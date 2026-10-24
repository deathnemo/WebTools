// Метрики спектра для шагов мастера: пики среднего спектра и их происхождение (моторы или рама). Без DOM:
// работает в браузере и под Node (тесты). Это не перенос из FilterReview — своё, поэтому у каждого порога источник.
//
// Способов атрибуции два. Основной при ESC-телеметрии — порядковый спектр автоподбора PR #363
// (motor_order_info + attribute_peaks_order, method "order"): спектр каждого окна нормирован на частоту моторов
// в этот момент. Запасной без ESC — медианная моторная частота, уточнённая по пику первой гармоники
// (motor_fundamental + refine_fundamental + attribute_peaks, method "median").
//
// Нужны глобалы страницы: классы core/tracking/* (источники трекинга приходят аргументом tracking из create_tracking)
// и core/autofit.js (auto_fit_rules, auto_fit_order_spectrum, auto_fit_harmonic_peaks, auto_fit_percentile) —
// он подключается после этого файла, но вызывается только во время работы, когда все скрипты уже загружены.

// Пики спектра и их происхождение. Пороги в одном блоке; источники: [PR363] — метод автоподбора, [наше].
const peak_rules = {
    min_excess_dB: 6,          // пик заметен, если выше локального шума на столько дБ [PR363]
    floor_half_width_hz: 50,   // полуширина окна для медианы шума вокруг пика: шире горбов гармоник (±15–20 Гц
                               // при газе, меняющемся в полёте), иначе горб сам задаёт «шум» [наше]
    peak_half_width_hz: 2,     // исключаемая из шума окрестность пика, не уже главного лепестка окна Ханна
                               // (±2 бина, см. peak_exclusion_hz) [наше]
    axis_merge_hz: 2,          // пики разных осей ближе max(этого, 2 бина) — один пик [наше]
    harmonic_tolerance: 0.1,   // пик «моторный», если freq/f_мотора отличается от целого N не больше чем на 0.1
                               // порядка (допуск относительно основной частоты, а не N·f) [наше]
    max_harmonic: 8,           // старшая гармоника для атрибуции [PR363]
    min_freq_hz: 5,            // ниже — не ищем (дрейф, DC) [наше]
}

// Медиана массива чисел (при чётном числе — среднее двух средних); null для пустого
function median_of(values) {
    if (values.length == 0) {
        return null
    }
    const sorted = Float64Array.from(values).sort()
    const mid = Math.floor(sorted.length / 2)
    return (sorted.length % 2 == 1) ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// Шаг бинов (бины равномерные); 0, если бинов меньше двух
function bin_spacing(bins) {
    return (bins.length > 1) ? (bins[bins.length - 1] - bins[0]) / (bins.length - 1) : 0
}

// Окрестность пика, исключаемая из шума: не уже peak_half_width_hz и главного лепестка окна Ханна (±2 бина)
function peak_exclusion_hz(bins, rules = peak_rules) {
    return Math.max(rules.peak_half_width_hz, 2 * bin_spacing(bins))
}

// Превышение бина i над локальным шумом, дБ: amp_dB[i] минус медиана окна ±floor_half_width_hz без окрестности
// peak_exclusion_hz вокруг бина. Нечисловые значения в шум не входят; null, если значение бина нечисловое
// или шума не набралось. Общая часть find_peaks и оценки остаточного пика после фильтров (core/candidates.js)
function local_excess_dB(bins, amp_dB, i, rules = peak_rules) {
    const len = Math.min(bins.length, amp_dB.length)
    const freq = bins[i]
    const amp = amp_dB[i]
    if (!Number.isFinite(amp)) {
        return null
    }
    const exclusion = peak_exclusion_hz(bins, rules)

    // Локальный шум: медиана окна вокруг пика без его ближней окрестности
    const floor = []
    for (let j = i - 1; (j >= 0) && (freq - bins[j] <= rules.floor_half_width_hz); j--) {
        if ((freq - bins[j] > exclusion) && Number.isFinite(amp_dB[j])) {
            floor.push(amp_dB[j])
        }
    }
    for (let j = i + 1; (j < len) && (bins[j] - freq <= rules.floor_half_width_hz); j++) {
        if ((bins[j] - freq > exclusion) && Number.isFinite(amp_dB[j])) {
            floor.push(amp_dB[j])
        }
    }
    const noise = median_of(floor)
    return (noise == null) ? null : amp - noise
}

// bins (Гц), amp_dB — средний спектр одной оси в дБ. Возвращает [{ freq, amp_dB, excess_dB }] по убыванию excess.
// Пик — локальный максимум (строго больше соседей) не ниже min_freq_hz, выше медианы шума в окне
// ±floor_half_width_hz (без окрестности peak_exclusion_hz вокруг пика) не меньше чем на min_excess_dB.
// Нечисловые значения (−Infinity у нулевой амплитуды) пиками не бывают и в шум не входят
function find_peaks(bins, amp_dB, rules = peak_rules) {
    const peaks = []
    const len = Math.min(bins.length, amp_dB.length)
    for (let i = 1; i < len - 1; i++) {
        const freq = bins[i]
        const amp = amp_dB[i]
        if ((freq < rules.min_freq_hz) || !Number.isFinite(amp)) {
            continue
        }
        // Строго больше обоих соседей: плато из равных значений пиком не считается
        if (!((amp > amp_dB[i - 1]) && (amp > amp_dB[i + 1]))) {
            continue
        }

        const excess = local_excess_dB(bins, amp_dB, i, rules)
        if ((excess != null) && (excess >= rules.min_excess_dB)) {
            peaks.push({ freq: freq, amp_dB: amp, excess_dB: excess })
        }
    }
    peaks.sort((a, b) => b.excess_dB - a.excess_dB)
    return peaks
}

// Пики по нескольким осям: axes_dB = { X: amp_dB, Y: …, Z: … } на общей сетке bins. Пики ищутся на каждой оси
// отдельно (find_peaks), затем пики ближе max(axis_merge_hz, 2 бина) сливаются: остаётся пик с наибольшим
// превышением, в axes — все оси, где он найден (в порядке ключей axes_dB). Возвращает
// [{ freq, amp_dB, excess_dB, axes }] по убыванию excess
function find_axis_peaks(bins, axes_dB, rules = peak_rules) {
    const names = Object.keys(axes_dB)
    const all = []
    for (const name of names) {
        for (const peak of find_peaks(bins, axes_dB[name], rules)) {
            all.push({ ...peak, axis: name })
        }
    }
    all.sort((a, b) => b.excess_dB - a.excess_dB)

    const merge_hz = Math.max(rules.axis_merge_hz, 2 * bin_spacing(bins))
    const merged = []
    for (const peak of all) {
        const near = merged.find((m) => Math.abs(m.freq - peak.freq) <= merge_hz)
        if (near != null) {
            if (!near.axes.includes(peak.axis)) {
                near.axes.push(peak.axis)
            }
            continue
        }
        merged.push({ freq: peak.freq, amp_dB: peak.amp_dB, excess_dB: peak.excess_dB, axes: [peak.axis] })
    }
    for (const peak of merged) {
        peak.axes.sort((a, b) => names.indexOf(a) - names.indexOf(b))
    }
    return merged
}

// Номер гармоники пика относительно основной частоты: ближайшее целое N к freq / fundamental_hz, если
// |freq / fundamental_hz − N| ≤ harmonic_tolerance и 1 ≤ N ≤ max_harmonic, иначе null
function harmonic_number(freq, fundamental_hz, rules = peak_rules) {
    if ((fundamental_hz == null) || !(fundamental_hz > 0)) {
        return null
    }
    const order = freq / fundamental_hz
    const harmonic = Math.round(order)
    if ((harmonic >= 1) && (harmonic <= rules.max_harmonic) && (Math.abs(order - harmonic) <= rules.harmonic_tolerance)) {
        return harmonic
    }
    return null
}

// fundamental_hz — моторная частота или null. Добавляет source: "motor"|"frame", harmonic: N|null
// (harmonic_number) и method: "median" — запасной метод без ESC (основной — attribute_peaks_order).
// Возвращает новый массив, исходные объекты не меняются
function attribute_peaks(peaks, fundamental_hz, rules = peak_rules) {
    return peaks.map((peak) => {
        const harmonic = harmonic_number(peak.freq, fundamental_hz, rules)
        return { ...peak, source: (harmonic != null) ? "motor" : "frame", harmonic: harmonic, method: "median" }
    })
}

// Порядковый спектр по ESC-телеметрии для атрибуции пиков — то же, что строит auto_fit_esc (core/autofit.js):
// средняя частота моторов из маски esc_mask, окна с частотой ниже auto_fit_rules.min_freq пропускаются, сетка
// 0.25…max_harmonic + 0.75 порядка шагом 0.005. Возвращает { spectrum, order_peaks, p5, p50, p95 }: spectrum —
// результат auto_fit_order_spectrum, order_peaks — превышение пика на каждой гармонике (auto_fit_harmonic_peaks
// при основной 1), p5/p50/p95 — процентили отслеживаемой частоты по окнам, Гц (auto_fit_percentile, как нижняя
// частота в auto_fit_esc). null, если ESC-телеметрии нет или нет окон с работающими моторами [PR363]
function motor_order_info(gyro, tracking, range, esc_mask) {
    const esc = tracking.find((t) => t.name === "ESC")
    if ((esc == null) || !esc.have_data()) {
        return null
    }

    // Средняя частота моторов из маски — как get_tracked в auto_fit_esc
    const config = { options: 0, ref: 1, freq: 0, esc_mask: esc_mask || 0 }
    const get_tracked = (instance, index) => {
        const freq = esc.get_interpolated_target_freq(instance, index, config)
        if ((freq == null) || (freq[0] < auto_fit_rules.min_freq)) {
            return null
        }
        return freq[0]
    }
    const spectrum = auto_fit_order_spectrum(gyro, range, get_tracked, { min: 0.25, max: auto_fit_rules.max_harmonic + 0.75, step: 0.005 })
    if (spectrum.tracked.length == 0) {
        return null
    }

    return {
        spectrum: spectrum,
        order_peaks: auto_fit_harmonic_peaks(spectrum, 1),
        p5: auto_fit_percentile(spectrum.tracked, 0.05),
        p50: auto_fit_percentile(spectrum.tracked, 0.5),
        p95: auto_fit_percentile(spectrum.tracked, 0.95),
    }
}

// Атрибуция по порядковому спектру (info из motor_order_info): пик на частоте F — «моторы, гармоника N», если
// у гармоники N в порядковом спектре превышение не меньше min_excess_dB и F лежит в [N·p5, N·p95] частоты ESC
// за интервал; иначе «рама/резонанс». Шум, который следует за оборотами, в порядковом спектре собирается в пик
// на N, а фиксированный резонанс размазывается — поэтому превышение отличает одно от другого [PR363], а диапазон
// частот привязывает пик к гармонике. Если подходят несколько N (широкий разброс оборотов), берётся та, у которой
// F/N ближе к медиане частоты ESC в логарифмическом смысле [наше]. Добавляет source, harmonic и method: "order";
// возвращает новый массив, исходные объекты не меняются
function attribute_peaks_order(peaks, info, rules = peak_rules) {
    return peaks.map((peak) => {
        let harmonic = null
        let best_distance = Infinity
        for (const order_peak of info.order_peaks) {
            const N = order_peak.harmonic
            if ((N > rules.max_harmonic) || !(order_peak.excess >= rules.min_excess_dB)) {
                continue
            }
            if ((peak.freq < N * info.p5) || (peak.freq > N * info.p95)) {
                continue
            }
            const distance = Math.abs(Math.log(peak.freq / N / info.p50))
            if (distance < best_distance) {
                best_distance = distance
                harmonic = N
            }
        }
        return { ...peak, source: (harmonic != null) ? "motor" : "frame", harmonic: harmonic, method: "order" }
    })
}

// Уточнить моторную частоту по спектру: медиана ESC или цели газа отличается от положения пика первой гармоники
// в среднем спектре (амплитуда вибрации растёт с оборотами, и среднее по окнам смещает пик к высоким оборотам),
// а допуск атрибуции 0.1 порядка у второй и старших гармоник это смещение уже не покрывает. Если среди пиков есть
// первая гармоника (harmonic_number == 1), основной частотой берётся она — самая выраженная из таких; иначе
// fundamental_hz без изменений [наше]
function refine_fundamental(peaks, fundamental_hz, rules = peak_rules) {
    let best = null
    for (const peak of peaks) {
        if ((harmonic_number(peak.freq, fundamental_hz, rules) === 1) && ((best == null) || (peak.excess_dB > best.excess_dB))) {
            best = peak
        }
    }
    return (best != null) ? best.freq : fundamental_hz
}

// Медиана положительных значений ряда freq, чьё время time попадает в range = [t0, t1]; null, если таких нет.
// Нули (моторы стоят, газ 0 на земле) медиану не тянут [наше]
function median_in_range(time, freq, range) {
    const selected = []
    for (let j = 0; j < Math.min(time.length, freq.length); j++) {
        if ((time[j] >= range[0]) && (time[j] <= range[1]) && (freq[j] > 0)) {
            selected.push(freq[j])
        }
    }
    return median_of(selected)
}

// Моторная частота: медиана среднего ESC (compute_avg(0).avg_freq) в диапазоне, иначе медиана цели газа
// (tracking[1].get_target_freq(config) с config из values), иначе null.
// tracking — источники из create_tracking (ищутся по имени: "ESC", "Throttle"); values — объект имя → число
// с параметрами INS_HNTCH_*. Цель газа осмысленна только при INS_HNTCH_FREQ > 0 и INS_HNTCH_REF > 0: при REF = 0
// она постоянна и равна FREQ, то есть о моторах ничего не говорит [наше]. range = [t0, t1], секунды
function motor_fundamental(tracking, values, range) {
    const esc = tracking.find((t) => t.name === "ESC")
    if ((esc != null) && esc.have_data()) {
        const avg = esc.compute_avg(0)
        const freq = median_in_range(avg.avg_time, avg.avg_freq, range)
        if (freq != null) {
            return freq
        }
    }

    const throttle = tracking.find((t) => t.name === "Throttle")
    const config = {
        freq: values["INS_HNTCH_FREQ"] ?? 0,
        ref: values["INS_HNTCH_REF"] ?? 0,
        min_ratio: values["INS_HNTCH_FM_RAT"] ?? 0,
        // Средний газ, а не по отдельным моторам
        options: 0,
        esc_mask: 0,
    }
    if ((throttle != null) && (config.freq > 0) && (config.ref > 0) && throttle.have_data(config)) {
        const target = throttle.get_target_freq(config)
        if ((target != null) && (target.time != null)) {
            return median_in_range(target.time, target.freq, range)
        }
    }

    return null
}
