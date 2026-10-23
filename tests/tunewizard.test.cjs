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
    const info = core_log.log_info(log, copter_version)
    assert.equal(info.vehicle, 'Copter')
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
    assert.equal(info.messages.pid, true)
})

test('log_info: без полёта и без ATT', () => {
    const log = fake_log({ messages: { RATE: { TimeUS: [0, 1e6, 2e6], AOut: [0, 0, 0] } } })
    const info = core_log.log_info(log, { build_type: 3 })
    assert.equal(info.vehicle, 'Plane')
    assert.equal(info.flight, null)
    assert.equal(info.duration_s, 2)
    assert.equal(info.time_start, 0)
    assert.equal(info.time_end, 2)
})

const checks = require('../TuneWizard/core/checks.js')

// Сведения о хорошем логе Copter; тесты переопределяют нужные поля
function good_info(over = {}) {
    return {
        vehicle: 'Copter', fw_string: 'ArduCopter V4.6.0', board: 'CubeOrange', filter_version: 2, duration_s: 120,
        messages: { pid: true, rate: true, gyro_raw: true, gyro_batch: false, esc: true, rpm: false, vibe: true, ctun: true, att: true, pos: true, ftn: false },
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
    assert.equal(checks.checks_summary(list).status, 'ok')
})

test('run_checks: не Copter — fail, итог fail', () => {
    const list = checks.run_checks(good_info({ vehicle: 'Plane' }), good_params, good_vibe)
    assert.equal(by_id(list, 'vehicle').status, 'fail')
    assert.equal(checks.checks_summary(list).status, 'fail')
})

test('run_checks: PID — ok / warn (только RATE) / fail', () => {
    const only_rate = good_info({ messages: { ...good_info().messages, pid: false, rate: true } })
    assert.equal(by_id(checks.run_checks(only_rate, good_params, good_vibe), 'pid_log').status, 'warn')
    const none = good_info({ messages: { ...good_info().messages, pid: false, rate: false } })
    assert.equal(by_id(checks.run_checks(none, good_params, good_vibe), 'pid_log').status, 'fail')
})

test('run_checks: нет данных гироскопа — fail с подсказкой', () => {
    const info = good_info({ messages: { ...good_info().messages, gyro_raw: false, gyro_batch: false } })
    const c = by_id(checks.run_checks(info, good_params, good_vibe), 'gyro_log')
    assert.equal(c.status, 'fail')
    assert.match(c.fix, /INS_LOG_BAT_MASK/)
})

test('run_checks: raw pre/post по INS_RAW_LOG_OPT', () => {
    const post_only = fake_params({ INS_RAW_LOG_OPT: 4 })
    assert.equal(by_id(checks.run_checks(good_info(), post_only, good_vibe), 'pre_post').status, 'warn')
    const pre_only = fake_params({ INS_RAW_LOG_OPT: 0 })
    assert.equal(by_id(checks.run_checks(good_info(), pre_only, good_vibe), 'pre_post').status, 'ok')
})

test('run_checks: batch pre/post по INS_LOG_BAT_OPT', () => {
    const info = good_info({ messages: { ...good_info().messages, gyro_raw: false, gyro_batch: true } })
    assert.equal(by_id(checks.run_checks(info, fake_params({ INS_LOG_BAT_OPT: 4 }), good_vibe), 'pre_post').status, 'ok')
    assert.equal(by_id(checks.run_checks(info, fake_params({ INS_LOG_BAT_OPT: 2 }), good_vibe), 'pre_post').status, 'warn')
})

test('run_checks: источник трекинга — ESC ok, RPM ok, только газ warn', () => {
    const rpm = good_info({ messages: { ...good_info().messages, esc: false, rpm: true } })
    assert.equal(by_id(checks.run_checks(rpm, good_params, good_vibe), 'tracking').status, 'ok')
    const throttle = good_info({ messages: { ...good_info().messages, esc: false, rpm: false } })
    assert.equal(by_id(checks.run_checks(throttle, good_params, good_vibe), 'tracking').status, 'warn')
})

test('run_checks: полёт — нет газа fail, короткий warn', () => {
    assert.equal(by_id(checks.run_checks(good_info({ flight: null }), good_params, good_vibe), 'flight').status, 'fail')
    const short = good_info({ flight: { start: 5, end: 25, duration_s: 20, mean_throttle: 0.33 } })
    assert.equal(by_id(checks.run_checks(short, good_params, good_vibe), 'flight').status, 'warn')
})

test('run_checks: вибрации — пороги 30/60 и clipping', () => {
    const warn = { ...good_vibe, level: 45 }
    assert.equal(by_id(checks.run_checks(good_info(), good_params, warn), 'vibe').status, 'warn')
    const fail = { ...good_vibe, level: 70 }
    assert.equal(by_id(checks.run_checks(good_info(), good_params, fail), 'vibe').status, 'fail')
    const clip = { ...good_vibe, clip: 5 }
    assert.equal(by_id(checks.run_checks(good_info(), good_params, clip), 'clipping').status, 'warn')
    assert.equal(by_id(checks.run_checks(good_info(), good_params, null), 'vibe').status, 'warn')
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

test('checks_summary: счётчики', () => {
    const s = checks.checks_summary([{ status: 'ok' }, { status: 'warn' }, { status: 'warn' }])
    assert.deepEqual(s, { status: 'warn', ok: 1, warn: 2, fail: 0 })
})
