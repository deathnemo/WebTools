// Сведения о логе и доступ к параметрам. Без DOM: работает в браузере и под Node (тесты).
// Лог — объект парсера JsDataflashParser: messageTypes, get(name, field), get_instance(name, instance, field).

// Микросекунды лога → секунды. Объявлено только здесь: другие скрипты страницы используют этот глобал.
const US2S = 1 / 1000000

// Типы сборки из VER.BU (как в Libraries/LogHelpers.js)
const BUILD_NAMES = { 1: "Rover", 2: "Copter", 3: "Plane", 4: "AntennaTracker", 7: "Sub", 12: "Blimp" }

// Без профиля аппарата (core/vehicle.js; вид не поддержан или вызов без профиля) — как до этапа 9: газ CTUN.ThO, затем
// RATE.AOut; PID — PIDR/PIDP/PIDY; рама — «Frame: »; окна по режимам нет. Те же значения у профиля Copter — равенство
// закреплено в tests/tunewizard-vehicle.test.cjs
const LOG_DEFAULT_PROFILE = {
    throttle: [["CTUN", "ThO"], ["RATE", "AOut"]],
    pid_messages: ["PIDR", "PIDP", "PIDY"],
    frame_prefix: "Frame: ",
    vtol_modes: null,
}

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

// Какие сообщения есть в логе. pid — все сообщения PID контура скорости pid_messages (профиль аппарата: у QuadPlane —
// PIQR/PIQP/PIQY), mode — MODE (смены режима)
function log_messages(log, pid_messages = LOG_DEFAULT_PROFILE.pid_messages) {
    const has = (name) => name in log.messageTypes
    return {
        pid: pid_messages.every(has),
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
        mode: has("MODE"),
    }
}

// Частота сообщения name, Гц — отсчётов в секунду без пропусков: средний интервал TimeUS, где интервалы длиннее 5 медиан
// (на земле лог может не писаться; порог — как у разрыва пакетов PIDReview) не учитываются. Дрожание меток усредняется,
// а частые выпадения по 2–3 интервала частоту снижают — как и частоты пакетов шага 4 (пакеты режутся по тому же порогу).
// null, если сообщения нет, в нём меньше двух отсчётов или оно пишется по экземплярам (как VIBE: get() на нём падает,
// а частота по экземплярам здесь не нужна — PIDR/PIDP/PIDY и RATE экземпляров не имеют)
function log_message_rate(log, name) {
    if (!(name in log.messageTypes) || (log.messageTypes[name].instances != null)) {
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

// Ряд «газ» 0–1 для окна полёта: первый из sources ([сообщение, поле] по порядку; профиль аппарата), который есть в логе.
// Без профиля — CTUN.ThO (выход газа), иначе RATE.AOut; у QuadPlane — QTUN.ThO, иначе RATE.AOut (газ VTOL-моторов).
// → { time (с), throttle, source: "СООБЩЕНИЕ.поле" } или null
function throttle_series(log, sources = LOG_DEFAULT_PROFILE.throttle) {
    for (const [name, field] of sources) {
        if (name in log.messageTypes) {
            const values = log.get(name, field)
            if (values != null) {
                return { time: us_to_s(log.get(name, "TimeUS")), throttle: Array.from(values), source: name + "." + field }
            }
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

// Участки режимов полёта в интервале range = [t0, t1] по сообщениям MODE (поле Mode — номер режима, у ArduPilot Mode =
// ModeNum [код] AP_Logger/LogFile.cpp:477–478): действующий на t0 (последний MODE не позже t0) — с t0, каждый MODE внутри
// (t0 < t < t1) открывает новый участок, последний — до t1; подряд один и тот же режим (повторная запись ACRO) — один
// участок. Режим до первого MODE неизвестен — участка нет. MODE ровно на t1 участка не даёт: его длительность в интервале
// нулевая (и кнопка «Интервал — участок ACRO» шага 4 ставит конец интервала на целую секунду не позже смены режима).
// Весь лог — range [−Infinity, Infinity]: участки с первого MODE, последний — до Infinity.
// → [{ mode (номер), start, end (с) }] по времени; [] — нет MODE. Перенесено из core/pidtune.js (pidtune_mode_segments —
// обёртка): окно VTOL шага 0 (log_vtol_windows) считается без ядра шага 4
function log_mode_segments(log, range) {
    if ((log == null) || !("MODE" in log.messageTypes)) {
        return []
    }
    const time = log.get("MODE", "TimeUS")
    const mode = log.get("MODE", "Mode")
    if ((time == null) || (mode == null)) {
        return []
    }
    let current = null
    const inner = []
    for (let i = 0; i < time.length; i++) {
        const t = time[i] * US2S
        if (t <= range[0]) {
            current = mode[i]
        } else if (t < range[1]) {
            inner.push([mode[i], t])
        }
    }
    const segments = []
    const open = (m, t) => {
        const last = segments[segments.length - 1]
        if (last != null) {
            if (last.mode == m) {
                return
            }
            last.end = t
        }
        segments.push({ mode: m, start: t, end: range[1] })
    }
    if (current != null) {
        open(current, range[0])
    }
    for (const [m, t] of inner) {
        open(m, t)
    }
    return segments
}

// Окна висения VTOL по ряду газа throttle (throttle_series) и режимам vtol_modes (профиль аппарата) [решение пользователя
// 30.10.2026; склейка — наше, дизайн этапа 9, раздел 4]: участки режимов за весь лог (log_mode_segments), соседние
// VTOL-режимы склеиваются в один участок (QHOVER → QLOITER → QLAND), внутри участка — окно газа throttle_window по его
// отсчётам (от первого до последнего ненулевого газа, 1 с внутрь). Не по одному газу: у tailsitter с Q_TAILSIT_ENABLE = 2
// и при Q-assist RATE и QTUN пишутся и в самолётных режимах [код] ArduPlane/quadplane.cpp:1767–1776, 1812–1826,
// tailsitter.cpp:237–238. → null — в логе нет MODE (режимы неизвестны); иначе [{ start, end, modes }] по времени:
// modes — номера режимов, чьи участки пересекают окно, без повторов в порядке появления; участок без окна (газа нет или
// он короче отступов) в список не попадает
function log_vtol_windows(log, throttle, vtol_modes) {
    const segments = log_mode_segments(log, [-Infinity, Infinity])
    if (segments.length == 0) {
        return null
    }
    // Участки идут подряд (конец одного — начало следующего): соседние VTOL-режимы — соседние элементы списка
    const groups = []
    let previous_vtol = false
    for (const segment of segments) {
        const vtol = vtol_modes.includes(segment.mode)
        if (vtol && previous_vtol) {
            const last = groups[groups.length - 1]
            last.end = segment.end
            last.parts.push(segment)
        } else if (vtol) {
            groups.push({ start: segment.start, end: segment.end, parts: [segment] })
        }
        previous_vtol = vtol
    }

    const windows = []
    for (const group of groups) {
        const time = []
        const values = []
        for (let i = 0; i < throttle.time.length; i++) {
            if ((throttle.time[i] >= group.start) && (throttle.time[i] < group.end)) {
                time.push(throttle.time[i])
                values.push(throttle.throttle[i])
            }
        }
        const window = throttle_window(time, values)
        if (window == null) {
            continue
        }
        const modes = []
        for (const part of group.parts) {
            if ((part.start < window.end) && (part.end > window.start) && !modes.includes(part.mode)) {
                modes.push(part.mode)
            }
        }
        windows.push({ start: window.start, end: window.end, modes })
    }
    return windows
}

// Окно полёта для шага 0 и интервала по умолчанию по ряду газа throttle (throttle_series; null — газа нет) → null (окна нет)
// или { start, end, duration_s, mean_throttle }. vtol_modes (профиль аппарата; null — у Copter и без профиля) — окно по
// участкам этих режимов (log_vtol_windows): самое длинное (при равных — раньше), и ещё modes — номера его режимов и
// segments — остальные окна VTOL [{ start, end, duration_s, modes }] по времени; в логе нет MODE — окно по газу за весь
// лог, как у Copter, modes null, segments []
function log_flight(log, throttle, vtol_modes = null) {
    if (throttle == null) {
        return null
    }
    const flight = (window) => ({
        start: window.start,
        end: window.end,
        duration_s: window.end - window.start,
        mean_throttle: mean_throttle(throttle.time, throttle.throttle, window),
    })
    const windows = (vtol_modes != null) ? log_vtol_windows(log, throttle, vtol_modes) : null
    if (windows == null) {
        const window = throttle_window(throttle.time, throttle.throttle)
        if (window == null) {
            return null
        }
        return (vtol_modes != null) ? { ...flight(window), modes: null, segments: [] } : flight(window)
    }
    if (windows.length == 0) {
        return null
    }
    const longest = windows.reduce((a, b) => ((b.end - b.start) > (a.end - a.start)) ? b : a)
    const segments = windows.filter((w) => w !== longest).map((w) => ({ start: w.start, end: w.end, duration_s: w.end - w.start, modes: w.modes }))
    return { ...flight(longest), modes: longest.modes, segments }
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

// Сводка ESC-телеметрии для проверки источника трекинга (аудит, I4): instances — экземпляров ESC с данными,
// with_rpm — сколько из них хоть раз сообщили конечные обороты больше нуля (прошивка пишет NaN, когда оборотов нет,
// AP_ESC_Telem.cpp; нули — моторы стоят). null, если сообщения ESC нет
function esc_summary(log) {
    if (!("ESC" in log.messageTypes)) {
        return null
    }
    // Старый лог без экземпляров читается как один регулятор через get_instance(name, null, field)
    const instances = log.messageTypes.ESC.instances
    const keys = instances ? Object.keys(instances) : [null]
    let count = 0
    let with_rpm = 0
    for (const key of keys) {
        const rpm = log.get_instance("ESC", key, "RPM")
        if ((rpm == null) || (rpm.length == 0)) {
            continue
        }
        count++
        for (let i = 0; i < rpm.length; i++) {
            if (Number.isFinite(rpm[i]) && (rpm[i] > 0)) {
                with_rpm++
                break
            }
        }
    }
    return { instances: count, with_rpm }
}

// Крайние метки времени лога, мкс: { start, end } или null. Сначала ATT, RATE, CTUN по порядку (первое с двумя и больше
// отсчётами — как границы графиков FilterReview/PIDReview); без них (аудит, I3) — данные гироскопа: ISBH.SampleUS,
// затем GYR.SampleUS по экземплярам; иначе — первая и последняя TimeUS первого подходящего из короткого списка обычных
// сообщений (LOG_FALLBACK_TIME_MESSAGES: пишутся весь полёт, читаются через get; с двумя и больше отсчётами), а не всех
// типов лога — get по каждому типу разбирал бы весь лог (ревью исправлений аудита). Сообщение списка с экземплярами
// (IMU, BARO, BAT, MAG в новых прошивках) пропускается: get на таких падает. Сообщение может быть объявлено без
// единой строки: поля нет, get возвращает undefined
const LOG_FALLBACK_TIME_MESSAGES = ["RCOU", "RCIN", "PM", "XKF1", "IMU", "BARO", "BAT", "MAG", "MODE"]
function log_time_bounds(log) {
    const span = (t) => ((t != null) && (t.length > 1)) ? { start: t[0], end: t[t.length - 1] } : null
    for (const name of ["ATT", "RATE", "CTUN"]) {
        if (name in log.messageTypes) {
            const found = span(log.get(name, "TimeUS"))
            if (found != null) {
                return found
            }
        }
    }
    if ("ISBH" in log.messageTypes) {
        const found = span(log.get("ISBH", "SampleUS"))
        if (found != null) {
            return found
        }
    }
    let bounds = null
    const extend = (found) => {
        if (found == null) {
            return
        }
        if (bounds == null) {
            bounds = { ...found }
        } else {
            bounds.start = Math.min(bounds.start, found.start)
            bounds.end = Math.max(bounds.end, found.end)
        }
    }
    if (("GYR" in log.messageTypes) && (log.messageTypes.GYR.instances != null)) {
        for (const inst of Object.keys(log.messageTypes.GYR.instances)) {
            extend(span(log.get_instance("GYR", inst, "SampleUS")))
        }
        if (bounds != null) {
            return bounds
        }
    }
    for (const name of LOG_FALLBACK_TIME_MESSAGES) {
        if (!(name in log.messageTypes) || (log.messageTypes[name].instances != null)) {
            continue
        }
        const found = span(log.get(name, "TimeUS"))
        if (found != null) {
            return found
        }
    }
    return null
}

// Рама из сообщений MSG: текст после prefix первого сообщения, которое так начинается («Frame: QUAD/X_REV» — класс и тип
// рамы, AP_Motors::get_frame_and_type_string; у QuadPlane — «QuadPlane Frame: QUAD/X», префикс профиля аппарата).
// Нет MSG (или в нём нет строк) или такой строки — null
function log_frame(log, prefix = LOG_DEFAULT_PROFILE.frame_prefix) {
    if (!("MSG" in log.messageTypes)) {
        return null
    }
    const message = log.get("MSG", "Message")?.find((text) => text.startsWith(prefix))
    return (message != null) ? message.slice(prefix.length) : null
}

// Сводная информация о логе. version — результат get_version_and_board(log) из Libraries/LogHelpers.js; profile —
// профиль аппарата (vehicle_profile из core/vehicle.js; null — вид не поддержан, тогда — LOG_DEFAULT_PROFILE, как до
// этапа 9). vehicle — имя вида (профиля, иначе типа сборки), kind и profile — вид и профиль (null — не поддержан),
// tailsitter — profile.is_tailsitter по параметрам лога. board — строка полётного контроллера из MSG, board_id — номер
// платы APJ из VER, frame — рама (log_frame), esc — сводка ESC-телеметрии (esc_summary); нет — null. flight — окно
// полёта (log_flight; у QuadPlane — по VTOL-режимам)
function log_info(log, version = {}, profile = null) {
    const used = profile ?? LOG_DEFAULT_PROFILE
    const messages = log_messages(log, used.pid_messages)

    // Границы и длительность (log_time_bounds). time_start/time_end — абсолютные секунды лога, по ним страница задаёт
    // границы графиков
    let time_start = null
    let time_end = null
    let duration_s = null
    const bounds = log_time_bounds(log)
    if (bounds != null) {
        time_start = bounds.start * US2S
        time_end = bounds.end * US2S
        duration_s = (bounds.end - bounds.start) * US2S
    }

    const throttle = throttle_series(log, used.throttle)

    // Частоты первого сообщения PID профиля (PIDR, у QuadPlane — PIQR) и RATE, Гц или null — для проверки pid_log (ниже
    // порога отклик шага 4 не считается); какую брать, решает проверка по той же ветке, что и наличие сообщений
    // (messages.pid или messages.rate)
    const pid_name = used.pid_messages[0]
    const pid_log_rates = { [pid_name]: log_message_rate(log, pid_name), RATE: log_message_rate(log, "RATE") }

    return {
        vehicle: profile?.title ?? BUILD_NAMES[version.build_type] ?? null,
        kind: profile?.kind ?? null,
        profile: profile ?? null,
        // PARM разбирается, только если у вида бывает tailsitter (у Copter is_tailsitter null — вызов с аргументами пропускается)
        tailsitter: profile?.is_tailsitter?.(log_params(log)) ?? false,
        build_type: version.build_type ?? null,
        fw_string: version.fw_string ?? null,
        board: version.flight_controller ?? null,
        board_id: version.board_id ?? null,
        frame: log_frame(log, used.frame_prefix),
        filter_version: version.filter_version ?? null,
        time_start,
        time_end,
        duration_s,
        messages,
        esc: esc_summary(log),
        pid_log_rates,
        throttle_source: throttle?.source ?? null,
        flight: log_flight(log, throttle, used.vtol_modes),
    }
}

if (typeof module !== "undefined") {
    module.exports = { US2S, LOG_DEFAULT_PROFILE, us_to_s, log_params, log_messages, log_message_rate, throttle_series, throttle_window, mean_throttle, log_mode_segments, log_vtol_windows, log_flight, percentile, vibe_summary, esc_summary, log_time_bounds, log_frame, log_info }
}
