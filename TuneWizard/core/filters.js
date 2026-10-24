// Фильтры гироскопа, их передаточная функция и оценка спектра «после». Без DOM: работает в браузере и под Node (тесты).
// Перенос из FilterReview/FilterReview.js (upstream 05d6177) построчно, чтобы будущие изменения FilterReview
// переносились диффом. Источники: DigitalBiquadFilter, NotchFilter, MultiNotch (12–165), HarmonicNotchFilter
// (169–275), max_num_harmonics (494), интерполяция трекинга (885–888), calculate_transfer_function (893–951),
// get_phase и phase_scale (1058–1108), статистика линий notch внутри redraw (1193–1262), оценка «после» внутри
// redraw_post_estimate_and_bode (1295–1350) и среднее бодэ там же (1409–1445), get_HNotch_param_names и
// load_filters (1838–1871).
//
// Замены относительно upstream (слева — FilterReview, справа — здесь):
//   глобалы Gyro_batch, filters, tracking_methods       → аргументы gyro, filters, tracking
//   get_filter_version()                                → env.filter_version
//   alert(msg)                                          → this.warnings.push(msg); tracking.no_data_error(params)
//                                                         возвращает текст, он тоже попадает в warnings
//   max_num_harmonics                                   → MAX_NUM_HARMONICS
//   find_start_index(time) / find_end_index(time)       → (time, range), range = [t0, t1] (core/gyro.js)
//   parameter_get_value(name) и поле INS_GYRO_FILTER    → values[name] ?? 0 (объект имя → число)
//   filters = [] и params = [] (массивы как словари)    → обычные объекты {}
//   get_amplitude_scale(), get_alias_obj(FFT)           → аргументы amplitude_scale (fft_amplitude_scale из
//                                                         Libraries/fft.js) и alias = { bins, apply_amp(amp) }
//   document.getElementById("ScaleWrap").checked        → без проверки: phase_wrap вызывает тот, кому нужна свёртка
//   frequency_scale.fun(...)                            → без масштаба: notch_line_stats отдаёт герцы
//   Notch…Show / SpecNotch…Show / calculate_filters     → убраны (DOM)
//
// Нужны глобалы страницы: Libraries/Array_Math.js, core/gyro.js (find_start_index, find_end_index)
// и классы core/tracking/*.

// Наибольшее число гармоник notch (битовая маска INS_HNTCH_HMNCS)
const MAX_NUM_HARMONICS = 16

function DigitalBiquadFilter(freq) {
    this.target_freq = freq

    if (this.target_freq <= 0) {
        this.transfer = function(Hn, Hd, sample_freq, Z1, Z2) { }
        return this
    }

    this.transfer = function(Hn, Hd, sample_freq, Z1, Z2) {

        const fr = sample_freq/this.target_freq
        const ohm = Math.tan(Math.PI/fr)
        const c = 1.0+2.0*Math.cos(Math.PI/4.0)*ohm + ohm*ohm

        const b0 = ohm*ohm/c
        const b1 = 2.0*b0
        const b2 = b0
        const a1 = 2.0*(ohm*ohm-1.0)/c
        const a2 = (1.0-2.0*Math.cos(Math.PI/4.0)*ohm+ohm*ohm)/c

        // Строим передаточную функцию и применяем к H; деление — на последнем шаге
        const len = Z1[0].length
        for (let i = 0; i<len; i++) {
            // H(z) = (b0 + b1*z^-1 + b2*z^-2)/(1 + a1*z^-1 + a2*z^-2)
            const numerator_r = b0 + b1 * Z1[0][i] + b2 * Z2[0][i]
            const numerator_i =      b1 * Z1[1][i] + b2 * Z2[1][i]

            const denominator_r = 1 + a1 * Z1[0][i] + a2 * Z2[0][i]
            const denominator_i =     a1 * Z1[1][i] + a2 * Z2[1][i]

            // Это просто два комплексных умножения
            // Развёрнуты здесь ради памяти и скорости
            const numerator_ac = Hn[0][i] * numerator_r
            const numerator_bd = Hn[1][i] * numerator_i
            const numerator_ad = Hn[0][i] * numerator_i
            const numerator_bc = Hn[1][i] * numerator_r

            Hn[0][i] = numerator_ac - numerator_bd
            Hn[1][i] = numerator_ad + numerator_bc

            const denominator_ac = Hd[0][i] * denominator_r
            const denominator_bd = Hd[1][i] * denominator_i
            const denominator_ad = Hd[0][i] * denominator_i
            const denominator_bc = Hd[1][i] * denominator_r

            Hd[0][i] = denominator_ac - denominator_bd
            Hd[1][i] = denominator_ad + denominator_bc
        }

    }

    return this
}

function NotchFilter(attenuation_dB, bandwidth_hz, harmonic_mul, min_freq_fun, spread_mul) {
    this.A = 10.0**(-attenuation_dB / 40.0)

    this.transfer = function(Hn, Hd, center, sample_freq, Z1, Z2) {
        let center_freq_hz = center * harmonic_mul

        // Проверяем, что центральная частота в допустимых пределах
        if ((center_freq_hz <= 0.5 * bandwidth_hz) || (center_freq_hz >= 0.5 * sample_freq)) {
            return
        }

        const min_freq = min_freq_fun(harmonic_mul)
        let A = this.A
        if (center_freq_hz < min_freq) {
            const disable_freq = min_freq * 0.25
            if (center_freq_hz < disable_freq) {
                // Выключен
                return
            }

            // Снижаем ослабление (A = 1.0 — без ослабления)
            const ratio = (center_freq_hz - disable_freq) / (min_freq - disable_freq)
            A = 1.0 + (A - 1.0) * ratio
        }
        center_freq_hz = Math.max(center_freq_hz, min_freq) * spread_mul

        const octaves = Math.log2(center_freq_hz / (center_freq_hz - bandwidth_hz / 2.0)) * 2.0
        const Q = ((2.0**octaves)**0.5) / ((2.0**octaves) - 1.0)
        const Asq = A**2

        const omega = 2.0 * Math.PI * center_freq_hz / sample_freq
        const alpha = Math.sin(omega) / (2 * Q)
        const b0 =  1.0 + alpha*Asq
        const b1 = -2.0 * Math.cos(omega)
        const b2 =  1.0 - alpha*Asq
        const a0 =  1.0 + alpha
        const a1 = b1
        const a2 =  1.0 - alpha

        // Строим передаточную функцию и применяем к H; деление — на последнем шаге
        const len = Z1[0].length
        for (let i = 0; i<len; i++) {
            // H(z) = (b0 + b1*z^-1 + b2*z^-2)/(a0 + a1*z^-1 + a2*z^-2)
            const numerator_r = b0 + b1 * Z1[0][i] + b2 * Z2[0][i]
            const numerator_i =      b1 * Z1[1][i] + b2 * Z2[1][i]

            const denominator_r = a0 + a1 * Z1[0][i] + a2 * Z2[0][i]
            const denominator_i =      a1 * Z1[1][i] + a2 * Z2[1][i]

            // Это просто два комплексных умножения
            // Развёрнуты здесь ради памяти и скорости
            const numerator_ac = Hn[0][i] * numerator_r
            const numerator_bd = Hn[1][i] * numerator_i
            const numerator_ad = Hn[0][i] * numerator_i
            const numerator_bc = Hn[1][i] * numerator_r

            Hn[0][i] = numerator_ac - numerator_bd
            Hn[1][i] = numerator_ad + numerator_bc

            const denominator_ac = Hd[0][i] * denominator_r
            const denominator_bd = Hd[1][i] * denominator_i
            const denominator_ad = Hd[0][i] * denominator_i
            const denominator_bc = Hd[1][i] * denominator_r

            Hd[0][i] = denominator_ac - denominator_bd
            Hd[1][i] = denominator_ad + denominator_bc
        }

    }

    return this
}

function MultiNotch(attenuation_dB, bandwidth_hz, harmonic, min_freq_fun, num, center) {

    // Разнос, при котором два notch с полосой/2 эквивалентны одному
    const notch_spread = bandwidth_hz / (32.0 * center)

    const bw_scaled = (bandwidth_hz * harmonic) / num

    this.notches = []
    this.notches.push(new NotchFilter(attenuation_dB, bw_scaled, harmonic, min_freq_fun, 1.0 - notch_spread))
    this.notches.push(new NotchFilter(attenuation_dB, bw_scaled, harmonic, min_freq_fun, 1.0 + notch_spread))
    if (num >= 3) {
        this.notches.push(new NotchFilter(attenuation_dB, bw_scaled, harmonic, min_freq_fun, 1.0))
    }
    if (num == 5) {
        this.notches.push(new NotchFilter(attenuation_dB, bw_scaled, harmonic, min_freq_fun, 1.0 - (2.0 * notch_spread)))
        this.notches.push(new NotchFilter(attenuation_dB, bw_scaled, harmonic, min_freq_fun, 1.0 + (2.0 * notch_spread)))
    }

    this.transfer = function(Hn, Hd, center, sample_freq, Z1, Z2) {
        const len = this.notches.length
        for (let i = 0; i<len; i++) {
            this.notches[i].transfer(Hn, Hd, center, sample_freq, Z1, Z2)
        }
    }

    return this
}



// params = { enable, mode, freq, bandwidth, attenuation, ref, min_ratio, harmonics, options, esc_mask },
// env = { filter_version, … }, tracking — массив источников (create_tracking)
function HarmonicNotchFilter(params, env, tracking) {
    this.params = params
    this.warnings = []

    // Ищем источник трекинга
    this.tracking = null
    for (let j=0;j<tracking.length;j++) {
        if (this.params.mode == tracking[j].mode_value) {
            this.tracking = tracking[j]
            if ((this.params.enable > 0) && !this.tracking.have_data(this.params)) {
                const msg = this.tracking.no_data_error(this.params)
                if (msg) {
                    this.warnings.push(msg)
                }
            }
            break
        }
    }

    if (this.tracking == null) {
        this.warnings.push("Неподдерживаемый режим notch " + this.params.mode)
    }

    this.enabled = function() {
        return (this.params.enable > 0) && (this.tracking != null) && this.tracking.have_data(this.params)
    }

    this.static = function() {
        return this.tracking.mode_value == 0
    }

    this.harmonics = function() {
        return this.params.harmonics
    }

    if (!this.enabled()) {
        // Выключен
        this.transfer = function(Hn, Hd, instance, index, sample_freq, Z1, Z2) { }
        return this
    }

    const filter_version = env.filter_version

    const quintuple = (this.params.options & 64) != 0
    const triple = (this.params.options & 16) != 0
    const double = (this.params.options & 1) != 0

    let num_composite_notches = 1
    if (double) {
        num_composite_notches = 2
    } else if (triple) {
        num_composite_notches = 3
    } else if (quintuple) {
        if (filter_version < 4) {
            this.warnings.push("Пятикратный notch поддерживается только с версии фильтра 4")
        } else {
            num_composite_notches = 5
        }
    }

    const filter_V1 = filter_version == 1
    const treat_low_freq_as_min = (this.params.options & 32) != 0

    this.get_min_freq = function(harmonic) {
        if (filter_V1) {
            return 0.0
        }
        const min_freq = this.params.freq * this.params.min_ratio
        if (treat_low_freq_as_min) {
            return min_freq * harmonic
        }
        return min_freq
    }

    this.notches = []
    for (var n=0; n<MAX_NUM_HARMONICS; n++) {
        if (this.params.harmonics & (1<<n)) {
            const harmonic = n + 1
            if (num_composite_notches == 1) {
                this.notches.push(new NotchFilter(this.params.attenuation, this.params.bandwidth * harmonic, harmonic, (h) => { return this.get_min_freq(h) }, 1.0))
            } else {
                this.notches.push(new MultiNotch(this.params.attenuation, this.params.bandwidth, harmonic, (h) => { return this.get_min_freq(h) }, num_composite_notches, this.params.freq))
            }
        }
    }

    this.transfer = function(Hn, Hd, instance, index, sample_freq, Z1, Z2) {
        // Целевые частоты от источника
        const freq = this.tracking.get_interpolated_target_freq(instance, index, this.params)

        if (freq != null) {
            for (let i = 0; i<this.notches.length; i++) {
                // По каждому notch
                for (let j=0; j<freq.length; j++) {
                    // Каждый notch прогоняем несколько раз — для многочастотного трекинга по моторам/ESC/FFT
                    this.notches[i].transfer(Hn, Hd, freq[j], sample_freq, Z1, Z2)
                }
            }
        }
    }

    this.get_target_freq = function() {
        return this.tracking.get_target_freq(this.params)
    }

    this.name = function() {
        return this.tracking.name
    }

    return this
}

// Имена параметров двух гармонических notch по ключам params (get_HNotch_param_names в upstream)
function notch_param_names() {
    let prefix = ["INS_HNTCH_", "INS_HNTC2_"]
    let ret = []
    for (let i = 0; i < prefix.length; i++) {
        ret[i] = {enable: prefix[i] + "ENABLE",
                  mode: prefix[i] + "MODE",
                  freq: prefix[i] + "FREQ",
                  bandwidth: prefix[i] + "BW",
                  attenuation: prefix[i] + "ATT",
                  ref: prefix[i] + "REF",
                  min_ratio: prefix[i] + "FM_RAT",
                  harmonics: prefix[i] + "HMNCS",
                  options: prefix[i] + "OPTS",
                  esc_mask: prefix[i] + "ESCMSK"}
    }
    return ret
}

// Источники трекинга в порядке режимов INS_HNTCH_MODE: 0 Static, 1 Throttle, 2 RPM1, 3 ESC, 4 FFT, 5 RPM2.
// Каждый источник несёт warnings, собранные при создании (например, неожиданный параметр мотора у Throttle);
// load_filters добавляет их в сводку filters.warnings
function create_tracking(log, env, gyro) {
    return [new StaticTarget(gyro, env), new ThrottleTarget(log, env), new RPMTarget(log, env, 1, 2), new ESCTarget(log, env), new FFTTarget(log, env), new RPMTarget(log, env, 2, 5)]
}

// Записанные в лог частоты notch по экземплярам
function create_logged(log) {
    return [new LoggedNotch(log, 0), new LoggedNotch(log, 1)]
}

// Интерполяция трекинга к окнам FFT каждого экземпляра (FR 885–888)
function interpolate_tracking(tracking, gyro) {
    for (let i = 0; i < gyro.length; i++) {
        if ((gyro[i] == null) || (gyro[i].FFT == null)) {
            continue
        }
        for (let j=0;j<tracking.length;j++) {
            tracking[j].interpolate(i, gyro[i].FFT.time)
        }
    }
}

// Фильтры по значениям параметров: values — объект имя → число (INS_GYRO_FILTER, INS_HNTCH_*, INS_HNTC2_*).
// Возвращает { static, notch: [два HarmonicNotchFilter], warnings }
function load_filters(values, env, tracking) {

    const filters = {}
    const HNotch_params = notch_param_names()

    // Статический ФНЧ
    filters.static = new DigitalBiquadFilter(values["INS_GYRO_FILTER"] ?? 0)

    // Гармонические notch
    filters.notch = []
    filters.warnings = []
    for (let i = 0; i < HNotch_params.length; i++) {
        const params = {}
        for (const [key, value] of Object.entries(HNotch_params[i])) {
            params[key] = values[value] ?? 0
        }
        filters.notch.push(new HarmonicNotchFilter(params, env, tracking))
        filters.warnings.push(...filters.notch[i].warnings)
    }

    // Предупреждения источников трекинга, собранные при их создании, без повторов
    filters.warnings.push(...new Set(tracking.flatMap((t) => t.warnings)))

    return filters
}

// Передаточная функция фильтров на сетке FFT (FFT.H, по окнам) и на сетке бодэ (FFT.bode.H)
function calculate_transfer_function(filters, gyro) {

    function calc(index, time, rate, Z1, Z2) {

        const Z_len = Z1[0].length
        let one = [new Array(Z_len), new Array(Z_len)]
        one[0].fill(1)
        one[1].fill(0)

        let Hn_static = [one[0].slice(), one[1].slice()]
        let Hd_static = [one[0].slice(), one[1].slice()]

        // ФНЧ в полёте частоту не меняет
        filters.static.transfer(Hn_static, Hd_static, rate, Z1, Z2)

        // Статические notch
        for (let k=0; k<filters.notch.length; k++) {
            if (filters.notch[k].enabled() && filters.notch[k].static()) {
                filters.notch[k].transfer(Hn_static, Hd_static, index, null, rate, Z1, Z2)
            }
        }

        // Динамические notch — на каждом шаге времени
        const len = time.length
        let ret_H = new Array(len)
        for (let j = 0; j < len; j++) {

            let Hn = [Hn_static[0].slice(), Hn_static[1].slice()]
            let Hd = [Hd_static[0].slice(), Hd_static[1].slice()]

            for (let k=0; k<filters.notch.length; k++) {
                if (filters.notch[k].enabled() && !filters.notch[k].static()) {
                    filters.notch[k].transfer(Hn, Hd, index, j, rate, Z1, Z2)
                }
            }

            ret_H[j] = complex_div(Hn, Hd)
        }

        return ret_H
    }

    // Считаем по времени и частотам FFT — для оценки «после»
    for (let i = 0; i < gyro.length; i++) {
        if ((gyro[i] == null) || (gyro[i].FFT == null)) {
            continue
        }
        if (gyro[i].FFT.Z1 != null) {
            // Передаточные функции для оценки «после»
            gyro[i].FFT.H = calc(i, gyro[i].FFT.time, gyro[i].FFT.average_sample_rate, gyro[i].FFT.Z1, gyro[i].FFT.Z2)

        }
        if (gyro[i].FFT.bode != null) {
            // Если есть данные «после», используем их

            // Более частая сетка для бодэ
            gyro[i].FFT.bode.H = calc(i, gyro[i].FFT.time, gyro[i].FFT.average_sample_rate, gyro[i].FFT.bode.Z1, gyro[i].FFT.bode.Z2)
        }
    }
}

// Фаза H в градусах с развёрткой
function get_phase(H) {

    let phase = array_scale(complex_phase(H), 180/Math.PI)
    const len = phase.length

    // Notch даёт большие положительные скачки фазы — смещаем развёртку, чтобы она справлялась лучше
    const neg_threshold = 45
    const pos_threshold = 360 - neg_threshold

    let unwrapped = new Array(len)

    unwrapped[0] = phase[0]
    for (let i = 1; i < len; i++) {
        let phase_diff = phase[i] - phase[i-1]
        if (phase_diff >= pos_threshold) {
            phase_diff -= 360
        } else if (phase_diff <= -neg_threshold) {
            phase_diff += 360
        }
        unwrapped[i] = unwrapped[i-1] + phase_diff
    }

    return unwrapped
}

// Свёртка фазы в ±180° (phase_scale в upstream): все массивы сворачиваются по первому
function phase_wrap(phase) {

    // Сворачиваем все массивы по первому
    const arrays = phase.length
    const len = phase[0].length
    for (let i = 1; i < len; i++) {
        if (phase[0][i] > 180) {
            for (let j = 0; j < arrays; j++) {
                phase[j][i] -= 360
            }
        } else if (phase[0][i] < -180) {
            for (let j = 0; j < arrays; j++) {
                phase[j][i] += 360
            }
        }
        if (Math.abs(phase[0][i]) > 180) {
            i--
        }
    }

    return phase
}

// Оценка спектра «после» для экземпляра i по данным «до» и FFT.H: { x, y, z } уже после alias.apply_amp
// и amplitude_scale.scale; null, если у экземпляра нет FFT или H
function estimate_post(gyro, i, amplitude_scale, range, alias) {
    if ((gyro[i] == null) || (gyro[i].FFT == null) || (gyro[i].FFT.x.length == 0) || (gyro[i].FFT.H == null)) {
        return null
    }

    // Поправка амплитуды окна зависит от выбранного спектра и разрешения
    const FFT_resolution = gyro[i].FFT.average_sample_rate/gyro[i].FFT.window_size
    const window_correction = amplitude_scale.window_correction(gyro[i].FFT.correction, FFT_resolution)

    // Шум квантования масштабируем поправкой окна, чтобы поправку можно было применить позже
    const quantization_correction = gyro.quantization_noise * amplitude_scale.quantization_correction(window_correction)

    // Начальный и конечный индексы
    const start_index = find_start_index(gyro[i].FFT.time, range)
    const end_index = find_end_index(gyro[i].FFT.time, range)+1

    // Оцениваем «после» по данным «до»
    const fft_len = gyro[i].FFT.x[0].length
    let fft_mean_x = (new Array(fft_len)).fill(0)
    let fft_mean_y = (new Array(fft_len)).fill(0)
    let fft_mean_z = (new Array(fft_len)).fill(0)
    for (let j=start_index;j<end_index;j++) {
        const attenuation = complex_abs(gyro[i].FFT.H[j])

        // Вычитаем шум, применяем передаточную функцию, возвращаем шум
        // Строго говоря, шум можно не трогать — с ним оценка менее точна,
        // зато хорошо сходится с записанными данными «после», что упрощает проверку оценок
        const filtered_x = array_offset(array_mul(array_offset(gyro[i].FFT.x[j], -quantization_correction), attenuation), quantization_correction)
        const filtered_y = array_offset(array_mul(array_offset(gyro[i].FFT.y[j], -quantization_correction), attenuation), quantization_correction)
        const filtered_z = array_offset(array_mul(array_offset(gyro[i].FFT.z[j], -quantization_correction), attenuation), quantization_correction)

        // Добавляем к сумме для среднего
        fft_mean_x = array_add(fft_mean_x, amplitude_scale.fun(filtered_x))
        fft_mean_y = array_add(fft_mean_y, amplitude_scale.fun(filtered_y))
        fft_mean_z = array_add(fft_mean_z, amplitude_scale.fun(filtered_z))
    }

    // Число усреднённых окон
    const mean_length = end_index - start_index

    const corrected_x = array_scale(fft_mean_x, window_correction / mean_length)
    const corrected_y = array_scale(fft_mean_y, window_correction / mean_length)
    const corrected_z = array_scale(fft_mean_z, window_correction / mean_length)

    // Свёртка частот (alias) и выбранный масштаб
    return { x: amplitude_scale.scale(alias.apply_amp(corrected_x)),
             y: amplitude_scale.scale(alias.apply_amp(corrected_y)),
             z: amplitude_scale.scale(alias.apply_amp(corrected_z)) }
}

// Среднее, максимум и минимум амплитуды и фазы бодэ экземпляра index по окнам в диапазоне range.
// Амплитуда линейная (масштаб накладывает вызывающая сторона), фаза в градусах без свёртки
function bode_mean(gyro, index, range) {
    // Без FFT, окон, сетки бодэ или ещё не посчитанной H считать нечего — upstream такие экземпляры
    // пропускал при выборе индекса (FR 1396–1408); null симметрично estimate_post
    if ((gyro[index] == null) || (gyro[index].FFT == null) || (gyro[index].FFT.x.length == 0) || (gyro[index].FFT.bode == null) || (gyro[index].FFT.bode.H == null)) {
        return null
    }

    // Начальный и конечный индексы
    const start_index = find_start_index(gyro[index].FFT.time, range)
    const end_index = find_end_index(gyro[index].FFT.time, range)+1

    // Множитель для среднего из накопленной суммы
    const mean_scale = 1 / (end_index - start_index)

    const H_len = gyro[index].FFT.bode.H[0][0].length
    let Amp_mean = (new Array(H_len)).fill(0)
    let Phase_mean = (new Array(H_len)).fill(0)
    let Amp_max
    let Amp_min
    let Phase_max
    let Phase_min
    for (let j=start_index;j<end_index;j++) {
        const H = gyro[index].FFT.bode.H[j]
        const HR_att = complex_abs(H)
        const HR_phase = get_phase(H)
        Amp_mean = array_add(Amp_mean, HR_att)
        Phase_mean = array_add(Phase_mean, HR_phase)

        if (j > start_index) {
            Amp_max = array_max(Amp_max, HR_att)
            Amp_min = array_min(Amp_min, HR_att)
            Phase_max = array_max(Phase_max, HR_phase)
            Phase_min = array_min(Phase_min, HR_phase)
        } else {
            Amp_max = HR_att
            Amp_min = HR_att
            Phase_max = HR_phase
            Phase_min = HR_phase
        }
    }

    Amp_mean = array_scale(Amp_mean, mean_scale)
    Phase_mean = array_scale(Phase_mean, mean_scale)

    return { freq: gyro[index].FFT.bode.freq,
             amp_mean: Amp_mean, amp_max: Amp_max, amp_min: Amp_min,
             phase_mean: Phase_mean, phase_max: Phase_max, phase_min: Phase_min }
}

// Линии частот notch: для каждого notch { enabled, harmonics: [{ harmonic, mean, min, max }] } в герцах
// по окнам диапазона range (у выключенного notch список пуст)
function notch_line_stats(filters, range) {
    const stats = []

    for (let i=0;i<filters.notch.length;i++) {
        if (!filters.notch[i].enabled()) {
            stats.push({ enabled: false, harmonics: [] })
            continue
        }

        const fundamental = filters.notch[i].get_target_freq()

        function get_mean_and_range(time, freq_array, harmonic, lower_limit) {
            // Начальный и конечный индексы
            const start_index = find_start_index(time, range)
            const end_index = find_end_index(time, range)+1

            // Среднее и размах от начала до конца
            var mean = 0
            var min = null
            var max = null
            for (let j=start_index;j<end_index;j++) {
                const freq = Math.max(freq_array[j] * harmonic, lower_limit)
                mean += freq
                if ((min == null) || (freq < min)) {
                    min = freq
                }
                if ((max == null) || (freq > max)) {
                    max = freq
                }
            }
            mean /= end_index - start_index

            return { mean: mean, min:min, max:max}
        }

        function get_stats(harmonic, lower_limit) {
            var mean
            var min
            var max
            if (!Array.isArray(fundamental.time[0])) {
                // Один пик
                let mean_range = get_mean_and_range(fundamental.time, fundamental.freq, harmonic, lower_limit)
                mean = mean_range.mean
                min = mean_range.min
                max = mean_range.max

            } else {
                // Объединяем несколько пиков
                mean = 0
                min = null
                max = null
                for (let j=0;j<fundamental.time.length;j++) {
                    let mean_range = get_mean_and_range(fundamental.time[j], fundamental.freq[j], harmonic, lower_limit)
                    mean += mean_range.mean
                    if ((min == null) || (mean_range.min < min)) {
                        min = mean_range.min
                    }
                    if ((max == null) || (mean_range.max > max)) {
                        max = mean_range.max
                    }
                }
                mean /= fundamental.time.length
            }
            return { mean, min, max }
        }

        const harmonics = []
        for (let j=0;j<MAX_NUM_HARMONICS;j++) {
            if ((filters.notch[i].harmonics() & (1<<j)) == 0) {
                continue
            }

            const harmonic = j + 1
            const harmonic_stats = get_stats(harmonic, filters.notch[i].get_min_freq(harmonic))

            harmonics.push({ harmonic: harmonic, mean: harmonic_stats.mean, min: harmonic_stats.min, max: harmonic_stats.max })
        }
        stats.push({ enabled: true, harmonics: harmonics })
    }

    return stats
}
