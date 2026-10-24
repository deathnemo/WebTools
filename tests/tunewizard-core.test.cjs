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
    'TuneWizard/core/tracking/Atmosphere_model.js',
    'TuneWizard/core/tracking/BaseClass.js',
    'TuneWizard/core/tracking/Static.js',
    'TuneWizard/core/tracking/Throttle.js',
    'TuneWizard/core/tracking/RPM.js',
    'TuneWizard/core/tracking/ESC.js',
    'TuneWizard/core/tracking/FFT.js',
    'TuneWizard/core/tracking/Logged.js',
    'TuneWizard/core/filters.js',
    'TuneWizard/core/spectrum.js',
    'TuneWizard/core/autofit.js',
])

// Параметры без лога: values = { имя: значение }
function fake_params(values) {
    return { get: (name) => (name in values) ? values[name] : null, has: (name) => name in values, changed: () => false }
}

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
// Лог кончается ровно на границе пакета: последний пакет полный и загружается (upstream его терял — дефект 5).
// Необязательно: tones = [[частота, амплитуда], ...] — сумма синусоид вместо одной; y_ratio — доля той же суммы по Y;
// noise — СКО детерминированного белого шума по всем трём осям. Без них фикстура прежняя
function batch_messages({ batches = 4, samples = 1024, rate = 1000, freq = 100, amp = 2, type = 1, tones = [[freq, amp]], y_ratio = 0, noise = 0 } = {}) {
    const ISBH = { N: [], type: [], instance: [], smp_cnt: [], mul: [], SampleUS: [], smp_rate: [] }
    const ISBD = { N: [], seqno: [], x: [], y: [], z: [] }
    const scale = 1000
    // Шум с фиксированным зерном: LCG из Numerical Recipes, равномерный на ±√3·noise — СКО ровно noise
    let seed = 1
    const white = () => {
        if (noise == 0) return 0
        seed = (seed * 1664525 + 1013904223) >>> 0
        return noise * Math.sqrt(3) * (2 * seed / 2 ** 32 - 1)
    }
    for (let b = 0; b < batches; b++) {
        ISBH.N.push(b); ISBH.type.push(type); ISBH.instance.push(0); ISBH.smp_cnt.push(samples)
        ISBH.mul.push(scale); ISBH.SampleUS.push(b * samples / rate * 1e6 + 10e6); ISBH.smp_rate.push(rate)
        for (let m = 0; m < samples / 32; m++) {
            const x = [], y = [], z = []
            for (let k = 0; k < 32; k++) {
                const n = m * 32 + k
                const s = tones.reduce((sum, [f, a]) => sum + a * Math.sin(2 * Math.PI * f * n / rate), 0)
                x.push(Math.round(scale * (s + white())))
                y.push(Math.round(scale * (y_ratio * s + white())))
                z.push(Math.round(scale * white()))
            }
            ISBD.N.push(b); ISBD.seqno.push(m); ISBD.x.push(x); ISBD.y.push(y); ISBD.z.push(z)
        }
    }
    return { ISBH, ISBD }
}

// Сообщения raw-логирования: GYR экземпляров 0..instances−1 (одинаковые ряды) — samples отсчётов на rate Гц
// с начала start_s секунд и разрывом gap_s секунд посередине (загрузчик режет ряд на два пакета),
// синусоида freq Гц амплитудой amp по X, тишина по Y, Z; IMU.GHz — заявленная частота rate
function raw_messages({ samples = 3000, rate = 1000, freq = 100, amp = 2, start_s = 20, gap_s = 1, instances = 1 } = {}) {
    const SampleUS = [], GyrX = [], GyrY = [], GyrZ = []
    const half = Math.floor(samples / 2)
    for (let n = 0; n < samples; n++) {
        SampleUS.push(start_s * 1e6 + n * 1e6 / rate + ((n >= half) ? gap_s * 1e6 : 0))
        GyrX.push(amp * Math.sin(2 * Math.PI * freq * n / rate))
        GyrY.push(0)
        GyrZ.push(0)
    }
    const GYR = { instances: {} }
    const IMU = { instances: {} }
    for (let i = 0; i < instances; i++) {
        GYR.instances[i] = { TimeUS: SampleUS, SampleUS, GyrX, GyrY, GyrZ }
        IMU.instances[i] = { GHz: [rate, rate, rate] }
    }
    return { GYR, IMU }
}

// Параметры: gyros гироскопов (INS_GYR_ID, INS_GYR2_ID, …), EKF3 с первичным primary, опции логирования;
// extra = [[имя, значение, TimeUS], ...] дописываются в конец — так имитируется смена параметра в полёте
function gyro_params({ bat_opt = 0, raw_opt = null, primary = 0, extra = [], gyros = 1 } = {}) {
    const params = [['INS_GYR_ID', 1, 0], ['INS_LOG_BAT_OPT', bat_opt, 0], ['AHRS_EKF_TYPE', 3, 0], ['EK3_PRIMARY', primary, 0]]
    for (let i = 2; i <= gyros; i++) {
        params.push(['INS_GYR' + i + '_ID', 1, 0])
    }
    if (raw_opt != null) {
        params.push(['INS_RAW_LOG_OPT', raw_opt, 0])
    }
    return params.concat(extra)
}

// Синтетический batch-лог: post — INS_LOG_BAT_OPT = 2 (только после фильтров), иначе 0
function synthetic_batch_log({ post = false, primary = 0, extra = [], ...messages } = {}) {
    return fake_log({ messages: batch_messages(messages), params: gyro_params({ bat_opt: post ? 2 : 0, primary, extra }) })
}

// Синтетический raw-лог: INS_RAW_LOG_OPT = raw_opt (0 — только до фильтров), gyros одинаковых экземпляров GYR
function synthetic_raw_log({ raw_opt = 0, extra = [], gyros = 1, ...messages } = {}) {
    return fake_log({ messages: raw_messages({ ...messages, instances: gyros }), params: gyro_params({ raw_opt, extra, gyros }) })
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
    assert.equal(gyro[0].length, 4, 'все 4 пакета, включая последний у конца лога (дефект 5 исправлен)')
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
    assert.equal(FFT.x.length, 4)
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
    assert.equal(FFT.x.length, 4, 'по одному окну на каждый из 4 пакетов')
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

// ---------- Исправления дефектов, унаследованных из FilterReview (задача 8) ----------

// Пакет для run_batch_fft: n отсчётов синусоиды 100 Гц по X на частоте rate, начало start секунд
function fft_batch(n, rate, start) {
    const x = Array.from({ length: n }, (_, k) => Math.sin(2 * Math.PI * 100 * k / rate))
    return { sample_time: start, sample_rate: rate, x, y: new Array(n).fill(0), z: new Array(n).fill(0) }
}

test('дефект 1: пакет короче окна пропускается и не входит в среднюю частоту (FR 284)', () => {
    // Короткий пакет с «чужой» частотой 4000 Гц: upstream не пропускал его при усреднении (window_size ещё
    // undefined) и брал частоту первого пакета; верно — среднее только по двум длинным пакетам, (1000 + 1300) / 2
    const data_set = [fft_batch(1024, 1000, 0), fft_batch(512, 4000, 2), fft_batch(1024, 1300, 4)]
    const FFT = run_batch_fft(data_set, { type: 'raw', window_size: 1024, window_per_batch: 1 })
    assert.equal(FFT.x.length, 2, 'окна только у двух длинных пакетов')
    assert.equal(FFT.time.length, 2)
    assert.ok(Math.abs(FFT.average_sample_rate - 1150) < 1e-9, 'средняя частота ' + FFT.average_sample_rate)
})

test('дефект 1: средняя частота — по всем пакетам, а не по первому (FR 289)', () => {
    const data_set = [fft_batch(1024, 1000, 0), fft_batch(1024, 1020, 2)]
    const FFT = run_batch_fft(data_set, { type: 'batch', window_size: 1024, window_per_batch: 1 })
    assert.equal(FFT.window_size, 1024)
    assert.ok(Math.abs(FFT.average_sample_rate - 1010) < 1e-9, 'средняя частота ' + FFT.average_sample_rate)
    assert.ok(Math.abs(FFT.bins[1] - 1010 / 1024) < 1e-12, 'бины по средней частоте')
})

test('дефект 1: все пакеты короче окна — окон нет, частота по всем пакетам, предупреждение, без исключения', () => {
    // После исправления пакеты короче окна в среднее не входят; если короче все, средняя берётся по всем пакетам,
    // чтобы бины и сетка бодэ остались числами (иначе 0/0 и RangeError в array_from_range)
    const log = synthetic_raw_log()
    const gyro = load_gyro(log, env_for(log), { log_type: null })
    const result = gyro_fft(gyro, { window_size: 4096, window_per_batch: 1 })
    const FFT = gyro[0].FFT
    assert.equal(FFT.x.length, 0)
    assert.ok(Number.isFinite(FFT.average_sample_rate) && Math.abs(FFT.average_sample_rate - 1000) < 1, 'частота ' + FFT.average_sample_rate)
    assert.ok(result.warnings.some((w) => /Недостаточно/.test(w)), result.warnings.join('; '))
})

test('дефект 2: raw-лог с двумя экземплярами GYR — пакеты экземпляра 1 той же длины, что у экземпляра 0 (FR 2295–2297)', () => {
    const log = synthetic_raw_log({ gyros: 2 })
    const gyro = load_gyro(log, env_for(log), { log_type: null })
    assert.equal(gyro.error, null)
    assert.equal(gyro.num_gyro, 2)
    assert.deepEqual(gyro[0].map((b) => b.x.length), [1500, 1499])
    assert.deepEqual(gyro[1].map((b) => b.x.length), [1500, 1499], 'срез до j, а не до j − номер экземпляра')
    assert.equal(gyro[1].sensor_num, 1)
    assert.equal(gyro.end_time, gyro[0][1].sample_time + 1499 / gyro[0][1].sample_rate)
})

// Убрать из batch-лога сообщение ISBD пакета batch с номером seqno
function drop_isbd(log_messages, batch, seqno) {
    const { ISBD } = log_messages
    const k = ISBD.N.findIndex((n, i) => (n == batch) && (ISBD.seqno[i] == seqno))
    for (const field of Object.keys(ISBD)) {
        ISBD[field].splice(k, 1)
    }
    return log_messages
}

test('дефект 3: нет сообщения ISBD в последнем пакете — прежние пакеты сохранены, предупреждение (FR 2109)', () => {
    const log = fake_log({ messages: drop_isbd(batch_messages(), 3, 10), params: gyro_params() })
    const gyro = load_gyro(log, env_for(log), { log_type: null })
    assert.equal(gyro.error, null, 'загрузка не обрывается')
    assert.equal(gyro[0].length, 3, 'пакеты 0–2 сохранены, повреждённый 3 пропущен')
    assert.equal(gyro.have_pre, true)
    assert.ok(gyro.warnings.some((w) => /ISBD/.test(w) && /— 1$/.test(w)), gyro.warnings.join('; '))
})

test('дефект 3: нет сообщения ISBD посреди лога — пропускается только этот пакет, следующие читаются', () => {
    const log = fake_log({ messages: drop_isbd(batch_messages(), 1, 5), params: gyro_params() })
    const gyro = load_gyro(log, env_for(log), { log_type: null })
    assert.equal(gyro.error, null)
    assert.deepEqual(gyro[0].map((b) => b.sample_time), [10, 10 + 2 * 1.024, 10 + 3 * 1.024], 'пакеты 0, 2, 3')
    assert.equal(gyro.warnings.length, 1, gyro.warnings.join('; '))
})

test('дефект 3: у заголовка посреди лога нет ни одного сообщения ISBD — пакет пропущен, следующие читаются (FR 2087–2095)', () => {
    // upstream искал сообщения этого пакета до конца лога и прекращал разбор: пакеты 2 и 3 терялись
    const messages = batch_messages()
    for (let seqno = 31; seqno >= 0; seqno--) {
        drop_isbd(messages, 1, seqno)
    }
    const log = fake_log({ messages, params: gyro_params() })
    const gyro = load_gyro(log, env_for(log), { log_type: null })
    assert.equal(gyro.error, null)
    assert.deepEqual(gyro[0].map((b) => b.sample_time), [10, 10 + 2 * 1.024, 10 + 3 * 1.024], 'пакеты 0, 2, 3')
    assert.equal(gyro.warnings.length, 1, gyro.warnings.join('; '))
    assert.match(gyro.warnings[0], /— 1$/)
})

test('дефект 3: заголовок без сообщений ISBD в самом конце лога — ожидаемо, без предупреждения', () => {
    // Лог оборвался сразу после заголовка пакета 4: данные дальше не продолжаются, повреждения нет
    const messages = batch_messages()
    const { ISBH } = messages
    ISBH.N.push(4); ISBH.type.push(1); ISBH.instance.push(0); ISBH.smp_cnt.push(1024)
    ISBH.mul.push(1000); ISBH.SampleUS.push(10e6 + 4 * 1.024e6); ISBH.smp_rate.push(1000)
    const log = fake_log({ messages, params: gyro_params() })
    const gyro = load_gyro(log, env_for(log), { log_type: null })
    assert.equal(gyro[0].length, 4)
    assert.deepEqual(gyro.warnings, [])
})

test('дефект 3: число отсчётов пакета не совпадает с заголовком — пакет пропущен, предупреждение (FR 2130)', () => {
    const messages = batch_messages()
    // 1000 не делится на 32: читаются 32 сообщения, 1024 отсчёта вместо 1000
    messages.ISBH.smp_cnt[1] = 1000
    const log = fake_log({ messages, params: gyro_params() })
    const gyro = load_gyro(log, env_for(log), { log_type: null })
    assert.equal(gyro.error, null)
    assert.equal(gyro[0].length, 3, 'пакеты 0, 2, 3')
    assert.ok(gyro.warnings.some((w) => /ISBD/.test(w)), gyro.warnings.join('; '))
})

test('дефект 5: последний пакет, кончающийся на последнем сообщении ISBD, загружается; неполный — нет (FR 2118–2122)', () => {
    const full = synthetic_batch_log()
    const gyro = load_gyro(full, env_for(full), { log_type: null })
    assert.equal(gyro[0].length, 4)
    assert.equal(gyro.end_time, 10 + 3 * 1.024, 'конец — начало последнего пакета')
    assert.deepEqual(gyro.warnings, [])
    // Лог оборвался посреди последнего пакета (нет сообщений 20–31): такой пакет отбрасывается без предупреждения,
    // как и в upstream — для конца лога это ожидаемо
    const messages = batch_messages()
    for (let seqno = 31; seqno >= 20; seqno--) {
        drop_isbd(messages, 3, seqno)
    }
    const cut = fake_log({ messages, params: gyro_params() })
    const gyro_cut = load_gyro(cut, env_for(cut), { log_type: null })
    assert.equal(gyro_cut[0].length, 3)
    assert.deepEqual(gyro_cut.warnings, [])
})

// Квадрокоптер с выходами моторов, барометром и параметрами моторов, без RATE и CTUN: газ по моторам считается
// (MOT_BAT_VOLT_MAX = 0 — без компенсации батареи), а средний газ (RATE.AOut, CTUN.ThO) недоступен
function motors_without_rate_log() {
    const params = [['FRAME_CLASS', 1, 0], ['MOT_THST_EXPO', 0.65, 0], ['MOT_SPIN_MAX', 0.95, 0], ['MOT_SPIN_MIN', 0.15, 0], ['MOT_PWM_MIN', 1000, 0],
                    ['MOT_PWM_MAX', 2000, 0], ['MOT_BAT_VOLT_MIN', 0, 0], ['MOT_BAT_VOLT_MAX', 0, 0], ['MOT_BAT_IDX', 0, 0], ['BARO_PRIMARY', 0, 0]]
    const RCOU = { TimeUS: [0, 1e6] }
    for (let i = 1; i <= 4; i++) {
        params.push(['SERVO' + i + '_FUNCTION', 32 + i, 0])
        RCOU['C' + i] = [1500, 1500]
    }
    return fake_log({ messages: { RCOU, BARO: { instances: { 0: { TimeUS: [0, 1e6], Alt: [0, 0] } } } }, params })
}

test('дефект 4: без RATE и CTUN источник газа остаётся режимом 1 — «нет данных газа», а не «неподдерживаемый режим»', () => {
    const log = fake_log({ messages: { ATT: { TimeUS: [0, 1e6] } } })
    const env = { filter_version: 2, params: log_params(log), build_type: 2 }
    const tracking = create_tracking(log, env, { start_time: 0, end_time: 1 })
    assert.equal(tracking[1].mode_value, 1)
    assert.equal(tracking[1].have_data({ options: 0 }), false)
    const filters = load_filters({ INS_HNTCH_ENABLE: 1, INS_HNTCH_MODE: 1, INS_HNTCH_FREQ: 80, INS_HNTCH_BW: 40, INS_HNTCH_ATT: 40, INS_HNTCH_REF: 0.3, INS_HNTCH_HMNCS: 1, INS_HNTC2_ENABLE: 0 }, env, tracking)
    assert.equal(filters.notch[0].enabled(), false)
    assert.ok(filters.warnings.some((w) => /газ/.test(w)), filters.warnings.join('; '))
    assert.ok(!filters.warnings.some((w) => /Неподдерживаемый/.test(w)), filters.warnings.join('; '))
})

test('дефект 4: газ по моторам без RATE и CTUN — notch по моторам выключен с «нет данных газа», а не включён без частот', () => {
    // Теперь источник с режимом 1 находится и без среднего газа. Ряды моторов (OPTS бит 2) при этом посчитаны, но
    // have_data upstream требует и средний газ (value) — notch выключен с понятным предупреждением, и состояния
    // «включён, но интерполяция пропущена и частот нет» не возникает
    const log = motors_without_rate_log()
    const env = { filter_version: 2, params: log_params(log), build_type: 2 }
    const tracking = create_tracking(log, env, { start_time: 0, end_time: 1 })
    assert.equal(tracking[1].data.length, 4, 'газ четырёх моторов посчитан')
    const config = { enable: 1, mode: 1, freq: 80, bandwidth: 40, attenuation: 40, ref: 0.3, min_ratio: 1, harmonics: 1, options: 2, esc_mask: 0 }
    const f = new HarmonicNotchFilter(config, env, tracking)
    assert.equal(f.enabled(), false)
    assert.deepEqual(f.warnings, ['Нет данных газа для notch по газу: в логе нет RATE.AOut (и CTUN.ThO на Copter)'])
    tracking[1].interpolate(0, [0.5])
    assert.equal(tracking[1].get_interpolated_target_freq(0, 0, config), null, 'без среднего газа интерполяции нет')
})

test('дефект 6: FFTTarget с экземплярами FTN2 только {1: …} — интерполяция и цели без исключения', () => {
    const log = fake_log({ messages: {
        FTN1: { TimeUS: [0, 1e6], PkAvg: [90, 110] },
        FTN2: { instances: { 1: { TimeUS: [0, 1e6], EnX: [1, 1], EnY: [3, 3], PkX: [80, 80], PkY: [120, 120] } } }
    } })
    const env = { filter_version: 2, params: log_params(log), build_type: 2 }
    const fft = new FFTTarget(log, env)
    const config = { ref: 1, freq: 50, options: 2 }
    fft.interpolate(0, [0.5])
    // Экземпляр 1: взвешенно по энергии (80·1 + 120·3) / 4 = 110 Гц
    assert.deepEqual(fft.get_interpolated_target_freq(0, 0, config), [110])
    assert.deepEqual(fft.get_interpolated_target_freq(0, 0, { ...config, options: 0 }), [100], 'центральный пик FTN1')
    const target = fft.get_target_freq(config)
    assert.deepEqual(target.freq, [[110, 110]])
    assert.deepEqual(target.time, [[0, 1]])
})

test('дефект 7: выключенный notch не даёт предупреждений; включённый с неподдерживаемым режимом — даёт (FR 174–186)', () => {
    const log = fake_log({ messages: { ATT: { TimeUS: [0, 1e6] } } })
    const env = { filter_version: 2, params: log_params(log), build_type: 2 }
    const tracking = create_tracking(log, env, { start_time: 0, end_time: 1 })
    // Сценарий из плана: INS_HNTC2 выключен, режим 1 (газ), в логе нет ни RATE, ни CTUN
    assert.deepEqual(load_filters({ INS_HNTCH_ENABLE: 0, INS_HNTC2_ENABLE: 0, INS_HNTC2_MODE: 1 }, env, tracking).warnings, [])
    // Выключенный notch с режимом, которого нет в списке источников
    assert.deepEqual(load_filters({ INS_HNTCH_ENABLE: 0, INS_HNTCH_MODE: 9, INS_HNTC2_ENABLE: 0 }, env, tracking).warnings, [])
    const enabled = load_filters({ INS_HNTCH_ENABLE: 1, INS_HNTCH_MODE: 9, INS_HNTC2_ENABLE: 0 }, env, tracking)
    assert.ok(enabled.warnings.some((w) => /Неподдерживаемый режим notch 9/.test(w)), enabled.warnings.join('; '))
})

// Передаточная функция одного notch на сетке частот: |H| в центре ≈ -ATT дБ, вдали ≈ 0 дБ
function notch_response(center, bw, att, sample_rate, freqs) {
    const Z = exp_jw(freqs, sample_rate)
    const Z1 = complex_inverse(Z)
    const Z2 = complex_inverse(complex_square(Z))
    const one = [new Array(freqs.length).fill(1), new Array(freqs.length).fill(0)]
    const Hn = [one[0].slice(), one[1].slice()]
    const Hd = [one[0].slice(), one[1].slice()]
    new NotchFilter(att, bw, 1, () => 0, 1.0).transfer(Hn, Hd, center, sample_rate, Z1, Z2)
    return complex_abs(complex_div(Hn, Hd))
}

test('NotchFilter: ослабление в центре равно ATT, вдали — нет', () => {
    const freqs = array_from_range(1, 400, 1)
    const H = notch_response(100, 50, 40, 1000, freqs)
    const at_center = 20 * Math.log10(H[freqs.indexOf(100)])
    assert.ok(Math.abs(at_center + 40) < 0.5, 'в центре ' + at_center.toFixed(2) + ' дБ')
    assert.ok(Math.abs(20 * Math.log10(H[freqs.indexOf(10)])) < 0.1, 'на 10 Гц нет ослабления')
    assert.ok(Math.abs(20 * Math.log10(H[freqs.indexOf(300)])) < 0.5, 'на 300 Гц нет ослабления')
})

test('DigitalBiquadFilter: −3 дБ на частоте среза', () => {
    const freqs = [10, 40, 200]
    const Z = exp_jw(freqs, 1000)
    const Z1 = complex_inverse(Z), Z2 = complex_inverse(complex_square(Z))
    const Hn = [[1, 1, 1], [0, 0, 0]], Hd = [[1, 1, 1], [0, 0, 0]]
    new DigitalBiquadFilter(40).transfer(Hn, Hd, 1000, Z1, Z2)
    const H = complex_abs(complex_div(Hn, Hd))
    assert.ok(Math.abs(20 * Math.log10(H[1]) + 3) < 0.3, 'на 40 Гц ≈ −3 дБ')
    assert.ok(H[0] > 0.98 && H[2] < 0.1)
})

test('HarmonicNotchFilter: статический notch, гармоники 1 и 3, предупреждений нет', () => {
    const gyro = { start_time: 0, end_time: 10 }
    const env = { filter_version: 2, params: fake_params({}), build_type: 2 }
    const tracking = [new StaticTarget(gyro, env)]
    const f = new HarmonicNotchFilter({ enable: 1, mode: 0, freq: 80, bandwidth: 40, attenuation: 30, ref: 0, min_ratio: 1, harmonics: 5, options: 0, esc_mask: 0 }, env, tracking)
    assert.equal(f.enabled(), true)
    assert.equal(f.static(), true)
    assert.equal(f.harmonics(), 5)
    assert.deepEqual(f.warnings, [])
    const target = f.get_target_freq()
    assert.deepEqual(target.freq, [80, 80])
})

test('ThrottleTarget.get_target: freq·√(thr/ref), версия 2', () => {
    const log = fake_log({ messages: { RATE: { TimeUS: [0, 1e6], AOut: [0.25, 0.5] } } })
    const env = { filter_version: 2, params: fake_params({}), build_type: 2 }
    const t = new ThrottleTarget(log, env)
    assert.equal(t.have_data({ options: 0 }), true)
    assert.ok(Math.abs(t.get_target({ ref: 0.25, freq: 100, min_ratio: 1 }, 0.5) - 100 * Math.SQRT2) < 1e-9)
    assert.equal(t.get_target({ ref: 0, freq: 100 }, 0.5), 100)
})

test('ESCTarget.compute_avg: среднее по маске и тайм-аут экземпляра', () => {
    const log = fake_log({ messages: { ESC: { instances: {
        0: { TimeUS: [0, 1e6, 2e6], RPM: [6000, 6000, 6000] },
        1: { TimeUS: [0, 1e6, 5e6], RPM: [3000, 3000, 3000] }
    } } } })
    const env = { filter_version: 2, params: fake_params({}), build_type: 2 }
    const esc = new ESCTarget(log, env)
    assert.equal(esc.get_num_motors(), 2)
    const avg = esc.compute_avg(0)
    // Отсчёты одного момента идут в порядке экземпляров, поэтому первое среднее — по одному экземпляру 0
    // (экземпляр 1 ещё не появился), дальше (100+50)/2 Гц; после 2 с экземпляр 0 молчит, и к 5 с он выбывает
    // по тайм-ауту 1 с — последнее среднее только по экземпляру 1 (50 Гц)
    assert.deepEqual(avg.avg_freq.map((f) => Math.round(f * 1e6) / 1e6), [100, 75, 75, 50], 'среднее (100+50)/2 Гц и тайм-аут')
    assert.deepEqual(avg.avg_time.map((t) => Math.round(t * 1e6) / 1e6), [0, 1, 2, 5])
    const only_first = esc.compute_avg(1)
    assert.ok(only_first.avg_freq.every((f) => Math.abs(f - 100) < 1e-9))
})

test('load_filters: значения формы → фильтры, нет данных для режима ESC → предупреждение', () => {
    const log = fake_log({ messages: { RATE: { TimeUS: [0, 1e6], AOut: [0.3, 0.3] } } })
    const gyro = { start_time: 0, end_time: 1 }
    const env = { filter_version: 2, params: log_params(log), build_type: 2 }
    const tracking = create_tracking(log, env, gyro)
    const values = { INS_GYRO_FILTER: 40, INS_HNTCH_ENABLE: 1, INS_HNTCH_MODE: 3, INS_HNTCH_FREQ: 80, INS_HNTCH_BW: 40, INS_HNTCH_ATT: 40, INS_HNTCH_REF: 1, INS_HNTCH_FM_RAT: 1, INS_HNTCH_HMNCS: 3, INS_HNTCH_OPTS: 0, INS_HNTCH_ESCMSK: 0, INS_HNTC2_ENABLE: 0 }
    const filters = load_filters(values, env, tracking)
    assert.equal(filters.notch.length, 2)
    assert.equal(filters.notch[0].enabled(), false, 'ESC-данных нет — notch выключен')
    assert.ok(filters.warnings.length >= 1 && /ESC/.test(filters.warnings.join(' ')))
})

test('calculate_transfer_function + estimate_post: оценка после = до × |H|, пик 100 Гц ослаблен', () => {
    const log = synthetic_batch_log({ freq: 100, amp: 2 })
    const gyro = load_gyro(log, env_for(log), { log_type: null })
    gyro_fft(gyro, { window_size: 1024, window_per_batch: 1 })
    const env = { filter_version: 2, params: log_params(log), build_type: 2 }
    const tracking = create_tracking(log, env, gyro)
    interpolate_tracking(tracking, gyro)
    const values = { INS_GYRO_FILTER: 0, INS_HNTCH_ENABLE: 1, INS_HNTCH_MODE: 0, INS_HNTCH_FREQ: 100, INS_HNTCH_BW: 20, INS_HNTCH_ATT: 40, INS_HNTCH_REF: 0, INS_HNTCH_FM_RAT: 1, INS_HNTCH_HMNCS: 1, INS_HNTCH_OPTS: 0, INS_HNTCH_ESCMSK: 0, INS_HNTC2_ENABLE: 0 }
    const filters = load_filters(values, env, tracking)
    assert.deepEqual(filters.warnings, [])
    calculate_transfer_function(filters, gyro)
    const FFT = gyro[0].FFT
    assert.ok(FFT.H != null && FFT.H.length === FFT.x.length, 'H на каждое окно')
    const scale = fft_amplitude_scale(true, false)   // дБ
    const range = [gyro.start_time, gyro.end_time + 10]
    const alias = { bins: FFT.bins, apply_amp: (a) => a }
    const est = estimate_post(gyro, 0, scale, range, alias)
    // Пик 100 Гц лежит между бинами 102 (99.6 Гц) и 103 (100.6 Гц); берём первый бин не ниже 100 Гц.
    // Он на 0.59 Гц сбоку от центра notch шириной 20 Гц, поэтому |H| там ≈ −24 дБ, а не −40, как в центре
    const peak = FFT.bins.findIndex((b) => b >= 100)
    const pre_dB = 20 * Math.log10(FFT.x[0][peak] * FFT.correction.linear)
    // Оценка «после» — ровно среднее по окнам «до» × |H| с поправкой окна (шум квантования ~1e-5 даёт < 0.01 дБ)
    const expected_lin = FFT.x.reduce((sum, x, j) => sum + x[peak] * complex_abs(FFT.H[j])[peak], 0) / FFT.x.length
    const expected_dB = 20 * Math.log10(expected_lin * FFT.correction.linear)
    assert.ok(Math.abs(est.x[peak] - expected_dB) < 0.01, 'после = до × |H|: ' + est.x[peak].toFixed(3) + ' против ' + expected_dB.toFixed(3))
    assert.ok(pre_dB - est.x[peak] > 20, 'пик ослаблен не меньше чем на 20 дБ: до ' + pre_dB.toFixed(1) + ', после ' + est.x[peak].toFixed(1))
    // Вне notch (≥ 300 Гц) |H| ≈ 1, и оценка «после» совпадает со средним «до» по окнам
    const i300 = FFT.bins.findIndex((b) => b >= 300)
    const pre300_dB = 20 * Math.log10(FFT.x.reduce((sum, x) => sum + x[i300], 0) / FFT.x.length * FFT.correction.linear)
    assert.ok(Math.abs(est.x[i300] - pre300_dB) < 0.1, 'вне notch: до ' + pre300_dB.toFixed(3) + ', после ' + est.x[i300].toFixed(3))
    const bode = bode_mean(gyro, 0, range)
    const i100 = bode.freq.findIndex((f) => f >= 100)
    assert.ok(20 * Math.log10(bode.amp_mean[i100]) < -30, 'бодэ: провал на 100 Гц')
    assert.ok(Math.abs(bode.phase_mean[2]) < 5, 'фаза около нуля на низкой частоте')
    const stats = notch_line_stats(filters, range)
    assert.equal(stats[0].enabled, true)
    assert.equal(stats[0].harmonics[0].mean, 100)
})

test('bode_mean: null без бодэ (только post) и до calculate_transfer_function', () => {
    const post = synthetic_batch_log({ post: true })
    const gyro_post = load_gyro(post, env_for(post), { log_type: null })
    gyro_fft(gyro_post, { window_size: 1024, window_per_batch: 1 })
    assert.ok(gyro_post[0].FFT.bode == null, 'сетка бодэ у post-экземпляра не создаётся (поле не задано)')
    assert.equal(bode_mean(gyro_post, 0, [0, 100]), null, 'у post-экземпляра нет сетки бодэ')
    const pre = synthetic_batch_log()
    const gyro_pre = load_gyro(pre, env_for(pre), { log_type: null })
    gyro_fft(gyro_pre, { window_size: 1024, window_per_batch: 1 })
    assert.ok(gyro_pre[0].FFT.bode != null && gyro_pre[0].FFT.bode.H == null)
    assert.equal(bode_mean(gyro_pre, 0, [0, 100]), null, 'H ещё не посчитана')
    assert.equal(bode_mean(gyro_pre, 5, [0, 100]), null, 'нет такого экземпляра')
})

test('HarmonicNotchFilter: triple (бит 16), quintuple на версии 3 — предупреждение, бит 32 — минимум × гармоника', () => {
    const gyro = { start_time: 0, end_time: 10 }
    const make = (options, filter_version) => {
        const env = { filter_version, params: fake_params({}), build_type: 2 }
        return new HarmonicNotchFilter({ enable: 1, mode: 0, freq: 80, bandwidth: 40, attenuation: 30, ref: 0, min_ratio: 0.5, harmonics: 1, options, esc_mask: 0 }, env, [new StaticTarget(gyro, env)])
    }
    const triple = make(16, 4)
    assert.deepEqual(triple.warnings, [])
    assert.equal(triple.notches[0].notches.length, 3, 'MultiNotch из трёх')
    const quintuple_v3 = make(64, 3)
    assert.ok(quintuple_v3.warnings.some((w) => /Пятикратный/.test(w)), quintuple_v3.warnings.join('; '))
    assert.equal(quintuple_v3.notches[0].notches, undefined, 'на версии 3 остаётся одиночный NotchFilter')
    const quintuple_v4 = make(64, 4)
    assert.deepEqual(quintuple_v4.warnings, [])
    assert.equal(quintuple_v4.notches[0].notches.length, 5)
    assert.equal(make(32, 4).get_min_freq(2), 2 * 80 * 0.5, 'бит 32: минимальная частота умножается на номер гармоники')
    assert.equal(make(0, 4).get_min_freq(2), 80 * 0.5, 'без бита 32 — одна для всех гармоник')
})

test('notch_line_stats: многопиковая ветка — ESC по моторам, min/mean/max по двум экземплярам', () => {
    const log = fake_log({ messages: { ESC: { instances: {
        0: { TimeUS: [0, 1e6, 2e6], RPM: [6000, 6000, 6000] },
        1: { TimeUS: [0, 1e6, 5e6], RPM: [3000, 3000, 3000] }
    } } } })
    const gyro = { start_time: 0, end_time: 6 }
    const env = { filter_version: 2, params: log_params(log), build_type: 2 }
    const tracking = create_tracking(log, env, gyro)
    // OPTS 2 — notch по каждому мотору: get_target_freq отдаёт частоты по экземплярам, интерполяция не нужна
    const values = { INS_HNTCH_ENABLE: 1, INS_HNTCH_MODE: 3, INS_HNTCH_OPTS: 2, INS_HNTCH_REF: 1, INS_HNTCH_FREQ: 50, INS_HNTCH_BW: 25, INS_HNTCH_ATT: 40, INS_HNTCH_FM_RAT: 1, INS_HNTCH_HMNCS: 1, INS_HNTCH_ESCMSK: 0 }
    const filters = load_filters(values, env, tracking)
    assert.deepEqual(filters.warnings, [])
    assert.equal(filters.notch[0].enabled(), true)
    const stats = notch_line_stats(filters, [gyro.start_time, gyro.end_time])
    const h = stats[0].harmonics[0]
    assert.equal(h.harmonic, 1)
    assert.ok(h.min <= h.mean && h.mean <= h.max)
    assert.equal(h.min, 50, '3000 об/мин → 50 Гц')
    assert.equal(h.max, 100, '6000 об/мин → 100 Гц')
    assert.equal(h.mean, 75, 'среднее средних по экземплярам')
    assert.deepEqual(stats[1], { enabled: false, harmonics: [] })
})

test('load_filters: предупреждения трекинга попадают в filters.warnings без повторов', () => {
    // Квадрокоптер с RCOU и обоими наборами параметров моторов: о Q_M_THST_EXPO при наличии MOT_THST_EXPO
    // ThrottleTarget предупреждает ещё до проверок батареи и барометра (Throttle.js:142), поэтому BAT/BARO не нужны
    const params = [['FRAME_CLASS', 1, 0], ['MOT_THST_EXPO', 0.65, 0], ['Q_M_THST_EXPO', 0.5, 0], ['MOT_SPIN_MAX', 0.95, 0], ['MOT_SPIN_MIN', 0.15, 0],
                    ['MOT_PWM_MIN', 1000, 0], ['MOT_PWM_MAX', 2000, 0], ['MOT_BAT_VOLT_MIN', 0, 0], ['MOT_BAT_VOLT_MAX', 0, 0], ['MOT_BAT_IDX', 0, 0]]
    for (let i = 1; i <= 4; i++) {
        params.push(['SERVO' + i + '_FUNCTION', 32 + i, 0])
    }
    const log = fake_log({ messages: { RATE: { TimeUS: [0, 1e6], AOut: [0.3, 0.3] }, RCOU: { TimeUS: [0, 1e6], C1: [1500, 1500] } }, params })
    const gyro = { start_time: 0, end_time: 1 }
    const env = { filter_version: 2, params: log_params(log), build_type: 2 }
    const tracking = create_tracking(log, env, gyro)
    const expected = 'Неожиданный параметр мотора: Q_M_THST_EXPO'
    assert.deepEqual(tracking[1].warnings, [expected])
    // То же предупреждение у второго источника — в сводке оно одно
    tracking[2].warnings.push(expected)
    const filters = load_filters({ INS_HNTCH_ENABLE: 0, INS_HNTC2_ENABLE: 0 }, env, tracking)
    assert.deepEqual(filters.warnings, [expected])
})

test('spectrum_amplitude_scale / spectrum_frequency_scale: русские подписи, функции библиотеки', () => {
    const db = spectrum_amplitude_scale('dB')
    assert.equal(db.label, 'Амплитуда, дБ')
    assert.ok(Math.abs(db.scale([10])[0] - 20) < 1e-9)
    assert.equal(spectrum_amplitude_scale('PSD').label, 'PSD, дБ/Гц')
    assert.equal(spectrum_amplitude_scale('linear').label, 'Амплитуда')
    const rpm = spectrum_frequency_scale('RPM', true)
    assert.equal(rpm.label, 'Обороты, RPM')
    assert.equal(rpm.type, 'log')
    assert.deepEqual(rpm.fun([1]), [60])
    assert.equal(spectrum_frequency_scale('Hz', false).label, 'Частота, Гц')
})

test('mean_spectrum: синусоида 100 Гц → максимум около 100 Гц и ≈ 6 дБ', () => {
    const log = synthetic_batch_log({ freq: 100, amp: 2 })
    const gyro = load_gyro(log, env_for(log), { log_type: null })
    gyro_fft(gyro, { window_size: 1024, window_per_batch: 1 })
    const FFT = gyro[0].FFT
    const scale = spectrum_amplitude_scale('dB')
    const alias = alias_obj(FFT, { mode: 'none', loop_rate: 400 })
    const mean = mean_spectrum(FFT, scale, [gyro.start_time, gyro.end_time + 10], alias)
    const peak = mean.x.indexOf(Math.max(...mean.x))
    assert.ok(Math.abs(mean.bins[peak] - 100) < 1.0)
    // 100 Гц лежит в 0.4 бина от центра бина 99.6 Гц, и окно Ханна оставляет там ≈ 0.90 амплитуды (≈ 5.1 дБ):
    // допуск «≈ 6 дБ» ±1 покрывает эти ~0.9 дБ потери намеренно
    assert.ok(Math.abs(mean.x[peak] - 20 * Math.log10(2)) < 1.0, 'пик ≈ 6 дБ, получили ' + mean.x[peak].toFixed(2))
    assert.ok(mean.y.every((v) => v < -100), 'тишина по Y в дБ')
    assert.equal(mean_spectrum(null, scale, [0, 1], alias), null)
})

test('alias_obj: режим fold сворачивает 300 Гц в 100 Гц при SCHED_LOOP_RATE 400', () => {
    const log = synthetic_batch_log({ freq: 300, amp: 2 })
    const gyro = load_gyro(log, env_for(log), { log_type: null })
    gyro_fft(gyro, { window_size: 1024, window_per_batch: 1 })
    const FFT = gyro[0].FFT
    const linear = spectrum_amplitude_scale('linear')
    const none = mean_spectrum(FFT, linear, [0, 1e9], alias_obj(FFT, { mode: 'none', loop_rate: 400 }))
    const fold = mean_spectrum(FFT, linear, [0, 1e9], alias_obj(FFT, { mode: 'fold', loop_rate: 400 }))
    const only = mean_spectrum(FFT, linear, [0, 1e9], alias_obj(FFT, { mode: 'only', loop_rate: 400 }))
    // Ближайший бин: 300 Гц лежит между бинами 299.8 и 300.8 Гц, и на дальнем (0.8 бина) окно Ханна
    // оставляет лишь 0.65 амплитуды; на ближнем (0.2 бина) — 0.97. Бины свёртки шагом 200/2048 Гц попадают в 100 Гц точно
    const near = (bins, f) => bins.reduce((best, b, i) => (Math.abs(b - f) < Math.abs(bins[best] - f)) ? i : best, 0)
    assert.ok(none.x[near(none.bins, 300)] > 1.5, 'без сворачивания пик на 300 Гц')
    assert.ok(none.x[near(none.bins, 100)] < 0.1, 'без сворачивания на 100 Гц пусто')
    assert.ok(fold.bins[fold.bins.length - 1] <= 200 + 1e-9, 'после сворачивания ось до частоты Найквиста контура')
    assert.ok(fold.x[near(fold.bins, 100)] > 1.0, 'пик свёрнут в 100 Гц')
    assert.ok(only.x[near(only.bins, 100)] > 1.0, 'режим only тоже показывает свёрнутый пик')
})

test('alias_obj: без окон FFT → null в любом режиме', () => {
    const empty = { x: [], bins: [] }
    assert.equal(alias_obj(empty, { mode: 'none', loop_rate: 400 }), null)
    assert.equal(alias_obj(empty, { mode: 'fold', loop_rate: 400 }), null)
    assert.equal(alias_obj(null, { mode: 'none', loop_rate: 400 }), null)
})

test('spectrogram_matrix: по строке на окно, разрыв по времени даёт пустые строки', () => {
    const log = synthetic_batch_log({ batches: 6 })
    const gyro = load_gyro(log, env_for(log), { log_type: null })
    gyro_fft(gyro, { window_size: 1024, window_per_batch: 1 })
    const FFT = gyro[0].FFT
    // Искусственный разрыв: сдвигаем время последних двух окон на 10 с
    for (let j = FFT.time.length - 2; j < FFT.time.length; j++) FFT.time[j] += 10
    const scale = spectrum_amplitude_scale('dB')
    const alias = alias_obj(FFT, { mode: 'none', loop_rate: 400 })
    const spec = spectrogram_matrix(gyro, find_instance(gyro, 0, false), 'x', false, scale, alias)
    assert.equal(spec.x.length, FFT.time.length + 2, 'два маркера разрыва')
    assert.equal(spec.z.length, spec.x.length)
    assert.equal(spec.bins.length, FFT.bins.length)
    const gap_rows = spec.z.filter((row) => row[0] === undefined).length
    assert.equal(gap_rows, 2)
    // Разрыв между третьим с конца и вторым с конца окном, поэтому маркеры стоят в spec.x на местах n−2 и n−1;
    // оба лежат строго внутри разрыва и идут по порядку
    const n = FFT.time.length
    const m1 = spec.x[n - 2], m2 = spec.x[n - 1]
    assert.ok(m1 > FFT.time[n - 3] && m1 < m2 && m2 < FFT.time[n - 2],
        'маркеры ' + m1.toFixed(2) + ', ' + m2.toFixed(2) + ' внутри (' + FFT.time[n - 3].toFixed(2) + ', ' + FFT.time[n - 2].toFixed(2) + ')')
    const peak = FFT.bins.findIndex((b) => b >= 100)
    assert.ok(spec.z[0][peak] > 0, 'пик в первой строке положителен в дБ')
    assert.equal(spectrogram_matrix(gyro, null, 'x', false, scale, alias), null)
    assert.equal(spectrogram_matrix(gyro, 0, 'x', true, scale, alias), null, 'оценка без H невозможна')
})

test('tracking_lines: статический notch с гармониками 1 и 3 → линии 80 и 240 Гц', () => {
    const log = fake_log({ messages: { RATE: { TimeUS: [0, 1e6], AOut: [0.3, 0.3] } } })
    const gyro = { start_time: 0, end_time: 1 }
    const env = { filter_version: 2, params: log_params(log), build_type: 2 }
    const tracking = create_tracking(log, env, gyro)
    const logged = create_logged(log)
    const values = { INS_GYRO_FILTER: 0, INS_HNTCH_ENABLE: 1, INS_HNTCH_MODE: 0, INS_HNTCH_FREQ: 80, INS_HNTCH_BW: 40, INS_HNTCH_ATT: 30, INS_HNTCH_REF: 0, INS_HNTCH_FM_RAT: 1, INS_HNTCH_HMNCS: 5, INS_HNTCH_OPTS: 0, INS_HNTCH_ESCMSK: 0, INS_HNTC2_ENABLE: 0 }
    const filters = load_filters(values, env, tracking)
    const lines = tracking_lines(filters, logged, [0, 1])
    assert.equal(lines.length, 2)
    assert.equal(lines[0].enabled, true)
    assert.deepEqual(lines[0].harmonics.map((h) => h.harmonic), [1, 3])
    assert.deepEqual(lines[0].harmonics[0].freq, [80, 80])
    assert.deepEqual(lines[0].harmonics[1].freq, [240, 240])
    assert.deepEqual(lines[0].harmonics[0].time, [0, 1])
    assert.deepEqual(lines[0].logged, [])
    assert.equal(lines[1].enabled, false)
})

test('tracking_lines: ESC по моторам — линии склеены через NaN с клампом к минимуму, логированный notch без клампа', () => {
    const log = fake_log({ messages: {
        ESC: { instances: {
            0: { TimeUS: [0, 1e6, 2e6], RPM: [6000, 6000, 6000] },
            1: { TimeUS: [0, 1e6, 5e6], RPM: [3000, 3000, 3000] }
        } },
        FTNS: { instances: { 0: { TimeUS: [0, 1e6], NF: [10, 20] } } }
    } })
    const gyro = { start_time: 0, end_time: 6 }
    const env = { filter_version: 2, params: log_params(log), build_type: 2 }
    const tracking = create_tracking(log, env, gyro)
    const logged = create_logged(log)
    // OPTS 2 — notch по каждому мотору; FREQ 60 с FM_RAT 1 даёт минимум 60 Гц, и мотор на 50 Гц поднимается до него
    const values = { INS_HNTCH_ENABLE: 1, INS_HNTCH_MODE: 3, INS_HNTCH_OPTS: 2, INS_HNTCH_REF: 1, INS_HNTCH_FREQ: 60, INS_HNTCH_BW: 25, INS_HNTCH_ATT: 40, INS_HNTCH_FM_RAT: 1, INS_HNTCH_HMNCS: 3, INS_HNTCH_ESCMSK: 0 }
    const filters = load_filters(values, env, tracking)
    assert.deepEqual(filters.warnings, [])
    // Как в upstream (FR 2586): маска гармоник логированного notch берётся из параметров
    logged[0].harmonics = filters.notch[0].harmonics()
    const lines = tracking_lines(filters, logged, [gyro.start_time, gyro.end_time])
    assert.equal(lines[0].enabled, true)
    assert.equal(lines[0].name, filters.notch[0].name())
    assert.deepEqual(lines[0].harmonics.map((h) => h.harmonic), [1, 2])
    assert.deepEqual(lines[0].harmonics[0].time, [0, 1, 2, NaN, 0, 1, 5, NaN])
    assert.deepEqual(lines[0].harmonics[0].freq, [100, 100, 100, NaN, 60, 60, 60, NaN], '50 Гц второго мотора поднято до минимума 60 Гц')
    assert.deepEqual(lines[0].harmonics[1].time, [0, 1, 2, NaN, 0, 1, 5, NaN])
    assert.deepEqual(lines[0].harmonics[1].freq, [200, 200, 200, NaN, 100, 100, 100, NaN], 'вторая гармоника: 2·50 = 100 ≥ 60, клампа нет')
    assert.deepEqual(lines[0].logged, [{ harmonic: 1, time: [0, 1], freq: [10, 20] }, { harmonic: 2, time: [0, 1], freq: [20, 40] }], 'логированные линии без клампа')
    assert.deepEqual(lines[1], { enabled: false, name: null, harmonics: [], logged: [] })
})

// Фикстура автоподбора: batch-лог с тонами 60, 120 и 180 Гц (гармоники 1–3 частоты 60 Гц) амплитудой 2, 1 и 0.5 рад/с
// по X и вполовину по Y поверх белого шума СКО 0.3 рад/с; esc_rpm — ESC-телеметрия четырёх моторов с постоянными
// оборотами, aout — RATE.AOut с постоянным газом. Отсчёты трекинга каждые 0.1 с с 9 по 20 с накрывают пакеты (10…13.1 с).
// Шум нужен по существу: без него ошибка квантования (mul = 1000) у сигнала с периодом 50 отсчётов даёт линии
// на всех кратных 20 Гц, подбор принимает их за гармоники 4–7 (превышение 35–60 дБ), и ослабление упирается в 50 дБ
function autofit_setup({ esc_rpm = null, aout = null } = {}) {
    const messages = batch_messages({ tones: [[60, 2], [120, 1], [180, 0.5]], y_ratio: 0.5, noise: 0.3 })
    const TimeUS = Array.from({ length: 111 }, (_, i) => 9e6 + i * 1e5)
    if (esc_rpm != null) {
        messages.ESC = { instances: {} }
        for (let i = 0; i < 4; i++) {
            messages.ESC.instances[i] = { TimeUS, RPM: TimeUS.map(() => esc_rpm) }
        }
    }
    if (aout != null) {
        messages.RATE = { TimeUS, AOut: TimeUS.map(() => aout) }
    }
    const log = fake_log({ messages, params: gyro_params() })
    const env = env_for(log)
    const gyro = load_gyro(log, env, { log_type: null })
    gyro_fft(gyro, { window_size: 1024, window_per_batch: 1 })
    const tracking = create_tracking(log, env, gyro)
    interpolate_tracking(tracking, gyro)
    return { gyro, tracking, range: [0, 1e9] }
}

test('auto_fit_esc: тоны на гармониках 1–3 частоты ESC 60 Гц → режим 3, гармоники 1–3, частота 0.8·60', () => {
    const { gyro, tracking, range } = autofit_setup({ esc_rpm: 3600 })
    const r = auto_fit_esc(gyro, tracking, range, 0)
    assert.equal(r.error, undefined)
    assert.equal(r.name, 'ESC-телеметрия')
    assert.equal(r.mode, 3)
    assert.equal(r.ref, 1)
    assert.equal(r.min_ratio, 1)
    assert.equal(r.harmonics & 7, 7, 'гармоники 1–3')
    assert.equal(r.harmonics, 7, 'на гармониках 4–7 только шум: превышение 1–2 дБ, меньше порога 6 дБ')
    // Ослабление — превышение пика 60 Гц над медианой шума. Пик: 60 Гц лежит в 0.44 бина от центра, окно Ханна
    // оставляет там 0.881 амплитуды, и бин даёт A·0.5·0.881 — 0.881 по X и 0.44 по Y, мощность ≈ 0.97.
    // Шум: (2/N)²·σ²·Σw² = 1.5·σ²/N на ось, по трём осям 3·1.5·0.09/1024 ≈ 3.96e−4. 10·lg(0.97/3.96e−4) ≈ 33.9 дБ
    assert.ok(r.attenuation >= 10 && r.attenuation <= 50)
    assert.ok(Math.abs(r.attenuation - 34) <= 2, 'ослабление ' + r.attenuation)
    assert.equal(r.freq, Math.round(60 * 0.8), 'обороты постоянны: перцентиль 5 % — те же 60 Гц')
    assert.equal(r.multi_source, true, 'четыре мотора')
})

test('auto_fit_esc: ESC 70 Гц при тех же тонах — сильнейший пик на 0.86× вне кратных, ошибка про полюса', () => {
    const { gyro, tracking, range } = autofit_setup({ esc_rpm: 4200 })
    const r = auto_fit_esc(gyro, tracking, range, 0)
    assert.match(r.error, /полюс/)
    assert.match(r.error, /0\.8[56]×/, '60/70 ≈ 0.857 частоты ESC')
})

test('auto_fit_throttle: газ 0.25 без ESC → режим 1, основная 60 Гц, опора 0.25; без газа по моторам и при нулевом газе — ошибки', () => {
    const { gyro, tracking, range } = autofit_setup({ aout: 0.25 })
    assert.deepEqual(auto_fit_throttle(gyro, tracking, range, true), { error: 'нет газа по моторам' }, 'без RCOU газа по моторам нет')
    const r = auto_fit_throttle(gyro, tracking, range, false)
    assert.equal(r.error, undefined)
    assert.equal(r.name, 'газ')
    assert.equal(r.mode, 1)
    assert.ok(Math.abs(r.freq - 60) <= 1, 'частота ' + r.freq)
    assert.ok(Math.abs(r.ref - 0.25) < 1e-6, 'опора ' + r.ref)
    assert.equal(r.harmonics & 1, 1)
    assert.equal(r.multi_source, false)
    // Газ постоянный — все окна на опорном газе, и нижний предел floor(20·0.8)/20 = 0.8 от основной
    assert.equal(r.min_ratio, 0.8)

    const zero = autofit_setup({ aout: 0 })
    assert.deepEqual(auto_fit_throttle(zero.gyro, zero.tracking, zero.range, false), { error: 'газ равен нулю в интервале анализа' })
})

test('auto_fit: ESC в приоритете, без ESC — газ и причины отказа, без данных до фильтров — ошибка', () => {
    const both = autofit_setup({ esc_rpm: 3600, aout: 0.25 })
    const with_esc = auto_fit(both.gyro, both.tracking, both.range, 0)
    assert.equal(with_esc.result.name, 'ESC-телеметрия')
    assert.deepEqual(with_esc.errors, [])

    const thr = autofit_setup({ aout: 0.25 })
    const fallback = auto_fit(thr.gyro, thr.tracking, thr.range, 0)
    assert.equal(fallback.result.name, 'газ')
    assert.equal(fallback.result.mode, 1)
    assert.deepEqual(fallback.errors, ['нет ESC-телеметрии', 'нет газа по моторам'])

    const none = autofit_setup()
    assert.deepEqual(auto_fit(none.gyro, none.tracking, none.range, 0), { result: null, errors: ['нет ESC-телеметрии', 'нет газа по моторам', 'нет газа'] })

    const no_pre = { result: null, errors: ['Для автоподбора нужны данные гироскопа до фильтров'] }
    assert.deepEqual(auto_fit(null, thr.tracking, thr.range, 0), no_pre)
    assert.deepEqual(auto_fit({ have_pre: false }, thr.tracking, thr.range, 0), no_pre)
})

test('auto_fit_values: INS_HNTCH_* по результату, OPTS без битов 1/16/64, бит 2 по multi_source, ESCMSK не трогается', () => {
    const { gyro, tracking, range } = autofit_setup({ esc_rpm: 3600 })
    const r = auto_fit_esc(gyro, tracking, range, 0)
    const values = auto_fit_values(r, { INS_HNTCH_OPTS: 1 | 16 | 4, INS_HNTCH_ESCMSK: 5 })
    assert.equal(values.INS_HNTCH_ENABLE, 1)
    assert.equal(values.INS_HNTCH_BW, Math.round(r.freq * 0.5))
    assert.equal(values.INS_HNTCH_OPTS & (1 | 16 | 64), 0, 'по одному notch на гармонику')
    assert.equal(values.INS_HNTCH_OPTS & 2, 2, 'несколько моторов — multi source')
    assert.equal(values.INS_HNTCH_OPTS & 4, 4, 'прочие биты сохранены')
    assert.equal('INS_HNTCH_ESCMSK' in values, false)
    assert.deepEqual(values, { INS_HNTCH_ENABLE: 1, INS_HNTCH_MODE: 3, INS_HNTCH_FREQ: 48, INS_HNTCH_BW: 24, INS_HNTCH_ATT: r.attenuation,
                               INS_HNTCH_REF: 1, INS_HNTCH_FM_RAT: 1, INS_HNTCH_HMNCS: 7, INS_HNTCH_OPTS: 6 })
    // Один источник — бит 2 снимается
    assert.equal(auto_fit_values({ ...r, multi_source: false }, { INS_HNTCH_OPTS: 2 | 8 }).INS_HNTCH_OPTS, 8)
})
