// Шаг 3 «Низкочастотные фильтры»: размер винта, варианты INS_GYRO_FILTER, фильтров ПИД и пределов ускорения
// (core/lowpass.js) со сравнением с логом — шум гироскопа после фильтров, шум D-составляющей, задержка путей P и D,
// — форма параметров с описаниями из ../FilterReview/params.json, метрики значений формы и «Принять».
// Notch-база — принятое на шаге 2 (state.steps[2].accepted), иначе notch из лога. Графики (реестр plots.js) — спектр
// гироскопа после фильтров, спектр D-составляющей и бодэ путей P и D для выбранной строки таблицы против лога.
// Форма строится своим кодом, а не load_param_inputs (Libraries/ParameterMetadata.js): тот ищет поле по id = имени
// параметра, а поле INS_GYRO_FILTER уже есть в форме шага 2. Поля шага 3 — id="lpf_<имя>".
//
// Нужны глобалы страницы: core/lowpass.js (lowpass_*, prop_*, LOWPASS_AXES), core/candidates.js (candidate_key),
// Libraries/Param_Helpers.js (param_to_string), plots.js (register_plot, render_plot, plot), wizard.js (state,
// set_step, html_escape), steps/common.js (step_signed, step_value_text, step_tile, step_cell, step_verdict,
// step_gyro_sensor, step_ensure_step1, step_try, step_run, step_find_metadata, step_metadata, step_load_metadata,
// step_edit_controller, plot_axis, plot_trace_visibility, plot_clear), steps/step1.js (step1, step1_ready,
// values_from_log, radio_value, SPEC_AXES) и steps/memory.js (memory_show — строка сравнения с прошлым проходом).
// От steps/step2.js шаг 3 не зависит: принятое шагом 2 читается из state.steps[2].

// Внутреннее состояние шага
const step3 = {
    form_built: false,        // разметка формы построена для имён текущего лога (пределы ускорения — под именами из лога)
    form_names: null,         // имена полей формы по порядку (lowpass_param_names)
    filled: false,            // форма заполнена значениями текущего лога
    base: null,               // notch-база расчёта: state.steps[2].accepted или values_from_log()
    prop_in: null,            // размер винта расчёта, дюймы; null — не введён или непригоден (prop_valid)
    ctx: null,                // lowpass_ctx расчёта; null — нет данных гироскопа до фильтров
    candidates: null,         // lowpass_candidates → [{ id, title, values, same_as, … }]
    evaluations: null,        // id → evaluate_lowpass (null — оценки нет)
    flags: null,              // id → lowpass_flags против «Как в логе»
    custom_row: null,         // «Свой» — значения формы, не совпавшие ни с одним вариантом: { id, title, values, evaluation, flags }
    selected_id: null,        // выбранная в таблице строка (читать через step3_selected_row)
    bode_cache: null,         // бодэ для графика: { context, gyro, map: candidate_key значений → lowpass_bode } (step3_bode)
    key: null,                // для какого расчёта посчитаны варианты (step3_calc_key)
    context_key: null,        // и на каком контексте оценки (step3_context_key: ключ расчёта без размера винта)
    gyro_ref: null,           // и для какого объекта state.gyro
    error: null,              // ошибка расчёта шага 1: показывается в вердикте вместо результатов
    edit_prop: null,          // текст размера винта, для которого пересчитано и отрисовано
    edit_form: null,          // ключ значений формы (candidate_key), для которого пересчитано и отрисовано
    edit_timer: null,         // отложенный пересчёт после набора в поле (step3_edits)
    edit_postponed: false,    // пересчёт отложен до отпускания кнопки мыши (step3_edits)
}

// Размер винта в памяти браузера
const step3_storage_key = "tunewizard_prop_in"

// Пауза в наборе, после которой поле пересчитывается, мс [наше]
const step3_edit_delay_ms = 400

// Механизм правок полей (каркас — step_edit_controller из steps/common.js, см. «Правки полей»)
const step3_edits = step_edit_controller(step3, { delay_ms: step3_edit_delay_ms, flush: step3_flush_edits })

// Оси с метриками словами: именительный и родительный падежи
const step3_axis_names = { roll: { nom: "крен", gen: "крена" }, pitch: { nom: "тангаж", gen: "тангажа" } }

// Типы трасс графиков: как в логе и выбранная строка таблицы (у спектра гироскопа ещё «до фильтров», spec3_types);
// подписи и штрих — по типу
const step3_trace_types = ["log", "sel"]
const spec3_types = ["pre", ...step3_trace_types]
const step3_type_names = { pre: "до фильтров", log: "как в логе", sel: "выбранный" }
const step3_dash = { pre: "dot", log: "dash", sel: "solid" }
// Пути бодэ: P — фильтр гироскопа, notch и FLTE; D — ещё и FLTD
const bode3_paths = ["P", "D"]
// Нижняя частота бодэ на логарифмической оси, Гц: ниже фильтры не действуют, а 0 Гц такая ось не покажет
const bode3_min_hz = 1
// Подграфики бодэ сверху вниз: поле lowpass_bode, оси подграфика, подсказка значения
const bode3_parts = [
    { field: "amp_dB", xaxis: "x", yaxis: "y", hover: "%{y:.2f} дБ" },
    { field: "phase_deg", xaxis: "x2", yaxis: "y2", hover: "%{y:.1f}°" },
]

// ---------- Подписи ----------

// Разница a − b со знаком и единицами; нечисловая — «не оценён»
function step3_delta_text(a, b, digits, units) {
    return (Number.isFinite(a) && Number.isFinite(b)) ? step_signed(a - b, digits) + " " + units : "не оценён"
}

// «что» для крена и тангажа одной строкой: одинаковые тексты — один раз, иначе «что крена A, тангажа B»
function step3_axes_text(what, by_axis) {
    if (by_axis.roll === by_axis.pitch) {
        return what + " " + by_axis.roll
    }
    return what + " " + step3_axis_names.roll.gen + " " + by_axis.roll + ", " + step3_axis_names.pitch.gen + " " + by_axis.pitch
}

// Короткая запись значений: INS_GYRO_FILTER и FLTT / FLTD крена и тангажа
function step3_short_values(values) {
    return "INS_GYRO_FILTER " + step_value_text(values.INS_GYRO_FILTER) +
        " · FLTT " + step_value_text(values.ATC_RAT_RLL_FLTT) + " / " + step_value_text(values.ATC_RAT_PIT_FLTT) +
        " · FLTD " + step_value_text(values.ATC_RAT_RLL_FLTD) + " / " + step_value_text(values.ATC_RAT_PIT_FLTD)
}

// Метрики current против лога log словами: шум гироскопа, шум D крена и тангажа, задержка путей P и D на
// lowpass_lag_hz(). current и log — оценки evaluate_lowpass или их сводки step3_metrics_summary (те же поля)
function step3_summary_text(current, log) {
    const hz = lowpass_lag_hz()
    const parts = ["шум гироскопа " + step3_delta_text(current.gyro.band_dB, log.gyro.band_dB, 2, "дБ")]
    const dterm = {}
    for (const axis of Object.keys(lowpass_pid_axes)) {
        dterm[axis] = (current.kd?.[axis] === 0) ? "не сравнивается (D выключен)" : step3_delta_text(current.dterm?.[axis]?.dB, log.dterm?.[axis]?.dB, 2, "дБ")
    }
    parts.push(step3_axes_text("шум D", dterm))
    const lag = []
    for (const path of ["P", "D"]) {
        const by_axis = {}
        for (const axis of Object.keys(lowpass_pid_axes)) {
            // Путь D оси с выключенным D (Kd = 0) не сравнивается
            by_axis[axis] = ((path === "D") && (current.kd?.[axis] === 0)) ? "— (D выключен)"
                : step3_delta_text(current.lag_ms?.[axis]?.[path]?.[hz], log.lag_ms?.[axis]?.[path]?.[hz], 2, "мс")
        }
        lag.push(step3_axes_text("путь " + path, by_axis))
    }
    return parts.join(", ") + "; задержка на " + hz + " Гц: " + lag.join(", ")
}

// Отметки варианта, которые делают его хуже лога: неполная оценка, «шумнее», «медленнее». incomplete_axes
// и d_off_axes — сведения, а не ухудшение (они одинаковы у всех вариантов: Kd у всех из одного лога)
function step3_flagged(flags) {
    return (flags != null) && (flags.incomplete || (flags.noisier.length > 0) || (flags.slower.length > 0))
}

// Отметки lowpass_flags словами с разницами к логу; пустая строка — отметок нет. current и log — как
// в step3_summary_text
function step3_flags_text(flags, current, log) {
    if (flags == null) {
        return ""
    }
    if (flags.incomplete) {
        return "оценка неполная — сравнить с логом нельзя"
    }
    const rules = lowpass_rules
    const hz = lowpass_lag_hz()
    const parts = []
    if (flags.noisier.length > 0) {
        const items = flags.noisier.map((what) => {
            if (what === "gyro") {
                return "гироскоп " + step3_delta_text(current.gyro.band_dB, log.gyro.band_dB, 2, "дБ")
            }
            return "D " + step3_axis_names[what].gen + " " + step3_delta_text(current.dterm?.[what]?.dB, log.dterm?.[what]?.dB, 2, "дБ")
        })
        parts.push("шумнее лога больше чем на " + rules.max_noise_increase_dB + " дБ: " + items.join(", "))
    }
    if (flags.slower.length > 0) {
        // По путям: обе оси с одной разницей — одной записью (step3_axes_text)
        const items = []
        for (const path of ["P", "D"]) {
            const axes = flags.slower.filter((s) => s.path === path).map((s) => s.axis)
            const text = (axis) => step3_delta_text(current.lag_ms?.[axis]?.[path]?.[hz], log.lag_ms?.[axis]?.[path]?.[hz], 2, "мс")
            if (axes.length == 2) {
                items.push(step3_axes_text("путь " + path, { roll: text("roll"), pitch: text("pitch") }))
            } else if (axes.length == 1) {
                items.push("путь " + path + " " + step3_axis_names[axes[0]].gen + " " + text(axes[0]))
            }
        }
        parts.push("медленнее лога больше чем на " + rules.max_lag_increase_ms + " мс на " + hz + " Гц: " + items.join(", "))
    }
    return parts.join("; ")
}

// Сводка оценки для итога мастера: те же поля, что читают step3_summary_text и step3_flags_text, без спектров
function step3_metrics_summary(e) {
    const dterm = {}
    for (const axis of Object.keys(lowpass_pid_axes)) {
        dterm[axis] = (e.dterm[axis] != null) ? { dB: e.dterm[axis].dB } : null
    }
    return {
        kd: { ...e.kd },
        gyro: { band_dB: e.gyro.band_dB, lag_ms: { ...e.gyro.lag_ms } },
        dterm: dterm,
        lag_ms: structuredClone(e.lag_ms),
        warnings: [...e.warnings],
    }
}

// ---------- Инициализация и сброс ----------

function step3_init() {
    step3_setup_plots()

    // Пороги во вступлении и частоты задержки в подписи бодэ — из lowpass_rules, чтобы текст не расходился с ядром.
    // Свой атрибут data-rule3: шаг 2 перебирает все [data-rule] документа
    const rules = lowpass_rules
    const rule_texts = {
        band: rules.band_hz[0] + "–" + rules.band_hz[1] + " Гц",
        noise: rules.max_noise_increase_dB + " дБ",
        lag_hz: lowpass_lag_hz() + " Гц",
        lag: rules.max_lag_increase_ms + " мс",
        lag_freqs: rules.lag_freqs_hz.join(" и ") + " Гц",
        band_top: rules.band_hz[1] + " Гц",
    }
    for (const span of document.querySelectorAll("[data-rule3]")) {
        span.textContent = rule_texts[span.dataset.rule3]
    }
    // Границы поля размера винта — те же prop_range_in, что у предупреждения prop_size_warning: вне них поле :invalid.
    // Шаг — любой: размеры бывают дробными (9.4″), а поле со step="0.5" считало бы их ошибкой
    const prop_field = document.getElementById("prop_in")
    prop_field.min = rules.prop_range_in[0]
    prop_field.max = rules.prop_range_in[1]
    prop_field.step = "any"

    const saved = step3_prop_load()
    if (saved != null) {
        document.getElementById("prop_in").value = saved
    }
    step3_render_prop()

    // Правки полей (размер винта и форма; поля формы перерисовываются с новым логом — слушаем контейнер):
    // набор — пересчёт после паузы, change — следующей задачей или после отпускания мыши (см. «Правки полей»)
    for (const id of ["prop_in", "lpf_form"]) {
        document.getElementById(id).addEventListener("input", step3_edits.input)
        document.getElementById(id).addEventListener("change", step3_edits.change)
    }
    document.getElementById("cand3_apply").addEventListener("click", step3_apply)
    document.getElementById("lpf_accept").addEventListener("click", step3_accept)
    // Выбор варианта в таблице (строки перерисовываются — слушаем таблицу): вердикт и графики выбранного
    document.getElementById("candidates3").addEventListener("change", (e) => {
        if (e.target.name === "cand3") {
            step3.selected_id = e.target.value
            if (step3_ready() && (step3.candidates != null)) {
                step_try(() => {
                    step3_render_verdict()
                    step3_redraw_plots()
                }, "verdict3", "шага 3")
            }
        }
    })
    // Ось бодэ: перерисовать только посчитанное (бодэ обеих осей считается одним вызовом lowpass_bode)
    for (const id of ["bode3_roll", "bode3_pitch"]) {
        document.getElementById(id).addEventListener("change", () => {
            if (step3_plots_ready()) {
                step_try(bode3_redraw, "verdict3", "шага 3")
            }
        })
    }
}

// Новый лог или ошибка загрузки: забыть варианты, расчёт и форму (имена пределов ускорения зависят от лога),
// очистить графики. Размер винта в поле остаётся: он про аппарат, а не про лог
function step3_reset() {
    Object.assign(step3, {
        form_built: false, form_names: null, filled: false, base: null, prop_in: null, ctx: null, candidates: null, evaluations: null,
        flags: null, custom_row: null, selected_id: null, bode_cache: null, key: null, context_key: null, gyro_ref: null, error: null,
        edit_prop: null, edit_form: null, edit_postponed: false,
    })
    clearTimeout(step3.edit_timer)
    step3.edit_timer = null
    document.getElementById("lpf_form").innerHTML = ""
    for (const id of ["verdict3", "memory3", "warnings3", "candidates3", "candidates3_note", "metrics3", "prop_hint"]) {
        document.getElementById(id).hidden = true
    }
    for (const id of ["cand3_apply", "lpf_accept"]) {
        document.getElementById(id).disabled = true
    }
    step3_clear_plots()
}

// ---------- Размер винта ----------

// Размер винта из поля: число или null, если поле пустое (поле type="number" отдаёт пустую строку и на нечисловой
// текст). Отрицательное, ноль и прочее — как есть: варианта по размеру не будет (prop_valid), у поля — предупреждение
function step3_prop_value() {
    const text = document.getElementById("prop_in").value.trim()
    return (text === "") ? null : Number(text)
}

// Размер винта для расчёта: значение поля, если оно пригодно для формул (prop_valid), иначе null — непригодный
// размер (−3, 0) считается как не введённый, о нём говорит предупреждение у поля
function step3_prop_size() {
    const p = step3_prop_value()
    return prop_valid(p) ? p : null
}

// Размер винта из памяти браузера (строка) или null; хранилище может быть недоступно (приватный режим)
function step3_prop_load() {
    try {
        return localStorage.getItem(step3_storage_key)
    } catch {
        return null
    }
}

function step3_prop_save(text) {
    try {
        if (text === "") {
            localStorage.removeItem(step3_storage_key)
        } else {
            localStorage.setItem(step3_storage_key, text)
        }
    } catch {
        // Хранилище недоступно — размер просто не запомнится
    }
}

// Предупреждение у поля (prop_size_warning) и подсказка по INS_GYRO_FILTER лога (обратная формула Mission Planner)
function step3_render_prop() {
    const warn = document.getElementById("prop_warn")
    const warning = prop_size_warning(step3_prop_value())
    warn.textContent = warning ?? ""
    warn.hidden = warning == null

    const hint = document.getElementById("prop_hint")
    if (state.params == null) {
        hint.hidden = true
        return
    }
    const gyro_hz = lowpass_log_values(state.params).INS_GYRO_FILTER
    const prop = prop_from_gyro_filter(gyro_hz)
    const intro = prop_valid(step3_prop_value()) ? "Размер винта запоминается в браузере. " : "Размера винта в логе нет — введите его, он запомнится в браузере. "
    hint.textContent = intro + ((prop != null)
        ? "Текущему INS_GYRO_FILTER " + step_value_text(gyro_hz) + " Гц по формуле Mission Planner соответствует ≈ " + prop.toFixed(1) + "″."
        : "INS_GYRO_FILTER в логе " + step_value_text(gyro_hz) + " — фильтр гироскопа выключен, подсказки по размеру нет.")
    hint.hidden = false
}

// ---------- Правки полей ----------
// Пересчёт после правки размера винта или формы. Щелчок по кнопке сразу после набора не должен теряться: нажатие
// кнопки уводит фокус из поля, поле даёт change, и перерисовка в этот момент (строка «Свой», вариант по размеру,
// предупреждение у поля) сдвинула бы кнопку до отпускания мыши. Поэтому:
// - набор (input) — пересчёт после паузы step3_edit_delay_ms: к уходу из поля обычно всё уже посчитано;
// - change — пересчёт, только если введённое отличается от посчитанного, следующей задачей (при уходе по Tab фокус
//   успевает перейти на следующий элемент, перерисовка таблицы его возвращает); при нажатой кнопке мыши — после
//   её отпускания, то есть после щелчка;
// - «Применить вариант» и «Принять» сами досчитывают правки перед действием (step3_flush_edits(true)), так что
//   действие идёт по актуальным значениям полей, даже если щелчок пришёл раньше пересчёта.
// Набор, change и флаг нажатой кнопки мыши — общий каркас step_edit_controller (step3_edits).

// Текст размера винта и ключ значений формы — то, что введено сейчас
function step3_edit_state() {
    return { prop: document.getElementById("prop_in").value.trim(), form: step3.filled ? candidate_key(step3_values_from_form()) : null }
}

// Отметить введённое сейчас как посчитанное
function step3_edit_done() {
    const edit = step3_edit_state()
    step3.edit_prop = edit.prop
    step3.edit_form = edit.form
}

// Применить правки, если введённое отличается от посчитанного: запомнить размер винта, подписи у поля, пересчёт
// (варианты — при смене размера, строка «Свой» — при правке формы; выбрана строка формы, если менялась форма)
// и перерисовка. При нажатой кнопке мыши — после её отпускания; force — без этой проверки (кнопки шага: к click
// кнопка мыши уже отпущена, а с клавиатуры флаг не нужен). Введённое отмечается посчитанным только после
// успешного расчёта: после исключения те же значения посчитаются снова (и варианты — тоже: step3_compute пишет
// ключ расчёта только после успешной оценки)
function step3_flush_edits(force = false) {
    if (!step3_edits.begin(force)) {
        return
    }
    const edit = step3_edit_state()
    if ((edit.prop === step3.edit_prop) && (edit.form === step3.edit_form)) {
        return
    }
    const form_changed = edit.form !== step3.edit_form
    step3_prop_save(edit.prop)
    step3_render_prop()
    if ((state.log == null) || !step3.filled) {
        step3_edit_done()
        return
    }
    step3_run_edit(() => {
        // Под оверлеем расчёт идёт позже — к нему мог прийти новый лог
        if (!step3.filled) {
            return
        }
        step3.error = step_ensure_step1()
        if (step3.error == null) {
            if (step3_stale()) {
                step3_compute()
            } else {
                step3_update_custom()
            }
            if (form_changed) {
                step3.selected_id = step3_form_row()?.id ?? step3.selected_id
            }
        }
        step3_redraw_all()
        step3_edit_done()
    })
}

// ---------- Форма параметров ----------

// Метаданные поля формы. Старых имён ATC_ACCEL_*_MAX (сантиградусы/с², 4.6 и раньше) в params.json нет — берётся
// описание нового ATC_ACC_*_MAX с единицами cdeg/s/s. Диапазоны не показываются: у ATC_RAT_* в params.json —
// диапазоны вертолёта (path AC_AttitudeControl_Heli, FLTE 5–50 Гц), у Copter они другие (FLTE 0–100, рыскания 0–20)
function step3_param_metadata(name) {
    const data = step_metadata()
    if (data == null) {
        return null
    }
    const old = /^ATC_ACCEL_([RPY])_MAX$/.exec(name)
    const metadata = step_find_metadata(data, (old != null) ? "ATC_ACC_" + old[1] + "_MAX" : name)
    if ((metadata == null) || (old == null)) {
        return metadata
    }
    return { ...metadata, Units: "cdeg/s/s" }
}

// Описания (title у подписи и поля) и единицы из метаданных в поля формы; без метаданных — только имена
function step3_apply_metadata() {
    if (step_metadata() == null) {
        return
    }
    for (const p of document.querySelectorAll("#lpf_form p.param")) {
        const metadata = step3_param_metadata(p.dataset.name)
        if (metadata == null) {
            continue
        }
        const description = metadata.Description ?? ""
        p.querySelector("label").title = description
        p.querySelector("input").title = description
        p.querySelector(".units").textContent = metadata.Units ?? ""
    }
}

// Разметка формы для имён текущего лога: группы, подпись-имя, поле, единицы и «в логе»
function step3_build_form() {
    const names = lowpass_param_names(state.params)
    const accel = lowpass_accel_names(state.params)
    const axis_titles = { RLL: "Крен", PIT: "Тангаж", YAW: "Рыскание" }
    const groups = [{ title: "Гироскоп и акселерометр · INS_*", names: ["INS_GYRO_FILTER", "INS_ACCEL_FILTER"], wide: true }]
    for (const axis of LOWPASS_AXES) {
        groups.push({ title: axis_titles[axis] + " · ATC_RAT_" + axis + "_*", names: ["FLTT", "FLTE", "FLTD"].map((f) => "ATC_RAT_" + axis + "_" + f) })
    }
    groups.push({ title: "Пределы ускорения · " + accel.r.replace("_R_", "_*_"), names: [accel.r, accel.p, accel.y] })

    let html = ""
    for (const group of groups) {
        html += '<div class="pgroup' + (group.wide ? " pgroup--wide" : "") + '"><h3>' + html_escape(group.title) + '</h3>'
        for (const name of group.names) {
            // Частоты — не меньше 0 (отрицательные не принимаются, step3_accept_refusal); шаг — любой: в логах бывают
            // 1.2 и 0.7 Гц, а поле со step="0.5" считало бы их ошибкой (:invalid). Пределы ускорения — любые, отрицательные
            // отсекает step3_accept_refusal
            const limits = [accel.r, accel.p, accel.y].includes(name) ? 'step="any"' : 'step="any" min="0"'
            const id = "lpf_" + name
            html += '<p class="param" data-name="' + html_escape(name) + '"><label for="' + html_escape(id) + '">' + html_escape(name) + '</label>' +
                '<input type="number" id="' + html_escape(id) + '" ' + limits + '><span class="units"></span><span class="inlog"></span></p>'
        }
        html += '</div>'
    }
    document.getElementById("lpf_form").innerHTML = html
    step3.form_names = names
    step3.form_built = true
    // Описания — сразу, если метаданные уже пришли, иначе по приходу (одна загрузка на страницу, step_load_metadata)
    if (step_metadata() != null) {
        step3_apply_metadata()
    } else {
        step_load_metadata().then(step3_apply_metadata)
    }
}

// Записать значения в поля: числа — кратчайшей записью того же float32, нечисловые — пустое поле
function step3_set_form_values(values) {
    for (const name of step3.form_names) {
        if (name in values) {
            document.getElementById("lpf_" + name).value = Number.isFinite(values[name]) ? param_to_string(values[name]) : ""
        }
    }
}

// Значения формы при первом заполнении (и после сброса — новый лог): лог (lowpass_log_values), а INS_GYRO_FILTER —
// принятый на шаге 2, если шаг 2 принят и его INS_GYRO_FILTER отличается от лога. Иначе правка шага 2 терялась: итог
// и файл .param берут INS_GYRO_FILTER у шага 3 (summary_rows), а форма шага 3 показывала значение лога. С таким
// значением форма — строка «Свой» с метриками; «Применить вариант» перезаписывает поле значением варианта, и о
// расхождении с шагом 2 напоминает заметка (step3_step2_gyro_note). Шаг 2, принятый уже после заполнения формы,
// поле не меняет — только заметка
function step3_initial_values() {
    const values = lowpass_log_values(state.params)
    const accepted = state.steps[2]?.accepted?.INS_GYRO_FILTER
    if (Number.isFinite(accepted) && (Math.fround(accepted) !== values.INS_GYRO_FILTER)) {
        values.INS_GYRO_FILTER = Math.fround(accepted)
    }
    return values
}

// Заметка о INS_GYRO_FILTER шага 2 для form_hz — значения поля формы (NaN — пустое): шаг 2 принят с INS_GYRO_FILTER,
// отличным от лога, а в форме другое значение — шаг 3 решает этот параметр, в файл пойдёт значение формы (summary_rows
// берёт его у последнего принявшего шага). null — заметка не нужна: шаг 2 не принят, принят как в логе или в форме уже
// принятое на шаге 2 (первое заполнение — step3_initial_values)
function step3_step2_gyro_note(form_hz) {
    const accepted = state.steps[2]?.accepted?.INS_GYRO_FILTER
    const log_hz = lowpass_log_values(state.params).INS_GYRO_FILTER
    if (!Number.isFinite(accepted) || (Math.fround(accepted) === log_hz) || (Math.fround(accepted) === form_hz)) {
        return null
    }
    return "На шаге 2 принят INS_GYRO_FILTER " + step_value_text(accepted) + " (в логе " + step_value_text(log_hz) + "). Шаг 3 решает этот параметр: " +
           "в файл пойдёт значение из этой формы" + (Number.isFinite(form_hz) ? " — " + step_value_text(form_hz) : "") + "."
}

// Заполнить форму значениями и подписи «в логе»; у параметров, которых в логе нет, — заводское значение,
// взятое вместо него (lowpass_log_values)
function step3_fill_form(values) {
    step3_set_form_values(values)
    const log_values = lowpass_log_values(state.params)
    for (const p of document.querySelectorAll("#lpf_form p.param")) {
        const name = p.dataset.name
        const value = state.params.get(name)
        p.querySelector(".inlog").textContent = (value == null) ? "в логе нет (взято " + step_value_text(log_values[name]) + ")" : "в логе: " + step_value_text(value)
    }
}

// Значения формы: объект имя → число float32 (как у вариантов и лога). Пустое или нечисловое поле — NaN: значение
// неизвестно, оценка такого набора даёт NaN, и lowpass_flags его отмечают
function step3_values_from_form() {
    const values = {}
    for (const name of step3.form_names) {
        const field = document.getElementById("lpf_" + name)
        const text = (field != null) ? field.value.trim() : ""
        values[name] = Math.fround((text === "") ? NaN : Number(text))
    }
    return values
}

// Пометка .changed у полей, чьё значение отличается от лога (пустое поле — тоже отличие)
function step3_mark_changed() {
    if (!step3.filled) {
        return
    }
    const log_values = lowpass_log_values(state.params)
    const values = step3_values_from_form()
    for (const p of document.querySelectorAll("#lpf_form p.param")) {
        p.classList.toggle("changed", values[p.dataset.name] !== log_values[p.dataset.name])
    }
}

// ---------- Расчёт ----------

// Notch-база: значения, принятые на шаге 2, иначе notch из лога (values_from_log шага 1)
function step3_base() {
    return state.steps[2]?.accepted ?? values_from_log()
}

// Kd крена и тангажа из лога: null — параметра нет (шум D оси не считается), 0 — D выключен
function step3_kd() {
    return { roll: state.params.get("ATC_RAT_RLL_D"), pitch: state.params.get("ATC_RAT_PIT_D") }
}

// Части контекста оценки: интервал, FFT и версия фильтра шага 1, notch-база — всё, от чего зависит step3.ctx,
// кроме объекта данных гироскопа (его сравнивает gyro_ref)
function step3_context_parts() {
    return [state.settings.start, state.settings.end, step1.fft_key, state.spectrum.filter_version, candidate_key(step3_base())]
}

// Ключ контекста оценки: размер винта в него не входит — от него зависят варианты, а не контекст и не бодэ значений
function step3_context_key() {
    return JSON.stringify(step3_context_parts())
}

// Ключ расчёта: контекст оценки и размер винта
function step3_calc_key() {
    return JSON.stringify([...step3_context_parts(), step3_prop_size()])
}

// Варианты посчитаны для другого расчёта (или ещё не посчитаны)
function step3_stale() {
    return (step3.candidates == null) || (step3.key !== step3_calc_key()) || (step3.gyro_ref !== state.gyro)
}

// Расчёт шага 1 актуален и нет своей ошибки (её пишет step_ensure_step1 при расчёте)
function step3_ready() {
    return step1_ready() && (step3.error == null)
}

// Варианты и их оценка против «Как в логе» для текущего интервала, notch-базы и размера винта. Выбор строки
// сохраняется, если пользователь выбрал не строку по умолчанию (рекомендованную или «Как в логе») и такая строка
// осталась; иначе выбрана новая рекомендованная. Без данных гироскопа до фильтров или с неположительной частотой
// контура notch-базы — варианты без оценки (step3_no_compare_reason). Ключи расчёта (key, context_key, gyro_ref)
// сбрасываются в начале и пишутся только после успешной оценки: после исключения step3_stale() даст true, и
// следующий показ или правка посчитают варианты заново
function step3_compute() {
    const previous = step3.selected_id
    const previous_default = (step3.candidates != null) ? (step3_recommended_id() ?? "log") : null
    const params = state.params
    const base = step3_base()
    step3.key = null
    step3.context_key = null
    step3.gyro_ref = null
    step3.base = base
    step3.prop_in = step3_prop_size()
    step3.candidates = lowpass_candidates(lowpass_log_values(params), step3.prop_in, lowpass_accel_names(params))
    step3.evaluations = null
    step3.flags = null
    step3.custom_row = null

    const sensor = step_gyro_sensor()
    const range = [state.settings.start, state.settings.end]
    step3.ctx = (sensor != null) ? lowpass_ctx({ gyro: state.gyro, env: state.env, tracking: state.tracking, range: range, sensor: sensor }, base, step3_kd()) : null
    if (step3.ctx != null) {
        const evaluations = {}
        for (const candidate of step3.candidates) {
            evaluations[candidate.id] = evaluate_lowpass(candidate.values, step3.ctx)
        }
        step3.evaluations = evaluations
        step3.flags = Object.fromEntries(step3.candidates.map((c) => [c.id, lowpass_flags(evaluations[c.id], evaluations.log)]))
    }
    step3_update_custom()
    const keep = (previous != null) && (previous !== previous_default) && step3_rows().some((r) => r.id === previous)
    step3.selected_id = keep ? previous : (step3_recommended_id() ?? "log")
    step3.key = step3_calc_key()
    step3.context_key = step3_context_key()
    step3.gyro_ref = state.gyro
}

// Почему варианты не сравниваются с логом (у «Как в логе» нет оценки): частота контура notch-базы не положительна
// (ядро тогда оценки не даёт), нет данных гироскопа до фильтров вовсе или нет их у первичного гироскопа (step_gyro_sensor
// берёт только его: в лог попали не все IMU — INS_LOG_BAT_MASK — или у него нет окон FFT); null — оценка есть
function step3_no_compare_reason() {
    if (step3.evaluations?.log != null) {
        return null
    }
    const loop_rate = step3.base?.SCHED_LOOP_RATE
    if (!(Number.isFinite(loop_rate) && (loop_rate > 0))) {
        return "частота контура SCHED_LOOP_RATE " + ((state.steps[2] != null) ? "(принята на шаге 2)" : "(из лога)") + " — " + step_value_text(loop_rate) +
            ", а нужна положительная"
    }
    const gyro = state.gyro
    if (!gyro.have_pre) {
        return "нужны данные гироскопа до фильтров (INS_LOG_BAT_OPT / INS_RAW_LOG_OPT)"
    }
    return "у первичного гироскопа " + ((gyro.primary ?? gyro.first_gyro) + 1) + " нет данных до фильтров (есть у другого) — проверьте INS_LOG_BAT_MASK"
}

// Строка «Свой»: значения формы, если они не совпали ни с одним вариантом, с оценкой и отметками против лога.
// Те же значения — прежняя оценка
function step3_update_custom() {
    if (!step3.filled || (step3.candidates == null)) {
        step3.custom_row = null
        return
    }
    const values = step3_values_from_form()
    if (step3_match(values) != null) {
        step3.custom_row = null
        return
    }
    if ((step3.custom_row != null) && (candidate_key(step3.custom_row.values) === candidate_key(values))) {
        return
    }
    const log = step3.evaluations?.log ?? null
    const evaluation = (step3.ctx != null) ? evaluate_lowpass(values, step3.ctx) : null
    step3.custom_row = { id: "custom", title: "Свой", values: values, evaluation: evaluation, flags: (log != null) ? lowpass_flags(evaluation, log) : null }
}

// Строки таблицы: варианты и «Свой»
function step3_rows() {
    const rows = (step3.candidates ?? []).map((c) => ({ ...c, evaluation: step3.evaluations?.[c.id] ?? null, flags: step3.flags?.[c.id] ?? null }))
    if (step3.custom_row != null) {
        rows.push(step3.custom_row)
    }
    return rows
}

// Вариант «Как в логе» (lowpass_candidates ставит его первым и не выбрасывает при совпадениях)
function step3_log_candidate() {
    return step3.candidates.find((c) => c.id === "log")
}

// Вариант с теми же значениями, что values; null — таких нет
function step3_match(values) {
    const key = candidate_key(values)
    return (step3.candidates ?? []).find((c) => candidate_key(c.values) === key) ?? null
}

// Строка таблицы со значениями формы (вариант или «Свой»); null — форма не заполнена или варианты не посчитаны
function step3_form_row() {
    if (!step3.filled) {
        return null
    }
    const key = candidate_key(step3_values_from_form())
    return step3_rows().find((r) => candidate_key(r.values) === key) ?? null
}

// Выбранная строка таблицы — единственный источник выбора для «Применить вариант», вердикта и графиков:
// step3.selected_id, а если такой строки нет — рекомендованная или «Как в логе»; null — строк нет
function step3_selected_row() {
    const rows = step3_rows()
    return rows.find((r) => r.id === step3.selected_id) ?? rows.find((r) => r.id === (step3_recommended_id() ?? "log")) ?? null
}

// Рекомендуемая строка — «По размеру винта» или та, с которой он совпал (same_as); null без размера винта
function step3_recommended_id() {
    return (step3.candidates ?? []).find((c) => (c.id === "prop") || c.same_as.includes("prop"))?.id ?? null
}

// Пределы ускорения варианта по размеру винта: { from_log, formula: { r, p, y } в единицах лога }. Если вариант
// слился с другим (same_as), полей accel_from_log и formula_accel у оставшейся строки нет — они считаются заново
function step3_prop_accel(row) {
    if (row.id === "prop") {
        return { from_log: row.accel_from_log, formula: row.formula_accel }
    }
    const names = lowpass_accel_names(state.params)
    const cdegss = prop_values(step3.prop_in).accel_cdegss
    return {
        from_log: !lowpass_accel_is_default(lowpass_log_values(state.params), names),
        formula: { r: cdegss.r * names.scale / 100, p: cdegss.p * names.scale / 100, y: cdegss.y * names.scale / 100 },
    }
}

// ---------- Действия ----------
// Неожиданная ошибка действия — в консоль и вердикт «Ошибка шага 3: …»: step_try (сразу) и step_run (под оверлеем
// загрузки). Расчёт шага 1 досчитывается step_ensure_step1, его ошибка — в step3.error

// Пересчёт правок полей (step3_flush_edits) — сразу, в том же обработчике и без оверлея: «Применить вариант» и
// «Принять» досчитывают правки в обработчике click и тут же читают таблицу и форму, а оверлей съел бы щелчок по
// кнопке. Цена на тестовом логе (205 окон FFT): смена размера — оценка вариантов ≈ 0.1 с, а если выбрана строка
// «По размеру винта», ещё бодэ её новых значений для графика ≈ 0.08 с (смена 10 → 12″ целиком ≈ 0.2 с); новые
// значения формы — оценка строки «Свой» ≈ 0.03 с и её бодэ ≈ 0.08 с; повторные значения берут бодэ из кэша
// (step3_bode). Оценка и бодэ растут с числом окон FFT. Если нужен расчёт шага 1, он идёт под оверлеем (step_run),
// а кнопки тогда не действуют
function step3_run_edit(fn) {
    if (step1_ready()) {
        step_try(fn, "verdict3", "шага 3")
    } else {
        step_run(fn, "verdict3", "шага 3")
    }
}

// Показ шага: форма из лога с INS_GYRO_FILTER шага 2 (step3_initial_values; один раз на лог); варианты считаются заново,
// если сменились интервал, расчёт шага 1, принятый notch или размер винта
function step3_show() {
    if (state.log == null) {
        return
    }
    step_run(() => {
        if (!step3.form_built) {
            step3_build_form()
        }
        if (!step3.filled) {
            step3_fill_form(step3_initial_values())
            step3.filled = true
        }
        step3_render_prop()
        step3.error = step_ensure_step1()
        if (step3.error == null) {
            if (step3_stale()) {
                step3_compute()
            } else {
                step3_update_custom()
            }
        }
        step3_redraw_all()
        // Введённое учтено: отложенный пересчёт правок не нужен
        clearTimeout(step3.edit_timer)
        step3.edit_timer = null
        step3_edit_done()
    }, "verdict3", "шага 3")
}

// «Применить вариант»: значения выбранной строки в форму. Сначала досчитать правки полей (щелчок мог прийти раньше
// их пересчёта). Строка — та, что была выбрана до досчёта: досчёт правки формы выбирает строку формы («Свой»), а щелчок
// шёл по строке, выбранной до него (ревью задачи 7 этапа 4: «По размеру винта», правка FLTT и сразу «Применить» давали
// «Свой»). Если до досчёта был выбор по умолчанию (рекомендованная или «Как в логе»), — выбор по умолчанию после него:
// step3_compute переводит его на новую рекомендацию (пустой размер → 10″ и сразу «Применить» — «По размеру винта»).
// Значения строки берутся после досчёта, по её id: «По размеру винта» — для актуального размера.
// Ошибка — в вердикт (step3_run_edit: step_try; расчёт шага 1 не готов — step_run, и тогда досчёт шага 1 и вариантов,
// правок и применение идут одной функцией под оверлеем, как «Принять»; раньше досчёт правок уходил под оверлей сам,
// а применение, не дождавшись его, молча выходило — щелчок терялся)
function step3_apply() {
    if (!step3.filled) {
        return
    }
    step3_run_edit(() => {
        if (!step3_ready() || (step3.candidates == null)) {
            // Расчёт шага 1 или варианты не готовы: досчитать и показать (как step3_show), затем применять
            step3.error = step_ensure_step1()
            if ((step3.error == null) && step3_stale()) {
                step3_compute()
            }
            step3_redraw_all()
            if (!step3_ready() || (step3.candidates == null)) {
                return
            }
        }
        const previous = step3_selected_row()?.id ?? null
        const was_default = previous === (step3_recommended_id() ?? "log")
        step3_flush_edits(true)
        if (!step3_ready() || (step3.candidates == null)) {
            return
        }
        const id = ((previous == null) || was_default) ? (step3_recommended_id() ?? "log") : previous
        const row = step3_rows().find((r) => r.id === id) ?? step3_selected_row()
        if (row == null) {
            return
        }
        step3.selected_id = row.id
        step3_set_form_values(row.values)
        step3_flush_edits(true)
    })
}

// Поля, которые принять нельзя: пустые (значение неизвестно), отрицательные частоты и отрицательные пределы ускорения
// (у ATC_ACC*_MAX диапазон от 0: 0 — предел выключен) → текст отказа или null
function step3_accept_refusal(values) {
    const accel = lowpass_accel_names(state.params)
    const is_accel = (name) => [accel.r, accel.p, accel.y].includes(name)
    const empty = step3.form_names.filter((name) => !Number.isFinite(values[name]))
    const negative = step3.form_names.filter((name) => !is_accel(name) && (values[name] < 0))
    const negative_accel = step3.form_names.filter((name) => is_accel(name) && (values[name] < 0))
    const parts = []
    if (empty.length > 0) {
        parts.push("не заполнены поля: " + empty.join(", "))
    }
    if (negative.length > 0) {
        parts.push("отрицательные частоты: " + negative.join(", "))
    }
    if (negative_accel.length > 0) {
        parts.push("отрицательные пределы ускорения: " + negative_accel.join(", "))
    }
    return (parts.length > 0) ? "Принять нельзя — " + parts.join("; ") + "." : null
}

// «Принять»: значения формы, их метрики и отметки против лога, ключи расчёта и контекста оценки (context_key — по нему
// вердикт узнаёт устаревшее принятое; размер винта в него не входит) и отпечаток входов (step_inputs_key — для
// «устарело» сводки) — в итог мастера, затем шаг 4 (если доступен). Правки полей сначала досчитываются (щелчок мог
// прийти раньше их пересчёта). Пустые поля, отрицательные частоты и пределы ускорения принять нельзя (step3_accept_refusal)
function step3_accept() {
    step3_flush_edits(true)
    step_run(() => {
        if (step3.filled) {
            step3.error = step_ensure_step1()
        }
        if (!step3.filled || (step3.error != null)) {
            step3_redraw_all()
            return
        }
        if (step3_stale()) {
            step3_compute()
        }
        const values = step3_values_from_form()
        const refusal = step3_accept_refusal(values)
        if (refusal != null) {
            step_verdict("verdict3", "fail", refusal)
            return
        }
        step3_update_custom()
        const row = step3_form_row()
        const log = step3.evaluations?.log ?? null
        const compared = (row?.evaluation != null) && (log != null)
        state.steps[3] = {
            accepted: values,
            candidate_id: ((row != null) && (row.id !== "custom")) ? row.id : "custom",
            prop_in: step3.prop_in,
            metrics: compared ? { current: step3_metrics_summary(row.evaluation), log: step3_metrics_summary(log) } : null,
            flags: compared ? (row.flags ?? lowpass_flags(row.evaluation, log)) : null,
            calc_key: step3.key,
            context_key: step3.context_key,
            inputs: step_inputs_key(3),
            evaluated_at: Date.now(),
        }
        step3_redraw_all()
        set_step(4)
    }, "verdict3", "шага 3")
}

// ---------- Отрисовка ----------

function step3_redraw_all() {
    step3_mark_changed()
    const ready = step3_ready() && (step3.candidates != null)
    document.getElementById("lpf_accept").disabled = !(ready && step3.filled)
    if (!ready) {
        for (const id of ["memory3", "candidates3", "candidates3_note", "metrics3", "warnings3"]) {
            document.getElementById(id).hidden = true
        }
        document.getElementById("cand3_apply").disabled = true
        step_verdict("verdict3", "fail", step3.error ?? "Расчёт спектра шага 1 не готов")
        step3_clear_plots()
        return
    }
    step3_render_candidates()
    step3_render_metrics()
    step3_render_warnings()
    step3_render_verdict()
    step3_redraw_plots()
}

// Почему у оси нет шума D: «D выкл.» (Kd = 0), «нет Kd» (параметра нет в логе); null — шум D есть
function step3_dterm_absent(e, axis) {
    if (e.kd[axis] === 0) {
        return "D выкл."
    }
    if (e.dterm[axis] == null) {
        return "нет Kd"
    }
    return null
}

// Ячейка шума к логу: own и base — уровни варианта и лога, дБ; у строки лога — «база»; flagged — отметка «шумнее
// лога» (красный), ниже лога — зелёный
function step3_noise_cell(own, base, is_log, flagged) {
    const level = (v) => Number.isFinite(v) ? v.toFixed(2) + " дБ" : "не посчитан"
    if (is_log) {
        return step_cell("база", null, "", "база сравнения, уровень " + level(own))
    }
    const delta = (Number.isFinite(own) && Number.isFinite(base)) ? own - base : NaN
    const cls = flagged ? "worse" : ((delta < -0.005) ? "better" : "")
    return step_cell(Number.isFinite(delta) ? step_signed(delta, 2) : "не оценён", null, cls, "уровень " + level(own) + ", у лога " + level(base))
}

// Ячейка задержки пути path оси axis на lowpass_lag_hz(): мс и разница к логу; остальные частоты — в подсказке.
// Путь D оси с выключенным D (Kd = 0) не сравнивается — «—»
function step3_lag_cell(e, log, axis, path, is_log, flagged) {
    if ((path === "D") && (e.kd[axis] === 0)) {
        return step_cell("—", null, "", "D выключен")
    }
    const lag = (evaluation, f) => evaluation?.lag_ms?.[axis]?.[path]?.[f]
    const hz = lowpass_lag_hz()
    const title = step3_other_lags_text(e, is_log ? null : log, axis, path)
    const own = lag(e, hz)
    if (!Number.isFinite(own)) {
        return step_cell("не оценена", null, flagged ? "worse" : "", title)
    }
    const delta = own - lag(log, hz)
    const cls = flagged ? "worse" : ((delta < -0.005) ? "better" : "")
    return step_cell(own.toFixed(2), is_log ? null : (Number.isFinite(delta) ? step_signed(delta, 2) : "—"), cls, title)
}

// Задержка пути path оси axis на частотах, кроме lowpass_lag_hz(), словами: «на 10 Гц 8.50 мс (к логу -0.28 мс)»;
// без log — без разницы к логу
function step3_other_lags_text(e, log, axis, path) {
    const lag = (evaluation, f) => evaluation?.lag_ms?.[axis]?.[path]?.[f]
    const hz = lowpass_lag_hz()
    return lowpass_rules.lag_freqs_hz.filter((f) => f !== hz).map((f) => "на " + f + " Гц " +
        (Number.isFinite(lag(e, f)) ? lag(e, f).toFixed(2) + " мс" : "не оценена") +
        ((log != null) ? " (к логу " + step3_delta_text(lag(e, f), lag(log, f), 2, "мс") + ")" : "")).join("; ")
}

// Пояснение под названием строки: с какими вариантами совпала, откуда пределы ускорения
function step3_row_note(row) {
    const titles = { log: "как в логе", prop: "по размеру винта (" + step3.prop_in + "″)", half: "лог + правило /2" }
    const notes = []
    if ((row.same_as ?? []).length > 0) {
        notes.push("то же, что " + row.same_as.map((id) => titles[id]).join(", "))
    }
    if (row.accel_from_log) {
        notes.push("пределы ускорения — из лога")
    }
    return notes.map((note) => '<small>' + html_escape(note) + '</small>').join("")
}

// Таблица вариантов: значения, шум гироскопа и D к логу, задержки путей P и D на 30 Гц, отметки
function step3_render_candidates() {
    const box = document.getElementById("candidates3")
    const note = document.getElementById("candidates3_note")
    const axes = Object.keys(lowpass_pid_axes)
    const hz = lowpass_lag_hz()
    const log = step3.evaluations?.log ?? null
    const recommended_id = step3_recommended_id()

    // Две строки заголовка: над группами столбцов — общая подпись, остальные столбцы — на обе строки
    let head = '<tr><th rowspan="2" aria-label="Выбор"></th><th rowspan="2">Вариант</th><th rowspan="2">INS_GYRO_FILTER</th>' +
        '<th class="group" colspan="' + axes.length + '">FLTD / FLTT</th><th class="group" colspan="' + (1 + axes.length) + '">Шум к логу, дБ</th>' +
        '<th class="group" colspan="' + (2 * axes.length) + '">Задержка на ' + hz + ' Гц, мс</th><th rowspan="2">Оценка</th></tr><tr>'
    for (const axis of axes) {
        head += '<th>' + step3_axis_names[axis].nom + '</th>'
    }
    head += '<th>гироскоп<small>' + lowpass_rules.band_hz.join("–") + ' Гц</small></th>'
    for (const axis of axes) {
        head += '<th>D<small>' + step3_axis_names[axis].nom + '</small></th>'
    }
    for (const path of ["P", "D"]) {
        for (const axis of axes) {
            head += '<th>путь ' + path + '<small>' + step3_axis_names[axis].nom + '</small></th>'
        }
    }
    head += '</tr>'
    box.querySelector("thead").innerHTML = head

    // Выбор — один источник: step3.selected_id, приведённый к существующей строке
    const rows = step3_rows()
    step3.selected_id = step3_selected_row()?.id ?? null
    const selected = step3.selected_id
    // Элемент таблицы с фокусом (радио после ухода из поля по Tab) пересоздаётся — фокус вернуть: радио группы —
    // на отмеченное (иначе пробел выбрал бы другую строку), прочее — по id
    const active = box.contains(document.activeElement) ? document.activeElement : null
    const focused = (active == null) ? "" : ((active.name === "cand3") ? "cand3_" + selected : active.id)
    let body = ""
    for (const row of rows) {
        const e = row.evaluation
        const is_log = row.id === "log"
        const id_attr = html_escape("cand3_" + row.id)
        const v = row.values
        body += '<tr' + ((row.id === recommended_id) ? ' class="recommended"' : '') + '>'
        body += '<td><input type="radio" name="cand3" id="' + id_attr + '" value="' + html_escape(row.id) + '"' + ((row.id === selected) ? ' checked' : '') + '></td>'
        body += '<td><label for="' + id_attr + '">' + html_escape(row.title) + '</label>' + step3_row_note(row) + '</td>'
        body += '<td class="num">' + html_escape(step_value_text(v.INS_GYRO_FILTER)) + '</td>'
        for (const axis of axes) {
            const param = lowpass_pid_axes[axis].param
            body += '<td class="num">' + html_escape(step_value_text(v["ATC_RAT_" + param + "_FLTD"]) + " / " + step_value_text(v["ATC_RAT_" + param + "_FLTT"])) + '</td>'
        }
        if ((e == null) || (log == null)) {
            body += '<td colspan="' + (1 + 3 * axes.length) + '">оценки нет</td>'
        } else {
            const flags = row.flags
            body += step3_noise_cell(e.gyro.band_dB, log.gyro.band_dB, is_log, flags?.noisier.includes("gyro") ?? false)
            for (const axis of axes) {
                const absent = step3_dterm_absent(e, axis)
                body += (absent != null) ? step_cell(absent, null, "", null)
                                         : step3_noise_cell(e.dterm[axis].dB, log.dterm[axis]?.dB, is_log, flags?.noisier.includes(axis) ?? false)
            }
            for (const path of ["P", "D"]) {
                for (const axis of axes) {
                    const slower = flags?.slower.some((s) => (s.axis === axis) && (s.path === path)) ?? false
                    body += step3_lag_cell(e, log, axis, path, is_log, slower)
                }
            }
        }
        const flags_text = ((e != null) && (log != null)) ? step3_flags_text(row.flags, e, log) : ""
        let verdict
        if (row.id === recommended_id) {
            verdict = '<span class="tag">рекомендуется</span>' + ((flags_text !== "") ? '<small>' + html_escape(flags_text) + '</small>' : "")
        } else if (is_log) {
            verdict = "текущие настройки"
        } else if (row.id === "custom") {
            verdict = "ручные значения" + ((flags_text !== "") ? '<small>' + html_escape(flags_text) + '</small>' : "")
        } else {
            verdict = html_escape((flags_text !== "") ? flags_text : "без отметок")
        }
        body += '<td>' + verdict + '</td></tr>'
    }
    box.querySelector("tbody").innerHTML = body
    box.hidden = false
    if (focused !== "") {
        (document.getElementById(focused) ?? box.querySelector("input[name=cand3]:checked"))?.focus({ preventScroll: true })
    }
    document.getElementById("cand3_apply").disabled = false

    const loop_rate = step3.ctx?.loop_rate ?? step3.base.SCHED_LOOP_RATE
    const d_top = Math.min(lowpass_rules.band_hz[1], loop_rate / 2)
    const gyro = state.gyro
    note.textContent = (prop_valid(step3.prop_in) ? "" : "Введите размер винта — появится вариант по формуле. ") +
        "Шум гироскопа — средняя мощность X+Y+Z после фильтров в полосе " + lowpass_rules.band_hz.join("–") + " Гц, как на шаге 2. " +
        "Шум D — модель D-составляющей крена и тангажа: спектр гироскопа после фильтров, свёрнутый к половине частоты контура " +
        "(SCHED_LOOP_RATE " + step_value_text(loop_rate) + " → " + step_value_text(loop_rate / 2) + " Гц), × производная × FLTE × FLTD, в полосе " +
        lowpass_rules.band_hz[0] + "–" + step_value_text(d_top) + " Гц; Kd из лога в сравнении сокращается. Обе — разница к «Как в логе». " +
        "Задержка — путь P (фильтр гироскопа, notch и FLTE) и путь D (ещё и FLTD) на " + hz + " Гц, мелкой строкой — разница к логу, " +
        "на остальных частотах — во всплывающей подсказке. Зелёный — лучше лога, красный — отметка: шумнее больше чем на " +
        lowpass_rules.max_noise_increase_dB + " дБ или медленнее больше чем на " + lowpass_rules.max_lag_increase_ms + " мс. " +
        "FLTT стоит на цели и в метрики не входит; рыскание и пределы ускорения — по правилам, без метрик. " +
        "Notch — " + ((state.steps[2] != null) ? "принятый на шаге 2" : "из лога (шаг 2 не принят)") +
        "; гироскоп " + ((gyro.primary ?? gyro.first_gyro) + 1) + " до фильтров, интервал " + state.settings.start + "–" + state.settings.end + " с."
    note.hidden = false
}

// Плитки метрик значений формы против лога: шум гироскопа, шум D крена и тангажа, задержка путей P и D
function step3_render_metrics() {
    const box = document.getElementById("metrics3")
    const row = step3_form_row()
    const log = step3.evaluations?.log ?? null
    if ((row == null) || (row.evaluation == null) || (log == null)) {
        box.hidden = true
        return
    }
    const e = row.evaluation
    const flags = row.flags
    const hz = lowpass_lag_hz()
    const mod = (flagged, delta) => flagged ? "bad" : ((delta < -0.005) ? "good" : null)
    const tiles = [step_tile("Значения", row.title, step3_short_values(row.values), null)]

    const gyro_delta = e.gyro.band_dB - log.gyro.band_dB
    tiles.push(step_tile("Шум гироскопа " + lowpass_rules.band_hz.join("–") + " Гц", step3_delta_text(e.gyro.band_dB, log.gyro.band_dB, 2, "дБ"),
                         "к логу; уровень " + (Number.isFinite(e.gyro.band_dB) ? e.gyro.band_dB.toFixed(2) + " дБ" : "не посчитан"),
                         mod(flags?.noisier.includes("gyro"), gyro_delta)))
    for (const axis of Object.keys(lowpass_pid_axes)) {
        const absent = step3_dterm_absent(e, axis)
        const key = "Шум D " + step3_axis_names[axis].gen
        if (absent != null) {
            tiles.push(step_tile(key, (absent === "нет Kd") ? "нет Kd в логе" : "D выключен", "не сравнивается", null))
            continue
        }
        const own = e.dterm[axis].dB
        const base = log.dterm[axis]?.dB
        tiles.push(step_tile(key, step3_delta_text(own, base, 2, "дБ"), "к логу", mod(flags?.noisier.includes(axis), own - base)))
    }
    for (const path of ["P", "D"]) {
        for (const axis of Object.keys(lowpass_pid_axes)) {
            if ((path === "D") && (e.kd[axis] === 0)) {
                tiles.push(step_tile("Путь D " + step3_axis_names[axis].gen, "—", "D выключен", null))
                continue
            }
            const lag = (evaluation, f) => evaluation.lag_ms[axis][path][f]
            const own = lag(e, hz)
            const slower = flags?.slower.some((s) => (s.axis === axis) && (s.path === path)) ?? false
            tiles.push(step_tile("Путь " + path + " " + step3_axis_names[axis].gen, Number.isFinite(own) ? own.toFixed(2) + " мс" : "не оценена",
                                 "на " + hz + " Гц, к логу " + step3_delta_text(own, lag(log, hz), 2, "мс") + "; " + step3_other_lags_text(e, log, axis, path),
                                 mod(slower, own - lag(log, hz))))
        }
    }
    box.innerHTML = tiles.join("")
    box.hidden = false
}

// Заметки под вердиктом: чего модель не учитывает (lowpass_model_warnings), INS_GYRO_FILTER шага 2 не в форме
// (step3_step2_gyro_note), оси без Kd или с выключенным D, предупреждения фильтров гироскопной части (в том числе
// срез INS_GYRO_FILTER, ограниченный прошивкой, — lowpass_gyro_cutoff)
function step3_render_warnings() {
    const box = document.getElementById("warnings3")
    const lines = [...lowpass_model_warnings(state.params)]
    const gyro_note = step3_step2_gyro_note(step3.filled ? step3_values_from_form().INS_GYRO_FILTER : NaN)
    if (gyro_note != null) {
        lines.push(gyro_note)
    }
    const kd = step3_kd()
    for (const [axis, names] of Object.entries(lowpass_pid_axes)) {
        const name = "ATC_RAT_" + names.param + "_D"
        if (kd[axis] == null) {
            lines.push("Нет " + name + " в логе — неполные данные: шум D " + step3_axis_names[axis].gen + " не оценивается.")
        } else if (kd[axis] === 0) {
            lines.push("D " + step3_axis_names[axis].gen + " выключен (" + name + " = 0): шум D и путь D " + step3_axis_names[axis].gen + " не сравниваются.")
        }
    }
    const warnings = new Set()
    for (const row of [{ evaluation: step3.evaluations?.log ?? null }, step3_form_row()]) {
        for (const warning of row?.evaluation?.warnings ?? []) {
            warnings.add(warning)
        }
    }
    if (warnings.size > 0) {
        lines.push("Предупреждения фильтров: " + [...warnings].join(" · "))
    }
    box.innerHTML = lines.map(html_escape).join("<br>")
    box.hidden = lines.length == 0
}

// Вердикт: принятые значения (всегда первыми; принят не рекомендованный вариант — какой рекомендовался: «Принять» без
// «Применить вариант» принимает значения лога, и это легко не заметить); без размера винта — просьба ввести его;
// рекомендация «По размеру винта» — что меняется против лога и метрики, с отметками — что хуже; пределы ускорения из
// лога — формула для справки; notch из лога, если шаг 2 не принят. Под ним — строка сравнения с прошлым проходом
// (memory_show): при любом исходе вердикта
function step3_render_verdict() {
    memory_show(3)
    const base_note = (state.steps[2] == null) ? " Notch — из лога (шаг 2 не принят)." : ""
    const accepted = state.steps[3]
    if ((accepted != null) && step3.filled && (candidate_key(accepted.accepted) === candidate_key(step3_values_from_form()))) {
        // Принятое считалось на другом контексте оценки — интервал, расчёт шага 1, notch-база (step3_context_key) — его
        // метрики устарели. Размер винта в контекст не входит: от него зависят варианты и рекомендация, а принятые
        // значения, их метрики и отметки — нет (и сводка, step_accepted_stale, его не учитывает)
        if (accepted.context_key !== step3_context_key()) {
            step_verdict("verdict3", "warn", "Принято раньше для другого интервала, окна FFT или notch — проверьте и примите заново." + base_note)
            return
        }
        const match = step3_match(accepted.accepted)
        const name = (match != null) ? "«" + match.title + "»" : "свои значения"
        const recommended_id = step3_recommended_id()
        const recommended = ((recommended_id != null) && (recommended_id !== match?.id)) ? step3_rows().find((r) => r.id === recommended_id) : null
        const advice = (recommended != null) ? " Рекомендовался «" + recommended.title + "»." : ""
        const metrics = accepted.metrics
        const tail = (metrics != null) ? " — " + step3_summary_text(metrics.current, metrics.log) + " (к логу)" : " (без сравнения с логом)"
        if (step3_flagged(accepted.flags)) {
            // name здесь начинает предложение: «свои значения» — с заглавной
            const sentence = name.charAt(0).toUpperCase() + name.slice(1)
            step_verdict("verdict3", "warn", "Принято, но хуже лога: " + step3_flags_text(accepted.flags, metrics.current, metrics.log) + ". " + sentence + tail + "." + advice + base_note)
        } else {
            step_verdict("verdict3", "ok", "Принято: " + name + tail + "." + advice + base_note)
        }
        return
    }

    const log = step3.evaluations?.log ?? null
    const no_compare = step3_no_compare_reason()
    const compare_note = (no_compare != null) ? " Сравнить варианты с логом нельзя: " + no_compare + "." : ""
    const recommended_id = step3_recommended_id()
    if (recommended_id == null) {
        step_verdict("verdict3", "warn", "Введите размер винта: в логе его нет, а без него нет варианта по формуле Mission Planner и рекомендации." + compare_note + base_note)
        return
    }
    const row = step3_rows().find((r) => r.id === recommended_id)
    const accel = step3_prop_accel(row)
    const names = lowpass_accel_names(state.params)
    const accel_text = accel.from_log ? " Пределы ускорения оставлены из лога (похоже на AutoTune), по формуле было бы " +
        [["r", names.r], ["p", names.p], ["y", names.y]].map(([k, n]) => n + " " + step_value_text(accel.formula[k])).join(", ") + " " + names.units + "." : ""
    const prop_title = "по размеру винта (" + step3.prop_in + "″)"
    if (recommended_id === "log") {
        // Форма уже ушла от лога — предложить вернуть его значения
        const back = (step3_form_row()?.id === "log") ? "" : " В форме сейчас другие значения — чтобы вернуть значения лога, выберите «Как в логе» и нажмите «Применить вариант»."
        step_verdict("verdict3", "ok", "Значения " + prop_title + " совпадают с логом — менять нечего." + back + accel_text + compare_note + base_note)
        return
    }

    const log_values = lowpass_log_values(state.params)
    const changes = step3.form_names.filter((n) => row.values[n] !== log_values[n]).map((n) => n + " " + step_value_text(log_values[n]) + " → " + step_value_text(row.values[n]))
    let status = "ok"
    let worse = ""
    let numbers = compare_note
    if ((log != null) && (row.evaluation != null)) {
        const summary = step3_summary_text(row.evaluation, log)
        numbers = " " + summary.charAt(0).toUpperCase() + summary.slice(1) + " (к логу)."
        if (step3_flagged(row.flags)) {
            status = "warn"
            worse = ", но он хуже лога: " + step3_flags_text(row.flags, row.evaluation, log)
        }
    } else {
        status = "warn"
    }
    let action
    if (step3_form_row()?.id === recommended_id) {
        action = "Значения уже в форме — нажмите «Принять»."
    } else if (step3_selected_row()?.id === recommended_id) {
        action = "Он выбран — нажмите «Применить вариант», затем «Принять»."
    } else {
        action = "Выберите его в таблице и нажмите «Применить вариант», затем «Принять»."
    }
    step_verdict("verdict3", status, "Рекомендуется «" + row.title + "»" + worse + ". Меняется: " + changes.join(", ") + "." + numbers + accel_text + " " + action + base_note)
}

// ---------- Графики ----------
// Реестр plots.js: графики регистрируются один раз (step3_setup_plots в step3_init), дальше данные меняются на месте
// и render_plot; цвета — только в хуках on_theme. «Выбранный» — step3_selected_row(): строка с отмеченным радио
// или «Свой» после правки формы, в легенде всех графиков — «выбранный: <строка>». Без оценки лога (нет данных
// гироскопа до фильтров, ошибка, новый лог) графики пустые

// Индекс трассы спектра гироскопа: тип t (spec3_types), ось a (SPEC_AXES)
function spec3_trace_index(t, a) {
    return t * SPEC_AXES.length + a
}

// Индекс трассы D-составляющей: ось a (ключи lowpass_pid_axes), тип t (step3_trace_types)
function dterm3_trace_index(a, t) {
    return a * step3_trace_types.length + t
}

// Индекс трассы бодэ: подграфик s (bode3_parts), путь p (bode3_paths), тип t (step3_trace_types)
function bode3_trace_index(s, p, t) {
    return (s * bode3_paths.length + p) * step3_trace_types.length + t
}

// Цвета спектра гироскопа: ось — цвет оси палитры (штрих — по типу, задан при регистрации); вертикали
// INS_GYRO_FILTER — цвет текста
function spec3_theme(palette, data, layout) {
    for (let t = 0; t < spec3_types.length; t++) {
        for (let a = 0; a < SPEC_AXES.length; a++) {
            data[spec3_trace_index(t, a)].line.color = palette.axis[SPEC_AXES[a]]
        }
    }
    for (const shape of layout.shapes) {
        shape.line.color = palette.ink
    }
}

// Цвета D-составляющей: крен — цвет оси X, тангаж — оси Y (оси гироскопа из lowpass_pid_axes)
function dterm3_theme(palette, data, layout) {
    const axes = Object.keys(lowpass_pid_axes)
    for (let a = 0; a < axes.length; a++) {
        for (let t = 0; t < step3_trace_types.length; t++) {
            data[dterm3_trace_index(a, t)].line.color = palette.axis[lowpass_pid_axes[axes[a]].gyro]
        }
    }
}

// Цвета бодэ: путь P — первый цвет палитры, путь D — второй; вертикали частот задержки — цвет текста
function bode3_theme(palette, data, layout) {
    for (let s = 0; s < bode3_parts.length; s++) {
        for (let p = 0; p < bode3_paths.length; p++) {
            for (let t = 0; t < step3_trace_types.length; t++) {
                data[bode3_trace_index(s, p, t)].line.color = palette.series[p]
            }
        }
    }
    for (const shape of layout.shapes) {
        shape.line.color = palette.ink
    }
}

// Вертикаль на частоте x (положение и видимость меняет перерисовка): xref/yref — оси подграфика, dash — штрих.
// На логарифмической оси x — в герцах: Plotly переводит положение фигур в логарифм сам. Слой — над трассами: слой
// "below" лежит под сеткой, а на логарифмической оси линии сетки стоят ровно на 10 и 30 Гц и закрывают вертикаль
// (слой "between" Plotly 2.32 не рисует)
function step3_plot_vline(name, xref, yref, x, dash) {
    return { type: "line", name: name, visible: false, layer: "above", xref: xref, yref: yref, x0: x, x1: x, y0: 0, y1: 1, opacity: 0.8,
             line: { width: 1, dash: dash } }
}

function step3_setup_plots() {
    const hover = "<extra></extra>%{meta}<br>%{x:.1f} Гц<br>%{y:.2f} дБ"
    const margin = { b: 50, l: 60, r: 20, t: 20 }

    // Спектр гироскопа после фильтров: тип × ось X/Y/Z; «до фильтров» по умолчанию только в легенде
    const spec_data = []
    for (let t = 0; t < spec3_types.length; t++) {
        const type = spec3_types[t]
        for (let a = 0; a < SPEC_AXES.length; a++) {
            spec_data[spec3_trace_index(t, a)] = {
                mode: "lines",
                name: SPEC_AXES[a].toUpperCase(),
                meta: step3_type_names[type] + " · " + SPEC_AXES[a].toUpperCase(),
                legendgroup: type,
                legendgrouptitle: { text: step3_type_names[type] },
                line: { width: 1.2, dash: step3_dash[type] },
                visible: false,
                hovertemplate: hover,
                x: [],
                y: [],
            }
        }
    }
    register_plot("Spectrum3", spec_data, {
        // Начальный вид — полоса шума 0…400 Гц; полный — двойным щелчком (Plotly: сброс к начальному, затем autorange)
        xaxis: { ...plot_axis("Частота, Гц"), range: [0, lowpass_rules.band_hz[1]] },
        yaxis: plot_axis("Амплитуда, дБ"),
        showlegend: true,
        legend: { groupclick: "toggleitem" },
        // INS_GYRO_FILTER лога — пунктир, выбранного — сплошная (name — тип)
        shapes: step3_trace_types.map((type) => step3_plot_vline(type, "x", "paper", 0, step3_dash[type])),
        margin: margin,
    }, { on_theme: spec3_theme })

    // Спектр D-составляющей: ось крен/тангаж × тип, до loop_rate / 2
    const axes = Object.keys(lowpass_pid_axes)
    const dterm_data = []
    for (let a = 0; a < axes.length; a++) {
        const name = step3_axis_names[axes[a]].nom
        for (let t = 0; t < step3_trace_types.length; t++) {
            const type = step3_trace_types[t]
            dterm_data[dterm3_trace_index(a, t)] = {
                mode: "lines",
                name: step3_type_names[type],
                meta: name + " · " + step3_type_names[type],
                legendgroup: axes[a],
                legendgrouptitle: { text: name.charAt(0).toUpperCase() + name.slice(1) },
                line: { width: 1.2, dash: step3_dash[type] },
                visible: false,
                hovertemplate: hover,
                x: [],
                y: [],
            }
        }
    }
    register_plot("DTerm3", dterm_data, {
        xaxis: plot_axis("Частота, Гц"),
        yaxis: plot_axis("D-составляющая, дБ (отн.)"),
        showlegend: true,
        legend: { groupclick: "toggleitem" },
        margin: margin,
    }, { on_theme: dterm3_theme })

    // Бодэ путей P и D: два подграфика друг под другом (амплитуда сверху, фаза снизу), общая логарифмическая ось
    // частот от bode3_min_hz до loop_rate / 2 (autorange по данным). В легенде — трассы амплитуды; фаза в той же
    // группе и включается вместе с ними
    const bode_data = []
    for (let s = 0; s < bode3_parts.length; s++) {
        const part = bode3_parts[s]
        for (let p = 0; p < bode3_paths.length; p++) {
            for (let t = 0; t < step3_trace_types.length; t++) {
                const type = step3_trace_types[t]
                const name = "путь " + bode3_paths[p] + " · " + step3_type_names[type]
                bode_data[bode3_trace_index(s, p, t)] = {
                    mode: "lines",
                    name: name,
                    meta: name,
                    legendgroup: bode3_paths[p] + ":" + type,
                    showlegend: s == 0,
                    xaxis: part.xaxis,
                    yaxis: part.yaxis,
                    line: { width: 1.5, dash: step3_dash[type] },
                    visible: false,
                    hovertemplate: "<extra></extra>%{meta}<br>%{x:.2f} Гц<br>" + part.hover,
                    x: [],
                    y: [],
                }
            }
        }
    }
    // Вертикали на частотах задержки таблицы (10 и 30 Гц) в обоих подграфиках
    const bode_lines = []
    for (const f of lowpass_rules.lag_freqs_hz) {
        for (const part of bode3_parts) {
            bode_lines.push(step3_plot_vline("lag" + f, part.xaxis, part.yaxis + " domain", f, "dot"))
        }
    }
    register_plot("Bode3", bode_data, {
        xaxis: plot_axis(null, "log"),
        xaxis2: { ...plot_axis("Частота, Гц", "log"), matches: "x" },
        yaxis: { ...plot_axis("Амплитуда, дБ"), domain: [0.52, 1] },
        yaxis2: { ...plot_axis("Фаза, °"), domain: [0, 0.48] },
        showlegend: true,
        grid: { rows: 2, columns: 1, pattern: "independent" },
        shapes: bode_lines,
        margin: margin,
    }, { on_theme: bode3_theme })
}

// Графикам есть что рисовать: расчёт шага 1 актуален и у «Как в логе» есть оценка (данные гироскопа до фильтров);
// оценки остальных строк считаются на том же контексте
function step3_plots_ready() {
    return step3_ready() && (step3.evaluations?.log != null)
}

// Пустые графики шага: без расчёта (нет данных гироскопа, ошибка, новый лог) — трассы и вертикали скрыты
function step3_clear_plots() {
    for (const id of ["Spectrum3", "DTerm3", "Bode3"]) {
        plot_clear(id)
    }
    for (const id of ["dterm3_absent", "bode3_absent"]) {
        document.getElementById(id).hidden = true
    }
}

// Графики выбранной строки (step3_selected_row) против лога; без оценки лога — пустые
function step3_redraw_plots() {
    const row = step3_selected_row()
    if (!step3_plots_ready() || (row == null)) {
        step3_clear_plots()
        return
    }
    const log = step3.evaluations.log
    spec3_redraw(row, log)
    dterm3_redraw(row, log)
    bode3_redraw()
}

// Подпись выбранной строки в легенде и подсказках всех графиков шага
function step3_selected_title(row) {
    return step3_type_names.sel + ": " + row.title
}

// D оси выключен: kd — Kd оси из оценки лога (evaluate_lowpass → kd). Текст причины, если Kd = 0, иначе null. Только
// тогда в бодэ нет пути D: задержка пути D от Kd не зависит, и без Kd в логе её считают таблица и lowpass_flags
function step3_d_off_reason(axis, kd) {
    return (kd === 0) ? "D выключен (ATC_RAT_" + lowpass_pid_axes[axis].param + "_D = 0)" : null
}

// Почему у оси нет спектра D-составляющей: D выключен (step3_d_off_reason) или Kd нет в логе; null — Kd есть
function step3_d_absent_reason(axis, kd) {
    return step3_d_off_reason(axis, kd) ?? (Number.isFinite(kd) ? null : "в логе нет ATC_RAT_" + lowpass_pid_axes[axis].param + "_D")
}

// Подпись-причина под графиком: пустой список — подпись скрыта
function step3_absent_note(id, lines) {
    const note = document.getElementById(id)
    note.textContent = lines.join(" ")
    note.hidden = lines.length == 0
}

// Спектр гироскопа после фильтров (evaluate_lowpass → gyro.spectrum и gyro.pre_spectrum, дБ, первичный гироскоп):
// до фильтров, как в логе, выбранная строка; вертикали на INS_GYRO_FILTER лога и выбранной строки (фильтр
// выключен или поле пустое — без вертикали)
function spec3_redraw(row, log) {
    const p = plot("Spectrum3")
    const sources = { pre: log.gyro.pre_spectrum, log: log.gyro.spectrum, sel: row.evaluation?.gyro.spectrum ?? null }
    for (let t = 0; t < spec3_types.length; t++) {
        const type = spec3_types[t]
        const spectrum = sources[type]
        for (let a = 0; a < SPEC_AXES.length; a++) {
            const trace = p.data[spec3_trace_index(t, a)]
            trace.x = spectrum?.bins ?? []
            trace.y = spectrum?.[SPEC_AXES[a]] ?? []
            if (type === "sel") {
                trace.meta = step3_selected_title(row) + " · " + SPEC_AXES[a].toUpperCase()
                trace.legendgrouptitle.text = step3_selected_title(row)
            }
            plot_trace_visibility(trace, (type === "pre") ? "legendonly" : true)
        }
    }
    const hz = { log: log.values.INS_GYRO_FILTER, sel: row.values.INS_GYRO_FILTER }
    for (const shape of p.layout.shapes) {
        const f = hz[shape.name]
        shape.visible = Number.isFinite(f) && (f > 0)
        shape.x0 = shape.visible ? f : 0
        shape.x1 = shape.x0
    }
    render_plot("Spectrum3")
}

// Спектр D-составляющей крена и тангажа (evaluate_lowpass → dterm, дБ с Kd лога, бины 0…loop_rate / 2): лог и
// выбранная строка. У оси без Kd в логе или с Kd = 0 трасс нет — причина в подписи #dterm3_absent
function dterm3_redraw(row, log) {
    const p = plot("DTerm3")
    const axes = Object.keys(lowpass_pid_axes)
    const absent = []
    for (let a = 0; a < axes.length; a++) {
        const axis = axes[a]
        for (let t = 0; t < step3_trace_types.length; t++) {
            const type = step3_trace_types[t]
            const e = (type === "log") ? log : row.evaluation
            const dterm = e?.dterm?.[axis] ?? null
            const trace = p.data[dterm3_trace_index(a, t)]
            trace.x = (dterm != null) ? e.dterm.bins : []
            trace.y = (dterm != null) ? dterm.spectrum : []
            if (type === "sel") {
                trace.name = step3_selected_title(row)
                trace.meta = step3_axis_names[axis].nom + " · " + step3_selected_title(row)
            }
            plot_trace_visibility(trace, true)
        }
        const reason = step3_d_absent_reason(axis, log.kd[axis])
        if (reason != null) {
            absent.push("Трассы " + step3_axis_names[axis].gen + " нет: " + reason + ".")
        }
    }
    step3_absent_note("dterm3_absent", absent)
    render_plot("DTerm3")
}

// Бодэ для графика от bode3_min_hz (логарифмическая ось 0 Гц не покажет, а ниже 1 Гц фильтры не действуют):
// lowpass_bode → то же строение с массивами от первой частоты не ниже bode3_min_hz; null — null
function step3_bode_trim(bode) {
    if (bode == null) {
        return null
    }
    const found = bode.freq.findIndex((f) => f >= bode3_min_hz)
    const from = (found >= 0) ? found : bode.freq.length
    const cut = (part) => ({ amp_dB: part.amp_dB.slice(from), phase_deg: part.phase_deg.slice(from) })
    const trimmed = { freq: bode.freq.slice(from), gyro: cut(bode.gyro) }
    for (const axis of Object.keys(lowpass_pid_axes)) {
        trimmed[axis] = { P: cut(bode[axis].P), D: cut(bode[axis].D) }
    }
    return trimmed
}

// Бодэ значений values для графика на контексте оценки расчёта, обрезанное от bode3_min_hz (step3_bode_trim) один раз
// при записи в кэш: у трасс остаются те же массивы, и Plotly.react не пересчитывает неизменённые трассы. lowpass_bode
// дорогой (≈ 80 мс на тестовом логе, растёт с числом окон FFT), поэтому кэш по candidate_key значений: повторный
// выбор строки и смена размера винта (бодэ от него не зависит) берут готовое. Кэш сбрасывается со сменой контекста
// оценки (step3.context_key, объект данных гироскопа), а в нём остаются только значения строк таблицы — правки формы
// его не раздувают. null — нет контекста оценки
function step3_bode(values) {
    if (step3.ctx == null) {
        return null
    }
    const cache = step3.bode_cache
    if ((cache == null) || (cache.context !== step3.context_key) || (cache.gyro !== step3.gyro_ref)) {
        step3.bode_cache = { context: step3.context_key, gyro: step3.gyro_ref, map: new Map() }
    }
    const map = step3.bode_cache.map
    const key = candidate_key(values)
    if (!map.has(key)) {
        const live = new Set(step3_rows().map((r) => candidate_key(r.values)))
        for (const old of map.keys()) {
            if (!live.has(old)) {
                map.delete(old)
            }
        }
        map.set(key, step3_bode_trim(lowpass_bode(values, step3.ctx)))
    }
    return map.get(key)
}

// Бодэ путей P и D оси, выбранной радио «Крен / Тангаж»: амплитуда и фаза лога и выбранной строки от bode3_min_hz
// (логарифмическая ось, массивы из кэша step3_bode); путь D оси с выключенным D (Kd = 0) не рисуется — причина
// в подписи #bode3_absent; вертикали на частотах задержки — при данных. Вызывать при step3_plots_ready()
function bode3_redraw() {
    const p = plot("Bode3")
    const axis = radio_value("bode3_axis") ?? "roll"
    const row = step3_selected_row()
    const sources = { log: step3_bode(step3_log_candidate().values), sel: (row != null) ? step3_bode(row.values) : null }
    const d_off = step3_d_off_reason(axis, step3.evaluations.log.kd[axis])
    for (let s = 0; s < bode3_parts.length; s++) {
        for (let k = 0; k < bode3_paths.length; k++) {
            const path = bode3_paths[k]
            for (let t = 0; t < step3_trace_types.length; t++) {
                const type = step3_trace_types[t]
                const bode = ((path === "D") && (d_off != null)) ? null : sources[type]
                const trace = p.data[bode3_trace_index(s, k, t)]
                trace.x = bode?.freq ?? []
                trace.y = (bode != null) ? bode[axis][path][bode3_parts[s].field] : []
                if ((type === "sel") && (row != null)) {
                    trace.name = "путь " + path + " · " + step3_selected_title(row)
                    trace.meta = trace.name
                }
                plot_trace_visibility(trace, true)
            }
        }
    }
    step3_absent_note("bode3_absent", (d_off != null) ? ["Пути D " + step3_axis_names[axis].gen + " нет: " + d_off + "."] : [])
    const drawn = p.data.some((trace) => trace.x.length > 0)
    for (const shape of p.layout.shapes) {
        shape.visible = drawn
    }
    render_plot("Bode3")
}
