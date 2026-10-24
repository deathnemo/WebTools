// Шаг 3 «Низкочастотные фильтры»: размер винта, варианты INS_GYRO_FILTER, фильтров ПИД и пределов ускорения
// (core/lowpass.js) со сравнением с логом — шум гироскопа после фильтров, шум D-составляющей, задержка путей P и D,
// — форма параметров с описаниями из ../FilterReview/params.json, метрики значений формы и «Принять».
// Notch-база — принятое на шаге 2 (state.steps[2].accepted), иначе notch из лога. Графики — задача 4 этапа 3.
// Форма строится своим кодом, а не load_param_inputs (Libraries/ParameterMetadata.js): тот ищет поле по id = имени
// параметра, а поле INS_GYRO_FILTER уже есть в форме шага 2. Поля шага 3 — id="lpf_<имя>".

// Внутреннее состояние шага
const step3 = {
    form_built: false,        // разметка формы построена для имён текущего лога (пределы ускорения — под именами из лога)
    form_names: null,         // имена полей формы по порядку (lowpass_param_names)
    filled: false,            // форма заполнена значениями текущего лога
    metadata: null,           // FilterReview/params.json; null — ещё не загружен или не загрузился
    metadata_requested: false, // запрос метаданных отправлен (один раз за жизнь страницы)
    base: null,               // notch-база расчёта: state.steps[2].accepted или values_from_log()
    prop_in: null,            // размер винта расчёта, дюймы; null — не введён или непригоден (prop_valid)
    ctx: null,                // lowpass_ctx расчёта; null — нет данных гироскопа до фильтров
    candidates: null,         // lowpass_candidates → [{ id, title, values, same_as, … }]
    evaluations: null,        // id → evaluate_lowpass (null — оценки нет)
    flags: null,              // id → lowpass_flags против «Как в логе»
    custom_row: null,         // «Свой» — значения формы, не совпавшие ни с одним вариантом: { id, title, values, evaluation, flags }
    selected_id: null,        // выбранный в таблице вариант
    key: null,                // для какого расчёта посчитаны варианты (step3_calc_key)
    gyro_ref: null,           // и для какого объекта state.gyro
    error: null,              // ошибка расчёта шага 1: показывается в вердикте вместо результатов
    edit_key: null,           // отпечаток введённого (step3_edit_key), для которого пересчитано и отрисовано
    edit_timer: null,         // отложенный пересчёт после набора в поле
    edit_postponed: false,    // пересчёт отложен до отпускания кнопки мыши
    pointer_down: false,      // кнопка мыши (касание) сейчас нажата
}

// Размер винта в памяти браузера
const step3_storage_key = "tunewizard_prop_in"

// Пауза в наборе, после которой поле пересчитывается, мс [наше]
const step3_edit_delay_ms = 400

// Оси с метриками словами: именительный и родительный падежи
const step3_axis_names = { roll: { nom: "крен", gen: "крена" }, pitch: { nom: "тангаж", gen: "тангажа" } }

// ---------- Подписи ----------

function step3_verdict(status, text) {
    const verdict = document.getElementById("verdict3")
    verdict.className = "verdict verdict--" + status
    verdict.textContent = text
    verdict.hidden = false
}

// Значение параметра кратчайшей записью float32 (param_to_string); нечисловое — «—» (param_to_string(NaN) бросает)
function step3_value_text(value) {
    return Number.isFinite(value) ? param_to_string(value) : "—"
}

// Разница a − b со знаком и единицами; нечисловая — «не оценён»
function step3_delta_text(a, b, digits, units) {
    return (Number.isFinite(a) && Number.isFinite(b)) ? step2_signed(a - b, digits) + " " + units : "не оценён"
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
    return "INS_GYRO_FILTER " + step3_value_text(values.INS_GYRO_FILTER) +
        " · FLTT " + step3_value_text(values.ATC_RAT_RLL_FLTT) + " / " + step3_value_text(values.ATC_RAT_PIT_FLTT) +
        " · FLTD " + step3_value_text(values.ATC_RAT_RLL_FLTD) + " / " + step3_value_text(values.ATC_RAT_PIT_FLTD)
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
    // Пороги во вступлении — из lowpass_rules, чтобы текст не расходился с ядром. Свой атрибут data-rule3:
    // шаг 2 перебирает все [data-rule] документа
    const rules = lowpass_rules
    const rule_texts = {
        band: rules.band_hz[0] + "–" + rules.band_hz[1] + " Гц",
        noise: rules.max_noise_increase_dB + " дБ",
        lag_hz: lowpass_lag_hz() + " Гц",
        lag: rules.max_lag_increase_ms + " мс",
    }
    for (const span of document.querySelectorAll("[data-rule3]")) {
        span.textContent = rule_texts[span.dataset.rule3]
    }

    const saved = step3_prop_load()
    if (saved != null) {
        document.getElementById("prop_in").value = saved
    }
    step3_render_prop()

    // Правки полей (размер винта и форма; поля формы перерисовываются с новым логом — слушаем контейнер):
    // набор — пересчёт после паузы, change — сразу или после отпускания мыши (см. «Правки полей»)
    for (const id of ["prop_in", "lpf_form"]) {
        document.getElementById(id).addEventListener("input", step3_edit_input)
        document.getElementById(id).addEventListener("change", step3_edit_change)
    }
    document.addEventListener("pointerdown", () => { step3.pointer_down = true }, true)
    for (const type of ["pointerup", "pointercancel"]) {
        document.addEventListener(type, step3_pointer_released, true)
    }
    document.getElementById("cand3_apply").addEventListener("click", step3_apply)
    document.getElementById("lpf_accept").addEventListener("click", step3_accept)
    // Выбор варианта в таблице (строки перерисовываются — слушаем таблицу)
    document.getElementById("candidates3").addEventListener("change", (e) => {
        if (e.target.name === "cand3") {
            step3.selected_id = e.target.value
            if (step3_ready() && (step3.candidates != null)) {
                step3_render_verdict()
            }
        }
    })
}

// Новый лог или ошибка загрузки: забыть варианты, расчёт и форму (имена пределов ускорения зависят от лога).
// Размер винта в поле остаётся: он про аппарат, а не про лог
function step3_reset() {
    Object.assign(step3, {
        form_built: false, form_names: null, filled: false, base: null, prop_in: null, ctx: null, candidates: null, evaluations: null,
        flags: null, custom_row: null, selected_id: null, key: null, gyro_ref: null, error: null, edit_key: null, edit_postponed: false,
    })
    clearTimeout(step3.edit_timer)
    step3.edit_timer = null
    document.getElementById("lpf_form").innerHTML = ""
    for (const id of ["verdict3", "warnings3", "candidates3", "candidates3_note", "metrics3", "prop_hint"]) {
        document.getElementById(id).hidden = true
    }
    for (const id of ["cand3_apply", "lpf_accept"]) {
        document.getElementById(id).disabled = true
    }
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
    hint.textContent = "Размера винта в логе нет — введите его, он запомнится в браузере. " + ((prop != null)
        ? "Текущему INS_GYRO_FILTER " + step3_value_text(gyro_hz) + " Гц по формуле Mission Planner соответствует ≈ " + prop.toFixed(1) + "″."
        : "INS_GYRO_FILTER в логе " + step3_value_text(gyro_hz) + " — фильтр гироскопа выключен, подсказки по размеру нет.")
    hint.hidden = false
}

// ---------- Правки полей ----------
// Пересчёт после правки размера винта или формы. Щелчок по кнопке сразу после набора не должен теряться: нажатие
// кнопки уводит фокус из поля, поле даёт change, и перерисовка в этот момент (строка «Свой», вариант по размеру,
// предупреждение у поля) сдвинула бы кнопку до отпускания мыши. Поэтому:
// - набор (input) — пересчёт после паузы step3_edit_delay_ms: к уходу из поля обычно всё уже посчитано;
// - change — пересчёт, только если введённое отличается от посчитанного; при нажатой кнопке мыши — после её
//   отпускания, то есть после щелчка;
// - «Применить вариант» и «Принять» сами досчитывают правки перед действием (step3_flush_edits), так что действие
//   идёт по актуальным значениям полей, даже если щелчок пришёл раньше пересчёта.

// Отпечаток введённого: текст размера винта и значения формы
function step3_edit_key() {
    return JSON.stringify([document.getElementById("prop_in").value.trim(), step3.filled ? candidate_key(step3_values_from_form()) : null])
}

// Набор в поле: пересчёт после паузы
function step3_edit_input() {
    clearTimeout(step3.edit_timer)
    step3.edit_timer = setTimeout(step3_flush_edits, step3_edit_delay_ms)
}

// change поля (уход из поля, Enter, стрелки): сразу, а при нажатой кнопке мыши — после её отпускания
function step3_edit_change() {
    if (step3.pointer_down) {
        step3.edit_postponed = true
        return
    }
    step3_flush_edits()
}

// Кнопка мыши отпущена: отложенный пересчёт — следующей задачей, после щелчка (click идёт сразу за pointerup)
function step3_pointer_released() {
    step3.pointer_down = false
    if (step3.edit_postponed) {
        step3.edit_postponed = false
        setTimeout(step3_flush_edits, 0)
    }
}

// Применить правки, если введённое отличается от посчитанного: запомнить размер винта, подписи у поля, пересчёт
// (варианты — при смене размера, строка «Свой» — при правке формы; выбрана строка формы, если менялась форма)
// и перерисовка. При нажатой кнопке мыши (сработал отложенный пересчёт) — после её отпускания
function step3_flush_edits() {
    clearTimeout(step3.edit_timer)
    step3.edit_timer = null
    if (step3.pointer_down) {
        step3.edit_postponed = true
        return
    }
    const key = step3_edit_key()
    if (key === step3.edit_key) {
        return
    }
    const form_changed = (step3.edit_key == null) || (JSON.parse(step3.edit_key)[1] !== JSON.parse(key)[1])
    step3.edit_key = key
    step3_prop_save(document.getElementById("prop_in").value.trim())
    step3_render_prop()
    if ((state.log == null) || !step3.filled) {
        return
    }
    step3_run_edit(() => {
        if (step3_ensure_step1()) {
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
    })
}

// ---------- Форма параметров ----------

// Описание параметра name в метаданных — тем же префиксным обходом, что recursive_search в
// Libraries/ParameterMetadata.js; null — описания нет
function step3_find_metadata(obj, name) {
    for (const [key, value] of Object.entries(obj)) {
        if (!name.startsWith(key)) {
            continue
        }
        if (name === key) {
            return value
        }
        const found = step3_find_metadata(value, name)
        if (found != null) {
            return found
        }
    }
    return null
}

// Метаданные поля формы. Старых имён ATC_ACCEL_*_MAX (сантиградусы/с², 4.6 и раньше) в params.json нет — берётся
// описание нового ATC_ACC_*_MAX с единицами cdeg/s/s. Диапазоны не показываются: у ATC_RAT_* в params.json —
// диапазоны вертолёта (path AC_AttitudeControl_Heli, FLTE 5–50 Гц), у Copter они другие (FLTE 0–100, рыскания 0–20)
function step3_param_metadata(name) {
    if (step3.metadata == null) {
        return null
    }
    const old = /^ATC_ACCEL_([RPY])_MAX$/.exec(name)
    const metadata = step3_find_metadata(step3.metadata, (old != null) ? "ATC_ACC_" + old[1] + "_MAX" : name)
    if ((metadata == null) || (old == null)) {
        return metadata
    }
    return { ...metadata, Units: "cdeg/s/s" }
}

// Загрузить метаданные один раз; по приходу — описания и единицы в построенную форму
function step3_load_metadata() {
    if (step3.metadata_requested) {
        return
    }
    step3.metadata_requested = true
    fetch("../FilterReview/params.json")
        .then((res) => res.json())
        .then((data) => {
            step3.metadata = data
            step3_apply_metadata()
        })
        .catch((e) => console.warn("Шаг 3: описания параметров не загрузились — " + e.message))
}

// Описания (title у подписи и поля) и единицы из метаданных в поля формы; без метаданных — только имена
function step3_apply_metadata() {
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
            // Частоты — с шагом 0.5 Гц (правило /2 даёт половинки), пределы ускорения из лога бывают дробными
            const step = [accel.r, accel.p, accel.y].includes(name) ? "any" : "0.5"
            const id = "lpf_" + name
            html += '<p class="param" data-name="' + html_escape(name) + '"><label for="' + html_escape(id) + '">' + html_escape(name) + '</label>' +
                '<input type="number" id="' + html_escape(id) + '" step="' + step + '"><span class="units"></span><span class="inlog"></span></p>'
        }
        html += '</div>'
    }
    document.getElementById("lpf_form").innerHTML = html
    step3.form_names = names
    step3.form_built = true
    if (step3.metadata != null) {
        step3_apply_metadata()
    } else {
        step3_load_metadata()
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

// Заполнить форму значениями и подписи «в логе»; у параметров, которых в логе нет, — заводское значение,
// взятое вместо него (lowpass_log_values)
function step3_fill_form(values) {
    step3_set_form_values(values)
    const log_values = lowpass_log_values(state.params)
    for (const p of document.querySelectorAll("#lpf_form p.param")) {
        const name = p.dataset.name
        const value = state.params.get(name)
        p.querySelector(".inlog").textContent = (value == null) ? "в логе нет (взято " + step3_value_text(log_values[name]) + ")" : "в логе: " + step3_value_text(value)
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

// Ключ расчёта: интервал, FFT и версия фильтра шага 1, notch-база и размер винта
function step3_calc_key() {
    return JSON.stringify([state.settings.start, state.settings.end, step1.fft_key, state.spectrum.filter_version, candidate_key(step3_base()), step3_prop_size()])
}

// Варианты посчитаны для другого расчёта (или ещё не посчитаны)
function step3_stale() {
    return (step3.candidates == null) || (step3.key !== step3_calc_key()) || (step3.gyro_ref !== state.gyro)
}

// Расчёт шага 1 актуален и нет своей ошибки
function step3_ready() {
    return step1_ready() && (step3.error == null)
}

// Расчёт шага 1 актуален или досчитан; иначе текст ошибки в step3.error
function step3_ensure_step1() {
    if (step1_ready() || step1_prepare()) {
        step3.error = null
        return true
    }
    step3.error = step1.error ?? "Расчёт спектра шага 1 не готов"
    return false
}

// Варианты и их оценка против «Как в логе» для текущего интервала, notch-базы и размера винта; выбран
// рекомендованный. Без данных гироскопа до фильтров — варианты без оценки
function step3_compute() {
    const params = state.params
    const base = step3_base()
    step3.key = step3_calc_key()
    step3.gyro_ref = state.gyro
    step3.base = base
    step3.prop_in = step3_prop_size()
    step3.candidates = lowpass_candidates(lowpass_log_values(params), step3.prop_in, lowpass_accel_names(params))
    step3.evaluations = null
    step3.flags = null
    step3.custom_row = null

    const sensor = step2_sensor()
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
    step3.selected_id = step3_recommended_id() ?? "log"
    step3_update_custom()
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

// Выполнить fn под оверлеем загрузки; неожиданная ошибка — в консоль и вердикт, оверлей не зависает
function step3_run(fn) {
    loading_call(async () => {
        try {
            fn()
        } catch (e) {
            console.error(e)
            step3_verdict("fail", "Ошибка шага 3: " + e.message)
        }
    })
}

// Пересчёт правок полей (step3_flush_edits): сразу, без оверлея загрузки — оверлей, показанный при уходе из поля
// на нажатии кнопки, перехватил бы щелчок. Это лёгкий расчёт — оценка вариантов, ≈ 0.1 с; если нужен расчёт
// шага 1, он идёт под оверлеем (step3_run)
function step3_run_edit(fn) {
    if (!step1_ready()) {
        step3_run(fn)
        return
    }
    try {
        fn()
    } catch (e) {
        console.error(e)
        step3_verdict("fail", "Ошибка шага 3: " + e.message)
    }
}

// Показ шага: форма из лога (один раз на лог); варианты считаются заново, если сменились интервал, расчёт шага 1,
// принятый notch или размер винта
function step3_show() {
    if (state.log == null) {
        return
    }
    step3_run(() => {
        if (!step3.form_built) {
            step3_build_form()
        }
        if (!step3.filled) {
            step3_fill_form(lowpass_log_values(state.params))
            step3.filled = true
        }
        step3_render_prop()
        if (step3_ensure_step1()) {
            if (step3_stale()) {
                step3_compute()
            } else {
                step3_update_custom()
            }
        }
        // Введённое учтено: отложенный пересчёт правок не нужен
        clearTimeout(step3.edit_timer)
        step3.edit_timer = null
        step3.edit_key = step3_edit_key()
        step3_redraw_all()
    })
}

// «Применить вариант»: значения выбранной строки в форму. Сначала досчитать правки полей: щелчок мог прийти раньше
// их пересчёта, и строка выбирается уже в таблице для актуального размера винта
function step3_apply() {
    if (!step3.filled) {
        return
    }
    step3_flush_edits()
    if (!step3_ready() || (step3.candidates == null)) {
        return
    }
    const row = step3_rows().find((r) => r.id === radio_value("cand3"))
    if (row == null) {
        return
    }
    step3_set_form_values(row.values)
    step3_flush_edits()
}

// «Принять»: значения формы, их метрики и отметки против лога и ключ расчёта — в итог мастера, затем шаг 4 (если
// доступен). Правки полей сначала досчитываются (щелчок мог прийти раньше их пересчёта). Пустое поле принять
// нельзя: значение параметра неизвестно
function step3_accept() {
    step3_flush_edits()
    step3_run(() => {
        if (!step3.filled || !step3_ensure_step1()) {
            step3_redraw_all()
            return
        }
        if (step3_stale()) {
            step3_compute()
        }
        const values = step3_values_from_form()
        const empty = step3.form_names.filter((name) => !Number.isFinite(values[name]))
        if (empty.length > 0) {
            step3_verdict("fail", "Не заполнены поля: " + empty.join(", ") + " — принять нельзя.")
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
            flags: compared ? lowpass_flags(row.evaluation, log) : null,
            calc_key: step3.key,
            evaluated_at: Date.now(),
        }
        step3_redraw_all()
        set_step(4)
    })
}

// ---------- Отрисовка ----------

function step3_redraw_all() {
    step3_mark_changed()
    const ready = step3_ready() && (step3.candidates != null)
    document.getElementById("lpf_accept").disabled = !(ready && step3.filled)
    if (!ready) {
        for (const id of ["candidates3", "candidates3_note", "metrics3", "warnings3"]) {
            document.getElementById(id).hidden = true
        }
        document.getElementById("cand3_apply").disabled = true
        step3_verdict("fail", step3.error ?? "Расчёт спектра шага 1 не готов")
        return
    }
    step3_render_candidates()
    step3_render_metrics()
    step3_render_warnings()
    step3_render_verdict()
}

// Ячейка таблицы: text — основное значение, sub — мелкая строка, cls — "better" | "worse" | "", title — подсказка
function step3_cell(text, sub, cls, title) {
    return '<td class="num' + (cls ? " " + cls : "") + '"' + (title ? ' title="' + html_escape(title) + '"' : "") + '>' + html_escape(text) +
        (sub ? '<small>' + html_escape(sub) + '</small>' : "") + '</td>'
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
        return step3_cell("база", null, "", "база сравнения, уровень " + level(own))
    }
    const delta = (Number.isFinite(own) && Number.isFinite(base)) ? own - base : NaN
    const cls = flagged ? "worse" : ((delta < -0.005) ? "better" : "")
    return step3_cell(Number.isFinite(delta) ? step2_signed(delta, 2) : "не оценён", null, cls, "уровень " + level(own) + ", у лога " + level(base))
}

// Ячейка задержки пути path оси axis на lowpass_lag_hz(): мс и разница к логу; остальные частоты — в подсказке.
// Путь D оси с выключенным D (Kd = 0) не сравнивается — «—»
function step3_lag_cell(e, log, axis, path, is_log, flagged) {
    if ((path === "D") && (e.kd[axis] === 0)) {
        return step3_cell("—", null, "", "D выключен")
    }
    const lag = (evaluation, f) => evaluation?.lag_ms?.[axis]?.[path]?.[f]
    const hz = lowpass_lag_hz()
    const title = lowpass_rules.lag_freqs_hz.filter((f) => f !== hz).map((f) => "на " + f + " Гц: " +
        (Number.isFinite(lag(e, f)) ? lag(e, f).toFixed(2) + " мс" : "не оценена") + (is_log ? "" : " (к логу " + step3_delta_text(lag(e, f), lag(log, f), 2, "мс") + ")")).join("; ")
    const own = lag(e, hz)
    if (!Number.isFinite(own)) {
        return step3_cell("не оценена", null, flagged ? "worse" : "", title)
    }
    const delta = own - lag(log, hz)
    const cls = flagged ? "worse" : ((delta < -0.005) ? "better" : "")
    return step3_cell(own.toFixed(2), is_log ? null : (Number.isFinite(delta) ? step2_signed(delta, 2) : "—"), cls, title)
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
    let head = '<tr><th rowspan="2"></th><th rowspan="2">Вариант</th><th rowspan="2">INS_GYRO_FILTER</th>' +
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

    const rows = step3_rows()
    const selected = rows.some((r) => r.id === step3.selected_id) ? step3.selected_id : (recommended_id ?? "log")
    let body = ""
    for (const row of rows) {
        const e = row.evaluation
        const is_log = row.id === "log"
        const id_attr = html_escape("cand3_" + row.id)
        const v = row.values
        body += '<tr' + ((row.id === recommended_id) ? ' class="recommended"' : '') + '>'
        body += '<td><input type="radio" name="cand3" id="' + id_attr + '" value="' + html_escape(row.id) + '"' + ((row.id === selected) ? ' checked' : '') + '></td>'
        body += '<td><label for="' + id_attr + '">' + html_escape(row.title) + '</label>' + step3_row_note(row) + '</td>'
        body += '<td class="num">' + html_escape(step3_value_text(v.INS_GYRO_FILTER)) + '</td>'
        for (const axis of axes) {
            const param = lowpass_pid_axes[axis].param
            body += '<td class="num">' + html_escape(step3_value_text(v["ATC_RAT_" + param + "_FLTD"]) + " / " + step3_value_text(v["ATC_RAT_" + param + "_FLTT"])) + '</td>'
        }
        if ((e == null) || (log == null)) {
            body += '<td colspan="' + (1 + 3 * axes.length) + '">оценки нет</td>'
        } else {
            const flags = row.flags
            body += step3_noise_cell(e.gyro.band_dB, log.gyro.band_dB, is_log, flags?.noisier.includes("gyro") ?? false)
            for (const axis of axes) {
                const absent = step3_dterm_absent(e, axis)
                body += (absent != null) ? step3_cell(absent, null, "", null)
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
    document.getElementById("cand3_apply").disabled = false

    const loop_rate = step3.ctx?.loop_rate ?? step3.base.SCHED_LOOP_RATE
    const d_top = Math.min(lowpass_rules.band_hz[1], loop_rate / 2)
    const gyro = state.gyro
    note.textContent = (prop_valid(step3.prop_in) ? "" : "Введите размер винта — появится вариант по формуле. ") +
        "Шум гироскопа — средняя мощность X+Y+Z после фильтров в полосе " + lowpass_rules.band_hz.join("–") + " Гц, как на шаге 2. " +
        "Шум D — модель D-составляющей крена и тангажа: спектр гироскопа после фильтров, свёрнутый к половине частоты контура " +
        "(SCHED_LOOP_RATE " + step3_value_text(loop_rate) + " → " + step3_value_text(loop_rate / 2) + " Гц), × производная × FLTE × FLTD, в полосе " +
        lowpass_rules.band_hz[0] + "–" + step3_value_text(d_top) + " Гц; Kd из лога в сравнении сокращается. Обе — разница к «Как в логе». " +
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
    const tiles = [step2_tile("Значения", row.title, step3_short_values(row.values), null)]

    const gyro_delta = e.gyro.band_dB - log.gyro.band_dB
    tiles.push(step2_tile("Шум гироскопа " + lowpass_rules.band_hz.join("–") + " Гц", step3_delta_text(e.gyro.band_dB, log.gyro.band_dB, 2, "дБ"),
                          "к логу; уровень " + (Number.isFinite(e.gyro.band_dB) ? e.gyro.band_dB.toFixed(2) + " дБ" : "не посчитан"),
                          mod(flags?.noisier.includes("gyro"), gyro_delta)))
    for (const axis of Object.keys(lowpass_pid_axes)) {
        const absent = step3_dterm_absent(e, axis)
        const key = "Шум D " + step3_axis_names[axis].gen
        if (absent != null) {
            tiles.push(step2_tile(key, (absent === "нет Kd") ? "нет Kd в логе" : "D выключен", "не сравнивается", null))
            continue
        }
        const own = e.dterm[axis].dB
        const base = log.dterm[axis]?.dB
        tiles.push(step2_tile(key, step3_delta_text(own, base, 2, "дБ"), "к логу", mod(flags?.noisier.includes(axis), own - base)))
    }
    for (const path of ["P", "D"]) {
        for (const axis of Object.keys(lowpass_pid_axes)) {
            if ((path === "D") && (e.kd[axis] === 0)) {
                tiles.push(step2_tile("Путь D " + step3_axis_names[axis].gen, "—", "D выключен", null))
                continue
            }
            const lag = (evaluation, f) => evaluation.lag_ms[axis][path][f]
            const own = lag(e, hz)
            const slower = flags?.slower.some((s) => (s.axis === axis) && (s.path === path)) ?? false
            const others = lowpass_rules.lag_freqs_hz.filter((f) => f !== hz).map((f) => "на " + f + " Гц " +
                (Number.isFinite(lag(e, f)) ? lag(e, f).toFixed(2) + " мс" : "не оценена") + " (" + step3_delta_text(lag(e, f), lag(log, f), 2, "мс") + ")")
            tiles.push(step2_tile("Путь " + path + " " + step3_axis_names[axis].gen, Number.isFinite(own) ? own.toFixed(2) + " мс" : "не оценена",
                                  "на " + hz + " Гц, к логу " + step3_delta_text(own, lag(log, hz), 2, "мс") + "; " + others.join("; "), mod(slower, own - lag(log, hz))))
        }
    }
    box.innerHTML = tiles.join("")
    box.hidden = false
}

// Заметки под вердиктом: чего модель не учитывает (lowpass_model_warnings), INS_GYRO_FILTER шага 2, оси без Kd или
// с выключенным D, предупреждения фильтров гироскопной части
function step3_render_warnings() {
    const box = document.getElementById("warnings3")
    const lines = [...lowpass_model_warnings(state.params)]
    const accepted = state.steps[2]?.accepted
    const log_gyro = lowpass_log_values(state.params).INS_GYRO_FILTER
    if ((accepted != null) && (Math.fround(accepted.INS_GYRO_FILTER) !== log_gyro)) {
        lines.push("На шаге 2 принят INS_GYRO_FILTER " + step3_value_text(accepted.INS_GYRO_FILTER) + " (в логе " + step3_value_text(log_gyro) +
                   "): шаг 3 выбирает INS_GYRO_FILTER заново, итоговым станет значение шага 3.")
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

// Вердикт: принятые значения (всегда первыми); без размера винта — просьба ввести его; рекомендация «По размеру
// винта» — что меняется против лога и метрики, с отметками — что хуже; пределы ускорения из лога — формула для
// справки; notch из лога, если шаг 2 не принят
function step3_render_verdict() {
    const base_note = (state.steps[2] == null) ? " Notch — из лога (шаг 2 не принят)." : ""
    const accepted = state.steps[3]
    if ((accepted != null) && step3.filled && (candidate_key(accepted.accepted) === candidate_key(step3_values_from_form()))) {
        // Принятое считалось для другого интервала, расчёта шага 1, notch-базы или размера винта — его метрики устарели
        if (accepted.calc_key !== step3_calc_key()) {
            step3_verdict("warn", "Принято раньше для другого интервала, notch или размера винта — проверьте и примите заново." + base_note)
            return
        }
        const match = step3_match(accepted.accepted)
        const name = (match != null) ? "«" + match.title + "»" : "свои значения"
        const metrics = accepted.metrics
        const tail = (metrics != null) ? " — " + step3_summary_text(metrics.current, metrics.log) + " (к логу)" : " (без сравнения с логом)"
        if (step3_flagged(accepted.flags)) {
            step3_verdict("warn", "Принято, но хуже лога: " + step3_flags_text(accepted.flags, metrics.current, metrics.log) + ". " + name + tail + "." + base_note)
        } else {
            step3_verdict("ok", "Принято: " + name + tail + "." + base_note)
        }
        return
    }

    const log = step3.evaluations?.log ?? null
    const compare_note = (log == null) ? " Сравнить варианты с логом нельзя: нужны данные гироскопа до фильтров (INS_LOG_BAT_OPT / INS_RAW_LOG_OPT)." : ""
    const recommended_id = step3_recommended_id()
    if (recommended_id == null) {
        step3_verdict("warn", "Введите размер винта: в логе его нет, а без него нет варианта по формуле Mission Planner и рекомендации." + compare_note + base_note)
        return
    }
    const row = step3_rows().find((r) => r.id === recommended_id)
    const accel = step3_prop_accel(row)
    const names = lowpass_accel_names(state.params)
    const accel_text = accel.from_log ? " Пределы ускорения оставлены из лога (похоже на AutoTune), по формуле было бы " +
        [["r", names.r], ["p", names.p], ["y", names.y]].map(([k, n]) => n + " " + step3_value_text(accel.formula[k])).join(", ") + " " + names.units + "." : ""
    const prop_title = "по размеру винта (" + step3.prop_in + "″)"
    if (recommended_id === "log") {
        step3_verdict("ok", "Значения " + prop_title + " совпадают с логом — менять нечего." + accel_text + compare_note + base_note)
        return
    }

    const log_values = lowpass_log_values(state.params)
    const changes = step3.form_names.filter((n) => row.values[n] !== log_values[n]).map((n) => n + " " + step3_value_text(log_values[n]) + " → " + step3_value_text(row.values[n]))
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
    } else if (radio_value("cand3") === recommended_id) {
        action = "Он выбран — нажмите «Применить вариант», затем «Принять»."
    } else {
        action = "Выберите его в таблице и нажмите «Применить вариант», затем «Принять»."
    }
    step3_verdict(status, "Рекомендуется «" + row.title + "»" + worse + ". Меняется: " + changes.join(", ") + "." + numbers + accel_text + " " + action + base_note)
}
