// Память прохода мастера: что принято в прошлый раз на этом аппарате — изменённые параметры и оценки для проверки
// прогноза. На следующем логе шаг 0 показывает, что из предложенного стоит в логе («применено»), шаги 2–4 — «было →
// прогноз → в этом логе». Без DOM: работает в браузере и под Node (тесты). Дизайн —
// docs/plans/2026-10-25-tune-wizard-stage5-design.md, раздел 4.
// Источники: [решение пользователя 25.10.2026]; [наше] — решение мастера; [код] — исходники ArduPilot и шагов мастера.
//
// Хранилище ядро получает аргументом (storage — объект с getItem, setItem, removeItem, как localStorage, или null):
// в браузере его даёт страница, в тестах — объект над словарём. Сам localStorage ядро не трогает.
//
// Версии формата: формат записи в хранилище меняется только вместе с новой PASSMEM_VERSION. Память чужой версии
// (в том числе более новой) читается как "version" и не используется; перевода между версиями нет. При чтении её
// не затирают: заменяет её только явное сохранение прохода на шаге 5 («Запомнить проход», «Скачать .param») — иначе
// первая же загрузка лога в старой версии мастера уничтожала бы память новой [наше].
// Поле bits записи (размер маски HMNCS при сохранении) добавлено без смены версии: записи без него читаются как
// прежде (passmem_applied).
//
// Нужны глобалы страницы: core/summary.js (summary_same; ему — core/params.js и Libraries/Param_Helpers.js),
// core/filters.js (notch_param_names), core/lowpass.js (lowpass_pid_axes), core/pidtune.js (pidtune_axes).

// Ключ в хранилище: { version: PASSMEM_VERSION, passes: { <ключ аппарата>: проход } }. Память по аппаратам, без
// переноса между браузерами [решение пользователя 25.10.2026]; не больше PASSMEM_MAX аппаратов [наше]
const PASSMEM_KEY = "tunewizard_v1"
const PASSMEM_VERSION = 1
const PASSMEM_MAX = 20

// Объект (не null и не массив)
function passmem_is_object(value) {
    return (value != null) && (typeof value === "object") && !Array.isArray(value)
}

// Годна ли запись прохода record, лежащая в карте под ключом key, для функций памяти: объект; key — строка, равная
// ключу в карте (иначе «Забыть» по pass.key промахнётся); changed — массив объектов со строковым name и числовым step;
// saved_at — число или нет (null — тоже нет: так его пишет passmem_record без даты); estimates — объект или нет, его
// оценки шагов 2–4 — объекты или null (нет). Остальные поля функции памяти читают осторожно (?., null)
function passmem_valid(key, record) {
    return passmem_is_object(record) &&
        (record.key === key) &&
        Array.isArray(record.changed) &&
        record.changed.every((change) => passmem_is_object(change) && (typeof change.name === "string") &&
                                         (typeof change.step === "number")) &&
        ((record.saved_at == null) || (typeof record.saved_at === "number")) &&
        ((record.estimates == null) ||
         (passmem_is_object(record.estimates) &&
          [2, 3, 4].every((n) => (record.estimates[n] == null) || passmem_is_object(record.estimates[n]))))
}

// Проходы из хранилища → { passes, error, dropped }:
// - error null — прочитано (ключа нет — пусто); dropped true — при этом отброшены битые записи (passmem_valid;
//   passes — остальные): страница перезаписывает память без битых, иначе битая запись роняла бы загрузку любого
//   лога [наше];
// - "unavailable" — хранилища нет или оно бросает (приватный режим, запрет хранилища): страница пишет, что браузер не
//   даёт сохранить память;
// - "version" — память другой версии формата (version — число, не PASSMEM_VERSION): passes {}, не используется и при
//   чтении не затирается — её заменит только явное сохранение прохода;
// - "corrupt" — JSON не разбирается, не объект, version не число или passes не объект: passes {}, тоже не
//   используется и не затирается (испорченное руками пусть чинят руками; затирает только сохранение) [наше]
function passmem_read(storage) {
    const result = (passes, error, dropped = false) => ({ passes: passes, error: error, dropped: dropped })
    if (storage == null) {
        return result({}, "unavailable")
    }
    let text
    try {
        text = storage.getItem(PASSMEM_KEY)
    } catch {
        return result({}, "unavailable")
    }
    if (text == null) {
        return result({}, null)
    }
    let data
    try {
        data = JSON.parse(text)
    } catch {
        return result({}, "corrupt")
    }
    if (!passmem_is_object(data) || (typeof data.version !== "number")) {
        return result({}, "corrupt")
    }
    if (data.version !== PASSMEM_VERSION) {
        return result({}, "version")
    }
    if (!passmem_is_object(data.passes)) {
        return result({}, "corrupt")
    }
    const passes = {}
    let dropped = false
    for (const [key, record] of Object.entries(data.passes)) {
        if (passmem_valid(key, record)) {
            passes[key] = record
        } else {
            dropped = true
        }
    }
    return result(passes, null, dropped)
}

// Записать проходы passes (ключ аппарата → проход) в хранилище как { version, passes } → null или "unavailable"
// (хранилища нет; setItem бросает — приватный режим, квота). Ошибка сериализации — ошибка программы, а не хранилища:
// она бросает
function passmem_write(storage, passes) {
    if (storage == null) {
        return "unavailable"
    }
    const text = JSON.stringify({ version: PASSMEM_VERSION, passes: passes })
    try {
        storage.setItem(PASSMEM_KEY, text)
    } catch {
        return "unavailable"
    }
    return null
}

// Ключ аппарата. info — state.info (log_info): board — строка полётного контроллера из MSG (плата и уникальный номер
// процессора, например «StellarH7V2 0034002E 35335104 39363630»; сохраняется и в обезличенных логах), board_id — номер
// платы APJ из VER, frame — рама.
// Строка контроллера есть (непустая строка) — «fc:<строка>»: тот же аппарат узнаётся в любом логе
// [решение пользователя 25.10.2026]. Нет — запасной «log:<номер платы>·<рама>·<имя лога>»: такой проход найдётся только
// для того же файла, шаг 0 предлагает выбрать проход вручную. Плата — номер APJ, а не из VER.FWS (fw_string): там её
// нет, только «ArduCopter V4.6.3 (<git>)» [код, AP_FWVersionDefine.h]. Нет значения (в том числе поля в info) — «—»
function passmem_aircraft_key(info, file_name) {
    const board = info?.board
    if ((typeof board === "string") && (board !== "")) {
        return "fc:" + board
    }
    return "log:" + [info?.board_id ?? "—", info?.frame ?? "—", file_name ?? "—"].join("·")
}

// Значение для записи в JSON: undefined → null (JSON.stringify выбросил бы поле)
function passmem_value(value) {
    return value ?? null
}

// Число для оценок: не конечное (NaN, ±Infinity, не число, нет) — null. В JSON NaN и бесконечность и так стали бы
// null: память и хранилище не должны расходиться
function passmem_number(value) {
    return Number.isFinite(value) ? value : null
}

// Одна оценка шага 2 в форме памяти: полоса и задержка на 30 Гц (старшая из lag_freqs_hz, lowpass_lag_hz).
// e — оценка с полями band_dB и lag_ms (сводка step2_metrics_summary current или log, evaluate_candidate шага 2).
// → { band_dB, lag30_ms }; нет числа (в том числе нет e) — null на его месте. Этой же формой страница передаёт
// оценку нового лога в passmem_compare (строка сравнения шага 2)
function passmem_estimate2(e) {
    return { band_dB: passmem_number(e?.band_dB), lag30_ms: passmem_number(e?.lag_ms?.[30]) }
}

// Одна оценка шага 3 в форме памяти: шум гироскопа в полосе, шум D по осям lowpass_pid_axes (оценки D нет — null)
// и задержка путей P и D на 30 Гц. e — сводка step3_metrics_summary (или evaluate_lowpass: поля те же).
// → { gyro_band_dB, dterm_dB: { roll, pitch }, lag30_ms: { roll: { P, D }, pitch: { P, D } } }; нет числа — null.
// Этой же формой страница передаёт оценку нового лога в passmem_compare (строка сравнения шага 3)
function passmem_estimate3(e) {
    const dterm = {}
    const lag = {}
    for (const axis of Object.keys(lowpass_pid_axes)) {
        dterm[axis] = passmem_number(e?.dterm?.[axis]?.dB)
        lag[axis] = { P: passmem_number(e?.lag_ms?.[axis]?.P?.[30]), D: passmem_number(e?.lag_ms?.[axis]?.D?.[30]) }
    }
    return { gyro_band_dB: passmem_number(e?.gyro?.band_dB), dterm_dB: dterm, lag30_ms: lag }
}

// Одна ось шага 4 в форме памяти. m — сводка оси step4_metrics_summary: надёжность измерения, измеренные
// перерегулирование и нарастание, запас фазы и частота среза лога, прогноз для строки (недостоверен — null).
// → { reliable, measured, log, prediction }; нет измерения, прогноза лога или прогноза строки — null на их месте;
// m нет — null. Этой же формой (prediction — null: сводка без строки, passmem_compare его не читает) страница передаёт
// ось нового лога в passmem_compare (строка сравнения шага 4)
function passmem_estimate4_axis(m) {
    if (m == null) {
        return null
    }
    return {
        reliable: passmem_value(m.reliable),
        measured: (m.measured == null) ? null :
            { overshoot_pct: passmem_number(m.measured.overshoot_pct), rise_s: passmem_number(m.measured.rise_s) },
        log: (m.log == null) ? null : { pm_deg: passmem_number(m.log.pm_deg), crossover_hz: passmem_number(m.log.crossover_hz) },
        prediction: (m.prediction == null) ? null : {
            overshoot_pct: passmem_number(m.prediction.overshoot_pct), rise_s: passmem_number(m.prediction.rise_s),
            pm_deg: passmem_number(m.prediction.pm_deg), unstable: passmem_value(m.prediction.unstable),
        },
    }
}

// Оценки шага 2 из state.steps[2].metrics (step2_metrics_summary): значения лога (log) и принятых (accepted) —
// passmem_estimate2; шаг не принят или без метрик — null
function passmem_estimates2(step) {
    const metrics = step?.metrics
    if (metrics == null) {
        return null
    }
    return { log: passmem_estimate2(metrics.log), accepted: passmem_estimate2(metrics.current) }
}

// Оценки шага 3 из state.steps[3].metrics (step3_metrics_summary для log и current) — passmem_estimate3; шаг не
// принят или без метрик — null
function passmem_estimates3(step) {
    const metrics = step?.metrics
    if (metrics == null) {
        return null
    }
    return { log: passmem_estimate3(metrics.log), accepted: passmem_estimate3(metrics.current) }
}

// Оценки шага 4 по осям pidtune_axes из state.steps[4].axes[ось].metrics (step4_metrics_summary) —
// passmem_estimate4_axis; нет метрик оси — null вместо оси; шаг не принят — null
function passmem_estimates4(step) {
    if (step?.axes == null) {
        return null
    }
    const estimates = {}
    for (const axis of Object.keys(pidtune_axes)) {
        estimates[axis] = passmem_estimate4_axis(step.axes[axis]?.metrics)
    }
    return estimates
}

// Проход для памяти. ctx = { key, info, file_name, rows, steps, saved_at, stale, conflicts, bits }: key —
// passmem_aircraft_key; info — state.info; file_name — имя лога; rows и conflicts — строки итога и расхождения
// (summary_rows(…).rows и .conflicts; conflicts нет — расхождений нет); steps — state.steps; saved_at — дата
// сохранения, мс (Date.now()); stale — { 2, 3, 4 }: устарело ли принятое шага (step_accepted_stale; нет — не
// устарело); bits — размер маски HMNCS лога (hmncs_bits), с которым считались строки итога.
// → { key, board, frame, fw, file_name, saved_at, bits, changed, estimates }:
// - подпись: board, frame, fw (info.fw_string) — для показа; нет — null;
// - bits — размер маски HMNCS при сохранении (нет — null): «применено» на логе с другим размером (смена версии
//   фильтра 2 → 3) сравнивает маски по большему из размеров (passmem_applied);
// - changed — строки итога с changed: { name, log, value, step } (log null — параметра не было в логе); изменений
//   нет — []: такой проход закрывает прошлый (страница его не показывает — memory_has_changes);
// - estimates — { 2, 3, 4 } для проверки прогноза (passmem_estimates2/3/4); null — шаг не принят, без метрик или его
//   оценки не для применяемой конфигурации: шаг устарел, или его значение какого-то имени перекрыто другим шагом
//   (в conflicts есть значение шага n, а used — другой шаг: расхождение INS_GYRO_FILTER) [наше].
// Все undefined — null, числа оценок — конечные или null: запись уходит в JSON
function passmem_record(ctx) {
    const info = ctx.info ?? {}
    const conflicts = ctx.conflicts ?? []
    const valid = (n) => !ctx.stale?.[n] && !conflicts.some((conflict) => (n in conflict.values) && (conflict.used !== n))
    return {
        key: ctx.key,
        board: passmem_value(info.board),
        frame: passmem_value(info.frame),
        fw: passmem_value(info.fw_string),
        file_name: passmem_value(ctx.file_name),
        saved_at: passmem_value(ctx.saved_at),
        bits: passmem_number(ctx.bits),
        changed: ctx.rows.filter((row) => row.changed).map((row) => ({
            name: row.name, log: passmem_value(row.log), value: passmem_value(row.value), step: row.step,
        })),
        estimates: {
            2: valid(2) ? passmem_estimates2(ctx.steps[2]) : null,
            3: valid(3) ? passmem_estimates3(ctx.steps[3]) : null,
            4: valid(4) ? passmem_estimates4(ctx.steps[4]) : null,
        },
    }
}

// Положить проход record в память passes → новый объект (passes не меняется): запись по record.key (проход того же
// аппарата заменяется). Аппаратов больше PASSMEM_MAX — удаляются проходы с самой старой датой сохранения (saved_at;
// нет даты — самые старые), кроме добавляемого: его только что сохранили, даже если часы компьютера сбиты [наше]
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
// HMNCS нового лога (hmncs_bits). Маски HMNCS сравниваются по большему из размеров — записи (pass.bits) и лога:
// после смены версии фильтра 2 → 3 маска стала 32-битной, и 8-битная −128 прохода и −128 нового лога — уже не одна
// гармоника 8 (mask_unsigned при 32 битах значение не трогает); запись без bits (старый формат) — по размеру лога,
// как раньше [наше].
// → { rows, applied, total, same_log }:
// - rows — по изменённым прохода: { name, step, proposed, now, status }; now — значение в логе или null; status —
//   "applied" (равно предложенному, summary_same: как float32, маски — целые, HMNCS без знака), "absent" (нет в логе),
//   "other" (другое значение);
// - applied — число "applied", total — число строк;
// - same_log — все значения лога равны «было» прохода (summary_same; нет в логе и не было — тоже равны) и изменения в
//   проходе есть: похоже на лог прошлого прохода, значения ещё не применялись. Имя файла страница сравнивает сама
function passmem_applied(pass, params, bits) {
    const mask_bits = Math.max(Number.isFinite(pass.bits) ? pass.bits : bits, bits)
    const rows = pass.changed.map((change) => {
        const now = params.has(change.name) ? params.get(change.name) : null
        let status = "other"
        if (summary_same(change.name, now, change.value, mask_bits)) {
            status = "applied"
        } else if (now == null) {
            status = "absent"
        }
        return { name: change.name, step: change.step, proposed: change.value, now: now, status: status }
    })
    const same_log = (rows.length > 0) && pass.changed.every((change, i) => summary_same(change.name, rows[i].now, change.log, mask_bits))
    return {
        rows: rows,
        applied: rows.filter((row) => row.status === "applied").length,
        total: rows.length,
        same_log: same_log,
    }
}

// Имена из принятого на шагах 2–3, от которых зависит прогноз шага 4: поля обоих notch и INS_GYRO_FILTER — поправка
// фильтров гироскопа, FLTE и FLTD осей — регуляторы вариантов [код, step4_gyro_new и step4_new_filters]. То же, что
// в ключе расчёта шага 4 (step4_calc_key) и в depends[4] контекста итога (step_depends4_names в steps/common.js —
// ядро его не зовёт, список повторён здесь). SCHED_LOOP_RATE, FLTT, INS_ACCEL_FILTER и пределы ускорения прогноз
// шага 4 не меняют: модель регулятора считается на частоте контура лога
function passmem_depends4_names() {
    return [
        ...notch_param_names().flatMap((notch) => Object.values(notch)),
        "INS_GYRO_FILTER",
        ...Object.values(pidtune_axes).flatMap((axis) => [axis.rate + "FLTE", axis.rate + "FLTD"]),
    ]
}

// Применены ли параметры, от которых зависит прогноз шага n (2–4) прошлого прохода. applied — passmem_applied(pass, …);
// шаг строки — шаг прохода, который дал значение. axis — ось шага 4 (roll | pitch | yaw); не передана — весь шаг 4.
// Прогноз шага 3 считался от notch шага 2, шага 4 — от notch шага 2 и фильтров шага 3 [код, шаги мастера], поэтому
// учитываются изменённые строки шагов 2..n; у шага 4 из строк шагов 2–3 — только имена, от которых его прогноз
// зависит (passmem_depends4_names): неприменённый FLTT, INS_ACCEL_FILTER, предел ускорения или SCHED_LOOP_RATE
// прогноз шага 4 не трогают и строку сравнения не отменяют [наше]. На шаге 4 с осью строки с префиксом другой оси
// (pidtune_axes[a].rate, a ≠ axis) не учитываются ни у шага 4, ни у шагов 2–3 (ATC_RAT_PIT_FLTD, ATC_RAT_YAW_FLTE для
// крена): другая ось на неё не влияет [наше]. Строки без префикса оси (notch, INS_GYRO_FILTER) учитываются.
// → "none" — шаг n (на шаге 4 с осью — эта ось) в проходе ничего не менял: строки сравнения нет; "partial" — параметры
//   шагов 2..n применены не все (другое значение или нет в логе); "applied" — все
function passmem_step_status(applied, n, axis) {
    // Префиксы других осей: только на шаге 4 с осью
    const others = ((n === 4) && (axis != null)) ?
        Object.keys(pidtune_axes).filter((a) => a !== axis).map((a) => pidtune_axes[a].rate) : []
    const depends = (n === 4) ? passmem_depends4_names() : null
    const rows = applied.rows.filter((row) => (row.step <= n) &&
        ((depends == null) || (row.step === n) || depends.includes(row.name)) &&
        !others.some((prefix) => row.name.startsWith(prefix)))
    if (!rows.some((row) => row.step === n)) {
        return "none"
    }
    return rows.every((row) => row.status === "applied") ? "applied" : "partial"
}

// Строка сравнения шага n (2–4) с прошлым проходом: «было X → прогноз Y → в этом логе Z»
// [решение пользователя 25.10.2026]. pass — проход аппарата (null — прохода нет), applied — passmem_applied(pass, …),
// now — оценка нового лога для варианта «Как в логе» (та же форма, что у estimates[n].log; шаг 4 — { reliable,
// measured, log } оси по step4_metrics_summary), axis — ось шага 4 (roll | pitch | yaw).
// → null — строки нет: прохода нет; оценок шага нет (не принят, без метрик, устарел или перекрыт — passmem_record);
//   на шаге 4 — нет записи оси (или ось не передана); шаг (на шаге 4 — ось) в проходе ничего не менял;
// → { status: "partial" } — параметры шагов 2..n применены не все (passmem_step_status): сравнивать нечего;
// → { status: "unreliable" } — шаг 4: измерение оси ненадёжно в проходе или сейчас (reliable не true; now null —
//   надёжность неизвестна): сравнивать нечем;
// → { status: "ok", was, predicted, now } — was — оценка лога прошлого прохода (estimates[n].log; шаг 4 — { measured,
//   log } оси), predicted — прогноз для принятого (estimates[n].accepted; шаг 4 — prediction оси, недостоверен —
//   null), now — как передано
function passmem_compare(pass, applied, n, now, axis) {
    if ((pass == null) || (applied == null)) {
        return null
    }
    // Оценки для сравнения: шага, на шаге 4 — оси
    const estimates = pass.estimates?.[n] ?? null
    const record = (n === 4) ? (estimates?.[axis] ?? null) : estimates
    if (record == null) {
        return null
    }

    const status = passmem_step_status(applied, n, axis)
    if (status === "none") {
        return null
    }
    if (status === "partial") {
        return { status: "partial" }
    }
    if (n === 4) {
        if ((record.reliable !== true) || (now?.reliable !== true)) {
            return { status: "unreliable" }
        }
        return { status: "ok", was: { measured: record.measured ?? null, log: record.log ?? null },
                 predicted: record.prediction ?? null, now: now }
    }
    return { status: "ok", was: record.log ?? null, predicted: record.accepted ?? null, now: now }
}
