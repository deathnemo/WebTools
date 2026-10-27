// Память прохода мастера: что принято в прошлый раз на этом аппарате — изменённые параметры и оценки для проверки
// прогноза. На следующем логе шаг 0 показывает, что из предложенного стоит в логе («применено»), шаги 2–4 — «было →
// прогноз → в этом логе». Без DOM: работает в браузере и под Node (тесты). Дизайн —
// docs/plans/2026-10-25-tune-wizard-stage5-design.md, раздел 4.
// Источники: [решение пользователя 25.10.2026]; [наше] — решение мастера; [код] — исходники ArduPilot и шагов мастера.
//
// Хранилище ядро получает аргументом (storage — объект с getItem, setItem, removeItem, как localStorage, или null):
// в браузере его даёт страница, в тестах — объект над словарём. Сам localStorage ядро не трогает.
//
// Нужны глобалы страницы: core/summary.js (summary_same; ему — core/params.js и Libraries/Param_Helpers.js),
// core/lowpass.js (lowpass_pid_axes), core/pidtune.js (pidtune_axes).

// Ключ в хранилище: { version: PASSMEM_VERSION, passes: { <ключ аппарата>: проход } }. Память по аппаратам, без
// переноса между браузерами [решение пользователя 25.10.2026]; не больше PASSMEM_MAX аппаратов [наше]
const PASSMEM_KEY = "tunewizard_v1"
const PASSMEM_VERSION = 1
const PASSMEM_MAX = 20

// Проходы из хранилища → { passes, error }: error null — прочитано (ключа нет — пусто); "unavailable" — хранилища нет
// или оно бросает (приватный режим, запрет хранилища): страница пишет, что браузер не даёт сохранить память;
// "corrupt" — JSON не разбирается, другая версия или passes не объект: память игнорируется и будет начата заново.
// При ошибке passes — {}
function passmem_read(storage) {
    if (storage == null) {
        return { passes: {}, error: "unavailable" }
    }
    let text
    try {
        text = storage.getItem(PASSMEM_KEY)
    } catch {
        return { passes: {}, error: "unavailable" }
    }
    if (text == null) {
        return { passes: {}, error: null }
    }
    let data
    try {
        data = JSON.parse(text)
    } catch {
        return { passes: {}, error: "corrupt" }
    }
    const passes = data?.passes
    if ((data?.version !== PASSMEM_VERSION) || (passes == null) || (typeof passes !== "object") || Array.isArray(passes)) {
        return { passes: {}, error: "corrupt" }
    }
    return { passes: passes, error: null }
}

// Записать проходы passes (ключ аппарата → проход) в хранилище как { version, passes } → null или "unavailable"
// (хранилища нет; setItem бросает — приватный режим, квота)
function passmem_write(storage, passes) {
    if (storage == null) {
        return "unavailable"
    }
    try {
        storage.setItem(PASSMEM_KEY, JSON.stringify({ version: PASSMEM_VERSION, passes: passes }))
    } catch {
        return "unavailable"
    }
    return null
}

// Ключ аппарата. info — state.info (log_info): board — строка полётного контроллера из MSG (плата и уникальный номер
// процессора, например «StellarH7V2 0034002E 35335104 39363630»; сохраняется и в обезличенных логах), frame — рама.
// Строка контроллера есть (непустая строка) — «fc:<строка>»: тот же аппарат узнаётся в любом логе
// [решение пользователя 25.10.2026]. Нет — запасной «log:<плата>·<рама>·<имя лога>»: такой проход найдётся только для
// того же файла, шаг 0 предлагает выбрать проход вручную. Платы на месте запасного ключа нет: в VER.FWS (fw_string) её
// нет — там «ArduCopter V4.6.3 (<git>)» [код, AP_FWVersionDefine.h], а строка контроллера и есть плата; поэтому «—».
// Рамы нет (null; до появления info.frame — undefined) — «—»
function passmem_aircraft_key(info, file_name) {
    const board = info?.board
    if ((typeof board === "string") && (board !== "")) {
        return "fc:" + board
    }
    return "log:" + ["—", info?.frame ?? "—", file_name].join("·")
}

// Значение для записи в JSON: undefined → null (JSON.stringify выбросил бы поле)
function passmem_value(value) {
    return value ?? null
}

// Оценки шага 2 из state.steps[2].metrics (step2_metrics_summary): полоса и задержка на 30 Гц (старшая из
// lag_freqs_hz) значений лога (log) и принятых (accepted); шаг не принят или без метрик — null
function passmem_estimates2(step) {
    const metrics = step?.metrics
    if (metrics == null) {
        return null
    }
    const pick = (e) => ({ band_dB: passmem_value(e?.band_dB), lag30_ms: passmem_value(e?.lag_ms?.[30]) })
    return { log: pick(metrics.log), accepted: pick(metrics.current) }
}

// Оценки шага 3 из state.steps[3].metrics (step3_metrics_summary для log и current): шум гироскопа в полосе, шум D
// по осям (оценки D нет — null) и задержка путей P и D на 30 Гц; шаг не принят или без метрик — null
function passmem_estimates3(step) {
    const metrics = step?.metrics
    if (metrics == null) {
        return null
    }
    const pick = (e) => {
        const dterm = {}
        const lag = {}
        for (const axis of Object.keys(lowpass_pid_axes)) {
            dterm[axis] = passmem_value(e?.dterm?.[axis]?.dB)
            lag[axis] = { P: passmem_value(e?.lag_ms?.[axis]?.P?.[30]), D: passmem_value(e?.lag_ms?.[axis]?.D?.[30]) }
        }
        return { gyro_band_dB: passmem_value(e?.gyro?.band_dB), dterm_dB: dterm, lag30_ms: lag }
    }
    return { log: pick(metrics.log), accepted: pick(metrics.current) }
}

// Оценки шага 4 по осям pidtune_axes из state.steps[4].axes[ось].metrics (step4_metrics_summary): надёжность
// измерения, измеренные перерегулирование и нарастание, запас фазы и частота среза лога, прогноз для принятого
// (недостоверен — null). Нет измерения или прогноза лога — null на их месте; нет метрик оси — null вместо оси;
// шаг не принят — null
function passmem_estimates4(step) {
    if (step?.axes == null) {
        return null
    }
    const estimates = {}
    for (const axis of Object.keys(pidtune_axes)) {
        const m = step.axes[axis]?.metrics
        estimates[axis] = (m == null) ? null : {
            reliable: passmem_value(m.reliable),
            measured: (m.measured == null) ? null :
                { overshoot_pct: passmem_value(m.measured.overshoot_pct), rise_s: passmem_value(m.measured.rise_s) },
            log: (m.log == null) ? null : { pm_deg: passmem_value(m.log.pm_deg), crossover_hz: passmem_value(m.log.crossover_hz) },
            prediction: (m.prediction == null) ? null : {
                overshoot_pct: passmem_value(m.prediction.overshoot_pct), rise_s: passmem_value(m.prediction.rise_s),
                pm_deg: passmem_value(m.prediction.pm_deg), unstable: passmem_value(m.prediction.unstable),
            },
        }
    }
    return estimates
}

// Проход для памяти. ctx = { key, info, file_name, rows, steps, saved_at }: key — passmem_aircraft_key; info —
// state.info; file_name — имя лога; rows — строки итога (summary_rows(…).rows); steps — state.steps; saved_at — дата
// сохранения, мс (Date.now()).
// → { key, board, frame, fw, file_name, saved_at, changed, estimates }:
// - подпись: board, frame, fw (info.fw_string) — для показа; нет — null;
// - changed — строки итога с changed: { name, log, value, step } (log null — параметра не было в логе);
// - estimates — { 2, 3, 4 } для проверки прогноза (passmem_estimates2/3/4); шаг не принят или без метрик — null.
// Все undefined — null: запись уходит в JSON
function passmem_record(ctx) {
    const info = ctx.info ?? {}
    return {
        key: ctx.key,
        board: passmem_value(info.board),
        frame: passmem_value(info.frame),
        fw: passmem_value(info.fw_string),
        file_name: passmem_value(ctx.file_name),
        saved_at: passmem_value(ctx.saved_at),
        changed: ctx.rows.filter((row) => row.changed).map((row) => ({
            name: row.name, log: passmem_value(row.log), value: passmem_value(row.value), step: row.step,
        })),
        estimates: {
            2: passmem_estimates2(ctx.steps[2]),
            3: passmem_estimates3(ctx.steps[3]),
            4: passmem_estimates4(ctx.steps[4]),
        },
    }
}

// Положить проход record в память passes → новый объект (passes не меняется): запись по record.key (проход того же
// аппарата заменяется). Аппаратов больше PASSMEM_MAX — удаляются проходы с самой старой датой сохранения (saved_at),
// кроме добавляемого: его только что сохранили, даже если часы компьютера сбиты [наше]
function passmem_put(passes, record) {
    const next = { ...passes, [record.key]: record }
    let keys = Object.keys(next)
    while (keys.length > PASSMEM_MAX) {
        let oldest = null
        for (const key of keys) {
            if ((key !== record.key) && ((oldest == null) || ((next[key].saved_at ?? 0) < (next[oldest].saved_at ?? 0)))) {
                oldest = key
            }
        }
        delete next[oldest]
        keys = Object.keys(next)
    }
    return next
}

// Забыть проход аппарата key → новый объект без него (passes не меняется)
function passmem_forget(passes, key) {
    const next = { ...passes }
    delete next[key]
    return next
}

// Проходы списком по убыванию даты сохранения — для выбора вручную, когда в логе нет строки контроллера
function passmem_list(passes) {
    return Object.values(passes).sort((a, b) => (b.saved_at ?? 0) - (a.saved_at ?? 0))
}

// Что из предложенного в проходе pass стоит в новом логе. params — параметры лога (get, has), bits — размер маски
// HMNCS нового лога (hmncs_bits).
// → { rows, applied, total, same_log }:
// - rows — по изменённым прохода: { name, step, proposed, now, status }; now — значение в логе или null; status —
//   "applied" (равно предложенному, summary_same: как float32, маски — целые, HMNCS без знака), "absent" (нет в логе),
//   "other" (другое значение);
// - applied — число "applied", total — число строк;
// - same_log — все значения лога равны «было» прохода (summary_same; нет в логе и не было — тоже равны) и изменения в
//   проходе есть: похоже на лог прошлого прохода, значения ещё не применялись. Имя файла страница сравнивает сама
function passmem_applied(pass, params, bits) {
    const rows = pass.changed.map((change) => {
        const now = params.has(change.name) ? params.get(change.name) : null
        let status = "other"
        if (summary_same(change.name, now, change.value, bits)) {
            status = "applied"
        } else if (now == null) {
            status = "absent"
        }
        return { name: change.name, step: change.step, proposed: change.value, now: now, status: status }
    })
    const same_log = (rows.length > 0) && pass.changed.every((change, i) => summary_same(change.name, rows[i].now, change.log, bits))
    return {
        rows: rows,
        applied: rows.filter((row) => row.status === "applied").length,
        total: rows.length,
        same_log: same_log,
    }
}

// Статус набора строк passmem_applied: "none" — строк нет, "applied" — все применены, "partial" — не все
function passmem_rows_status(rows) {
    if (rows.length === 0) {
        return "none"
    }
    return rows.every((row) => row.status === "applied") ? "applied" : "partial"
}

// Применён ли шаг n прошлого прохода: "none" — шаг в проходе ничего не менял, "partial" — применены не все его
// изменённые параметры (другое значение или нет в логе), "applied" — все. applied — passmem_applied(pass, …);
// строки applied идут по pass.changed, шаг строки — шаг прохода, который дал значение
function passmem_step_status(pass, applied, n) {
    return passmem_rows_status(applied.rows.filter((row) => row.step === n))
}

// Строка сравнения шага n (2–4) с прошлым проходом: «было X → прогноз Y → в этом логе Z»
// [решение пользователя 25.10.2026]. pass — проход аппарата (null — прохода нет), applied — passmem_applied(pass, …),
// now — оценка нового лога для варианта «Как в логе» (та же форма, что у estimates[n].log; шаг 4 — { reliable,
// measured, log } оси по step4_metrics_summary), axis — ось шага 4 (roll | pitch | yaw).
// → null — строки нет: прохода нет, шаг (на шаге 4 — ось) в проходе ничего не менял, оценок шага нет (принят без
//   метрик), на шаге 4 — нет записи оси;
// → { status: "partial" } — применены не все изменённые параметры шага: сравнивать нечего;
// → { status: "unreliable" } — шаг 4: измерение оси ненадёжно в проходе (reliable не true) или сейчас
//   (now.reliable === false): сравнивать нечем;
// → { status: "ok", was, predicted, now } — was — оценка лога прошлого прохода (estimates[n].log; шаг 4 — { measured,
//   log } оси), predicted — прогноз для принятого (estimates[n].accepted; шаг 4 — prediction оси, недостоверен —
//   null), now — как передано.
// На шаге 4 «применено» — по изменённым параметрам шага 4 этой оси (префикс pidtune_axes[ось].rate): ось
// сравнивается, даже если другую ось не применили [наше]
function passmem_compare(pass, applied, n, now, axis) {
    if ((pass == null) || (applied == null)) {
        return null
    }
    const estimates = pass.estimates?.[n] ?? null
    if (estimates == null) {
        return null
    }
    let rows = applied.rows.filter((row) => row.step === n)
    if (n === 4) {
        const record = estimates[axis] ?? null
        if (record == null) {
            return null
        }
        rows = rows.filter((row) => row.name.startsWith(pidtune_axes[axis].rate))
        const status = passmem_rows_status(rows)
        if (status !== "applied") {
            return (status === "none") ? null : { status: "partial" }
        }
        if ((record.reliable !== true) || (now?.reliable === false)) {
            return { status: "unreliable" }
        }
        return { status: "ok", was: { measured: record.measured, log: record.log }, predicted: record.prediction, now: now }
    }
    const status = passmem_rows_status(rows)
    if (status !== "applied") {
        return (status === "none") ? null : { status: "partial" }
    }
    return { status: "ok", was: estimates.log, predicted: estimates.accepted, now: now }
}
