// Тесты метрик шагов мастера настройки (TuneWizard/core/metrics.js): пики спектра, атрибуция (по медиане
// и по порядковому спектру), моторная частота; сравнение вариантов notch (TuneWizard/core/candidates.js),
// оценка вариантов низкочастотных фильтров шага 3 (TuneWizard/core/lowpass.js: шум D, задержка путей P и D, бодэ)
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
    'TuneWizard/core/lowpass.js',
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
// интерполяция даёт ровно частоту окна. Последний пакет у конца лога загружается (дефект upstream 5 исправлен
// в задаче 8) — окон FFT ровно esc_hz.length
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
    for (let b = 0; b < esc_hz.length; b++) {
        const f = esc_hz[b]
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
    for (let n = 0; 9 + n * 0.05 < 11 + esc_hz.length * batch_s; n++) {
        const t = 9 + n * 0.05
        const b = Math.min(esc_hz.length - 1, Math.max(0, Math.floor((t - 10) / batch_s)))
        TimeUS.push(t * 1e6)
        RPM.push(esc_hz[b] * 60)
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

// Пик среднего спектра, ближайший к частоте freq
function nearest_peak(peaks, freq) {
    return peaks.reduce((best, p) => (Math.abs(p.freq - freq) < Math.abs(best.freq - freq)) ? p : best)
}

// Средний спектр (дБ) и пики по осям экземпляра 0
function mean_peaks(gyro, range) {
    const FFT = gyro[0].FFT
    const mean = mean_spectrum(FFT, spectrum_amplitude_scale('dB'), range, alias_obj(FFT, { mode: 'none' }))
    return { mean, peaks: find_axis_peaks(mean.bins, { X: mean.x, Y: mean.y, Z: mean.z }) }
}

test('motor_order_info + attribute_peaks_order: 60 и 120 Гц — моторы H1 и H2, фиксированные 155 Гц — рама', () => {
    const { gyro, tracking, range } = esc_setup({ esc_hz: order_esc_hz })
    const info = motor_order_info(gyro, tracking, range, 0)
    assert.equal(info.spectrum.tracked.length, order_esc_hz.length, 'по окну на частоту ESC')
    // Процентили как в auto_fit_esc: sorted[floor((n − 1)·p)] из 13 окон — 0-е, 6-е и 11-е
    assert.ok(Math.abs(info.p5 - 50) < 1e-9 && Math.abs(info.p50 - 60) < 1e-9 && Math.abs(info.p95 - 66) < 1e-9, [info.p5, info.p50, info.p95].join(', '))
    assert.ok(Math.abs(info.bin_hz - 1000 / 1024) < 1e-9, 'шаг бинов FFT ' + info.bin_hz)
    const excess = info.order_peaks.map((p) => p.excess)
    assert.equal(info.order_peaks.length, auto_fit_rules.max_harmonic)
    assert.ok(excess[0] > 20 && excess[1] > 20, 'H1 и H2 следуют оборотам: ' + excess.slice(0, 2).map((e) => e.toFixed(1)).join(', '))
    // 155 Гц лежит в диапазоне третьей гармоники, но в порядковом спектре размазан — пика на H3 нет
    assert.ok(!(excess[2] >= peak_rules.min_excess_dB), 'H3 ' + excess[2])

    const peaks = attribute_peaks_order(mean_peaks(gyro, range).peaks, info)
    for (const [freq, source, harmonic] of [[60, 'motor', 1], [120, 'motor', 2], [155, 'frame', null]]) {
        const peak = nearest_peak(peaks, freq)
        assert.ok(Math.abs(peak.freq - freq) < 1.5, 'пик около ' + freq + ' Гц: ' + peak.freq)
        assert.equal(peak.source, source, freq + ' Гц')
        assert.equal(peak.harmonic, harmonic, freq + ' Гц')
        assert.equal(peak.method, 'order')
    }
    assert.ok(peaks.every((p) => p.method === 'order'))
    // Запасной метод помечается своим именем
    assert.ok(attribute_peaks(peaks, 60).every((p) => p.method === 'median'))
})

test('attribute_peaks_order: ровное висение (ESC 60 Гц без разброса) — 60 и 120 Гц моторы, 155 Гц рама', () => {
    // p5 = p95 = 60: без допуска окно гармоники — точка, и пик на бине 59.57 Гц (или 60.55 при 60.3 Гц) уходил в раму
    for (const esc of [60, 60.3]) {
        const { gyro, tracking, range } = esc_setup({ esc_hz: new Array(7).fill(esc) })
        const info = motor_order_info(gyro, tracking, range, 0)
        assert.ok(Math.abs(info.p5 - esc) < 1e-9 && Math.abs(info.p95 - esc) < 1e-9)
        const peaks = attribute_peaks_order(mean_peaks(gyro, range).peaks, info)
        for (const [freq, source, harmonic] of [[esc, 'motor', 1], [2 * esc, 'motor', 2], [155, 'frame', null]]) {
            const peak = nearest_peak(peaks, freq)
            assert.ok(Math.abs(peak.freq - freq) < 1, 'ESC ' + esc + ': пик около ' + freq + ' Гц — ' + peak.freq)
            assert.equal(peak.source, source, 'ESC ' + esc + ', ' + peak.freq + ' Гц')
            assert.equal(peak.harmonic, harmonic, 'ESC ' + esc + ', ' + peak.freq + ' Гц')
        }
    }
})

test('attribute_peaks_order: превышение гармоники, окно N·p5 − tol…N·p95 + tol, из нескольких N — ближе к медиане', () => {
    const order_peaks = (excess) => excess.map((e, n) => ({ harmonic: n + 1, excess: e }))
    const info = { order_peaks: order_peaks([20, 15, 3, -Infinity, 2, 1, 0, -Infinity]), p5: 47, p50: 72, p95: 110, bin_hz: 1 }
    // Допуск max(max(2, 2·1), 0.1·72) = 7.2 Гц: H1 [39.8, 117.2], H2 [86.8, 227.2], H3 [133.8, 337.2]
    const freqs = [78, 100, 105, 153, 235, 35, 900, 40]
    const result = attribute_peaks_order(freqs.map((freq) => ({ freq, excess_dB: 10 })), info)
    // 78 — только H1; 100 — H1 и H2: 100/1 ближе к 72, чем 100/2; 105 — 52.5 ближе, чем 105 → H2; 153 — H2
    // (превышение 15); 235 — в окне H3, но превышение 3 < 6 — рама; 35 и 900 — вне окон; 40 — ниже 47, но в допуске H1
    assert.deepEqual(result.map((p) => p.harmonic), [1, 1, 2, 2, null, null, null, 1])
    assert.deepEqual(result.map((p) => p.source), ['motor', 'motor', 'motor', 'motor', 'frame', 'frame', 'frame', 'motor'])
    assert.equal(result[0].excess_dB, 10, 'поля пика сохраняются')

    // Низкие обороты и грубая сетка: допуск задаёт шаг бинов — max(2, 2·5) = 10 Гц больше 0.1·10 = 1 Гц
    const slow = { order_peaks: order_peaks([20, 3, 3, 3, 3, 3, 3, 3]), p5: 10, p50: 10, p95: 10, bin_hz: 5 }
    assert.deepEqual(attribute_peaks_order([{ freq: 19.5 }, { freq: 20.5 }], slow).map((p) => p.harmonic), [1, null])
    // Без шага бинов — только peak_half_width_hz = 2 Гц
    assert.deepEqual(attribute_peaks_order([{ freq: 11.5 }, { freq: 12.5 }], { ...slow, bin_hz: undefined }).map((p) => p.harmonic), [1, null])
})

test('motor_order_info: без ESC и без окон с работающими моторами — null', () => {
    const no_esc = create_tracking(fake_log(), env, { start_time: 0, end_time: 1 })
    assert.equal(motor_order_info([], no_esc, [0, 1], 0), null)
    const { gyro, tracking, range } = esc_setup({ esc_hz: [5, 5, 5] })
    assert.equal(motor_order_info(gyro, tracking, range, 0), null, 'частота ESC ниже auto_fit_rules.min_freq — окна пропущены')
})

test('attribute_peaks_auto: по порядку при ESC, иначе по медиане с уточнением', () => {
    const { gyro, tracking, range } = esc_setup({ esc_hz: order_esc_hz })
    const { mean, peaks } = mean_peaks(gyro, range)
    const order = attribute_peaks_auto(peaks, { gyro, tracking, range, esc_mask: 0, values: {}, bins: mean.bins })
    assert.equal(order.method, 'order')
    assert.equal(order.info.bin_hz, bin_spacing(mean.bins), 'шаг бинов — по сетке пиков')
    assert.deepEqual(order.peaks, attribute_peaks_order(peaks, motor_order_info(gyro, tracking, range, 0)))
    assert.equal(nearest_peak(order.peaks, 155).source, 'frame')

    // Без ESC: цель газа 100·√(thr/0.25) — 100, 100, 200 Гц, медиана 100; первая гармоника среди пиков — 100 Гц
    const log = fake_log({ messages: { RATE: { TimeUS: [0, 1e6, 2e6, 3e6], AOut: [0, 0.25, 0.25, 1.0] } } })
    const throttle = create_tracking(log, env, { start_time: 0, end_time: 3 })
    const values = { INS_HNTCH_FREQ: 100, INS_HNTCH_REF: 0.25, INS_HNTCH_FM_RAT: 1 }
    const given = [{ freq: 100, excess_dB: 20 }, { freq: 200, excess_dB: 15 }, { freq: 57, excess_dB: 12 }]
    const median = attribute_peaks_auto(given, { gyro: [], tracking: throttle, range: [0, 3], esc_mask: 0, values })
    assert.equal(median.method, 'median')
    assert.deepEqual(median.info, { median_hz: 100, fundamental_hz: 100 })
    assert.deepEqual(median.peaks.map((p) => p.harmonic), [1, 2, null])
    assert.ok(median.peaks.every((p) => p.method === 'median'))
    // Ни ESC, ни газа — всё рама
    const none = attribute_peaks_auto(given, { gyro: [], tracking: create_tracking(fake_log(), env, { start_time: 0, end_time: 3 }), range: [0, 3], esc_mask: 0, values })
    assert.deepEqual(none.info, { median_hz: null, fundamental_hz: null })
    assert.ok(none.peaks.every((p) => p.source === 'frame'))
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
    const ctx = { gyro, env: log_env, tracking, range, sensor: 0, peaks, loop_rate: 400 }
    const e = evaluate_candidate(values, ctx)

    // Оценка «после» — во всех бинах та же, что у estimate_post с FFT.H этих значений
    for (const axis of ['x', 'y', 'z']) {
        assert.equal(e.spectrum[axis].length, expected[axis].length)
        for (let k = 0; k < expected[axis].length; k++) {
            assert.ok(Math.abs(e.spectrum[axis][k] - expected[axis][k]) <= 1e-9, axis + '[' + k + ']: ' + e.spectrum[axis][k] + ' против ' + expected[axis][k])
        }
    }
    assert.deepEqual(e.pre_spectrum, mean, 'средний спектр до фильтров')
    assert.equal(e.peaks.length, candidate_rules.main_peaks)
    for (const peak of e.peaks) {
        const k = FFT.bins.indexOf(peak.bin)
        assert.ok(k >= 0 && Math.abs(peak.bin - peak.freq) < 1e-9, 'частота пика шага 1 — бин FFT')
        assert.equal(peak.source, 'main')
        for (const axis of peak.axes) {
            assert.equal(peak.by_axis[axis].post_dB, expected[axis.toLowerCase()][k])
            assert.equal(peak.by_axis[axis].pre_dB, mean[axis.toLowerCase()][k])
        }
        const sum = (key) => 10 * Math.log10(peak.axes.reduce((s, axis) => s + 10 ** (peak.by_axis[axis][key] / 10), 0))
        assert.ok(Math.abs(peak.post_dB - sum('post_dB')) < 1e-9 && Math.abs(peak.pre_dB - sum('pre_dB')) < 1e-9, 'уровень пика — сумма мощностей осей')
    }
    assert.deepEqual(e.bands.map((b) => b.band), [[20, 400], [60, 200], [200, 500]])
    assert.equal(e.band_dB, e.bands[0].dB)
    // Полоса 20–400 Гц: среднее по бинам суммы мощностей осей; band_f2_dB — то же с весом (f / 100 Гц)²
    let sum = 0
    let sum_f2 = 0
    let count = 0
    FFT.bins.forEach((bin, k) => {
        if (bin >= 20 && bin <= 400) {
            const power = 10 ** (expected.x[k] / 10) + 10 ** (expected.y[k] / 10) + 10 ** (expected.z[k] / 10)
            sum += power
            sum_f2 += power * (bin / 100) ** 2
            count++
        }
    })
    assert.ok(Math.abs(e.band_dB - 10 * Math.log10(sum / count)) < 1e-9)
    assert.ok(Math.abs(e.band_f2_dB - 10 * Math.log10(sum_f2 / count)) < 1e-9)
    assert.ok(e.lag_ms[10] > 0 && e.lag_ms[30] > 0, 'задержка на 10 и 30 Гц: ' + JSON.stringify(e.lag_ms))
    // Предупреждения — от load_filters. Выключенный INS_HNTC2 с режимом 1 в логе без газа больше не даёт ложного
    // «неподдерживаемый режим 1» (дефекты upstream 4 и 7 исправлены в задаче 8)
    assert.deepEqual(e.warnings, load_filters(values, log_env, tracking).warnings)
    assert.deepEqual(e.warnings, [])
    assert.equal(e.values, values)
    // Второй вариант на том же ctx берёт закэшированный спектр «до»
    assert.equal(evaluate_candidate(other, ctx).pre_spectrum, e.pre_spectrum)

    // Состояние gyro не тронуто
    assert.equal(FFT.H, H, 'тот же массив FFT.H')
    assert.equal(FFT.bode.H, bode_H, 'тот же массив FFT.bode.H')
    assert.deepEqual(FFT.H.map((h) => [h[0].slice(), h[1].slice()]), H_copy)
    assert.deepEqual(FFT.bode.H.map((h) => [h[0].slice(), h[1].slice()]), bode_copy)

    // ctx.sensor — индекс экземпляра; без экземпляра или без данных «до» (нет Z1) оценки нет
    assert.equal(evaluate_candidate(values, { ...ctx, sensor: 5 }), null)
    const post_only = [{ FFT: { ...FFT, Z1: null, Z2: null } }]
    assert.equal(evaluate_candidate(values, { ...ctx, gyro: post_only }), null)
})

// ---------- Оценка вариантов низкочастотных фильтров шага 3 (core/lowpass.js) ----------

// Значения шага 3 «как в логе» (как у пользователя: FLTD 30, FLTT 20, FLTE крена и тангажа 0)
const lowpass_values_8 = {
    INS_GYRO_FILTER: 40, INS_ACCEL_FILTER: 10,
    ATC_RAT_RLL_FLTT: 20, ATC_RAT_RLL_FLTE: 0, ATC_RAT_RLL_FLTD: 30,
    ATC_RAT_PIT_FLTT: 20, ATC_RAT_PIT_FLTE: 0, ATC_RAT_PIT_FLTD: 30,
    ATC_RAT_YAW_FLTT: 20, ATC_RAT_YAW_FLTE: 1, ATC_RAT_YAW_FLTD: 0,
    ATC_ACCEL_R_MAX: 90000, ATC_ACCEL_P_MAX: 90000, ATC_ACCEL_Y_MAX: 50000,
}
const lowpass_kd_8 = { roll: 0.004, pitch: 0.005 }

// Синтетический гироскоп 1000 Гц (esc_setup) и контекст шага 3: notch-база — значения лога этапа 2 (контур 400 Гц)
function lowpass_setup({ options = { esc_hz: [56, 58, 60, 60, 60, 62, 64] }, kd = lowpass_kd_8 } = {}) {
    const setup = esc_setup(options)
    const base = { gyro: setup.gyro, env: setup.env, tracking: setup.tracking, range: setup.range, sensor: 0 }
    return { ...setup, base, ctx: lowpass_ctx(base, { ...log_values_7a }, kd) }
}

// Метрики оценки одним объектом для сравнения: шум гироскопа, шум D осей, задержки путей
function lowpass_metrics(e) {
    return { gyro: e.gyro.band_dB, roll: e.dterm.roll?.dB, pitch: e.dterm.pitch?.dB, lag: e.lag_ms }
}

// Индекс наибольшего конечного значения
function argmax_finite(values) {
    let best = -1
    values.forEach((v, k) => {
        if (Number.isFinite(v) && ((best < 0) || (v > values[best]))) {
            best = k
        }
    })
    return best
}

test('evaluate_lowpass: одинаковые значения — разница ровно 0; FLTT, INS_ACCEL_FILTER, рыскание и пределы в метрики не входят', () => {
    const { ctx, env: log_env, tracking } = lowpass_setup()
    assert.equal(ctx.loop_rate, 400, 'контур — SCHED_LOOP_RATE notch-базы')
    assert.deepEqual(ctx.peaks, [])
    assert.equal(ctx.sensor, 0)
    assert.deepEqual(ctx.kd, lowpass_kd_8)

    const a = evaluate_lowpass(lowpass_values_8, ctx)
    const b = evaluate_lowpass({ ...lowpass_values_8 }, ctx)
    assert.equal(b.gyro.band_dB - a.gyro.band_dB, 0)
    assert.equal(b.dterm.roll.dB - a.dterm.roll.dB, 0)
    assert.equal(b.dterm.pitch.dB - a.dterm.pitch.dB, 0)
    assert.deepEqual(b.lag_ms, a.lag_ms)
    assert.deepEqual(lowpass_flags(b, a), { noisier: [], slower: [], incomplete: false, incomplete_axes: [], d_off_axes: [] })

    // То, что не стоит на пути гироскоп → P/D крена и тангажа, метрики не меняет
    const other = evaluate_lowpass({ ...lowpass_values_8, ATC_RAT_RLL_FLTT: 5, ATC_RAT_PIT_FLTT: 50, INS_ACCEL_FILTER: 20,
                                     ATC_RAT_YAW_FLTE: 2.5, ATC_RAT_YAW_FLTD: 20, ATC_ACCEL_R_MAX: 1 }, ctx)
    assert.deepEqual(lowpass_metrics(other), lowpass_metrics(a))

    // Форма результата
    assert.equal(a.values, lowpass_values_8)
    assert.deepEqual(a.warnings, load_filters(log_values_7a, log_env, tracking).warnings)
    assert.deepEqual(a.kd, lowpass_kd_8, 'Kd контекста — в оценке')
    assert.notEqual(a.kd, ctx.kd, 'копия, а не тот же объект')
    assert.equal(a.dterm.bins[0], 0)
    const top = a.dterm.bins[a.dterm.bins.length - 1]
    assert.ok(Math.abs(top - 200) < 1e-9, 'до частоты Найквиста контура: ' + top)
    for (const axis of ['roll', 'pitch']) {
        assert.equal(a.dterm[axis].spectrum.length, a.dterm.bins.length)
        assert.equal(a.dterm[axis].spectrum[0], -Infinity, 'на 0 Гц производная равна нулю')
        assert.ok(Number.isFinite(a.dterm[axis].dB))
        for (const path of ['P', 'D']) {
            assert.deepEqual(Object.keys(a.lag_ms[axis][path]), ['10', '30'])
        }
    }
    assert.deepEqual(Object.keys(a.gyro).sort(), ['band_dB', 'lag_ms', 'pre_spectrum', 'spectrum'])
})

test('evaluate_lowpass: шум гироскопа «как в логе» — тот же, что на шаге 2; шум D — свёрнутая PSD × производная × FLTE × FLTD', () => {
    const { gyro, env: log_env, tracking, range, ctx } = lowpass_setup()
    const values = { ...lowpass_values_8, ATC_RAT_RLL_FLTE: 10, ATC_RAT_PIT_FLTD: 15 }
    const e = evaluate_lowpass(values, ctx)

    // Шаг 2 с той же notch-базой: то же число, та же задержка гироскопной части
    const step2 = evaluate_candidate(log_values_7a, { gyro, env: log_env, tracking, range, sensor: 0, peaks: [], loop_rate: 400 })
    assert.equal(e.gyro.band_dB, step2.band_dB)
    assert.deepEqual(e.gyro.lag_ms, step2.lag_ms)
    assert.deepEqual(e.gyro.spectrum, step2.spectrum)

    // Задержка: путь P = гироскопная часть + FLTE оси, путь D = путь P + FLTD оси
    for (const [axis, flte, fltd] of [['roll', 10, 30], ['pitch', 0, 15]]) {
        for (const f of [10, 30]) {
            const P = step2.lag_ms[f] + pid_lowpass_lag_ms(flte, 400, f)
            assert.ok(Math.abs(e.lag_ms[axis].P[f] - P) < 1e-12, axis + ' P на ' + f + ' Гц')
            assert.ok(Math.abs(e.lag_ms[axis].D[f] - P - pid_lowpass_lag_ms(fltd, 400, f)) < 1e-12, axis + ' D на ' + f + ' Гц')
        }
    }

    // Шум D отдельно: PSD после фильтров базы через FFT.H (calculate_transfer_function), свёрнутая к 200 Гц;
    // крен — ось X, тангаж — ось Y
    calculate_transfer_function(load_filters(log_values_7a, log_env, tracking), gyro)
    const alias = alias_obj(gyro[0].FFT, { mode: 'fold', loop_rate: 400 })
    const psd = estimate_post(gyro, 0, spectrum_amplitude_scale('PSD'), range, alias)
    assert.deepEqual(e.dterm.bins, alias.bins)
    const abs2 = (h) => h[0] ** 2 + h[1] ** 2
    for (const [axis, key, kd, flte, fltd] of [['roll', 'x', 0.004, 10, 30], ['pitch', 'y', 0.005, 0, 15]]) {
        let sum = 0
        let count = 0
        alias.bins.forEach((f, k) => {
            const D = kd ** 2 * 10 ** (psd[key][k] / 10) * pid_lowpass_derivative_gain2(f, 400) * abs2(pid_lowpass_response(flte, 400, f)) * abs2(pid_lowpass_response(fltd, 400, f))
            const got = e.dterm[axis].spectrum[k]
            assert.ok((k == 0) ? (got === -Infinity) : (Math.abs(got - 10 * Math.log10(D)) < 1e-9), axis + ' ' + f + ' Гц: ' + got + ' против ' + 10 * Math.log10(D))
            if ((f >= 20) && (f <= 200)) {
                sum += D
                count++
            }
        })
        assert.ok(Math.abs(e.dterm[axis].dB - 10 * Math.log10(sum / count)) < 1e-9, axis + ': среднее по 20–200 Гц')
    }
})

test('evaluate_lowpass: FLTD 30 → 15 — шум D крена и тангажа ниже, путь D медленнее, путь P прежний', () => {
    const { ctx } = lowpass_setup()
    const log = evaluate_lowpass(lowpass_values_8, ctx)
    const half = evaluate_lowpass({ ...lowpass_values_8, ATC_RAT_RLL_FLTD: 15, ATC_RAT_PIT_FLTD: 15 }, ctx)
    for (const axis of ['roll', 'pitch']) {
        assert.ok(half.dterm[axis].dB < log.dterm[axis].dB - 1, axis + ': ' + log.dterm[axis].dB + ' → ' + half.dterm[axis].dB)
        assert.deepEqual(half.lag_ms[axis].P, log.lag_ms[axis].P)
        for (const f of [10, 30]) {
            assert.ok(half.lag_ms[axis].D[f] > log.lag_ms[axis].D[f], axis + ' D на ' + f + ' Гц')
            // Разница — ровно разница задержек FLTD
            const expected = pid_lowpass_lag_ms(15, 400, f) - pid_lowpass_lag_ms(30, 400, f)
            assert.ok(Math.abs(half.lag_ms[axis].D[f] - log.lag_ms[axis].D[f] - expected) < 1e-9)
        }
    }
    assert.equal(half.gyro.band_dB, log.gyro.band_dB, 'гироскоп не меняется')
    assert.deepEqual(lowpass_flags(half, log).slower, [{ axis: 'roll', path: 'D' }, { axis: 'pitch', path: 'D' }], '30 → 15 Гц добавляет на 30 Гц больше 1 мс')
    assert.deepEqual(lowpass_flags(half, log).noisier, [])
})

test('evaluate_lowpass: INS_GYRO_FILTER 80 → 40 — шум гироскопа ниже, пути P и D медленнее', () => {
    const { ctx } = lowpass_setup()
    const fast = evaluate_lowpass({ ...lowpass_values_8, INS_GYRO_FILTER: 80 }, ctx)
    const slow = evaluate_lowpass({ ...lowpass_values_8, INS_GYRO_FILTER: 40 }, ctx)
    assert.ok(slow.gyro.band_dB < fast.gyro.band_dB - 1, fast.gyro.band_dB + ' → ' + slow.gyro.band_dB)
    for (const axis of ['roll', 'pitch']) {
        assert.ok(slow.dterm[axis].dB < fast.dterm[axis].dB, axis + ': шум D тоже ниже')
        for (const f of [10, 30]) {
            const gyro_delta = slow.gyro.lag_ms[f] - fast.gyro.lag_ms[f]
            assert.ok(gyro_delta > 0, 'гироскопная часть медленнее на ' + f + ' Гц')
            // Фильтры ПИД те же — пути P и D замедляются ровно на гироскопную часть
            assert.ok(Math.abs(slow.lag_ms[axis].P[f] - fast.lag_ms[axis].P[f] - gyro_delta) < 1e-9)
            assert.ok(Math.abs(slow.lag_ms[axis].D[f] - fast.lag_ms[axis].D[f] - gyro_delta) < 1e-9)
        }
    }
    const flags = lowpass_flags(slow, fast)
    assert.deepEqual(flags.noisier, [])
    assert.deepEqual(flags.slower, [{ axis: 'roll', path: 'P' }, { axis: 'roll', path: 'D' }, { axis: 'pitch', path: 'P' }, { axis: 'pitch', path: 'D' }])
    assert.deepEqual(lowpass_flags(fast, slow).noisier, ['gyro', 'roll', 'pitch'], 'обратно — шумнее больше чем на 3 дБ')
})

test('evaluate_lowpass: тон 233 Гц на гироскопе 1000 Гц сворачивается в спектре D-составляющей к 167 Гц (контур 400 Гц)', () => {
    // Только тон и слабый шум (0.1), ФНЧ гироскопа 80 Гц: тон над шумом D на 22 дБ по крену и 15 дБ по тангажу
    // (по Y тон вдвое слабее). С шумом 0.3 и ФНЧ 40 Гц у тангажа шум D около 18 Гц выше тона
    const { ctx } = lowpass_setup({ options: { esc_hz: [60, 60, 60, 60, 60], motor: [], fixed: [[233, 1.5]], noise: 0.1 } })
    const e = evaluate_lowpass({ ...lowpass_values_8, INS_GYRO_FILTER: 80 }, ctx)
    const bins = e.dterm.bins
    for (const axis of ['roll', 'pitch']) {
        const k = argmax_finite(e.dterm[axis].spectrum)
        assert.ok(Math.abs(bins[k] - 167) <= 1, axis + ': пик D на ' + bins[k] + ' Гц')
    }
    // Сам тон — на 233 Гц в спектре гироскопа (без свёртки)
    const gyro_bins = e.gyro.spectrum.bins
    const peak = argmax_finite(e.gyro.spectrum.x.map((v, k) => (gyro_bins[k] >= 100) ? v : -Infinity))
    assert.ok(Math.abs(gyro_bins[peak] - 233) <= 1, 'тон гироскопа на ' + gyro_bins[peak] + ' Гц')
})

test('evaluate_lowpass: Kd — удвоение даёт +6.02 дБ в каждом бине; без Kd или с Kd = 0 — dterm оси null, отметки различают', () => {
    const { base } = lowpass_setup()
    const notch = { ...log_values_7a }
    const one = evaluate_lowpass(lowpass_values_8, lowpass_ctx(base, notch, { roll: 0.004, pitch: 0.005 }))
    const two = evaluate_lowpass(lowpass_values_8, lowpass_ctx(base, notch, { roll: 0.008, pitch: 0.005 }))
    const six = 20 * Math.log10(2)
    one.dterm.roll.spectrum.forEach((dB, k) => {
        const got = two.dterm.roll.spectrum[k]
        assert.ok(Number.isFinite(dB) ? (Math.abs(got - dB - six) < 1e-9) : (got === dB), k + ': ' + dB + ' → ' + got)
    })
    assert.ok(Math.abs(two.dterm.roll.dB - one.dterm.roll.dB - six) < 1e-9)
    assert.deepEqual(two.dterm.pitch, one.dterm.pitch, 'Kd тангажа тот же')

    // Kd нет в логе (null, нет поля) — ось неполная; Kd = 0 — D выключен, ось в d_off_axes
    for (const [kd, incomplete, off] of [[{ roll: null, pitch: 0.005 }, ['roll'], []], [{ pitch: 0.005 }, ['roll'], []],
                                         [{ roll: 0, pitch: 0.005 }, [], ['roll']]]) {
        const e = evaluate_lowpass(lowpass_values_8, lowpass_ctx(base, notch, kd))
        assert.equal(e.dterm.roll, null, JSON.stringify(kd))
        assert.deepEqual(e.dterm.pitch, one.dterm.pitch)
        assert.deepEqual(e.lag_ms, one.lag_ms, 'задержка от Kd не зависит')
        assert.deepEqual(e.kd, { roll: kd.roll ?? null, pitch: 0.005 })
        const flags = lowpass_flags(e, e)
        assert.deepEqual([flags.incomplete_axes, flags.d_off_axes], [incomplete, off], JSON.stringify(kd))
    }
    const none = evaluate_lowpass(lowpass_values_8, lowpass_ctx(base, notch, null))
    assert.equal(none.dterm.roll, null)
    assert.equal(none.dterm.pitch, null)
    assert.deepEqual(none.kd, { roll: null, pitch: null })
})

test('evaluate_lowpass: нечисловые FLTE/FLTD — задержка и шум D NaN, вариант отмечается', () => {
    const { ctx } = lowpass_setup()
    const log = evaluate_lowpass(lowpass_values_8, ctx)
    const broken = evaluate_lowpass({ ...lowpass_values_8, ATC_RAT_RLL_FLTE: undefined, ATC_RAT_PIT_FLTD: NaN }, ctx)
    assert.ok(Number.isNaN(broken.lag_ms.roll.P[30]) && Number.isNaN(broken.lag_ms.roll.D[30]), 'FLTE крена — оба пути')
    assert.ok(Number.isFinite(broken.lag_ms.pitch.P[30]) && Number.isNaN(broken.lag_ms.pitch.D[30]), 'FLTD тангажа — только путь D')
    assert.ok(Number.isNaN(broken.dterm.roll.dB) && Number.isNaN(broken.dterm.pitch.dB))
    const flags = lowpass_flags(broken, log)
    assert.deepEqual(flags.noisier, ['roll', 'pitch'])
    assert.deepEqual(flags.slower, [{ axis: 'roll', path: 'P' }, { axis: 'roll', path: 'D' }, { axis: 'pitch', path: 'D' }])
    assert.deepEqual(flags.incomplete_axes, [], 'шум D посчитан, но нечисловой — отметка, а не неполная ось')
})

test('evaluate_lowpass: нечисловой INS_GYRO_FILTER (пустое поле формы) — шум гироскопа, шум D и задержки NaN, вариант отмечается', () => {
    const { ctx } = lowpass_setup()
    const log = evaluate_lowpass(lowpass_values_8, ctx)
    // Пустое поле формы даёт NaN (step3_values_from_form). Отсутствующее значение (undefined) — другое: load_filters,
    // как upstream, берёт для него 0, то есть фильтр выключен
    const broken = evaluate_lowpass({ ...lowpass_values_8, INS_GYRO_FILTER: NaN }, ctx)
    assert.ok(broken != null, 'оценка есть')
    assert.ok(!Number.isFinite(broken.gyro.band_dB), 'шум гироскопа нечисловой: ' + broken.gyro.band_dB)
    for (const axis of ['roll', 'pitch']) {
        assert.ok(!Number.isFinite(broken.dterm[axis].dB), axis + ': шум D нечисловой')
        for (const path of ['P', 'D']) {
            assert.ok(!Number.isFinite(broken.lag_ms[axis][path][30]), axis + ' ' + path + ': задержка нечисловая')
        }
    }
    // Отказ при сомнении: полоса гироскопа нечисловая — оценка неполная, вариант отмечен (сравнивать не с чем,
    // поэтому списки «шумнее» и «медленнее» не заполняются)
    const flags = lowpass_flags(broken, log)
    assert.equal(flags.incomplete, true, 'вариант отмечен как неполный')
    assert.deepEqual([flags.noisier, flags.slower], [[], []], 'списки «шумнее» и «медленнее» пусты')
    assert.equal(lowpass_flags(log, broken).incomplete, true, 'и лог с таким значением тоже не сравнивается')
})

test('evaluate_lowpass: контур 1000 Гц на гироскопе 1000 Гц — полоса D 20…400 Гц, а не до 500 (min(band_hz[1], Найквист))', () => {
    const { base } = lowpass_setup()
    const ctx = lowpass_ctx(base, { ...log_values_7a, SCHED_LOOP_RATE: 1000 }, lowpass_kd_8)
    const e = evaluate_lowpass(lowpass_values_8, ctx)
    const bins = e.dterm.bins
    assert.ok(Math.abs(bins[bins.length - 1] - 500) < 1e-9, 'свёртка к 500 Гц: ' + bins[bins.length - 1])
    const mean_dB = (spectrum, lo, hi) => {
        let sum = 0
        let count = 0
        bins.forEach((f, k) => {
            if ((f >= lo) && (f <= hi)) {
                sum += 10 ** (spectrum[k] / 10)
                count++
            }
        })
        return 10 * Math.log10(sum / count)
    }
    for (const axis of ['roll', 'pitch']) {
        const spectrum = e.dterm[axis].spectrum
        assert.ok(Math.abs(e.dterm[axis].dB - mean_dB(spectrum, 20, 400)) < 1e-9, axis + ': среднее по 20–400 Гц')
        assert.ok(Math.abs(e.dterm[axis].dB - mean_dB(spectrum, 20, 500)) > 0.1, axis + ': до 500 Гц — другое число')
    }
})

test('evaluate_lowpass и lowpass_bode: контур или шаг сетки не положительное конечное число — null', () => {
    const { base, ctx } = lowpass_setup()
    for (const loop_rate of [0, -400, NaN, Infinity, undefined, null]) {
        const bad = lowpass_ctx(base, { ...log_values_7a, SCHED_LOOP_RATE: loop_rate }, lowpass_kd_8)
        assert.equal(evaluate_lowpass(lowpass_values_8, bad), null, 'контур ' + loop_rate)
        assert.equal(lowpass_bode(lowpass_values_8, bad), null, 'бодэ, контур ' + loop_rate)
    }
    for (const step of [0, -0.05, NaN, Infinity, null]) {
        assert.equal(lowpass_bode(lowpass_values_8, ctx, step), null, 'шаг ' + step)
    }
})

test('lowpass_bode: гироскопная часть — как filters_lag_ms и bode_mean; пути P и D обеих осей — она × FLTE (× FLTD)', () => {
    const { gyro, env: log_env, tracking, range, ctx } = lowpass_setup()
    const values = { ...lowpass_values_8, ATC_RAT_PIT_FLTE: 10, ATC_RAT_PIT_FLTD: 15 }
    const e = evaluate_lowpass(values, ctx)
    const lag_at = (phase, f) => -phase / 360 / f * 1000
    const deg = (h) => Math.atan2(h[1], h[0]) * 180 / Math.PI
    const db = (h) => 20 * Math.log10(Math.hypot(h[0], h[1]))

    const bode = lowpass_bode(values, ctx)
    assert.deepEqual(Object.keys(bode).sort(), ['freq', 'gyro', 'pitch', 'roll'])
    assert.equal(bode.freq.length, 4001)
    assert.equal(bode.freq[0], 0)
    assert.equal(bode.freq[4000], 200)
    for (const f of [10, 30]) {
        const k = Math.round(f / 0.05)
        assert.equal(bode.freq[k], f)
        // Гироскопная часть — её задержка — filters_lag_ms внутри evaluate_candidate; у крена FLTE 0 — путь P совпадает
        assert.ok(Math.abs(lag_at(bode.gyro.phase_deg[k], f) - e.gyro.lag_ms[f]) < 1e-6, 'гироскоп на ' + f + ' Гц: ' + lag_at(bode.gyro.phase_deg[k], f) + ' против ' + e.gyro.lag_ms[f])
        assert.equal(bode.roll.P.phase_deg[k], bode.gyro.phase_deg[k])
        assert.equal(bode.roll.P.amp_dB[k], bode.gyro.amp_dB[k])
        for (const axis of ['roll', 'pitch']) {
            for (const path of ['P', 'D']) {
                assert.ok(Math.abs(lag_at(bode[axis][path].phase_deg[k], f) - e.lag_ms[axis][path][f]) < 1e-6, axis + ' ' + path + ' на ' + f + ' Гц')
            }
        }
    }
    const k30 = 600
    // Крен: FLTE 0, FLTD 30; тангаж: FLTE 10, FLTD 15
    assert.ok(Math.abs(bode.roll.D.phase_deg[k30] - bode.roll.P.phase_deg[k30] - deg(pid_lowpass_response(30, 400, 30))) < 1e-6)
    assert.ok(Math.abs(bode.roll.D.amp_dB[k30] - bode.roll.P.amp_dB[k30] - db(pid_lowpass_response(30, 400, 30))) < 1e-9)
    assert.ok(Math.abs(bode.pitch.P.phase_deg[k30] - bode.gyro.phase_deg[k30] - deg(pid_lowpass_response(10, 400, 30))) < 1e-9)
    assert.ok(Math.abs(bode.pitch.P.amp_dB[k30] - bode.gyro.amp_dB[k30] - db(pid_lowpass_response(10, 400, 30))) < 1e-9)
    assert.ok(Math.abs(bode.pitch.D.phase_deg[k30] - bode.pitch.P.phase_deg[k30] - deg(pid_lowpass_response(15, 400, 30))) < 1e-6)
    // Амплитуда на 0 Гц — 0 дБ (ФНЧ и notch постоянную составляющую пропускают)
    assert.ok(Math.abs(bode.pitch.D.amp_dB[0]) < 1e-9)

    // Гироскопная часть на совпадающих частотах — как средние бодэ calculate_transfer_function (bode_mean) тех же фильтров
    calculate_transfer_function(load_filters({ ...log_values_7a, INS_GYRO_FILTER: values.INS_GYRO_FILTER }, log_env, tracking), gyro)
    const mean = bode_mean(gyro, 0, range)
    for (const f of [10, 30, 77.5, 150, 199]) {
        const k = Math.round(f / 0.05)
        const j = mean.freq.findIndex((x) => Math.abs(x - f) < 1e-6)
        assert.ok(j >= 0, f + ' Гц на сетке bode_mean')
        assert.ok(Math.abs(bode.gyro.amp_dB[k] - 20 * Math.log10(mean.amp_mean[j])) < 1e-6, 'амплитуда на ' + f + ' Гц')
        assert.ok(Math.abs(bode.gyro.phase_deg[k] - mean.phase_mean[j]) < 1e-6, 'фаза на ' + f + ' Гц: ' + bode.gyro.phase_deg[k] + ' против ' + mean.phase_mean[j])
    }

    // Свой шаг сетки
    assert.equal(lowpass_bode(values, ctx, 0.5).freq.length, 401)
})

test('evaluate_lowpass и lowpass_bode: без FFT или данных «до» — null; FFT.H и FFT.bode.H не меняются', () => {
    const { gyro, env: log_env, tracking, ctx } = lowpass_setup()
    const other = { INS_GYRO_FILTER: 80, INS_HNTCH_ENABLE: 1, INS_HNTCH_MODE: 0, INS_HNTCH_FREQ: 100, INS_HNTCH_BW: 50, INS_HNTCH_ATT: 40, INS_HNTCH_HMNCS: 1, INS_HNTCH_FM_RAT: 1, INS_HNTC2_ENABLE: 0 }
    calculate_transfer_function(load_filters(other, log_env, tracking), gyro)
    const FFT = gyro[0].FFT
    const H = FFT.H
    const bode_H = FFT.bode.H
    const H_copy = H.map((h) => [h[0].slice(), h[1].slice()])
    const bode_copy = bode_H.map((h) => [h[0].slice(), h[1].slice()])

    evaluate_lowpass(lowpass_values_8, ctx)
    evaluate_lowpass({ ...lowpass_values_8, INS_GYRO_FILTER: 20 }, ctx)
    lowpass_bode(lowpass_values_8, ctx)
    assert.equal(FFT.H, H, 'тот же массив FFT.H')
    assert.equal(FFT.bode.H, bode_H, 'тот же массив FFT.bode.H')
    assert.deepEqual(FFT.H.map((h) => [h[0].slice(), h[1].slice()]), H_copy)
    assert.deepEqual(FFT.bode.H.map((h) => [h[0].slice(), h[1].slice()]), bode_copy)

    assert.equal(evaluate_lowpass(lowpass_values_8, { ...ctx, sensor: 5 }), null)
    assert.equal(lowpass_bode(lowpass_values_8, { ...ctx, sensor: 5 }), null)
    const post_only = [{ FFT: { ...FFT, Z1: null, Z2: null } }]
    assert.equal(evaluate_lowpass(lowpass_values_8, { ...ctx, gyro: post_only }), null)
})

// Плоский спектр 0…500 Гц шагом 2 Гц (−60 дБ, рябь ±0.3 дБ) — пиков «после» в нём нет
function flat_spectrum_7a() {
    const bins = Array.from({ length: 251 }, (_, i) => 2 * i)
    const axis = (shift) => bins.map((bin, i) => -60 + 0.3 * Math.sin(i + shift))
    return { bins, x: axis(0), y: axis(1), z: axis(2) }
}

// Оценка варианта для rank_candidates: мощность в полосе, задержка на 30 Гц, уровни главных пиков после фильтров;
// spectrum — оценка «после» (по умолчанию плоская)
function eval_7a(band_dB, lag30, posts, spectrum = flat_spectrum_7a()) {
    return { band_dB, lag_ms: { 10: 8, 30: lag30 }, peaks: posts.map(([freq, post_dB]) => ({ freq, post_dB, source: 'main' })), spectrum, pre_spectrum: null }
}

const no_flags = { worse_peaks: [], lag_over: false, incomplete: false }

test('rank_candidates: лучший по полосе среди не ухудшающих пики и задержку; иначе — лог', () => {
    const log = eval_7a(-40, 10, [[78, -64], [153, -62]])
    // Автоподбор лучше по полосе, но ухудшает 153 Гц на 14 дБ — остаётся лог
    const worse = rank_candidates({ log, fit: eval_7a(-45, 9.8, [[78, -66], [153, -48]]) })
    assert.equal(worse.best_id, 'log')
    assert.deepEqual(worse.flags, { log: no_flags, fit: { worse_peaks: [153], lag_over: false, incomplete: false } })
    // Ухудшение ровно на 3 дБ ещё допустимо, и лучший по полосе выигрывает
    const edge = rank_candidates({ log, fit: eval_7a(-41, 10, [[78, -61], [153, -63]]) })
    assert.equal(edge.best_id, 'fit')
    assert.deepEqual(edge.flags.fit, no_flags)
    // Задержка на 30 Гц +0.6 мс — вариант отмечен, выбирается следующий по полосе
    const lag = rank_candidates({ log, fit: eval_7a(-41, 10.4, [[78, -65], [153, -62]]), combo: eval_7a(-42, 10.6, [[78, -67], [153, -63]]) })
    assert.equal(lag.best_id, 'fit')
    assert.deepEqual(lag.flags.combo, { worse_peaks: [], lag_over: true, incomplete: false })
    // Неотмеченный, но хуже лога по полосе — остаётся лог
    assert.equal(rank_candidates({ log, a: eval_7a(-39, 10, [[78, -64], [153, -62]]) }).best_id, 'log')
})

test('rank_candidates: при сомнении вариант отмечается — NaN, нет пары пика, нет пиков или оценки', () => {
    const log = eval_7a(-40, 10, [[78, -64], [153, -62]])
    const good = [[78, -65], [153, -63]]
    const check = (evaluation) => rank_candidates({ log, a: evaluation })
    // Нечисловая задержка
    for (const lag30 of [NaN, undefined]) {
        const r = check(eval_7a(-45, lag30, good))
        assert.equal(r.best_id, 'log', 'задержка ' + lag30)
        assert.equal(r.flags.a.lag_over, true)
    }
    // Нечисловой уровень пика
    const nan_peak = check(eval_7a(-45, 10, [[78, NaN], [153, -63]]))
    assert.equal(nan_peak.best_id, 'log')
    assert.deepEqual(nan_peak.flags.a.worse_peaks, [78])
    // Пик, которого нет у лога, и пик лога, которого нет у варианта
    const extra = check(eval_7a(-45, 10, [[78, -65], [153, -63], [200, -70]]))
    assert.deepEqual(extra.flags.a.worse_peaks, [200])
    const missing = check(eval_7a(-45, 10, [[78, -65]]))
    assert.deepEqual(missing.flags.a.worse_peaks, [153])
    assert.equal(missing.best_id, 'log')
    // Нет списка пиков, нет спектра, нечисловая полоса, нет оценки — incomplete, без исключения
    for (const broken of [{ ...eval_7a(-45, 10, good), peaks: undefined }, { ...eval_7a(-45, 10, good), spectrum: undefined },
                          eval_7a(NaN, 10, good), null]) {
        const r = check(broken)
        assert.equal(r.best_id, 'log')
        assert.deepEqual(r.flags.a, { worse_peaks: [], lag_over: false, incomplete: true })
    }
    // Без оценки лога сравнивать не с чем
    const no_log = rank_candidates({ a: eval_7a(-45, 10, good) })
    assert.equal(no_log.best_id, null)
    assert.equal(no_log.flags.a.incomplete, true)
})

test('rank_candidates: неполная оценка лога — все варианты тоже неполные, остаётся лог', () => {
    const good = [[78, -65], [153, -63]]
    const log_ok = eval_7a(-40, 10, [[78, -64], [153, -62]])
    for (const log of [eval_7a(NaN, 10, [[78, -64], [153, -62]]), { ...log_ok, peaks: undefined }, { ...log_ok, spectrum: undefined }, null]) {
        const r = rank_candidates({ log, a: eval_7a(-45, 10, good), b: eval_7a(-42, 9, good) })
        assert.equal(r.best_id, 'log')
        assert.equal(r.flags.log.incomplete, true)
        assert.deepEqual(r.flags.a, { worse_peaks: [], lag_over: false, incomplete: true })
        assert.deepEqual(r.flags.b, { worse_peaks: [], lag_over: false, incomplete: true })
    }
    // Полная оценка лога — варианты сравниваются как обычно
    assert.equal(rank_candidates({ log: log_ok, a: eval_7a(-45, 10, good) }).flags.a.incomplete, false)
})

test('rank_candidates: при равной полосе — меньшая задержка на 30 Гц, затем порядок вариантов', () => {
    const log = eval_7a(-40, 10, [[78, -64]])
    const r = rank_candidates({ log, a: eval_7a(-42, 10.3, [[78, -64]]), b: eval_7a(-42, 10.1, [[78, -64]]), c: eval_7a(-42, 10.1, [[78, -64]]) })
    assert.equal(r.best_id, 'b', 'b и c равны по полосе и задержке — остаётся раньше перечисленный')
    assert.equal(rank_candidates({ log, c: eval_7a(-42, 10.1, [[78, -64]]), b: eval_7a(-42, 10.1, [[78, -64]]) }).best_id, 'c')
    // Равная логу полоса и меньшая задержка — вариант лучше лога
    assert.equal(rank_candidates({ log, a: eval_7a(-40, 9.9, [[78, -64]]) }).best_id, 'a')
})

test('rank_candidates: пики оценки «после» лога тоже проверяются (source "post"), повторный вызов их не дублирует', () => {
    // У лога после фильтров остаётся пик 250 Гц по X (+10 дБ над фоном), главным пиком шага 1 он не был
    const bump = (spectrum, dB) => ({ ...spectrum, x: spectrum.x.map((v, k) => (spectrum.bins[k] === 250) ? v + dB : v) })
    const flat = flat_spectrum_7a()
    const log = eval_7a(-40, 10, [[78, -64]], bump(flat, 10))
    // Вариант лучше по полосе, но поднимает 250 Гц ещё на 5 дБ
    const raised = eval_7a(-42, 10, [[78, -64]], bump(flat, 15))
    const evaluations = { log, a: raised }
    const r = rank_candidates(evaluations)
    assert.equal(r.best_id, 'log')
    assert.deepEqual(r.flags.a.worse_peaks, [250])
    const post = log.peaks.filter((p) => p.source === 'post')
    assert.deepEqual(post.map((p) => [p.freq, p.axes]), [[250, ['X']]])
    assert.equal(post[0].pre_dB, null, 'спектра «до» у ручной оценки нет')
    assert.ok(Math.abs(raised.peaks.find((p) => p.source === 'post').post_dB - post[0].post_dB - 5) < 1e-9)
    rank_candidates(evaluations)
    assert.equal(log.peaks.filter((p) => p.source === 'post').length, 1, 'пики «после» заменяются, а не добавляются')
    // Тот же вариант, но 250 Гц на +2 дБ — проходит
    assert.equal(rank_candidates({ log, a: eval_7a(-42, 10, [[78, -64]], bump(flat, 12)) }).best_id, 'a')
    // Пик «после» рядом с главным пиком не дублируется
    const near_main = eval_7a(-40, 10, [[249, -64]], bump(flat, 10))
    rank_candidates({ log: near_main })
    assert.equal(near_main.peaks.filter((p) => p.source === 'post').length, 0)
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

// Оценка «после» лучшего варианта для second_notch_candidate: бины 0…500 Гц шагом 2, фон −60 дБ с рябью ±ripple дБ,
// bumps = { ось: { частота: дБ } или функция частоты → дБ }
function post_eval_7a(bumps, ripple = 0.3) {
    const bins = Array.from({ length: 251 }, (_, i) => 2 * i)
    const bump = (name, bin) => (typeof bumps[name] === 'function') ? bumps[name](bin) : (bumps[name]?.[bin] ?? 0)
    const axis = (name) => bins.map((bin, i) => -60 + ripple * Math.sin(i + name.charCodeAt(0)) + bump(name, bin))
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
    assert.equal(c.peak.axis, 'X')
    assert.ok(Math.abs(c.peak.excess_dB - 10) < 1, 'превышение ' + c.peak.excess_dB)
    // Пик в один бин: ширина по −3 дБ ≈ 1.2 Гц, удвоенная — меньше 10 Гц, BW упирается в нижний предел
    assert.ok(c.peak.width.width_hz < 2, 'ширина ' + c.peak.width.width_hz)
    assert.deepEqual(c.values, { ...log_values_7a, INS_HNTC2_ENABLE: 1, INS_HNTC2_MODE: 0, INS_HNTC2_FREQ: 155, INS_HNTC2_BW: 10, INS_HNTC2_ATT: 30,
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
    // Второй notch уже включён; оценки нет
    assert.equal(second_notch_candidate({ ...best, values: { ...log_values_7a, INS_HNTC2_ENABLE: 1 } }, post_eval_7a({ x: { 156: 10 } }), [frame]), null)
    assert.equal(second_notch_candidate(best, null, [frame]), null)
    // Из двух немоторных — с большим превышением
    const two = second_notch_candidate(best, post_eval_7a({ x: { 156: 10 }, z: { 300: 14 } }), [frame, { freq: 300, axes: ['Z'], source: 'frame' }])
    assert.equal(two.values.INS_HNTC2_FREQ, 300)
    assert.equal(two.peak.axis, 'Z')
})

test('second_notch_candidate: порог ровно 6 дБ включается, чуть ниже — нет', () => {
    const best = { id: 'log', title: 'Как в логе', values: { ...log_values_7a } }
    const frame = { freq: 156, axes: ['X'], source: 'frame' }
    // Без ряби фон ровно −60 дБ, медиана шума — тоже, превышение равно добавке
    const at = second_notch_candidate(best, post_eval_7a({ x: { 156: 6 } }, 0), [frame])
    assert.equal(at.peak.excess_dB, 6)
    assert.equal(at.values.INS_HNTC2_FREQ, 156)
    assert.equal(second_notch_candidate(best, post_eval_7a({ x: { 156: 5.999 } }, 0), [frame]), null)
})

test('second_notch_candidate: BW — удвоенная ширина пика по −3 дБ в пределах 10 Гц…0.5·F', () => {
    const best = { id: 'log', title: 'Как в логе', values: { ...log_values_7a } }
    const frame = { freq: 155.3, axes: ['X'], source: 'frame' }
    // Треугольный пик +12 дБ со скатом 1 дБ/Гц: −3 дБ на 153 и 159 Гц (интерполяция между бинами), ширина 6 → BW 12
    const triangle = second_notch_candidate(best, post_eval_7a({ x: (f) => Math.max(0, 12 - Math.abs(f - 156)) }, 0), [frame])
    assert.equal(triangle.peak.width.top_hz, 156)
    assert.ok(Math.abs(triangle.peak.width.left_hz - 3) < 1e-9 && Math.abs(triangle.peak.width.right_hz - 3) < 1e-9, JSON.stringify(triangle.peak.width))
    assert.equal(triangle.values.INS_HNTC2_BW, 12)
    // Плато шириной 40 Гц: ширина 41 Гц, удвоенная 82 — больше round(0.5·155) = 78, BW = 78
    const plateau = second_notch_candidate(best, post_eval_7a({ x: (f) => (Math.abs(f - 156) <= 20) ? 12 : 0 }, 0), [frame])
    assert.ok(Math.abs(plateau.peak.width.width_hz - 41) < 1e-9, 'ширина ' + plateau.peak.width.width_hz)
    assert.equal(plateau.values.INS_HNTC2_BW, 78)
    // Вершина — наибольший бин рядом с ближайшим: пик на 158 Гц при частоте шага 1 155.3 Гц
    const shifted = second_notch_candidate(best, post_eval_7a({ x: (f) => Math.max(0, 12 - Math.abs(f - 158)) }, 0), [frame])
    assert.equal(shifted.peak.width.top_hz, 158)
    assert.equal(shifted.values.INS_HNTC2_BW, 12)

    // Справа уровень не падает на 3 дБ в пределах ±0.5·F — сторона берётся по пределу 0.5·F / (2·2) = 19.5 Гц
    const bins = Array.from({ length: 251 }, (_, i) => 2 * i)
    const shoulder = bins.map((f) => (f < 150) ? -60 : ((f <= 156) ? -48 : -49))
    const width = peak_width_hz(bins, shoulder, 156, candidate_rules.second_notch)
    assert.equal(width.found_left, true)
    assert.equal(width.found_right, false)
    assert.ok(Math.abs(width.left_hz - 6.5) < 1e-9, 'слева: −51 дБ между 150 и 148 Гц на 149.5 Гц')
    assert.equal(width.right_hz, 19.5)
    assert.equal(width.width_hz, 26)
})

test('notch_line_stats: NaN в целях трекинга — среднее по числам (дефект upstream 8), без чисел — null', () => {
    // ESCTarget теперь отбрасывает NaN-отсчёты при чтении (аудит, C1; tests/tunewizard-audit-a.test.cjs), поэтому NaN
    // подставляется в уже прочитанные данные источника (и в его общий ряд all) — проверяется сама статистика линий
    const esc_log = () => fake_log({ messages: { ESC: { instances: {
        0: { TimeUS: [0, 1e6, 2e6, 3e6], RPM: [6000, 6000, 6000, 6000] },
        1: { TimeUS: [0, 1e6, 2e6, 3e6], RPM: [3000, 3000, 3000, 3000] }
    } } } })
    const values = { INS_HNTCH_ENABLE: 1, INS_HNTCH_MODE: 3, INS_HNTCH_REF: 1, INS_HNTCH_FREQ: 40, INS_HNTCH_BW: 20, INS_HNTCH_ATT: 40, INS_HNTCH_FM_RAT: 1, INS_HNTCH_HMNCS: 1, INS_HNTCH_ESCMSK: 0 }
    const stats = (freq0, options) => {
        const tracking = create_tracking(esc_log(), env, { start_time: 0, end_time: 3 })
        const esc = tracking.find((t) => t.name === 'ESC')
        esc.data[0].freq = freq0
        for (const sample of esc.data.all) {
            if (sample.inst == 0) {
                sample.freq = freq0[esc.data[0].time.indexOf(sample.time)]
            }
        }
        return notch_line_stats(load_filters({ ...values, INS_HNTCH_OPTS: options }, env, tracking), [0, 3])[0].harmonics[0]
    }
    const with_nan = [100, NaN, 100, 100]

    // OPTS 2 — по моторам (многопиковая ветка): мотор 0 — 100 Гц без NaN-отсчёта, мотор 1 — 50 Гц
    const multi = stats(with_nan, 2)
    assert.deepEqual([multi.mean, multi.min, multi.max], [75, 50, 100])

    // OPTS 0 — среднее по моторам (compute_avg): 100 (первый отсчёт, пара не набрана), NaN, 75, 75 → по числам 250/3
    const single = stats(with_nan, 0)
    assert.ok(Number.isFinite(single.mean) && Math.abs(single.mean - 250 / 3) < 1e-9, 'среднее ' + single.mean)
    assert.deepEqual([single.min, single.max], [75, 100])

    // Мотор 0 целиком NaN: по моторам — только мотор 1; в среднем по моторам все средние NaN → null
    const all_nan = [NaN, NaN, NaN, NaN]
    const multi_nan = stats(all_nan, 2)
    assert.deepEqual([multi_nan.mean, multi_nan.min, multi_nan.max], [50, 50, 50])
    const single_nan = stats(all_nan, 0)
    assert.deepEqual([single_nan.mean, single_nan.min, single_nan.max], [null, null, null])
})
