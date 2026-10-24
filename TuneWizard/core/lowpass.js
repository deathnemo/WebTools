// Низкочастотные фильтры шага 3: значения по размеру винта (формулы Mission Planner), варианты и их оценка —
// шум гироскопа после фильтров, шум D-составляющей и задержка путей P и D. Без DOM: работает в браузере и под
// Node (тесты). Дизайн — docs/plans/2026-10-24-tune-wizard-stage3-design.md.
// Источники: [MP] — Mission Planner GCSViews/ConfigurationView/ConfigInitialParams.cs (calc_values);
// [wiki] — ardupilot.org/copter/docs/setting-up-for-tuning.html; [код] — исходники ArduPilot; [наше] — эвристика мастера.
//
// Нужны глобалы страницы: Libraries/Array_Math.js, core/gyro.js (find_start_index, find_end_index),
// core/filters.js (load_filters, filter_transfer, estimate_post, get_phase), core/spectrum.js
// (spectrum_amplitude_scale, alias_obj) и core/candidates.js (evaluate_candidate, candidate_key, candidate_rules).

const lowpass_rules = {
    gyro_filter: { scale: 289.22, power: -0.838, min_hz: 20 },   // INS_GYRO_FILTER по размеру винта [MP]
    pid_filter_min_hz: 10,              // FLTT/FLTD = max(10, INS_GYRO_FILTER / 2) [MP; wiki — INS_GYRO_FILTER / 2]
    yaw_flte_hz: 2,                     // ATC_RAT_YAW_FLTE [MP, wiki]
    accel_filter_hz: 10,                // INS_ACCEL_FILTER [MP, wiki]
    // ATC_ACCEL_R/P_MAX [MP]: коэффициенты многочлена при p³, p², p, 1
    accel_rp: { poly: [-2.613267, 343.39216, -15083.7121, 235771], min_cdegss: 10000 },
    accel_y: { slope: -900, offset: 36000, min_cdegss: 8000 },   // ATC_ACCEL_Y_MAX [MP]
    accel_default_degss: { rp: 1100, y: 270 },   // заводские пределы, AC_AttitudeControl.h [код]
    // Заводские фильтры Copter: AP_InertialSensor.cpp (DEFAULT_GYRO_FILTER, DEFAULT_ACCEL_FILTER),
    // AC_AttitudeControl_Multi.h (FLTT, FLTD 20 Гц по всем осям, FLTE крена/тангажа 0, рыскания 2.5 Гц) [код]
    defaults: { gyro_hz: 20, accel_hz: 20, fltt_hz: 20, fltd_hz: 20, flte_rp_hz: 0, flte_y_hz: 2.5 },
    // Размер винта без предупреждения у поля: ниже ≈ 4″ формулы выходят за диапазоны метаданных ArduPilot
    // (FLTT/FLTD > 50 Гц, ACC_R/P_MAX > 1800 °/с², INS_GYRO_FILTER > 256 на 1″) [наше]
    prop_range_in: [4, 40],
    // Полоса шума гироскопа (для D — до частоты Найквиста контура) и частоты задержки — те же, что у шага 2:
    // шум гироскопа и задержку гироскопной части даёт evaluate_candidate по candidate_rules
    band_hz: candidate_rules.band_hz,
    lag_freqs_hz: candidate_rules.lag_freqs_hz,
    max_noise_increase_dB: 3,           // «шумнее лога» [наше, как на шаге 2]
    max_lag_increase_ms: 1,             // «медленнее лога» на 30 Гц (решение пользователя 24.10.2026) [наше]
}

const LOWPASS_AXES = ["RLL", "PIT", "YAW"]

// Оси с метриками D и задержки: имя в параметрах ATC_RAT_<имя>_* и ось гироскопа (крен ↔ X, тангаж ↔ Y).
// Рыскание — по правилу wiki, без метрик: FLTE 2 Гц даёт задержку, несравнимую с остальными осями (дизайн, раздел 4)
const lowpass_pid_axes = { roll: { param: "RLL", gyro: "x" }, pitch: { param: "PIT", gyro: "y" } }

// Math.Round из C# (по умолчанию — к чётному): так округляет Mission Planner
function mp_round_half_even(value) {
    const floor = Math.floor(value)
    const diff = value - floor
    if (diff < 0.5) {
        return floor
    }
    if (diff > 0.5) {
        return floor + 1
    }
    return (floor % 2 == 0) ? floor : floor + 1
}

// RoundTo(value, precision) из Mission Planner: при precision < 0 — m = 10^|precision|, v = value + m/2, v − v % m
// (округление половиной вверх — для v ≥ 0; для отрицательных повторяет Mission Planner как есть); при precision ≥ 0 —
// Math.Round C# (к чётному). Math.Round(value, digits) в .NET масштабирует на 10^digits, округляет и делит обратно —
// так же и здесь
function mp_round_to(value, precision) {
    if (precision >= 0) {
        const scale = 10**precision
        return mp_round_half_even(value * scale) / scale
    }
    const m = 10**(-precision)
    const v = value + m / 2
    return mp_round_half_even(v - v % m)
}

// Размер винта p пригоден для формул: положительное конечное число
function prop_valid(p) {
    return Number.isFinite(p) && (p > 0)
}

// FLTT/FLTD по частоте фильтра гироскопа gyro_hz: max(10, gyro_hz / 2) [MP]
function lowpass_pid_filter_hz(gyro_hz) {
    return Math.max(lowpass_rules.pid_filter_min_hz, gyro_hz / 2)
}

// Значения по размеру винта p (дюймы) [MP]: INS_GYRO_FILTER, INS_ACCEL_FILTER, FLTT/FLTE/FLTD трёх осей
// и пределы ускорения в сантиградусах/с² (accel_cdegss: { r, p, y }) — имена пределов ставит lowpass_candidates.
// Область определения — prop_valid(p); иначе результат не определён (Infinity/NaN)
function prop_values(p) {
    const rules = lowpass_rules
    const gyro = Math.max(rules.gyro_filter.min_hz, mp_round_half_even(rules.gyro_filter.scale * p**rules.gyro_filter.power))
    const pid = lowpass_pid_filter_hz(gyro)

    const values = { INS_GYRO_FILTER: gyro, INS_ACCEL_FILTER: rules.accel_filter_hz }
    for (const axis of LOWPASS_AXES) {
        const yaw = (axis == "YAW")
        values["ATC_RAT_" + axis + "_FLTT"] = pid
        values["ATC_RAT_" + axis + "_FLTE"] = yaw ? rules.yaw_flte_hz : 0   // крен и тангаж без FLTE [MP]
        values["ATC_RAT_" + axis + "_FLTD"] = yaw ? 0 : pid                 // рыскание без FLTD [MP]
    }

    // В том же порядке действий, что calc_values
    const [a3, a2, a1, a0] = rules.accel_rp.poly
    const rp = Math.max(rules.accel_rp.min_cdegss, mp_round_to(a3 * p**3 + a2 * p**2 + a1 * p + a0, -2))
    const y = Math.max(rules.accel_y.min_cdegss, mp_round_to(rules.accel_y.slope * p + rules.accel_y.offset, -2))
    values.accel_cdegss = { r: rp, p: rp, y: y }
    return values
}

// Размер винта, которому формула [MP] даёт частоту hz (без клампа и округления); null, если hz не положительное
// конечное число
function prop_from_gyro_filter(hz) {
    if (!Number.isFinite(hz) || !(hz > 0)) {
        return null
    }
    const rules = lowpass_rules.gyro_filter
    return (hz / rules.scale)**(1 / rules.power)
}

// Имена и единицы пределов ускорения по логу: ATC_ACCEL_*_MAX (сантиградусы/с², 4.6 и раньше) или ATC_ACC_*_MAX (°/с²).
// scale — во сколько раз значение параметра больше значения в °/с²
function lowpass_accel_names(params) {
    if (params.has("ATC_ACCEL_R_MAX")) {
        return { r: "ATC_ACCEL_R_MAX", p: "ATC_ACCEL_P_MAX", y: "ATC_ACCEL_Y_MAX", scale: 100, units: "cdeg/s/s" }
    }
    return { r: "ATC_ACC_R_MAX", p: "ATC_ACC_P_MAX", y: "ATC_ACC_Y_MAX", scale: 1, units: "deg/s/s" }
}

// Параметры шага по порядку: INS_GYRO_FILTER, INS_ACCEL_FILTER, FLTT/FLTE/FLTD крена, тангажа и рыскания,
// пределы ускорения r, p, y под именами из лога (lowpass_accel_names)
function lowpass_param_names(params) {
    const names = ["INS_GYRO_FILTER", "INS_ACCEL_FILTER"]
    for (const axis of LOWPASS_AXES) {
        names.push("ATC_RAT_" + axis + "_FLTT", "ATC_RAT_" + axis + "_FLTE", "ATC_RAT_" + axis + "_FLTD")
    }
    const accel = lowpass_accel_names(params)
    names.push(accel.r, accel.p, accel.y)
    return names
}

// Значения параметров шага из лога (объект имя → число в порядке lowpass_param_names); чего в логе нет —
// заводские Copter (lowpass_rules.defaults, пределы — accel_default_degss × scale). Как float32: так их хранит
// прошивка, и 0.7 из файла .param совпадает с 0.699999988 из лога
function lowpass_log_values(params) {
    const rules = lowpass_rules
    const accel = lowpass_accel_names(params)
    const defaults = { INS_GYRO_FILTER: rules.defaults.gyro_hz, INS_ACCEL_FILTER: rules.defaults.accel_hz }
    for (const axis of LOWPASS_AXES) {
        defaults["ATC_RAT_" + axis + "_FLTT"] = rules.defaults.fltt_hz
        defaults["ATC_RAT_" + axis + "_FLTE"] = (axis == "YAW") ? rules.defaults.flte_y_hz : rules.defaults.flte_rp_hz
        defaults["ATC_RAT_" + axis + "_FLTD"] = rules.defaults.fltd_hz
    }
    defaults[accel.r] = rules.accel_default_degss.rp * accel.scale
    defaults[accel.p] = rules.accel_default_degss.rp * accel.scale
    defaults[accel.y] = rules.accel_default_degss.y * accel.scale

    const values = {}
    for (const name of lowpass_param_names(params)) {
        values[name] = Math.fround(params.get(name) ?? defaults[name])
    }
    return values
}

// Пределы ускорения в values (объект имя → число) заводские: 1100 / 1100 / 270 °/с² × names.scale с допуском
// 0.5·scale по каждой оси. names — lowpass_accel_names; нет значения под этим именем — не заводские
function lowpass_accel_is_default(values, names) {
    const defaults = lowpass_rules.accel_default_degss
    const tolerance = 0.5 * names.scale
    const near = (value, default_degss) => Math.abs(value - default_degss * names.scale) <= tolerance
    return near(values[names.r], defaults.rp) && near(values[names.p], defaults.rp) && near(values[names.y], defaults.y)
}

// Предупреждение у поля размера винта: null, если размер не введён (пустое поле вызывающий приводит к null или
// undefined — тогда нет варианта по размеру, об этом пишет вердикт) или лежит в prop_range_in; текст, если размер
// вне диапазона или не число (NaN, ±Infinity, ≤ 0) [наше]
function prop_size_warning(p) {
    if (p == null) {
        return null
    }
    const [min, max] = lowpass_rules.prop_range_in
    if ((p >= min) && (p <= max)) {
        return null
    }
    return "Размер винта вне диапазона " + min + "–" + max + "″ — проверьте значение"
}

// Варианты: «как в логе»; «по размеру винта» (только с prop_valid(prop_in); пределы ускорения — по формуле, только
// если в логе заводские, иначе из лога: их записывает AutoTune, AC_AutoTune_Multi.cpp); «лог + правило /2» (только
// если фильтр гироскопа в логе включён, INS_GYRO_FILTER > 0). Одинаковые наборы — один раз (первый по порядку).
// log_values — lowpass_log_values(params), prop_in — размер винта в дюймах, как ввёл пользователь (null, если не
// введён), names — lowpass_accel_names(params). У всех вариантов ровно ключи log_values; значения — float32, как
// у лога, чтобы совпадение с логом было честным.
// Возвращает [{ id, title, values, same_as }]: same_as — id выброшенных вариантов с тем же набором (пустой массив,
// если совпадений не было). У варианта «prop» ещё accel_from_log (пределы оставлены из лога) и formula_accel
// ({ r, p, y } — пределы по формуле в единицах параметров лога, для справки)
function lowpass_candidates(log_values, prop_in, names) {
    const candidates = [{ id: "log", title: "Как в логе", values: { ...log_values } }]

    if (prop_valid(prop_in)) {
        const { accel_cdegss, ...filters } = prop_values(prop_in)
        // Формула [MP] — в сантиградусах/с²; для ATC_ACC_*_MAX Mission Planner делит на 100
        const formula_accel = {
            r: accel_cdegss.r * names.scale / 100,
            p: accel_cdegss.p * names.scale / 100,
            y: accel_cdegss.y * names.scale / 100,
        }
        const accel_from_log = !lowpass_accel_is_default(log_values, names)
        const values = { ...log_values, ...filters }
        if (!accel_from_log) {
            values[names.r] = formula_accel.r
            values[names.p] = formula_accel.p
            values[names.y] = formula_accel.y
        }
        candidates.push({
            id: "prop",
            title: "По размеру винта (" + prop_in + "″)",
            values: values,
            accel_from_log: accel_from_log,
            formula_accel: formula_accel,
        })
    }

    if (log_values.INS_GYRO_FILTER > 0) {
        const half = lowpass_pid_filter_hz(log_values.INS_GYRO_FILTER)
        const values = { ...log_values }
        for (const axis of ["RLL", "PIT"]) {
            values["ATC_RAT_" + axis + "_FLTT"] = half
            values["ATC_RAT_" + axis + "_FLTD"] = half
        }
        values.ATC_RAT_YAW_FLTT = half
        candidates.push({ id: "half", title: "Лог + правило /2", values: values })
    }

    // Значения — float32, как у лога
    for (const candidate of candidates) {
        for (const name of Object.keys(candidate.values)) {
            candidate.values[name] = Math.fround(candidate.values[name])
        }
    }

    // Одинаковые наборы — один раз: id выброшенного — в same_as оставшегося
    const kept = new Map()
    for (const candidate of candidates) {
        const key = candidate_key(candidate.values)
        if (kept.has(key)) {
            kept.get(key).same_as.push(candidate.id)
        } else {
            kept.set(key, { ...candidate, same_as: [] })
        }
    }
    return [...kept.values()]
}

// ---------- Модель ПИД и оценка вариантов ----------
// ПИД крена и тангажа (AC_PID.cpp, update_all) считается на частоте контура SCHED_LOOP_RATE: ошибка = цель после
// FLTT − гироскоп после notch и INS_GYRO_FILTER; FLTE — на ошибке (действует на P, I и D); производная ошибки
// (error − error_last) / dt; FLTD — на производной (только D). Все три — первого порядка (calc_lowpass_alpha_dt) [код].
// Отсюда путь P = гироскопная часть + FLTE, путь D = путь P + производная + FLTD; FLTT стоит на цели и в метрики
// не входит. Гироскоп ПИД получает с частотой контура, поэтому шум выше её половины отражается вниз (свёртка).

// Фильтр первого порядка ArduPilot на частоте контура loop_rate: y += alpha·(x − y), alpha = dt / (dt + 1/(2π·fc))
// (calc_lowpass_alpha_dt); H(z) = alpha / (1 − (1 − alpha)·z⁻¹) при z = e^(j·2π·f/loop_rate). fc ≤ 0 — без фильтра
// (H = 1): calc_lowpass_alpha_dt при fc = 0 даёт alpha = 1, при отрицательной — тоже 1 (с внутренней ошибкой) [код].
// Нечисловая fc (NaN, undefined, null, не число) — [NaN, NaN]: значение варианта неизвестно, задержка и шум D станут
// NaN, и lowpass_flags отметят вариант (отказ при сомнении). Возвращает [re, im] на частоте f
function pid_lowpass_response(fc, loop_rate, f) {
    if ((typeof fc !== "number") || Number.isNaN(fc)) {
        return [NaN, NaN]
    }
    if (fc <= 0) {
        return [1, 0]
    }
    const dt = 1 / loop_rate
    const alpha = dt / (dt + 1 / (2 * Math.PI * fc))
    const w = 2 * Math.PI * f / loop_rate
    // Знаменатель 1 − (1 − alpha)·e^(−jω) = (1 − (1 − alpha)·cos ω) + j·(1 − alpha)·sin ω
    const re = 1 - (1 - alpha) * Math.cos(w)
    const im = (1 - alpha) * Math.sin(w)
    const norm = re * re + im * im
    return [alpha * re / norm, -alpha * im / norm]
}

// Задержка этого фильтра на частоте f > 0, мс: −arg(H) / (2π·f) · 1000 (фаза первого порядка по модулю меньше 90°,
// развёртка не нужна); без фильтра — 0, при нечисловой fc — NaN
function pid_lowpass_lag_ms(fc, loop_rate, f) {
    const [re, im] = pid_lowpass_response(fc, loop_rate, f)
    // 0 − фаза, а не −фаза: без фильтра фаза +0, и задержка выходит +0, а не −0 (строгие сравнения их различают)
    return (0 - Math.atan2(im, re)) / (2 * Math.PI * f) * 1000
}

// |(1 − z⁻¹) / dt|² на частоте f при dt = 1 / loop_rate: (2·sin(π·f/loop_rate) · loop_rate)² — квадрат усиления
// производной ошибки в ПИД (AC_PID.cpp: (_error − error_last) / dt) [код]
function derivative_gain2(f, loop_rate) {
    return (2 * Math.sin(Math.PI * f / loop_rate) * loop_rate)**2
}

// FLTE и FLTD оси axis ("roll" | "pitch") из значений варианта: { flte, fltd } (undefined, если имени в values нет)
function lowpass_axis_filters(values, axis) {
    const param = lowpass_pid_axes[axis].param
    return { flte: values["ATC_RAT_" + param + "_FLTE"], fltd: values["ATC_RAT_" + param + "_FLTD"] }
}

// Старшая из частот задержки rules.lag_freqs_hz (30 Гц): на ней lowpass_flags сравнивают задержку путей с логом
function lowpass_lag_hz(rules = lowpass_rules) {
    return Math.max(...rules.lag_freqs_hz)
}

// Контекст оценки: контекст evaluate_candidate (gyro, env, tracking, range, sensor — индекс экземпляра в gyro,
// как у шага 2) с пустыми пиками и loop_rate = notch.SCHED_LOOP_RATE; notch — значения notch-базы (принятые на шаге 2
// или из лога: INS_GYRO_FILTER, SCHED_LOOP_RATE, INS_HNTCH_*, INS_HNTC2_*), kd — { roll: ATC_RAT_RLL_D,
// pitch: ATC_RAT_PIT_D }: null (или не число) — Kd нет в логе, шум D оси не считается, ось неполная; 0 — D выключен,
// шум D и путь D оси не сравниваются (lowpass_flags, d_off_axes). loop_rate не положительное конечное число —
// оценки и бодэ нет (evaluate_lowpass и lowpass_bode возвращают null). Один объект на все варианты: по нему
// evaluate_candidate кэширует спектр «до». base = { gyro, env, tracking, range, sensor }
function lowpass_ctx(base, notch, kd) {
    return { ...base, peaks: [], loop_rate: notch.SCHED_LOOP_RATE, notch: notch, kd: kd }
}

// Шум D-составляющей одной оси: psd_dB — PSD гироскопа после фильтров (дБ/Гц), свёрнутая к loop_rate / 2, по бинам
// bins. D[k] = kd² · 10^(psd_dB[k]/10) · derivative_gain2(f_k) · |H_FLTE(f_k)|² · |H_FLTD(f_k)|².
// Возвращает { dB, spectrum }: spectrum = 10·log10(D[k]) по всем бинам (на 0 Гц производная равна нулю — −Infinity),
// dB = 10·log10 среднего D[k] по бинам band_hz[0] ≤ f ≤ min(band_hz[1], loop_rate / 2) (null, если таких нет).
// null, если kd не ненулевое конечное число (нет в логе или D выключен): D-составляющей у оси нет
function lowpass_dterm(bins, psd_dB, kd, flte, fltd, loop_rate) {
    if (!Number.isFinite(kd) || (kd == 0)) {
        return null
    }
    const band = lowpass_rules.band_hz
    const top = Math.min(band[1], loop_rate / 2)
    const abs2 = (h) => h[0] * h[0] + h[1] * h[1]
    const spectrum = new Array(bins.length)
    let sum = 0
    let count = 0
    for (let k = 0; k < bins.length; k++) {
        const f = bins[k]
        const D = kd * kd * 10**(psd_dB[k] / 10) * derivative_gain2(f, loop_rate) *
                  abs2(pid_lowpass_response(flte, loop_rate, f)) * abs2(pid_lowpass_response(fltd, loop_rate, f))
        spectrum[k] = 10 * Math.log10(D)
        if ((f >= band[0]) && (f <= top)) {
            sum += D
            count++
        }
    }
    return { dB: (count > 0) ? 10 * Math.log10(sum / count) : null, spectrum: spectrum }
}

// Оценка варианта values (объект имя → число, имена lowpass_param_names) на контексте lowpass_ctx.
// Гироскопная часть — notch-база с INS_GYRO_FILTER варианта; FLTE и FLTD крена и тангажа — из values
// (lowpass_axis_filters; нечисловые дают NaN в задержке и шуме D).
// Возвращает null, если у экземпляра нет FFT или Z1 (только «после») или контур ctx.loop_rate не положительное
// конечное число, иначе {
//   values, warnings (filters.warnings гироскопной части, как в evaluate_candidate),
//   kd: { roll, pitch } — копия ctx.kd (нет оси или нет ctx.kd — null): по ней lowpass_flags отличают «Kd нет»
//       от «D выключен»,
//   gyro: { band_dB, lag_ms: { 10, 30 }, spectrum, pre_spectrum } — evaluate_candidate({ ...ctx.notch, INS_GYRO_FILTER }):
//         шум гироскопа после фильтров в band_hz и задержка гироскопной части (filters_lag_ms),
//   dterm: { bins, roll: { dB, spectrum }, pitch: { dB, spectrum } } — шум D-составляющей (lowpass_dterm): PSD
//          гироскопа после фильтров варианта (оси X и Y), свёрнутая к loop_rate / 2 (alias_obj, режим "fold");
//          bins — 0…loop_rate / 2; у оси без Kd (null) или с Kd = 0 — null. Kd в сравнении вариантов
//          сокращается: метрика относительная,
//   lag_ms: { roll: { P: { 10, 30 }, D: { 10, 30 } }, pitch: { … } } — путь P = гироскопная часть + FLTE,
//           путь D = путь P + FLTD (производная одинакова у всех вариантов и в задержку не входит)
// }. Частоты задержки — lag_freqs_hz. Состояние gyro (FFT.H, FFT.bode.H) не меняется
function evaluate_lowpass(values, ctx) {
    const loop_rate = ctx.loop_rate
    if (!(Number.isFinite(loop_rate) && (loop_rate > 0))) {
        return null
    }
    const gyro_values = { ...ctx.notch, INS_GYRO_FILTER: values.INS_GYRO_FILTER }
    const gyro_eval = evaluate_candidate(gyro_values, ctx)
    if (gyro_eval == null) {
        return null
    }
    const gyro = ctx.gyro
    const index = ctx.sensor
    const FFT = gyro[index].FFT

    // PSD после фильтров варианта, свёрнутая к частоте Найквиста контура. Своя H на сетке FFT, как в
    // evaluate_candidate: FFT.H не трогаем; окна — до конца диапазона
    const filters = load_filters(gyro_values, ctx.env, ctx.tracking)
    const end_index = find_end_index(FFT.time, ctx.range) + 1
    const H = filter_transfer(filters, index, FFT.time.slice(0, end_index), FFT.average_sample_rate, FFT.Z1, FFT.Z2)
    const alias = alias_obj(FFT, { mode: "fold", loop_rate: loop_rate })
    const psd = estimate_post(gyro, index, spectrum_amplitude_scale("PSD"), ctx.range, alias, H)

    const kd = {}
    const dterm = { bins: alias.bins }
    const lag_ms = {}
    for (const [axis, names] of Object.entries(lowpass_pid_axes)) {
        kd[axis] = ctx.kd?.[axis] ?? null
        const { flte, fltd } = lowpass_axis_filters(values, axis)
        dterm[axis] = lowpass_dterm(alias.bins, psd[names.gyro], kd[axis], flte, fltd, loop_rate)

        const P = {}
        const D = {}
        for (const f of lowpass_rules.lag_freqs_hz) {
            P[f] = gyro_eval.lag_ms[f] + pid_lowpass_lag_ms(flte, loop_rate, f)
            D[f] = P[f] + pid_lowpass_lag_ms(fltd, loop_rate, f)
        }
        lag_ms[axis] = { P: P, D: D }
    }

    return {
        values: values,
        warnings: gyro_eval.warnings,
        kd: kd,
        gyro: { band_dB: gyro_eval.band_dB, lag_ms: gyro_eval.lag_ms, spectrum: gyro_eval.spectrum, pre_spectrum: gyro_eval.pre_spectrum },
        dterm: dterm,
        lag_ms: lag_ms,
    }
}

// Бодэ для графика: гироскопная часть и пути P и D обеих осей одним вызовом (гироскопная часть считается один раз).
// H гироскопной части (notch-база с INS_GYRO_FILTER варианта) на сетке 0…loop_rate / 2 шагом step (0.05 Гц, как
// в filters_lag_ms: get_phase считает спад больше 45° за шаг переносом фазы, поэтому сетка плотная и от нуля):
// filter_transfer на exp_jw(сетка, FFT.average_sample_rate) по окнам до конца интервала, средние по окнам интервала
// амплитуда (complex_abs) и развёрнутая фаза (get_phase). Путь P оси — она, умноженная на FLTE оси, путь D — ещё
// и на FLTD (lowpass_axis_filters; в дБ и градусах — сложение; фаза фильтров ПИД по модулю меньше 90°, развёртка
// не нужна). → { freq, gyro: { amp_dB, phase_deg }, roll: { P: { amp_dB, phase_deg }, D: { … } }, pitch: { … } }
// (амплитуда 20·log10, фаза в градусах без свёртки); null, если у экземпляра нет FFT, контур ctx.loop_rate или step
// не положительное конечное число. Состояние gyro не меняется
function lowpass_bode(values, ctx, step = 0.05) {
    const loop_rate = ctx.loop_rate
    if (!(Number.isFinite(step) && (step > 0)) || !(Number.isFinite(loop_rate) && (loop_rate > 0))) {
        return null
    }
    const gyro = ctx.gyro
    const index = ctx.sensor
    if ((gyro[index] == null) || (gyro[index].FFT == null) || (gyro[index].FFT.x.length == 0)) {
        return null
    }
    const FFT = gyro[index].FFT

    // Сетка k·step до loop_rate / 2 включительно (допуск — чтобы не потерять последнюю точку на округлении)
    const freq = []
    const count = Math.floor((loop_rate / 2) / step + 1e-9)
    for (let k = 0; k <= count; k++) {
        freq.push(k * step)
    }

    const filters = load_filters({ ...ctx.notch, INS_GYRO_FILTER: values.INS_GYRO_FILTER }, ctx.env, ctx.tracking)
    const start_index = find_start_index(FFT.time, ctx.range)
    const end_index = find_end_index(FFT.time, ctx.range) + 1
    const Z = exp_jw(freq, FFT.average_sample_rate)
    const H = filter_transfer(filters, index, FFT.time.slice(0, end_index), FFT.average_sample_rate, complex_inverse(Z), complex_inverse(complex_square(Z)))

    // Средние по окнам интервала
    const amp = new Array(freq.length).fill(0)
    const phase = new Array(freq.length).fill(0)
    for (let j = start_index; j < end_index; j++) {
        const window_amp = complex_abs(H[j])
        const window_phase = get_phase(H[j])
        for (let k = 0; k < freq.length; k++) {
            amp[k] += window_amp[k]
            phase[k] += window_phase[k]
        }
    }
    const mean_length = end_index - start_index
    const result = {
        freq: freq,
        gyro: { amp_dB: amp.map((a) => 20 * Math.log10(a / mean_length)), phase_deg: phase.map((p) => p / mean_length) },
    }

    // Амплитуда в дБ и фаза в градусах фильтра первого порядка
    const dB = (h) => 20 * Math.log10(Math.hypot(h[0], h[1]))
    const deg = (h) => Math.atan2(h[1], h[0]) * 180 / Math.PI
    for (const axis of Object.keys(lowpass_pid_axes)) {
        const { flte, fltd } = lowpass_axis_filters(values, axis)
        const P = { amp_dB: new Array(freq.length), phase_deg: new Array(freq.length) }
        const D = { amp_dB: new Array(freq.length), phase_deg: new Array(freq.length) }
        for (let k = 0; k < freq.length; k++) {
            const e = pid_lowpass_response(flte, loop_rate, freq[k])
            const d = pid_lowpass_response(fltd, loop_rate, freq[k])
            P.amp_dB[k] = result.gyro.amp_dB[k] + dB(e)
            P.phase_deg[k] = result.gyro.phase_deg[k] + deg(e)
            D.amp_dB[k] = P.amp_dB[k] + dB(d)
            D.phase_deg[k] = P.phase_deg[k] + deg(d)
        }
        result[axis] = { P: P, D: D }
    }
    return result
}

// Отметки варианта evaluation против лога log (обе — evaluate_lowpass, могут быть null):
//   noisier — что шумнее лога больше чем на max_noise_increase_dB: "gyro" (полоса гироскопа), "roll", "pitch" (шум D);
//   slower — пути, где задержка на lowpass_lag_hz(rules) (30 Гц) больше лога на max_lag_increase_ms:
//            [{ axis: "roll" | "pitch", path: "P" | "D" }];
//   incomplete — нет оценки варианта или лога, полоса гироскопа у одного из них нечисловая; тогда остальные проверки
//                не делаются (списки пусты);
//   incomplete_axes — оси, у которых числа шума D нет хотя бы у одного: dterm null (Kd нет в логе) или пустая полоса
//                     (dB null). Если dterm null у обоих — без отметки шума; иначе сравнивать не с чем, и ось ещё
//                     и в noisier. NaN (нечисловой FLTE или FLTD) — не отсутствие числа: такая ось только в noisier.
//                     Путь D таких осей проверяется;
//   d_off_axes — оси с Kd = 0 у обоих (D выключен, kd из evaluate_lowpass): шум D не сравнивается, путь D
//                не проверяется, путь P — проверяется. Kd = 0 только у одного — как шум D только у одного; если
//                у другого Kd нет (null), dterm null у обоих, и ось только в incomplete_axes.
// Проверки отказывают при сомнении: !(разница ≤ порога), разница нечисловых значений (NaN, null, нет поля) — NaN,
// поэтому такие места отмечаются. Ровно на пороге — без отметки [наше].
// → { noisier: [...], slower: [...], incomplete, incomplete_axes: [...], d_off_axes: [...] }
function lowpass_flags(evaluation, log, rules = lowpass_rules) {
    const flags = { noisier: [], slower: [], incomplete: false, incomplete_axes: [], d_off_axes: [] }
    const complete = (e) => (e != null) && Number.isFinite(e.gyro?.band_dB)
    if (!complete(evaluation) || !complete(log)) {
        flags.incomplete = true
        return flags
    }
    const delta = (a, b) => (Number.isFinite(a) && Number.isFinite(b)) ? a - b : NaN
    const lag_hz = lowpass_lag_hz(rules)
    const axes = Object.keys(lowpass_pid_axes)

    if (!(delta(evaluation.gyro.band_dB, log.gyro.band_dB) <= rules.max_noise_increase_dB)) {
        flags.noisier.push("gyro")
    }
    for (const axis of axes) {
        if ((evaluation.kd?.[axis] === 0) && (log.kd?.[axis] === 0)) {
            flags.d_off_axes.push(axis)
            continue
        }
        const own = evaluation.dterm?.[axis]
        const base = log.dterm?.[axis]
        if ((own == null) && (base == null)) {
            flags.incomplete_axes.push(axis)
            continue
        }
        if ((own?.dB == null) || (base?.dB == null)) {
            flags.incomplete_axes.push(axis)
        }
        if (!(delta(own?.dB, base?.dB) <= rules.max_noise_increase_dB)) {
            flags.noisier.push(axis)
        }
    }
    for (const axis of axes) {
        for (const path of ["P", "D"]) {
            if ((path == "D") && flags.d_off_axes.includes(axis)) {
                continue
            }
            if (!(delta(evaluation.lag_ms?.[axis]?.[path]?.[lag_hz], log.lag_ms?.[axis]?.[path]?.[lag_hz]) <= rules.max_lag_increase_ms)) {
                flags.slower.push({ axis: axis, path: path })
            }
        }
    }
    return flags
}

// Предупреждения о том, чего модель не учитывает (строки для вердикта); params — log_params (get → число или null):
// - notch-фильтр ошибки ПИД крена или тангажа (ATC_RAT_RLL/PIT_NEF ≠ 0): стоит на ошибке до FLTE (AC_PID.cpp,
//   update_all) и меняет шум D и задержку, а модель его не знает → строка на ось. Notch цели (NTF) стоит на цели,
//   как FLTT, и на шум D и задержку не влияет — о нём строки нет. Рыскания модель не касается вовсе;
// - быстрый поток контура скорости (FSTRATE_ENABLE > 0, Copter 4.7): ПИД скорости идёт на частоте гироскопа,
//   делённой на делитель от FSTRATE_DIV (ArduCopter/rate_thread.cpp, rate_controller_set_rates), а модель считает
//   свёртку и фильтры ПИД на SCHED_LOOP_RATE → строка с FSTRATE_ENABLE и FSTRATE_DIV (если он есть в логе) [код]
function lowpass_model_warnings(params) {
    const titles = { roll: "крена", pitch: "тангажа" }
    const warnings = []
    for (const [axis, names] of Object.entries(lowpass_pid_axes)) {
        const name = "ATC_RAT_" + names.param + "_NEF"
        const value = params.get(name)
        if ((value != null) && (value != 0)) {
            warnings.push("Notch-фильтр ошибки ПИД " + titles[axis] + " (" + name + " = " + value + ") стоит до FLTE и не учтён в шуме D и задержке")
        }
    }
    const fast = params.get("FSTRATE_ENABLE")
    if (fast > 0) {
        const div = params.get("FSTRATE_DIV")
        const settings = "FSTRATE_ENABLE = " + fast + ((div != null) ? ", FSTRATE_DIV = " + div : "")
        warnings.push("Контур скорости в быстром потоке (" + settings + "): модель считает свёртку и фильтры ПИД на SCHED_LOOP_RATE")
    }
    return warnings
}
