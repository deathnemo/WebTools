// Шаг 1 «Спектр до фильтров»: панель настроек спектра, средний спектр, спектрограмма, пики шума и вердикт.
// Данные — ядро (core/gyro.js, core/filters.js, core/spectrum.js, core/metrics.js), графики — реестр plots.js,
// состояние — общий state из wizard.js. Числа повторяют FilterReview: тот же интервал анализа, окно FFT, шкалы
// и фильтры из параметров лога (регрессия — tests/tunewizard-compare.cjs).

// Типы и оси трасс среднего спектра — в порядке get_FFT_data_index из FilterReview
const SPEC_TYPES = ["pre", "post", "est"]
const SPEC_TYPE_NAMES = { pre: "до", post: "после", est: "оценка" }
const SPEC_AXES = ["x", "y", "z"]
// Строк в таблице пиков
const SPEC_MAX_PEAKS = 10
// Наибольшее число окон на пакет в подсказке допустимых значений
const SPEC_MAX_WINDOWS_PER_BATCH = 64

// Внутреннее состояние шага: с какими настройками посчитан FFT и фильтры, ошибка и предупреждения расчёта FFT
const step1 = {
    fft_key: null,        // "batch:<окон на пакет>" или "raw:<окно>" — настройки посчитанного FFT
    filters_key: null,    // версия фильтра, с которой посчитаны фильтры и передаточная функция
    error: null,          // ошибка загрузки гироскопа или FFT: показывается в вердикте вместо результатов
    fft_warnings: [],     // предупреждения последнего расчёта FFT (живут, пока FFT не пересчитан)
}

// Индекс трассы среднего спектра: сенсор s (0–2), тип t (0 до, 1 после, 2 оценка), ось a (0–2)
function spec_trace_index(s, t, a) {
    return s * SPEC_TYPES.length * SPEC_AXES.length + t * SPEC_AXES.length + a
}

// Значения параметров фильтров из лога; отсутствующих в логе — умолчания формы FilterReview (reset, FR 461–483,
// и поля INS_GYRO_FILTER = 20, SCHED_LOOP_RATE = 400 в его index.html). ESCMSK при версии фильтра ниже 4
// обнуляется, как в update_hidden_params FilterReview
function values_from_log() {
    const values = {
        INS_GYRO_FILTER: state.params.get("INS_GYRO_FILTER") ?? 20,
        SCHED_LOOP_RATE: state.params.get("SCHED_LOOP_RATE") ?? 400,
    }
    const defaults = { FREQ: 80, BW: 40, ATT: 40, HMNCS: 3, MODE: 1, FM_RAT: 1 }
    for (const names of notch_param_names()) {
        for (const name of Object.values(names)) {
            // Префиксы INS_HNTCH_ и INS_HNTC2_ — по 10 символов
            values[name] = state.params.get(name) ?? defaults[name.slice(10)] ?? 0
        }
        if (state.env.filter_version < 4) {
            values[names.esc_mask] = 0
        }
    }
    return values
}

// ---------- Подписи ----------

// Подсказка частоты для hovertemplate по выбранной единице
function spec_freq_hover(axis) {
    return "%{" + axis + ":.2f}" + ((state.spectrum.frequency === "RPM") ? " RPM" : " Гц")
}

// Подсказка амплитуды для hovertemplate по выбранной шкале
function spec_amp_hover(axis) {
    const units = { linear: "", dB: " дБ", PSD: " дБ/Гц" }
    return "%{" + axis + ":.2f}" + units[state.spectrum.amplitude]
}

function spec_verdict(status, text) {
    const verdict = document.getElementById("verdict1")
    verdict.className = "verdict verdict--" + status
    verdict.textContent = text
    verdict.hidden = false
}

// ---------- Графики ----------

// Цвета трасс среднего спектра: ось — цвет, тип — штрих, гироскоп — прозрачность
function spectrum1_theme(palette, data, layout) {
    for (let s = 0; s < 3; s++) {
        for (let t = 0; t < SPEC_TYPES.length; t++) {
            for (let a = 0; a < SPEC_AXES.length; a++) {
                const trace = data[spec_trace_index(s, t, a)]
                trace.line.color = palette.axis[SPEC_AXES[a]]
                trace.line.dash = palette.dash[SPEC_TYPES[t]]
                trace.opacity = palette.gyro_opacity[s]
            }
        }
    }
}

// Цвета линий логированных notch на спектрограмме (трассы после тепловой карты)
function spectrogram1_theme(palette, data, layout) {
    for (let i = 1; i < data.length; i++) {
        data[i].line.color = palette.warn
    }
}

function setup_step1_plots() {
    const data = []
    for (let s = 0; s < 3; s++) {
        for (let t = 0; t < SPEC_TYPES.length; t++) {
            for (let a = 0; a < SPEC_AXES.length; a++) {
                const name = "Гироскоп " + (s + 1) + " · " + SPEC_TYPE_NAMES[SPEC_TYPES[t]] + " · " + SPEC_AXES[a].toUpperCase()
                data[spec_trace_index(s, t, a)] = {
                    mode: "lines",
                    name: name,
                    meta: name,
                    legendgroup: "g" + s,
                    legendgrouptitle: { text: "Гироскоп " + (s + 1) },
                    line: { width: 1.2 },
                    visible: false,
                    x: [],
                    y: [],
                }
            }
        }
    }
    const layout = {
        xaxis: { title: { text: "Частота, Гц" }, type: "linear", zeroline: false, showline: true, mirror: true },
        yaxis: { title: { text: "Амплитуда, дБ" }, zeroline: false, showline: true, mirror: true },
        showlegend: true,
        // Щелчок по легенде включает одну линию, а не всю группу гироскопа
        legend: { groupclick: "toggleitem" },
        margin: { b: 50, l: 60, r: 20, t: 20 },
    }
    register_plot("Spectrum1", data, layout, { on_theme: spectrum1_theme })

    // Спектрограмма: тепловая карта (x — время, y — частота, z[j] — строка окна j, поэтому transpose) и линии
    // логированных notch. Градиент Viridis — единственное исключение из правила «цвета только из токенов»
    const sg_data = [{
        type: "heatmap",
        transpose: true,
        zsmooth: "best",
        colorscale: "Viridis",
        colorbar: { title: { text: "Амплитуда, дБ", side: "right" }, orientation: "h" },
        hovertemplate: "",
        x: [],
        y: [],
        z: [],
    }]
    const sg_layout = {
        xaxis: { title: { text: "Время, с" }, zeroline: false, showline: true, mirror: true },
        yaxis: { title: { text: "Частота, Гц" }, type: "linear", zeroline: false, showline: true, mirror: true },
        showlegend: true,
        legend: { groupclick: "toggleitem" },
        margin: { b: 50, l: 60, r: 20, t: 20 },
    }
    register_plot("Spectrogram1", sg_data, sg_layout, { on_theme: spectrogram1_theme })
}

// ---------- Инициализация и сброс ----------

function radio_value(name) {
    const checked = document.querySelector('input[name="' + name + '"]:checked')
    return checked ? checked.value : null
}

function step1_init() {
    setup_step1_plots()

    // Тип лога, окна и версия фильтра — до «Пересчитать»
    for (const id of ["spec_log_batch", "spec_log_raw", "spec_fv_1", "spec_fv_2", "spec_fv_3", "spec_fv_4"]) {
        document.getElementById(id).addEventListener("change", step1_panel_changed)
    }
    document.getElementById("spec_window_per_batch").addEventListener("change", (e) => {
        // Целое не меньше 1, как Math.max(parseInt(…), 1) в run_batch_fft
        const value = parseInt(e.target.value)
        e.target.value = (Number.isFinite(value) && (value >= 1)) ? value : 1
        step1_panel_changed()
    })
    document.getElementById("spec_recalc").addEventListener("click", step1_recalc)

    // Шкалы и алиасинг — перерисовка без FFT
    for (const id of ["spec_amp_linear", "spec_amp_dB", "spec_amp_PSD", "spec_freq_Hz", "spec_freq_RPM", "spec_freq_log",
                      "spec_alias_none", "spec_alias_fold", "spec_alias_only"]) {
        document.getElementById(id).addEventListener("change", step1_view_changed)
    }

    // Выбор данных спектрограммы
    for (const id of ["spec_sg_inst0", "spec_sg_inst1", "spec_sg_inst2", "spec_sg_pre", "spec_sg_post", "spec_sg_est",
                      "spec_sg_x", "spec_sg_y", "spec_sg_z"]) {
        document.getElementById(id).addEventListener("change", () => step1_run(() => redraw_spectrogram1()))
    }

    document.getElementById("open_filterreview").addEventListener("click", open_in_filterreview)
}

// Новый лог или ошибка загрузки: забыть расчёт шага, очистить графики и итоги
function step1_reset() {
    step1.fft_key = null
    step1.filters_key = null
    step1.error = null
    step1.fft_warnings = []
    for (const id of ["verdict1", "warnings1", "peaks1", "peaks1_note", "spec_raw_note", "spec_wpb_hint"]) {
        document.getElementById(id).hidden = true
    }
    document.getElementById("spec_info").textContent = ""
    for (const id of ["spec_log_batch", "spec_log_raw"]) {
        const radio = document.getElementById(id)
        radio.checked = false
        radio.disabled = true
    }
    for (const id of ["spec_sg_inst0", "spec_sg_inst1", "spec_sg_inst2", "spec_sg_pre", "spec_sg_post", "spec_sg_est"]) {
        const radio = document.getElementById(id)
        radio.checked = false
        radio.disabled = true
    }
    document.getElementById("spec_recalc").classList.remove("primary")
    document.getElementById("open_filterreview").disabled = true
    clear_step1_plots()
}

// Пустые графики шага (данные и линии убираются, видимость трасс — по умолчанию скрыты)
function clear_step1_plots() {
    const spectrum = plot("Spectrum1")
    if (spectrum != null) {
        for (const trace of spectrum.data) {
            trace.x = []
            trace.y = []
            trace.visible = false
        }
        render_plot("Spectrum1")
    }
    const spectrogram = plot("Spectrogram1")
    if (spectrogram != null) {
        spectrogram.data.length = 1
        spectrogram.data[0].x = []
        spectrogram.data[0].y = []
        spectrogram.data[0].z = []
        render_plot("Spectrogram1")
    }
}

// ---------- Панель настроек ----------

// Значения панели, которые применяются только кнопкой «Пересчитать»
function step1_pending() {
    return {
        log_type: radio_value("spec_log") ?? state.spectrum.log_type,
        window_per_batch: parseInt(document.getElementById("spec_window_per_batch").value),
        filter_version: parseInt(radio_value("spec_fv") ?? state.spectrum.filter_version),
    }
}

// Панель расходится с посчитанным: подсветить «Пересчитать», как FilterReview включает Calculate
function step1_panel_changed() {
    const pending = step1_pending()
    const stale = (pending.log_type !== state.spectrum.log_type) ||
                  (pending.window_per_batch !== state.spectrum.window_per_batch) ||
                  (pending.filter_version !== state.spectrum.filter_version)
    document.getElementById("spec_recalc").classList.toggle("primary", stale)
    // Поле окон на пакет и подсказка — только для batch-лога; у raw окно задаётся на шаге 0
    const batch = pending.log_type === "batch"
    document.getElementById("spec_batch_field").hidden = !batch
    const hint = document.getElementById("spec_wpb_hint")
    hint.hidden = !batch || (hint.textContent === "")
    document.getElementById("spec_raw_note").hidden = batch || (pending.log_type == null)
}

// Шкалы, единицы и алиасинг: перерисовать без FFT
function step1_view_changed() {
    state.spectrum.amplitude = radio_value("spec_amp")
    state.spectrum.frequency = radio_value("spec_freq")
    state.spectrum.log_frequency = document.getElementById("spec_freq_log").checked
    state.spectrum.aliasing = radio_value("spec_alias")
    step1_run(() => redraw_step1())
}

// Числа окон на пакет до SPEC_MAX_WINDOWS_PER_BATCH, при которых окно batch — степень двойки: формула run_batch_fft
// floor(N / (1 + (w − 1)·0.5)) для длины пакета N каждого экземпляра (общие для всех экземпляров)
function valid_windows_per_batch(gyro) {
    let valid = null
    for (let i = 0; i < gyro.length; i++) {
        if ((gyro[i] == null) || (gyro[i].length == 0)) {
            continue
        }
        const num_points = gyro[i][0].x.length
        const list = []
        for (let w = 1; w <= SPEC_MAX_WINDOWS_PER_BATCH; w++) {
            const size = Math.floor(num_points / (1 + (w - 1) * 0.5))
            if ((size >= 1) && Number.isInteger(Math.log2(size))) {
                list.push(w)
            }
        }
        valid = (valid == null) ? list : valid.filter((w) => list.includes(w))
    }
    return valid ?? []
}

// Панель по состоянию: применённые настройки, доступные типы лога, версия фильтра, подсказка окон на пакет
function fill_step1_panel() {
    const log = state.log
    const have_batch = ("ISBH" in log.messageTypes) && ("ISBD" in log.messageTypes)
    const have_raw = "GYR" in log.messageTypes
    for (const [id, type] of [["spec_log_batch", "batch"], ["spec_log_raw", "raw"]]) {
        const radio = document.getElementById(id)
        // Выбор есть, только если в логе оба типа
        radio.disabled = !(have_batch && have_raw)
        radio.checked = state.spectrum.log_type === type
    }
    document.getElementById("spec_window_per_batch").value = state.spectrum.window_per_batch
    for (let v = 1; v <= 4; v++) {
        document.getElementById("spec_fv_" + v).checked = state.spectrum.filter_version === v
    }
    document.getElementById("spec_amp_" + state.spectrum.amplitude).checked = true
    document.getElementById("spec_freq_" + state.spectrum.frequency).checked = true
    document.getElementById("spec_freq_log").checked = state.spectrum.log_frequency
    document.getElementById("spec_alias_" + state.spectrum.aliasing).checked = true
    document.getElementById("open_filterreview").disabled = state.file == null

    const hint = document.getElementById("spec_wpb_hint")
    hint.textContent = ""
    if ((state.gyro != null) && (state.gyro.error == null) && (state.gyro.type === "batch")) {
        const valid = valid_windows_per_batch(state.gyro)
        const lengths = [...new Set(state.gyro.filter((g) => (g != null) && (g.length > 0)).map((g) => g[0].x.length))]
        hint.textContent = "Окно FFT — степень двойки, поэтому для пакета " + lengths.join(", ") + " отсчётов допустимо окон на пакет: " +
            ((valid.length > 0) ? valid.join(", ") : "ни одного до " + SPEC_MAX_WINDOWS_PER_BATCH)
    }
    step1_panel_changed()
}

// Сведения о сенсорах: имя и шина из INS_GYR*_ID, частота IMU, частота дискретизации и разрешение FFT
function fill_step1_info() {
    const gyro = state.gyro
    const info = ((gyro != null) && (gyro.error == null)) ? fft_info(gyro) : {}
    const lines = []
    for (let s = 0; s < 3; s++) {
        const sensor = gyro?.gyro_info?.[s]
        if ((sensor == null) && (info[s] == null)) {
            continue
        }
        let text = "Гироскоп " + (s + 1) + ": "
        if (sensor != null) {
            text += sensor.name + (sensor.bus_type ? " через " + sensor.bus_type : "") +
                    ((sensor.rate != null) ? ", " + Math.round(sensor.rate) + " Гц" : ", частота IMU неизвестна")
        } else {
            text += "сенсор не определён"
        }
        if (info[s] != null) {
            text += " · дискретизация " + info[s].sample_rate.toFixed(2) + " Гц, разрешение " + info[s].resolution.toFixed(2) + " Гц, окно " + info[s].window_size
        }
        lines.push(text)
    }
    const box = document.getElementById("spec_info")
    box.innerHTML = lines.map((line) => "<span>" + html_escape(line) + "</span>").join("")
}

// Видимость трасс по умолчанию (FilterReview load, FR 2619–2672): у первичного гироскопа (или у всех, если
// первичный не определён) видны до и после; оценка «после» видна, только если записанного «после» нет;
// остальные — в легенде; трассы без данных скрыты совсем
function default_spectrum_visibility() {
    const gyro = state.gyro
    const data = plot("Spectrum1").data
    for (const trace of data) {
        trace.visible = false
    }
    const shown = (s) => (gyro.primary == null) || (s == gyro.primary)
    for (let i = 0; i < gyro.length; i++) {
        if (gyro[i] == null) {
            continue
        }
        const s = gyro[i].sensor_num
        const t = gyro[i].post_filter ? 1 : 0
        for (let a = 0; a < SPEC_AXES.length; a++) {
            data[spec_trace_index(s, t, a)].visible = shown(s) ? true : "legendonly"
            if (!gyro[i].post_filter) {
                // Оценка «после» строится по данным «до» этого сенсора
                data[spec_trace_index(s, 2, a)].visible = (shown(s) && !gyro.have_post) ? true : "legendonly"
            }
        }
    }
}

// Выбор спектрограммы по умолчанию (FR 2679–2688): первичный гироскоп или первый с данными, «до» если есть, ось X
function default_spectrogram_selection() {
    const gyro = state.gyro
    for (let s = 0; s < 3; s++) {
        const radio = document.getElementById("spec_sg_inst" + s)
        radio.disabled = !gyro.some((g) => (g != null) && (g.sensor_num == s))
        radio.checked = false
    }
    const sensor = gyro.primary ?? gyro.first_gyro
    if (sensor != null) {
        document.getElementById("spec_sg_inst" + sensor).checked = true
    }
    document.getElementById("spec_sg_pre").disabled = !gyro.have_pre
    document.getElementById("spec_sg_post").disabled = !gyro.have_post
    document.getElementById("spec_sg_est").disabled = !gyro.have_pre
    document.getElementById(gyro.have_pre ? "spec_sg_pre" : "spec_sg_post").checked = true
    document.getElementById("spec_sg_x").checked = true
}

// ---------- Расчёт ----------

// Загрузить гироскоп, если ещё не загружен (или сменили тип лога): источники трекинга, логированные notch,
// видимость трасс и выбор спектрограммы. false — данных нет, текст в step1.error; производные тогда сброшены
function ensure_gyro() {
    if (state.gyro != null) {
        step1.error = state.gyro.error
        return state.gyro.error == null
    }
    step1.fft_key = null
    step1.filters_key = null
    step1.fft_warnings = []
    state.tracking = null
    state.logged = null
    state.filters = null
    state.gyro = load_gyro(state.log, state.env, { log_type: state.spectrum.log_type })
    if (state.gyro.error != null) {
        step1.error = state.gyro.error
        return false
    }
    state.spectrum.log_type = state.gyro.type
    state.tracking = create_tracking(state.log, state.env, state.gyro)
    state.logged = create_logged(state.log)
    // Окно FFT шага 0 действует только на raw-лог
    document.getElementById("FFTWindow_size").disabled = !raw_window_used()
    default_spectrum_visibility()
    default_spectrogram_selection()
    return true
}

// FFT по текущим настройкам (batch — окон на пакет, raw — окно шага 0), затем фильтры из параметров лога и
// передаточная функция — как calculate, load_filters и calculate_transfer_function в re_calc FilterReview.
// false — ошибка (окно не степень двойки и т. п.), текст в step1.error
function ensure_fft() {
    const gyro = state.gyro
    const batch = gyro.type === "batch"
    const key = batch ? "batch:" + state.spectrum.window_per_batch : "raw:" + state.settings.window_size
    if (key !== step1.fft_key) {
        step1.fft_key = null
        step1.filters_key = null
        step1.fft_warnings = []
        state.filters = null
        clear_gyro_fft(gyro)
        let result
        try {
            result = gyro_fft(gyro, { window_size: state.settings.window_size, window_per_batch: state.spectrum.window_per_batch })
        } catch (e) {
            // Ошибка настроек, а не программы: в вердикт, без консоли
            clear_gyro_fft(gyro)
            step1.error = "Не удалось посчитать FFT: " + e.message
            return false
        }
        step1.fft_warnings = result.warnings
        interpolate_tracking(state.tracking, gyro)
        step1.fft_key = key

        // В batch размер окна вычисляется: показать его в поле шага 0, как FilterReview (FR 843)
        if (batch) {
            const info = fft_info(gyro)
            const first = [0, 1, 2].find((s) => info[s] != null)
            if (first != null) {
                state.settings.window_size = info[first].window_size
                document.getElementById("FFTWindow_size").value = info[first].window_size
            }
        }
    }

    if ((state.filters == null) || (step1.filters_key !== state.spectrum.filter_version)) {
        // Источники трекинга держат ссылку на state.env — версию меняем на месте
        state.env.filter_version = state.spectrum.filter_version
        state.filters = load_filters(values_from_log(), state.env, state.tracking)
        // Логированные notch рисуются с гармониками из параметров лога (FR 2586)
        for (let i = 0; i < state.filters.notch.length; i++) {
            state.logged[i].harmonics = state.filters.notch[i].harmonics()
        }
        calculate_transfer_function(state.filters, gyro)
        step1.filters_key = state.spectrum.filter_version
    }
    return true
}

// Выполнить fn под оверлеем загрузки; неожиданная ошибка — в консоль и вердикт, оверлей не зависает
function step1_run(fn) {
    loading_call(async () => {
        try {
            fn()
        } catch (e) {
            console.error(e)
            spec_verdict("fail", "Ошибка шага 1: " + e.message)
        }
    })
}

// Посчитать недостающее без перерисовки: гироскоп, FFT, трекинг и фильтры из параметров лога. Шаг 2 зовёт это,
// если шаг 1 ещё не считался или его расчёт устарел. Возвращает step1_ready(); ошибка — в step1.error
function step1_prepare() {
    step1.error = null
    if (ensure_gyro()) {
        ensure_fft()
    }
    return step1_ready()
}

// Посчитать недостающее и перерисовать всё
function compute_and_redraw_step1() {
    step1_prepare()
    fill_step1_panel()
    fill_step1_info()
    redraw_step1()
}

// Показ шага: при первом показе (и после смены окна raw-лога на шаге 0) посчитать FFT; настройки панели
// применяются только кнопкой «Пересчитать»
function step1_show() {
    if (state.log == null) {
        return
    }
    step1_run(compute_and_redraw_step1)
}

// «Пересчитать»: применить панель (тип лога, окна на пакет, версию фильтра) и посчитать заново
function step1_recalc() {
    if (state.log == null) {
        return
    }
    const pending = step1_pending()
    if ((pending.log_type != null) && (pending.log_type !== state.spectrum.log_type)) {
        state.spectrum.log_type = pending.log_type
        state.gyro = null
    }
    state.spectrum.window_per_batch = pending.window_per_batch
    state.spectrum.filter_version = pending.filter_version
    step1_run(compute_and_redraw_step1)
}

// ---------- Перерисовка ----------

// Расчёт шага актуален: гироскоп загружен, FFT посчитан с текущими настройками, источники трекинга и фильтры
// текущей версии готовы. Шаг 2 опирается на это же состояние (state.gyro, state.tracking, state.filters)
function step1_ready() {
    if ((step1.error != null) || (state.gyro == null) || (state.gyro.error != null) || (step1.fft_key == null)) {
        return false
    }
    const key = (state.gyro.type === "batch") ? "batch:" + state.spectrum.window_per_batch : "raw:" + state.settings.window_size
    return (step1.fft_key === key) && (state.tracking != null) && (state.filters != null) && (step1.filters_key === state.spectrum.filter_version)
}

// Предупреждения шага, собранные заново из источников: загрузка лога и гироскопа, последний FFT, фильтры
function step1_warnings() {
    return [...new Set([...(state.load_warnings ?? []), ...(state.gyro?.warnings ?? []), ...step1.fft_warnings, ...(state.filters?.warnings ?? [])])]
}

function redraw_step1() {
    redraw_spectrum1()
    redraw_spectrogram1()
    redraw_peaks1()
}

// Средний спектр всех экземпляров: до/после (mean_spectrum) и оценка «после» (estimate_post) — FR redraw
// (1112–1182) и redraw_post_estimate_and_bode (1295–1350)
function redraw_spectrum1() {
    const p = plot("Spectrum1")
    const amp = spectrum_amplitude_scale(state.spectrum.amplitude)
    const freq = spectrum_frequency_scale(state.spectrum.frequency, state.spectrum.log_frequency)
    p.layout.xaxis.type = freq.type
    p.layout.xaxis.title.text = freq.label
    p.layout.yaxis.title.text = amp.label

    const hover = "<extra></extra>%{meta}<br>" + spec_freq_hover("x") + "<br>" + spec_amp_hover("y")
    for (const trace of p.data) {
        trace.x = []
        trace.y = []
        trace.hovertemplate = hover
    }

    if (step1_ready()) {
        const gyro = state.gyro
        const range = [state.settings.start, state.settings.end]
        const loop_rate = values_from_log().SCHED_LOOP_RATE
        for (let i = 0; i < gyro.length; i++) {
            if ((gyro[i] == null) || (gyro[i].FFT == null) || (gyro[i].FFT.x.length == 0)) {
                continue
            }
            const alias = alias_obj(gyro[i].FFT, { mode: state.spectrum.aliasing, loop_rate: loop_rate })
            const x = freq.fun(alias.bins)
            const s = gyro[i].sensor_num

            const mean = mean_spectrum(gyro[i].FFT, amp, range, alias)
            const t = gyro[i].post_filter ? 1 : 0
            for (let a = 0; a < SPEC_AXES.length; a++) {
                const trace = p.data[spec_trace_index(s, t, a)]
                trace.x = x
                trace.y = mean[SPEC_AXES[a]]
            }

            const est = estimate_post(gyro, i, amp, range, alias)
            if (est != null) {
                for (let a = 0; a < SPEC_AXES.length; a++) {
                    const trace = p.data[spec_trace_index(s, 2, a)]
                    trace.x = x
                    trace.y = est[SPEC_AXES[a]]
                }
            }
        }
    }
    render_plot("Spectrum1")
}

// Спектрограмма выбранного гироскопа, данных и оси (FR redraw_Spectrogram 1477–1577) и линии логированных notch
function redraw_spectrogram1() {
    const p = plot("Spectrogram1")
    const heat = p.data[0]
    // Видимость линий, выбранную в легенде, сохраняем между перерисовками (по подписи линии)
    const line_visible = Object.fromEntries(p.data.slice(1).map((trace) => [trace.meta, trace.visible]))
    p.data.length = 1
    heat.x = []
    heat.y = []
    heat.z = []

    const amp = spectrum_amplitude_scale(state.spectrum.amplitude)
    const freq = spectrum_frequency_scale(state.spectrum.frequency, state.spectrum.log_frequency)
    p.layout.yaxis.type = freq.type
    p.layout.yaxis.title.text = freq.label
    p.layout.xaxis.autorange = false
    p.layout.xaxis.range = [state.settings.start, state.settings.end]
    heat.hovertemplate = "<extra></extra>%{x:.2f} с<br>" + spec_freq_hover("y") + "<br>" + spec_amp_hover("z")
    heat.colorbar.title.text = amp.label

    if (step1_ready()) {
        const gyro = state.gyro
        const sensor = parseInt(radio_value("spec_sg_inst"))
        const data = radio_value("spec_sg_data")
        const axis = radio_value("spec_sg_axis")
        const instance = find_instance(gyro, sensor, data === "post")
        if (instance != null) {
            const alias = alias_obj(gyro[instance].FFT, { mode: state.spectrum.aliasing, loop_rate: values_from_log().SCHED_LOOP_RATE })
            const spec = spectrogram_matrix(gyro, instance, axis, data === "est", amp, alias)
            if (spec != null) {
                heat.x = spec.x
                heat.y = freq.fun(spec.bins)
                heat.z = spec.z
            }
        }

        // Линии логированных notch (FTN/FTNS), если они есть в логе. По умолчанию только в легенде — как флажок
        // SpecNotchShowLogged в FilterReview, выключенный по умолчанию
        const range = [state.settings.start, state.settings.end]
        const lines = tracking_lines(state.filters, state.logged, range)
        const line_hover = "<extra></extra>%{meta}<br>%{x:.2f} с<br>" + spec_freq_hover("y")
        for (let i = 0; i < lines.length; i++) {
            for (const line of lines[i].logged) {
                const name = (line.harmonic == 1) ? "основная" : "гармоника " + line.harmonic
                const meta = "Notch " + (i + 1) + " в логе: " + name
                p.data.push({
                    type: "scatter",
                    mode: "lines",
                    name: name,
                    meta: meta,
                    legendgroup: "notch" + i,
                    legendgrouptitle: { text: "Notch " + (i + 1) + " в логе" },
                    line: { width: 1, dash: "dashdot" },
                    visible: line_visible[meta] ?? "legendonly",
                    hovertemplate: line_hover,
                    x: line.time,
                    y: freq.fun(line.freq),
                })
            }
        }
        // Новым линиям — цвета темы тем же хуком, что и при смене темы
        spectrogram1_theme(plot_palette(), p.data, p.layout)
    }
    render_plot("Spectrogram1")
}

// Источник пика словами
function peak_source_text(peak) {
    return (peak.source === "motor") ? "моторы, гармоника " + peak.harmonic : "рама/резонанс"
}

// Способ атрибуции словами — столбец «Метод» таблицы пиков
const PEAK_METHOD_NAMES = { order: "порядковый спектр", median: "медиана ESC/газа" }

// Пики первичного гироскопа (до фильтров, без них — после) в дБ при любой выбранной шкале и без алиасинга —
// на настоящих частотах. Пики ищутся на каждой оси и сливаются по частоте (find_axis_peaks); происхождение —
// attribute_peaks_auto: по порядковому спектру ESC, а без ESC-телеметрии — по медиане ESC или цели газа,
// уточнённой по пику первой гармоники. Общая часть таблицы шага 1 и вариантов notch шага 2. Вызывать при step1_ready().
// Возвращает { sensor, instance, post_filter, peaks: [{ freq, amp_dB, excess_dB, axes, source, harmonic, method }]
// по убыванию превышения, method: "order" | "median", info } (info — как у attribute_peaks_auto); null, если у
// первичного гироскопа нет окон FFT
function step1_peaks() {
    const gyro = state.gyro
    const sensor = gyro.primary ?? gyro.first_gyro
    let instance = find_instance(gyro, sensor, false)
    if (instance == null) {
        instance = find_instance(gyro, sensor, true)
    }
    if (instance == null) {
        return null
    }

    const range = [state.settings.start, state.settings.end]
    const FFT = gyro[instance].FFT
    const mean = mean_spectrum(FFT, spectrum_amplitude_scale("dB"), range, alias_obj(FFT, { mode: "none" }))
    const found = find_axis_peaks(mean.bins, { X: mean.x, Y: mean.y, Z: mean.z })
    // Маска ESC и параметры цели газа — первого notch из лога
    const values = values_from_log()
    const attribution = attribute_peaks_auto(found, { gyro: gyro, tracking: state.tracking, range: range, esc_mask: values.INS_HNTCH_ESCMSK,
                                                      values: values, bins: mean.bins })
    return { sensor: sensor, instance: instance, post_filter: gyro[instance].post_filter, peaks: attribution.peaks, method: attribution.method,
             info: attribution.info }
}

// Пояснение способа атрибуции для подписи под таблицей пиков
function peak_method_text(analysis) {
    const info = analysis.info
    if (analysis.method === "order") {
        // Допуск окна — как в attribute_peaks_order: max(peak_half_width_hz, 2 бина, harmonic_tolerance · p50)
        const tolerance = Math.max(peak_rules.peak_half_width_hz, 2 * (info.bin_hz ?? 0), peak_rules.harmonic_tolerance * info.p50)
        return "Происхождение — по порядковому спектру ESC (метод автоподбора PR #363): пик — моторы, гармоника N, если у гармоники N " +
            "в порядковом спектре превышение не меньше " + peak_rules.min_excess_dB + " дБ и частота пика лежит в N × (p5…p95) ± max(" +
            peak_rules.peak_half_width_hz + " Гц, 2 бина, " + peak_rules.harmonic_tolerance + "·p50) частоты ESC (сейчас ±" + tolerance.toFixed(1) +
            " Гц); иначе рама/резонанс. Частота ESC за интервал: p5 " + info.p5.toFixed(1) + ", p50 " + info.p50.toFixed(1) + ", p95 " + info.p95.toFixed(1) + " Гц."
    }
    let motor_text
    if (info.median_hz == null) {
        motor_text = "Моторная частота не определена (нет ESC и цели газа) — все пики отнесены к раме."
    } else if (info.fundamental_hz !== info.median_hz) {
        motor_text = "Моторная частота: медиана ESC или цели газа за интервал " + info.median_hz.toFixed(1) +
                     " Гц, уточнена по пику первой гармоники до " + info.fundamental_hz.toFixed(1) + " Гц."
    } else {
        motor_text = "Моторная частота: медиана ESC или цели газа за интервал " + info.fundamental_hz.toFixed(1) + " Гц."
    }
    return "Происхождение — по медиане ESC или цели газа (порядкового спектра нет: нужны ESC-телеметрия и запись «до» фильтров). " + motor_text +
        " Гармоника N — если отношение частоты пика к моторной отличается от целого N не больше чем на " + peak_rules.harmonic_tolerance + "."
}

// Таблица, пояснение и вердикт шага
function redraw_peaks1() {
    const table = document.getElementById("peaks1")
    const note = document.getElementById("peaks1_note")
    const warnings_box = document.getElementById("warnings1")
    const warnings = step1_warnings()
    warnings_box.textContent = warnings.join(" · ")
    warnings_box.hidden = warnings.length == 0

    if (!step1_ready()) {
        table.hidden = true
        note.hidden = true
        if (step1.error != null) {
            spec_verdict("fail", step1.error)
        } else {
            document.getElementById("verdict1").hidden = true
        }
        return
    }

    const analysis = step1_peaks()
    if (analysis == null) {
        table.hidden = true
        note.hidden = true
        spec_verdict("fail", "Нет окон FFT в данных гироскопа: интервал или пакеты слишком короткие для окна")
        return
    }
    const peaks = analysis.peaks

    table.querySelector("tbody").innerHTML = peaks.slice(0, SPEC_MAX_PEAKS).map((peak) =>
        '<tr><td class="num">' + peak.freq.toFixed(1) + '</td><td class="num">' + peak.axes.join(", ") +
        '</td><td class="num">' + peak.amp_dB.toFixed(1) + '</td><td class="num">' + peak.excess_dB.toFixed(1) +
        '</td><td>' + html_escape(peak_source_text(peak)) + '</td><td>' + html_escape(PEAK_METHOD_NAMES[peak.method]) + '</td></tr>'
    ).join("")
    table.hidden = peaks.length == 0

    note.textContent = "Гироскоп " + (analysis.sensor + 1) + ", " + (analysis.post_filter ? "после фильтров (записи «до» нет)" : "до фильтров") +
        ", пики по осям X/Y/Z не меньше " + peak_rules.min_excess_dB + " дБ над медианой шума в ±" + peak_rules.floor_half_width_hz + " Гц" +
        ((peaks.length > SPEC_MAX_PEAKS) ? "; показаны " + SPEC_MAX_PEAKS + " из " + peaks.length : "") + ". " + peak_method_text(analysis)
    note.hidden = false

    // Шаг диагностический: ok с описанием шума; warn — только при предупреждениях загрузки, FFT или фильтров
    const status = (warnings.length > 0) ? "warn" : "ok"
    const gyro_filter = values_from_log().INS_GYRO_FILTER
    const above = (gyro_filter > 0) ? peaks.filter((peak) => peak.freq > gyro_filter).length : 0
    const tail = (above > 0) ? "Пиков выше INS_GYRO_FILTER (" + gyro_filter + " Гц): " + above + " — их задача notch на шаге 2."
                             : "Пиков выше INS_GYRO_FILTER (" + gyro_filter + " Гц) нет."
    if (peaks.length == 0) {
        spec_verdict(status, "Выраженных пиков шума нет. " + tail)
        return
    }
    const main = peaks[0]
    spec_verdict(status, "Главный шум: " + main.freq.toFixed(1) + " Гц (" + peak_source_text(main) + "; оси " + main.axes.join(", ") + "), " +
        main.excess_dB.toFixed(1) + " дБ над фоном. " + tail)
}

// ---------- Открыть в FilterReview ----------

// Тот же файл в FilterReview: как кнопка «Open In» (Libraries/OpenIn.js, hook_load) — страница того же источника
// после загрузки получает File сообщением и подставляет его в поле выбора лога
function open_in_filterreview() {
    if (state.file == null) {
        return
    }
    const file = state.file
    const w = window.open("../FilterReview/")
    if (w == null) {
        // Всплывающие окна запрещены
        spec_verdict("warn", "Браузер не открыл новую вкладку: разрешите всплывающие окна для этой страницы")
        return
    }
    w.addEventListener("load", () => w.postMessage({ type: "file", data: file }, location.origin))
}
