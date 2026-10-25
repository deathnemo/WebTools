// Шаг 4 «PID по осям»: измеренный отклик контура скорости (КИХ МНК во времени), проверки качества измерения, метрики
// отклика, шум D, режим лога и правила ATC_RAT_*_P/I/D. Без DOM: работает в браузере и под Node (тесты).
// Дизайн — docs/plans/2026-10-25-tune-wizard-stage4-design.md, раздел 3; план — …-stage4.md, задача 5.
// Источники: [wiki] — ardupilot.org/copter/docs/ac_rollpitchtuning.html (ручная настройка); [код] — исходники ArduPilot;
// [PIDReview] — PIDReview/PIDReview.js (перенос — core/pid.js); [наше] — эвристика мастера (исследование 25.10.2026,
// скрипты step_method/ в scratchpad сеанса: синтетика с известным ответом и лог пользователя).
//
// Почему не отклик PIDReview (pid_step_response в core/pid.js): его плато ниже 1 даже при идеальном слежении (≈ 0.56 при
// факте = цели и 400 Гц), а перерегулирование сжато к 5–20 % независимо от правды. Он остаётся для графика и теста
// сравнения с PIDReview, метрики считаются здесь: импульсная характеристика «цель → факт» подбирается методом
// наименьших квадратов во времени, отклик на ступеньку — её накопленная сумма. На синтетике в условиях как у лога:
// перерегулирование ±1.6 пункта, нарастание ±5 мс, не зависит от окна FFT; при редких манёврах и сильной турбулентности
// без углового контура — до −2.8 пункта и +5.6 мс, при частых резких манёврах (тестовый полёт) — доли пункта и мс.
// Пройденные проверки качества ±5 мс не гарантируют: угловой контур + турбулентность + активный пилот дают (а) 0.029,
// (б) 0.033, (в) 1.48 — все проходят, а ошибка нарастания −6.8 мс (ревью задачи 5).
//
// Производительность: решение Холецким — O(M³) по числу отводов M = fir_length_s·частота, суммы — O(отсчёты·M), на ось
// четыре решения (отклик, (а), две половины (б)). При 400 Гц ≈ 80 мс на ось, при 800 Гц ≈ 0.4 с, при 1 кГц ≈ 0.7 с
// (110 с отобранных данных). Если понадобится быстрее — Левинсон — Дурбин для тёплицевой системы, O(M²).
//
// Измерение ненадёжно, если не пройдена любая из трёх проверок (pidtune_quality). Главная беда обычного полёта: в Acro
// при ATC_RATE_FF_ENAB = 0 цель скорости выше 4–5 Гц формирует угловой контур из самого факта, и «цель → факт» там
// показывает обратную величину углового контура (|T| растёт с частотой, фаза около −90°). Точно мастер считает тестовый
// полёт Acro с ACRO_OPTIONS «Rate Loop Only» (pidtune_log_mode) — решение пользователя 25.10.2026.
//
// Нужны глобалы страницы: FFTJS (modules/fft.js), Libraries/fft.js (hanning), US2S (core/log.js), find_start_index
// и find_end_index (core/gyro.js), PID_STEP_MIN_RATE и PID_STEP_RATE_MARGIN (core/pid.js).

const pidtune_rules = {
    target_min_dps: 20,           // окно — |цель·Ханн| не меньше 20 °/с [PIDReview, redraw_step]
    window: 512,                  // отрезки КИХ: окна по 512 отсчётов… [наше, как отбор PIDReview — число окон сравнимо]
    window_step: 32,              // …с шагом 32, центр окна в интервале [наше]
    fir_length_s: 1.0,            // длина КИХ, с (400 отводов при 400 Гц) [наше, исследование]
    fir_ridge: 1e-3,              // гребень λ·c_rr(0) [наше]
    fir_ridge_check: 1e-2,        // второй λ для проверки (а) [наше]
    step_length_s: 0.5,           // длина отклика, с [PIDReview]
    plateau_s: [0.3, 0.5],        // плато — среднее на этом отрезке, с [наше]
    // Меньше секунд отобранных данных (время, покрытое отобранными окнами, без повторов) — «мало манёвров» [наше].
    // Порог в окнах не годился: 10 окон по 512 с шагом 32 — около 2 с данных при КИХ на 1 с (399 отводов)
    min_data_s: 10,
    // Ниже — отклик не считается (без ATTITUDE_FAST в LOG_BITMASK PID пишутся с 10 Гц): тот же порог, что у отклика
    // PIDReview и проверки шага 0, — 100 Гц с запасом 1 % (99 Гц) [наше, дефект upstream 5, core/pid.js]
    min_log_rate_hz: PID_STEP_MIN_RATE * PID_STEP_RATE_MARGIN,
    settle_band: 0.05,            // установление ±5 % от плато [наше]
    osc_min_pp: 0.08,             // остаточные колебания — размах от пика до пика не меньше [наше, шум плато КИХ ±0.02–0.03]
    bandwidth_rise_product: 0.35, // полоса отклика ≈ 0.35 / t нарастания 10–90 % [наше, первый порядок]
    overshoot_high_pct: 20,       // больше — P −10 % [наше; wiki — логика P до раскачки]
    overshoot_low_pct: 5,         // меньше и колебаний нет — P +10 % [наше; wiki — логика P до раскачки]
    osc_band_ratio: 3,            // «высокие» колебания — выше 3 полос отклика [наше]
    // Проверки качества (а)–(в) [наше, исследование 25.10.2026]. Сценарии синтетики исследования через этот модуль
    // (половины — по отсчётам, (в) — окнами отбора 512): без ошибок (а) ≤ 0.018, (б) ≤ 0.028, (в) ≤ 1.46; с ошибками
    // (угловой контур, сильное возмущение) (а) 0.048–0.167, (б) 0.034–0.049, (в) 1.10–5.49 — каждый не проходит хотя
    // бы (а). В исследовании (половины по времени интервала, (в) окном 1024): без ошибок ≤ 0.018 / ≤ 0.026 / ≤ 1.51,
    // с ошибками 0.047–0.164 / 0.040–0.069 / 1.3–6.3
    quality: { ridge_rms_max: 0.03, halves_rms_max: 0.035, outer_t_max: 1.5, outer_band_hz: [4, 12] },
    gain_step: 0.10,              // ±10 % [wiki]
    yaw_i_ratio: 0.1,             // I рыскания = 0.1·P [код, AC_AutoTune_Multi.cpp, AUTOTUNE_YAW_PI_RATIO_FINAL]
    p_min: 0.01,                  // [код, AC_AutoTune_Multi.cpp, AUTOTUNE_RP_MIN]
    p_max: 2.0,                   // [код, AUTOTUNE_RP_MAX]
    d_max: 0.2,                   // [код, AUTOTUNE_RD_MAX]
    d_noise_hz: 50,               // шум D — выше этой частоты [наше]
    // Порог шума D, дБ от СКО D-составляющей выше d_noise_hz (выход регулятора: 1 — полный диапазон): выше —
    // «горячие моторы» [наше]. Калибровка на логе пользователя (AutoTune, 4.6.3, лог PID 400 Гц, notch на моторах,
    // интервал 49–540 с): крен −59.9, тангаж −61.5, рыскание −99.5 дБ — СКО 0.10 %, 0.08 % и ≈ 0 % выхода (СКО всей
    // D-составляющей крена 0.55 %). Тихий настроенный аппарат даёт только нижнюю опору: порог — на 20 дБ (в 10 раз
    // по СКО) выше худшей оси, СКО 1 % полного выхода на частотах выше 50 Гц. Лога с горячими моторами для проверки нет
    d_noise_threshold: -40,
    acro_mode: 1,                 // номер режима ACRO [код, ArduCopter/mode.h, Mode::Number]
    acro_rate_only_bit: 2,        // ACRO_OPTIONS бит 1 «Rate Loop Only» [код, ArduCopter/mode.h, AcroOptions; Parameters.cpp]
    // С Copter 4.7.0 в Rate Loop Only I × ATC_ANG_*_P [код, mode_acro.cpp, scale_I_to_angle_P; коммит 497039d36e
    // 01.10.2025, первый тег Copter-4.7.0, в 4.6.x нет]. По версии 4.7 масштаб получат и беты 4.7, собранные до
    // 01.10.2025, где его ещё не было
    i_scale_since: [4, 7],
}

// Оси шага: префикс параметров регулятора скорости и P углового контура (масштаб I в Rate Loop Only)
const pidtune_axes = {
    roll: { title: "крен", rate: "ATC_RAT_RLL_", angle_p: "ATC_ANG_RLL_P" },
    pitch: { title: "тангаж", rate: "ATC_RAT_PIT_", angle_p: "ATC_ANG_PIT_P" },
    yaw: { title: "рыскание", rate: "ATC_RAT_YAW_", angle_p: "ATC_ANG_YAW_P" },
}

// Имена режимов Copter по номеру [код, ArduCopter/mode.h, Mode::Number]
const pidtune_mode_names = {
    0: "STABILIZE", 1: "ACRO", 2: "ALT_HOLD", 3: "AUTO", 4: "GUIDED", 5: "LOITER", 6: "RTL", 7: "CIRCLE", 9: "LAND",
    11: "DRIFT", 13: "SPORT", 14: "FLIP", 15: "AUTOTUNE", 16: "POSHOLD", 17: "BRAKE", 18: "THROW", 19: "AVOID_ADSB",
    20: "GUIDED_NOGPS", 21: "SMART_RTL", 22: "FLOWHOLD", 23: "FOLLOW", 24: "ZIGZAG", 25: "SYSTEMID", 26: "AUTOROTATE",
    27: "AUTO_RTL", 28: "TURTLE",
}

// Отрезки оси для КИХ: окна rules.window с шагом rules.window_step по пакетам набора set_index оси axis
// (элемент load_pid().axes), где max |цель·Ханн| ≥ target_min_dps (как TarMax в PIDReview) и центр окна (время
// отсчёта начало + window/2) в range = [t0, t1]; перекрывающиеся окна сливаются в непрерывный отрезок, пакеты —
// не сливаются (между ними разрыв лога).
// → { segments: [{ start_time, tar, act (Float64Array, °/с), starts: [начала окон внутри отрезка] }], rate_hz, windows,
// data_s } — rate_hz — средняя частота пакетов набора не короче окна (как average_sample_rate у pid_run_batch_fft, но по
// набору), windows — число отобранных окон, data_s — секунды отобранных данных (отсчёты отрезков / rate_hz: время,
// покрытое окнами, без повторов). null — нет данных: ось без данных, нет набора или ни одного пакета не короче окна.
// Окон нет — segments пуст, windows и data_s 0
function pidtune_segments(axis, set_index, range, rules = pidtune_rules) {
    if ((axis == null) || !axis.have_data || (axis.sets == null) || (axis.sets[set_index] == null)) {
        return null
    }
    const N = rules.window
    const hop = rules.window_step
    const w = hanning(N)
    const segments = []
    let rate_sum = 0
    let rate_count = 0
    let windows = 0
    let samples = 0
    for (const batch of axis.sets[set_index]) {
        const n = batch.Tar.length
        if (n < N) {
            continue
        }
        rate_sum += batch.sample_rate
        rate_count++

        // Окна, прошедшие отбор
        const starts = []
        for (let s = 0; s + N <= n; s += hop) {
            const center = batch.time[s + (N >> 1)]
            if ((center < range[0]) || (center > range[1])) {
                continue
            }
            let max = 0
            for (let i = 0; i < N; i++) {
                const v = Math.abs(batch.Tar[s + i] * w[i])
                if (v > max) {
                    max = v
                }
            }
            if (max >= rules.target_min_dps) {
                starts.push(s)
            }
        }

        // Слияние перекрывающихся (и стыкующихся) окон в отрезки
        let i = 0
        while (i < starts.length) {
            const begin = starts[i]
            let end = begin + N
            const own = [0]
            let j = i + 1
            while ((j < starts.length) && (starts[j] <= end)) {
                own.push(starts[j] - begin)
                end = starts[j] + N
                j++
            }
            segments.push({ start_time: batch.time[begin], tar: Float64Array.from(batch.Tar.slice(begin, end)),
                            act: Float64Array.from(batch.Act.slice(begin, end)), starts: own })
            windows += own.length
            samples += end - begin
            i = j
        }
    }
    if (rate_count == 0) {
        return null
    }
    const rate_hz = rate_sum / rate_count
    return { segments: segments, rate_hz: rate_hz, windows: windows, data_s: samples / rate_hz }
}

// Суммы по отрезкам для нормальных уравнений КИХ из taps отводов (метод автокорреляции: за краями отрезка — нули,
// матрица неотрицательно определена): crr[m] = Σ r[k]·r[k − m], cry[m] = Σ y[k]·r[k − m], m = 0…taps − 1
// → { crr, cry, samples, windows }
function pidtune_correlations(segments, taps) {
    const crr = new Float64Array(taps)
    const cry = new Float64Array(taps)
    let samples = 0
    let windows = 0
    for (const seg of segments) {
        const r = seg.tar
        const y = seg.act
        const n = r.length
        samples += n
        windows += seg.starts.length
        for (let lag = 0; (lag < taps) && (lag < n); lag++) {
            let a = 0
            let b = 0
            for (let k = lag; k < n; k++) {
                const x = r[k - lag]
                a += r[k] * x
                b += y[k] * x
            }
            crr[lag] += a
            cry[lag] += b
        }
    }
    return { crr: crr, cry: cry, samples: samples, windows: windows }
}

// Решение симметричной тёплицевой системы (col[|i − j|] + diag_add·[i = j])·x = rhs разложением Холецкого.
// → Float64Array x | null (матрица не положительно определена — данных нет)
function pidtune_toeplitz_solve(col, rhs, diag_add) {
    const n = rhs.length
    const L = new Float64Array(n * n)
    for (let i = 0; i < n; i++) {
        const ri = i * n
        for (let j = 0; j <= i; j++) {
            const rj = j * n
            let s = col[i - j] + ((i == j) ? diag_add : 0)
            for (let k = 0; k < j; k++) {
                s -= L[ri + k] * L[rj + k]
            }
            if (i == j) {
                if (!(s > 0)) {
                    return null
                }
                L[ri + i] = Math.sqrt(s)
            } else {
                L[ri + j] = s / L[rj + j]
            }
        }
    }
    // L·z = rhs, затем Lᵀ·x = z
    const z = new Float64Array(n)
    for (let i = 0; i < n; i++) {
        let s = rhs[i]
        for (let k = 0; k < i; k++) {
            s -= L[i * n + k] * z[k]
        }
        z[i] = s / L[i * n + i]
    }
    const x = new Float64Array(n)
    for (let i = n - 1; i >= 0; i--) {
        let s = z[i]
        for (let k = i + 1; k < n; k++) {
            s -= L[k * n + i] * x[k]
        }
        x[i] = s / L[i * n + i]
    }
    return x
}

// КИХ по готовым суммам corr (pidtune_correlations) с гребнем ridge·c_rr(0) и h[0] = 0: прямой связи «цель → факт»
// в контуре нет (без запрета на смешанных режимах y(0) = 0.09–0.21 [наше, исследование]). Решаются уравнения для
// h[1…taps − 1]: та же тёплицева матрица без первой строки и столбца.
// → { h, time, step, windows, samples, ridge, corr } | null (нет энергии цели или в данных нечисловое — NaN, Infinity)
function pidtune_fir_from(corr, rate_hz, ridge, rules = pidtune_rules) {
    const taps = corr.crr.length
    if ((taps < 2) || !(corr.crr[0] > 0) || !Number.isFinite(corr.crr[0])) {
        return null
    }
    const x = pidtune_toeplitz_solve(corr.crr.subarray(0, taps - 1), corr.cry.subarray(1), ridge * corr.crr[0])
    if ((x == null) || !x.every(Number.isFinite)) {
        return null
    }
    const h = new Float64Array(taps)
    h.set(x, 1)

    // Отклик на ступеньку — накопленная сумма h на 0…step_length_s
    const n_out = Math.min(taps, Math.round(rules.step_length_s * rate_hz) + 1)
    const time = new Array(n_out)
    const step = new Array(n_out)
    let sum = 0
    for (let i = 0; i < n_out; i++) {
        sum += h[i]
        time[i] = i / rate_hz
        step[i] = sum
    }
    return { h: h, time: time, step: step, windows: corr.windows, samples: corr.samples, ridge: ridge, corr: corr }
}

// КИХ МНК «цель → факт» по отрезкам (pidtune_segments): нормальные уравнения по автокорреляции цели и взаимной
// корреляции «факт ← цель», суммированным по отрезкам (Тёплиц, разложение Холецкого), гребень ridge·c_rr(0), h[0] = 0;
// длина fir_length_s·rate_hz отводов.
// → { h, time (с), step (накопленная сумма h на 0…step_length_s), windows, samples, ridge, corr (суммы — для
// pidtune_quality) } | null — нет отрезков, частота ниже min_log_rate_hz (отклик не считается), нет энергии цели или
// в цели или факте нечисловое (NaN, Infinity)
function pidtune_fir(segments, rate_hz, ridge = pidtune_rules.fir_ridge, rules = pidtune_rules) {
    if ((segments == null) || (segments.length == 0) || !(rate_hz >= rules.min_log_rate_hz)) {
        return null
    }
    const taps = Math.round(rules.fir_length_s * rate_hz)
    return pidtune_fir_from(pidtune_correlations(segments, taps), rate_hz, ridge, rules)
}

// Среднеквадратичная разница двух откликов на общей сетке (по короткому)
function pidtune_rms_diff(a, b) {
    const n = Math.min(a.length, b.length)
    let sum = 0
    for (let i = 0; i < n; i++) {
        sum += (a[i] - b[i]) ** 2
    }
    return Math.sqrt(sum / n)
}

// Деление отрезков на две половины по числу отсчётов (в порядке времени); отрезок на середине режется, окна —
// только целиком попавшие в свою часть (window — их длина). → [первая, вторая]
function pidtune_halves(segments, window) {
    let total = 0
    for (const seg of segments) {
        total += seg.tar.length
    }
    const half = Math.round(total / 2)
    const first = []
    const second = []
    let acc = 0
    for (const seg of segments) {
        const n = seg.tar.length
        if (acc + n <= half) {
            first.push(seg)
        } else if (acc >= half) {
            second.push(seg)
        } else {
            const cut = half - acc
            first.push({ start_time: seg.start_time, tar: seg.tar.subarray(0, cut), act: seg.act.subarray(0, cut),
                         starts: seg.starts.filter((s) => s + window <= cut) })
            second.push({ start_time: null, tar: seg.tar.subarray(cut), act: seg.act.subarray(cut),
                          starts: seg.starts.filter((s) => s >= cut).map((s) => s - cut) })
        }
        acc += n
    }
    return [first, second]
}

// Подпись углового контура: наибольшее |T_H1| = |S_ar / S_rr| (усреднённые по отобранным окнам спектры, окно Ханна
// rules.window) на частотах quality.outer_band_hz. → { value, freq_hz } | null (нет окон или полоса пуста)
function pidtune_outer_peak(segments, rate_hz, rules = pidtune_rules) {
    const N = rules.window
    const band = rules.quality.outer_band_hz
    const k0 = Math.max(1, Math.ceil(band[0] * N / rate_hz))
    const k1 = Math.min(N / 2, Math.floor(band[1] * N / rate_hz))
    if (k1 < k0) {
        return null
    }
    const fft = new FFTJS(N)
    const w = hanning(N)
    const xr = new Float64Array(N)
    const xa = new Float64Array(N)
    const Fr = fft.createComplexArray()
    const Fa = fft.createComplexArray()
    const len = k1 - k0 + 1
    const s_ar_re = new Float64Array(len)
    const s_ar_im = new Float64Array(len)
    const s_rr = new Float64Array(len)
    let count = 0
    for (const seg of segments) {
        for (const s of seg.starts) {
            for (let i = 0; i < N; i++) {
                xr[i] = seg.tar[s + i] * w[i]
                xa[i] = seg.act[s + i] * w[i]
            }
            fft.realTransform(Fr, xr)
            fft.realTransform(Fa, xa)
            for (let k = k0; k <= k1; k++) {
                const rr = Fr[2 * k]
                const ri = Fr[2 * k + 1]
                const ar = Fa[2 * k]
                const ai = Fa[2 * k + 1]
                // A·conj(R)
                s_ar_re[k - k0] += ar * rr + ai * ri
                s_ar_im[k - k0] += ai * rr - ar * ri
                s_rr[k - k0] += rr * rr + ri * ri
            }
            count++
        }
    }
    if (count == 0) {
        return null
    }
    let value = -Infinity
    let freq_hz = null
    for (let k = k0; k <= k1; k++) {
        const t = Math.hypot(s_ar_re[k - k0], s_ar_im[k - k0]) / s_rr[k - k0]
        if (t > value) {
            value = t
            freq_hz = k * rate_hz / N
        }
    }
    return { value: value, freq_hz: freq_hz }
}

// Проверки качества измерения оси (решение пользователя 25.10.2026: не прошла любая — «измерение ненадёжно»):
//   (а) ridge — RMS разницы откликов КИХ при fir.ridge (fir_ridge) и fir_ridge_check; выше порога — отклик держится
//       на регуляризации, а не на данных;
//   (б) halves — RMS разницы откликов КИХ по первой и второй половине отрезков (по числу отсчётов, pidtune_halves);
//       выше порога — режим или объект менялись в интервале, или данных мало;
//   (в) outer — наибольшее |T_H1| («цель → факт» по усреднённым спектрам отобранных окон) на outer_band_hz; выше
//       порога — цель формирует угловой контур из факта (Acro без Rate Loop Only при ATC_RATE_FF_ENAB = 0).
//       В Acro «Rate Loop Only» (options.rate_only, pidtune_log_mode) не применяется: угловой контур там выключен
//       устройством режима, а резонансный пик плохо задемпфированного контура скорости (ζ меньше ≈ 0.36 — пик |T|
//       выше 1.5 на 4–12 Гц) проверка приняла бы за угловой контур [наше, ревью задачи 5: rate-only, перерегулирование
//       правды 35.6 %, КИХ 35.5 %, (а) и (б) 0.003 и 0.002, а (в) 1.57]. Значение считается и показывается, в итог
//       не входит: ok null, applied false, note — почему.
// fir — pidtune_fir(segments, rate_hz) (его суммы используются для (а)); options = { rate_only }.
// → { ok, checks: { ridge: { value, ok }, halves: { value, ok }, outer: { value, freq_hz, ok, applied, note } },
// reasons: [текст] }; значение, которое не посчитать (нет отклика или окон), — null и проверка не пройдена
function pidtune_quality(segments, rate_hz, fir, options = {}, rules = pidtune_rules) {
    const q = rules.quality
    const outer_applied = !options.rate_only
    let ridge = null
    let halves = null
    let outer = null
    if (fir != null) {
        const check = pidtune_fir_from(fir.corr, rate_hz, rules.fir_ridge_check, rules)
        if (check != null) {
            ridge = pidtune_rms_diff(fir.step, check.step)
        }
        const parts = pidtune_halves(segments, rules.window)
        const first = pidtune_fir(parts[0], rate_hz, fir.ridge, rules)
        const second = pidtune_fir(parts[1], rate_hz, fir.ridge, rules)
        if ((first != null) && (second != null)) {
            halves = pidtune_rms_diff(first.step, second.step)
        }
        outer = pidtune_outer_peak(segments, rate_hz, rules)
    }
    const checks = {
        ridge: { value: ridge, ok: (ridge != null) && (ridge <= q.ridge_rms_max) },
        halves: { value: halves, ok: (halves != null) && (halves <= q.halves_rms_max) },
        outer: { value: outer?.value ?? null, freq_hz: outer?.freq_hz ?? null,
                 ok: outer_applied ? ((outer != null) && (outer.value <= q.outer_t_max)) : null, applied: outer_applied,
                 note: outer_applied ? null : "не применяется (Rate Loop Only): угловой контур выключен устройством режима" },
    }
    const reasons = []
    if (fir == null) {
        reasons.push("нет отклика: нет отобранных окон или частота лога ниже " + PID_STEP_MIN_RATE + " Гц")
    } else {
        if (!checks.ridge.ok) {
            reasons.push((ridge == null) ? "проверка регуляризации не посчиталась"
                : "отклик зависит от регуляризации: RMS разницы при λ " + rules.fir_ridge + " и " + rules.fir_ridge_check + " — " +
                  ridge.toFixed(3) + " (порог " + q.ridge_rms_max + ")")
        }
        if (!checks.halves.ok) {
            reasons.push((halves == null) ? "половины данных не посчитались"
                : "половины данных дают разный отклик: RMS " + halves.toFixed(3) + " (порог " + q.halves_rms_max + ") — режим " +
                  "или объект менялись в интервале, или данных мало")
        }
        if (outer_applied && !checks.outer.ok) {
            reasons.push((outer == null) ? "подпись углового контура не посчиталась"
                : "подпись углового контура: |цель → факт| до " + outer.value.toFixed(2) + " на " + outer.freq_hz.toFixed(1) + " Гц (порог " +
                  q.outer_t_max + " на " + q.outer_band_hz[0] + "–" + q.outer_band_hz[1] + " Гц) — цель скорости формирует угловой " +
                  "контур (Acro без «Rate Loop Only»)")
        }
    }
    return { ok: checks.ridge.ok && checks.halves.ok && (!outer_applied || checks.outer.ok), checks: checks, reasons: reasons }
}

// Время первого достижения уровня level снизу (линейная интерполяция) на отсчётах 0…n − 1; null — не достиг
function pidtune_crossing(time, y, n, level) {
    for (let i = 1; i < n; i++) {
        if ((y[i - 1] < level) && (y[i] >= level)) {
            return time[i - 1] + (level - y[i - 1]) / (y[i] - y[i - 1]) * (time[i] - time[i - 1])
        }
    }
    return null
}

// Остаточные колебания на отсчётах i0…n − 1 по отклонению от прямой МНК (медленный дрейф не в счёт): события —
// выходы отклонения за ±min_pp/4 попеременно (гистерезис: шум КИХ ±0.02–0.03 сам их почти не даёт), между соседними
// событиями полпериода; экстремум каждого полупериода; размах — наибольшая разница соседних экстремумов (общий
// «максимум − минимум» завышал бы его: прямая МНК по синусоиде на конечном отрезке наклонена). Колебания есть, если
// событий не меньше трёх (целый период) и размах не меньше min_pp. → { freq_hz, amplitude_pp } | null
function pidtune_oscillation(time, y, i0, n, min_pp) {
    const count = n - i0
    if (count < 4) {
        return null
    }
    let st = 0
    let sy = 0
    for (let i = i0; i < n; i++) {
        st += time[i]
        sy += y[i]
    }
    const mt = st / count
    const my = sy / count
    let stt = 0
    let sty = 0
    for (let i = i0; i < n; i++) {
        stt += (time[i] - mt) ** 2
        sty += (time[i] - mt) * (y[i] - my)
    }
    const slope = (stt > 0) ? sty / stt : 0
    const hyst = min_pp / 4
    const events = []
    const extremes = []
    let state = 0
    let extreme = 0
    let prev = 0
    for (let k = 0; k < count; k++) {
        const v = y[i0 + k] - (my + slope * (time[i0 + k] - mt))
        const flip = ((v > hyst) && (state != 1)) ? 1 : (((v < -hyst) && (state != -1)) ? -1 : 0)
        if (flip != 0) {
            if (state != 0) {
                extremes.push(extreme)
            }
            // Время выхода за уровень (на первом отсчёте выхода нет: отклонение уже было там)
            if (k > 0) {
                const level = flip * hyst
                const t0 = time[i0 + k - 1]
                const t1 = time[i0 + k]
                events.push(t0 + Math.min(1, Math.max(0, (level - prev) / (v - prev))) * (t1 - t0))
            }
            state = flip
            extreme = v
        } else if (state == 1) {
            extreme = Math.max(extreme, v)
        } else if (state == -1) {
            extreme = Math.min(extreme, v)
        }
        prev = v
    }
    if (state != 0) {
        extremes.push(extreme)
    }
    if (events.length < 3) {
        return null
    }
    let amplitude_pp = 0
    for (let i = 1; i < extremes.length; i++) {
        amplitude_pp = Math.max(amplitude_pp, Math.abs(extremes[i] - extremes[i - 1]))
    }
    if (amplitude_pp < min_pp) {
        return null
    }
    const span = events[events.length - 1] - events[0]
    return { freq_hz: (events.length - 1) / (2 * span), amplitude_pp: amplitude_pp }
}

// Метрики отклика на ступеньку (time, step — сетка с 0; цель = 1), отсчёты не дальше step_length_s:
//   rise_s — нарастание 10–90 % от 1 (null — не достиг 0.9), bandwidth_hz = bandwidth_rise_product / rise_s;
//   overshoot_pct — (максимум − 1)·100, не меньше 0; peak — максимум;
//   plateau — среднее на plateau_s (null — отсчётов там нет);
//   settle_s — установление в ±settle_band от плато: время после последнего выхода из полосы (null — в конце вне полосы);
//   osc — остаточные колебания { freq_hz, amplitude_pp } | null (pidtune_oscillation) на плато: у отклика,
//         установившегося раньше, это «после установления», у неустановившегося — колебания, которые и мешают
//         установиться. С момента установления считать нельзя: там отклик ровно на краю полосы, и размах всегда
//         включал бы её половину. На 0.2 с плато три пересечения дают колебания от ≈ 7.5 Гц; более медленные —
//         основной переходный процесс, его ловит перерегулирование.
// «±5 % от плато», а не от 1 [наше]: при P = I интегратор дотягивает медленно (y(0.5) = 0.95…1.04), и «от 1»
// переключалось бы случайно. → { rise_s, overshoot_pct, peak, plateau, settle_s, osc, bandwidth_hz } | null — в отклике
// нечисловое (NaN, Infinity) или отсчётов нет
function pidtune_step_metrics(time, step, rules = pidtune_rules) {
    let n = 0
    while ((n < time.length) && (time[n] <= rules.step_length_s + 1e-9)) {
        n++
    }
    for (let i = 0; i < n; i++) {
        if (!Number.isFinite(step[i])) {
            return null
        }
    }
    if (n == 0) {
        return null
    }
    const t10 = pidtune_crossing(time, step, n, 0.1)
    const t90 = pidtune_crossing(time, step, n, 0.9)
    const rise_s = ((t10 != null) && (t90 != null)) ? t90 - t10 : null

    let peak = -Infinity
    for (let i = 0; i < n; i++) {
        peak = Math.max(peak, step[i])
    }

    let sum = 0
    let count = 0
    for (let i = 0; i < n; i++) {
        if ((time[i] >= rules.plateau_s[0] - 1e-9) && (time[i] <= rules.plateau_s[1] + 1e-9)) {
            sum += step[i]
            count++
        }
    }
    const plateau = (count > 0) ? sum / count : null

    let settle_s = null
    let osc = null
    if (plateau != null) {
        const band = rules.settle_band * Math.abs(plateau)
        let last = -1
        for (let i = 0; i < n; i++) {
            if (Math.abs(step[i] - plateau) > band) {
                last = i
            }
        }
        if (last < n - 1) {
            settle_s = (last < 0) ? 0 : time[last + 1]
        }
        let i0 = 0
        while ((i0 < n) && (time[i0] < rules.plateau_s[0] - 1e-9)) {
            i0++
        }
        osc = pidtune_oscillation(time, step, i0, n, rules.osc_min_pp)
    }

    return {
        rise_s: rise_s,
        overshoot_pct: Math.max(0, (peak - 1) * 100),
        peak: peak,
        plateau: plateau,
        settle_s: settle_s,
        osc: osc,
        bandwidth_hz: (rise_s > 0) ? rules.bandwidth_rise_product / rise_s : null,
    }
}

// Шум D-составляющей выше d_noise_hz по спектру D набора set_index оси axis за интервал range. Нужен
// pid_run_batch_fft(axis.sets, window): окна набора (set.FFT.D, время set.FFT.time) от последнего до t0 до первого
// после t1, как у спектра PIDReview (find_start_index, find_end_index); поэтому интервал целиком вне данных даёт одно
// окно — ближайшее к нему. Мощность окна — Σ |X|²/2 по бинам выше d_noise_hz (на частоте Найквиста — |X|²; амплитуды
// run_fft — одна сторона, 2/N), с поправкой окна на энергию; среднее по окнам.
// → { dB: 10·log10(мощность) — дБ от СКО (1 — полный диапазон выхода), rms, off, over: dB > d_noise_threshold, windows }
// | null — нет FFT или D (ось RATE). Вся D-составляющая в окнах нулевая (D выключен) — dB null, rms 0, off true,
// over false
function pidtune_d_noise(axis, set_index, range, rules = pidtune_rules) {
    if ((axis == null) || !axis.have_data || (axis.sets == null) || (axis.sets.FFT == null)) {
        return null
    }
    const set = axis.sets[set_index]
    if ((set == null) || (set.FFT == null) || (set.FFT.D == null) || (set.FFT.D.length == 0)) {
        return null
    }
    const bins = axis.sets.FFT.bins
    const energy = axis.sets.FFT.correction.energy
    const last_bin = bins.length - 1
    const start = find_start_index(set.FFT.time, range)
    const end = find_end_index(set.FFT.time, range) + 1
    let sum = 0
    let count = 0
    let any = false
    for (let k = start; k < end; k++) {
        const X = set.FFT.D[k]
        let power = 0
        for (let j = 0; j <= last_bin; j++) {
            if ((X[0][j] != 0) || (X[1][j] != 0)) {
                any = true
            }
            if (bins[j] <= rules.d_noise_hz) {
                continue
            }
            const p = X[0][j] ** 2 + X[1][j] ** 2
            power += (j == last_bin) ? p : p / 2
        }
        sum += power
        count++
    }
    if (count == 0) {
        return null
    }
    if (!any) {
        return { dB: null, rms: 0, off: true, over: false, windows: count }
    }
    // Мощности выше d_noise_hz ровно нет (D есть, но только на низких частотах) — dB null, порог не превышен
    const power = sum / count * energy ** 2
    const dB = (power > 0) ? 10 * Math.log10(power) : null
    return { dB: dB, rms: Math.sqrt(power), off: false, over: (dB != null) && (rules.d_noise_threshold != null) && (dB > rules.d_noise_threshold),
             windows: count }
}

// Значения параметра name, действующие в интервале range (params — log_params из core/log.js): значение на начало
// интервала (последнее не позже t0, иначе первое записанное) и все смены внутри. [] — параметра нет
function pidtune_param_values(params, name, range) {
    const history = (params != null) ? params.history(name) : []
    if (history.length == 0) {
        return []
    }
    let first = 0
    for (let i = 0; i < history.length; i++) {
        if (history[i].time <= range[0]) {
            first = i
        }
    }
    const values = [history[first].value]
    for (let i = first + 1; i < history.length; i++) {
        if ((history[i].time > range[0]) && (history[i].time <= range[1])) {
            values.push(history[i].value)
        }
    }
    return values
}

// Номера режимов полёта в интервале range по сообщениям MODE (поле Mode): действующий на t0 (последний не позже t0)
// и включённые внутри, без повторов, в порядке появления. Режим до первого MODE неизвестен и не входит. [] — нет MODE
function pidtune_modes_in(log, range) {
    if ((log == null) || !("MODE" in log.messageTypes)) {
        return []
    }
    const time = log.get("MODE", "TimeUS")
    const mode = log.get("MODE", "Mode")
    if ((time == null) || (mode == null)) {
        return []
    }
    let current = null
    const list = []
    for (let i = 0; i < time.length; i++) {
        const t = time[i] * US2S
        if (t <= range[0]) {
            current = mode[i]
        } else if (t <= range[1]) {
            list.push(mode[i])
        }
    }
    const out = []
    for (const m of ((current != null) ? [current, ...list] : list)) {
        if (!out.includes(m)) {
            out.push(m)
        }
    }
    return out
}

// Версия прошивки { major, minor, patch }: VER.Maj/Min/Pat из лога, иначе «V4.6.3» в version.fw_string
// (get_version_and_board, Libraries/LogHelpers.js). null — не определить
function pidtune_firmware(log, version) {
    if ((log != null) && ("VER" in log.messageTypes)) {
        const major = log.get("VER", "Maj")
        const minor = log.get("VER", "Min")
        if ((major != null) && (minor != null) && (major.length > 0) && (minor.length > 0)) {
            const patch = log.get("VER", "Pat")
            return { major: major[0], minor: minor[0], patch: ((patch != null) && (patch.length > 0)) ? patch[0] : null }
        }
    }
    const found = /V(\d+)\.(\d+)(?:\.(\d+))?/.exec(version?.fw_string ?? "")
    if (found == null) {
        return null
    }
    return { major: Number(found[1]), minor: Number(found[2]), patch: (found[3] != null) ? Number(found[3]) : null }
}

// Режим лога для оси axis_name ("roll", "pitch", "yaw") в интервале range:
//   rate_only — тестовый полёт Acro «Rate Loop Only»: во всём интервале режим ACRO (acro_mode) и в каждом действующем
//               значении ACRO_OPTIONS бит acro_rate_only_bit — угловой контур выключен, цель — команда пилота;
//   modes — имена режимов в интервале (pidtune_modes_in), mixed_modes — они же, если режимов больше одного, иначе [];
//   i_scale — множитель I регулятора (update_all, i_scale): ATC_ANG_*_P оси (значение в конце интервала) при rate_only
//             и версии не ниже i_scale_since (4.7), иначе 1;
//   firmware — pidtune_firmware(log, version); low_rate — rate_hz ниже min_log_rate_hz (отклик не считается);
//   warnings — что не удалось определить (версия, ATC_ANG_*_P при rate_only — тогда i_scale 1).
// params — log_params (core/log.js), version — get_version_and_board (state.version), rate_hz — pidtune_segments
function pidtune_log_mode(log, params, version, range, axis_name, rate_hz, rules = pidtune_rules) {
    const warnings = []
    const numbers = pidtune_modes_in(log, range)
    const modes = numbers.map((m) => pidtune_mode_names[m] ?? ("режим " + m))
    const options = pidtune_param_values(params, "ACRO_OPTIONS", range)
    const rate_only = (numbers.length > 0) && numbers.every((m) => m == rules.acro_mode) &&
                      (options.length > 0) && options.every((v) => (v & rules.acro_rate_only_bit) != 0)

    const firmware = pidtune_firmware(log, version)
    let i_scale = 1
    if (rate_only) {
        const since = rules.i_scale_since
        if (firmware == null) {
            warnings.push("Версия прошивки не определена: масштаб I по " + pidtune_axes[axis_name].angle_p + " в Rate Loop Only " +
                          "(Copter " + since.join(".") + " и новее) не учтён")
        } else if ((firmware.major > since[0]) || ((firmware.major == since[0]) && (firmware.minor >= since[1]))) {
            const angle_p = pidtune_param_values(params, pidtune_axes[axis_name].angle_p, range)
            if (angle_p.length == 0) {
                warnings.push("В логе нет " + pidtune_axes[axis_name].angle_p + ": масштаб I в Rate Loop Only не учтён")
            } else {
                i_scale = angle_p[angle_p.length - 1]
            }
        }
    }
    return {
        rate_only: rate_only,
        modes: modes,
        mixed_modes: (modes.length > 1) ? modes : [],
        i_scale: i_scale,
        firmware: firmware,
        low_rate: (rate_hz != null) && (rate_hz < rules.min_log_rate_hz),
        warnings: warnings,
    }
}

// Изменение P на sign·gain_step с пределами AutoTune; I по правилу: крен и тангаж — I = P [wiki, Manual tuning:
// «Each time the P term is changed set the I term equal to the P term»], рыскание — I = yaw_i_ratio·P [код].
// Предел, не давший сдвинуть P в нужную сторону (P уже на пределе) или развернувший изменение (P 2.5 и «P +10 %» →
// 2.0, P 0.005 и «P −10 %» → 0.01), — без изменений, limited true
function pidtune_change_p(gains, axis, sign, reason, rules) {
    const target = gains.P * (1 + sign * rules.gain_step)
    const P = Math.min(rules.p_max, Math.max(rules.p_min, target))
    const limited = (P != target)
    const limit_text = "предел AutoTune P " + rules.p_min + "…" + rules.p_max
    if ((P - gains.P) * sign <= 0) {
        const why = (P == gains.P) ? "P уже на пределе"
            : "P = " + gains.P + " вне пределов: ограничение " + ((sign > 0) ? "уменьшило бы P вместо увеличения" : "увеличило бы P вместо уменьшения")
        return { change: null, reason: reason + "; " + why + " (" + limit_text + ") — без изменений", values: { P: gains.P, I: gains.I, D: gains.D }, limited: true }
    }
    const I = (axis == "yaw") ? rules.yaw_i_ratio * P : P
    return { change: (sign > 0) ? "P+" : "P-", reason: reason + (limited ? " (ограничено: " + limit_text + ")" : ""),
             values: { P: P, I: I, D: gains.D }, limited: limited }
}

// Предложение по правилам (раздел 3 дизайна). Без изменений (change null, причина), по порядку: P или I нет в логе
// (не число); отобранных данных меньше min_data_s — «мало манёвров» (раньше качества: на коротком полёте причина —
// данные, а не проверки); измерение ненадёжно (quality.ok ложно); нет метрик. Иначе одно изменение на коэффициент за
// проход, правила по порядку:
//   1. остаточные колебания (metrics.osc): частота выше osc_band_ratio полос отклика (bandwidth_hz) — «высокие» → D −10 %,
//      не выше — «низкие» → P −10 %. При D = 0 (или D нет) правило для D не применяется — дальше по правилам;
//   2. перерегулирование больше overshoot_high_pct → P −10 %;
//   3. перерегулирование меньше overshoot_low_pct и колебаний нет — отклик вялый → P +10 % [wiki: P поднимают
//      до раскачки, затем отступают; пороги — наше];
//   4. иначе — менять нечего.
// gains = { P, I, D } лога, axis — "roll", "pitch", "yaw", metrics — pidtune_step_metrics, data_s — секунды отобранных
// данных (pidtune_segments), quality — pidtune_quality. Пределы AutoTune: P в p_min…p_max, D ≤ d_max
// (pidtune_change_p).
// → { change: "P-" | "P+" | "D-" | null, reason, values: { P, I, D }, limited } (change null — values как в логе)
function pidtune_rule(gains, axis, metrics, data_s, quality, rules = pidtune_rules) {
    const keep = (reason, limited = false) => ({ change: null, reason: reason, values: { P: gains.P, I: gains.I, D: gains.D }, limited: limited })
    const missing = ["P", "I"].filter((k) => !Number.isFinite(gains[k])).map((k) => pidtune_axes[axis].rate + k)
    if (missing.length > 0) {
        return keep("нет коэффициента в логе: " + missing.join(", "))
    }
    if (!(data_s >= rules.min_data_s)) {
        return keep("мало манёвров: отобранных данных (окна с целью больше " + rules.target_min_dps + " °/с) " + (data_s ?? 0).toFixed(1) +
                    " с, нужно не меньше " + rules.min_data_s + " с")
    }
    if ((quality == null) || !quality.ok) {
        const why = ((quality != null) && (quality.reasons.length > 0)) ? ": " + quality.reasons.join("; ") : ""
        return keep("измерение ненадёжно" + why + " — правил нет")
    }
    if (metrics == null) {
        return keep("нет отклика")
    }
    const os = metrics.overshoot_pct
    const os_text = "перерегулирование " + os.toFixed(1) + " %"
    const osc = metrics.osc
    let d_skipped = null
    if (osc != null) {
        const osc_text = "колебания " + osc.freq_hz.toFixed(1) + " Гц, размах " + osc.amplitude_pp.toFixed(2)
        if (metrics.bandwidth_hz == null) {
            return keep(osc_text + ", а время нарастания не определено — частоту не с чем сравнить")
        }
        const limit = rules.osc_band_ratio * metrics.bandwidth_hz
        const band_text = rules.osc_band_ratio + " полос отклика (" + limit.toFixed(1) + " Гц)"
        if (osc.freq_hz > limit) {
            if (Number.isFinite(gains.D) && (gains.D > 0)) {
                const target = gains.D * (1 - rules.gain_step)
                const D = Math.min(rules.d_max, target)
                const limited = (D != target)
                return { change: "D-", reason: "высокие " + osc_text + " — выше " + band_text + " → D −" + Math.round(rules.gain_step * 100) + " %" +
                         (limited ? " (ограничено: предел AutoTune D ≤ " + rules.d_max + ")" : ""),
                         values: { P: gains.P, I: gains.I, D: D }, limited: limited }
            }
            d_skipped = "высокие " + osc_text + " — выше " + band_text + ", но D " + (Number.isFinite(gains.D) ? "выключен (D = 0)" : "нет в логе") +
                        " — правило для D не применяется"
        } else {
            return pidtune_change_p(gains, axis, -1, "низкие " + osc_text + " — не выше " + band_text + " → P −" + Math.round(rules.gain_step * 100) + " %", rules)
        }
    }
    if (os > rules.overshoot_high_pct) {
        return pidtune_change_p(gains, axis, -1, (d_skipped != null ? d_skipped + "; " : "") + os_text + " больше " + rules.overshoot_high_pct +
                                " % → P −" + Math.round(rules.gain_step * 100) + " %", rules)
    }
    if (d_skipped != null) {
        return keep(d_skipped)
    }
    if (os < rules.overshoot_low_pct) {
        return pidtune_change_p(gains, axis, 1, os_text + " меньше " + rules.overshoot_low_pct + " %, колебаний нет — отклик вялый, запас есть → P +" +
                                Math.round(rules.gain_step * 100) + " %", rules)
    }
    return keep(os_text + " — от " + rules.overshoot_low_pct + " до " + rules.overshoot_high_pct + " %, колебаний нет — менять нечего")
}
