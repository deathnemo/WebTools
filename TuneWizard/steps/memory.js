// Память прохода на странице мастера: хранилище браузера и сохранение прохода по аппарату (шаг 5: «Скачать .param»
// и «Запомнить проход»). Формат, ключ аппарата и запись — ядро core/passmem.js; здесь — только состояние страницы.
// Дизайн — docs/plans/2026-10-25-tune-wizard-stage5-design.md, раздел 4. Блок «Прошлый проход» шага 0 и строки
// сравнения шагов 2–4 — задачи 6–7 плана этапа 5.
//
// Нужны глобалы страницы: core/passmem.js (passmem_*), core/summary.js (summary_rows), wizard.js (state),
// steps/common.js (step_accepted_stale) и steps/step5.js (step5_context). Все они нужны только при вызове.

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
// проход того же аппарата заменяется. Хранилища нет или запись не удалась (приватный режим, квота) — текст ошибки.
// Прежняя память не прочитана целиком ("corrupt": испорченный JSON, другая версия, битые записи) — сохраняются
// уцелевшие записи и новая, к тексту — оговорка [наше]. Нужен загруженный лог
function memory_save() {
    const unavailable = "Браузер не даёт сохранить память прохода (приватный режим или запрет хранилища)."
    const storage = memory_storage()
    const read = passmem_read(storage)
    if (read.error === "unavailable") {
        return unavailable
    }
    const summary = summary_rows(step5_context())
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
}
