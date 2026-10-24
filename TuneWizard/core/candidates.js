// Сравнение вариантов параметров гармонических notch: какие варианты считать, как оценить шум после фильтров
// и задержку, какой рекомендовать. Без DOM: работает в браузере и под Node (тесты). Это не перенос из
// FilterReview — своё, поэтому у каждого порога источник.
//
// Зачем: на логе пользователя чистое предложение автоподбора PR #363 хуже того, что летали — оно оставляет
// только гармоники, чётко следующие за оборотами, и убирает третью, которая попутно гасила резонанс ≈ 153 Гц
// и шум ≈ 235 Гц. Поэтому шаг 2 считает несколько вариантов (как в логе, автоподбор, их сочетания, при
// необходимости второй статический notch), оценивает каждый по ожидаемому шуму после фильтров на главных пиках
// шага 1 и в полосе 20–400 Гц и по задержке на 10/30 Гц и рекомендует лучший по полосе среди тех, что не хуже
// лога (docs/plans/2026-10-24-tune-wizard-stage2-design.md, раздел 6).
//
// Оценка варианта не меняет состояние gyro: передаточная функция считается своя (filter_transfer на FFT.Z1/Z2)
// и передаётся в estimate_post; FFT.H и FFT.bode.H остаются от последнего calculate_transfer_function.
//
// Нужны глобалы страницы: Libraries/Array_Math.js, core/gyro.js (find_start_index, find_end_index),
// core/filters.js (load_filters, filter_transfer, estimate_post, get_phase, notch_param_names),
// core/spectrum.js (spectrum_amplitude_scale, alias_obj, mean_spectrum), core/metrics.js (local_excess_dB)
// и core/autofit.js (auto_fit_values).

// Пороги сравнения вариантов notch; источники: [наше] — эвристика мастера, [PR363] — правила автоподбора
const candidate_rules = {
    band_hz: [20, 400],               // главная полоса для оценки шума после фильтров [наше]
    extra_bands_hz: [[60, 200], [200, 500]],   // для справки в таблице [наше]
    main_peaks: 5,                    // сколько главных пиков шага 1 учитывать [наше]
    max_peak_worsening_dB: 3,         // вариант не может ухудшить главный пик сильнее, чем на столько [наше]
    max_lag_increase_ms: 0.5,         // и увеличить задержку на 30 Гц сильнее, чем на столько [наше]
    lag_freqs_hz: [10, 30],           // частоты фазовой задержки [наше]
    second_notch: { min_excess_dB: 6, attenuation: 30, bandwidth_ratio: 0.5 },   // [PR363] порог и BW, ослабление [наше]
}

// Набор значений параметров одной строкой для сравнения вариантов: имена по алфавиту
function candidate_key(values) {
    return JSON.stringify(Object.keys(values).sort().map((name) => [name, values[name]]))
}

// Варианты параметров: «как в логе»; автоподбор (fit = auto_fit(...) → { result, errors }, значения
// auto_fit_values поверх лога); автоподбор с гармониками из лога (объединение масок HMNCS); лог с ослаблением
// из автоподбора. Два последних — только если первый notch в логе включён: иначе «гармоники» и «ослабление» лога
// ничего не значат. Без результата автоподбора — только лог. Одинаковые наборы значений остаются один раз
// (первый по порядку). log_values — объект имя → число (INS_GYRO_FILTER, SCHED_LOOP_RATE, INS_HNTCH_*,
// INS_HNTC2_*). Возвращает [{ id, title, values }]
function notch_candidates(log_values, fit) {
    const names = notch_param_names()[0]
    const candidates = [{ id: "log", title: "Как в логе", values: { ...log_values } }]

    const result = (fit != null) ? fit.result : null
    if (result != null) {
        const fitted = { ...log_values, ...auto_fit_values(result, log_values) }
        candidates.push({ id: "fit", title: "Автоподбор (" + result.name + ")", values: fitted })

        if (log_values[names.enable] > 0) {
            const with_log_harmonics = { ...fitted }
            with_log_harmonics[names.harmonics] = fitted[names.harmonics] | (log_values[names.harmonics] ?? 0)
            candidates.push({ id: "fit_log_harmonics", title: "Автоподбор + гармоники из лога", values: with_log_harmonics })

            const with_fit_attenuation = { ...log_values }
            with_fit_attenuation[names.attenuation] = result.attenuation
            candidates.push({ id: "log_fit_attenuation", title: "Как в логе, ослабление из автоподбора", values: with_fit_attenuation })
        }
    }

    // Одинаковые наборы — один раз
    const seen = new Set()
    return candidates.filter((candidate) => {
        const key = candidate_key(candidate.values)
        if (seen.has(key)) {
            return false
        }
        seen.add(key)
        return true
    })
}

// Индекс бина, ближайшего к частоте freq
function nearest_bin(bins, freq) {
    let best = 0
    for (let k = 1; k < bins.length; k++) {
        if (Math.abs(bins[k] - freq) < Math.abs(bins[best] - freq)) {
            best = k
        }
    }
    return best
}

// Сумма мощностей значений в дБ (10·log10 Σ 10^(дБ/10)); −Infinity, если все −Infinity
function power_sum_dB(values_dB) {
    let sum = 0
    for (const value of values_dB) {
        sum += 10**(value / 10)
    }
    return 10 * Math.log10(sum)
}

// Мощность в полосе band = [lo, hi] Гц: среднее по бинам полосы суммы линейной мощности осей X/Y/Z
// (spectrum в дБ: 10^(дБ/10)), результат в дБ; null, если в полосе нет бинов [наше]
function band_power_dB(bins, spectrum, band) {
    let sum = 0
    let count = 0
    for (let k = 0; k < bins.length; k++) {
        if ((bins[k] < band[0]) || (bins[k] > band[1])) {
            continue
        }
        sum += 10**(spectrum.x[k] / 10) + 10**(spectrum.y[k] / 10) + 10**(spectrum.z[k] / 10)
        count++
    }
    return (count > 0) ? 10 * Math.log10(sum / count) : null
}

// Задержка всей цепочки фильтров экземпляра index на частотах freqs (Гц), мс: −phase_deg / 360 / f · 1000, где
// phase_deg — фаза H, средняя по окнам FFT в диапазоне range (как phase_mean в bode_mean). Возвращает массив
// по freqs; null, если у экземпляра нет окон FFT.
// H считается не на полной сетке бодэ (0…Найквист шагом 0.05 Гц), а на сетке 0…max(freqs) тем же шагом плюс сами
// частоты: мелкая сетка от нуля нужна только для развёртки фазы get_phase — без неё фаза ниже −180° (низкий
// INS_GYRO_FILTER, notch ниже 30 Гц) свернулась бы. Z1/Z2 — exp_jw этой сетки на FFT.average_sample_rate [наше]
function filters_lag_ms(filters, gyro, index, freqs, range) {
    if ((gyro[index] == null) || (gyro[index].FFT == null) || (gyro[index].FFT.x.length == 0)) {
        return null
    }
    const FFT = gyro[index].FFT

    // Шаг сетки бодэ из gyro_fft — тот же, чтобы развёртка фазы совпадала с bode_mean
    const step = 0.05
    const max_freq = Math.max(...freqs)
    const grid = []
    for (let k = 0; k * step < max_freq; k++) {
        grid.push(k * step)
    }
    grid.push(...freqs)
    grid.sort((a, b) => a - b)
    const positions = freqs.map((freq) => grid.indexOf(freq))

    const Z = exp_jw(grid, FFT.average_sample_rate)
    const H = filter_transfer(filters, index, FFT.time, FFT.average_sample_rate, complex_inverse(Z), complex_inverse(complex_square(Z)))

    // Средняя фаза по окнам диапазона
    const start_index = find_start_index(FFT.time, range)
    const end_index = find_end_index(FFT.time, range) + 1
    const sum = new Array(freqs.length).fill(0)
    for (let j = start_index; j < end_index; j++) {
        const phase = get_phase(H[j])
        for (let k = 0; k < positions.length; k++) {
            sum[k] += phase[positions[k]]
        }
    }
    const mean_length = end_index - start_index
    return freqs.map((freq, k) => -(sum[k] / mean_length) / 360 / freq * 1000)
}

// Оценка варианта values (объект имя → число) — ожидаемый шум после фильтров и задержка.
// ctx = { gyro, env, tracking, range, sensor, peaks, loop_rate }: sensor — индекс экземпляра gyro до фильтров
// (с FFT.Z1/Z2), peaks — главные пики шага 1 [{ freq, axes }] (axes — "X"/"Y"/"Z", без них — все три),
// учитываются первые main_peaks; loop_rate — SCHED_LOOP_RATE для alias_obj (режим "none", частоты настоящие,
// как у пиков шага 1). Трекинг уже интерполирован к окнам FFT (interpolate_tracking).
// Возвращает {
//   values, warnings (filters.warnings),
//   peaks: [{ freq, axes, bin (частота ближайшего бина), pre_dB, post_dB, by_axis: { X: { pre_dB, post_dB } } }] —
//          pre — средний спектр до фильтров, post — оценка после; pre_dB/post_dB пика — сумма мощностей
//          перечисленных осей,
//   band_dB — мощность в band_hz (band_power_dB), bands: [{ band, dB }] — band_hz и extra_bands_hz,
//   lag_ms: { частота: мс } по lag_freqs_hz,
//   spectrum: { bins, x, y, z } — оценка после фильтров, дБ
// }. Состояние gyro (FFT.H, FFT.bode.H) не меняется
function evaluate_candidate(values, ctx) {
    const rules = candidate_rules
    const gyro = ctx.gyro
    const index = ctx.sensor
    const FFT = gyro[index].FFT
    const filters = load_filters(values, ctx.env, ctx.tracking)

    // Своя передаточная функция на сетке FFT — FFT.H не трогаем
    const H = filter_transfer(filters, index, FFT.time, FFT.average_sample_rate, FFT.Z1, FFT.Z2)
    const amplitude_scale = spectrum_amplitude_scale("dB")
    const alias = alias_obj(FFT, { mode: "none", loop_rate: ctx.loop_rate })
    const post = estimate_post(gyro, index, amplitude_scale, ctx.range, alias, H)
    const pre = mean_spectrum(FFT, amplitude_scale, ctx.range, alias)
    const bins = alias.bins

    // Главные пики шага 1: уровни до и после на ближайшем бине по осям, где пик найден
    const peaks = ctx.peaks.slice(0, rules.main_peaks).map((peak) => {
        const axes = peak.axes ?? ["X", "Y", "Z"]
        const k = nearest_bin(bins, peak.freq)
        const by_axis = {}
        for (const axis of axes) {
            const key = axis.toLowerCase()
            by_axis[axis] = { pre_dB: pre[key][k], post_dB: post[key][k] }
        }
        return {
            freq: peak.freq,
            axes: axes,
            bin: bins[k],
            pre_dB: power_sum_dB(axes.map((axis) => by_axis[axis].pre_dB)),
            post_dB: power_sum_dB(axes.map((axis) => by_axis[axis].post_dB)),
            by_axis: by_axis,
        }
    })

    const bands = [rules.band_hz, ...rules.extra_bands_hz].map((band) => ({ band: band, dB: band_power_dB(bins, post, band) }))

    const lag = filters_lag_ms(filters, gyro, index, rules.lag_freqs_hz, ctx.range)
    const lag_ms = {}
    for (let k = 0; k < rules.lag_freqs_hz.length; k++) {
        lag_ms[rules.lag_freqs_hz[k]] = lag[k]
    }

    return {
        values: values,
        warnings: filters.warnings,
        peaks: peaks,
        band_dB: bands[0].dB,
        bands: bands,
        lag_ms: lag_ms,
        spectrum: { bins: bins, x: post.x, y: post.y, z: post.z },
    }
}

// Выбор варианта. evaluations — объект id → evaluate_candidate(...), обязательно с id "log". Вариант отмечается,
// если ухудшает главный пик относительно лога больше чем на max_peak_worsening_dB (worse_peaks — частоты таких
// пиков) или увеличивает задержку на старшей из lag_freqs_hz (30 Гц) больше чем на max_lag_increase_ms (lag_over).
// Лучший — с наименьшей мощностью в главной полосе среди неотмеченных; лог неотмечен всегда, поэтому если
// подходит только он — рекомендуется лог. При равной мощности остаётся раньше перечисленный (лог первым).
// Возвращает { best_id, flags: { id: { worse_peaks: [freq…], lag_over } } } [наше]
function rank_candidates(evaluations, rules = candidate_rules) {
    const log = evaluations.log
    const lag_hz = rules.lag_freqs_hz[rules.lag_freqs_hz.length - 1]

    const flags = {}
    for (const [id, evaluation] of Object.entries(evaluations)) {
        const worse_peaks = []
        let lag_over = false
        if ((log != null) && (id !== "log")) {
            for (const peak of evaluation.peaks) {
                const log_peak = log.peaks.find((p) => p.freq === peak.freq)
                if ((log_peak != null) && (peak.post_dB - log_peak.post_dB > rules.max_peak_worsening_dB)) {
                    worse_peaks.push(peak.freq)
                }
            }
            lag_over = evaluation.lag_ms[lag_hz] > log.lag_ms[lag_hz] + rules.max_lag_increase_ms
        }
        flags[id] = { worse_peaks: worse_peaks, lag_over: lag_over }
    }

    let best_id = (log != null) ? "log" : null
    for (const [id, evaluation] of Object.entries(evaluations)) {
        if ((flags[id].worse_peaks.length > 0) || flags[id].lag_over) {
            continue
        }
        if ((best_id == null) || (evaluation.band_dB < evaluations[best_id].band_dB)) {
            best_id = id
        }
    }

    return { best_id: best_id, flags: flags }
}

// Второй notch: если в оценке «после» лучшего варианта остаётся немоторный пик шага 1 — превышение над локальным
// шумом (local_excess_dB, на ближайшем бине по осям пика, наибольшее) не меньше second_notch.min_excess_dB, —
// вариант с добавленным статическим INS_HNTC2: MODE 0, FREQ = F (округлённая частота пика), BW = F·bandwidth_ratio,
// ATT second_notch.attenuation, HMNCS 1, REF 0 (статический), FM_RAT 1, OPTS 0, ESCMSK 0. Пики берутся из главной
// полосы band_hz (notch ниже неё съест задержку, выше — бесполезен); из нескольких — с наибольшим превышением.
// best — вариант { id, title, values }, best_eval — его evaluate_candidate, attribution — пики шага 1 с source
// (attribute_peaks_order или attribute_peaks). null, если такого пика нет или второй notch у best уже включён.
// Возвращает { id: "second", title, values, base: best.id, peak: { freq, excess_dB } }
function second_notch_candidate(best, best_eval, attribution, rules = candidate_rules) {
    const names = notch_param_names()[1]
    if (best.values[names.enable] > 0) {
        return null
    }

    const spectrum = best_eval.spectrum
    let found = null
    for (const peak of attribution) {
        if ((peak.source !== "frame") || (peak.freq < rules.band_hz[0]) || (peak.freq > rules.band_hz[1])) {
            continue
        }
        const k = nearest_bin(spectrum.bins, peak.freq)
        let excess = null
        for (const axis of peak.axes ?? ["X", "Y", "Z"]) {
            const value = local_excess_dB(spectrum.bins, spectrum[axis.toLowerCase()], k)
            if ((value != null) && ((excess == null) || (value > excess))) {
                excess = value
            }
        }
        if ((excess == null) || (excess < rules.second_notch.min_excess_dB)) {
            continue
        }
        if ((found == null) || (excess > found.excess_dB)) {
            found = { freq: peak.freq, excess_dB: excess }
        }
    }
    if (found == null) {
        return null
    }

    const freq = Math.round(found.freq)
    const values = { ...best.values }
    values[names.enable] = 1
    values[names.mode] = 0
    values[names.freq] = freq
    values[names.bandwidth] = Math.round(freq * rules.second_notch.bandwidth_ratio)
    values[names.attenuation] = rules.second_notch.attenuation
    values[names.ref] = 0
    values[names.min_ratio] = 1
    values[names.harmonics] = 1
    values[names.options] = 0
    values[names.esc_mask] = 0
    return { id: "second", title: best.title + " + второй notch на " + freq + " Гц", values: values, base: best.id, peak: found }
}
