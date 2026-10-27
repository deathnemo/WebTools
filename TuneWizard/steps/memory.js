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

// Внутреннее состояние блока шага 0: list — проходы списка выбора на момент загрузки лога (лог без строки
// контроллера), corrupt — память прочитана не целиком: строка предупреждения остаётся в вердикте и после выбора прохода
const memory_step0 = { list: [], corrupt: false }

// Строка предупреждения: часть памяти не прочитана (битые записи, испорченный JSON, другая версия)
const memory_corrupt_text = "Часть памяти прохода не прочитана — удалена."

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
    Object.assign(memory_step0, { list: [], corrupt: false })
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

// Блок «Прошлый проход» после загрузки лога. Лог со строкой контроллера (state.info.board — непустая строка) — проход
// этого аппарата по ключу; без неё — список сохранённых проходов (passmem_list), по умолчанию ничего не выбрано.
// Прохода нет (список пуст) — блок скрыт; хранилища нет ("unavailable") — тоже. Память прочитана не целиком
// ("corrupt") — уцелевшие записи переписываются в хранилище без битых (иначе предупреждение было бы при каждой загрузке
// и не было бы правдой «удалена»), в вердикте — строка предупреждения, а без прохода блок показывает только её.
// Блок показан до разбора памяти: ошибку (load вызывает функцию под step_try) видно вердиктом блока. Нужен
// загруженный лог
function memory_render_step0() {
    memory_reset()
    const box = document.getElementById("memory0")
    box.hidden = false
    const storage = memory_storage()
    const read = passmem_read(storage)
    if (read.error === "unavailable") {
        box.hidden = true
        return
    }
    memory_state.key = passmem_aircraft_key(state.info, state.file_name)
    memory_step0.corrupt = read.error === "corrupt"
    if (memory_step0.corrupt) {
        passmem_write(storage, read.passes)
    }

    const board = state.info.board
    if ((typeof board === "string") && (board !== "")) {
        const pass = read.passes[memory_state.key] ?? null
        if (pass != null) {
            memory_show_pass(pass)
            return
        }
    } else {
        const list = passmem_list(read.passes)
        if (list.length > 0) {
            memory_show_list(list)
            return
        }
    }
    if (memory_step0.corrupt) {
        step_verdict("memory0_verdict", "warn", memory_corrupt_text)
        return
    }
    box.hidden = true
}

// Подпись блока (#memory0_head)
function memory_head(text) {
    const head = document.getElementById("memory0_head")
    head.textContent = text
    head.hidden = false
}

// Список выбора для лога без строки контроллера: проходы list по убыванию даты, по умолчанию ничего не выбрано —
// прохода нет, пока его не выберут (memory_show_none)
function memory_show_list(list) {
    memory_step0.list = list
    const select = document.getElementById("memory0_pick")
    select.replaceChildren(new Option("— не выбран —", ""), ...list.map((pass) => new Option(memory_pass_label(pass), pass.key)))
    select.value = ""
    document.getElementById("memory0_pick_field").hidden = false
    memory_show_none()
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
    if (memory_step0.corrupt) {
        step_verdict("memory0_verdict", "warn", memory_corrupt_text)
    } else {
        document.getElementById("memory0_verdict").hidden = true
    }
}

// Показать проход pass: подпись (дата, лог, прошивка), таблица «что применено» (passmem_applied по параметрам лога и
// размеру маски HMNCS — как в step_summary_context) и вердикт: лог прошлого прохода (значения лога равны «было»
// прохода и имя файла то же) — значения ещё не применялись; применено всё — ok; иначе — предупреждение «K из N».
// Проход и «применено» — в memory_state
function memory_show_pass(pass) {
    const bits = hmncs_bits(state.params, state.spectrum.filter_version ?? 1)
    const applied = passmem_applied(pass, state.params, bits)

    memory_head("Сохранён " + memory_date_text(pass.saved_at) + ", лог " + (pass.file_name ?? "—") + ", прошивка " + (pass.fw ?? "—"))
    const cell = (text) => '<td class="num">' + html_escape(text) + '</td>'
    const table = document.getElementById("memory0_table")
    table.querySelector("tbody").innerHTML = applied.rows.map((row) => '<tr>' + cell(row.name) + cell(String(row.step)) + cell(step_value_text(row.proposed)) +
        cell(step_value_text(row.now)) + '<td class="memory0-status memory0-status--' + row.status + '">' + html_escape(memory_status_text[row.status]) + '</td></tr>').join("")
    table.hidden = false

    let status = "warn"
    let text = "Применено " + applied.applied + " из " + applied.total + "."
    if (applied.same_log && (pass.file_name === state.file_name)) {
        text = "Это лог прошлого прохода — значения ещё не применялись."
    } else if (applied.applied === applied.total) {
        status = "ok"
    }
    if (memory_step0.corrupt) {
        status = "warn"
        text += " " + memory_corrupt_text
    }
    step_verdict("memory0_verdict", status, text)
    document.getElementById("memory0_forget").hidden = false

    memory_state.pass = pass
    memory_state.applied = applied
}

// «Забыть проход этого аппарата»: показанный проход — из памяти браузера по его ключу, блок скрыт, прохода для лога
// больше нет. Память перечитывается: после загрузки лога её мог переписать шаг 5. Хранилища нет или запись не
// удалась — блок остаётся, в вердикте — ошибка
function memory_forget() {
    const pass = memory_state.pass
    if (pass == null) {
        return
    }
    const storage = memory_storage()
    const read = passmem_read(storage)
    if ((read.error === "unavailable") || (passmem_write(storage, passmem_forget(read.passes, pass.key)) != null)) {
        step_verdict("memory0_verdict", "fail", "Проход не забыт: браузер не даёт изменить память прохода (приватный режим, запрет или переполнение хранилища).")
        return
    }
    document.getElementById("memory0").hidden = true
    memory_state.pass = null
    memory_state.applied = null
}
