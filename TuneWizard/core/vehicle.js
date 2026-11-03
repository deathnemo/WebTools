// Профиль аппарата: всё, чем для мастера различаются Copter и QuadPlane (VTOL-часть ArduPlane), — одна таблица на вид.
// Код получает профиль (аргументом — core/log.js, core/checks.js; со страницы — шаги), а не проверяет вид в россыпи
// условий. Без DOM: работает в браузере и под Node (тесты). Дизайн — docs/plans/2026-10-30-tune-wizard-stage9-design.md
// (разделы 3 и 10), план — …-stage9.md, задача 1.
// Источники: [код] — modules/ardupilot (ArduPlane 4.8.0-dev, f3836cfae7); [4.6.3] — тег Plane-4.6.3 (версия логов
// пользователя); [лог] — третий лог TuneWizard/logs/1 01.01.1980 2-00-00.bin (журнал, раздел 8); [решение пользователя
// 30.10.2026] — дизайн этапа 9, раздел 1; [наше] — решение мастера.
//
// Глобалов страницы не нужно: файл грузится первым из core/.

// Профили по виду. Поля:
//   kind, title — ключ вида и имя для пользователя; build_type — VER.BU (как в Libraries/LogHelpers.js);
//   enable_param — параметр, без которого вид не поднимается (null — не нужен); param_marker — признак вида в файле .param;
//   steps — доступные шаги мастера; closed_steps — почему шаг мастера, которого нет в steps, закрыт: { номер: текст }
//          (подсказка кнопки шага в полосе шагов, строка сводки);
//   atc, mot — префиксы параметров регулятора положения (AC_AttitudeControl_Multi) и моторов (AP_MotorsMulticopter):
//          суффиксы у Copter и QuadPlane одни (RAT_RLL_FLTD, ACCEL_R_MAX / ACC_R_MAX, THST_HOVER…);
//   pid_messages, pid_title — сообщения PID контура скорости (первое — для частоты лога PID) и заголовок проверки шага 0;
//   fullrate_bit — бит LOG_BITMASK, который один пишет PID с частотой цикла (null — у Copter так пишут биты ATTITUDE_FAST
//          и PID вместе, core/checks.js check_rules);
//   throttle — ряды газа 0…1 по порядку [сообщение, поле]; throttle_title — подпись газа (ряд и ось графика полёта,
//          плитка «Средний …» шага 0); frame_prefix — начало строки MSG с рамой;
//   vtol_modes — режимы, по участкам которых берётся окно полёта (null — весь полёт с газом); modes — имена режимов по
//          номеру; acro_mode, level_modes — режим Acro и режимы с самовыравниванием для выхода из него;
//   filter_defaults — заводские фильтры ПИД, Гц: FLTT всех осей (fltt_hz), FLTD и FLTE крена и тангажа (fltd_rp_hz,
//          flte_rp_hz), FLTD и FLTE рыскания (fltd_y_hz, flte_y_hz); accel_defaults_degss — заводские
//          пределы ускорения, °/с²; accel_frame — рама с другими заводскими пределами ({ param, value, degss }, null — нет)
//          (оба — через vehicle_accel_defaults);
//   gyro_axes — ось гироскопа для крена, тангажа и рыскания и знак (у tailsitter — vehicle_gyro_axes);
//   prop_formula — шаг 3: варианты по размеру винта по формулам Mission Planner (поле размера винта и рекомендация;
//          false — формулы для вида нет: поля, варианта и рекомендации нет);
//   loop_rate_default — SCHED_LOOP_RATE, если его нет в логе;
//   flight_title — что за окно полёта (проверка «Полёт», плитка шага 0); hover_throttle_text — средний газ окна в
//          проверке газа висения; hover_learn_modes, hover_learn_note — где учится газ висения и почему не в других
//          режимах (null — без пояснения);
//   is_tailsitter(params) — tailsitter ли аппарат по параметрам (params с get, как у log_params; может быть null); null —
//          у вида tailsitter не бывает (core/log.js тогда не разбирает PARM ради этого)
const vehicle_profiles = {
    copter: {
        kind: "copter",
        title: "Copter",
        build_type: 2,                          // VER.BU ArduCopter (Libraries/LogHelpers.js)
        enable_param: null,
        param_marker: "ATC_RAT_RLL_P",          // контур скорости крена Copter (дизайн этапа 7) [наше]
        steps: [0, 1, 2, 3, 4, 5],
        closed_steps: {},
        atc: "ATC_",
        mot: "MOT_",
        pid_messages: ["PIDR", "PIDP", "PIDY"], // [код] ArduCopter/Log.cpp:88 (Log_Write_PIDS)
        pid_title: "Сообщения PID",
        fullrate_bit: null,
        // CTUN.ThO — выход газа, RATE.AOut — газ моторов [код] ArduCopter/Log.cpp:58,
        // AC_AttitudeControl/AC_AttitudeControl_Logging.cpp:50
        throttle: [["CTUN", "ThO"], ["RATE", "AOut"]],
        throttle_title: "Газ",
        frame_prefix: "Frame: ",                // [код] AP_Motors/AP_Motors_Class.cpp:67–69 (get_frame_and_type_string)
        vtol_modes: null,
        // То же, что pidtune_mode_names (core/pidtune.js, шаг 4) — равенство закреплено в tests/tunewizard-vehicle.test.cjs
        // [код] ArduCopter/mode.h, Mode::Number
        modes: {
            0: "STABILIZE", 1: "ACRO", 2: "ALT_HOLD", 3: "AUTO", 4: "GUIDED", 5: "LOITER", 6: "RTL", 7: "CIRCLE", 9: "LAND",
            11: "DRIFT", 13: "SPORT", 14: "FLIP", 15: "AUTOTUNE", 16: "POSHOLD", 17: "BRAKE", 18: "THROW", 19: "AVOID_ADSB",
            20: "GUIDED_NOGPS", 21: "SMART_RTL", 22: "FLOWHOLD", 23: "FOLLOW", 24: "ZIGZAG", 25: "SYSTEMID", 26: "AUTOROTATE",
            27: "AUTO_RTL", 28: "TURTLE",
        },
        // То же, что pidtune_rules.acro_mode и prep_rules.level_modes (STABILIZE, ALT_HOLD, LOITER, POSHOLD) — равенство
        // закреплено в tests/tunewizard-vehicle.test.cjs [код] ArduCopter/mode.h; [наше, решение пользователя 30.10.2026]
        acro_mode: 1,
        level_modes: [0, 2, 5, 16],
        // Шаг 3 (core/lowpass.js) берёт их отсюда для параметров, которых нет в логе: FLTT и FLTD всех осей — 20 Гц
        // (AC_ATC_MULTI_RATE_RPY_FILT_HZ), FLTE рыскания — 2.5 Гц (AC_ATC_MULTI_RATE_YAW_FILT_HZ), крена и тангажа — нет
        // [код] AC_AttitudeControl/AC_AttitudeControl_Multi.h:22–38, 106–149, AC_AttitudeControl.h
        filter_defaults: { fltt_hz: 20, fltd_rp_hz: 20, fltd_y_hz: 20, flte_rp_hz: 0, flte_y_hz: 2.5 },
        accel_defaults_degss: { r: 1100, p: 1100, y: 270 },
        accel_frame: null,
        gyro_axes: { roll: "x", pitch: "y", yaw: "z", sign: { roll: 1, pitch: 1, yaw: 1 } },
        // Формулы Mission Planner ConfigInitialParams.cs (core/lowpass.js, prop_values) [MP; решение пользователя 24.10.2026]
        prop_formula: true,
        loop_rate_default: 400,                 // [код] AP_Scheduler/AP_Scheduler.cpp:43–44 (так же — FilterReview)
        flight_title: "Полёт с газом",
        hover_throttle_text: "средний газ в полёте",
        hover_learn_modes: "AltHold",
        hover_learn_note: null,
        is_tailsitter: null,
    },
    quadplane: {
        kind: "quadplane",
        title: "QuadPlane",
        build_type: 3,                          // VER.BU ArduPlane (Libraries/LogHelpers.js)
        // QuadPlane поднимается при любом ненулевом Q_ENABLE (0:Disable, 1:Enable, 2:Enable VTOL AUTO); при 0 параметры
        // Q_* скрыты (флаг ENABLE) [код] ArduPlane/quadplane.cpp:9–15, 680
        enable_param: "Q_ENABLE",
        param_marker: "Q_A_RAT_RLL_P",          // виден только при Q_ENABLE ≠ 0 [код] quadplane.cpp:15, Parameters.cpp:817–821
        steps: [0, 1, 2, 3, 5],                 // шаг 4 — следующим этапом [решение пользователя 30.10.2026]
        // Текст — дизайн этапа 9, раздел 7, обобщён после ревью задачи 2: без частностей третьего лога (PIQx 24 Гц, полёт
        // в QSTABILIZE) — он про любой лог QuadPlane
        closed_steps: {
            4: "Шаг 4 (PID) для QuadPlane пока недоступен: метод ещё не проверен на логе QuadPlane, для него нужен лог полёта " +
               "в QACRO с PID на частоте цикла. Подготовьте такой лог в «Подготовке к следующему полёту» (цель «PID»); шаг 4 " +
               "появится следующим этапом.",
        },
        // Q_A_ — тот же AC_AttitudeControl_Multi, Q_M_ — тот же AP_MotorsMulticopter [код] Parameters.cpp:817–821,
        // quadplane.cpp:17–19, 768
        atc: "Q_A_",
        mot: "Q_M_",
        // PIQR/PIQP/PIQY — регуляторы VTOL; PIDR/PIDP/PIDY у Plane — самолётные [код] ArduPlane/Log.cpp:30–34, 46–51
        pid_messages: ["PIQR", "PIQP", "PIQY"],
        pid_title: "Сообщения PID VTOL",
        // ATTITUDE_FULLRATE: PIQR/PIQP/PIQY с частотой цикла; бита PID у Plane нет, бит 12 — CAMERA [код] ArduPlane/
        // defines.h:102–121, Log.cpp:59–65; [4.6.3] defines.h:109–126
        fullrate_bit: 20,
        // QTUN.ThO и RATE.AOut — газ VTOL-моторов 0…1, пишутся без LOG_BITMASK; CTUN.ThO у Plane — самолётный мотор, в VTOL
        // ≈ 0 [код] quadplane.cpp:3751, 1801–1808, 1815–1838, AC_AttitudeControl_Logging.cpp:50, ArduPlane/Log.cpp:110;
        // [лог] оба дают окно 317–382 с и средний газ 0.47
        throttle: [["QTUN", "ThO"], ["RATE", "AOut"]],
        throttle_title: "Газ VTOL",
        frame_prefix: "QuadPlane Frame: ",      // «QuadPlane » + get_frame_and_type_string [код] ArduPlane/Log.cpp:573–574
        // Режимы с is_vtol_mode(): QSTABILIZE, QHOVER, QLOITER, QLAND, QRTL, QAUTOTUNE, QACRO [код] ArduPlane/mode.h:735,
        // 769, 802, 832, 853, 889, 912 [решение пользователя 30.10.2026: интервал по умолчанию — только VTOL-режимы]
        vtol_modes: [17, 18, 19, 20, 21, 22, 23],
        // [код] ArduPlane/mode.h:38–75; 5 и 6 — сокращения FBWA и FBWB (Mission Planner, modules/JsDataflashParser)
        modes: {
            0: "MANUAL", 1: "CIRCLE", 2: "STABILIZE", 3: "TRAINING", 4: "ACRO", 5: "FBWA", 6: "FBWB", 7: "CRUISE",
            8: "AUTOTUNE", 10: "AUTO", 11: "RTL", 12: "LOITER", 13: "TAKEOFF", 14: "AVOID_ADSB", 15: "GUIDED",
            16: "INITIALISING", 17: "QSTABILIZE", 18: "QHOVER", 19: "QLOITER", 20: "QLAND", 21: "QRTL", 22: "QAUTOTUNE",
            23: "QACRO", 24: "THERMAL", 25: "LOITER_ALT_QLAND", 26: "AUTOLAND",
        },
        // QACRO; выход — QSTABILIZE, QHOVER, QLOITER [код] mode.h:38–75, mode_qstabilize.cpp:12–40, quadplane.cpp:1101–1116;
        // [решение пользователя 30.10.2026]
        acro_mode: 23,
        level_modes: [17, 18, 19],
        // FLTD крена и тангажа 10 Гц (таблица defaults_table QuadPlane), остальное — как у Copter: FLTD рыскания 20 Гц
        // [код] quadplane.cpp:581–590 ([4.6.3] 564–590), AC_AttitudeControl_Multi.h:10–38, 136–149
        filter_defaults: { fltt_hz: 20, fltd_rp_hz: 10, fltd_y_hz: 20, flte_rp_hz: 0, flte_y_hz: 2.5 },
        // 400 / 400 / 100 °/с² (в 4.6 — Q_A_ACCEL_*_MAX 40000 / 40000 / 10000 сантиградусов/с²) [код] quadplane.cpp:603–606,
        // [4.6.3] quadplane.cpp:587–589. Рама Q_FRAME_CLASS = 10 (MOTOR_FRAME_TAILSITTER) — крен и тангаж 300 °/с²
        // (в 4.6 — 30000) [код] tailsitter.cpp:186–187, 231–234, AP_Motors_Class.h:65; [4.6.3] tailsitter.cpp:186–187
        accel_defaults_degss: { r: 400, p: 400, y: 100 },
        accel_frame: { param: "Q_FRAME_CLASS", value: 10, degss: { r: 300, p: 300 } },
        gyro_axes: { roll: "x", pitch: "y", yaw: "z", sign: { roll: 1, pitch: 1, yaw: 1 } },
        // Формулы по размеру винта для Q_A_RAT_* нет: в modules/ardupilot — только примеры .param (Tools/Frame_params/
        // QuadPlanes/), в Mission Planner и wiki Plane — не проверено [решение пользователя 30.10.2026; дизайн, раздел 6]
        prop_formula: false,
        // 300 при Q_ENABLE (без него — 50); арминг QuadPlane требует не меньше 100 [код] AP_Scheduler.cpp:43–47,
        // Parameters.cpp:1365–1370, AP_Arming_Plane.cpp:166–169
        loop_rate_default: 300,
        flight_title: "Висение VTOL",
        hover_throttle_text: "средний газ VTOL",
        // Q_M_THST_HOVER учится только при работающем регуляторе высоты: QHOVER, QLOITER, QLAND, QRTL, VTOL в AUTO и
        // GUIDED; в QSTABILIZE и QACRO газ ручной [код] quadplane.cpp:1918–1960 (регулятор Z — 1941–1944), 1101–1116,
        // mode_qloiter.cpp:177, mode_qland.cpp:27–32, mode_qrtl.cpp:120. Ещё условие — оценка воздушной скорости ниже
        // 0.3·AIRSPEED_MIN (quadplane.cpp:1951–1953); есть ли она без датчика скорости — не проверено
        hover_learn_modes: "QHOVER или QLOITER",
        hover_learn_note: "в QSTABILIZE и QACRO газ висения не учится",
        // Q_TAILSIT_ENABLE > 0 (1 — Enable, 2 — Enable Always) [код] tailsitter.cpp:26–33, quadplane.cpp:763
        is_tailsitter: (params) => (params?.get("Q_TAILSIT_ENABLE") ?? 0) > 0,
    },
}

// Оси гироскопа tailsitter: регулятор VTOL работает в виде, повёрнутом на 90° по тангажу — крен VTOL ↔ Z гироскопа,
// тангаж ↔ Y, рыскание ↔ −X [код] quadplane.cpp:763, AP_AHRS/AP_AHRS_View.cpp:24–88; [лог] корреляция RATE с IMU[0]:
// R↔Z +1.00, P↔Y +1.00, Y↔X −1.00. Q_TRIM_PITCH ≠ 0 слегка смешивает R и Y — не учитывается (дизайн, раздел 13)
const vehicle_tailsitter_gyro_axes = { roll: "z", pitch: "y", yaw: "x", sign: { roll: 1, pitch: 1, yaw: -1 } }

// Вид аппарата лога по build_type (VER.BU, get_version_and_board) и параметрам лога (params с get, как у log_params):
// первый профиль с тем же build_type, у которого enable_param нет или он больше 0 → "copter" | "quadplane"; иначе
// (Plane без Q_ENABLE, Rover, нет build_type) — null
function vehicle_kind(build_type, params) {
    for (const profile of Object.values(vehicle_profiles)) {
        if (profile.build_type !== build_type) {
            continue
        }
        if ((profile.enable_param == null) || ((params?.get(profile.enable_param) ?? 0) > 0)) {
            return profile.kind
        }
    }
    return null
}

// Вид по файлу .param (params с has): первый профиль, чей param_marker есть в файле → "copter" | "quadplane"; ни того ни
// другого (или params нет) — null
function vehicle_kind_of_params(params) {
    if (params == null) {
        return null
    }
    for (const profile of Object.values(vehicle_profiles)) {
        if (params.has(profile.param_marker)) {
            return profile.kind
        }
    }
    return null
}

// Профиль по виду (vehicle_kind) или null — вид не поддержан
function vehicle_profile(kind) {
    return ((kind != null) && Object.hasOwn(vehicle_profiles, kind)) ? vehicle_profiles[kind] : null
}

// Имя параметра регулятора: vehicle_atc(профиль QuadPlane, "RAT_RLL_FLTD") → "Q_A_RAT_RLL_FLTD"
function vehicle_atc(profile, suffix) {
    return profile.atc + suffix
}

// Имя параметра моторов: vehicle_mot(профиль Copter, "THST_HOVER") → "MOT_THST_HOVER"
function vehicle_mot(profile, suffix) {
    return profile.mot + suffix
}

// Оси гироскопа для крена, тангажа и рыскания { roll, pitch, yaw: "x" | "y" | "z", sign: { roll, pitch, yaw: 1 | −1 } }:
// у tailsitter (profile.is_tailsitter) — vehicle_tailsitter_gyro_axes, иначе profile.gyro_axes. params — с get; может быть null
function vehicle_gyro_axes(profile, params) {
    return (profile.is_tailsitter?.(params) ?? false) ? vehicle_tailsitter_gyro_axes : profile.gyro_axes
}

// Заводские пределы ускорения { r, p, y }, °/с²: accel_defaults_degss профиля, а при раме accel_frame (параметр
// accel_frame.param равен accel_frame.value) — её значения поверх. params — с get; может быть null
function vehicle_accel_defaults(profile, params) {
    const frame = profile.accel_frame
    if ((frame != null) && (params?.get(frame.param) == frame.value)) {
        return { ...profile.accel_defaults_degss, ...frame.degss }
    }
    return { ...profile.accel_defaults_degss }
}

if (typeof module !== "undefined") {
    module.exports = { vehicle_profiles, vehicle_tailsitter_gyro_axes, vehicle_kind, vehicle_kind_of_params, vehicle_profile, vehicle_atc, vehicle_mot, vehicle_gyro_axes, vehicle_accel_defaults }
}
