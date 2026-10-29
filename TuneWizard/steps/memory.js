// Память прохода на странице мастера: хранилище браузера, сохранение прохода по аппарату (шаг 5: «Скачать .param»
// и «Запомнить проход»), блок «Прошлый проход» шага 0 — что из предложенного в прошлый раз стоит в загруженном логе —
// и строки сравнения шагов 2–4 «было → прогноз → в этом логе» (проход для лога — из memory_state).
// Формат, ключ аппарата, запись, «применено» и условия строки сравнения — ядро core/passmem.js; здесь — только
// состояние и текст страницы. Дизайн — docs/plans/2026-10-25-tune-wizard-stage5-design.md, раздел 4.
//
// Нужны глобалы страницы: core/passmem.js (passmem_*), core/summary.js (summary_rows), core/candidates.js
// (candidate_key), core/lowpass.js (lowpass_pid_axes, lowpass_lag_hz), wizard.js (state, html_escape), steps/common.js
// (step_summary_context, step_hmncs_bits, step_accepted_stale, step_try, step_verdict, step_value_text), steps/step1.js
// (values_from_log), steps/step2.js (step2), steps/step3.js (step3, step3_metrics_summary, step3_axis_names) и
// steps/step4.js (step4, step4_metrics_summary). Все они нужны только при вызове.

// Проход для загруженного лога (блок «Прошлый проход» шага 0): pass — проход из памяти (null — прохода нет, он не
// выбран из списка или забыт), applied — passmem_applied(pass, …) по параметрам лога (null — без прохода), key — ключ
// аппарата лога (passmem_aircraft_key; null — лог не загружен)
const memory_state = { pass: null, applied: null, key: null }

// Внутреннее состояние блока шага 0: pick — лог без строки контроллера (проход выбирается из списка), list — проходы
// списка (на момент загрузки лога, без забытых), warning — строка предупреждения о неполной памяти (memory_corrupt_texts;
// null — память прочитана целиком): она остаётся в вердикте и после выбора прохода
const memory_step0 = { pick: false, list: [], warning: null }

// Строки предупреждения о памяти, которую не удалось прочитать целиком (passmem_read): removed и kept — отброшены
// битые записи той же версии, и уцелевшее переписано в хранилище без них (removed) или запись не удалась (kept);
// version и corrupt — память другой версии формата или испорченная: не используется и при загрузке лога не
// трогается, заменит её только сохранение прохода на шаге 5 [наше]
const memory_corrupt_texts = {
    removed: "Часть памяти прохода не прочитана — удалена.",
    kept: "Часть памяти прохода не прочитана.",
    version: "Память прохода другой версии формата — не используется; её заменит «Запомнить проход» или «Скачать .param» на шаге 5.",
    corrupt: "Память прохода испорчена — не используется; её заменит «Запомнить проход» или «Скачать .param» на шаге 5.",
}

// Хвост заметки шага 5 о прежней памяти при сохранении прохода: что с ней стало (ключ — dropped или error passmem_read)
const memory_replaced_texts = {
    dropped: " Часть прежней памяти не прочитана — удалена.",
    version: " Прежняя память другой версии заменена.",
    corrupt: " Прежняя память была испорчена — заменена.",
}

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
// проход того же аппарата заменяется. Изменённых нет (принятое совпало с логом) — запись с пустым changed всё равно
// сохраняется: она закрывает прошлый проход аппарата (шаг 0 проход без изменений не показывает — memory_has_changes),
// иначе на сошедшемся логе старый проход жил бы вечно; текст об этом [наше]. Хранилища нет или запись не удалась
// (приватный режим, запрет, квота) — текст ошибки. Прежняя память не прочитана целиком: отброшены битые записи —
// сохраняются уцелевшие и новая; другая версия или испорченный JSON — заменяется целиком (это и есть явное действие
// пользователя, при загрузке лога её не трогают — memory_render_step0); к тексту — оговорка (memory_replaced_texts).
// Не бросает: неожиданная ошибка — в консоль и текстом в заметку (при «Скачать .param» файл уже скачан, и сводка не
// должна смениться на «Ошибка шага 5»). Нужен загруженный лог
function memory_save() {
    const unavailable = "Браузер не даёт сохранить память прохода (приватный режим, запрет или переполнение хранилища)."
    try {
        const storage = memory_storage()
        const read = passmem_read(storage)
        if (read.error === "unavailable") {
            return unavailable
        }
        const ctx = step_summary_context()
        const summary = summary_rows(ctx)
        const record = passmem_record({
            key: passmem_aircraft_key(state.info, state.file_name),
            info: state.info,
            file_name: state.file_name,
            rows: summary.rows,
            steps: state.steps,
            saved_at: Date.now(),
            stale: { 2: step_accepted_stale(2), 3: step_accepted_stale(3), 4: step_accepted_stale(4) },
            conflicts: summary.conflicts,
            bits: ctx.bits,
        })
        if (passmem_write(storage, passmem_put(read.passes, record)) != null) {
            return unavailable
        }
        const saved = (record.changed.length > 0) ? "Память прохода сохранена." :
            "Изменений нет — прошлый проход аппарата закрыт (память очищена для этого аппарата)."
        return saved + (read.dropped ? memory_replaced_texts.dropped : (memory_replaced_texts[read.error] ?? ""))
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
// ("unavailable") — тоже. Отброшены битые записи той же версии (dropped) — уцелевшие переписываются в хранилище без
// битых (иначе предупреждение было бы при каждой загрузке), в вердикте — строка предупреждения («удалена» — только
// если запись удалась). Память другой версии формата ("version") или испорченная ("corrupt") не используется и не
// переписывается: загрузка лога — не повод терять память (например, новой версии мастера, открытой в другой вкладке);
// в вердикте — предупреждение, что её заменит сохранение на шаге 5 [наше]. Без прохода блок показывает только
// предупреждение.
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
    if (read.dropped) {
        memory_step0.warning = (passmem_write(storage, read.passes) == null) ? memory_corrupt_texts.removed : memory_corrupt_texts.kept
    } else if (read.error != null) {
        memory_step0.warning = memory_corrupt_texts[read.error]
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

// Загружен ли лог прошлого прохода: значения лога равны «было» прохода (passmem_applied: same_log) и имя файла то же —
// значения ещё не применялись. pass и applied — проход и passmem_applied по нему (applied null — нет)
function memory_is_pass_log(pass, applied) {
    return (applied?.same_log === true) && (pass.file_name === state.file_name)
}

// Показать проход pass: подпись (дата, лог, прошивка), таблица «что применено» (passmem_applied по параметрам лога и
// размеру маски HMNCS — step_hmncs_bits, как у итога; шаг перед итогом, как в изменениях шага 5) и вердикт: лог
// прошлого прохода (memory_is_pass_log) — значения ещё не применялись; применено всё — ok; иначе — предупреждение
// «K из N». Кнопка «Забыть» — про аппарат лога или про выбранный в списке проход. Проход и «применено» — в memory_state
function memory_show_pass(pass) {
    const applied = passmem_applied(pass, state.params, step_hmncs_bits())

    memory_head("Сохранён " + memory_date_text(pass.saved_at) + ", лог " + (pass.file_name ?? "—") + ", прошивка " + (pass.fw ?? "—"))
    const cell = (text) => '<td class="num">' + html_escape(text) + '</td>'
    const table = document.getElementById("memory0_table")
    table.querySelector("tbody").innerHTML = applied.rows.map((row) => '<tr>' + cell(row.name) + cell(step_value_text(row.proposed)) + cell(step_value_text(row.now)) +
        cell(String(row.step)) + '<td class="memory0-status memory0-status--' + row.status + '">' + html_escape(memory_status_text[row.status]) + '</td></tr>').join("")
    table.hidden = false

    let status = "warn"
    let text = "Применено " + applied.applied + " из " + applied.total + "."
    if (memory_is_pass_log(pass, applied)) {
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

// ---------- Шаги 2–4: строка сравнения с прошлым проходом ----------
// Дизайн — раздел 4.5: было X → прогноз Y → в этом логе Z — сбылся ли прогноз прошлого прохода [решение пользователя
// 25.10.2026]. X — оценка лога прошлого прохода, Y — прогноз для принятого, Z — оценка конфигурации нового лога
// (вариант «Как в логе»). Порядок называется один раз, в цепочках величин — только числа (решение координатора по ревью
// задачи 7): «Прошлый проход (дата), было → прогноз → в этом логе: полоса -61.87 → -63.87 → -63.37 дБ; …»; оценки
// этого лога нет ни у одной величины — «…, было → прогноз: …». Когда строка есть и что сравнивать — passmem_compare.
// Строку рисуют вердикты шагов (step2_render_verdict, step3_render_verdict, step4_render_axis_verdict) через
// memory_show: она обновляется при каждом показе шага, а проход берёт из memory_state (шаг 0 выставляет его при
// загрузке лога и выборе в списке). Числа — с теми же знаками, что плитки метрик шагов

// Оговорка строк шагов 2–3: шум нового лога зависит не только от фильтров, но и от полёта
const memory_noise_note = "Шум зависит от полёта: газ, манёвры."

// Цепочка чисел одной величины: values — [было, прогноз] или [было, прогноз, в этом логе] через « → » и единицы units
// (с пробелом впереди, если он нужен: " дБ", но "°"); числа — с digits знаками, нет числа — «—». Чисел нет совсем —
// null: величину не писать
function memory_chain(values, digits, units) {
    if (!values.some(Number.isFinite)) {
        return null
    }
    return values.map((value) => Number.isFinite(value) ? value.toFixed(digits) : "—").join(" → ") + units
}

// «<что> <звено>»; звена нет — null
function memory_part(what, chain) {
    return (chain != null) ? what + " " + chain : null
}

// Notch-база расчёта шага 3 — notch лога: base (step3.base — принятое на шаге 2 или values_from_log) без
// INS_GYRO_FILTER равна значениям лога (values_from_log) по candidate_key. INS_GYRO_FILTER не сравнивается:
// evaluate_lowpass берёт его у варианта, а не у базы (core/lowpass.js), поэтому оценка «Как в логе» шага 3 и при
// другом INS_GYRO_FILTER, принятом на шаге 2, — оценка конфигурации лога (решение координатора по задаче 7).
// Ложных отличий нет: значения лога — float32 без потерь, принятое шагом 2 — float32 формы, маски HMNCS с обеих сторон
// без знака, ESCMSK при версии фильтра ниже 4 — 0 с обеих сторон
function memory_notch_is_log(base) {
    if (base == null) {
        return false
    }
    const notch = (values) => {
        const rest = { ...values }
        delete rest.INS_GYRO_FILTER
        return candidate_key(rest)
    }
    return notch(base) === notch(values_from_log())
}

// Оценка нового лога для строки сравнения шага n (2–4) — в форме estimates[n].log прохода (passmem_estimate2,
// passmem_estimate3, passmem_estimate4_axis). → { now } или null — расчёта шага нет (строки нет). Только величины
// конфигурации лога [дизайн, раздел 4.5]:
// - шаг 2 — оценка «Как в логе» (step2.evaluations.log);
// - шаг 3 — оценка «Как в логе» (step3.evaluations.log), если notch-база расчёта — notch лога (memory_notch_is_log);
//   иначе now null: после «Принять» на шаге 2 шаг 3 считает «Как в логе» с принятым notch, и это уже не лог;
// - шаг 4 — ось axis расчёта (step4_metrics_summary без строки): измерение — всегда; запас фазы и частота среза лога —
//   только при достоверном прогнозе оси (как плитка «Срез · запас фазы (лог)»), иначе log null. От принятого на
//   шагах 2–3 они не зависят: прогноз лога (res.pred_log) — регулятор с фильтрами лога, без поправки фильтров
//   гироскопа (решение координатора по задаче 7)
function memory_now(n, axis) {
    if (n === 2) {
        const log = step2.evaluations?.log ?? null
        return (log != null) ? { now: passmem_estimate2(log) } : null
    }
    if (n === 3) {
        const log = step3.evaluations?.log ?? null
        if (log == null) {
            return null
        }
        return { now: memory_notch_is_log(step3.base) ? passmem_estimate3(step3_metrics_summary(log)) : null }
    }
    if (step4.calc?.[axis] == null) {
        return null
    }
    const metrics = step4_metrics_summary(axis, null)
    const now = passmem_estimate4_axis(metrics)
    if (!metrics.prediction_valid) {
        now.log = null
    }
    return { now: now }
}

// Числа величины pick из оценок сравнения: [было, прогноз] и, если with_now, ещё «в этом логе»
function memory_values(compare, pick, with_now) {
    const values = [pick(compare.was), pick(compare.predicted)]
    return with_now ? [...values, pick(compare.now)] : values
}

// Величины шагов 2–4 словами — { with_now, body } (with_now — есть ли в цепочках «в этом логе»; body — текст после
// «было → прогноз[ → в этом логе]: ») или null — величин нет.
// Шаг 2: полоса и задержка на старшей частоте задержки (lowpass_lag_hz, 30 Гц; поля lag30_ms памяти), оговорка про шум
function memory_text2(compare) {
    const with_now = compare.now != null
    const chain = (pick, units) => memory_chain(memory_values(compare, pick, with_now), 2, units)
    const parts = [
        memory_part("полоса", chain((e) => e?.band_dB, " дБ")),
        memory_part("задержка на " + lowpass_lag_hz() + " Гц", chain((e) => e?.lag30_ms, " мс")),
    ].filter((part) => part != null)
    if (parts.length == 0) {
        return null
    }
    return { with_now: with_now, body: parts.join("; ") + "." + (with_now ? " " + memory_noise_note : "") }
}

// Шаг 3: шум гироскопа, шум D крена и тангажа, задержка путей P и D на старшей частоте задержки (lowpass_lag_hz,
// 30 Гц; поля lag30_ms памяти); оси без чисел не пишутся. Оценки этого лога нет (now null — notch-база не лога) —
// цепочки без «в этом логе» и пояснение вместо оговорки про шум
function memory_text3(compare) {
    const with_now = compare.now != null
    const chain = (pick, units) => memory_chain(memory_values(compare, pick, with_now), 2, units)
    // «<что> крена …, тангажа …»
    const by_axis = (what, pick, units) => {
        const items = Object.keys(lowpass_pid_axes).map((axis) => memory_part(step3_axis_names[axis].gen, chain((e) => pick(e, axis), units)))
            .filter((item) => item != null)
        return (items.length > 0) ? what + " " + items.join(", ") : null
    }
    const lag = ["P", "D"].map((path) => by_axis("путь " + path, (e, axis) => e?.lag30_ms?.[axis]?.[path], " мс")).filter((item) => item != null)
    const parts = [
        memory_part("шум гироскопа", chain((e) => e?.gyro_band_dB, " дБ")),
        by_axis("шум D", (e, axis) => e?.dterm_dB?.[axis], " дБ"),
        (lag.length > 0) ? "задержка на " + lowpass_lag_hz() + " Гц: " + lag.join(", ") : null,
    ].filter((part) => part != null)
    if (parts.length == 0) {
        return null
    }
    const tail = with_now ? memory_noise_note : "Оценка этого лога видна до «Принять» на шаге 2: после него шаг 3 считает с принятыми на шаге 2 значениями."
    return { with_now: with_now, body: parts.join("; ") + ". " + tail }
}

// Шаг 4 (ось): перерегулирование и нарастание (измерение), запас фазы (прогноз лога); нарастание — в мс, числа — как в
// плитках шага 4. Измерения в цепочках — всегда с «в этом логе» (строка есть, только если ось сейчас надёжна).
// Прогноз прошлого прохода:
// - недостоверен (predicted null у надёжной оси) — запаса фазы нет совсем (по недостоверному прогнозу о нём не судят),
//   в конце — «прогноз был недостоверен»; у измерений вместо прогноза — «—»;
// - неустойчив — его числа не пишутся (как step4_prediction_text и step5_axis_text: у неустойчивого — не числа, а
//   «неустойчив»), в конце — «прогноз был неустойчив».
// Запаса фазы этого лога нет (прогноз оси сейчас недостоверен) — у него два числа, в конце — пояснение
function memory_text4(compare) {
    const { was, now } = compare
    const valid = compare.predicted != null
    const unstable = compare.predicted?.unstable === true
    const predicted = unstable ? null : compare.predicted
    const ms = (seconds) => Number.isFinite(seconds) ? seconds * 1000 : null
    const parts = [
        memory_part("перерегулирование", memory_chain([was?.measured?.overshoot_pct, predicted?.overshoot_pct, now?.measured?.overshoot_pct], 1, " %")),
        memory_part("нарастание", memory_chain([ms(was?.measured?.rise_s), ms(predicted?.rise_s), ms(now?.measured?.rise_s)], 1, " мс")),
    ]
    const tails = []
    if (!valid) {
        tails.push("прогноз был недостоверен")
    } else {
        const pm_now = now?.log != null
        const pm = [was?.log?.pm_deg, predicted?.pm_deg]
        const chain = memory_chain(pm_now ? [...pm, now.log.pm_deg] : pm, 1, "°")
        parts.push(memory_part("запас фазы", chain))
        if (unstable) {
            tails.push("прогноз был неустойчив")
        }
        if ((chain != null) && !pm_now) {
            tails.push("запас фазы этого лога — только при достоверном прогнозе")
        }
    }
    const shown = parts.filter((part) => part != null)
    if (shown.length == 0) {
        return null
    }
    return { with_now: true, body: [...shown, ...tails].join("; ") + "." }
}

// Текст строки сравнения шага n (2–4) или null — строки нет (passmem_compare: прохода нет, оценок шага нет, шаг —
// на шаге 4 ось axis — в проходе ничего не менял; или величин нет совсем). now — оценка нового лога (memory_now).
// Дата прохода — как в подписи блока шага 0 (memory_date_text)
function memory_line(n, now, axis) {
    const compare = passmem_compare(memory_state.pass, memory_state.applied, n, now, axis)
    if (compare == null) {
        return null
    }
    const head = "Прошлый проход (" + memory_date_text(memory_state.pass.saved_at) + ")"
    if (compare.status === "partial") {
        // Прогноз шага n считался от принятого на шагах до него: «применено» — накопительно по шагам 2–n, на шаге 4 —
        // шаги 2–3 и параметры этой оси (passmem_step_status)
        return head + ": параметры " + { 2: "шага 2", 3: "шагов 2–3", 4: "шагов 2–3 и этой оси" }[n] + " применены не все — сравнивать нечего."
    }
    if (compare.status === "unreliable") {
        return head + ": измерение ненадёжно — сравнивать нечем."
    }
    const text = { 2: memory_text2, 3: memory_text3, 4: memory_text4 }[n](compare)
    if (text == null) {
        return null
    }
    return head + ", было → прогноз" + (text.with_now ? " → в этом логе" : "") + ": " + text.body
}

// Строка сравнения шага n (2–4) в #memory<n>: текст memory_line по оценке нового лога из расчёта шага (memory_now);
// прохода нет, нет расчёта или строки — скрыта. Загружен лог прошлого прохода (memory_is_pass_log) — тоже скрыта: его
// значения ещё не применялись, и «применены не все — сравнивать нечего» была бы шумом, а шаг 0 уже говорит об этом.
// axis — ось открытой вкладки шага 4. Ошибка памяти не роняет вердикт и графики шага (функцию зовут вердикты): строка
// скрыта, ошибка — в консоль
function memory_show(n, axis) {
    const box = document.getElementById("memory" + n)
    box.hidden = true
    box.textContent = ""
    if ((memory_state.pass == null) || memory_is_pass_log(memory_state.pass, memory_state.applied)) {
        return
    }
    try {
        const est = memory_now(n, axis)
        const text = (est != null) ? memory_line(n, est.now, axis) : null
        if (text != null) {
            box.textContent = text
            box.hidden = false
        }
    } catch (e) {
        console.error(e)
    }
}
