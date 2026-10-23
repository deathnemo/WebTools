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

// Ряд «газ» 0–1 для окна полёта: CTUN.ThO (выход газа), иначе RATE.AOut
function throttle_series(log) {
    if ("CTUN" in log.messageTypes) {
        return { time: us_to_s(log.get("CTUN", "TimeUS")), throttle: Array.from(log.get("CTUN", "ThO")), source: "CTUN.ThO" }
    }
    if ("RATE" in log.messageTypes) {
        return { time: us_to_s(log.get("RATE", "TimeUS")), throttle: Array.from(log.get("RATE", "AOut")), source: "RATE.AOut" }
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
    const sorted = Array.from(values).sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
}

// Сводка VIBE по экземплярам IMU: p95 и максимум по осям, число событий clipping.
// Clip в логе — счётчик нарастающим итогом, поэтому берём максимум.
function vibe_summary(log) {
    if (!("VIBE" in log.messageTypes)) {
        return null
    }
    const VIBE = log.get("VIBE")
    const by_imu = {}
    for (let i = 0; i < VIBE.TimeUS.length; i++) {
        const s = by_imu[VIBE.IMU[i]] ??= { x: [], y: [], z: [], max: -Infinity, clip: 0 }
        s.x.push(VIBE.VibeX[i])
        s.y.push(VIBE.VibeY[i])
        s.z.push(VIBE.VibeZ[i])
        // Максимум считаем на ходу: разворачивать длинные ряды в аргументы Math.max нельзя (переполнение стека)
        s.max = Math.max(s.max, VIBE.VibeX[i], VIBE.VibeY[i], VIBE.VibeZ[i])
        s.clip = Math.max(s.clip, VIBE.Clip[i])
    }
    const imus = Object.entries(by_imu).map(([imu, s]) => {
        const p95 = { x: percentile(s.x, 0.95), y: percentile(s.y, 0.95), z: percentile(s.z, 0.95) }
        return {
            imu: Number(imu),
            p95,
            level: Math.max(p95.x, p95.y, p95.z),
            max: s.max,
            clip: s.clip,
        }
    })
    return {
        imus,
        level: Math.max(...imus.map((s) => s.level)),
        max: Math.max(...imus.map((s) => s.max)),
        clip: imus.reduce((sum, s) => sum + s.clip, 0),
    }
}

// Сводная информация о логе. version — результат get_version_and_board(log) из Libraries/LogHelpers.js
function log_info(log, version) {
    const messages = log_messages(log)

    // Длительность по первому подходящему сообщению с TimeUS
    let duration_s = null
    for (const name of ["ATT", "RATE", "CTUN", "IMU"]) {
        if (name in log.messageTypes) {
            const t = log.get(name, "TimeUS")
            if (t.length > 1) {
                duration_s = (t[t.length - 1] - t[0]) * US2S
                break
            }
        }
    }

    const throttle = throttle_series(log)
    const window = throttle ? throttle_window(throttle.time, throttle.throttle) : null

    return {
        vehicle: BUILD_NAMES[version.build_type] ?? null,
        build_type: version.build_type ?? null,
        fw_string: version.fw_string ?? null,
        board: version.flight_controller ?? null,
        filter_version: version.filter_version ?? null,
        duration_s,
        messages,
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
    module.exports = { US2S, us_to_s, log_params, log_messages, throttle_series, throttle_window, mean_throttle, percentile, vibe_summary, log_info }
}
