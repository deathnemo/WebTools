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

test('log_info: рама — текст после «Frame: » из первого такого MSG; нет строки или MSG — null', () => {
    const frame_of = (messages) => core_log.log_info(fake_log({ messages }), copter_version).frame
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
    assert.equal(core_log.log_info(log, copter_version).board_id, null)
    assert.equal(core_log.log_info(log).board_id, null)
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
    const rates_of = (log) => core_log.log_info(log, copter_version).pid_log_rates
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
    const info = core_log.log_info(log, copter_version)
    assert.equal(info.duration_s, 3)
    assert.equal(info.time_start, 0)
    assert.equal(info.time_end, 3)
})

test('log_info: без ATT, RATE и CTUN границы — из ISBH.SampleUS, GYR.SampleUS или любого сообщения с TimeUS (аудит, I3)', () => {
    const bounds = (messages) => {
        const info = core_log.log_info(fake_log({ messages }), copter_version)
        return [info.time_start, info.time_end, info.duration_s]
    }
    // Batch-лог без сообщений положения: границы по заголовкам пакетов
    assert.deepEqual(bounds({ ISBH: { N: [0, 1, 2], SampleUS: [10e6, 11e6, 12e6] }, PARM: { TimeUS: [1e6, 1e6] } }), [10, 12, 2])
    // Raw-лог: GYR по экземплярам (читается через get_instance), объединение по всем экземплярам
    assert.deepEqual(bounds({ GYR: { instances: { 0: { SampleUS: [20e6, 25e6] }, 1: { SampleUS: [21e6, 26e6] } } } }), [20, 26, 6])
    // Ни того ни другого: крайние TimeUS сообщений без экземпляров (сообщения с экземплярами, как VIBE, пропускаются)
    assert.deepEqual(bounds({ XKF1: { TimeUS: [5e6, 9e6] }, MSG: { TimeUS: [4e6, 6e6], Message: ['a', 'b'] }, VIBE: { instances: { 0: { TimeUS: [0, 50e6] } } } }), [4, 9, 5])
    // ATT в приоритете, как раньше; сообщение с одним отсчётом границ не задаёт
    assert.deepEqual(bounds({ ATT: { TimeUS: [1e6, 3e6] }, ISBH: { SampleUS: [10e6, 12e6] } }), [1, 3, 2])
    assert.deepEqual(bounds({ XKF1: { TimeUS: [5e6] } }), [null, null, null])
    assert.deepEqual(bounds({}), [null, null, null])
    assert.deepEqual(core_log.log_time_bounds(fake_log({ messages: { ISBH: { SampleUS: [10e6, 12e6] } } })), { start: 10e6, end: 12e6 })
})

const checks = require('../TuneWizard/core/checks.js')

// Сведения о хорошем логе Copter; тесты переопределяют нужные поля
function good_info(over = {}) {
    return {
        vehicle: 'Copter', fw_string: 'ArduCopter V4.6.0', board: 'CubeOrange', filter_version: 2, duration_s: 120,
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

test('run_checks: не Copter — fail, итог fail', () => {
    const list = checks.run_checks(good_info({ vehicle: 'Plane' }), good_params, good_vibe)
    assert.equal(by_id(list, 'vehicle').status, 'fail')
    assert.equal(checks.checks_summary(list).status, 'fail')
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
    const pid_check = (log) => by_id(checks.run_checks(core_log.log_info(log, copter_version), good_params, good_vibe), 'pid_log')
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
    const c = by_id(checks.run_checks(info, fake_params({ INS_LOG_BAT_OPT: 2 }), good_vibe), 'pre_post')
    assert.equal(c.status, 'warn')
    assert.match(c.fix, /\+4/)
    // Только до фильтров — норма, оценка «станет» строится расчётом
    assert.equal(by_id(checks.run_checks(info, fake_params({ INS_LOG_BAT_OPT: 0 }), good_vibe), 'pre_post').status, 'ok')
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
    } }), copter_version)
    const dead = esc_log([0, NaN, 0])
    assert.deepEqual(dead.esc, { instances: 2, with_rpm: 0 })
    assert.equal(dead.messages.esc, true)
    assert.equal(by_id(checks.run_checks(dead, good_params, good_vibe), 'tracking').status, 'warn')
    const alive = esc_log([0, NaN, 3000])
    assert.deepEqual(alive.esc, { instances: 2, with_rpm: 1 })
    assert.equal(by_id(checks.run_checks(alive, good_params, good_vibe), 'tracking').status, 'ok')
    assert.equal(core_log.log_info(fake_log(), copter_version).esc, null, 'без ESC сводки нет')
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

test('checks_summary: счётчики', () => {
    const s = checks.checks_summary([{ status: 'ok' }, { status: 'warn' }, { status: 'warn' }])
    assert.deepEqual(s, { status: 'warn', ok: 1, warn: 2, fail: 0 })
})

test('checks_summary: пустой список — ok с нулевыми счётчиками', () => {
    assert.deepEqual(checks.checks_summary([]), { status: 'ok', ok: 0, warn: 0, fail: 0 })
})
