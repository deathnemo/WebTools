// Шаг 5 «Сводка»: итог прохода по принятому на шагах 2–4 — плитки, вердикт, состояние шагов (принят, не принят,
// устарело), изменённые параметры «было → станет» и расхождения шагов, неизменённые (свёрнуто), «что перелететь»,
// файл .param из изменённых, память прохода и печать сводки. Логика без DOM — core/summary.js и core/passmem.js;
// сводка перестраивается при каждом показе шага. Дизайн — docs/plans/2026-10-25-tune-wizard-stage5-design.md, раздел 3.
// Источники: [решение пользователя 25.10.2026]; [наше] — решение мастера.
//
// Нужны глобалы страницы: core/summary.js (summary_*), core/candidates.js (candidate_rules), core/pidtune.js
// (pidtune_axes), Libraries/FileSaver.js (saveAs), wizard.js (state, set_step, STEP_TITLES, html_escape),
// steps/common.js (step_summary_context, step_accepted_stale, step_tile, step_verdict, step_value_text, step_signed,
// step_plural, step_try, step_metadata, step_metadata_failed, step_load_metadata, step_find_metadata), steps/step2.js
// (step2_flagged, step2_accepted_flags_text), steps/step3.js (step3_summary_text, step3_flagged, step3_flags_text),
// steps/step4.js (step4, step4_axis_list, step4_ready, step4_stale, step4_fixed, step4_test_flight_short) и
// steps/memory.js (memory_save). Все они нужны только при вызове.

// Внутреннее состояние шага
const step5_state = {
    metadata_waiting: false,  // ждём загрузки метаданных параметров, чтобы перерисовать сводку (один .then на страницу)
    unchanged_open: null,     // раскрыт ли список «без изменений» до печати (null — печать не идёт)
}

// Шаги, принятое которых сводит итог
const step5_steps = [2, 3, 4]

// Формы слова «параметр» для step_plural
const step5_param_forms = ["параметр", "параметра", "параметров"]

// Что после «Принять» могло сделать принятое шага устаревшим — входы отпечатка (summary_inputs_key) словами; у шага 4
// из принятого на шагах 2–3 — только фильтры (step_depends4_names)
const step5_stale_inputs = {
    2: "интервал анализа или расчёт шага 1",
    3: "интервал анализа, расчёт шага 1 или принятое на шаге 2",
    4: "интервал анализа или фильтры шагов 2–3",
}

// ---------- Подписи ----------

// Фраза с заглавной буквы
function step5_capital(text) {
    return text.charAt(0).toUpperCase() + text.slice(1)
}

// Названия осей шага 4 через запятую, по порядку pidtune_axes
function step5_axes_titles(axes) {
    return step4_axis_list.filter((axis) => axes.includes(axis)).map((axis) => pidtune_axes[axis].title).join(", ")
}

// Оси шага 4 без надёжного измерения словами: «оси шага 4 без надёжного измерения: крен, тангаж — нужен тестовый
// полёт» (одна ось — «ось шага 4 …»)
function step5_unreliable_text(axes) {
    return ((axes.length == 1) ? "ось шага 4 без надёжного измерения: " : "оси шага 4 без надёжного измерения: ") +
        step5_axes_titles(axes) + " — нужен тестовый полёт"
}

// ---------- Данные сводки ----------

// Оси шага 4 без надёжного измерения (ключи pidtune_axes) — для вердикта и «что перелететь»: из принятого шага 4
// (metrics.reliable не true — как «ненадёжно» в таблице шагов), а если шаг 4 не принят — из уже посчитанного, только
// при актуальном расчёте: на логе вроде тестового менять нечего, и «Принять» могут не нажать [наше]. Шаг 4 не
// открывался или расчёт устарел — []
function step5_unreliable_axes() {
    const accepted = state.steps[4]
    if (accepted != null) {
        return step4_axis_list.filter((axis) => accepted.axes?.[axis]?.metrics?.reliable !== true)
    }
    if (!step4_ready() || step4_stale()) {
        return []
    }
    return step4_axis_list.filter((axis) => step4.calc[axis].status !== "ok")
}

// Имена изменённых строк rows, которым после записи нужна перезагрузка (summary_reboot_names): метаданные ещё грузятся —
// [] (пункта нет, он появится после загрузки: step5_show перерисует сводку); не загрузились — null (общий пункт)
function step5_reboot_names(rows) {
    if (step_metadata_failed()) {
        return null
    }
    const data = step_metadata()
    if (data == null) {
        return []
    }
    return summary_reboot_names(rows.filter((row) => row.changed).map((row) => row.name), data, step_find_metadata)
}

// Оси принятого шага 4 с отметками прогноза (непустые flags.reasons)
function step5_flagged4_axes(accepted) {
    return step4_axis_list.filter((axis) => (accepted.axes?.[axis]?.flags?.reasons?.length ?? 0) > 0)
}

// Прогноз оси принятого шага 4 словами (metrics — step4_metrics_summary): «ненадёжно», «прогноз недостоверен» или
// перерегулирование и запас фазы прогноза; величины, которых в прогнозе нет, не пишутся
function step5_axis_text(m) {
    if ((m == null) || (m.reliable !== true)) {
        return "ненадёжно"
    }
    if (!m.prediction_valid) {
        return "прогноз недостоверен"
    }
    const pred = m.prediction
    if (pred == null) {
        return "прогноза нет"
    }
    if (pred.unstable) {
        return "прогноз неустойчив"
    }
    const pm = Number.isFinite(pred.pm_deg) ? "запас фазы " + step4_fixed(pred.pm_deg, 1) + "°" : null
    if (!Number.isFinite(pred.overshoot_pct)) {
        return (pm != null) ? "прогноз: " + pm : "прогноза нет"
    }
    return "прогноз перерегулирования " + step4_fixed(pred.overshoot_pct, 1) + " %" + ((pm != null) ? ", " + pm : "")
}

// Итог принятого шага n словами → { text, flags }: text — короткий итог к логу (без заглавной), flags — отметки словами
// теми же функциями, что у вердиктов шагов, или null — отметок нет.
// Шаг 2 — полоса и задержка на старшей частоте задержки (30 Гц) к логу; шаг 3 — шум гироскопа, шум D крена и тангажа
// и задержка путей P и D (step3_summary_text); шаг 4 — по осям прогноз перерегулирования и запаса фазы, «ненадёжно»
// или «прогноз недостоверен» (step5_axis_text)
function step5_step_result(n, accepted) {
    const metrics = accepted.metrics
    if (n === 2) {
        let text = "без сравнения с логом"
        if (metrics != null) {
            const rules = candidate_rules
            const hz = rules.lag_freqs_hz[rules.lag_freqs_hz.length - 1]
            const cur = metrics.current
            const log = metrics.log
            text = "полоса " + rules.band_hz.join("–") + " Гц " + cur.band_dB.toFixed(2) + " дБ (к логу " + step_signed(cur.band_dB - log.band_dB, 2) +
                "), задержка на " + hz + " Гц " + cur.lag_ms[hz].toFixed(2) + " мс (к логу " + step_signed(cur.lag_ms[hz] - log.lag_ms[hz], 2) + ")"
        }
        return { text: text, flags: step2_flagged(accepted.flags) ? step2_accepted_flags_text(accepted) : null }
    }
    if (n === 3) {
        const text = (metrics != null) ? step3_summary_text(metrics.current, metrics.log) + " (к логу)" : "без сравнения с логом"
        return { text: text, flags: step3_flagged(accepted.flags) ? step3_flags_text(accepted.flags, metrics.current, metrics.log) : null }
    }
    const text = step4_axis_list.map((axis) => pidtune_axes[axis].title + " — " + step5_axis_text(accepted.axes?.[axis]?.metrics)).join("; ")
    const flagged = step5_flagged4_axes(accepted)
    const flags = flagged.map((axis) => pidtune_axes[axis].title + " — " + accepted.axes[axis].flags.reasons.join("; ")).join(" · ")
    return { text: text, flags: (flagged.length > 0) ? flags : null }
}

// ---------- Инициализация и сброс ----------

function step5_init() {
    document.getElementById("step5_download").addEventListener("click", step5_download)
    document.getElementById("step5_remember").addEventListener("click", step5_remember)
    document.getElementById("step5_print").addEventListener("click", step5_print)
    // Память прохода (localStorage) привязана к источнику страницы: http://127.0.0.1:8000 и http://localhost:8000 —
    // разные памяти. Адрес — в поясняющей заметке, чтобы открывать мастер всегда по одному; у file:// источника нет
    document.getElementById("step5_origin").textContent = (location.origin !== "null") ? location.origin : location.protocol + "//" + location.pathname
    // «К шагу N» в таблице шагов: кнопки строятся при каждой перерисовке — один обработчик на таблицу
    document.getElementById("steps5").addEventListener("click", (e) => {
        const button = e.target.closest("button[data-goto]")
        if (button != null) {
            set_step(Number(button.dataset.goto))
        }
    })
    // Печать и кнопкой «Печать», и из меню браузера (Ctrl+P)
    window.addEventListener("beforeprint", step5_before_print)
    window.addEventListener("afterprint", step5_after_print)
}

// Новый лог или ошибка загрузки: сводка пустая, кнопки файла и памяти выключены. Память браузера не трогается
function step5_reset() {
    for (const id of ["verdict5", "tiles5", "steps5", "changes5", "conflicts5", "unchanged5", "refly5_head", "refly5", "step5_note"]) {
        document.getElementById(id).hidden = true
    }
    for (const selector of ["#steps5 tbody", "#changes5 tbody", "#unchanged5 tbody", "#tiles5", "#refly5"]) {
        document.querySelector(selector).innerHTML = ""
    }
    document.getElementById("step5_print_head").textContent = ""
    for (const id of ["step5_download", "step5_remember"]) {
        document.getElementById(id).disabled = true
    }
}

// ---------- Показ и действия ----------

// Показ шага: сводка сразу; заметка прошлого действия скрыта. Метаданных параметров ещё нет и они не сбились —
// загрузить и перерисовать (один раз, сколько бы раз шаг ни показывали): пункт «что перелететь» о перезагрузке
// появится после загрузки
function step5_show() {
    if (state.info == null) {
        return
    }
    document.getElementById("step5_note").hidden = true
    step_try(step5_render, "verdict5", "шага 5")
    if ((step_metadata() == null) && !step_metadata_failed() && !step5_state.metadata_waiting) {
        step5_state.metadata_waiting = true
        step_load_metadata().then(() => {
            step5_state.metadata_waiting = false
            if ((state.step === 5) && (state.info != null)) {
                step_try(step5_render, "verdict5", "шага 5")
            }
        })
    }
}

// Заметка под кнопками (#step5_note): итог скачивания и сохранения памяти
function step5_note(text) {
    const note = document.getElementById("step5_note")
    note.textContent = text
    note.hidden = false
}

// «Скачать .param»: только изменённые параметры (summary_param_text) в файл <лог>_tune.param, затем память прохода —
// скачанный файл означает намерение применить [решение пользователя 25.10.2026]. Устаревшее принятое не блокирует.
// Ошибку памяти memory_save возвращает текстом заметки, не бросает
function step5_download() {
    step_try(() => {
        const ctx = step_summary_context()
        const rows = summary_rows(ctx).rows
        const text = summary_param_text(rows, ctx.bits)
        if (text == null) {
            return
        }
        const name = summary_file_name(state.file_name)
        saveAs(new Blob([text], { type: "text/plain;charset=utf-8" }), name)
        const count = Object.keys(summary_param_values(rows, ctx.bits)).length
        step5_note("Файл " + name + ": " + step_plural(count, step5_param_forms) + ". " + memory_save())
    }, "verdict5", "шага 5")
}

// «Запомнить проход»: память без файла — значения вводятся на аппарате вручную [решение пользователя 25.10.2026].
// Доступна и без изменений (принят хотя бы один шаг): проход без изменений закрывает прошлый проход аппарата
// (memory_save), иначе на сошедшемся логе старый проход жил бы вечно [наше]
function step5_remember() {
    step5_note(memory_save())
}

// Шапка печати (#step5_print_head, видна только при печати): «Мастер настройки · <лог> · <аппарат> · <дата печати>»;
// аппарат — строка контроллера и рама
function step5_fill_print_head() {
    const info = state.info
    const device = [info.board, info.frame].filter((part) => (part != null) && (part !== "")).join(", ")
    const date = new Date().toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })
    document.getElementById("step5_print_head").textContent = ["Мастер настройки", state.file_name ?? "—", (device !== "") ? device : "—", date].join(" · ")
}

// Перед печатью на шаге 5 (кнопка «Печать» или меню браузера): шапка с временем печати и раскрытый список «без
// изменений» — на бумаге его не раскрыть; прежнее состояние списка запоминается до конца печати
function step5_before_print() {
    if ((state.step !== 5) || (state.info == null)) {
        return
    }
    step5_fill_print_head()
    const details = document.getElementById("unchanged5")
    if (step5_state.unchanged_open == null) {
        step5_state.unchanged_open = details.open
    }
    details.open = true
}

// После печати: список «без изменений» — как был до неё
function step5_after_print() {
    if (step5_state.unchanged_open == null) {
        return
    }
    document.getElementById("unchanged5").open = step5_state.unchanged_open
    step5_state.unchanged_open = null
}

// «Печать»: диалог печати браузера; шапку и список готовит step5_before_print, правила @media print оставляют сводку
function step5_print() {
    window.print()
}

// ---------- Отрисовка ----------

// Сводка целиком: итог прохода (summary_rows), устаревшее принятое (step_accepted_stale), оси шага 4 без надёжного
// измерения; «Скачать .param» — только при изменённых строках (файла без них нет), «Запомнить проход» — если принят
// хотя бы один шаг (без изменений закрывает прошлый проход аппарата)
function step5_render() {
    const ctx = step_summary_context()
    const summary = summary_rows(ctx)
    const rows = summary.rows
    const changed = rows.filter((row) => row.changed)
    const accepted = step5_steps.filter((n) => summary.accepted[n])
    const stale = accepted.filter((n) => step_accepted_stale(n))
    const unreliable = step5_unreliable_axes()

    step5_render_tiles(changed, accepted, stale)
    step5_render_verdict(summary, ctx.bits, changed, accepted, stale, unreliable)
    step5_render_steps(stale)
    step5_render_changes(rows, summary.conflicts)
    step5_render_refly(rows, unreliable)
    document.getElementById("step5_download").disabled = changed.length == 0
    document.getElementById("step5_remember").disabled = accepted.length == 0
}

// Куда идёт значение при расхождении шагов (conflict — из summary_rows(…).conflicts, row — строка итога того же
// имени): в файл — значение шага used, если строка изменена, иначе остаётся лог
function step5_conflict_used(conflict, row) {
    return row?.changed ? "в файл идёт шаг " + conflict.used : "действует шаг " + conflict.used + ", значение как в логе — в файл не идёт"
}

// Расхождение шагов для вердикта: «INS_GYRO_FILTER: на шаге 2 принято 50, на шаге 3 — 40 (как в логе), действует
// шаг 3, значение как в логе — в файл не идёт» — значение, равное логу (summary_same по размеру маски bits),
// помечено. Пользователь на шаге 2 ждал одного, а в файл идёт другое (или ничего) — это надо видеть в вердикте, а не
// только в заметке под таблицей [наше]
function step5_conflict_issue(conflict, rows, bits) {
    const row = rows.find((r) => r.name === conflict.name) ?? null
    const values = Object.keys(conflict.values).map((n, i) => {
        const value = conflict.values[n]
        const as_log = (row?.log != null) && summary_same(conflict.name, value, row.log, bits)
        return ((i == 0) ? "на шаге " + n + " принято " : "на шаге " + n + " — ") + step_value_text(value) + (as_log ? " (как в логе)" : "")
    })
    return conflict.name + ": " + values.join(", ") + ", " + step5_conflict_used(conflict, row)
}

// Плитки: аппарат (плата — первое слово строки контроллера; рама и остаток строки — подписью), лог (прошивка подписью),
// число изменённых параметров, принятые шаги (устаревшие — подписью)
function step5_render_tiles(changed, accepted, stale) {
    const info = state.info
    const parts = ((typeof info.board === "string") ? info.board.trim() : "").split(/\s+/).filter((part) => part !== "")
    const board = (parts.length > 0) ? parts[0] : "—"
    const board_sub = [info.frame, parts.slice(1).join(" ")].filter((part) => (part != null) && (part !== "")).join(" · ")
    const box = document.getElementById("tiles5")
    box.innerHTML = [
        step_tile("Аппарат", board, board_sub, null),
        step_tile("Лог", state.file_name ?? "—", info.fw_string ?? "", null),
        step_tile("Изменено", String(changed.length), (changed.length > 0) ? "в файл .param" : "файла .param нет", "accent"),
        step_tile("Приняты шаги", (accepted.length > 0) ? accepted.join(", ") : "нет", (stale.length > 0) ? "устарело: " + stale.join(", ") : "", null),
    ].join("")
    box.hidden = false
}

// Вердикт: ничего не принято (или лог не Copter) — «менять нечего» (и тестовый полёт, если оси шага 4 без надёжного
// измерения уже известны); есть устаревшее, расхождение шагов (step5_conflict_issue), изменённые PID, менявшиеся
// после интервала анализа (summary.moved), отметки шагов или оси шага 4 без надёжного измерения — предупреждение с
// перечнем; иначе — готово или «совпадает с логом». summary — summary_rows(…), bits — размер маски HMNCS контекста
function step5_render_verdict(summary, bits, changed, accepted, stale, unreliable) {
    if ((accepted.length == 0) || (state.info.vehicle !== "Copter")) {
        const tail = (unreliable.length > 0) ? " " + step5_capital(step5_unreliable_text(unreliable)) + " (ниже)." : ""
        step_verdict("verdict5", "warn", "Менять нечего: ни один из шагов 2–4 не принят." + tail)
        return
    }
    const issues = []
    if (stale.length == 1) {
        issues.push("принятое шага " + stale[0] + " устарело — примите шаг " + stale[0] + " заново")
    } else if (stale.length > 1) {
        issues.push("принятое шагов " + stale.join(", ") + " устарело — примите их заново")
    }
    for (const conflict of summary.conflicts) {
        issues.push(step5_conflict_issue(conflict, summary.rows, bits))
    }
    if (changed.some((row) => summary.moved.includes(row.name))) {
        issues.push("PID менялись после интервала анализа: принятое перепишет значения конца лога (см. пометки)")
    }
    const flagged = []
    if ((state.steps[2] != null) && step2_flagged(state.steps[2].flags)) {
        flagged.push(2)
    }
    if ((state.steps[3] != null) && step3_flagged(state.steps[3].flags)) {
        flagged.push(3)
    }
    if (flagged.length > 0) {
        issues.push(((flagged.length == 1) ? "шаг " : "шаги ") + flagged.join(", ") + ((flagged.length == 1) ? " принят" : " приняты") + " с отметками")
    }
    const flagged4 = (state.steps[4] != null) ? step5_flagged4_axes(state.steps[4]) : []
    if (flagged4.length > 0) {
        issues.push("у шага 4 отметки прогноза: " + step5_axes_titles(flagged4))
    }
    if (unreliable.length > 0) {
        issues.push(step5_unreliable_text(unreliable))
    }
    const count = step_plural(changed.length, step5_param_forms)
    if (issues.length > 0) {
        const head = (changed.length > 0) ? "Изменено " + count : "Принятые значения совпадают с логом"
        step_verdict("verdict5", "warn", head + ", но проверьте: " + issues.join("; ") + ".")
    } else if (changed.length > 0) {
        step_verdict("verdict5", "ok", "Готово: изменено " + count + ".")
    } else {
        step_verdict("verdict5", "ok", "Принятые значения совпадают с логом — менять нечего.")
    }
}

// Таблица шагов 2–4: принят (итог и отметки), не принят (параметры шага — как в логе) или устарело (кнопка «К шагу N»,
// принятое и отметки — мелкими строками). stale — устаревшие шаги
function step5_render_steps(stale) {
    const html = step5_steps.map((n) => {
        const accepted = state.steps[n]
        const title = '<td>Шаг ' + n + '<small>' + html_escape(STEP_TITLES[n]) + '</small></td>'
        if (accepted == null) {
            return '<tr>' + title + '<td class="step5-state step5-state--off">не принят</td><td>Параметры шага остаются как в логе.</td><td></td></tr>'
        }
        const result = step5_step_result(n, accepted)
        const flags = (result.flags != null) ? '<small class="step5-flags">Отметки: ' + html_escape(result.flags) + '</small>' : ""
        if (stale.includes(n)) {
            return '<tr>' + title + '<td class="step5-state step5-state--warn">устарело</td><td>Примите шаг ' + n + ' заново: после «Принять» сменились ' +
                html_escape(step5_stale_inputs[n]) + '.<small>Принято: ' + html_escape(result.text) + '</small>' + flags + '</td>' +
                '<td><button type="button" data-goto="' + n + '">К шагу ' + n + '</button></td></tr>'
        }
        return '<tr>' + title + '<td class="step5-state step5-state--ok">принят</td><td>' + html_escape(step5_capital(result.text)) + flags + '</td><td></td></tr>'
    })
    const box = document.getElementById("steps5")
    box.querySelector("tbody").innerHTML = html.join("")
    box.hidden = false
}

// Изменения: изменённые строки итога «было → станет» (маски — числом, как в форме шага 2; параметра нет в логе —
// «нет в логе»), расхождения шагов по одному имени (INS_GYRO_FILTER шагов 2 и 3) и свёрнутый список без изменений
function step5_render_changes(rows, conflicts) {
    const changed = rows.filter((row) => row.changed)
    const unchanged = rows.filter((row) => !row.changed)
    const cell = (text) => '<td class="num">' + html_escape(text) + '</td>'
    const box = document.getElementById("changes5")
    box.querySelector("tbody").innerHTML = (changed.length > 0) ?
        changed.map((row) => '<tr>' + cell(row.name) + cell((row.log == null) ? "нет в логе" : step_value_text(row.log)) + cell(step_value_text(row.value)) +
                             cell(String(row.step)) + '<td>' + html_escape(row.note ?? "") + '</td></tr>').join("") :
        '<tr><td colspan="5">Изменённых параметров нет.</td></tr>'
    box.hidden = false

    // Расхождение: значения шагов по порядку; куда идёт значение — step5_conflict_used
    const note = document.getElementById("conflicts5")
    note.textContent = conflicts.map((conflict) => {
        const values = Object.keys(conflict.values).map((n) => "шаг " + n + " — " + step_value_text(conflict.values[n])).join(", ")
        return conflict.name + ": " + values + ", " + step5_conflict_used(conflict, rows.find((r) => r.name === conflict.name) ?? null) + "."
    }).join(" ")
    note.hidden = conflicts.length == 0

    const details = document.getElementById("unchanged5")
    details.querySelector("summary").textContent = "Без изменений — " + step_plural(unchanged.length, step5_param_forms)
    details.querySelector("tbody").innerHTML = unchanged.map((row) => '<tr>' + cell(row.name) + cell(step_value_text(row.value)) + cell(String(row.step)) +
                                                                       '<td>' + html_escape(row.note ?? "") + '</td></tr>').join("")
    details.hidden = unchanged.length == 0
}

// «Что перелететь» (summary_refly): пустой список — блок скрыт вместе с заголовком
function step5_render_refly(rows, unreliable) {
    const items = summary_refly({
        checks: state.checks,
        // Блок подготовки шага 0 (steps/prep.js); его нет — пунктов подготовки нет
        prep: (typeof prep0_items === "function") ? prep0_items() : null,
        rows: rows,
        reboot_names: step5_reboot_names(rows),
        unreliable_axes: unreliable,
        test_flight: step4_test_flight_short,
    })
    const list = document.getElementById("refly5")
    list.innerHTML = items.map((item) => '<li>' + html_escape(item.text) + '</li>').join("")
    list.hidden = items.length == 0
    document.getElementById("refly5_head").hidden = items.length == 0
}
