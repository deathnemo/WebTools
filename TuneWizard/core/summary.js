// Итог прохода мастера (шаг 5 «Сводка»): строки «было → станет» по принятому на шагах 2–4, значения и текст
// файла .param из изменённых параметров, отпечаток входов принятого шага и «устарело», «что перелететь». Без DOM:
// работает в браузере и под Node (тесты). Дизайн — docs/plans/2026-10-25-tune-wizard-stage5-design.md, раздел 2.
// Источники: [решение пользователя 25.10.2026]; [наше] — решение мастера; [код] — исходники ArduPilot и шагов мастера.
//
// Всё, что живёт в steps/, ядро получает аргументом, чтобы core/ не зависело от steps/: списки имён параметров шагов
// (страница собирает их step2_param_names(), lowpass_param_names(state.params), step4_param_names()), совет
// тестового полёта (step4_test_flight_short) и поиск записи в метаданных параметров (step_find_metadata).
//
// Нужны глобалы страницы: core/params.js (param_file_text, is_bitmask_param, mask_unsigned, mask_signed; ему —
// Libraries/Param_Helpers.js), Libraries/Param_Helpers.js (param_to_string), core/filters.js (notch_param_names),
// core/pidtune.js (pidtune_axes).

// Одно ли значение у параметра name: a и b — числа или null (параметра нет). Оба null — одно, один null — разное.
// Маски (is_bitmask_param) — целые: *_HMNCS сравниваются без знака по размеру маски bits (mask_unsigned: 8-битная
// −128 из лога — та же гармоника 8, что 128 из формы), остальные маски — как есть; во float32 маски потеряли бы
// младшие биты. Прочее — как float32: так прошивка хранит параметры, 0.7 из формы и 0.699999988 из лога — одно [код].
// bits (hmncs_bits) обязателен для *_HMNCS; у остальных имён не используется
function summary_same(name, a, b, bits) {
    if ((a == null) || (b == null)) {
        return (a == null) && (b == null)
    }
    if (is_bitmask_param(name)) {
        return name.endsWith("_HMNCS") ? (mask_unsigned(a, bits) === mask_unsigned(b, bits)) : (a === b)
    }
    return Math.fround(a) === Math.fround(b)
}

// Включается ли notch: его ENABLE в логе нет (log null) или ≤ 0, а принято value > 0. Пока notch выключен, прошивка
// скрывает остальные его поля — в логе их нет [код]
function summary_notch_enabling(log, value) {
    return ((log == null) || (log <= 0)) && (value > 0)
}

// Строки итога по принятым шагам 2–4. ctx = { params, steps, names: { 2: […], 3: […], 4: […] }, filter_version, bits }:
// params — параметры лога (get(name) → число или null, has(name)); steps — state.steps (принятое шага n —
// steps[n].accepted, имя → число, в нём должно быть каждое имя из names[n]; у шага 4 ещё
// steps[4].axes[ось].metrics.reliable); names — имена параметров шагов; filter_version — версия фильтра лога (нет —
// считается 1, как в step2_save_param); bits — размер маски HMNCS (hmncs_bits).
// → { rows, conflicts, accepted }:
// - accepted — { 2, 3, 4 }: принят ли шаг (steps[n] != null);
// - rows — строки { name, log, value, step, changed, note } только принятых шагов, по шагам 2 → 3 → 4 и порядку имён
//   шага; log — последнее значение в логе или null, value — принятое, note — пометка словами или null. Имя, которое
//   есть у нескольких принятых шагов (INS_GYRO_FILTER у шагов 2 и 3), — одна строка от последнего: шаг 3 считает
//   от notch шага 2 [решение пользователя 25.10.2026];
// - conflicts — такие имена с разными значениями шагов: { name, values: { шаг: значение }, used: шаг строки }.
// *_ESCMSK при версии фильтра ниже 4 строки не получает: у прошивок ниже её нет, а 0 вместо настоящей маски сменил бы
// набор моторов (как «Сохранить .param» шага 2). Включаемый notch (summary_notch_enabling): все его поля изменены,
// даже совпавшие с логом, «было» у отсутствующих — null. Прочий параметр без лога не изменён и не пишется: значение
// для него в лог не попало, сравнить не с чем [наше]. Изменённая строка шага 4 ненадёжной оси
// (metrics.reliable === false) — значение введено вручную, а не из измерения: пометка
function summary_rows(ctx) {
    const steps_order = [2, 3, 4]
    const log_value = (name) => ctx.params.has(name) ? ctx.params.get(name) : null

    const accepted = {}
    // Значения имени по принятым шагам (шаг → значение) и последний принявший его шаг
    const sources = {}
    const last = {}
    for (const n of steps_order) {
        accepted[n] = ctx.steps[n] != null
        if (!accepted[n]) {
            continue
        }
        for (const name of ctx.names[n]) {
            if (!(name in sources)) {
                sources[name] = {}
            }
            sources[name][n] = ctx.steps[n].accepted[name]
            last[name] = n
        }
    }
    // Значение, которое идёт в итог: от последнего принявшего имя шага
    const final_value = (name) => sources[name][last[name]]

    // Поля включаемых notch
    const enabling = new Set()
    for (const notch of notch_param_names()) {
        if ((notch.enable in last) && summary_notch_enabling(log_value(notch.enable), final_value(notch.enable))) {
            for (const name of Object.values(notch)) {
                enabling.add(name)
            }
        }
    }

    const rows = []
    const conflicts = []
    for (const n of steps_order) {
        if (!accepted[n]) {
            continue
        }
        for (const name of ctx.names[n]) {
            if (last[name] !== n) {
                continue
            }
            if (name.endsWith("_ESCMSK") && ((ctx.filter_version ?? 1) < 4)) {
                continue
            }
            const log = log_value(name)
            const value = final_value(name)
            let changed
            let note = null
            if (enabling.has(name)) {
                changed = true
            } else if (log == null) {
                changed = false
                note = "нет в логе — не пишется"
            } else {
                changed = !summary_same(name, log, value, ctx.bits)
            }
            if ((n === 4) && changed) {
                const axis = Object.keys(pidtune_axes).find((a) => name.startsWith(pidtune_axes[a].rate))
                if (ctx.steps[4].axes?.[axis]?.metrics?.reliable === false) {
                    note = "ось ненадёжна — значение введено вручную"
                }
            }
            rows.push({ name: name, log: log, value: value, step: n, changed: changed, note: note })

            const values = sources[name]
            if (Object.values(values).some((v) => !summary_same(name, v, value, ctx.bits))) {
                conflicts.push({ name: name, values: { ...values }, used: n })
            }
        }
    }
    return { rows: rows, conflicts: conflicts, accepted: accepted }
}

// Значения для файла .param: объект имя → число из строк итога с changed. Маски *_HMNCS — со знаком при 8 битах
// (mask_signed): так их хранит прошивка и так пишет шаг 2 (step2_save_param)
function summary_param_values(rows, bits) {
    const values = {}
    for (const row of rows) {
        if (row.changed) {
            values[row.name] = row.name.endsWith("_HMNCS") ? mask_signed(row.value, bits) : row.value
        }
    }
    return values
}

// Текст файла .param из изменённых строк итога (param_file_text: натуральный порядок имён, кратчайшая запись
// float32); изменённых нет — null: файла нет. Только изменённые — что поменяли в Mission Planner после полёта,
// файл не перезапишет [решение пользователя 25.10.2026]
function summary_param_text(rows, bits) {
    const values = summary_param_values(rows, bits)
    return (Object.keys(values).length > 0) ? param_file_text(values) : null
}

// Имя файла .param: имя лога без последнего расширения + «_tune.param»; имени нет (null или пустая строка) —
// «tune.param»
function summary_file_name(log_name) {
    return (((log_name != null) && (log_name !== "")) ? log_name.replace(/\.[^.]*$/, "") + "_" : "") + "tune.param"
}

// Отпечаток входов шага n (2–4) для «устарело»: строка JSON [start, end, fft_key, filter_version, [принятое шагов
// 2..n−1]], ctx = { start, end, fft_key, filter_version, steps } — интервал анализа (state.settings.start/end), ключ
// FFT шага 1 (step1.fft_key), версия фильтра шага 1 и state.steps; нет значения (undefined) — null.
// Ключ FFT и версия фильтра — только у шагов 2–3: они всегда считают шаг 1 до «Принять» (версия фильтра меняет и
// форму шага 2: ниже 4 ESCMSK — 0); у шага 4 на их месте null. Ключ FFT: шаг 4 можно принять, не открывая шаг 1, и
// ключ, появившийся позже, давал бы ложное «устарело». Версия фильтра: шаг 4 зависит от неё только через фильтры
// гироскопа и устаревает через изменённое принятое шагов 2–3; если после смены версии шаги 2–3 приняли заново с теми
// же значениями, шаг 4 устаревшим не станет — допустимо, версию меняют редко [наше].
// Принятое шага k — пары [имя, значение] с именами по алфавиту (как candidate_key), значения как есть;
// не принят — null.
// Ключи расчёта шагов (calc_key) не годятся: в них окно FFT и выбор набора, их смена давала бы ложное «устарело» [наше]
function summary_inputs_key(n, ctx) {
    const accepted = []
    for (let k = 2; k < n; k++) {
        const values = ctx.steps[k]?.accepted ?? null
        accepted.push((values != null) ? Object.keys(values).sort().map((name) => [name, values[name]]) : null)
    }
    const from_step1 = (n < 4) ? [ctx.fft_key ?? null, ctx.filter_version ?? null] : [null, null]
    return JSON.stringify([ctx.start ?? null, ctx.end ?? null, ...from_step1, accepted])
}

// Устарело ли принятое шага n: шаг принят (steps[n] != null), а отпечаток, сохранённый при «Принять»
// (steps[n].inputs), не совпал с посчитанным заново (summary_inputs_key); принятое без отпечатка — тоже устарело.
// ctx — как у summary_inputs_key. Устаревшее предупреждается, не блокирует [решение пользователя 25.10.2026]
function summary_stale(n, ctx) {
    return (ctx.steps[n] != null) && (ctx.steps[n].inputs !== summary_inputs_key(n, ctx))
}

// Подсказка про включаемый notch: пока его ENABLE на аппарате ≤ 0, прошивка скрывает остальные поля notch [код] —
// записать их можно только после ENABLE = 1 и обновления списка параметров. enable_name — имя ENABLE
// (INS_HNTC2_ENABLE), префикс полей — оно без «ENABLE»; log_value — ENABLE в логе (null — нет в логе, пишется 0).
// Один текст у шага 2 (step2_second_notch_hint) и у «что перелететь»
function summary_notch_enable_hint(enable_name, log_value) {
    const prefix = enable_name.replace(/ENABLE$/, "")
    return "В логе " + enable_name + " = " + param_to_string(log_value ?? 0) + ": на аппарате сначала запишите " +
        enable_name + " = 1 и обновите список параметров — остальные " + prefix + "* появятся только после этого, " +
        "затем загрузите файл ещё раз."
}

// Законченная фраза: точка в конце, если фраза не кончается на . ! ? — текст с точкой (будущий fix проверки) не
// получит вторую
function summary_period(text) {
    return /[.!?]$/.test(text) ? text : text + "."
}

// «Что перелететь»: пункты [{ source, text }] по порядку, каждый текст — фраза с точкой (summary_period)
// [решение пользователя 25.10.2026]. ctx = { checks, rows, reboot_names, unreliable_axes, test_flight }:
// - checks — проверки шага 0 (state.checks: { status, title, fix }; null — проверок нет);
// - rows — строки итога, summary_rows(…).rows;
// - reboot_names — имена, которым нужна перезагрузка (summary_reboot_names): [] — метаданные есть, перезагрузка не
//   нужна; null — метаданные не загрузились;
// - unreliable_axes — ключи осей шага 4 без надёжного измерения (roll | pitch | yaw; [] или null — таких нет). Страница
//   берёт их из принятого шага 4 или из посчитанного: совет нужен и тогда, когда менять нечего и «Принять» на шаге 4
//   не нажимали [наше];
// - test_flight — совет тестового полёта (step4_test_flight_short).
// Пункты:
// 1. "check" — проверки warn или fail с непустым fix: «title — fix» (в fix бывают свои двоеточия);
// 2. "notch" — каждый включаемый notch (изменённая строка его ENABLE, summary_notch_enabling):
//    summary_notch_enable_hint;
// 3. "reboot" — изменённые строки из reboot_names, одним пунктом в порядке строк; reboot_names null, а изменённые
//    есть — общий пункт: после записи перезагрузить полётный контроллер — так надёжнее [наше];
// 4. "test_flight" — есть оси из unreliable_axes: «Оси — test_flight», оси — pidtune_axes[ось].title через запятую
//    в порядке pidtune_axes, первая с заглавной;
// 5. "repeat" — последним, только если есть изменённые строки: слетать тем же профилем и загрузить лог. Без
//    изменений проверять нечего, и список может быть пустым [наше]
function summary_refly(ctx) {
    const items = []
    const add = (source, text) => items.push({ source: source, text: summary_period(text) })

    for (const check of ctx.checks ?? []) {
        if (((check.status === "warn") || (check.status === "fail")) && ((check.fix ?? "") !== "")) {
            add("check", check.title + " — " + check.fix)
        }
    }

    const changed = ctx.rows.filter((row) => row.changed)
    const enables = notch_param_names().map((notch) => notch.enable)
    for (const row of changed) {
        if (enables.includes(row.name) && summary_notch_enabling(row.log, row.value)) {
            add("notch", summary_notch_enable_hint(row.name, row.log))
        }
    }

    if (ctx.reboot_names == null) {
        if (changed.length > 0) {
            add("reboot", "Описания параметров не загрузились, и мастер не знает, какие изменённые параметры " +
                "действуют только после перезагрузки: после записи перезагрузите полётный контроллер — так надёжнее")
        }
    } else {
        const reboot = changed.map((row) => row.name).filter((name) => ctx.reboot_names.includes(name))
        if (reboot.length > 0) {
            add("reboot", "После записи перезагрузите полётный контроллер — только после перезагрузки действуют: " +
                reboot.join(", "))
        }
    }

    const axes = Object.keys(pidtune_axes).filter((axis) => (ctx.unreliable_axes ?? []).includes(axis))
    if (axes.length > 0) {
        const titles = axes.map((axis) => pidtune_axes[axis].title).join(", ")
        add("test_flight", titles[0].toUpperCase() + titles.slice(1) + " — " + ctx.test_flight)
    }

    if (changed.length > 0) {
        add("repeat", "Слетайте тем же профилем и загрузите лог в мастер: шаг 0 покажет, что применено, шаги 2–4 — " +
            "сбылся ли прогноз")
    }
    return items
}

// Имена из names, которым после записи нужна перезагрузка: в метаданных параметров (FilterReview/params.json —
// описания ArduPilot) RebootRequired = "True" [код]. find(metadata, name) → запись или null (страница передаёт
// step_find_metadata). [] — метаданные есть, перезагрузка не нужна; metadata null (не загрузились) — null, а не []:
// summary_refly тогда даёт общий пункт; find не зовётся
function summary_reboot_names(names, metadata, find) {
    if (metadata == null) {
        return null
    }
    return names.filter((name) => find(metadata, name)?.RebootRequired === "True")
}
