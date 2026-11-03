// Проверки пригодности лога (шаг 0). Чистые функции без DOM.
// Источники порогов: [wiki] — ardupilot.org, [код] — исходники ArduPilot, [наше] — эвристика, у ArduPilot числа нет.

const check_rules = {
    vibe_warn: 30,                  // м/с²: выше — возможны проблемы [wiki, Measuring Vibration]
    vibe_fail: 60,                  // м/с²: выше — почти наверняка проблемы [wiki, Measuring Vibration]
    hover_min_s: 30,                // с: минимальное висение для усреднения спектра [wiki, Initial tuning flight]
    hover_throttle_tolerance: 0.05, // допустимое расхождение MOT_THST_HOVER и среднего газа [наше]
    // Пределы и время обучения газа висения — одни у MOT_THST_HOVER Copter и Q_M_THST_HOVER QuadPlane: тот же
    // AP_MotorsMulticopter [код] ArduPlane/quadplane.cpp:17–19
    hover_learn_min: 0.125,         // нижний предел обучения MOT_THST_HOVER [код, AP_MotorsMulticopter.h AP_MOTORS_THST_HOVER_MIN]
    hover_learn_max: 0.6875,        // верхний предел обучения MOT_THST_HOVER [код, AP_MotorsMulticopter.h AP_MOTORS_THST_HOVER_MAX]
    hover_learn_s: 30,              // с висения для обучения MOT_THST_HOVER: постоянная времени 10 с, ~95 % за 30 с [код, AP_MOTORS_THST_HOVER_TC]
    log_bitmask_pid: 12,           // номер бита PID в LOG_BITMASK [код, ArduCopter/defines.h MASK_LOG_PID]
    log_bitmask_imu_raw: 19,        // номер бита IMU_RAW [код, MASK_LOG_IMU_RAW]
    log_bitmask_attitude_fast: 0,   // номер бита ATTITUDE_FAST [код, MASK_LOG_ATTITUDE_FAST]; без него Copter пишет PIDx
                                    // и RATE с 10 Гц [код, ArduCopter/Copter.cpp ten_hz_logging_loop, rate_thread.cpp medium_logging_rate]
    // ArduPlane (QuadPlane): PIQR/PIQP/PIQY пишутся вместе с ATT, пока работал регулятор VTOL; с частотой цикла — только при
    // бите ATTITUDE_FULLRATE (номер — fullrate_bit профиля, core/vehicle.js), при ATTITUDE_FAST без него — 25 Гц, при одном
    // ATTITUDE_MED — 10 Гц; бита PID нет, бит 12 у Plane — CAMERA [код] ArduPlane/defines.h:102–121, Plane.cpp:269–312,
    // Log.cpp:30–34, 59–65; [4.6.3] defines.h:109–126. RATE у QuadPlane пишется с частотой цикла без LOG_BITMASK
    // [код] ArduPlane/quadplane.cpp:1812–1826
    plane_log_bitmask_attitude_fast: 0,
    plane_attitude_fast_hz: 25,
    plane_log_bitmask_attitude_med: 1,
    plane_attitude_med_hz: 10,
    pid_log_min_rate_hz: 100,       // Гц: ниже отклик на ступеньку шага 4 не считается [наше; шумовая оценка метода PIDReview —
                                    // до 25 Гц, дефект upstream 5]. То же, что PID_STEP_MIN_RATE в core/pid.js: этот файл
                                    // грузится раньше и под Node без него, равенство закреплено в tests/tunewizard-pid.test.cjs
    pid_log_rate_margin: 0.99,      // запас порога: warn ниже 100 · 0.99 = 99 Гц, чтобы лог ровно на 100 Гц не переключался
                                    // от дрожания меток [наше; то же, что PID_STEP_RATE_MARGIN в core/pid.js, там и обоснование]
    // Совет при отсутствии записи гироскопа (gyro_log) и исправление batch «до и после» (pre_post): batch основного IMU
    // (INS_LOG_BAT_MASK бит 0) до и после фильтров (INS_LOG_BAT_OPT — только бит 2) — работает на любой плате
    // [код] AP_InertialSensor/BatchSampler.cpp:17–30; [решение пользователя 30.10.2026, дизайн этапа 7, раздел 10, в].
    // Те же значения берёт подготовка к полёту (core/prep.js, prep_rules.batch_fix)
    gyro_batch_fix: { INS_LOG_BAT_MASK: 1, INS_LOG_BAT_OPT: 4 },
    // Совет raw для быстрых плат: INS_RAW_LOG_OPT = 9 — основной гироскоп (бит 0 сам включает raw-запись) до и после
    // фильтров (бит 3); бит IMU_RAW в LOG_BITMASK не нужен — он пишет raw всех гироскопов и акселерометров
    // [код] AP_InertialSensor/AP_InertialSensor_Backend.cpp:480–487, 489–492, 750–751. Подготовка — prep_rules.raw_hint
    gyro_raw_hint: 9,
}

// info — из log_info (в том числе info.esc — сводка ESC-телеметрии; info.profile — профиль аппарата core/vehicle.js,
// null — вид не поддержан; info.tailsitter), params — из log_params, vibe — из vibe_summary (может быть null).
// Возвращает список { id, status: "ok" | "warn" | "fail", title, text, fix }. Без профиля — «Аппарат» (СТОП) и проверки,
// не зависящие от аппарата (данные гироскопа, до/после фильтров, трекинг, вибрации, clipping): сообщения PID, газ полёта и
// газ висения неподдержанного аппарата судить не по чему (у Plane без QuadPlane PIDR — самолётные регуляторы, бит 12 —
// CAMERA, CTUN.ThO — самолётный мотор)
function run_checks(info, params, vibe) {
    const checks = []
    const add = (id, status, title, text, fix) => checks.push({ id, status, title, text, fix: fix ?? null })
    const m = info.messages
    const r = check_rules
    const profile = info.profile ?? null

    // Аппарат
    if (profile != null) {
        add("vehicle", "ok", "Аппарат", profile.title + (info.tailsitter ? " (tailsitter)" : "") + ", " + (info.fw_string ?? "версия неизвестна") + (info.board ? ", " + info.board : ""))
    } else {
        add("vehicle", "fail", "Аппарат", "Лог от " + (info.vehicle ?? "неизвестного аппарата") + "; мастер поддерживает Copter и QuadPlane",
            "Загрузите лог ArduCopter или ArduPlane с Q_ENABLE ≥ 1")
    }

    // Сообщения PID и их частота: ниже pid_log_min_rate_hz (с запасом pid_log_rate_margin) отклик на ступеньку шага 4
    // не считается. Частота — того сообщения, по которому выбрана ветка: первое сообщение PID профиля (PIDR, PIQR) при
    // messages.pid, иначе RATE (info.pid_log_rates; нет частоты — объявлено без отсчётов или старые сведения — проверки
    // частоты нет)
    const pid_names = profile?.pid_messages ?? []
    const rate_message = m.pid ? pid_names[0] : (m.rate ? "RATE" : null)
    const hz = (rate_message != null) ? (info.pid_log_rates?.[rate_message] ?? null) : null
    const slow = (hz != null) && (hz < r.pid_log_min_rate_hz * r.pid_log_rate_margin)
    // Частота словами — с отбрасыванием до десятых, без округления вверх: 98.97 — «98.9», а не «99»
    const hz_text = (hz == null) ? "" : String(Math.floor(hz * 10) / 10)
    if ((profile != null) && (profile.fullrate_bit == null)) {
        // Copter: PID с частотой цикла — биты PID и ATTITUDE_FAST; без PID и RATE шаг 4 недоступен
        const pid_fix = "Включите бит PID (" + r.log_bitmask_pid + ") в LOG_BITMASK и перелетите"
        const slow_text = slow ? rate_message + " пишется с частотой " + hz_text + " Гц — ниже " + r.pid_log_min_rate_hz + " Гц отклик на ступеньку на шаге 4 не считается" : ""
        const fast_fix = "без него Copter пишет PID и RATE с частотой 10 Гц"
        if (m.pid && slow) {
            add("pid_log", "warn", profile.pid_title, pid_names.join("/") + " есть, но " + slow_text,
                "Включите бит ATTITUDE_FAST (" + r.log_bitmask_attitude_fast + ") в LOG_BITMASK и перелетите: " + fast_fix)
        } else if (m.pid) {
            add("pid_log", "ok", profile.pid_title, pid_names.join("/") + " есть" + ((hz != null) ? " (" + hz_text + " Гц)" : "") + ": доступны компоненты P/I/D/FF, отфильтрованные цель и ошибка")
        } else if (m.rate) {
            add("pid_log", "warn", profile.pid_title, "Есть только RATE: по нему на шаге 4 нет компонент P/I/D, шума D и прогноза — только отклик и правила" + (slow ? "; " + slow_text : ""),
                slow ? "Включите биты PID (" + r.log_bitmask_pid + ") и ATTITUDE_FAST (" + r.log_bitmask_attitude_fast + ") в LOG_BITMASK и перелетите: " + fast_fix : pid_fix)
        } else {
            add("pid_log", "fail", profile.pid_title, "Нет ни PID, ни RATE: шаг 4 недоступен", pid_fix)
        }
    } else if (profile != null) {
        // QuadPlane: PID с частотой цикла пишет один бит fullrate_bit (ATTITUDE_FULLRATE), совета «бит 12» нет — у Plane это
        // CAMERA (check_rules, plane_*). RATE не в счёт: он пишется всегда. Пока шага 4 у вида нет (profile.steps), проверка
        // справочная — без СТОП, совет — для будущего шага 4 [решение пользователя 30.10.2026, дизайн этапа 9, раздел 4]
        const step4 = profile.steps.includes(4)
        const step4_note = step4 ? "" : "; шаг 4 для " + profile.title + " пока недоступен"
        const bit = profile.fullrate_bit
        const fullrate_fix = "Включите бит ATTITUDE_FULLRATE (" + bit + ") в LOG_BITMASK (+" + (1 << bit) + ") — " + (step4 ? "для шага 4" : "для будущего шага 4") +
            ": без него " + pid_names.join("/") + " пишутся с частотой " + r.plane_attitude_fast_hz + " Гц (бит ATTITUDE_FAST, " + r.plane_log_bitmask_attitude_fast +
            ") или " + r.plane_attitude_med_hz + " Гц (только бит ATTITUDE_MED, " + r.plane_log_bitmask_attitude_med + ")"
        if (m.pid && slow) {
            add("pid_log", "warn", profile.pid_title, pid_names.join("/") + " есть, но " + rate_message + " пишется с частотой " + hz_text + " Гц — ниже " +
                r.pid_log_min_rate_hz + " Гц отклик на ступеньку не считается" + step4_note, fullrate_fix)
        } else if (m.pid) {
            add("pid_log", "ok", profile.pid_title, pid_names.join("/") + " есть" + ((hz != null) ? " (" + hz_text + " Гц)" : "") + step4_note)
        } else {
            add("pid_log", "warn", profile.pid_title, "Сообщений " + pid_names.join("/") + " нет" + step4_note, fullrate_fix)
        }
    }

    // Данные гироскопа. Совет — batch (gyro_batch_fix) или raw (gyro_raw_hint); нет INS_RAW_LOG_OPT (старая прошивка) —
    // raw включается только битом IMU_RAW [код] AP_InertialSensor_Backend.cpp:485–487. Текст raw — тот же, что у
    // подготовки (core/prep.js, gyro_data)
    if (m.gyro_raw || m.gyro_batch) {
        add("gyro_log", "ok", "Данные гироскопа", "Есть " + (m.gyro_raw ? "raw (GYR)" : "batch (ISBH/ISBD)") + ": шаги 1–3 доступны")
    } else {
        const batch_fix = Object.entries(r.gyro_batch_fix).map(([name, value]) => name + " = " + value).join(", ")
        const raw_fix = (params.get("INS_RAW_LOG_OPT") != null)
            ? "INS_RAW_LOG_OPT = " + r.gyro_raw_hint + " (основной гироскоп до и после фильтров; бит IMU_RAW не нужен)"
            : "бит IMU_RAW (" + r.log_bitmask_imu_raw + ") в LOG_BITMASK (+" + (1 << r.log_bitmask_imu_raw) + "; INS_RAW_LOG_OPT в этой прошивке нет)"
        add("gyro_log", "fail", "Данные гироскопа", "Нет ни raw (GYR), ни batch (ISBH/ISBD): шаги 1–3 недоступны",
            "Batch: " + batch_fix + ". Raw (нужна быстрая плата, обычно H7): " + raw_fix)
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
        // INS_LOG_BAT_OPT: бит 0 — Sensor-Rate, бит 1 — после фильтров, бит 2 — до и после [код] AP_InertialSensor/
        // BatchSampler.cpp:28, AP_InertialSensor.h:386–388. Бит 2 работает только без битов 0 и 1:
        // - с битом 1 (без бита 0) обе половины — после фильтров: флаг «после фильтров» включён (BatchSampler.cpp:97–102),
        //   и без Sensor-Rate doing_post_filter_logging() всегда true [код] AP_InertialSensor.h:351–353,
        //   AP_InertialSensor_Backend.cpp:507;
        // - с битом 0 на датчиках с выборкой на частоте датчика (Invensense v1/v2 по SPI с быстрой выборкой
        //   [код] AP_InertialSensor_Invensense.cpp:889–922, AP_InertialSensor_Invensensev2.cpp:611–638) batch берёт только
        //   сырые отсчёты — обе половины до фильтров [код] BatchSampler.cpp:103–115, AP_InertialSensor_Backend.cpp:503–508,
        //   727–738; на остальных датчиках бит 0 не действует, и с битом 1 обе половины — после фильтров.
        // Исправление одно — INS_LOG_BAT_OPT = 4 (gyro_batch_fix) и перезагрузка: флаги batch при смене параметра только
        // выставляются, не сбрасываются (BatchSampler.cpp:97–102) — снятый бит 1 действует после перезагрузки [наше, по
        // коду]. То же правило — gyro_prepost в core/prep.js
        const opt = params.get("INS_LOG_BAT_OPT") ?? 0
        const sensor_rate = (opt & (1 << 0)) != 0
        const post = (opt & (1 << 1)) != 0
        const prepost = (opt & (1 << 2)) != 0
        const fix = "Запишите INS_LOG_BAT_OPT = " + r.gyro_batch_fix.INS_LOG_BAT_OPT + " (только бит 2 — до и после фильтров) и перезагрузите полётный контроллер"
        const fix_post = fix + ": флаг «после фильтров» сбрасывается только перезагрузкой"
        if (prepost && (post || sensor_rate)) {
            const others = [sensor_rate ? "битом 0 (Sensor-Rate)" : null, post ? "битом 1 (после фильтров)" : null].filter((t) => t != null)
            const reason = !sensor_rate ? "обе половины пишутся после фильтров: спектр «до фильтров» на шаге 1 на самом деле после фильтров"
                : "на датчиках с выборкой на частоте датчика (Invensense v1/v2 по SPI) обе половины — сырые, до фильтров" +
                  (post ? ", на остальных бит 1 даёт обе после фильтров: «до» и «после» на шаге 1 не различаются"
                      : ": спектр «после фильтров» на шаге 1 на таких датчиках на самом деле до фильтров")
            add("pre_post", "warn", "До/после фильтров", "Batch-лог с INS_LOG_BAT_OPT = " + opt + ": бит 2 (до и после) вместе с " + others.join(" и ") + " — " + reason,
                post ? fix_post : fix)
        } else if (prepost) {
            add("pre_post", "ok", "До/после фильтров", "Batch-лог до и после фильтров: оценку «станет» можно сверить с реальными данными")
        } else if (post) {
            add("pre_post", "warn", "До/после фильтров", "Batch-лог только после фильтров: спектра до фильтров и оценки «станет» не будет", fix_post)
        } else {
            add("pre_post", "ok", "До/после фильтров", "Batch-лог только до фильтров: оценка «станет» строится расчётом, реальных данных после фильтров нет")
        }
    }

    // Источник трекинга notch. ESC хвалится, только если хоть один регулятор сообщал обороты (info.esc из esc_summary):
    // телеметрия без оборотов (все 0 или NaN) для notch бесполезна (аудит, I4)
    if (m.esc && ((info.esc?.with_rpm ?? 0) > 0)) {
        add("tracking", "ok", "Источник трекинга notch", "ESC-телеметрия (ESC): лучший источник, сам подстраивается под нагрузку")
    } else if (m.esc) {
        add("tracking", "warn", "Источник трекинга notch", "ESC-телеметрия (ESC) есть, но оборотов в ней нет (все значения 0 или NaN): трекинг по ESC (INS_HNTCH_MODE = 3) работать не будет",
            "Проверьте телеметрию регуляторов (SERVO_BLH_MASK, SERVO_BLH_POLES, двунаправленный DShot): обороты должны приходить в полёте")
    } else if (m.rpm) {
        add("tracking", "ok", "Источник трекинга notch", "Датчик оборотов (RPM)")
    } else {
        add("tracking", "warn", "Источник трекинга notch", "Нет ESC-телеметрии и RPM: доступен только трекинг по газу (INS_HNTCH_MODE = 1)",
            "Если регуляторы умеют телеметрию или двунаправленный DShot — включите, это точнее")
    }

    // Полёт: окно log_flight (core/log.js) по газу профиля (profile.throttle — ряды по порядку), у QuadPlane — самое длинное
    // окно участков VTOL-режимов (profile.vtol_modes), остальные называются («ещё VTOL»); в логе нет MODE — окно по газу за
    // весь лог с предупреждением [решение пользователя 30.10.2026, дизайн этапа 9, раздел 4]
    if (profile != null) {
        const flight = info.flight
        const vtol = profile.vtol_modes != null
        const mode_names = (modes) => modes.map((n) => profile.modes[n] ?? ("режим " + n)).join(", ")
        const span = (w) => w.start + "–" + w.end + " с"
        if (flight == null) {
            if (info.throttle_source == null) {
                add("flight", "fail", "Полёт", "Газ не определить: в логе нет " + profile.throttle.map(([name]) => name).join(" и "))
            } else if (!vtol) {
                // Окно полёта схлопывается, если ненулевой газ короче отступов throttle_window
                add("flight", "fail", "Полёт", "Ненулевого газа нет или он короче 3 с: полёта в логе нет")
            } else if (m.mode) {
                add("flight", "fail", "Полёт", "Участков VTOL-режимов (Q-режимов) с ненулевым газом дольше 3 с нет: VTOL-полёта в логе нет")
            } else {
                add("flight", "fail", "Полёт", "Ненулевого газа VTOL-моторов нет или он короче 3 с: VTOL-полёта в логе нет")
            }
        } else {
            const where = vtol ? " (" + span(flight) + ((flight.modes != null) ? ", " + mode_names(flight.modes) : "") + ")" : ""
            const others = (vtol && (flight.segments.length > 0))
                ? "; ещё VTOL: " + flight.segments.map((s) => span(s) + " (" + mode_names(s.modes) + ")").join(", ") : ""
            const text = profile.flight_title + " " + Math.round(flight.duration_s) + " с" + where
            const mean_text = (flight.mean_throttle != null) ? ", средний газ " + flight.mean_throttle.toFixed(2) : ""
            if (flight.duration_s < r.hover_min_s) {
                add("flight", "warn", "Полёт", text + ": мало для усреднения спектра" + others, "Висение не меньше " + r.hover_min_s + " с без ввода")
            } else if (vtol && (flight.modes == null)) {
                add("flight", "warn", "Полёт", text + mean_text + ": в логе нет MODE — окно взято по газу, в него мог попасть самолётный полёт",
                    "Проверьте окно по графику полёта и при необходимости задайте интервал вручную")
            } else {
                add("flight", "ok", "Полёт", text + mean_text + others)
            }
        }
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

    // Газ висения против <mot>THST_HOVER (MOT_ у Copter, Q_M_ у QuadPlane — тот же AP_MotorsMulticopter; средний газ — окна
    // полёта, у QuadPlane — VTOL-окна). Расхождение считается не к самому среднему газу, а к тому значению, которое обучение
    // вообще может дать: ArduPilot зажимает THST_HOVER в пределах hover_learn_min…hover_learn_max. Где газ висения учится —
    // profile.hover_learn_modes (у QuadPlane — только с регулятором высоты: не в QSTABILIZE и QACRO, profile.hover_learn_note)
    const hover_name = (profile != null) ? profile.mot + "THST_HOVER" : null
    const hover = (hover_name != null) ? params.get(hover_name) : null
    const mean = info.flight?.mean_throttle ?? null
    if ((hover != null) && (mean != null)) {
        const learn_name = profile.mot + "HOVER_LEARN"
        const target = Math.min(Math.max(mean, r.hover_learn_min), r.hover_learn_max)
        const diff = Math.abs(hover - target)
        // Пояснение, почему значение не совпадёт с газом даже после обучения — в обеих ветках
        const limit_note = (mean < r.hover_learn_min)
            ? " (обучение ограничено снизу значением " + r.hover_learn_min + " — для очень мощного аппарата это нормально)"
            : ""
        let text = hover_name + " " + hover.toFixed(2) + ", " + profile.hover_throttle_text + " " + mean.toFixed(2)
        if (diff > r.hover_throttle_tolerance) {
            const learning = params.get(learn_name) == 2
            const modes = profile.hover_learn_modes
            const note = (profile.hover_learn_note != null) ? ": " + profile.hover_learn_note : ""
            text += ": расхождение " + diff.toFixed(2) + limit_note
            if (learning) {
                text += " (обучение включено: большое расхождение значит, что висения в " + modes + " было мало)"
            }
            add("hover_throttle", "warn", "Газ висения", text, learning
                ? "Повисите не меньше " + r.hover_learn_s + " с в " + modes + ", чтобы значение обучилось" + note
                : learn_name + " = 2 (обучение с сохранением)" + ((note != "") ? " и висение не меньше " + r.hover_learn_s + " с в " + modes + note : ""))
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
