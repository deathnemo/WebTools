// Сведения о логе и доступ к параметрам. Без DOM: работает в браузере и под Node (тесты).
// Лог — объект парсера JsDataflashParser: messageTypes, get(name, field), get_instance(name, instance, field).

// Микросекунды лога → секунды. Объявлено только здесь: другие скрипты страницы используют этот глобал.
const US2S = 1 / 1000000

// Типы сборки из VER.BU (как в Libraries/LogHelpers.js)
const BUILD_NAMES = { 1: "Rover", 2: "Copter", 3: "Plane", 4: "AntennaTracker", 7: "Sub", 12: "Blimp" }

function us_to_s(TimeUS) {
    return Array.from(TimeUS, (t) => t * US2S)
}

// Доступ к параметрам из сообщений PARM: последнее значение и история изменений
function log_params(log) {
    const history = {}
    if ("PARM" in log.messageTypes) {
        const PARM = log.get("PARM")
        for (let i = 0; i < PARM.Name.length; i++) {
            const name = PARM.Name[i]
            const value = PARM.Value[i]
            const list = history[name] ??= []
            // Повторная запись того же значения — не изменение
            if ((list.length == 0) || (list[list.length - 1].value != value)) {
                list.push({ time: PARM.TimeUS[i] * US2S, value })
            }
        }
    }
    return {
        has: (name) => name in history,
        get: (name) => (name in history) ? history[name][history[name].length - 1].value : null,
        history: (name) => history[name] ?? [],
        changed: (name) => (history[name]?.length ?? 0) > 1,
    }
}

// Какие сообщения есть в логе
function log_messages(log) {
    const has = (name) => name in log.messageTypes
    return {
        pid: has("PIDR") && has("PIDP") && has("PIDY"),
        rate: has("RATE"),
        gyro_raw: has("GYR"),
        gyro_batch: has("ISBH") && has("ISBD"),
        esc: has("ESC"),
        rpm: has("RPM"),
        vibe: has("VIBE"),
        ctun: has("CTUN"),
        att: has("ATT"),
        pos: has("POS"),
        ftn: has("FTN1"),
    }
}

// Частота сообщения name (без экземпляров), Гц — по среднему интервалу TimeUS без пропусков: интервалы длиннее 5 медиан
// (на земле лог может не писаться; порог — как у разрыва пакетов PIDReview) не учитываются, дрожание меток усредняется.
// null, если сообщения нет или в нём меньше двух отсчётов
function log_message_rate(log, name) {
    if (!(name in log.messageTypes)) {
        return null
    }
    const t = log.get(name, "TimeUS")
    if ((t == null) || (t.length < 2)) {
        return null
    }
    const dt = new Float64Array(t.length - 1)
    for (let i = 1; i < t.length; i++) {
        dt[i - 1] = t[i] - t[i - 1]
    }
    const sorted = dt.slice().sort()
    const mid = sorted.length >> 1
    const median = (sorted.length % 2) ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
    if (!(median > 0)) {
        return null
    }
    let sum = 0
    let count = 0
    for (const d of dt) {
        if (d <= 5 * median) {
            sum += d
            count++
        }
    }
    // TimeUS — микросекунды
    return 1e6 / (sum / count)
}

// Ряд «газ» 0–1 для окна полёта: CTUN.ThO (выход газа), иначе RATE.AOut
function throttle_series(log) {
    if ("CTUN" in log.messageTypes) {
        const ThO = log.get("CTUN", "ThO")
        if (ThO != null) {
            return { time: us_to_s(log.get("CTUN", "TimeUS")), throttle: Array.from(ThO), source: "CTUN.ThO" }
        }
    }
    if ("RATE" in log.messageTypes) {
        const AOut = log.get("RATE", "AOut")
        if (AOut != null) {
            return { time: us_to_s(log.get("RATE", "TimeUS")), throttle: Array.from(AOut), source: "RATE.AOut" }
        }
    }
    return null
}

// Окно полёта: от первого до последнего ненулевого газа, с отступом margin секунд внутрь,
// чтобы отрезать набор и сброс газа (как в FilterReview)
function throttle_window(time, throttle, margin = 1) {
    let first = -1
    let last = -1
    for (let i = 0; i < throttle.length; i++) {
        if (throttle[i] > 0) {
            if (first < 0) {
                first = i
            }
            last = i
        }
    }
    if (first < 0) {
        return null
    }
    const start = Math.ceil(time[first]) + margin
    const end = Math.floor(time[last]) - margin
    if (end <= start) {
        return null
    }
    return { start, end }
}

// Средний ненулевой газ внутри окна
function mean_throttle(time, throttle, window) {
    let sum = 0
    let count = 0
    for (let i = 0; i < throttle.length; i++) {
        if ((time[i] < window.start) || (time[i] > window.end) || !(throttle[i] > 0)) {
            continue
        }
        sum += throttle[i]
        count++
    }
    return (count > 0) ? sum / count : null
}

// Процентиль по ближайшему рангу
function percentile(values, fraction) {
    if (values.length == 0) {
        return null
    }
    const sorted = Float64Array.from(values).sort()
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
}

// Максимум массива циклом: разворачивать длинные ряды в аргументы Math.max нельзя (переполнение стека)
function max_of(values) {
    let max = -Infinity
    for (let i = 0; i < values.length; i++) {
        if (values[i] > max) {
            max = values[i]
        }
    }
    return max
}

// Сводка VIBE по экземплярам IMU: p95 и максимум по осям, число событий clipping.
// VIBE пишется по экземплярам, и парсер отдаёт такие сообщения только через get_instance.
// Clip в логе — счётчик нарастающим итогом, поэтому берём максимум.
function vibe_summary(log) {
    if (!("VIBE" in log.messageTypes)) {
        return null
    }
    // Старый лог без экземпляров читается как один IMU через get_instance(name, null, field)
    const instances = log.messageTypes.VIBE.instances
    const keys = instances ? Object.keys(instances) : [null]
    const imus = []
    for (const key of keys) {
        const x = log.get_instance("VIBE", key, "VibeX")
        if ((x == null) || (x.length == 0)) {
            continue
        }
        const y = log.get_instance("VIBE", key, "VibeY")
        const z = log.get_instance("VIBE", key, "VibeZ")
        // Clip — счётчик нарастающим итогом (с 4.1); в старых логах три счётчика Clip0..Clip2
        const clip = log.get_instance("VIBE", key, "Clip")
        let clip_count = 0
        if (clip != null) {
            clip_count = max_of(clip)
        } else {
            for (const name of ["Clip0", "Clip1", "Clip2"]) {
                const old = log.get_instance("VIBE", key, name)
                if (old != null) {
                    clip_count += max_of(old)
                }
            }
        }
        const p95 = { x: percentile(x, 0.95), y: percentile(y, 0.95), z: percentile(z, 0.95) }
        imus.push({
            imu: (key == null) ? 0 : Number(key),
            p95,
            level: Math.max(p95.x, p95.y, p95.z),
            max: Math.max(max_of(x), max_of(y), max_of(z)),
            clip: clip_count,
        })
    }
    if (imus.length == 0) {
        return null
    }
    return {
        imus,
        level: Math.max(...imus.map((s) => s.level)),
        max: Math.max(...imus.map((s) => s.max)),
        clip: imus.reduce((sum, s) => sum + s.clip, 0),
    }
}

// Сводная информация о логе. version — результат get_version_and_board(log) из Libraries/LogHelpers.js
function log_info(log, version = {}) {
    const messages = log_messages(log)

    // Границы и длительность по первому подходящему сообщению с TimeUS (без экземпляров: такие читаются через get).
    // time_start/time_end — абсолютные секунды лога, по ним страница задаёт границы графиков
    let time_start = null
    let time_end = null
    let duration_s = null
    for (const name of ["ATT", "RATE", "CTUN"]) {
        if (name in log.messageTypes) {
            // Сообщение может быть объявлено без единой строки: поля нет, get возвращает undefined
            const t = log.get(name, "TimeUS")
            if ((t != null) && (t.length > 1)) {
                time_start = t[0] * US2S
                time_end = t[t.length - 1] * US2S
                duration_s = (t[t.length - 1] - t[0]) * US2S
                break
            }
        }
    }

    const throttle = throttle_series(log)
    const window = throttle ? throttle_window(throttle.time, throttle.throttle) : null

    // Частота лога PID: PIDR, без него — RATE (проверка pid_log: ниже 100 Гц отклик шага 4 не считается)
    let pid_log_rate = null
    for (const name of ["PIDR", "RATE"]) {
        const hz = log_message_rate(log, name)
        if (hz != null) {
            pid_log_rate = { message: name, hz }
            break
        }
    }

    return {
        vehicle: BUILD_NAMES[version.build_type] ?? null,
        build_type: version.build_type ?? null,
        fw_string: version.fw_string ?? null,
        board: version.flight_controller ?? null,
        filter_version: version.filter_version ?? null,
        time_start,
        time_end,
        duration_s,
        messages,
        pid_log_rate,
        throttle_source: throttle?.source ?? null,
        flight: window ? {
            start: window.start,
            end: window.end,
            duration_s: window.end - window.start,
            mean_throttle: mean_throttle(throttle.time, throttle.throttle, window),
        } : null,
    }
}

if (typeof module !== "undefined") {
    module.exports = { US2S, us_to_s, log_params, log_messages, log_message_rate, throttle_series, throttle_window, mean_throttle, percentile, vibe_summary, log_info }
}
