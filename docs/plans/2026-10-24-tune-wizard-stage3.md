# Мастер настройки — этап 3: низкочастотные фильтры (план реализации)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Цель:** шаг 3 мастера «Низкочастотные фильтры»: предложение `INS_GYRO_FILTER`, `INS_ACCEL_FILTER`, `ATC_RAT_*_FLTT/FLTE/FLTD` и пределов ускорения по размеру винта, сравнение вариантов по шуму гироскопа, шуму D-составляющей и задержке путей P и D, графики и «Принять».

**Архитектура:** по `docs/plans/2026-10-24-tune-wizard-stage3-design.md`. Новое ядро `TuneWizard/core/lowpass.js` (без DOM) переиспользует `evaluate_candidate`, `filter_transfer`, `estimate_post`, `alias_obj`, `get_phase` этапа 2; интерфейс — `TuneWizard/steps/step3.js` по образцу `steps/step2.js`.

**Стек:** как на этапе 2 (браузерный JS без сборки, Plotly, `node --test`, ESLint, Playwright + Chrome через `CHROME_PATH`).

**Соглашения:** русский язык в коде, комментариях, интерфейсе и сообщениях; 4 пробела, без `;`, объявления функций, стиль соседнего кода. Коммит на задачу с трейлером `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; ничего из `TuneWizard/logs/`; `modules/ardupilot` не коммитить (вложенный репозиторий, `git add` только по именам файлов). Ветка `tune-wizard-stage3` (от `main` = `a487477`); после каждой задачи `git push origin tune-wizard-stage3`. В upstream ArduPilot ничего не отправлять.

**Общая глобальная область страницы.** Все скрипты страницы делят одну лексическую область (см. план этапа 2): новые глобальные имена — только с префиксами `lowpass_`, `prop_`, `pid_lowpass_`, `step3`, `lpf_`, `spec3_`, `dterm3_`, `bode3_`; перед добавлением имени — `grep` по `Libraries/` и `TuneWizard/`. Тесты ядра загружают скрипты через `vm.runInThisContext` в порядке страницы (помощник `load_page_scripts` в `tests/tunewizard-steps.test.cjs`).

**Проверки (везде):** `npm run lint`; `npm test`; браузерные — `CHROME_PATH="C:/Users/taa03/AppData/Local/Google/Chrome/Application/chrome.exe" npm run test:tunewizard` и `npm run test:tunewizard-compare`. Node — `"/c/Program Files/nodejs/node.exe"` (в Git Bash: `export PATH="/c/Program Files/nodejs:$PATH"`).

**Лог для ручной проверки:** `TuneWizard/logs/2026-06-18 18-54-42_anon.bin` (ArduCopter 4.6.3, `INS_GYRO_FILTER 40`, `ATC_RAT_RLL/PIT_FLTD 30`, `FLTT 20`, `FLTE 0`, `ATC_RAT_YAW_FLTE 1`, `ATC_ACCEL_R/P_MAX 90000`, `ATC_ACCEL_Y_MAX 50045.7` в сантиградусах/с², `SCHED_LOOP_RATE 400`). Размер винта для проверки — 10″ (владелец выставил значения wiki и Mission Planner для 10″).

---

### Задача 1: `core/lowpass.js` — правила, формулы, параметры и варианты

**Файлы:** создать `TuneWizard/core/lowpass.js`, `tests/tunewizard-lowpass.test.cjs`; изменить `TuneWizard/index.html` (подключить `core/lowpass.js` сразу после `core/candidates.js`).

**Шаг 1. Тест (сначала падает).** `tests/tunewizard-lowpass.test.cjs` загружает скрипты как `tests/tunewizard-steps.test.cjs` (тот же список плюс `TuneWizard/core/lowpass.js` последним) и проверяет:

- `round_half_even`: 2.5 → 2, 3.5 → 4, −2.5 → −2, 41.998 → 42 (C# `Math.Round` по умолчанию — к чётному).
- `mp_round_to(116659.8, -2)` → 116700, `mp_round_to(27000, -2)` → 27000, `mp_round_to(24750, -2)` → 24800 (Mission Planner `RoundTo`: `v += 50`, затем `v − v % 100` — округление до сотен половиной вверх).
- `prop_values(p)` — ровно значения Mission Planner:

| p | `INS_GYRO_FILTER` | `FLTT/FLTD` | `ACCEL_R/P`, сантиград./с² | `ACCEL_Y`, сантиград./с² |
|---|---|---|---|---|
| 5 | 75 | 37.5 | 168600 | 31500 |
| 10 | 42 | 21 | 116700 | 27000 |
| 12.5 | 35 | 17.5 | 95800 | 24800 |
| 20 | 23 | 11.5 | 50500 | 18000 |
| 30 | 20 | 10 | 21800 | 9000 |

  и у всех: `INS_ACCEL_FILTER 10`, `ATC_RAT_RLL/PIT_FLTE 0`, `ATC_RAT_YAW_FLTE 2`, `ATC_RAT_YAW_FLTD 0`, `ATC_RAT_YAW_FLTT = FLTT`. Отдельным утверждением — расхождения с таблицей wiki записаны (5″ 75 против 80, 10″ 42 против 40, `ACCEL_R/P` 10″ 1167 против 1100, `ACCEL_Y` 10″ 270 против 200 °/с²) — тест фиксирует, что берём Mission Planner.
- `prop_from_gyro_filter(40)` ≈ 10.5989 (±1e-3), `prop_from_gyro_filter(0)` и `(-5)` → `null`; `prop_values(prop_from_gyro_filter(42)).INS_GYRO_FILTER` = 42.
- `accel_names(params)`: в логе есть `ATC_ACCEL_R_MAX` → `{ r: "ATC_ACCEL_R_MAX", p: "ATC_ACCEL_P_MAX", y: "ATC_ACCEL_Y_MAX", scale: 100, units: "cdeg/s/s" }`; иначе (новые версии) → `{ r: "ATC_ACC_R_MAX", …, scale: 1, units: "deg/s/s" }`.
- `lowpass_param_names(params)` — порядок: `INS_GYRO_FILTER`, `INS_ACCEL_FILTER`, `ATC_RAT_RLL_FLTT`, `ATC_RAT_RLL_FLTE`, `ATC_RAT_RLL_FLTD`, то же `PIT`, `YAW`, затем пределы ускорения r, p, y под именами из `accel_names`.
- `lowpass_log_values(params)` — значения лога, отсутствующие — заводские (раздел 2 дизайна): `INS_GYRO_FILTER 20`, `INS_ACCEL_FILTER 20`, `FLTT 20`, `FLTD 20`, `FLTE` крен/тангаж 0, рыскание 2.5, пределы 1100/270 °/с² × `scale`. Значения — `Math.fround` (как хранит прошивка).
- `accel_is_default(log_values, names)`: 110000/27000 при `scale` 100 → `true`; 90000/90000/50045.7 → `false`; новые имена 1100/270 → `true`.
- `lowpass_candidates(log_values, prop_in, names)`:
  - без размера (`null`, `NaN`, ≤ 0) → `["log", "half"]`;
  - с размером 10″ на значениях лога пользователя → `["log", "prop", "half"]`; у `prop` пределы ускорения — из лога (не заводские), у `half` — `INS_GYRO_FILTER` лога, `FLTT/FLTD` крена и тангажа и `FLTT` рыскания = `max(10, INS_GYRO_FILTER / 2)` = 20, остальное как в логе;
  - заводские пределы → у `prop` пределы по формуле (10″: 116700 и 27000 при `scale` 100; 1167 и 270 при `scale` 1);
  - одинаковые наборы остаются один раз (лог уже по правилу /2 → `half` исчезает), сравнение по `candidate_key` от `Math.fround`-значений.
- `prop_size_warning(p)`: 2 → текст «вне 3–40″», 10 → `null`, `null` → `null`.

Запуск: `node --test tests/tunewizard-lowpass.test.cjs` — падает (`lowpass_rules is not defined`).

**Шаг 2. Реализация.** `TuneWizard/core/lowpass.js`:

```js
// Низкочастотные фильтры шага 3: значения по размеру винта (формулы Mission Planner), варианты и их оценка —
// шум гироскопа после фильтров, шум D-составляющей и задержка путей P и D. Без DOM: работает в браузере и под
// Node (тесты). Дизайн — docs/plans/2026-10-24-tune-wizard-stage3-design.md.
// Источники: [MP] — Mission Planner GCSViews/ConfigurationView/ConfigInitialParams.cs (calc_values);
// [wiki] — ardupilot.org/copter/docs/setting-up-for-tuning.html; [код] — исходники ArduPilot; [наше] — эвристика мастера.
//
// Нужны глобалы страницы: Libraries/Array_Math.js, core/gyro.js (find_start_index, find_end_index),
// core/filters.js (load_filters, filter_transfer, estimate_post, get_phase), core/spectrum.js
// (spectrum_amplitude_scale, alias_obj) и core/candidates.js (evaluate_candidate, candidate_key).

const lowpass_rules = {
    gyro_filter: { scale: 289.22, power: -0.838, min_hz: 20 },   // INS_GYRO_FILTER по размеру винта [MP]
    pid_filter_min_hz: 10,              // FLTT/FLTD = max(10, INS_GYRO_FILTER / 2) [MP; wiki — INS_GYRO_FILTER / 2]
    yaw_flte_hz: 2,                     // ATC_RAT_YAW_FLTE [MP, wiki]
    accel_filter_hz: 10,                // INS_ACCEL_FILTER [MP, wiki]
    accel_rp: { poly: [-2.613267, 343.39216, -15083.7121, 235771], min_cdegss: 10000 },   // ATC_ACCEL_R/P_MAX [MP]
    accel_y: { slope: -900, offset: 36000, min_cdegss: 8000 },   // ATC_ACCEL_Y_MAX [MP]
    accel_default_degss: { rp: 1100, y: 270 },   // заводские пределы, AC_AttitudeControl.h [код]
    // Заводские фильтры Copter: AP_InertialSensor.cpp (DEFAULT_GYRO_FILTER, DEFAULT_ACCEL_FILTER),
    // AC_AttitudeControl_Multi.h (FLTT, FLTD 20 Гц по всем осям, FLTE крена/тангажа 0, рыскания 2.5 Гц) [код]
    defaults: { gyro_hz: 20, accel_hz: 20, fltt_hz: 20, fltd_hz: 20, flte_rp_hz: 0, flte_y_hz: 2.5 },
    prop_range_in: [3, 40],             // размер винта без предупреждения у поля [наше]
    band_hz: [20, 400],                 // полоса шума гироскопа; для D — до частоты Найквиста контура [наше]
    lag_freqs_hz: [10, 30],             // частоты задержки [наше]
    max_noise_increase_dB: 3,           // «шумнее лога» [наше, как на шаге 2]
    max_lag_increase_ms: 1,             // «медленнее лога» на 30 Гц (решение пользователя 24.10.2026) [наше]
}

const LOWPASS_AXES = ["RLL", "PIT", "YAW"]

// Math.Round из C# (по умолчанию — к чётному): так округляет Mission Planner
function round_half_even(value) { … }

// RoundTo(value, precision) из Mission Planner: при precision < 0 — m = 10^|precision|, v = value + m/2, v − v % m
function mp_round_to(value, precision) { … }

// Значения по размеру винта p (дюймы) [MP]: INS_GYRO_FILTER, INS_ACCEL_FILTER, FLTT/FLTE/FLTD трёх осей
// и пределы ускорения в сантиградусах/с² (accel_cdegss: { r, p, y }) — имена пределов ставит lowpass_candidates
function prop_values(p) { … }

// Размер винта, которому формула [MP] даёт частоту hz (без клампа и округления); null при hz ≤ 0
function prop_from_gyro_filter(hz) { … }

// Имена и единицы пределов ускорения по логу: ATC_ACCEL_*_MAX (сантиградусы/с², 4.6 и раньше) или ATC_ACC_*_MAX (°/с²)
function accel_names(params) { … }

function lowpass_param_names(params) { … }
function lowpass_log_values(params) { … }
function accel_is_default(values, names) { … }   // сравнение с заводскими × scale с допуском 0.5·scale
function prop_size_warning(p) { … }

// Варианты: «как в логе»; «по размеру винта» (только с p > 0; пределы ускорения — по формуле, только если в логе
// заводские, иначе из лога: их записывает AutoTune, AC_AutoTune_Multi.cpp); «лог + правило /2». Одинаковые наборы
// — один раз (первый по порядку). Возвращает [{ id, title, values }]
function lowpass_candidates(log_values, prop_in, names) { … }
```

Заголовки вариантов: «Как в логе», «По размеру винта (N″)», «Лог + правило /2».

**Шаг 3.** `node --test tests/tunewizard-lowpass.test.cjs` — зелёный; `npm run lint`; `npm test`.

**Коммит:** `TuneWizard: шаг 3 — правила и формулы низкочастотных фильтров` (+ трейлер), push.

---

### Задача 2: `core/lowpass.js` — оценка вариантов

**Файлы:** изменить `TuneWizard/core/lowpass.js`, `tests/tunewizard-lowpass.test.cjs` (аналитика без гироскопа), `tests/tunewizard-steps.test.cjs` (на синтетическом гироскопе: в список `load_page_scripts` добавить `core/lowpass.js` последним).

**Модель** (раздел 4 дизайна, `AC_PID.cpp`):

```js
// Фильтр первого порядка ArduPilot на частоте контура loop_rate: y += alpha·(x − y), alpha = dt / (dt + 1/(2π·fc))
// (calc_lowpass_alpha_dt); H(z) = alpha / (1 − (1 − alpha)·z⁻¹). fc ≤ 0 — без фильтра (H = 1).
// Возвращает [re, im] на частоте f
function pid_lowpass_response(fc, loop_rate, f) { … }
// Задержка этого фильтра на частоте f, мс: −arg(H) / (2π·f) · 1000
function pid_lowpass_lag_ms(fc, loop_rate, f) { … }
// |(1 − z⁻¹) / dt|² на частоте f при dt = 1 / loop_rate: (2·sin(π·f/loop_rate) · loop_rate)²
function derivative_gain2(f, loop_rate) { … }
```

```js
// Контекст оценки: контекст evaluate_candidate (gyro, env, tracking, range, sensor, loop_rate) с пустыми пиками,
// notch — значения notch-базы (принятые на шаге 2 или из лога: INS_GYRO_FILTER, SCHED_LOOP_RATE, INS_HNTCH_*, INS_HNTC2_*),
// kd — { roll: ATC_RAT_RLL_D, pitch: ATC_RAT_PIT_D } (null — нет в логе). Один объект на все варианты:
// по нему evaluate_candidate кэширует спектр «до»
function lowpass_ctx(base, notch, kd) { … }   // base = { gyro, env, tracking, range, sensor }

// Оценка варианта values (имена lowpass_param_names) → null, если у экземпляра нет FFT или Z1, иначе {
//   values, warnings,
//   gyro: { band_dB, lag_ms: { 10, 30 }, spectrum, pre_spectrum } — evaluate_candidate({ ...ctx.notch, INS_GYRO_FILTER }),
//   dterm: { bins, roll: { dB, spectrum }, pitch: { dB, spectrum } } — шум D-составляющей; у оси без Kd — null,
//   lag_ms: { roll: { P: { 10, 30 }, D: { 10, 30 } }, pitch: { … } }
// }. Состояние gyro не меняется
function evaluate_lowpass(values, ctx) { … }
```

Шум D-составляющей оси (roll ↔ ось X гироскопа, pitch ↔ Y):

1. Фильтры гироскопной части — `load_filters({ ...ctx.notch, INS_GYRO_FILTER: values.INS_GYRO_FILTER }, ctx.env, ctx.tracking)`, `H = filter_transfer(…, FFT.Z1, FFT.Z2)` по окнам до конца интервала (как в `evaluate_candidate`).
2. `post = estimate_post(gyro, sensor, spectrum_amplitude_scale("PSD"), range, alias_obj(FFT, { mode: "fold", loop_rate }), H)` — PSD (дБ/Гц), свёрнутая к `loop_rate / 2`; `bins = alias.bins`.
3. В каждом бине `k`: `D[k] = kd² · 10^(post[k]/10) · derivative_gain2(f_k) · |H_FLTE(f_k)|² · |H_FLTD(f_k)|²` (FLTE и FLTD оси из `values`, `pid_lowpass_response` на `loop_rate`).
4. `dB = 10·log10(среднее D[k] по бинам band_hz[0] ≤ f ≤ min(band_hz[1], loop_rate/2))`; `spectrum = 10·log10(D[k])` по всем бинам.

Задержка оси: гироскопная часть — `gyro.lag_ms` (это `filters_lag_ms` внутри `evaluate_candidate`), путь P = она + `pid_lowpass_lag_ms(FLTE)`, путь D = путь P + `pid_lowpass_lag_ms(FLTD)`. Сама производная в задержку не входит (одинакова у всех вариантов и в разнице сокращается).

```js
// Бодэ путей P и D оси (axis — "roll" | "pitch") для графика: H гироскопной части на сетке 0…loop_rate/2 шагом
// step (0.05 Гц, как в filters_lag_ms — get_phase считает спад больше 45° за шаг переносом фазы), средняя по окнам
// интервала амплитуда и развёрнутая фаза, умноженные на FLTE (путь P) и FLTE·FLTD (путь D).
// → { freq, P: { amp_dB, phase_deg }, D: { amp_dB, phase_deg } }; null без FFT
function lowpass_bode(values, ctx, axis, step = 0.05) { … }

// Отметки варианта против лога: noisier — что шумнее больше чем на max_noise_increase_dB ("gyro", "roll", "pitch");
// slower — пути, где задержка на старшей из lag_freqs_hz больше лога на max_lag_increase_ms ("roll P", "roll D", …);
// incomplete — нет оценки или оценки лога, нечисловая полоса гироскопа. Проверки отказывают при сомнении:
// !(разница ≤ порога); ось без Kd у обоих — без отметки шума, но в incomplete_axes.
// → { noisier: [...], slower: [...], incomplete, incomplete_axes: [...] }
function lowpass_flags(evaluation, log, rules = lowpass_rules) { … }

// Предупреждения о том, чего модель не учитывает: notch-фильтры ПИД ATC_RAT_*_NTF/NEF ≠ 0 → строка на ось
function lowpass_model_warnings(params) { … }
```

**Тесты.**

`tests/tunewizard-lowpass.test.cjs` (без гироскопа):
- `pid_lowpass_response(0, 400, f)` = `[1, 0]`; `pid_lowpass_lag_ms(20, 400, 30)` = 4.3531 (±1e-3), `(20, 400, 10)` = 7.1117, `(30, 400, 30)` = 3.5223; независимая проверка — фаза `alpha / (1 − (1 − alpha)·e^(−jω))`, посчитанная в тесте комплексной арифметикой; задержка убывает с ростом `fc`.
- `derivative_gain2(100, 400)` = 320000 (±1e-6), `derivative_gain2(0, 400)` = 0.
- `lowpass_flags`: ровно +3 дБ и ровно +1 мс — без отметки; +3.0001 дБ / +1.0001 мс — с отметкой; `NaN` в задержке или шуме — отметка; оценки нет — `incomplete`; ось без Kd — `incomplete_axes`.
- `lowpass_model_warnings`: `ATC_RAT_RLL_NEF 1` → одна строка с именем; нули и отсутствие параметров → пусто.

`tests/tunewizard-steps.test.cjs` (синтетика `esc_setup`, gyro 1000 Гц, контур 400 Гц):
- одинаковые значения → разница шума гироскопа и D ровно 0 дБ, задержки равны;
- шум гироскопа «как в логе» совпадает с `evaluate_candidate(notch, ctx).band_dB` (то же число);
- `FLTD` 30 → 15: шум D крена и тангажа ниже, задержка пути D больше, путь P не меняется;
- `INS_GYRO_FILTER` 80 → 40: шум гироскопа ниже, задержка путей P и D больше;
- свёртка: фиксированный тон 233 Гц (`fixed: [[233, 1.5]]`) даёт пик спектра D-составляющей на 167 ± 1 Гц;
- Kd: удвоение `kd.roll` даёт +6.02 дБ в `dterm.roll.spectrum` в каждом бине; `kd.roll = null` → `dterm.roll = null`;
- `lowpass_bode`: при `FLTE 0` путь P совпадает с гироскопной частью; разность фаз путей D и P на 30 Гц = фаза `pid_lowpass_response(FLTD)` (±1e-6);
- после `evaluate_lowpass` массивы `FFT.H` и `FFT.bode.H` в gyro — те же объекты и значения.

**Замер** на логе пользователя (скрипт в scratchpad, в репозиторий не коммитить): 3 варианта оцениваются под Node быстрее 1 с; `lowpass_bode` одной оси — быстрее 0.5 с. Числа — в отчёт задачи. Ожидание на логе (notch лога, 10″): «Как в логе» — путь P на 30 Гц ≈ 7.0 мс, путь D ≈ 10.6 мс; «Лог + правило /2» (`FLTD` 20) — путь D больше на ≈ 0.8 мс, шум D ниже.

**Коммит:** `TuneWizard: шаг 3 — оценка вариантов: шум D, задержка путей P и D, бодэ` (+ трейлер), push.

---

### Задача 3: шаг 3 — страница без графиков

**Файлы:** создать `TuneWizard/steps/step3.js`; изменить `TuneWizard/index.html` (секция `data-step="3"`, стили формы, подключить `steps/step3.js` после `steps/step2.js`), `TuneWizard/wizard.js` (`step3_init` в `init_wizard`, `step3_show` в `on_show_step(3)`, `step3_reset` в `reset`), `docs/plans/2026-10-24-tune-wizard-stage3-design.md` (раздел 5, форма — см. ниже).

**Почему форма своя, а не `load_param_inputs`.** `ParameterMetadata` ищет поле по `id` = имени параметра, а поле `INS_GYRO_FILTER` уже есть в форме шага 2 — второй элемент с тем же `id` сломал бы обе формы. Кроме того, в `FilterReview/params.json` нет старых имён `ATC_ACCEL_*_MAX` (поиск по префиксу не найдёт описание). Поэтому шаг 3 строит форму сам по тем же метаданным: один раз `fetch("../FilterReview/params.json")`, поиск описания по имени тем же префиксным обходом, что `recursive_search` в `Libraries/ParameterMetadata.js`; для `ATC_ACCEL_*_MAX` — описание `ATC_ACC_*_MAX`, единицы `cdeg/s/s`, диапазон ×100. Поля — `<input type="number" id="lpf_<ИМЯ>">` с подписью-именем (`title` — описание), единицами и «в логе: …». Поправить раздел 5 дизайна одной фразой.

**Разметка секции 3** (по образцу секции 2, классы и токены те же):
- `.lede` — что делает шаг (пороги подставляются из `lowpass_rules` через `data-rule`, как на шаге 2);
- поле «Размер винта, ″» (`#prop_in`, `type="number"`, `step="0.5"`, `min="1"`) с подсказкой `#prop_hint` и предупреждением `#prop_warn`;
- `#verdict3`, `#warnings3`;
- «Варианты»: `#candidates3` (таблица), `#candidates3_note`, кнопка `#cand3_apply` «Применить вариант»;
- «Параметры»: `.lab` с `#lpf_form` (группы «Гироскоп и акселерометр», «Крен», «Тангаж», «Рыскание», «Пределы ускорения»), пояснение про метаданные;
- «Метрики»: `#metrics3` (`.stats`) и кнопка `#lpf_accept` «Принять»;
- места под графики задачи 4 (`#Spectrum3`, `#DTerm3`, `#Bode3`) пока без регистрации.
Стили `#notch_form` распространить на `#lpf_form` перечислением селекторов через запятую; вид шага 2 не меняется.

**`steps/step3.js`:**
- Состояние `step3 = { form_built, filled, metadata, ctx, candidates, evaluations, flags, custom_row, selected_id, key, error }`.
- Размер винта: из `localStorage["tunewizard_prop_in"]` (чтение и запись в `try/catch`), подсказка «текущему INS_GYRO_FILTER N Гц по формуле Mission Planner соответствует ≈ p″» (`prop_from_gyro_filter`), предупреждение `prop_size_warning`. Изменение поля → пересчёт вариантов и перерисовка.
- База notch: `state.steps[2]?.accepted ?? values_from_log()`; если на шаге 2 принят `INS_GYRO_FILTER`, отличный от лога, — заметка «шаг 3 выбирает INS_GYRO_FILTER заново, итоговым станет значение шага 3»; если шаг 2 не принят — в вердикте «notch — из лога (шаг 2 не принят)».
- Расчёт: `step3_ensure_step1()` (как `step2_ensure_step1`, своя ошибка в `step3.error`), экземпляр — `step2_sensor()`, `ctx = lowpass_ctx({ gyro, env, tracking, range, sensor }, base, kd)`; `loop_rate` — из базы (`SCHED_LOOP_RATE`). Ключ расчёта — `JSON.stringify([start, end, step1.fft_key, filter_version, candidate_key(base), prop_in])`; при показе шага с другим ключом — пересчёт автоматически.
- Таблица вариантов: «Вариант», `INS_GYRO_FILTER`, `FLTD / FLTT` крена и тангажа, шум гироскопа (дБ к логу), шум D крена / тангажа (дБ к логу), задержка путей P и D на 30 Гц (мс, разница к логу; на 10 Гц — `title`), отметки словами, радио выбора; пометка «рекомендуется» у `prop`. Цвета разниц — `--ok` при улучшении, `--high` при отметке (как `step2_delta_cell`). Без размера винта — заметка «Введите размер винта — появится вариант по формуле».
- Вердикт: рекомендован «По размеру винта» — что меняется против лога и цифры; с отметками — `warn` и что именно хуже; пределы ускорения не заводские — «пределы ускорения оставлены из лога (похоже на AutoTune), по формуле было бы …»; предупреждения `lowpass_model_warnings`; без размера — `warn` «введите размер винта».
- Форма: значения из лога при первом показе; «Применить вариант» — значения выбранного варианта в форму; правка поля (`change`) → строка «Свой» (`custom_row`, оценка и отметки против лога), пересчёт метрик; пометка `.changed` у полей, отличных от лога.
- Метрики `#metrics3`: значения формы против лога — шум гироскопа, шум D крена/тангажа, задержка путей P/D на 10 и 30 Гц.
- «Принять» → `state.steps[3] = { accepted: значения формы, candidate_id ("prop" | "half" | "log" | "custom"), prop_in, metrics, flags, evaluated_at }`; вердикт «Принято» или «Принято, но хуже лога: …» (`warn`); затем `set_step(4)`, если шаг 4 доступен.
- Все расчёты — под `loading_call` с `try/catch` (как `step2_run`), ошибка — в `#verdict3`.

**Проверка руками** (`python -m http.server --bind 127.0.0.1`, `http://127.0.0.1:8000/TuneWizard/`): лог пользователя, шаг 3, размер 10″ — три варианта, рекомендован «По размеру винта (10″)» (`INS_GYRO_FILTER 42`, `FLTD/FLTT 21`), пределы ускорения из лога; правка `ATC_RAT_RLL_FLTD` → строка «Свой». Ошибок консоли нет. `npm run lint`, `npm test`, `npm run test:tunewizard` (шаги 0–2 не сломаны).

**Коммит:** `TuneWizard: шаг 3 — варианты низкочастотных фильтров, форма и «Принять»` (+ трейлер), push.

---

### Задача 4: графики шага 3 и браузерный тест

**Файлы:** изменить `TuneWizard/steps/step3.js`, `TuneWizard/index.html`, `tests/tunewizard-browser.cjs`.

**Графики** (реестр `plots.js`: `register_plot` в `step3_init`, данные меняются на месте и `render_plot`; цвета только в хуках `on_theme` из `plot_palette()`):
- `Spectrum3` — оценка спектра гироскопа после фильтров: для осей X/Y/Z три типа — «до фильтров» (`dot`, по умолчанию `legendonly`), «как в логе» (`dash`), «выбранный» (`solid`); цвет — `palette.axis`; вертикали на `INS_GYRO_FILTER` лога (пунктир) и выбранного варианта (сплошная) — `shapes`, цвет в `on_theme`.
- `DTerm3` — спектр D-составляющей до `loop_rate / 2`: крен (`palette.axis.x`) и тангаж (`palette.axis.y`), лог (`dash`) и выбранный (`solid`); ось Y «D-составляющая, дБ (отн.)».
- `Bode3` — два подграфика (амплитуда сверху, фаза снизу) путей P (`palette.series[0]`) и D (`palette.series[1]`), лог (`dash`) и выбранный (`solid`); радио «Крен / Тангаж» (`#bode3_roll`, `#bode3_pitch`); вертикали на 10 и 30 Гц.
- «Выбранный» — строка таблицы с отмеченным радио (или «Свой» после правки формы). Перерисовка — при выборе строки, «Применить вариант», правке формы и пересчёте.
- Подписи под графиками (`.note`): гироскоп первичный; модель D — свёртка к частоте контура, Kd из лога, фильтры ПИД первого порядка (`AC_PID.cpp`).

**Браузерный тест** (`tunewizard-browser.cjs`, после проверок «Принять» шага 2 и до повторной загрузки лога):
- шаг 3 открыт через `#wizbar`; до ввода размера: строк вариантов 2 («Как в логе», «Лог + правило /2»), вердикт `warn` с просьбой ввести размер;
- `#prop_in` = 10 → строк 3, ровно одна «рекомендуется» — «По размеру винта (10″)»; у неё `INS_GYRO_FILTER 42`, `FLTD 21`, пределы ускорения — из лога (`ATC_ACCEL_R_MAX` 90000), в вердикте фраза про AutoTune;
- «Лог + правило /2»: шум D крена ниже лога, задержка пути D больше;
- `#prop_in` = 20 → у варианта по размеру отметка «медленнее лога» (задержка на 30 Гц > +1 мс);
- правка `#lpf_ATC_RAT_RLL_FLTD` → строка «Свой»;
- графики `Spectrum3`, `DTerm3`, `Bode3` с данными, фон `--surface`; у `DTerm3` наибольшая частота — 200 Гц (`SCHED_LOOP_RATE 400`);
- «Принять» → `state.steps[3].accepted.INS_GYRO_FILTER` — значение формы, `candidate_id`; вердикт `^Принято`;
- размер винта переживает перезагрузку страницы (`localStorage`); повторная загрузка лога сбрасывает `state.steps[3]` и строку «Свой»;
- скриншот `step3.png`; итоговая строка лога теста — «шаги 0–3 пройдены» и строка про шаг 3 (варианты, рекомендованный, вердикт).

`npm run lint`, `npm test`, `npm run test:tunewizard`, `npm run test:tunewizard-compare` — зелёные.

**Коммит:** `TuneWizard: шаг 3 — графики и браузерный тест` (+ трейлер), push.

---

### Задача 5: Readme, описание тестов, финальный прогон

- `TuneWizard/Readme.md`: структура (`core/lowpass.js`, `steps/step3.js`), раздел «Как шаг 3 выбирает низкочастотные фильтры» (формулы Mission Planner, варианты, метрики, пороги 1 мс и 3 дБ, AutoTune и пределы ускорения), «Готовность» — этап 3 готов.
- `tests/README.md`: `tunewizard-lowpass.test.cjs`; браузерный тест — шаги 0–3.
- Все проверки зелёные; коммит `TuneWizard: Readme и описание тестов для этапа 3` (+ трейлер), push.

---

## Что сознательно не вошло в этап 3

- `MOT_THST_EXPO`, напряжения батареи, `ATC_THR_MIX_MAN`, `MOT_THST_HOVER`, `ACRO_YAW_P` из Mission Planner — решение пользователя: аппарат уже летает.
- Notch-фильтры ПИД (`ATC_RAT_*_NTF/NEF`, `FILTn_*`) в модели — только предупреждение, если включены.
- Файл `.param` шага 3 — итоговый файл соберёт сводка на этапе 5.
- Спектр D-составляющей из `PIDR/P/Y` (записанный) — этап 4 (перенос PIDReview).
