// Автоподбор первого гармонического notch по записанному спектру гироскопа до фильтров. Без DOM: работает
// в браузере и под Node (тесты).
// Перенос FilterReview/AutoFit.js из PR ArduPilot/WebTools#363 построчно, чтобы будущие изменения PR
// переносились диффом. Правила auto_fit_rules и вся логика — без изменений.
//
// Источник трекинга — ESC-телеметрия, если она есть в логе, затем газ по моторам, затем средний газ.
// Спектр каждого окна FFT пересчитывается на сетку кратных отслеживаемой частоты, и окна усредняются.
// Шум, который следует за моторами, складывается в пики на кратных отслеживаемой частоты, прочий шум
// размазывается. Источник берётся, только если пики чёткие — так заодно проверяется трекинг. Подавляются
// гармоники, выделяющиеся над местным уровнем шума, а ослабление задаётся тем, насколько выделяется
// наибольшая из них.
//
// Замены относительно PR (слева — PR, справа — здесь):
//   глобалы Gyro_batch, tracking_methods                → аргументы gyro, tracking (порядок create_tracking из core/filters.js)
//   find_start_index(time) / find_end_index(time)       → (time, range), range = [t0, t1] (core/gyro.js)
//   auto_fit(): calculate(), чтение INS_HNTCH_ESCMSK    → auto_fit(gyro, tracking, range, esc_mask) возвращает { result, errors };
//   из формы, alert                                       FFT до фильтров и интерполяцию трекинга обеспечивает вызывающий
//   хвост auto_fit(): parameter_set_value,              → auto_fit_values(result, current_values) — объект значений INS_HNTCH_*,
//   filter_param_read, auto_fit_info, loading_call        записывает и пересчитывает вызывающий
//   get_HNotch_param_names()                            → notch_param_names() (core/filters.js)
//   тексты ошибок и result.name                         → по-русски
//
// Нужны глобалы страницы: core/gyro.js (find_start_index, find_end_index) и core/filters.js (notch_param_names).

// Эмпирические правила
const auto_fit_rules = {
    // Гармоника подавляется, если её пик на столько выше местного уровня шума (дБ)
    min_peak_dB: 6,
    // Пределы ослабления (дБ)
    min_attenuation: 10,
    max_attenuation: 50,
    // Наибольшая рассматриваемая гармоника
    max_harmonic: 8,
    // Ширина поиска пика около каждой гармоники, в долях основной частоты
    peak_width: 0.1,
    // Ширина, исключаемая около каждой гармоники при оценке уровня шума, в долях основной частоты
    floor_exclude: 0.12,
    // Окна, где отслеживаемая частота ниже этой, пропускаются — моторы стоят (Гц)
    min_freq: 10,
    // Нижний предел частоты notch — эта доля наименьшей отслеживаемой частоты в полёте
    min_freq_ratio: 0.8,
    // Наименьшая отслеживаемая частота в полёте берётся как этот перцентиль
    low_percentile: 0.05,
    // Полоса в долях частоты notch, как советует описание параметра
    bandwidth_ratio: 0.5,
    // Трекинг по ESC отвергается, если наибольший пик дальше этого от целого кратного частоты моторов
    esc_order_tolerance: 0.1,
}

// Средняя мощность до фильтров, суммированная по осям, на сетке кратных отслеживаемой частоты
// get_tracked(instance, window) даёт отслеживаемую частоту для окна FFT или null
function auto_fit_order_spectrum(gyro, range, get_tracked, grid) {
    const num_points = Math.floor((grid.max - grid.min) / grid.step) + 1
    const sum = new Array(num_points).fill(0)
    const count = new Array(num_points).fill(0)
    const tracked = []

    for (let i = 0; i < gyro.length; i++) {
        if ((gyro[i] == null) || gyro[i].post_filter || (gyro[i].FFT == null)) {
            continue
        }
        const FFT = gyro[i].FFT
        const bin_width = FFT.bins[1]
        const num_bins = FFT.bins.length

        const start_index = find_start_index(FFT.time, range)
        const end_index = find_end_index(FFT.time, range) + 1
        for (let j = start_index; j < end_index; j++) {
            const freq = get_tracked(i, j)
            if ((freq == null) || !(freq > 0)) {
                continue
            }
            tracked.push(freq)

            const x = FFT.x[j]
            const y = FFT.y[j]
            const z = FFT.z[j]
            for (let k = 0; k < num_points; k++) {
                const pos = (grid.min + k * grid.step) * freq / bin_width
                const bin = Math.floor(pos)
                if (bin + 1 >= num_bins) {
                    break
                }
                const frac = pos - bin
                const power_0 = x[bin]**2 + y[bin]**2 + z[bin]**2
                const power_1 = x[bin+1]**2 + y[bin+1]**2 + z[bin+1]**2
                sum[k] += power_0 + (power_1 - power_0) * frac
                count[k]++
            }
        }
    }

    // Берём только точки, покрытые большинством окон: старшие кратные могут лежать выше частоты Найквиста
    const dB = new Array(num_points).fill(null)
    for (let k = 0; k < num_points; k++) {
        if ((count[k] > 0) && (count[k] >= tracked.length * 0.5)) {
            dB[k] = 10 * Math.log10(sum[k] / count[k])
        }
    }

    return { dB, grid, tracked }
}

// Наибольшее значение в окне, только если это пик: на склоне наибольшее значение лежит на краю окна
function auto_fit_peak_value(dB, start, end) {
    let max_index = start
    for (let k = start; k <= end; k++) {
        if (dB[k] > dB[max_index]) {
            max_index = k
        }
    }
    if ((max_index == start) || (max_index == end)) {
        return -Infinity
    }
    return dB[max_index]
}

// Насколько пик в данной точке выделяется над местным уровнем шума; ширины — доли scale
function auto_fit_peak_excess(spectrum, position, scale) {
    const grid = spectrum.grid
    const dB = spectrum.dB
    const index = (value) => Math.round((value - grid.min) / grid.step)
    const floor_start = index(position - scale * 0.5)
    const floor_end = index(position + scale * 0.5)
    if ((floor_start < 0) || (floor_end >= dB.length) || (dB[floor_start] == null) || (dB[floor_end] == null)) {
        return -Infinity
    }

    const peak = auto_fit_peak_value(dB, index(position - scale * auto_fit_rules.peak_width), index(position + scale * auto_fit_rules.peak_width))

    let floor = []
    for (let k = floor_start; k <= floor_end; k++) {
        if (Math.abs(grid.min + k * grid.step - position) > scale * auto_fit_rules.floor_exclude) {
            floor.push(dB[k])
        }
    }
    floor.sort((a, b) => a - b)
    return peak - floor[Math.floor(floor.length / 2)]
}

// Насколько пик на каждой гармонике основной частоты выделяется над местным уровнем шума (дБ)
// Гармоники за пределами спектра дают -Infinity
function auto_fit_harmonic_peaks(spectrum, fundamental) {
    let ret = []
    for (let harmonic = 1; harmonic <= auto_fit_rules.max_harmonic; harmonic++) {
        ret.push({ harmonic, excess: auto_fit_peak_excess(spectrum, fundamental * harmonic, fundamental) })
    }
    return ret
}

// Найти пик, сильнее всех выделяющийся над местным уровнем шума
// scale задаёт ширины поиска, null — брать положение каждого пика
function auto_fit_strongest_peak(spectrum, scale) {
    const dB = spectrum.dB
    const grid = spectrum.grid
    const half_width = 10
    let best = null
    for (let k = half_width; k < dB.length - half_width; k++) {
        if (dB[k] == null) {
            continue
        }
        // Проверяем только локальные максимумы
        let is_max = true
        for (let n = k - half_width; n <= k + half_width; n++) {
            if ((dB[n] != null) && (dB[n] > dB[k])) {
                is_max = false
                break
            }
        }
        if (!is_max) {
            continue
        }
        const position = grid.min + k * grid.step
        const excess = auto_fit_peak_excess(spectrum, position, scale ?? position)
        if ((best == null) || (excess > best.excess)) {
            best = { position, excess }
        }
    }
    if ((best == null) || (best.excess < auto_fit_rules.min_peak_dB)) {
        return
    }
    return best
}

// Выбрать по пикам гармоники для подавления и ослабление
function auto_fit_select(peaks) {
    let harmonics = 0
    let max_excess = 0
    for (const peak of peaks) {
        if (peak.excess >= auto_fit_rules.min_peak_dB) {
            harmonics |= 1 << (peak.harmonic - 1)
            max_excess = Math.max(max_excess, peak.excess)
        }
    }
    if (harmonics == 0) {
        return
    }
    const attenuation = Math.round(Math.min(Math.max(max_excess, auto_fit_rules.min_attenuation), auto_fit_rules.max_attenuation))
    return { harmonics, attenuation }
}

function auto_fit_percentile(values, fraction) {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.floor((sorted.length - 1) * fraction)]
}

// Отслеживаемая частота — частота моторов, notch стоят на её целых кратных
function auto_fit_esc(gyro, tracking, range, esc_mask) {
    const esc = tracking[3]
    if (!esc.have_data()) {
        return { error: "нет ESC-телеметрии" }
    }

    // Средняя частота моторов из маски
    const config = { options: 0, ref: 1, freq: 0, esc_mask }
    const get_tracked = (instance, index) => {
        const freq = esc.get_interpolated_target_freq(instance, index, config)
        if ((freq == null) || (freq[0] < auto_fit_rules.min_freq)) {
            return null
        }
        return freq[0]
    }
    const spectrum = auto_fit_order_spectrum(gyro, range, get_tracked, { min: 0.25, max: auto_fit_rules.max_harmonic + 0.75, step: 0.005 })
    if (spectrum.tracked.length == 0) {
        return { error: "нет окон FFT с работающими моторами" }
    }

    // Проверяем, что пики шума идут на целых кратных частоты моторов: гораздо больший пик в другом месте
    // говорит о неверном масштабе частоты ESC, например из-за числа полюсов моторов
    const peaks = auto_fit_harmonic_peaks(spectrum, 1)
    const strongest = auto_fit_strongest_peak(spectrum, 1)
    const max_harmonic_excess = Math.max(...peaks.map((peak) => peak.excess))
    if (strongest != null) {
        const nearest = Math.max(1, Math.round(strongest.position))
        const off_harmonic = Math.abs(strongest.position - nearest) > nearest * auto_fit_rules.esc_order_tolerance
        if (off_harmonic && (strongest.excess > max_harmonic_excess + auto_fit_rules.min_peak_dB)) {
            return { error: "наибольший пик шума на " + strongest.position.toFixed(2) + "× частоты ESC — проверьте число полюсов моторов" }
        }
    }

    const selection = auto_fit_select(peaks)
    if (selection == null) {
        return { error: "пики шума не следуют частоте ESC" }
    }

    const low = auto_fit_percentile(spectrum.tracked, auto_fit_rules.low_percentile)
    return {
        name: "ESC-телеметрия",
        mode: 3,
        freq: Math.round(low * auto_fit_rules.min_freq_ratio),
        ref: 1,
        min_ratio: 1,
        multi_source: esc.get_num_motors() > 1,
        ...selection
    }
}

// Отслеживаемая частота — freq * sqrt(throttle / ref); подбираем freq при ref, равном среднему газу
function auto_fit_throttle(gyro, tracking, range, multi_source) {
    const throttle = tracking[1]
    if (!throttle.have_data({ options: multi_source ? 2 : 0 })) {
        return { error: multi_source ? "нет газа по моторам" : "нет газа" }
    }

    // Корень из газа для каждого окна, для газа по моторам — среднее по моторам
    const config = { options: multi_source ? 2 : 0, ref: 1, freq: 1, min_ratio: 0 }
    const root_throttle = (instance, index) => {
        const value = throttle.get_interpolated_target_freq(instance, index, config)
        if ((value == null) || (value.length == 0)) {
            return null
        }
        return value.reduce((sum, v) => sum + v, 0) / value.length
    }

    // Опорный газ — средний газ по использованным окнам
    let sum = 0
    let count = 0
    for (let i = 0; i < gyro.length; i++) {
        if ((gyro[i] == null) || gyro[i].post_filter || (gyro[i].FFT == null)) {
            continue
        }
        const time = gyro[i].FFT.time
        for (let j = find_start_index(time, range); j < find_end_index(time, range) + 1; j++) {
            const value = root_throttle(i, j)
            if (value > 0) {
                sum += value**2
                count++
            }
        }
    }
    if (count == 0) {
        return { error: "газ равен нулю в интервале анализа" }
    }
    const ref = sum / count

    // Спектр по частоте при опорном газе
    const get_tracked = (instance, index) => {
        const value = root_throttle(instance, index)
        return (value > 0) ? value / Math.sqrt(ref) : null
    }
    let max_freq = Infinity
    for (const batch of gyro) {
        if ((batch != null) && !batch.post_filter && (batch.FFT != null)) {
            max_freq = Math.min(max_freq, batch.FFT.bins[batch.FFT.bins.length - 1])
        }
    }
    const step = 0.25
    const spectrum = auto_fit_order_spectrum(gyro, range, get_tracked, { min: auto_fit_rules.min_freq, max: max_freq, step })

    // Основная частота — сильнейший пик или наименьшая его целая доля, где тоже есть пик
    const strongest = auto_fit_strongest_peak(spectrum, null)
    if (strongest == null) {
        return { error: "пики шума не следуют газу" }
    }
    let fundamental = strongest.position
    for (let harmonic = 4; harmonic >= 2; harmonic--) {
        const position = strongest.position / harmonic
        if ((position >= auto_fit_rules.min_freq * 2) && (auto_fit_peak_excess(spectrum, position, position) >= auto_fit_rules.min_peak_dB)) {
            fundamental = position
            break
        }
    }
    const selection = auto_fit_select(auto_fit_harmonic_peaks(spectrum, fundamental))
    if (selection == null) {
        return { error: "пики шума не следуют газу" }
    }

    // Снижаем предел частоты, чтобы notch продолжал следить и ниже опорного газа
    const low = auto_fit_percentile(spectrum.tracked, auto_fit_rules.low_percentile) * fundamental
    const min_ratio = Math.min(1, Math.max(0.1, Math.floor(20 * low * auto_fit_rules.min_freq_ratio / fundamental) / 20))

    return {
        name: multi_source ? "газ по моторам" : "газ",
        mode: 1,
        freq: Math.round(fundamental),
        ref: Math.round(ref * 100) / 100,
        min_ratio,
        multi_source,
        ...selection
    }
}

// Подбор первого notch: источники по порядку предпочтения. esc_mask — значение INS_HNTCH_ESCMSK (0 — все моторы).
// Вызывающий заранее считает FFT до фильтров (gyro_fft) и интерполирует трекинг (interpolate_tracking).
// Возвращает { result, errors }: result — первый удавшийся подбор или null, errors — причины отказа предыдущих источников
function auto_fit(gyro, tracking, range, esc_mask) {
    if ((gyro == null) || !gyro.have_pre) {
        return { result: null, errors: ["Для автоподбора нужны данные гироскопа до фильтров"] }
    }

    esc_mask = esc_mask || 0

    // Пробуем источники по порядку предпочтения
    let result
    let errors = []
    for (const fit of [() => auto_fit_esc(gyro, tracking, range, esc_mask), () => auto_fit_throttle(gyro, tracking, range, true), () => auto_fit_throttle(gyro, tracking, range, false)]) {
        result = fit()
        if (result.error == null) {
            break
        }
        errors.push(result.error)
        result = null
    }
    return { result, errors }
}

// Значения INS_HNTCH_* по результату auto_fit (хвост auto_fit() в PR). current_values — текущие значения
// параметров (объект имя → число), из них берётся INS_HNTCH_OPTS; INS_HNTCH_ESCMSK не трогаем
function auto_fit_values(result, current_values) {
    const names = notch_param_names()[0]

    // По одному notch на гармонику, multi source — по необходимости
    let options = current_values[names.options] & ~(1 | 16 | 64)
    if (result.multi_source) {
        options |= 2
    } else {
        options &= ~2
    }

    const values = {}
    values[names.enable] = 1
    values[names.mode] = result.mode
    values[names.freq] = result.freq
    values[names.bandwidth] = Math.round(result.freq * auto_fit_rules.bandwidth_ratio)
    values[names.attenuation] = result.attenuation
    values[names.ref] = result.ref
    values[names.min_ratio] = result.min_ratio
    values[names.harmonics] = result.harmonics
    values[names.options] = options
    return values
}
