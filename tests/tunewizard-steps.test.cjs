// Тесты метрик шагов мастера настройки (TuneWizard/core/metrics.js): пики спектра, атрибуция (по медиане
// и по порядковому спектру), моторная частота; сравнение вариантов notch (TuneWizard/core/candidates.js)
// и статистика линий notch с NaN в трекинге (дефект upstream 8, core/filters.js).
// Скрипты ядра — классические (общая глобальная область), поэтому загружаются как на странице:
// по порядку через vm.runInThisContext (как в tests/tunewizard-core.test.cjs).
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
    'TuneWizard/core/log.js',
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
    'TuneWizard/core/metrics.js',
    'TuneWizard/core/autofit.js',
    'TuneWizard/core/candidates.js',
])

// Параметры без лога: values = { имя: значение }
function fake_params(values) {
    return { get: (name) => (name in values) ? values[name] : null, has: (name) => name in values, changed: () => false }
}

// Поддельный лог с интерфейсом парсера (как в tests/tunewizard-core.test.cjs).
// messages = { ИМЯ: { поле: массив } } — сообщение без экземпляров;
//            { ИМЯ: { instances: { 0: { поле: массив }, 1: {…} } } } — с экземплярами (как ESC):
//            такие сообщения настоящий парсер отдаёт только через get_instance, а get() на них падает.
// params = [[имя, значение, TimeUS], ...] — сообщения PARM
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

const env = { filter_version: 2, params: fake_params({}), build_type: 2 }

// Синтетический спектр: бины 0..500 Гц шагом 1, фон 0 дБ с детерминированной рябью ±0.5 дБ,
// пики +20 дБ на 100/200/300 Гц и +12 дБ на 57 Гц
function synthetic_spectrum() {
    const bins = []
    const amp = []
    for (let i = 0; i <= 500; i++) {
        bins.push(i)
        amp.push(0.5 * Math.sin(i))
    }
    for (const f of [100, 200, 300]) {
        amp[f] += 20
    }
    amp[57] += 12
    return { bins, amp }
}

test('find_peaks: четыре пика по убыванию превышения над шумом, рябь фона — не пики', () => {
    const { bins, amp } = synthetic_spectrum()
    const peaks = find_peaks(bins, amp)
    assert.equal(peaks.length, 4, 'найдено: ' + peaks.map((p) => p.freq).join(', '))
    assert.deepEqual(peaks.slice(0, 3).map((p) => p.freq).sort((a, b) => a - b), [100, 200, 300])
    assert.equal(peaks[3].freq, 57)
    for (const p of peaks.slice(0, 3)) {
        assert.ok(Math.abs(p.excess_dB - 20) <= 1, p.freq + ' Гц: превышение ' + p.excess_dB.toFixed(2))
        assert.equal(p.amp_dB, amp[p.freq])
    }
    assert.ok(Math.abs(peaks[3].excess_dB - 12) <= 1, '57 Гц: превышение ' + peaks[3].excess_dB.toFixed(2))
    for (let i = 1; i < peaks.length; i++) {
        assert.ok(peaks[i - 1].excess_dB >= peaks[i].excess_dB, 'сортировка по убыванию превышения')
    }
})

test('find_peaks: ниже min_freq_hz не ищем, плато из равных соседей — не пик', () => {
    const { bins, amp } = synthetic_spectrum()
    amp[3] += 30                // ниже 5 Гц
    amp[150] += 15              // плато: два равных бина
    amp[151] = amp[150]
    const peaks = find_peaks(bins, amp)
    const freqs = peaks.map((p) => p.freq)
    assert.ok(!freqs.includes(3), 'пик на 3 Гц проигнорирован')
    assert.ok(!freqs.includes(150) && !freqs.includes(151), 'плато не пик')
    assert.equal(peaks.length, 4)
    // Тот же пик выше порога частоты находится
    const custom = find_peaks(bins, amp, { ...peak_rules, min_freq_hz: 1 })
    assert.ok(custom.map((p) => p.freq).includes(3))
})

test('find_peaks: пик ниже порога превышения не попадает в список', () => {
    const { bins, amp } = synthetic_spectrum()
    amp[400] += 4
    assert.ok(!find_peaks(bins, amp).map((p) => p.freq).includes(400), '+4 дБ < 6 дБ')
    assert.ok(find_peaks(bins, amp, { ...peak_rules, min_excess_dB: 3 }).map((p) => p.freq).includes(400))
})

test('attribute_peaks: при 100 Гц три моторных пика с гармониками 1–3, 57 Гц — рама', () => {
    const { bins, amp } = synthetic_spectrum()
    const peaks = find_peaks(bins, amp)
    const attributed = attribute_peaks(peaks, 100)
    assert.equal(attributed.length, 4)
    const by_freq = Object.fromEntries(attributed.map((p) => [p.freq, p]))
    assert.deepEqual([1, 2, 3].map((n) => by_freq[n * 100].source), ['motor', 'motor', 'motor'])
    assert.deepEqual([1, 2, 3].map((n) => by_freq[n * 100].harmonic), [1, 2, 3])
    assert.equal(by_freq[57].source, 'frame')
    assert.equal(by_freq[57].harmonic, null)
    // Поля пика сохраняются, исходные объекты не меняются
    assert.equal(by_freq[100].excess_dB, peaks.find((p) => p.freq == 100).excess_dB)
    assert.equal(peaks[0].source, undefined)
    // Допуск 0.1 порядка относительно основной: 109 Гц — ещё первая гармоника, 112 Гц — уже нет; 308 Гц — третья,
    // а 325 Гц (3.25 порядка) — рама, хотя в ±10 % от 3·100 Гц; выше max_harmonic (900 Гц) — рама
    const edge = attribute_peaks([{ freq: 109 }, { freq: 112 }, { freq: 308 }, { freq: 325 }, { freq: 900 }], 100)
    assert.deepEqual(edge.map((p) => p.source), ['motor', 'frame', 'motor', 'frame', 'frame'])
    assert.deepEqual(edge.map((p) => p.harmonic), [1, null, 3, null, null])
    assert.equal(harmonic_number(195, 100), 2)
    assert.equal(harmonic_number(40, 100), null, 'ниже основной — не гармоника')
})

test('refine_fundamental: основная уточняется по самому выраженному пику первой гармоники', () => {
    // 66 Гц — тоже кандидат первой гармоники (0.91 порядка от 72.6), но слабее 77.7 Гц; от 77.7 Гц он уже 0.85 — рама
    const peaks = [{ freq: 77.7, excess_dB: 20 }, { freq: 153.4, excess_dB: 9 }, { freq: 66, excess_dB: 7 }]
    // Медиана ESC 72.6 Гц: 153.4 Гц — 2.11 порядка (рама), после уточнения по 77.7 Гц — 1.97 (вторая гармоника)
    assert.equal(attribute_peaks(peaks, 72.6)[1].source, 'frame')
    const refined = refine_fundamental(peaks, 72.6)
    assert.equal(refined, 77.7, 'из двух кандидатов первой гармоники — с большим превышением')
    assert.deepEqual(attribute_peaks(peaks, refined).map((p) => p.harmonic), [1, 2, null])
    // Первой гармоники среди пиков нет — основная не меняется; null остаётся null
    assert.equal(refine_fundamental([{ freq: 150, excess_dB: 10 }], 72.6), 72.6)
    assert.equal(refine_fundamental(peaks, null), null)
})

test('find_peaks: два пика в окнах шума друг друга находятся оба; −Infinity в бинах не мешает', () => {
    const { bins, amp } = synthetic_spectrum()
    amp[110] += 15
    for (let i = 400; i < 420; i++) {
        amp[i] = -Infinity       // нулевая амплитуда в дБ
    }
    const peaks = find_peaks(bins, amp)
    const freqs = peaks.map((p) => p.freq).sort((a, b) => a - b)
    assert.deepEqual(freqs, [57, 100, 110, 200, 300])
    assert.ok(peaks.every((p) => Number.isFinite(p.excess_dB)))
    const p110 = peaks.find((p) => p.freq == 110)
    assert.ok(Math.abs(p110.excess_dB - 15) <= 1, '110 Гц: превышение ' + p110.excess_dB.toFixed(2))
})

test('find_peaks: окрестность пика без шума — не уже двух бинов', () => {
    assert.equal(peak_exclusion_hz([0, 1, 2, 3]), 2, 'шаг 1 Гц — peak_half_width_hz')
    assert.ok(Math.abs(peak_exclusion_hz([0, 1.94, 3.88, 5.82]) - 3.88) < 1e-9, 'шаг 1.94 Гц — два бина')
    // Широкий пик (три бина на шаге 2 Гц): соседние бины пика не попадают в шум, превышение не занижено
    const bins = []
    const amp = []
    for (let i = 0; i <= 250; i++) {
        bins.push(2 * i)
        amp.push(0.5 * Math.sin(i))
    }
    amp[50] += 20
    amp[49] += 14
    amp[51] += 14
    const peak = find_peaks(bins, amp).find((p) => p.freq == 100)
    assert.ok(Math.abs(peak.excess_dB - 20) <= 1, 'превышение ' + peak.excess_dB.toFixed(2))
})

test('find_axis_peaks: пики осей сливаются по частоте, у пика — список осей', () => {
    const { bins, amp } = synthetic_spectrum()
    const x = amp.slice()
    const y = bins.map((b, i) => 0.5 * Math.cos(i))
    const z = y.slice()
    // 150 Гц на X (+18) и на Z рядом, 151 Гц (+12): один пик с осями X, Z и превышением X; 250 Гц — только на Y
    x[150] += 18
    z[151] += 12
    y[250] += 10
    const peaks = find_axis_peaks(bins, { X: x, Y: y, Z: z })
    const p150 = peaks.find((p) => Math.abs(p.freq - 150) <= 1)
    assert.equal(p150.freq, 150, 'остаётся пик с наибольшим превышением')
    assert.deepEqual(p150.axes, ['X', 'Z'])
    assert.ok(Math.abs(p150.excess_dB - 18) <= 1)
    assert.equal(peaks.filter((p) => Math.abs(p.freq - 150) <= 2).length, 1, 'одна строка на пик')
    assert.deepEqual(peaks.find((p) => p.freq == 250).axes, ['Y'])
    assert.deepEqual(peaks.find((p) => p.freq == 57).axes, ['X'], 'пик только на X')
    for (let i = 1; i < peaks.length; i++) {
        assert.ok(peaks[i - 1].excess_dB >= peaks[i].excess_dB, 'сортировка по убыванию превышения')
    }
    // Пики дальше max(axis_merge_hz, 2 бина) — разные строки
    const far = find_axis_peaks(bins, { X: x, Z: bins.map((b, i) => 0.5 * Math.cos(i) + ((i == 155) ? 12 : 0)) })
    assert.ok(far.some((p) => p.freq == 150) && far.some((p) => p.freq == 155))
})

test('attribute_peaks: без моторной частоты все пики — рама, гармоник нет', () => {
    const { bins, amp } = synthetic_spectrum()
    const attributed = attribute_peaks(find_peaks(bins, amp), null)
    assert.equal(attributed.length, 4)
    assert.ok(attributed.every((p) => (p.source === 'frame') && (p.harmonic === null)))
})

test('motor_fundamental: ESC — медиана среднего по моторам в диапазоне', () => {
    // Два экземпляра 6000 и 3000 RPM (как в тесте ESCTarget.compute_avg): среднее 100, 75, 75, 50 Гц на 0, 1, 2, 5 с
    const log = fake_log({ messages: { ESC: { instances: {
        0: { TimeUS: [0, 1e6, 2e6], RPM: [6000, 6000, 6000] },
        1: { TimeUS: [0, 1e6, 5e6], RPM: [3000, 3000, 3000] }
    } } } })
    const tracking = create_tracking(log, env, { start_time: 0, end_time: 5 })
    assert.equal(motor_fundamental(tracking, {}, [0, 10]), 75, 'медиана 100, 75, 75, 50')
    assert.equal(motor_fundamental(tracking, {}, [0, 1.5]), 87.5, 'медиана 100 и 75')
})

test('motor_fundamental: без ESC — медиана цели газа по RATE.AOut, без газа — null', () => {
    const log = fake_log({ messages: { RATE: { TimeUS: [0, 1e6, 2e6, 3e6], AOut: [0, 0.25, 0.25, 1.0] } } })
    const tracking = create_tracking(log, env, { start_time: 0, end_time: 3 })
    const values = { INS_HNTCH_FREQ: 100, INS_HNTCH_REF: 0.25, INS_HNTCH_FM_RAT: 1 }
    // Цель freq·√(thr/ref): 0 (газ 0 — отброшен), 100, 100, 200 → медиана 100
    assert.equal(motor_fundamental(tracking, values, [0, 3]), 100)
    assert.equal(motor_fundamental(tracking, values, [2.5, 3]), 200)
    // REF = 0 — цель постоянна и о моторах не говорит
    assert.equal(motor_fundamental(tracking, { ...values, INS_HNTCH_REF: 0 }, [0, 3]), null)

    const empty = create_tracking(fake_log(), env, { start_time: 0, end_time: 3 })
    assert.equal(motor_fundamental(empty, values, [0, 3]), null, 'нет ни ESC, ни газа')
    // FREQ = 0 — цель газа не определена
    assert.equal(motor_fundamental(tracking, { ...values, INS_HNTCH_FREQ: 0 }, [0, 3]), null)
})

test('motor_fundamental: ESC есть, но обороты нулевые — берётся цель газа', () => {
    const log = fake_log({ messages: {
        ESC: { instances: { 0: { TimeUS: [0, 1e6, 2e6], RPM: [0, 0, 0] } } },
        RATE: { TimeUS: [0, 1e6, 2e6], AOut: [0.25, 0.25, 0.25] }
    } })
    const tracking = create_tracking(log, env, { start_time: 0, end_time: 2 })
    assert.equal(tracking.find((t) => t.name === 'ESC').have_data(), true, 'ESC в логе есть')
    assert.equal(motor_fundamental(tracking, { INS_HNTCH_FREQ: 80, INS_HNTCH_REF: 0.25, INS_HNTCH_FM_RAT: 1 }, [0, 2]), 80)
})

// ---------- Атрибуция по порядковому спектру и сравнение вариантов notch ----------

// Batch-лог с ESC-телеметрией: по окну FFT (samples отсчётов на rate Гц) на каждую частоту моторов из esc_hz.
// В окне — тоны на гармониках частоты моторов motor = [[N, амплитуда], ...] и фиксированные тоны
// fixed = [[Гц, амплитуда], ...] по X, вполовину по Y, плюс детерминированный белый шум СКО noise по трём осям
// (без шума ошибка квантования mul = 1000 даёт ложные линии — см. autofit_setup в tunewizard-core.test.cjs).
// ESC — четыре мотора, отсчёты каждые 0.05 с с частотой окна, в которое попадает отсчёт: в центре окна
// интерполяция даёт ровно частоту окна. Загрузчик upstream теряет последний пакет (дефект 5), поэтому в лог
// пишется ещё один пакет с последней частотой — окон FFT ровно esc_hz.length
function esc_batch_log({ esc_hz, motor = [[1, 2], [2, 1]], fixed = [[155, 1.5]], noise = 0.3, rate = 1000, samples = 1024 }) {
    const ISBH = { N: [], type: [], instance: [], smp_cnt: [], mul: [], SampleUS: [], smp_rate: [] }
    const ISBD = { N: [], seqno: [], x: [], y: [], z: [] }
    const scale = 1000
    // Шум с фиксированным зерном: LCG из Numerical Recipes, равномерный на ±√3·noise — СКО ровно noise
    let seed = 1
    const white = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0
        return noise * Math.sqrt(3) * (2 * seed / 2 ** 32 - 1)
    }
    const batch_s = samples / rate
    const per_batch = [...esc_hz, esc_hz[esc_hz.length - 1]]
    for (let b = 0; b < per_batch.length; b++) {
        const f = per_batch[b]
        ISBH.N.push(b); ISBH.type.push(1); ISBH.instance.push(0); ISBH.smp_cnt.push(samples)
        ISBH.mul.push(scale); ISBH.SampleUS.push((10 + b * batch_s) * 1e6); ISBH.smp_rate.push(rate)
        for (let m = 0; m < samples / 32; m++) {
            const x = [], y = [], z = []
            for (let k = 0; k < 32; k++) {
                const t = (m * 32 + k) / rate
                let s = 0
                for (const [n, a] of motor) s += a * Math.sin(2 * Math.PI * n * f * t)
                for (const [freq, a] of fixed) s += a * Math.sin(2 * Math.PI * freq * t)
                x.push(Math.round(scale * (s + white())))
                y.push(Math.round(scale * (0.5 * s + white())))
                z.push(Math.round(scale * white()))
            }
            ISBD.N.push(b); ISBD.seqno.push(m); ISBD.x.push(x); ISBD.y.push(y); ISBD.z.push(z)
        }
    }
    const TimeUS = [], RPM = []
    for (let n = 0; 9 + n * 0.05 < 11 + per_batch.length * batch_s; n++) {
        const t = 9 + n * 0.05
        const b = Math.min(per_batch.length - 1, Math.max(0, Math.floor((t - 10) / batch_s)))
        TimeUS.push(t * 1e6)
        RPM.push(per_batch[b] * 60)
    }
    const ESC = { instances: {} }
    for (let i = 0; i < 4; i++) {
        ESC.instances[i] = { TimeUS, RPM }
    }
    const params = [['INS_GYR_ID', 1, 0], ['INS_LOG_BAT_OPT', 0, 0], ['AHRS_EKF_TYPE', 3, 0], ['EK3_PRIMARY', 0, 0]]
    return fake_log({ messages: { ISBH, ISBD, ESC }, params })
}

// gyro с FFT до фильтров и интерполированным трекингом по esc_batch_log
function esc_setup(options) {
    const log = esc_batch_log(options)
    const log_env = { filter_version: 2, params: log_params(log), build_type: 2 }
    const gyro = load_gyro(log, log_env, { log_type: null })
    gyro_fft(gyro, { window_size: 1024, window_per_batch: 1 })
    const tracking = create_tracking(log, log_env, gyro)
    interpolate_tracking(tracking, gyro)
    return { gyro, env: log_env, tracking, range: [0, 1e9] }
}

// Частота ESC: большинство окон около 60 Гц, выбросы до 50 и 70 Гц — как висение с манёврами (на логе
// пользователя гистограмма частоты ESC тоже собрана у середины). Равномерная развёртка 50→70 здесь не годится:
// фиксированный тон сильнее тона второй гармоники, и в окнах с частотой ≈ 51.7 Гц он ложится ровно на третий
// порядок — порядковый спектр показывает у H3 превышение 7–20 дБ, и 155 Гц попадает в моторные. Это свойство
// метода PR #363 (окна, где резонанс случайно кратен оборотам), а не ошибка атрибуции
const order_esc_hz = [50, 54, 57, 59, 60, 60, 60, 60, 60, 61, 63, 66, 70]

test('motor_order_info + attribute_peaks_order: 60 и 120 Гц — моторы H1 и H2, фиксированные 155 Гц — рама', () => {
    const { gyro, tracking, range } = esc_setup({ esc_hz: order_esc_hz })
    const info = motor_order_info(gyro, tracking, range, 0)
    assert.equal(info.spectrum.tracked.length, order_esc_hz.length, 'по окну на частоту ESC')
    // Процентили как в auto_fit_esc: sorted[floor((n − 1)·p)] из 13 окон — 0-е, 6-е и 11-е
    assert.ok(Math.abs(info.p5 - 50) < 1e-9 && Math.abs(info.p50 - 60) < 1e-9 && Math.abs(info.p95 - 66) < 1e-9, [info.p5, info.p50, info.p95].join(', '))
    const excess = info.order_peaks.map((p) => p.excess)
    assert.equal(info.order_peaks.length, auto_fit_rules.max_harmonic)
    assert.ok(excess[0] > 20 && excess[1] > 20, 'H1 и H2 следуют оборотам: ' + excess.slice(0, 2).map((e) => e.toFixed(1)).join(', '))
    // 155 Гц лежит в диапазоне третьей гармоники [150, 198] Гц, но в порядковом спектре размазан — пика на H3 нет
    assert.ok(!(excess[2] >= peak_rules.min_excess_dB), 'H3 ' + excess[2])

    const FFT = gyro[0].FFT
    const mean = mean_spectrum(FFT, spectrum_amplitude_scale('dB'), range, alias_obj(FFT, { mode: 'none' }))
    const peaks = attribute_peaks_order(find_axis_peaks(mean.bins, { X: mean.x, Y: mean.y, Z: mean.z }), info)
    const near = (freq) => peaks.reduce((best, p) => (Math.abs(p.freq - freq) < Math.abs(best.freq - freq)) ? p : best)
    for (const [freq, source, harmonic] of [[60, 'motor', 1], [120, 'motor', 2], [155, 'frame', null]]) {
        const peak = near(freq)
        assert.ok(Math.abs(peak.freq - freq) < 1.5, 'пик около ' + freq + ' Гц: ' + peak.freq)
        assert.equal(peak.source, source, freq + ' Гц')
        assert.equal(peak.harmonic, harmonic, freq + ' Гц')
        assert.equal(peak.method, 'order')
    }
    assert.ok(peaks.every((p) => p.method === 'order'))
    // Запасной метод помечается своим именем
    assert.ok(attribute_peaks(peaks, 60).every((p) => p.method === 'median'))
})

test('attribute_peaks_order: превышение гармоники и диапазон N·p5…N·p95, из нескольких N — ближе к медиане', () => {
    const excess = [20, 15, 3, -Infinity, 2, 1, 0, -Infinity]
    const info = { order_peaks: excess.map((e, n) => ({ harmonic: n + 1, excess: e })), p5: 47, p50: 72, p95: 110 }
    const freqs = [78, 100, 105, 153, 235, 40, 900]
    const result = attribute_peaks_order(freqs.map((freq) => ({ freq, excess_dB: 10 })), info)
    // 78 — только H1 [47, 110]; 100 — H1 и H2 [94, 220]: 100/1 ближе к 72, чем 100/2; 105 — 52.5 ближе, чем 105 → H2;
    // 153 — H2 (превышение 15); 235 — в диапазоне H3 [141, 330], но превышение 3 < 6 — рама; 40 и 900 — вне диапазонов
    assert.deepEqual(result.map((p) => p.harmonic), [1, 1, 2, 2, null, null, null])
    assert.deepEqual(result.map((p) => p.source), ['motor', 'motor', 'motor', 'motor', 'frame', 'frame', 'frame'])
    assert.equal(result[0].excess_dB, 10, 'поля пика сохраняются')
})

test('motor_order_info: без ESC и без окон с работающими моторами — null', () => {
    const no_esc = create_tracking(fake_log(), env, { start_time: 0, end_time: 1 })
    assert.equal(motor_order_info([], no_esc, [0, 1], 0), null)
    const { gyro, tracking, range } = esc_setup({ esc_hz: [5, 5, 5] })
    assert.equal(motor_order_info(gyro, tracking, range, 0), null, 'частота ESC ниже auto_fit_rules.min_freq — окна пропущены')
})

// Значения параметров «как в логе» (как у пользователя: ESC по моторам, гармоники 1 и 3) и результат автоподбора
const log_values_7a = {
    INS_GYRO_FILTER: 40, SCHED_LOOP_RATE: 400,
    INS_HNTCH_ENABLE: 1, INS_HNTCH_MODE: 3, INS_HNTCH_FREQ: 40, INS_HNTCH_BW: 18, INS_HNTCH_ATT: 15, INS_HNTCH_REF: 1,
    INS_HNTCH_FM_RAT: 1, INS_HNTCH_HMNCS: 5, INS_HNTCH_OPTS: 6, INS_HNTCH_ESCMSK: 0,
    INS_HNTC2_ENABLE: 0, INS_HNTC2_MODE: 1, INS_HNTC2_FREQ: 80, INS_HNTC2_BW: 40, INS_HNTC2_ATT: 40, INS_HNTC2_REF: 0,
    INS_HNTC2_FM_RAT: 1, INS_HNTC2_HMNCS: 3, INS_HNTC2_OPTS: 0, INS_HNTC2_ESCMSK: 0,
}
const fit_7a = { result: { name: 'ESC-телеметрия', mode: 3, freq: 37, ref: 1, min_ratio: 1, multi_source: true, harmonics: 1, attenuation: 24 }, errors: [] }

test('notch_candidates: лог, автоподбор и их сочетания; одинаковые наборы — один раз', () => {
    const candidates = notch_candidates(log_values_7a, fit_7a)
    assert.deepEqual(candidates.map((c) => c.id), ['log', 'fit', 'fit_log_harmonics', 'log_fit_attenuation'])
    assert.deepEqual(candidates.map((c) => c.title), ['Как в логе', 'Автоподбор (ESC-телеметрия)', 'Автоподбор + гармоники из лога', 'Как в логе, ослабление из автоподбора'])
    const short = (c) => ['FREQ', 'BW', 'ATT', 'HMNCS', 'OPTS'].map((n) => c.values['INS_HNTCH_' + n])
    assert.deepEqual(candidates.map(short), [[40, 18, 15, 5, 6], [37, 19, 24, 1, 6], [37, 19, 24, 5, 6], [40, 18, 24, 5, 6]])
    assert.deepEqual(candidates[0].values, log_values_7a)
    assert.notEqual(candidates[0].values, log_values_7a, 'копия, а не тот же объект')
    assert.ok(candidates.every((c) => (c.values.INS_GYRO_FILTER === 40) && (c.values.INS_HNTC2_ENABLE === 0)), 'прочие значения — из лога')

    // Автоподбор с теми же гармониками и ослаблением, что в логе: сочетания совпадают с ним и с логом
    const same = notch_candidates(log_values_7a, { result: { ...fit_7a.result, harmonics: 5, attenuation: 15 }, errors: [] })
    assert.deepEqual(same.map((c) => c.id), ['log', 'fit'])
    // Автоподбор дал ровно значения лога — один вариант
    const as_log = { ...log_values_7a, INS_HNTCH_FREQ: 37, INS_HNTCH_BW: 19, INS_HNTCH_ATT: 24, INS_HNTCH_HMNCS: 1 }
    assert.deepEqual(notch_candidates(as_log, fit_7a).map((c) => c.id), ['log'])
    // Без результата автоподбора — только лог; первый notch в логе выключен — без сочетаний с логом
    assert.deepEqual(notch_candidates(log_values_7a, { result: null, errors: ['нет ESC-телеметрии'] }).map((c) => c.id), ['log'])
    assert.deepEqual(notch_candidates(log_values_7a, null).map((c) => c.id), ['log'])
    assert.deepEqual(notch_candidates({ ...log_values_7a, INS_HNTCH_ENABLE: 0 }, fit_7a).map((c) => c.id), ['log', 'fit'])
})

test('evaluate_candidate: «как в логе» = estimate_post после calculate_transfer_function, FFT.H и FFT.bode.H не меняются', () => {
    const { gyro, env: log_env, tracking, range } = esc_setup({ esc_hz: [56, 58, 60, 60, 60, 62, 64] })
    const values = { ...log_values_7a, INS_HNTCH_BW: 20, INS_HNTCH_ATT: 30, INS_HNTCH_HMNCS: 3, INS_HNTCH_OPTS: 2 }
    const amp = spectrum_amplitude_scale('dB')
    const FFT = gyro[0].FFT
    const alias = alias_obj(FFT, { mode: 'none', loop_rate: 400 })
    calculate_transfer_function(load_filters(values, log_env, tracking), gyro)
    const expected = estimate_post(gyro, 0, amp, range, alias)

    // В gyro — передаточная функция других фильтров, как после правки формы
    const other = { INS_GYRO_FILTER: 80, INS_HNTCH_ENABLE: 1, INS_HNTCH_MODE: 0, INS_HNTCH_FREQ: 100, INS_HNTCH_BW: 50, INS_HNTCH_ATT: 40, INS_HNTCH_HMNCS: 1, INS_HNTCH_FM_RAT: 1, INS_HNTC2_ENABLE: 0 }
    calculate_transfer_function(load_filters(other, log_env, tracking), gyro)
    const H = FFT.H
    const bode_H = FFT.bode.H
    const H_copy = H.map((h) => [h[0].slice(), h[1].slice()])
    const bode_copy = bode_H.map((h) => [h[0].slice(), h[1].slice()])

    const mean = mean_spectrum(FFT, amp, range, alias)
    const peaks = find_axis_peaks(mean.bins, { X: mean.x, Y: mean.y, Z: mean.z })
    assert.ok(peaks.length > candidate_rules.main_peaks, 'пиков больше, чем учитывается: ' + peaks.length)
    const e = evaluate_candidate(values, { gyro, env: log_env, tracking, range, sensor: 0, peaks, loop_rate: 400 })

    assert.equal(e.peaks.length, candidate_rules.main_peaks)
    for (const peak of e.peaks) {
        const k = FFT.bins.indexOf(peak.bin)
        assert.ok(k >= 0 && Math.abs(peak.bin - peak.freq) < 1e-9, 'частота пика шага 1 — бин FFT')
        for (let n = Math.max(0, k - 3); n <= k + 3; n++) {
            for (const axis of ['x', 'y', 'z']) {
                assert.ok(Math.abs(e.spectrum[axis][n] - expected[axis][n]) <= 1e-9, peak.freq + ' Гц, ' + axis + ': ' + e.spectrum[axis][n] + ' против ' + expected[axis][n])
            }
        }
        for (const axis of peak.axes) {
            assert.equal(peak.by_axis[axis].post_dB, expected[axis.toLowerCase()][k])
            assert.equal(peak.by_axis[axis].pre_dB, mean[axis.toLowerCase()][k])
        }
        const sum = (key) => 10 * Math.log10(peak.axes.reduce((s, axis) => s + 10 ** (peak.by_axis[axis][key] / 10), 0))
        assert.ok(Math.abs(peak.post_dB - sum('post_dB')) < 1e-9 && Math.abs(peak.pre_dB - sum('pre_dB')) < 1e-9, 'уровень пика — сумма мощностей осей')
    }
    assert.deepEqual(e.bands.map((b) => b.band), [[20, 400], [60, 200], [200, 500]])
    assert.equal(e.band_dB, e.bands[0].dB)
    // Полоса 20–400 Гц: среднее по бинам суммы мощностей осей
    let sum = 0
    let count = 0
    FFT.bins.forEach((bin, k) => {
        if (bin >= 20 && bin <= 400) {
            sum += 10 ** (expected.x[k] / 10) + 10 ** (expected.y[k] / 10) + 10 ** (expected.z[k] / 10)
            count++
        }
    })
    assert.ok(Math.abs(e.band_dB - 10 * Math.log10(sum / count)) < 1e-9)
    assert.ok(e.lag_ms[10] > 0 && e.lag_ms[30] > 0, 'задержка на 10 и 30 Гц: ' + JSON.stringify(e.lag_ms))
    // Предупреждения — от load_filters (здесь ложное «неподдерживаемый режим 1» у выключенного INS_HNTC2: в логе
    // нет газа — дефект upstream 7, его исправит задача 8)
    assert.deepEqual(e.warnings, load_filters(values, log_env, tracking).warnings)
    assert.equal(e.values, values)

    // Состояние gyro не тронуто
    assert.equal(FFT.H, H, 'тот же массив FFT.H')
    assert.equal(FFT.bode.H, bode_H, 'тот же массив FFT.bode.H')
    assert.deepEqual(FFT.H.map((h) => [h[0].slice(), h[1].slice()]), H_copy)
    assert.deepEqual(FFT.bode.H.map((h) => [h[0].slice(), h[1].slice()]), bode_copy)
})

// Оценка варианта для rank_candidates: мощность в полосе, задержка на 30 Гц, уровни главных пиков после фильтров
function eval_7a(band_dB, lag30, posts) {
    return { band_dB, lag_ms: { 10: 8, 30: lag30 }, peaks: posts.map(([freq, post_dB]) => ({ freq, post_dB })) }
}

test('rank_candidates: лучший по полосе среди не ухудшающих пики и задержку; иначе — лог', () => {
    const log = eval_7a(-40, 10, [[78, -64], [153, -62]])
    // Автоподбор лучше по полосе, но ухудшает 153 Гц на 14 дБ — остаётся лог
    const worse = rank_candidates({ log, fit: eval_7a(-45, 9.8, [[78, -66], [153, -48]]) })
    assert.equal(worse.best_id, 'log')
    assert.deepEqual(worse.flags, { log: { worse_peaks: [], lag_over: false }, fit: { worse_peaks: [153], lag_over: false } })
    // Ухудшение ровно на 3 дБ ещё допустимо, и лучший по полосе выигрывает
    const edge = rank_candidates({ log, fit: eval_7a(-41, 10, [[78, -61], [153, -63]]) })
    assert.equal(edge.best_id, 'fit')
    assert.deepEqual(edge.flags.fit, { worse_peaks: [], lag_over: false })
    // Задержка на 30 Гц +0.6 мс — вариант отмечен, выбирается следующий по полосе
    const lag = rank_candidates({ log, fit: eval_7a(-41, 10.4, [[78, -65], [153, -62]]), combo: eval_7a(-42, 10.6, [[78, -67], [153, -63]]) })
    assert.equal(lag.best_id, 'fit')
    assert.deepEqual(lag.flags.combo, { worse_peaks: [], lag_over: true })
    // Неотмеченный, но хуже лога по полосе — остаётся лог
    assert.equal(rank_candidates({ log, a: eval_7a(-39, 10, [[78, -64], [153, -62]]) }).best_id, 'log')
})

// Задержка дискретного ФНЧ Баттерворта 2-го порядка (DigitalBiquadFilter) на частоте f, мс — по формуле
// H(z) = (b0 + b1·z⁻¹ + b2·z⁻²)/(1 + a1·z⁻¹ + a2·z⁻²) при z = e^(j·2πf/rate), без кода фильтров
function biquad_lag_ms(cutoff, rate, f) {
    const ohm = Math.tan(Math.PI * cutoff / rate)
    const c = 1 + Math.SQRT2 * ohm + ohm * ohm
    const b0 = ohm * ohm / c
    const b1 = 2 * b0
    const b2 = b0
    const a1 = 2 * (ohm * ohm - 1) / c
    const a2 = (1 - Math.SQRT2 * ohm + ohm * ohm) / c
    const w = 2 * Math.PI * f / rate
    const num = Math.atan2(-(b1 * Math.sin(w) + b2 * Math.sin(2 * w)), b0 + b1 * Math.cos(w) + b2 * Math.cos(2 * w))
    const den = Math.atan2(-(a1 * Math.sin(w) + a2 * Math.sin(2 * w)), 1 + a1 * Math.cos(w) + a2 * Math.cos(2 * w))
    return -(num - den) * 180 / Math.PI / 360 / f * 1000
}

test('filters_lag_ms: biquad 40 Гц — как bode_mean и формула; фаза ниже −180° развёрнута', () => {
    const { gyro, env: log_env, tracking, range } = esc_setup({ esc_hz: [60, 60, 60] })
    const lag_from_bode = (bode, f) => -bode.phase_mean[Math.round(f / 0.05)] / 360 / f * 1000

    const filters = load_filters({ INS_GYRO_FILTER: 40, INS_HNTCH_ENABLE: 0, INS_HNTC2_ENABLE: 0 }, log_env, tracking)
    calculate_transfer_function(filters, gyro)
    const bode = bode_mean(gyro, 0, range)
    const lag = filters_lag_ms(filters, gyro, 0, [10, 30], range)
    assert.ok(Math.abs(lag[0] - lag_from_bode(bode, 10)) < 1e-6, '10 Гц: ' + lag[0] + ' против бодэ ' + lag_from_bode(bode, 10))
    assert.ok(Math.abs(lag[0] - biquad_lag_ms(40, gyro[0].FFT.average_sample_rate, 10)) < 1e-6, '10 Гц по формуле')
    // На 30 Гц фаза −67°: скачок от 10 Гц больше 45°, и развёртка get_phase по двум точкам дала бы +293°
    assert.ok(Math.abs(lag[1] - lag_from_bode(bode, 30)) < 1e-6, '30 Гц: ' + lag[1] + ' против бодэ ' + lag_from_bode(bode, 30))
    assert.ok(Math.abs(lag[1] - biquad_lag_ms(40, gyro[0].FFT.average_sample_rate, 30)) < 1e-6, '30 Гц по формуле')

    // ФНЧ 10 Гц и статический notch 45 Гц шириной 40 Гц: фаза на 30 Гц ≈ −207°
    const deep = load_filters({ INS_GYRO_FILTER: 10, INS_HNTCH_ENABLE: 1, INS_HNTCH_MODE: 0, INS_HNTCH_FREQ: 45, INS_HNTCH_BW: 40, INS_HNTCH_ATT: 40, INS_HNTCH_HMNCS: 1, INS_HNTCH_FM_RAT: 1, INS_HNTC2_ENABLE: 0 }, log_env, tracking)
    calculate_transfer_function(deep, gyro)
    const deep_bode = bode_mean(gyro, 0, range)
    assert.ok(deep_bode.phase_mean[600] < -180, 'фаза ' + deep_bode.phase_mean[600])
    const deep_lag = filters_lag_ms(deep, gyro, 0, [10, 30], range)
    assert.ok(Math.abs(deep_lag[1] - lag_from_bode(deep_bode, 30)) < 1e-6, deep_lag[1] + ' против ' + lag_from_bode(deep_bode, 30))
    assert.equal(filters_lag_ms(deep, gyro, 3, [10, 30], range), null, 'нет такого экземпляра')
})

// Оценка «после» лучшего варианта для second_notch_candidate: бины 0…500 Гц шагом 2, фон −60 дБ с рябью ±0.3 дБ,
// bumps = { ось: { частота: дБ } }
function post_eval_7a(bumps) {
    const bins = Array.from({ length: 251 }, (_, i) => 2 * i)
    const axis = (name) => bins.map((bin, i) => -60 + 0.3 * Math.sin(i + name.charCodeAt(0)) + (bumps[name]?.[bin] ?? 0))
    return { spectrum: { bins, x: axis('x'), y: axis('y'), z: axis('z') } }
}

test('second_notch_candidate: статический INS_HNTC2 только для немоторного пика ≥ 6 дБ после фильтров', () => {
    const best = { id: 'log', title: 'Как в логе', values: { ...log_values_7a } }
    const frame = { freq: 155.3, axes: ['X'], source: 'frame', harmonic: null }
    const c = second_notch_candidate(best, post_eval_7a({ x: { 156: 10 } }), [frame, { freq: 78, axes: ['X', 'Y', 'Z'], source: 'motor', harmonic: 1 }])
    assert.equal(c.id, 'second')
    assert.equal(c.base, 'log')
    assert.equal(c.title, 'Как в логе + второй notch на 155 Гц')
    assert.equal(c.peak.freq, 155.3)
    assert.ok(Math.abs(c.peak.excess_dB - 10) < 1, 'превышение ' + c.peak.excess_dB)
    assert.deepEqual(c.values, { ...log_values_7a, INS_HNTC2_ENABLE: 1, INS_HNTC2_MODE: 0, INS_HNTC2_FREQ: 155, INS_HNTC2_BW: 78, INS_HNTC2_ATT: 30,
                                 INS_HNTC2_REF: 0, INS_HNTC2_FM_RAT: 1, INS_HNTC2_HMNCS: 1, INS_HNTC2_OPTS: 0, INS_HNTC2_ESCMSK: 0 })
    assert.equal(best.values.INS_HNTC2_ENABLE, 0, 'исходный вариант не меняется')

    // Моторный пик — дело первого notch
    assert.equal(second_notch_candidate(best, post_eval_7a({ z: { 300: 12 } }), [{ freq: 300, axes: ['Z'], source: 'motor', harmonic: 4 }]), null)
    // Немоторный, но после фильтров всего +4 дБ
    assert.equal(second_notch_candidate(best, post_eval_7a({ x: { 156: 4 } }), [frame]), null)
    // Пик на оси, которой нет в списке осей пика, не считается
    assert.equal(second_notch_candidate(best, post_eval_7a({ y: { 156: 10 } }), [frame]), null)
    // Вне полосы 20–400 Гц
    assert.equal(second_notch_candidate(best, post_eval_7a({ x: { 450: 15 } }), [{ freq: 450, axes: ['X'], source: 'frame' }]), null)
    // Второй notch уже включён
    assert.equal(second_notch_candidate({ ...best, values: { ...log_values_7a, INS_HNTC2_ENABLE: 1 } }, post_eval_7a({ x: { 156: 10 } }), [frame]), null)
    // Из двух немоторных — с большим превышением
    const two = second_notch_candidate(best, post_eval_7a({ x: { 156: 10 }, z: { 300: 14 } }), [frame, { freq: 300, axes: ['Z'], source: 'frame' }])
    assert.equal(two.values.INS_HNTC2_FREQ, 300)
    assert.equal(two.values.INS_HNTC2_BW, 150)
})

test('notch_line_stats: NaN в ESC — среднее по числам (дефект upstream 8), без чисел — null', () => {
    const esc_log = (rpm0) => fake_log({ messages: { ESC: { instances: {
        0: { TimeUS: [0, 1e6, 2e6, 3e6], RPM: rpm0 },
        1: { TimeUS: [0, 1e6, 2e6, 3e6], RPM: [3000, 3000, 3000, 3000] }
    } } } })
    const values = { INS_HNTCH_ENABLE: 1, INS_HNTCH_MODE: 3, INS_HNTCH_REF: 1, INS_HNTCH_FREQ: 40, INS_HNTCH_BW: 20, INS_HNTCH_ATT: 40, INS_HNTCH_FM_RAT: 1, INS_HNTCH_HMNCS: 1, INS_HNTCH_ESCMSK: 0 }
    const stats = (log, options) => {
        const tracking = create_tracking(log, env, { start_time: 0, end_time: 3 })
        return notch_line_stats(load_filters({ ...values, INS_HNTCH_OPTS: options }, env, tracking), [0, 3])[0].harmonics[0]
    }
    const with_nan = esc_log([6000, NaN, 6000, 6000])

    // OPTS 2 — по моторам (многопиковая ветка): мотор 0 — 100 Гц без NaN-отсчёта, мотор 1 — 50 Гц
    const multi = stats(with_nan, 2)
    assert.deepEqual([multi.mean, multi.min, multi.max], [75, 50, 100])

    // OPTS 0 — среднее по моторам (compute_avg): 100 (первый отсчёт, пара не набрана), NaN, 75, 75 → по числам 250/3
    const single = stats(with_nan, 0)
    assert.ok(Number.isFinite(single.mean) && Math.abs(single.mean - 250 / 3) < 1e-9, 'среднее ' + single.mean)
    assert.deepEqual([single.min, single.max], [75, 100])

    // Мотор 0 целиком NaN: по моторам — только мотор 1; в среднем по моторам все средние NaN → null
    const all_nan = esc_log([NaN, NaN, NaN, NaN])
    const multi_nan = stats(all_nan, 2)
    assert.deepEqual([multi_nan.mean, multi_nan.min, multi_nan.max], [50, 50, 50])
    const single_nan = stats(all_nan, 0)
    assert.deepEqual([single_nan.mean, single_nan.min, single_nan.max], [null, null, null])
})
