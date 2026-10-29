// Шаг 4 «PID по осям»: измеренный отклик контура скорости (КИХ МНК во времени), проверки качества измерения, метрики
// отклика, шум D, режим лога и правила ATC_RAT_*_P/I/D; модель регулятора AC_PID, прогноз вариантов из измеренной
// характеристики «цель → факт», его достоверность, варианты и отметки. Без DOM: работает в браузере и под Node (тесты).
// Дизайн — docs/plans/2026-10-25-tune-wizard-stage4-design.md, разделы 3–4; план — …-stage4.md, задачи 5–6.
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
// Измерение ненадёжно, если не пройдена любая из трёх проверок (pidtune_quality; в Acro «Rate Loop Only» — (а) и (б),
// (в) не применяется). Главная беда обычного полёта: в Acro при ATC_RATE_FF_ENAB = 0 цель скорости выше 4–5 Гц
// формирует угловой контур из самого факта, и «цель → факт» там показывает обратную величину углового контура (|T|
// растёт с частотой, фаза около −90°). Точно мастер считает тестовый полёт Acro с ACRO_OPTIONS «Rate Loop Only»
// (pidtune_log_mode) — решение пользователя 25.10.2026.
//
// Прогноз (раздел 4 дизайна) — из измеренной T («цель → факт», FFT импульсной характеристики КИХ), а не из оценки
// объекта «выход → факт»: та по замкнутому контуру смещена (P_H1 = ρ·P − (1 − ρ)/C, ρ — когерентность «цель → ошибка»,
// на логе пользователя 0.52–0.87, а для 10 % на частоте среза нужно ρ ≥ 0.9). Объект вместе с фильтрами гироскопа
// лога выражается через T и модель регулятора лога, новый вариант — через отношение регуляторов и фильтров
// (pidtune_predict). Для коэффициентов лога прогноз совпадает с измеренным по построению, поэтому достоверность
// проверяется отдельно (pidtune_validity): качество измерения, сверка модели регулятора с данными, когерентность.
// На синтетике (условия как у лога, исследование): ошибка перерегулирования до 2.8 пункта при P +30 %, изменение
// перерегулирования для P ±10 % и D ±10 % — в пределах ±1.5 пункта, запас фазы ±5°. Через этот модуль на синтетике
// rate-only (задача 6, против прямой симуляции вариантов P ±10 %, D ±10 %, P +30 %): при частых резких манёврах
// (тестовый полёт) — до 0.2 пункта и 0.6°, при редких манёврах и сильной турбулентности — до 2.9 пункта и 3°.
//
// Нужны глобалы страницы: FFTJS (modules/fft.js), Libraries/fft.js (hanning), Libraries/Array_Math.js (exp_jw,
// complex_inverse, complex_square), US2S (core/log.js), find_start_index и find_end_index (core/gyro.js), load_filters
// и filter_transfer (core/filters.js), candidate_key (core/candidates.js), pid_lowpass_response (core/lowpass.js),
// PID_STEP_MIN_RATE и PID_STEP_RATE_MARGIN (core/pid.js).

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
    // Предлагаемые значения (правила и варианты) — 4 значащие цифры: 0.12793 → 0.1279, 0.002637 → 0.002637; I по
    // правилу — от уже округлённого P [наше, решение координатора по ревью задачи 5: правило давало 0.12793000000000002]
    round_digits: 4,
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
    // Отметки прогноза варианта (решение пользователя 25.10.2026): запас фазы ниже pm_min_deg, хуже прогноза лога
    // больше чем на pm_max_drop_deg, перерегулирование в прогнозе выше overshoot_pred_max_pct. Выбор не блокируют
    pm_min_deg: 30,
    pm_max_drop_deg: 5,
    overshoot_pred_max_pct: 20,
    // Достоверность прогноза: когерентность γ² «цель → факт» на частоте среза лога не меньше [наше]. На логе пользователя
    // на частоте среза по T (окно 512): 49–540 с — 0.48 / 0.55 / 0.84 (крен, тангаж, рыскание), 80–464 с — 0.29 / 0.58 /
    // 0.80 (окно 1024 — в пределах 0.03 от этих); синтетика rate-only — 0.94–0.96
    coherence_min: 0.5,
    // Сверка модели регулятора с данными на band_hz: ||C_изм / C_мод| − 1| ≤ mag_err_max и |∠| ≤ phase_err_max_deg,
    // окна Ханна window с шагом window_step (1/16 окна, как у отклика PIDReview) [наше]. Модель на логе пользователя
    // (49–540 и 80–464 с, все оси): модуль до 0.031, фаза до 1.2°, γ² ≥ 0.993; в исследовании в точках 2/5/10/20 Гц —
    // 0.95–1.05 и не больше 3°
    controller_check: { band_hz: [2, 20], mag_err_max: 0.1, phase_err_max_deg: 10, window: 1024, window_step: 64 },
    // Шаг сетки частот прогноза, Гц: FFT импульсной характеристики КИХ, дополненной нулями до степени двойки не меньше
    // частота / шаг (4096 точек — 10.24 с при 400 Гц: хвост отклика за это время не заворачивается в первые 0.5 с) [наше]
    predict_resolution_hz: 0.1,
    // Частота среза ищется не ниже, Гц: ниже |L| велико из-за интеграторов регулятора и объекта, а оценка T там шумит
    // [наше, исследование]
    crossover_min_hz: 0.5,
    // Запас фазы первого пересечения по модулю больше — развёртка фазы недостоверна: точка отсчёта на crossover_min_hz
    // попала не на ту ветвь (шум оценки T на низких частотах при малых данных), pm_deg null с причиной (pm_note) [наше,
    // аудит области D: лог пользователя 200–205 с давал +400°, синтетика с фазой L +10° на 0.5 Гц — −282° при правде 78°]
    pm_abs_max_deg: 180,
    // Прогноз неустойчив, если доля энергии его импульсной характеристики в последней четверти буфера обратного FFT
    // (отрицательное время) больше [наше]. Синтетика rate-only (три сценария, три объекта, два зерна): у вариантов ±10 %
    // не больше 1e-13, у I = 0 — до 3e-5, у D ×5 вялого объекта при редких манёврах — до 5e-4; у неустойчивых по правде —
    // 0.42–1. Срабатывает и у устойчивых по правде вариантов с ненадёжным прогнозом — D ×5…×6 при редких манёврах или
    // турбулентности, P ×2.5…×3 на грани устойчивости (0.003–0.34): отказ при сомнении. Устойчивый, но звенящий дольше
    // 3/4 буфера (7.7 с при 400 Гц) контур тоже отмечается — на практике то же самое
    noncausal_max: 1e-3,
    // Поправка фильтров гироскопа в прогнозе — полностью до gyro_ratio_full_x × частоты среза лога (не выше половины
    // частоты Найквиста), выше — плавно (приподнятый косинус) к 1 к частоте Найквиста лога [наше, задача 8: замер на
    // логе пользователя — pidtune_predict]. Infinity — без сглаживания
    gyro_ratio_full_x: 5,
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
// → { segments: [{ start_time, tar, act (Float64Array, °/с), starts: [начала окон внутри отрезка], batch (номер пакета
// в axis.sets[set_index]), begin (первый отсчёт отрезка в пакете) }], rate_hz, windows,
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
    const batches = axis.sets[set_index]
    for (let b = 0; b < batches.length; b++) {
        const batch = batches[b]
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
                            act: Float64Array.from(batch.Act.slice(begin, end)), starts: own, batch: b, begin: begin })
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
// длина fir_length_s·rate_hz отводов. У оси RATE цель — RDes до FLTT (у PIDx — после), поэтому отклик по RATE включает
// FLTT и немного медленнее настоящего (первый порядок 20 Гц, по умолчанию, — ≈ 8 мс на низких частотах): вердикт
// шага говорит об этом; прогноза по RATE нет (pidtune_controller_check, pidtune_validity).
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

// Суммы взаимных спектров по окнам: pieces — [{ [x_key], [y_key] (массивы отсчётов), starts: [начала окон] }], окно
// Ханна длиной N, бины k0…k1 (realTransform FFTJS: k ≤ N/2). → { yx_re, yx_im — Σ Y·conj(X), xx — Σ |X|², yy — Σ |Y|²
// (Float64Array, элемент k − k0), count — число окон }
function pidtune_spectra(pieces, x_key, y_key, N, k0, k1) {
    const fft = new FFTJS(N)
    const w = hanning(N)
    const xw = new Float64Array(N)
    const yw = new Float64Array(N)
    const X = fft.createComplexArray()
    const Y = fft.createComplexArray()
    const len = Math.max(0, k1 - k0 + 1)
    const yx_re = new Float64Array(len)
    const yx_im = new Float64Array(len)
    const xx = new Float64Array(len)
    const yy = new Float64Array(len)
    let count = 0
    for (const piece of pieces) {
        const x = piece[x_key]
        const y = piece[y_key]
        for (const s of piece.starts) {
            for (let i = 0; i < N; i++) {
                xw[i] = x[s + i] * w[i]
                yw[i] = y[s + i] * w[i]
            }
            fft.realTransform(X, xw)
            fft.realTransform(Y, yw)
            for (let k = k0; k <= k1; k++) {
                const xr = X[2 * k]
                const xi = X[2 * k + 1]
                const yr = Y[2 * k]
                const yi = Y[2 * k + 1]
                yx_re[k - k0] += yr * xr + yi * xi
                yx_im[k - k0] += yi * xr - yr * xi
                xx[k - k0] += xr * xr + xi * xi
                yy[k - k0] += yr * yr + yi * yi
            }
            count++
        }
    }
    return { yx_re: yx_re, yx_im: yx_im, xx: xx, yy: yy, count: count }
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
    const S = pidtune_spectra(segments, "tar", "act", N, k0, k1)
    if (S.count == 0) {
        return null
    }
    let value = -Infinity
    let freq_hz = null
    for (let k = k0; k <= k1; k++) {
        const t = Math.hypot(S.yx_re[k - k0], S.yx_im[k - k0]) / S.xx[k - k0]
        if (t > value) {
            value = t
            freq_hz = k * rate_hz / N
        }
    }
    return { value: value, freq_hz: freq_hz }
}

// Когерентность «цель → факт» γ² = |S_ar|² / (S_rr·S_aa) на частоте freq_hz по отобранным окнам отрезков (окно Ханна
// rules.window, как у pidtune_outer_peak), линейная интерполяция между соседними бинами.
// → γ² | null — нет окон, частота не число или вне 0…rate_hz/2
function pidtune_coherence(segments, rate_hz, freq_hz, rules = pidtune_rules) {
    const N = rules.window
    const pos = freq_hz * N / rate_hz
    if ((segments == null) || !Number.isFinite(freq_hz) || !(pos >= 0) || !(pos <= N / 2)) {
        return null
    }
    const k0 = Math.min(Math.floor(pos), N / 2 - 1)
    const S = pidtune_spectra(segments, "tar", "act", N, k0, k0 + 1)
    if (S.count == 0) {
        return null
    }
    const coh = (i) => (S.yx_re[i] ** 2 + S.yx_im[i] ** 2) / (S.xx[i] * S.yy[i])
    const a = pos - k0
    return (1 - a) * coh(0) + a * coh(1)
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
                  pidtune_beyond(ridge, q.ridge_rms_max, 3) + " (порог " + q.ridge_rms_max + ")")
        }
        if (!checks.halves.ok) {
            reasons.push((halves == null) ? "половины данных не посчитались"
                : "половины данных дают разный отклик: RMS " + pidtune_beyond(halves, q.halves_rms_max, 3) + " (порог " + q.halves_rms_max + ") — режим " +
                  "или объект менялись в интервале, или данных мало")
        }
        if (outer_applied && !checks.outer.ok) {
            reasons.push((outer == null) ? "подпись углового контура не посчиталась"
                : "подпись углового контура: |цель → факт| до " + pidtune_beyond(outer.value, q.outer_t_max, 2) + " на " + outer.freq_hz.toFixed(1) + " Гц (порог " +
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

// Участки режимов полёта в интервале range = [t0, t1] по сообщениям MODE (поле Mode): действующий на t0 (последний
// MODE не позже t0) — с t0, каждый MODE внутри (t0 < t < t1) открывает новый участок, последний — до t1; подряд один
// и тот же режим (повторная запись ACRO) — один участок. Режим до первого MODE неизвестен — участка нет. MODE ровно
// на t1 участка не даёт: его длительность в интервале нулевая (и кнопка «Интервал — участок ACRO» шага 4 ставит
// конец интервала на целую секунду не позже смены режима). → [{ mode (номер), start, end (с) }] по времени; [] — нет MODE
function pidtune_mode_segments(log, range) {
    if ((log == null) || !("MODE" in log.messageTypes)) {
        return []
    }
    const time = log.get("MODE", "TimeUS")
    const mode = log.get("MODE", "Mode")
    if ((time == null) || (mode == null)) {
        return []
    }
    let current = null
    const inner = []
    for (let i = 0; i < time.length; i++) {
        const t = time[i] * US2S
        if (t <= range[0]) {
            current = mode[i]
        } else if (t < range[1]) {
            inner.push([mode[i], t])
        }
    }
    const segments = []
    const open = (m, t) => {
        const last = segments[segments.length - 1]
        if (last != null) {
            if (last.mode == m) {
                return
            }
            last.end = t
        }
        segments.push({ mode: m, start: t, end: range[1] })
    }
    if (current != null) {
        open(current, range[0])
    }
    for (const [m, t] of inner) {
        open(m, t)
    }
    return segments
}

// Номера режимов полёта в интервале range (pidtune_mode_segments): без повторов, в порядке появления. [] — нет MODE
function pidtune_modes_in(log, range) {
    const out = []
    for (const segment of pidtune_mode_segments(log, range)) {
        if (!out.includes(segment.mode)) {
            out.push(segment.mode)
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
//   rate_only_segment — { start, end } (с): лог тестового полёта с интервалом шире него (взлёт и посадка в STABILIZE,
//             LAND — интервал по умолчанию у полёта с газом): режимы смешаны, не rate_only, а самый длинный участок ACRO
//             (pidtune_mode_segments, в границах интервала) с битом acro_rate_only_bit в каждом действующем на нём
//             ACRO_OPTIONS — сужение интервала до него даст rate_only; иначе null (и когда участка ACRO нет вовсе —
//             полёт в STABILIZE с выставленным битом) [аудит области D];
//   i_scale — множитель I регулятора (update_all, i_scale): ATC_ANG_*_P оси (значение в конце интервала) при rate_only
//             и версии не ниже i_scale_since (4.7), иначе 1;
//   firmware — pidtune_firmware(log, version); low_rate — rate_hz ниже min_log_rate_hz (отклик не считается);
//   warnings — что не удалось определить (версия, ATC_ANG_*_P при rate_only — тогда i_scale 1) и ACRO_TRAINER ≠ 0 при
//             rate_only: тренер подмешивает в цель скорости выравнивание по углу и в Rate Loop Only [код,
//             ArduCopter/mode_acro.cpp, get_pilot_desired_rates_rads — вызывается до ветвления по RATE_LOOP_ONLY],
//             цель — не чистая команда пилота.
// params — log_params (core/log.js), version — get_version_and_board (state.version), rate_hz — pidtune_segments
function pidtune_log_mode(log, params, version, range, axis_name, rate_hz, rules = pidtune_rules) {
    const warnings = []
    const segments = pidtune_mode_segments(log, range)
    const numbers = []
    for (const segment of segments) {
        if (!numbers.includes(segment.mode)) {
            numbers.push(segment.mode)
        }
    }
    const modes = numbers.map((m) => pidtune_mode_names[m] ?? ("режим " + m))
    const bit_set = (values) => (values.length > 0) && values.every((v) => (v & rules.acro_rate_only_bit) != 0)
    const options = pidtune_param_values(params, "ACRO_OPTIONS", range)
    const rate_only = (numbers.length > 0) && numbers.every((m) => m == rules.acro_mode) && bit_set(options)

    // Самый длинный участок ACRO смешанного интервала, на котором ACRO_OPTIONS с битом Rate Loop Only
    let rate_only_segment = null
    if (!rate_only && (numbers.length > 1)) {
        const acro = segments.filter((s) => s.mode == rules.acro_mode)
        if (acro.length > 0) {
            const longest = acro.reduce((a, b) => ((b.end - b.start) > (a.end - a.start)) ? b : a)
            if (bit_set(pidtune_param_values(params, "ACRO_OPTIONS", [longest.start, longest.end]))) {
                rate_only_segment = { start: longest.start, end: longest.end }
            }
        }
    }

    const firmware = pidtune_firmware(log, version)
    let i_scale = 1
    if (rate_only) {
        const trainer = [...new Set(pidtune_param_values(params, "ACRO_TRAINER", range).filter((v) => v != 0))]
        if (trainer.length > 0) {
            warnings.push("ACRO_TRAINER = " + trainer.join(", ") + " (не 0): тренер Acro подмешивает в цель скорости выравнивание по углу и в Rate Loop " +
                          "Only (mode_acro.cpp, get_pilot_desired_rates_rads) — цель не чистая команда пилота, измерение может быть искажено; для " +
                          "тестового полёта ставьте ACRO_TRAINER = 0")
        }
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
        rate_only_segment: rate_only_segment,
        i_scale: i_scale,
        firmware: firmware,
        low_rate: (rate_hz != null) && (rate_hz < rules.min_log_rate_hz),
        warnings: warnings,
    }
}

// Предлагаемое значение коэффициента: round_digits значащих цифр (0.12793000000000002 → 0.1279). 0 и нечисловое — как есть
function pidtune_round(value, rules = pidtune_rules) {
    return (Number.isFinite(value) && (value != 0)) ? Number(value.toPrecision(rules.round_digits)) : value
}

// Число для текста причины рядом с порогом limit: digits знаков после запятой. Обычное округление, а если оно попадает
// на порог или за него — округление от порога (ниже порога — вниз, выше — вверх): 29.99 при пороге 30 — «29.9° ниже
// 30°», а не «30.0°», 20.01 при пороге 20 — «20.1 % выше 20 %» [наше, ревью задачи 6]. Допуск 1e-9 — от двоичного
// округления (0.43·100 = 43.00000000000001)
function pidtune_beyond(value, limit, digits) {
    const text = value.toFixed(digits)
    const shown = Number(text)
    if (((value < limit) && (shown >= limit)) || ((value > limit) && (shown <= limit))) {
        const scale = 10 ** digits
        const rounded = (value < limit) ? Math.floor(value * scale + 1e-9) : Math.ceil(value * scale - 1e-9)
        return (rounded / scale).toFixed(digits)
    }
    return text
}

// Изменение коэффициента словами с фактическим процентом: «+5.3 %», «−20.0 %» (ограниченное пределом правило говорит
// «P +10 %», а даёт меньше — число в причине [аудит области D, M-9]). От нуля (или нечислового) процент не определён —
// «—», а не «+Infinity %»
function pidtune_percent_text(from, to) {
    const pct = (to - from) / from * 100
    if (!Number.isFinite(pct)) {
        return "—"
    }
    return ((pct < 0) ? "−" : "+") + Math.abs(pct).toFixed(1) + " %"
}

// Изменение P на sign·gain_step с пределами AutoTune; I по правилу: крен и тангаж — I = P [wiki, Manual tuning:
// «Each time the P term is changed set the I term equal to the P term»], рыскание — I = yaw_i_ratio·P [код].
// P округляется (pidtune_round) до пределов, I считается от округлённого P и тоже округляется.
// Предел, не давший сдвинуть P в нужную сторону (P уже на пределе) или развернувший изменение (P 2.5 и «P +10 %» →
// 2.0, P 0.005 и «P −10 %» → 0.01), — без изменений, limited true; предел, урезавший шаг (P 1.9 и «P +10 %» → 2.0), —
// в причине фактический процент («ограничено: … — фактически +5.3 %»)
function pidtune_change_p(gains, axis, sign, reason, rules) {
    const target = pidtune_round(gains.P * (1 + sign * rules.gain_step), rules)
    const P = Math.min(rules.p_max, Math.max(rules.p_min, target))
    const limited = (P != target)
    const limit_text = "предел AutoTune P " + rules.p_min + "…" + rules.p_max
    if ((P - gains.P) * sign <= 0) {
        const why = (P == gains.P) ? "P уже на пределе"
            : "P = " + gains.P + " вне пределов: ограничение " + ((sign > 0) ? "уменьшило бы P вместо увеличения" : "увеличило бы P вместо уменьшения")
        return { change: null, reason: reason + "; " + why + " (" + limit_text + ") — без изменений", values: { P: gains.P, I: gains.I, D: gains.D }, limited: true }
    }
    const I = (axis == "yaw") ? pidtune_round(rules.yaw_i_ratio * P, rules) : P
    return { change: (sign > 0) ? "P+" : "P-", reason: reason + (limited ? " (ограничено: " + limit_text + " — фактически P " + pidtune_percent_text(gains.P, P) + ")" : ""),
             values: { P: P, I: I, D: gains.D }, limited: limited }
}

// Предложение по правилам (раздел 3 дизайна). Без изменений (change null, причина), по порядку: P или I нет в логе
// (не число); отобранных данных меньше min_data_s — «мало манёвров» (раньше качества: на коротком полёте причина —
// данные, а не проверки); измерение ненадёжно (quality.ok ложно); нет метрик. По оси RATE метрики включают FLTT
// (pidtune_fir) — правила те же. Иначе одно изменение на коэффициент за проход, правила по порядку:
//   1. остаточные колебания (metrics.osc): частота выше osc_band_ratio полос отклика (bandwidth_hz) — «высокие» → D −10 %,
//      не выше — «низкие» → P −10 %. При D = 0 (или D нет) правило для D не применяется — дальше по правилам;
//   2. перерегулирование больше overshoot_high_pct → P −10 %;
//   3. перерегулирование меньше overshoot_low_pct и колебаний нет — отклик вялый → P +10 % [wiki: P поднимают
//      до раскачки, затем отступают; пороги — наше];
//   4. иначе — менять нечего.
// gains = { P, I, D } лога, axis — "roll", "pitch", "yaw", metrics — pidtune_step_metrics, data_s — секунды отобранных
// данных (pidtune_segments), quality — pidtune_quality. Пределы AutoTune: P в p_min…p_max, D ≤ d_max
// (pidtune_change_p). Изменённые значения — round_digits значащих цифр (pidtune_round), I — от округлённого P.
// → { change: "P-" | "P+" | "D-" | null, reason, values: { P, I, D }, limited } (change null — values как в логе)
function pidtune_rule(gains, axis, metrics, data_s, quality, rules = pidtune_rules) {
    const keep = (reason, limited = false) => ({ change: null, reason: reason, values: { P: gains.P, I: gains.I, D: gains.D }, limited: limited })
    const missing = ["P", "I"].filter((k) => !Number.isFinite(gains[k])).map((k) => pidtune_axes[axis].rate + k)
    if (missing.length > 0) {
        return keep("нет коэффициента в логе: " + missing.join(", "))
    }
    if (!(data_s >= rules.min_data_s)) {
        return keep("мало манёвров: отобранных данных (окна с целью больше " + rules.target_min_dps + " °/с) " + pidtune_beyond(data_s ?? 0, rules.min_data_s, 1) +
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
    // Числа у порога — с округлением от него (pidtune_beyond)
    const os_text = (limit) => "перерегулирование " + ((limit != null) ? pidtune_beyond(os, limit, 1) : os.toFixed(1)) + " %"
    const osc = metrics.osc
    let d_skipped = null
    if (osc != null) {
        const amplitude = ", размах " + osc.amplitude_pp.toFixed(2)
        if (metrics.bandwidth_hz == null) {
            return keep("колебания " + osc.freq_hz.toFixed(1) + " Гц" + amplitude + ", а время нарастания не определено — частоту не с чем сравнить")
        }
        const limit = rules.osc_band_ratio * metrics.bandwidth_hz
        const osc_text = "колебания " + pidtune_beyond(osc.freq_hz, limit, 1) + " Гц" + amplitude
        const band_text = rules.osc_band_ratio + " полос отклика (" + limit.toFixed(1) + " Гц)"
        if (osc.freq_hz > limit) {
            if (Number.isFinite(gains.D) && (gains.D > 0)) {
                const target = pidtune_round(gains.D * (1 - rules.gain_step), rules)
                const D = Math.min(rules.d_max, target)
                const limited = (D != target)
                return { change: "D-", reason: "высокие " + osc_text + " — выше " + band_text + " → D −" + Math.round(rules.gain_step * 100) + " %" +
                         (limited ? " (ограничено: предел AutoTune D ≤ " + rules.d_max + " — фактически D " + pidtune_percent_text(gains.D, D) + ")" : ""),
                         values: { P: gains.P, I: gains.I, D: D }, limited: limited }
            }
            d_skipped = "высокие " + osc_text + " — выше " + band_text + ", но D " + (Number.isFinite(gains.D) ? "выключен (D = 0)" : "нет в логе") +
                        " — правило для D не применяется"
        } else {
            return pidtune_change_p(gains, axis, -1, "низкие " + osc_text + " — не выше " + band_text + " → P −" + Math.round(rules.gain_step * 100) + " %", rules)
        }
    }
    if (os > rules.overshoot_high_pct) {
        return pidtune_change_p(gains, axis, -1, (d_skipped != null ? d_skipped + "; " : "") + os_text(rules.overshoot_high_pct) + " больше " + rules.overshoot_high_pct +
                                " % → P −" + Math.round(rules.gain_step * 100) + " %", rules)
    }
    if (d_skipped != null) {
        return keep(d_skipped)
    }
    if (os < rules.overshoot_low_pct) {
        return pidtune_change_p(gains, axis, 1, os_text(rules.overshoot_low_pct) + " меньше " + rules.overshoot_low_pct + " %, колебаний нет — отклик вялый, запас есть → P +" +
                                Math.round(rules.gain_step * 100) + " %", rules)
    }
    return keep(os_text(null) + " — от " + rules.overshoot_low_pct + " до " + rules.overshoot_high_pct + " %, колебаний нет — менять нечего")
}

// ---------- Модель регулятора, прогноз, варианты и отметки (раздел 4 дизайна) ----------

// Регулятор C(f) — модель AC_PID::update_all (libraries/AC_PID/AC_PID.cpp) на частоте контура loop_rate
// (SCHED_LOOP_RATE); вход — ошибка «цель − факт», рад/с (как у AC_PID), выход — нормированный (как P + I + D в PIDx) [код]:
//   C = H_FLTE·(Kp + Ki·i_scale·dt / (1 − z⁻¹) + Kd·(1 − z⁻¹) / dt·H_FLTD),  z = e^(j·2π·f / loop_rate),  dt = 1 / loop_rate.
// FLTE — на ошибке (действует на P, I и D); производная — (_error − error_last) / dt, на ней FLTD; интегратор
// _integrator += _error·Ki·i_scale·dt обновляется в том же такте, что и выход (update_i), — без задержки z⁻¹.
// Фильтры первого порядка — pid_lowpass_response (core/lowpass.js), как на шаге 3. i_scale — множитель I (update_all):
// ATC_ANG_*_P в Acro «Rate Loop Only» с Copter 4.7 (pidtune_log_mode), иначе 1.
// FF — прямая связь с цели вне контура (get_ff = _pid_info.FF + DFF): FF = Kff + Kdff·(1 − z⁻¹) / dt от цели после
// FLTT (поле Tar в PIDx); прогноз вычитает её из измеренной T (раздел 7 дизайна: FF ≠ 0 учитывается в T).
// Не моделируются: notch ошибки и цели (NEF, NTF), ограничитель SMAX (Dmod), PDMX, pd_scale, IMAX и остановка
// интегратора при насыщении моторов (limit).
// gains = { P, I, D, FF, DFF }: P, I, D не числа — NaN в C; FF и DFF необязательны (null, undefined — 0). i_scale не
// число (в том числе null) — NaN в C (отказ при сомнении), а не регулятор без I.
// filters = { flte, fltd } — Гц (0 — без фильтра, нечисловые — NaN в C); freq — частоты, Гц. На 0 Гц при ki ≠ 0
// интегратор бесконечен — C = [Infinity, 0] (нечисловое в коэффициентах или фильтрах — NaN): предел отношения двух
// регуляторов — отношение ki (берёт pidtune_predict).
// → { freq, C: [re[], im[]], FF: [re[], im[]], ki: Ki·i_scale, loop_rate } (комплексные массивы как в Libraries/Array_Math.js)
function pidtune_controller(gains, filters, loop_rate, freq, i_scale = 1) {
    const num = (v) => (typeof v === "number") ? v : NaN
    const dt = 1 / loop_rate
    const kp = num(gains.P)
    const ki = num(gains.I) * num(i_scale)
    const kd = num(gains.D)
    const kff = gains.FF ?? 0
    const kdff = gains.DFF ?? 0
    const n = freq.length
    const C = [new Array(n), new Array(n)]
    const FF = [new Array(n), new Array(n)]
    for (let k = 0; k < n; k++) {
        const f = freq[k]
        const w = 2 * Math.PI * f / loop_rate
        // 1 − z⁻¹ = 2·sin²(w/2) + j·sin w (не 1 − cos w: на низких частотах вычитание теряет точность)
        const ar = 2 * Math.sin(w / 2) ** 2
        const ai = Math.sin(w)
        FF[0][k] = kff + kdff / dt * ar
        FF[1][k] = kdff / dt * ai
        // Kp + Kd·(1 − z⁻¹) / dt·H_FLTD
        const hd = pid_lowpass_response(filters.fltd, loop_rate, f)
        const he = pid_lowpass_response(filters.flte, loop_rate, f)
        let sr = kp + kd / dt * (ar * hd[0] - ai * hd[1])
        let si = kd / dt * (ar * hd[1] + ai * hd[0])
        // + ki·dt / (1 − z⁻¹); при ki = 0 интегратора нет (update_i обнуляет его)
        if (ki != 0) {
            const ad = ar * ar + ai * ai
            if (ad == 0) {
                // 0 Гц: интегратор бесконечен; нечисловое в коэффициентах или фильтрах — NaN, как на других частотах
                C[0][k] = Number.isNaN(sr + si + ki + he[0] + he[1]) ? NaN : Infinity
                C[1][k] = 0
                continue
            }
            sr += ki * dt * ar / ad
            si -= ki * dt * ai / ad
        }
        C[0][k] = sr * he[0] - si * he[1]
        C[1][k] = sr * he[1] + si * he[0]
    }
    return { freq: freq, C: C, FF: FF, ki: ki, loop_rate: loop_rate }
}

// Есть ли у набора set_index оси компоненты регулятора P, I, D (сообщения PIDR/PIDP/PIDY). У оси RATE их нет:
// цель RDes записана до FLTT, выход ROut — вместе с FF (AC_AttitudeControl_Logging.cpp) — прогноз по ней не считается
function pidtune_has_components(axis, set_index) {
    const batches = axis?.sets?.[set_index]
    return (batches != null) && (batches.length > 0) && batches.every((b) => (b.P != null) && (b.I != null) && (b.D != null))
}

// Сверка модели регулятора с данными лога (достоверность прогноза, раздел 4 дизайна): C_изм = S_oe / S_ee — выход
// регулятора по ошибке, суммы взаимных спектров (pidtune_spectra) окон controller_check.window с шагом window_step,
// отобранных как отрезки КИХ (pidtune_segments: центр окна в range, max |цель·Ханн| ≥ target_min_dps). Ошибка
// e = Tar − Act (до FLTE: он в модели) — в рад/с, выход o = P + I + D (FF и DFF — с цели, вне контура). Модель —
// pidtune_controller(gains, filters, loop_rate, частоты бинов, i_scale) с коэффициентами и фильтрами лога. На бинах
// band_hz отношение r = C_изм / C_мод: ошибка модуля ||r| − 1|, фазы |∠r|; проходит, если наибольшие не больше
// mag_err_max и phase_err_max_deg [наше]. Нечисловое отношение — не проходит.
// У оси без компонент регулятора (RATE, pidtune_has_components) сверка не запускается: цель RDes — до FLTT, выход ROut —
// с FF, и при FLTT 20 Гц (по умолчанию) модель «не сходилась» бы всегда (ревью задачи 6: модуль 0.32, фаза 42°) —
// skipped "rate", pidtune_validity называет настоящую причину.
// → { ok, max_mag_err, max_phase_err_deg, worst_hz (бин наибольшей ошибки относительно порогов), min_coherence
// (наименьшая γ² «ошибка → выход» на полосе), windows, skipped: null | "rate" } — RATE, нет данных, окон или бинов
// полосы: ok false, числа null
function pidtune_controller_check(axis, set_index, range, gains, filters, loop_rate, i_scale = 1, rules = pidtune_rules) {
    const cc = rules.controller_check
    const fail = (windows, skipped = null) => ({ ok: false, max_mag_err: null, max_phase_err_deg: null, worst_hz: null, min_coherence: null,
                                                 windows: windows, skipped: skipped })
    if ((axis != null) && axis.have_data && (axis.sets?.[set_index] != null) && !pidtune_has_components(axis, set_index)) {
        return fail(0, "rate")
    }
    const seg = pidtune_segments(axis, set_index, range, { ...rules, window: cc.window, window_step: cc.window_step })
    if ((seg == null) || (seg.windows == 0)) {
        return fail(0)
    }
    const N = cc.window
    const k0 = Math.max(1, Math.ceil(cc.band_hz[0] * N / seg.rate_hz))
    const k1 = Math.min(N / 2, Math.floor(cc.band_hz[1] * N / seg.rate_hz))
    if (k1 < k0) {
        return fail(seg.windows)
    }

    // Ошибка (рад/с) и выход регулятора на отсчётах отрезков
    const batches = axis.sets[set_index]
    const pieces = seg.segments.map((s) => {
        const batch = batches[s.batch]
        const n = s.tar.length
        const e = new Float64Array(n)
        const o = new Float64Array(n)
        for (let i = 0; i < n; i++) {
            const j = s.begin + i
            e[i] = (s.tar[i] - s.act[i]) * Math.PI / 180
            o[i] = batch.P[j] + batch.I[j] + batch.D[j]
        }
        return { e: e, o: o, starts: s.starts }
    })
    const S = pidtune_spectra(pieces, "e", "o", N, k0, k1)

    const freq = []
    for (let k = k0; k <= k1; k++) {
        freq.push(k * seg.rate_hz / N)
    }
    const model = pidtune_controller(gains, filters, loop_rate, freq, i_scale).C
    let max_mag_err = 0
    let max_phase_err_deg = 0
    let min_coherence = Infinity
    let worst = -1
    let worst_hz = null
    for (let i = 0; i < freq.length; i++) {
        // C_изм = S_oe / S_ee, r = C_изм / C_мод
        const mr = S.yx_re[i] / S.xx[i]
        const mi = S.yx_im[i] / S.xx[i]
        const cr = model[0][i]
        const ci = model[1][i]
        const d = cr * cr + ci * ci
        const rr = (mr * cr + mi * ci) / d
        const ri = (mi * cr - mr * ci) / d
        const mag_err = Math.abs(Math.hypot(rr, ri) - 1)
        const phase_err = Math.abs(Math.atan2(ri, rr)) * 180 / Math.PI
        // Math.max и Math.min сохраняют NaN — нечисловое отношение не проходит
        max_mag_err = Math.max(max_mag_err, mag_err)
        max_phase_err_deg = Math.max(max_phase_err_deg, phase_err)
        min_coherence = Math.min(min_coherence, (S.yx_re[i] ** 2 + S.yx_im[i] ** 2) / (S.xx[i] * S.yy[i]))
        const relative = Math.max(mag_err / cc.mag_err_max, phase_err / cc.phase_err_max_deg)
        if (!(relative <= worst)) {
            worst = relative
            worst_hz = freq[i]
        }
    }
    return {
        ok: (max_mag_err <= cc.mag_err_max) && (max_phase_err_deg <= cc.phase_err_max_deg),
        max_mag_err: max_mag_err,
        max_phase_err_deg: max_phase_err_deg,
        worst_hz: worst_hz,
        min_coherence: min_coherence,
        windows: seg.windows,
        skipped: null,
    }
}

// Поправка фильтров гироскопа (раздел 4 дизайна): G_new / G_log — отношение передаточных функций цепочки фильтров
// new_values и old_values (значения load_filters: INS_GYRO_FILTER, INS_HNTCH_*, INS_HNTC2_*; новые — принятые на шагах
// 2–3, старые — лога) на частотах freq. Act — отфильтрованный гироскоп, по нему и работает регулятор, поэтому объект
// «выход → факт» меняется ровно в это отношение. gyro_ctx = { gyro, env, tracking, range, sensor } (как base шага 3:
// sensor — индекс экземпляра, трекинг интерполирован к окнам FFT). H — filter_transfer на exp_jw(freq,
// FFT.average_sample_rate) по окнам FFT экземпляра до конца интервала (с первого окна: индексы окон — те же, что
// у трекинга, как в lowpass_bode); поправка — отношение средних mean(H_new) / mean(H_old) по окнам интервала
// (комплексных). У статических фильтров H во всех окнах одна, и это просто H_new / H_old. Где notch движется, окна
// различаются около его частот, а там |L| мало, T ≈ L пропорциональна G, и КИХ, подобранный по всем окнам, — это T
// при среднем G: усреднённая T масштабируется средним G, а не средним отношением. Отношение средних ещё и устойчиво
// к окнам, где H_old ≈ 0 (глубокий notch точно на частоте сетки), — среднее отношений там взрывается [наше].
// Одинаковые наборы (candidate_key) — ровно 1 без расчёта (и без данных гироскопа).
// → [re[], im[]] | null — нет экземпляра, FFT или окон гироскопа: прогноз без поправки
function pidtune_gyro_ratio(old_values, new_values, gyro_ctx, freq) {
    const n = freq.length
    if (candidate_key(old_values) == candidate_key(new_values)) {
        return [new Array(n).fill(1), new Array(n).fill(0)]
    }
    const gyro = gyro_ctx?.gyro
    const index = gyro_ctx?.sensor
    if ((gyro == null) || (gyro[index] == null) || (gyro[index].FFT == null) || (gyro[index].FFT.time == null) ||
        (gyro[index].FFT.time.length == 0)) {
        return null
    }
    const FFT = gyro[index].FFT
    const start = find_start_index(FFT.time, gyro_ctx.range)
    const end = find_end_index(FFT.time, gyro_ctx.range) + 1
    if (end <= start) {
        return null
    }
    const Z = exp_jw(freq, FFT.average_sample_rate)
    const Z1 = complex_inverse(Z)
    const Z2 = complex_inverse(complex_square(Z))
    const time = FFT.time.slice(0, end)
    const rate = FFT.average_sample_rate
    const H_old = filter_transfer(load_filters(old_values, gyro_ctx.env, gyro_ctx.tracking), index, time, rate, Z1, Z2)
    const H_new = filter_transfer(load_filters(new_values, gyro_ctx.env, gyro_ctx.tracking), index, time, rate, Z1, Z2)
    // Суммы H по окнам интервала (на число окон отношение средних не зависит)
    const sum_new = [new Array(n).fill(0), new Array(n).fill(0)]
    const sum_old = [new Array(n).fill(0), new Array(n).fill(0)]
    for (let j = start; j < end; j++) {
        for (let k = 0; k < n; k++) {
            sum_new[0][k] += H_new[j][0][k]
            sum_new[1][k] += H_new[j][1][k]
            sum_old[0][k] += H_old[j][0][k]
            sum_old[1][k] += H_old[j][1][k]
        }
    }
    const re = new Array(n)
    const im = new Array(n)
    for (let k = 0; k < n; k++) {
        const d = sum_old[0][k] ** 2 + sum_old[1][k] ** 2
        re[k] = (sum_new[0][k] * sum_old[0][k] + sum_new[1][k] * sum_old[1][k]) / d
        im[k] = (sum_new[1][k] * sum_old[0][k] - sum_new[0][k] * sum_old[1][k]) / d
    }
    return [re, im]
}

// Сетка частот прогноза: n — степень двойки не меньше rate_hz / predict_resolution_hz и длины КИХ (FFT импульсной
// характеристики, дополненной нулями), freq — k·rate_hz / n, k = 0…n/2. На ней же считаются регуляторы
// (pidtune_controller) и поправка фильтров (pidtune_gyro_ratio) для pidtune_predict. → { n, freq }
function pidtune_predict_grid(rate_hz, rules = pidtune_rules) {
    const n = 2 ** Math.ceil(Math.log2(Math.max(rate_hz / rules.predict_resolution_hz, rules.fir_length_s * rate_hz)))
    const freq = new Array(n / 2 + 1)
    for (let k = 0; k <= n / 2; k++) {
        freq[k] = k * rate_hz / n
    }
    return { n: n, freq: freq }
}

// Частота среза, запас фазы и запас по амплитуде разомкнутого контура L ([re[], im[]]) на сетке freq.
//   пересечения — все переходы |L| через 1 сверху вниз (|L| ≥ 1 на бине и < 1 на следующем) выше crossover_min_hz,
//   частота и фаза — линейная интерполяция между бинами, запас пересечения — 180° + фаза;
//   crossover_hz и pm_deg — первого пересечения: его фаза развёрнута от низких частот — от первого бина не ниже
//   crossover_min_hz (там главное значение приводится к (−270°, 90°] — центр на ожидаемых −90°: у контура скорости
//   фаза L на 0.5 Гц около −90°…−120° — интегратор регулятора или объекта и запаздывание нуля PI; шумная оценка T
//   даёт там и слегка положительную фазу, и окно (−360°, 0°] бросало бы +10° на −350° — запас −282° вместо 78°
//   (аудит области D)) вверх с шагом между бинами в (−180°, 180°] (сетка 0.1 Гц: фаза меняется на единицы
//   градусов). До первого пересечения |L| ≥ 1, T там намного выше шума, и развёртка обычно надёжна; запас первого
//   пересечения по модулю больше pm_abs_max_deg (180°) — точка отсчёта всё же легла не на ту ветвь: pm_deg null,
//   причина в pm_note (запаса по амплитуде тоже нет), crossings[0].pm_deg — как посчитан;
//   поздние пересечения — только справка (crossings, multiple_crossings), фаза — главное значение в (−360°, 0°], запас
//   в (−180°, 180°]. В прогнозе по измеренной T они появляются, когда шум КИХ на 20–40 Гц умножается большим D через R,
//   и их фаза недостоверна: развёртка туда идёт через участки с |L| < 1 и копит лишние обороты (D ×6: −2061°), а
//   главное значение +16° → −344° даёт «запас» −164° там, где L смотрит в сторону +1 (ревью задачи 6: «Свой» D ×3 на
//   достоверной оси — «неустойчив, −164°» при правде 59°). Устойчивость решают запас первого пересечения
//   и причинность отклика (pidtune_predict);
//   options.min_over_crossings — pm_deg наименьший по всем пересечениям: для точной L (правда в тестах), где поздние
//   пересечения настоящие;
//   запас по амплитуде — −20·log10 |L| там, где развёрнутая фаза выше первого пересечения впервые переходит −180°
//   (|L| в дБ интерполирован); только при pm_deg больше 0, перехода до конца сетки нет — null.
// → { crossover_hz, pm_deg, gm_db, multiple_crossings, crossings: [{ freq_hz, pm_deg }], pm_note } — нет пересечений
// (или нечисловые L) — числа null, crossings пуст; pm_note — почему pm_deg null при найденном пересечении, иначе null
function pidtune_margins(freq, L, rules = pidtune_rules, options = {}) {
    const none = { crossover_hz: null, pm_deg: null, gm_db: null, multiple_crossings: false, crossings: [], pm_note: null }
    const mag = (k) => Math.hypot(L[0][k], L[1][k])
    const phase = (k) => Math.atan2(L[1][k], L[0][k]) * 180 / Math.PI
    // Разность фаз соседних бинов — в (−180°, 180°]
    const step = (d) => d - 360 * Math.ceil((d - 180) / 360)
    let k0 = 0
    while ((k0 < freq.length) && !(freq[k0] >= rules.crossover_min_hz)) {
        k0++
    }
    if (k0 >= freq.length - 1) {
        return none
    }

    // Развёрнутая фаза от k0 (главное значение на k0 — в (−270°, 90°], центр −90°)
    const unwrapped = new Array(freq.length).fill(NaN)
    const p0 = phase(k0)
    unwrapped[k0] = p0 - 360 * Math.ceil((p0 - 90) / 360)
    for (let k = k0 + 1; k < freq.length; k++) {
        unwrapped[k] = unwrapped[k - 1] + step(phase(k) - phase(k - 1))
    }

    const crossings = []
    for (let k = k0 + 1; k < freq.length; k++) {
        const m0 = mag(k - 1)
        const m1 = mag(k)
        if ((m0 >= 1) && (m1 < 1)) {
            const a = (m0 - 1) / (m0 - m1)
            let phase_deg = unwrapped[k - 1] + a * (unwrapped[k] - unwrapped[k - 1])
            if (crossings.length > 0) {
                // Следующие пересечения — главное значение в (−360°, 0°]
                phase_deg -= 360 * Math.ceil(phase_deg / 360)
            }
            crossings.push({ freq_hz: freq[k - 1] + a * (freq[k] - freq[k - 1]), pm_deg: 180 + phase_deg, bin: k })
        }
    }
    if ((crossings.length == 0) || !Number.isFinite(crossings[0].pm_deg)) {
        return none
    }
    // Запас первого пересечения по модулю больше pm_abs_max_deg — развёртка легла не на ту ветвь: запаса нет, причина
    const first = crossings[0].pm_deg
    const pm_note = (Math.abs(first) > rules.pm_abs_max_deg)
        ? "развёртка фазы недостоверна: запас первого пересечения " + first.toFixed(0) + "° по модулю больше " + rules.pm_abs_max_deg + "°"
        : null
    const pm_deg = (pm_note != null) ? null : (options.min_over_crossings ? Math.min(...crossings.map((c) => c.pm_deg)) : first)

    // Запас по амплитуде: первый переход развёрнутой фазы через −180° выше первого пересечения
    let gm_db = null
    if (pm_deg > 0) {
        for (let k = crossings[0].bin; k < freq.length; k++) {
            const prev = unwrapped[k - 1]
            const next = unwrapped[k]
            if ((prev > -180) && (next <= -180)) {
                const b = (prev + 180) / (prev - next)
                const db0 = 20 * Math.log10(mag(k - 1))
                const db1 = 20 * Math.log10(mag(k))
                gm_db = -(db0 + b * (db1 - db0))
                break
            }
        }
    }
    return {
        crossover_hz: crossings[0].freq_hz,
        pm_deg: pm_deg,
        gm_db: gm_db,
        multiple_crossings: crossings.length > 1,
        crossings: crossings.map((c) => ({ freq_hz: c.freq_hz, pm_deg: c.pm_deg })),
        pm_note: pm_note,
    }
}

// Прогноз варианта по измеренной T (раздел 4 дизайна). T — FFT импульсной характеристики КИХ fir.h, дополненной нулями
// до сетки pidtune_predict_grid(rate_hz). Объект вместе с фильтрами гироскопа лога G_log выражается через T и регулятор
// лога: T = G_log·(C_log + FF_log) / (1 + G_log·C_log), откуда L_log = G_log·C_log = T / (1 + φ_log − T), φ = FF / C
// (при FF = 0 — привычное L = T / (1 − T)). Вариант: R = (C_new / C_log)·ratio (ratio = G_new / G_log —
// pidtune_gyro_ratio; null — 1), L_new = R·L_log, T_new = L_new·(1 + φ_new) / (1 + L_new) =
// R·T·(1 + φ_new) / (1 + φ_log − T + R·T) — без деления на 1 − T, близкое к нулю на низких частотах. При c_new = c_log
// и ratio = 1 T_new = T: прогноз для коэффициентов лога совпадает с измеренным по построению.
// На 0 Гц (интегратор: C = Infinity): I у обоих — R = ki_new / ki_log; I только у варианта — T_new = 1 (интегратор
// убирает статическую ошибку); I только у лога — предел по данным не определить, T_new(0) — по непрерывности, Re T_new
// на соседнем бине (0.1 Гц). Скачок на бине 0 Гц (например, T_new(0) = T(0)) — это постоянная добавка δ/n ко всей
// импульсной характеристике: наклон отклика и ложная доля энергии «до нуля» (≈ δ²/(4n·Σh²)), у узкополосного рыскания
// она могла бы дойти до noncausal_max (ревью задачи 6). На частоте Найквиста — действительная часть (отклик
// действительный).
// Отклик — обратное FFT T_new и накопленная сумма на 0…step_length_s (сетка — как у fir.step); метрики —
// pidtune_step_metrics; частота среза и запасы — pidtune_margins(L_new). Нечисловые коэффициенты дают NaN в L и T,
// метрики и запасы null — pidtune_flags отметят вариант.
// Поправка фильтров гироскопа ratio применяется полностью до ratio_full_hz = gyro_ratio_full_x (5) × частоты среза лога
// (L_log, не выше половины частоты Найквиста; нет частоты среза — половина частоты Найквиста), выше — плавно
// (приподнятый косинус) сходит к 1 к частоте Найквиста лога. Зачем (задача 8, лог пользователя): отношение посчитано
// по фильтрам на частоте гироскопа (≈ 2 кГц), а контур и КИХ — на частоте лога (400 Гц). У частоты Найквиста контура
// оно комплексное и большое (снят notch третьей гармоники ≈ 233 Гц: 7.3∠63° на 200 Гц), а спектр контура там
// действителен — разрыв даёт двусторонний «звон» импульсной характеристики, доля энергии до нуля 0.05–0.09, и все
// варианты выходили «прогноз неустойчив». К тому же где G_log глубоко подавлял, T — шум, и обратный notch его раздувает.
// На запас фазы и отклик влияет отношение у частоты среза и до нескольких её кратных, где |L| заметен; выше |L| ≪ 1.
// Переход — широкий: само окно тоже ломает связь модуля и фазы, и узкое (5–10× частоты среза) или ограничение модуля
// [0.5, 2] на том же логе дают 1e-3–1e-2 у INS_GYRO_FILTER 20 или 80. С широким переходом доля — до 1e-4 у всех
// изменений фильтров на логе пользователя, запас фазы — тот же, перерегулирование — в пределах 0.5 пункта от «как есть»
// (где оно считалось). Полное выключение notch (|R| ≈ 44 на 75 Гц, внутри полосы) так не лечится: T на частоте notch
// лога — шум, прогноз «неустойчив или ненадёжен» — честно.
// Неустойчивый вариант: обратное FFT T_new неустойчивого контура — не отклик, а периодический непричинный ряд
// (ревью задачи 6: K 290, P ×3 — «0 %» при правде 316 %). Поэтому unstable — запас фазы первого пересечения
// (pidtune_margins; поздние пересечения по измеренной T недостоверны) не больше 0 или импульсная характеристика прогноза
// непричинна: доля её энергии в последней четверти буфера (отрицательное время) noncausal больше noncausal_max. Тогда
// step и metrics — null. Второй признак нужен: на синтетике с редкими манёврами прогноз D ×5 у K 290 — первое
// пересечение +11.5°, а правда −8.9° (noncausal 0.56). Он же срабатывает и у вариантов, устойчивых по правде, но с
// ненадёжным прогнозом (D ×6 при редких манёврах — правда 53°; P ×2.5 у K 290 — правда 1.8°): это отказ при сомнении,
// и текст отметки это говорит (pidtune_flags).
// fir — pidtune_fir; c_log, c_new — pidtune_controller на частотах сетки (по длине и шагу freq[1]; другая сетка —
// исключение), ratio — [re[], im[]] той же длины или null; rate_hz — частота лога (pidtune_segments). Страница (шаг 4)
// строит c_new с FLTE и FLTD, принятыми на шаге 3, а c_log — с фильтрами лога (как и pidtune_controller_check).
// → { freq, T (T_new), L (L_new) — [re[], im[]] на 0…rate_hz/2 (L[·][0] — Infinity или NaN: 0 Гц на бодэ не рисовать),
// crossover_hz, pm_deg, gm_db, multiple_crossings, crossings, pm_note (pidtune_margins: pm_deg null при найденной
// частоте среза — развёртка фазы недостоверна, причина в pm_note; такой прогноз неустойчивым по запасу не считается —
// только по причинности), unstable, noncausal, ratio_full_hz (без поправки — null), step: { time, y } | null,
// metrics | null } | null — нет КИХ или регулятора
function pidtune_predict(fir, c_log, c_new, ratio, rate_hz, rules = pidtune_rules) {
    if ((fir == null) || (c_log == null) || (c_new == null)) {
        return null
    }
    const grid = pidtune_predict_grid(rate_hz, rules)
    const n = grid.n
    const half = n / 2
    const off_grid = (c) => (c.freq == null) || (c.freq.length != half + 1) || !(Math.abs(c.freq[1] - grid.freq[1]) <= 1e-9 * grid.freq[1])
    const bad_length = (arr) => (arr != null) && ((arr[0].length != half + 1) || (arr[1].length != half + 1))
    if (off_grid(c_log) || off_grid(c_new) || [c_log.C, c_log.FF, c_new.C, c_new.FF, ratio].some(bad_length)) {
        throw new Error("pidtune_predict: регуляторы и поправка фильтров — на сетке pidtune_predict_grid (" + (half + 1) + " частот, шаг " +
                        grid.freq[1] + " Гц)")
    }

    // T = FFT h (дополнение нулями до n)
    const fft = new FFTJS(n)
    const x = new Float64Array(n)
    for (let i = 0; i < Math.min(fir.h.length, n); i++) {
        x[i] = fir.h[i]
    }
    const spectrum = fft.createComplexArray()
    fft.realTransform(spectrum, x)

    const cdiv = (ar, ai, br, bi) => {
        const d = br * br + bi * bi
        return [(ar * br + ai * bi) / d, (ai * br - ar * bi) / d]
    }
    // Поправка фильтров гироскопа: полностью до ratio_full_hz (по частоте среза L_log), выше — плавно к 1 на Найквисте
    let gyro = null
    let ratio_full_hz = null
    if (ratio != null) {
        const L_log = [new Array(half + 1).fill(NaN), new Array(half + 1).fill(NaN)]
        for (let k = 1; k <= half; k++) {
            const tr = spectrum[2 * k]
            const ti = (k == half) ? 0 : spectrum[2 * k + 1]
            const phi = cdiv(c_log.FF[0][k], c_log.FF[1][k], c_log.C[0][k], c_log.C[1][k])
            const l = cdiv(tr, ti, 1 + phi[0] - tr, phi[1] - ti)
            L_log[0][k] = l[0]
            L_log[1][k] = l[1]
        }
        const fc_log = pidtune_margins(grid.freq, L_log, rules).crossover_hz
        const nyquist = grid.freq[half]
        ratio_full_hz = !Number.isFinite(rules.gyro_ratio_full_x) ? Infinity
            : ((fc_log != null) ? Math.min(rules.gyro_ratio_full_x * fc_log, nyquist / 2) : nyquist / 2)
        gyro = [new Array(half + 1), new Array(half + 1)]
        for (let k = 0; k <= half; k++) {
            const f = grid.freq[k]
            const w = (f <= ratio_full_hz) ? 1 : 0.5 + 0.5 * Math.cos(Math.PI * (f - ratio_full_hz) / (nyquist - ratio_full_hz))
            gyro[0][k] = 1 + w * (ratio[0][k] - 1)
            gyro[1][k] = w * ratio[1][k]
        }
    }

    const T_new = [new Array(half + 1), new Array(half + 1)]
    const L = [new Array(half + 1), new Array(half + 1)]
    let dc_by_continuity = false
    for (let k = 0; k <= half; k++) {
        const tr = spectrum[2 * k]
        const ti = ((k == 0) || (k == half)) ? 0 : spectrum[2 * k + 1]
        const cl = [c_log.C[0][k], c_log.C[1][k]]
        const cn = [c_new.C[0][k], c_new.C[1][k]]
        const g = (gyro != null) ? [gyro[0][k], gyro[1][k]] : [1, 0]
        let R
        let phi_log
        let phi_new
        if ((cl[0] === Infinity) || (cn[0] === Infinity)) {
            // 0 Гц с интегратором
            if (cl[0] !== Infinity) {
                T_new[0][k] = 1
                T_new[1][k] = 0
                L[0][k] = Infinity
                L[1][k] = 0
                continue
            }
            if (cn[0] !== Infinity) {
                // I только у лога: предел по данным не определить — по непрерывности, после цикла
                dc_by_continuity = true
                L[0][k] = NaN
                L[1][k] = NaN
                continue
            }
            const q = c_new.ki / c_log.ki
            R = [q * g[0], q * g[1]]
            phi_log = [0, 0]
            phi_new = [0, 0]
        } else {
            const c = cdiv(cn[0], cn[1], cl[0], cl[1])
            R = [c[0] * g[0] - c[1] * g[1], c[0] * g[1] + c[1] * g[0]]
            phi_log = cdiv(c_log.FF[0][k], c_log.FF[1][k], cl[0], cl[1])
            phi_new = cdiv(c_new.FF[0][k], c_new.FF[1][k], cn[0], cn[1])
        }
        // R·T и 1 + φ_log − T
        const rt = [R[0] * tr - R[1] * ti, R[0] * ti + R[1] * tr]
        const den = [1 + phi_log[0] - tr, phi_log[1] - ti]
        const l = cdiv(rt[0], rt[1], den[0], den[1])
        L[0][k] = l[0]
        L[1][k] = l[1]
        const num = [rt[0] * (1 + phi_new[0]) - rt[1] * phi_new[1], rt[0] * phi_new[1] + rt[1] * (1 + phi_new[0])]
        const t = cdiv(num[0], num[1], den[0] + rt[0], den[1] + rt[1])
        T_new[0][k] = t[0]
        T_new[1][k] = ((k == 0) || (k == half)) ? 0 : t[1]
    }
    if (dc_by_continuity) {
        T_new[0][0] = T_new[0][1]
        T_new[1][0] = 0
    }

    // Отклик: обратное FFT полного (сопряжённо-симметричного) спектра и накопленная сумма
    const full = fft.createComplexArray()
    for (let k = 0; k <= half; k++) {
        full[2 * k] = T_new[0][k]
        full[2 * k + 1] = T_new[1][k]
        if ((k > 0) && (k < half)) {
            full[2 * (n - k)] = T_new[0][k]
            full[2 * (n - k) + 1] = -T_new[1][k]
        }
    }
    const impulse = fft.createComplexArray()
    fft.inverseTransform(impulse, full)

    // Причинность: доля энергии в последней четверти буфера (отрицательное время)
    let energy = 0
    let negative = 0
    for (let i = 0; i < n; i++) {
        const e = impulse[2 * i] ** 2
        energy += e
        if (i >= n - n / 4) {
            negative += e
        }
    }
    const noncausal = negative / energy
    const margins = pidtune_margins(grid.freq, L, rules)
    // Запас первого пересечения (pidtune_margins: поздние — только справка)
    const unstable = ((margins.pm_deg != null) && !(margins.pm_deg > 0)) || (noncausal > rules.noncausal_max)

    let step = null
    let metrics = null
    if (!unstable) {
        const n_out = Math.min(n, Math.round(rules.step_length_s * rate_hz) + 1)
        const time = new Array(n_out)
        const y = new Array(n_out)
        let sum = 0
        for (let i = 0; i < n_out; i++) {
            sum += impulse[2 * i]
            time[i] = i / rate_hz
            y[i] = sum
        }
        step = { time: time, y: y }
        metrics = pidtune_step_metrics(time, y, rules)
    }
    return {
        freq: grid.freq,
        T: T_new,
        L: L,
        crossover_hz: margins.crossover_hz,
        pm_deg: margins.pm_deg,
        gm_db: margins.gm_db,
        multiple_crossings: margins.multiple_crossings,
        crossings: margins.crossings,
        pm_note: margins.pm_note,
        unstable: unstable,
        noncausal: noncausal,
        ratio_full_hz: ratio_full_hz,
        step: step,
        metrics: metrics,
    }
}

// Достоверность прогноза оси (раздел 4 дизайна). Для коэффициентов лога прогноз совпадает с измеренным по построению,
// поэтому проверяется, можно ли доверять T и модели регулятора:
//   измерение надёжно — quality.ok (pidtune_quality: (а)–(в), в Acro «Rate Loop Only» — (а) и (б));
//   модель регулятора сходится с данными — controller_check.ok (pidtune_controller_check); у оси RATE сверка не
//   запускается (skipped "rate") — причина «по RATE прогноз не считается» (решение координатора по ревью задачи 6:
//   честный отказ — цель записана до FLTT, выход — с FF; FLTT не моделируется);
//   когерентность γ² «цель → факт» на частоте среза лога (pidtune_coherence) не меньше coherence_min [наше].
// Нет значения (null, нечисловое) — проверка не пройдена (отказ при сомнении). Числа у порога — с округлением от него.
// → { valid, reasons: [текст по каждой непройденной проверке] }
function pidtune_validity(quality, controller_check, coherence_at_crossover, rules = pidtune_rules) {
    const reasons = []
    if (quality == null) {
        reasons.push("нет проверки качества измерения")
    } else if (!quality.ok) {
        reasons.push("измерение ненадёжно" + ((quality.reasons.length > 0) ? ": " + quality.reasons.join("; ") : ""))
    }

    const cc = rules.controller_check
    const mag = controller_check?.max_mag_err
    const phase = controller_check?.max_phase_err_deg
    if (controller_check?.skipped == "rate") {
        reasons.push("по RATE прогноз не считается: цель записана до фильтра FLTT, выход — с FF; включите бит PID в LOG_BITMASK " +
                     "(сообщения PIDR, PIDP, PIDY)")
    } else if (!Number.isFinite(mag) || !Number.isFinite(phase)) {
        reasons.push("сверка модели регулятора с данными не посчиталась: нет окон " + cc.window + " отсчётов с целью больше " +
                     rules.target_min_dps + " °/с или коэффициенты регулятора не числа")
    } else if (!controller_check.ok) {
        reasons.push("модель регулятора не сходится с данными: модуль C_изм / C_мод отличается от 1 до " +
                     pidtune_beyond(mag * 100, cc.mag_err_max * 100, 1) + " %, фаза — до " + pidtune_beyond(phase, cc.phase_err_max_deg, 1) + "° (худшее — на " + controller_check.worst_hz.toFixed(1) + " Гц; порог " +
                     cc.mag_err_max * 100 + " % и " + cc.phase_err_max_deg + "° на " + cc.band_hz[0] + "–" + cc.band_hz[1] + " Гц)")
    }

    if (!Number.isFinite(coherence_at_crossover)) {
        reasons.push("когерентность «цель → факт» на частоте среза не посчиталась: частота среза не найдена или нет окон")
    } else if (!(coherence_at_crossover >= rules.coherence_min)) {
        reasons.push("когерентность «цель → факт» на частоте среза γ² = " + pidtune_beyond(coherence_at_crossover, rules.coherence_min, 2) + " ниже " + rules.coherence_min +
                     " — отклик на этой частоте плохо связан с целью (возмущения, шум)")
    }
    return { valid: reasons.length == 0, reasons: reasons }
}

// Варианты оси (раздел 4 дизайна), по порядку:
//   «Как в логе» (log) — значения лога как есть;
//   «По правилам» (rule) — rule.values (pidtune_rule; без изменений — значения лога);
//   «P −10 %», «P +10 %» (p_minus, p_plus) — I по правилу, пределы AutoTune (pidtune_change_p); варианта нет, если
//   предел не даёт сдвинуть P в нужную сторону или P и I лога не числа;
//   «D −10 %», «D +10 %» (d_minus, d_plus) — только при D лога — положительном числе (D = 0 — «D выключен»); D ≤ d_max,
//   варианта нет, если предел не даёт сдвинуть D.
// Изменённые значения — round_digits значащих цифр (pidtune_round), I — от округлённого P. Одинаковые наборы
// (candidate_key) остаются один раз — первый по порядку, в его same_as — id совпавших (так «По правилам» без изменений —
// это «Как в логе» с same_as ["rule"]). «Свой» (правка формы) добавляет страница.
// log_gains = { P, I, D } лога, rule — pidtune_rule (null — без «По правилам»), axis — "roll" | "pitch" | "yaw".
// → [{ id, title, values: { P, I, D }, same_as: [id] }]
function pidtune_candidates(log_gains, rule, axis, rules = pidtune_rules) {
    const log = { P: log_gains.P, I: log_gains.I, D: log_gains.D }
    const percent = Math.round(rules.gain_step * 100) + " %"
    const list = [{ id: "log", title: "Как в логе", values: log }]
    if (rule != null) {
        list.push({ id: "rule", title: "По правилам", values: { P: rule.values.P, I: rule.values.I, D: rule.values.D } })
    }
    if (Number.isFinite(log.P) && Number.isFinite(log.I)) {
        for (const sign of [-1, 1]) {
            const changed = pidtune_change_p(log, axis, sign, "", rules)
            if (changed.change != null) {
                list.push({ id: (sign < 0) ? "p_minus" : "p_plus", title: "P " + ((sign < 0) ? "−" : "+") + percent, values: changed.values })
            }
        }
    }
    if (Number.isFinite(log.D) && (log.D > 0)) {
        for (const sign of [-1, 1]) {
            const D = Math.min(rules.d_max, pidtune_round(log.D * (1 + sign * rules.gain_step), rules))
            if ((D - log.D) * sign > 0) {
                list.push({ id: (sign < 0) ? "d_minus" : "d_plus", title: "D " + ((sign < 0) ? "−" : "+") + percent, values: { P: log.P, I: log.I, D: D } })
            }
        }
    }

    // Одинаковые наборы — один раз (первый), остальные — в его same_as
    const kept = []
    const by_key = new Map()
    for (const candidate of list) {
        const key = candidate_key(candidate.values)
        const first = by_key.get(key)
        if (first != null) {
            first.same_as.push(candidate.id)
            continue
        }
        const item = { ...candidate, same_as: [] }
        by_key.set(key, item)
        kept.push(item)
    }
    return kept
}

// Отметки прогноза варианта pred против прогноза для коэффициентов лога pred_log (оба — pidtune_predict, могут быть
// null) — решение пользователя 25.10.2026, плюс неустойчивость (ревью задачи 6):
//   unstable — прогноз неустойчив (pred.unstable); метрик у такого прогноза нет, перерегулирование отмечено без своего
//   текста, неполным он не считается. Текст — по признаку: запас первого пересечения не больше 0 — «контур неустойчив
//   (запас фазы …)»; иначе (непричинный отклик) — «прогноз неустойчив — вариант на грани устойчивости или прогноз
//   ненадёжен»: этот признак срабатывает и у вариантов, устойчивых по правде, когда прогноз ненадёжен (большое
//   изменение D или фильтров гироскопа — например, выключенный notch, мало возбуждения на высоких частотах) — отказ при
//   сомнении. Запаса у такого прогноза (первое пересечение > 0) тоже нет — он недостоверен (шаг 4 показывает «—»
//   и «запас недостоверен»), поэтому low_pm и pm_drop с числом запаса не ставятся: остаётся одна отметка unstable;
//   low_pm — запас фазы ниже pm_min_deg;
//   pm_drop — запас фазы хуже лога больше чем на pm_max_drop_deg;
//   overshoot — перерегулирование в прогнозе выше overshoot_pred_max_pct;
//   incomplete — у устойчивого прогноза нет запаса фазы (частота среза не найдена или запас не определён — развёртка
//   фазы недостоверна, pred.pm_note) или метрик, нет прогноза, у лога нет запаса фазы.
// Отметки отказывают при сомнении: !(значение в пределах порога), поэтому NaN и null отмечаются; ровно на пороге —
// без отметки [наше]. Числа в текстах у порога — с округлением от него (pidtune_beyond). Выбор отметки не блокируют.
// → { unstable, low_pm, pm_drop, overshoot, incomplete, flagged (хотя бы одна), reasons: [текст] }
function pidtune_flags(pred, pred_log, rules = pidtune_rules) {
    const value = (v) => (typeof v === "number") ? v : NaN
    const pm = value(pred?.pm_deg)
    const pm_log = value(pred_log?.pm_deg)
    const os = value(pred?.metrics?.overshoot_pct)
    const unstable = pred?.unstable === true
    // Неустойчив по причинности при запасе первого пересечения больше 0 (или без него): запас недостоверен
    const margin_unreliable = unstable && !(pm <= 0)
    const flags = {
        unstable: unstable,
        low_pm: !margin_unreliable && !(pm >= rules.pm_min_deg),
        pm_drop: !margin_unreliable && !(pm_log - pm <= rules.pm_max_drop_deg),
        overshoot: !(os <= rules.overshoot_pred_max_pct),
        incomplete: (!unstable && (!Number.isFinite(pm) || !Number.isFinite(os))) || (pred == null) || !Number.isFinite(pm_log),
    }
    const reasons = []
    if (unstable) {
        reasons.push((Number.isFinite(pm) && (pm <= 0)) ? "контур неустойчив (запас фазы " + pidtune_beyond(pm, 0, 1) + "°)"
            : "прогноз неустойчив — вариант на грани устойчивости или прогноз ненадёжен (большое изменение D или фильтров " +
              "гироскопа, мало возбуждения на высоких частотах)")
    }
    if (flags.incomplete) {
        const missing = []
        if (pred == null) {
            missing.push("нет прогноза")
        } else if (!unstable) {
            if (!Number.isFinite(pm)) {
                missing.push((pred.pm_note != null) ? "запас фазы не определён (" + pred.pm_note + ")" : "частота среза не найдена")
            }
            if (!Number.isFinite(os)) {
                missing.push("нет метрик отклика")
            }
        }
        if (!Number.isFinite(pm_log)) {
            missing.push("у прогноза лога нет запаса фазы")
        }
        reasons.push("прогноз неполный: " + missing.join(", "))
    }
    if (flags.low_pm && Number.isFinite(pm)) {
        reasons.push("запас фазы " + pidtune_beyond(pm, rules.pm_min_deg, 1) + "° ниже " + rules.pm_min_deg + "°")
    }
    if (flags.pm_drop && Number.isFinite(pm) && Number.isFinite(pm_log)) {
        reasons.push("запас фазы хуже лога на " + pidtune_beyond(pm_log - pm, rules.pm_max_drop_deg, 1) + "° (больше " + rules.pm_max_drop_deg + "°)")
    }
    if (flags.overshoot && Number.isFinite(os)) {
        reasons.push("перерегулирование в прогнозе " + pidtune_beyond(os, rules.overshoot_pred_max_pct, 1) + " % выше " + rules.overshoot_pred_max_pct + " %")
    }
    flags.flagged = flags.unstable || flags.low_pm || flags.pm_drop || flags.overshoot || flags.incomplete
    flags.reasons = reasons
    return flags
}
