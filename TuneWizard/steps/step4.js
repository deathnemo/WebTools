// Шаг 4 «PID по осям»: измеренный отклик контура скорости по крену, тангажу и рысканию (КИХ МНК, core/pidtune.js),
// проверки качества измерения, предложение ATC_RAT_*_P/I/D по правилам и прогноз отклика и запаса фазы вариантов
// с проверкой достоверности; форма коэффициентов с описаниями из ../FilterReview/params.json и «Принять».
// Дизайн — docs/plans/2026-10-25-tune-wizard-stage4-design.md, разделы 3–5 и 7; план — …-stage4.md, задача 7.
//
// Данные PID — load_pid (core/pid.js) один раз на лог; FFT компонент (спектр D для шума D, а в задаче 8 — отклик
// PIDReview на графике) — pid_run_batch_fft с окном шага. Измеренный отклик, проверки качества и прогноз от окна
// FFT не зависят: отбор отрезков КИХ — окнами pidtune_rules.window (512) с шагом 32, на них откалиброваны пороги
// проверок (раздел 3 дизайна).
// Регулятор лога и сверка модели регулятора — с коэффициентами и фильтрами FLTE/FLTD набора лога; регуляторы
// вариантов — с FLTE/FLTD, принятыми на шаге 3 (иначе лога); notch шага 2 и INS_GYRO_FILTER шага 3 входят в прогноз
// поправкой pidtune_gyro_ratio (нужен расчёт шага 1; без данных гироскопа — без поправки, с пометкой в вердикте).
// На оси без надёжного измерения (проверки качества, мало манёвров, редкий лог) правил и прогноза нет: в таблице —
// только «Как в логе» и «Свой», вердикт советует тестовый полёт (решение пользователя 25.10.2026).
// Графики шага — задача 8 плана.
//
// Форма — своя (id="pidf_<имя>"), механизм правок — как на шаге 3: пересчёт через паузу в наборе, change — только
// при отличии и после отпускания мыши, кнопки досчитывают правки сами (step4_flush_edits(true)).
//
// Нужны глобалы страницы: core/pid.js (load_pid, pid_run_batch_fft, PID_STEP_MIN_RATE), core/pidtune.js (pidtune_*),
// core/lowpass.js (lowpass_log_values — фильтры лога для ключа расчёта), core/candidates.js (candidate_key),
// core/spectrum.js (find_instance), Libraries/Param_Helpers.js (param_to_string), wizard.js (state, set_step,
// html_escape), steps/common.js (step_signed, step_value_text, step_tile, step_cell, step_verdict, step_gyro_sensor,
// step_ensure_step1, step_try, step_run, step_open_in, step_find_metadata, step_metadata, step_load_metadata,
// step_edit_controller, step_pointer) и steps/step1.js (values_from_log). Принятое шагами 2–3 читается из state.steps[2] и state.steps[3].

// Внутреннее состояние шага
const step4 = {
    pid: null,                // load_pid(state.log, …): один раз на лог
    fft_window: null,         // окно, с которым посчитан FFT осей (pid_run_batch_fft); null — не считался
    window: 512,              // окно FFT шага — поле step4_window (как FFTWindow_size в PIDReview)
    axis: "roll",             // выбранная вкладка
    set_choice: { roll: null, pitch: null, yaw: null }, // выбранный набор параметров оси; null — действующий в конце интервала
    calc: null,               // расчёт по осям: { roll: step4_compute_axis(…), pitch, yaw }; null — нет расчёта
    key: null,                // для какого расчёта посчитано (step4_calc_key)
    gyro_ref: null,           // и для какого объекта state.gyro (важно, только если фильтры гироскопа менялись)
    error: null,              // почему шаг не считается (нет данных PID): показывается в вердикте
    selected: { roll: null, pitch: null, yaw: null }, // выбранная строка таблицы оси (читать через step4_selected_row)
    form_built: false,        // разметка формы построена
    filled: false,            // форма заполнена значениями текущего лога
    edit_form: null,          // ключи значений формы по осям, для которых пересчитано и отрисовано
    edit_timer: null,         // отложенный пересчёт после набора в поле (step4_edits)
    edit_postponed: false,    // пересчёт (правок или окна FFT) отложен до отпускания кнопки мыши (step4_edits)
    window_pending: false,    // поле окна FFT изменено (change), а step4.window ещё не обновлён (step4_flush_window)
}

// Пауза в наборе, после которой поле пересчитывается, мс [наше, как на шаге 3]
const step4_edit_delay_ms = 400

// Механизм правок полей формы и поля окна FFT (каркас — step_edit_controller из steps/common.js, см. «Правки полей»):
// отложенный пересчёт — step4_flush_pending (окно, затем форма)
const step4_edits = step_edit_controller(step4, { delay_ms: step4_edit_delay_ms, flush: step4_flush_pending })

// Оси шага по порядку вкладок; названия — именительный и родительный падежи
const step4_axis_list = ["roll", "pitch", "yaw"]
const step4_axis_names = { roll: { nom: "Крен", gen: "крена" }, pitch: { nom: "Тангаж", gen: "тангажа" }, yaw: { nom: "Рыскание", gen: "рыскания" } }
// Индекс оси в load_pid().axes: PIDR/PIDP/PIDY; RATE R/P/Y — на 3 дальше
const step4_pid_index = { roll: 0, pitch: 1, yaw: 2 }
// Коэффициенты шага у оси
const step4_gain_keys = ["P", "I", "D"]
// Проверки качества по буквам дизайна
const step4_check_letters = { ridge: "(а)", halves: "(б)", outer: "(в)" }
// Лучший неотмеченный вариант: перерегулирования, отличающиеся от лучшего не больше чем на столько пунктов, считаются
// равными (step4_best_unflagged) [наше, решение координатора по ревью задачи 7]
const step4_best_tie_pct = 0.5

// Совет тестового полёта (решение пользователя 25.10.2026; раздел 3 дизайна): полный — в вердикте оси, краткий — в сводке
const step4_test_flight = "Слетайте тестовый лог: Acro с ACRO_OPTIONS бит 1 «Rate Loop Only» (значение 2, или 3 вместе с Air-mode) — " +
    "угловой контур выключен, цель — прямая команда пилота; 2–3 минуты резких отклонений стиков по каждой оси; в LOG_BITMASK " +
    "включены ATTITUDE_FAST и PID. Такой лог мастер считает точно."
const step4_test_flight_short = "нужен тестовый полёт: Acro с ACRO_OPTIONS «Rate Loop Only» (2, или 3 с Air-mode), 2–3 минуты резких " +
    "отклонений стиков по каждой оси, в LOG_BITMASK — ATTITUDE_FAST и PID"

// ---------- Подписи ----------

// Секунды в миллисекундах с одним знаком; нечисловое — «—»
function step4_ms(seconds) {
    return Number.isFinite(seconds) ? (seconds * 1000).toFixed(1) + " мс" : "—"
}

// Число с digits знаками; нечисловое — «—»
function step4_fixed(value, digits) {
    return Number.isFinite(value) ? value.toFixed(digits) : "—"
}

// Число окон с существительным в нужной форме: «1 окно», «553 окна», «811 окон»
function step4_windows_text(n) {
    const last = n % 10
    const teen = (n % 100 >= 11) && (n % 100 <= 14)
    const word = teen ? "окон" : ((last == 1) ? "окно" : (((last >= 2) && (last <= 4)) ? "окна" : "окон"))
    return n + " " + word
}

// Имена параметров формы по порядку: ATC_RAT_RLL/PIT/YAW_P/I/D
function step4_param_names() {
    return step4_axis_list.flatMap((axis) => step4_gain_keys.map((k) => pidtune_axes[axis].rate + k))
}

// Коэффициенты оси axis из объекта имя → значение: { P, I, D }
function step4_axis_gains(values, axis) {
    const prefix = pidtune_axes[axis].rate
    return { P: values[prefix + "P"], I: values[prefix + "I"], D: values[prefix + "D"] }
}

// Ключ коэффициентов { P, I, D } для сравнения строк таблицы и формы: как float32 (значения формы — float32, у правил
// — 4 значащие цифры двойной точности); нечисловое — null
function step4_gain_key(gains) {
    return JSON.stringify(step4_gain_keys.map((k) => Number.isFinite(gains[k]) ? Math.fround(gains[k]) : null))
}

// Одно и то же значение коэффициента — как float32; два нечисловых тоже считаются одинаковыми (значение неизвестно)
function step4_same_value(a, b) {
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
        return !Number.isFinite(a) && !Number.isFinite(b)
    }
    return Math.fround(a) === Math.fround(b)
}

// Буквы непройденных проверок качества: ["(б)"] и т. п.; (в) в Rate Loop Only не применяется и не входит
function step4_failed_checks(quality) {
    const checks = quality?.checks
    if (checks == null) {
        return []
    }
    return Object.keys(step4_check_letters).filter((k) => (checks[k].applied !== false) && !checks[k].ok).map((k) => step4_check_letters[k])
}

// ---------- Инициализация и сброс ----------

function step4_init() {
    // Пороги во вступлении — из pidtune_rules, чтобы текст не расходился с ядром. Свой атрибут data-rule4: шаг 2
    // перебирает все [data-rule] документа, шаг 3 — [data-rule3]
    const rules = pidtune_rules
    const rule_texts = {
        step: Math.round(rules.gain_step * 100) + " %",
        pm_min: rules.pm_min_deg + "°",
        pm_drop: rules.pm_max_drop_deg + "°",
        overshoot: rules.overshoot_pred_max_pct + " %",
    }
    for (const span of document.querySelectorAll("[data-rule4]")) {
        span.textContent = rule_texts[span.dataset.rule4]
    }
    document.getElementById("step4_window").value = step4.window
    document.getElementById("step4_window").addEventListener("change", step4_window_change)

    // Правки формы (поля перерисовываются с новым логом — слушаем контейнер): набор — пересчёт после паузы,
    // change — следующей задачей или после отпускания мыши (см. «Правки полей»)
    const form = document.getElementById("pidf_form")
    form.addEventListener("input", step4_edits.input)
    form.addEventListener("change", step4_edits.change)

    // Вкладки осей: щелчок; стрелки влево/вправо, Home и End (фокус переходит на выбранную вкладку)
    for (const axis of step4_axis_list) {
        const tab = document.getElementById("step4_tab_" + axis)
        tab.addEventListener("click", () => step4_select_axis(axis))
        tab.addEventListener("keydown", (e) => {
            const list = step4_axis_list
            const i = list.indexOf(axis)
            const index = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: list.length - 1 }[e.key]
            if (index == null) {
                return
            }
            e.preventDefault()
            const next = list[(index + list.length) % list.length]
            step4_select_axis(next)
            document.getElementById("step4_tab_" + next).focus()
        })
    }
    // Выбор варианта в таблице и набора параметров (строки перерисовываются — слушаем контейнеры). Выбор строки
    // меняет только вердикт оси (что делать с выбранной строкой): таблица и вкладки от него не зависят, а
    // перерисовка таблицы сбивала бы выбор стрелками с клавиатуры
    document.getElementById("candidates4").addEventListener("change", (e) => {
        if (e.target.name === "cand4") {
            step4.selected[step4.axis] = e.target.value
            if (step4_ready()) {
                step_try(step4_render_axis_verdict, "verdict4", "шага 4")
            }
        }
    })
    document.getElementById("step4_sets").addEventListener("change", (e) => {
        if (e.target.name === "step4_set") {
            step4_set_changed(step4.axis, Number(e.target.value))
        }
    })
    document.getElementById("cand4_apply").addEventListener("click", step4_apply)
    document.getElementById("pidf_accept").addEventListener("click", step4_accept)
    // «Открыть в PIDReview» — как «Открыть в FilterReview» шага 1
    document.getElementById("step4_open_pidreview").addEventListener("click", () => step_open_in("../PIDReview/", () => {
        step_verdict("verdict4", "warn", "Браузер не открыл новую вкладку: разрешите всплывающие окна для этой страницы")
    }))
}

// Новый лог или ошибка загрузки: забыть данные PID, расчёт, выбор и форму. Окно FFT шага остаётся (как окно шага 0)
function step4_reset() {
    Object.assign(step4, {
        pid: null, fft_window: null, axis: "roll", set_choice: { roll: null, pitch: null, yaw: null }, calc: null, key: null, gyro_ref: null,
        error: null, selected: { roll: null, pitch: null, yaw: null }, form_built: false, filled: false, edit_form: null, edit_postponed: false,
    })
    clearTimeout(step4.edit_timer)
    step4.edit_timer = null
    document.getElementById("pidf_form").innerHTML = ""
    for (const id of ["verdict4", "step4_tabs", "step4_panel"]) {
        document.getElementById(id).hidden = true
    }
    for (const id of ["cand4_apply", "pidf_accept", "step4_open_pidreview"]) {
        document.getElementById(id).disabled = true
    }
}

// ---------- Правки полей ----------
// Как на шаге 3 (steps/step3.js, «Правки полей»): щелчок по кнопке сразу после набора не должен теряться — нажатие
// уводит фокус из поля, поле даёт change, и перерисовка таблицы (строка «Свой») сдвинула бы кнопку до отпускания
// мыши. Поэтому набор (input) пересчитывается после паузы step4_edit_delay_ms, change — только при отличии от
// посчитанного и после отпускания мыши, а «Применить вариант» и «Принять» досчитывают правки сами. Набор, change и флаг
// нажатой кнопки мыши — общий каркас step_edit_controller (step4_edits).

// Ключи значений формы по осям — то, что введено сейчас; null — форма не заполнена
function step4_edit_state() {
    if (!step4.filled) {
        return null
    }
    const values = step4_values_from_form()
    return Object.fromEntries(step4_axis_list.map((axis) => [axis, step4_gain_key(step4_axis_gains(values, axis))]))
}

// Отметить введённое сейчас как посчитанное
function step4_edit_done() {
    step4.edit_form = step4_edit_state()
}

// Отложенное: сменённое окно FFT (с пересчётом шага) и правки формы
function step4_flush_pending() {
    step4_flush_window()
    step4_flush_edits()
}

// Применить правки формы, если введённое отличается от посчитанного: строки «Свой» осей с изменёнными значениями,
// выбор строки формы в них. Вкладка не переключается (решение координатора по ревью задачи 7: переход уводил
// «Применить вариант», щелчок по вкладке и выбор строки на другую ось и сдвигал поле) — правку другой оси видно по
// пометке на её вкладке (step4_render_tabs). При нажатой кнопке мыши — после её отпускания; force — без этой проверки
// (кнопки шага). Введённое отмечается посчитанным только после успешного пересчёта
function step4_flush_edits(force = false) {
    if (!step4_edits.begin(force)) {
        return
    }
    const edit = step4_edit_state()
    if ((edit == null) || (JSON.stringify(edit) === JSON.stringify(step4.edit_form))) {
        return
    }
    const changed = step4_axis_list.filter((axis) => edit[axis] !== step4.edit_form?.[axis])
    if (state.log == null) {
        step4_edit_done()
        return
    }
    // Расчёт обычно готов (форма заполняется вместе с ним) — пересчёт строк «Свой» сразу, без оверлея: кнопки
    // досчитывают правки в обработчике click и тут же читают форму, а оверлей съел бы щелчок. Строка «Свой» с
    // прогнозом — ≈ 5 мс на ось. Если расчёт устарел (новый интервал), он идёт под оверлеем
    const run = step4_stale() ? step_run : step_try
    run(() => {
        // Под оверлеем расчёт идёт позже — к нему мог прийти новый лог
        if (!step4.filled) {
            return
        }
        if (step4_stale()) {
            step4_compute()
        } else {
            step4_update_custom()
        }
        for (const axis of changed) {
            step4.selected[axis] = step4_form_row(axis)?.id ?? step4.selected[axis]
        }
        step4_redraw_all()
        step4_edit_done()
    }, "verdict4", "шага 4")
}

// change поля окна FFT — как change поля формы: пересчёт шага идёт под оверлеем и съел бы щелчок по кнопке, ради
// которого поле теряет фокус (ревью задачи 7: набор 1024 и сразу «Принять» или «Открыть в PIDReview»). Поэтому —
// следующей задачей, а при нажатой кнопке мыши — после её отпускания; «Принять» само досчитывает окно
function step4_window_change() {
    step4.window_pending = true
    step4_edits.change()
}

// Применить изменённое поле окна FFT: ближайшая степень двойки в сторону изменения (как поле окна шага 0
// и PIDReview), не меньше 64, — в step4.window и в поле. recalc — пересчитать шаг (step4_show), если он открыт
// и расчёт устарел; «Принять» передаёт false — оно считает само
function step4_flush_window(recalc = true) {
    if (!step4.window_pending) {
        return
    }
    // Кнопка мыши нажата — после её отпускания, как step4_flush_edits; «Принять» (recalc false) идёт к click, когда
    // кнопка уже отпущена, — как force у правок
    if (recalc && step_pointer.down) {
        step4.edit_postponed = true
        return
    }
    step4.window_pending = false
    const field = document.getElementById("step4_window")
    const value = parseInt(field.value)
    let size = step4.window
    if (value > size) {
        size *= 2
    } else if (value < size) {
        size = Math.max(64, size / 2)
    }
    step4.window = size
    field.value = size
    if (recalc && (state.log != null) && step4.filled && (state.step === 4) && step4_stale()) {
        step4_show()
    }
}

// Выбор набора параметров оси: пересчёт, поля оси — значения нового набора (он — база «Как в логе»)
function step4_set_changed(axis, index) {
    step4.set_choice[axis] = index
    step_run(() => {
        if (!step4.filled) {
            return
        }
        step4_compute()
        step4_set_form_values(step4_log_values_of(axis))
        step4_update_custom()
        step4.selected[axis] = step4_form_row(axis)?.id ?? step4.selected[axis]
        step4_redraw_all()
        step4_edit_done()
    }, "verdict4", "шага 4")
}

// Вкладка оси: перерисовать только посчитанное
function step4_select_axis(axis) {
    if (step4.axis === axis) {
        return
    }
    step4.axis = axis
    if (step4_ready()) {
        step_try(() => {
            step4_render_tabs()
            step4_render_axis()
        }, "verdict4", "шага 4")
    }
}

// ---------- Форма параметров ----------

// Описания (title у подписи и поля) из метаданных (step_find_metadata). Единицы и диапазоны не показываются: у ATC_RAT_*
// в params.json — описание вертолёта (path AC_AttitudeControl_Heli, у P единицы s/rad и диапазон до 0.35), у Copter
// они другие
function step4_apply_metadata() {
    const data = step_metadata()
    if (data == null) {
        return
    }
    for (const p of document.querySelectorAll("#pidf_form p.param")) {
        const metadata = step_find_metadata(data, p.dataset.name)
        if (metadata == null) {
            continue
        }
        const description = metadata.Description ?? ""
        p.querySelector("label").title = description
        p.querySelector("input").title = description
    }
}

// Разметка формы: группа на ось, подпись-имя, поле и «в логе»
function step4_build_form() {
    let html = ""
    for (const axis of step4_axis_list) {
        html += '<div class="pgroup"><h3>' + html_escape(step4_axis_names[axis].nom + " · " + pidtune_axes[axis].rate + "*") + '</h3>'
        for (const k of step4_gain_keys) {
            const name = pidtune_axes[axis].rate + k
            const id = "pidf_" + name
            html += '<p class="param" data-name="' + html_escape(name) + '" data-axis="' + axis + '"><label for="' + html_escape(id) + '">' + html_escape(name) + '</label>' +
                '<input type="number" id="' + html_escape(id) + '" step="any" min="0"><span class="inlog"></span></p>'
        }
        html += '</div>'
    }
    document.getElementById("pidf_form").innerHTML = html
    step4.form_built = true
    // Описания — сразу, если метаданные уже пришли, иначе по приходу (одна загрузка на страницу, step_load_metadata)
    if (step_metadata() != null) {
        step4_apply_metadata()
    } else {
        step_load_metadata().then(step4_apply_metadata)
    }
}

// Записать значения (объект имя → число) в поля: числа — кратчайшей записью того же float32, нечисловые — пустое поле
function step4_set_form_values(values) {
    for (const [name, value] of Object.entries(values)) {
        const field = document.getElementById("pidf_" + name)
        if (field != null) {
            field.value = Number.isFinite(value) ? param_to_string(value) : ""
        }
    }
}

// Значения лога оси axis — объект имя → число: коэффициенты набора анализа, без расчёта — последние в логе
function step4_log_values_of(axis) {
    const gains = step4_log_gains(axis)
    const prefix = pidtune_axes[axis].rate
    return Object.fromEntries(step4_gain_keys.map((k) => [prefix + k, gains[k]]))
}

// Значения лога всех осей (объект имя → число)
function step4_log_values() {
    return Object.assign({}, ...step4_axis_list.map(step4_log_values_of))
}

// Коэффициенты лога оси { P, I, D } (null — нет в логе): набора анализа (step4_compute_axis), без него — последние
// значения параметров
function step4_log_gains(axis) {
    const gains = step4.calc?.[axis]?.gains
    if (gains != null) {
        return { P: gains.P, I: gains.I, D: gains.D }
    }
    return step4_axis_gains(Object.fromEntries(step4_param_names().map((name) => [name, state.params.get(name)])), axis)
}

// Заполнить форму значениями лога и подписи «в логе»
function step4_fill_form() {
    step4_set_form_values(step4_log_values())
    step4_render_inlog()
}

// Подписи «в логе: …» — значения набора анализа оси
function step4_render_inlog() {
    const log_values = step4_log_values()
    for (const p of document.querySelectorAll("#pidf_form p.param")) {
        const value = log_values[p.dataset.name]
        p.querySelector(".inlog").textContent = Number.isFinite(value) ? "в логе: " + step_value_text(value) : "в логе нет"
    }
}

// Значения формы: объект имя → число float32 (как в логе). Пустое или нечисловое поле — NaN: значение неизвестно,
// прогноз такого набора даёт NaN, отметки его отмечают, а «Принять» не принимает
function step4_values_from_form() {
    const values = {}
    for (const name of step4_param_names()) {
        const field = document.getElementById("pidf_" + name)
        const text = (field != null) ? field.value.trim() : ""
        values[name] = Math.fround((text === "") ? NaN : Number(text))
    }
    return values
}

// Пометка .changed у полей, чьё значение отличается от лога (пустое поле — тоже отличие)
function step4_mark_changed() {
    if (!step4.filled) {
        return
    }
    const log_values = step4_log_values()
    const values = step4_values_from_form()
    for (const p of document.querySelectorAll("#pidf_form p.param")) {
        const log = log_values[p.dataset.name]
        p.classList.toggle("changed", !(Number.isFinite(log) && step4_same_value(values[p.dataset.name], log)))
    }
}

// ---------- Расчёт ----------

// Значения фильтров гироскопа лога (values_from_log шага 1: INS_GYRO_FILTER, SCHED_LOOP_RATE, INS_HNTCH_*, INS_HNTC2_*)
// как float32 — так их хранит прошивка, и принятое шагами 2–3 сравнивается с ними без ложных отличий
function step4_gyro_old() {
    const values = values_from_log()
    return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, Math.fround(value)]))
}

// Фильтры гироскопа для прогноза: notch, принятые на шаге 2 (иначе лога), и INS_GYRO_FILTER, принятый на шаге 3 (иначе
// шага 2 или лога); имена — те же, что у step4_gyro_old
function step4_gyro_new() {
    const old = values_from_log()
    const base = state.steps[2]?.accepted ?? old
    const gyro = state.steps[3]?.accepted?.INS_GYRO_FILTER ?? base.INS_GYRO_FILTER
    const values = {}
    for (const name of Object.keys(old)) {
        values[name] = Math.fround((name === "INS_GYRO_FILTER") ? gyro : (base[name] ?? old[name]))
    }
    return values
}

// FLTE и FLTD оси для регуляторов вариантов: принятые на шаге 3, иначе лога (log_filters = { flte, fltd })
function step4_new_filters(axis, log_filters) {
    const accepted = state.steps[3]?.accepted
    const prefix = pidtune_axes[axis].rate
    if ((accepted == null) || !((prefix + "FLTE") in accepted) || !((prefix + "FLTD") in accepted)) {
        return { ...log_filters }
    }
    return { flte: accepted[prefix + "FLTE"], fltd: accepted[prefix + "FLTD"] }
}

// Части ключа расчёта: интервал, окно, выбор наборов, фильтры шагов 2–3 (notch и INS_GYRO_FILTER — для поправки,
// FLTE/FLTD — для регуляторов вариантов); если фильтры гироскопа менялись, ещё и расчёт шага 1 (по его окнам
// считается поправка). Фильтры — действующие значения, без принятого шагом 3 — значения лога (lowpass_log_values, как
// их показывает форма шага 3), float32: принятие шага 3 с фильтрами лога ключ не меняет и не даёт ложного «Принято
// раньше…» (ревью задачи 7)
function step4_calc_key() {
    const old = step4_gyro_old()
    const now = step4_gyro_new()
    const gyro_changed = candidate_key(old) !== candidate_key(now)
    const log_values = lowpass_log_values(state.params)
    const filters = step4_axis_list.map((axis) => {
        const prefix = pidtune_axes[axis].rate
        const f = step4_new_filters(axis, { flte: log_values[prefix + "FLTE"], fltd: log_values[prefix + "FLTD"] })
        return [Math.fround(f.flte), Math.fround(f.fltd)]
    })
    return JSON.stringify([state.settings.start, state.settings.end, step4.window, step4.set_choice, candidate_key(now), filters,
                           gyro_changed ? [step1.fft_key, state.spectrum.filter_version] : null])
}

// Фильтры гироскопа для прогноза отличаются от лога
function step4_gyro_changed() {
    return candidate_key(step4_gyro_old()) !== candidate_key(step4_gyro_new())
}

// Расчёт сделан для другого интервала, окна, набора или фильтров (или ещё не сделан)
function step4_stale() {
    return (step4.calc == null) || (step4.key !== step4_calc_key()) || (step4_gyro_changed() && (step4.gyro_ref !== state.gyro))
}

// Расчёт есть и нет своей ошибки
function step4_ready() {
    return (step4.calc != null) && (step4.error == null)
}

// Оси шага в load_pid().axes: PIDx, если в нём есть данные, иначе RATE той же оси, иначе null
function step4_source(axis) {
    const axes = step4.pid?.axes ?? []
    const i = step4_pid_index[axis]
    if (axes[i]?.have_data) {
        return axes[i]
    }
    return axes[i + 3]?.have_data ? axes[i + 3] : null
}

// Наборы параметров оси source в интервале range, у которых есть данные: [{ index, start, end }] по времени
function step4_sets_in(source, range) {
    const list = []
    const sets = source.params.sets
    for (let i = 0; i < sets.length; i++) {
        if ((source.sets[i] == null) || (sets[i].start_time >= range[1]) || (sets[i].end_time <= range[0])) {
            continue
        }
        list.push({ index: i, start: sets[i].start_time, end: sets[i].end_time })
    }
    return list
}

// Набор анализа оси: выбранный пользователем, если он есть среди наборов интервала, иначе действующий в конце интервала
// (последний из наборов интервала); null — наборов с данными в интервале нет
function step4_set_index(axis, sets) {
    const choice = step4.set_choice[axis]
    if (sets.some((s) => s.index === choice)) {
        return choice
    }
    return (sets.length > 0) ? sets[sets.length - 1].index : null
}

// Средняя частота пакетов набора set_index оси source (любой длины), Гц; null — пакетов нет. Нужна, когда отрезков КИХ
// нет вовсе (pidtune_segments → null: ни одного пакета не короче окна): у лога PID с частотой 10 Гц (без ATTITUDE_FAST)
// причина тогда — частота, а не данные
function step4_batch_rate(source, set_index) {
    const batches = source.sets[set_index] ?? []
    return (batches.length > 0) ? batches.reduce((sum, b) => sum + b.sample_rate, 0) / batches.length : null
}

// Расчёт оси axis на интервале range (ctx — step4_compute): данные (PIDx или RATE), набор, отрезки КИХ, режим лога,
// отклик и его метрики, качество измерения, шум D, правило; при надёжном измерении — сверка регулятора, прогноз лога,
// когерентность на частоте среза, достоверность прогноза и варианты. Прогнозы вариантов считает step4_compute (после
// поправки фильтров гироскопа).
// status — почему нет правил, по порядку отказов (раздел 3 дизайна, pidtune_rule): "low_rate" (лог PID реже 99 Гц —
// и когда отрезков нет вовсе), "nodata" (нет данных оси или набора), "missing" (P или I нет в логе), "little" (мало
// манёвров), "noresp" (нет отклика), "unreliable" (проверки качества не пройдены), "ok" — правила есть.
// "noresp" — раньше "unreliable", не как в pidtune_rule (там «ненадёжно» раньше «нет отклика»): без КИХ проверки
// качества не считаются и pidtune_quality даёт ok false с причиной «нет отклика», — «измерение ненадёжно» было бы
// неправдой, а совет тестового полёта не помог бы (КИХ не решился на тех же данных)
function step4_compute_axis(axis, range, ctx) {
    const res = {
        axis: axis, source: step4_source(axis), is_rate: false, sets: [], set_index: null, gains: null, filters_log: null, filters_new: null,
        fltt: null, slew: null, seg: null, rate_hz: null, mode: null, fir: null, quality: null, metrics: null, d_noise: null, rule: null,
        status: "nodata", cc: null, grid: null, c_log: null, pred_log: null, coherence: null, validity: null, predict_ok: false,
        loop_rate: ctx.loop_rate, ratio: null, ratio_note: null, candidates: null, predictions: null, flags: null, custom: null,
    }
    const source = res.source
    if (source != null) {
        res.is_rate = source.id[0] === "RATE"
        res.sets = step4_sets_in(source, range)
        res.set_index = step4_set_index(axis, res.sets)
    }
    if (res.set_index == null) {
        const gains = step4_log_gains(axis)
        res.gains = { ...gains, FF: 0, DFF: 0 }
        res.candidates = [{ id: "log", title: "Как в логе", values: gains, same_as: [] }]
        return res
    }
    const set = source.params.sets[res.set_index]
    res.gains = { P: set.KP, I: set.KI, D: set.KD, FF: set.FF ?? 0, DFF: set.D_FF ?? 0 }
    res.filters_log = { flte: set.Error_filter, fltd: set.D_filter }
    res.filters_new = step4_new_filters(axis, res.filters_log)
    res.fltt = set.Target_filter
    res.slew = set.Slew_max
    const log_values = { P: res.gains.P, I: res.gains.I, D: res.gains.D }

    res.seg = pidtune_segments(source, res.set_index, range)
    res.rate_hz = res.seg?.rate_hz ?? step4_batch_rate(source, res.set_index)
    res.mode = pidtune_log_mode(state.log, state.params, state.version, range, axis, res.rate_hz)
    res.fir = (res.seg != null) ? pidtune_fir(res.seg.segments, res.seg.rate_hz) : null
    res.quality = pidtune_quality(res.seg?.segments ?? [], res.rate_hz, res.fir, { rate_only: res.mode.rate_only })
    res.metrics = (res.fir != null) ? pidtune_step_metrics(res.fir.time, res.fir.step) : null
    res.d_noise = pidtune_d_noise(source, res.set_index, range)
    res.rule = pidtune_rule(log_values, axis, res.metrics, res.seg?.data_s ?? 0, res.quality)

    if (res.mode.low_rate) {
        res.status = "low_rate"
    } else if (res.seg == null) {
        res.status = "nodata"
    } else if (!Number.isFinite(res.gains.P) || !Number.isFinite(res.gains.I)) {
        res.status = "missing"
    } else if (!(res.seg.data_s >= pidtune_rules.min_data_s)) {
        res.status = "little"
    } else if (res.metrics == null) {
        res.status = "noresp"
    } else if (!res.quality.ok) {
        res.status = "unreliable"
    } else {
        res.status = "ok"
    }
    if (res.status !== "ok") {
        res.candidates = [{ id: "log", title: "Как в логе", values: log_values, same_as: [] }]
        return res
    }

    // Надёжное измерение: варианты по правилам и проверка достоверности прогноза
    res.candidates = pidtune_candidates(log_values, res.rule, axis)
    res.cc = pidtune_controller_check(source, res.set_index, range, res.gains, res.filters_log, ctx.loop_rate, res.mode.i_scale)
    res.grid = pidtune_predict_grid(res.rate_hz)
    res.c_log = pidtune_controller(res.gains, res.filters_log, ctx.loop_rate, res.grid.freq, res.mode.i_scale)
    res.pred_log = pidtune_predict(res.fir, res.c_log, res.c_log, null, res.rate_hz)
    res.coherence = pidtune_coherence(res.seg.segments, res.rate_hz, res.pred_log?.crossover_hz)
    res.validity = pidtune_validity(res.quality, res.cc, res.coherence)
    res.predict_ok = res.validity.valid
    return res
}

// Прогноз значений values = { P, I, D } на оси res (step4_compute_axis с достоверным прогнозом): регулятор с FF и DFF
// лога и FLTE/FLTD для вариантов, поправка фильтров гироскопа res.ratio, отметки против прогноза лога
// → { pred, flags }
function step4_predict(res, values) {
    const gains = { P: values.P, I: values.I, D: values.D, FF: res.gains.FF, DFF: res.gains.DFF }
    const c_new = pidtune_controller(gains, res.filters_new, res.loop_rate, res.grid.freq, res.mode.i_scale)
    const pred = pidtune_predict(res.fir, res.c_log, c_new, res.ratio, res.rate_hz)
    return { pred: pred, flags: pidtune_flags(pred, res.pred_log) }
}

// Расчёт шага для текущего интервала, окна, наборов и фильтров шагов 2–3: FFT осей (если сменилось окно), расчёт
// каждой оси, поправка фильтров гироскопа (только для осей с достоверным прогнозом и только если фильтры менялись —
// тогда нужен расчёт шага 1, step_ensure_step1) и прогнозы вариантов. Выбор строки оси сохраняется, если пользователь
// выбрал не строку по умолчанию и она осталась; иначе — рекомендованная или «Как в логе». Ключ расчёта пишется только
// после успешного расчёта: после исключения step4_stale() даст true, и следующий показ посчитает заново
function step4_compute() {
    const previous = { ...step4.selected }
    const previous_default = Object.fromEntries(step4_axis_list.map((axis) => [axis, (step4.calc != null) ? (step4_recommended_id(axis) ?? "log") : null]))
    const previous_sets = Object.fromEntries(step4_axis_list.map((axis) => [axis, (step4.calc != null) ? { set_index: step4.calc[axis].set_index,
        source: step4.calc[axis].source, gains: step4.calc[axis].gains } : null]))
    step4.key = null
    step4.gyro_ref = null
    step4.calc = null
    step4.error = null
    const pid = step4.pid
    if (!pid.have_data) {
        step4.error = "Нет данных PID: " + ((pid.warnings.length > 0) ? pid.warnings.join("; ") : "в логе нет сообщений PIDR/PIDP/PIDY и RATE")
        return
    }

    // FFT компонент осей шага (спектр D для шума D) — один раз на окно
    if (step4.fft_window !== step4.window) {
        step4.fft_window = null
        for (const axis of step4_axis_list) {
            const source = step4_source(axis)
            if (source != null) {
                pid_run_batch_fft(source.sets, step4.window)
            }
        }
        step4.fft_window = step4.window
    }

    const range = [state.settings.start, state.settings.end]
    const gyro_old = step4_gyro_old()
    const gyro_new = step4_gyro_new()
    const gyro_changed = candidate_key(gyro_old) !== candidate_key(gyro_new)
    // Частота контура лога; нет в логе — заводская 400 Гц, как values_from_log шага 1 (заметка — step4_render_warnings)
    const ctx = { loop_rate: state.params.get("SCHED_LOOP_RATE") ?? 400 }
    const calc = {}
    for (const axis of step4_axis_list) {
        calc[axis] = step4_compute_axis(axis, range, ctx)
    }

    // Поправка фильтров гироскопа и прогнозы вариантов — у осей с достоверным прогнозом
    const predicted = step4_axis_list.filter((axis) => calc[axis].predict_ok)
    const step1_error = (gyro_changed && (predicted.length > 0)) ? step_ensure_step1() : null
    for (const axis of predicted) {
        const res = calc[axis]
        if (gyro_changed) {
            if (step1_error != null) {
                res.ratio_note = "нет расчёта шага 1 (" + step1_error + ")"
            } else {
                const gyro = state.gyro
                const sensor = step_gyro_sensor() ?? find_instance(gyro, gyro.primary ?? gyro.first_gyro, true) ?? null
                res.ratio = pidtune_gyro_ratio(gyro_old, gyro_new, { gyro: gyro, env: state.env, tracking: state.tracking, range: range, sensor: sensor }, res.grid.freq)
                if (res.ratio == null) {
                    res.ratio_note = "нет окон FFT гироскопа в интервале"
                }
            }
        }
        res.predictions = {}
        res.flags = {}
        for (const candidate of res.candidates) {
            const p = step4_predict(res, candidate.values)
            res.predictions[candidate.id] = p.pred
            res.flags[candidate.id] = p.flags
        }
    }
    step4.calc = calc
    step4_follow_sets(previous_sets)
    step4_update_custom()
    for (const axis of step4_axis_list) {
        const keep = (previous[axis] != null) && (previous[axis] !== previous_default[axis]) && step4_rows(axis).some((r) => r.id === previous[axis])
        step4.selected[axis] = keep ? previous[axis] : (step4_recommended_id(axis) ?? "log")
    }
    step4.key = step4_calc_key()
    step4.gyro_ref = state.gyro
}

// Набор анализа оси сменился (новый интервал), а поля оси равны значениям прежнего набора — в поля значения нового
// набора: он теперь «Как в логе». Правленые вручную поля не трогаются (ревью задачи 7). previous — { ось: { set_index,
// source, gains } | null } до пересчёта
function step4_follow_sets(previous) {
    if (!step4.filled) {
        return
    }
    const values = step4_values_from_form()
    for (const axis of step4_axis_list) {
        const old = previous[axis]
        const res = step4.calc[axis]
        if ((old == null) || ((old.set_index === res.set_index) && (old.source === res.source))) {
            continue
        }
        const form = step4_axis_gains(values, axis)
        if (step4_gain_keys.every((k) => step4_same_value(form[k], old.gains?.[k]))) {
            step4_set_form_values(step4_log_values_of(axis))
        }
    }
}

// Строки «Свой»: значения формы оси, если они не совпали ни с одним вариантом, с прогнозом и отметками (при
// достоверном прогнозе). Те же значения — прежняя строка
function step4_update_custom() {
    if (step4.calc == null) {
        return
    }
    const values = step4.filled ? step4_values_from_form() : null
    for (const axis of step4_axis_list) {
        const res = step4.calc[axis]
        if (values == null) {
            res.custom = null
            continue
        }
        const gains = step4_axis_gains(values, axis)
        const key = step4_gain_key(gains)
        if (res.candidates.some((c) => step4_gain_key(c.values) === key)) {
            res.custom = null
            continue
        }
        if ((res.custom != null) && (step4_gain_key(res.custom.values) === key)) {
            continue
        }
        const row = { id: "custom", title: "Свой", values: gains, same_as: [], pred: null, flags: null }
        if (res.predict_ok) {
            const p = step4_predict(res, gains)
            row.pred = p.pred
            row.flags = p.flags
        }
        res.custom = row
    }
}

// Строки таблицы оси: варианты (с прогнозом и отметками, если они есть) и «Свой»
function step4_rows(axis) {
    const res = step4.calc?.[axis]
    if (res == null) {
        return []
    }
    const rows = res.candidates.map((c) => ({ ...c, pred: res.predictions?.[c.id] ?? null, flags: res.flags?.[c.id] ?? null }))
    if (res.custom != null) {
        rows.push(res.custom)
    }
    return rows
}

// Строка таблицы оси со значениями формы (вариант или «Свой»); null — форма не заполнена или расчёта нет
function step4_form_row(axis) {
    if (!step4.filled) {
        return null
    }
    const key = step4_gain_key(step4_axis_gains(step4_values_from_form(), axis))
    return step4_rows(axis).find((r) => step4_gain_key(r.values) === key) ?? null
}

// Выбранная строка таблицы оси — единственный источник выбора для «Применить вариант», вердикта и (в задаче 8)
// графиков: step4.selected[axis], а если такой строки нет — рекомендованная или «Как в логе»; null — строк нет
function step4_selected_row(axis) {
    const rows = step4_rows(axis)
    return rows.find((r) => r.id === step4.selected[axis]) ?? rows.find((r) => r.id === (step4_recommended_id(axis) ?? "log")) ?? null
}

// Рекомендуемая строка оси — «По правилам» или та, с которой он совпал (same_as); null — правил нет
function step4_recommended_id(axis) {
    return (step4.calc?.[axis]?.candidates ?? []).find((c) => (c.id === "rule") || c.same_as.includes("rule"))?.id ?? null
}

// Середина полосы «менять нечего» правил по перерегулированию, % (12.5 % при 5–20 %) — цель выбора лучшего
// неотмеченного варианта
function step4_best_target_pct() {
    return (pidtune_rules.overshoot_low_pct + pidtune_rules.overshoot_high_pct) / 2
}

// Лучший неотмеченный вариант оси (не «Свой», «Как в логе» допустим; решение координатора по ревью задачи 7):
// перерегулирование прогноза ближе всего к середине полосы «менять нечего» (step4_best_target_pct); близкие к лучшему
// в пределах step4_best_tie_pct считаются равными — из них без колебаний в прогнозе (metrics.osc), затем с большим
// запасом фазы. null — неотмеченных вариантов с метриками прогноза нет
function step4_best_unflagged(axis) {
    const target = step4_best_target_pct()
    const rows = step4_rows(axis).filter((row) => (row.id !== "custom") && (row.flags != null) && !row.flags.flagged &&
                                                  Number.isFinite(row.pred?.metrics?.overshoot_pct) && Number.isFinite(row.pred?.pm_deg))
    if (rows.length == 0) {
        return null
    }
    const distance = (row) => Math.abs(row.pred.metrics.overshoot_pct - target)
    const nearest = Math.min(...rows.map(distance))
    const close = rows.filter((row) => distance(row) <= nearest + step4_best_tie_pct)
    const calm = close.filter((row) => row.pred.metrics.osc == null)
    return (calm.length > 0 ? calm : close).reduce((best, row) => (row.pred.pm_deg > best.pred.pm_deg) ? row : best)
}

// ---------- Действия ----------
// Неожиданная ошибка действия — в консоль и вердикт «Ошибка шага 4: …»: step_try (сразу) и step_run (под оверлеем)

// Показ шага: данные PID (один раз на лог), форма (один раз на лог, значения — наборов анализа), расчёт заново, если
// сменились интервал, окно, набор или фильтры шагов 2–3. Расчёт на тестовом логе (400 Гц, 3 оси) — доли секунды
function step4_show() {
    if (state.log == null) {
        return
    }
    step_run(() => {
        if (step4.pid == null) {
            step4.pid = load_pid(state.log, { build_type: state.info.build_type })
        }
        if (!step4.form_built) {
            step4_build_form()
        }
        if (step4_stale()) {
            step4_compute()
        }
        if (!step4.filled) {
            step4_fill_form()
            step4.filled = true
        }
        step4_update_custom()
        step4_redraw_all()
        // Введённое учтено: отложенный пересчёт правок не нужен
        clearTimeout(step4.edit_timer)
        step4.edit_timer = null
        step4_edit_done()
    }, "verdict4", "шага 4")
}

// «Применить вариант»: значения выбранной строки оси открытой вкладки — в поля этой оси. Ось и строка запоминаются
// до досчёта правок: досчёт выбирает в оси строку формы («Свой»), а щелчок шёл по строке, выбранной до него (ревью
// задачи 7). Значения строки берутся после досчёта — по её id
function step4_apply() {
    if (!step4.filled) {
        return
    }
    const axis = step4.axis
    const row_id = step4_ready() ? (step4_selected_row(axis)?.id ?? null) : null
    step4_flush_edits(true)
    if (!step4_ready() || (row_id == null)) {
        return
    }
    const row = step4_rows(axis).find((r) => r.id === row_id)
    if (row == null) {
        return
    }
    step4.selected[axis] = row.id
    const prefix = pidtune_axes[axis].rate
    step4_set_form_values(Object.fromEntries(step4_gain_keys.map((k) => [prefix + k, row.values[k]])))
    step4_flush_edits(true)
}

// Поля, которые принять нельзя: пустые (значение неизвестно) и отрицательные → текст отказа или null
function step4_accept_refusal(values) {
    const names = step4_param_names()
    const empty = names.filter((name) => !Number.isFinite(values[name]))
    const negative = names.filter((name) => values[name] < 0)
    const parts = []
    if (empty.length > 0) {
        parts.push("не заполнены поля: " + empty.join(", "))
    }
    if (negative.length > 0) {
        parts.push("отрицательные значения: " + negative.join(", "))
    }
    return (parts.length > 0) ? "Принять нельзя — " + parts.join("; ") + "." : null
}

// Сводка оси для итога мастера: измеренный отклик и его надёжность, прогноз лога и строки формы (если он достоверен)
function step4_metrics_summary(axis, row) {
    const res = step4.calc[axis]
    const m = res.metrics
    const pred_summary = (pred) => (pred == null) ? null : {
        pm_deg: pred.pm_deg, crossover_hz: pred.crossover_hz, unstable: pred.unstable,
        rise_s: pred.metrics?.rise_s ?? null, overshoot_pct: pred.metrics?.overshoot_pct ?? null, settle_s: pred.metrics?.settle_s ?? null,
    }
    return {
        source: (res.source != null) ? res.source.id.join(" ") : null,
        status: res.status,
        reliable: res.status === "ok",
        prediction_valid: res.predict_ok,
        windows: res.seg?.windows ?? 0,
        data_s: res.seg?.data_s ?? 0,
        measured: (m == null) ? null : { rise_s: m.rise_s, overshoot_pct: m.overshoot_pct, plateau: m.plateau, settle_s: m.settle_s, osc: m.osc },
        log: pred_summary(res.pred_log),
        prediction: res.predict_ok ? pred_summary(row?.pred ?? null) : null,
        d_noise_dB: res.d_noise?.dB ?? null,
    }
}

// «Принять»: значения формы, по каждой оси — строка формы (вариант или «custom»), её отметки и сводка метрик, ключ
// расчёта — в итог мастера, затем шаг 5. Правки полей сначала досчитываются. Пустые и отрицательные значения
// принять нельзя (step4_accept_refusal)
function step4_accept() {
    step4_flush_window(false)
    step4_flush_edits(true)
    step_run(() => {
        if (!step4.filled || (state.log == null)) {
            return
        }
        if (step4_stale()) {
            step4_compute()
            step4_update_custom()
        }
        if (!step4_ready()) {
            step4_redraw_all()
            return
        }
        const values = step4_values_from_form()
        const refusal = step4_accept_refusal(values)
        if (refusal != null) {
            step_verdict("verdict4", "fail", refusal)
            return
        }
        step4_update_custom()
        const axes = {}
        for (const axis of step4_axis_list) {
            const row = step4_form_row(axis)
            axes[axis] = {
                candidate_id: ((row != null) && (row.id !== "custom")) ? row.id : "custom",
                flags: row?.flags ?? null,
                metrics: step4_metrics_summary(axis, row),
            }
        }
        state.steps[4] = { accepted: values, axes: axes, calc_key: step4.key, evaluated_at: Date.now() }
        step4_redraw_all()
        set_step(5)
    }, "verdict4", "шага 4")
}

// ---------- Отрисовка ----------

function step4_redraw_all() {
    step4_mark_changed()
    step4_render_inlog()
    const ready = step4_ready()
    document.getElementById("pidf_accept").disabled = !(ready && step4.filled)
    document.getElementById("step4_open_pidreview").disabled = state.file == null
    if (!ready) {
        for (const id of ["step4_tabs", "step4_panel"]) {
            document.getElementById(id).hidden = true
        }
        document.getElementById("cand4_apply").disabled = true
        step_verdict("verdict4", "fail", step4.error ?? "Расчёт шага 4 не готов")
        return
    }
    step4_render_tabs()
    step4_render_summary()
    step4_render_axis()
}

// Короткое состояние оси для вкладки и сводки: { text, cls: "bad" | "warn" | "ok", reason, all } — у оси без правил
// reason — причина словами для сводки, all — она же фразой «на всех осях» (сводка, если причина у осей одна)
function step4_axis_state(axis) {
    const res = step4.calc[axis]
    switch (res.status) {
        case "nodata":
            return { text: "нет данных", cls: "bad", reason: "нет данных PID", all: "Нет данных PID на всех осях" }
        case "low_rate": {
            const rate = step4_fixed(res.rate_hz, 1) + " Гц"
            return { text: "лог " + step4_fixed(res.rate_hz, 0) + " Гц", cls: "bad", reason: "лог PID " + rate + " — включите ATTITUDE_FAST",
                     all: "Лог PID записан с частотой " + rate + " — отклик не считается, включите ATTITUDE_FAST в LOG_BITMASK" }
        }
        case "missing":
            return { text: "нет коэффициента", cls: "bad", reason: "нет коэффициента в логе", all: "Нет коэффициентов P или I в логе на всех осях" }
        case "little":
            return { text: "мало манёвров", cls: "warn", reason: "мало манёвров", all: "Мало манёвров на всех осях" }
        case "noresp":
            return { text: "нет отклика", cls: "bad", reason: "нет отклика", all: "Нет отклика на всех осях" }
        case "unreliable": {
            const failed = step4_failed_checks(res.quality)
            const checks = (failed.length == 1) ? "не пройдена проверка " + failed[0] : "не пройдены проверки " + failed.join(", ")
            return { text: "ненадёжно " + failed.join(" "), cls: "bad", reason: "измерение ненадёжно (" + checks + ")",
                     all: "Измерение ненадёжно на всех осях (" + checks + ")" }
        }
    }
    const change = { "P+": "P +", "P-": "P −", "D-": "D −" }[res.rule.change]
    let text = (change != null) ? change + Math.round(pidtune_rules.gain_step * 100) + " %" : "без изменений"
    let cls = "ok"
    const recommended = step4_rows(axis).find((r) => r.id === step4_recommended_id(axis))
    if (!res.predict_ok) {
        text += " · без прогноза"
        cls = "warn"
    } else if (recommended?.flags?.flagged) {
        text += " · отметки"
        cls = "warn"
    }
    return { text: text, cls: cls, reason: null, all: null }
}

// Вкладки: выбранная (aria-selected, tabindex), короткое состояние оси второй строкой и третьей — что в форме, если
// не значения лога («в форме свои значения», «в форме «P +10 %»»): правка поля другой оси видна, а вкладка остаётся
function step4_render_tabs() {
    for (const axis of step4_axis_list) {
        const tab = document.getElementById("step4_tab_" + axis)
        const selected = axis === step4.axis
        tab.setAttribute("aria-selected", selected ? "true" : "false")
        tab.tabIndex = selected ? 0 : -1
        const s = step4_axis_state(axis)
        const sub = tab.querySelector(".s")
        sub.textContent = s.text
        sub.className = "s s--" + s.cls
        const form = step4_form_row(axis)
        tab.querySelector(".f").textContent = ((form == null) || (form.id === "log")) ? "" : "в форме " + ((form.id === "custom") ? "свои значения" : "«" + form.title + "»")
    }
    document.getElementById("step4_panel").setAttribute("aria-labelledby", "step4_tab_" + step4.axis)
    document.getElementById("step4_tabs").hidden = false
}

// Принятое шагом 4 совпадает с формой: принятое (state.steps[4]) или null
function step4_accepted_now() {
    const accepted = state.steps[4]
    if ((accepted == null) || !step4.filled) {
        return null
    }
    return (candidate_key(accepted.accepted) === candidate_key(step4_values_from_form())) ? accepted : null
}

// Название строки словами: «По правилам» в кавычках или «свои значения»
function step4_row_name(axis, id) {
    if (id === "custom") {
        return "свои значения"
    }
    const row = step4_rows(axis).find((r) => r.id === id)
    return "«" + (row?.title ?? id) + "»"
}

// Сводка над вкладками — главный вывод шага одной строкой: принятое; нет надёжного измерения ни на одной оси — это
// и совет тестового полёта; иначе — что предлагается по осям
function step4_render_summary() {
    const accepted = step4_accepted_now()
    if (accepted != null) {
        if (accepted.calc_key !== step4_calc_key()) {
            step_verdict("verdict4", "warn", "Принято раньше для другого интервала, окна FFT, набора или фильтров шагов 2–3 — проверьте и примите заново.")
            return
        }
        const names = step4_axis_list.map((axis) => step4_axis_names[axis].nom.toLowerCase() + " " + step4_row_name(axis, accepted.axes[axis].candidate_id))
        const flagged = step4_axis_list.filter((axis) => accepted.axes[axis].flags?.flagged)
        if (flagged.length > 0) {
            const worse = flagged.map((axis) => step4_axis_names[axis].nom.toLowerCase() + " — " + accepted.axes[axis].flags.reasons.join(", ")).join("; ")
            step_verdict("verdict4", "warn", "Принято, но прогноз помечает: " + worse + ". Принято: " + names.join(", ") + ".")
        } else {
            step_verdict("verdict4", "ok", "Принято: " + names.join(", ") + ".")
        }
        return
    }

    const states = Object.fromEntries(step4_axis_list.map((axis) => [axis, step4_axis_state(axis)]))
    const reliable = step4_axis_list.filter((axis) => step4.calc[axis].status === "ok")
    if (reliable.length == 0) {
        if (step4_axis_list.every((axis) => step4.calc[axis].status === "nodata")) {
            step_verdict("verdict4", "fail", "Нет данных PID ни по одной оси в интервале анализа — выберите другой интервал на шаге 0.")
            return
        }
        // Одинаковая причина у всех осей — одной фразой
        const reasons = [...new Set(step4_axis_list.map((axis) => states[axis].reason))]
        const what = (reasons.length == 1) ? states.roll.all
            : "Надёжного измерения нет ни на одной оси: " + step4_axis_list.map((axis) => step4_axis_names[axis].nom.toLowerCase() + " — " + states[axis].reason).join(", ")
        step_verdict("verdict4", "warn", what + " — правил и прогноза нет; " + step4_test_flight_short + " (подробности — во вкладках осей).")
        return
    }

    let status = "ok"
    const parts = []
    for (const axis of step4_axis_list) {
        const res = step4.calc[axis]
        const name = step4_axis_names[axis].nom.toLowerCase()
        if (res.status !== "ok") {
            parts.push(name + " — " + states[axis].reason)
            status = "warn"
            continue
        }
        const recommended = step4_rows(axis).find((r) => r.id === step4_recommended_id(axis))
        let text = (res.rule.change != null) ? "«По правилам» (" + states[axis].text.split(" · ")[0] + ")" : "менять нечего"
        if (!res.predict_ok) {
            text += ", прогноз недостоверен"
            status = "warn"
        } else if (recommended?.flags?.flagged) {
            const best = step4_best_unflagged(axis)
            text += ", но прогноз помечает его" + ((best != null) ? " — лучший неотмеченный «" + best.title + "»" : "")
            status = "warn"
        }
        parts.push(name + " — " + text)
    }
    const unreliable = step4_axis_list.filter((axis) => step4.calc[axis].status !== "ok")
    const tail = (unreliable.length > 0) ? " По осям без надёжного измерения " + step4_test_flight_short + "." : ""
    step_verdict("verdict4", status, "Предлагается: " + parts.join("; ") + "." + tail)
}

// Панель оси: набор параметров, вердикт, заметки, плитки, качество измерения, таблица вариантов
function step4_render_axis() {
    document.getElementById("step4_panel").hidden = false
    step4_render_sets()
    step4_render_axis_verdict()
    step4_render_warnings()
    step4_render_metrics()
    step4_render_quality()
    step4_render_candidates()
}

// Выбор набора параметров оси — только если в интервале их больше одного
function step4_render_sets() {
    const res = step4.calc[step4.axis]
    const row = document.getElementById("step4_sets_row")
    if (res.sets.length <= 1) {
        row.hidden = true
        return
    }
    const last = res.sets[res.sets.length - 1].index
    document.getElementById("step4_sets").innerHTML = res.sets.map((s, i) => {
        const id = "step4_set_" + s.index
        const end = Number.isFinite(s.end) ? s.end.toFixed(0) : "конец лога"
        return '<label><input type="radio" name="step4_set" id="' + id + '" value="' + s.index + '"' + ((s.index === res.set_index) ? " checked" : "") + '>' +
            '<span>набор ' + (i + 1) + ': ' + html_escape(s.start.toFixed(0) + "–" + end + " с" + ((s.index === last) ? " (в конце интервала)" : "")) + '</span></label>'
    }).join("")
    row.hidden = false
}

// Отклик словами: нарастание, перерегулирование, установление, колебания
function step4_response_text(metrics) {
    const osc = (metrics.osc != null) ? "колебания " + metrics.osc.freq_hz.toFixed(1) + " Гц (размах " + metrics.osc.amplitude_pp.toFixed(2) + ")" : "колебаний нет"
    return "нарастание " + step4_ms(metrics.rise_s) + ", перерегулирование " + metrics.overshoot_pct.toFixed(1) + " %, установление " +
        ((metrics.settle_s != null) ? step4_ms(metrics.settle_s) : "— не установился за " + pidtune_rules.step_length_s + " с") + ", " + osc
}

// Изменения строки против лога словами: «P 0.1163 → 0.1279, I 0.1163 → 0.1279»; без изменений — пусто
function step4_changes_text(axis, values) {
    const log = step4.calc[axis].gains
    return step4_gain_keys.filter((k) => !step4_same_value(values[k], log[k]))
        .map((k) => k + " " + step_value_text(log[k]) + " → " + step_value_text(values[k])).join(", ")
}

// Текст неустойчивости строки — из отметок pidtune_flags («контур неустойчив (запас фазы …)» или «прогноз неустойчив —
// вариант на грани устойчивости или прогноз ненадёжен …»): первый в reasons, когда unstable
function step4_unstable_text(row) {
    return row.flags?.unstable ? row.flags.reasons[0] : "прогноз неустойчив"
}

// Прогноз строки (pred, flags) словами против прогноза лога: запас фазы, частота среза, перерегулирование, нарастание
function step4_prediction_text(row, pred_log) {
    const pred = row.pred
    if (pred == null) {
        return "прогноза нет"
    }
    if (pred.unstable) {
        return step4_unstable_text(row)
    }
    const m = pred.metrics
    return "запас фазы " + step4_fixed(pred.pm_deg, 1) + "° (лог " + step4_fixed(pred_log?.pm_deg, 1) + "°), частота среза " + step4_fixed(pred.crossover_hz, 2) +
        " Гц (лог " + step4_fixed(pred_log?.crossover_hz, 2) + "), перерегулирование " + step4_fixed(m?.overshoot_pct, 1) + " % (лог " +
        step4_fixed(pred_log?.metrics?.overshoot_pct, 1) + " %), нарастание " + step4_ms(m?.rise_s) + " (лог " + step4_ms(pred_log?.metrics?.rise_s) + ")"
}

// Вердикт оси: что показал отклик и измерение, режим лога, предложение, прогноз или причина недостоверности, мало
// манёвров, D выключен, шум D, поправка фильтров гироскопа, что делать
function step4_render_axis_verdict() {
    const axis = step4.axis
    const res = step4.calc[axis]
    const rules = pidtune_rules
    const prefix = pidtune_axes[axis].rate
    const parts = []
    let action = null
    let status = "ok"
    const warn = () => {
        if (status === "ok") {
            status = "warn"
        }
    }
    const data_text = (res.seg != null) ? step4_windows_text(res.seg.windows) + ", " + res.seg.data_s.toFixed(1) + " с данных" : null
    const response = (res.metrics != null) ? "Отклик КИХ МНК (" + data_text + "): " + step4_response_text(res.metrics) + "." : null

    // Источник RATE: отклик включает FLTT
    const rate_note = () => {
        if (!res.is_rate) {
            return
        }
        const lag = (Number.isFinite(res.fltt) && (res.fltt > 0)) ? " (≈ " + (1000 / (2 * Math.PI * res.fltt)).toFixed(1) + " мс при FLTT " + step_value_text(res.fltt) + " Гц)" : ""
        parts.push("Цель — из RATE (сообщений PIDR/PIDP/PIDY в логе нет): она записана до фильтра FLTT, поэтому отклик включает FLTT и немного " +
                   "медленнее настоящего" + lag + ".")
    }
    // Смешение режимов — предупреждение и на надёжной оси (вердикт не зелёный): (б) его не всегда ловит
    const mixed_note = () => {
        if (res.mode?.mixed_modes.length > 0) {
            warn()
            parts.push("В интервале режимы " + res.mode.mixed_modes.join(", ") + ": смешение режимов ломает проверку (б) — для измерения выберите " +
                       "интервал одного режима.")
        }
    }

    switch (res.status) {
        case "nodata":
            status = "fail"
            parts.push((res.source == null) ? "Нет данных PID оси (сообщений " + ["PIDR", "PIDP", "PIDY"][step4_pid_index[axis]] + " и RATE) — предложений нет."
                : "В интервале нет данных оси: ни одного пакета лога PID не короче " + rules.window + " отсчётов в наборе — предложений нет.")
            break
        case "low_rate":
            status = "fail"
            parts.push("Частота лога PID " + step4_fixed(res.rate_hz, 1) + " Гц ниже " + PID_STEP_MIN_RATE + " Гц — отклик не считается: включите ATTITUDE_FAST в " +
                       "LOG_BITMASK (без него PID пишутся с частотой 10 Гц).")
            break
        case "missing":
            status = "fail"
            parts.push("Без изменений: " + res.rule.reason + ".")
            break
        case "little":
            warn()
            parts.push("Мало манёвров — предложений нет: " + res.rule.reason.replace(/^мало манёвров: /, "") + ".")
            if (response != null) {
                parts.push(response)
            }
            rate_note()
            parts.push(step4_test_flight)
            break
        case "noresp":
            status = "fail"
            parts.push("Нет отклика: " + ((res.quality.reasons.length > 0) ? res.quality.reasons.join("; ") : "КИХ не решился") + " — предложений нет.")
            break
        case "unreliable":
            warn()
            parts.push("Измерение ненадёжно — правил и прогноза нет" + (res.mode.rate_only ? ", хотя это лог тестового полёта Acro «Rate Loop Only»" : "") +
                       ": " + res.quality.reasons.join("; ") + ".")
            parts.push(response + " Отклик показан с пометкой: по нему не судят.")
            mixed_note()
            rate_note()
            parts.push(step4_test_flight)
            break
        case "ok": {
            parts.push(response)
            if (res.mode.rate_only) {
                parts.push("Лог тестового полёта Acro «Rate Loop Only» — измерение точное (угловой контур выключен устройством режима).")
            }
            rate_note()
            mixed_note()
            const rule = res.rule
            const recommended_id = step4_recommended_id(axis)
            const recommended = step4_rows(axis).find((r) => r.id === recommended_id) ?? null
            if (rule.change != null) {
                parts.push("Предлагается «По правилам»: " + step4_changes_text(axis, rule.values) + " — " + rule.reason + ".")
            } else {
                parts.push("По правилам: " + rule.reason + ".")
            }
            if (!res.predict_ok) {
                warn()
                parts.push("Прогноз недостоверен: " + res.validity.reasons.join("; ") + " — остаются только правила.")
            } else if (recommended != null) {
                const title = (recommended.id === "log") ? "«Как в логе»" : "«" + recommended.title + "»"
                parts.push("Прогноз " + title + ": " + step4_prediction_text(recommended, res.pred_log) + ".")
                if (recommended.flags?.flagged) {
                    warn()
                    const best = step4_best_unflagged(axis)
                    const target = step4_best_target_pct()
                    parts.push("Прогноз помечает его: " + recommended.flags.reasons.join(", ") + ". " + ((best != null)
                        ? "Лучший неотмеченный (перерегулирование ближе всего к " + target + " %, середине полосы «менять нечего») — «" + best.title +
                          "»: перерегулирование " + best.pred.metrics.overshoot_pct.toFixed(1) + " %, запас фазы " + best.pred.pm_deg.toFixed(1) + "°."
                        : "Неотмеченных вариантов нет."))
                }
                // В форме другая строка с отметками (например, «Свой» после правки) — сказать, что с ней не так
                const form = step4_form_row(axis)
                if ((form != null) && (form.id !== recommended.id) && form.flags?.flagged) {
                    warn()
                    parts.push("В форме — " + step4_row_name(axis, form.id) + ": прогноз помечает " + ((form.id === "custom") ? "их" : "его") + " — " +
                               form.flags.reasons.join(", ") + ".")
                }
                if (res.ratio_note != null) {
                    warn()
                    parts.push("Поправки фильтров гироскопа шагов 2–3 в прогнозе нет: " + res.ratio_note + " — прогноз с фильтрами гироскопа лога.")
                }
            }
            // Что делать (в конце вердикта): принятое для этого расчёта, значения уже в форме, строка выбрана, выбрать её
            if (step4_accepted_now()?.calc_key === step4.key) {
                action = "Принято."
            } else if (recommended != null) {
                const form = step4_form_row(axis)
                const name = (recommended.id === "log") ? "Значения лога" : "Значения «" + recommended.title + "»"
                if (form?.id === recommended.id) {
                    action = name + " уже в форме — нажмите «Принять»."
                } else if (step4_selected_row(axis)?.id === recommended.id) {
                    action = "Строка выбрана — нажмите «Применить вариант», затем «Принять»."
                } else {
                    action = "Выберите строку «" + recommended.title + "» и нажмите «Применить вариант», затем «Принять»."
                }
            }
            break
        }
    }
    // D выключен, шум D — у оси с данными
    if (res.gains?.D === 0) {
        parts.push("D выключен (" + prefix + "D = 0): вариантов D ±" + Math.round(rules.gain_step * 100) + " % и шума D нет.")
    } else if (res.d_noise?.over) {
        warn()
        parts.push("Шум D выше " + rules.d_noise_hz + " Гц " + res.d_noise.dB.toFixed(1) + " дБ — выше порога " + rules.d_noise_threshold + " дБ: горячие моторы — " +
                   "снизьте D или FLTD (шаг 3).")
    }
    if (action != null) {
        parts.push(action)
    }
    step_verdict("axis_verdict4", status, parts.join(" "))
}

// Заметки под вердиктом оси: чего модель регулятора не учитывает (NEF, SMAX, быстрый поток), FF, что не определилось
// в режиме лога, предупреждения загрузки PID, частота контура и фильтры шагов 2–3 в прогнозе
function step4_render_warnings() {
    const axis = step4.axis
    const res = step4.calc[axis]
    const prefix = pidtune_axes[axis].rate
    const params = state.params
    const lines = []
    const nef = params.get(prefix + "NEF")
    if ((nef != null) && (nef != 0)) {
        lines.push("Notch-фильтр ошибки ПИД (" + prefix + "NEF = " + nef + ") в модели регулятора не учтён: сверка модели с данными и прогноз могут расходиться.")
    }
    if (Number.isFinite(res.slew) && (res.slew > 0)) {
        lines.push("Ограничитель " + prefix + "SMAX = " + step_value_text(res.slew) + " не моделируется: при его срабатывании (резкие манёвры, шум) " +
                   "настоящий отклик медленнее прогноза.")
    }
    const fast = params.get("FSTRATE_ENABLE")
    if (fast > 0) {
        const div = params.get("FSTRATE_DIV")
        lines.push("Контур скорости в быстром потоке (FSTRATE_ENABLE = " + fast + ((div != null) ? ", FSTRATE_DIV = " + div : "") + "): модель регулятора " +
                   "считается на SCHED_LOOP_RATE.")
    }
    const ff = res.gains?.FF
    const dff = res.gains?.DFF
    if ((Number.isFinite(ff) && (ff != 0)) || (Number.isFinite(dff) && (dff != 0))) {
        lines.push("Прямая связь " + prefix + "FF = " + step_value_text(ff) + ", " + prefix + "D_FF = " + step_value_text(dff) + " — вне контура: прогноз " +
                   "вычитает её из измеренного отклика (φ = FF / C).")
    }
    for (const warning of res.mode?.warnings ?? []) {
        lines.push(warning + ".")
    }
    for (const warning of step4.pid?.warnings ?? []) {
        lines.push(warning + ".")
    }
    if ((res.status === "ok") && (params.get("SCHED_LOOP_RATE") == null)) {
        lines.push("В логе нет SCHED_LOOP_RATE: модель регулятора (сверка и прогноз) — на заводских " + step_value_text(res.loop_rate) + " Гц.")
    }
    const accepted_rate = state.steps[2]?.accepted?.SCHED_LOOP_RATE
    if (res.predict_ok && Number.isFinite(accepted_rate) && (Math.fround(accepted_rate) !== Math.fround(res.loop_rate))) {
        lines.push("На шаге 2 принят SCHED_LOOP_RATE " + step_value_text(accepted_rate) + ": модель регулятора — на частоте контура лога " +
                   step_value_text(res.loop_rate) + " Гц.")
    }
    const box = document.getElementById("warnings4")
    box.innerHTML = lines.map(html_escape).join("<br>")
    box.hidden = lines.length == 0
}

// Плитки метрик оси: измерение, нарастание, перерегулирование, плато, установление, колебания, шум D, данные,
// частота среза и запас фазы лога (при достоверном прогнозе)
function step4_render_metrics() {
    const res = step4.calc[step4.axis]
    const box = document.getElementById("metrics4")
    const rules = pidtune_rules
    const m = res.metrics
    // Пометка у метрик отклика оси без правил: по ним не судят
    const unreliable = (res.status === "ok") ? null : ((res.status === "little") ? "мало данных" : "измерение ненадёжно")
    const tiles = []
    const failed = step4_failed_checks(res.quality)
    const measure = {
        nodata: ["нет данных", "нет пакетов в интервале", "bad"],
        low_rate: ["не считается", "лог PID " + step4_fixed(res.rate_hz, 1) + " Гц", "bad"],
        missing: ["не считается", "нет коэффициента в логе", "bad"],
        little: ["мало данных", "нужно не меньше " + rules.min_data_s + " с", "bad"],
        noresp: ["нет отклика", null, "bad"],
        unreliable: ["ненадёжно", "не пройдены " + failed.join(", "), "bad"],
        ok: ["надёжно", res.mode?.rate_only ? "Rate Loop Only: (а), (б)" : "пройдены (а)–(в)", "good"],
    }[res.status]
    tiles.push(step_tile("Измерение", measure[0], measure[1], measure[2]))
    tiles.push(step_tile("Нарастание 10–90 %", step4_ms(m?.rise_s), unreliable ?? (Number.isFinite(m?.bandwidth_hz) ? "полоса ≈ " + m.bandwidth_hz.toFixed(1) + " Гц" : null), null))
    tiles.push(step_tile("Перерегулирование", Number.isFinite(m?.overshoot_pct) ? m.overshoot_pct.toFixed(1) + " %" : "—", unreliable ?? "от 1", null))
    tiles.push(step_tile("Плато " + rules.plateau_s.join("–") + " с", step4_fixed(m?.plateau, 3), unreliable ?? "среднее отклика", null))
    tiles.push(step_tile("Установление ±" + Math.round(rules.settle_band * 100) + " %", (m == null) ? "—" : ((m.settle_s != null) ? step4_ms(m.settle_s) : "не установился"),
                         unreliable ?? "от плато", null))
    const osc_sub = (m?.osc != null) ? "размах " + m.osc.amplitude_pp.toFixed(2) : "порог размаха " + rules.osc_min_pp
    tiles.push(step_tile("Колебания на плато", (m == null) ? "—" : ((m.osc != null) ? m.osc.freq_hz.toFixed(1) + " Гц" : "нет"),
                         (unreliable != null) ? unreliable + ", " + osc_sub : osc_sub, null))
    const dn = res.d_noise
    if (res.gains?.D === 0 || dn?.off) {
        tiles.push(step_tile("Шум D > " + rules.d_noise_hz + " Гц", "D выключен", null, null))
    } else if (dn == null) {
        tiles.push(step_tile("Шум D > " + rules.d_noise_hz + " Гц", "—", res.is_rate ? "в RATE нет D-составляющей" : "нет спектра D", null))
    } else {
        tiles.push(step_tile("Шум D > " + rules.d_noise_hz + " Гц", (dn.dB != null) ? dn.dB.toFixed(1) + " дБ" : "нет", "порог " + rules.d_noise_threshold + " дБ, окно " +
                             step4.window, dn.over ? "bad" : null))
    }
    const seg = res.seg
    tiles.push(step_tile("Данные", (seg != null) ? step4_windows_text(seg.windows) + " · " + seg.data_s.toFixed(1) + " с" : "—", "нужно не меньше " + rules.min_data_s + " с",
                         ((seg != null) && (seg.data_s < rules.min_data_s)) ? "bad" : null))
    const pl = res.pred_log
    tiles.push(step_tile("Срез · запас фазы (лог)", res.predict_ok ? step4_fixed(pl?.crossover_hz, 2) + " Гц · " + step4_fixed(pl?.pm_deg, 1) + "°" : "—",
                         res.predict_ok ? ("по амплитуде " + (Number.isFinite(pl?.gm_db) ? pl.gm_db.toFixed(1) + " дБ" : "—")) : "только при достоверном прогнозе", null))
    box.innerHTML = tiles.join("")
    box.hidden = false
}

// Таблица качества измерения: (а)–(в), значение, порог, итог; в Rate Loop Only (в) — «не применяется»
function step4_render_quality() {
    const res = step4.calc[step4.axis]
    const box = document.getElementById("quality4")
    const q = pidtune_rules.quality
    const checks = res.quality?.checks
    if ((checks == null) || (res.fir == null)) {
        box.hidden = true
        return
    }
    const rows = [
        ["ridge", "(а) устойчивость к регуляризации", "RMS разницы откликов КИХ при λ " + pidtune_rules.fir_ridge + " и " + pidtune_rules.fir_ridge_check,
         step4_fixed(checks.ridge.value, 3), "≤ " + q.ridge_rms_max],
        ["halves", "(б) устойчивость по данным", "RMS разницы откликов КИХ первой и второй половины данных", step4_fixed(checks.halves.value, 3), "≤ " + q.halves_rms_max],
        ["outer", "(в) подпись углового контура", "наибольшее |цель → факт| на " + q.outer_band_hz.join("–") + " Гц",
         step4_fixed(checks.outer.value, 2) + (Number.isFinite(checks.outer.freq_hz) ? " на " + checks.outer.freq_hz.toFixed(1) + " Гц" : ""), "≤ " + q.outer_t_max],
    ]
    let body = ""
    for (const [key, title, what, value, limit] of rows) {
        const check = checks[key]
        let verdict
        let cls = ""
        if (check.applied === false) {
            verdict = "не применяется (Rate Loop Only)"
        } else if (check.ok) {
            verdict = "пройдена"
            cls = "better"
        } else {
            verdict = "не пройдена"
            cls = "worse"
        }
        body += '<tr><td>' + html_escape(title) + '<small>' + html_escape(what) + '</small></td><td class="num">' + html_escape(value) + '</td>' +
            '<td class="num">' + html_escape(limit) + '</td><td class="' + cls + '">' + html_escape(verdict) + '</td></tr>'
    }
    box.querySelector("tbody").innerHTML = body
    box.hidden = false
}

// Пояснение под названием строки: с какими вариантами совпала
function step4_row_note(row) {
    const titles = { log: "как в логе", rule: "по правилам", p_minus: "P −10 %", p_plus: "P +10 %", d_minus: "D −10 %", d_plus: "D +10 %" }
    if ((row.same_as ?? []).length == 0) {
        return ""
    }
    return '<small>' + html_escape("то же, что " + row.same_as.map((id) => titles[id] ?? id).join(", ")) + '</small>'
}

// Ячейки прогноза строки: запас фазы, частота среза, перерегулирование и нарастание с разницей к логу (у «Как в логе»
// при фильтрах лога разницы нет — его прогноз и есть лог); у неустойчивого — «—» вместо метрик (запас фазы и срез —
// только если запас не больше 0, иначе их число недостоверно)
function step4_pred_cells(row, res, same_as_log) {
    const pred = row.pred
    const log = res.pred_log
    const flags = row.flags
    const diff = (a, b, digits) => (same_as_log || !Number.isFinite(a) || !Number.isFinite(b)) ? null : step_signed(a - b, digits)
    if (pred == null) {
        return '<td colspan="4">прогноза нет</td>'
    }
    const pm_cls = (flags?.low_pm || flags?.pm_drop || flags?.unstable) ? "worse" : ""
    if (pred.unstable) {
        const contour = Number.isFinite(pred.pm_deg) && (pred.pm_deg <= 0)
        return step_cell(contour ? pred.pm_deg.toFixed(1) : "—", null, "worse", null) + step_cell(contour ? step4_fixed(pred.crossover_hz, 2) : "—", null, "", null) +
            step_cell("—", null, "worse", step4_unstable_text(row) + " — отклика нет") + step_cell("—", null, "", step4_unstable_text(row) + " — отклика нет")
    }
    const m = pred.metrics
    const ms = (s) => Number.isFinite(s) ? s * 1000 : NaN
    return step_cell(step4_fixed(pred.pm_deg, 1), diff(pred.pm_deg, log?.pm_deg, 1), pm_cls, Number.isFinite(pred.gm_db) ? "запас по амплитуде " + pred.gm_db.toFixed(1) + " дБ" : null) +
        step_cell(step4_fixed(pred.crossover_hz, 2), diff(pred.crossover_hz, log?.crossover_hz, 2), "", null) +
        step_cell(step4_fixed(m?.overshoot_pct, 1), diff(m?.overshoot_pct, log?.metrics?.overshoot_pct, 1), flags?.overshoot ? "worse" : "", null) +
        step_cell(step4_fixed(ms(m?.rise_s), 1), diff(ms(m?.rise_s), ms(log?.metrics?.rise_s), 1), "", null)
}

// Таблица вариантов оси: P / I / D, прогноз (запас фазы, частота среза, перерегулирование и нарастание к логу), оценка
function step4_render_candidates() {
    const axis = step4.axis
    const res = step4.calc[axis]
    const box = document.getElementById("candidates4")
    const note = document.getElementById("candidates4_note")
    const prefix = pidtune_axes[axis].rate
    const recommended_id = step4_recommended_id(axis)
    const filters_same = !step4_gyro_changed() && (res.filters_new != null) && (candidate_key(res.filters_new) === candidate_key(res.filters_log))

    box.querySelector("thead").innerHTML = '<tr><th aria-label="Выбор"></th><th>Вариант</th><th>' + html_escape(prefix) + 'P</th><th>I</th><th>D</th>' +
        '<th>Запас фазы<small>°, к логу</small></th><th>Частота среза<small>Гц, к логу</small></th><th>Перерегулирование<small>%, к логу</small></th>' +
        '<th>Нарастание<small>мс, к логу</small></th><th>Оценка</th></tr>'

    // Выбор — один источник: step4.selected[axis], приведённый к существующей строке
    const rows = step4_rows(axis)
    step4.selected[axis] = step4_selected_row(axis)?.id ?? null
    const selected = step4.selected[axis]
    // Элемент таблицы с фокусом пересоздаётся — фокус вернуть: радио группы — на отмеченное, прочее — по id
    const active = box.contains(document.activeElement) ? document.activeElement : null
    const focused = (active == null) ? "" : ((active.name === "cand4") ? "cand4_" + selected : active.id)
    const log_gains = res.gains
    let body = ""
    for (const row of rows) {
        const id_attr = html_escape("cand4_" + row.id)
        const is_log = row.id === "log"
        body += '<tr' + ((row.id === recommended_id) ? ' class="recommended"' : '') + '>'
        body += '<td><input type="radio" name="cand4" id="' + id_attr + '" value="' + html_escape(row.id) + '"' + ((row.id === selected) ? ' checked' : '') + '></td>'
        body += '<td><label for="' + id_attr + '">' + html_escape(row.title) + '</label>' + step4_row_note(row) + '</td>'
        for (const k of step4_gain_keys) {
            const changed = !step4_same_value(row.values[k], log_gains[k])
            body += step_cell(step_value_text(row.values[k]), changed ? "было " + step_value_text(log_gains[k]) : null, "", null)
        }
        if (!res.predict_ok) {
            body += '<td colspan="4">' + html_escape((res.status === "ok") ? "прогноз недостоверен" : "прогноза нет") + '</td>'
        } else {
            body += step4_pred_cells(row, res, is_log && filters_same)
        }
        const flags_text = (row.flags?.reasons ?? []).join("; ")
        const small = (flags_text !== "") ? '<small>' + html_escape(flags_text) + '</small>' : ""
        let verdict
        if (row.id === recommended_id) {
            verdict = '<span class="tag">рекомендуется</span>' + small
        } else if (is_log) {
            verdict = "текущие настройки" + small
        } else if (row.id === "custom") {
            verdict = "ручные значения" + small
        } else if (!res.predict_ok) {
            verdict = "без прогноза"
        } else {
            verdict = html_escape((flags_text !== "") ? flags_text : "без отметок")
        }
        body += '<td>' + verdict + '</td></tr>'
    }
    box.querySelector("tbody").innerHTML = body
    box.hidden = false
    if (focused !== "") {
        (document.getElementById(focused) ?? box.querySelector("input[name=cand4]:checked"))?.focus({ preventScroll: true })
    }
    document.getElementById("cand4_apply").disabled = rows.length == 0

    // Пояснение: откуда прогноз и какие фильтры шагов 2–3 в нём учтены
    const lines = []
    if (res.status !== "ok") {
        lines.push("Правил и прогноза по оси нет — " + step4_axis_state(axis).reason + ". В таблице — значения лога и «Свой» после правки формы.")
    } else {
        lines.push("Варианты: «По правилам» (рекомендуется), P ±" + Math.round(pidtune_rules.gain_step * 100) + " % (I по правилу: " +
                   ((axis === "yaw") ? "I = " + pidtune_rules.yaw_i_ratio + "·P" : "I = P") + ") и D ±" + Math.round(pidtune_rules.gain_step * 100) +
                   " % (при D > 0); «Свой» — после правки формы. Изменённые значения — " + pidtune_rules.round_digits + " значащие цифры.")
        if (res.predict_ok) {
            const changes = []
            const gyro_old = step4_gyro_old()
            const gyro_new = step4_gyro_new()
            if (gyro_old.INS_GYRO_FILTER !== gyro_new.INS_GYRO_FILTER) {
                changes.push("INS_GYRO_FILTER " + step_value_text(gyro_old.INS_GYRO_FILTER) + " → " + step_value_text(gyro_new.INS_GYRO_FILTER) + " Гц")
            }
            if (Object.keys(gyro_old).some((name) => (name !== "INS_GYRO_FILTER") && (gyro_old[name] !== gyro_new[name]))) {
                changes.push("notch шага 2")
            }
            for (const [key, title] of [["flte", "FLTE"], ["fltd", "FLTD"]]) {
                if (Math.fround(res.filters_new[key]) !== Math.fround(res.filters_log[key])) {
                    changes.push(prefix + title + " " + step_value_text(res.filters_log[key]) + " → " + step_value_text(res.filters_new[key]) + " Гц")
                }
            }
            lines.push("Прогноз — из измеренной характеристики «цель → факт» (КИХ) и модели регулятора AC_PID; разница — к измеренному логу. " +
                       ((changes.length > 0) ? "В прогнозе учтены фильтры шагов 2–3: " + changes.join(", ") + ((res.ratio == null && step4_gyro_changed()) ? " (кроме фильтров гироскопа — поправки нет)" : "") +
                        " — поэтому прогноз «Как в логе» может отличаться от лога. " : "Фильтры шагов 2–3 совпадают с логом. ") +
                       "Отметки: запас фазы ниже " + pidtune_rules.pm_min_deg + "° или хуже лога больше чем на " + pidtune_rules.pm_max_drop_deg + "°, перерегулирование " +
                       "выше " + pidtune_rules.overshoot_pred_max_pct + " %, неустойчивый или неполный прогноз; у неустойчивого «—» вместо метрик. Отметки выбор не блокируют.")
        } else {
            lines.push("Прогноз недостоверен — в таблице только значения; причины — в вердикте оси.")
        }
    }
    note.textContent = lines.join(" ")
    note.hidden = false
}
