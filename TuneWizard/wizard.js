// Мастер настройки: состояние, навигация по шагам, тема и график полёта. Математика — в core/, реестр графиков — в plots.js.

// Парсер логов — ES-модуль, подгружается асинхронно; load() ждёт import_done
var DataflashParser
const import_done = import('../modules/JsDataflashParser/parser.js').then((mod) => { DataflashParser = mod.default })

// Названия шагов для полосы навигации
const STEP_TITLES = ["Лог и проверки", "Спектр до фильтров", "Гармонический notch", "Низкочастотные фильтры", "PID по осям", "Сводка"]

// Состояние мастера. Лог и производные — только здесь; шаги читают и пишут steps[n]
const state = {
    file_name: null,
    log: null,
    version: null,
    params: null,
    info: null,
    vibe: null,
    checks: null,
    settings: { start: 0, end: 0, min: null, max: null, window_size: 1024 },
    step: 0,
    steps: [],
    // Шаги 1–2: настройки спектра (log_type и filter_version — от лога, остальное — выбор пользователя)
    spectrum: { log_type: null, window_per_batch: 1, amplitude: "dB", frequency: "Hz", log_frequency: false, aliasing: "none", filter_version: null },
    // Гироскоп и FFT (core/gyro.js), источники трекинга и логированные notch, фильтры (core/filters.js)
    gyro: null,
    tracking: null,
    logged: null,
    filters: null,
    // { params, build_type, filter_version } для ядра; filter_version меняется на месте (его читают источники трекинга)
    env: null,
    // Предупреждения загрузки, которые показывают шаги (например, неподдерживаемая версия фильтра)
    load_warnings: [],
    // Файл лога: нужен для «Открыть в FilterReview»
    file: null,
}

// ---------- Тема ----------

function apply_theme(name) {
    const root = document.documentElement
    if (name === "auto") {
        root.removeAttribute("data-theme")
    } else {
        root.setAttribute("data-theme", name)
    }
    for (const button of document.querySelectorAll(".themebar button[data-t]")) {
        button.setAttribute("aria-pressed", String(button.dataset.t === name))
    }
    restyle_plots()
}

function init_theme() {
    let saved = null
    try {
        saved = localStorage.getItem("theme_v1")
    } catch {
        // Хранилище недоступно — работаем без памяти темы
    }
    apply_theme(saved ?? "auto")
    for (const button of document.querySelectorAll(".themebar button[data-t]")) {
        button.addEventListener("click", () => {
            apply_theme(button.dataset.t)
            try {
                localStorage.setItem("theme_v1", button.dataset.t)
            } catch {
                // см. выше
            }
        })
    }
    // Смена системной темы при выборе «как в системе»
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
        if (!document.documentElement.hasAttribute("data-theme")) {
            restyle_plots()
        }
    })
}

// ---------- График полёта ----------

const flight_data = { data: [], layout: {} }

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

function setup_flight_plot() {
    const names = ["Крен", "Тангаж", "Газ", "Высота"]
    const units = ["°", "°", "", "м"]
    const colors = plot_palette().series

    flight_data.data = []
    for (let i = 0; i < names.length; i++) {
        flight_data.data[i] = {
            mode: "lines",
            name: names[i],
            meta: names[i],
            line: { color: colors[i], width: 1.2 },
            yaxis: (i == 0) ? "y" : "y" + (i + 1),
            hovertemplate: "<extra></extra>%{meta}<br>%{x:.2f} с<br>%{y:.2f} " + units[i],
            x: [],
            y: [],
        }
    }

    // Поля темы (фоны, шрифт, сетка, ползунок) проставит реестр; здесь — только своё
    flight_data.layout = {
        xaxis: { title: { text: "Время, с" }, domain: [0.07, 0.93], zeroline: false, showline: true, mirror: true, rangeslider: {} },
        showlegend: false,
        margin: { b: 50, l: 50, r: 50, t: 20 },
    }
    const positions = [0, 0.06, 0.94, 1]
    for (let i = 0; i < names.length; i++) {
        const key = (i == 0) ? "yaxis" : "yaxis" + (i + 1)
        flight_data.layout[key] = {
            title: { text: names[i], font: { color: colors[i] } },
            tickfont: { color: colors[i] },
            zeroline: false,
            showline: true,
            mirror: true,
            side: (i < 2) ? "left" : "right",
            position: positions[i],
            color: colors[i],
        }
        if (i > 0) {
            flight_data.layout[key].overlaying = "y"
        }
    }

    register_plot("FlightData", flight_data.data, flight_data.layout, { on_theme: flight_plot_theme })

    // Ползунок и зум по X задают интервал анализа
    document.getElementById("FlightData").on("plotly_relayout", (data) => {
        if (data["xaxis.range"] !== undefined) {
            set_interval(data["xaxis.range"][0], data["xaxis.range"][1])
        } else if ((data["xaxis.range[0]"] !== undefined) && (data["xaxis.range[1]"] !== undefined)) {
            set_interval(data["xaxis.range[0]"], data["xaxis.range[1]"])
        } else if (data["xaxis.autorange"] === true && state.info != null) {
            set_interval(state.settings.min, state.settings.max)
        }
    })
}

// ---------- Интервал анализа и окно FFT ----------

function set_interval(start, end) {
    start = Math.floor(start)
    end = Math.ceil(end)
    if (state.settings.min != null) {
        start = Math.max(start, state.settings.min)
        end = Math.min(end, state.settings.max)
    }
    state.settings.start = start
    state.settings.end = end
    document.getElementById("TimeStart").value = start
    document.getElementById("TimeEnd").value = end
}

function interval_input_changed() {
    let start = Math.floor(parseFloat(document.getElementById("TimeStart").value))
    let end = Math.ceil(parseFloat(document.getElementById("TimeEnd").value))
    // Сначала зажать в границы лога, потом проверять порядок: иначе конец за пределами лога
    // срезался бы уже в set_interval после проверки, и интервал мог бы инвертироваться
    if (state.settings.min != null) {
        start = Math.max(start, state.settings.min)
        end = Math.min(end, state.settings.max)
    }
    if (!(end > start)) {
        set_interval(state.settings.start, state.settings.end)
        return
    }
    set_interval(start, end)
    flight_data.layout.xaxis.range = [state.settings.start, state.settings.end]
    flight_data.layout.xaxis.autorange = false
    Plotly.relayout("FlightData", { "xaxis.range": [state.settings.start, state.settings.end] })
}

// Окно FFT — ближайшая степень двойки в сторону изменения
function window_size_changed(input) {
    const value = parseInt(input.value)
    let size = state.settings.window_size
    if (value > size) {
        size *= 2
    } else if (value < size) {
        size = Math.max(64, size / 2)
    }
    state.settings.window_size = size
    input.value = size
}

// ---------- Шаги ----------

// Статус проверки шага 0 по id ("gyro_log", "pid_log"); null, если проверок нет
function check_status(id) {
    const check = (state.checks ?? []).find((c) => c.id === id)
    return check ? check.status : null
}

// Шаг 0 доступен всегда; 1–3 — лог Copter с пригодными данными гироскопа; 4 — лог Copter с PID или RATE;
// 5 (сводка) — любой загруженный лог
function step_available(n) {
    if (n == 0) {
        return true
    }
    if (state.info == null) {
        return false
    }
    if (n == 5) {
        return true
    }
    if (state.info.vehicle !== "Copter") {
        return false
    }
    if (n <= 3) {
        return check_status("gyro_log") !== "fail"
    }
    return check_status("pid_log") !== "fail"
}

// Окно FFT шага 0 действует только на raw-лог (GYR). Тип — выбор шага 1, а до него — как выберет load_gyro:
// raw, если он есть, иначе batch
function raw_window_used() {
    if (state.log == null) {
        return false
    }
    const types = state.log.messageTypes
    const have_raw = "GYR" in types
    const have_batch = ("ISBH" in types) && ("ISBD" in types)
    const type = state.spectrum.log_type ?? (have_raw ? "raw" : (have_batch ? "batch" : null))
    return type === "raw"
}

// Хук показа шага: шаги из steps/*.js готовят данные и графики своей секции
function on_show_step(n) {
    if ((n === 1) && (typeof step1_show === "function")) {
        step1_show()
    }
}

function set_step(n) {
    if (!step_available(n)) {
        return
    }
    state.step = n
    for (const section of document.querySelectorAll("section[data-step]")) {
        section.hidden = Number(section.dataset.step) !== n
    }
    update_wizbar()
    on_show_step(n)
    // Графики показанного шага дорисовать: скрытыми они не рисуются (политика в plots.js)
    show_plots(document.querySelector('section[data-step="' + n + '"]'))
}

function update_wizbar() {
    const buttons = document.querySelectorAll("#wizbar button")
    for (let i = 0; i < buttons.length; i++) {
        buttons[i].disabled = !step_available(i)
        if (i === state.step) {
            buttons[i].setAttribute("aria-current", "step")
        } else {
            buttons[i].removeAttribute("aria-current")
        }
    }
}

function init_wizard() {
    const bar = document.getElementById("wizbar")
    for (let i = 0; i < STEP_TITLES.length; i++) {
        const button = document.createElement("button")
        button.type = "button"
        button.innerHTML = '<span class="n">Шаг ' + i + '</span><span class="t">' + STEP_TITLES[i] + '</span>'
        button.addEventListener("click", () => set_step(i))
        bar.appendChild(button)
    }
    setup_flight_plot()
    if (typeof step1_init === "function") {
        step1_init()
    }
    set_step(0)
}

// ---------- Загрузка лога (шаг 0) ----------

function read_file(input) {
    const file = input.files[0]
    if (file == null) {
        return
    }
    state.file_name = file.name
    const reader = new FileReader()
    reader.onload = function () {
        loading_call(async () => {
            try {
                await load(reader.result, file)
            } catch (e) {
                // Ошибка парсера или данных: показать в вердикте, а не оставлять оверлей
                console.error(e)
                load_failed("Не удалось прочитать лог «" + state.file_name + "»: " + e.message)
            }
        })
    }
    reader.onerror = function () {
        load_failed("Не удалось прочитать файл «" + state.file_name + "»: " + (reader.error ? reader.error.message : "ошибка чтения"))
    }
    reader.readAsArrayBuffer(file)
    // File уже взят: очистить поле, чтобы повторный выбор того же файла (перезагрузка лога) снова вызвал change
    input.value = ""
}

function show_verdict(status, text) {
    const verdict = document.getElementById("log_verdict")
    verdict.className = "verdict verdict--" + status
    verdict.textContent = text
    verdict.hidden = false
}

// Единый путь ошибки загрузки: сбросить полусостояние, назвать причину и очистить поле выбора,
// чтобы повторный выбор того же файла снова вызвал change
function load_failed(message) {
    reset()
    show_verdict("fail", message)
    document.getElementById("fileItem").value = ""
}

function reset() {
    document.title = "Мастер настройки"
    state.log = null
    state.version = null
    state.params = null
    state.info = null
    state.vibe = null
    state.checks = null
    state.settings = { start: 0, end: 0, min: null, max: null, window_size: state.settings.window_size }
    state.steps = []
    state.spectrum.log_type = null
    state.spectrum.filter_version = null
    state.gyro = null
    state.tracking = null
    state.logged = null
    state.filters = null
    state.env = null
    state.load_warnings = []
    state.file = null
    if (typeof step1_reset === "function") {
        step1_reset()
    }
    document.getElementById("fileLabel").textContent = "Выбрать лог…"
    for (const id of ["TimeStart", "TimeEnd", "FFTWindow_size"]) {
        document.getElementById(id).disabled = true
    }
    for (const id of ["TimeStart", "TimeEnd"]) {
        const input = document.getElementById(id)
        input.value = 0
        input.removeAttribute("min")
        input.removeAttribute("max")
    }
    document.getElementById("log_verdict").hidden = true
    document.getElementById("log_info").hidden = true
    document.getElementById("log_checks").hidden = true
    for (const trace of flight_data.data) {
        trace.x = []
        trace.y = []
    }
    // Пустой график перерисовать сразу, чтобы прошлый полёт не оставался на экране; диапазон — снова авто
    if (plot("FlightData")) {
        delete flight_data.layout.xaxis.range
        flight_data.layout.xaxis.autorange = true
        render_plot("FlightData")
    }
    update_wizbar()
}

// buffer — содержимое лога, file — исходный File (для «Открыть в FilterReview»; может быть null)
async function load(buffer, file = null) {
    await import_done
    const start = performance.now()
    reset()

    const log = new DataflashParser()
    log.processData(buffer, [])
    if (!("PARM" in log.messageTypes)) {
        load_failed("В файле «" + state.file_name + "» нет параметров (PARM): это не лог ArduPilot или он повреждён")
        return
    }

    state.log = log
    state.version = get_version_and_board(log)
    state.params = log_params(log)
    state.info = log_info(log, state.version)
    state.vibe = vibe_summary(log)
    state.checks = run_checks(state.info, state.params, state.vibe)
    // Окружение ядра. Версия фильтра из VER.FV, как в FilterReview: без неё — 1 (FilterReview оставляет 1.0 из reset),
    // неподдерживаемая — последняя (4) с предупреждением (FilterReview показывает alert)
    const fv = state.info.filter_version
    let filter_version = 1
    if (fv != null) {
        filter_version = [1, 2, 3, 4].includes(fv) ? fv : 4
        if (filter_version !== fv) {
            state.load_warnings.push("Неподдерживаемая версия фильтра " + fv + ", взята 4")
        }
    }
    state.env = { params: state.params, build_type: state.info.build_type, filter_version: filter_version }
    state.spectrum.filter_version = filter_version
    state.file = file

    document.title = "Мастер настройки: " + state.file_name
    document.getElementById("fileLabel").textContent = state.file_name

    render_info()
    render_checks()
    plot_flight()

    for (const id of ["TimeStart", "TimeEnd"]) {
        document.getElementById(id).disabled = false
    }
    document.getElementById("FFTWindow_size").disabled = !raw_window_used()
    update_wizbar()
    console.log("Загрузка заняла " + Math.round(performance.now() - start) + " мс")
}

// Экранирование текста для innerHTML: строки из лога (прошивка, плата) могут содержать < и &
function html_escape(text) {
    return String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))
}

function stat_tile(key, value, accent) {
    return '<div class="stat' + (accent ? " stat--accent" : "") + '"><span class="stat__k">' + html_escape(key) + '</span><span class="stat__v">' + html_escape(value) + '</span></div>'
}

function format_seconds(s) {
    if (s == null) {
        return "—"
    }
    // Сначала округлить всё, потом делить: иначе 59.6 с давало бы «0 мин 60 с»
    const t = Math.round(s)
    const m = Math.floor(t / 60)
    const sec = t % 60
    return (m > 0) ? m + " мин " + sec + " с" : sec + " с"
}

function render_info() {
    const info = state.info
    const params = state.params
    const flight = info.flight
    const html = [
        stat_tile("Аппарат", info.vehicle ?? "—", info.vehicle === "Copter"),
        stat_tile("Прошивка", info.fw_string ?? "—"),
        stat_tile("Плата", info.board ?? "—"),
        stat_tile("Длительность лога", format_seconds(info.duration_s)),
        stat_tile("Полёт с газом", flight ? format_seconds(flight.duration_s) : "нет"),
        stat_tile("Средний газ", (flight && flight.mean_throttle != null) ? flight.mean_throttle.toFixed(2) : "—"),
        stat_tile("INS_GYRO_FILTER", params.get("INS_GYRO_FILTER") ?? "—"),
        stat_tile("SCHED_LOOP_RATE", params.get("SCHED_LOOP_RATE") ?? "—"),
        stat_tile("Версия фильтра", info.filter_version ?? "—"),
    ]
    const box = document.getElementById("log_info")
    box.innerHTML = html.join("")
    box.hidden = false
}

function render_checks() {
    const labels = { ok: "OK", warn: "ВНИМ", fail: "СТОП" }
    const box = document.getElementById("log_checks")
    box.innerHTML = state.checks.map((c) =>
        '<div class="check check--' + c.status + '"><span class="check__s">' + labels[c.status] + '</span>' +
        '<div class="check__b"><h3>' + html_escape(c.title) + '</h3><p>' + html_escape(c.text) + '</p>' +
        (c.fix ? '<p class="fix"><b>Что сделать:</b> ' + html_escape(c.fix) + '</p>' : "") + '</div></div>'
    ).join("")
    box.hidden = false

    const summary = checks_summary(state.checks)
    const texts = {
        ok: "Лог пригоден: все проверки пройдены",
        warn: "Лог пригоден с оговорками: " + summary.warn + " предупреждений",
        fail: "Есть блокирующие проблемы: " + summary.fail + " — см. список ниже",
    }
    show_verdict(summary.status, texts[summary.status])
}

function plot_flight() {
    const log = state.log
    // log.get возвращает undefined для сообщения без строк или без поля: каждый ряд рисуем только целиком
    if ("ATT" in log.messageTypes) {
        const TimeUS = log.get("ATT", "TimeUS")
        const Roll = log.get("ATT", "Roll")
        const Pitch = log.get("ATT", "Pitch")
        if ((TimeUS != null) && (Roll != null) && (Pitch != null)) {
            const time = us_to_s(TimeUS)
            flight_data.data[0].x = time
            flight_data.data[0].y = Roll
            flight_data.data[1].x = time
            flight_data.data[1].y = Pitch
        }
    }
    const throttle = throttle_series(log)
    if ((throttle != null) && (throttle.time != null) && (throttle.throttle != null)) {
        flight_data.data[2].x = throttle.time
        flight_data.data[2].y = throttle.throttle
    }
    if ("POS" in log.messageTypes) {
        const TimeUS = log.get("POS", "TimeUS")
        const RelHomeAlt = log.get("POS", "RelHomeAlt")
        if ((TimeUS != null) && (RelHomeAlt != null)) {
            flight_data.data[3].x = us_to_s(TimeUS)
            flight_data.data[3].y = RelHomeAlt
        }
    }

    // Границы данных: абсолютные секунды лога из log_info, иначе по нарисованным рядам
    let min = state.info.time_start
    let max = state.info.time_end
    if ((min == null) || (max == null)) {
        min = Infinity
        max = -Infinity
        for (const trace of flight_data.data) {
            if (trace.x.length > 0) {
                min = Math.min(min, trace.x[0])
                max = Math.max(max, trace.x[trace.x.length - 1])
            }
        }
        if (!Number.isFinite(min)) {
            min = 0
            max = state.info.duration_s ?? 0
        }
    }
    state.settings.min = Math.floor(min)
    state.settings.max = Math.ceil(max)
    // Интервал по умолчанию: полёт с газом, иначе весь лог
    const flight = state.info.flight
    set_interval(flight ? flight.start : min, flight ? flight.end : max)
    for (const id of ["TimeStart", "TimeEnd"]) {
        document.getElementById(id).min = state.settings.min
        document.getElementById(id).max = state.settings.max
    }

    flight_data.layout.xaxis.range = [state.settings.start, state.settings.end]
    flight_data.layout.xaxis.autorange = false
    render_plot("FlightData")
}
