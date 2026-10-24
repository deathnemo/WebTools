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
// core/spectrum.js (spectrum_amplitude_scale, alias_obj, mean_spectrum), core/metrics.js (local_excess_dB,
// find_axis_peaks, peak_exclusion_hz, bin_spacing, peak_rules) и core/autofit.js (auto_fit_values).

// Пороги сравнения вариантов notch; источники: [наше] — эвристика мастера, [PR363] — правила автоподбора
const candidate_rules = {
    band_hz: [20, 400],               // главная полоса для оценки шума после фильтров [наше]
    extra_bands_hz: [[60, 200], [200, 500]],   // для справки в таблице [наше]
    main_peaks: 5,                    // сколько главных пиков шага 1 учитывать [наше]
    post_peaks: 3,                    // и сколько пиков оценки «после» для варианта «как в логе» [наше]
    max_peak_worsening_dB: 3,         // вариант не может ухудшить главный пик сильнее, чем на столько [наше]
    max_lag_increase_ms: 0.5,         // и увеличить задержку на 30 Гц сильнее, чем на столько [наше]
    lag_freqs_hz: [10, 30],           // частоты фазовой задержки [наше]
    f2_ref_hz: 100,                   // опорная частота веса (f / f_ref)² в band_f2_dB, справочно [наше]
    // Второй notch: порог превышения [PR363], ослабление [наше]; BW — удвоенная ширина пика по −3 дБ в пределах
    // 10 Гц…0.5·F (решение пользователя 24.10.2026) [наше]
    second_notch: { min_excess_dB: 6, attenuation: 30, width_db: 3, width_factor: 2, min_bw_hz: 10, max_bw_ratio: 0.5 },
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
// (spectrum в дБ: 10^(дБ/10)), результат в дБ; null, если в полосе нет бинов [наше].
// f2_ref_hz — вес бина (f / f_ref)²: шум после D-члена регулятора растёт примерно как f², и такая мощность
// показывает, сколько высокочастотного шума дойдёт до моторов (справочно, в выборе не участвует) [наше]
function band_power_dB(bins, spectrum, band, f2_ref_hz = null) {
    let sum = 0
    let count = 0
    for (let k = 0; k < bins.length; k++) {
        if ((bins[k] < band[0]) || (bins[k] > band[1])) {
            continue
        }
        const weight = (f2_ref_hz != null) ? (bins[k] / f2_ref_hz)**2 : 1
        sum += weight * (10**(spectrum.x[k] / 10) + 10**(spectrum.y[k] / 10) + 10**(spectrum.z[k] / 10))
        count++
    }
    return (count > 0) ? 10 * Math.log10(sum / count) : null
}

// Уровни пика peak = { freq, axes } на ближайшем бине: до фильтров (pre, может быть null) и после (post), по осям
// пика (axes — "X"/"Y"/"Z", без них — все три) и суммой мощностей этих осей. source — "main" (пик шага 1)
// или "post" (пик оценки «после» для варианта «как в логе», добавляет rank_candidates)
function peak_levels(peak, bins, pre, post, source) {
    const axes = peak.axes ?? ["X", "Y", "Z"]
    const k = nearest_bin(bins, peak.freq)
    const by_axis = {}
    for (const axis of axes) {
        const key = axis.toLowerCase()
        by_axis[axis] = { pre_dB: (pre != null) ? pre[key][k] : null, post_dB: post[key][k] }
    }
    return {
        freq: peak.freq,
        axes: axes,
        bin: bins[k],
        pre_dB: (pre != null) ? power_sum_dB(axes.map((axis) => by_axis[axis].pre_dB)) : null,
        post_dB: power_sum_dB(axes.map((axis) => by_axis[axis].post_dB)),
        by_axis: by_axis,
        source: source,
    }
}

// Задержка всей цепочки фильтров экземпляра index на частотах freqs (Гц), мс: −phase_deg / 360 / f · 1000, где
// phase_deg — фаза H, средняя по окнам FFT в диапазоне range (как phase_mean в bode_mean). Возвращает массив
// по freqs; null, если у экземпляра нет окон FFT.
// H считается не на полной сетке бодэ (0…Найквист шагом 0.05 Гц), а на плотной сетке 0…max(freqs) тем же шагом
// плюс сами частоты: сетка от нуля нужна только для развёртки фазы get_phase — по одним частотам freqs развёртка
// ломается (у biquad 40 Гц шаг фазы от 10 к 30 Гц больше 45°, и вышло бы +293° вместо −67°). Z1/Z2 — exp_jw этой
// сетки на FFT.average_sample_rate; окна после конца диапазона не считаются [наше]
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

    const start_index = find_start_index(FFT.time, range)
    const end_index = find_end_index(FFT.time, range) + 1
    const Z = exp_jw(grid, FFT.average_sample_rate)
    const H = filter_transfer(filters, index, FFT.time.slice(0, end_index), FFT.average_sample_rate, complex_inverse(Z), complex_inverse(complex_square(Z)))

    // Средняя фаза по окнам диапазона
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

// Средний спектр до фильтров (дБ) — один на ctx: все варианты оцениваются на одних и тех же данных «до».
// Кэш проверяет, что FFT и диапазон те же
const pre_spectrum_cache = new WeakMap()
function ctx_pre_spectrum(ctx, FFT, alias) {
    const cached = pre_spectrum_cache.get(ctx)
    if ((cached != null) && (cached.FFT === FFT) && (cached.start === ctx.range[0]) && (cached.end === ctx.range[1])) {
        return cached.pre
    }
    const pre = mean_spectrum(FFT, spectrum_amplitude_scale("dB"), ctx.range, alias)
    pre_spectrum_cache.set(ctx, { FFT: FFT, start: ctx.range[0], end: ctx.range[1], pre: pre })
    return pre
}

// Оценка варианта values (объект имя → число) — ожидаемый шум после фильтров и задержка.
// ctx = { gyro, env, tracking, range, sensor, peaks, loop_rate }: sensor — индекс экземпляра в массиве gyro
// (результат find_instance(gyro, номер_сенсора, false)), а не номер сенсора; у экземпляра должны быть FFT и
// FFT.Z1/Z2, то есть данные до фильтров. peaks — главные пики шага 1 [{ freq, axes }] (axes — "X"/"Y"/"Z", без них —
// все три), учитываются первые main_peaks; loop_rate — SCHED_LOOP_RATE для alias_obj (режим "none", частоты
// настоящие, как у пиков шага 1). Трекинг уже интерполирован к окнам FFT (interpolate_tracking).
// Возвращает null, если у экземпляра нет FFT или Z1 (только «после»), иначе {
//   values, warnings (filters.warnings),
//   peaks: [{ freq, axes, bin (частота ближайшего бина), pre_dB, post_dB, by_axis: { X: { pre_dB, post_dB } },
//           source: "main" }] — pre — средний спектр до фильтров, post — оценка после; pre_dB/post_dB пика — сумма
//          мощностей перечисленных осей; rank_candidates дописывает сюда пики source: "post",
//   band_dB — мощность в band_hz (band_power_dB), bands: [{ band, dB }] — band_hz и extra_bands_hz,
//   band_f2_dB — мощность в band_hz с весом (f / f2_ref_hz)², справочно,
//   lag_ms: { частота: мс } по lag_freqs_hz,
//   spectrum: { bins, x, y, z } — оценка после фильтров, дБ; pre_spectrum: { bins, x, y, z } — до фильтров, дБ
// }. Состояние gyro (FFT.H, FFT.bode.H) не меняется
function evaluate_candidate(values, ctx) {
    const rules = candidate_rules
    const gyro = ctx.gyro
    const index = ctx.sensor
    if ((gyro[index] == null) || (gyro[index].FFT == null) || (gyro[index].FFT.x.length == 0) || (gyro[index].FFT.Z1 == null)) {
        return null
    }
    const FFT = gyro[index].FFT
    const filters = load_filters(values, ctx.env, ctx.tracking)

    // Своя передаточная функция на сетке FFT — FFT.H не трогаем. estimate_post берёт окна до конца диапазона,
    // поэтому и H нужна только до него
    const end_index = find_end_index(FFT.time, ctx.range) + 1
    const H = filter_transfer(filters, index, FFT.time.slice(0, end_index), FFT.average_sample_rate, FFT.Z1, FFT.Z2)
    const amplitude_scale = spectrum_amplitude_scale("dB")
    const alias = alias_obj(FFT, { mode: "none", loop_rate: ctx.loop_rate })
    const post = estimate_post(gyro, index, amplitude_scale, ctx.range, alias, H)
    const pre = ctx_pre_spectrum(ctx, FFT, alias)
    const bins = alias.bins

    // Главные пики шага 1: уровни до и после на ближайшем бине по осям, где пик найден
    const peaks = ctx.peaks.slice(0, rules.main_peaks).map((peak) => peak_levels(peak, bins, pre, post, "main"))

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
        band_f2_dB: band_power_dB(bins, post, rules.band_hz, rules.f2_ref_hz),
        lag_ms: lag_ms,
        spectrum: { bins: bins, x: post.x, y: post.y, z: post.z },
        pre_spectrum: pre,
    }
}

// Пики оценки «после» для варианта «как в логе», которые проверяются вместе с главными: первые post_peaks
// по убыванию превышения (find_axis_peaks — по осям со слиянием, не меньше peak_rules.min_excess_dB), кроме
// совпадающих с главными пиками (ближе max(axis_merge_hz, 2 бина)). Так вариант не может поднять пик, который
// фильтры лога держат внизу. null, если у оценки лога нет спектра или пиков [наше]
function log_post_peaks(log, rules) {
    if ((log == null) || (log.spectrum == null) || !Array.isArray(log.peaks)) {
        return null
    }
    const spectrum = log.spectrum
    const merge_hz = Math.max(peak_rules.axis_merge_hz, 2 * bin_spacing(spectrum.bins))
    const main = log.peaks.filter((peak) => peak.source !== "post")
    const found = find_axis_peaks(spectrum.bins, { X: spectrum.x, Y: spectrum.y, Z: spectrum.z })
    return found
        .filter((peak) => !main.some((m) => Math.abs(m.freq - peak.freq) <= merge_hz))
        .slice(0, rules.post_peaks)
        .map((peak) => ({ freq: peak.freq, axes: peak.axes }))
}

// Выбор варианта. evaluations — объект id → evaluate_candidate(...) (порядок ключей — порядок вариантов, лог
// первым), обязательно с id "log". Сначала в каждую оценку дописываются пики оценки «после» лога (log_post_peaks,
// source: "post"; повторный вызов заменяет их, а не добавляет). Вариант отмечается:
//   worse_peaks — частоты пиков (главных и «после»), где уровень хуже лога больше чем на max_peak_worsening_dB,
//                 где разница нечисловая (NaN) или где у пика нет пары в оценке лога (и наоборот);
//   lag_over    — задержка на старшей из lag_freqs_hz (30 Гц) больше задержки лога на max_lag_increase_ms
//                 или нечисловая;
//   incomplete  — оценки нет (null), нет списка пиков или спектра, мощность в полосе нечисловая.
// Проверки отказывают при сомнении: !(разница ≤ порога), поэтому NaN и undefined отмечают вариант [наше].
// Лучший — с наименьшей мощностью в главной полосе среди неотмеченных; при равной мощности — с меньшей задержкой
// на 30 Гц, затем раньше перечисленный. Лог служит опорой и рекомендуется, если лучше никто не подошёл; без
// оценки лога сравнивать не с чем — все варианты incomplete, best_id null.
// Возвращает { best_id, flags: { id: { worse_peaks: [freq…], lag_over, incomplete } } }
function rank_candidates(evaluations, rules = candidate_rules) {
    const log = evaluations.log
    const lag_hz = rules.lag_freqs_hz[rules.lag_freqs_hz.length - 1]

    // Пики оценки «после» лога — один раз на выбор, во все оценки
    const post_peaks = log_post_peaks(log, rules)
    for (const evaluation of Object.values(evaluations)) {
        if ((evaluation == null) || !Array.isArray(evaluation.peaks)) {
            continue
        }
        evaluation.peaks = evaluation.peaks.filter((peak) => peak.source !== "post")
        if ((post_peaks != null) && (evaluation.spectrum != null)) {
            for (const peak of post_peaks) {
                evaluation.peaks.push(peak_levels(peak, evaluation.spectrum.bins, evaluation.pre_spectrum, evaluation.spectrum, "post"))
            }
        }
    }

    const same = (a, b) => (a.freq === b.freq) && (a.source === b.source)
    const flags = {}
    for (const [id, evaluation] of Object.entries(evaluations)) {
        const worse_peaks = []
        let lag_over = false
        const incomplete = (evaluation == null) || !Array.isArray(evaluation.peaks) || (evaluation.spectrum == null) ||
                           !Number.isFinite(evaluation.band_dB) || ((id !== "log") && (post_peaks == null))
        if ((log != null) && (id !== "log") && !incomplete) {
            for (const peak of evaluation.peaks) {
                const log_peak = log.peaks.find((p) => same(p, peak))
                if ((log_peak == null) || !(peak.post_dB - log_peak.post_dB <= rules.max_peak_worsening_dB)) {
                    worse_peaks.push(peak.freq)
                }
            }
            for (const log_peak of log.peaks) {
                if (!evaluation.peaks.some((p) => same(p, log_peak))) {
                    worse_peaks.push(log_peak.freq)
                }
            }
            lag_over = !(evaluation.lag_ms?.[lag_hz] <= log.lag_ms?.[lag_hz] + rules.max_lag_increase_ms)
        }
        flags[id] = { worse_peaks: worse_peaks, lag_over: lag_over, incomplete: incomplete }
    }

    let best_id = (log != null) ? "log" : null
    for (const [id, evaluation] of Object.entries(evaluations)) {
        if (flags[id].incomplete || (flags[id].worse_peaks.length > 0) || flags[id].lag_over) {
            continue
        }
        if (best_id == null) {
            best_id = id
            continue
        }
        const best = evaluations[best_id]
        if ((evaluation.band_dB < best.band_dB) ||
            ((evaluation.band_dB === best.band_dB) && (evaluation.lag_ms[lag_hz] < best.lag_ms[lag_hz]))) {
            best_id = id
        }
    }

    return { best_id: best_id, flags: flags }
}

// Ширина пика в спектре amp_dB (одна ось, дБ) около частоты freq по уровню width_db ниже вершины. Вершина —
// наибольший бин в окрестности peak_exclusion_hz от ближайшего к freq (склон notch сдвигает вершину на бин-два).
// От вершины идём влево и вправо до первого бина не выше уровня; точка пересечения — линейная интерполяция
// между ним и предыдущим. Поиск — в пределах ±0.5·freq; если с какой-то стороны пересечения нет, эта сторона
// берётся равной пределу клампа BW на сторону: max_bw_ratio·freq / (2·width_factor).
// rules — candidate_rules.second_notch. Возвращает { top_hz, left_hz, right_hz, width_hz, found_left, found_right }:
// left_hz/right_hz — расстояния от вершины до пересечений, width_hz — их сумма (полная ширина) [наше]
function peak_width_hz(bins, amp_dB, freq, rules) {
    const k0 = nearest_bin(bins, freq)
    const exclusion = peak_exclusion_hz(bins)
    let top = k0
    for (let k = k0 - 1; (k >= 0) && (bins[k0] - bins[k] <= exclusion); k--) {
        if (amp_dB[k] > amp_dB[top]) {
            top = k
        }
    }
    for (let k = k0 + 1; (k < bins.length) && (bins[k] - bins[k0] <= exclusion); k++) {
        if (amp_dB[k] > amp_dB[top]) {
            top = k
        }
    }

    const level = amp_dB[top] - rules.width_db
    const search_hz = 0.5 * freq
    const side_limit_hz = rules.max_bw_ratio * freq / (2 * rules.width_factor)
    const crossing = (step) => {
        for (let k = top + step; (k >= 0) && (k < bins.length) && (Math.abs(bins[k] - bins[top]) <= search_hz); k += step) {
            if (amp_dB[k] > level) {
                continue
            }
            const prev = k - step
            const frac = (amp_dB[prev] - level) / (amp_dB[prev] - amp_dB[k])
            const f = bins[prev] + (bins[k] - bins[prev]) * (Number.isFinite(frac) ? frac : 0)
            return Math.abs(f - bins[top])
        }
        return null
    }
    const left = crossing(-1)
    const right = crossing(1)
    const left_hz = (left != null) ? left : side_limit_hz
    const right_hz = (right != null) ? right : side_limit_hz
    return { top_hz: bins[top], left_hz: left_hz, right_hz: right_hz, width_hz: left_hz + right_hz, found_left: left != null, found_right: right != null }
}

// Второй notch: если в оценке «после» лучшего варианта остаётся немоторный пик шага 1 — превышение над локальным
// шумом (local_excess_dB, на ближайшем бине по осям пика) не меньше second_notch.min_excess_dB, — вариант
// с добавленным статическим INS_HNTC2: MODE 0, FREQ = F (округлённая частота пика шага 1), ATT
// second_notch.attenuation, HMNCS 1, REF 0 (статический), FM_RAT 1, OPTS 0, ESCMSK 0.
// BW — по измеренной ширине пика (решение пользователя 24.10.2026): на оси, где пик выделяется сильнее всего,
// в оценке «после» лучшего варианта ширина по уровню −width_db от вершины (peak_width_hz), BW = round(width_factor
// · ширина), в пределах [min_bw_hz, round(max_bw_ratio · F)] [наше].
// Пики берутся из главной полосы band_hz (notch ниже неё съест задержку, выше — бесполезен); из нескольких —
// с наибольшим превышением. best — вариант { id, title, values }, best_eval — его evaluate_candidate,
// attribution — пики шага 1 с source (attribute_peaks_auto, attribute_peaks_order или attribute_peaks).
// null, если такого пика нет, оценки нет или второй notch у best уже включён.
// Возвращает { id: "second", title, values, base: best.id, peak: { freq, excess_dB, axis, width } }
function second_notch_candidate(best, best_eval, attribution, rules = candidate_rules) {
    const names = notch_param_names()[1]
    if ((best.values[names.enable] > 0) || (best_eval == null) || (best_eval.spectrum == null)) {
        return null
    }

    const spectrum = best_eval.spectrum
    const second = rules.second_notch
    let found = null
    for (const peak of attribution) {
        if ((peak.source !== "frame") || (peak.freq < rules.band_hz[0]) || (peak.freq > rules.band_hz[1])) {
            continue
        }
        const k = nearest_bin(spectrum.bins, peak.freq)
        for (const axis of peak.axes ?? ["X", "Y", "Z"]) {
            const excess = local_excess_dB(spectrum.bins, spectrum[axis.toLowerCase()], k)
            if ((excess != null) && (excess >= second.min_excess_dB) && ((found == null) || (excess > found.excess_dB))) {
                found = { freq: peak.freq, excess_dB: excess, axis: axis }
            }
        }
    }
    if (found == null) {
        return null
    }

    const freq = Math.round(found.freq)
    found.width = peak_width_hz(spectrum.bins, spectrum[found.axis.toLowerCase()], found.freq, second)
    const max_bw = Math.round(second.max_bw_ratio * freq)
    const bandwidth = Math.min(Math.max(Math.round(second.width_factor * found.width.width_hz), second.min_bw_hz), max_bw)

    const values = { ...best.values }
    values[names.enable] = 1
    values[names.mode] = 0
    values[names.freq] = freq
    values[names.bandwidth] = bandwidth
    values[names.attenuation] = second.attenuation
    values[names.ref] = 0
    values[names.min_ratio] = 1
    values[names.harmonics] = 1
    values[names.options] = 0
    values[names.esc_mask] = 0
    return { id: "second", title: best.title + " + второй notch на " + freq + " Гц", values: values, base: best.id, peak: found }
}
