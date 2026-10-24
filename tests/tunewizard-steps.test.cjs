// Тесты метрик шагов мастера настройки (TuneWizard/core/metrics.js): пики спектра, атрибуция, моторная частота.
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
])

// Параметры без лога: values = { имя: значение }
function fake_params(values) {
    return { get: (name) => (name in values) ? values[name] : null, has: (name) => name in values, changed: () => false }
}

// Поддельный лог с интерфейсом парсера (как в tests/tunewizard-core.test.cjs).
// messages = { ИМЯ: { поле: массив } } — сообщение без экземпляров;
//            { ИМЯ: { instances: { 0: { поле: массив }, 1: {…} } } } — с экземплярами (как ESC):
//            такие сообщения настоящий парсер отдаёт только через get_instance, а get() на них падает.
function fake_log({ messages = {} } = {}) {
    const types = { ...messages }
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
    // Допуск ±10 %: 109 Гц — ещё первая гармоника, 112 Гц — уже нет; выше max_harmonic — рама
    const edge = attribute_peaks([{ freq: 109 }, { freq: 112 }, { freq: 900 }], 100)
    assert.deepEqual(edge.map((p) => p.source), ['motor', 'frame', 'frame'])
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
})
