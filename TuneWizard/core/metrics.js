// Метрики спектра для шагов мастера: пики среднего спектра и их происхождение (моторы или рама). Без DOM:
// работает в браузере и под Node (тесты). Это не перенос из FilterReview — своё, поэтому у каждого порога источник.
//
// Нужны глобалы страницы: классы core/tracking/* (источники трекинга приходят аргументом tracking из create_tracking).

// Пики спектра и их происхождение. Пороги в одном блоке; источники: [PR363] — метод автоподбора, [наше].
const peak_rules = {
    min_excess_dB: 6,          // пик заметен, если выше локального шума на столько дБ [PR363]
    floor_half_width_hz: 15,   // полуширина окна для медианы шума вокруг пика [наше]
    peak_half_width_hz: 2,     // исключаемая из шума окрестность пика [наше]
    harmonic_tolerance: 0.1,   // пик «моторный», если в пределах ±10 % от N·f_мотора [наше]
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

// bins (Гц), amp_dB — средний спектр в дБ. Возвращает [{ freq, amp_dB, excess_dB }] по убыванию excess.
// Пик — локальный максимум (строго больше соседей), выше медианы шума в окне ±floor_half_width_hz
// (без ±peak_half_width_hz вокруг пика) не меньше чем на min_excess_dB.
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

        // Локальный шум: медиана окна вокруг пика без его ближней окрестности
        const floor = []
        for (let j = i - 1; (j >= 0) && (freq - bins[j] <= rules.floor_half_width_hz); j--) {
            if ((freq - bins[j] > rules.peak_half_width_hz) && Number.isFinite(amp_dB[j])) {
                floor.push(amp_dB[j])
            }
        }
        for (let j = i + 1; (j < len) && (bins[j] - freq <= rules.floor_half_width_hz); j++) {
            if ((bins[j] - freq > rules.peak_half_width_hz) && Number.isFinite(amp_dB[j])) {
                floor.push(amp_dB[j])
            }
        }
        const noise = median_of(floor)
        if (noise == null) {
            continue
        }

        const excess = amp - noise
        if (excess >= rules.min_excess_dB) {
            peaks.push({ freq: freq, amp_dB: amp, excess_dB: excess })
        }
    }
    peaks.sort((a, b) => b.excess_dB - a.excess_dB)
    return peaks
}

// fundamental_hz — медианная моторная частота или null. Добавляет source: "motor"|"frame", harmonic: N|null.
// Номер гармоники — ближайшее целое к freq / fundamental_hz; пик моторный, если он в пределах harmonic_tolerance
// от N·fundamental_hz и 1 ≤ N ≤ max_harmonic. Возвращает новый массив, исходные объекты не меняются
function attribute_peaks(peaks, fundamental_hz, rules = peak_rules) {
    return peaks.map((peak) => {
        if ((fundamental_hz != null) && (fundamental_hz > 0)) {
            const harmonic = Math.round(peak.freq / fundamental_hz)
            const target = harmonic * fundamental_hz
            if ((harmonic >= 1) && (harmonic <= rules.max_harmonic) && (Math.abs(peak.freq - target) <= rules.harmonic_tolerance * target)) {
                return { ...peak, source: "motor", harmonic: harmonic }
            }
        }
        return { ...peak, source: "frame", harmonic: null }
    })
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
