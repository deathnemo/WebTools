// Тесты исправлений аудита, область A (ядро шагов 0–1 мастера настройки): NaN в оборотах ESC/RPM (C1), устойчивость
// подготовки источников трекинга и шага 1 к неожиданному логу (I2), моторная частота только по режиму notch (I1),
// проверка источника трекинга (I4 — в tests/tunewizard.test.cjs вместе с границами лога I3), окно raw отдельно от окна
// batch (I5), мелочи M1, M3, M4, M5 и страховка alias_obj.
// Скрипты классические (общая глобальная область), поэтому загружаются как на странице — через vm.runInThisContext
// (как в tests/tunewizard-core.test.cjs). Шаг 1 (steps/step1.js) грузится с заглушками страницы: document с элементами
// по id (радиокнопки по name для querySelector), реестр графиков plots.js (register_plot, plot, render_plot,
// plot_palette), loading_call, html_escape, state и raw_window_used из wizard.js (его не загрузить под Node:
// динамический import парсера в начале файла) — та же логика по типам сообщений лога.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const repo = path.resolve(__dirname, '..')

// FFTJS на странице — глобал из modules/fft.js/dist/fft.js; под Node берём ту же библиотеку через require
globalThis.FFTJS = require('../modules/fft.js/lib/fft.js')

// ---------- Заглушки страницы для steps/step1.js ----------

// Элементы по id; у радиокнопок — name группы, чтобы document.querySelector('input[name="…"]:checked') находил выбранную
const elements = {}
const radio_groups = [['spec_log_', 'spec_log'], ['spec_fv_', 'spec_fv'], ['spec_amp_', 'spec_amp'], ['spec_freq_Hz', 'spec_freq'],
                      ['spec_freq_RPM', 'spec_freq'], ['spec_alias_', 'spec_alias'], ['spec_sg_inst', 'spec_sg_inst'], ['spec_sg_pre', 'spec_sg_data'],
                      ['spec_sg_post', 'spec_sg_data'], ['spec_sg_est', 'spec_sg_data'], ['spec_sg_x', 'spec_sg_axis'], ['spec_sg_y', 'spec_sg_axis'],
                      ['spec_sg_z', 'spec_sg_axis']]
// Значение радиокнопки — как атрибут value в index.html: номер гироскопа (spec_sg_inst0 → "0"), иначе хвост id после
// последнего подчёркивания (spec_sg_pre → "pre", spec_log_batch → "batch", spec_freq_Hz → "Hz", spec_fv_2 → "2")
function radio_value_of(id, prefix) {
    return (prefix === 'spec_sg_inst') ? id.slice(prefix.length) : id.slice(id.lastIndexOf('_') + 1)
}
function element(id) {
    if (!(id in elements)) {
        const group = radio_groups.find(([prefix]) => id.startsWith(prefix))
        elements[id] = { id, name: group ? group[1] : null, hidden: false, disabled: false, checked: false, value: group ? radio_value_of(id, group[0]) : '',
                         textContent: '', innerHTML: '', className: '', classList: { toggle() {}, remove() {}, add() {} }, addEventListener() {},
                         querySelector: () => ({ innerHTML: '' }) }
    }
    return elements[id]
}
globalThis.document = {
    getElementById: element,
    querySelector: (selector) => {
        const m = /input\[name="([^"]+)"\]:checked/.exec(selector)
        return m ? (Object.values(elements).find((e) => (e.name === m[1]) && e.checked) ?? null) : null
    },
}
function check_radio(id) {
    const radio = element(id)
    for (const e of Object.values(elements)) {
        if (e.name === radio.name) {
            e.checked = false
        }
    }
    radio.checked = true
}

// Реестр графиков (plots.js): данные и макет хранятся как есть, рисования нет
const plots = {}
globalThis.register_plot = (id, data, layout) => { plots[id] = { data, layout } }
globalThis.plot = (id) => plots[id] ?? null
globalThis.render_plot = () => {}
globalThis.plot_palette = () => ({ warn: '#000', axis: { x: '#f00', y: '#0f0', z: '#00f' }, dash: { pre: 'solid', post: 'dash', est: 'dot' }, gyro_opacity: [1, 1, 1], series: [] })
globalThis.loading_call = (fun) => fun()
globalThis.html_escape = (text) => String(text)
globalThis.step_open_in = () => {}

// Состояние мастера (wizard.js) — те же поля, что у state страницы
globalThis.state = {
    file_name: null, log: null, version: null, params: null, info: null, vibe: null, checks: null,
    settings: { start: 0, end: 0, min: null, max: null, window_size: 1024 }, step: 0, steps: [],
    spectrum: { log_type: null, window_per_batch: 1, amplitude: 'dB', frequency: 'Hz', log_frequency: false, aliasing: 'none', filter_version: null },
    gyro: null, tracking: null, logged: null, filters: null, env: null, load_warnings: [], file: null,
}
// raw_window_used из wizard.js: окно шага 0 действует только на raw-лог
globalThis.raw_window_used = () => {
    if (state.log == null) {
        return false
    }
    const types = state.log.messageTypes
    const have_raw = 'GYR' in types
    const have_batch = ('ISBH' in types) && ('ISBD' in types)
    const type = state.spectrum.log_type ?? (have_raw ? 'raw' : (have_batch ? 'batch' : null))
    return type === 'raw'
}

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
    'TuneWizard/core/metrics.js',
    'TuneWizard/core/autofit.js',
    'TuneWizard/core/params.js',
    'TuneWizard/steps/step1.js',
])

// Внутреннее состояние шага 1 — const модуля в общей лексической области
const step1_state = vm.runInThisContext('step1')

// ---------- Поддельные логи (как в tests/tunewizard-core.test.cjs) ----------

// messages = { ИМЯ: { поле: массив } } — сообщение без экземпляров; { ИМЯ: { instances: { 0: {…} } } } — с экземплярами
// (такие настоящий парсер отдаёт только через get_instance, а get() на них падает). params = [[имя, значение, TimeUS], ...]
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

// Сообщения batch-логирования: экземпляр 0 гироскопа, batches пакетов по samples отсчётов на rate Гц с 10 с,
// синусоида freq Гц амплитудой amp по X поверх детерминированного белого шума СКО noise по трём осям; масштаб 1000
function batch_messages({ batches = 4, samples = 1024, rate = 1000, freq = 100, amp = 2, noise = 0 } = {}) {
    const ISBH = { N: [], type: [], instance: [], smp_cnt: [], mul: [], SampleUS: [], smp_rate: [] }
    const ISBD = { N: [], seqno: [], x: [], y: [], z: [] }
    const scale = 1000
    let seed = 1
    const white = () => {
        if (noise == 0) return 0
        seed = (seed * 1664525 + 1013904223) >>> 0
        return noise * Math.sqrt(3) * (2 * seed / 2 ** 32 - 1)
    }
    for (let b = 0; b < batches; b++) {
        ISBH.N.push(b); ISBH.type.push(1); ISBH.instance.push(0); ISBH.smp_cnt.push(samples)
        ISBH.mul.push(scale); ISBH.SampleUS.push(b * samples / rate * 1e6 + 10e6); ISBH.smp_rate.push(rate)
        for (let m = 0; m < samples / 32; m++) {
            const x = [], y = [], z = []
            for (let k = 0; k < 32; k++) {
                const n = m * 32 + k
                x.push(Math.round(scale * (amp * Math.sin(2 * Math.PI * freq * n / rate) + white())))
                y.push(Math.round(scale * white()))
                z.push(Math.round(scale * white()))
            }
            ISBD.N.push(b); ISBD.seqno.push(m); ISBD.x.push(x); ISBD.y.push(y); ISBD.z.push(z)
        }
    }
    return { ISBH, ISBD }
}

// Сообщения raw-логирования: GYR экземпляров 0..instances−1 — samples отсчётов на rate Гц с start_s секунд
// и разрывом gap_s посередине, синусоида freq Гц по X; IMU.GHz — заявленная частота
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

function gyro_params({ bat_opt = 0, raw_opt = null, extra = [] } = {}) {
    const params = [['INS_GYR_ID', 1, 0], ['INS_LOG_BAT_OPT', bat_opt, 0], ['AHRS_EKF_TYPE', 3, 0], ['EK3_PRIMARY', 0, 0]]
    if (raw_opt != null) {
        params.push(['INS_RAW_LOG_OPT', raw_opt, 0])
    }
    return params.concat(extra)
}

// ESC-телеметрия четырёх моторов: отсчёты каждые 0.05 с с 9 по 15 с, обороты rpm; nan = { instance, time } —
// один отсчёт этого экземпляра в этот момент заменён NaN (как quiet_nanf() прошивки без оборотов); time null — все
// отсчёты экземпляра NaN (мотор без оборотов весь лог)
function esc_messages(rpm, nan = null) {
    const ESC = { instances: {} }
    for (let i = 0; i < 4; i++) {
        const TimeUS = []
        const RPM = []
        for (let n = 0; n <= 120; n++) {
            const t = 9 + n * 0.05
            TimeUS.push(Math.round(t * 1e6))
            RPM.push((nan != null && nan.instance == i && ((nan.time == null) || (Math.abs(t - nan.time) < 1e-6))) ? NaN : rpm)
        }
        ESC.instances[i] = { TimeUS, RPM }
    }
    return { ESC }
}

const env0 = { params: null, build_type: 2, filter_version: 2 }
const env_for = (log) => ({ ...env0, params: log_params(log) })

const finite = (arr) => arr.every(Number.isFinite)

// gyro с FFT (окно 1024) и трекингом, фильтры из values, передаточная функция посчитана
function setup(log, values) {
    const env = env_for(log)
    const gyro = load_gyro(log, env, { log_type: null })
    assert.equal(gyro.error, null)
    gyro_fft(gyro, { window_size: 1024, window_per_batch: 1 })
    const tracking = create_tracking(log, env, gyro)
    interpolate_tracking(tracking, gyro)
    const filters = load_filters(values, env, tracking)
    calculate_transfer_function(filters, gyro)
    return { env, gyro, tracking, filters }
}

// ---------- C1: NaN в оборотах ----------

test('C1 ESCTarget: отсчёты с NaN в RPM отбрасываются (время и частота вместе, по экземпляру), общий ряд без NaN', () => {
    const log = fake_log({ messages: { ESC: { instances: {
        0: { TimeUS: [0, 1e6, 2e6, 3e6], RPM: [6000, NaN, 6000, 6000] },
        1: { TimeUS: [0, 1e6, 2e6, 3e6], RPM: [3000, 3000, NaN, NaN] }
    } } } })
    const esc = new ESCTarget(log, env0)
    assert.deepEqual(esc.data[0].time, [0, 2, 3])
    assert.deepEqual(esc.data[0].freq, [100, 100, 100])
    assert.deepEqual(esc.data[1].time, [0, 1])
    assert.deepEqual(esc.data[1].freq, [50, 50])
    assert.equal(esc.data.all.length, 5)
    assert.ok(esc.data.all.every((s) => Number.isFinite(s.freq) && Number.isFinite(s.time)))
    assert.equal(esc.get_num_motors(), 2)
    // Интерполяция проходит через пропуск по соседним отсчётам
    esc.interpolate(0, [1, 2.5])
    assert.deepEqual(esc.data.interpolated[0][0], [100, 100])
    assert.deepEqual(esc.get_interpolated_target_freq(0, 0, { options: 0, ref: 1, freq: 40, esc_mask: 0 }), [75])
    // Среднее по моторам: NaN не входит, тайм-аут по-прежнему работает
    const avg = esc.compute_avg(0)
    assert.ok(finite(avg.avg_freq) && finite(avg.avg_time), avg.avg_freq.join(', '))
    assert.equal(esc.get_mean([0, 3]), esc.get_mean([0, 3]))
    assert.ok(Number.isFinite(esc.get_mean([0, 3])))
})

test('C1 RPMTarget: NaN отбрасывается в новом и старом формате; нездоровый датчик — −1; данные парсера не меняются', () => {
    const RPM = [3000, NaN, 3000, 3000]
    const log = fake_log({ messages: { RPM: { instances: { 0: { TimeUS: [0, 1e6, 2e6, 3e6], RPM, H: [1, 1, 0, 1] } } } } })
    const rpm1 = new RPMTarget(log, env0, 1, 2)
    assert.deepEqual(rpm1.data.time, [0, 2, 3])
    assert.deepEqual(rpm1.data.value, [3000, -1, 3000])
    assert.deepEqual(RPM, [3000, NaN, 3000, 3000], 'массив лога не тронут (раньше −1 писалось прямо в него)')
    assert.equal(rpm1.have_data(), true)
    assert.equal(new RPMTarget(log, env0, 2, 5).have_data(), false, 'второго экземпляра нет')
    const config = { ref: 1, freq: 50 }
    assert.deepEqual(rpm1.get_target_freq(config).freq, [50, 0, 50], 'нездоровый датчик (−1) при версии фильтра 2 — 0 Гц; NaN в целях нет')

    const old = fake_log({ messages: { RPM: { TimeUS: [0, 1e6, 2e6], rpm1: [3000, NaN, 3000] } } })
    const rpm_old = new RPMTarget(old, env0, 1, 2)
    assert.deepEqual(rpm_old.data.time, [0, 2])
    assert.deepEqual(rpm_old.data.value, [3000, 3000])
    assert.equal(new RPMTarget(old, env0, 2, 5).have_data(), false, 'поля rpm2 нет — без данных, без исключения')
    assert.equal(new RPMTarget(fake_log({ messages: { RPM: {} } }), env0, 1, 2).have_data(), false, 'RPM без строк')
})

// Параметры notch по ESC: среднее по моторам (OPTS 0) или по каждому (OPTS 2)
const esc_values = (opts) => ({ INS_GYRO_FILTER: 0, INS_HNTCH_ENABLE: 1, INS_HNTCH_MODE: 3, INS_HNTCH_FREQ: 40, INS_HNTCH_BW: 20, INS_HNTCH_ATT: 30,
                                INS_HNTCH_REF: 1, INS_HNTCH_FM_RAT: 1, INS_HNTCH_HMNCS: 1, INS_HNTCH_OPTS: opts, INS_HNTCH_ESCMSK: 0, INS_HNTC2_ENABLE: 0 })

test('C1 сквозной: NaN в ESC.RPM у центра окна FFT — H и оценка «после» конечны и равны оценке без NaN', () => {
    // Центр первого окна — 10.512 с (пакет с 10 с, 512-й отсчёт при 1000 Гц); отсчёты ESC на 10.50 и 10.55 с его
    // окружают, и NaN на 10.50 с у мотора 2 раньше попадал в интерполяцию → цель окна NaN → H[0] NaN
    const nan = { instance: 2, time: 10.5 }
    // Шум по всем осям, чтобы Y и Z не были нулями (ноль в дБ — −Infinity, а проверяется конечность)
    const messages = () => batch_messages({ noise: 0.3 })
    for (const opts of [0, 2]) {
        const clean = setup(fake_log({ messages: { ...messages(), ...esc_messages(3600) }, params: gyro_params() }), esc_values(opts))
        const dirty = setup(fake_log({ messages: { ...messages(), ...esc_messages(3600, nan) }, params: gyro_params() }), esc_values(opts))
        assert.deepEqual(dirty.filters.warnings, [])
        const FFT = dirty.gyro[0].FFT
        assert.equal(FFT.H.length, 4)
        for (let j = 0; j < FFT.H.length; j++) {
            assert.ok(finite(FFT.H[j][0]) && finite(FFT.H[j][1]), 'OPTS ' + opts + ': H окна ' + j + ' конечна')
            assert.deepEqual(FFT.H[j], clean.gyro[0].FFT.H[j], 'OPTS ' + opts + ': H окна ' + j + ' как без NaN (обороты постоянны)')
        }
        const target = dirty.tracking[3].get_interpolated_target_freq(0, 0, { options: opts, ref: 1, freq: 40, esc_mask: 0 })
        assert.ok(finite(target), 'цель первого окна: ' + target)
        const scale = spectrum_amplitude_scale('dB')
        const range = [dirty.gyro.start_time, dirty.gyro.end_time + 10]
        const alias = alias_obj(FFT, { mode: 'none' })
        const est = estimate_post(dirty.gyro, 0, scale, range, alias)
        const expected = estimate_post(clean.gyro, 0, scale, range, alias_obj(clean.gyro[0].FFT, { mode: 'none' }))
        for (const axis of ['x', 'y', 'z']) {
            assert.ok(finite(est[axis]), 'OPTS ' + opts + ': оценка «после» по ' + axis + ' конечна')
            assert.deepEqual(est[axis], expected[axis])
        }
        const sg = spectrogram_matrix(dirty.gyro, 0, 'x', true, scale, alias)
        assert.ok(sg.z.every((row) => (row[0] === undefined) || finite(row)), 'строки спектрограммы оценки конечны')
        const bode = bode_mean(dirty.gyro, 0, range)
        assert.ok(finite(bode.amp_mean) && finite(bode.phase_mean))
        const stats = notch_line_stats(dirty.filters, range)
        assert.ok(Number.isFinite(stats[0].harmonics[0].mean))
    }
})

test('C1 экземпляр из одних NaN: мотор ESC без единого числового отсчёта — без данных, цель и H по остальным конечны; RPM из одних NaN — have_data false', () => {
    // Раньше такой экземпляр регистрировался с пустыми рядами, linear_interp([], [], t) давал цель NaN, и H была NaN во всех
    // окнах — даже при исправных остальных моторах (ревью исправлений аудита)
    const log = fake_log({ messages: { ESC: { instances: {
        0: { TimeUS: [0, 1e6, 2e6], RPM: [NaN, NaN, NaN] },
        1: { TimeUS: [0, 1e6, 2e6], RPM: [6000, 6000, 6000] }
    } } } })
    const esc = new ESCTarget(log, env0)
    assert.equal(esc.data[0], undefined, 'экземпляр без отсчётов не зарегистрирован')
    assert.equal(esc.get_num_motors(), 1)
    assert.equal(esc.data.all.length, 3)
    esc.interpolate(0, [0.5, 1.5])
    for (const opts of [0, 2]) {
        assert.deepEqual(esc.get_interpolated_target_freq(0, 0, { options: opts, ref: 1, freq: 40, esc_mask: 0 }), [100], 'OPTS ' + opts)
    }
    assert.ok(Number.isFinite(esc.get_mean([0, 2])))
    // Все моторы без оборотов — источник без данных: load_filters выключит notch с предупреждением
    const none = new ESCTarget(fake_log({ messages: { ESC: { instances: { 0: { TimeUS: [0, 1e6], RPM: [NaN, NaN] } } } } }), env0)
    assert.equal(none.have_data(), false)
    assert.equal(none.get_num_motors(), undefined)
    assert.equal(none.get_target_freq({ options: 0, ref: 1, freq: 40, esc_mask: 0 }), undefined)

    // Сквозная: третий мотор без оборотов весь лог — H и цель окна конечны по трём остальным, предупреждений нет
    for (const opts of [0, 2]) {
        const dirty = setup(fake_log({ messages: { ...batch_messages({ noise: 0.3 }), ...esc_messages(3600, { instance: 2, time: null }) }, params: gyro_params() }), esc_values(opts))
        assert.deepEqual(dirty.filters.warnings, [])
        assert.equal(dirty.tracking[3].get_num_motors(), 3)
        const FFT = dirty.gyro[0].FFT
        for (let j = 0; j < FFT.H.length; j++) {
            assert.ok(finite(FFT.H[j][0]) && finite(FFT.H[j][1]), 'OPTS ' + opts + ': H окна ' + j + ' конечна')
        }
        const target = dirty.tracking[3].get_interpolated_target_freq(0, 0, { options: opts, ref: 1, freq: 40, esc_mask: 0 })
        assert.ok(finite(target), 'OPTS ' + opts + ': цель первого окна: ' + target)
        assert.equal(target.length, (opts == 2) ? 3 : 1, 'OPTS ' + opts + ': целей по числу моторов с данными')
    }

    // RPM из одних NaN: данных нет (have_data false), notch по нему выключен с предупреждением, а не с целью NaN
    const rpm_log = fake_log({ messages: { RPM: { instances: { 0: { TimeUS: [0, 1e6, 2e6], RPM: [NaN, NaN, NaN], H: [1, 1, 1] } } } } })
    const rpm = new RPMTarget(rpm_log, env0, 1, 2)
    assert.equal(rpm.have_data(), false)
    assert.equal(rpm.get_target_freq({ ref: 1, freq: 50 }), undefined)
    const filters = load_filters({ ...esc_values(0), INS_HNTCH_MODE: 2 }, env0, [rpm])
    assert.equal(filters.notch[0].enabled(), false)
    assert.deepEqual(filters.warnings, ['Нет данных трекинга для notch RPM1'])
    // Старый формат — то же
    assert.equal(new RPMTarget(fake_log({ messages: { RPM: { TimeUS: [0, 1e6], rpm1: [NaN, NaN] } } }), env0, 1, 2).have_data(), false)
})

test('C1 страховка: окно с нечисловой H не входит в estimate_post, bode_mean и спектрограмму оценки', () => {
    const log = fake_log({ messages: batch_messages(), params: gyro_params() })
    const values = { INS_GYRO_FILTER: 0, INS_HNTCH_ENABLE: 1, INS_HNTCH_MODE: 0, INS_HNTCH_FREQ: 100, INS_HNTCH_BW: 20, INS_HNTCH_ATT: 40,
                     INS_HNTCH_REF: 0, INS_HNTCH_FM_RAT: 1, INS_HNTCH_HMNCS: 1, INS_HNTCH_OPTS: 0, INS_HNTCH_ESCMSK: 0, INS_HNTC2_ENABLE: 0 }
    const { gyro } = setup(log, values)
    const FFT = gyro[0].FFT
    assert.equal(FFT.x.length, 4)
    const nan_H = (H) => [new Array(H[0].length).fill(NaN), new Array(H[1].length).fill(NaN)]
    const scale = spectrum_amplitude_scale('dB')
    const range = [gyro.start_time, gyro.end_time + 10]
    const alias = alias_obj(FFT, { mode: 'none' })

    // Оценка «после»: окно 1 с NaN пропущено, среднее по окнам 0, 2, 3
    const H = FFT.H.map((h, j) => (j == 1) ? nan_H(h) : h)
    const est = estimate_post(gyro, 0, scale, range, alias, H)
    assert.ok(finite(est.x), 'оценка конечна')
    const peak = FFT.bins.findIndex((b) => b >= 100)
    const expected_lin = [0, 2, 3].reduce((sum, j) => sum + FFT.x[j][peak] * complex_abs(FFT.H[j])[peak], 0) / 3
    const expected_dB = 20 * Math.log10(expected_lin * FFT.correction.linear)
    assert.ok(Math.abs(est.x[peak] - expected_dB) < 0.01, 'среднее по трём окнам: ' + est.x[peak].toFixed(3) + ' против ' + expected_dB.toFixed(3))
    // Все окна NaN — форма результата сохраняется, значения NaN
    const all_nan = estimate_post(gyro, 0, scale, range, alias, FFT.H.map(nan_H))
    assert.equal(all_nan.x.length, FFT.bins.length)
    assert.ok(all_nan.x.every(Number.isNaN) && all_nan.z.every(Number.isNaN))

    // Спектрограмма оценки: строка окна 1 пустая (как у разрыва), остальные конечны
    FFT.H[1] = nan_H(FFT.H[1])
    const sg = spectrogram_matrix(gyro, 0, 'x', true, scale, alias)
    assert.equal(sg.z.length, 4)
    assert.ok(sg.z[1].every((v) => v === undefined), 'строка окна с NaN пустая')
    assert.ok(finite(sg.z[0]) && finite(sg.z[2]) && finite(sg.z[3]))

    // Бодэ: окно 1 пропущено, среднее по 0, 2, 3; все NaN — null
    const bode_H = FFT.bode.H
    const clean = bode_mean(gyro, 0, range)
    FFT.bode.H = bode_H.map((h, j) => (j == 1) ? nan_H(h) : h)
    const bode = bode_mean(gyro, 0, range)
    assert.ok(finite(bode.amp_mean) && finite(bode.phase_mean))
    const k = bode.freq.findIndex((f) => f >= 100)
    const expected_amp = [0, 2, 3].reduce((sum, j) => sum + complex_abs(bode_H[j])[k], 0) / 3
    assert.ok(Math.abs(bode.amp_mean[k] - expected_amp) < 1e-12)
    // Статический notch: во всех окнах H одинакова — среднее то же, что без пропуска
    assert.ok(Math.abs(bode.amp_mean[k] - clean.amp_mean[k]) < 1e-12)
    FFT.bode.H = bode_H.map(nan_H)
    assert.equal(bode_mean(gyro, 0, range), null)
})

// ---------- I2: неожиданный лог не роняет подготовку трекинга ----------

// Квадрокоптер с моторами на выходах 15–18 (RCO2) и всем нужным для газа по моторам; with_rco2 — есть ли RCO2 в логе
function motors_on_rco2_log(with_rco2) {
    const params = [['FRAME_CLASS', 1, 0], ['MOT_THST_EXPO', 0.65, 0], ['MOT_SPIN_MAX', 0.95, 0], ['MOT_SPIN_MIN', 0.15, 0], ['MOT_PWM_MIN', 1000, 0],
                    ['MOT_PWM_MAX', 2000, 0], ['MOT_BAT_VOLT_MIN', 0, 0], ['MOT_BAT_VOLT_MAX', 0, 0], ['MOT_BAT_IDX', 0, 0], ['BARO_PRIMARY', 0, 0]]
    const RCOU = { TimeUS: [0, 1e6] }
    const RCO2 = { TimeUS: [0, 1e6] }
    for (let i = 1; i <= 4; i++) {
        params.push(['SERVO' + (14 + i) + '_FUNCTION', 32 + i, 0])
        RCO2['C' + (14 + i)] = [1500, 1500]
    }
    const messages = { RCOU, RATE: { TimeUS: [0, 1e6], AOut: [0.3, 0.3] }, BARO: { instances: { 0: { TimeUS: [0, 1e6], Alt: [0, 0] } } } }
    if (with_rco2) {
        messages.RCO2 = RCO2
    }
    return fake_log({ messages, params })
}

test('I2 ThrottleTarget: моторы на выходах 15–18 без RCO2 — нет данных по моторам, без исключения; с RCO2 — четыре мотора', () => {
    const without = new ThrottleTarget(motors_on_rco2_log(false), env_for(motors_on_rco2_log(false)))
    assert.equal(without.data.length, 0)
    assert.equal(without.have_data({ options: 0 }), true, 'средний газ из RATE есть')
    assert.equal(without.have_data({ options: 2 }), false)
    assert.match(without.no_data_error({ options: 2 }), /отдельных моторов/)
    const log = motors_on_rco2_log(true)
    const with_rco2 = new ThrottleTarget(log, env_for(log))
    assert.equal(with_rco2.data.length, 4)
    assert.equal(with_rco2.have_data({ options: 2 }), true)
    assert.doesNotThrow(() => create_tracking(motors_on_rco2_log(false), env_for(motors_on_rco2_log(false)), { start_time: 0, end_time: 1 }))
})

test('I2 FFTTarget: FTN2 без FTN1 — конструктор, интерполяция и цели не падают; одиночный трекинг без данных, по пикам — есть', () => {
    const log = fake_log({ messages: {
        FTN2: { instances: { 1: { TimeUS: [0, 1e6], EnX: [1, 1], EnY: [3, 3], PkX: [80, 80], PkY: [120, 120] } } }
    } })
    const fft = new FFTTarget(log, env0)
    assert.equal(fft.have_data({ options: 0 }), false, 'центрального пика нет')
    assert.equal(fft.have_data({ options: 2 }), true, 'пики FTN2 есть')
    assert.doesNotThrow(() => fft.interpolate(0, [0.5]))
    assert.equal(fft.get_interpolated_target_freq(0, 0, { options: 0, ref: 1, freq: 50 }), null)
    assert.deepEqual(fft.get_interpolated_target_freq(0, 0, { options: 2, ref: 1, freq: 50 }), [110])
    assert.equal(fft.get_target_freq({ options: 0, ref: 1, freq: 50 }), undefined)
    assert.deepEqual(fft.get_target_freq({ options: 2, ref: 1, freq: 50 }).freq, [[110, 110]])
    // Включённый notch режима 4 без пиков по моторам — выключен с предупреждением, а не исключение
    const tracking = create_tracking(log, env0, { start_time: 0, end_time: 1 })
    const filters = load_filters({ INS_HNTCH_ENABLE: 1, INS_HNTCH_MODE: 4, INS_HNTCH_FREQ: 80, INS_HNTCH_BW: 40, INS_HNTCH_ATT: 40, INS_HNTCH_REF: 1, INS_HNTCH_HMNCS: 1, INS_HNTC2_ENABLE: 0 }, env0, tracking)
    assert.equal(filters.notch[0].enabled(), false)
    assert.ok(filters.warnings.some((w) => /FFT/.test(w)), filters.warnings.join('; '))
    assert.doesNotThrow(() => interpolate_tracking(tracking, [{ FFT: { time: [0.5] } }]))
})

test('I2 NotchTarget: сообщение источника объявлено без строк (RATE, FTN1) — источник без данных, без исключения', () => {
    const log = fake_log({ messages: { RATE: {}, FTN1: {}, CTUN: {} } })
    assert.doesNotThrow(() => create_tracking(log, env_for(log), { start_time: 0, end_time: 1 }))
    const tracking = create_tracking(log, env_for(log), { start_time: 0, end_time: 1 })
    assert.equal(tracking[1].have_data({ options: 0 }), false, 'газ')
    assert.equal(tracking[4].have_data({ options: 0 }), false, 'FFT')
})

// ---------- Шаг 1 под заглушками: ensure_gyro (I2), окно raw (I5), M3, M4, M5 ----------

// Новый лог в состоянии мастера, как после load() в wizard.js, и сброс шага 1
function load_state(log, { window_size = 1024, log_type = null } = {}) {
    const params = log_params(log)
    Object.assign(state, {
        log, params, env: { params, build_type: 2, filter_version: 2 },
        settings: { start: 0, end: 1e9, min: null, max: null, window_size },
        spectrum: { ...state.spectrum, log_type, window_per_batch: 1, filter_version: 2 },
        gyro: null, tracking: null, logged: null, filters: null, load_warnings: [],
    })
    step1_reset()
}

setup_step1_plots()

test('I2 ensure_gyro: исключение в источниках трекинга — ошибка в step1.error, состояние восстановимо, повтор лечит', () => {
    const log = fake_log({ messages: { ...batch_messages(), ESC: { instances: { 0: {} } } }, params: gyro_params() })
    // ESC объявлен, а чтение его падает — как неожиданный формат в конструкторе источника
    const get_instance = log.get_instance
    let broken = true
    log.get_instance = function (name, instance, field) {
        if (broken && (name === 'ESC')) {
            throw new Error('нечитаемый ESC')
        }
        return get_instance.call(this, name, instance, field)
    }
    const errors = []
    const console_error = console.error
    console.error = (e) => errors.push(e)
    try {
        load_state(log)
        for (let attempt = 0; attempt < 2; attempt++) {
            assert.equal(step1_prepare(), false, 'попытка ' + attempt)
            assert.match(step1_state.error, /источники трекинга/)
            assert.match(step1_state.error, /нечитаемый ESC/)
            assert.ok(state.gyro != null && state.gyro.error == null, 'гироскоп загружен')
            assert.equal(state.tracking, null)
            assert.equal(state.logged, null)
            assert.equal(state.filters, null)
            assert.equal(step1_ready(), false)
        }
        assert.equal(errors.length, 2, 'исключение попало в консоль')
        // Перерисовка с таким состоянием не падает и показывает ошибку в вердикте
        assert.doesNotThrow(() => redraw_step1())
        assert.equal(element('verdict1').hidden, false)
        assert.match(element('verdict1').textContent, /нечитаемый ESC/)
        // Лог «починился» (повторная попытка): источники готовы, FFT и фильтры посчитаны
        broken = false
        assert.equal(step1_prepare(), true)
        assert.equal(step1_state.error, null)
        assert.ok(state.tracking != null && state.logged != null && state.filters != null)
        assert.equal(step1_ready(), true)
        assert.doesNotThrow(() => redraw_step1())
    } finally {
        console.error = console_error
    }
})

test('I5 окно raw хранится отдельно от окна batch: поле шага 0 показывает окно batch, настройка не меняется, после смены типа — окно raw', () => {
    // Пакеты по 2048 отсчётов: окно batch при одном окне на пакет — 2048, окно raw в настройках — 1024
    const log = fake_log({ messages: { ...batch_messages({ samples: 2048 }), ...raw_messages() }, params: gyro_params({ raw_opt: 0 }) })
    load_state(log, { window_size: 1024, log_type: 'batch' })
    const field = element('FFTWindow_size')
    assert.equal(step1_prepare(), true)
    assert.equal(state.gyro.type, 'batch')
    assert.equal(state.gyro[0].FFT.window_size, 2048)
    assert.equal(field.value, 2048, 'в поле — вычисленное окно batch')
    assert.equal(field.disabled, true)
    assert.equal(state.settings.window_size, 1024, 'окно raw не подменено окном batch')
    assert.equal(step1_state.fft_key, 'batch:1')

    // Смена типа лога на raw, как в step1_recalc: окно — снова из настроек
    state.spectrum.log_type = 'raw'
    state.gyro = null
    assert.equal(step1_prepare(), true)
    assert.equal(state.gyro.type, 'raw')
    assert.equal(state.gyro[0].FFT.window_size, 1024)
    assert.equal(field.value, 1024, 'в поле — окно raw')
    assert.equal(field.disabled, false)
    assert.equal(step1_state.fft_key, 'raw:1024')
    assert.equal(step1_ready(), true)
})

test('M3 valid_windows_per_batch: только окна не меньше 64 отсчётов', () => {
    const log = fake_log({ messages: batch_messages({ samples: 1024 }), params: gyro_params() })
    const gyro = load_gyro(log, env_for(log), { log_type: null })
    // floor(1024 / (1 + (w − 1)·0.5)): 1 → 1024, 3 → 512, 7 → 256, 15 → 128, 31 → 64; 63 → 32 — меньше 64, не предлагается
    assert.deepEqual(valid_windows_per_batch(gyro), [1, 3, 7, 15, 31])
    assert.deepEqual(valid_windows_per_batch([]), [])
})

test('M4 step1_pending: пустое или нечисловое поле «Окон на пакет» — 1', () => {
    const field = element('spec_window_per_batch')
    for (const [value, expected] of [['', 1], ['abc', 1], ['0', 1], ['-2', 1], ['4', 4], ['2.7', 2]]) {
        field.value = value
        assert.equal(step1_pending().window_per_batch, expected, 'поле «' + value + '»')
    }
    field.value = '1'
})

test('M5 спектрограмма: у выбранного гироскопа нет данных выбранного вида — пояснение под графиком', () => {
    const log = fake_log({ messages: batch_messages(), params: gyro_params() })
    load_state(log)
    assert.equal(step1_prepare(), true)
    const note = element('spec_sg_note')
    redraw_spectrogram1()
    assert.equal(note.hidden, true, 'гироскоп 1 «до» по умолчанию — данные есть')
    assert.ok(plots.Spectrogram1.data[0].z.length > 0)
    // Второго гироскопа в логе нет
    check_radio('spec_sg_inst1')
    redraw_spectrogram1()
    assert.equal(note.hidden, false)
    assert.match(note.textContent, /гироскопа 2/)
    assert.match(note.textContent, /до фильтров/)
    assert.equal(plots.Spectrogram1.data[0].z.length, 0, 'карта пустая')
    // «После» для гироскопа 1: записи «после» нет
    check_radio('spec_sg_inst0')
    check_radio('spec_sg_post')
    redraw_spectrogram1()
    assert.equal(note.hidden, false)
    assert.match(note.textContent, /гироскопа 1/)
    assert.match(note.textContent, /после фильтров/)
    check_radio('spec_sg_pre')
    redraw_spectrogram1()
    assert.equal(note.hidden, true)
})

test('M9 step1_reset скрывает поле «Окон на пакет» и пояснение спектрограммы', () => {
    element('spec_batch_field').hidden = false
    element('spec_sg_note').hidden = false
    step1_reset()
    assert.equal(element('spec_batch_field').hidden, true)
    assert.equal(element('spec_sg_note').hidden, true)
})

// ---------- Мелочи ядра ----------

test('M1 load_gyro: GYR без экземпляров (старый формат без поля I) — понятная ошибка, без исключения', () => {
    const log = fake_log({ messages: { GYR: { TimeUS: [0, 1e6], SampleUS: [0, 1e6], GyrX: [0, 0] } }, params: gyro_params() })
    let gyro
    assert.doesNotThrow(() => { gyro = load_gyro(log, env_for(log), { log_type: null }) })
    assert.match(gyro.error, /GYR/)
    assert.match(gyro.error, /экземпляра/)
})

test('alias_obj: частота контура не положительное число — как режим none', () => {
    const log = fake_log({ messages: batch_messages(), params: gyro_params() })
    const gyro = load_gyro(log, env_for(log), { log_type: null })
    gyro_fft(gyro, { window_size: 1024, window_per_batch: 1 })
    const FFT = gyro[0].FFT
    for (const loop_rate of [NaN, 0, -400, undefined, null]) {
        for (const mode of ['fold', 'only']) {
            const alias = alias_obj(FFT, { mode, loop_rate })
            assert.equal(alias.bins, FFT.bins, mode + ' при ' + loop_rate)
            assert.equal(alias.len, FFT.x[0].length)
            assert.equal(alias.apply_amp(FFT.x[0]), FFT.x[0], 'амплитуды как есть')
        }
    }
    assert.ok(alias_obj(FFT, { mode: 'fold', loop_rate: 400 }).bins.length !== FFT.bins.length, 'с частотой контура сворачивание работает')
})

test('values_from_log: ESCMSK — по правилу escmsk_present (записан в лог или версия фильтра не ниже 4), как у шага 2', () => {
    const with_params = (params, filter_version) => {
        state.params = { get: (name) => (name in params) ? params[name] : null, has: (name) => name in params }
        state.env = { params: state.params, build_type: 2, filter_version }
        return values_from_log()
    }
    // Записанная в лог маска при версии фильтра 2 остаётся (раньше обнулялась, как в update_hidden_params FilterReview, и
    // notch-база шага 3 расходилась с формой шага 2 из-за одной маски)
    assert.equal(with_params({ INS_HNTCH_ESCMSK: 3, INS_HNTC2_ESCMSK: 5 }, 2).INS_HNTCH_ESCMSK, 3)
    assert.equal(with_params({ INS_HNTCH_ESCMSK: 3, INS_HNTC2_ESCMSK: 5 }, 2).INS_HNTC2_ESCMSK, 5, 'маска второго notch — тем же правилом')
    // Нет в логе и версия ниже 4 — 0 (умолчание и так 0); версия 4 без записи — 0 из умолчания, а записанная — из лога
    assert.equal(with_params({}, 2).INS_HNTCH_ESCMSK, 0)
    assert.equal(with_params({}, 4).INS_HNTCH_ESCMSK, 0)
    assert.equal(with_params({ INS_HNTCH_ESCMSK: 12 }, 4).INS_HNTCH_ESCMSK, 12)
    // Остальное прежнее: умолчания формы FilterReview и маска HMNCS без знака
    const values = with_params({ INS_HNTCH_HMNCS: -128 }, 2)
    assert.deepEqual([values.INS_GYRO_FILTER, values.SCHED_LOOP_RATE, values.INS_HNTCH_FREQ, values.INS_HNTCH_HMNCS], [20, 400, 80, 128])
})
