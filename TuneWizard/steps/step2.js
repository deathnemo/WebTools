// Шаг 2 «Гармонический notch»: варианты параметров notch со сравнением (core/candidates.js), форма параметров
// с метаданными FilterReview (Libraries/ParameterMetadata.js и ../FilterReview/params.json), спектр, бодэ
// и спектрограмма для значений формы, метрики против лога, файл .param (core/params.js) и «Принять».
// Состояние шага 1 не меняется: state.filters и FFT.H остаются от параметров лога (их рисует шаг 1), а
// передаточная функция значений формы считается отдельно (filter_transfer) и подставляется в копию-взгляд gyro.
// Общие помощники шагов (step_…, plot_…) — steps/common.js.

// Внутреннее состояние шага
const step2 = {
    form_built: false,    // разметка формы запрошена у load_param_inputs (один раз за жизнь страницы)
    form_ready: false,    // load_param_inputs дорисовал подписи, списки и маски (он асинхронный)
    observer: null,       // MutationObserver формы: доводит разметку ParameterMetadata до оформления шага
    filled: false,        // форма заполнена значениями текущего лога
    fit: null,            // auto_fit(...) → { result, errors }
    analysis: null,       // step1_peaks() на момент подбора: главные пики и их атрибуция
    ctx: null,            // контекст evaluate_candidate подбора
    candidates: null,     // [{ id, title, values }] — notch_candidates (+ второй notch)
    evaluations: null,    // id → evaluate_candidate
    ranking: null,        // rank_candidates(evaluations) → { best_id, flags }
    current_row: null,    // строка «Текущий (из формы)»: { id, title, values, evaluation, flags }
    key: null,            // для какого интервала и расчёта шага 1 посчитаны варианты (step2_calc_key)
    gyro_ref: null,       // и для какого объекта state.gyro
    selected_id: null,    // выбранный в таблице вариант
    current: null,        // посчитанные значения формы для графиков и метрик: { values, key, filters, H, … }
    view_gyro: null,      // для какого state.gyro выставлены видимость трасс и выбор гироскопов графиков
    error: null,          // ошибка расчёта шага 1: показывается в вердикте вместо результатов
}

// Типы трасс спектра шага 2: до фильтров, оценка «после» для значений формы, записанное «после»
const SPEC2_TYPES = ["pre", "est", "post"]
const SPEC2_TYPE_NAMES = { pre: "до фильтров", est: "оценка «после» (форма)", post: "после (записано)" }

// Параметры формы в порядке разметки: общие и два гармонических notch
function step2_param_names() {
    const names = ["INS_GYRO_FILTER", "SCHED_LOOP_RATE"]
    for (const notch of notch_param_names()) {
        names.push(...Object.values(notch))
    }
    return names
}

// ---------- Подписи ----------

// Короткие имена битов INS_*_OPTS (Libraries/ParameterMetadata — английские подписи из params.json)
const STEP2_OPTS_NAMES = ["2×", "multi", "loop", "all IMU", "3×", "min freq", "5×"]

// Маски словами: HMNCS — «гарм. 1, 3», OPTS — короткие имена битов
function step2_masks_text(values, names) {
    const harmonics = []
    for (let n = 0; n < 32; n++) {
        if ((values[names.harmonics] & (1 << n)) != 0) {
            harmonics.push(n + 1)
        }
    }
    const options = STEP2_OPTS_NAMES.filter((_, bit) => (values[names.options] & (1 << bit)) != 0)
    return "гарм. " + ((harmonics.length > 0) ? harmonics.join(", ") : "нет") + ((options.length > 0) ? " · " + options.join(", ") : "")
}

// Значения notch коротко: FREQ/BW/ATT/HMNCS/OPTS первого notch и, если включён, второго; рядом — маски словами
function step2_short_values(values) {
    const parts = []
    const names = notch_param_names()
    for (let i = 0; i < names.length; i++) {
        const n = names[i]
        if (!(values[n.enable] > 0)) {
            if (i == 0) {
                parts.push("notch 1 выкл.")
            }
            continue
        }
        const text = [n.freq, n.bandwidth, n.attenuation, n.harmonics, n.options].map((name) => param_to_string(values[name])).join("/") +
                     " (" + step2_masks_text(values, n) + ")"
        parts.push((i == 0) ? text : "+ notch 2: " + text)
    }
    return parts
}

// ---------- Графики ----------

// Индекс трассы спектра: тип t (0 до, 1 оценка, 2 после), ось a (0–2)
function spec2_trace_index(t, a) {
    return t * SPEC_AXES.length + a
}

// Цвета спектра: ось — цвет, тип — штрих; линии notch — заливка диапазона и пунктир средней частоты
function spectrum2_theme(palette, data, layout) {
    for (let t = 0; t < SPEC2_TYPES.length; t++) {
        for (let a = 0; a < SPEC_AXES.length; a++) {
            const trace = data[spec2_trace_index(t, a)]
            trace.line.color = palette.axis[SPEC_AXES[a]]
            trace.line.dash = palette.dash[SPEC2_TYPES[t]]
        }
    }
    for (const shape of layout.shapes ?? []) {
        const notch = Number(shape.name.slice(1, 2))
        if (shape.name.endsWith(":range")) {
            shape.fillcolor = (notch == 0) ? palette.series[0] : palette.series[1]
        } else {
            shape.line.color = palette.ink
        }
    }
}

// Цвета бодэ: амплитуда — акцент, фаза — второй цвет палитры; размах — заливкой того же цвета
function bode2_theme(palette, data, layout) {
    data[0].fillcolor = palette.series[0]
    data[2].line.color = palette.series[0]
    data[1].fillcolor = palette.series[1]
    data[3].line.color = palette.series[1]
}

// Цвета линий спектрограммы: notch значений формы — акцент, записанные в лог — цвет предупреждения
function spectrogram2_theme(palette, data, layout) {
    for (let i = 1; i < data.length; i++) {
        data[i].line.color = data[i].legendgroup.startsWith("form") ? palette.series[0] : palette.warn
    }
}

function setup_step2_plots() {
    const data = []
    for (let t = 0; t < SPEC2_TYPES.length; t++) {
        for (let a = 0; a < SPEC_AXES.length; a++) {
            const name = SPEC2_TYPE_NAMES[SPEC2_TYPES[t]] + " · " + SPEC_AXES[a].toUpperCase()
            data[spec2_trace_index(t, a)] = {
                mode: "lines",
                name: SPEC_AXES[a].toUpperCase(),
                meta: name,
                legendgroup: SPEC2_TYPES[t],
                legendgrouptitle: { text: SPEC2_TYPE_NAMES[SPEC2_TYPES[t]] },
                line: { width: 1.2 },
                visible: false,
                x: [],
                y: [],
            }
        }
    }
    const layout = {
        xaxis: plot_axis("Частота, Гц"),
        yaxis: plot_axis("Амплитуда, дБ"),
        showlegend: true,
        legend: { groupclick: "toggleitem" },
        shapes: [],
        margin: { b: 50, l: 60, r: 20, t: 20 },
    }
    register_plot("Spectrum2", data, layout, { on_theme: spectrum2_theme })

    // Бодэ как в FilterReview (setup_plots, Bode.data[0..3]): размах амплитуды и фазы заливкой, средние линиями;
    // два подграфика друг под другом — амплитуда сверху, фаза снизу
    const bode_data = [
        { type: "scatter", fill: "toself", line: { color: "transparent" }, opacity: 0.25, showlegend: false, hoverinfo: "none", x: [], y: [] },
        { type: "scatter", fill: "toself", line: { color: "transparent" }, opacity: 0.25, showlegend: false, hoverinfo: "none", xaxis: "x2", yaxis: "y2", x: [], y: [] },
        { mode: "lines", line: { width: 1.5 }, showlegend: false, x: [], y: [] },
        { mode: "lines", line: { width: 1.5 }, showlegend: false, xaxis: "x2", yaxis: "y2", x: [], y: [] },
    ]
    const bode_layout = {
        xaxis: plot_axis(null),
        xaxis2: plot_axis("Частота, Гц"),
        yaxis: { ...plot_axis("Амплитуда, дБ"), domain: [0.52, 1] },
        yaxis2: { ...plot_axis("Фаза, °"), domain: [0, 0.48] },
        showlegend: false,
        grid: { rows: 2, columns: 1, pattern: "independent" },
        margin: { b: 50, l: 60, r: 20, t: 20 },
    }
    register_plot("Bode2", bode_data, bode_layout, { on_theme: bode2_theme })

    // Спектрограмма как на шаге 1: тепловая карта (Viridis — исключение из правила «цвета только из токенов»)
    // и линии notch
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
        xaxis: plot_axis("Время, с"),
        yaxis: plot_axis("Частота, Гц"),
        showlegend: true,
        legend: { groupclick: "toggleitem" },
        margin: { b: 50, l: 60, r: 20, t: 20 },
    }
    register_plot("Spectrogram2", sg_data, sg_layout, { on_theme: spectrogram2_theme })
}

// Пустые графики шага. Линии notch спектра скрываются, redraw_spectrum2 строит их заново; трассы бодэ не
// скрываются — redraw_bode2 видимость не возвращает
function clear_step2_plots() {
    plot_clear("Spectrum2")
    plot_clear("Bode2", false)
    const spectrogram = plot("Spectrogram2")
    if (spectrogram != null) {
        spectrogram.data.length = 1
        spectrogram.data[0].x = []
        spectrogram.data[0].y = []
        spectrogram.data[0].z = []
        render_plot("Spectrogram2")
    }
}

// ---------- Инициализация и сброс ----------

function step2_init() {
    setup_step2_plots()

    // Пороги во вступлении — из candidate_rules, чтобы текст не расходился с ядром
    const rules = candidate_rules
    const rule_texts = {
        band: rules.band_hz[0] + "–" + rules.band_hz[1] + " Гц",
        peak: rules.max_peak_worsening_dB + " дБ",
        lag_hz: rules.lag_freqs_hz[rules.lag_freqs_hz.length - 1] + " Гц",
        lag: rules.max_lag_increase_ms + " мс",
    }
    for (const span of document.querySelectorAll("[data-rule]")) {
        span.textContent = rule_texts[span.dataset.rule]
    }

    document.getElementById("cand2_apply").addEventListener("click", step2_apply)
    document.getElementById("cand2_refit").addEventListener("click", step2_refit)
    document.getElementById("notch_recalc").addEventListener("click", step2_recalc)
    document.getElementById("notch_save").addEventListener("click", step2_save_param)
    document.getElementById("notch_load_file").addEventListener("change", (e) => step2_load_param(e.target))
    document.getElementById("notch_accept").addEventListener("click", step2_accept)
    // Выбор варианта в таблице (строки перерисовываются — слушаем таблицу)
    document.getElementById("candidates2").addEventListener("change", (e) => {
        if (e.target.name === "cand2") {
            step2.selected_id = e.target.value
            if (step1_ready() && (step2.error == null)) {
                step2_render_verdict()
            }
        }
    })
    // Поля формы: ParameterMetadata заменяет часть полей списками и добавляет флажки масок — слушаем контейнер
    document.getElementById("notch_form").addEventListener("change", step2_form_changed)

    // Переключатели графиков перерисовывают только посчитанное: без расчёта шага 1 или значений формы — ничего
    const plot_handler = (redraw) => () => {
        if (!step1_ready() || (step2.error != null) || (step2.current == null)) {
            return
        }
        step_run(redraw, "verdict2", "шага 2")
    }
    for (const id of ["bode2_inst0", "bode2_inst1", "bode2_inst2", "bode2_wrap"]) {
        document.getElementById(id).addEventListener("change", plot_handler(redraw_bode2))
    }
    for (const id of ["sg2_inst0", "sg2_inst1", "sg2_inst2", "sg2_pre", "sg2_post", "sg2_est", "sg2_x", "sg2_y", "sg2_z"]) {
        document.getElementById(id).addEventListener("change", plot_handler(redraw_spectrogram2))
    }
}

// Новый лог или ошибка загрузки: забыть варианты и расчёт, очистить итоги и графики. Значения формы
// заполнятся из нового лога при следующем показе шага
function step2_reset() {
    Object.assign(step2, {
        filled: false, fit: null, analysis: null, ctx: null, candidates: null, evaluations: null, ranking: null, current_row: null,
        key: null, gyro_ref: null, selected_id: null, current: null, view_gyro: null, error: null,
    })
    for (const id of ["verdict2", "warnings2", "candidates2", "candidates2_note", "candidates2_stale", "harmonics2", "harmonics2_note",
                      "metrics2", "notch_file_note"]) {
        document.getElementById(id).hidden = true
    }
    for (const id of ["cand2_apply", "cand2_refit", "notch_recalc", "notch_save", "notch_load_file", "notch_accept"]) {
        document.getElementById(id).disabled = true
    }
    document.getElementById("cand2_refit").classList.remove("primary")
    document.getElementById("notch_recalc").classList.remove("primary")
    for (const span of document.querySelectorAll("#notch_form .inlog")) {
        span.textContent = ""
    }
    for (const p of document.querySelectorAll("#notch_form p.changed")) {
        p.classList.remove("changed")
    }
    for (const id of ["bode2_inst0", "bode2_inst1", "bode2_inst2", "sg2_inst0", "sg2_inst1", "sg2_inst2", "sg2_pre", "sg2_post", "sg2_est"]) {
        const radio = document.getElementById(id)
        radio.checked = false
        radio.disabled = true
    }
    clear_step2_plots()
}

// ---------- Форма параметров ----------

// Разметка формы один раз: подписи, описания, списки значений и флажки масок — load_param_inputs по метаданным
// FilterReview. Он асинхронный и промис загрузки не возвращает, поэтому окончание разметки ловит MutationObserver
function step2_build_form() {
    if (step2.form_built) {
        return
    }
    step2.form_built = true
    const form = document.getElementById("notch_form")
    step2.observer = new MutationObserver(() => step2_form_tidy())
    step2.observer.observe(form, { childList: true, subtree: true })
    load_param_inputs("../FilterReview/params.json", step2_param_names())
}

// Довести разметку ParameterMetadata до оформления шага (повторный вызов ничего не меняет): подпись «в логе» —
// за полем и единицами, а не перед ними (единицы и список значений ParameterMetadata добавляет в конец абзаца).
// Флажки масок остаются прямыми детьми абзаца: обработчик флажка в ParameterMetadata ищет поле маски через
// parentElement. Когда у всех полей есть подписи, разметка готова: размер масок и выключение полей
// применяются заново (set_bitmask_size работает только после разметки)
function step2_form_tidy() {
    let ready = true
    for (const p of document.querySelectorAll("#notch_form p.param")) {
        const name = p.dataset.name
        const field = document.getElementById(name)
        const inlog = p.querySelector(".inlog")
        if ((field == null) || (inlog == null)) {
            continue
        }
        if (p.querySelector('label[for="' + name + '"]') == null) {
            ready = false
        }
        // Единицы — текстовый узел после поля
        let anchor = field
        for (const node of p.childNodes) {
            if ((node.nodeType === Node.TEXT_NODE) && (node.textContent.trim() !== "")) {
                anchor = node
            }
        }
        if (inlog.previousSibling !== anchor) {
            anchor.after(inlog)
        }
    }
    if (ready && !step2.form_ready) {
        step2.form_ready = true
        step2.observer.disconnect()
        if (step2.filled) {
            step2_param_read()
        }
    }
}

// Размер маски HMNCS в битах (hmncs_bits, core/params.js) для текущего лога и версии фильтра
function step2_harmonics_bits() {
    return hmncs_bits(state.params, state.env?.filter_version ?? 1)
}

// Значение как float32 — так прошивка хранит параметры: 0.7 из файла .param и 0.699999988 из лога — одно значение.
// Битовые маски — целые до 2^32, во float32 они потеряли бы младшие биты: их не округляем
function step2_fround_value(name, value) {
    return is_bitmask_param(name) ? value : Math.fround(value)
}

function step2_fround(values) {
    const out = {}
    for (const [name, value] of Object.entries(values)) {
        out[name] = step2_fround_value(name, value)
    }
    return out
}

// Ключ набора значений для сравнения наборов между собой (по float32)
function step2_key(values) {
    return candidate_key(step2_fround(values))
}

// Записать значения в поля формы: числа — кратчайшей записью того же float32 (param_to_string), так что
// 0.699999988 из лога показывается как 0.7
function step2_set_form_values(values) {
    for (const name of step2_param_names()) {
        if (name in values) {
            parameter_set_value(name, Number.isFinite(values[name]) ? param_to_string(values[name]) : values[name])
        }
    }
}

// Заполнить форму значениями (объект имя → число) и подписи «в логе»; у параметров, которых в логе нет, —
// значение по умолчанию FilterReview, взятое вместо него
function step2_fill_form(values) {
    step2_set_form_values(values)
    const log_values = values_from_log()
    for (const span of document.querySelectorAll("#notch_form .inlog")) {
        const value = state.params.get(span.dataset.for)
        span.textContent = (value == null) ? "в логе нет (взято " + param_to_string(log_values[span.dataset.for]) + ")" : "в логе: " + param_to_string(value)
    }
    step2_param_read()
}

// Аналог filter_param_read и update_hidden_params FilterReview: поля notch с ENABLE = 0 выключены, ESCMSK
// виден только с версии фильтра 4 (иначе 0), размер маски HMNCS — 32 бита, если в логе есть INS_RAW_LOG_OPT
// или версия фильтра не ниже 3, иначе 8. Затем пометки изменённых полей и подсветка «Пересчитать фильтры»
function step2_param_read() {
    const filter_version = state.env?.filter_version ?? 1
    for (const names of notch_param_names()) {
        const enabled = parameter_get_value(names.enable) > 0
        for (const [key, name] of Object.entries(names)) {
            if (key !== "enable") {
                parameter_set_disable(name, !enabled)
            }
        }
        const esc_mask = document.getElementById(names.esc_mask)
        esc_mask.closest("p").hidden = filter_version < 4
        if (filter_version < 4) {
            parameter_set_value(names.esc_mask, 0)
        }
        // До разметки у поля нет data-type, и set_bitmask_size упал бы на вызове несуществующей error()
        if ("type" in document.getElementById(names.harmonics).dataset) {
            set_bitmask_size(names.harmonics, step2_harmonics_bits())
        }
    }
    step2_mark_changed()
}

// Значения формы: объект имя → число float32, маски — целые (через parameter_get_value). Пустое или нечисловое поле —
// значение из лога: проверяется сам текст поля, потому что parameter_get_value у 8-битной маски даёт из NaN
// число 0 (NaN & 0xFF). ESCMSK при версии фильтра ниже 4 — 0, как в values_from_log
function values_from_form() {
    const log_values = values_from_log()
    const values = {}
    for (const name of step2_param_names()) {
        const field = document.getElementById(name)
        const typed = (field != null) && Number.isFinite(parseFloat(field.value))
        values[name] = step2_fround_value(name, typed ? parameter_get_value(name) : log_values[name])
    }
    if ((state.env?.filter_version ?? 1) < 4) {
        for (const names of notch_param_names()) {
            values[names.esc_mask] = 0
        }
    }
    return values
}

// Пометка .changed у полей, чьё значение отличается от лога; подсветка «Пересчитать фильтры», если форма
// разошлась с посчитанными значениями
function step2_mark_changed() {
    if (state.params == null) {
        return
    }
    const log_values = values_from_log()
    const values = values_from_form()
    for (const p of document.querySelectorAll("#notch_form p.param")) {
        const name = p.dataset.name
        p.classList.toggle("changed", values[name] !== step2_fround_value(name, log_values[name]))
    }
    const stale = (step2.current != null) && (step2_key(values) !== step2.current.key)
    document.getElementById("notch_recalc").classList.toggle("primary", stale)
}

// Правка поля (или флажка маски)
function step2_form_changed() {
    if (!step2.filled) {
        return
    }
    step2_param_read()
}

// ---------- Расчёт ----------

// Ключ расчёта, для которого посчитаны варианты: интервал, FFT и версия фильтра шага 1
function step2_calc_key() {
    return JSON.stringify([state.settings.start, state.settings.end, step1.fft_key, state.spectrum.filter_version])
}

// Варианты посчитаны для другого интервала или расчёта шага 1
function step2_stale() {
    return (step2.candidates != null) && ((step2.key !== step2_calc_key()) || (step2.gyro_ref !== state.gyro))
}

// Контекст evaluate_candidate для текущего интервала: главные пики шага 1 (первые candidate_rules.main_peaks)
// и экземпляр до фильтров первичного гироскопа (step_gyro_sensor). null — нет данных «до» или пиков
function step2_make_ctx(analysis) {
    const sensor = step_gyro_sensor()
    if ((sensor == null) || (analysis == null)) {
        return null
    }
    return {
        gyro: state.gyro,
        env: state.env,
        tracking: state.tracking,
        range: [state.settings.start, state.settings.end],
        sensor: sensor,
        peaks: analysis.peaks.slice(0, candidate_rules.main_peaks),
        loop_rate: values_from_log().SCHED_LOOP_RATE,
    }
}

// Подбор и сравнение вариантов (при первом показе и «Подобрать заново»): автоподбор PR #363, варианты
// notch_candidates, оценка каждого, выбор лучшего и, если после него остаётся немоторный пик, второй notch
function step2_fit() {
    const gyro = state.gyro
    const range = [state.settings.start, state.settings.end]
    const log_values = values_from_log()
    step2.key = step2_calc_key()
    step2.gyro_ref = gyro
    step2.current_row = null
    step2.analysis = step1_peaks()
    step2.fit = auto_fit(gyro, state.tracking, range, log_values.INS_HNTCH_ESCMSK)
    step2.candidates = notch_candidates(log_values, step2.fit)
    step2.ctx = step2_make_ctx(step2.analysis)
    step2.evaluations = null
    step2.ranking = null
    if (step2.ctx == null) {
        return
    }

    const evaluations = {}
    for (const candidate of step2.candidates) {
        evaluations[candidate.id] = evaluate_candidate(candidate.values, step2.ctx)
    }
    let ranking = rank_candidates(evaluations)
    const best = step2.candidates.find((c) => c.id === ranking.best_id)
    const second = ((best != null) && (evaluations[best.id] != null)) ? second_notch_candidate(best, evaluations[best.id], step2.analysis.peaks) : null
    if (second != null) {
        step2.candidates.push(second)
        evaluations[second.id] = evaluate_candidate(second.values, step2.ctx)
        ranking = rank_candidates(evaluations)
    }
    step2.evaluations = evaluations
    step2.ranking = ranking
    // Новый подбор — выбран рекомендованный
    step2.selected_id = ranking.best_id ?? "log"
}

// Строки таблицы: варианты и «Текущий (из формы)»
function step2_rows() {
    const rows = (step2.candidates ?? []).map((c) => ({ ...c, evaluation: step2.evaluations?.[c.id] ?? null, flags: step2.ranking?.flags[c.id] ?? null }))
    if (step2.current_row != null) {
        rows.push(step2.current_row)
    }
    return rows
}

// Вариант с теми же значениями, что values: id и название; null — таких нет (правка вручную)
function step2_match(values) {
    const key = step2_key(values)
    return (step2.candidates ?? []).find((c) => step2_key(c.values) === key) ?? null
}

// Посчитанные значения формы: графики и метрики рисуются по ним, пока не нажаты «Применить вариант»
// или «Пересчитать фильтры»
function step2_set_current(values) {
    step2.current = { values: values, key: step2_key(values), filters: null, tracking: null, filter_version: null, H: {} }
}

// Фильтры посчитанных значений: пересоздаются, если сменились источники трекинга или версия фильтра
function step2_current() {
    const current = step2.current
    if (current == null) {
        return null
    }
    if ((current.filters == null) || (current.tracking !== state.tracking) || (current.filter_version !== state.env.filter_version)) {
        current.filters = load_filters(current.values, state.env, state.tracking)
        current.tracking = state.tracking
        current.filter_version = state.env.filter_version
        current.H = {}
    }
    return current
}

// Передаточные функции посчитанных значений у экземпляра index: { H } на сетке FFT и { bode_H } на сетке бодэ.
// Считаются по требованию и живут, пока не сменился объект FFT экземпляра (пересчёт FFT на шаге 1)
function step2_transfer(index) {
    const current = step2_current()
    const FFT = state.gyro[index].FFT
    let entry = current.H[index]
    if ((entry == null) || (entry.FFT !== FFT)) {
        entry = { FFT: FFT, H: null, bode_H: null }
        current.H[index] = entry
    }
    return { entry: entry, filters: current.filters, FFT: FFT }
}

function step2_H(index) {
    const { entry, filters, FFT } = step2_transfer(index)
    if ((entry.H == null) && (FFT.Z1 != null)) {
        entry.H = filter_transfer(filters, index, FFT.time, FFT.average_sample_rate, FFT.Z1, FFT.Z2)
    }
    return entry.H
}

function step2_bode_H(index) {
    const { entry, filters, FFT } = step2_transfer(index)
    if ((entry.bode_H == null) && (FFT.bode != null)) {
        entry.bode_H = filter_transfer(filters, index, FFT.time, FFT.average_sample_rate, FFT.bode.Z1, FFT.bode.Z2)
    }
    return entry.bode_H
}

// Копия-взгляд gyro, у экземпляра index которого FFT.H и FFT.bode.H — от посчитанных значений формы:
// bode_mean и spectrogram_matrix читают их из gyro, а FFT шага 1 (H от параметров лога) менять нельзя
function step2_gyro_view(index, H, bode_H) {
    const gyro = state.gyro
    const view = gyro.slice()
    view.quantization_noise = gyro.quantization_noise
    const FFT = gyro[index].FFT
    const bode = (FFT.bode != null) ? { freq: FFT.bode.freq, Z1: FFT.bode.Z1, Z2: FFT.bode.Z2, H: bode_H } : null
    view[index] = { sensor_num: gyro[index].sensor_num, post_filter: gyro[index].post_filter, FFT: { ...FFT, H: H, bode: bode } }
    return view
}

// Метрики посчитанных значений формы против лога для текущего интервала: { current, log } — evaluate_candidate.
// Пока варианты не устарели, оценка лога (и совпадающего варианта) берётся из таблицы. null без данных «до»
function step2_metrics(values) {
    if (step2_stale() || (step2.ctx == null) || (step2.evaluations == null)) {
        const ctx = step2_make_ctx(step1_peaks())
        if (ctx == null) {
            return null
        }
        return { current: evaluate_candidate(values, ctx), log: evaluate_candidate(values_from_log(), ctx) }
    }
    const key = step2_key(values)
    const row = step2_rows().find((r) => (r.evaluation != null) && (step2_key(r.values) === key))
    return { current: row ? row.evaluation : evaluate_candidate(values, step2.ctx), log: step2.evaluations.log }
}

// ---------- Действия ----------
// Действия идут под оверлеем загрузки (step_run): неожиданная ошибка — в консоль и вердикт «Ошибка шага 2: …».
// Расчёт шага 1 досчитывается step_ensure_step1, его ошибка — в step2.error

// Показ шага: форма из лога (один раз на лог), варианты при первом показе; смена интервала или расчёта шага 1
// только помечает варианты устаревшими — пересчёт кнопкой «Подобрать заново»
function step2_show() {
    if (state.log == null) {
        return
    }
    step2_build_form()
    step_run(() => {
        if (!step2.filled) {
            step2_fill_form(values_from_log())
            step2.filled = true
        } else {
            step2_param_read()
        }
        step2.error = step_ensure_step1()
        if ((step2.error == null) && (step2.candidates == null)) {
            step2_fit()
        }
        step2_redraw_all()
    }, "verdict2", "шага 2")
}

// «Подобрать заново»: автоподбор и сравнение для текущего интервала
function step2_refit() {
    step_run(() => {
        step2.error = step_ensure_step1()
        if (step2.error == null) {
            step2_fit()
        }
        step2_redraw_all()
    }, "verdict2", "шага 2")
}

// «Применить вариант»: все значения выбранного варианта в форму (и выключенных полей), пересчёт графиков и метрик
function step2_apply() {
    const id = radio_value("cand2")
    const row = step2_rows().find((r) => r.id === id)
    if (row == null) {
        return
    }
    step2_set_form_values(row.values)
    step2_param_read()
    step_run(() => {
        step2.error = step_ensure_step1()
        if (step2.error == null) {
            step2_set_current(values_from_form())
        }
        step2_redraw_all()
    }, "verdict2", "шага 2")
}

// «Пересчитать фильтры» после правки формы: строка «Текущий (из формы)» в таблице вариантов (заменяет прежнюю),
// графики и метрики по значениям формы. Устаревшие варианты сначала подбираются заново, чтобы строки сравнивались
// на одном интервале
function step2_recalc() {
    step_run(() => {
        step2.error = step_ensure_step1()
        if (step2.error != null) {
            step2_redraw_all()
            return
        }
        if ((step2.candidates == null) || step2_stale()) {
            step2_fit()
        }
        const values = values_from_form()
        step2_set_current(values)
        const match = step2_match(values)
        step2.current_row = null
        if ((step2.ctx != null) && (step2.evaluations?.log != null)) {
            const evaluation = evaluate_candidate(values, step2.ctx)
            const flags = rank_candidates({ log: step2.evaluations.log, current: evaluation }).flags.current
            const title = "Текущий (из формы)" + ((match != null) ? " = " + match.title : "")
            step2.current_row = { id: "current", title: title, values: values, evaluation: evaluation, flags: flags }
        }
        step2_param_read()
        step2_redraw_all()
    }, "verdict2", "шага 2")
}

// Подсказка про второй notch: в логе он выключен, а в значениях включён — на аппарате остальные INS_HNTC2_*
// появляются только после записи INS_HNTC2_ENABLE = 1 и обновления списка параметров; null — подсказка не нужна.
// Проверка и текст — из ядра (summary_notch_enabling, summary_notch_enable_hint): тот же пункт есть в «что
// перелететь» сводки
function step2_second_notch_hint(values) {
    const enable = notch_param_names()[1].enable
    const log = state.params.get(enable)
    if (!summary_notch_enabling(log, values[enable])) {
        return null
    }
    return summary_notch_enable_hint(enable, log)
}

// «Сохранить .param»: параметры INS_* формы (как save_parameters FilterReview); ESCMSK — только с версии
// фильтра 4: у прошивок ниже его нет, а 0 вместо настоящей маски сменил бы набор моторов. 8-битная маска HMNCS
// (прошивки без INS_RAW_LOG_OPT и с версией фильтра ниже 3) со старшим битом пишется со знаком (−128…127):
// так её хранит прошивка и так пишет FilterReview
function step2_save_param() {
    const values = values_from_form()
    const names = notch_param_names()
    const esc_masks = names.map((n) => n.esc_mask)
    const harmonics = names.map((n) => n.harmonics)
    const bits = step2_harmonics_bits()
    const out = {}
    for (const name of step2_param_names()) {
        if (!name.startsWith("INS_")) {
            continue
        }
        if (esc_masks.includes(name) && ((state.env?.filter_version ?? 1) < 4)) {
            continue
        }
        out[name] = harmonics.includes(name) ? mask_signed(values[name], bits) : values[name]
    }
    saveAs(new Blob([param_file_text(out)], { type: "text/plain;charset=utf-8" }), "notch.param")
    const hint = step2_second_notch_hint(values)
    const note = document.getElementById("notch_file_note")
    note.textContent = "Файл notch.param сохранён: параметров " + Object.keys(out).length + "." + ((hint != null) ? " " + hint : "")
    note.hidden = false
}

// «Загрузить .param»: значения параметров формы из файла (остальные строки файла не трогаем) и пересчёт
async function step2_load_param(input) {
    const file = input.files[0]
    if (file == null) {
        return
    }
    input.value = ""
    const note = document.getElementById("notch_file_note")
    let parsed
    try {
        parsed = parse_param_file(await file.text())
    } catch (e) {
        note.textContent = "Не удалось прочитать «" + file.name + "»: " + e.message
        note.hidden = false
        return
    }
    const names = step2_param_names().filter((name) => name in parsed)
    step2_set_form_values(Object.fromEntries(names.map((name) => [name, parsed[name]])))
    note.textContent = (names.length > 0) ? "Из файла «" + file.name + "» взято параметров формы: " + names.length + " из " + step2_param_names().length + "."
                                          : "В файле «" + file.name + "» нет параметров формы — значения не изменились."
    note.hidden = false
    if (names.length > 0) {
        step2_param_read()
        step2_recalc()
    }
}

// «Принять»: значения формы, их метрики и отметки сравнения с логом (rank_candidates для пары «лог — принятое») и
// отпечаток входов (step_inputs_key — для «устарело» сводки) — в итог мастера, открыть шаг 3
function step2_accept() {
    step_run(() => {
        if (!step1_ready() || (step2.error != null)) {
            return
        }
        const values = values_from_form()
        const match = step2_match(values)
        let metrics = step2_metrics(values)
        if ((metrics != null) && ((metrics.current == null) || (metrics.log == null))) {
            metrics = null
        }
        const flags = (metrics != null) ? rank_candidates({ log: metrics.log, current: metrics.current }).flags.current : null
        state.steps[2] = {
            accepted: values,
            candidate_id: (match != null) ? match.id : "current",
            metrics: (metrics != null) ? step2_metrics_summary(metrics) : null,
            flags: flags,
            inputs: step_inputs_key(2),
            evaluated_at: Date.now(),
        }
        step2_render_verdict()
        set_step(3)
    }, "verdict2", "шага 2")
}

// Отметки rank_candidates словами: пики хуже лога (с разницей), неоценённые пики, задержка сверх допуска;
// пустая строка — отметок нет. evaluation и log — оценки варианта и лога (для разниц)
function step2_flags_text(flags, evaluation, log) {
    if (flags == null) {
        return ""
    }
    const rules = candidate_rules
    const lag_hz = rules.lag_freqs_hz[rules.lag_freqs_hz.length - 1]
    if (flags.incomplete) {
        return "оценка неполная — сравнить с логом нельзя"
    }
    const worse = []
    const unrated = []
    for (const freq of [...new Set(flags.worse_peaks)]) {
        const peak = evaluation?.peaks.find((p) => p.freq === freq)
        const log_peak = (peak != null) ? step2_peak(log, peak) : null
        const delta = (log_peak != null) ? peak.post_dB - log_peak.post_dB : NaN
        if (Number.isFinite(delta)) {
            worse.push(freq.toFixed(1) + " Гц " + step_signed(delta, 1) + " дБ")
        } else {
            unrated.push(freq.toFixed(1) + " Гц")
        }
    }
    const parts = []
    if (worse.length > 0) {
        parts.push("хуже лога больше чем на " + rules.max_peak_worsening_dB + " дБ: " + worse.join(", "))
    }
    if (unrated.length > 0) {
        parts.push("не оценён: " + unrated.join(", "))
    }
    if (flags.lag_over) {
        const delta = (evaluation != null) ? evaluation.lag_ms[lag_hz] - log.lag_ms[lag_hz] : NaN
        parts.push("задержка на " + lag_hz + " Гц " + (Number.isFinite(delta) ? step_signed(delta, 2) + " мс" : "не оценена") +
                   " (допустимо +" + rules.max_lag_increase_ms + ")")
    }
    return parts.join("; ")
}

// Сводка метрик для итога: пики (до, после, после у лога), полосы и задержки значений формы и лога
function step2_metrics_summary(metrics) {
    const pick = (e) => ({ band_dB: e.band_dB, band_f2_dB: e.band_f2_dB ?? null, lag_ms: { ...e.lag_ms }, warnings: [...e.warnings] })
    return {
        peaks: metrics.current.peaks.map((peak) => ({ freq: peak.freq, axes: peak.axes, source: peak.source ?? null, pre_dB: peak.pre_dB,
                                                         post_dB: peak.post_dB, log_post_dB: step2_peak(metrics.log, peak)?.post_dB ?? null })),
        current: pick(metrics.current),
        log: pick(metrics.log),
    }
}

// ---------- Отрисовка ----------

// Выбор гироскопов бодэ и спектрограммы и видимость трасс спектра — по умолчанию для нового гироскопа
function step2_default_selection() {
    const gyro = state.gyro
    if (step2.view_gyro === gyro) {
        return
    }
    step2.view_gyro = gyro
    const sensor = gyro.primary ?? gyro.first_gyro
    for (let s = 0; s < 3; s++) {
        const bode = document.getElementById("bode2_inst" + s)
        bode.disabled = step2_bode_instance(s) == null
        bode.checked = false
        const sg = document.getElementById("sg2_inst" + s)
        sg.disabled = !gyro.some((g) => (g != null) && (g.sensor_num == s))
        sg.checked = false
    }
    const bode_sensor = (step2_bode_instance(sensor) != null) ? sensor : [0, 1, 2].find((s) => step2_bode_instance(s) != null)
    if (bode_sensor != null) {
        document.getElementById("bode2_inst" + bode_sensor).checked = true
    }
    if (sensor != null) {
        document.getElementById("sg2_inst" + sensor).checked = true
    }
    document.getElementById("sg2_pre").disabled = !gyro.have_pre
    document.getElementById("sg2_post").disabled = !gyro.have_post
    document.getElementById("sg2_est").disabled = !gyro.have_pre
    document.getElementById(gyro.have_pre ? "sg2_est" : "sg2_post").checked = true

    // Спектр: до и оценка видны, записанное «после» — в легенде (оно от параметров лога, а не формы)
    const data = plot("Spectrum2").data
    for (let a = 0; a < SPEC_AXES.length; a++) {
        data[spec2_trace_index(0, a)].visible = true
        data[spec2_trace_index(1, a)].visible = true
        data[spec2_trace_index(2, a)].visible = "legendonly"
    }
}

// Экземпляр gyro для бодэ сенсора s — как в FilterReview (redraw_post_estimate_and_bode): последний с FFT
// и сеткой бодэ; null — такого нет
function step2_bode_instance(s) {
    const gyro = state.gyro
    let index = null
    for (let i = 0; i < gyro.length; i++) {
        if ((gyro[i] == null) || (gyro[i].FFT == null) || (gyro[i].FFT.x.length == 0) || (gyro[i].FFT.bode == null)) {
            continue
        }
        if (gyro[i].sensor_num == s) {
            index = i
        }
    }
    return index
}

function step2_redraw_all() {
    const ready = step1_ready() && (step2.error == null)
    for (const id of ["notch_save", "notch_load_file"]) {
        document.getElementById(id).disabled = !step2.filled
    }
    for (const id of ["notch_recalc", "notch_accept", "cand2_refit"]) {
        document.getElementById(id).disabled = !ready
    }
    if (!ready) {
        for (const id of ["candidates2", "candidates2_note", "candidates2_stale", "harmonics2", "harmonics2_note", "metrics2", "warnings2"]) {
            document.getElementById(id).hidden = true
        }
        document.getElementById("cand2_apply").disabled = true
        step_verdict("verdict2", "fail", step2.error ?? "Расчёт спектра шага 1 не готов")
        clear_step2_plots()
        return
    }
    if (step2.current == null) {
        step2_set_current(values_from_form())
    }
    step2_default_selection()
    step2_render_candidates()
    step2_render_harmonics()
    step2_render_metrics()
    step2_render_verdict()
    step2_mark_changed()
    redraw_spectrum2()
    redraw_bode2()
    redraw_spectrogram2()
}

// Ячейка уровня с разницей к логу: delta > worse — хуже (красный), delta < -better — лучше (зелёный)
function step2_delta_cell(value, delta, digits, worse, better) {
    if (value == null) {
        return '<td class="num">—</td>'
    }
    let cls = "num"
    if ((delta != null) && (delta > worse)) {
        cls += " worse"
    } else if ((delta != null) && (delta < -better)) {
        cls += " better"
    }
    return '<td class="' + cls + '">' + value.toFixed(digits) + ((delta != null) ? '<small>' + step_signed(delta, digits) + '</small>' : "") + '</td>'
}

// Пик варианта, соответствующий столбцу (частота и признак пика оценки «после»)
function step2_peak(evaluation, column) {
    return evaluation.peaks.find((p) => (p.freq === column.freq) && ((p.source === "post") === (column.source === "post"))) ?? null
}

// Пояснение под названием строки: у второго notch — измеренная ширина пика и BW из неё
function step2_row_note(row) {
    const width = row.peak?.width
    if ((width == null) || !Number.isFinite(width.width_hz)) {
        return ""
    }
    const bandwidth = row.values[notch_param_names()[1].bandwidth]
    const hint = step2_second_notch_hint(row.values)
    return '<small>' + html_escape("пик " + row.peak.freq.toFixed(1) + " Гц выше шума на " + row.peak.excess_dB.toFixed(1) + " дБ (ось " + row.peak.axis +
        "), ширина пика " + width.width_hz.toFixed(1) + " Гц → BW " + param_to_string(bandwidth) + " Гц") + '</small>' +
        ((hint != null) ? '<small>' + html_escape(hint) + '</small>' : "")
}

// Почему вариант не рекомендован: отметки ранжирования, иначе — полоса не лучше рекомендованного.
// Строка «Текущий» в рекомендации не участвует — у неё только отметки против лога
function step2_reason(row, log) {
    const flags_text = step2_flags_text(row.flags, row.evaluation, log)
    if (row.id === "current") {
        return "ручные значения в рекомендации не участвуют" + ((flags_text !== "") ? "; " + flags_text : "")
    }
    if (flags_text !== "") {
        return flags_text
    }
    const best = step2.evaluations[step2.ranking.best_id]
    return "полоса " + step_signed(row.evaluation.band_dB - log.band_dB, 2) + " дБ к логу — не лучше рекомендованного (" +
        step_signed(row.evaluation.band_dB - best.band_dB, 2) + " дБ)"
}

// Таблица вариантов: значения, уровни на пиках, полосы и задержки с разницей к логу, оценка
function step2_render_candidates() {
    const box = document.getElementById("candidates2")
    const note = document.getElementById("candidates2_note")
    const stale_note = document.getElementById("candidates2_stale")
    const refit = document.getElementById("cand2_refit")
    const apply = document.getElementById("cand2_apply")
    const stale = step2_stale()
    refit.classList.toggle("primary", stale)
    stale_note.hidden = !stale
    if (stale) {
        const key = JSON.parse(step2.key)
        stale_note.textContent = "Интервал анализа или настройки спектра изменились: варианты посчитаны для " + key[0] + "–" + key[1] +
            " с. Нажмите «Подобрать заново»; графики и метрики уже для текущего интервала."
    }
    if ((step2.evaluations == null) || (step2.ranking == null) || (step2.evaluations.log == null)) {
        box.hidden = true
        note.hidden = true
        apply.disabled = true
        return
    }

    const rules = candidate_rules
    const log = step2.evaluations.log
    const lag_freqs = rules.lag_freqs_hz
    const lag_hz = lag_freqs[lag_freqs.length - 1]
    const columns = log.peaks
    const with_f2 = log.band_f2_dB != null
    const best_id = step2.ranking.best_id

    // Две строки заголовка: над столбцами пиков — общая подпись, остальные столбцы — на обе строки
    let head = '<tr><th rowspan="2"></th><th rowspan="2">Вариант</th><th rowspan="2">FREQ/BW/ATT/HMNCS/OPTS</th>' +
        '<th class="group" colspan="' + columns.length + '">Шум после фильтров на пиках, дБ</th>'
    head += '<th rowspan="2">Полоса ' + rules.band_hz[0] + '–' + rules.band_hz[1] + ' Гц, дБ</th>'
    if (with_f2) {
        head += '<th rowspan="2">Полоса с весом f², дБ (справочно)</th>'
    }
    for (const freq of lag_freqs) {
        head += '<th rowspan="2">Задержка ' + freq + ' Гц, мс</th>'
    }
    head += '<th rowspan="2">Оценка</th></tr><tr>'
    for (const column of columns) {
        head += '<th>' + column.freq.toFixed(1) + ' Гц<small>' + html_escape((column.source === "post") ? "пик «после» лога" : column.axes.join(", ")) + '</small></th>'
    }
    head += '</tr>'
    box.querySelector("thead").innerHTML = head

    const rows = step2_rows()
    const selected = rows.some((r) => r.id === step2.selected_id) ? step2.selected_id : (best_id ?? "log")
    let body = ""
    for (const row of rows) {
        const e = row.evaluation
        const id_attr = html_escape("cand2_" + row.id)
        body += '<tr' + ((row.id === best_id) ? ' class="recommended"' : '') + '>'
        body += '<td><input type="radio" name="cand2" id="' + id_attr + '" value="' + html_escape(row.id) + '"' + ((row.id === selected) ? ' checked' : '') + '></td>'
        body += '<td><label for="' + id_attr + '">' + html_escape(row.title) + '</label>' + step2_row_note(row) + '</td>'
        body += '<td class="num">' + step2_short_values(row.values).map(html_escape).join('<br>') + '</td>'
        if (e == null) {
            body += '<td colspan="' + (columns.length + 2 + (with_f2 ? 1 : 0) + lag_freqs.length) + '">оценки нет</td></tr>'
            continue
        }
        const is_log = row.id === "log"
        for (const column of columns) {
            const peak = step2_peak(e, column)
            const delta = ((peak != null) && !is_log) ? peak.post_dB - column.post_dB : null
            body += step2_delta_cell(peak?.post_dB ?? null, delta, 1, rules.max_peak_worsening_dB, 0.05)
        }
        body += step2_delta_cell(e.band_dB, is_log ? null : e.band_dB - log.band_dB, 2, 0.005, 0.005)
        if (with_f2) {
            // Справочный столбец: без цвета «лучше/хуже»
            body += step2_delta_cell(e.band_f2_dB, is_log ? null : e.band_f2_dB - log.band_f2_dB, 2, Infinity, Infinity)
        }
        for (const freq of lag_freqs) {
            const delta = is_log ? null : e.lag_ms[freq] - log.lag_ms[freq]
            // Допуск задержки — только на старшей частоте, как в rank_candidates
            body += step2_delta_cell(e.lag_ms[freq], delta, 2, (freq === lag_hz) ? rules.max_lag_increase_ms : Infinity, 0.005)
        }
        let verdict
        if (row.id === best_id) {
            verdict = '<span class="tag">рекомендуется</span>'
        } else if (is_log) {
            verdict = "текущие настройки"
        } else {
            verdict = html_escape(step2_reason(row, log))
        }
        body += '<td>' + verdict + '</td></tr>'
    }
    box.querySelector("tbody").innerHTML = body
    box.hidden = false
    apply.disabled = false

    note.textContent = "Уровни — ожидаемый шум после фильтров на пиках шага 1 (мощность по осям, где пик найден) и на главных пиках оценки «после» " +
        "для настроек лога (столбцы «пик «после» лога»), в мелкой строке — разница с логом. Полоса — средняя по бинам мощность X+Y+Z" +
        (with_f2 ? "; полоса с весом f² — та же мощность с весом (f / " + rules.f2_ref_hz + " Гц)², для справки, в выборе не участвует" : "") + ". Задержка — фазовая задержка всей цепочки фильтров. " +
        "Зелёный — лучше лога, красный — хуже больше допуска (пик +" + rules.max_peak_worsening_dB + " дБ, задержка на " + lag_hz + " Гц +" + rules.max_lag_increase_ms +
        " мс). Гироскоп " + ((state.gyro.primary ?? state.gyro.first_gyro) + 1) + " до фильтров, интервал " + JSON.parse(step2.key).slice(0, 2).join("–") + " с."
    note.hidden = false
}

// Таблица гармоник автоподбора: превышение каждой гармоники в порядковом спектре ESC и взята ли она в HMNCS
function step2_render_harmonics() {
    const box = document.getElementById("harmonics2")
    const note = document.getElementById("harmonics2_note")
    const fit = step2.fit
    if (fit == null) {
        box.hidden = true
        note.hidden = true
        return
    }
    const result = fit.result
    const info = (step2.analysis?.method === "order") ? step2.analysis.info : null
    // «Взята» — бит HMNCS автоподбора по ESC (MODE 3): его гармоники — те же порядки, что в этой таблице.
    // У подбора по газу гармоники считаются от другой основной частоты, и сопоставлять их с порядками ESC нельзя
    const esc_fit = (result != null) && (result.mode == 3)
    if (info != null) {
        box.querySelector("tbody").innerHTML = info.order_peaks.map((peak) => {
            let taken = "—"
            if (esc_fit) {
                taken = ((result.harmonics & (1 << (peak.harmonic - 1))) != 0) ? "взята" : "нет"
            }
            return '<tr><td class="num">' + peak.harmonic + '</td><td class="num">' + (Number.isFinite(peak.excess) ? peak.excess.toFixed(1) : "нет пика") +
                '</td><td>' + taken + '</td></tr>'
        }).join("")
    }
    box.hidden = info == null

    const parts = []
    if (result != null) {
        parts.push("Источник автоподбора: " + result.name + " — MODE " + result.mode + ", FREQ " + result.freq + " Гц, REF " + param_to_string(result.ref) +
                   ", FM_RAT " + param_to_string(result.min_ratio) + ", HMNCS " + result.harmonics + ", ATT " + result.attenuation + " дБ.")
    } else {
        parts.push("Автоподбор не нашёл источника.")
    }
    if (fit.errors.length > 0) {
        parts.push("Не подошли: " + fit.errors.join("; ") + ".")
    }
    if (info == null) {
        parts.push("Порядкового спектра ESC нет (нужны ESC-телеметрия и запись «до» фильтров) — таблица гармоник не строится.")
    } else {
        parts.push("Гармоника берётся, если её пик в порядковом спектре выше местного шума не меньше чем на " + auto_fit_rules.min_peak_dB +
                   " дБ; ослабление — по самой выраженной из взятых.")
        parts.push(esc_fit ? "«Взята» — бит в INS_HNTCH_HMNCS автоподбора."
                           : "Автоподбор взял другой источник" + ((result != null) ? " (" + result.name + ")" : "") +
                             " — его гармоники считаются от своей основной частоты, поэтому столбец «В автоподборе» здесь не заполняется.")
    }
    note.textContent = parts.join(" ")
    note.hidden = false
}

// Плитки метрик посчитанных значений формы против лога и предупреждения фильтров
function step2_render_metrics() {
    const box = document.getElementById("metrics2")
    const warnings_box = document.getElementById("warnings2")
    const current = step2_current()
    let metrics = (current != null) ? step2_metrics(current.values) : null
    if ((metrics != null) && ((metrics.current == null) || (metrics.log == null))) {
        metrics = null
    }
    if (metrics == null) {
        box.hidden = true
        const warnings = (current != null) ? current.filters.warnings : []
        warnings_box.textContent = "Предупреждения фильтров: " + [...new Set(warnings)].join(" · ")
        warnings_box.hidden = warnings.length == 0
        return
    }
    const rules = candidate_rules
    const cur = metrics.current
    const log = metrics.log
    const lag_hz = rules.lag_freqs_hz[rules.lag_freqs_hz.length - 1]
    const match = step2_match(current.values)
    const tiles = [step_tile("Значения", (match != null) ? match.title : "правка вручную", step2_short_values(current.values).join(" "), null)]
    for (const peak of cur.peaks) {
        if (peak.source === "post") {
            continue
        }
        const log_peak = step2_peak(log, peak)
        const delta = (log_peak != null) ? peak.post_dB - log_peak.post_dB : 0
        const mod = (delta > rules.max_peak_worsening_dB) ? "bad" : ((delta < -0.05) ? "good" : null)
        tiles.push(step_tile("Пик " + peak.freq.toFixed(1) + " Гц · " + peak.axes.join(", "), peak.pre_dB.toFixed(1) + " → " + peak.post_dB.toFixed(1) + " дБ",
                             "ослабление " + (peak.pre_dB - peak.post_dB).toFixed(1) + " дБ, к логу " + step_signed(delta, 1) + " дБ", mod))
    }
    const band_delta = cur.band_dB - log.band_dB
    tiles.push(step_tile("Полоса " + rules.band_hz[0] + "–" + rules.band_hz[1] + " Гц", cur.band_dB.toFixed(2) + " дБ", "к логу " + step_signed(band_delta, 2) + " дБ",
                         (band_delta > 0.005) ? "bad" : ((band_delta < -0.005) ? "good" : null)))
    if ((cur.band_f2_dB != null) && (log.band_f2_dB != null)) {
        tiles.push(step_tile("Полоса с весом f²", cur.band_f2_dB.toFixed(2) + " дБ", "к логу " + step_signed(cur.band_f2_dB - log.band_f2_dB, 2) + " дБ", null))
    }
    for (const freq of rules.lag_freqs_hz) {
        const delta = cur.lag_ms[freq] - log.lag_ms[freq]
        const mod = ((freq === lag_hz) && (delta > rules.max_lag_increase_ms)) ? "bad" : null
        tiles.push(step_tile("Задержка на " + freq + " Гц", cur.lag_ms[freq].toFixed(2) + " мс", "к логу " + step_signed(delta, 2) + " мс", mod))
    }
    box.innerHTML = tiles.join("")
    box.hidden = false

    const warnings = [...new Set(cur.warnings)]
    warnings_box.textContent = "Предупреждения фильтров: " + warnings.join(" · ")
    warnings_box.hidden = warnings.length == 0
}

// Вердикт: принятые значения (всегда первыми); без данных «до» — предупреждение; рекомендация или «менять
// не нужно» с причинами по отвергнутым вариантам; неудача автоподбора — приставкой к обычному тексту
function step2_render_verdict() {
    const accepted = state.steps[2]
    if ((accepted != null) && (step2_key(accepted.accepted) === step2_key(values_from_form()))) {
        const match = step2_match(accepted.accepted)
        const metrics = accepted.metrics
        const name = (match != null) ? "«" + match.title + "»" : "значения формы"
        let tail = ""
        if (metrics != null) {
            const lag_hz = candidate_rules.lag_freqs_hz[candidate_rules.lag_freqs_hz.length - 1]
            tail = " — полоса " + metrics.current.band_dB.toFixed(2) + " дБ (к логу " + step_signed(metrics.current.band_dB - metrics.log.band_dB, 2) +
                   "), задержка на " + lag_hz + " Гц " + metrics.current.lag_ms[lag_hz].toFixed(2) + " мс (к логу " +
                   step_signed(metrics.current.lag_ms[lag_hz] - metrics.log.lag_ms[lag_hz], 2) + ")"
        }
        if (step2_flagged(accepted.flags)) {
            step_verdict("verdict2", "warn", "Принято, но хуже лога: " + step2_accepted_flags_text(accepted) + ". " + name + tail + ".")
        } else {
            step_verdict("verdict2", "ok", "Принято: " + name + tail + ".")
        }
        return
    }
    if (!state.gyro.have_pre) {
        step_verdict("verdict2", "warn", "Для сравнения вариантов нужны данные гироскопа до фильтров (INS_LOG_BAT_OPT/INS_RAW_LOG_OPT). Форма, файл .param и графики работают с записанным «после».")
        return
    }
    if (step2.ranking == null) {
        step_verdict("verdict2", "warn", "Варианты не оценены: у первичного гироскопа нет окон FFT до фильтров или пиков в интервале.")
        return
    }
    const stale = step2_stale() ? " Варианты посчитаны для прежнего интервала — «Подобрать заново»." : ""
    const best_id = step2.ranking.best_id
    if (best_id == null) {
        // Защитная ветка: в оценках всегда есть ключ «log», и rank_candidates возвращает хотя бы его
        step_verdict("verdict2", "fail", "Сравнение вариантов не выбрало ни одного варианта." + stale)
        return
    }
    // Оценка лога неполная — rank_candidates отмечает все остальные варианты incomplete, рекомендуется лог
    const others = step2_rows().filter((r) => (r.id !== "log") && (r.id !== "current"))
    if ((others.length > 0) && others.every((r) => r.flags?.incomplete)) {
        const reason = (step2.evaluations.log == null) ? "нет оценки варианта «Как в логе» (у первичного гироскопа нет окон FFT до фильтров в интервале)"
                                                       : "оценка варианта «Как в логе» неполная (нет пиков или спектра, мощность в полосе не число)"
        step_verdict("verdict2", "warn", "Оценить варианты не удалось: " + reason + ". Остаются настройки из лога." + stale)
        return
    }
    // Автоподбор не удался: без других вариантов сравнивать не с чем, иначе (второй notch) — приставка к обычному тексту
    const fit_failed = step2.fit.result == null
    const fit_prefix = fit_failed ? "Автоподбор не удался: " + step2.fit.errors.join("; ") + ". " : ""
    if (fit_failed && (others.length == 0)) {
        step_verdict("verdict2", "warn", fit_prefix + "Сравнивать не с чем — ниже оценка текущих настроек." + stale)
        return
    }
    const log = step2.evaluations.log
    if (best_id === "log") {
        const reasons = others.filter((r) => r.evaluation != null).map((r) => r.title + ": " + step2_reason(r, log))
        step_verdict("verdict2", fit_failed ? "warn" : "ok", fit_prefix + "Текущие настройки лучше " + (fit_failed ? "других вариантов" : "вариантов автоподбора") +
            " с учётом задержки; менять notch не нужно." + ((reasons.length > 0) ? " " + reasons.join(". ") + "." : "") + stale)
        return
    }
    const best = step2.candidates.find((c) => c.id === best_id)
    const e = step2.evaluations[best_id]
    const lag_hz = candidate_rules.lag_freqs_hz[candidate_rules.lag_freqs_hz.length - 1]
    // Самое большое изменение уровня на пике (главном или «после» лога)
    let biggest = null
    for (const peak of e.peaks) {
        const log_peak = step2_peak(log, peak)
        const delta = (log_peak != null) ? peak.post_dB - log_peak.post_dB : NaN
        if (Number.isFinite(delta) && ((biggest == null) || (Math.abs(delta) > Math.abs(biggest.delta)))) {
            biggest = { freq: peak.freq, delta: delta }
        }
    }
    const selected = radio_value("cand2") === best_id
    step_verdict("verdict2", fit_failed ? "warn" : "ok", fit_prefix + "Рекомендуется «" + best.title + "»: " +
        ((biggest != null) ? biggest.freq.toFixed(1) + " Гц " + step_signed(biggest.delta, 1) + " дБ, " : "") +
        "полоса " + candidate_rules.band_hz.join("–") + " Гц " + step_signed(e.band_dB - log.band_dB, 2) +
        " дБ к логу, задержка на " + lag_hz + " Гц " + step_signed(e.lag_ms[lag_hz] - log.lag_ms[lag_hz], 2) + " мс. " +
        (selected ? "Он выбран — нажмите «Применить вариант», затем «Принять»." : "Выберите его в таблице и нажмите «Применить вариант», затем «Принять».") + stale)
}

// Отметки варианта против лога (rank_candidates), которые делают его хуже лога: неполная оценка, пики хуже лога,
// задержка сверх допуска; flags null — сравнения не было, отметок нет. Вердикт шага 2 и сводка шага 5
function step2_flagged(flags) {
    return (flags != null) && (flags.incomplete || (flags.worse_peaks.length > 0) || flags.lag_over)
}

// Отметки принятого набора против лога словами (сохранены в state.steps[2].flags; пики — из сводки метрик)
function step2_accepted_flags_text(accepted) {
    const flags = accepted.flags
    const metrics = accepted.metrics
    if (metrics == null) {
        return step2_flags_text(flags, null, null)
    }
    // Сводка хранит пары «после» и «после у лога» — достаточно для step2_flags_text
    const evaluation = { peaks: metrics.peaks.map((p) => ({ freq: p.freq, source: p.source, post_dB: p.post_dB })), lag_ms: metrics.current.lag_ms }
    const log = { peaks: metrics.peaks.filter((p) => p.log_post_dB != null).map((p) => ({ freq: p.freq, source: p.source, post_dB: p.log_post_dB })),
                  lag_ms: metrics.log.lag_ms }
    return step2_flags_text(flags, evaluation, log)
}

// Спектр первичного гироскопа: до фильтров, оценка «после» для посчитанных значений формы, записанное «после»;
// линии notch — shapes из notch_line_stats (диапазон — прямоугольник, средняя — линия)
function redraw_spectrum2() {
    const p = plot("Spectrum2")
    const amp = spectrum_amplitude_scale(state.spectrum.amplitude)
    const freq = spectrum_frequency_scale(state.spectrum.frequency, state.spectrum.log_frequency)
    p.layout.xaxis.type = freq.type
    p.layout.xaxis.title.text = freq.label
    p.layout.yaxis.title.text = amp.label
    p.layout.shapes = []
    const hover = "<extra></extra>%{meta}<br>" + spec_freq_hover("x") + "<br>" + spec_amp_hover("y")
    for (const trace of p.data) {
        trace.x = []
        trace.y = []
        trace.hovertemplate = hover
    }

    const current = step2_current()
    const gyro = state.gyro
    const sensor = gyro.primary ?? gyro.first_gyro
    const range = [state.settings.start, state.settings.end]
    const loop_rate = current.values.SCHED_LOOP_RATE
    const fill = (t, instance, spectrum, alias) => {
        const x = freq.fun(alias.bins)
        for (let a = 0; a < SPEC_AXES.length; a++) {
            const trace = p.data[spec2_trace_index(t, a)]
            trace.x = x
            trace.y = spectrum[SPEC_AXES[a]]
        }
    }
    const pre = find_instance(gyro, sensor, false)
    if (pre != null) {
        const alias = alias_obj(gyro[pre].FFT, { mode: state.spectrum.aliasing, loop_rate: loop_rate })
        fill(0, pre, mean_spectrum(gyro[pre].FFT, amp, range, alias), alias)
        const est = estimate_post(gyro, pre, amp, range, alias, step2_H(pre))
        if (est != null) {
            fill(1, pre, est, alias)
        }
    }
    const post = find_instance(gyro, sensor, true)
    if (post != null) {
        const alias = alias_obj(gyro[post].FFT, { mode: state.spectrum.aliasing, loop_rate: loop_rate })
        fill(2, post, mean_spectrum(gyro[post].FFT, amp, range, alias), alias)
    }
    // Трассы без данных — вне легенды; с данными — видимость, выбранная пользователем (после очистки — только
    // в легенде, на графике скрыта)
    for (const trace of p.data) {
        plot_trace_visibility(trace, "legendonly")
    }

    // Линии notch: на логарифмической оси неположительные частоты не рисуются
    const stats = notch_line_stats(current.filters, range)
    const usable = (v) => (v != null) && Number.isFinite(v) && ((freq.type !== "log") || (v > 0))
    for (let i = 0; i < stats.length; i++) {
        for (const h of stats[i].harmonics) {
            if (usable(h.min) && usable(h.max)) {
                const [x0, x1] = freq.fun([h.min, h.max])
                p.layout.shapes.push({ type: "rect", name: "n" + i + ":range", layer: "below", xref: "x", yref: "paper", x0: x0, x1: x1, y0: 0, y1: 1,
                                       line: { width: 0 }, opacity: (i == 0) ? 0.14 : 0.12 })
            }
            if (usable(h.mean)) {
                const x = freq.fun([h.mean])[0]
                p.layout.shapes.push({ type: "line", name: "n" + i + ":mean", layer: "below", xref: "x", yref: "paper", x0: x, x1: x, y0: 0, y1: 1,
                                       line: { width: 1, dash: (i == 0) ? "dash" : "dot" } })
            }
        }
    }
    spectrum2_theme(plot_palette(), p.data, p.layout)
    render_plot("Spectrum2")
}

// Бодэ посчитанных значений формы для выбранного гироскопа — как redraw_post_estimate_and_bode FilterReview:
// среднее по окнам интервала (bode_mean) линией, размах заливкой; амплитуда в шкале шага 1, фаза в градусах,
// «свернуть фазу» — phase_wrap
function redraw_bode2() {
    const p = plot("Bode2")
    const amp = spectrum_amplitude_scale(state.spectrum.amplitude)
    const freq = spectrum_frequency_scale(state.spectrum.frequency, state.spectrum.log_frequency)
    const wrap = document.getElementById("bode2_wrap").checked
    p.layout.xaxis.type = freq.type
    p.layout.xaxis2.type = freq.type
    p.layout.xaxis2.title.text = freq.label
    p.layout.yaxis.title.text = amp.label
    if (wrap) {
        p.layout.yaxis2.range = [-180, 180]
        p.layout.yaxis2.autorange = false
        p.layout.yaxis2.fixedrange = true
    } else {
        delete p.layout.yaxis2.range
        p.layout.yaxis2.fixedrange = false
        p.layout.yaxis2.autorange = true
    }
    p.data[2].hovertemplate = "<extra></extra>" + spec_freq_hover("x") + "<br>" + spec_amp_hover("y")
    p.data[3].hovertemplate = "<extra></extra>" + spec_freq_hover("x") + "<br>%{y:.2f}°"
    for (const trace of p.data) {
        trace.x = []
        trace.y = []
    }

    const sensor = radio_value("bode2_inst")
    const index = (sensor != null) ? step2_bode_instance(parseInt(sensor)) : null
    if (index != null) {
        const view = step2_gyro_view(index, null, step2_bode_H(index))
        const bode = bode_mean(view, index, [state.settings.start, state.settings.end])
        if (bode != null) {
            const x = freq.fun(bode.freq)
            const phase = [bode.phase_mean, bode.phase_max, bode.phase_min]
            if (wrap) {
                phase_wrap(phase)
            }
            p.data[2].x = x
            p.data[2].y = amp.scale(bode.amp_mean)
            p.data[3].x = x
            p.data[3].y = phase[0]
            const area_x = [...x, ...x.toReversed()]
            p.data[0].x = area_x
            p.data[0].y = amp.scale([...bode.amp_max, ...bode.amp_min.toReversed()])
            p.data[1].x = area_x
            p.data[1].y = [...phase[1], ...phase[2].toReversed()]
        }
    }
    render_plot("Bode2")
}

// Спектрограмма выбранного гироскопа, данных и оси (как на шаге 1; оценка — для посчитанных значений формы)
// и линии гармоник notch формы; записанные в лог линии — в легенде
function redraw_spectrogram2() {
    const p = plot("Spectrogram2")
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

    const current = step2_current()
    const gyro = state.gyro
    const sensor = radio_value("sg2_inst")
    const data = radio_value("sg2_data")
    const axis = radio_value("sg2_axis")
    const instance = ((sensor != null) && (data != null)) ? find_instance(gyro, parseInt(sensor), data === "post") : null
    if (instance != null) {
        const alias = alias_obj(gyro[instance].FFT, { mode: state.spectrum.aliasing, loop_rate: current.values.SCHED_LOOP_RATE })
        const source = (data === "est") ? step2_gyro_view(instance, step2_H(instance), null) : gyro
        const spec = spectrogram_matrix(source, instance, axis, data === "est", amp, alias)
        if (spec != null) {
            heat.x = spec.x
            heat.y = freq.fun(spec.bins)
            heat.z = spec.z
        }
    }

    const lines = tracking_lines(current.filters, state.logged, [state.settings.start, state.settings.end])
    const line_hover = "<extra></extra>%{meta}<br>%{x:.2f} с<br>" + spec_freq_hover("y")
    const add_line = (group, title, line, meta, visible, dash) => {
        const name = (line.harmonic == 1) ? "основная" : "гармоника " + line.harmonic
        p.data.push({
            type: "scatter",
            mode: "lines",
            name: name,
            meta: meta + ": " + name,
            legendgroup: group,
            legendgrouptitle: { text: title },
            line: { width: 1, dash: dash },
            visible: line_visible[meta + ": " + name] ?? visible,
            hovertemplate: line_hover,
            x: line.time,
            y: freq.fun(line.freq),
        })
    }
    for (let i = 0; i < lines.length; i++) {
        const title = "Notch " + (i + 1) + " (форма" + ((lines[i].name != null) ? ", " + lines[i].name : "") + ")"
        for (const line of lines[i].harmonics) {
            add_line("form" + i, title, line, "Notch " + (i + 1) + " формы", true, "solid")
        }
    }
    for (let i = 0; i < lines.length; i++) {
        for (const line of lines[i].logged) {
            add_line("log" + i, "Notch " + (i + 1) + " в логе", line, "Notch " + (i + 1) + " в логе", "legendonly", "dashdot")
        }
    }
    spectrogram2_theme(plot_palette(), p.data, p.layout)
    render_plot("Spectrogram2")
}
