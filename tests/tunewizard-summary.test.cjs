// Тесты итога прохода мастера настройки (TuneWizard/core/summary.js): сравнение значений как float32 и масок,
// строки итога по принятым шагам 2–4 (порядок источников и расхождение INS_GYRO_FILTER, ESCMSK по версии фильтра,
// включаемый notch, параметры без лога, ненадёжные оси шага 4), значения и текст .param из изменённых, имя
// файла, отпечаток входов принятого шага и «устарело».
// Скрипты ядра — классические (общая глобальная область), поэтому загружаются как на странице:
// по порядку через vm.runInThisContext (как в tests/tunewizard-pidtune.test.cjs).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const repo = path.resolve(__dirname, '..')

// Загрузить скрипты страницы в глобальную область, в том порядке, что и index.html
function load_page_scripts(files) {
    for (const file of files) {
        const full = path.join(repo, file)
        vm.runInThisContext(fs.readFileSync(full, 'utf8'), { filename: full })
    }
}

// Нужное итогу в порядке страницы: param_file_text (Param_Helpers.js, params.js), notch_param_names (filters.js),
// pidtune_axes (pidtune.js; ему при загрузке нужны константы core/pid.js)
load_page_scripts([
    'Libraries/Param_Helpers.js',
    'TuneWizard/core/filters.js',
    'TuneWizard/core/pid.js',
    'TuneWizard/core/pidtune.js',
    'TuneWizard/core/params.js',
    'TuneWizard/core/summary.js',
])

// ---------------------------------------------------------------- поддельные данные

// Параметры лога с интерфейсом log_params: get(name) — значение или null, has(name)
function fake_params(values) {
    return {
        get: (name) => (name in values) ? values[name] : null,
        has: (name) => name in values,
    }
}

// Имена шагов — как их собирает страница: step2_param_names(), lowpass_param_names(params) для лога 4.6+
// (пределы ATC_ACC_*_MAX), step4_param_names()
const STEP2_NAMES = ['INS_GYRO_FILTER', 'SCHED_LOOP_RATE', ...notch_param_names().flatMap((n) => Object.values(n))]
const STEP3_NAMES = ['INS_GYRO_FILTER', 'INS_ACCEL_FILTER',
    ...['RLL', 'PIT', 'YAW'].flatMap((a) => ['FLTT', 'FLTE', 'FLTD'].map((k) => 'ATC_RAT_' + a + '_' + k)),
    'ATC_ACC_R_MAX', 'ATC_ACC_P_MAX', 'ATC_ACC_Y_MAX']
const STEP4_NAMES = Object.values(pidtune_axes).flatMap((axis) => ['P', 'I', 'D'].map((k) => axis.rate + k))
const NAMES = { 2: STEP2_NAMES, 3: STEP3_NAMES, 4: STEP4_NAMES }

// Лог как у тестового: версия фильтра 2 (ESCMSK нет), первый notch включён, второй выключен — полей INS_HNTC2_*,
// кроме ENABLE, в логе нет. Дробные значения — как float32 из лога
const BASE_LOG = {
    INS_GYRO_FILTER: 40, SCHED_LOOP_RATE: 400,
    INS_HNTCH_ENABLE: 1, INS_HNTCH_MODE: 3, INS_HNTCH_FREQ: 80, INS_HNTCH_BW: 40, INS_HNTCH_ATT: 40,
    INS_HNTCH_REF: 1, INS_HNTCH_FM_RAT: 1, INS_HNTCH_HMNCS: 3, INS_HNTCH_OPTS: 0,
    INS_HNTC2_ENABLE: 0,
    INS_ACCEL_FILTER: 20,
    ATC_RAT_RLL_FLTT: 20, ATC_RAT_RLL_FLTE: 0, ATC_RAT_RLL_FLTD: 20,
    ATC_RAT_PIT_FLTT: 20, ATC_RAT_PIT_FLTE: 0, ATC_RAT_PIT_FLTD: 20,
    ATC_RAT_YAW_FLTT: 20, ATC_RAT_YAW_FLTE: 2.5, ATC_RAT_YAW_FLTD: 20,
    ATC_ACC_R_MAX: 1100, ATC_ACC_P_MAX: 1100, ATC_ACC_Y_MAX: 270,
    ATC_RAT_RLL_P: Math.fround(0.135), ATC_RAT_RLL_I: Math.fround(0.135), ATC_RAT_RLL_D: Math.fround(0.0036),
    ATC_RAT_PIT_P: Math.fround(0.135), ATC_RAT_PIT_I: Math.fround(0.135), ATC_RAT_PIT_D: Math.fround(0.0036),
    ATC_RAT_YAW_P: Math.fround(0.18), ATC_RAT_YAW_I: Math.fround(0.018), ATC_RAT_YAW_D: 0,
}

// Принятое шага: по всем именам шага — значение из changes, иначе из лога, иначе 0 (как форма шага 2 даёт
// значения и скрытым полям)
function accepted_values(names, log, changes = {}) {
    return Object.fromEntries(names.map((name) => [name, (name in changes) ? changes[name] : ((name in log) ? log[name] : 0)]))
}

// Метрики осей шага 4: reliable по осям (по умолчанию все надёжны)
function step4_axes(reliable = {}) {
    return Object.fromEntries(Object.keys(pidtune_axes).map((axis) => [axis, { candidate_id: 'custom', flags: null,
        metrics: { reliable: reliable[axis] ?? true } }]))
}

// Вход summary_rows: лог (поверх BASE_LOG), принятые шаги, версия фильтра и размер маски HMNCS
function rows_ctx({ log = BASE_LOG, steps = [], filter_version = 2, bits = 8 } = {}) {
    return { params: fake_params(log), steps: steps, names: NAMES, filter_version: filter_version, bits: bits }
}

function row_of(result, name) {
    return result.rows.find((r) => r.name === name)
}

// ---------------------------------------------------------------- summary_same

test('summary_same: null с null — одно, null с числом — разное', () => {
    assert.equal(summary_same('INS_GYRO_FILTER', null, null, 8), true)
    assert.equal(summary_same('INS_GYRO_FILTER', null, 40, 8), false)
    assert.equal(summary_same('INS_GYRO_FILTER', 40, null, 8), false)
    assert.equal(summary_same('INS_HNTCH_HMNCS', null, 0, 8), false)
})

test('summary_same: числа — как float32', () => {
    assert.equal(summary_same('ATC_RAT_RLL_P', 0.699999988, 0.7, 32), true)
    assert.equal(summary_same('ATC_RAT_RLL_P', 0.699999988, 0.71, 32), false)
})

test('summary_same: маски — целые; HMNCS без знака по размеру маски, остальные маски — как есть', () => {
    assert.equal(summary_same('INS_HNTCH_HMNCS', -128, 128, 8), true)
    assert.equal(summary_same('INS_HNTCH_HMNCS', -128, 128, 32), false)
    // Целые без float32: 2^24 + 1 и 2^24 во float32 совпали бы
    assert.equal(Math.fround(2**24 + 1), Math.fround(2**24))
    assert.equal(summary_same('INS_HNTCH_HMNCS', 2**24 + 1, 2**24, 32), false)
    assert.equal(summary_same('INS_HNTCH_OPTS', -128, 128, 8), false)
    assert.equal(summary_same('INS_HNTC2_ESCMSK', 15, 15, 8), true)
})

// ---------------------------------------------------------------- summary_rows

test('summary_rows: непринятые шаги — строк нет, accepted по шагам false', () => {
    for (const steps of [[], [undefined, undefined, null, null, null]]) {
        const result = summary_rows(rows_ctx({ steps: steps }))
        assert.deepEqual(result.rows, [])
        assert.deepEqual(result.conflicts, [])
        assert.deepEqual(result.accepted, { 2: false, 3: false, 4: false })
    }
})

test('summary_rows: строка — имя, было, станет, шаг, изменён, пометка; порядок шагов и имён шага', () => {
    const steps = []
    steps[3] = { accepted: accepted_values(STEP3_NAMES, BASE_LOG, { INS_ACCEL_FILTER: 10 }) }
    steps[4] = { accepted: accepted_values(STEP4_NAMES, BASE_LOG), axes: step4_axes() }
    const result = summary_rows(rows_ctx({ steps: steps }))
    assert.deepEqual(result.accepted, { 2: false, 3: true, 4: true })
    assert.deepEqual(result.rows.map((r) => r.name), [...STEP3_NAMES, ...STEP4_NAMES])
    assert.deepEqual(row_of(result, 'INS_ACCEL_FILTER'),
        { name: 'INS_ACCEL_FILTER', log: 20, value: 10, step: 3, changed: true, note: null })
    assert.deepEqual(row_of(result, 'ATC_RAT_RLL_P'),
        { name: 'ATC_RAT_RLL_P', log: Math.fround(0.135), value: Math.fround(0.135), step: 4, changed: false, note: null })
    assert.deepEqual(result.rows.filter((r) => r.changed).map((r) => r.name), ['INS_ACCEL_FILTER'])
})

test('summary_rows: сравнение как float32 — 0.7 при логе 0.699999988 не изменён, 0.71 — изменён', () => {
    const log = { ...BASE_LOG, ATC_RAT_RLL_P: 0.699999988 }
    for (const [value, changed] of [[0.7, false], [0.71, true]]) {
        const steps = []
        steps[4] = { accepted: accepted_values(STEP4_NAMES, log, { ATC_RAT_RLL_P: value }), axes: step4_axes() }
        const row = row_of(summary_rows(rows_ctx({ log: log, steps: steps })), 'ATC_RAT_RLL_P')
        assert.equal(row.log, 0.699999988)
        assert.equal(row.value, value)
        assert.equal(row.changed, changed, 'принятое ' + value)
    }
})

test('summary_rows: маска HMNCS 8 бит — лог −128 и принятое 128 одно; в .param — со знаком; при 32 битах — как есть', () => {
    const steps = []
    steps[2] = { accepted: accepted_values(STEP2_NAMES, { ...BASE_LOG, INS_HNTCH_HMNCS: -128 }, { INS_HNTCH_HMNCS: 128 }) }
    const same = row_of(summary_rows(rows_ctx({ log: { ...BASE_LOG, INS_HNTCH_HMNCS: -128 }, steps: steps })), 'INS_HNTCH_HMNCS')
    assert.equal(same.changed, false)

    // Изменённая 8-битная маска с гармоникой 8 пишется со знаком, как её хранит прошивка
    const changed = summary_rows(rows_ctx({ log: { ...BASE_LOG, INS_HNTCH_HMNCS: 1 }, steps: steps }))
    assert.equal(row_of(changed, 'INS_HNTCH_HMNCS').changed, true)
    assert.equal(row_of(changed, 'INS_HNTCH_HMNCS').value, 128)
    assert.deepEqual(summary_param_values(changed.rows, 8), { INS_HNTCH_HMNCS: -128 })

    // 32 бита: сравнение и запись как есть
    const wide = summary_rows(rows_ctx({ log: { ...BASE_LOG, INS_HNTCH_HMNCS: -128 }, steps: steps, bits: 32 }))
    assert.equal(row_of(wide, 'INS_HNTCH_HMNCS').changed, true)
    assert.deepEqual(summary_param_values(wide.rows, 32), { INS_HNTCH_HMNCS: 128 })
})

test('summary_rows: ESCMSK при версии фильтра ниже 4 — строки нет, с версии 4 — есть', () => {
    const log = { ...BASE_LOG, INS_HNTCH_ESCMSK: 15 }
    const steps = []
    steps[2] = { accepted: accepted_values(STEP2_NAMES, log, { INS_HNTCH_ESCMSK: 0 }) }
    const old = summary_rows(rows_ctx({ log: log, steps: steps, filter_version: 2 }))
    assert.deepEqual(old.rows.filter((r) => r.name.endsWith('_ESCMSK')), [])
    assert.equal(old.rows.length, STEP2_NAMES.length - 2)

    steps[2] = { accepted: accepted_values(STEP2_NAMES, log) }
    const v4 = summary_rows(rows_ctx({ log: log, steps: steps, filter_version: 4 }))
    assert.deepEqual(v4.rows.filter((r) => r.name.endsWith('_ESCMSK')).map((r) => r.name), ['INS_HNTCH_ESCMSK', 'INS_HNTC2_ESCMSK'])
    assert.equal(row_of(v4, 'INS_HNTCH_ESCMSK').changed, false)
})

test('summary_rows: включаемый второй notch — все поля INS_HNTC2_* изменены, у отсутствующих в логе log = null', () => {
    const steps = []
    steps[2] = { accepted: accepted_values(STEP2_NAMES, BASE_LOG, { INS_HNTC2_ENABLE: 1, INS_HNTC2_FREQ: 153 }) }
    const result = summary_rows(rows_ctx({ steps: steps }))
    const notch2 = result.rows.filter((r) => r.name.startsWith('INS_HNTC2_'))
    // Версия фильтра 2: ESCMSK не пишется
    assert.deepEqual(notch2.map((r) => r.name), Object.values(notch_param_names()[1]).filter((name) => !name.endsWith('_ESCMSK')))
    for (const row of notch2) {
        assert.equal(row.changed, true, row.name)
        assert.equal(row.note, null, row.name)
        assert.equal(row.log, (row.name === 'INS_HNTC2_ENABLE') ? 0 : null, row.name)
    }
    assert.equal(row_of(result, 'INS_HNTC2_FREQ').value, 153)
    // Первый notch не трогали
    assert.deepEqual(result.rows.filter((r) => r.changed).map((r) => r.name), notch2.map((r) => r.name))
    // ENABLE нет в логе вовсе — тоже включение
    const no_enable = { ...BASE_LOG }
    delete no_enable.INS_HNTC2_ENABLE
    const absent = summary_rows(rows_ctx({ log: no_enable, steps: steps }))
    assert.deepEqual(absent.rows.filter((r) => r.name.startsWith('INS_HNTC2_')).map((r) => [r.changed, r.log]),
        notch2.map(() => [true, null]))
    // С версии 4 включается и ESCMSK
    const v4 = summary_rows(rows_ctx({ steps: steps, filter_version: 4 }))
    assert.equal(row_of(v4, 'INS_HNTC2_ESCMSK').changed, true)
    assert.equal(row_of(v4, 'INS_HNTC2_ESCMSK').log, null)
})

test('summary_rows: notch остаётся выключенным — поля без лога не изменены и не пишутся', () => {
    const steps = []
    steps[2] = { accepted: accepted_values(STEP2_NAMES, BASE_LOG, { INS_HNTC2_FREQ: 153 }) }
    const result = summary_rows(rows_ctx({ steps: steps }))
    assert.deepEqual(row_of(result, 'INS_HNTC2_ENABLE'),
        { name: 'INS_HNTC2_ENABLE', log: 0, value: 0, step: 2, changed: false, note: null })
    assert.deepEqual(row_of(result, 'INS_HNTC2_FREQ'),
        { name: 'INS_HNTC2_FREQ', log: null, value: 153, step: 2, changed: false, note: 'нет в логе — не пишется' })
    assert.equal(result.rows.some((r) => r.changed), false)
    assert.equal(summary_param_text(result.rows, 8), null)
})

test('summary_rows: INS_GYRO_FILTER шагов 2 и 3 — одна строка от шага 3, расхождение в conflicts', () => {
    const steps = []
    steps[2] = { accepted: accepted_values(STEP2_NAMES, BASE_LOG, { INS_GYRO_FILTER: 40 }) }
    steps[3] = { accepted: accepted_values(STEP3_NAMES, BASE_LOG, { INS_GYRO_FILTER: 45 }) }
    const result = summary_rows(rows_ctx({ steps: steps }))
    const gyro = result.rows.filter((r) => r.name === 'INS_GYRO_FILTER')
    assert.deepEqual(gyro, [{ name: 'INS_GYRO_FILTER', log: 40, value: 45, step: 3, changed: true, note: null }])
    assert.deepEqual(result.conflicts, [{ name: 'INS_GYRO_FILTER', values: { 2: 40, 3: 45 }, used: 3 }])
    // Строка стоит среди строк шага 3: шаг 2 без INS_GYRO_FILTER, затем шаг 3 по порядку его имён
    assert.deepEqual(result.rows.map((r) => r.name), [...STEP2_NAMES.slice(1).filter((n) => !n.endsWith('_ESCMSK')), ...STEP3_NAMES])
})

test('summary_rows: одинаковый INS_GYRO_FILTER шагов 2 и 3 (как float32) — расхождения нет', () => {
    const log = { ...BASE_LOG, INS_GYRO_FILTER: 37.5 }
    const steps = []
    steps[2] = { accepted: accepted_values(STEP2_NAMES, log, { INS_GYRO_FILTER: Math.fround(40.7) }) }
    steps[3] = { accepted: accepted_values(STEP3_NAMES, log, { INS_GYRO_FILTER: 40.7 }) }
    const result = summary_rows(rows_ctx({ log: log, steps: steps }))
    assert.deepEqual(result.conflicts, [])
    assert.equal(row_of(result, 'INS_GYRO_FILTER').step, 3)
    assert.equal(row_of(result, 'INS_GYRO_FILTER').value, 40.7)
})

test('summary_rows: принят только шаг 2 — INS_GYRO_FILTER от шага 2', () => {
    const steps = []
    steps[2] = { accepted: accepted_values(STEP2_NAMES, BASE_LOG, { INS_GYRO_FILTER: 50 }) }
    const result = summary_rows(rows_ctx({ steps: steps }))
    assert.deepEqual(row_of(result, 'INS_GYRO_FILTER'), { name: 'INS_GYRO_FILTER', log: 40, value: 50, step: 2, changed: true, note: null })
    assert.deepEqual(result.conflicts, [])
})

test('summary_rows: ненадёжная ось шага 4 — ручная правка с пометкой, значения лога не изменены и без пометки', () => {
    const steps = []
    steps[4] = { accepted: accepted_values(STEP4_NAMES, BASE_LOG, { ATC_RAT_RLL_P: 0.15, ATC_RAT_YAW_P: 0.2 }),
                 axes: step4_axes({ roll: false, pitch: false }) }
    const result = summary_rows(rows_ctx({ steps: steps }))
    assert.deepEqual(row_of(result, 'ATC_RAT_RLL_P'),
        { name: 'ATC_RAT_RLL_P', log: Math.fround(0.135), value: 0.15, step: 4, changed: true, note: 'ось ненадёжна — значение введено вручную' })
    // Тангаж ненадёжен, но значения лога: не изменён и без пометки
    for (const name of ['ATC_RAT_PIT_P', 'ATC_RAT_PIT_I', 'ATC_RAT_PIT_D']) {
        assert.equal(row_of(result, name).changed, false, name)
        assert.equal(row_of(result, name).note, null, name)
    }
    // Надёжное рыскание с правкой — без пометки
    assert.equal(row_of(result, 'ATC_RAT_YAW_P').changed, true)
    assert.equal(row_of(result, 'ATC_RAT_YAW_P').note, null)
})

// ---------------------------------------------------------------- .param

test('summary_param_text: только изменённые, натуральный порядок имён; без изменений — null', () => {
    const steps = []
    steps[2] = { accepted: accepted_values(STEP2_NAMES, BASE_LOG, { INS_HNTCH_FREQ: 75, INS_HNTCH_FM_RAT: 0.7 }) }
    steps[3] = { accepted: accepted_values(STEP3_NAMES, BASE_LOG, { ATC_RAT_RLL_FLTD: 25, INS_ACCEL_FILTER: 10 }) }
    steps[4] = { accepted: accepted_values(STEP4_NAMES, BASE_LOG, { ATC_RAT_PIT_D: 0.004 }), axes: step4_axes() }
    const result = summary_rows(rows_ctx({ steps: steps }))
    assert.equal(summary_param_text(result.rows, 8),
        'ATC_RAT_PIT_D,0.004\nATC_RAT_RLL_FLTD,25\nINS_ACCEL_FILTER,10\nINS_HNTCH_FM_RAT,0.7\nINS_HNTCH_FREQ,75\n')
    assert.deepEqual(Object.keys(summary_param_values(result.rows, 8)).sort(),
        ['ATC_RAT_PIT_D', 'ATC_RAT_RLL_FLTD', 'INS_ACCEL_FILTER', 'INS_HNTCH_FM_RAT', 'INS_HNTCH_FREQ'])

    steps[2] = { accepted: accepted_values(STEP2_NAMES, BASE_LOG) }
    steps[3] = { accepted: accepted_values(STEP3_NAMES, BASE_LOG) }
    steps[4] = { accepted: accepted_values(STEP4_NAMES, BASE_LOG), axes: step4_axes() }
    const unchanged = summary_rows(rows_ctx({ steps: steps }))
    assert.deepEqual(summary_param_values(unchanged.rows, 8), {})
    assert.equal(summary_param_text(unchanged.rows, 8), null)
    assert.equal(summary_param_text([], 8), null)
})

test('summary_file_name: имя лога без последнего расширения + _tune.param', () => {
    assert.equal(summary_file_name('a.b.bin'), 'a.b_tune.param')
    assert.equal(summary_file_name('2026-06-18 18-54-42_anon.bin'), '2026-06-18 18-54-42_anon_tune.param')
    assert.equal(summary_file_name('log'), 'log_tune.param')
    assert.equal(summary_file_name(null), 'tune.param')
})

// ---------------------------------------------------------------- отпечаток входов

// Состояние для отпечатка: интервал, ключ FFT шага 1, принятые шаги 2 и 3
function inputs_ctx() {
    const steps = []
    steps[2] = { accepted: { INS_HNTCH_FREQ: 80, INS_GYRO_FILTER: 40 } }
    steps[3] = { accepted: { INS_GYRO_FILTER: 45, INS_ACCEL_FILTER: 10 } }
    return { start: 10, end: 100, fft_key: 'batch:16', steps: steps }
}

test('summary_inputs_key: JSON [начало, конец, ключ FFT, принятое шагов 2..n−1 с именами по алфавиту]', () => {
    const ctx = inputs_ctx()
    assert.deepEqual(JSON.parse(summary_inputs_key(2, ctx)), [10, 100, 'batch:16', []])
    assert.deepEqual(JSON.parse(summary_inputs_key(3, ctx)),
        [10, 100, 'batch:16', [[['INS_GYRO_FILTER', 40], ['INS_HNTCH_FREQ', 80]]]])
    // Шаг 4: ключа FFT нет; непринятый шаг — null
    ctx.steps[2] = null
    assert.deepEqual(JSON.parse(summary_inputs_key(4, ctx)),
        [10, 100, null, [null, [['INS_ACCEL_FILTER', 10], ['INS_GYRO_FILTER', 45]]]])
    // Порядок имён в принятом не важен
    const swapped = inputs_ctx()
    swapped.steps[2] = { accepted: { INS_GYRO_FILTER: 40, INS_HNTCH_FREQ: 80 } }
    assert.equal(summary_inputs_key(3, swapped), summary_inputs_key(3, inputs_ctx()))
})

test('summary_stale: принятое с отпечатком текущего состояния — не устарело; смена принятого шага 2, интервала или FFT — устарело', () => {
    const fresh = () => {
        const ctx = inputs_ctx()
        ctx.steps[3].inputs = summary_inputs_key(3, ctx)
        return ctx
    }
    assert.equal(summary_stale(3, fresh()), false)

    const accepted2 = fresh()
    accepted2.steps[2] = { accepted: { INS_HNTCH_FREQ: 75, INS_GYRO_FILTER: 40 } }
    assert.equal(summary_stale(3, accepted2), true)

    const start = fresh()
    start.start = 12
    assert.equal(summary_stale(3, start), true)

    const end = fresh()
    end.end = 90
    assert.equal(summary_stale(3, end), true)

    const fft = fresh()
    fft.fft_key = 'raw:1024'
    assert.equal(summary_stale(3, fft), true)

    // Шаг 2 приняли позже шага 3 — шаг 3 считал от лога: устарело
    const late = inputs_ctx()
    late.steps[2] = null
    late.steps[3].inputs = summary_inputs_key(3, late)
    late.steps[2] = inputs_ctx().steps[2]
    assert.equal(summary_stale(3, late), true)
})

test('summary_stale: непринятый шаг — не устарел; принятое без отпечатка — устарело', () => {
    const ctx = inputs_ctx()
    assert.equal(summary_stale(4, ctx), false)
    assert.equal(summary_stale(3, ctx), true)
})

test('summary_inputs_key: у шага 2 не зависит от шага 3, у шага 4 — от ключа FFT', () => {
    const ctx = inputs_ctx()
    const key2 = summary_inputs_key(2, ctx)
    ctx.steps[3] = { accepted: { INS_GYRO_FILTER: 50, INS_ACCEL_FILTER: 15 } }
    assert.equal(summary_inputs_key(2, ctx), key2)
    ctx.steps[3] = null
    assert.equal(summary_inputs_key(2, ctx), key2)

    const step4 = inputs_ctx()
    step4.steps[4] = { accepted: {} }
    step4.steps[4].inputs = summary_inputs_key(4, step4)
    step4.fft_key = null
    assert.equal(summary_stale(4, step4), false)
    step4.fft_key = 'raw:2048'
    assert.equal(summary_stale(4, step4), false)
    // А принятое шага 3 — входит
    step4.steps[3] = { accepted: { INS_GYRO_FILTER: 50, INS_ACCEL_FILTER: 10 } }
    assert.equal(summary_stale(4, step4), true)
})
