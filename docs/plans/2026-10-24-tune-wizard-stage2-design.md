# Мастер настройки — этап 2: спектр гироскопов и гармонический notch (дизайн)

Дата: 24.10.2026. Статус: утверждён в обсуждении. Основа — `2026-10-23-tune-wizard-design.md` (общий дизайн) и итоги этапа 1 (`2026-10-23-tune-wizard-stage1.md`).

## 1. Цель этапа

Шаги 1 («Спектр до фильтров») и 2 («Гармонический notch») мастера: перенос математики FilterReview в DOM-независимое ядро, реестр графиков с темами, полный набор органов управления спектром как в FilterReview (решение пользователя 24.10.2026), автоподбор первого notch по методу PR ArduPilot/WebTools#363, метрики и предложение второго notch, регрессионная проверка против FilterReview на одном логе.

## 2. Стратегия переноса — «минимальный дифф»

Файлы ядра повторяют структуру upstream, чтобы будущие изменения FilterReview переносились диффом:

| Файл | Источник (upstream) | Содержимое |
|---|---|---|
| `core/gyro.js` | `FilterReview.js` 2051–2344 (загрузчики), 277–352 (`run_batch_fft`), 795–891 (`calculate`), части `load` 2375–2395, 2546–2572, 2619–2677 | `load_gyro(log, params, info, opts)`, `gyro_fft(gyro, opts)`, подготовка `Z1/Z2/bode`, `have_pre/have_post`, первичный гироскоп |
| `core/filters.js` | 12–275, 893–955, 1058–1108, 1295–1358, 1396–1459, 1193–1279 | Biquad/Notch/MultiNotch/HarmonicNotch, `transfer_functions`, `estimate_post`, `bode_mean`, `get_phase`, статистика линий notch |
| `core/tracking/{BaseClass,Static,Throttle,RPM,ESC,FFT,Logged,Atmosphere_model}.js` | `FilterReview/tracking/*.js` | один в один |
| `core/spectrum.js` | 1131–1184, 973–1028, 1517–1577, 1581–1671, 1466–1475 | средний спектр по интервалу, алиасинг, матрица спектрограммы, линии трекинга |
| `core/autofit.js` | PR #363 `FilterReview/AutoFit.js` | автоподбор первого notch |
| `core/metrics.js` | новое (на базе функций пиков из PR #363) | пики спектра, превышение над шумом, атрибуция «моторы/рама» |
| `core/params.js` | `Param_Helpers.get_param_download_text`, `get_HNotch_param_names` | имена параметров notch, текст `.param`, реестр предложений (минимум для этапа 2) |

Механические замены при переносе:

- `get_filter_version()` → `env.filter_version` (объект `env = { filter_version, params, build_type, range }` передаётся в конструкторы тракинга и `HarmonicNotchFilter`);
- глобал `Gyro_batch` → аргумент `gyro`; `tracking_methods` → `tracking` (массив в том же порядке: Static, Throttle, RPM1, ESC, FFT, RPM2); `logged_tracking` → `logged`;
- `find_start_index(time)` / `find_end_index(time)` (читают поля формы) → `find_start_index(time, range)` / `find_end_index(time, range)` с `range = [t0, t1]`;
- `document.getElementById("FFTWindow_size"/"FFTWindow_per_batch")` → `opts.window_size` / `opts.window_per_batch`;
- `alert(...)` → накопление предупреждений (`warnings.push(...)`) или возвращаемый `{ error }`; ядро не трогает `window`;
- `get_param_value(PARM, name)` → `params.get(name)`; `TimeUS_to_seconds` → `us_to_s`; `get_version_and_board(log).build_type` → `env.build_type`;
- `get_air_density_model()` вызывать как `new` или переписать на объект (upstream опирается на `this` = `window`).

**Сначала — верно, потом — лучше.** Перенос воспроизводит upstream численно (включая известные дефекты), чтобы регрессионный тест против FilterReview был строгим. Дефекты исправляются отдельной задачей после установления базовой линии:

1. `run_batch_fft`: проверка `data_set[i].x.length < window_size` выполняется до присваивания `window_size` (hoisting) и никогда не срабатывает; `sample_rate_sum` суммирует `data_set[0]` вместо `data_set[i]`.
2. `load_from_raw_log`: `slice(batch_start, j-i)` — `i` здесь номер экземпляра гироскопа, а не смещение.
3. `load_from_batch`: `return` при неполной последовательности оставляет `Gyro_batch` недостроенным.
4. `ThrottleTarget` без `RATE` (и без `CTUN` на Copter) получает `mode_value = null` → «Unsupported notch mode» для MODE 1.
5. `load_from_batch` (FR 2118–2122): пакет, заканчивающийся ровно на последнем сообщении ISBD лога, считается неполным и отбрасывается.

## 3. Реестр графиков `TuneWizard/plots.js`

- `register_plot(id, data, layout, { on_theme })` — регистрирует контейнер; `render_plot(id)` — `Plotly.react`; `plot(id)` — доступ к `data/layout`.
- `restyle_plots()` применяет `plot_layout_theme()` ко всем зарегистрированным графикам: `paper_bgcolor`, `plot_bgcolor`, `font`, каждая ось `/^[xy]axis\d*$/`, `rangeslider`, `colorbar`; затем вызывает `on_theme(palette)` графика для цветов линий. Вызывается при смене темы и при показе шага.
- `plot_palette()` из токенов: оси X/Y/Z → `--accent`, `--low`, `--ok`; предупреждение → `--high`; стили линий: pre — сплошная, оценка post — пунктир (`dash`), логированное post — точки (`dot`); гироскопы 2 и 3 — та же палитра с прозрачностью 0.65 и 0.4. Градиент спектрограммы — Viridis (единственное исключение из правила «цвета только из токенов»: тепловой карте нужен непрерывный ряд).
- Помощники темы `css_token`, `plot_layout_theme`, палитра и `restyle_plots` переезжают из `wizard.js` в `plots.js`; график полёта шага 0 регистрируется первым (регрессия — браузерный тест этапа 1).
- Один классический скрипт на шаг: `TuneWizard/steps/step1.js`, `steps/step2.js`; `wizard.js` остаётся каркасом (состояние, навигация, шаг 0). Все они делят `state`; `core/` по-прежнему не объявляет `state`, `US2S`, `css_token`, `stat_tile`, `html_escape`.

## 4. Панель настроек спектра (общая для шагов 1–2)

Состояние `state.spectrum`: `log_type` (batch/raw, если есть оба), `window_size` (общее с шагом 0) и `window_per_batch` (для batch), `amplitude` (linear/dB/PSD, по умолчанию dB), `frequency` (Hz/RPM), `log_frequency` (bool), `aliasing` (none/fold/only), `filter_version` (из `VER.FV`, редактируется). Кнопка «Пересчитать» с оверлеем; пересчёт FFT только при смене типа лога/окна, смена шкал — перерисовка без FFT (как `re_calc`/`redraw` в FilterReview).

## 5. Шаг 1 · Спектр до фильтров

- Средний спектр: до трёх гироскопов × X/Y/Z × pre / логированное post / оценка post; видимость через легенду Plotly с группами по гироскопу; первичный гироскоп виден, остальные скрыты по умолчанию.
- Спектрограмма: гироскоп / pre–post–оценка / ось; линии логированных notch (`FTN`/`FTNS`), если есть.
- Таблица пиков (`core/metrics.js`): локальные максимумы ≥ 6 дБ над медианой шума в окне ±50 Гц без ±max(2 Гц, 2 бина) вокруг пика (метод окон из PR #363), отдельно по осям X/Y/Z со слиянием пиков ближе max(2 Гц, 2 бина) — в строке оси, где пик найден; источник: «моторы, гармоника N», если отношение частоты к моторной частоте отличается от целого N (1…8) не больше чем на 0.1 порядка, иначе «рама/резонанс». Моторная частота — медиана ESC (иначе цели газа) за интервал, уточнённая по пику первой гармоники в спектре. Это запасной способ: на шаге 2 основным станет порядковый спектр автоподбора PR #363 (`auto_fit_order_spectrum`).
- Вердикт: главный шум (частота, источник), есть ли пики выше `INS_GYRO_FILTER`.
- «Открыть в FilterReview» через `Libraries/OpenIn.js`.

## 6. Шаг 2 · Гармонический notch

- Форма: `INS_GYRO_FILTER`, `SCHED_LOOP_RATE`, `INS_HNTCH_*`, `INS_HNTC2_*` через `Libraries/ParameterMetadata.js` + `../FilterReview/params.json` (подписи, описания, маски `HMNCS/OPTS/ESCMSK`, список `MODE`); у каждого поля «в логе: …» и подсветка изменённого; `ESCMSK` только при версии фильтра ≥ 4, размер маски `HMNCS` 8/32 как в `update_hidden_params`.
- Кнопки: «Автоподбор» (первый notch, строка-пояснение об источнике), «Пересчитать фильтры», «Сохранить .param», «Загрузить .param».
- Графики: спектр pre / оценка post / логированное post с линиями notch (среднее и диапазон); бодэ (амплитуда и фаза, «свернуть фазу», выбор гироскопа); спектрограмма с опцией «оценка».
- Метрики: главный пик до/после (дБ), ослабление, фазовая задержка на 10/20/50 Гц (из бодэ). Если после notch остаётся некратный пик ≥ 6 дБ — предложение статического `INS_HNTC2` (кнопка «Применить»).
- «Принять» → `state.steps[2].accepted = { параметры }` + метрики; открывает шаг 3.
- Доступность шагов 1–3 на шаге 0 — по результату проверки `gyro_log` (fail → закрыты), шаг 4 — по `pid_log`.

## 7. Тесты и регрессия

- Node (`tests/tunewizard.test.cjs`): notch — заданное ослабление в центре и ≈0 дБ вдали; biquad −3 дБ на срезе; `run_batch_fft` синусоиды — пик в нужном бине с верной амплитудой; оценка «после» = pre × |H|; тракинг (газ `freq·√(thr/ref)`, усреднение ESC с маской и тайм-аутом, `FM_RAT`); автоподбор на синтетическом спектре; пики и атрибуция; загрузчики на поддельных `ISBH/ISBD` и `GYR`.
- Регрессия против FilterReview в Chrome (`tests/tunewizard-compare.cjs`): один лог, одинаковые окно и интервал; из FilterReview читаются глобалы `fft_plot.data`, `Bode.data`, `Spectrogram.data`; сравнение с данными графиков мастера (спектры pre/post/est X/Y/Z первичного гироскопа, амплитуда и фаза бодэ, матрица спектрограммы), допуск 1e-6. После задачи исправления дефектов расхождения документируются.
- Браузерный smoke (`tests/tunewizard-browser.cjs`) расширяется шагами 1–2.

## 8. Задачи

1. `plots.js`: реестр, перенос графика полёта и помощников темы; smoke-тест без изменений.
2. `core/gyro.js`: загрузчики, FFT, подготовка Z/bode, pre/post, первичный гироскоп; тесты.
3. `core/tracking/*` и `core/filters.js`; тесты.
4. `core/spectrum.js` и бодэ/фаза; тесты.
5. Шаг 1 (`steps/step1.js`, разметка, панель настроек, спектр, спектрограмма, пики, вердикт, «Открыть в FilterReview»); регрессионный тест против FilterReview.
6. `core/autofit.js`; тесты.
7. Шаг 2 (`steps/step2.js`, форма с метаданными, автоподбор, графики, метрики, `.param`, «Принять»); браузерный тест.
8. Исправление дефектов upstream отдельным коммитом с тестами; заметка для возможного PR в ArduPilot.
9. Readme, память, push.

## 9. Источники

- `FilterReview/FilterReview.js`, `FilterReview/tracking/*.js`, `Libraries/fft.js`, `Libraries/Array_Math.js`, `Libraries/ParameterMetadata.js`, `FilterReview/params.json` (upstream 05d6177).
- PR ArduPilot/WebTools#363 (`FilterReview/AutoFit.js`, 378 строк), PR #362 (третий и четвёртый notch — не переносим), PR #367.
- Карта зависимостей переносимого кода (обзор 24.10.2026): DOM-связность только через `get_filter_version()`, `alert()`, `find_start/end_index`, поля `FFTWindow_*`; тракинг-классы `document` не используют.
