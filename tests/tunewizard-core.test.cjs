// Тесты ядра мастера настройки, которое переносится из FilterReview.
// Эти скрипты — классические (общая глобальная область, наследование классов между файлами),
// поэтому загружаются как на странице: по порядку через vm.runInThisContext.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const repo = path.resolve(__dirname, '..')

// FFTJS на странице — глобал из modules/fft.js/dist/fft.js; под Node берём ту же библиотеку через require
globalThis.FFTJS = require('../modules/fft.js/lib/fft.js')

// Загрузить скрипты страницы в глобальную область, в том порядке, что и index.html
function load_page_scripts(files) {
    for (const file of files) {
        const full = path.join(repo, file)
        vm.runInThisContext(fs.readFileSync(full, 'utf8'), { filename: full })
    }
}

load_page_scripts([
    'Libraries/Array_Math.js',
    'Libraries/fft.js',
    'Libraries/DecodeDevID.js',
    'TuneWizard/core/log.js',
    'TuneWizard/core/checks.js',
    'TuneWizard/core/gyro.js',
])

// Поддельный лог с интерфейсом парсера (как в tests/tunewizard.test.cjs).
// messages = { ИМЯ: { поле: массив } } — сообщение без экземпляров;
//            { ИМЯ: { instances: { 0: { поле: массив }, 1: {…} } } } — с экземплярами (как VIBE, ESC, IMU, GYR):
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

// Сообщения batch-логирования: экземпляр 0 типа type (1 — гироскоп, 0 — акселерометр), N пакетов по samples
// отсчётов на rate Гц, синусоида freq Гц амплитудой amp рад/с по X, тишина по Y, Z; масштаб mul = 1000.
// Лог кончается ровно на границе пакета, и upstream-загрузчик теряет последний пакет
// (см. пометку upstream у "Sequence incomplete" в core/gyro.js): загружается N−1 пакетов, пока это не исправит задача 8
function batch_messages({ batches = 4, samples = 1024, rate = 1000, freq = 100, amp = 2, type = 1 } = {}) {
    const ISBH = { N: [], type: [], instance: [], smp_cnt: [], mul: [], SampleUS: [], smp_rate: [] }
    const ISBD = { N: [], seqno: [], x: [], y: [], z: [] }
    const scale = 1000
    for (let b = 0; b < batches; b++) {
        ISBH.N.push(b); ISBH.type.push(type); ISBH.instance.push(0); ISBH.smp_cnt.push(samples)
        ISBH.mul.push(scale); ISBH.SampleUS.push(b * samples / rate * 1e6 + 10e6); ISBH.smp_rate.push(rate)
        for (let m = 0; m < samples / 32; m++) {
            const x = [], y = [], z = []
            for (let k = 0; k < 32; k++) {
                const n = m * 32 + k
                x.push(Math.round(scale * amp * Math.sin(2 * Math.PI * freq * n / rate)))
                y.push(0)
                z.push(0)
            }
            ISBD.N.push(b); ISBD.seqno.push(m); ISBD.x.push(x); ISBD.y.push(y); ISBD.z.push(z)
        }
    }
    return { ISBH, ISBD }
}

// Сообщения raw-логирования: GYR экземпляра 0 — samples отсчётов на rate Гц с начала start_s секунд и разрывом
// gap_s секунд посередине (загрузчик режет ряд на два пакета), синусоида freq Гц амплитудой amp по X,
// тишина по Y, Z; IMU.GHz — заявленная частота rate
function raw_messages({ samples = 3000, rate = 1000, freq = 100, amp = 2, start_s = 20, gap_s = 1 } = {}) {
    const SampleUS = [], GyrX = [], GyrY = [], GyrZ = []
    const half = Math.floor(samples / 2)
    for (let n = 0; n < samples; n++) {
        SampleUS.push(start_s * 1e6 + n * 1e6 / rate + ((n >= half) ? gap_s * 1e6 : 0))
        GyrX.push(amp * Math.sin(2 * Math.PI * freq * n / rate))
        GyrY.push(0)
        GyrZ.push(0)
    }
    return {
        GYR: { instances: { 0: { TimeUS: SampleUS, SampleUS, GyrX, GyrY, GyrZ } } },
        IMU: { instances: { 0: { GHz: [rate, rate, rate] } } }
    }
}

// Параметры: один гироскоп, EKF3 с первичным primary, опции логирования; extra = [[имя, значение, TimeUS], ...]
// дописываются в конец — так имитируется смена параметра в полёте
function gyro_params({ bat_opt = 0, raw_opt = null, primary = 0, extra = [] } = {}) {
    const params = [['INS_GYR_ID', 1, 0], ['INS_LOG_BAT_OPT', bat_opt, 0], ['AHRS_EKF_TYPE', 3, 0], ['EK3_PRIMARY', primary, 0]]
    if (raw_opt != null) {
        params.push(['INS_RAW_LOG_OPT', raw_opt, 0])
    }
    return params.concat(extra)
}

// Синтетический batch-лог: post — INS_LOG_BAT_OPT = 2 (только после фильтров), иначе 0
function synthetic_batch_log({ post = false, primary = 0, extra = [], ...messages } = {}) {
    return fake_log({ messages: batch_messages(messages), params: gyro_params({ bat_opt: post ? 2 : 0, primary, extra }) })
}

// Синтетический raw-лог: INS_RAW_LOG_OPT = raw_opt (0 — только до фильтров)
function synthetic_raw_log({ raw_opt = 0, extra = [], ...messages } = {}) {
    return fake_log({ messages: raw_messages(messages), params: gyro_params({ raw_opt, extra }) })
}

const env0 = { params: null, build_type: 2, filter_version: 2 }
const env_for = (log) => ({ ...env0, params: log_params(log) })

test('load_gyro: batch-лог даёт один экземпляр pre-filter с пакетами и временем', () => {
    const log = synthetic_batch_log()
    const gyro = load_gyro(log, env_for(log), { log_type: null })
    assert.equal(gyro.error, null)
    assert.equal(gyro.type, 'batch')
    assert.equal(gyro.num_gyro, 1)
    assert.equal(gyro.length, 1)
    assert.equal(gyro[0].sensor_num, 0)
    assert.equal(gyro[0].post_filter, false)
    assert.equal(gyro[0].length, 3, 'из 4 пакетов upstream теряет последний (задача 8 вернёт 4)')
    assert.equal(gyro[0][0].x.length, 1024)
    // Период 100 Гц при 1000 Гц — 10 отсчётов, на целый отсчёт максимум не попадает;
    // проверяем снятие масштаба 1/mul на втором отсчёте: round(1000·2·sin(0.4π))/1000
    const expected_x2 = Math.round(1000 * 2 * Math.sin(2 * Math.PI * 100 * 2 / 1000)) / 1000
    assert.ok(Math.abs(gyro[0][0].x[2] - expected_x2) < 1e-9, 'масштаб 1/mul снят: ' + gyro[0][0].x[2] + ' против ' + expected_x2)
    assert.equal(gyro.have_pre, true)
    assert.equal(gyro.have_post, false)
    assert.equal(gyro.primary, 0)
    assert.equal(gyro.first_gyro, 0)
    assert.ok(gyro.start_time >= 10 && gyro.end_time > gyro.start_time)
    // decode_devid — глобал страницы (Libraries/DecodeDevID.js загружен): INS_GYR_ID = 1 раскодируется
    // в имя и шину; частоты нет — в batch-фикстуре нет IMU. Предупреждений на чистом логе нет
    assert.ok(typeof gyro.gyro_info[0].name === 'string' && gyro.gyro_info[0].name.length > 0, 'имя сенсора: ' + gyro.gyro_info[0].name)
    assert.equal(gyro.gyro_info[0].rate, null)
    assert.deepEqual(gyro.warnings, [])
})

test('load_gyro: без ISBH/ISBD и GYR — ошибка, без исключения', () => {
    const log = fake_log({ params: [['INS_GYR_ID', 1, 0]] })
    const gyro = load_gyro(log, env_for(log), { log_type: null })
    assert.match(gyro.error, /raw|batch/i)
})

test('load_gyro: ISBH только с акселерометром (type 0) — ошибка «нет пригодных данных», без исключения', () => {
    const log = synthetic_batch_log({ type: 0 })
    const gyro = load_gyro(log, env_for(log), { log_type: null })
    assert.match(gyro.error, /пригодных/)
    assert.equal(gyro.length, 0)
})

test('load_gyro: post-only batch (INS_LOG_BAT_OPT = 2) — только post, без Z и бодэ', () => {
    const log = synthetic_batch_log({ post: true })
    const gyro = load_gyro(log, env_for(log), { log_type: null })
    assert.equal(gyro.error, null)
    assert.equal(gyro[0].post_filter, true)
    assert.equal(gyro.have_pre, false)
    assert.equal(gyro.have_post, true)
    assert.equal(gyro.primary, 0)
    gyro_fft(gyro, { window_size: 1024, window_per_batch: 1 })
    const FFT = gyro[0].FFT
    assert.equal(FFT.x.length, 3)
    // Z1/Z2 считаются только для pre-filter (к post фильтр не применяют); бодэ строится при
    // !post_filter || !have_post — для единственного post-экземпляра оба ложны, бодэ нет (FR 865)
    assert.ok(FFT.Z1 == null && FFT.Z2 == null, 'без Z для post-filter')
    assert.ok(FFT.bode == null, 'без бодэ, когда есть только post')
})

test('load_gyro: raw-лог (GYR) с разрывом — два пакета, частота, конец по формуле raw, FFT по обоим', () => {
    const log = synthetic_raw_log()
    const gyro = load_gyro(log, env_for(log), { log_type: null })
    assert.equal(gyro.error, null)
    assert.equal(gyro.type, 'raw')
    assert.equal(gyro.quantization_noise, 0)
    assert.equal(gyro.length, 1)
    assert.equal(gyro[0].sensor_num, 0)
    assert.equal(gyro[0].post_filter, false)
    assert.equal(gyro[0].length, 2, 'разрыв 1 с делит ряд на два пакета')
    assert.equal(gyro[0][0].x.length, 1500)
    assert.equal(gyro[0][1].x.length, 1499, 'последний отсчёт лога upstream не включает (slice до j)')
    // Частота пакета по upstream: count отсчётов на count−1 интервалов → чуть выше 1000 Гц
    assert.ok(Math.abs(gyro[0].gyro_rate - 1000) < 1, 'gyro_rate ' + gyro[0].gyro_rate)
    assert.equal(gyro.gyro_rate[0], 1000, 'заявленная частота из IMU.GHz')
    assert.equal(gyro.gyro_info[0].rate, 1000)
    assert.ok(Math.abs(gyro.start_time - 20) < 1e-9)
    const last = gyro[0][1]
    assert.ok(last.sample_time > 22, 'второй пакет начинается после разрыва')
    assert.ok(Math.abs(gyro.end_time - (last.sample_time + last.x.length / last.sample_rate)) < 1e-9, 'конец = начало последнего пакета + его длительность')
    const result = gyro_fft(gyro, { window_size: 1024, window_per_batch: 1 })
    assert.equal(result.changed, true)
    assert.deepEqual(result.warnings, [])
    const FFT = gyro[0].FFT
    assert.equal(FFT.window_size, 1024, 'в raw-режиме окно — opts.window_size')
    assert.equal(FFT.x.length, 2, 'по одному окну на пакет')
    assert.equal(FFT.time.length, 2)
    const peak_index = FFT.x[1].indexOf(Math.max(...FFT.x[1]))
    assert.ok(Math.abs(FFT.bins[peak_index] - 100) < 1.0, 'пик около 100 Гц во втором пакете, получили ' + FFT.bins[peak_index])
})

test('load_gyro: есть и batch, и raw — выбор по opts.log_type, без выбора raw', () => {
    const log = fake_log({ messages: { ...batch_messages(), ...raw_messages() }, params: gyro_params({ raw_opt: 0 }) })
    assert.equal(load_gyro(log, env_for(log), { log_type: 'batch' }).type, 'batch')
    assert.equal(load_gyro(log, env_for(log), { log_type: 'raw' }).type, 'raw')
    assert.equal(load_gyro(log, env_for(log), { log_type: null }).type, 'raw')
    assert.equal(load_gyro(log, env_for(log)).type, 'raw')
})

test('load_gyro: EK3_PRIMARY = 1 без данных второго гироскопа — primary null, first_gyro 0', () => {
    const log = synthetic_batch_log({ primary: 1 })
    const gyro = load_gyro(log, env_for(log), { log_type: null })
    assert.equal(gyro.error, null)
    assert.equal(gyro.primary, null)
    assert.equal(gyro.first_gyro, 0)
})

test('load_gyro: смена INS_LOG_BAT_OPT / INS_RAW_LOG_OPT в полёте — предупреждение, взято последнее значение', () => {
    const batch = synthetic_batch_log({ extra: [['INS_LOG_BAT_OPT', 4, 5e6]] })
    const gyro_b = load_gyro(batch, env_for(batch), { log_type: null })
    assert.ok(gyro_b.warnings.some((w) => /INS_LOG_BAT_OPT/.test(w) && /менялся/.test(w)), gyro_b.warnings.join('; '))
    assert.equal(gyro_b[0].post_filter, false, 'последнее значение 4 — pre+post, экземпляр 0 остаётся pre')
    const raw = synthetic_raw_log({ extra: [['INS_RAW_LOG_OPT', 4, 5e6]] })
    const gyro_r = load_gyro(raw, env_for(raw), { log_type: null })
    assert.ok(gyro_r.warnings.some((w) => /INS_RAW_LOG_OPT/.test(w) && /менялся/.test(w)), gyro_r.warnings.join('; '))
    assert.equal(gyro_r[0].post_filter, true, 'последнее значение 4 — post')
})

test('gyro_fft: пик синусоиды в нужном бине с верной амплитудой', () => {
    const log = synthetic_batch_log({ freq: 100, amp: 2 })
    const gyro = load_gyro(log, env_for(log), { log_type: null })
    const result = gyro_fft(gyro, { window_size: 1024, window_per_batch: 1 })
    assert.equal(result.changed, true)
    const FFT = gyro[0].FFT
    assert.equal(FFT.window_size, 1024)
    assert.ok(Math.abs(FFT.average_sample_rate - 1000) < 1e-6)
    assert.equal(FFT.x.length, 3, 'по одному окну на каждый из 3 загруженных пакетов (задача 8 вернёт 4)')
    const peak_index = FFT.x[0].indexOf(Math.max(...FFT.x[0]))
    assert.ok(Math.abs(FFT.bins[peak_index] - 100) < 1.0, 'пик около 100 Гц, получили ' + FFT.bins[peak_index])
    // Амплитуда с поправкой окна Ханна (linear) ≈ 2; утечка на нецелом бине допускает запас
    const peak_amp = FFT.x[0][peak_index] * FFT.correction.linear
    assert.ok(peak_amp > 1.7 && peak_amp < 2.1, 'амплитуда пика ' + peak_amp)
    assert.ok(Math.max(...FFT.y[0]) < 1e-9, 'тишина по Y')
    assert.ok(FFT.Z1 != null && FFT.Z2 != null && FFT.bode != null, 'подготовлены Z и бодэ для pre-filter')
    assert.equal(FFT.Z1[0].length, FFT.bins.length, 'Z на каждый бин')
    assert.ok(Math.abs(FFT.bode.freq[1] - FFT.bode.freq[0] - 0.05) < 1e-9, 'сетка бодэ с шагом 0.05 Гц')
    assert.equal(gyro_fft(gyro, { window_size: 1024, window_per_batch: 1 }).changed, false, 'повторный вызов без изменений')
    clear_gyro_fft(gyro)
    assert.equal(gyro[0].FFT, null)
})

test('run_batch_fft: окно не степень двойки — исключение с русским текстом', () => {
    const log = synthetic_batch_log()
    const gyro = load_gyro(log, env_for(log), { log_type: null })
    gyro.type = 'raw'   // в raw-режиме окно берётся из opts.window_size
    assert.throws(() => gyro_fft(gyro, { window_size: 1000, window_per_batch: 1 }), /степен/)
})

test('find_start_index/find_end_index: границы по диапазону', () => {
    const time = [0, 1, 2, 3, 4, 5]
    assert.equal(find_start_index(time, [2.5, 4.5]), 2)
    assert.equal(find_end_index(time, [2.5, 4.5]), 5)
})

test('fft_info: частота дискретизации и разрешение по сенсору', () => {
    const log = synthetic_batch_log()
    const gyro = load_gyro(log, env_for(log), { log_type: null })
    gyro_fft(gyro, { window_size: 1024, window_per_batch: 1 })
    const info = fft_info(gyro)
    assert.ok(Math.abs(info[0].sample_rate - 1000) < 1e-6)
    assert.ok(Math.abs(info[0].resolution - 1000 / 1024) < 1e-6)
    assert.equal(info[0].window_size, 1024)
})
