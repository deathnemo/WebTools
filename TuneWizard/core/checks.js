// Проверки пригодности лога (шаг 0). Чистые функции без DOM.
// Источники порогов: [wiki] — ardupilot.org, [код] — исходники ArduPilot, [наше] — эвристика, у ArduPilot числа нет.

const check_rules = {
    vibe_warn: 30,                  // м/с²: выше — возможны проблемы [wiki, Measuring Vibration]
    vibe_fail: 60,                  // м/с²: выше — почти наверняка проблемы [wiki, Measuring Vibration]
    hover_min_s: 30,                // с: минимальное висение для усреднения спектра [wiki, Initial tuning flight]
    hover_throttle_tolerance: 0.05, // допустимое расхождение MOT_THST_HOVER и среднего газа [наше]
    hover_learn_min: 0.125,         // нижний предел обучения MOT_THST_HOVER [код, AP_MotorsMulticopter.h AP_MOTORS_THST_HOVER_MIN]
    log_bitmask_pid: 12,            // номер бита PID в LOG_BITMASK [код, ArduCopter/defines.h MASK_LOG_PID]
    log_bitmask_imu_raw: 19,        // номер бита IMU_RAW [код, MASK_LOG_IMU_RAW]
}

// info — из log_info, params — из log_params, vibe — из vibe_summary (может быть null).
// Возвращает список { id, status: "ok" | "warn" | "fail", title, text, fix }.
function run_checks(info, params, vibe) {
    const checks = []
    const add = (id, status, title, text, fix) => checks.push({ id, status, title, text, fix: fix ?? null })
    const m = info.messages
    const r = check_rules

    // Аппарат
    if (info.vehicle === "Copter") {
        add("vehicle", "ok", "Аппарат", "Copter, " + (info.fw_string ?? "версия неизвестна") + (info.board ? ", " + info.board : ""))
    } else {
        add("vehicle", "fail", "Аппарат", "Лог от " + (info.vehicle ?? "неизвестного аппарата") + "; мастер поддерживает только Copter", "Загрузите лог ArduCopter")
    }

    // Сообщения PID
    const pid_fix = "Включите бит PID (" + r.log_bitmask_pid + ") в LOG_BITMASK и перелетите"
    if (m.pid) {
        add("pid_log", "ok", "Сообщения PID", "PIDR/PIDP/PIDY есть: доступны компоненты P/I/D/FF, отфильтрованные цель и ошибка")
    } else if (m.rate) {
        add("pid_log", "warn", "Сообщения PID", "Есть только RATE: на шаге 4 не будет компонент P/I/D", pid_fix)
    } else {
        add("pid_log", "fail", "Сообщения PID", "Нет ни PID, ни RATE: шаг 4 недоступен", pid_fix)
    }

    // Данные гироскопа
    if (m.gyro_raw || m.gyro_batch) {
        add("gyro_log", "ok", "Данные гироскопа", "Есть " + (m.gyro_raw ? "raw (GYR)" : "batch (ISBH/ISBD)") + ": шаги 1–3 доступны")
    } else {
        add("gyro_log", "fail", "Данные гироскопа", "Нет ни raw (GYR), ни batch (ISBH/ISBD): шаги 1–3 недоступны",
            "Batch: INS_LOG_BAT_MASK = 1, INS_LOG_BAT_OPT = 4. Raw (платы H7): бит IMU_RAW (" + r.log_bitmask_imu_raw + ") в LOG_BITMASK, INS_RAW_LOG_OPT = 8")
    }

    // До/после фильтров
    if (m.gyro_raw) {
        const opt = params.get("INS_RAW_LOG_OPT") ?? 0
        if (opt & (1 << 3)) {
            add("pre_post", "ok", "До/после фильтров", "Raw-лог до и после фильтров: оценку «станет» можно сверить с реальными данными")
        } else if (opt & (1 << 2)) {
            add("pre_post", "warn", "До/после фильтров", "Raw-лог только после фильтров: спектра до фильтров и оценки «станет» не будет", "INS_RAW_LOG_OPT = 8 (до и после)")
        } else {
            add("pre_post", "ok", "До/после фильтров", "Raw-лог только до фильтров: оценка «станет» строится расчётом, реальных данных после фильтров нет")
        }
    } else if (m.gyro_batch) {
        const opt = params.get("INS_LOG_BAT_OPT") ?? 0
        if (opt & (1 << 2)) {
            add("pre_post", "ok", "До/после фильтров", "Batch-лог до и после фильтров: оценку «станет» можно сверить с реальными данными")
        } else if (opt & (1 << 1)) {
            add("pre_post", "warn", "До/после фильтров", "Batch-лог только после фильтров: спектра до фильтров и оценки «станет» не будет", "INS_LOG_BAT_OPT = 4 (до и после)")
        } else {
            add("pre_post", "ok", "До/после фильтров", "Batch-лог только до фильтров: оценка «станет» строится расчётом, реальных данных после фильтров нет")
        }
    }

    // Источник трекинга notch
    if (m.esc) {
        add("tracking", "ok", "Источник трекинга notch", "ESC-телеметрия (ESC): лучший источник, сам подстраивается под нагрузку")
    } else if (m.rpm) {
        add("tracking", "ok", "Источник трекинга notch", "Датчик оборотов (RPM)")
    } else {
        add("tracking", "warn", "Источник трекинга notch", "Нет ESC-телеметрии и RPM: доступен только трекинг по газу (INS_HNTCH_MODE = 1)",
            "Если регуляторы умеют телеметрию или двунаправленный DShot — включите, это точнее")
    }

    // Полёт
    if (info.flight == null) {
        add("flight", "fail", "Полёт", "Газ не поднимался выше нуля: полёта в логе нет")
    } else if (info.flight.duration_s < r.hover_min_s) {
        add("flight", "warn", "Полёт", "Полёт с газом " + Math.round(info.flight.duration_s) + " с: мало для усреднения спектра", "Висение не меньше " + r.hover_min_s + " с без ввода")
    } else {
        add("flight", "ok", "Полёт", "Полёт с газом " + Math.round(info.flight.duration_s) + " с, средний газ " + (info.flight.mean_throttle ?? 0).toFixed(2))
    }

    // Вибрации
    if (vibe == null) {
        add("vibe", "warn", "Вибрации", "Сообщений VIBE нет: уровень вибраций не проверить")
    } else {
        const level = Math.round(vibe.level)
        const text = "Уровень (95-й процентиль) " + level + " м/с², максимум " + Math.round(vibe.max) + " м/с²"
        if (vibe.level >= r.vibe_fail) {
            add("vibe", "fail", "Вибрации", text + ": выше " + r.vibe_fail + " — почти наверняка проблемы", "Проверьте крепление автопилота, балансировку пропеллеров и моторов")
        } else if (vibe.level >= r.vibe_warn) {
            add("vibe", "warn", "Вибрации", text + ": выше " + r.vibe_warn + " — возможны проблемы", "Проверьте крепление автопилота и балансировку пропеллеров")
        } else {
            add("vibe", "ok", "Вибрации", text)
        }
        if (vibe.clip > 0) {
            add("clipping", "warn", "Clipping", vibe.clip + " событий clipping акселерометра", "Проверьте крепление автопилота и балансировку пропеллеров")
        } else {
            add("clipping", "ok", "Clipping", "Событий clipping нет")
        }
    }

    // Газ висения против MOT_THST_HOVER
    const hover = params.get("MOT_THST_HOVER")
    const mean = info.flight?.mean_throttle ?? null
    if ((hover != null) && (mean != null)) {
        const diff = Math.abs(hover - mean)
        let text = "MOT_THST_HOVER " + hover.toFixed(2) + ", средний газ в полёте " + mean.toFixed(2)
        if (diff > r.hover_throttle_tolerance) {
            const learning = params.get("MOT_HOVER_LEARN") == 2
            text += ": расхождение " + diff.toFixed(2)
            // ArduPilot не обучает значение ниже предела
            if (mean < r.hover_learn_min) {
                text += " (обучение ограничено снизу значением " + r.hover_learn_min + " — для очень мощного аппарата это нормально)"
            }
            if (learning) {
                text += " (обучение включено, значение сохранится после полёта)"
            }
            add("hover_throttle", "warn", "Газ висения", text,
                learning ? "Повисите не меньше 30 с в AltHold, чтобы значение обучилось" : "MOT_HOVER_LEARN = 2 (обучение с сохранением)")
        } else {
            add("hover_throttle", "ok", "Газ висения", text)
        }
    }

    return checks
}

// Итог по списку проверок
function checks_summary(checks) {
    const count = { ok: 0, warn: 0, fail: 0 }
    for (const c of checks) {
        count[c.status]++
    }
    const status = (count.fail > 0) ? "fail" : (count.warn > 0) ? "warn" : "ok"
    return { status, ...count }
}

if (typeof module !== "undefined") {
    module.exports = { check_rules, run_checks, checks_summary }
}
