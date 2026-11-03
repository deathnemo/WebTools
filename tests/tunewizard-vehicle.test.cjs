// Тесты профиля аппарата мастера настройки (TuneWizard/core/vehicle.js): вид лога по VER.BU и Q_ENABLE, вид файла .param
// по признаку, профиль по виду, имена параметров с префиксом, оси гироскопа tailsitter, заводские пределы ускорения рамы
// Q_FRAME_CLASS = 10; значения профиля Copter — против констант, которые пока живут в других скриптах ядра (pidtune.js,
// prep.js, log.js), чтобы они не разошлись, и шаг 3 без профиля (lowpass.js) — как с профилем Copter. Дизайн —
// docs/plans/2026-10-30-tune-wizard-stage9-design.md, разделы 3, 10 и 11.
// vehicle.js — двойной скрипт: здесь он берётся через require (как в tests/tunewizard.test.cjs), а для сверки констант
// скрипты ядра грузятся как на странице — по порядку через vm.runInThisContext (общая глобальная область: заодно видно,
// что новые имена не спорят с остальными скриптами).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const vehicle = require('../TuneWizard/core/vehicle.js')
const { copter, quadplane } = vehicle.vehicle_profiles

const repo = path.resolve(__dirname, '..')

// FFTJS на странице — глобал из modules/fft.js/dist/fft.js; под Node берём ту же библиотеку через require
globalThis.FFTJS = require('../modules/fft.js/lib/fft.js')

// Скрипты ядра в порядке страницы (index.html) — до core/prep.js: pidtune_mode_names и pidtune_rules (pidtune.js),
// prep_mode_slots и prep_exit_slots (prep.js), lowpass_log_values, lowpass_param_names и lowpass_vehicle_axes
// (lowpass.js), LOG_DEFAULT_PROFILE (log.js)
for (const file of [
    'Libraries/Array_Math.js',
    'Libraries/fft.js',
    'Libraries/Param_Helpers.js',
    'TuneWizard/core/vehicle.js',
    'TuneWizard/core/log.js',
    'TuneWizard/core/checks.js',
    'TuneWizard/core/gyro.js',
    'TuneWizard/core/tracking/Atmosphere_model.js',
    'TuneWizard/core/tracking/BaseClass.js',
    'TuneWizard/core/tracking/Static.js',
    'TuneWizard/core/tracking/Throttle.js',
    'TuneWizard/core/tracking/RPM.js',
    'TuneWizard/core/tracking/ESC.js',
    'TuneWizard/core/tracking/FFT.js',
    'TuneWizard/core/tracking/Logged.js',
    'TuneWizard/core/filters.js',
    'TuneWizard/core/spectrum.js',
    'TuneWizard/core/metrics.js',
    'TuneWizard/core/autofit.js',
    'TuneWizard/core/candidates.js',
    'TuneWizard/core/lowpass.js',
    'TuneWizard/core/pid.js',
    'TuneWizard/core/pidtune.js',
    'TuneWizard/core/params.js',
    'TuneWizard/core/summary.js',
    'TuneWizard/core/prep.js',
]) {
    const full = path.join(repo, file)
    vm.runInThisContext(fs.readFileSync(full, 'utf8'), { filename: full })
}

// Параметры с интерфейсом log_params: get(name) — значение или null, has(name)
function fake_params(values) {
    return {
        get: (name) => (name in values) ? values[name] : null,
        has: (name) => name in values,
    }
}

test('vehicle_kind: VER.BU 2 — Copter; 3 и Q_ENABLE 1 или 2 — QuadPlane; 3 с Q_ENABLE 0 или без него и другие сборки — null', () => {
    assert.equal(vehicle.vehicle_kind(2, fake_params({})), 'copter')
    // У Copter Q_ENABLE не смотрится, параметры не нужны
    assert.equal(vehicle.vehicle_kind(2, fake_params({ Q_ENABLE: 0 })), 'copter')
    assert.equal(vehicle.vehicle_kind(2, null), 'copter')
    // Q_ENABLE: 0 Disable, 1 Enable, 2 Enable VTOL AUTO — QuadPlane при любом ненулевом [код] ArduPlane/quadplane.cpp:9–15, 680
    assert.equal(vehicle.vehicle_kind(3, fake_params({ Q_ENABLE: 1 })), 'quadplane')
    assert.equal(vehicle.vehicle_kind(3, fake_params({ Q_ENABLE: 2 })), 'quadplane')
    assert.equal(vehicle.vehicle_kind(3, fake_params({ Q_ENABLE: 0 })), null)
    assert.equal(vehicle.vehicle_kind(3, fake_params({})), null)
    assert.equal(vehicle.vehicle_kind(3, null), null)
    // Rover, AntennaTracker, Sub, Blimp, сборка не определена
    for (const build_type of [1, 4, 7, 12, null, undefined]) {
        assert.equal(vehicle.vehicle_kind(build_type, fake_params({ Q_ENABLE: 1 })), null, 'VER.BU = ' + build_type)
    }
})

test('vehicle_kind_of_params: ATC_RAT_RLL_P — Copter, Q_A_RAT_RLL_P — QuadPlane, ни того ни другого — null', () => {
    assert.equal(vehicle.vehicle_kind_of_params(fake_params({ ATC_RAT_RLL_P: 0.135 })), 'copter')
    assert.equal(vehicle.vehicle_kind_of_params(fake_params({ Q_ENABLE: 1, Q_A_RAT_RLL_P: 0.25 })), 'quadplane')
    // Plane без QuadPlane: Q_* скрыты при Q_ENABLE = 0, в файле один Q_ENABLE и самолётные RLL_RATE_*
    assert.equal(vehicle.vehicle_kind_of_params(fake_params({ Q_ENABLE: 0, RLL_RATE_P: 0.08 })), null)
    assert.equal(vehicle.vehicle_kind_of_params(fake_params({})), null)
    assert.equal(vehicle.vehicle_kind_of_params(null), null)
    // Оба признака (так не бывает) — первый по таблице, Copter
    assert.equal(vehicle.vehicle_kind_of_params(fake_params({ ATC_RAT_RLL_P: 0.1, Q_A_RAT_RLL_P: 0.25 })), 'copter')
})

test('vehicle_profile, vehicle_atc, vehicle_mot: профиль по виду и имена параметров с префиксом профиля', () => {
    assert.equal(vehicle.vehicle_profile('copter'), copter)
    assert.equal(vehicle.vehicle_profile('quadplane'), quadplane)
    for (const kind of [null, undefined, 'plane', 'constructor', 'toString']) {
        assert.equal(vehicle.vehicle_profile(kind), null, String(kind))
    }
    assert.equal(vehicle.vehicle_atc(copter, 'RAT_RLL_FLTD'), 'ATC_RAT_RLL_FLTD')
    assert.equal(vehicle.vehicle_atc(quadplane, 'RAT_RLL_FLTD'), 'Q_A_RAT_RLL_FLTD')
    assert.equal(vehicle.vehicle_atc(quadplane, 'ACCEL_R_MAX'), 'Q_A_ACCEL_R_MAX')
    assert.equal(vehicle.vehicle_mot(copter, 'THST_HOVER'), 'MOT_THST_HOVER')
    assert.equal(vehicle.vehicle_mot(quadplane, 'HOVER_LEARN'), 'Q_M_HOVER_LEARN')
    // Вид, ключ и build_type профиля согласованы
    for (const [key, profile] of Object.entries(vehicle.vehicle_profiles)) {
        assert.equal(profile.kind, key)
        assert.equal(vehicle.vehicle_kind(profile.build_type, fake_params({ Q_ENABLE: 1 })), key)
        assert.equal(vehicle.vehicle_kind_of_params(fake_params({ [profile.param_marker]: 1 })), key)
    }
    // Профили описаны одними полями
    assert.deepEqual(Object.keys(quadplane), Object.keys(copter))
})

test('профиль QuadPlane: шаги без 4, PIQx, газ QTUN.ThO → RATE.AOut, VTOL-режимы 17–23, QACRO и выход, бит 20, рама', () => {
    assert.deepEqual(copter.steps, [0, 1, 2, 3, 4, 5])
    assert.deepEqual(quadplane.steps, [0, 1, 2, 3, 5])
    // Почему шаг закрыт — у каждого шага мастера вне steps, и только у них (подсказка кнопки шага, дизайн, раздел 7)
    for (const profile of [copter, quadplane]) {
        for (let n = 0; n <= 5; n++) {
            assert.equal(Object.hasOwn(profile.closed_steps, n), !profile.steps.includes(n), profile.kind + ', шаг ' + n)
        }
    }
    // Текст — про любой лог QuadPlane, без частностей третьего лога (ревью задачи 2)
    assert.equal(quadplane.closed_steps[4], 'Шаг 4 (PID) для QuadPlane пока недоступен: метод ещё не проверен на логе QuadPlane, для него нужен лог ' +
        'полёта в QACRO с PID на частоте цикла. Подготовьте такой лог в «Подготовке к следующему полёту» (цель «PID»); шаг 4 появится следующим этапом.')
    assert.doesNotMatch(quadplane.closed_steps[4], /25 Гц|24 Гц|QSTABILIZE/)
    assert.deepEqual(quadplane.pid_messages, ['PIQR', 'PIQP', 'PIQY'])
    assert.deepEqual(quadplane.throttle, [['QTUN', 'ThO'], ['RATE', 'AOut']])
    assert.deepEqual(quadplane.vtol_modes.map((m) => quadplane.modes[m]), ['QSTABILIZE', 'QHOVER', 'QLOITER', 'QLAND', 'QRTL', 'QAUTOTUNE', 'QACRO'])
    assert.equal(quadplane.modes[quadplane.acro_mode], 'QACRO')
    assert.deepEqual(quadplane.level_modes.map((m) => quadplane.modes[m]), ['QSTABILIZE', 'QHOVER', 'QLOITER'])
    // Самолётные режимы — не VTOL: FBWA (5), LOITER_ALT_QLAND (25) — наследник LOITER [код] ArduPlane/mode.h:469
    assert.equal(quadplane.modes[5], 'FBWA')
    assert.equal(quadplane.vtol_modes.includes(25), false)
    assert.equal(quadplane.fullrate_bit, 20)
    assert.equal(1 << quadplane.fullrate_bit, 1048576)
    assert.equal(copter.fullrate_bit, null)
    assert.equal(quadplane.frame_prefix, 'QuadPlane Frame: ')
    assert.equal(quadplane.loop_rate_default, 300)
    assert.equal(copter.loop_rate_default, 400)
    // FLTD крена и тангажа — 10 Гц, рыскания — 20, как у Copter [код] quadplane.cpp:581–590
    assert.deepEqual(quadplane.filter_defaults, { fltt_hz: 20, fltd_rp_hz: 10, fltd_y_hz: 20, flte_rp_hz: 0, flte_y_hz: 2.5 })
    assert.deepEqual(copter.filter_defaults, { fltt_hz: 20, fltd_rp_hz: 20, fltd_y_hz: 20, flte_rp_hz: 0, flte_y_hz: 2.5 })
    // Подпись газа и формула по размеру винта (шаг 3)
    assert.deepEqual([copter.throttle_title, quadplane.throttle_title], ['Газ', 'Газ VTOL'])
    assert.deepEqual([copter.prop_formula, quadplane.prop_formula], [true, false])
})

test('vehicle_gyro_axes: Copter и QuadPlane — крен X, тангаж Y; tailsitter (Q_TAILSIT_ENABLE 1 или 2) — крен Z, тангаж Y, рыскание −X', () => {
    const plain = { roll: 'x', pitch: 'y', yaw: 'z', sign: { roll: 1, pitch: 1, yaw: 1 } }
    assert.deepEqual(vehicle.vehicle_gyro_axes(copter, fake_params({ Q_TAILSIT_ENABLE: 2 })), plain)
    assert.deepEqual(vehicle.vehicle_gyro_axes(copter, null), plain)
    for (const values of [{ Q_TAILSIT_ENABLE: 0 }, {}]) {
        assert.deepEqual(vehicle.vehicle_gyro_axes(quadplane, fake_params(values)), plain, JSON.stringify(values))
    }
    assert.deepEqual(vehicle.vehicle_gyro_axes(quadplane, null), plain)
    // [лог] третий лог: корреляция RATE с IMU[0] — R↔Z +1.00, P↔Y +1.00, Y↔X −1.00
    const tailsitter = { roll: 'z', pitch: 'y', yaw: 'x', sign: { roll: 1, pitch: 1, yaw: -1 } }
    for (const Q_TAILSIT_ENABLE of [1, 2]) {
        assert.deepEqual(vehicle.vehicle_gyro_axes(quadplane, fake_params({ Q_TAILSIT_ENABLE })), tailsitter, 'Q_TAILSIT_ENABLE = ' + Q_TAILSIT_ENABLE)
        assert.equal(quadplane.is_tailsitter(fake_params({ Q_TAILSIT_ENABLE })), true)
    }
    assert.equal(quadplane.is_tailsitter(fake_params({ Q_TAILSIT_ENABLE: 0 })), false)
    assert.equal(quadplane.is_tailsitter(null), false)
    assert.equal(copter.is_tailsitter, null)
})

test('vehicle_accel_defaults: Copter 1100 / 1100 / 270, QuadPlane 400 / 400 / 100 °/с², рама Q_FRAME_CLASS = 10 — крен и тангаж 300', () => {
    assert.deepEqual(vehicle.vehicle_accel_defaults(copter, fake_params({})), { r: 1100, p: 1100, y: 270 })
    // У Copter Q_FRAME_CLASS не смотрится
    assert.deepEqual(vehicle.vehicle_accel_defaults(copter, fake_params({ Q_FRAME_CLASS: 10, FRAME_CLASS: 10 })), { r: 1100, p: 1100, y: 270 })
    assert.deepEqual(vehicle.vehicle_accel_defaults(quadplane, fake_params({ Q_FRAME_CLASS: 1 })), { r: 400, p: 400, y: 100 })
    assert.deepEqual(vehicle.vehicle_accel_defaults(quadplane, fake_params({})), { r: 400, p: 400, y: 100 })
    assert.deepEqual(vehicle.vehicle_accel_defaults(quadplane, null), { r: 400, p: 400, y: 100 })
    // MOTOR_FRAME_TAILSITTER [код] AP_Motors_Class.h:65, ArduPlane/tailsitter.cpp:186–187, 231–234
    assert.deepEqual(vehicle.vehicle_accel_defaults(quadplane, fake_params({ Q_FRAME_CLASS: 10 })), { r: 300, p: 300, y: 100 })
    // Возвращается копия: правка результата не меняет профиль
    const result = vehicle.vehicle_accel_defaults(quadplane, fake_params({ Q_FRAME_CLASS: 10 }))
    result.r = 1
    assert.deepEqual(quadplane.accel_defaults_degss, { r: 400, p: 400, y: 100 })
    assert.deepEqual(quadplane.accel_frame.degss, { r: 300, p: 300 })
})

test('профиль Copter совпадает с константами ядра: режимы и ACRO (pidtune.js), выход из Acro (prep.js), шаг 3 без профиля (lowpass.js), без профиля (log.js)', () => {
    // Скрипт страницы: глобалы те же, что у require
    assert.deepEqual(vehicle_profiles.copter.modes, copter.modes)
    assert.equal(typeof vehicle_kind, 'function')
    // pidtune_mode_names и pidtune_rules.acro_mode — шаг 4 Copter (не меняется на этапе 9)
    assert.deepEqual(copter.modes, pidtune_mode_names)
    assert.equal(copter.acro_mode, pidtune_rules.acro_mode)
    // Подготовка (prep.js) с задачи 5 этапа 9 берёт ACRO и выход из профиля; без профиля — Copter
    assert.deepEqual(prep_exit_slots(prep_mode_slots(fake_params({ FLTMODE1: 0, FLTMODE2: 2, FLTMODE3: 5, FLTMODE4: 16, FLTMODE5: 1, FLTMODE6: 3 }))).map((s) => s.slot),
        [1, 2, 3, 4])
    // lowpass.js с задачи 3 этапа 9 берёт заводские и оси из профиля; без профиля — Copter, как до этапа 9
    const empty = fake_params({})
    assert.deepEqual(lowpass_log_values(empty), lowpass_log_values(empty, vehicle_profiles.copter))
    assert.deepEqual(lowpass_param_names(empty, null), lowpass_param_names(empty, vehicle_profiles.copter))
    assert.deepEqual(lowpass_vehicle_axes(), { roll: { param: 'RLL', gyro: copter.gyro_axes.roll }, pitch: { param: 'PIT', gyro: copter.gyro_axes.pitch } })
    // LOG_DEFAULT_PROFILE — сведения о логе без профиля, как до этапа 9
    for (const key of Object.keys(LOG_DEFAULT_PROFILE)) {
        assert.deepEqual(copter[key], LOG_DEFAULT_PROFILE[key], key)
    }
})
