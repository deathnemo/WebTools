// Тесты ядра мастера настройки (TuneWizard/core). Логи — поддельные объекты с интерфейсом парсера.
const test = require('node:test')
const assert = require('node:assert/strict')

const core_log = require('../TuneWizard/core/log.js')

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
    assert.ok(vibe.level >= 35 && vibe.level <= 45)
    assert.equal(core_log.vibe_summary(fake_log()), null)
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
    const info = core_log.log_info(log, copter_version)
    assert.equal(info.vehicle, 'Copter')
    assert.equal(info.fw_string, 'ArduCopter V4.6.0')
    assert.equal(info.board, 'CubeOrange')
    assert.equal(info.filter_version, 2)
    assert.equal(info.duration_s, 60)
    assert.equal(info.throttle_source, 'CTUN.ThO')
    assert.equal(info.flight.start, 6)
    assert.equal(info.flight.end, 54)
    assert.equal(info.flight.duration_s, 48)
    assert.ok(Math.abs(info.flight.mean_throttle - 0.35) < 1e-9)
    assert.equal(info.messages.pid, true)
})

test('log_info: без полёта и без ATT', () => {
    const log = fake_log({ messages: { RATE: { TimeUS: [0, 1e6, 2e6], AOut: [0, 0, 0] } } })
    const info = core_log.log_info(log, { build_type: 3 })
    assert.equal(info.vehicle, 'Plane')
    assert.equal(info.flight, null)
    assert.equal(info.duration_s, 2)
})
