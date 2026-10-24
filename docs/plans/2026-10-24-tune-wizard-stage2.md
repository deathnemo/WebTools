# Мастер настройки — этап 2: спектр гироскопов и гармонический notch (план реализации)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Цель:** шаги 1 («Спектр до фильтров») и 2 («Гармонический notch») мастера на математике FilterReview, перенесённой в DOM-независимое ядро; реестр графиков с темами; автоподбор первого notch; регрессия против FilterReview на одном логе.

**Архитектура:** по `docs/plans/2026-10-24-tune-wizard-stage2-design.md`. Ядро `TuneWizard/core/` — классические скрипты без `document`, структура повторяет upstream («минимальный дифф»); `TuneWizard/plots.js` — реестр графиков и тема; `TuneWizard/steps/step1.js`, `steps/step2.js` — интерфейс шагов; `wizard.js` — каркас. Перенос сначала численно точный (включая известные дефекты upstream), исправления — отдельной задачей 8.

**Стек:** как на этапе 1 (браузерный JS без сборки, Plotly, `modules/fft.js`, `Libraries/*`, `node --test`, ESLint, Playwright + Chrome через `CHROME_PATH`).

**Соглашения:** те же, что в `2026-10-23-tune-wizard-stage1.md` (русский язык, 4 пробела, без `;`, объявления функций, коммит на задачу с трейлером `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`, ничего из `TuneWizard/logs/`). Ветка `tune-wizard-stage2` (от `main` = `1b61d27`); после каждой задачи `git push origin tune-wizard-stage2`.

**Общая глобальная область страницы.** Все скрипты страницы делят одну лексическую область: нельзя повторно объявлять `US2S`, `state`, `css_token`, `stat_tile`, `html_escape`, `flight_data`, имена из `Libraries/*` (`array_*`, `complex_*`, `linear_interp`, `hanning`, `run_fft`, `rfft_freq`, `real_length`, `to_double_sided`, `to_fft_format`, `fft_amplitude_scale`, `fft_frequency_scale`, `fft_window_size_inc`, `decode_devid`, `get_param_value`, `param_to_string`, `get_param_download_text`, `parameter_*`, `set_bitmask_size`, `load_param_inputs`, `get_version_and_board`, `init_loading_overlay`, `loading_call`, `get_open_in`, `open_in_update`). Перед добавлением нового глобального имени — `grep` по `Libraries/`, `TuneWizard/`.

**Тесты ядра под Node — как в браузере.** Переносимые файлы наследуют классы через глобальную область (`class ThrottleTarget extends NotchTarget`) и зовут глобалы `Libraries/*`, поэтому в тестах они загружаются через `vm.runInThisContext` в порядке, как на странице (помощник `load_page_scripts` в задаче 2). Это же ловит коллизии имён: повторное `const` падает в Node так же, как в браузере. `FFTJS` в Node — `require('../modules/fft.js/lib/fft.js')`. Файлы `core/log.js` и `core/checks.js` остаются как есть (через `require`).

**Источники переноса (upstream 05d6177):** `FilterReview/FilterReview.js` (далее FR), `FilterReview/tracking/*.js`, `Libraries/fft.js`, `Libraries/Array_Math.js`, `Libraries/DecodeDevID.js`, `Libraries/ParameterMetadata.js`, `FilterReview/params.json`; PR ArduPilot/WebTools#363 — дифф сохранён в `C:\Users\taa03\AppData\Local\Temp\claude\c--Users-taa03-Desktop-Repo-WebTools\602a6c14-2807-460e-97b1-5cbfa3d21d83\scratchpad\pr363.diff` (или `gh pr diff 363 --repo ArduPilot/WebTools`).

**Таблица замен при переносе (применяется во всех задачах 2–6):**

| В upstream | В ядре |
|---|---|
| `get_filter_version()` | `env.filter_version` (`this.env.filter_version` в классах) |
| `Gyro_batch` | аргумент `gyro` |
| `tracking_methods`, `logged_tracking`, `filters` | аргументы `tracking`, `logged`, `filters` |
| `find_start_index(time)` / `find_end_index(time)` | `find_start_index(time, range)` / `find_end_index(time, range)`, `range = [t0, t1]` |
| `document.getElementById("FFTWindow_size").value` / `"FFTWindow_per_batch"` | `opts.window_size` / `opts.window_per_batch` |
| `alert(msg)` | `warnings.push(msg)` (массив на объекте результата или `this.warnings`) |
| `get_param_value(PARM, name)` | `env.params.get(name)` |
| `get_version_and_board(log).build_type` | `env.build_type` |
| `TimeUS_to_seconds(x)` | `us_to_s(x)` |
| `parameter_get_value(name)` (чтение формы) | значения приходят объектом `values[name]` |
| `get_air_density_model()` с `this` | возвращает обычный объект `model` |

`env` создаётся в `wizard.js` после загрузки лога: `{ params: state.params, build_type: state.info.build_type, filter_version: <из VER.FV или форма>, decode_devid }`.

---

### Задача 1: `plots.js` — реестр графиков и перенос помощников темы

**Файлы:**
- Создать: `TuneWizard/plots.js`
- Изменить: `TuneWizard/wizard.js` (убрать `css_token`, `plot_colors`, `plot_layout_theme`, `restyle_plots`; переписать `setup_flight_plot`/`plot_flight`/`reset` на реестр)
- Изменить: `TuneWizard/index.html` (подключить `plots.js` перед `wizard.js`)
- Проверка: `tests/tunewizard-browser.cjs` без изменений должен проходить

**Шаг 1: создать `TuneWizard/plots.js`**

```js
// Реестр графиков Plotly мастера: тема из токенов CSS применяется ко всем графикам разом.

// Значение токена темы из :root
function css_token(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

// Палитра линий из токенов: оси X/Y/Z, предупреждение; стили pre / оценка post / логированное post;
// прозрачность для второго и третьего гироскопа
function plot_palette() {
    return {
        series: [css_token("--accent"), css_token("--low"), css_token("--ok"), css_token("--high")],
        axis: { x: css_token("--accent"), y: css_token("--low"), z: css_token("--ok") },
        warn: css_token("--high"),
        ink: css_token("--ink-2"),
        line: css_token("--line"),
        dash: { pre: "solid", est: "dash", post: "dot" },
        gyro_opacity: [1, 0.65, 0.4],
    }
}

// Общая часть layout под текущую тему
function plot_layout_theme() {
    const font = { family: '"IBM Plex Mono", ui-monospace, monospace', size: 11, color: css_token("--ink-2") }
    return {
        paper_bgcolor: css_token("--surface"),
        plot_bgcolor: css_token("--surface"),
        font,
        axis: {
            gridcolor: css_token("--line-soft"),
            linecolor: css_token("--line"),
            zerolinecolor: css_token("--line"),
            tickfont: font,
            title: { font },
        },
        // Ползунок диапазона: фон и рамка тоже из токенов, иначе в тёмной теме он остаётся светлым
        rangeslider: { bgcolor: css_token("--surface-2"), bordercolor: css_token("--line") },
        legend: { font, bgcolor: "rgba(0,0,0,0)" },
        colorbar: { tickfont: font, outlinecolor: css_token("--line"), title: { font } },
    }
}

// Зарегистрированные графики: id контейнера → { data, layout, config, on_theme }
const plots = {}

// Зарегистрировать график. on_theme(palette, data, layout) — перекраска линий при смене темы (необязательно)
function register_plot(id, data, layout, options = {}) {
    plots[id] = { data, layout, config: { displaylogo: false, responsive: true }, on_theme: options.on_theme ?? null }
    apply_plot_theme(plots[id])
    const div = document.getElementById(id)
    Plotly.purge(div)
    Plotly.newPlot(div, data, layout, plots[id].config)
    return plots[id]
}

function plot(id) {
    return plots[id]
}

// Перерисовать график после изменения data/layout
function render_plot(id) {
    const p = plots[id]
    Plotly.react(id, p.data, p.layout, p.config)
}

// Применить тему к одному графику: фоны, шрифт, все оси, ползунок, легенда, colorbar; затем хук цветов
function apply_plot_theme(p) {
    const theme = plot_layout_theme()
    const layout = p.layout
    layout.paper_bgcolor = theme.paper_bgcolor
    layout.plot_bgcolor = theme.plot_bgcolor
    layout.font = theme.font
    for (const key of Object.keys(layout)) {
        if (/^[xy]axis\d*$/.test(key)) {
            const axis = layout[key]
            // Цвет подписи оси сохраняется (у графика полёта он свой), остальное — из темы
            const title_color = axis.title?.font?.color
            Object.assign(axis, theme.axis, { title: { ...(axis.title ?? {}), font: { ...theme.font, ...(title_color ? { color: title_color } : {}) } } })
            if (axis.tickfont?.color && axis.tickfont.color !== theme.font.color) {
                axis.tickfont = { ...theme.font, color: axis.tickfont.color }
            }
            if (axis.rangeslider) {
                Object.assign(axis.rangeslider, theme.rangeslider)
            }
        }
    }
    layout.legend = { ...(layout.legend ?? {}), ...theme.legend }
    for (const trace of p.data) {
        if (trace.colorbar) {
            Object.assign(trace.colorbar, theme.colorbar)
        }
    }
    if (p.on_theme) {
        p.on_theme(plot_palette(), p.data, layout)
    }
}

// Перерисовать все графики под новую тему, данные сохраняются
function restyle_plots() {
    if (typeof Plotly === "undefined") {
        return
    }
    for (const [id, p] of Object.entries(plots)) {
        if (document.getElementById(id) == null) {
            continue
        }
        apply_plot_theme(p)
        Plotly.react(id, p.data, p.layout, p.config)
    }
}
```

**Шаг 2: переписать график полёта в `wizard.js` на реестр**

- Удалить из `wizard.js` функции `css_token`, `plot_colors`, `plot_layout_theme`, `restyle_plots` (теперь в `plots.js`). `apply_theme` и `init_theme` остаются в `wizard.js` и зовут `restyle_plots()` из `plots.js`.
- `const flight_data = { data: [], layout: {} }` остаётся; `setup_flight_plot()`:
  - строит `flight_data.data` как раньше, но цвета берёт из `plot_palette().series[i]`;
  - строит `flight_data.layout` без полей темы (их проставит реестр): `xaxis: { title: { text: "Время, с" }, domain: [0.07, 0.93], zeroline: false, showline: true, mirror: true, rangeslider: {} }`, оси `yaxis…yaxis4` с `title: { text, font: { color } }`, `tickfont: { color }`, `color`, `side`, `position`, `overlaying`;
  - регистрирует: `register_plot("FlightData", flight_data.data, flight_data.layout, { on_theme: flight_plot_theme })`, где
    ```js
    // Цвета рядов и осей графика полёта из палитры темы
    function flight_plot_theme(palette, data, layout) {
        for (let i = 0; i < data.length; i++) {
            data[i].line.color = palette.series[i]
            const axis = layout[(i == 0) ? "yaxis" : "yaxis" + (i + 1)]
            axis.color = palette.series[i]
            axis.title.font.color = palette.series[i]
            axis.tickfont = { ...axis.tickfont, color: palette.series[i] }
        }
    }
    ```
  - вешает обработчик `plotly_relayout` как раньше (`document.getElementById("FlightData").on(...)`).
- `plot_flight()` и `reset()` вместо `Plotly.react("FlightData", …)` зовут `render_plot("FlightData")`; `interval_input_changed` оставляет `Plotly.relayout`.
- `set_step(n)` зовёт `show_plots(section)` для показанной секции: скрытые графики не рисуются (dirty) и дорисовываются при показе, чистым подгоняется размер (`Plots.resize`); смена темы по-прежнему зовёт `restyle_plots()`.

**Шаг 3: `index.html`** — добавить `<script type="text/javascript" src="plots.js"></script>` сразу перед `wizard.js`.

**Шаг 4: проверить**

- `node --check TuneWizard/plots.js TuneWizard/wizard.js`; `npm run lint` → 0; `npm test` → все проходят.
- `CHROME_PATH=... npm run test:tunewizard` → проходит без изменений теста (в том числе проверка `paper_bgcolor` после смены темы).
- Grep: `css_token`, `plot_layout_theme`, `restyle_plots` определены только в `plots.js`.

**Шаг 5: коммит**

```
TuneWizard: plots.js — реестр графиков и тема в одном месте

register_plot/render_plot/restyle_plots применяют токены темы ко всем
графикам: фоны, шрифт, оси, ползунок, легенда, colorbar; цвета линий —
хуком on_theme. График полёта переведён на реестр.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

---

### Задача 2: `core/gyro.js` — загрузка гироскопа и FFT

**Файлы:**
- Создать: `TuneWizard/core/gyro.js`
- Создать: `tests/tunewizard-core.test.cjs` (новый файл тестов ядра, загружающий скрипты как страница)
- Изменить: `eslint.config.mjs` — ничего (файл не использует `module`); убедиться, что `TuneWizard/index.html` после задачи 5 загружает его (до тех пор ESLint линтит файл по общим правилам, глобалы `Libraries` будут помечены как undefined — поэтому **в этой задаче** добавить `core/gyro.js` и библиотеки в `index.html` сразу: `../Libraries/Array_Math.js`, `../Libraries/fft.js`, `../Libraries/DecodeDevID.js`, `../modules/fft.js/dist/fft.js` перед `core/log.js`, затем `core/gyro.js` после `core/checks.js`).

**Шаг 1: помощник загрузки скриптов в тестах**

Создать `tests/tunewizard-core.test.cjs` с заголовком:

```js
// Тесты ядра мастера настройки, которое переносится из FilterReview.
// Эти скрипты — классические (общая глобальная область, наследование классов между файлами),
// поэтому загружаются как на странице: по порядку через vm.runInThisContext.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const repo = path.resolve(__dirname, '..')

// FFTJS на странице — глобал из modules/fft.js/dist/fft.js; под Node берём ту же библиотеку через require
globalThis.FFTJS = require('../modules/fft.js/lib/fft.js')

// Загрузить скрипты страницы в глобальную область, в том порядке, что и index.html
function load_page_scripts(files) {
    for (const file of files) {
        const full = path.join(repo, file)
        vm.runInThisContext(fs.readFileSync(full, 'utf8'), { filename: full })
    }
}

load_page_scripts([
    'Libraries/Array_Math.js',
    'Libraries/fft.js',
    'Libraries/DecodeDevID.js',
    'TuneWizard/core/log.js',
    'TuneWizard/core/gyro.js',
])

// Поддельный лог как в tests/tunewizard.test.cjs, плюс экземпляры
function fake_log({ messages = {}, params = [] } = {}) { /* скопировать из tests/tunewizard.test.cjs (версия с instances) */ }
function fake_params(values) {
    return { get: (name) => (name in values) ? values[name] : null, has: (name) => name in values }
}
```

Примечание: `core/log.js` при загрузке через `vm` видит `typeof module === "undefined"` и просто объявляет глобалы — это ожидаемо.

**Шаг 2: падающие тесты `core/gyro.js`**

```js
// Синтетический batch-лог: один гироскоп, pre-filter, N пакетов по 1024 отсчёта на 1000 Гц,
// синусоида 100 Гц амплитудой 2 рад/с по X, тишина по Y, Z
function synthetic_batch_log({ batches = 4, samples = 1024, rate = 1000, freq = 100, amp = 2, post = false } = {}) {
    const ISBH = { N: [], type: [], instance: [], smp_cnt: [], mul: [], SampleUS: [], smp_rate: [] }
    const ISBD = { N: [], seqno: [], x: [], y: [], z: [] }
    const scale = 1000
    for (let b = 0; b < batches; b++) {
        ISBH.N.push(b); ISBH.type.push(1); ISBH.instance.push(0); ISBH.smp_cnt.push(samples)
        ISBH.mul.push(scale); ISBH.SampleUS.push(b * samples / rate * 1e6 + 10e6); ISBH.smp_rate.push(rate)
        for (let m = 0; m < samples / 32; m++) {
            const x = [], y = [], z = []
            for (let k = 0; k < 32; k++) {
                const n = m * 32 + k
                x.push(Math.round(scale * amp * Math.sin(2 * Math.PI * freq * n / rate)))
                y.push(0)
                z.push(0)
            }
            ISBD.N.push(b); ISBD.seqno.push(m); ISBD.x.push(x); ISBD.y.push(y); ISBD.z.push(z)
        }
    }
    return fake_log({ messages: { ISBH, ISBD }, params: [
        ['INS_GYR_ID', 1, 0], ['INS_LOG_BAT_OPT', post ? 2 : 0, 0], ['AHRS_EKF_TYPE', 3, 0], ['EK3_PRIMARY', 0, 0]
    ] })
}
const env0 = { params: null, build_type: 2, filter_version: 2 }

test('load_gyro: batch-лог даёт один экземпляр pre-filter с пакетами и временем', () => {
    const log = synthetic_batch_log()
    const gyro = load_gyro(log, { ...env0, params: log_params(log) }, { log_type: null })
    assert.equal(gyro.error, null)
    assert.equal(gyro.type, 'batch')
    assert.equal(gyro.num_gyro, 1)
    assert.equal(gyro.length, 1)
    assert.equal(gyro[0].sensor_num, 0)
    assert.equal(gyro[0].post_filter, false)
    assert.equal(gyro[0].length, 4)
    assert.equal(gyro[0][0].x.length, 1024)
    assert.ok(Math.abs(gyro[0][0].x[256] - 2) < 1e-6, 'масштаб 1/mul снят: sin(π/2)·2')
    assert.equal(gyro.have_pre, true)
    assert.equal(gyro.have_post, false)
    assert.equal(gyro.primary, 0)
    assert.ok(gyro.start_time >= 10 && gyro.end_time > gyro.start_time)
})

test('load_gyro: без ISBH/ISBD и GYR — ошибка, без исключения', () => {
    const log = fake_log({ params: [['INS_GYR_ID', 1, 0]] })
    const gyro = load_gyro(log, { ...env0, params: log_params(log) }, { log_type: null })
    assert.match(gyro.error, /raw|batch/i)
})

test('gyro_fft: пик синусоиды в нужном бине с верной амплитудой', () => {
    const log = synthetic_batch_log({ freq: 100, amp: 2 })
    const gyro = load_gyro(log, { ...env0, params: log_params(log) }, { log_type: null })
    const result = gyro_fft(gyro, { window_size: 1024, window_per_batch: 1 })
    assert.equal(result.changed, true)
    const FFT = gyro[0].FFT
    assert.equal(FFT.window_size, 1024)
    assert.ok(Math.abs(FFT.average_sample_rate - 1000) < 1e-6)
    assert.equal(FFT.x.length, 4, 'по одному окну на пакет')
    // Бин 100 Гц при разрешении 1000/1024 ≈ 0.977 Гц → индекс 102 (ближайший)
    const peak_index = FFT.x[0].indexOf(Math.max(...FFT.x[0]))
    assert.ok(Math.abs(FFT.bins[peak_index] - 100) < 1.0, 'пик около 100 Гц, получили ' + FFT.bins[peak_index])
    // Амплитуда с поправкой окна Ханна (linear) ≈ 2 (утечка на нецелом бине допускает 15 %)
    assert.ok(FFT.x[0][peak_index] * FFT.correction.linear > 1.7 && FFT.x[0][peak_index] * FFT.correction.linear < 2.1)
    assert.ok(Math.max(...FFT.y[0]) < 1e-9, 'тишина по Y')
    assert.ok(FFT.Z1 != null && FFT.Z2 != null && FFT.bode != null, 'подготовлены Z и бодэ для pre-filter')
    assert.equal(gyro_fft(gyro, { window_size: 1024, window_per_batch: 1 }).changed, false, 'повторный вызов без изменений')
    clear_gyro_fft(gyro)
    assert.equal(gyro[0].FFT, null)
})

test('run_batch_fft: окно не степень двойки — исключение с русским текстом', () => {
    const log = synthetic_batch_log()
    const gyro = load_gyro(log, { ...env0, params: log_params(log) }, { log_type: null })
    assert.throws(() => gyro_fft(gyro, { window_size: 1000, window_per_batch: 0, type_override: 'raw' }), /степен/)
})

test('find_start_index/find_end_index: границы по диапазону', () => {
    const time = [0, 1, 2, 3, 4, 5]
    assert.equal(find_start_index(time, [2.5, 4.5]), 2)
    assert.equal(find_end_index(time, [2.5, 4.5]), 5)
})
```

(Тест `run_batch_fft` с `window_size: 1000` упростите, если `type_override` не нужен: для raw-типа окно берётся из `opts.window_size`; создайте `gyro.type = 'raw'` вручную перед вызовом.)

**Шаг 3: реализовать `core/gyro.js`** — перенос:

- `find_start_index(time, range)`, `find_end_index(time, range)` — FR 1031–1056 с `range[0]`/`range[1]` вместо полей формы.
- `run_batch_fft(data_set, opts)` — FR 277–352: `opts.type` (`"batch"`/`"raw"`), `opts.window_per_batch`, `opts.window_size`; вместо `alert`+`throw new Error()` — `throw new Error("Размер окна FFT должен быть степенью двойки")`. Дефекты строк 284 и 289 **сохранить как есть** (их чинит задача 8; оставить комментарий `// upstream: …`).
- `load_from_batch(log, gyro, num_gyro, gyro_rate, params, warnings)`, `load_from_raw_log(...)` — FR 2051–2344 с заменами; результат пишется в переданный массив `gyro` (чтобы сохранить структуру upstream).
- `load_gyro(log, env, opts)` → `gyro` (массив с полями `type`, `quantization_noise`, `start_time`, `end_time`, `have_pre`, `have_post`, `primary`, `num_gyro`, `gyro_rate`, `gyro_info[]` ({name, bus_type, rate} через `env.decode_devid`, если передан), `warnings`, `error`): объединяет FR 2375–2443 (ID гироскопов и частоты, выбор batch/raw по `opts.log_type` с автоопределением), 2546–2572 (первичный гироскоп по `AHRS_EKF_TYPE`/`EK3_PRIMARY`), 2619–2652 (`have_pre`/`have_post`). При отсутствии данных — `error: "В логе нет ни raw (GYR), ни batch (ISBH/ISBD) данных гироскопа"`, без исключения.
- `gyro_fft(gyro, opts)` → `{ changed, warnings }` — FR 795–891 без DOM и без `tracking_methods[j].interpolate` (интерполяцию трекинга делает `interpolate_tracking(tracking, gyro)` в задаче 3). `opts` = `{ window_size, window_per_batch }`.
- `clear_gyro_fft(gyro)` — FR 779–792 без DOM.
- `fft_info(gyro)` → по номеру сенсора `{ sample_rate, resolution, window_size }` (FR 819–845 без DOM) — для подписи «частота/разрешение» на панели.

**Шаг 4:** `node --test tests/tunewizard-core.test.cjs` → 5 pass; `npm run lint` → 0 (страница уже подключает библиотеки и `core/gyro.js`, см. выше); `npm test`.

**Шаг 5: коммит** — `TuneWizard: ядро gyro.js — загрузка гироскопа и FFT из FilterReview` (+ трейлер).

---

### Задача 3: `core/tracking/*` и `core/filters.js`

**Файлы:**
- Создать: `TuneWizard/core/tracking/Atmosphere_model.js`, `BaseClass.js`, `Static.js`, `Throttle.js`, `RPM.js`, `ESC.js`, `FFT.js`, `Logged.js` (один в один с `FilterReview/tracking/`)
- Создать: `TuneWizard/core/filters.js`
- Изменить: `TuneWizard/index.html` (подключить все восемь файлов трекинга и `core/filters.js` после `core/gyro.js`, порядок как в `FilterReview/index.html:15-22`), `tests/tunewizard-core.test.cjs`

**Перенос трекинга — правила:**
- Конструкторы: `NotchTarget(log, env, msg_name, key_name, name, mode_value)`; `StaticTarget(gyro, env)` (нужны `gyro.start_time/end_time`); `ThrottleTarget(log, env)`; `RPMTarget(log, env, instance, mode_value)`; `ESCTarget(log, env)`; `FFTTarget(log, env)`; `LoggedNotch(log, instance)`. `this.env = env`; `this.warnings = []`.
- `get_filter_version()` → `this.env.filter_version`; `get_param_value(PARM, name)` → `this.env.params.get(name)`; `get_version_and_board(log).build_type` → `this.env.build_type`; `alert(x)` → `this.warnings.push(x)`; `no_data_error()` **возвращает** строку сообщения (не показывает).
- `get_mean_value(time, value, range)` и `get_mean(range)` принимают диапазон.
- `get_air_density_model()`: заменить `this.` на локальный `const model = {}` и `return model`.
- Фабрики в `core/filters.js`:
  ```js
  // Источники трекинга в порядке режимов INS_HNTCH_MODE: 0 Static, 1 Throttle, 2 RPM1, 3 ESC, 4 FFT, 5 RPM2
  function create_tracking(log, env, gyro) { return [new StaticTarget(gyro, env), new ThrottleTarget(log, env), new RPMTarget(log, env, 1, 2), new ESCTarget(log, env), new FFTTarget(log, env), new RPMTarget(log, env, 2, 5)] }
  function create_logged(log) { return [new LoggedNotch(log, 0), new LoggedNotch(log, 1)] }
  // Интерполяция трекинга к окнам FFT каждого экземпляра (FR 885-888)
  function interpolate_tracking(tracking, gyro) { for (let i = 0; i < gyro.length; i++) { if (gyro[i]?.FFT == null) continue; for (const t of tracking) t.interpolate(i, gyro[i].FFT.time) } }
  ```

**`core/filters.js` — перенос:**
- `DigitalBiquadFilter`, `NotchFilter`, `MultiNotch` — FR 12–165 без изменений.
- `HarmonicNotchFilter(params, env, tracking)` — FR 169–275: `tracking_methods` → `tracking`, `get_filter_version()` → `env.filter_version`, `alert` → `this.warnings.push`, `max_num_harmonics` → константа `MAX_NUM_HARMONICS = 16` в этом файле.
- `notch_param_names()` — FR 1838–1854.
- `load_filters(values, env, tracking)` → `{ static, notch: [...], warnings }` — FR 1856–1871 без DOM: `values` — объект `имя → число` (например, `values["INS_HNTCH_FREQ"]`).
- `calculate_transfer_function(filters, gyro)` — FR 893–951 без DOM.
- `get_phase(H)` — FR 1058–1081; `phase_wrap(arrays)` — FR 1083–1108 без DOM (вызывается только если «свернуть фазу» включено).
- `estimate_post(gyro, i, amplitude_scale, range, alias)` → `{ x, y, z }` (скорректированные средние, уже после `alias.apply_amp` и `amplitude_scale.scale`) — FR 1295–1350.
- `bode_mean(gyro, index, range)` → `{ freq, amp_mean, amp_max, amp_min, phase_mean, phase_max, phase_min }` — FR 1409–1445.
- `notch_line_stats(filters, range)` → для каждого включённого notch список `{ harmonic, mean, min, max }` — FR 1193–1262 без DOM и без `frequency_scale` (масштабирует вызывающая сторона).

**Падающие тесты (добавить в `tests/tunewizard-core.test.cjs`; расширить `load_page_scripts` файлами трекинга и `core/filters.js`):**

```js
// Передаточная функция одного notch на сетке частот: |H| в центре ≈ -ATT дБ, вдали ≈ 0 дБ
function notch_response(center, bw, att, sample_rate, freqs) {
    const Z = exp_jw(freqs, sample_rate)
    const Z1 = complex_inverse(Z)
    const Z2 = complex_inverse(complex_square(Z))
    const one = [new Array(freqs.length).fill(1), new Array(freqs.length).fill(0)]
    const Hn = [one[0].slice(), one[1].slice()]
    const Hd = [one[0].slice(), one[1].slice()]
    new NotchFilter(att, bw, 1, () => 0, 1.0).transfer(Hn, Hd, center, sample_rate, Z1, Z2)
    return complex_abs(complex_div(Hn, Hd))
}

test('NotchFilter: ослабление в центре равно ATT, вдали — нет', () => {
    const freqs = array_from_range(1, 400, 1)
    const H = notch_response(100, 50, 40, 1000, freqs)
    const at_center = 20 * Math.log10(H[freqs.indexOf(100)])
    assert.ok(Math.abs(at_center + 40) < 0.5, 'в центре ' + at_center.toFixed(2) + ' дБ')
    assert.ok(Math.abs(20 * Math.log10(H[freqs.indexOf(10)])) < 0.1, 'на 10 Гц нет ослабления')
    assert.ok(Math.abs(20 * Math.log10(H[freqs.indexOf(300)])) < 0.5, 'на 300 Гц нет ослабления')
})

test('DigitalBiquadFilter: −3 дБ на частоте среза', () => {
    const freqs = [10, 40, 200]
    const Z = exp_jw(freqs, 1000)
    const Z1 = complex_inverse(Z), Z2 = complex_inverse(complex_square(Z))
    const Hn = [[1, 1, 1], [0, 0, 0]], Hd = [[1, 1, 1], [0, 0, 0]]
    new DigitalBiquadFilter(40).transfer(Hn, Hd, 1000, Z1, Z2)
    const H = complex_abs(complex_div(Hn, Hd))
    assert.ok(Math.abs(20 * Math.log10(H[1]) + 3) < 0.3, 'на 40 Гц ≈ −3 дБ')
    assert.ok(H[0] > 0.98 && H[2] < 0.1)
})

test('HarmonicNotchFilter: статический notch, гармоники 1 и 3, предупреждений нет', () => {
    const gyro = { start_time: 0, end_time: 10 }
    const env = { filter_version: 2, params: fake_params({}), build_type: 2 }
    const tracking = [new StaticTarget(gyro, env)]
    const f = new HarmonicNotchFilter({ enable: 1, mode: 0, freq: 80, bandwidth: 40, attenuation: 30, ref: 0, min_ratio: 1, harmonics: 5, options: 0, esc_mask: 0 }, env, tracking)
    assert.equal(f.enabled(), true)
    assert.equal(f.static(), true)
    assert.equal(f.harmonics(), 5)
    assert.deepEqual(f.warnings, [])
    const target = f.get_target_freq()
    assert.deepEqual(target.freq, [80, 80])
})

test('ThrottleTarget.get_target: freq·√(thr/ref), версия 2', () => {
    const log = fake_log({ messages: { RATE: { TimeUS: [0, 1e6], AOut: [0.25, 0.5] } } })
    const env = { filter_version: 2, params: fake_params({}), build_type: 2 }
    const t = new ThrottleTarget(log, env)
    assert.equal(t.have_data({ options: 0 }), true)
    assert.ok(Math.abs(t.get_target({ ref: 0.25, freq: 100, min_ratio: 1 }, 0.5) - 100 * Math.SQRT2) < 1e-9)
    assert.equal(t.get_target({ ref: 0, freq: 100 }, 0.5), 100)
})

test('ESCTarget.compute_avg: среднее по маске и тайм-аут экземпляра', () => {
    const log = fake_log({ messages: { ESC: { instances: {
        0: { TimeUS: [0, 1e6, 2e6], RPM: [6000, 6000, 6000] },
        1: { TimeUS: [0, 1e6, 5e6], RPM: [3000, 3000, 3000] }
    } } } })
    const env = { filter_version: 2, params: fake_params({}), build_type: 2 }
    const esc = new ESCTarget(log, env)
    assert.equal(esc.get_num_motors(), 2)
    const avg = esc.compute_avg(0)
    assert.ok(Math.abs(avg.avg_freq[0] - 75) < 1e-9, 'среднее (100+50)/2 Гц')
    const only_first = esc.compute_avg(1)
    assert.ok(only_first.avg_freq.every((f) => Math.abs(f - 100) < 1e-9))
})

test('load_filters: значения формы → фильтры, нет данных для режима ESC → предупреждение', () => {
    const log = fake_log({ messages: { RATE: { TimeUS: [0, 1e6], AOut: [0.3, 0.3] } } })
    const gyro = { start_time: 0, end_time: 1 }
    const env = { filter_version: 2, params: log_params(log), build_type: 2 }
    const tracking = create_tracking(log, env, gyro)
    const values = { INS_GYRO_FILTER: 40, INS_HNTCH_ENABLE: 1, INS_HNTCH_MODE: 3, INS_HNTCH_FREQ: 80, INS_HNTCH_BW: 40, INS_HNTCH_ATT: 40, INS_HNTCH_REF: 1, INS_HNTCH_FM_RAT: 1, INS_HNTCH_HMNCS: 3, INS_HNTCH_OPTS: 0, INS_HNTCH_ESCMSK: 0, INS_HNTC2_ENABLE: 0 }
    const filters = load_filters(values, env, tracking)
    assert.equal(filters.notch.length, 2)
    assert.equal(filters.notch[0].enabled(), false, 'ESC-данных нет — notch выключен')
    assert.ok(filters.warnings.length >= 1 && /ESC/.test(filters.warnings.join(' ')))
})
```

**Коммит:** `TuneWizard: ядро — трекинг notch и фильтры из FilterReview` (+ трейлер). Проверки: тесты ядра, `npm run lint`, `npm test`.

---

### Задача 4: `core/spectrum.js` — средний спектр, алиасинг, спектрограмма, линии трекинга

**Файлы:** создать `TuneWizard/core/spectrum.js`; тесты в `tests/tunewizard-core.test.cjs`; подключить в `index.html` после `core/filters.js`.

**Перенос:**
- `amplitude_scale(mode)` → `fft_amplitude_scale(mode === "dB", mode === "PSD")`; `frequency_scale(unit, log_axis)` → `fft_frequency_scale(unit === "RPM", log_axis)`; метки переводятся на русский в вызывающей стороне (поля `label` переопределяются: «Амплитуда», «Амплитуда, дБ», «PSD, дБ/Гц», «Частота, Гц», «Обороты, RPM»).
- `alias_obj(FFT, { mode: "none"|"fold"|"only", loop_rate })` — FR 973–1028 без DOM.
- `mean_spectrum(FFT, amplitude_scale, range, alias)` → `{ bins, x, y, z }` — FR 1131–1182 (после `alias.apply_amp` и `amplitude_scale.scale`; `bins = alias.bins`, не масштабированные по частоте — масштаб частоты применяет вызывающая сторона).
- `find_instance(gyro, sensor_num, post_filter)` — FR 1466–1475.
- `spectrogram_matrix(gyro, batch_instance, axis, estimated, amplitude_scale, alias)` → `{ x (время с разрывами null), bins, z }` — FR 1517–1577.
- `tracking_lines(filters, logged, range)` → для каждого notch: `{ enabled, name, harmonics: [{ harmonic, time, freq }], logged: [{ harmonic, time, freq }] }` — FR 1597–1668 без DOM и без масштаба частоты.

**Тесты:** `mean_spectrum` синтетического лога (из задачи 2) в режиме `dB` даёт максимум около 100 Гц и ≈ `20·log10(2)` ≈ 6 дБ (±1); `alias_obj` в режиме `fold` с `loop_rate = 400` сворачивает 300 Гц в 100 Гц (сумма амплитуд в бине 100 Гц растёт); `spectrogram_matrix` возвращает `z.length == x.length` и вставляет разрыв (`null`-строку) при пропуске времени > 2.5 среднего шага; `tracking_lines` для статического notch с гармониками 1 и 3 даёт две линии 80 и 240 Гц.

**Коммит:** `TuneWizard: ядро spectrum.js — средний спектр, алиасинг, спектрограмма, линии notch` (+ трейлер).

---

### Задача 5: шаг 1 — «Спектр до фильтров» и регрессия против FilterReview

**Файлы:**
- Создать: `TuneWizard/steps/step1.js`
- Изменить: `TuneWizard/index.html` (разметка секции `data-step="1"`, подключение `steps/step1.js` после `wizard.js`, `../Libraries/OpenIn.js`)
- Изменить: `TuneWizard/wizard.js` (`state.spectrum`, `state.gyro`, `state.tracking`, `state.logged`, `state.filters`, `env`; доступность шагов по проверкам; хук показа шага `on_show_step(n)`)
- Создать: `tests/tunewizard-compare.cjs`; изменить `package.json` (`"test:tunewizard-compare": "node tests/tunewizard-compare.cjs"`), `tests/tunewizard-browser.cjs` (проверки шага 1)
- Создать: `TuneWizard/core/metrics.js` (пики и атрибуция) + тесты

**`core/metrics.js` (новое, DOM-free):**

```js
// Пики спектра и их происхождение. Пороги в одном блоке; источники: [PR363] — метод автоподбора, [наше].
const peak_rules = {
    min_excess_dB: 6,          // пик заметен, если выше локального шума на столько дБ [PR363]
    floor_half_width_hz: 15,   // полуширина окна для медианы шума вокруг пика [наше]
    peak_half_width_hz: 2,     // исключаемая из шума окрестность пика [наше]
    harmonic_tolerance: 0.1,   // пик «моторный», если в пределах ±10 % от N·f_мотора [наше]
    max_harmonic: 8,           // старшая гармоника для атрибуции [PR363]
    min_freq_hz: 5,            // ниже — не ищем (дрейф, DC) [наше]
}
// bins (Гц), amp_dB — средний спектр в дБ. Возвращает [{ freq, amp_dB, excess_dB }] по убыванию excess
function find_peaks(bins, amp_dB, rules = peak_rules)
// fundamental_hz — медианная моторная частота (ESC → газ) или null. Добавляет к пикам source: "motor"|"frame", harmonic: N|null
function attribute_peaks(peaks, fundamental_hz, rules = peak_rules)
// Моторная частота для атрибуции: медиана ESC compute_avg(0) по диапазону, иначе медиана цели газа; null если нет
function motor_fundamental(tracking, values, range)
```

Тесты: синтетический спектр (шум 0 дБ, пики +20 дБ на 100/200/300 Гц и +12 дБ на 57 Гц) → четыре пика, три «motor» с гармониками 1–3 при `fundamental_hz = 100`, 57 Гц — «frame»; `excess_dB` ≈ 20/12.

**`wizard.js` — изменения:**
- `state.spectrum = { log_type: null, window_per_batch: 1, amplitude: "dB", frequency: "Hz", log_frequency: false, aliasing: "none", filter_version: null }`; `state.gyro = null`, `state.tracking = null`, `state.logged = null`, `state.filters = null`, `state.env = null`.
- После успешной загрузки лога: `state.env = { params, build_type, filter_version: info.filter_version ?? 4, decode_devid }`, `state.spectrum.filter_version = state.env.filter_version`.
- `step_available(n)`: 1–3 требуют `checks` без `fail` у `gyro_log`; 4 — без `fail` у `pid_log`; 5 — лог загружен. (Обновить `tests/tunewizard-browser.cjs`: на реальном логе все доступны.)
- `set_step(n)`: после показа секции вызывать `on_show_step(n)` — функция-диспетчер: `if (n === 1) step1_show()`; `if (n === 2) step2_show()` (определены в `steps/*.js`; проверка `typeof step1_show === "function"`), затем `show_plots(section)`.
- Сброс (`reset`) обнуляет новые поля и зовёт `step1_reset()`/`step2_reset()`, если определены.

**`steps/step1.js`:**
- `ensure_gyro()` — лениво: `state.gyro = load_gyro(state.log, state.env, { log_type })`; при `gyro.error` — вердикт шага с текстом и выход; `state.tracking = create_tracking(log, env, gyro)`, `state.logged = create_logged(log)`.
- `ensure_fft()` — `gyro_fft(gyro, { window_size: state.settings.window_size, window_per_batch })`; при `changed` — `interpolate_tracking(state.tracking, state.gyro)`; затем `state.filters = load_filters(values_from_log(), env, tracking)` (значения параметров из лога — чтобы линии логированных notch и оценка «после» были доступны уже на шаге 1), `calculate_transfer_function(filters, gyro)`; ошибки окна — в вердикт.
- Панель настроек (`.lab`): тип лога (radio, активны только при наличии обоих), «окон на пакет» (batch) / окно FFT (raw — то же поле шага 0), шкала амплитуды (radio linear/dB/PSD), частота (Hz/RPM; чекбокс «лог»), алиасинг (none/fold/only), версия фильтра (radio 1–4), кнопка «Пересчитать» (`loading_call`), подпись «частота дискретизации … Гц, разрешение … Гц» из `fft_info`.
- График `Spectrum1` (реестр): трассы `gyro × {pre, post, est} × {x, y, z}` — имена «Гироскоп N · до · X», `legendgroup` по гироскопу, `visible` по умолчанию: первичный гироскоп pre (и post, если есть) — `true`, оценка — `"legendonly"`, остальные гироскопы — `"legendonly"`; цвета/штрихи из палитры (`on_theme`). Данные из `mean_spectrum`/`estimate_post`; оси из `amplitude_scale.label`/`frequency_scale`.
- Спектрограмма `Spectrogram1`: радио гироскоп / pre–post–оценка / ось; heatmap `colorscale: "Viridis"`; линии логированных notch (`tracking_lines(...).logged`), если есть.
- Таблица пиков `#peaks1` (`.tablewrap`): частота, уровень, превышение, источник; `motor_fundamental` из ESC/газа.
- Вердикт `#verdict1`: «Главный шум: 180.3 Гц (моторы, гармоника 2), 23 дБ над фоном. Пики выше INS_GYRO_FILTER (40 Гц): 3».
- Кнопка «Открыть в FilterReview»: `get_open_in` из `Libraries/OpenIn.js` ожидает функцию, возвращающую файл — передать `() => state.log_buffer` (сохранить `ArrayBuffer` в `state.log_buffer` при загрузке; FilterReview открывается через `hook_load`). Если интеграция с `OpenIn.js` требует больше, чем 20 строк, — заменить простой ссылкой `../FilterReview/` с подсказкой «загрузите тот же лог».

**`tests/tunewizard-compare.cjs`** (Chrome, тот же каркас, что `tunewizard-browser.cjs`, порт 8792):
1. Открыть `/FilterReview/`, загрузить лог, дождаться `#calculate` disabled и оверлея; прочитать `TimeStart`, `TimeEnd`, `FFTWindow_size`, `FFTWindow_per_batch`, `log_type_batch.checked`; выставить `ScaleLog` (дБ), `freq_Scale_Hz` линейно, `Aliasing_none` (имена радио — см. `FilterReview/index.html`), вызвать `page.evaluate(() => re_calc())`; снять `fft_plot.data` (x/y первичного гироскопа pre X/Y/Z и est X/Y/Z по индексам `get_FFT_data_index`), `Bode.data[2].y`, `Bode.data[3].y`, `Spectrogram.data[0].z` (первые 5 столбцов).
2. Открыть `/TuneWizard/`, загрузить лог, выставить тот же интервал через поля, тот же тип лога/окно, dB/Hz/none, перейти на шаг 1 (и 2 — после задачи 7), нажать «Пересчитать»; снять данные `Spectrum1`/`Bode2`/`Spectrogram1` по именам трасс.
3. Сравнить массивы поэлементно: длина равна, `|a−b| ≤ 1e-6·max(1,|a|)`; при расхождении — первая позиция и значения. До задачи 7 бодэ сравнивать не обязательно (графика ещё нет) — тест должен пропускать отсутствующие графики с пометкой.

**Коммит:** `TuneWizard: шаг 1 — спектр до фильтров, пики, регрессия против FilterReview` (+ трейлер). Проверки: тесты ядра, `npm run lint`, `npm test`, `npm run test:tunewizard`, `npm run test:tunewizard-compare` (должен проходить по спектрам).

---

### Задача 6: `core/autofit.js` — автоподбор первого notch

**Файлы:** создать `TuneWizard/core/autofit.js`; тесты; подключить в `index.html`.

**Перенос PR #363 `AutoFit.js`:** `auto_fit_rules` без изменений; функции `auto_fit_order_spectrum(gyro, range, get_tracked, grid)`, `auto_fit_peak_value`, `auto_fit_peak_excess`, `auto_fit_harmonic_peaks`, `auto_fit_strongest_peak`, `auto_fit_select`, `auto_fit_percentile`, `auto_fit_esc(gyro, tracking, range, esc_mask)`, `auto_fit_throttle(gyro, tracking, range, multi_source)`; `auto_fit(gyro, tracking, range, esc_mask)` → `{ result, errors }` без DOM, без `calculate()` (вызывающий гарантирует FFT) и без записи параметров; плюс `auto_fit_values(result, current_values)` → объект значений `INS_HNTCH_*` по правилам PR (enable 1, mode, freq, bw = round(freq·0.5), att, ref, FM_RAT, HMNCS, OPTS с multi-source и без 1/16/64). Комментарии PR перевести на русский, числа и логику не менять.

**Тесты:** синтетический `gyro` с FFT (по образцу `synthetic_batch_log` + `gyro_fft`), где сигнал — сумма синусоид 60/120/180 Гц (амплитуды 2/1/0.5) и поддельный `ESCTarget`-совместимый объект трекинга, отдающий `get_interpolated_target_freq → [60]`; `auto_fit_esc` → `mode 3`, `harmonics` с битами 1–3 (`7`), `attenuation` в 10…50, `freq = round(60·0.8) = 48`; при трекинге 70 Гц (пики не кратны) — ошибка «не кратны»; `auto_fit_throttle` на том же сигнале с газом 0.25 → `freq ≈ 60`, `ref ≈ 0.25`.

**Коммит:** `TuneWizard: ядро autofit.js — автоподбор первого notch (PR #363)` (+ трейлер).

---

### Задача 7: шаг 2 — «Гармонический notch»

**Файлы:** создать `TuneWizard/steps/step2.js`; изменить `index.html` (секция `data-step="2"`, подключить `../Libraries/ParameterMetadata.js`, `../Libraries/Param_Helpers.js`, `../Libraries/FileSaver.js`, `steps/step2.js`), `core/params.js` (новый: `param_file_text(values)` через `get_param_download_text`, `parse_param_file(text)` → объект; тесты), `tests/tunewizard-browser.cjs`, `tests/tunewizard-compare.cjs` (бодэ и оценка «после»).

**Форма параметров** (`#notch_form`, `.lab`): по одному `<p>` на параметр с `<input type="number" id="INS_HNTCH_FREQ" …>` (ids = имена параметров, как в FilterReview) и `<span class="inlog" data-for="INS_HNTCH_FREQ">в логе: 40</span>`; после вставки разметки — `load_param_inputs("../FilterReview/params.json", names)` (подписи/описания/маски/списки); `parameter_set_value` для значений из лога; `filter_param_read()`-аналог: включение полей по `*_ENABLE`, `ESCMSK` только при версии ≥ 4, размер маски `HMNCS` 8/32 (`set_bitmask_size`), пометка `.changed` у поля, если значение ≠ логу.
- Кнопки: «Автоподбор» → `auto_fit(state.gyro, state.tracking, range, esc_mask)`; при `result` — `auto_fit_values` → `parameter_set_value` для каждого, строка `#autofit_info` («Подобрано по ESC-телеметрии» + ошибки других источников); при ошибке — текст в `#autofit_info` (без `alert`). «Пересчитать фильтры» → `load_filters(values_from_form(), env, tracking)` → `calculate_transfer_function` → перерисовка. «Сохранить .param» → `saveAs(new Blob([param_file_text(values_from_form())]), "notch.param")`. «Загрузить .param» → `parse_param_file` → `parameter_set_value` → пересчёт.
- Графики: `Spectrum2` (pre / est / post с линиями notch как `shapes`: среднее — линия, диапазон — прямоугольник; данные из `notch_line_stats`), `Bode2` (две подграфика: амплитуда и фаза; чекбокс «свернуть фазу» → `phase_wrap`; радио гироскопа), `Spectrogram2` (как на шаге 1 плюс опция «оценка» и линии notch текущих настроек из `tracking_lines`).
- Метрики `#metrics2` (`.stats`): главный пик до (Гц, дБ), после (дБ), ослабление (дБ), фазовая задержка на 10/20/50 Гц (из `bode_mean.phase_mean`, интерполяция по `freq`), предупреждения фильтров (`filters.warnings`, `notch.warnings`).
- Предложение второго notch: после расчёта оценки «после» — `find_peaks` по оценке; если сильнейший пик ≥ 6 дБ и не «motor» → блок «Остаётся пик F Гц (+X дБ): предложить статический INS_HNTC2 (FREQ=F, BW=F/2, ATT=30, MODE 0)» с кнопкой «Применить» (заполняет поля INS_HNTC2_*, пересчёт).
- «Принять» → `state.steps[2] = { accepted: values_from_form(), metrics }`; вердикт «Принято»; `set_step(3)`.
- Все тексты — русские; числа — моноширинные плитки.

**Браузерный тест** (`tunewizard-browser.cjs`): переход на шаг 1 → `#Spectrum1` имеет данные, таблица пиков непуста, вердикт содержит «Гц»; шаг 2 → поля `INS_HNTCH_*` заполнены из лога (`INS_HNTCH_MODE` = 3 на тестовом логе), «Автоподбор» заполняет `#autofit_info` и меняет `INS_HNTCH_FREQ`, «Пересчитать фильтры» без ошибок консоли, плитки метрик содержат «дБ», «Принять» открывает шаг 3. Регрессия (`tunewizard-compare.cjs`): бодэ и оценка «после» совпадают с FilterReview при одинаковых значениях параметров (значения из лога в обоих инструментах).

**Коммит:** `TuneWizard: шаг 2 — гармонический notch, автоподбор, метрики, .param` (+ трейлер).

---

### Задача 8: исправление дефектов upstream (отдельным коммитом, с тестами)

**Файлы:** `TuneWizard/core/gyro.js`, `TuneWizard/core/tracking/Throttle.js`, тесты; `docs/plans/2026-10-24-tune-wizard-stage2-design.md` (раздел «Дефекты» — отметить исправленные и ожидаемые расхождения с FilterReview).

1. `run_batch_fft`: объявить `window_size` до цикла проверки длины; суммировать `data_set[i].sample_rate`. Тест: пакет короче окна пропускается (FFT.x на один меньше), средняя частота по пакетам с разными `sample_rate` — среднее.
2. `load_from_raw_log`: `slice(batch_start, j)` для последнего пакета (`j-1` — конец включительно? воспроизвести семантику upstream для `i = 0` и исправить для `i > 0`). Тест на поддельном `GYR` с двумя экземплярами: длины пакетов экземпляра 1 равны экземпляру 0.
3. `load_from_batch`: при неполной последовательности не возвращать пустой результат, а завершить с уже собранными пакетами и предупреждением. Тест: обрыв последнего пакета → предыдущие пакеты сохранены, `warnings` содержит текст.
4. `ThrottleTarget`: при отсутствии `RATE`/`CTUN` `mode_value` остаётся 1, `have_data` → false; `HarmonicNotchFilter` даёт предупреждение «нет данных газа» вместо «неподдерживаемый режим». Тест.
5. `load_from_batch` (FR 2118–2122, найдено при переносе в задаче 2): после чтения последнего сообщения ISBD последнего пакета `data_index >= ISBD.N.length` считается «неполной последовательностью», и полностью прочитанный пакет отбрасывается. Исправление: пакет считать полным, если `j + 1 == num_data_msg`. Тест: синтетический лог из 4 пакетов даёт 4 пакета и 4 окна FFT (сейчас в тестах задачи 2 закреплено 3 — снять закрепление).
6. `FFTTarget.interpolate` (upstream `tracking/FFT.js`, найдено в задаче 3): перебирает `this.data.length` без проверки `null`, в отличие от `ESCTarget.interpolate`; при разреженных экземплярах `FTN2` (например, только экземпляр 1) падает. Исправление: пропускать `null`. Тест с экземплярами `{1: …}`.
7. `HarmonicNotchFilter` (FR 174–186, найдено в задаче 3): проверка режима трекинга идёт до `enabled()`, поэтому выключенный notch с неподдерживаемым/бесданным режимом даёт ложное предупреждение. Исправление: при `enable == 0` предупреждений не выдавать. Тест: `INS_HNTC2_ENABLE 0`, `INS_HNTC2_MODE 1`, лог без `RATE`/`CTUN` → `warnings` пуст.

После этого `npm run test:tunewizard-compare` покажет расхождения только там, где они ожидаются; тест получает список допустимых отличий (например, число окон спектрограммы) или проверяет только неизменившиеся величины — задокументировать в тесте.

**Коммит:** `TuneWizard: исправления дефектов, унаследованных из FilterReview` (+ трейлер). В теле коммита — список семи дефектов со ссылками на строки upstream (материал для возможного PR в ArduPilot/WebTools).

---

### Задача 9: Readme, память, push

- `TuneWizard/Readme.md`: раздел «Готовность» — этап 2 готов; описание шагов 1–2, панели настроек, автоподбора, тестов (`test:tunewizard-compare`).
- `tests/README.md`: абзац про `tunewizard-core.test.cjs` (загрузка скриптов как на странице) и `tunewizard-compare.cjs`.
- `npm run lint`, `npm test`, `npm run test:tunewizard`, `npm run test:tunewizard-compare` — всё зелёное.
- Коммит `TuneWizard: Readme и завершение этапа 2` (+ трейлер), `git push origin tune-wizard-stage2`.

---

## Что сознательно не вошло в этап 2

- Третий и четвёртый notch (PR #362) — у прошивки пользователя их нет.
- Web Worker для FFT — ядро без DOM готово к этому, но пока считаем в главном потоке с оверлеем.
- Память прошлого прохода и сводка — этап 5; ссылка на лендинге — этап 6.
