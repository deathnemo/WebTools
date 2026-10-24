// Низкочастотные фильтры шага 3: значения по размеру винта (формулы Mission Planner), варианты и их оценка —
// шум гироскопа после фильтров, шум D-составляющей и задержка путей P и D. Без DOM: работает в браузере и под
// Node (тесты). Дизайн — docs/plans/2026-10-24-tune-wizard-stage3-design.md.
// Источники: [MP] — Mission Planner GCSViews/ConfigurationView/ConfigInitialParams.cs (calc_values);
// [wiki] — ardupilot.org/copter/docs/setting-up-for-tuning.html; [код] — исходники ArduPilot; [наше] — эвристика мастера.
//
// Нужны глобалы страницы: Libraries/Array_Math.js, core/gyro.js (find_start_index, find_end_index),
// core/filters.js (load_filters, filter_transfer, estimate_post, get_phase), core/spectrum.js
// (spectrum_amplitude_scale, alias_obj) и core/candidates.js (evaluate_candidate, candidate_key).

const lowpass_rules = {
    gyro_filter: { scale: 289.22, power: -0.838, min_hz: 20 },   // INS_GYRO_FILTER по размеру винта [MP]
    pid_filter_min_hz: 10,              // FLTT/FLTD = max(10, INS_GYRO_FILTER / 2) [MP; wiki — INS_GYRO_FILTER / 2]
    yaw_flte_hz: 2,                     // ATC_RAT_YAW_FLTE [MP, wiki]
    accel_filter_hz: 10,                // INS_ACCEL_FILTER [MP, wiki]
    accel_rp: { poly: [-2.613267, 343.39216, -15083.7121, 235771], min_cdegss: 10000 },   // ATC_ACCEL_R/P_MAX [MP]
    accel_y: { slope: -900, offset: 36000, min_cdegss: 8000 },   // ATC_ACCEL_Y_MAX [MP]
    accel_default_degss: { rp: 1100, y: 270 },   // заводские пределы, AC_AttitudeControl.h [код]
    // Заводские фильтры Copter: AP_InertialSensor.cpp (DEFAULT_GYRO_FILTER, DEFAULT_ACCEL_FILTER),
    // AC_AttitudeControl_Multi.h (FLTT, FLTD 20 Гц по всем осям, FLTE крена/тангажа 0, рыскания 2.5 Гц) [код]
    defaults: { gyro_hz: 20, accel_hz: 20, fltt_hz: 20, fltd_hz: 20, flte_rp_hz: 0, flte_y_hz: 2.5 },
    prop_range_in: [3, 40],             // размер винта без предупреждения у поля [наше]
    band_hz: [20, 400],                 // полоса шума гироскопа; для D — до частоты Найквиста контура [наше]
    lag_freqs_hz: [10, 30],             // частоты задержки [наше]
    max_noise_increase_dB: 3,           // «шумнее лога» [наше, как на шаге 2]
    max_lag_increase_ms: 1,             // «медленнее лога» на 30 Гц (решение пользователя 24.10.2026) [наше]
}

const LOWPASS_AXES = ["RLL", "PIT", "YAW"]

// Math.Round из C# (по умолчанию — к чётному): так округляет Mission Planner
function round_half_even(value) {
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
// (округление половиной вверх); при precision ≥ 0 — Math.Round C# (к чётному). Math.Round(value, digits) в .NET
// масштабирует на 10^digits, округляет и делит обратно — так же и здесь
function mp_round_to(value, precision) {
    if (precision >= 0) {
        const scale = 10**precision
        return round_half_even(value * scale) / scale
    }
    const m = 10**(-precision)
    const v = value + m / 2
    return round_half_even(v - v % m)
}

// Значения по размеру винта p (дюймы) [MP]: INS_GYRO_FILTER, INS_ACCEL_FILTER, FLTT/FLTE/FLTD трёх осей
// и пределы ускорения в сантиградусах/с² (accel_cdegss: { r, p, y }) — имена пределов ставит lowpass_candidates
function prop_values(p) {
    const rules = lowpass_rules
    const gyro = Math.max(rules.gyro_filter.min_hz, round_half_even(rules.gyro_filter.scale * p**rules.gyro_filter.power))
    const pid = Math.max(rules.pid_filter_min_hz, gyro / 2)

    const values = { INS_GYRO_FILTER: gyro, INS_ACCEL_FILTER: rules.accel_filter_hz }
    for (const axis of LOWPASS_AXES) {
        const yaw = (axis == "YAW")
        values["ATC_RAT_" + axis + "_FLTT"] = pid
        values["ATC_RAT_" + axis + "_FLTE"] = yaw ? rules.yaw_flte_hz : 0   // крен и тангаж без FLTE [MP]
        values["ATC_RAT_" + axis + "_FLTD"] = yaw ? 0 : pid                 // рыскание без FLTD [MP]
    }

    // Порядок действий — как в calc_values, чтобы совпало до последнего бита перед RoundTo
    const [a3, a2, a1, a0] = rules.accel_rp.poly
    const rp = Math.max(rules.accel_rp.min_cdegss, mp_round_to(a3 * p**3 + a2 * p**2 + a1 * p + a0, -2))
    const y = Math.max(rules.accel_y.min_cdegss, mp_round_to(rules.accel_y.slope * p + rules.accel_y.offset, -2))
    values.accel_cdegss = { r: rp, p: rp, y: y }
    return values
}

// Размер винта, которому формула [MP] даёт частоту hz (без клампа и округления); null при hz ≤ 0
function prop_from_gyro_filter(hz) {
    if (!(hz > 0)) {
        return null
    }
    const rules = lowpass_rules.gyro_filter
    return (hz / rules.scale)**(1 / rules.power)
}

// Имена и единицы пределов ускорения по логу: ATC_ACCEL_*_MAX (сантиградусы/с², 4.6 и раньше) или ATC_ACC_*_MAX (°/с²).
// scale — во сколько раз значение параметра больше значения в °/с²
function accel_names(params) {
    if (params.has("ATC_ACCEL_R_MAX")) {
        return { r: "ATC_ACCEL_R_MAX", p: "ATC_ACCEL_P_MAX", y: "ATC_ACCEL_Y_MAX", scale: 100, units: "cdeg/s/s" }
    }
    return { r: "ATC_ACC_R_MAX", p: "ATC_ACC_P_MAX", y: "ATC_ACC_Y_MAX", scale: 1, units: "deg/s/s" }
}

// Параметры шага по порядку: INS_GYRO_FILTER, INS_ACCEL_FILTER, FLTT/FLTE/FLTD крена, тангажа и рыскания,
// пределы ускорения r, p, y под именами из лога (accel_names)
function lowpass_param_names(params) {
    const names = ["INS_GYRO_FILTER", "INS_ACCEL_FILTER"]
    for (const axis of LOWPASS_AXES) {
        names.push("ATC_RAT_" + axis + "_FLTT", "ATC_RAT_" + axis + "_FLTE", "ATC_RAT_" + axis + "_FLTD")
    }
    const accel = accel_names(params)
    names.push(accel.r, accel.p, accel.y)
    return names
}

// Значения параметров шага из лога (объект имя → число в порядке lowpass_param_names); чего в логе нет —
// заводские Copter (lowpass_rules.defaults, пределы — accel_default_degss × scale). Как float32: так их хранит
// прошивка, и 0.7 из файла .param совпадает с 0.699999988 из лога
function lowpass_log_values(params) {
    const rules = lowpass_rules
    const accel = accel_names(params)
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
// 0.5·scale по каждой оси. names — accel_names; нет значения под этим именем — не заводские
function accel_is_default(values, names) {
    const defaults = lowpass_rules.accel_default_degss
    const tolerance = 0.5 * names.scale
    const near = (value, default_degss) => Math.abs(value - default_degss * names.scale) <= tolerance
    return near(values[names.r], defaults.rp) && near(values[names.p], defaults.rp) && near(values[names.y], defaults.y)
}

// Предупреждение у поля размера винта: текст, если размер вне prop_range_in или не число (NaN, ≤ 0); null, если
// размер в диапазоне или не введён (null/undefined — тогда нет варианта по размеру, об этом пишет вердикт) [наше]
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

// Варианты: «как в логе»; «по размеру винта» (только с p > 0; пределы ускорения — по формуле, только если в логе
// заводские, иначе из лога: их записывает AutoTune, AC_AutoTune_Multi.cpp); «лог + правило /2». Одинаковые наборы
// — один раз (первый по порядку). Возвращает [{ id, title, values }].
// log_values — lowpass_log_values(params), prop_in — размер винта в дюймах, как ввёл пользователь (null, если не
// введён), names — accel_names(params). У всех вариантов ровно ключи log_values; значения — float32, как у лога,
// чтобы совпадение с логом было честным
function lowpass_candidates(log_values, prop_in, names) {
    const rules = lowpass_rules
    const candidates = [{ id: "log", title: "Как в логе", values: { ...log_values } }]

    if (prop_in > 0) {
        const { accel_cdegss, ...filters } = prop_values(prop_in)
        const values = { ...log_values, ...filters }
        if (accel_is_default(log_values, names)) {
            // Формула [MP] — в сантиградусах/с²; для ATC_ACC_*_MAX Mission Planner делит на 100
            values[names.r] = accel_cdegss.r * names.scale / 100
            values[names.p] = accel_cdegss.p * names.scale / 100
            values[names.y] = accel_cdegss.y * names.scale / 100
        }
        candidates.push({ id: "prop", title: "По размеру винта (" + prop_in + "″)", values: values })
    }

    const half = Math.max(rules.pid_filter_min_hz, log_values.INS_GYRO_FILTER / 2)
    const half_values = { ...log_values }
    for (const axis of ["RLL", "PIT"]) {
        half_values["ATC_RAT_" + axis + "_FLTT"] = half
        half_values["ATC_RAT_" + axis + "_FLTD"] = half
    }
    half_values.ATC_RAT_YAW_FLTT = half
    candidates.push({ id: "half", title: "Лог + правило /2", values: half_values })

    // Значения — float32, как у лога
    for (const candidate of candidates) {
        for (const name of Object.keys(candidate.values)) {
            candidate.values[name] = Math.fround(candidate.values[name])
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
