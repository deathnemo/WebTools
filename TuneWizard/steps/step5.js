// Шаг 5 «Сводка»: итог прохода по принятому на шагах 2–4 — плитки, вердикт, состояние шагов (принят, не принят,
// устарело), изменённые параметры «было → станет» и расхождения шагов, неизменённые (свёрнуто), «что перелететь»,
// файл .param из изменённых, память прохода и печать сводки. Логика без DOM — core/summary.js и core/passmem.js;
// сводка перестраивается при каждом показе шага. Дизайн — docs/plans/2026-10-25-tune-wizard-stage5-design.md, раздел 3.
// Источники: [решение пользователя 25.10.2026]; [наше] — решение мастера.
//
// Нужны глобалы страницы: core/summary.js (summary_*), core/candidates.js (candidate_rules), core/pidtune.js
// (pidtune_axes), Libraries/FileSaver.js (saveAs), wizard.js (state, set_step, STEP_TITLES, html_escape),
// steps/common.js (step_summary_context, step_accepted_stale, step_tile, step_verdict, step_value_text, step_signed,
// step_try, step_metadata, step_metadata_failed, step_load_metadata, step_find_metadata), steps/step2.js
// (step2_accepted_flags_text), steps/step3.js (step3_summary_text, step3_flagged, step3_flags_text), steps/step4.js
// (step4, step4_axis_list, step4_ready, step4_stale, step4_fixed, step4_test_flight_short) и steps/memory.js
// (memory_save). Все они нужны только при вызове.

// Шаги, принятое которых сводит итог
const step5_steps = [2, 3, 4]

// Формы слова «параметр» для step5_count
const step5_param_forms = ["параметр", "параметра", "параметров"]

// Что после «Принять» могло сделать принятое шага устаревшим — входы отпечатка (summary_inputs_key) словами
const step5_stale_inputs = {
    2: "интервал анализа или расчёт шага 1",
    3: "интервал анализа, расчёт шага 1 или принятое на шаге 2",
    4: "интервал анализа или принятое на шагах 2–3",
}

// ---------- Подписи ----------

// Число со словом в нужной форме: forms — для 1, 2–4 и 5+ («1 параметр», «3 параметра», «12 параметров»)
function step5_count(n, forms) {
    const last = n % 10
    const teen = (n % 100 >= 11) && (n % 100 <= 14)
    const form = teen ? forms[2] : ((last == 1) ? forms[0] : (((last >= 2) && (last <= 4)) ? forms[1] : forms[2]))
    return n + " " + form
}

// Фраза с заглавной буквы
function step5_capital(text) {
    return text.charAt(0).toUpperCase() + text.slice(1)
}

// Названия осей шага 4 через запятую, по порядку pidtune_axes
function step5_axes_titles(axes) {
    return step4_axis_list.filter((axis) => axes.includes(axis)).map((axis) => pidtune_axes[axis].title).join(", ")
}

// ---------- Данные сводки ----------

// Контекст итога (summary_rows) — тот же построитель, что у отпечатка входов (step_summary_context): «изменён» в сводке
// и в ключе «устарело» считается по одной версии фильтра. Нужен загруженный лог
function step5_context() {
    return step_summary_context()
}

// Оси шага 4 без надёжного измерения (ключи pidtune_axes) — для вердикта и «что перелететь»: из принятого шага 4
// (metrics.reliable === false), а если шаг 4 не принят — из уже посчитанного, только при актуальном расчёте: на логе
// вроде тестового менять нечего, и «Принять» могут не нажать [наше]. Шаг 4 не открывался или расчёт устарел — []
function step5_unreliable_axes() {
    const accepted = state.steps[4]
    if (accepted != null) {
        return step4_axis_list.filter((axis) => accepted.axes?.[axis]?.metrics?.reliable === false)
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

// Отметки принятого шага 2 — как в его вердикте (step2_render_verdict): пики хуже лога, задержка, неполная оценка
function step5_flagged2(accepted) {
    const flags = accepted.flags
    return (flags != null) && (flags.incomplete || (flags.worse_peaks.length > 0) || flags.lag_over)
}

// Оси принятого шага 4 с отметками прогноза (непустые flags.reasons)
function step5_flagged4_axes(accepted) {
    return step4_axis_list.filter((axis) => (accepted.axes?.[axis]?.flags?.reasons?.length ?? 0) > 0)
}

// Итог принятого шага n словами → { text, flags }: text — короткий итог к логу (без заглавной), flags — отметки словами
// теми же функциями, что у вердиктов шагов, или null — отметок нет.
// Шаг 2 — полоса и задержка на старшей частоте задержки (30 Гц) к логу; шаг 3 — шум гироскопа, шум D крена и тангажа
// и задержка путей P и D (step3_summary_text); шаг 4 — по осям прогноз перерегулирования и запаса фазы, «ненадёжно»
// или «прогноз недостоверен»
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
        return { text: text, flags: step5_flagged2(accepted) ? step2_accepted_flags_text(accepted) : null }
    }
    if (n === 3) {
        const text = (metrics != null) ? step3_summary_text(metrics.current, metrics.log) + " (к логу)" : "без сравнения с логом"
        return { text: text, flags: step3_flagged(accepted.flags) ? step3_flags_text(accepted.flags, metrics.current, metrics.log) : null }
    }
    const axis_text = (m) => {
        if ((m == null) || (m.reliable !== true)) {
            return "ненадёжно"
        }
        if (!m.prediction_valid) {
            return "прогноз недостоверен"
        }
        if (m.prediction == null) {
            return "прогноза нет"
        }
        if (m.prediction.unstable) {
            return "прогноз неустойчив"
        }
        return "прогноз перерегулирования " + step4_fixed(m.prediction.overshoot_pct, 1) + " %, запас фазы " + step4_fixed(m.prediction.pm_deg, 1) + "°"
    }
    const text = step4_axis_list.map((axis) => pidtune_axes[axis].title + " — " + axis_text(accepted.axes?.[axis]?.metrics)).join("; ")
    const flagged = step5_flagged4_axes(accepted)
    const flags = flagged.map((axis) => pidtune_axes[axis].title + " — " + accepted.axes[axis].flags.reasons.join("; ")).join(" · ")
    return { text: text, flags: (flagged.length > 0) ? flags : null }
}

// ---------- Инициализация и сброс ----------

function step5_init() {
    document.getElementById("step5_download").addEventListener("click", step5_download)
    document.getElementById("step5_remember").addEventListener("click", step5_remember)
    document.getElementById("step5_print").addEventListener("click", step5_print)
    // «К шагу N» в таблице шагов: кнопки строятся при каждой перерисовке — один обработчик на таблицу
    document.getElementById("steps5").addEventListener("click", (e) => {
        const button = e.target.closest("button[data-goto]")
        if (button != null) {
            set_step(Number(button.dataset.goto))
        }
    })
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
// загрузить и перерисовать: пункт «что перелететь» о перезагрузке появится после загрузки
function step5_show() {
    if (state.info == null) {
        return
    }
    document.getElementById("step5_note").hidden = true
    step_try(step5_render, "verdict5", "шага 5")
    if ((step_metadata() == null) && !step_metadata_failed()) {
        step_load_metadata().then(() => {
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
// скачанный файл означает намерение применить [решение пользователя 25.10.2026]. Устаревшее принятое не блокирует
function step5_download() {
    step_try(() => {
        const ctx = step5_context()
        const rows = summary_rows(ctx).rows
        const text = summary_param_text(rows, ctx.bits)
        if (text == null) {
            return
        }
        const name = summary_file_name(state.file_name)
        saveAs(new Blob([text], { type: "text/plain;charset=utf-8" }), name)
        const count = Object.keys(summary_param_values(rows, ctx.bits)).length
        step5_note("Файл " + name + ": " + step5_count(count, step5_param_forms) + ". " + memory_save())
    }, "verdict5", "шага 5")
}

// «Запомнить проход»: память без файла — значения вводятся на аппарате вручную [решение пользователя 25.10.2026]
function step5_remember() {
    step_try(() => step5_note(memory_save()), "verdict5", "шага 5")
}

// Шапка печати (#step5_print_head, видна только при печати): «Мастер настройки · <лог> · <аппарат> · <дата>»;
// аппарат — строка контроллера и рама
function step5_fill_print_head() {
    const info = state.info
    const device = [info.board, info.frame].filter((part) => (part != null) && (part !== "")).join(", ")
    const date = new Date().toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })
    document.getElementById("step5_print_head").textContent = ["Мастер настройки", state.file_name ?? "—", (device !== "") ? device : "—", date].join(" · ")
}

// «Печать»: шапка с датой печати, затем диалог печати браузера (правила @media print оставляют только сводку)
function step5_print() {
    if (state.info != null) {
        step5_fill_print_head()
    }
    window.print()
}

// ---------- Отрисовка ----------

// Сводка целиком: итог прохода (summary_rows), устаревшее принятое (step_accepted_stale), оси шага 4 без надёжного
// измерения; кнопки файла и памяти — только при изменённых строках
function step5_render() {
    const summary = summary_rows(step5_context())
    const rows = summary.rows
    const changed = rows.filter((row) => row.changed)
    const accepted = step5_steps.filter((n) => summary.accepted[n])
    const stale = accepted.filter((n) => step_accepted_stale(n))
    const unreliable = step5_unreliable_axes()

    step5_render_tiles(changed, accepted, stale)
    step5_render_verdict(changed, accepted, stale, unreliable)
    step5_render_steps(stale)
    step5_render_changes(rows, summary.conflicts)
    step5_render_refly(rows, unreliable)
    for (const id of ["step5_download", "step5_remember"]) {
        document.getElementById(id).disabled = changed.length == 0
    }
    step5_fill_print_head()
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

// Вердикт: ничего не принято (или лог не Copter) — «менять нечего»; есть устаревшее, отметки шагов или оси шага 4
// без надёжного измерения — предупреждение с перечнем; иначе — готово или «совпадает с логом»
function step5_render_verdict(changed, accepted, stale, unreliable) {
    if ((accepted.length == 0) || (state.info.vehicle !== "Copter")) {
        step_verdict("verdict5", "warn", "Менять нечего: ни один из шагов 2–4 не принят.")
        return
    }
    const issues = []
    if (stale.length == 1) {
        issues.push("принятое шага " + stale[0] + " устарело — примите шаг " + stale[0] + " заново")
    } else if (stale.length > 1) {
        issues.push("принятое шагов " + stale.join(", ") + " устарело — примите их заново")
    }
    if ((state.steps[2] != null) && step5_flagged2(state.steps[2])) {
        issues.push("шаг 2 принят хуже лога")
    }
    if ((state.steps[3] != null) && step3_flagged(state.steps[3].flags)) {
        issues.push("шаг 3 принят хуже лога")
    }
    const flagged4 = (state.steps[4] != null) ? step5_flagged4_axes(state.steps[4]) : []
    if (flagged4.length > 0) {
        issues.push("прогноз шага 4 помечает " + step5_axes_titles(flagged4))
    }
    if (unreliable.length > 0) {
        issues.push(((unreliable.length == 1) ? "ось шага 4 без надёжного измерения: " : "оси шага 4 без надёжного измерения: ") +
                    step5_axes_titles(unreliable) + " — нужен тестовый полёт")
    }
    const count = step5_count(changed.length, step5_param_forms)
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

    // Расхождение: значения шагов по порядку; в файл идёт значение шага used, если строка изменена, иначе остаётся лог
    const note = document.getElementById("conflicts5")
    note.textContent = conflicts.map((conflict) => {
        const values = Object.keys(conflict.values).map((n) => "шаг " + n + " — " + step_value_text(conflict.values[n])).join(", ")
        const row = rows.find((r) => r.name === conflict.name)
        const used = row?.changed ? "в файл идёт шаг " + conflict.used : "действует шаг " + conflict.used + ", значение как в логе — в файл не идёт"
        return conflict.name + ": " + values + ", " + used + "."
    }).join(" ")
    note.hidden = conflicts.length == 0

    const details = document.getElementById("unchanged5")
    details.querySelector("summary").textContent = "Без изменений — " + step5_count(unchanged.length, step5_param_forms)
    details.querySelector("tbody").innerHTML = unchanged.map((row) => '<tr>' + cell(row.name) + cell(step_value_text(row.value)) + cell(String(row.step)) +
                                                                       '<td>' + html_escape(row.note ?? "") + '</td></tr>').join("")
    details.hidden = unchanged.length == 0
}

// «Что перелететь» (summary_refly): пустой список — блок скрыт вместе с заголовком
function step5_render_refly(rows, unreliable) {
    const items = summary_refly({
        checks: state.checks,
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
