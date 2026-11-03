// Подготовка к следующему полёту (шаг 0, блок «Подготовка к следующему полёту»): проверка параметров для качественного
// лога по цели полёта (фильтры, PID или оба), исправления для файла .param, положения переключателя режимов и план
// полёта. Без DOM: работает в браузере и под Node (тесты). Дизайн — docs/plans/2026-10-30-tune-wizard-stage7-design.md
// (правила — раздел 3, план полёта — раздел 5), план — …-stage7.md, задача 1; для QuadPlane — дизайн этапа 9
// (docs/plans/2026-10-30-tune-wizard-stage9-design.md, раздел 9), план — …-stage9.md, задача 5.
// Источники: [код] — исходники ArduPilot (modules/ardupilot, пути от libraries/, ArduCopter/ или ArduPlane/); [wiki] —
// ardupilot.org; [наше] — решение мастера; [решение пользователя 30.10.2026] — дизайн этапа 7, разделы 1 и 10, и этапа 9,
// раздел 1.
//
// Правила — только качество лога; из безопасности — одно: на переключателе остаётся режим с самовыравниванием для выхода
// из Acro [решение пользователя 30.10.2026]. Что по параметрам не проверить (вибрации, clipping, пришли ли обороты),
// остаётся проверками лога шага 0 (core/checks.js); план полёта ссылается на их предупреждения.
//
// Правила — по профилю аппарата (core/vehicle.js, ctx.profile; нет — Copter): режимы и номер ACRO, бит полной частоты PID,
// префикс моторов — из профиля, остальное, чем подготовка Copter и QuadPlane различается, — prep_vehicles.
//
// Ядро не зовёт steps/ и не трогает state: параметры (params.get(name) → число или null — log_params из core/log.js или
// обёртка страницы над parse_param_file), профиль, выбранное положение ACRO и проверки шага 0 страница передаёт аргументами.
//
// Нужны глобалы страницы: Libraries/Param_Helpers.js (param_to_string), core/vehicle.js (vehicle_profiles), core/checks.js
// (check_rules, check_sensor_rate_prepost), core/filters.js (notch_param_names), core/pidtune.js (pidtune_rules; ему —
// константы core/pid.js), core/summary.js (summary_period, summary_lower_first).

const prep_rules = {
    // Номера битов LOG_BITMASK Copter: ATTITUDE_FAST, PID, IMU_RAW [код] ArduCopter/defines.h:87, 99, 105 (MASK_LOG_*) — из
    // check_rules (core/checks.js), не повторяются; IMU_RAW у Plane — тоже бит 19 [код] ArduPlane/defines.h:118
    log_bitmask_attitude_fast: check_rules.log_bitmask_attitude_fast,
    log_bitmask_pid: check_rules.log_bitmask_pid,
    log_bitmask_imu_raw: check_rules.log_bitmask_imu_raw,
    // LOG_BACKEND_TYPE: бит 0 — File (карта памяти), бит 2 — Block (встроенная флеш-память платы); лог пишется, если
    // включён любой из них [код] AP_Logger/AP_Logger.cpp:100 (@Bitmask 0:File,1:MAVLink,2:Block), 245–262 (выбор
    // хранилищ при запуске), AP_Logger.h:456–458 (Backend_Type). Бит 1 (MAVLink) — поток на наземную станцию, не запись
    log_backend_file_bit: 0,
    log_backend_block_bit: 2,
    // INS_RAW_LOG_OPT: бит 0 — основной гироскоп, 1 — все гироскопы, 2 — после фильтров, 3 — до и после
    // [код] AP_InertialSensor/AP_InertialSensor.cpp:693–698. Raw пишется при бите 0 или 1 или бите IMU_RAW в LOG_BITMASK,
    // бит 3 проверяется раньше бита 2 [код] AP_InertialSensor_Backend.cpp:480–502. Batch не пишется для тех гироскопов,
    // которые пишет raw; при бите 0 batch остальных IMU из INS_LOG_BAT_MASK пишется [код] AP_InertialSensor_Backend.cpp:485–510.
    // Мастер при raw берёт raw (log_messages, core/log.js) — его и оценивает подготовка
    raw_opt_primary_bit: 0,
    raw_opt_all_bit: 1,
    raw_opt_post_bit: 2,
    raw_opt_prepost_bit: 3,
    // INS_LOG_BAT_OPT: бит 0 — Sensor-Rate, бит 1 — после фильтров, бит 2 — до и после [код] AP_InertialSensor/
    // BatchSampler.cpp:28, AP_InertialSensor.h:386–388. Бит 2 работает только без битов 0 и 1: с битом 1 (без бита 0) обе
    // половины после фильтров — флаг «после фильтров» включён (BatchSampler.cpp:97–102), и без Sensor-Rate
    // doing_post_filter_logging() всегда true [код] AP_InertialSensor.h:351–353, AP_InertialSensor_Backend.cpp:507; с битом 0
    // на датчиках с выборкой на частоте датчика (Invensense v1/v2 по SPI с быстрой выборкой [код]
    // AP_InertialSensor_Invensense.cpp:889–922, AP_InertialSensor_Invensensev2.cpp:611–638) batch берёт только сырые
    // отсчёты — обе половины до фильтров [код] BatchSampler.cpp:103–115, AP_InertialSensor_Backend.cpp:503–508, 727–738;
    // на остальных бит 0 не действует — тип гироскопа по INS_GYR*_ID решает check_sensor_rate_prepost (core/checks.js).
    // Исправление batch — всегда INS_LOG_BAT_OPT = batch_fix.INS_LOG_BAT_OPT (только бит 2); то же правило — pre_post шага 0
    bat_opt_sensor_rate_bit: 0,
    bat_opt_post_bit: 1,
    bat_opt_prepost_bit: 2,
    // Нет записи гироскопа — в файл batch: работает на любой плате [решение пользователя 30.10.2026, раздел 10, в]; тот же
    // совет и те же значения у шага 0 — из check_rules (core/checks.js, gyro_log), не повторяются
    batch_fix: check_rules.gyro_batch_fix,
    // Подсказка raw для плат H7 и быстрее (в файл не пишется): основной гироскоп (бит 0) до и после фильтров (бит 3)
    // [код] AP_InertialSensor_Backend.cpp:480–492 — из check_rules. Нет INS_RAW_LOG_OPT (старая прошивка) — подсказка — бит
    // IMU_RAW в LOG_BITMASK: тогда raw включается только им [код] AP_InertialSensor_Backend.cpp:485–487. Текст — как у шага 0
    raw_hint: check_rules.gyro_raw_hint,
    // LOG_FILE_BUFSIZE, КиБ: при raw-записи ниже buffer_min_kib — warn, в файл — buffer_fix_kib. Умолчания прошивки
    // 16 / 50 / 80 / ≈200 по памяти платы [код] AP_Logger/AP_Logger.cpp:27–35; не хватит памяти — прошивка сама уменьшит
    // буфер [код] AP_Logger_File.cpp:82–85. Порог — [наше]: на втором логе пользователя (30.10.2026) при 8 КиБ поток GYR
    // рвался каждую секунду; 64 проверит следующий лог [решение пользователя 30.10.2026, раздел 10, г]
    buffer_min_kib: 50,
    buffer_fix_kib: 64,
    // INS_HNTCH_MODE = 3 — трекинг notch по ESC [код] Filter/HarmonicNotchFilter.cpp:127; обороты от регуляторов —
    // двунаправленный DShot (SERVO_BLH_BDMASK) [код] AP_BLHeli/AP_BLHeli.cpp:144–150 или SERIALn_PROTOCOL = 16 (телеметрия
    // ESC) [код] AP_SerialManager/AP_SerialManager.h:55; параметры SERIAL0_PROTOCOL–SERIAL9_PROTOCOL
    // [код] AP_SerialManager.cpp:174–384
    notch_mode_esc: 3,
    serial_protocol_esc: 16,
    serial_ports: 10,
    // Номер режима ACRO и режимы с самовыравниванием для выхода из него — из профиля аппарата (acro_mode, level_modes,
    // core/vehicle.js); значение «Rate Loop Only» Copter — prep_vehicles.copter (из pidtune_rules)
    // <mot>HOVER_LEARN = 2 — обучение газа висения с сохранением; MOT_ у Copter и Q_M_ у QuadPlane — тот же
    // AP_MotorsMulticopter [код] AP_Motors/AP_MotorsMulticopter.cpp:143–150, ArduPlane/quadplane.cpp:17–19
    hover_learn_save: 2,
    // Переключатель режимов: положения FLTMODE1–6, верхние границы PWM положений 1–5, положение 6 — от 1750; у Plane — тот
    // же read_6pos_switch [код] RC_Channel/RC_Channel.cpp:597–609, ArduPlane/control_modes.cpp:106–123
    slot_count: 6,
    slot_pwm_max: [1230, 1360, 1490, 1620, 1749],
    // Предлагаемое положение для ACRO — 6: верхнее положение трёхпозиционного тумблера, PWM от 1750 [решение пользователя
    // 30.10.2026, раздел 10, б]
    acro_suggest_slot: 6,
    // Имена, которым после записи нужна перезагрузка: INS_LOG_BAT_MASK — @RebootRequired [код] BatchSampler.cpp:22;
    // LOG_BACKEND_TYPE и LOG_FILE_BUFSIZE выбираются при запуске логгера [код] AP_Logger.cpp:256, AP_Logger_File.cpp:74–78;
    // INS_LOG_BAT_OPT: флаги «после фильтров» и «до и после» при смене параметра только включаются и не сбрасываются
    // [код] BatchSampler.cpp:95–102 — снятый бит 1 (после фильтров) действует только после перезагрузки [наше, по коду].
    // У Plane список тот же: у LOG_BITMASK, FLTMODE1–6, ACRO_LOCKING @RebootRequired нет [код] ArduPlane/Parameters.cpp:
    // 475–510, 573–578, 628–633 (дизайн этапа 9, раздел 9)
    reboot_names: ["INS_LOG_BAT_MASK", "INS_LOG_BAT_OPT", "LOG_BACKEND_TYPE", "LOG_FILE_BUFSIZE"],
    // План полёта: висение не меньше hover_min_s (лучше hover_good_s) [wiki, Initial tuning flight — check_rules.hover_min_s;
    // 60 с — дизайн этапа 7, раздел 5]; Acro — мастеру нужно не меньше acro_data_s секунд участков с целью от
    // acro_target_dps (pidtune_rules.min_data_s и target_min_dps; Readme мастера, шаг 4)
    hover_min_s: check_rules.hover_min_s,
    hover_good_s: 60,
    hover_learn_s: check_rules.hover_learn_s,
    acro_data_s: pidtune_rules.min_data_s,
    acro_target_dps: pidtune_rules.target_min_dps,
    // Цели правил по порядку таблицы раздела 3 дизайна: filters — шаги 1–3, pid — шаг 4
    check_goals: {
        log_backend: ["filters", "pid"],
        log_pid: ["pid"],
        log_fast: ["pid"],
        gyro_data: ["filters"],
        gyro_prepost: ["filters"],
        log_buffer: ["filters"],
        notch_source: ["filters"],
        acro_slot: ["pid"],
        acro_exit: ["pid"],
        acro_rate_only: ["pid"],
        acro_trainer: ["pid"],
        fstrate: ["pid"],
        hover_learn: ["filters"],
    },
    // Проверки шага 0, на которые план полёта ссылается пунктом «До полёта» (дизайн, раздел 5)
    plan_check_ids: ["vibe", "clipping", "tracking"],
}

// Цели полёта: title — подпись, goals — части цели (filters — шаги 1–3, pid — шаг 4; у QuadPlane — лог для будущего
// шага 4); пояснение цели — по виду аппарата (prep_goal_text). Правило применяется к цели, если его цели
// (prep_rules.check_goals) пересекаются с goals выбранной [решение пользователя 30.10.2026]
const prep_goals = {
    filters: { title: "Фильтры", goals: ["filters"] },
    pid: { title: "PID", goals: ["pid"] },
    both: { title: "Фильтры и PID", goals: ["filters", "pid"] },
}

// Чем подготовка различается по виду аппарата (profile.kind, core/vehicle.js) [дизайн этапа 9, раздел 9; решение
// пользователя 30.10.2026]. Режимы (modes, acro_mode, level_modes), префикс моторов (mot), бит полной частоты PID
// (fullrate_bit), сообщения PID и шаги — из профиля; здесь — только нужное подготовке. Поля:
//   goal_texts — пояснения целей (ключи prep_goals);
//   log_pid_bit — бит PID в LOG_BITMASK (null — правила log_pid нет);
//   log_fast — правило частоты PID: bit, name — номер и имя бита LOG_BITMASK; title — заголовок пункта; on, off — что
//       будет при включённом и выключенном бите (продолжение «бит N (имя) включён — …»);
//   acro_flight — что за полёт в ACRO (текст пункта acro_slot); acro_word — режим ACRO в «в … аппарат сам не
//       выравнивается»;
//   exit_suggest — режимы выхода из ACRO, которые советуют пункт acro_exit и план; takeoff — режимы взлёта в плане;
//   acro_rate_only — правило «только контур скорости»: { param, mask } — бит маски включён (Copter) или
//       { param, value } — значение равно (QuadPlane); title — заголовок пункта;
//   acro_trainer, fstrate — есть ли правила тренера Acro и быстрого потока контура;
//   hover_where — где висеть ради обучения газа висения (совет hover_learn); hover_plan — пункт висения в плане: where —
//       продолжение «… без движений стиками», note — конец пункта;
//   tailsitter_axes — план, у tailsitter: какими стиками крен и рыскание VTOL (null — tailsitter у вида не бывает);
//   mode_channel — канал переключателя режимов для подписи таблицы положений: { param, default } (null — не
//       показывать: у Copter подпись без канала, как до этапа 9)
const prep_vehicles = {
    copter: {
        goal_texts: {
            filters: "шаги 1–3: висение в любом режиме",
            pid: "шаг 4: тестовый полёт Acro «Rate Loop Only»",
            both: "шаги 1–4: висение и Acro в одном полёте",
        },
        // Номера битов PID и ATTITUDE_FAST — prep_rules (из check_rules, core/checks.js)
        log_pid_bit: prep_rules.log_bitmask_pid,
        log_fast: {
            bit: prep_rules.log_bitmask_attitude_fast, name: "ATTITUDE_FAST", title: "Частота PID и RATE",
            on: "PID и RATE пишутся с полной частотой", off: "PID и RATE пишутся с частотой 10 Гц, отклик на ступеньку на шаге 4 не считается",
        },
        acro_flight: "тестовый полёт Acro «Rate Loop Only»",
        acro_word: "Acro",
        // STABILIZE и ALT_HOLD — совет выхода и режимы взлёта [наше, дизайн этапа 7, раздел 3]
        exit_suggest: [0, 2],
        takeoff: [0, 2],
        // ACRO_OPTIONS «Rate Loop Only» — маска 2 (бит 1; pidtune_rules.acro_rate_only_bit, core/pidtune.js)
        acro_rate_only: { param: "ACRO_OPTIONS", mask: pidtune_rules.acro_rate_only_bit, title: "Acro «Rate Loop Only»" },
        acro_trainer: true,
        fstrate: true,
        hover_where: "ALT_HOLD",
        hover_plan: { where: "", note: "" },
        tailsitter_axes: null,
        mode_channel: null,
    },
    quadplane: {
        goal_texts: {
            filters: "шаги 1–3: висение в Q-режиме",
            pid: "лог QACRO для будущего шага 4",
            both: "висение и QACRO в одном полёте",
        },
        // Бита PID у Plane нет (PIQR/PIQP/PIQY пишутся вместе с ATT, бит 12 — CAMERA): правила log_pid нет
        // [код] ArduPlane/Log.cpp:30–39, defines.h:102–121
        log_pid_bit: null,
        // Бит 20 ATTITUDE_FULLRATE (fullrate_bit профиля): без него PIQx — 25 Гц при ATTITUDE_FAST или 10 Гц при одном
        // ATTITUDE_MED; с ним Log_Write_Attitude — на частоте цикла [код] ArduPlane/Plane.cpp:269–312, Log.cpp:58–65; бит 0
        // для этого не нужен (Log_Write_FullRate — только по биту 20), на логе не проверено
        log_fast: {
            bit: vehicle_profiles.quadplane.fullrate_bit, name: "ATTITUDE_FULLRATE", title: "Частота PID VTOL",
            on: vehicle_profiles.quadplane.pid_messages.join("/") + " пишутся с частотой цикла",
            off: vehicle_profiles.quadplane.pid_messages.join("/") + " пишутся с частотой " + check_rules.plane_attitude_fast_hz +
                 " Гц (бит ATTITUDE_FAST) или " + check_rules.plane_attitude_med_hz + " Гц (только ATTITUDE_MED) — для будущего шага 4 нужна частота цикла",
        },
        acro_flight: "тестовый полёт QACRO для будущего шага 4",
        acro_word: "QACRO",
        // Выход — QSTABILIZE, QHOVER, QLOITER (все level_modes профиля); взлёт — QSTABILIZE или QHOVER
        // [решение пользователя 30.10.2026; дизайн этапа 9, раздел 9]
        exit_suggest: [17, 18, 19],
        takeoff: [17, 18],
        // ACRO_LOCKING: 0 — в QACRO только контур скорости (input_rate_bf_roll_pitch_yaw_2, как Rate Loop Only у Copter),
        // 1 и 2 — удержание угла (input_rate_bf_roll_pitch_yaw_3, поправка углового контура) [код] ArduPlane/mode_qacro.cpp:
        // 64–69, Parameters.cpp:573–578, AC_AttitudeControl.cpp:650–737
        acro_rate_only: { param: "ACRO_LOCKING", value: 0, title: "QACRO без удержания угла" },
        // Тренера Acro и быстрого потока FSTRATE_* в Plane нет: grep trainer, FSTRATE по ArduPlane/ — пусто
        acro_trainer: false,
        fstrate: false,
        // Газ висения учится только с регулятором высоты [код] quadplane.cpp:1918–1960 (core/vehicle.js, hover_learn_*)
        hover_where: vehicle_profiles.quadplane.hover_learn_modes + ": " + vehicle_profiles.quadplane.hover_learn_note,
        // VTOL-участки внутри AUTO и GUIDED по MODE не видны — в интервал по умолчанию не входят (дизайн этапа 9, раздел 4)
        hover_plan: { where: " в Q-режиме", note: "; VTOL-участки AUTO и GUIDED шаги 1–3 не берут" },
        // Tailsitter: регулятор VTOL повёрнут на 90° по тангажу — крен VTOL от руля направления, рыскание — от элеронов
        // [код] ArduPlane/mode_qacro.cpp:53–57
        tailsitter_axes: "у tailsitter крен VTOL — стиком руля направления, рыскание — элеронами",
        // FLTMODE_CH; у Plane по умолчанию канал 8 [код] ArduPlane/Parameters.cpp:468–473, config.h:42–43
        mode_channel: { param: "FLTMODE_CH", default: 8 },
    },
}

// Профиль для подготовки: profile или, если его нет, Copter (как до этапа 9)
function prep_profile_or_copter(profile) {
    return profile ?? vehicle_profiles.copter
}

// Различия подготовки по виду профиля (prep_vehicles); profile null — Copter; вида нет в prep_vehicles — ошибка
function prep_vehicle(profile) {
    const kind = prep_profile_or_copter(profile).kind
    if (!Object.hasOwn(prep_vehicles, kind)) {
        throw new Error("Подготовка к полёту не знает вид аппарата: " + kind)
    }
    return prep_vehicles[kind]
}

// Части цели goal ("filters" | "pid" | "both") — prep_goals[goal].goals; другая цель — ошибка
function prep_goal_parts(goal) {
    if (!Object.hasOwn(prep_goals, goal)) {
        throw new Error("Неизвестная цель полёта: " + goal)
    }
    return prep_goals[goal].goals
}

// Пояснение цели goal для вида профиля (prep_vehicles, goal_texts); profile null — Copter
function prep_goal_text(goal, profile = null) {
    prep_goal_parts(goal)
    return prep_vehicle(profile).goal_texts[goal]
}

// Имя режима mode у профиля: из profile.modes, номера нет в списке — «режим N»
function prep_mode_name(mode, profile) {
    return prep_profile_or_copter(profile).modes[mode] ?? ("режим " + mode)
}

// Режимы modes словами: «STABILIZE или ALT_HOLD», «QSTABILIZE, QHOVER или QLOITER»; with_numbers — с номерами:
// «STABILIZE (0) или ALT_HOLD (2)»
function prep_modes_text(modes, profile, with_numbers = false) {
    const names = modes.map((m) => prep_mode_name(m, profile) + (with_numbers ? " (" + m + ")" : ""))
    return (names.length > 1) ? names.slice(0, -1).join(", ") + " или " + names[names.length - 1] : names.join("")
}

// Номер положения 1…slot_count из числа или строки (значение поля страницы); иначе null
function prep_slot_number(value) {
    const slot = ((value == null) || (value === "")) ? NaN : Number(value)
    return (Number.isInteger(slot) && (slot >= 1) && (slot <= prep_rules.slot_count)) ? slot : null
}

// Диапазон PWM положения slot (1–6) текстом: «до 1230», «1231–1360», …, «от 1750»
function prep_slot_pwm(slot) {
    const max = prep_rules.slot_pwm_max
    if (slot === 1) {
        return "до " + max[0]
    }
    if (slot > max.length) {
        return "от " + (max[max.length - 1] + 1)
    }
    return (max[slot - 2] + 1) + "–" + max[slot - 1]
}

// Положения переключателя режимов → [{ slot: 1…6, name: "FLTMODE<n>", mode, mode_name, pwm }]: mode — номер режима или
// null (параметра нет), mode_name — имя из profile.modes (номера нет в списке — «режим N»; mode null — null), pwm —
// prep_slot_pwm. acro_slot (необязательный, 1–6) — режим этого положения заменён на ACRO профиля (profile.acro_mode: у
// QuadPlane — QACRO): как станет после записи файла. profile null — Copter (так же у функций ниже)
function prep_mode_slots(params, acro_slot = null, profile = null) {
    const p = prep_profile_or_copter(profile)
    const chosen = prep_slot_number(acro_slot)
    const slots = []
    for (let slot = 1; slot <= prep_rules.slot_count; slot++) {
        const name = "FLTMODE" + slot
        const mode = (slot === chosen) ? p.acro_mode : params.get(name)
        const mode_name = (mode == null) ? null : prep_mode_name(mode, p)
        slots.push({ slot: slot, name: name, mode: mode, mode_name: mode_name, pwm: prep_slot_pwm(slot) })
    }
    return slots
}

// Режим положения — с самовыравниванием (profile.level_modes)
function prep_is_level(mode, profile = null) {
    return (mode != null) && prep_profile_or_copter(profile).level_modes.includes(Number(mode))
}

// Положение, которое станет ACRO после записи файла исправлений: acro_slot (1–6, число или строка), если ACRO сейчас
// нет ни в одном положении и есть все FLTMODE1–6; иначе null — ACRO уже есть, acro_slot неверный или какого-то FLTMODE
// нет (пункт acro_slot тогда — warn о параметрах, без changes). Одно правило для prep_check (acro_slot, acro_exit),
// prep_plan_slots и prep_acro_suggestion
function prep_acro_applied(params, acro_slot, profile = null) {
    const acro = prep_profile_or_copter(profile).acro_mode
    const slot = prep_slot_number(acro_slot)
    const now = prep_mode_slots(params, null, profile)
    if ((slot == null) || now.some((s) => (s.mode == null) || (s.mode == acro))) {
        return null
    }
    return slot
}

// Положения выхода из Acro среди slots (prep_mode_slots): не ACRO и с самовыравниванием, по порядку положений
function prep_exit_slots(slots, profile = null) {
    const acro = prep_profile_or_copter(profile).acro_mode
    return slots.filter((s) => (s.mode != acro) && prep_is_level(s.mode, profile))
}

// Предложение положения для ACRO: acro_suggest_slot (6), если файл его запишет (prep_acro_applied: ACRO нет, все
// FLTMODE1–6 есть) и после записи остаётся положение выхода (prep_exit_slots); иначе null — только выбор пользователя
// [решение пользователя 30.10.2026, раздел 10, б]. ACRO уже есть — null
function prep_acro_suggestion(params, profile = null) {
    const suggest = prep_rules.acro_suggest_slot
    if (prep_acro_applied(params, suggest, profile) == null) {
        return null
    }
    return (prep_exit_slots(prep_mode_slots(params, suggest, profile), profile).length > 0) ? suggest : null
}

// Положения для плана полёта → { acro, exit } (номера или null): режимы — после записи файла (prep_mode_slots с
// prep_acro_applied(params, acro_slot)); acro — первое положение с ACRO (уже стоящее или выбранное, если файл его
// запишет), exit — первое положение выхода (prep_exit_slots). То же, что видят пункты acro_slot и acro_exit prep_check
function prep_plan_slots(params, acro_slot = null, profile = null) {
    const acro_mode = prep_profile_or_copter(profile).acro_mode
    const slots = prep_mode_slots(params, prep_acro_applied(params, acro_slot, profile), profile)
    const acro = slots.find((s) => s.mode == acro_mode)
    const exit = prep_exit_slots(slots, profile)
    return { acro: acro?.slot ?? null, exit: (exit.length > 0) ? exit[0].slot : null }
}

// Бит bit (номер) в целом value
function prep_bit(value, bit) {
    return (value & (1 << bit)) !== 0
}

// «ИМЯ = значение» (значение — как в файле .param, param_to_string; не число — как есть: param_to_string на NaN бросает)
function prep_eq(name, value) {
    return name + " = " + (Number.isFinite(value) ? param_to_string(value) : String(value))
}

// Текст пункта, которому не хватает параметров names: «Параметра X нет — проверьте версию прошивки»
function prep_missing_text(names) {
    return ((names.length === 1) ? "Параметра " : "Параметров ") + names.join(", ") + " нет — проверьте версию прошивки"
}

// Положения текстом: «положение 6 (PWM от 1750)» или «положения 1 (PWM до 1230), 4 (PWM 1491–1620)»; with_mode — с
// именем режима: «положение 1 (STABILIZE, PWM до 1230)»
function prep_slots_text(slots, with_mode) {
    const one = (s) => s.slot + " (" + (with_mode ? s.mode_name + ", " : "") + "PWM " + s.pwm + ")"
    return ((slots.length === 1) ? "положение " : "положения ") + slots.map(one).join(", ")
}

// Проверка параметров для цели goal ("filters" | "pid" | "both") → [{ id, status: "ok" | "warn" | "fail", title, text,
// fix, changes }] — правила цели по порядку таблицы раздела 3 дизайна (prep_rules.check_goals).
// params.get(name) → число или null. ctx = { acro_slot, hover_check, profile } (ctx и поля необязательны): acro_slot —
// положение для ACRO, выбранное пользователем (1–6 или null; учитывается по prep_acro_applied: ACRO сейчас нет и все
// FLTMODE1–6 есть), hover_check — проверка шага 0 hover_throttle ({ status, … }) или null (лога нет, нет газа висения или
// лог другого вида), profile — профиль аппарата (core/vehicle.js; нет — Copter). По профилю (prep_vehicles): у QuadPlane
// нет log_pid, acro_trainer, fstrate; log_fast — бит 20 ATTITUDE_FULLRATE; ACRO — QACRO (23), выход — QSTABILIZE,
// QHOVER, QLOITER; acro_rate_only — ACRO_LOCKING = 0; hover_learn — Q_M_HOVER_LEARN [дизайн этапа 9, раздел 9].
// fix — что сделать (null — нечего); changes — что пишет файл исправлений: [{ name, value }] или для масок
// [{ name, set, clear }] (set / clear — значения битов, prep_changes), [] — нечего. Параметра, нужного правилу для вывода,
// нет — warn «параметра X нет — проверьте версию прошивки» (prep_missing_text), changes []. Уточнения:
// - log_backend — fail, только если нет ни бита File (0), ни бита Block (2); в файл — бит File;
// - gyro_data — raw (INS_RAW_LOG_OPT бит 0 или 1, или бит IMU_RAW в LOG_BITMASK) или batch (INS_LOG_BAT_MASK ≠ 0); нет
//   INS_RAW_LOG_OPT — raw только по биту IMU_RAW (старые прошивки). Ни того ни другого — fail, в файл batch (batch_fix),
//   в fix ещё подсказка raw для плат H7: raw_hint, а без INS_RAW_LOG_OPT — бит IMU_RAW;
// - gyro_prepost и log_buffer — от источника после исправления gyro_data: raw и batch вместе — raw (его берёт мастер;
//   batch не пишется для гироскопов, которые пишет raw); нет записи — batch из файла: gyro_prepost ok, log_buffer не
//   применяется (пункта нет). Источник не определить (gyro_data — warn о параметрах) — обоих пунктов нет. log_buffer —
//   только при raw. Batch: бит 2 INS_LOG_BAT_OPT вместе с битом 1 — warn (обе половины после фильтров или, с
//   Sensor-Rate на Invensense v1/v2, обе сырые); с битом 0 без бита 1 — по типу гироскопа (check_sensor_rate_prepost):
//   Invensense v1/v2 или тип не определить — warn, иначе ok; любое warn batch — changes INS_LOG_BAT_OPT = batch_fix
//   (только бит 2), { name, value };
// - notch_source — по обоим notch (notch_param_names): warn, если включённый notch с MODE = 3 (ESC), а SERVO_BLH_BDMASK
//   0 или нет и ни один SERIAL0–9_PROTOCOL не 16; нет INS_HNTC2_ENABLE — второй notch выключен;
// - acro_slot — ACRO есть — ok; нет — fail, changes FLTMODE<acro_slot> = profile.acro_mode (1 у Copter, 23 у
//   QuadPlane), только если файл его запишет (prep_acro_applied);
// - acro_exit — по режимам после записи файла: есть положение выхода (prep_exit_slots) — ok (названы положения), нет —
//   fail без changes;
// - fstrate — FSTRATE_ENABLE нет — ok: быстрого потока нет в прошивке или на плате; > 0 — warn без fix и changes: перед
//   полётом делать нечего, это оговорка к прогнозу шага 4;
// - acro_rate_only — у Copter бит 1 ACRO_OPTIONS (в файл — маска), у QuadPlane ACRO_LOCKING = 0 (в файл — значение);
// - hover_learn — <mot>HOVER_LEARN = 2 — ok; иначе при hover_check?.status === "warn" — warn, changes 2; иначе ok с
//   советом в тексте, без changes
function prep_check(params, goal, ctx) {
    const parts = prep_goal_parts(goal)
    const r = prep_rules
    const profile = prep_profile_or_copter(ctx?.profile)
    const v = prep_vehicle(profile)
    const acro_name = prep_mode_name(profile.acro_mode, profile)
    const acro_slot = prep_slot_number(ctx?.acro_slot)
    const hover_check = ctx?.hover_check ?? null
    const get = (name) => params.get(name)
    const items = []
    const add = (id, status, title, text, fix, changes) =>
        items.push({ id: id, status: status, title: title, text: text, fix: fix ?? null, changes: changes ?? [] })
    const missing = (id, title, names) => add(id, "warn", title, prep_missing_text(names), null, [])

    // Запись лога: на карту памяти (File) или во встроенную память платы (Block)
    {
        const title = "Запись лога"
        const value = get("LOG_BACKEND_TYPE")
        const file = r.log_backend_file_bit
        const block = r.log_backend_block_bit
        if (value == null) {
            missing("log_backend", title, ["LOG_BACKEND_TYPE"])
        } else if (prep_bit(value, file)) {
            add("log_backend", "ok", title, prep_eq("LOG_BACKEND_TYPE", value) + ": бит " + file + " (File) включён — лог пишется на карту памяти")
        } else if (prep_bit(value, block)) {
            add("log_backend", "ok", title, prep_eq("LOG_BACKEND_TYPE", value) + ": бит " + block + " (Block) включён — лог пишется во встроенную память платы")
        } else {
            add("log_backend", "fail", title, prep_eq("LOG_BACKEND_TYPE", value) + ": биты " + file + " (File) и " + block + " (Block) выключены — лог не пишется ни на карту, ни во встроенную память",
                "Включите запись на карту (бит " + file + ", +" + (1 << file) + "); у платы без карты — во встроенную память (бит " + block + ", +" + (1 << block) + ")",
                [{ name: "LOG_BACKEND_TYPE", set: 1 << file, clear: 0 }])
        }
    }

    // Биты LOG_BITMASK: PID (только Copter) и частота PID (ATTITUDE_FAST у Copter, ATTITUDE_FULLRATE у QuadPlane)
    const bitmask = get("LOG_BITMASK")
    if (v.log_pid_bit != null) {
        const title = "Сообщения PID"
        const bit = v.log_pid_bit
        if (bitmask == null) {
            missing("log_pid", title, ["LOG_BITMASK"])
        } else if (prep_bit(bitmask, bit)) {
            add("log_pid", "ok", title, prep_eq("LOG_BITMASK", bitmask) + ": бит " + bit + " (PID) включён — PIDR/PIDP/PIDY будут в логе")
        } else {
            add("log_pid", "fail", title, prep_eq("LOG_BITMASK", bitmask) + ": бит " + bit + " (PID) выключен — без PIDR/PIDP/PIDY на шаге 4 нет компонент P/I/D, шума D и прогноза",
                "Включите бит PID (" + bit + ") в LOG_BITMASK (+" + (1 << bit) + ")",
                [{ name: "LOG_BITMASK", set: 1 << bit, clear: 0 }])
        }
    }
    {
        const fast = v.log_fast
        const title = fast.title
        const bit = fast.bit
        const flag = "бит " + bit + " (" + fast.name + ")"
        if (bitmask == null) {
            missing("log_fast", title, ["LOG_BITMASK"])
        } else if (prep_bit(bitmask, bit)) {
            add("log_fast", "ok", title, prep_eq("LOG_BITMASK", bitmask) + ": " + flag + " включён — " + fast.on)
        } else {
            add("log_fast", "fail", title, prep_eq("LOG_BITMASK", bitmask) + ": " + flag + " выключен — " + fast.off,
                "Включите бит " + fast.name + " (" + bit + ") в LOG_BITMASK (+" + (1 << bit) + ")",
                [{ name: "LOG_BITMASK", set: 1 << bit, clear: 0 }])
        }
    }

    // Запись гироскопа: raw или batch. source — что будет после исправления: "raw" | "batch" | "fix" (batch из файла) |
    // null (не определить: нет параметров)
    const raw_opt = get("INS_RAW_LOG_OPT")
    const bat_mask = get("INS_LOG_BAT_MASK")
    const raw_reasons = []
    if ((raw_opt != null) && (prep_bit(raw_opt, r.raw_opt_primary_bit) || prep_bit(raw_opt, r.raw_opt_all_bit))) {
        raw_reasons.push(prep_eq("INS_RAW_LOG_OPT", raw_opt) + (prep_bit(raw_opt, r.raw_opt_all_bit) ? " (все гироскопы)" : " (основной гироскоп)"))
    }
    if ((bitmask != null) && prep_bit(bitmask, r.log_bitmask_imu_raw)) {
        raw_reasons.push("бит " + r.log_bitmask_imu_raw + " (IMU_RAW) в LOG_BITMASK")
    }
    const raw = raw_reasons.length > 0
    const batch = (bat_mask != null) && (bat_mask != 0)
    let source = null
    {
        const id = "gyro_data"
        const title = "Запись гироскопа"
        if (raw) {
            source = "raw"
            add(id, "ok", title, "Raw (GYR): " + raw_reasons.join(", ") +
                (batch ? "; " + prep_eq("INS_LOG_BAT_MASK", bat_mask) + " тоже включён, но batch не пишется для гироскопов, которые пишет raw, — мастер возьмёт raw" : ""))
        } else if (batch) {
            source = "batch"
            add(id, "ok", title, "Batch (ISBH/ISBD): " + prep_eq("INS_LOG_BAT_MASK", bat_mask))
        } else {
            const absent = ["LOG_BITMASK", "INS_LOG_BAT_MASK"].filter((name) => get(name) == null)
            if (absent.length > 0) {
                missing(id, title, absent)
            } else {
                source = "fix"
                const found = [((raw_opt != null) ? prep_eq("INS_RAW_LOG_OPT", raw_opt) : null),
                    "бит " + r.log_bitmask_imu_raw + " (IMU_RAW) в LOG_BITMASK выключен", prep_eq("INS_LOG_BAT_MASK", bat_mask)].filter((t) => t != null)
                const fix_values = Object.entries(r.batch_fix)
                // Без INS_RAW_LOG_OPT (старая прошивка) raw включается только битом IMU_RAW
                // Текст raw — как у шага 0 (core/checks.js, gyro_log)
                const raw_hint = (raw_opt != null)
                    ? prep_eq("INS_RAW_LOG_OPT", r.raw_hint) + " (основной гироскоп до и после фильтров; бит IMU_RAW не нужен)"
                    : "бит IMU_RAW (" + r.log_bitmask_imu_raw + ") в LOG_BITMASK (+" + (1 << r.log_bitmask_imu_raw) + "; INS_RAW_LOG_OPT в этой прошивке нет)"
                add(id, "fail", title, "Записи гироскопа нет: " + found.join(", ") + " — шагам 1–3 нечего считать",
                    "Batch: " + fix_values.map(([name, value]) => prep_eq(name, value)).join(", ") + " (до и после фильтров) — работает на любой плате. " +
                    "На платах H7 и быстрее можно вместо него raw: " + raw_hint,
                    fix_values.map(([name, value]) => ({ name: name, value: value })))
            }
        }
    }

    // До и после фильтров — по источнику после исправления
    {
        const id = "gyro_prepost"
        const title = "До/после фильтров"
        if (source === "fix") {
            add(id, "ok", title, "После исправления записи гироскопа — batch до и после фильтров (" + prep_eq("INS_LOG_BAT_OPT", r.batch_fix.INS_LOG_BAT_OPT) + ")")
        } else if (source === "raw") {
            const prepost = r.raw_opt_prepost_bit
            const post = r.raw_opt_post_bit
            const changes = [{ name: "INS_RAW_LOG_OPT", set: 1 << prepost, clear: 1 << post }]
            const add_text = "Добавьте бит " + prepost + " (+" + (1 << prepost) + ") к INS_RAW_LOG_OPT"
            if (raw_opt == null) {
                missing(id, title, ["INS_RAW_LOG_OPT"])
            } else if (prep_bit(raw_opt, prepost)) {
                add(id, "ok", title, prep_eq("INS_RAW_LOG_OPT", raw_opt) + ": raw до и после фильтров (бит " + prepost + ") — оценку «станет» можно сверить с реальными данными")
            } else if (prep_bit(raw_opt, post)) {
                add(id, "warn", title, prep_eq("INS_RAW_LOG_OPT", raw_opt) + ": raw только после фильтров — спектра до фильтров и оценки «станет» не будет",
                    add_text + " и снимите бит " + post + " (−" + (1 << post) + "): запись до и после фильтров", changes)
            } else {
                add(id, "warn", title, prep_eq("INS_RAW_LOG_OPT", raw_opt) + ": raw только до фильтров — реального «после» для сверки оценки «станет» не будет",
                    add_text + ": запись до и после фильтров", changes)
            }
        } else if (source === "batch") {
            // Исправление одно — INS_LOG_BAT_OPT = 4 (только бит 2): бит 2 работает без бита 1, а с битом 0 — только не на
            // Invensense v1/v2 (prep_rules); перезагрузку называет заметка файла (INS_LOG_BAT_OPT — в reboot_names)
            const bat_opt = get("INS_LOG_BAT_OPT")
            const prepost = r.bat_opt_prepost_bit
            const target = r.batch_fix.INS_LOG_BAT_OPT
            const changes = [{ name: "INS_LOG_BAT_OPT", value: target }]
            const fix = "Запишите " + prep_eq("INS_LOG_BAT_OPT", target) + " (только бит " + prepost + " — до и после фильтров)"
            if (bat_opt == null) {
                missing(id, title, ["INS_LOG_BAT_OPT"])
            } else {
                const sensor_rate = prep_bit(bat_opt, r.bat_opt_sensor_rate_bit)
                const post = prep_bit(bat_opt, r.bat_opt_post_bit)
                const sensor_rate_text = "битом " + r.bat_opt_sensor_rate_bit + " (Sensor-Rate)"
                const prepost_ok = prep_eq("INS_LOG_BAT_OPT", bat_opt) + ": batch до и после фильтров (бит " + prepost + ") — оценку «станет» можно сверить с реальными данными"
                // Бит 0 без бита 1 — по типу гироскопа: выборку на частоте датчика включают только Invensense v1/v2
                const rate = (prep_bit(bat_opt, prepost) && sensor_rate && !post) ? check_sensor_rate_prepost(params, "реального «после» не будет") : null
                if (rate?.status === "warn") {
                    add(id, "warn", title, prep_eq("INS_LOG_BAT_OPT", bat_opt) + ": бит " + prepost + " (до и после) вместе с " + sensor_rate_text + " — " + rate.reason,
                        fix, changes)
                } else if (rate != null) {
                    add(id, "ok", title, prepost_ok + "; бит " + r.bat_opt_sensor_rate_bit + " (Sensor-Rate) — " + rate.reason)
                } else if (prep_bit(bat_opt, prepost) && post) {
                    const others = [sensor_rate ? sensor_rate_text : null, "битом " + r.bat_opt_post_bit + " (после фильтров)"].filter((t) => t != null)
                    const reason = !sensor_rate ? "обе половины batch пишутся после фильтров, спектра до фильтров не будет"
                        : "на датчиках с выборкой на частоте датчика (Invensense v1/v2 по SPI) обе половины batch — сырые, до фильтров, на остальных бит " +
                          r.bat_opt_post_bit + " даёт обе после фильтров: «до» и «после» не различаются"
                    add(id, "warn", title, prep_eq("INS_LOG_BAT_OPT", bat_opt) + ": бит " + prepost + " (до и после) вместе с " + others.join(" и ") + " — " + reason,
                        fix, changes)
                } else if (prep_bit(bat_opt, prepost)) {
                    add(id, "ok", title, prepost_ok)
                } else if (post) {
                    add(id, "warn", title, prep_eq("INS_LOG_BAT_OPT", bat_opt) + ": batch только после фильтров — спектра до фильтров и оценки «станет» не будет",
                        fix, changes)
                } else {
                    add(id, "warn", title, prep_eq("INS_LOG_BAT_OPT", bat_opt) + ": batch только до фильтров — реального «после» для сверки оценки «станет» не будет",
                        fix, changes)
                }
            }
        }
    }

    // Буфер лога — только при raw-записи
    if (source === "raw") {
        const id = "log_buffer"
        const title = "Буфер лога"
        const size = get("LOG_FILE_BUFSIZE")
        if (size == null) {
            missing(id, title, ["LOG_FILE_BUFSIZE"])
        } else if (size < r.buffer_min_kib) {
            add(id, "warn", title, prep_eq("LOG_FILE_BUFSIZE", size) + " КиБ при raw-записи гироскопа: ниже " + r.buffer_min_kib + " КиБ поток GYR может рваться на куски короче окна FFT",
                prep_eq("LOG_FILE_BUFSIZE", r.buffer_fix_kib) + " (не хватит памяти платы — прошивка сама уменьшит буфер)",
                [{ name: "LOG_FILE_BUFSIZE", value: r.buffer_fix_kib }])
        } else {
            add(id, "ok", title, prep_eq("LOG_FILE_BUFSIZE", size) + " КиБ: для raw-записи гироскопа хватает (мастер предупреждает ниже " + r.buffer_min_kib + " КиБ)")
        }
    }

    // Обороты для notch по ESC
    {
        const id = "notch_source"
        const title = "Обороты для notch"
        const notches = notch_param_names()
        if (get(notches[0].enable) == null) {
            missing(id, title, [notches[0].enable])
        } else {
            const enabled = notches.filter((n) => (get(n.enable) ?? 0) > 0)
            const no_mode = enabled.filter((n) => get(n.mode) == null).map((n) => n.mode)
            const esc = enabled.filter((n) => get(n.mode) == r.notch_mode_esc)
            if (enabled.length === 0) {
                add(id, "ok", title, prep_eq(notches[0].enable, get(notches[0].enable)) + ": notch выключен — обороты ему не нужны")
            } else if (no_mode.length > 0) {
                missing(id, title, no_mode)
            } else if (esc.length === 0) {
                add(id, "ok", title, enabled.map((n) => prep_eq(n.mode, get(n.mode))).join(", ") + ": notch не по ESC — телеметрия регуляторов ему не нужна")
            } else {
                const modes = esc.map((n) => prep_eq(n.mode, get(n.mode))).join(", ") + " (трекинг по ESC)"
                const bdmask = get("SERVO_BLH_BDMASK")
                const serials = []
                for (let port = 0; port < r.serial_ports; port++) {
                    if (get("SERIAL" + port + "_PROTOCOL") == r.serial_protocol_esc) {
                        serials.push("SERIAL" + port + "_PROTOCOL")
                    }
                }
                const sources = []
                if ((bdmask != null) && (bdmask != 0)) {
                    sources.push("двунаправленный DShot (" + prep_eq("SERVO_BLH_BDMASK", bdmask) + ")")
                }
                if (serials.length > 0) {
                    sources.push("телеметрия ESC (" + serials.map((name) => name + " = " + r.serial_protocol_esc).join(", ") + ")")
                }
                if (sources.length > 0) {
                    add(id, "ok", title, modes + ", обороты — " + sources.join(" и "))
                } else {
                    add(id, "warn", title, modes + ", но " + ((bdmask == null) ? "SERVO_BLH_BDMASK нет" : prep_eq("SERVO_BLH_BDMASK", bdmask)) +
                        " и ни один SERIALn_PROTOCOL не " + r.serial_protocol_esc + " (телеметрия ESC): оборотам неоткуда прийти, notch не будет следить за моторами",
                        "Включите обороты от регуляторов: двунаправленный DShot (SERVO_BLH_BDMASK) или телеметрию ESC (SERIALn_PROTOCOL = " + r.serial_protocol_esc +
                        "); если обороты приходят иначе (например, по DroneCAN) — пункт можно не учитывать")
                }
            }
        }
    }

    // ACRO на переключателе и выход из него (ACRO и режимы выхода — профиля: у QuadPlane QACRO и Q-режимы)
    const now = prep_mode_slots(params, null, profile)
    const acro_now = now.filter((s) => s.mode == profile.acro_mode)
    // Положение, которое станет ACRO после записи файла (null — ACRO уже есть, не выбрано или нет какого-то FLTMODE)
    const applied = prep_acro_applied(params, acro_slot, profile)
    {
        const id = "acro_slot"
        const title = acro_name + " на переключателе"
        const absent = now.filter((s) => s.mode == null).map((s) => s.name)
        if (acro_now.length > 0) {
            add(id, "ok", title, acro_name + " — " + prep_slots_text(acro_now, false))
        } else if (absent.length > 0) {
            missing(id, title, absent)
        } else {
            const fix = (applied != null)
                ? "Запишите FLTMODE" + applied + " = " + profile.acro_mode + " (есть в файле _prep.param шага 0): " + acro_name + " — " +
                  prep_slots_text([now[applied - 1]], false) + "; другое положение — в таблице положений переключателя на шаге 0"
                : "Выберите положение для " + acro_name + " в таблице положений переключателя на шаге 0"
            add(id, "fail", title, "Ни в одном из FLTMODE1–" + r.slot_count + " нет " + acro_name + " (" + profile.acro_mode + "): " + v.acro_flight + " не включить",
                fix, (applied != null) ? [{ name: "FLTMODE" + applied, value: profile.acro_mode }] : [])
        }
    }
    {
        const id = "acro_exit"
        const title = "Выход из " + acro_name
        const after = prep_mode_slots(params, applied, profile)
        const level = prep_exit_slots(after, profile)
        const absent = after.filter((s) => s.mode == null).map((s) => s.name)
        if (level.length > 0) {
            add(id, "ok", title, "Выход из " + acro_name + " — " + prep_slots_text(level, true) + ": проверьте, что тумблер достаёт до " +
                ((level.length === 1) ? "этого положения" : "одного из этих положений"))
        } else if (absent.length > 0) {
            missing(id, title, absent)
        } else {
            add(id, "fail", title, "Кроме " + acro_name + ", на переключателе нет режима с самовыравниванием (" + profile.level_modes.map((m) => prep_mode_name(m, profile)).join(", ") +
                "): в " + v.acro_word + " аппарат сам не выравнивается, и выйти из него будет некуда",
                "Поставьте " + prep_modes_text(v.exit_suggest, profile, true) + " в одно из положений FLTMODE1–" + r.slot_count + ", кроме положения " + acro_name +
                ", и проверьте, что тумблер достаёт до него")
        }
    }

    // Только контур скорости: у Copter — бит «Rate Loop Only» в ACRO_OPTIONS, у QuadPlane — ACRO_LOCKING = 0
    {
        const id = "acro_rate_only"
        const rule = v.acro_rate_only
        const title = rule.title
        const value = get(rule.param)
        if (value == null) {
            missing(id, title, [rule.param])
        } else if (rule.mask != null) {
            const mask = rule.mask
            const bit = Math.log2(mask)
            if ((value & mask) !== 0) {
                add(id, "ok", title, prep_eq(rule.param, value) + ": бит " + bit + " (Rate Loop Only) включён — в Acro угловой контур выключен, цель скорости — прямая команда пилота")
            } else {
                add(id, "fail", title, prep_eq(rule.param, value) + ": бит " + bit + " (Rate Loop Only) выключен — в Acro работает угловой контур, контур скорости по такому полёту точно не измерить",
                    "Включите бит " + bit + " (Rate Loop Only) в " + rule.param + " (+" + mask + "); бит 0 (Air-mode) не меняется",
                    [{ name: rule.param, set: mask, clear: 0 }])
            }
        } else if (value == rule.value) {
            add(id, "ok", title, prep_eq(rule.param, value) + ": удержания угла нет — в " + acro_name + " только контур скорости, цель скорости — прямая команда пилота")
        } else {
            add(id, "fail", title, prep_eq(rule.param, value) + ": в " + acro_name + " при отпущенных стиках удерживается угол (поправка углового контура) — контур скорости по такому полёту точно не измерить",
                "Запишите " + prep_eq(rule.param, rule.value) + " (тогда в " + acro_name + " при отпущенных стиках аппарат не держит и угол — выход только переключателем)",
                [{ name: rule.param, value: rule.value }])
        }
    }
    // Тренер Acro (только Copter): ACRO_TRAINER 0 — выключен, 1 — выравнивание, 2 — выравнивание и ограничение угла,
    // заводское 2 [код] ArduCopter/Parameters.cpp:319–324; тренер подмешивает выравнивание в цель скорости и в Rate Loop
    // Only [код] ArduCopter/mode_acro.cpp, get_pilot_desired_rates_rads — вызывается до ветвления по RATE_LOOP_ONLY
    // (как pidtune_log_mode, core/pidtune.js)
    if (v.acro_trainer) {
        const id = "acro_trainer"
        const title = "Тренер Acro"
        const value = get("ACRO_TRAINER")
        if (value == null) {
            missing(id, title, ["ACRO_TRAINER"])
        } else if (value == 0) {
            add(id, "ok", title, prep_eq("ACRO_TRAINER", value) + ": тренер выключен — цель скорости не искажается")
        } else {
            add(id, "fail", title, prep_eq("ACRO_TRAINER", value) + ": тренер подмешивает в цель скорости выравнивание по углу и в Rate Loop Only — цель не чистая команда пилота",
                "ACRO_TRAINER = 0 (тогда в Acro аппарат совсем не выравнивается сам — выход только переключателем)",
                [{ name: "ACRO_TRAINER", value: 0 }])
        }
    }

    // Быстрый поток контура скорости (только Copter). FSTRATE_ENABLE есть только при
    // AP_INERTIALSENSOR_FAST_SAMPLE_WINDOW_ENABLED [код] ArduCopter/Parameters.cpp:1084–1090, AP_InertialSensor/
    // AP_InertialSensor_rate_config.h:8 — нет параметра, нет и потока. warn — оговорка к прогнозу шага 4, а не действие
    // перед полётом: fix нет
    if (v.fstrate) {
        const id = "fstrate"
        const title = "Быстрый поток контура"
        const value = get("FSTRATE_ENABLE")
        if (value == null) {
            add(id, "ok", title, "FSTRATE_ENABLE нет: быстрого потока контура скорости нет в прошивке или на плате")
        } else if (value > 0) {
            add(id, "warn", title, prep_eq("FSTRATE_ENABLE", value) + ": контур скорости в быстром потоке, а модель регулятора мастера считается на SCHED_LOOP_RATE — прогноз шага 4 может разойтись с полётом")
        } else {
            add(id, "ok", title, prep_eq("FSTRATE_ENABLE", value) + ": контур скорости в основном цикле — как в модели мастера")
        }
    }

    // Обучение газа висения: <mot>HOVER_LEARN и <mot>THST_HOVER профиля (MOT_ у Copter, Q_M_ у QuadPlane)
    {
        const id = "hover_learn"
        const title = "Обучение газа висения"
        const name = profile.mot + "HOVER_LEARN"
        const hover = profile.mot + "THST_HOVER"
        const value = get(name)
        const advice = name + " = " + r.hover_learn_save + " и не меньше " + r.hover_learn_s + " с висения в " + v.hover_where
        // 0 — выключено, 1 — обучение без сохранения [код] AP_MotorsMulticopter.cpp:146
        const now_text = (value == 1) ? "газ висения обучается, но не сохраняется" : "обучение газа висения выключено"
        if (value == null) {
            missing(id, title, [name])
        } else if (value == r.hover_learn_save) {
            add(id, "ok", title, prep_eq(name, value) + ": газ висения обучается и сохраняется")
        } else if (hover_check?.status === "warn") {
            add(id, "warn", title, prep_eq(name, value) + ": " + now_text + ", а по логу газ висения расходится с " + hover + " (проверка шага 0 «Газ висения»)",
                advice, [{ name: name, value: r.hover_learn_save }])
        } else {
            add(id, "ok", title, prep_eq(name, value) + ": " + now_text + "; " +
                ((hover_check != null) ? "по логу газ висения сходится с " + hover : "по логу не проверено") + ". Совет: " + advice)
        }
    }

    return items.filter((item) => r.check_goals[item.id].some((part) => parts.includes(part)))
}

// Значения файла исправлений по пунктам items (prep_check) → объект имя → значение. Пункты и их changes — по очереди:
// { name, value } ставит значение, { name, set, clear } — маска: от уже набранного значения этого имени, иначе от
// params.get(name) (нет — от 0), (v | set) & ~clear — несколько правил на одну маску (LOG_BITMASK) складываются в одно
// значение; маска в params не число (NaN) — не пишется: от неё нечего отсчитывать, а 0 стёр бы остальные биты [наше].
// Значение, равное текущему в params (как float32), в файл не идёт: файл — только изменения
function prep_changes(params, items) {
    const values = {}
    for (const item of items) {
        for (const change of item.changes ?? []) {
            const name = change.name
            if ("value" in change) {
                values[name] = change.value
            } else {
                const base = (name in values) ? values[name] : (params.get(name) ?? 0)
                if (Number.isFinite(base)) {
                    values[name] = (base | change.set) & ~change.clear
                }
            }
        }
    }
    for (const name of Object.keys(values)) {
        const current = params.get(name)
        if ((current != null) && (Math.fround(current) === Math.fround(values[name]))) {
            delete values[name]
        }
    }
    return values
}

// Имена из names, которым после записи нужна перезагрузка (prep_rules.reboot_names), в порядке names
function prep_reboot_names(names) {
    return names.filter((name) => prep_rules.reboot_names.includes(name))
}

// План полёта под цель goal → пункты текста (каждый — фраза с точкой, summary_period). ctx = { acro_slot, exit_slot,
// checks, profile, tailsitter } (ctx и поля необязательны): acro_slot — положение ACRO (найденное или выбранное;
// prep_plan_slots), exit_slot — положение выхода с самовыравниванием, checks — проверки шага 0 (state.checks: { id,
// status, title, fix }) или null, profile — профиль аппарата (нет — Copter), tailsitter — аппарат tailsitter
// (profile.is_tailsitter). Режимы, ACRO и тексты — по профилю (prep_vehicles). Пункты (дизайн этапа 7, раздел 5; этапа 9,
// раздел 9):
// 1. «До полёта: title — fix» — проверки шага 0 из prep_rules.plan_check_ids (вибрации, clipping, обороты) со статусом
//    warn или fail и непустым fix, fix — продолжение фразы (summary_lower_first);
// 2. фильтры — взлёт и висение без движений стиками (у QuadPlane — в Q-режиме: VTOL-участки AUTO и GUIDED не в счёт);
// 3. PID — безопасная высота и ACRO положением acro_slot, резкие отклонения стиков по осям (у tailsitter — какими стиками
//    крен и рыскание VTOL; требования мастера к участкам — только у вида с шагом 4), выход положением exit_slot; с
//    фильтрами — после висения. Положения выхода нет (exit_slot null) — на месте этих пунктов один пункт-запрет: не
//    включать ACRO, пока его не будет;
// 4. последним — посадка и загрузка лога, с полётом в ACRO — кнопка шага 4 «Интервал — участок ACRO», а у вида без шага 4
//    (QuadPlane) — «сохраните лог: шаг 4 для … — следующим этапом»
function prep_flight_plan(goal, ctx) {
    const parts = prep_goal_parts(goal)
    const r = prep_rules
    const profile = prep_profile_or_copter(ctx?.profile)
    const v = prep_vehicle(profile)
    const acro = prep_mode_name(profile.acro_mode, profile)
    const step4 = profile.steps.includes(4)
    const filters = parts.includes("filters")
    const pid = parts.includes("pid")
    const acro_slot = prep_slot_number(ctx?.acro_slot)
    const exit_slot = prep_slot_number(ctx?.exit_slot)
    const items = []
    const add = (text) => items.push(summary_period(text))

    for (const check of ctx?.checks ?? []) {
        if (r.plan_check_ids.includes(check.id) && ((check.status === "warn") || (check.status === "fail")) && ((check.fix ?? "") !== "")) {
            add("До полёта: " + check.title + " — " + summary_lower_first(check.fix))
        }
    }
    if (filters) {
        add("Взлёт в " + prep_modes_text(v.takeoff, profile) + ", висение не меньше " + r.hover_min_s + " с (лучше " + r.hover_good_s + ") без движений стиками" +
            v.hover_plan.where + ": по нему шаги 1–3 считают спектр гироскопа" + v.hover_plan.note)
    }
    const acro_flight = pid && (exit_slot != null)
    if (acro_flight) {
        add((filters ? "После висения наберите" : "Наберите") + " безопасную высоту и включите " + acro + " " +
            ((acro_slot != null) ? "положением " + acro_slot + " (PWM " + prep_slot_pwm(acro_slot) + ")"
                : "— положение для " + acro + " не выбрано: выберите его в таблице положений переключателя"))
        const axes = ((ctx?.tailsitter ?? false) && (v.tailsitter_axes != null)) ? "; " + v.tailsitter_axes : ""
        add("2–3 минуты резких отклонений стиков с возвратом, по одной оси за раз — крен, тангаж, рыскание — с разной амплитудой" + axes +
            (step4 ? ": мастеру нужно не меньше " + r.acro_data_s + " с участков с целью скорости от " + r.acro_target_dps + " °/с" : ""))
        add("Выход из " + acro + " — положением " + exit_slot + " (PWM " + prep_slot_pwm(exit_slot) + "): в " + v.acro_word + " аппарат сам не выравнивается")
    } else if (pid) {
        add("Положения с самовыравниванием на переключателе нет: в " + v.acro_word + " аппарат сам не выравнивается — не включайте " + acro + ", пока его " +
            "не будет (" + prep_modes_text(v.exit_suggest, profile) + " в одном из положений, кроме положения " + acro + ")")
    }
    add("Посадка; загрузите лог в мастер" + (!acro_flight ? "" : step4 ? ", на шаге 4 — «Интервал — участок ACRO»"
        : " и сохраните лог: шаг 4 для " + profile.title + " — следующим этапом"))
    return items
}

// Имя файла исправлений: имя лога или файла .param без последнего расширения + «_prep.param»; имени нет (null или
// пустая строка) — «prep.param». Отдельно от «_tune.param» шага 5 [решение пользователя 30.10.2026, раздел 10, е]
function prep_file_name(source_name) {
    return (((source_name != null) && (source_name !== "")) ? source_name.replace(/\.[^.]*$/, "") + "_" : "") + "prep.param"
}
