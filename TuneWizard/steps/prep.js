// Шаг 0, блок «Подготовка к следующему полёту»: проверка параметров для качественного лога следующего полёта по цели
// (фильтры, PID или оба) — по загруженному файлу .param или по параметрам лога, файл .param исправлений, положения
// переключателя режимов с выбором положения для ACRO, план полёта и его печать. Правила, исправления, положения и план —
// ядро core/prep.js; здесь — источник параметров, выбор пользователя и разметка. Дизайн —
// docs/plans/2026-10-30-tune-wizard-stage7-design.md (разделы 2, 4, 5, 10), план — …-stage7.md, задача 2.
// Источники: [решение пользователя 30.10.2026] — дизайн этапа 7; [наше] — решение мастера.
//
// Нужны глобалы страницы: core/prep.js (prep_*), core/params.js (parse_param_file, param_file_text), core/checks.js
// (checks_summary), Libraries/FileSaver.js (saveAs), wizard.js (state, html_escape), steps/common.js (step_try,
// step_verdict, step_plural, step_cell, step_value_text). Все они нужны только при вызове.

// Состояние блока: goal — цель полёта (ключ prep_goals); file — загруженный файл .param ({ name, params }: params с
// get/has, как у log_params; null — файла нет); slot и slot_source — положение для ACRO, выбранное пользователем
// (1–6 или null — «— выберите —»), и источник (prep0_source().id), для которого его выбрали: у другого источника — снова
// предложение ядра; error и error_source — ошибка чтения файла .param и источник на момент ошибки: при другом источнике
// она не показывается
const prep0_state = { goal: "both", file: null, slot: null, slot_source: undefined, error: null, error_source: undefined }

// Цель в памяти браузера; по умолчанию — «Фильтры и PID» [решение пользователя 30.10.2026, раздел 10, а]
const prep0_storage_key = "tunewizard_prep_goal"
const prep0_default_goal = "both"

// Подписи статусов — как у проверок лога (render_checks в wizard.js)
const prep0_labels = { ok: "OK", warn: "ВНИМ", fail: "СТОП" }

// Формы слов для step_plural
const prep0_param_forms = ["параметр", "параметра", "параметров"]
const prep0_warn_forms = ["предупреждение", "предупреждения", "предупреждений"]
const prep0_fail_forms = ["блокирующая проблема", "блокирующие проблемы", "блокирующих проблем"]

// Части блока под строкой источника: скрываются в начале каждой отрисовки и показываются по данным — после ошибки
// отрисовки на экране не остаётся прошлого списка
const prep0_parts = ["prep0_verdict", "prep0_checks", "prep0_modes_head", "prep0_slot_field", "prep0_modes", "prep0_actions", "prep0_note",
    "prep0_plan_head", "prep0_plan"]

// ---------- Цель и источник ----------

// Цель из памяти браузера: ключ prep_goals, иначе (хранилища нет, записи нет, чужое значение) — prep0_default_goal.
// Значение проверяется здесь, до ядра: prep_goal_parts на неизвестную цель бросает
function prep0_goal_load() {
    let value = null
    try {
        value = localStorage.getItem(prep0_storage_key)
    } catch {
        // Хранилище недоступно (приватный режим, запрет для сайта) — цель по умолчанию
    }
    return ((value != null) && Object.hasOwn(prep_goals, value)) ? value : prep0_default_goal
}

// Запомнить цель goal (ключ prep_goals) в браузере
function prep0_goal_save(goal) {
    try {
        localStorage.setItem(prep0_storage_key, goal)
    } catch {
        // Хранилище недоступно — цель просто не запомнится
    }
}

// Параметры файла .param (объект имя → число из parse_param_file) с интерфейсом log_params: get(name) → число или null,
// has(name)
function prep0_file_params(values) {
    return {
        has: (name) => Object.hasOwn(values, name),
        get: (name) => Object.hasOwn(values, name) ? values[name] : null,
    }
}

// Источник параметров → { kind: "file" | "log", name, params, id } или null (нет ни файла, ни лога). Файл важнее
// параметров лога [решение пользователя 30.10.2026, раздел 10, д]. id — объект, по которому узнаётся тот же источник
// (выбор положения ACRO, ошибка чтения файла): у файла — запись prep0_state.file (новая при каждой загрузке), у лога —
// state.params (новый при каждой загрузке лога)
function prep0_source() {
    const file = prep0_state.file
    if (file != null) {
        return { kind: "file", name: file.name, params: file.params, id: file }
    }
    if (state.params != null) {
        return { kind: "log", name: state.file_name, params: state.params, id: state.params }
    }
    return null
}

// Положение для ACRO у источника source: выбранное пользователем для этого источника (1–6 или null), иначе
// предложение ядра (prep_acro_suggestion: 6 или null)
function prep0_slot(source) {
    return (prep0_state.slot_source === source.id) ? prep0_state.slot : prep_acro_suggestion(source.params)
}

// Данные блока → null (источника нет) или { source, goal, slot, items }: items — prep_check по источнику, цели и
// положению ACRO; газ висения (проверка шага 0 hover_throttle) — из загруженного лога и при файле (дизайн, раздел 4)
function prep0_context() {
    const source = prep0_source()
    if (source == null) {
        return null
    }
    const goal = prep0_state.goal
    const slot = prep0_slot(source)
    const hover_check = state.checks?.find((c) => c.id === "hover_throttle") ?? null
    const items = prep_check(source.params, goal, { acro_slot: slot, hover_check: hover_check })
    return { source: source, goal: goal, slot: slot, items: items }
}

// Пункты подготовки для текущего источника, цели и положения ACRO (prep_check) или null — источника нет. Для «что
// сделать перед следующим полётом» шага 5 (задача 3): сбой подготовки не должен ронять сводку — ошибка в консоль, null
function prep0_items() {
    try {
        return prep0_context()?.items ?? null
    } catch (e) {
        console.error(e)
        return null
    }
}

// ---------- Инициализация и действия ----------

// Список целей, цель из памяти браузера, обработчики полей и кнопок; блок скрыт, пока нет ни файла, ни лога
function prep0_init() {
    const goal = document.getElementById("prep0_goal")
    goal.innerHTML = Object.entries(prep_goals).map(([key, g]) => '<option value="' + html_escape(key) + '">' + html_escape(g.title) + '</option>').join("")
    prep0_state.goal = prep0_goal_load()
    goal.value = prep0_state.goal
    goal.addEventListener("change", () => prep0_set_goal(goal.value))
    document.getElementById("prep0_file").addEventListener("change", (e) => prep0_read_file(e.target))
    document.getElementById("prep0_unfile").addEventListener("click", prep0_unfile)
    document.getElementById("prep0_slot").addEventListener("change", (e) => prep0_set_slot(e.target.value))
    document.getElementById("prep0_download").addEventListener("click", prep0_download)
    document.getElementById("prep0_print").addEventListener("click", prep0_print)
    window.addEventListener("afterprint", prep0_after_print)
    prep0_render()
}

// Смена цели: запомнить в браузере и перерисовать. Значение не из prep_goals (подменённый список) — цель по умолчанию
function prep0_set_goal(value) {
    prep0_state.goal = Object.hasOwn(prep_goals, value) ? value : prep0_default_goal
    prep0_goal_save(prep0_state.goal)
    prep0_render()
}

// Выбор положения для ACRO (значение поля: "1"…"6" или "" — «— выберите —») — для текущего источника
function prep0_set_slot(value) {
    const source = prep0_source()
    if (source == null) {
        return
    }
    prep0_state.slot = prep_slot_number(value)
    prep0_state.slot_source = source.id
    prep0_render()
}

// «Проверить .param…»: файл параметров — источник блока (важнее параметров лога); загрузка лога его не сбрасывает.
// Файл не прочитан или в нём нет ни одной строки «ИМЯ,значение» — прежний источник остаётся, причина — в строке
// источника (без источника — в вердикте блока). Поле очищается: повторный выбор того же файла снова вызовет change
async function prep0_read_file(input) {
    const file = input.files[0]
    if (file == null) {
        return
    }
    input.value = ""
    let values = null
    let error = null
    try {
        values = parse_param_file(await file.text())
        if (Object.keys(values).length === 0) {
            error = "В файле «" + file.name + "» нет параметров (строк «ИМЯ,значение»)"
        }
    } catch (e) {
        console.error(e)
        error = "Не удалось прочитать «" + file.name + "»: " + e.message
    }
    if (error != null) {
        prep0_state.error = error
        prep0_state.error_source = prep0_source()?.id ?? null
    } else {
        prep0_state.error = null
        prep0_state.file = { name: file.name, params: prep0_file_params(values) }
    }
    prep0_render()
}

// «Убрать файл»: снова по параметрам лога (без лога — блок скрыт)
function prep0_unfile() {
    prep0_state.file = null
    prep0_state.error = null
    prep0_render()
}

// «Скачать .param исправлений»: только изменения (prep_changes) в файл <лог или файл>_prep.param (prep_file_name) —
// отдельно от _tune.param шага 5 [решение пользователя 30.10.2026, раздел 10, е]
function prep0_download() {
    step_try(() => {
        const ctx = prep0_context()
        if (ctx == null) {
            return
        }
        const values = prep_changes(ctx.source.params, ctx.items)
        if (Object.keys(values).length === 0) {
            return
        }
        saveAs(new Blob([param_file_text(values)], { type: "text/plain;charset=utf-8" }), prep_file_name(ctx.source.name))
    }, "prep0_verdict", "подготовки к полёту")
}

// Шапка печати плана (#prep0_print_head): «Мастер настройки · Подготовка к полёту · <цель> · <файл или лог> · <дата>» —
// цель на бумаге только здесь: поля при печати скрыты
function prep0_fill_print_head() {
    const source = prep0_source()
    const from = (source == null) ? "—" : ((source.kind === "file") ? "файл «" : "лог «") + (source.name ?? "—") + "»"
    const date = new Date().toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })
    document.getElementById("prep0_print_head").textContent = ["Мастер настройки", "Подготовка к полёту", "цель «" + prep_goals[prep0_state.goal].title + "»",
        from, date].join(" · ")
}

// «Печать плана»: класс print-prep на body — правила @media print оставляют на шаге 0 только блок подготовки; снимает
// его prep0_after_print. Ctrl+P без кнопки печатает шаг 0 как раньше
function prep0_print() {
    prep0_fill_print_head()
    document.body.classList.add("print-prep")
    window.print()
}

// После печати (и отмены диалога): обычная печать шага 0
function prep0_after_print() {
    document.body.classList.remove("print-prep")
}

// ---------- Отрисовка ----------

// Отрисовать блок; ошибка не роняет шаг 0 — она в вердикте блока. Зовут prep0_init, действия блока и wizard.js
// (reset — в том числе при ошибке загрузки лога, конец load)
function prep0_render() {
    step_try(prep0_draw, "prep0_verdict", "подготовки к полёту")
}

// Строка источника: «По файлу «…»» или «По параметрам лога «…»»; файл и лог — ещё «файл важнее параметров лога»;
// error — ошибка чтения файла (или null) — первой фразой
function prep0_source_text(source, error) {
    const text = (source.kind === "file")
        ? "По файлу «" + source.name + "»" +
          ((state.params != null) ? " — файл важнее параметров лога «" + state.file_name + "»; газ висения и предупреждения шага 0 — по логу" : "")
        : "По параметрам лога «" + source.name + "»"
    return ((error != null) ? error + ". " : "") + text + "."
}

// Список проверок: разметка и подписи — как у проверок лога (render_checks в wizard.js)
function prep0_checks_html(items) {
    return items.map((c) =>
        '<div class="check check--' + c.status + '"><span class="check__s">' + prep0_labels[c.status] + '</span>' +
        '<div class="check__b"><h3>' + html_escape(c.title) + '</h3><p>' + html_escape(c.text) + '</p>' +
        (c.fix ? '<p class="fix"><b>Что сделать:</b> ' + html_escape(c.fix) + '</p>' : "") + '</div></div>'
    ).join("")
}

// Вердикт: «Готово к полёту: <цель>» / «С оговорками: N предупреждений — см. список» / «Не готово: N блокирующих
// проблем — см. список» (статус — checks_summary, как у проверок лога)
function prep0_verdict(items, goal) {
    const summary = checks_summary(items)
    const warns = step_plural(summary.warn, prep0_warn_forms)
    const texts = {
        ok: "Готово к полёту: " + prep_goals[goal].title,
        warn: "С оговорками: " + warns + " — см. список",
        fail: "Не готово: " + step_plural(summary.fail, prep0_fail_forms) + ((summary.warn > 0) ? ", " + warns : "") + " — см. список",
    }
    step_verdict("prep0_verdict", summary.status, texts[summary.status])
    return summary.status
}

// Поле «Положение для ACRO» — только при fail acro_slot (ACRO нет ни в одном положении): FLTMODE1–6 с режимом сейчас и
// PWM; выбрано slot (предложение ядра или выбор пользователя), иначе «— выберите —»
function prep0_draw_slot(params, items, slot) {
    const show = items.find((item) => item.id === "acro_slot")?.status === "fail"
    document.getElementById("prep0_slot_field").hidden = !show
    if (!show) {
        return
    }
    const select = document.getElementById("prep0_slot")
    select.innerHTML = '<option value="">— выберите —</option>' + prep_mode_slots(params).map((s) =>
        '<option value="' + s.slot + '">' + html_escape(s.name + " · " + (s.mode_name ?? "нет параметра") + " · PWM " + s.pwm) + '</option>').join("")
    select.value = (slot != null) ? String(slot) : ""
}

// Таблица положений переключателя (#prep0_modes) — при цели с PID: положение, PWM, режим сейчас. Положение с ACRO —
// сейчас или после записи файла (prep_acro_applied) — выделено; пометки — «станет ACRO (файл исправлений)» и «выход
// из ACRO» у положения выхода плана полёта (prep_plan_slots)
function prep0_draw_modes(params, slot) {
    const acro = prep_rules.acro_mode
    const applied = prep_acro_applied(params, slot)
    const plan = prep_plan_slots(params, slot)
    const rows = prep_mode_slots(params).map((s) => {
        let mark = null
        if (s.slot === applied) {
            mark = "станет ACRO (файл исправлений)"
        } else if ((s.slot === plan.exit) && (plan.acro != null)) {
            mark = "выход из ACRO"
        }
        const hot = (s.slot === applied) || (s.mode == acro)
        return '<tr' + (hot ? ' class="recommended"' : "") + '>' + step_cell(String(s.slot), s.name, "") + step_cell(s.pwm, null, "") +
            step_cell(s.mode_name ?? "нет параметра", mark, "") + '</tr>'
    })
    document.querySelector("#prep0_modes tbody").innerHTML = rows.join("")
    for (const id of ["prep0_modes_head", "prep0_modes"]) {
        document.getElementById(id).hidden = false
    }
}

// Заметка о файле исправлений и кнопка: изменений нет — кнопка выключена; иначе «Файл <имя>: N параметров — ИМЯ =
// значение, …» и, если нужно, «после записи перезагрузите полётный контроллер: …» (prep_reboot_names)
function prep0_draw_file(ctx, status) {
    const values = prep_changes(ctx.source.params, ctx.items)
    const names = Object.keys(values)
    document.getElementById("prep0_download").disabled = (names.length === 0)
    let text = (status === "ok") ? "Менять нечего: файла исправлений нет." : "В файл исправлений записать нечего — что сделать, сказано в списке."
    if (names.length > 0) {
        text = "Файл " + prep_file_name(ctx.source.name) + ": " + step_plural(names.length, prep0_param_forms) + " — " +
            names.map((name) => name + " = " + step_value_text(values[name])).join(", ") + "."
        const reboot = prep_reboot_names(names)
        if (reboot.length > 0) {
            text += " После записи перезагрузите полётный контроллер: " + reboot.join(", ") + "."
        }
    }
    const note = document.getElementById("prep0_note")
    note.textContent = text
    note.hidden = false
    document.getElementById("prep0_actions").hidden = false
}

// План полёта (prep_flight_plan): положение ACRO и выхода — prep_plan_slots (найденное или выбранное), проверки шага 0 —
// state.checks (null — лога нет)
function prep0_draw_plan(ctx) {
    const slots = prep_plan_slots(ctx.source.params, ctx.slot)
    const plan = prep_flight_plan(ctx.goal, { acro_slot: slots.acro, exit_slot: slots.exit, checks: state.checks })
    document.getElementById("prep0_plan").innerHTML = plan.map((text) => '<li>' + html_escape(text) + '</li>').join("")
    for (const id of ["prep0_plan_head", "prep0_plan"]) {
        document.getElementById(id).hidden = false
    }
}

// Блок целиком: нет ни источника, ни ошибки — скрыт; ошибка чтения файла без источника — только она в вердикте; иначе
// цель, строка источника, вердикт, список, положения переключателя (цель с PID), файл исправлений и план
function prep0_draw() {
    const source = prep0_source()
    const id = source?.id ?? null
    const error = (prep0_state.error_source === id) ? prep0_state.error : null
    const block = document.getElementById("prep0")
    block.hidden = (source == null) && (error == null)
    for (const part of prep0_parts) {
        document.getElementById(part).hidden = true
    }
    document.getElementById("prep0_controls").hidden = (source == null)
    if (block.hidden) {
        return
    }
    if (source == null) {
        step_verdict("prep0_verdict", "fail", error)
        return
    }

    const goal = prep0_state.goal
    document.getElementById("prep0_goal").value = goal
    document.getElementById("prep0_goal_text").textContent = prep_goals[goal].text
    document.getElementById("prep0_source").textContent = prep0_source_text(source, error)
    document.getElementById("prep0_unfile").hidden = (source.kind !== "file")

    const ctx = prep0_context()
    const status = prep0_verdict(ctx.items, goal)
    const checks = document.getElementById("prep0_checks")
    checks.innerHTML = prep0_checks_html(ctx.items)
    checks.hidden = false
    if (prep_goal_parts(goal).includes("pid")) {
        prep0_draw_slot(source.params, ctx.items, ctx.slot)
        prep0_draw_modes(source.params, ctx.slot)
    }
    prep0_draw_file(ctx, status)
    prep0_draw_plan(ctx)
}
