# Мастер настройки — этап 4: PID по осям (план реализации)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Цель:** шаг 4 мастера «PID по осям» — измеренный отклик контура скорости, предложение `ATC_RAT_*_P/I/D` по правилам и прогноз вариантов с проверкой достоверности.

**Архитектура:** по `docs/plans/2026-10-25-tune-wizard-stage4-design.md`.

- `TuneWizard/core/pid.js` — перенос PIDReview «минимальным диффом».
- `TuneWizard/core/pidtune.js` — своё: метрики, правила, оценка объекта, модель `AC_PID`, прогноз, варианты, отметки.
- `TuneWizard/steps/step4.js` — страница шага по образцу `steps/step3.js`.
- Первая задача — общий модуль шагов (долг этапа 3).

**Стек:** как на этапах 2–3 (браузерный JS без сборки, Plotly, `node --test`, ESLint, Playwright + Chrome через `CHROME_PATH`).

**Соглашения:**

- Русский язык в коде, комментариях, интерфейсе и сообщениях. Стиль соседнего кода: 4 пробела, без `;`, объявления `function`, комментарий-контракт перед функцией, правила с источниками `[wiki]`, `[код]`, `[PIDReview]`, `[наше]`.
- Коммит на задачу с трейлером `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. `git add` только по именам файлов: `modules/ardupilot` и `TuneWizard/logs/` не коммитить.
- Ветка `tune-wizard-stage4` (от `main` = `0a0a5ea`). После каждой задачи — `git push origin tune-wizard-stage4`. В upstream ArduPilot ничего не отправлять. Журнал `docs/tunewizard-journal.md` обновляет координатор.
- Только тёмная тема «Графит»: цвета — токены CSS и `plot_palette()` в хуках `on_theme`.

**Общая глобальная область страницы.** Новые глобальные имена — только с префиксами:

- `pid_`, `PID_` — `core/pid.js`;
- `pidtune_` — `core/pidtune.js`;
- `step4`, `pidf_`, `stepresp4_`, `tarac4_`, `dspec4_`, `lbode4_` — `steps/step4.js`;
- `step_`, `plot_` — общий модуль задачи 1.

Перед добавлением имени — `grep` по `Libraries/` и `TuneWizard/`. В PIDReview есть `run_batch_fft`, `find_start_index`, `find_end_index`, `load`, `reset` — в ядре мастера они уже заняты или общие:

- `find_*_index(time, range)` — переиспользовать из `core/gyro.js`; логика та же, что у PIDReview, проверить построчно;
- `run_batch_fft` → `pid_run_batch_fft`;
- `load` → `load_pid`.

**Тесты ядра под Node** грузят скрипты через `vm.runInThisContext` в порядке страницы (помощник `load_page_scripts` в `tests/tunewizard-steps.test.cjs`); `FFTJS` — `require('../modules/fft.js/lib/fft.js')`.

**Проверки (везде):** `npm run lint`; `npm test`; `CHROME_PATH="C:/Users/taa03/AppData/Local/Google/Chrome/Application/chrome.exe" npm run test:tunewizard` и `npm run test:tunewizard-compare`. Node — `export PATH="/c/Program Files/nodejs:$PATH"`.

**Лог для проверки:** `TuneWizard/logs/2026-06-18 18-54-42_anon.bin`:

- ArduCopter 4.6.3;
- `PIDR/PIDP/PIDY` с частотой 400 Гц, интервал мастера 49–540 с;
- PID в полёте не менялись;
- Kp = Ki: крен 0.1163, тангаж 0.0926; Kd: крен 0.00293, тангаж 0.00241; рыскание Kp 0.2298, Ki 0.02298, Kd 0.0017;
- `FF` 0, `FLTE` 0, `FLTD` 30, `SMAX` 0.

**Окно FFT шага 4:** по умолчанию 512 — как в PIDReview (поле `FFTWindow_size`, value 512). Одно окно на отклик, оценку объекта и прогноз.

---

### Задача 1: общий модуль шагов (долг этапа 3)

**Файлы:**

- создать `TuneWizard/steps/common.js` (подключить в `index.html` перед `steps/step1.js`);
- изменить `TuneWizard/steps/step2.js`, `TuneWizard/steps/step3.js`, `TuneWizard/index.html` (CSS и разметка).

**Что вынести** (поведение шагов 2–3 не меняется):

- `step2_signed` → `step_signed(value, digits)`;
- `step2_tile` → `step_tile(key, value, sub, mod)`;
- `step2_sensor` → `step_gyro_sensor()`;
- `step2_verdict` и `step3_verdict` → `step_verdict(id, status, text)`;
- `step2_ensure_step1` и `step3_ensure_step1` → `step_ensure_step1()`: возвращает `null`, если расчёт шага 1 готов, иначе текст ошибки; шаги кладут его в своё `error`;
- `step2_run`, `step3_run`, `step3_try` → `step_run(fn, verdict_id, label)` (под `loading_call`) и `step_try(fn, verdict_id, label)` (без оверлея). Текст ошибки «Ошибка шага N: …» сохраняется.

Повторяющиеся куски графиков шагов 2–3 — в помощники `plot_…`, только если повтор есть хотя бы в двух местах (например, очистка трасс графика `plot_clear(id)`).

**CSS:** селекторы-перечисления `#candidates2,#candidates3`, `#metrics2,#metrics3`, `#notch_form,#lpf_form` заменить общими классами (`.cands`, `.pform`, `.metrics`), классы проставить в разметке. Вид шагов 2–3 не меняется; проверить скриншотами браузерного теста.

**Проверки:** lint, `npm test`, `npm run test:tunewizard`, `npm run test:tunewizard-compare` — без правки ожиданий тестов. Старых имён (`step2_signed` и т.д.) в коде не остаётся (grep).

**Коммит:** `TuneWizard: общий модуль шагов и классы стилей вместо перечислений` (+ трейлер), push.

---

### Задача 2: `core/pid.js` — перенос PIDReview

**Файлы:**

- создать `TuneWizard/core/pid.js`, `tests/tunewizard-pid.test.cjs`;
- изменить `TuneWizard/index.html` — подключить `core/pid.js` после `core/lowpass.js`.

**Перенос «минимальным диффом»** из `PIDReview/PIDReview.js` (upstream 05d6177), только Copter (`build_type` 2). В шапке файла — таблица замен, как в `core/gyro.js`:

| В upstream | В ядре |
|---|---|
| `fft_keys` | `PID_FFT_KEYS` |
| `run_batch_fft(data_set)` с окном из DOM | `pid_run_batch_fft(data_set, window_size)` |
| `get_PID_param_names(prefix)` | `pid_param_names(prefix)` |
| `split_into_batches(PID_log_messages, index, time)` | `pid_split_into_batches(pids, index, time)` |
| `load(log_file)` — парсинг, DOM, `alert` | `load_pid(log, env)` → `{ axes, start_time, end_time, have_data, warnings }`; `axes` — массив как `PID_log_messages` (только Copter: `PIDR/P/Y`, затем `RATE R/P/Y`), без `flight_data` и DOM |
| `find_start_index(time)` / `find_end_index(time)` | `find_start_index(time, range)` / `find_end_index(time, range)` из `core/gyro.js` |
| `redraw_step()` — расчёт и запись в `step_plot.data` | `pid_step_response(axis, set_index, range)` → `{ time, windows: [[…]], mean }` (окна — массивы шага, как трассы «все»; `mean` — среднее; `null`, если окон нет) |
| `alert(msg)` | `warnings.push(msg)` |

Поведение — построчно как upstream, включая известные странности (их фиксируют отдельно, см. задачу 4):

- выход `Out = P + I + D + FF + DFF`;
- у RATE: `Tar = RDes`, `Act = R`, `Out = ROut` (без масштабирования, как в upstream);
- окна отклика: шаг 1/16, цель больше 20 °/с, шумовая оценка гауссианой с частотой 25 Гц.

Замеченное при переносе расхождение с разумным поведением не исправлять — записать в шапке как «дефект upstream N (строки)» для задачи 4.

**Тесты** (`tests/tunewizard-pid.test.cjs`, поддельный лог с интерфейсом парсера, как `fake_log` в `tests/tunewizard-steps.test.cjs`):

- **Загрузка:**
  - `PIDR` с масштабом рад → °/с для `Tar/Act/Err`;
  - выход — сумма компонент;
  - `RATE`-путь без компонент;
  - наборы параметров при смене `ATC_RAT_RLL_P` в середине (два набора, разрыв не меньше 1 с, как в upstream);
  - пакеты при пропуске отсчётов.
- **FFT:** синусоида в `Tar` даёт пик в нужном бине.
- **Отклик на ступеньку:**
  - синтетический замкнутый контур «первый порядок» с известной постоянной времени: цель — случайные ступеньки (детерминированный генератор), факт — фильтр первого порядка от цели;
  - средний отклик достигает 0.63 за τ с допуском;
  - окна с целью меньше 20 °/с не входят.

**Проверки:** `node --test tests/tunewizard-pid.test.cjs`, lint, `npm test`.

**Коммит:** `TuneWizard: core/pid.js — перенос загрузки PID и отклика на ступеньку из PIDReview` (+ трейлер), push.

---

### Задача 3: тест сравнения с PIDReview

**Файлы:** создать `tests/tunewizard-pid-compare.cjs`; изменить `package.json` — скрипт `"test:tunewizard-pid-compare": "node tests/tunewizard-pid-compare.cjs"`.

**Устройство** — как у `tests/tunewizard-compare.cjs` (сервер, Chrome через `CHROME_PATH`, лог из `TuneWizard/logs/`, без лога — пропуск).

1. Открыть `PIDReview/index.html` и загрузить лог в поле файла.
2. Выставить то же окно (512) и тот же интервал, что у мастера по умолчанию (`throttle_window`: 49–540 с), нажать «Calculate».
3. Для каждой оси (`type_PIDR`, `type_PIDP`, `type_PIDY`) прочитать `step_plot.data`: окна — трасса «все», среднее — трасса «среднее» первого набора.
4. В мастере на той же странице TuneWizard посчитать `load_pid` и `pid_step_response` с тем же окном и интервалом (через `page.evaluate`, данные мастера уже загружены шагом 0).
5. Сравнить поэлементно с допуском 1e-6 (относительным) и вывести итоговую строку «совпадение с PIDReview: N массивов, M значений, наибольшее отклонение …».

**Поиск дефектов.** Если что-то расходится, сначала проверить, не дефект ли это переноса. Расхождения из-за дефектов upstream не подгонять: записать и сообщить для задачи 4.

**Проверки:** `CHROME_PATH=… npm run test:tunewizard-pid-compare` — зелёный, отклонение 0 (или только записанные дефекты).

**Коммит:** `TuneWizard: тест сравнения отклика на ступеньку с PIDReview` (+ трейлер), push.

---

### Задача 4: исправление дефектов upstream PIDReview (если найдены в задачах 2–3)

Как задача 8 этапа 2:

- каждый дефект — тест, который падает, затем исправление в `core/pid.js`;
- в тесте сравнения — подмена кода PIDReview теми же исправлениями: эталон = PIDReview с исправлениями; подмена падает, если не нашла своё место;
- отдельный отчёт «чем исходный PIDReview отличается от мастера» и проверка, что отличия ровно ожидаемые;
- список дефектов со ссылками на строки — в шапке `core/pid.js` и в разделе 2 дизайна.

Если дефектов нет — задача пропускается, координатор отмечает это в журнале.

**Коммит:** `TuneWizard: исправления дефектов, унаследованных из PIDReview` (+ трейлер), push.

---

### Задача 5: `core/pidtune.js` — метрики отклика и правила

**Файлы:** создать `TuneWizard/core/pidtune.js`, `tests/tunewizard-pidtune.test.cjs`; подключить `core/pidtune.js` в `index.html` после `core/pid.js`.

```js
// Правила шага 4; источники: [wiki] — ardupilot.org/copter/docs/ac_rollpitchtuning.html (Manual tuning),
// [код] — AC_AutoTune_Multi.cpp, [PIDReview] — метод отклика, [наше] — эвристика мастера
const pidtune_rules = {
    target_min_dps: 20,          // окно отклика — цель больше 20 °/с [PIDReview, redraw_step]
    step_length_s: 0.5,          // длина отклика [PIDReview]
    min_windows: 10,             // меньше окон — «мало манёвров» [наше]
    settle_band: 0.05,           // установление в ±5 % [наше]
    overshoot_high_pct: 20,      // больше — P −10 % [наше]
    overshoot_low_pct: 5,        // меньше и без колебаний — P +10 % [wiki: P поднимают до раскачки; порог — наше]
    osc_min_amplitude: null,     // порог остаточных колебаний, размах после установления [наше] — калибровка на логе
    osc_band_ratio: 3,           // «высокие» колебания — выше 3 полос 0.35/t_нарастания [наше]
    gain_step: 0.10,             // шаг изменения ±10 % [wiki: −10 % до исчезновения раскачки]
    yaw_i_ratio: 0.1,            // I рыскания = 0.1·P [код, AUTOTUNE_YAW_PI_RATIO_FINAL]
    p_min: 0.01, p_max: 2.0,     // [код, AUTOTUNE_RP_MIN/MAX]
    d_max: 0.2,                  // [код, AUTOTUNE_RD_MAX]
    d_noise_hz: 50,              // шум D — выше этой частоты [наше]
    d_noise_threshold: null,     // порог шума D [наше] — калибровка на логе
}
// Метрики среднего отклика: time — секунды, step — значения (цель = 1).
// → { rise_s, overshoot_pct, settle_s, osc: { freq_hz, amplitude } | null, bandwidth_hz (0.35 / rise_s) }
function pidtune_step_metrics(time, step, rules = pidtune_rules) { … }
// Шум D-составляющей выше d_noise_hz по спектру D оси (FFT pid_run_batch_fft) за интервал → { dB, over } | null
function pidtune_d_noise(axis_sets, set_index, range, rules = pidtune_rules) { … }
// Предложение по правилам: gains = { P, I, D }, axis — "roll" | "pitch" | "yaw"; metrics — pidtune_step_metrics;
// windows — число окон. → { change: "P-" | "P+" | "D-" | null, reason (текст), values: { P, I, D }, limited (упёрлось в предел) }
function pidtune_rule(gains, axis, metrics, windows, rules = pidtune_rules) { … }
```

**Правила** — раздел 3 дизайна, проверяются по порядку:

1. колебания: высокие → D −10 %, низкие → P −10 %;
2. перерегулирование больше 20 % → P −10 %;
3. перерегулирование меньше 5 % и колебаний нет → P +10 %;
4. иначе — без изменений.

При изменении P: `I = P` у крена и тангажа, `I = 0.1·P` у рыскания. Пределы `P` 0.01…2.0, `D ≤ 0.2`. При `D = 0` правило D не применяется. Меньше `min_windows` окон — `change: null`, причина «мало манёвров».

**Калибровка** `osc_min_amplitude` и `d_noise_threshold` — на логе пользователя (скрипт в scratchpad, в репозиторий не коммитить). Значения и обоснование — в комментарии правила и в отчёте; координатор занесёт их в дизайн.

**Тесты:**

- метрики системы второго порядка с известными ζ и ωn: перерегулирование `exp(−πζ/√(1−ζ²))`, нарастание и установление — с допуском;
- апериодический отклик даёт перерегулирование 0 и `osc: null`;
- синтетические колебания после установления определяются с частотой;
- каждое правило ровно на пороге (20 / 5 %, граница «высоких» колебаний);
- `I = P` и `I = 0.1·P`;
- пределы (P 0.0105 −10 % → 0.01, D 0.19 +… не больше 0.2);
- `D = 0` у рыскания;
- мало окон.

**Коммит:** `TuneWizard: core/pidtune.js — метрики отклика и правила` (+ трейлер), push.

---

### Задача 6: `core/pidtune.js` — оценка объекта, модель регулятора, прогноз, варианты

**Файлы:** изменить `TuneWizard/core/pidtune.js`, `tests/tunewizard-pidtune.test.cjs`.

**Модель** (раздел 4 дизайна, `AC_PID.cpp` `update_all`). Частота контура — `SCHED_LOOP_RATE`; при `FSTRATE_ENABLE > 0` — предупреждение, как на шаге 3.

```
C(z) = H_FLTE(z) · ( Kp + Ki·dt / (1 − z⁻¹) + Kd · (1 − z⁻¹)/dt · H_FLTD(z) )
```

- H_FLTE и H_FLTD — `pid_lowpass_response` из `core/lowpass.js`;
- `FF` — на цели, вне контура;
- регулятор работает в рад/с, поэтому `Act` в °/с переводится в рад/с: `L = C · P_°/с / R2D`.

```js
// Объект P(f) = Act/Out по окнам отклика (цель больше target_min_dps), взаимные спектры: H = S_yu/S_uu,
// когерентность γ² = |S_yu|² / (S_uu·S_yy). → { freq, H: [[re, im]], coh: [], windows } | null
function pidtune_plant(axis, set_index, range, window_size, rules = pidtune_rules) { … }
// Регулятор C(f) на частотах freq: gains = { P, I, D, FF }, filters = { flte, fltd }, loop_rate → { C: [[re, im]], FF }
function pidtune_controller(gains, filters, loop_rate, freq) { … }
// Поправка объекта на другие фильтры гироскопа (шаги 2–3): отношение передаточных функций новых и старых
// фильтров (load_filters + filter_transfer, среднее по окнам FFT гироскопа в интервале) на частотах freq
// → [[re, im]]; null без данных гироскопа (тогда без поправки, предупреждение в вердикте)
function pidtune_gyro_ratio(old_values, new_values, gyro_ctx, freq) { … }
// Прогноз для коэффициентов gains: L = C·P, T = (C + FF)·P / (1 + C·P); частота среза |L| = 1, запас фазы,
// запас по амплитуде; отклик на ступеньку обратным FFT, как в pid_step_response; метрики — pidtune_step_metrics.
// → { L, T, crossover_hz, pm_deg, gm_db, step: { time, y }, metrics } | null
function pidtune_predict(plant, gains, filters, loop_rate, ratio, rules = pidtune_rules) { … }
// Достоверность: прогноз для коэффициентов лога против измеренного среднего отклика (RMS разницы на 0…step_length_s
// не больше validation_rms_max) и когерентность объекта на частоте среза не ниже coherence_min
// → { valid, reason, rms, coh_at_crossover }
function pidtune_validate(prediction_log, measured_mean, plant, rules = pidtune_rules) { … }
// Варианты оси: «Как в логе», «По правилам» (pidtune_rule), P ±10 % (I по правилу), D ±10 % (без D при D = 0);
// одинаковые — один раз (candidate_key), у оставшегося same_as. → [{ id, title, values: { P, I, D } }]
function pidtune_candidates(log_gains, rule, axis, rules = pidtune_rules) { … }
// Отметки варианта против прогноза лога: low_pm (< pm_min_deg), pm_drop (хуже лога > pm_max_drop_deg),
// overshoot (прогноз > overshoot_pred_max_pct), incomplete (нет прогноза); отказ при сомнении
function pidtune_flags(pred, pred_log, rules = pidtune_rules) { … }
```

Новые правила в `pidtune_rules`:

- `pm_min_deg: 30`, `pm_max_drop_deg: 5`, `overshoot_pred_max_pct: 20` — решение пользователя 25.10.2026;
- `coherence_min: 0.5` **[наше]**;
- `validation_rms_max` **[наше]** — калибровка на логе.

**Тесты:**

- **Регулятор:** при `FLTE 0`, `FLTD 0`, `Ki 0`, `Kd 0` C = Kp; фаза I-части −90° на низкой частоте; совпадение со своей комплексной моделью.
- **Объект:** синтетический замкнутый контур во времени с известным объектом (первый порядок + интегратор + задержка) и регулятором — разностные уравнения `update_all`, цель — случайные ступеньки и белый шум, датчику — шум. Оценка восстанавливает объект в полосе с γ² > 0.9 с допуском.
- **Прогноз и проверка:** прогноз для коэффициентов «лога» повторяет «измеренный» отклик той же синтетики, `valid: true`. Испорченный объект (случайная фаза) даёт `valid: false` с причиной.
- **Запас фазы:** на аналитической L совпадает с вычисленным вручную.
- **Варианты и отметки:** отметки ровно на порогах; дедупликация; D ±10 % отсутствует при D = 0.

**Замер на логе пользователя** (скрипт в scratchpad, в репозиторий не коммитить), по каждой оси:

- окна, когерентность на частоте среза, частота среза, запас фазы по логу;
- `valid` и RMS;
- для каждого варианта — запас фазы, перерегулирование, отметки;
- время расчёта.

Если прогноз на логе недостоверен — не подгонять, объяснить в отчёте. Координатор решит с пользователем.

**Коммит:** `TuneWizard: core/pidtune.js — оценка объекта, модель AC_PID, прогноз и варианты` (+ трейлер), push.

---

### Задача 7: шаг 4 — страница без графиков

**Файлы:** создать `TuneWizard/steps/step4.js`; изменить `TuneWizard/index.html` (секция `data-step="4"`, подключить после `steps/step3.js`), `TuneWizard/wizard.js` (`step4_init`, `on_show_step(4)` → `step4_show`, `step4_reset`).

**По образцу `steps/step3.js`** (общий модуль задачи 1):

- **Загрузка PID** — `load_pid` один раз на лог (при первом показе шага, под оверлеем).
- **Ключ расчёта:** интервал, окно, набор, notch и фильтры шагов 2–3 (для `pidtune_gyro_ratio`).
- **Вкладки** «Крен», «Тангаж», «Рыскание» (радиокнопки или кнопки с `aria-selected`); сводка по осям над вкладками.
- **Вердикт оси:**
  - отклик;
  - предложение;
  - прогноз или «прогноз недостоверен: …»;
  - «мало манёвров», «D выключен»;
  - шум D — «горячие моторы»;
  - предупреждения модели (`NEF`, `FSTRATE_ENABLE`, `FF`).
- **Плитки метрик:** нарастание, перерегулирование, установление, колебания, шум D, окна, частота среза и запас фазы по логу.
- **Таблица вариантов:** `P / I / D`, запас фазы, частота среза, перерегулирование и нарастание в прогнозе с разницей к логу, отметки словами, выбор, «рекомендуется» у «По правилам». Если он помечен, вердикт называет лучший неотмеченный.
- **Окно FFT** — поле (512 по умолчанию, степень двойки). **Набор параметров** — выбор, если наборов больше одного в интервале.
- **Форма** — своя, `pidf_<имя>`: `ATC_RAT_RLL/PIT/YAW_P/I/D`, описания из `../FilterReview/params.json` тем же префиксным обходом, что на шаге 3, «в логе: …», `.changed`. Механизм правок — как на шаге 3: пересчёт через 400 мс, кнопки досчитывают, флаг нажатой кнопки только для левой. Правка — строка «Свой» в таблице своей оси.
- **«Принять»** → `state.steps[4] = { accepted: { имя: значение }, axes: { roll: { candidate_id, flags, metrics }, … }, calc_key, evaluated_at }`. Пустые и отрицательные значения не принимаются. Вердикт «Принято» или «Принято, но …»; затем `set_step(5)`, если доступен.
- **«Открыть в PIDReview»** — как «Открыть в FilterReview» на шаге 1 (`steps/step1.js`).

**Проверка в браузере** — одноразовый скрипт Playwright в scratchpad: лог пользователя, шаг 4, три вкладки, таблица, вердикт, «Свой», «Принять». Ошибок консоли нет; скриншот посмотреть.

**Коммит:** `TuneWizard: шаг 4 — оси, варианты PID с прогнозом, форма и «Принять»` (+ трейлер), push.

---

### Задача 8: графики шага 4 и браузерный тест

**Файлы:** изменить `TuneWizard/steps/step4.js`, `TuneWizard/index.html`, `tests/tunewizard-browser.cjs`.

**Графики** (реестр `plots.js`, хуки `on_theme`, данные на месте). Ось — выбранная вкладка, вариант — выбранная строка.

- **`StepResp4`** — отклик на ступеньку: окна бледно (`legendonly` при многих наборах), измеренное среднее, прогноз выбранного варианта (сплошная), прогноз «как в логе» (пунктир); линии 1.0 и ±5 %.
- **`TarAct4`** — цель и факт во времени за интервал (прореживание для отрисовки, если точек много).
- **`DSpec4`** — спектр D-составляющей и выхода (дБ) с вертикалью на `d_noise_hz`.
- **`LBode4`** — амплитуда и фаза L лога и выбранного варианта, логарифмическая ось частот; отметки частоты среза и −180° + запас. Только при достоверном прогнозе, иначе пусто с подписью.

**Браузерный тест** (после шага 3, до повторной загрузки лога):

- шаг 4 открыт, три вкладки, у каждой оси вердикт и таблица;
- на логе пользователя у крена и тангажа окон ≥ 10;
- рекомендованный вариант есть;
- прогноз достоверен или причина названа (зафиксировать факт лога);
- переключение вкладки меняет графики;
- правка `#pidf_ATC_RAT_RLL_P` с немедленным щелчком «Принять» (регрессия правок, `step4.edit_timer != null` перед щелчком) → строка «Свой», `state.steps[4].accepted.ATC_RAT_RLL_P` — значение формы;
- графики с данными, фон `--surface`, ширина как у контейнера (проверка до первого снимка — по образцу проверки после перезагрузки страницы);
- повторная загрузка лога сбрасывает `state.steps[4]`;
- скриншот `step4.png`;
- итоговая строка «шаги 0–4 пройдены» и строка про шаг 4 (оси, рекомендации, достоверность прогноза).

**Коммит:** `TuneWizard: шаг 4 — графики и браузерный тест` (+ трейлер), push.

---

### Задача 9: Readme, описание тестов, финальный прогон

- **`TuneWizard/Readme.md`:**
  - структура: `steps/common.js`, `core/pid.js`, `core/pidtune.js`, `steps/step4.js`;
  - раздел «Как шаг 4 предлагает PID» — правила, прогноз, проверка достоверности, отметки;
  - проверки — шаги 0–4 и `test:tunewizard-pid-compare`;
  - готовность — этап 4.
- **`tests/README.md`:** `tunewizard-pid.test.cjs`, `tunewizard-pidtune.test.cjs`, `tunewizard-pid-compare.cjs`, браузерный тест шагов 0–4.
- **Все проверки зелёные**, включая `npm run test:tunewizard-pid-compare`.
- **Коммит** `TuneWizard: Readme и описание тестов для этапа 4` (+ трейлер), push. Журнал обновляет координатор.

---

## Что сознательно не вошло в этап 4

- Спектрограмма и спектры P/I/FF/Err — есть в PIDReview, кнопка «Открыть в PIDReview».
- Угловые `ATC_ANG_*`, `FF`, пределы скорости и ускорения — шаг их не предлагает.
- AnalyticTune и полёты System Identification.
- Сводка, итоговый `.param`, память прохода — этап 5.
