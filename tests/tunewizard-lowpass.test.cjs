// Тесты низкочастотных фильтров шага 3 мастера настройки (TuneWizard/core/lowpass.js): формулы Mission Planner
// по размеру винта (включая округление C# и RoundTo), имена и единицы пределов ускорения для 4.6 и новых
// версий, значения лога с заводскими по умолчанию, распознавание заводских пределов и набор вариантов; модель ПИД
// без гироскопа — фильтр первого порядка и его задержка, производная, отметки вариантов, предупреждения модели
// (оценка на синтетическом гироскопе — в tests/tunewizard-steps.test.cjs).
// Скрипты ядра — классические (общая глобальная область), поэтому загружаются как на странице:
// по порядку через vm.runInThisContext (как в tests/tunewizard-steps.test.cjs).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const repo = path.resolve(__dirname, '..')

// FFTJS на странице — глобал из modules/fft.js/dist/fft.js; под Node берём ту же библиотеку через require
globalThis.FFTJS = require('../modules/fft.js/lib/fft.js')

// Загрузить скрипты страницы в глобальную область, в том порядке, что и index.html
function load_page_scripts(files) {
    for (const file of files) {
        const full = path.join(repo, file)
        vm.runInThisContext(fs.readFileSync(full, 'utf8'), { filename: full })
    }
}

load_page_scripts([
    'Libraries/Array_Math.js',
    'Libraries/fft.js',
    'TuneWizard/core/log.js',
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
])

// Параметры без лога: values = { имя: значение }
function fake_params(values) {
    return { get: (name) => (name in values) ? values[name] : null, has: (name) => name in values, changed: () => false }
}

// Значения лога пользователя (ArduCopter 4.6.3, старые имена пределов ускорения, сантиградусы/с²)
const user_log = {
    INS_GYRO_FILTER: 40,
    INS_ACCEL_FILTER: 10,
    ATC_RAT_RLL_FLTT: 20,
    ATC_RAT_RLL_FLTE: 0,
    ATC_RAT_RLL_FLTD: 30,
    ATC_RAT_PIT_FLTT: 20,
    ATC_RAT_PIT_FLTE: 0,
    ATC_RAT_PIT_FLTD: 30,
    ATC_RAT_YAW_FLTT: 20,
    ATC_RAT_YAW_FLTE: 1,
    ATC_RAT_YAW_FLTD: 0,
    ATC_ACCEL_R_MAX: 90000,
    ATC_ACCEL_P_MAX: 90000,
    ATC_ACCEL_Y_MAX: 50045.70703125,
}

const filter_names = [
    'INS_GYRO_FILTER', 'INS_ACCEL_FILTER',
    'ATC_RAT_RLL_FLTT', 'ATC_RAT_RLL_FLTE', 'ATC_RAT_RLL_FLTD',
    'ATC_RAT_PIT_FLTT', 'ATC_RAT_PIT_FLTE', 'ATC_RAT_PIT_FLTD',
    'ATC_RAT_YAW_FLTT', 'ATC_RAT_YAW_FLTE', 'ATC_RAT_YAW_FLTD',
]
const old_accel = ['ATC_ACCEL_R_MAX', 'ATC_ACCEL_P_MAX', 'ATC_ACCEL_Y_MAX']
const new_accel = ['ATC_ACC_R_MAX', 'ATC_ACC_P_MAX', 'ATC_ACC_Y_MAX']

// Значения лога пользователя с заменами changes: имя → значение (null — удалить)
function user_log_with(changes) {
    const values = { ...user_log }
    for (const [name, value] of Object.entries(changes)) {
        if (value == null) {
            delete values[name]
        } else {
            values[name] = value
        }
    }
    return values
}

// Варианты по значениям лога values (объект имя → значение) и размеру винта prop
function candidates_for(values, prop) {
    const params = fake_params(values)
    return lowpass_candidates(lowpass_log_values(params), prop, lowpass_accel_names(params))
}

test('mp_round_half_even: середина округляется к чётному, как Math.Round в C#', () => {
    assert.equal(mp_round_half_even(2.5), 2)
    assert.equal(mp_round_half_even(3.5), 4)
    assert.equal(mp_round_half_even(-2.5), -2)
    assert.equal(mp_round_half_even(-3.5), -4)
    assert.equal(mp_round_half_even(0.5), 0)
    assert.equal(mp_round_half_even(41.998), 42)
    assert.equal(mp_round_half_even(2.4999), 2)
    assert.equal(mp_round_half_even(2.5001), 3)
})

test('mp_round_to: RoundTo Mission Planner — до сотен половиной вверх, при precision ≥ 0 — Math.Round C#', () => {
    assert.equal(mp_round_to(116659.8, -2), 116700, '116659.8 + 50 → 116700, а не отбрасывание до 116600')
    assert.equal(mp_round_to(27000, -2), 27000)
    assert.equal(mp_round_to(24750, -2), 24800, 'середина — вверх')
    assert.equal(mp_round_to(24749.9, -2), 24700)
    assert.equal(mp_round_to(2.5, 0), 2, 'precision = 0 — к чётному')
    assert.equal(mp_round_to(1.25, 1), 1.2, 'precision > 0 — к чётному в знаке precision')
})

test('prop_valid: размер винта — положительное конечное число', () => {
    assert.equal(prop_valid(10), true)
    assert.equal(prop_valid(0.5), true)
    for (const p of [0, -1, NaN, Infinity, -Infinity, null, undefined, '10']) {
        assert.equal(prop_valid(p), false, String(p))
    }
})

test('prop_values: ровно значения Mission Planner на 5 / 10 / 12.5 / 20 / 30″', () => {
    const table = [
        // p, INS_GYRO_FILTER, FLTT/FLTD, ACCEL_R/P и ACCEL_Y в сантиградусах/с²
        [5, 75, 37.5, 168600, 31500],
        [10, 42, 21, 116700, 27000],
        [12.5, 35, 17.5, 95800, 24800],
        [20, 23, 11.5, 50500, 18000],
        [30, 20, 10, 21800, 9000],
    ]
    for (const [p, gyro, pid, accel_rp, accel_y] of table) {
        const values = prop_values(p)
        const at = p + '″: '
        assert.equal(values.INS_GYRO_FILTER, gyro, at + 'INS_GYRO_FILTER')
        for (const axis of ['RLL', 'PIT']) {
            assert.equal(values['ATC_RAT_' + axis + '_FLTT'], pid, at + axis + ' FLTT')
            assert.equal(values['ATC_RAT_' + axis + '_FLTD'], pid, at + axis + ' FLTD')
            assert.equal(values['ATC_RAT_' + axis + '_FLTE'], 0, at + axis + ' FLTE')
        }
        assert.equal(values.ATC_RAT_YAW_FLTT, pid, at + 'YAW FLTT = FLTT')
        assert.equal(values.ATC_RAT_YAW_FLTE, 2, at + 'YAW FLTE')
        assert.equal(values.ATC_RAT_YAW_FLTD, 0, at + 'YAW FLTD')
        assert.equal(values.INS_ACCEL_FILTER, 10, at + 'INS_ACCEL_FILTER')
        assert.deepEqual(values.accel_cdegss, { r: accel_rp, p: accel_rp, y: accel_y }, at + 'пределы ускорения')
        assert.deepEqual(Object.keys(values).sort(), [...filter_names, 'accel_cdegss'].sort(), at + 'ровно эти ключи')
    }
})

test('prop_values: берём Mission Planner, а не таблицу wiki — расхождения записаны', () => {
    // Таблица wiki «Setting up for tuning»: 5″ — 80 Гц, 10″ — 40 Гц, ATC_ACC_P/R_MAX 1100 и ATC_ACC_Y_MAX 200 °/с² для 10″
    const wiki = { 5: { gyro: 80 }, 10: { gyro: 40, accel_rp_degss: 1100, accel_y_degss: 200 } }
    const p5 = prop_values(5)
    const p10 = prop_values(10)
    assert.equal(p5.INS_GYRO_FILTER, 75)
    assert.notEqual(p5.INS_GYRO_FILTER, wiki[5].gyro)
    assert.equal(p10.INS_GYRO_FILTER, 42)
    assert.notEqual(p10.INS_GYRO_FILTER, wiki[10].gyro)
    assert.equal(p10.accel_cdegss.r / 100, 1167)
    assert.notEqual(p10.accel_cdegss.r / 100, wiki[10].accel_rp_degss)
    assert.equal(p10.accel_cdegss.y / 100, 270)
    assert.notEqual(p10.accel_cdegss.y / 100, wiki[10].accel_y_degss)
})

test('prop_values: нижние границы формул — 20 Гц гироскопа, 10 Гц ПИД, 10000 и 8000 сантиградусов/с²', () => {
    const values = prop_values(60)
    assert.equal(values.INS_GYRO_FILTER, 20)
    assert.equal(values.ATC_RAT_RLL_FLTT, 10)
    assert.equal(values.ATC_RAT_RLL_FLTD, 10)
    assert.deepEqual(values.accel_cdegss, { r: 10000, p: 10000, y: 8000 })
})

test('prop_values: на 4–40″ шагом 0.5″ все значения конечные', () => {
    for (let p = 4; p <= 40; p += 0.5) {
        const { accel_cdegss, ...filters } = prop_values(p)
        for (const [name, value] of Object.entries({ ...filters, ...accel_cdegss })) {
            assert.ok(Number.isFinite(value), p + '″: ' + name + ' = ' + value)
        }
    }
})

test('lowpass_pid_filter_hz: max(10, INS_GYRO_FILTER / 2)', () => {
    assert.equal(lowpass_pid_filter_hz(42), 21)
    assert.equal(lowpass_pid_filter_hz(20), 10)
    assert.equal(lowpass_pid_filter_hz(16), 10)
})

test('prop_from_gyro_filter: обратная формула, без клампа и округления; null, если hz не положительное конечное', () => {
    assert.ok(Math.abs(prop_from_gyro_filter(40) - 10.5989) <= 1e-3, '40 Гц → ' + prop_from_gyro_filter(40))
    for (const hz of [0, -5, null, NaN, Infinity, -Infinity]) {
        assert.equal(prop_from_gyro_filter(hz), null, String(hz))
    }
    assert.equal(prop_values(prop_from_gyro_filter(42)).INS_GYRO_FILTER, 42)
})

test('lowpass_accel_names: имена и единицы пределов ускорения по логу — 4.6 и новые версии', () => {
    assert.deepEqual(lowpass_accel_names(fake_params(user_log)),
        { r: 'ATC_ACCEL_R_MAX', p: 'ATC_ACCEL_P_MAX', y: 'ATC_ACCEL_Y_MAX', scale: 100, units: 'cdeg/s/s' })
    assert.deepEqual(lowpass_accel_names(fake_params({ ATC_ACC_R_MAX: 1100 })),
        { r: 'ATC_ACC_R_MAX', p: 'ATC_ACC_P_MAX', y: 'ATC_ACC_Y_MAX', scale: 1, units: 'deg/s/s' })
    assert.deepEqual(lowpass_accel_names(fake_params({})),
        { r: 'ATC_ACC_R_MAX', p: 'ATC_ACC_P_MAX', y: 'ATC_ACC_Y_MAX', scale: 1, units: 'deg/s/s' })
})

test('lowpass_param_names: фильтры по осям, затем пределы ускорения под именами из лога', () => {
    assert.deepEqual(lowpass_param_names(fake_params(user_log)), [...filter_names, ...old_accel])
    assert.deepEqual(lowpass_param_names(fake_params({})), [...filter_names, ...new_accel])
})

test('lowpass_log_values: значения лога как float32, отсутствующие — заводские', () => {
    const values = lowpass_log_values(fake_params(user_log))
    assert.deepEqual(Object.keys(values), [...filter_names, ...old_accel])
    for (const [name, value] of Object.entries(user_log)) {
        assert.equal(values[name], Math.fround(value), name)
    }

    // Float32: 0.7 из файла и 0.699999988 из лога — одно значение
    assert.equal(lowpass_log_values(fake_params({ ...user_log, ATC_RAT_YAW_FLTE: 0.7 })).ATC_RAT_YAW_FLTE, Math.fround(0.7))

    // Пустой лог, новые имена: заводские Copter
    const defaults = lowpass_log_values(fake_params({}))
    assert.deepEqual(defaults, {
        INS_GYRO_FILTER: 20, INS_ACCEL_FILTER: 20,
        ATC_RAT_RLL_FLTT: 20, ATC_RAT_RLL_FLTE: 0, ATC_RAT_RLL_FLTD: 20,
        ATC_RAT_PIT_FLTT: 20, ATC_RAT_PIT_FLTE: 0, ATC_RAT_PIT_FLTD: 20,
        ATC_RAT_YAW_FLTT: 20, ATC_RAT_YAW_FLTE: 2.5, ATC_RAT_YAW_FLTD: 20,
        ATC_ACC_R_MAX: 1100, ATC_ACC_P_MAX: 1100, ATC_ACC_Y_MAX: 270,
    })

    // Старые имена (по ATC_ACCEL_R_MAX в логе): отсутствующие пределы — заводские в сантиградусах/с²
    const old = lowpass_log_values(fake_params({ ATC_ACCEL_R_MAX: 90000 }))
    assert.equal(old.ATC_ACCEL_R_MAX, 90000)
    assert.equal(old.ATC_ACCEL_P_MAX, 110000)
    assert.equal(old.ATC_ACCEL_Y_MAX, 27000)
})

test('lowpass_accel_is_default: заводские 1100 / 270 °/с² × scale с допуском 0.5·scale', () => {
    const old_names = lowpass_accel_names(fake_params(user_log))
    const new_names = lowpass_accel_names(fake_params({}))
    const old_values = (r, p, y) => ({ ATC_ACCEL_R_MAX: r, ATC_ACCEL_P_MAX: p, ATC_ACCEL_Y_MAX: y })
    const new_values = (r, p, y) => ({ ATC_ACC_R_MAX: r, ATC_ACC_P_MAX: p, ATC_ACC_Y_MAX: y })

    assert.equal(lowpass_accel_is_default(old_values(110000, 110000, 27000), old_names), true)
    assert.equal(lowpass_accel_is_default(old_values(90000, 90000, Math.fround(50045.7)), old_names), false)
    assert.equal(lowpass_accel_is_default(new_values(1100, 1100, 270), new_names), true)

    // Допуск и каждая ось по отдельности
    assert.equal(lowpass_accel_is_default(old_values(110050, 109950, 27050), old_names), true, 'ровно на допуске')
    assert.equal(lowpass_accel_is_default(old_values(110051, 110000, 27000), old_names), false, 'R за допуском')
    assert.equal(lowpass_accel_is_default(old_values(110000, 109000, 27000), old_names), false, 'только P другой')
    assert.equal(lowpass_accel_is_default(old_values(110000, 110000, 27100), old_names), false, 'только Y другой')
    assert.equal(lowpass_accel_is_default(new_values(1100.4, 1100, 269.6), new_names), true)
    assert.equal(lowpass_accel_is_default(new_values(1100, 1100, 271), new_names), false)

    // Значения с другими именами (лог старый, names новые) — не заводские
    assert.equal(lowpass_accel_is_default(old_values(110000, 110000, 27000), new_names), false)
})

test('lowpass_candidates: без размера винта — «как в логе» и «лог + правило /2»', () => {
    for (const prop of [null, undefined, NaN, 0, -10, Infinity, -Infinity]) {
        const candidates = candidates_for(user_log, prop)
        assert.deepEqual(candidates.map((c) => c.id), ['log', 'half'], 'размер ' + prop)
    }
})

test('lowpass_candidates: 10″ на логе пользователя — лог, по размеру винта (пределы из лога), правило /2', () => {
    const params = fake_params(user_log)
    const log_values = lowpass_log_values(params)
    const names = lowpass_accel_names(params)
    const candidates = lowpass_candidates(log_values, 10, names)
    assert.deepEqual(candidates.map((c) => c.id), ['log', 'prop', 'half'])
    assert.deepEqual(candidates.map((c) => c.title), ['Как в логе', 'По размеру винта (10″)', 'Лог + правило /2'])
    assert.deepEqual(candidates.map((c) => c.same_as), [[], [], []], 'совпадений нет')

    const [log, prop, half] = candidates
    const expected_names = lowpass_param_names(params)
    for (const candidate of candidates) {
        assert.deepEqual(Object.keys(candidate.values), expected_names, candidate.id + ': ровно параметры шага')
    }
    assert.deepEqual(log.values, log_values)

    // По размеру винта: фильтры по формуле, пределы ускорения из лога (AutoTune), а не по формуле
    assert.deepEqual(prop.values, {
        INS_GYRO_FILTER: 42, INS_ACCEL_FILTER: 10,
        ATC_RAT_RLL_FLTT: 21, ATC_RAT_RLL_FLTE: 0, ATC_RAT_RLL_FLTD: 21,
        ATC_RAT_PIT_FLTT: 21, ATC_RAT_PIT_FLTE: 0, ATC_RAT_PIT_FLTD: 21,
        ATC_RAT_YAW_FLTT: 21, ATC_RAT_YAW_FLTE: 2, ATC_RAT_YAW_FLTD: 0,
        ATC_ACCEL_R_MAX: 90000, ATC_ACCEL_P_MAX: 90000, ATC_ACCEL_Y_MAX: Math.fround(50045.70703125),
    })
    assert.equal(prop.accel_from_log, true)
    assert.deepEqual(prop.formula_accel, { r: 116700, p: 116700, y: 27000 }, 'формула — для справки, в единицах лога')

    // Лог + правило /2: INS_GYRO_FILTER лога, FLTT/FLTD крена и тангажа и FLTT рыскания = max(10, 40 / 2), остальное — лог
    assert.deepEqual(half.values, {
        ...log_values,
        ATC_RAT_RLL_FLTT: 20, ATC_RAT_RLL_FLTD: 20,
        ATC_RAT_PIT_FLTT: 20, ATC_RAT_PIT_FLTD: 20,
        ATC_RAT_YAW_FLTT: 20,
    })
    assert.equal(half.values.ATC_RAT_YAW_FLTE, Math.fround(1), 'FLTE рыскания — из лога')
    assert.equal(half.values.ATC_RAT_YAW_FLTD, 0, 'FLTD рыскания — из лога')
})

test('lowpass_candidates: правило /2 не опускается ниже 10 Гц', () => {
    const half = candidates_for(user_log_with({ INS_GYRO_FILTER: 16 }), null).find((c) => c.id === 'half')
    assert.equal(half.values.INS_GYRO_FILTER, 16)
    assert.equal(half.values.ATC_RAT_RLL_FLTD, 10)
    assert.equal(half.values.ATC_RAT_YAW_FLTT, 10)
})

test('lowpass_candidates: фильтр гироскопа выключен в логе — без «лог + правило /2»', () => {
    const off = user_log_with({ INS_GYRO_FILTER: 0 })
    assert.deepEqual(candidates_for(off, null).map((c) => c.id), ['log'])
    assert.deepEqual(candidates_for(off, 10).map((c) => c.id), ['log', 'prop'])
})

test('lowpass_candidates: заводские пределы в логе — у «по размеру винта» пределы по формуле', () => {
    // Старые имена, сантиградусы/с²
    const old_prop = candidates_for(user_log_with({ ATC_ACCEL_R_MAX: 110000, ATC_ACCEL_P_MAX: 110000, ATC_ACCEL_Y_MAX: 27000 }), 10)
        .find((c) => c.id === 'prop')
    assert.equal(old_prop.values.ATC_ACCEL_R_MAX, 116700)
    assert.equal(old_prop.values.ATC_ACCEL_P_MAX, 116700)
    assert.equal(old_prop.values.ATC_ACCEL_Y_MAX, 27000)
    assert.equal(old_prop.accel_from_log, false)
    assert.deepEqual(old_prop.formula_accel, { r: 116700, p: 116700, y: 27000 })

    // Новые имена, °/с²: значение Mission Planner делится на 100
    const new_log = user_log_with({
        ATC_ACCEL_R_MAX: null, ATC_ACCEL_P_MAX: null, ATC_ACCEL_Y_MAX: null,
        ATC_ACC_R_MAX: 1100, ATC_ACC_P_MAX: 1100, ATC_ACC_Y_MAX: 270,
    })
    const new_prop = candidates_for(new_log, 10).find((c) => c.id === 'prop')
    assert.equal(new_prop.values.ATC_ACC_R_MAX, 1167)
    assert.equal(new_prop.values.ATC_ACC_P_MAX, 1167)
    assert.equal(new_prop.values.ATC_ACC_Y_MAX, 270)
    assert.equal(new_prop.accel_from_log, false)
    assert.deepEqual(new_prop.formula_accel, { r: 1167, p: 1167, y: 270 })
    assert.deepEqual(Object.keys(new_prop.values), lowpass_param_names(fake_params(new_log)))

    // Размер как ввёл пользователь — в заголовке
    const p12 = candidates_for(new_log, 12.5).find((c) => c.id === 'prop')
    assert.equal(p12.title, 'По размеру винта (12.5″)')
    assert.equal(p12.values.ATC_ACC_R_MAX, 958)
    assert.equal(p12.values.ATC_ACC_Y_MAX, 248)
})

test('lowpass_candidates: одинаковые наборы остаются один раз, у оставшегося — same_as', () => {
    // Лог уже по правилу /2 → «лог + правило /2» совпадает с логом
    const by_rule = user_log_with({ ATC_RAT_RLL_FLTD: 20, ATC_RAT_PIT_FLTD: 20 })
    const without_prop = candidates_for(by_rule, null)
    assert.deepEqual(without_prop.map((c) => c.id), ['log'])
    assert.deepEqual(without_prop[0].same_as, ['half'])
    const with_prop = candidates_for(by_rule, 10)
    assert.deepEqual(with_prop.map((c) => c.id), ['log', 'prop'])
    assert.deepEqual(with_prop.map((c) => c.same_as), [['half'], []])

    // Лог совпадает с «по размеру винта» 12.5″: FLTT/FLTD 17.5 и INS_GYRO_FILTER 35 — остаётся «как в логе»,
    // правило /2 даёт те же 17.5 — тоже исчезает
    const p12 = candidates_for(user_log_with({
        INS_GYRO_FILTER: 35, INS_ACCEL_FILTER: 10,
        ATC_RAT_RLL_FLTT: 17.5, ATC_RAT_RLL_FLTD: 17.5,
        ATC_RAT_PIT_FLTT: 17.5, ATC_RAT_PIT_FLTD: 17.5,
        ATC_RAT_YAW_FLTT: 17.5, ATC_RAT_YAW_FLTE: 2,
    }), 12.5)
    assert.deepEqual(p12.map((c) => c.id), ['log'])
    assert.deepEqual(p12[0].same_as, ['prop', 'half'])

    // «Лог + правило /2» совпадает с «по размеру винта» 10″, а лог отличается (FLTT 20, FLTD 30): половина
    // INS_GYRO_FILTER 42 — 21, как у формулы
    const half_is_prop = candidates_for(user_log_with({ INS_GYRO_FILTER: 42, ATC_RAT_YAW_FLTE: 2 }), 10)
    assert.deepEqual(half_is_prop.map((c) => c.id), ['log', 'prop'])
    assert.deepEqual(half_is_prop.map((c) => c.same_as), [[], ['half']])

    // Значения вариантов — float32, даже если log_values не прошли через lowpass_log_values: лог с FLTT/FLTD
    // float32(20.1) и INS_GYRO_FILTER 40.2 (double); правило /2 даёт 20.1 (double), во float32 — то же, что в логе,
    // поэтому «лог + правило /2» исчезает
    const params_user = fake_params(user_log)
    const raw = {
        ...lowpass_log_values(params_user),
        INS_GYRO_FILTER: 40.2,
        ATC_RAT_RLL_FLTT: Math.fround(20.1), ATC_RAT_RLL_FLTD: Math.fround(20.1),
        ATC_RAT_PIT_FLTT: Math.fround(20.1), ATC_RAT_PIT_FLTD: Math.fround(20.1),
        ATC_RAT_YAW_FLTT: Math.fround(20.1),
    }
    const raw_candidates = lowpass_candidates(raw, 10, lowpass_accel_names(params_user))
    assert.deepEqual(raw_candidates.map((c) => c.id), ['log', 'prop'])
    assert.equal(raw_candidates[0].values.INS_GYRO_FILTER, Math.fround(40.2))
    for (const candidate of raw_candidates) {
        for (const [name, value] of Object.entries(candidate.values)) {
            assert.equal(value, Math.fround(value), candidate.id + ': ' + name + ' — float32')
        }
    }
})

test('prop_size_warning: пусто — нет предупреждения, вне 4–40″ и не число — текст', () => {
    for (const p of [2, 3, 41, 0, -1, NaN, Infinity, -Infinity]) {
        assert.match(prop_size_warning(p), /4–40″/, String(p))
    }
    assert.equal(prop_size_warning(10), null)
    assert.equal(prop_size_warning(4), null)
    assert.equal(prop_size_warning(40), null)
    assert.equal(prop_size_warning(null), null)
    assert.equal(prop_size_warning(undefined), null)
})

// ---------- Модель ПИД: фильтр первого порядка, производная, отметки вариантов ----------

// Независимая модель фильтра первого порядка ArduPilot (AC_PID.cpp, calc_lowpass_alpha_dt) своей комплексной
// арифметикой: H = alpha / (1 − (1 − alpha)·e^(−jω)), ω = 2π·f / rate. Возвращает { re, im, phase } (фаза в радианах)
function first_order(fc, rate, f) {
    const dt = 1 / rate
    const alpha = dt / (dt + 1 / (2 * Math.PI * fc))
    const w = 2 * Math.PI * f / rate
    // e^(−jω) = cos ω − j·sin ω; знаменатель 1 − (1 − alpha)·e^(−jω)
    const den = { re: 1 - (1 - alpha) * Math.cos(w), im: (1 - alpha) * Math.sin(w) }
    const norm = den.re * den.re + den.im * den.im
    const h = { re: alpha * den.re / norm, im: -alpha * den.im / norm }
    return { ...h, phase: Math.atan2(h.im, h.re) }
}

test('pid_lowpass_response: без фильтра (fc ≤ 0) — H = 1; иначе alpha / (1 − (1 − alpha)·z⁻¹)', () => {
    for (const fc of [0, -5, null, undefined, NaN]) {
        for (const f of [0, 10, 30, 199]) {
            assert.deepEqual(pid_lowpass_response(fc, 400, f), [1, 0], 'fc ' + fc + ', ' + f + ' Гц')
        }
        assert.equal(pid_lowpass_lag_ms(fc, 400, 30), 0, 'без фильтра задержки нет: fc ' + fc)
    }
    for (const [fc, rate, f] of [[20, 400, 30], [30, 400, 10], [15, 400, 167], [10, 1000, 50]]) {
        const [re, im] = pid_lowpass_response(fc, rate, f)
        const ref = first_order(fc, rate, f)
        assert.ok(Math.abs(re - ref.re) < 1e-12 && Math.abs(im - ref.im) < 1e-12, fc + ' Гц на ' + f + ' Гц: ' + [re, im] + ' против ' + [ref.re, ref.im])
    }
    // На 0 Гц фильтр пропускает без изменений
    const dc = pid_lowpass_response(20, 400, 0)
    assert.ok(Math.abs(dc[0] - 1) < 1e-12 && Math.abs(dc[1]) < 1e-12)
})

test('pid_lowpass_lag_ms: 20 Гц на 30 и 10 Гц, 30 Гц на 30 Гц при контуре 400 Гц; чем выше срез, тем меньше задержка', () => {
    const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) <= 1e-3, label + ': ' + actual)
    near(pid_lowpass_lag_ms(20, 400, 30), 4.3531, '20 Гц на 30 Гц')
    near(pid_lowpass_lag_ms(20, 400, 10), 7.1117, '20 Гц на 10 Гц')
    near(pid_lowpass_lag_ms(30, 400, 30), 3.5223, '30 Гц на 30 Гц')
    // Независимо: −фаза / (2π·f) · 1000 по своей модели
    for (const [fc, f] of [[20, 30], [20, 10], [30, 30], [12.5, 30], [45, 10]]) {
        const ref = -first_order(fc, 400, f).phase / (2 * Math.PI * f) * 1000
        assert.ok(Math.abs(pid_lowpass_lag_ms(fc, 400, f) - ref) < 1e-12, fc + ' Гц на ' + f + ' Гц')
    }
    for (const f of [10, 30]) {
        let previous = Infinity
        for (const fc of [5, 10, 15, 20, 30, 50, 80]) {
            const lag = pid_lowpass_lag_ms(fc, 400, f)
            assert.ok(lag > 0 && lag < previous, f + ' Гц: срез ' + fc + ' Гц — ' + lag + ' мс, у предыдущего ' + previous)
            previous = lag
        }
    }
})

test('derivative_gain2: |(1 − z⁻¹)/dt|² при dt = 1 / loop_rate', () => {
    assert.ok(Math.abs(derivative_gain2(100, 400) - 320000) <= 1e-6, String(derivative_gain2(100, 400)))
    assert.equal(derivative_gain2(0, 400), 0)
    // На частоте Найквиста контура: (2·loop_rate)²; на низких частотах ≈ (2π·f)², как у непрерывной производной
    assert.ok(Math.abs(derivative_gain2(200, 400) - 800 ** 2) < 1e-6)
    assert.ok(Math.abs(derivative_gain2(1, 400) / (2 * Math.PI) ** 2 - 1) < 1e-4)
})

// Поддельная оценка варианта для lowpass_flags: шум гироскопа, шум D крена и тангажа (null — оси без Kd) и задержка
// путей P и D на 10 и 30 Гц (одна на обе оси, на 10 Гц — на 2 мс больше)
function fake_lowpass_eval({ gyro = -40, roll = -20, pitch = -21, P = 7, D = 10.5 } = {}) {
    const lag = (ms) => ({ 10: ms + 2, 30: ms })
    const dterm = (dB) => (dB === null) ? null : { dB, spectrum: [] }
    return {
        values: {},
        warnings: [],
        gyro: { band_dB: gyro, lag_ms: lag(P), spectrum: null, pre_spectrum: null },
        dterm: { bins: [], roll: dterm(roll), pitch: dterm(pitch) },
        lag_ms: { roll: { P: lag(P), D: lag(D) }, pitch: { P: lag(P), D: lag(D) } },
    }
}

const no_lowpass_flags = { noisier: [], slower: [], incomplete: false, incomplete_axes: [] }

test('lowpass_flags: ровно на порогах +3 дБ и +1 мс — без отметки, чуть выше — с отметкой', () => {
    const log = fake_lowpass_eval()
    assert.deepEqual(lowpass_flags(log, log), no_lowpass_flags, 'лог против себя')
    assert.deepEqual(lowpass_flags(fake_lowpass_eval({ gyro: -37, roll: -17, pitch: -18, P: 8, D: 11.5 }), log), no_lowpass_flags,
        'ровно +3 дБ и ровно +1 мс')
    // Лучше лога — без отметок
    assert.deepEqual(lowpass_flags(fake_lowpass_eval({ gyro: -45, roll: -30, pitch: -30, P: 6, D: 9 }), log), no_lowpass_flags)

    assert.deepEqual(lowpass_flags(fake_lowpass_eval({ gyro: -36.9999 }), log), { ...no_lowpass_flags, noisier: ['gyro'] })
    assert.deepEqual(lowpass_flags(fake_lowpass_eval({ roll: -16.9999 }), log), { ...no_lowpass_flags, noisier: ['roll'] })
    assert.deepEqual(lowpass_flags(fake_lowpass_eval({ gyro: -36.9999, roll: -16.9999, pitch: -17.9999 }), log),
        { ...no_lowpass_flags, noisier: ['gyro', 'roll', 'pitch'] })
    // Путь P больше на 1.0001 мс, путь D — на 1 мс ровно (у пути D свой отсчёт от лога)
    assert.deepEqual(lowpass_flags(fake_lowpass_eval({ P: 8.0001, D: 11.5 }), log), { ...no_lowpass_flags, slower: ['roll P', 'pitch P'] })
    assert.deepEqual(lowpass_flags(fake_lowpass_eval({ D: 11.5001 }), log), { ...no_lowpass_flags, slower: ['roll D', 'pitch D'] })
    // Задержка на 10 Гц не проверяется — только на старшей из lag_freqs_hz
    const lag10 = fake_lowpass_eval()
    lag10.lag_ms.roll.P[10] += 5
    assert.deepEqual(lowpass_flags(lag10, log), no_lowpass_flags)
    // Пороги берутся из rules
    assert.deepEqual(lowpass_flags(fake_lowpass_eval({ gyro: -38, P: 7.6 }), log, { ...lowpass_rules, max_noise_increase_dB: 1, max_lag_increase_ms: 0.5 }),
        { ...no_lowpass_flags, noisier: ['gyro'], slower: ['roll P', 'pitch P'] })
})

test('lowpass_flags: при сомнении отмечает — NaN в шуме или задержке, нет оценки, ось без Kd', () => {
    const log = fake_lowpass_eval()
    // Нечисловой шум D и задержка — отметка
    assert.deepEqual(lowpass_flags(fake_lowpass_eval({ pitch: NaN }), log).noisier, ['pitch'])
    assert.deepEqual(lowpass_flags(fake_lowpass_eval(), fake_lowpass_eval({ roll: NaN })).noisier, ['roll'], 'NaN у лога')
    assert.deepEqual(lowpass_flags(fake_lowpass_eval({ D: NaN }), log).slower, ['roll D', 'pitch D'])
    const no_lag = fake_lowpass_eval()
    delete no_lag.lag_ms.pitch
    assert.deepEqual(lowpass_flags(no_lag, log).slower, ['pitch P', 'pitch D'], 'нет задержки оси')

    // Нет оценки варианта или лога, нечисловая полоса гироскопа — incomplete, остальные проверки не делаются
    const no_band = { ...log, gyro: { ...log.gyro, band_dB: undefined } }
    for (const [evaluation, against] of [[null, log], [log, null], [fake_lowpass_eval({ gyro: NaN }), log], [log, no_band], [log, { ...log, gyro: undefined }]]) {
        assert.deepEqual(lowpass_flags(evaluation, against), { ...no_lowpass_flags, incomplete: true })
    }

    // Ось без Kd у обоих — без отметки шума, но в incomplete_axes; задержка проверяется
    const no_kd = fake_lowpass_eval({ roll: null })
    assert.deepEqual(lowpass_flags(fake_lowpass_eval({ roll: null }), no_kd), { ...no_lowpass_flags, incomplete_axes: ['roll'] })
    assert.deepEqual(lowpass_flags(fake_lowpass_eval({ roll: null, pitch: null, D: 12 }), fake_lowpass_eval({ roll: null, pitch: null })),
        { ...no_lowpass_flags, slower: ['roll D', 'pitch D'], incomplete_axes: ['roll', 'pitch'] })
    // Шум D есть только у одного — сравнить не с чем: отметка и неполная ось
    assert.deepEqual(lowpass_flags(fake_lowpass_eval({ pitch: null }), log), { ...no_lowpass_flags, noisier: ['pitch'], incomplete_axes: ['pitch'] })
    assert.deepEqual(lowpass_flags(log, fake_lowpass_eval({ pitch: null })), { ...no_lowpass_flags, noisier: ['pitch'], incomplete_axes: ['pitch'] })
})

test('lowpass_model_warnings: notch-фильтры ПИД крена и тангажа (NTF/NEF ≠ 0) — строка на ось с именами', () => {
    const one = lowpass_model_warnings(fake_params({ ATC_RAT_RLL_NEF: 1, ATC_RAT_RLL_NTF: 0, ATC_RAT_PIT_NEF: 0, ATC_RAT_PIT_NTF: 0 }))
    assert.equal(one.length, 1)
    assert.match(one[0], /ATC_RAT_RLL_NEF = 1/)
    assert.doesNotMatch(one[0], /NTF/, 'нулевые не перечисляются')

    const both = lowpass_model_warnings(fake_params({ ATC_RAT_RLL_NTF: 2, ATC_RAT_RLL_NEF: 1, ATC_RAT_PIT_NTF: 3 }))
    assert.equal(both.length, 2, 'строка на ось: ' + both.join(' | '))
    assert.match(both[0], /ATC_RAT_RLL_NTF = 2.*ATC_RAT_RLL_NEF = 1/)
    assert.match(both[1], /ATC_RAT_PIT_NTF = 3/)

    assert.deepEqual(lowpass_model_warnings(fake_params({ ATC_RAT_RLL_NTF: 0, ATC_RAT_RLL_NEF: 0, ATC_RAT_PIT_NTF: 0, ATC_RAT_PIT_NEF: 0 })), [])
    assert.deepEqual(lowpass_model_warnings(fake_params({})), [], 'параметров нет (прошивка без notch ПИД)')
    assert.deepEqual(lowpass_model_warnings(fake_params(user_log)), [])
})
