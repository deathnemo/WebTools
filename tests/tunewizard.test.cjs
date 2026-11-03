// Тесты ядра мастера настройки (TuneWizard/core). Логи — поддельные объекты с интерфейсом парсера.
const test = require('node:test')
const assert = require('node:assert/strict')

const core_log = require('../TuneWizard/core/log.js')
// Профили аппаратов: log_info и run_checks получают профиль аргументом (в info.profile) — глобалов страницы здесь нет
const vehicle = require('../TuneWizard/core/vehicle.js')
const copter = vehicle.vehicle_profile('copter')
const quadplane = vehicle.vehicle_profile('quadplane')

// Поддельный лог с интерфейсом парсера.
// messages = { ИМЯ: { поле: массив } } — сообщение без экземпляров;
//            { ИМЯ: { instances: { 0: { поле: массив }, 1: {…} } } } — с экземплярами (как VIBE, ESC, IMU):
//            такие сообщения настоящий парсер отдаёт только через get_instance, а get() на них падает.
// params = [[имя, значение, TimeUS], ...]
function fake_log({ messages = {}, params = [] } = {}) {
    const types = { ...messages }
    if (params.length > 0) {
        types.PARM = {
            TimeUS: params.map((p) => p[2] ?? 0),
            Name: params.map((p) => p[0]),
            Value: params.map((p) => p[1])
        }
    }
    const messageTypes = {}
    for (const [name, msg] of Object.entries(types)) {
        messageTypes[name] = msg.instances ? { instances: Object.fromEntries(Object.keys(msg.instances).map((k) => [k, {}])) } : {}
    }
    return {
        messageTypes,
        get(name, field) {
            return this.get_instance(name, null, field)
        },
        get_instance(name, instance, field) {
            const msg = types[name]
            if (msg == null) return undefined
            if (msg.instances) {
                if (instance == null) throw new TypeError("сообщение с экземплярами читается только через get_instance")
                const data = msg.instances[instance]
                if (data == null) return undefined
                return field ? data[field] : data
            }
            return field ? msg[field] : msg
        }
    }
}

const copter_version = { build_type: 2, fw_string: 'ArduCopter V4.6.0', flight_controller: 'CubeOrange', filter_version: 2 }

test('log_params: последнее значение, история изменений, отсутствующий параметр', () => {
    const log = fake_log({ params: [
        ['ATC_RAT_RLL_P', 0.1, 1e6],
        ['ATC_RAT_RLL_P', 0.1, 2e6],   // повтор без изменения не попадает в историю
        ['ATC_RAT_RLL_P', 0.15, 30e6],
        ['INS_GYRO_FILTER', 40, 1e6]
    ] })
    const params = core_log.log_params(log)
    assert.equal(params.get('ATC_RAT_RLL_P'), 0.15)
    assert.equal(params.get('INS_GYRO_FILTER'), 40)
    assert.equal(params.get('NOPE'), null)
    assert.equal(params.has('NOPE'), false)
    assert.deepEqual(params.history('ATC_RAT_RLL_P'), [{ time: 1, value: 0.1 }, { time: 30, value: 0.15 }])
    assert.equal(params.changed('ATC_RAT_RLL_P'), true)
    assert.equal(params.changed('INS_GYRO_FILTER'), false)
})

test('log_messages: флаги наличия сообщений', () => {
    const log = fake_log({ messages: { PIDR: {}, PIDP: {}, PIDY: {}, GYR: {}, ESC: {}, ATT: {} } })
    const m = core_log.log_messages(log)
    assert.equal(m.pid, true)
    assert.equal(m.rate, false)
    assert.equal(m.gyro_raw, true)
    assert.equal(m.gyro_batch, false)
    assert.equal(m.esc, true)
    assert.equal(m.rpm, false)
    assert.equal(m.vibe, false)
})

test('throttle_window: от первого до последнего ненулевого газа с отступом 1 с', () => {
    const time = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const throttle = [0, 0, 0.3, 0.4, 0.4, 0.4, 0.4, 0.4, 0.3, 0, 0]
    assert.deepEqual(core_log.throttle_window(time, throttle), { start: 3, end: 7 })
    assert.equal(core_log.throttle_window(time, new Array(11).fill(0)), null)
    // Слишком короткий полёт: окно схлопывается
    assert.equal(core_log.throttle_window([0, 1, 2], [0, 0.5, 0]), null)
})

test('mean_throttle: средний ненулевой газ внутри окна', () => {
    const time = [0, 1, 2, 3, 4, 5]
    const throttle = [0, 0.2, 0.4, 0.6, 0, 0.9]
    // Сумма чисел с плавающей точкой: сравниваем с допуском
    assert.ok(Math.abs(core_log.mean_throttle(time, throttle, { start: 1, end: 4 }) - 0.4) < 1e-9)
    assert.equal(core_log.mean_throttle(time, [0, 0, 0, 0, 0, 0], { start: 1, end: 4 }), null)
})

test('throttle_series: CTUN.ThO предпочтительнее RATE.AOut', () => {
    const both = fake_log({ messages: {
        CTUN: { TimeUS: [0, 1e6], ThO: [0.3, 0.4] },
        RATE: { TimeUS: [0, 1e6], AOut: [0.5, 0.6] }
    } })
    assert.deepEqual(core_log.throttle_series(both), { time: [0, 1], throttle: [0.3, 0.4], source: 'CTUN.ThO' })
    const rate_only = fake_log({ messages: { RATE: { TimeUS: [0, 2e6], AOut: [0.5, 0.6] } } })
    assert.deepEqual(core_log.throttle_series(rate_only), { time: [0, 2], throttle: [0.5, 0.6], source: 'RATE.AOut' })
    assert.equal(core_log.throttle_series(fake_log()), null)
})

test('throttle_series: CTUN без поля ThO — берём RATE.AOut; без обоих полей — null', () => {
    const log = fake_log({ messages: {
        CTUN: { TimeUS: [0, 1e6], Alt: [1, 2] },
        RATE: { TimeUS: [0, 1e6], AOut: [0.5, 0.6] }
    } })
    assert.deepEqual(core_log.throttle_series(log), { time: [0, 1], throttle: [0.5, 0.6], source: 'RATE.AOut' })
    const no_fields = fake_log({ messages: { CTUN: { TimeUS: [0] }, RATE: { TimeUS: [0] } } })
    assert.equal(core_log.throttle_series(no_fields), null)
})

test('percentile: 95-й процентиль', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1)
    assert.equal(core_log.percentile(values, 0.95), 95)
    assert.equal(core_log.percentile([], 0.95), null)
})

test('vibe_summary: по экземплярам IMU — p95 и максимум по осям, clipping', () => {
    const log = fake_log({ messages: { VIBE: { instances: {
        0: { TimeUS: [0, 2e6], VibeX: [10, 12], VibeY: [5, 7], VibeZ: [30, 35], Clip: [0, 3] },
        1: { TimeUS: [1e6, 3e6], VibeX: [20, 22], VibeY: [6, 8], VibeZ: [40, 45], Clip: [0, 1] }
    } } } })
    const vibe = core_log.vibe_summary(log)
    assert.equal(vibe.imus.length, 2)
    assert.equal(vibe.imus[0].imu, 0)
    assert.equal(vibe.imus[0].max, 35)
    assert.equal(vibe.imus[1].max, 45)
    assert.equal(vibe.imus[0].clip, 3)
    assert.equal(vibe.imus[1].clip, 1)
    assert.equal(vibe.max, 45)
    assert.equal(vibe.clip, 4)
    assert.equal(vibe.level, 45)
    assert.equal(core_log.vibe_summary(fake_log()), null)
})

test('vibe_summary: старый формат VIBE без экземпляров — один IMU, clip = сумма Clip0..Clip2', () => {
    const log = fake_log({ messages: { VIBE: {
        TimeUS: [0, 1e6, 2e6], VibeX: [10, 12, 11], VibeY: [5, 7, 6], VibeZ: [30, 35, 33],
        Clip0: [0, 1, 2], Clip1: [0, 0, 1], Clip2: [0, 0, 0]
    } } })
    const vibe = core_log.vibe_summary(log)
    assert.equal(vibe.imus.length, 1)
    assert.equal(vibe.imus[0].imu, 0)
    assert.equal(vibe.imus[0].max, 35)
    assert.equal(vibe.imus[0].clip, 3)
    assert.equal(vibe.clip, 3)
})

test('vibe_summary: VIBE по экземплярам без поля Clip — clip равен 0, без исключения', () => {
    const log = fake_log({ messages: { VIBE: { instances: {
        0: { TimeUS: [0, 1e6], VibeX: [10, 12], VibeY: [5, 7], VibeZ: [30, 35] }
    } } } })
    const vibe = core_log.vibe_summary(log)
    assert.equal(vibe.imus[0].clip, 0)
    assert.equal(vibe.clip, 0)
    assert.equal(vibe.max, 35)
})

test('vibe_summary: длинный ряд VIBE (часы полёта) не переполняет стек', () => {
    const n = 200000
    const log = fake_log({ messages: { VIBE: { instances: { 0: {
        TimeUS: Array.from({ length: n }, (_, i) => i * 1e5),
        VibeX: new Array(n).fill(10),
        VibeY: new Array(n).fill(10),
        VibeZ: Array.from({ length: n }, (_, i) => (i == n - 1) ? 50 : 20),
        Clip: new Array(n).fill(0)
    } } } } })
    const vibe = core_log.vibe_summary(log)
    assert.equal(vibe.max, 50)
    assert.equal(vibe.level, 20)
})

test('log_info: аппарат, длительность, окно полёта, средний газ', () => {
    const n = 61
    const TimeUS = Array.from({ length: n }, (_, i) => i * 1e6)
    const ThO = TimeUS.map((_, i) => (i >= 5 && i <= 55) ? 0.35 : 0)
    const log = fake_log({ messages: {
        ATT: { TimeUS, Roll: new Array(n).fill(0), Pitch: new Array(n).fill(0) },
        CTUN: { TimeUS, ThO },
        GYR: {}, PIDR: {}, PIDP: {}, PIDY: {}
    } })
    const info = core_log.log_info(log, copter_version, copter)
    assert.equal(info.vehicle, 'Copter')
    assert.equal(info.kind, 'copter')
    assert.equal(info.profile, copter)
    assert.equal(info.tailsitter, false)
    assert.equal(info.fw_string, 'ArduCopter V4.6.0')
    assert.equal(info.board, 'CubeOrange')
    assert.equal(info.filter_version, 2)
    assert.equal(info.duration_s, 60)
    assert.equal(info.time_start, 0)
    assert.equal(info.time_end, 60)
    assert.equal(info.throttle_source, 'CTUN.ThO')
    assert.equal(info.flight.start, 6)
    assert.equal(info.flight.end, 54)
    assert.equal(info.flight.duration_s, 48)
    assert.ok(Math.abs(info.flight.mean_throttle - 0.35) < 1e-9)
    // У Copter окно — весь полёт с газом: полей окна VTOL нет
    assert.deepEqual(Object.keys(info.flight), ['start', 'end', 'duration_s', 'mean_throttle'])
    assert.equal(info.messages.pid, true)
    assert.equal(info.messages.mode, false)
})

test('log_info: рама — текст после «Frame: » из первого такого MSG; нет строки или MSG — null', () => {
    const frame_of = (messages) => core_log.log_info(fake_log({ messages }), copter_version, copter).frame
    assert.equal(frame_of({ MSG: { Message: ['ArduCopter V4.6.3 (92b0cd78)', 'Frame: QUAD/X_REV'] } }), 'QUAD/X_REV')
    // Первая из нескольких; строка без «Frame: » в начале не считается
    assert.equal(frame_of({ MSG: { Message: ['Old Frame: HEXA/X', 'Frame: QUAD/X', 'Frame: HEXA/X'] } }), 'QUAD/X')
    assert.equal(frame_of({ MSG: { Message: ['ArduCopter V4.6.3 (92b0cd78)', 'RCOut: PWM:1-4'] } }), null)
    // MSG объявлен без строк: поля нет, get возвращает undefined
    assert.equal(frame_of({ MSG: {} }), null)
    assert.equal(frame_of({}), null)
})

test('log_info: номер платы APJ — board_id из get_version_and_board; нет — null', () => {
    const log = fake_log()
    assert.equal(core_log.log_info(log, { ...copter_version, board_id: 1503 }).board_id, 1503)
    assert.equal(core_log.log_info(log, copter_version, copter).board_id, null)
    assert.equal(core_log.log_info(log).board_id, null)
})

test('log_info: без полёта и без ATT', () => {
    const log = fake_log({ messages: { RATE: { TimeUS: [0, 1e6, 2e6], AOut: [0, 0, 0] } } })
    const info = core_log.log_info(log, { build_type: 3 })
    assert.equal(info.vehicle, 'Plane')
    assert.equal(info.kind, null)
    assert.equal(info.profile, null)
    assert.equal(info.tailsitter, false)
    assert.equal(info.flight, null)
    assert.equal(info.duration_s, 2)
    assert.equal(info.time_start, 0)
    assert.equal(info.time_end, 2)
})

// ---------------------------------------------------------------- QuadPlane (этап 9)

const plane_version = { build_type: 3, fw_string: 'ArduPlane V4.6.3 (84451727)', flight_controller: 'DEFD-H7-Basic-V3.1', filter_version: 2 }

// Поддельный лог QuadPlane tailsitter (дизайн этапа 9, раздел 11), 0–200 с. Газ VTOL-моторов (QTUN.ThO 10 Гц, RATE.AOut
// 50 Гц, отсчёты на 0.05 с от целых секунд): 0.45 на 15–55 с, 0.2 на 60–100 с (FBWA: у tailsitter с Q_TAILSIT_ENABLE = 2
// QTUN и RATE пишутся и в самолётных режимах), 0.5 на 100–150 с и 0.4 на 150–170 с; CTUN.ThO (самолётный мотор) — нули.
// MODE 17 (10 с) → 5 (60 с) → 18 (100 с) → 20 (150 с). PIDR (самолётный) — 50 Гц, PIQR/PIQP/PIQY — piq_hz. MSG с рамой
// «QuadPlane Frame: QUAD/X». over — поправки: { qtun: false, rate: false, mode: null | { TimeUS, Mode }, piq_hz: null
// (без PIQx), throttle_at: (t) → газ, params: { имя: значение (null — параметра нет) } }
function quadplane_log(over = {}) {
    const throttle_at = over.throttle_at ??
        ((t) => (t >= 15 && t < 55) ? 0.45 : (t >= 60 && t < 100) ? 0.2 : (t >= 100 && t < 150) ? 0.5 : (t >= 150 && t < 170) ? 0.4 : 0)
    const series = (hz) => Array.from({ length: 200 * hz }, (_, i) => Math.round((0.05 + i / hz) * 1e6))
    const qtun_time = series(10)
    const rate_time = series(50)
    const messages = {
        VER: { BU: [3] },
        ATT: { TimeUS: rate_time },
        CTUN: { TimeUS: qtun_time, ThO: qtun_time.map(() => 0) },
        PIDR: { TimeUS: rate_time }, PIDP: { TimeUS: rate_time }, PIDY: { TimeUS: rate_time },
        MSG: { Message: ['ArduPlane V4.6.3 (84451727)', 'QuadPlane Frame: QUAD/X'] },
        // Batch гироскопа (INS_LOG_BAT_OPT = 4 — до и после фильтров): проверки gyro_log и pre_post
        ISBH: {}, ISBD: {},
    }
    if (over.qtun !== false) {
        messages.QTUN = { TimeUS: qtun_time, ThO: qtun_time.map((t) => throttle_at(t * 1e-6)) }
    }
    if (over.rate !== false) {
        messages.RATE = { TimeUS: rate_time, AOut: rate_time.map((t) => throttle_at(t * 1e-6)) }
    }
    const mode = (over.mode !== undefined) ? over.mode : { TimeUS: [10e6, 60e6, 100e6, 150e6], Mode: [17, 5, 18, 20] }
    if (mode != null) {
        messages.MODE = mode
    }
    const piq_hz = (over.piq_hz !== undefined) ? over.piq_hz : 25
    if (piq_hz != null) {
        const piq_time = series(piq_hz)
        messages.PIQR = { TimeUS: piq_time }
        messages.PIQP = { TimeUS: piq_time }
        messages.PIQY = { TimeUS: piq_time }
    }
    const values = { Q_ENABLE: 1, Q_TAILSIT_ENABLE: 2, Q_FRAME_CLASS: 1, Q_A_RAT_RLL_P: 0.25, Q_A_RAT_RLL_FLTD: 25.5, Q_M_THST_HOVER: 0.35,
                     Q_M_HOVER_LEARN: 0, LOG_BITMASK: 65535, INS_LOG_BAT_OPT: 4, ...over.params }
    return fake_log({ messages, params: Object.entries(values).filter(([, v]) => v != null).map(([name, value]) => [name, value, 0]) })
}

// Сведения о логе, как на странице: вид по VER.BU и параметрам лога, профиль — в log_info
function quadplane_info(log, version = plane_version) {
    const kind = vehicle.vehicle_kind(version.build_type, core_log.log_params(log))
    return core_log.log_info(log, version, vehicle.vehicle_profile(kind))
}

test('log_mode_segments: весь лог — участки с первого MODE, подряд один режим — один участок; без MODE — []', () => {
    const log = fake_log({ messages: { MODE: { TimeUS: [10e6, 60e6, 61e6, 100e6], Mode: [17, 5, 5, 18] } } })
    assert.deepEqual(core_log.log_mode_segments(log, [-Infinity, Infinity]),
        [{ mode: 17, start: 10, end: 60 }, { mode: 5, start: 60, end: 100 }, { mode: 18, start: 100, end: Infinity }])
    assert.deepEqual(core_log.log_mode_segments(log, [30, 80]), [{ mode: 17, start: 30, end: 60 }, { mode: 5, start: 60, end: 80 }])
    assert.deepEqual(core_log.log_mode_segments(fake_log(), [-Infinity, Infinity]), [])
    assert.deepEqual(core_log.log_mode_segments(fake_log({ messages: { MODE: {} } }), [0, 10]), [])
})

test('log_info QuadPlane: вид, газ QTUN.ThO, окно VTOL без FBWA, склейка QHOVER → QLAND, самый длинный участок и остальные, рама, PIQR', () => {
    const info = quadplane_info(quadplane_log())
    assert.equal(info.vehicle, 'QuadPlane')
    assert.equal(info.kind, 'quadplane')
    assert.equal(info.profile, quadplane)
    assert.equal(info.tailsitter, true)
    assert.equal(info.build_type, 3)
    // CTUN.ThO (нули самолётного мотора) не берётся
    assert.equal(info.throttle_source, 'QTUN.ThO')
    // QHOVER 100–150 и QLAND 150–… склеены: газ 100.05–169.95 → окно 102–168; FBWA (60–100, газ 0.2) не входит
    assert.equal(info.flight.start, 102)
    assert.equal(info.flight.end, 168)
    assert.equal(info.flight.duration_s, 66)
    assert.deepEqual(info.flight.modes, [18, 20])
    // Средний газ окна: 480 отсчётов 0.5 и 180 отсчётов 0.4
    assert.ok(Math.abs(info.flight.mean_throttle - (480 * 0.5 + 180 * 0.4) / 660) < 1e-9, String(info.flight.mean_throttle))
    // Остальные VTOL-участки: QSTABILIZE 15.05–54.95 → 17–53
    assert.deepEqual(info.flight.segments, [{ start: 17, end: 53, duration_s: 36, modes: [17] }])
    // PID — регуляторы VTOL (PIQx), а не самолётные PIDR; частота — PIQR
    assert.equal(info.messages.pid, true)
    assert.equal(info.messages.mode, true)
    assert.deepEqual(Object.keys(info.pid_log_rates), ['PIQR', 'RATE'])
    assert.ok(Math.abs(info.pid_log_rates.PIQR - 25) < 1e-6, String(info.pid_log_rates.PIQR))
    assert.equal(info.frame, 'QUAD/X')
    // Без PIQx — messages.pid ложно, хотя PIDR/PIDP/PIDY есть
    assert.equal(quadplane_info(quadplane_log({ piq_hz: null })).messages.pid, false)
    // Не tailsitter
    assert.equal(quadplane_info(quadplane_log({ params: { Q_TAILSIT_ENABLE: 0 } })).tailsitter, false)
    assert.equal(quadplane_info(quadplane_log({ params: { Q_TAILSIT_ENABLE: null } })).tailsitter, false)
})

test('log_info QuadPlane: без QTUN — газ RATE.AOut, окно то же; без QTUN и RATE — газа нет', () => {
    const info = quadplane_info(quadplane_log({ qtun: false }))
    assert.equal(info.throttle_source, 'RATE.AOut')
    assert.deepEqual([info.flight.start, info.flight.end, info.flight.modes], [102, 168, [18, 20]])
    assert.deepEqual(info.flight.segments.map((s) => [s.start, s.end]), [[17, 53]])
    const none = quadplane_info(quadplane_log({ qtun: false, rate: false }))
    assert.equal(none.throttle_source, null)
    assert.equal(none.flight, null)
})

test('log_info QuadPlane: без MODE — окно по газу за весь лог, modes null; MODE без VTOL-участков с газом — окна нет', () => {
    const no_mode = quadplane_info(quadplane_log({ mode: null }))
    assert.deepEqual(no_mode.flight, { start: 17, end: 168, duration_s: 151, mean_throttle: no_mode.flight.mean_throttle, modes: null, segments: [] })
    assert.equal(no_mode.messages.mode, false)
    // Весь лог в FBWA — VTOL-участков нет, хотя газ VTOL-моторов есть
    const fbwa = quadplane_info(quadplane_log({ mode: { TimeUS: [1e6], Mode: [5] } }))
    assert.equal(fbwa.throttle_source, 'QTUN.ThO')
    assert.equal(fbwa.flight, null)
    // QLOITER без газа (на земле, 1–12 с) склеен с соседним QSTABILIZE, но в режимы окна не входит; QLOITER после FBWA —
    // свой участок
    const split = quadplane_info(quadplane_log({ mode: { TimeUS: [1e6, 12e6, 58e6, 100e6], Mode: [19, 17, 5, 19] } }))
    assert.deepEqual([split.flight.start, split.flight.end, split.flight.modes], [102, 168, [19]])
    assert.deepEqual(split.flight.segments, [{ start: 17, end: 53, duration_s: 36, modes: [17] }])
    // Два окна одной длины — берётся раньше
    const equal = quadplane_info(quadplane_log({ mode: { TimeUS: [10e6, 60e6, 100e6, 140e6], Mode: [17, 5, 18, 5] } }))
    assert.deepEqual([equal.flight.start, equal.flight.end], [17, 53])
    assert.deepEqual(equal.flight.segments.map((s) => [s.start, s.end, s.modes]), [[102, 138, [18]]])
})

test('log_info QuadPlane: газ до первого MODE (режим неизвестен) в окно не входит', () => {
    // Газ 0.45 с 15 с, первый MODE (QSTABILIZE) — на 30 с: окно с 32 (30.05 → 31 + 1 с отступа), а не с 17
    const info = quadplane_info(quadplane_log({ mode: { TimeUS: [30e6, 60e6, 100e6, 150e6], Mode: [17, 5, 18, 20] } }))
    assert.deepEqual([info.flight.start, info.flight.end, info.flight.modes], [102, 168, [18, 20]])
    assert.deepEqual(info.flight.segments, [{ start: 32, end: 53, duration_s: 21, modes: [17] }])
    // Единственный VTOL-участок начинается позже газа
    const only = quadplane_info(quadplane_log({ mode: { TimeUS: [30e6], Mode: [17] }, throttle_at: (t) => (t >= 15 && t < 55) ? 0.45 : 0 }))
    assert.deepEqual([only.flight.start, only.flight.end, only.flight.modes, only.flight.segments], [32, 53, [17], []])
})

test('log_info QuadPlane: VTOL сменился самолётным режимом при продолжающемся газе — окно кончается на смене режима', () => {
    // Газ 0.45 на 15–55 с без перерыва, QSTABILIZE → FBWA на 40 с (у tailsitter QTUN и RATE пишутся и в FBWA): окно
    // 17–38, газ FBWA и следующие участки FBWA с газом — не VTOL
    const info = quadplane_info(quadplane_log({ mode: { TimeUS: [10e6, 40e6], Mode: [17, 5] } }))
    assert.deepEqual([info.flight.start, info.flight.end, info.flight.duration_s, info.flight.modes, info.flight.segments], [17, 38, 21, [17], []])
    assert.ok(Math.abs(info.flight.mean_throttle - 0.45) < 1e-9, String(info.flight.mean_throttle))
})

test('log_info Copter с MODE: окно — весь полёт с газом, как без MODE; полей окна VTOL нет', () => {
    const n = 61
    const TimeUS = Array.from({ length: n }, (_, i) => i * 1e6)
    const messages = {
        ATT: { TimeUS, Roll: new Array(n).fill(0), Pitch: new Array(n).fill(0) },
        CTUN: { TimeUS, ThO: TimeUS.map((_, i) => (i >= 5 && i <= 55) ? 0.35 : 0) },
    }
    const without = core_log.log_info(fake_log({ messages }), copter_version, copter)
    // STABILIZE → ACRO → ALT_HOLD → LAND внутри полёта: режимы окно Copter не делят
    const with_mode = core_log.log_info(fake_log({ messages: { ...messages, MODE: { TimeUS: [2e6, 20e6, 30e6, 50e6], Mode: [0, 1, 2, 9] } } }), copter_version, copter)
    assert.equal(with_mode.messages.mode, true)
    assert.deepEqual(with_mode.flight, without.flight)
    assert.deepEqual(Object.keys(with_mode.flight), ['start', 'end', 'duration_s', 'mean_throttle'])
    assert.deepEqual([with_mode.flight.start, with_mode.flight.end], [6, 54])
})

test('log_info: Plane без Q_ENABLE (0 и без параметра) — вид не поддержан, сведения как до этапа 9', () => {
    for (const Q_ENABLE of [0, null]) {
        const info = quadplane_info(quadplane_log({ params: { Q_ENABLE } }))
        assert.equal(info.kind, null, 'Q_ENABLE = ' + Q_ENABLE)
        assert.equal(info.profile, null)
        assert.equal(info.vehicle, 'Plane')
        // Без профиля — газ CTUN.ThO (у Plane — самолётный мотор, здесь нули) и PIDR, рама по «Frame: »
        assert.equal(info.throttle_source, 'CTUN.ThO')
        assert.equal(info.flight, null)
        assert.deepEqual(Object.keys(info.pid_log_rates), ['PIDR', 'RATE'])
        assert.equal(info.frame, null)
    }
})

// Лог с сообщениями names (по умолчанию PIDR/PIDP/PIDY) с частотой hz на участках segments [начало, конец) в секундах
function pid_rate_log(hz, names = ['PIDR', 'PIDP', 'PIDY'], segments = [[0, 60]]) {
    const TimeUS = []
    for (const [t0, t1] of segments) {
        for (let i = 0; i < Math.round((t1 - t0) * hz); i++) {
            TimeUS.push(Math.round((t0 + i / hz) * 1e6))
        }
    }
    return fake_log({ messages: Object.fromEntries(names.map((name) => [name, { TimeUS }])) })
}

test('log_info: частоты PIDR и RATE; пропуски не мешают', () => {
    const rates_of = (log) => core_log.log_info(log, copter_version, copter).pid_log_rates
    assert.deepEqual(rates_of(pid_rate_log(400)), { PIDR: 400, RATE: null })
    // Пропуск 30 с (лог на земле не пишется) — частота та же
    assert.deepEqual(rates_of(pid_rate_log(400, ['PIDR', 'PIDP', 'PIDY'], [[0, 20], [50, 80]])), { PIDR: 400, RATE: null })
    assert.deepEqual(rates_of(pid_rate_log(10, ['RATE'])), { PIDR: null, RATE: 10 })
    // Без отсчётов (объявлено без строк) и без PID/RATE — null
    assert.deepEqual(rates_of(fake_log({ messages: { PIDR: {}, ATT: { TimeUS: [0, 1e6] } } })), { PIDR: null, RATE: null })
})

test('log_message_rate: дрожание меток усредняется, частые выпадения по 2–3 интервала снижают частоту, сообщение с экземплярами — null', () => {
    // Метки 400 Гц с дрожанием ±300 мкс (детерминированно, среднее — 2500 мкс): медиана здесь дала бы не 400 Гц
    const jitter = [0]
    for (let i = 1; i < 4000; i++) {
        jitter.push(i * 2500 + ((i * 7919) % 601) - 300)
    }
    const jittered = core_log.log_message_rate(fake_log({ messages: { PIDR: { TimeUS: jitter } } }), 'PIDR')
    assert.ok(Math.abs(jittered - 400) < 0.05, 'дрожание: ' + jittered)
    // Выпадения: интервалы по кругу 2500, 2500, 2500, 5000 мкс (выпал каждый пятый отсчёт) — 320 отсчётов в секунду;
    // 2500, 2500, 7500 — 240. Интервалы не длиннее 5 медиан — не пропуски: так же режет пакеты шаг 4 (порог разрыва ×5)
    const with_drops = (pattern) => {
        const t = [0]
        for (let i = 0; i < 3600; i++) {
            t.push(t[t.length - 1] + pattern[i % pattern.length])
        }
        return core_log.log_message_rate(fake_log({ messages: { PIDR: { TimeUS: t } } }), 'PIDR')
    }
    assert.ok(Math.abs(with_drops([2500, 2500, 2500, 5000]) - 320) < 1e-9)
    assert.ok(Math.abs(with_drops([2500, 2500, 7500]) - 240) < 1e-9)
    // Сообщение с экземплярами — null без исключения (get() на нём падает)
    const vibe = fake_log({ messages: { VIBE: { instances: { 0: { TimeUS: [0, 1e5, 2e5] } } } } })
    assert.equal(core_log.log_message_rate(vibe, 'VIBE'), null)
    assert.equal(core_log.log_message_rate(vibe, 'NOPE'), null)
})

test('log_info: ATT объявлен, но без строк (нет полей) — длительность из RATE, без исключения', () => {
    // Парсер отдаёт undefined для поля сообщения без строк; поддельный лог ведёт себя так же
    const log = fake_log({ messages: { ATT: {}, RATE: { TimeUS: [0, 1e6, 2e6, 3e6], AOut: [0, 0, 0, 0] } } })
    const info = core_log.log_info(log, copter_version, copter)
    assert.equal(info.duration_s, 3)
    assert.equal(info.time_start, 0)
    assert.equal(info.time_end, 3)
})

test('log_info: без ATT, RATE и CTUN границы — из ISBH.SampleUS, GYR.SampleUS или первого из короткого списка обычных сообщений (аудит, I3)', () => {
    const bounds = (messages) => {
        const info = core_log.log_info(fake_log({ messages }), copter_version, copter)
        return [info.time_start, info.time_end, info.duration_s]
    }
    // Batch-лог без сообщений положения: границы по заголовкам пакетов
    assert.deepEqual(bounds({ ISBH: { N: [0, 1, 2], SampleUS: [10e6, 11e6, 12e6] }, PARM: { TimeUS: [1e6, 1e6] } }), [10, 12, 2])
    // Raw-лог: GYR по экземплярам (читается через get_instance), объединение по всем экземплярам
    assert.deepEqual(bounds({ GYR: { instances: { 0: { SampleUS: [20e6, 25e6] }, 1: { SampleUS: [21e6, 26e6] } } } }), [20, 26, 6])
    // Ни того ни другого: крайние TimeUS первого подходящего из короткого списка (RCOU, RCIN, PM, XKF1, …) — не всех
    // сообщений лога (ревью: get по каждому типу — лишний разбор); MSG в списке нет, сообщения с экземплярами (VIBE)
    // и из списка (IMU с экземплярами) пропускаются без чтения — get на них падает
    assert.deepEqual(bounds({ XKF1: { TimeUS: [5e6, 9e6] }, MSG: { TimeUS: [4e6, 6e6], Message: ['a', 'b'] }, VIBE: { instances: { 0: { TimeUS: [0, 50e6] } } },
                             IMU: { instances: { 0: { TimeUS: [0, 50e6] } } } }), [5, 9, 4])
    // Первое подходящее по порядку списка: RCOU раньше XKF1; сообщение списка с одним отсчётом (MODE) пропускается,
    // объявленное без строк (PM) — тоже
    assert.deepEqual(bounds({ XKF1: { TimeUS: [5e6, 9e6] }, RCOU: { TimeUS: [3e6, 8e6] } }), [3, 8, 5])
    assert.deepEqual(bounds({ MODE: { TimeUS: [7e6] }, PM: {}, XKF1: { TimeUS: [5e6, 9e6] } }), [5, 9, 4])
    // ATT в приоритете, как раньше; сообщение с одним отсчётом границ не задаёт; сообщение не из списка не считается
    assert.deepEqual(bounds({ ATT: { TimeUS: [1e6, 3e6] }, ISBH: { SampleUS: [10e6, 12e6] } }), [1, 3, 2])
    assert.deepEqual(bounds({ XKF1: { TimeUS: [5e6] } }), [null, null, null])
    assert.deepEqual(bounds({ MSG: { TimeUS: [4e6, 6e6], Message: ['a', 'b'] } }), [null, null, null])
    assert.deepEqual(bounds({}), [null, null, null])
    assert.deepEqual(core_log.log_time_bounds(fake_log({ messages: { ISBH: { SampleUS: [10e6, 12e6] } } })), { start: 10e6, end: 12e6 })
})

const checks = require('../TuneWizard/core/checks.js')

// Сведения о хорошем логе Copter; тесты переопределяют нужные поля
function good_info(over = {}) {
    return {
        vehicle: 'Copter', kind: 'copter', profile: copter, tailsitter: false,
        fw_string: 'ArduCopter V4.6.0', board: 'CubeOrange', filter_version: 2, duration_s: 120,
        messages: { pid: true, rate: true, gyro_raw: true, gyro_batch: false, esc: true, rpm: false, vibe: true, ctun: true, att: true, pos: true, ftn: false },
        esc: { instances: 4, with_rpm: 4 },
        throttle_source: 'CTUN.ThO',
        flight: { start: 5, end: 100, duration_s: 95, mean_throttle: 0.33 },
        ...over
    }
}
function fake_params(values) {
    return { get: (name) => (name in values) ? values[name] : null, has: (name) => name in values }
}
const good_params = fake_params({ MOT_THST_HOVER: 0.35, MOT_HOVER_LEARN: 2, INS_RAW_LOG_OPT: 8, INS_GYRO_FILTER: 40 })
const good_vibe = { imus: [{ imu: 0, level: 12, max: 20, clip: 0 }], level: 12, max: 20, clip: 0 }

function by_id(list, id) {
    const found = list.find((c) => c.id === id)
    assert.ok(found, `нет проверки ${id}`)
    return found
}

test('run_checks: хороший лог — все проверки ok', () => {
    const list = checks.run_checks(good_info(), good_params, good_vibe)
    for (const c of list) assert.equal(c.status, 'ok', `${c.id}: ${c.text}`)
    // Полный набор проверок в порядке показа
    assert.deepEqual(list.map((c) => c.id), ['vehicle', 'pid_log', 'gyro_log', 'pre_post', 'tracking', 'flight', 'vibe', 'clipping', 'hover_throttle'])
    assert.equal(checks.checks_summary(list).status, 'ok')
})

test('run_checks: вид не поддержан (Plane без Q_ENABLE) — fail, итог fail; проверок PID, полёта и газа висения нет', () => {
    const list = checks.run_checks(good_info({ vehicle: 'Plane', kind: null, profile: null }), good_params, good_vibe)
    const c = by_id(list, 'vehicle')
    assert.equal(c.status, 'fail')
    assert.equal(c.text, 'Лог от Plane; мастер поддерживает Copter и QuadPlane')
    assert.equal(c.fix, 'Загрузите лог ArduCopter или ArduPlane с Q_ENABLE ≥ 1')
    assert.equal(checks.checks_summary(list).status, 'fail')
    // У неподдержанного аппарата PIDR, газ и THST_HOVER судить не по чему (у Plane PIDR — самолётные регуляторы, бит 12 — CAMERA)
    assert.deepEqual(list.map((x) => x.id), ['vehicle', 'gyro_log', 'pre_post', 'tracking', 'vibe', 'clipping'])
    // Сведения без поля profile (старые или чужие) — так же
    const no_profile = good_info({ vehicle: 'Rover' })
    delete no_profile.profile
    assert.deepEqual(checks.run_checks(no_profile, good_params, good_vibe).map((x) => x.id), ['vehicle', 'gyro_log', 'pre_post', 'tracking', 'vibe', 'clipping'])
})

test('run_checks: PID — ok / warn (только RATE) / fail', () => {
    const only_rate = good_info({ messages: { ...good_info().messages, pid: false, rate: true } })
    const rate_check = by_id(checks.run_checks(only_rate, good_params, good_vibe), 'pid_log')
    assert.equal(rate_check.status, 'warn')
    // Что по RATE остаётся на шаге 4: только отклик и правила
    assert.equal(rate_check.text, 'Есть только RATE: по нему на шаге 4 нет компонент P/I/D, шума D и прогноза — только отклик и правила')
    const none = good_info({ messages: { ...good_info().messages, pid: false, rate: false } })
    assert.equal(by_id(checks.run_checks(none, good_params, good_vibe), 'pid_log').status, 'fail')
})

test('run_checks: PID с частотой ниже 100 Гц — warn с советом включить ATTITUDE_FAST (бит 0); 400 Гц — ok', () => {
    // Поддельный лог → log_info → run_checks: частоту проверка берёт из сведений о логе
    const pid_check = (log) => by_id(checks.run_checks(core_log.log_info(log, copter_version, copter), good_params, good_vibe), 'pid_log')
    const slow = pid_check(pid_rate_log(10))
    assert.equal(slow.status, 'warn')
    assert.match(slow.text, /PIDR .*10 Гц/)
    assert.match(slow.text, /шаге 4/)
    assert.match(slow.fix, /ATTITUDE_FAST \(0\)/)
    assert.match(slow.fix, /LOG_BITMASK/)
    const fast = pid_check(pid_rate_log(400))
    assert.equal(fast.status, 'ok')
    assert.match(fast.text, /400 Гц/)
    // Только RATE с частотой 10 Гц: warn, в тексте — и нехватка компонент, и частота; совет — оба бита
    const rate_only = pid_check(pid_rate_log(10, ['RATE']))
    assert.equal(rate_only.status, 'warn')
    assert.match(rate_only.text, /только RATE: по нему на шаге 4 нет компонент P\/I\/D, шума D и прогноза — только отклик и правила/)
    assert.match(rate_only.text, /RATE .*10 Гц/)
    assert.match(rate_only.fix, /PID \(12\)/)
    assert.match(rate_only.fix, /ATTITUDE_FAST \(0\)/)
    // Без сведений о частоте (например, старые сведения) — как раньше
    assert.equal(by_id(checks.run_checks(good_info(), good_params, good_vibe), 'pid_log').status, 'ok')
    // Порог с запасом: около 100 Гц (дрожание меток) — ok; 98.97 Гц — warn, в тексте «98.9» (без округления вверх)
    const at_rate = (PIDR) => by_id(checks.run_checks(good_info({ pid_log_rates: { PIDR, RATE: null } }), good_params, good_vibe), 'pid_log')
    assert.equal(at_rate(99.95).status, 'ok')
    assert.match(at_rate(99.95).text, /99\.9 Гц/)
    assert.equal(at_rate(100.05).status, 'ok')
    assert.equal(pid_check(pid_rate_log(99.95)).status, 'ok')
    assert.equal(pid_check(pid_rate_log(100.05)).status, 'ok')
    assert.equal(at_rate(98.97).status, 'warn')
    assert.match(at_rate(98.97).text, /PIDR пишется с частотой 98\.9 Гц — ниже 100 Гц/)
    // PIDR/PIDP/PIDY объявлены без отсчётов, RATE с частотой 10 Гц: ветка PID, частота PIDR неизвестна — о RATE ни слова
    const empty_pid = fake_log({ messages: { PIDR: {}, PIDP: {}, PIDY: {}, RATE: { TimeUS: Array.from({ length: 600 }, (_, i) => i * 1e5) } } })
    const empty = pid_check(empty_pid)
    assert.equal(empty.status, 'ok')
    assert.doesNotMatch(empty.text, /RATE|Гц/)
})

test('run_checks: нет данных гироскопа — fail с подсказкой', () => {
    const info = good_info({ messages: { ...good_info().messages, gyro_raw: false, gyro_batch: false } })
    const c = by_id(checks.run_checks(info, good_params, good_vibe), 'gyro_log')
    assert.equal(c.status, 'fail')
    assert.match(c.fix, /INS_LOG_BAT_MASK/)
    // Raw — основной гироскоп до и после фильтров одним INS_RAW_LOG_OPT = 9: бит 0 сам включает запись, IMU_RAW не нужен
    assert.equal(c.fix, 'Batch: INS_LOG_BAT_MASK = 1, INS_LOG_BAT_OPT = 4. Raw (нужна быстрая плата, обычно H7): ' +
        'INS_RAW_LOG_OPT = 9 (основной гироскоп до и после фильтров; бит IMU_RAW не нужен)')
    assert.doesNotMatch(c.fix, /INS_RAW_LOG_OPT = 8/)
    // Нет INS_RAW_LOG_OPT (старая прошивка) — raw включается только битом IMU_RAW, как в подсказке подготовки
    const old_fw = by_id(checks.run_checks(info, fake_params({ MOT_THST_HOVER: 0.35, MOT_HOVER_LEARN: 2 }), good_vibe), 'gyro_log')
    assert.match(old_fw.fix, /Raw \(нужна быстрая плата, обычно H7\): бит IMU_RAW \(19\) в LOG_BITMASK \(\+524288; INS_RAW_LOG_OPT в этой прошивке нет\)$/)
    assert.doesNotMatch(old_fw.fix, /INS_RAW_LOG_OPT = /)
    // Значения совета — из check_rules (их же берёт подготовка, core/prep.js)
    assert.deepEqual(checks.check_rules.gyro_batch_fix, { INS_LOG_BAT_MASK: 1, INS_LOG_BAT_OPT: 4 })
    assert.equal(checks.check_rules.gyro_raw_hint, 9)
})

test('run_checks: raw pre/post по INS_RAW_LOG_OPT', () => {
    const post_only = fake_params({ INS_RAW_LOG_OPT: 4 })
    const c = by_id(checks.run_checks(good_info(), post_only, good_vibe), 'pre_post')
    assert.equal(c.status, 'warn')
    // Совет добавляет бит, а не перезаписывает параметр: иначе пропадут другие включённые биты
    assert.match(c.fix, /\+8/)
    const pre_only = fake_params({ INS_RAW_LOG_OPT: 0 })
    assert.equal(by_id(checks.run_checks(good_info(), pre_only, good_vibe), 'pre_post').status, 'ok')
})

test('run_checks: batch pre/post по INS_LOG_BAT_OPT', () => {
    const info = good_info({ messages: { ...good_info().messages, gyro_raw: false, gyro_batch: true } })
    assert.equal(by_id(checks.run_checks(info, fake_params({ INS_LOG_BAT_OPT: 4 }), good_vibe), 'pre_post').status, 'ok')
    // Только после фильтров (бит 1, и с битом 0) — одно исправление: INS_LOG_BAT_OPT = 4 и перезагрузка — снятый бит 1
    // действует только после неё: флаги batch только выставляются [код] BatchSampler.cpp:97–102
    for (const opt of [2, 3]) {
        const c = by_id(checks.run_checks(info, fake_params({ INS_LOG_BAT_OPT: opt }), good_vibe), 'pre_post')
        assert.equal(c.status, 'warn', 'INS_LOG_BAT_OPT = ' + opt)
        assert.equal(c.fix, 'Запишите INS_LOG_BAT_OPT = 4 (только бит 2 — до и после фильтров) и перезагрузите полётный контроллер: ' +
            'флаг «после фильтров» сбрасывается только перезагрузкой')
    }
    // Только до фильтров — норма, оценка «станет» строится расчётом
    assert.equal(by_id(checks.run_checks(info, fake_params({ INS_LOG_BAT_OPT: 0 }), good_vibe), 'pre_post').status, 'ok')
})

test('run_checks: batch — бит 2 INS_LOG_BAT_OPT вместе с битом 1 или 0 — warn с причиной, исправление INS_LOG_BAT_OPT = 4; только бит 2 — ok', () => {
    const info = good_info({ messages: { ...good_info().messages, gyro_raw: false, gyro_batch: true } })
    const pre_post_of = (opt) => by_id(checks.run_checks(info, fake_params({ INS_LOG_BAT_OPT: opt }), good_vibe), 'pre_post')
    const fix = 'Запишите INS_LOG_BAT_OPT = 4 (только бит 2 — до и после фильтров) и перезагрузите полётный контроллер'
    const sensor_rate = 'на датчиках с выборкой на частоте датчика (Invensense v1/v2 по SPI) обе половины — сырые, до фильтров'

    // Только бит 2 — до и после фильтров
    const good = pre_post_of(4)
    assert.equal(good.status, 'ok')
    assert.equal(good.fix, null)

    // 6 — бит 1 без бита 0: флаг «после фильтров» включён, обе половины после фильтров
    const post = pre_post_of(6)
    assert.equal(post.status, 'warn')
    assert.equal(post.text, 'Batch-лог с INS_LOG_BAT_OPT = 6: бит 2 (до и после) вместе с битом 1 (после фильтров) — обе половины пишутся ' +
        'после фильтров: спектр «до фильтров» на шаге 1 на самом деле после фильтров')
    assert.equal(post.fix, fix + ': флаг «после фильтров» сбрасывается только перезагрузкой')

    // 5 — бит 0 (Sensor-Rate): на датчиках с выборкой на частоте датчика (Invensense v1/v2) batch берёт только сырые
    // отсчёты. Тип гироскопа — по INS_GYR*_ID через decode_devid (Libraries/DecodeDevID.js, глобал страницы): здесь
    // (require, без него) и без параметров тип не определить — warn с оговоркой; типы датчиков — tests/tunewizard-prep.test.cjs
    const raw = pre_post_of(5)
    assert.equal(raw.status, 'warn')
    assert.equal(raw.text, 'Batch-лог с INS_LOG_BAT_OPT = 5: бит 2 (до и после) вместе с битом 0 (Sensor-Rate) — тип гироскопа не определить: ' +
        'если датчик Invensense v1/v2 (по SPI с быстрой выборкой), обе половины batch — сырые, до фильтров: спектр «после фильтров» на шаге 1 на самом деле до фильтров')
    assert.equal(raw.fix, fix)
    assert.equal(by_id(checks.run_checks(info, fake_params({ INS_LOG_BAT_OPT: 5, INS_LOG_BAT_MASK: 1, INS_GYR_ID: 3866890 }), good_vibe), 'pre_post').status, 'warn',
        'без decode_devid тип не определить и по INS_GYR_ID')

    // 7 — биты 0 и 1: на таких датчиках обе сырые, на остальных бит 1 — обе после фильтров
    const both = pre_post_of(7)
    assert.equal(both.status, 'warn')
    assert.equal(both.text, 'Batch-лог с INS_LOG_BAT_OPT = 7: бит 2 (до и после) вместе с битом 0 (Sensor-Rate) и битом 1 (после фильтров) — ' +
        sensor_rate + ', на остальных бит 1 даёт обе после фильтров: «до» и «после» на шаге 1 не различаются')
    assert.equal(both.fix, fix + ': флаг «после фильтров» сбрасывается только перезагрузкой')

    // Raw-лог от INS_LOG_BAT_OPT не зависит: оценивается INS_RAW_LOG_OPT
    assert.equal(by_id(checks.run_checks(good_info(), fake_params({ INS_RAW_LOG_OPT: 9, INS_LOG_BAT_OPT: 6 }), good_vibe), 'pre_post').status, 'ok')
})

test('run_checks: источник трекинга — ESC ok, RPM ok, только газ warn', () => {
    const rpm = good_info({ messages: { ...good_info().messages, esc: false, rpm: true }, esc: null })
    assert.equal(by_id(checks.run_checks(rpm, good_params, good_vibe), 'tracking').status, 'ok')
    const throttle = good_info({ messages: { ...good_info().messages, esc: false, rpm: false }, esc: null })
    assert.equal(by_id(checks.run_checks(throttle, good_params, good_vibe), 'tracking').status, 'warn')
})

test('run_checks: ESC без оборотов (все 0 или NaN) — warn, хоть один экземпляр с оборотами — ok (аудит, I4)', () => {
    // Сводка из log_info: экземпляры есть, оборотов ни у одного
    const none = by_id(checks.run_checks(good_info({ esc: { instances: 4, with_rpm: 0 } }), good_params, good_vibe), 'tracking')
    assert.equal(none.status, 'warn')
    assert.match(none.text, /оборотов в ней нет/)
    assert.match(none.fix, /SERVO_BLH_MASK/)
    assert.equal(by_id(checks.run_checks(good_info({ esc: { instances: 4, with_rpm: 1 } }), good_params, good_vibe), 'tracking').status, 'ok')
    // ESC объявлен, а сводки нет (сообщение без строк) — тоже warn
    assert.equal(by_id(checks.run_checks(good_info({ esc: null }), good_params, good_vibe), 'tracking').status, 'warn')
    // Поддельный лог → log_info → run_checks: NaN и нули не считаются оборотами
    const esc_log = (RPM) => core_log.log_info(fake_log({ messages: {
        ATT: { TimeUS: [0, 1e6] },
        ESC: { instances: { 0: { TimeUS: [0, 1e6, 2e6], RPM }, 1: { TimeUS: [0, 1e6, 2e6], RPM: [0, 0, 0] } } }
    } }), copter_version, copter)
    const dead = esc_log([0, NaN, 0])
    assert.deepEqual(dead.esc, { instances: 2, with_rpm: 0 })
    assert.equal(dead.messages.esc, true)
    assert.equal(by_id(checks.run_checks(dead, good_params, good_vibe), 'tracking').status, 'warn')
    const alive = esc_log([0, NaN, 3000])
    assert.deepEqual(alive.esc, { instances: 2, with_rpm: 1 })
    assert.equal(by_id(checks.run_checks(alive, good_params, good_vibe), 'tracking').status, 'ok')
    assert.equal(core_log.log_info(fake_log(), copter_version, copter).esc, null, 'без ESC сводки нет')
})

test('run_checks: полёт — нет газа fail, короткий warn', () => {
    assert.equal(by_id(checks.run_checks(good_info({ flight: null }), good_params, good_vibe), 'flight').status, 'fail')
    const short = good_info({ flight: { start: 5, end: 25, duration_s: 20, mean_throttle: 0.33 } })
    assert.equal(by_id(checks.run_checks(short, good_params, good_vibe), 'flight').status, 'warn')
    // Без CTUN и RATE газ вообще не определить — текст говорит об этом, а не о «нулевом газе»
    const no_source = by_id(checks.run_checks(good_info({ flight: null, throttle_source: null }), good_params, good_vibe), 'flight')
    assert.equal(no_source.status, 'fail')
    assert.match(no_source.text, /CTUN и RATE/)
})

test('run_checks: вибрации — пороги 30/60 и clipping', () => {
    const warn = { ...good_vibe, level: 45 }
    assert.equal(by_id(checks.run_checks(good_info(), good_params, warn), 'vibe').status, 'warn')
    const fail = { ...good_vibe, level: 70 }
    assert.equal(by_id(checks.run_checks(good_info(), good_params, fail), 'vibe').status, 'fail')
    const clip = { ...good_vibe, clip: 5 }
    assert.equal(by_id(checks.run_checks(good_info(), good_params, clip), 'clipping').status, 'warn')
    assert.equal(by_id(checks.run_checks(good_info(), good_params, null), 'vibe').status, 'warn')
    // Рядом с порогом уровень печатается с одной десятичной: 59.6 — warn, и не показывается как «60»
    const near = by_id(checks.run_checks(good_info(), good_params, { ...good_vibe, level: 59.6 }), 'vibe')
    assert.equal(near.status, 'warn')
    assert.match(near.text, /59\.6/)
    // Некорректный уровень (NaN) — warn без исключения, clipping проверяется как обычно
    const broken = checks.run_checks(good_info(), good_params, { ...good_vibe, level: NaN })
    assert.equal(by_id(broken, 'vibe').status, 'warn')
    assert.equal(by_id(broken, 'clipping').status, 'ok')
})

test('run_checks: газ висения против MOT_THST_HOVER', () => {
    const far = fake_params({ MOT_THST_HOVER: 0.5, MOT_HOVER_LEARN: 0 })
    const c = by_id(checks.run_checks(good_info(), far, good_vibe), 'hover_throttle')
    assert.equal(c.status, 'warn')
    assert.match(c.fix, /MOT_HOVER_LEARN/)
    const close = fake_params({ MOT_THST_HOVER: 0.31 })
    assert.equal(by_id(checks.run_checks(good_info(), close, good_vibe), 'hover_throttle').status, 'ok')
})

test('run_checks: газ висения ниже предела обучения 0.125 — предупреждение упоминает предел', () => {
    const info = good_info({ flight: { start: 5, end: 100, duration_s: 95, mean_throttle: 0.11 } })
    const params = fake_params({ MOT_THST_HOVER: 0.3, MOT_HOVER_LEARN: 0 })
    const c = by_id(checks.run_checks(info, params, good_vibe), 'hover_throttle')
    assert.equal(c.status, 'warn')
    assert.match(c.text, /0\.125/)
})

test('run_checks: газ висения — расхождение считается к достижимому обученному значению', () => {
    // Средний газ ниже предела: обучение дало бы ровно 0.125, и MOT_THST_HOVER = 0.125 — норма, а не расхождение
    const low = good_info({ flight: { start: 5, end: 100, duration_s: 95, mean_throttle: 0.05 } })
    const at_limit = by_id(checks.run_checks(low, fake_params({ MOT_THST_HOVER: 0.125, MOT_HOVER_LEARN: 0 }), good_vibe), 'hover_throttle')
    assert.equal(at_limit.status, 'ok')
    assert.match(at_limit.text, /0\.125/)
    // Обучение включено, но значение далеко от газа: висения в AltHold было мало
    const learning = by_id(checks.run_checks(good_info(), fake_params({ MOT_THST_HOVER: 0.5, MOT_HOVER_LEARN: 2 }), good_vibe), 'hover_throttle')
    assert.equal(learning.status, 'warn')
    assert.match(learning.fix, /AltHold/)
})

// Проверки QuadPlane по поддельному логу, как на странице: log_params → вид → log_info → run_checks
function quadplane_checks(over = {}, vibe = good_vibe) {
    const log = quadplane_log(over)
    return checks.run_checks(quadplane_info(log), core_log.log_params(log), vibe)
}

test('run_checks QuadPlane: аппарат, сообщения PID VTOL (без совета «бит 12», с битом 20), полёт VTOL, газ висения по Q_M_*', () => {
    const list = quadplane_checks()
    assert.deepEqual(list.map((c) => c.id), ['vehicle', 'pid_log', 'gyro_log', 'pre_post', 'tracking', 'flight', 'vibe', 'clipping', 'hover_throttle'])
    const v = by_id(list, 'vehicle')
    assert.equal(v.status, 'ok')
    assert.equal(v.text, 'QuadPlane (tailsitter), ArduPlane V4.6.3 (84451727), DEFD-H7-Basic-V3.1')
    assert.equal(by_id(quadplane_checks({ params: { Q_TAILSIT_ENABLE: 0 } }), 'vehicle').text, 'QuadPlane, ArduPlane V4.6.3 (84451727), DEFD-H7-Basic-V3.1')

    // PIQR 25 Гц (самолётный PIDR — 50 Гц — не в счёт): ВНИМ, шаг 4 для QuadPlane закрыт, совет — бит 20, не бит 12
    const pid = by_id(list, 'pid_log')
    assert.equal(pid.status, 'warn')
    assert.equal(pid.title, 'Сообщения PID VTOL')
    assert.equal(pid.text, 'PIQR/PIQP/PIQY есть, но PIQR пишется с частотой 25 Гц — ниже 100 Гц отклик на ступеньку не считается; ' +
        'шаг 4 для QuadPlane пока недоступен')
    // Частота без бита 20 — по битам лога (LOG_BITMASK 65535 — с ATTITUDE_FAST): фраза check_plane_pid_rate_text, одна с
    // правилом подготовки log_fast (core/prep.js)
    assert.equal(pid.fix, 'Включите бит ATTITUDE_FULLRATE (20) в LOG_BITMASK (+1048576) — для будущего шага 4: без него PIQR/PIQP/PIQY ' +
        'пишутся с частотой 25 Гц (бит ATTITUDE_FAST, 0)')
    assert.doesNotMatch(pid.fix, /PID \(12\)|бит 12/)
    // С частотой цикла — ok; PIQx нет — ВНИМ (не СТОП: шагу 4 QuadPlane эта проверка пока не нужна)
    const fast = by_id(quadplane_checks({ piq_hz: 400 }), 'pid_log')
    assert.equal(fast.status, 'ok')
    assert.equal(fast.text, 'PIQR/PIQP/PIQY есть (400 Гц); шаг 4 для QuadPlane пока недоступен')
    assert.equal(fast.fix, null)
    const none = by_id(quadplane_checks({ piq_hz: null }), 'pid_log')
    assert.equal(none.status, 'warn')
    // PIQx нет при включённом бите записи положения (65535 — ATTITUDE_FAST и MED): они пишутся, только пока работает
    // регулятор VTOL (ArduPlane/Log.cpp:30) — совет без частоты «без бита 20», иначе противоречие с «нет» (ревью задачи 6)
    assert.equal(none.text, 'Сообщений PIQR/PIQP/PIQY нет: они пишутся, только пока работает регулятор VTOL (бит записи положения в LOG_BITMASK ' +
        'включён); шаг 4 для QuadPlane пока недоступен')
    assert.equal(none.fix, 'Включите бит ATTITUDE_FULLRATE (20) в LOG_BITMASK (+1048576) — для будущего шага 4: с ним PIQR/PIQP/PIQY пишутся с частотой ' +
        'цикла — тоже только при работающем регуляторе VTOL')
    assert.doesNotMatch(none.fix, /25 Гц|10 Гц/)
    // Одного ATTITUDE_MED — так же; бит 20 уже включён — совета нет
    assert.equal(by_id(quadplane_checks({ piq_hz: null, params: { LOG_BITMASK: 2 } }), 'pid_log').text, none.text)
    const none_full = by_id(quadplane_checks({ piq_hz: null, params: { LOG_BITMASK: 1114111 } }), 'pid_log')
    assert.deepEqual([none_full.status, none_full.text, none_full.fix], ['warn', none.text, null])
    // Без ATTITUDE_FAST и ATTITUDE_MED PIQx не пишутся вовсе; с одним ATTITUDE_MED — 10 Гц; LOG_BITMASK нет — все случаи
    assert.match(by_id(quadplane_checks({ piq_hz: null, params: { LOG_BITMASK: 65532 } }), 'pid_log').fix,
        /: без него PIQR\/PIQP\/PIQY не пишутся вовсе: в LOG_BITMASK нет ни ATTITUDE_FAST \(0\), ни ATTITUDE_MED \(1\)$/)
    assert.match(by_id(quadplane_checks({ piq_hz: 10, params: { LOG_BITMASK: 65534 } }), 'pid_log').fix, /: без него PIQR\/PIQP\/PIQY пишутся с частотой 10 Гц \(только бит ATTITUDE_MED, 1\)$/)
    assert.match(by_id(quadplane_checks({ params: { LOG_BITMASK: null } }), 'pid_log').fix, /25 Гц \(бит ATTITUDE_FAST, 0\) или 10 Гц \(только бит ATTITUDE_MED, 1\), а без обоих не пишутся вовсе$/)

    // Полёт — самый длинный VTOL-участок, остальные названы
    const flight = by_id(list, 'flight')
    assert.equal(flight.status, 'ok')
    assert.equal(flight.text, 'Висение VTOL 66 с (102–168 с, QHOVER, QLAND), средний газ 0.47; ещё VTOL: 17–53 с (QSTABILIZE)')

    // Газ висения: Q_M_THST_HOVER против среднего газа VTOL-окна; обучение выключено — Q_M_HOVER_LEARN = 2 и режимы обучения
    const hover = by_id(list, 'hover_throttle')
    assert.equal(hover.status, 'warn')
    assert.equal(hover.text, 'Q_M_THST_HOVER 0.35, средний газ VTOL 0.47: расхождение 0.12')
    // Условия обучения — и полёт: оценка воздушной скорости, вертикальная скорость, крен и тангаж [код] quadplane.cpp:1948–1953
    const learn_note = 'в QSTABILIZE и QACRO газ висения не учится; учится только при оценке воздушной скорости ниже 0.3·AIRSPEED_MIN (без датчика скорости ' +
        'и GPS её нет), вертикальной скорости меньше 0.6 м/с, крене и тангаже меньше 5°'
    assert.equal(hover.fix, 'Q_M_HOVER_LEARN = 2 (обучение с сохранением) и висение не меньше 30 с в QHOVER или QLOITER: ' + learn_note)
    // Обучение включено — повисеть в QHOVER или QLOITER
    const learning = by_id(quadplane_checks({ params: { Q_M_HOVER_LEARN: 2 } }), 'hover_throttle')
    assert.equal(learning.text, 'Q_M_THST_HOVER 0.35, средний газ VTOL 0.47: расхождение 0.12 (обучение включено: большое расхождение значит, ' +
        'что висения в QHOVER или QLOITER было мало)')
    assert.equal(learning.fix, 'Повисите не меньше 30 с в QHOVER или QLOITER, чтобы значение обучилось: ' + learn_note)
    assert.equal(by_id(quadplane_checks({ params: { Q_M_THST_HOVER: 0.46 } }), 'hover_throttle').status, 'ok')
    // MOT_THST_HOVER у QuadPlane не читается
    assert.equal(quadplane_checks({ params: { Q_M_THST_HOVER: null, MOT_THST_HOVER: 0.3 } }).find((c) => c.id === 'hover_throttle'), undefined)
})

test('run_checks QuadPlane: полёт — короткий, без MODE, без VTOL-участков, без QTUN и RATE', () => {
    // Короткий: QSTABILIZE 30–56 с (газ 30.05–54.95 → 32–53) и QHOVER 100–120 с (102–118) — оба короче 30 с, второй назван
    const short = by_id(quadplane_checks({ mode: { TimeUS: [10e6, 30e6, 56e6, 100e6, 120e6], Mode: [5, 17, 5, 18, 5] } }), 'flight')
    assert.equal(short.status, 'warn')
    assert.equal(short.text, 'Висение VTOL 21 с (32–53 с, QSTABILIZE): мало для усреднения спектра; ещё VTOL: 102–118 с (QHOVER)')
    assert.equal(short.fix, 'Висение не меньше 30 с без ввода')
    // Без MODE — окно по газу за весь лог (с FBWA), предупреждение. Средний газ 17–168 с: 380 отсчётов 0.45, 400 — 0.2,
    // 500 — 0.5, 180 — 0.4 → 573 / 1460 = 0.39
    const no_mode = by_id(quadplane_checks({ mode: null }), 'flight')
    assert.equal(no_mode.status, 'warn')
    assert.equal(no_mode.text, 'Висение VTOL 151 с (17–168 с), средний газ 0.39: в логе нет MODE — окно взято по газу, в него мог попасть самолётный полёт')
    assert.match(no_mode.fix, /интервал вручную/)
    // Без MODE и висение короче 30 с — «мало» и та же оговорка о самолётном полёте (газ 15–35 с → окно 17–33)
    const short_no_mode = by_id(quadplane_checks({ mode: null, throttle_at: (t) => (t >= 15 && t < 35) ? 0.45 : 0 }), 'flight')
    assert.equal(short_no_mode.status, 'warn')
    assert.equal(short_no_mode.text, 'Висение VTOL 16 с (17–33 с): мало для усреднения спектра; в логе нет MODE — в окно мог попасть самолётный полёт; ' +
        'проверьте интервал по графику')
    assert.equal(short_no_mode.fix, 'Висение не меньше 30 с без ввода')
    // С MODE короткое окно оговорки не получает
    assert.doesNotMatch(short.text, /MODE/)
    // MODE без VTOL-участков с газом — СТОП
    const fbwa = by_id(quadplane_checks({ mode: { TimeUS: [1e6], Mode: [5] } }), 'flight')
    assert.equal(fbwa.status, 'fail')
    assert.equal(fbwa.text, 'Участков VTOL-режимов (Q-режимов) с ненулевым газом дольше 3 с нет: VTOL-полёта в логе нет')
    assert.equal(by_id(quadplane_checks({ throttle_at: () => 0 }), 'flight').text, fbwa.text)
    // Без MODE и без газа VTOL-моторов — СТОП
    const zero = by_id(quadplane_checks({ mode: null, throttle_at: () => 0 }), 'flight')
    assert.equal(zero.status, 'fail')
    assert.equal(zero.text, 'Ненулевого газа VTOL-моторов нет или он короче 3 с: VTOL-полёта в логе нет')
    // Без QTUN и RATE — газ не определить: «нет QTUN и RATE», а не CTUN
    const no_source = by_id(quadplane_checks({ qtun: false, rate: false }), 'flight')
    assert.equal(no_source.status, 'fail')
    assert.equal(no_source.text, 'Газ не определить: в логе нет QTUN и RATE')
})

test('run_checks: Plane без Q_ENABLE — «Аппарат» СТОП, проверок PID, полёта и газа висения нет', () => {
    for (const Q_ENABLE of [0, null]) {
        const list = quadplane_checks({ params: { Q_ENABLE } })
        assert.equal(by_id(list, 'vehicle').status, 'fail', 'Q_ENABLE = ' + Q_ENABLE)
        assert.equal(by_id(list, 'vehicle').text, 'Лог от Plane; мастер поддерживает Copter и QuadPlane')
        assert.deepEqual(list.map((c) => c.id), ['vehicle', 'gyro_log', 'pre_post', 'tracking', 'vibe', 'clipping'])
    }
})

test('checks_summary: счётчики', () => {
    const s = checks.checks_summary([{ status: 'ok' }, { status: 'warn' }, { status: 'warn' }])
    assert.deepEqual(s, { status: 'warn', ok: 1, warn: 2, fail: 0 })
})

test('checks_summary: пустой список — ok с нулевыми счётчиками', () => {
    assert.deepEqual(checks.checks_summary([]), { status: 'ok', ok: 0, warn: 0, fail: 0 })
})
