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

// Параметры без лога: { имя: значение } — для тестов, которым лог не нужен
function fake_params(values) {
    return { get: (name) => (name in values) ? values[name] : null, has: (name) => name in values }
}

// Синтетический batch-лог: один гироскоп, pre-filter, N пакетов по 1024 отсчёта на 1000 Гц,
// синусоида freq Гц амплитудой amp рад/с по X, тишина по Y, Z.
// Лог кончается ровно на границе пакета, и upstream-загрузчик теряет последний пакет
// (см. «upstream:» у "Sequence incomplete" в core/gyro.js): загружается N−1 пакетов, пока это не исправит задача 8
function synthetic_batch_log({ batches = 4, samples = 1024, rate = 1000, freq = 100, amp = 2, post = false } = {}) {
    const ISBH = { N: [], type: [], instance: [], smp_cnt: [], mul: [], SampleUS: [], smp_rate: [] }
    const ISBD = { N: [], seqno: [], x: [], y: [], z: [] }
    const scale = 1000
    for (let b = 0; b < batches; b++) {
        ISBH.N.push(b); ISBH.type.push(1); ISBH.instance.push(0); ISBH.smp_cnt.push(samples)
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
    return fake_log({ messages: { ISBH, ISBD }, params: [
        ['INS_GYR_ID', 1, 0], ['INS_LOG_BAT_OPT', post ? 2 : 0, 0], ['AHRS_EKF_TYPE', 3, 0], ['EK3_PRIMARY', 0, 0]
    ] })
}
const env0 = { params: null, build_type: 2, filter_version: 2 }

test('load_gyro: batch-лог даёт один экземпляр pre-filter с пакетами и временем', () => {
    const log = synthetic_batch_log()
    const gyro = load_gyro(log, { ...env0, params: log_params(log) }, { log_type: null })
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
    assert.ok(gyro.start_time >= 10 && gyro.end_time > gyro.start_time)
    // Без env.decode_devid сведения о сенсоре — заглушка; предупреждений на чистом логе нет
    assert.deepEqual(gyro.gyro_info[0], { name: 'IMU', bus_type: null, rate: null })
    assert.deepEqual(gyro.warnings, [])
})

test('load_gyro: без ISBH/ISBD и GYR — ошибка, без исключения', () => {
    const log = fake_log({ params: [['INS_GYR_ID', 1, 0]] })
    const gyro = load_gyro(log, { ...env0, params: log_params(log) }, { log_type: null })
    assert.match(gyro.error, /raw|batch/i)
})

test('gyro_fft: пик синусоиды в нужном бине с верной амплитудой', () => {
    const log = synthetic_batch_log({ freq: 100, amp: 2 })
    const gyro = load_gyro(log, { ...env0, params: log_params(log) }, { log_type: null })
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
    assert.equal(gyro_fft(gyro, { window_size: 1024, window_per_batch: 1 }).changed, false, 'повторный вызов без изменений')
    clear_gyro_fft(gyro)
    assert.equal(gyro[0].FFT, null)
})

test('run_batch_fft: окно не степень двойки — исключение с русским текстом', () => {
    const log = synthetic_batch_log()
    const gyro = load_gyro(log, { ...env0, params: log_params(log) }, { log_type: null })
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
    const gyro = load_gyro(log, { ...env0, params: log_params(log) }, { log_type: null })
    gyro_fft(gyro, { window_size: 1024, window_per_batch: 1 })
    const info = fft_info(gyro)
    assert.ok(Math.abs(info[0].sample_rate - 1000) < 1e-6)
    assert.ok(Math.abs(info[0].resolution - 1000 / 1024) < 1e-6)
    assert.equal(info[0].window_size, 1024)
})
