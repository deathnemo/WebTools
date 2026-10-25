// Проверки пригодности лога (шаг 0). Чистые функции без DOM.
// Источники порогов: [wiki] — ardupilot.org, [код] — исходники ArduPilot, [наше] — эвристика, у ArduPilot числа нет.

const check_rules = {
    vibe_warn: 30,                  // м/с²: выше — возможны проблемы [wiki, Measuring Vibration]
    vibe_fail: 60,                  // м/с²: выше — почти наверняка проблемы [wiki, Measuring Vibration]
    hover_min_s: 30,                // с: минимальное висение для усреднения спектра [wiki, Initial tuning flight]
    hover_throttle_tolerance: 0.05, // допустимое расхождение MOT_THST_HOVER и среднего газа [наше]
    hover_learn_min: 0.125,         // нижний предел обучения MOT_THST_HOVER [код, AP_MotorsMulticopter.h AP_MOTORS_THST_HOVER_MIN]
    hover_learn_max: 0.6875,        // верхний предел обучения MOT_THST_HOVER [код, AP_MotorsMulticopter.h AP_MOTORS_THST_HOVER_MAX]
    hover_learn_s: 30,              // с висения для обучения MOT_THST_HOVER: постоянная времени 10 с, ~95 % за 30 с [код, AP_MOTORS_THST_HOVER_TC]
    log_bitmask_pid: 12,           // номер бита PID в LOG_BITMASK [код, ArduCopter/defines.h MASK_LOG_PID]
    log_bitmask_imu_raw: 19,        // номер бита IMU_RAW [код, MASK_LOG_IMU_RAW]
    log_bitmask_attitude_fast: 0,   // номер бита ATTITUDE_FAST [код, MASK_LOG_ATTITUDE_FAST]; без него Copter пишет PIDx
                                    // и RATE с 10 Гц [код, ArduCopter/Copter.cpp ten_hz_logging_loop, rate_thread.cpp medium_logging_rate]
    pid_log_min_rate_hz: 100,       // Гц: ниже отклик на ступеньку шага 4 не считается [наше; шумовая оценка метода PIDReview —
                                    // до 25 Гц, дефект upstream 5]. То же, что PID_STEP_MIN_RATE в core/pid.js: этот файл
                                    // грузится раньше и под Node без него, равенство закреплено в tests/tunewizard-pid.test.cjs
    pid_log_rate_margin: 0.99,      // запас порога: warn ниже 100 · 0.99 = 99 Гц, чтобы лог ровно на 100 Гц не переключался
                                    // от дрожания меток [наше; то же, что PID_STEP_RATE_MARGIN в core/pid.js, там и обоснование]
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

    // Сообщения PID и их частота: ниже pid_log_min_rate_hz (с запасом pid_log_rate_margin) отклик на ступеньку шага 4
    // не считается. Частота — того сообщения, по которому выбрана ветка: PIDR при messages.pid, иначе RATE
    // (info.pid_log_rates; нет частоты — объявлено без отсчётов или старые сведения — проверки частоты нет)
    const pid_fix = "Включите бит PID (" + r.log_bitmask_pid + ") в LOG_BITMASK и перелетите"
    const rate_message = m.pid ? "PIDR" : (m.rate ? "RATE" : null)
    const hz = (rate_message != null) ? (info.pid_log_rates?.[rate_message] ?? null) : null
    const slow = (hz != null) && (hz < r.pid_log_min_rate_hz * r.pid_log_rate_margin)
    // Частота словами — с отбрасыванием до десятых, без округления вверх: 98.97 — «98.9», а не «99»
    const hz_text = (hz == null) ? "" : String(Math.floor(hz * 10) / 10)
    const slow_text = slow ? rate_message + " пишется с частотой " + hz_text + " Гц — ниже " + r.pid_log_min_rate_hz + " Гц отклик на ступеньку на шаге 4 не считается" : ""
    const fast_fix = "без него Copter пишет PID и RATE с частотой 10 Гц"
    if (m.pid && slow) {
        add("pid_log", "warn", "Сообщения PID", "PIDR/PIDP/PIDY есть, но " + slow_text,
            "Включите бит ATTITUDE_FAST (" + r.log_bitmask_attitude_fast + ") в LOG_BITMASK и перелетите: " + fast_fix)
    } else if (m.pid) {
        add("pid_log", "ok", "Сообщения PID", "PIDR/PIDP/PIDY есть" + ((hz != null) ? " (" + hz_text + " Гц)" : "") + ": доступны компоненты P/I/D/FF, отфильтрованные цель и ошибка")
    } else if (m.rate) {
        add("pid_log", "warn", "Сообщения PID", "Есть только RATE: на шаге 4 не будет компонент P/I/D" + (slow ? "; " + slow_text : ""),
            slow ? "Включите биты PID (" + r.log_bitmask_pid + ") и ATTITUDE_FAST (" + r.log_bitmask_attitude_fast + ") в LOG_BITMASK и перелетите: " + fast_fix : pid_fix)
    } else {
        add("pid_log", "fail", "Сообщения PID", "Нет ни PID, ни RATE: шаг 4 недоступен", pid_fix)
    }

    // Данные гироскопа
    if (m.gyro_raw || m.gyro_batch) {
        add("gyro_log", "ok", "Данные гироскопа", "Есть " + (m.gyro_raw ? "raw (GYR)" : "batch (ISBH/ISBD)") + ": шаги 1–3 доступны")
    } else {
        add("gyro_log", "fail", "Данные гироскопа", "Нет ни raw (GYR), ни batch (ISBH/ISBD): шаги 1–3 недоступны",
            "Batch: INS_LOG_BAT_MASK = 1, INS_LOG_BAT_OPT = 4. Raw (нужна быстрая плата, обычно H7): бит IMU_RAW (" + r.log_bitmask_imu_raw + ") в LOG_BITMASK, INS_RAW_LOG_OPT = 8")
    }

    // До/после фильтров
    if (m.gyro_raw) {
        const opt = params.get("INS_RAW_LOG_OPT") ?? 0
        if (opt & (1 << 3)) {
            add("pre_post", "ok", "До/после фильтров", "Raw-лог до и после фильтров: оценку «станет» можно сверить с реальными данными")
        } else if (opt & (1 << 2)) {
            add("pre_post", "warn", "До/после фильтров", "Raw-лог только после фильтров: спектра до фильтров и оценки «станет» не будет",
                "Добавьте бит 3 (+8) к INS_RAW_LOG_OPT и снимите бит 2 (−4): логирование до и после фильтров")
        } else {
            add("pre_post", "ok", "До/после фильтров", "Raw-лог только до фильтров: оценка «станет» строится расчётом, реальных данных после фильтров нет")
        }
    } else if (m.gyro_batch) {
        const opt = params.get("INS_LOG_BAT_OPT") ?? 0
        if (opt & (1 << 2)) {
            add("pre_post", "ok", "До/после фильтров", "Batch-лог до и после фильтров: оценку «станет» можно сверить с реальными данными")
        } else if (opt & (1 << 1)) {
            add("pre_post", "warn", "До/после фильтров", "Batch-лог только после фильтров: спектра до фильтров и оценки «станет» не будет",
                "Добавьте бит 2 (+4) к INS_LOG_BAT_OPT и снимите бит 1 (−2): логирование до и после фильтров")
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
        if (info.throttle_source == null) {
            add("flight", "fail", "Полёт", "Газ не определить: в логе нет CTUN и RATE")
        } else {
            // Окно полёта схлопывается, если ненулевой газ короче отступов throttle_window
            add("flight", "fail", "Полёт", "Ненулевого газа нет или он короче 3 с: полёта в логе нет")
        }
    } else if (info.flight.duration_s < r.hover_min_s) {
        add("flight", "warn", "Полёт", "Полёт с газом " + Math.round(info.flight.duration_s) + " с: мало для усреднения спектра", "Висение не меньше " + r.hover_min_s + " с без ввода")
    } else {
        const mean_text = (info.flight.mean_throttle != null) ? ", средний газ " + info.flight.mean_throttle.toFixed(2) : ""
        add("flight", "ok", "Полёт", "Полёт с газом " + Math.round(info.flight.duration_s) + " с" + mean_text)
    }

    // Вибрации
    if (vibe == null) {
        add("vibe", "warn", "Вибрации", "Сообщений VIBE нет: уровень вибраций не проверить")
    } else {
        if (!Number.isFinite(vibe.level)) {
            add("vibe", "warn", "Вибрации", "Уровень вибраций не определён (нет корректных данных VIBE)")
        } else {
            // Одна десятичная: 59.6 рядом с порогом 60 не должно читаться как «60»
            const text = "Уровень (95-й процентиль) " + vibe.level.toFixed(1) + " м/с², максимум " + vibe.max.toFixed(1) + " м/с²"
            if (vibe.level >= r.vibe_fail) {
                add("vibe", "fail", "Вибрации", text + ": выше " + r.vibe_fail + " — почти наверняка проблемы", "Проверьте крепление автопилота, балансировку пропеллеров и моторов")
            } else if (vibe.level >= r.vibe_warn) {
                add("vibe", "warn", "Вибрации", text + ": выше " + r.vibe_warn + " — возможны проблемы", "Проверьте крепление автопилота и балансировку пропеллеров")
            } else {
                add("vibe", "ok", "Вибрации", text)
            }
        }
        if (vibe.clip > 0) {
            add("clipping", "warn", "Clipping", vibe.clip + " событий clipping акселерометра", "Проверьте крепление автопилота и балансировку пропеллеров")
        } else {
            add("clipping", "ok", "Clipping", "Событий clipping нет")
        }
    }

    // Газ висения против MOT_THST_HOVER. Расхождение считается не к самому среднему газу, а к тому значению,
    // которое обучение вообще может дать: ArduPilot зажимает MOT_THST_HOVER в пределах hover_learn_min…hover_learn_max
    const hover = params.get("MOT_THST_HOVER")
    const mean = info.flight?.mean_throttle ?? null
    if ((hover != null) && (mean != null)) {
        const target = Math.min(Math.max(mean, r.hover_learn_min), r.hover_learn_max)
        const diff = Math.abs(hover - target)
        // Пояснение, почему значение не совпадёт с газом даже после обучения — в обеих ветках
        const limit_note = (mean < r.hover_learn_min)
            ? " (обучение ограничено снизу значением " + r.hover_learn_min + " — для очень мощного аппарата это нормально)"
            : ""
        let text = "MOT_THST_HOVER " + hover.toFixed(2) + ", средний газ в полёте " + mean.toFixed(2)
        if (diff > r.hover_throttle_tolerance) {
            const learning = params.get("MOT_HOVER_LEARN") == 2
            text += ": расхождение " + diff.toFixed(2) + limit_note
            if (learning) {
                text += " (обучение включено: большое расхождение значит, что висения в AltHold было мало)"
            }
            add("hover_throttle", "warn", "Газ висения", text,
                learning ? "Повисите не меньше " + r.hover_learn_s + " с в AltHold, чтобы значение обучилось" : "MOT_HOVER_LEARN = 2 (обучение с сохранением)")
        } else {
            add("hover_throttle", "ok", "Газ висения", text + limit_note)
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
