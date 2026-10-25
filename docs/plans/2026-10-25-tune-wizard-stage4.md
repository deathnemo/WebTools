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

**Окно FFT шага 4:** по умолчанию 512 — как в PIDReview (поле `FFTWindow_size`, value 512). После перехода на КИХ МНК (задача 5) окно действует на спектр D (шум D) и отклик PIDReview на графике; отбор отрезков КИХ, проверки качества и прогноз — окнами 512 с шагом 32 (решение по задаче 7).

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

Исправляются дефекты 1, 2, 3, 5 и 6; дефект 4 не исправляется (см. ниже), дефект 7 — только запись.

**Найдено в задаче 2** (шапка `core/pid.js`, ревью 25.10.2026), семь дефектов:

1. быстрая повторная смена параметров — отсчёты разрыва в первом пакете нового набора, частота занижена;
2. потеря последнего отсчёта пакета — частота завышена в count/(count−1);
3. пакет целиком вне интервала даёт одно окно;
4. сила регуляризации зависит от амплитуды цели (добавка из PID-Analyzer для ненормированных спектров) — **не исправляется** (решение по итогам исследования 25.10.2026): отклик PIDReview остаётся только для графика и сравнения, метрики — КИХ МНК (задача 5); дефект описан в шапке `core/pid.js`;
5. частота лога PID ниже 100 Гц — нулевой отклик (PIDx и RATE пишутся с 10 Гц, если в `LOG_BITMASK` нет ATTITUDE_FAST — заводская маска);
6. лог без PARM — `TypeError` вместо сообщения;
7. только интерфейс upstream: устаревшее среднее после пересчёта — в переносе не воспроизводится, только запись.

**Защита от редкого лога PID** (к дефекту 5), здесь же:

- проверка шага 0 `pid_log` (`core/checks.js`) — `warn`, если частота PIDR (или RATE) ниже 100 Гц, с советом включить ATTITUDE_FAST в `LOG_BITMASK`;
- шаг 4 (задача 7) — вердикт оси «частота лога PID N Гц — отклик не считается» вместо нулевого отклика.

**Коммит:** `TuneWizard: исправления дефектов, унаследованных из PIDReview` (+ трейлер), push.

---

### Задача 5: `core/pidtune.js` — измеренный отклик (КИХ МНК), проверки качества, метрики и правила

**Файлы:** создать `TuneWizard/core/pidtune.js`, `tests/tunewizard-pidtune.test.cjs`; подключить `core/pidtune.js` в `index.html` после `core/pid.js`.

**Основа** — раздел 3 дизайна (переписан после исследования 25.10.2026). Рабочие прототипы исследования — `C:\Users\taa03\AppData\Local\Temp\claude\c--Users-taa03-Desktop-Repo-WebTools\602a6c14-2807-460e-97b1-5cbfa3d21d83\scratchpad\step_method\`:

- `common.mjs` — КИХ МНК, симуляция `AC_PID::update_all`, объект, правда;
- `quality.mjs` — проверки качества;
- `outer_check.mjs` — подпись углового контура;
- `synth_compare.mjs` — сценарии;
- выводы `out_*.txt`.

Переносить логику оттуда в стиль ядра можно, копировать как есть — нет.

```js
const pidtune_rules = {
    target_min_dps: 20,          // окно — |цель·Ханн| больше 20 °/с [PIDReview, redraw_step]
    window: 512, window_step: 32, // отрезки КИХ: окно и шаг, центр окна в интервале [наше, как отбор PIDReview]
    fir_length_s: 1.0,           // длина КИХ [наше, исследование]
    fir_ridge: 1e-3,             // гребень λ·c_rr(0) [наше]
    fir_ridge_check: 1e-2,       // второй λ для проверки (а) [наше]
    step_length_s: 0.5,          // длина отклика [PIDReview]
    plateau_s: [0.3, 0.5],       // плато — среднее на этом отрезке [наше]
    min_windows: 10,             // меньше — «мало манёвров» [наше]; после ревью — min_data_s: 10 (секунды данных)
    min_log_rate_hz: 100,        // ниже — отклик не считается (LOG_BITMASK без ATTITUDE_FAST) [наше, дефект upstream 5]
    settle_band: 0.05,           // установление ±5 % от плато [наше]
    osc_min_pp: 0.08,            // остаточные колебания — размах от пика до пика не меньше [наше, шум плато КИХ ±0.02–0.03]
    overshoot_high_pct: 20, overshoot_low_pct: 5, // [наше; wiki — логика P до раскачки]
    osc_band_ratio: 3,           // «высокие» колебания — выше 3 полос 0.35/t_нарастания [наше]
    quality: { ridge_rms_max: 0.03, halves_rms_max: 0.035, outer_t_max: 1.5, outer_band_hz: [4, 12] }, // проверки (а)–(в) [наше, исследование]
    gain_step: 0.10,             // ±10 % [wiki]
    yaw_i_ratio: 0.1,            // [код, AUTOTUNE_YAW_PI_RATIO_FINAL]
    p_min: 0.01, p_max: 2.0, d_max: 0.2, // [код, AUTOTUNE_RP_MIN/MAX, AUTOTUNE_RD_MAX]
    d_noise_hz: 50,              // [наше]
    d_noise_threshold: null,     // [наше] — калибровка на логе
}
// Отрезки оси для КИХ: окна window с шагом window_step по пакетам набора set_index, где |цель·Ханн| ≥ target_min_dps
// и центр окна в range → { segments: [{ tar, act }], rate_hz } | null
function pidtune_segments(axis, set_index, range, rules = pidtune_rules) { … }
// КИХ МНК «цель → факт»: нормальные уравнения по автокорреляции и взаимной корреляции, суммированным по отрезкам
// (Тёплиц, Холецкий), гребень ridge·c_rr(0), h[0] = 0; длина fir_length_s·rate_hz
// → { h, step: накопленная сумма h на 0…step_length_s, time, windows } | null
function pidtune_fir(segments, rate_hz, ridge = pidtune_rules.fir_ridge, rules = pidtune_rules) { … }
// Проверки качества (а) RMS КИХ при fir_ridge против fir_ridge_check, (б) RMS КИХ по первой половине отрезков против
// второй, (в) наибольшее |T_H1| («цель → факт» по усреднённым спектрам) на outer_band_hz
// → { ok, checks: { ridge: { value, ok }, halves: {…}, outer: {…} }, reasons: [текст] }
function pidtune_quality(segments, rate_hz, fir, rules = pidtune_rules) { … }   // после ревью: (segments, rate_hz, fir, { rate_only }, rules) — см. блок API в задаче 6
// Метрики отклика (time, step; цель = 1): нарастание 10–90 % и перерегулирование — от 1, плато — среднее на plateau_s,
// установление ±settle_band — от плато, колебания — частота и размах после установления (не меньше osc_min_pp)
// → { rise_s, overshoot_pct, plateau, settle_s, osc: { freq_hz, amplitude_pp } | null, bandwidth_hz }
function pidtune_step_metrics(time, step, rules = pidtune_rules) { … }
// Шум D выше d_noise_hz по спектру D оси (pid_run_batch_fft) за интервал → { dB, over } | null (нет D — null)
function pidtune_d_noise(axis, set_index, range, rules = pidtune_rules) { … }
// Режим лога для оси: Acro «Rate Loop Only» (ACRO_OPTIONS бит 1 и режим ACRO занимает интервал), смешение режимов в интервале,
// частота лога PID → { rate_only, mixed_modes: [имена], i_scale (ATC_ANG_*_P при rate_only и версии ≥ 4.7, иначе 1), low_rate }
function pidtune_log_mode(log, params, version, range, axis_name, rate_hz, rules = pidtune_rules) { … }
// Предложение по правилам (раздел 3 дизайна) — только при надёжном измерении (quality.ok) и достаточном числе окон
// → { change: "P-" | "P+" | "D-" | null, reason, values: { P, I, D }, limited }
function pidtune_rule(gains, axis, metrics, windows, quality, rules = pidtune_rules) { … }   // после ревью: четвёртый аргумент — data_s (секунды отобранных данных), см. блок API в задаче 6
```

**Калибровка на логе пользователя** (скрипт в scratchpad, в репозиторий не коммитить): `d_noise_threshold`. Проверить, что на интервале 49–540 с проверка (б) не проходит у всех осей, а на 80–464 с (только Acro) крен и тангаж не проходят (а) и (в), рыскание проходит (а) и (в) — как в исследовании. Числа — в отчёт. Итог задачи 5: рыскание на 80–464 с не проходит (б) — 0.071 (в исследовании 0.059, тоже выше порога); надёжной оси на логе пользователя нет ни на одном интервале (раздел 3 дизайна).

**Тесты:**

- **Метрики:** система второго порядка с известными ζ и ωn (перерегулирование `exp(−πζ/√(1−ζ²))`, нарастание, установление от плато); апериодический отклик; колебания на плато выше и ниже порога 0.08.
- **КИХ на синтетике** — замкнутый контур во времени (регулятор — разностные уравнения `update_all`, объект — интегратор × мотор × задержка × фильтр гироскопа):
  - без углового контура (rate-only): отклик КИХ совпадает с правдой — перерегулирование ±2 пункта, нарастание ±5 мс;
  - h[0] = 0;
  - проверки (а)–(в) проходят.
- **Отказ проверок:**
  - с угловым контуром, формирующим цель из факта, — проверка (в) не проходит;
  - смена объекта в середине данных — проверка (б) не проходит.
- **Режим лога:** `ACRO_OPTIONS` 2 и режим ACRO → `rate_only`; версия 4.7 → `i_scale = ATC_ANG_*_P`, 4.6 → 1; смешение режимов; частота 10 Гц → `low_rate`.
- **Правила:** каждое ровно на пороге; `I = P` и `I = 0.1·P`; пределы; `D = 0`; ненадёжное измерение и мало данных → `change: null` с причиной.

**Коммит:** `TuneWizard: core/pidtune.js — отклик КИХ МНК, проверки качества, метрики и правила` (+ трейлер), push.

---

### Задача 6: `core/pidtune.js` — модель регулятора, прогноз из измеренной T, варианты и отметки

**Файлы:** изменить `TuneWizard/core/pidtune.js`, `tests/tunewizard-pidtune.test.cjs`.

**Основа** — раздел 4 дизайна: прогноз из измеренной T, оценки объекта «выход → факт» нет. Прототип прогноза — `scratchpad\step_method\predict_test.mjs`.

**API задачи 5 после ревью** (`94227b2` и правки по ревью; подробности — раздел 3 дизайна):

- `pidtune_quality(segments, rate_hz, fir, { rate_only }, rules)` — в Acro «Rate Loop Only» проверка (в) не применяется: `checks.outer = { value, freq_hz, ok: null, applied: false, note }`, в `ok` не входит. Режим — `pidtune_log_mode(…).rate_only`; синтетику rate-only в тестах этой задачи проверять с `{ rate_only: true }`, иначе резонансный пик |T| плохо задемпфированного варианта (P +30 %) даст «ненадёжно».
- `pidtune_segments` → ещё `data_s` (секунды отобранных данных); порог данных — `pidtune_rules.min_data_s` (10 с) вместо `min_windows`.
- `pidtune_rule(gains, axis, metrics, data_s, quality, rules)` — четвёртый аргумент — секунды данных, а не число окон; порядок отказов: нет коэффициента → мало данных → ненадёжно → нет отклика.
- `pidtune_step_metrics` → `null` при нечисловом в отклике; `pidtune_fir` → `null` при NaN или Infinity в данных; `pidtune_d_noise` при нулевой D → `{ dB: null, off: true }`.

**API задачи 6 после ревью** (`2019176` и правки по ревью; подробности — раздел 4 дизайна). Комплексные массивы — как в `Libraries/Array_Math.js`: `[re[], im[]]`.

```js
// Регулятор C(f) — модель AC_PID: H_FLTE·(Kp + Ki·i_scale·dt/(1 − z⁻¹) + Kd·(1 − z⁻¹)/dt·H_FLTD); FF = Kff + Kdff·(1 − z⁻¹)/dt
// отдельно (вне контура); на 0 Гц при Ki ≠ 0 — C = Infinity; нечисловые коэффициенты, фильтры и i_scale (и null) — NaN
// → { freq, C: [re[], im[]], FF: [re[], im[]], ki: Ki·i_scale, loop_rate }
function pidtune_controller(gains, filters, loop_rate, freq, i_scale = 1) { … }
// Есть ли у набора компоненты P, I, D (PIDx); у оси RATE нет
function pidtune_has_components(axis, set_index) { … }
// Сверка регулятора по данным: C_изм = S_oe/S_ee (e = Tar − Act, o = P + I + D; окна 1024 с шагом 64, отбор как у
// отрезков КИХ) против модели на бинах 2–20 Гц: ||r| − 1| и |∠r|. Ось RATE — не запускается (skipped "rate")
// → { ok, max_mag_err, max_phase_err_deg, worst_hz, min_coherence, windows, skipped: null | "rate" }
function pidtune_controller_check(axis, set_index, range, gains, filters, loop_rate, i_scale = 1, rules = pidtune_rules) { … }
// Поправка фильтров гироскопа: mean(H_new)/mean(H_old) по окнам FFT гироскопа в интервале (load_filters + filter_transfer);
// одинаковые наборы — ровно 1 → [re[], im[]] | null (без данных гироскопа — без поправки)
function pidtune_gyro_ratio(old_values, new_values, gyro_ctx, freq) { … }
// Сетка прогноза: n — степень двойки ≥ rate_hz / predict_resolution_hz, freq — k·rate_hz/n, k = 0…n/2 → { n, freq }
function pidtune_predict_grid(rate_hz, rules = pidtune_rules) { … }
// Пересечения |L| = 1 сверху вниз выше crossover_min_hz; частота среза и запас — первого (фаза развёрнута от низких
// частот), поздние — справка (главное значение фазы); options.min_over_crossings — наименьший по всем (точная L)
// → { crossover_hz, pm_deg, gm_db, multiple_crossings, crossings: [{ freq_hz, pm_deg }] }
function pidtune_margins(freq, L, rules = pidtune_rules, options = {}) { … }
// Прогноз: T — FFT КИХ на сетке pidtune_predict_grid; φ = FF/C; R = (C_new/C_log)·ratio; L_new = R·T/(1 + φ_log − T);
// T_new = R·T·(1 + φ_new)/(1 + φ_log − T + R·T); предел на 0 Гц (I только у лога — по непрерывности); неустойчив —
// запас первого пересечения ≤ 0 или доля энергии отклика в последней четверти буфера > noncausal_max (тогда step
// и metrics — null). c_log, c_new — на той же сетке (длина и
// шаг freq[1], иначе исключение); c_new строится с FLTE/FLTD, принятыми на шаге 3, c_log — с фильтрами лога
// → { freq, T, L, crossover_hz, pm_deg, gm_db, multiple_crossings, crossings, unstable, noncausal, step | null, metrics | null } | null
function pidtune_predict(fir, c_log, c_new, ratio, rate_hz, rules = pidtune_rules) { … }
// Когерентность γ² «цель → факт» на частоте по окнам отбора отрезков (512) → γ² | null
function pidtune_coherence(segments, rate_hz, freq_hz, rules = pidtune_rules) { … }
// Достоверность прогноза: quality.ok, сверка регулятора (RATE — «по RATE прогноз не считается»), γ² на частоте среза
// лога ≥ coherence_min → { valid, reasons: [текст] }
function pidtune_validity(quality, controller_check, coherence_at_crossover, rules = pidtune_rules) { … }
// Варианты оси: «Как в логе» (как есть), «По правилам», P ±10 % (I по правилу), D ±10 % (только при D > 0); изменённые —
// 4 значащие цифры (pidtune_round); дедупликация (candidate_key) → [{ id, title, values: { P, I, D }, same_as: [id] }]
function pidtune_candidates(log_gains, rule, axis, rules = pidtune_rules) { … }
// Отметки варианта: unstable («контур неустойчив» при запасе ≤ 0, иначе «прогноз неустойчив … или ненадёжен»),
// low_pm (< pm_min_deg), pm_drop (хуже прогноза лога > pm_max_drop_deg),
// overshoot (> overshoot_pred_max_pct), incomplete; отказ при сомнении; числа у порога — от порога (pidtune_beyond)
// → { unstable, low_pm, pm_drop, overshoot, incomplete, flagged, reasons }
function pidtune_flags(pred, pred_log, rules = pidtune_rules) { … }
// Помощники: pidtune_round (4 значащие цифры), pidtune_beyond (число у порога — с округлением от него),
// pidtune_spectra (суммы взаимных спектров по окнам; на нём pidtune_outer_peak и pidtune_coherence).
// pidtune_segments отдаёт у отрезка ещё batch и begin (номер пакета и первый отсчёт — для сверки регулятора).
```

Новые правила в `pidtune_rules`:

- `pm_min_deg: 30`, `pm_max_drop_deg: 5`, `overshoot_pred_max_pct: 20` — решение пользователя 25.10.2026;
- `coherence_min: 0.5` **[наше]**;
- `controller_check: { band_hz: [2, 20], mag_err_max: 0.1, phase_err_max_deg: 10, window: 1024, window_step: 64 }` **[наше]**;
- после реализации: `round_digits: 4` (решение координатора по ревью задачи 5), `predict_resolution_hz: 0.1`, `crossover_min_hz: 0.5`, `noncausal_max: 1e-3` (ревью задачи 6) **[наше]**.

**Тесты:**

- **Регулятор:** частные случаи (только P; фаза I −90° на низкой частоте); совпадение со своей комплексной моделью; `i_scale`.
- **Прогноз на синтетике** (rate-only контур с известными объектом и регулятором):
  - прогноз отклика и запаса фазы для P ±10 %, D ±10 % и P +30 % совпадает с прямой симуляцией новых коэффициентов: перерегулирование ±3 пункта, запас фазы ±5°;
  - для коэффициентов лога прогноз равен измеренному.
- **Сверка регулятора:** верная модель проходит, испорченная (например, Kd ×2) — нет.
- **Поправка фильтров:** одинаковые фильтры дают отношение 1.
- **Варианты и отметки:** отметки на порогах; дедупликация; нет D ±10 % при D = 0; достоверность — каждая причина отказа.
- **После ревью задачи 6:** неустойчивый вариант (K 290, P ×3) — `unstable`, отклика и метрик нет, отметка «контур неустойчив»; неустойчивость по причинности при положительном запасе; второе пересечение |L| = 1 (резонанс) — запас первого (развёрнутая фаза, в том числе ниже −360°), второе — справка с главным значением фазы, наименьший — опцией; повторное ревью: на достоверной оси с редкими манёврами «Свой» D ×3 не «неустойчив» (поздние пересечения от шума КИХ — справка), у K 290 — `low_pm` около 28° (правда 28.9°); рыскание с I = 0 — T_new(0) по непрерывности, не «неустойчив»; ось RATE — сверка не запускается, причина «по RATE прогноз не считается»; поправка фильтров при движущемся notch — отношение средних, а не среднее отношений; другая сетка (тот же размер, другой шаг) — исключение; нечисловой `i_scale` — NaN; числа у порога — с округлением от него.

**Замер на логе пользователя** (скрипт в scratchpad), по каждой оси:

- окна, качество — какие проверки не прошли;
- сверка регулятора;
- частота среза и запас фазы;
- достоверность прогноза: на логе пользователя прогноз недостоверен на всех осях — ни одна ось не проходит проверки качества ни на 49–540 с, ни на 80–464 с (раздел 3 дизайна); показать причины по каждой оси;
- варианты, прогноз и отметки на логе пользователя не проверяются (достоверного прогноза нет) — их проверяют тесты на синтетике rate-only (выше);
- время.

**Коммит:** `TuneWizard: core/pidtune.js — модель AC_PID, прогноз из измеренной T, варианты и отметки` (+ трейлер), push.

---

### Задача 7: шаг 4 — страница без графиков

**Файлы:** создать `TuneWizard/steps/step4.js`; изменить `TuneWizard/index.html` (секция `data-step="4"`, подключить после `steps/step3.js`), `TuneWizard/wizard.js` (`step4_init`, `on_show_step(4)` → `step4_show`, `step4_reset`).

**По образцу `steps/step3.js`** (общий модуль задачи 1):

- **Загрузка PID** — `load_pid` один раз на лог (при первом показе шага, под оверлеем).
- **Ключ расчёта:** интервал, окно, набор, notch и фильтры шагов 2–3 (для `pidtune_gyro_ratio`).
- **Вкладки** «Крен», «Тангаж», «Рыскание» (радиокнопки или кнопки с `aria-selected`); сводка по осям над вкладками.
- **Вердикт оси:**
  - отклик (КИХ МНК, `pidtune_fir`) и качество измерения: при «измерение ненадёжно» — причина, правил и прогноза нет, совет тестового полёта (Acro `ACRO_OPTIONS` «Rate Loop Only», 2–3 минуты резких движений по осям, `LOG_BITMASK` с ATTITUDE_FAST и PID) — решение пользователя 25.10.2026;
  - режим лога: тестовый (Rate Loop Only) — «измерение точное»; смешение режимов — предупреждение; частота лога PID ниже 100 Гц — «включите ATTITUDE_FAST»;
  - предложение;
  - прогноз или «прогноз недостоверен: …»;
  - «мало манёвров», «D выключен»;
  - шум D — «горячие моторы»;
  - предупреждения модели (`NEF`, `FSTRATE_ENABLE`, `FF`).
- **Плитки метрик:** нарастание, перерегулирование, установление, колебания, шум D, окна и секунды отобранных данных, частота среза и запас фазы по логу.
- **Качество измерения:** в `pidtune_quality` передаётся `pidtune_log_mode(…).rate_only`; в Rate Loop Only проверка (в) показывается с пометкой «не применяется (Rate Loop Only)»; в `pidtune_rule` — `seg.data_s` (секунды данных), а не число окон.
- **Таблица вариантов:** `P / I / D`, запас фазы, частота среза, перерегулирование и нарастание в прогнозе с разницей к логу, отметки словами, выбор, «рекомендуется» у «По правилам». Если он помечен, вердикт называет лучший неотмеченный: перерегулирование ближе всего к середине полосы «менять нечего» (12.5 %), при равенстве в пределах 0.5 пункта — без колебаний, затем больший запас фазы (раздел 4 дизайна). «Применить вариант» — как на шаге 3.
- **Окно FFT** — поле (512 по умолчанию, степень двойки; отложенный механизм, как у формы). **Набор параметров** — выбор на вкладке оси, у каждой оси свой, если наборов больше одного в интервале.
- **Форма** — своя, `pidf_<имя>`: `ATC_RAT_RLL/PIT/YAW_P/I/D`, описания из `../FilterReview/params.json` тем же префиксным обходом, что на шаге 3, «в логе: …», `.changed`. Механизм правок — как на шаге 3: пересчёт через 400 мс, кнопки досчитывают, флаг нажатой кнопки только для левой. Правка — строка «Свой» в таблице своей оси.
- **«Принять»** → `state.steps[4] = { accepted: { имя: значение }, axes: { roll: { candidate_id, flags, metrics }, … }, calc_key, evaluated_at }`. Пустые и отрицательные значения не принимаются. Вердикт «Принято» или «Принято, но …»; затем `set_step(5)`, если доступен.
- **«Открыть в PIDReview»** — как «Открыть в FilterReview» на шаге 1 (`steps/step1.js`).

**Проверка в браузере** — одноразовый скрипт Playwright в scratchpad: лог пользователя, шаг 4, три вкладки, таблица, вердикт, «Свой», «Принять». Ошибок консоли нет; скриншот посмотреть.

**Коммит:** `TuneWizard: шаг 4 — оси, варианты PID с прогнозом, форма и «Принять»` (+ трейлер), push.

---

### Задача 8: графики шага 4 и браузерный тест

**Файлы:** изменить `TuneWizard/steps/step4.js`, `TuneWizard/index.html`, `tests/tunewizard-browser.cjs`.

**Графики** (реестр `plots.js`, хуки `on_theme`, данные на месте). Ось — выбранная вкладка, вариант — выбранная строка.

- **`StepResp4`** — отклик на ступеньку: измеренный КИХ МНК (основная линия), прогноз выбранного варианта (сплошная), отклик PIDReview (окна бледно и среднее — `legendonly`, для сравнения с PIDReview; подпись, что он занижен методом); линии 1.0 и ±5 % от плато; при ненадёжном измерении — пометка в легенде и подписи.
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
