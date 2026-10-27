// Память прохода на странице мастера: хранилище браузера, сохранение прохода по аппарату (шаг 5: «Скачать .param»
// и «Запомнить проход») и блок «Прошлый проход» шага 0 — что из предложенного в прошлый раз стоит в загруженном логе.
// Формат, ключ аппарата, запись и «применено» — ядро core/passmem.js; здесь — только состояние страницы.
// Дизайн — docs/plans/2026-10-25-tune-wizard-stage5-design.md, раздел 4. Строки сравнения шагов 2–4 — задача 7 плана
// этапа 5: проход для лога они берут из memory_state.
//
// Нужны глобалы страницы: core/passmem.js (passmem_*), core/summary.js (summary_rows), core/params.js (hmncs_bits),
// wizard.js (state, html_escape) и steps/common.js (step_summary_context, step_accepted_stale, step_try, step_verdict,
// step_value_text). Все они нужны только при вызове.

// Проход для загруженного лога (блок «Прошлый проход» шага 0): pass — проход из памяти (null — прохода нет, он не
// выбран из списка или забыт), applied — passmem_applied(pass, …) по параметрам лога (null — без прохода), key — ключ
// аппарата лога (passmem_aircraft_key; null — лог не загружен)
const memory_state = { pass: null, applied: null, key: null }

// Внутреннее состояние блока шага 0: pick — лог без строки контроллера (проход выбирается из списка), list — проходы
// списка (на момент загрузки лога, без забытых), warning — строка предупреждения о неполной памяти (memory_corrupt_texts;
// null — память прочитана целиком): она остаётся в вердикте и после выбора прохода
const memory_step0 = { pick: false, list: [], warning: null }

// Строка предупреждения: часть памяти не прочитана (битые записи, испорченный JSON, другая версия) — и удалена
// (уцелевшее переписано в хранилище) или осталась (запись не удалась)
const memory_corrupt_texts = { removed: "Часть памяти прохода не прочитана — удалена.", kept: "Часть памяти прохода не прочитана." }

// Итог строки таблицы «Прошлый проход» по status из passmem_applied
const memory_status_text = { applied: "применено", other: "другое значение", absent: "нет в логе" }

// Хранилище браузера для памяти прохода: window.localStorage или null. Сам доступ к свойству может бросить (запрет
// хранилища для сайта, режимы приватности) — тогда null, и память пишет «браузер не даёт сохранить»
function memory_storage() {
    try {
        return window.localStorage ?? null
    } catch {
        return null
    }
}

// Сохранить проход этого аппарата → текст для заметки шага 5 (#step5_note). Проход — изменённые параметры итога и
// оценки принятых шагов (passmem_record: оценки устаревших шагов и шага, чьё значение перекрыто другим, — null);
// проход того же аппарата заменяется. Хранилища нет или запись не удалась (приватный режим, запрет, квота) — текст
// ошибки. Прежняя память не прочитана целиком ("corrupt": испорченный JSON, другая версия, битые записи) —
// сохраняются уцелевшие записи и новая, к тексту — оговорка [наше]. Не бросает: неожиданная ошибка — в консоль и
// текстом в заметку (при «Скачать .param» файл уже скачан, и сводка не должна смениться на «Ошибка шага 5»).
// Нужен загруженный лог
function memory_save() {
    const unavailable = "Браузер не даёт сохранить память прохода (приватный режим, запрет или переполнение хранилища)."
    try {
        const storage = memory_storage()
        const read = passmem_read(storage)
        if (read.error === "unavailable") {
            return unavailable
        }
        const summary = summary_rows(step_summary_context())
        const record = passmem_record({
            key: passmem_aircraft_key(state.info, state.file_name),
            info: state.info,
            file_name: state.file_name,
            rows: summary.rows,
            steps: state.steps,
            saved_at: Date.now(),
            stale: { 2: step_accepted_stale(2), 3: step_accepted_stale(3), 4: step_accepted_stale(4) },
            conflicts: summary.conflicts,
        })
        if (passmem_write(storage, passmem_put(read.passes, record)) != null) {
            return unavailable
        }
        return "Память прохода сохранена." + ((read.error === "corrupt") ? " Часть прежней памяти не прочитана — удалена." : "")
    } catch (e) {
        console.error(e)
        return "Память прохода не сохранена: " + e.message
    }
}

// ---------- Шаг 0: блок «Прошлый проход» ----------
// Дизайн — раздел 4.4. Блок строится при загрузке лога (load в wizard.js) по памяти на этот момент

// Обработчики блока; ошибка — в вердикт блока
function memory_init() {
    document.getElementById("memory0_pick").addEventListener("change", () => step_try(memory_pick_changed, "memory0_verdict", "памяти прохода"))
    document.getElementById("memory0_forget").addEventListener("click", () => step_try(memory_forget, "memory0_verdict", "памяти прохода"))
}

// Новый лог или ошибка загрузки: блок скрыт и пуст, прохода нет. Память браузера не трогается
function memory_reset() {
    for (const id of ["memory0", "memory0_head", "memory0_verdict", "memory0_table", "memory0_pick_field", "memory0_forget"]) {
        document.getElementById(id).hidden = true
    }
    document.getElementById("memory0_head").textContent = ""
    document.querySelector("#memory0_table tbody").innerHTML = ""
    document.getElementById("memory0_pick").replaceChildren()
    Object.assign(memory_state, { pass: null, applied: null, key: null })
    Object.assign(memory_step0, { pick: false, list: [], warning: null })
}

// Дата сохранения прохода: «27.10.2026, 14:05»; нет даты — «—»
function memory_date_text(saved_at) {
    return (saved_at != null) ? new Date(saved_at).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" }) : "—"
}

// Подпись прохода в списке выбора: «дата · плата, рама · лог»; нет платы и рамы — «—» на их месте
function memory_pass_label(pass) {
    const device = [pass.board, pass.frame].filter((part) => (typeof part === "string") && (part !== "")).join(", ")
    return [memory_date_text(pass.saved_at), (device !== "") ? device : "—", pass.file_name ?? "—"].join(" · ")
}

// Есть ли что показать у прохода: проход без изменённых параметров сравнивать не с чем — как прохода нет
function memory_has_changes(pass) {
    return (pass != null) && (pass.changed.length > 0)
}

// Блок «Прошлый проход» после загрузки лога. Ключ аппарата лога (memory_state.key) — сразу: он зависит только от лога.
// Лог со строкой контроллера (state.info.board — непустая строка) — проход этого аппарата по ключу; без неё — список
// сохранённых проходов (passmem_list, memory_show_list). Прохода нет (список пуст) — блок скрыт; хранилища нет
// ("unavailable") — тоже. Память прочитана не целиком ("corrupt") — уцелевшие записи переписываются в хранилище без
// битых (иначе предупреждение было бы при каждой загрузке), в вердикте — строка предупреждения («удалена» — только
// если запись удалась), а без прохода блок показывает только её.
// Блок показан до разбора памяти: ошибку (load вызывает функцию под step_try) видно вердиктом блока. Нужен
// загруженный лог
function memory_render_step0() {
    memory_reset()
    memory_state.key = passmem_aircraft_key(state.info, state.file_name)
    const box = document.getElementById("memory0")
    box.hidden = false
    const storage = memory_storage()
    const read = passmem_read(storage)
    if (read.error === "unavailable") {
        box.hidden = true
        return
    }
    if (read.error === "corrupt") {
        memory_step0.warning = (passmem_write(storage, read.passes) == null) ? memory_corrupt_texts.removed : memory_corrupt_texts.kept
    }

    const board = state.info.board
    if ((typeof board === "string") && (board !== "")) {
        const pass = read.passes[memory_state.key] ?? null
        if (memory_has_changes(pass)) {
            memory_show_pass(pass)
        } else {
            memory_show_empty()
        }
        return
    }
    memory_step0.pick = true
    memory_show_list(passmem_list(read.passes).filter(memory_has_changes))
}

// Подпись блока (#memory0_head)
function memory_head(text) {
    const head = document.getElementById("memory0_head")
    head.textContent = text
    head.hidden = false
}

// Прохода для показа нет: блок только с предупреждением о неполной памяти, а без него — скрыт
function memory_show_empty() {
    memory_state.pass = null
    memory_state.applied = null
    for (const id of ["memory0_head", "memory0_table", "memory0_pick_field", "memory0_forget"]) {
        document.getElementById(id).hidden = true
    }
    if (memory_step0.warning != null) {
        step_verdict("memory0_verdict", "warn", memory_step0.warning)
        document.getElementById("memory0").hidden = false
    } else {
        document.getElementById("memory0").hidden = true
    }
}

// Список выбора для лога без строки контроллера: проходы list по убыванию даты. Проход с тем же запасным ключом, что
// у лога (та же плата, рама и имя файла), выбран сразу, иначе ничего не выбрано. Список пуст — memory_show_empty
function memory_show_list(list) {
    memory_step0.list = list
    if (list.length == 0) {
        memory_show_empty()
        return
    }
    const select = document.getElementById("memory0_pick")
    select.replaceChildren(new Option("— не выбран —", ""), ...list.map((pass) => new Option(memory_pass_label(pass), pass.key)))
    select.value = list.some((pass) => pass.key === memory_state.key) ? memory_state.key : ""
    document.getElementById("memory0_pick_field").hidden = false
    document.getElementById("memory0").hidden = false
    memory_pick_changed()
}

// Выбор в списке: проход по ключу или снова «не выбран»
function memory_pick_changed() {
    const key = document.getElementById("memory0_pick").value
    const pass = memory_step0.list.find((p) => p.key === key) ?? null
    if (pass != null) {
        memory_show_pass(pass)
    } else {
        memory_show_none()
    }
}

// Список без выбранного прохода: подпись о выборе, таблицы и кнопки «Забыть» нет; вердикт — только предупреждение
// о неполной памяти
function memory_show_none() {
    memory_state.pass = null
    memory_state.applied = null
    memory_head("В логе нет строки полётного контроллера — проход этого аппарата не узнать. Выберите сохранённый проход из списка.")
    document.getElementById("memory0_table").hidden = true
    document.getElementById("memory0_forget").hidden = true
    if (memory_step0.warning != null) {
        step_verdict("memory0_verdict", "warn", memory_step0.warning)
    } else {
        document.getElementById("memory0_verdict").hidden = true
    }
}

// Показать проход pass: подпись (дата, лог, прошивка), таблица «что применено» (passmem_applied по параметрам лога и
// размеру маски HMNCS — как в step_summary_context; шаг перед итогом, как в изменениях шага 5) и вердикт: лог
// прошлого прохода (значения лога равны «было» прохода и имя файла то же) — значения ещё не применялись; применено
// всё — ok; иначе — предупреждение «K из N». Кнопка «Забыть» — про аппарат лога или про выбранный в списке проход. Проход и
// «применено» — в memory_state
function memory_show_pass(pass) {
    const bits = hmncs_bits(state.params, state.spectrum.filter_version ?? 1)
    const applied = passmem_applied(pass, state.params, bits)

    memory_head("Сохранён " + memory_date_text(pass.saved_at) + ", лог " + (pass.file_name ?? "—") + ", прошивка " + (pass.fw ?? "—"))
    const cell = (text) => '<td class="num">' + html_escape(text) + '</td>'
    const table = document.getElementById("memory0_table")
    table.querySelector("tbody").innerHTML = applied.rows.map((row) => '<tr>' + cell(row.name) + cell(step_value_text(row.proposed)) + cell(step_value_text(row.now)) +
        cell(String(row.step)) + '<td class="memory0-status memory0-status--' + row.status + '">' + html_escape(memory_status_text[row.status]) + '</td></tr>').join("")
    table.hidden = false

    let status = "warn"
    let text = "Применено " + applied.applied + " из " + applied.total + "."
    if (applied.same_log && (pass.file_name === state.file_name)) {
        text = "Это лог прошлого прохода — значения ещё не применялись."
    } else if (applied.applied === applied.total) {
        status = "ok"
    }
    if (memory_step0.warning != null) {
        status = "warn"
        text += " " + memory_step0.warning
    }
    step_verdict("memory0_verdict", status, text)
    const forget = document.getElementById("memory0_forget")
    forget.textContent = memory_step0.pick ? "Забыть выбранный проход" : "Забыть проход этого аппарата"
    forget.hidden = false

    memory_state.pass = pass
    memory_state.applied = applied
}

// Фокус после «Забыть» (кнопка скрыта): список проходов, если он показан (режим списка и в нём есть проходы), иначе
// поле выбора лога — без прокрутки к началу шага 0
function memory_focus_after_forget() {
    if (memory_step0.pick && (memory_step0.list.length > 0)) {
        document.getElementById("memory0_pick").focus()
    } else {
        document.getElementById("fileItem").focus({ preventScroll: true })
    }
}

// «Забыть»: показанный проход — из памяти браузера по его ключу. Память перечитывается: после загрузки лога её мог
// переписать шаг 5 (или другая вкладка). Удаляется только показанная запись (та же дата сохранения): заменённую более
// новым сохранением не трогать — блок остаётся с предупреждением (и строкой о неполной памяти, если она была), проход
// для сравнения шагов 2–4 — показанный [наше]. Записи уже нет — забывать нечего. Лог со строкой контроллера — дальше
// прохода нет (memory_show_empty); список — он показывается заново без забытого, как при загрузке (проход того же
// файла снова выбран по умолчанию). Хранилища нет или запись не удалась — блок остаётся, в вердикте — ошибка
function memory_forget() {
    const pass = memory_state.pass
    if (pass == null) {
        return
    }
    const storage = memory_storage()
    const read = passmem_read(storage)
    const failed = "Проход не забыт: браузер не даёт изменить память прохода (приватный режим, запрет или переполнение хранилища)."
    if (read.error === "unavailable") {
        step_verdict("memory0_verdict", "fail", failed)
        return
    }
    const stored = read.passes[pass.key] ?? null
    if ((stored != null) && (stored.saved_at !== pass.saved_at)) {
        const tail = (memory_step0.warning != null) ? " " + memory_step0.warning : ""
        step_verdict("memory0_verdict", "warn", "Проход уже заменён более новым сохранением — он остаётся." + tail)
        document.getElementById("memory0_forget").hidden = true
        memory_focus_after_forget()
        return
    }
    if ((stored != null) && (passmem_write(storage, passmem_forget(read.passes, pass.key)) != null)) {
        step_verdict("memory0_verdict", "fail", failed)
        return
    }
    if (memory_step0.pick) {
        memory_show_list(memory_step0.list.filter((p) => p.key !== pass.key))
    } else {
        memory_show_empty()
    }
    memory_focus_after_forget()
}
