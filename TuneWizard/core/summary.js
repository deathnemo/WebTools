// Итог прохода мастера (шаг 5 «Сводка»): строки «было → станет» по принятому на шагах 2–4, значения и текст
// файла .param из изменённых параметров, отпечаток входов принятого шага и «устарело». Без DOM: работает
// в браузере и под Node (тесты). Дизайн — docs/plans/2026-10-25-tune-wizard-stage5-design.md, раздел 2.
// Источники: [решение пользователя 25.10.2026]; [наше] — решение мастера; [код] — исходники ArduPilot и шагов мастера.
//
// Списки имён параметров шагов ядро получает аргументом (страница собирает их step2_param_names(),
// lowpass_param_names(state.params), step4_param_names()), чтобы core/ не зависело от steps/.
//
// Нужны глобалы страницы: core/params.js (param_file_text, is_bitmask_param, mask_unsigned, mask_signed; ему —
// Libraries/Param_Helpers.js), core/filters.js (notch_param_names), core/pidtune.js (pidtune_axes).

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
// форму шага 2: ниже 4 ESCMSK — 0); шаг 4 можно принять, не открывая шаг 1, и ключ FFT, появившийся позже, давал бы
// ложное «устарело» — на их месте null; шаг 4 устаревает через изменённое принятое шагов 2–3. Принятое шага k — пары
// [имя, значение] с именами по алфавиту (как candidate_key), значения как есть; не принят — null.
// Ключи расчёта шагов (calc_key) не годятся: в них окно FFT и выбор набора, их смена давала бы ложное «устарело» [наше]
function summary_inputs_key(n, ctx) {
    const accepted = []
    for (let k = 2; k < n; k++) {
        const values = ctx.steps[k]?.accepted ?? null
        accepted.push((values != null) ? Object.keys(values).sort().map((name) => [name, values[name]]) : null)
    }
    const step1 = (n < 4) ? [ctx.fft_key ?? null, ctx.filter_version ?? null] : [null, null]
    return JSON.stringify([ctx.start ?? null, ctx.end ?? null, ...step1, accepted])
}

// Устарело ли принятое шага n: шаг принят (steps[n] != null), а отпечаток, сохранённый при «Принять»
// (steps[n].inputs), не совпал с посчитанным заново (summary_inputs_key); принятое без отпечатка — тоже устарело.
// ctx — как у summary_inputs_key. Устаревшее предупреждается, не блокирует [решение пользователя 25.10.2026]
function summary_stale(n, ctx) {
    return (ctx.steps[n] != null) && (ctx.steps[n].inputs !== summary_inputs_key(n, ctx))
}
