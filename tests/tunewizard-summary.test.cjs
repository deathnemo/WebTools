// Тесты итога прохода мастера настройки (TuneWizard/core/summary.js): сравнение значений как float32 и масок,
// строки итога по принятым шагам 2–4 (порядок источников и расхождение INS_GYRO_FILTER, ESCMSK по версии фильтра,
// включаемый notch, параметры без лога, ненадёжные оси шага 4), значения и текст .param из изменённых, имя
// файла, отпечаток входов принятого шага (по действующим отличиям от лога, у шага 4 — только по его фильтрам) и
// «устарело», «что перелететь» (проверки шага 0 с fix продолжением фразы, включаемый notch, перезагрузка, тестовый
// полёт, повтор) и имена с перезагрузкой по метаданным.
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

// Нужное итогу и тестам в порядке страницы: param_file_text (Param_Helpers.js, params.js), notch_param_names
// (filters.js), lowpass_param_names (lowpass.js; ему при загрузке нужен candidate_rules из candidates.js),
// pidtune_axes (pidtune.js; ему — константы core/pid.js)
load_page_scripts([
    'Libraries/Param_Helpers.js',
    'TuneWizard/core/filters.js',
    'TuneWizard/core/candidates.js',
    'TuneWizard/core/lowpass.js',
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

// Имена шагов — как их собирает страница: step2_param_names() (steps/step2.js — под Node не грузится, тот же
// состав), lowpass_param_names(params) — для BASE_LOG пределы ATC_ACC_*_MAX, step4_param_names() (тот же состав)
const STEP2_NAMES = ['INS_GYRO_FILTER', 'SCHED_LOOP_RATE', ...notch_param_names().flatMap((n) => Object.values(n))]
const STEP3_NAMES = lowpass_param_names(fake_params(BASE_LOG))
const STEP4_NAMES = Object.values(pidtune_axes).flatMap((axis) => ['P', 'I', 'D'].map((k) => axis.rate + k))
const NAMES = { 2: STEP2_NAMES, 3: STEP3_NAMES, 4: STEP4_NAMES }
// Имена, от которых зависит шаг 4, — как их собирает страница (step_depends4_names в steps/common.js; состав проверяет
// tests/tunewizard-common.test.cjs): поля notch, INS_GYRO_FILTER, FLTE и FLTD осей
const DEPENDS4 = [...notch_param_names().flatMap((n) => Object.values(n)), 'INS_GYRO_FILTER',
    ...Object.values(pidtune_axes).flatMap((axis) => [axis.rate + 'FLTE', axis.rate + 'FLTD'])]

// Принятое шага: по всем именам шага — значение из changes, иначе из лога, иначе 0. Упрощение: форма шага 2
// для отсутствующих в логе полей берёт умолчания (values_from_log), а не 0 — итогу это не важно
function accepted_values(names, log, changes = {}) {
    return Object.fromEntries(names.map((name) => [name, (name in changes) ? changes[name] : ((name in log) ? log[name] : 0)]))
}

// Метрики осей шага 4: reliable по осям (по умолчанию все надёжны)
function step4_axes(reliable = {}) {
    return Object.fromEntries(Object.keys(pidtune_axes).map((axis) => [axis, { candidate_id: 'custom', flags: null,
        metrics: { reliable: reliable[axis] ?? true } }]))
}

// Вход summary_rows: лог (целиком заменяет BASE_LOG), принятые шаги, версия фильтра и размер маски HMNCS
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

// ---------------------------------------------------------------- summary_notch_enabling

test('summary_notch_enabling: ENABLE в логе нет или ≤ 0, а принято > 0', () => {
    assert.equal(summary_notch_enabling(null, 1), true)
    assert.equal(summary_notch_enabling(0, 1), true)
    assert.equal(summary_notch_enabling(-1, 2), true)
    assert.equal(summary_notch_enabling(0, 0), false)
    assert.equal(summary_notch_enabling(null, 0), false)
    assert.equal(summary_notch_enabling(1, 1), false)
    assert.equal(summary_notch_enabling(1, 0), false)
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
    assert.equal(summary_param_text(changed.rows, 8), 'INS_HNTCH_HMNCS,-128\n')

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

    // Версия фильтра неизвестна — как ниже 4 (защитное правило, как step2_save_param)
    const unknown = summary_rows({ ...rows_ctx({ log: log, steps: steps }), filter_version: undefined })
    assert.deepEqual(unknown.rows.filter((r) => r.name.endsWith('_ESCMSK')), [])
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

test('summary_rows: поле включаемого notch, совпавшее с логом, всё равно изменено', () => {
    const log = { ...BASE_LOG, INS_HNTC2_FREQ: 80 }
    const steps = []
    steps[2] = { accepted: accepted_values(STEP2_NAMES, log, { INS_HNTC2_ENABLE: 1 }) }
    const result = summary_rows(rows_ctx({ log: log, steps: steps }))
    assert.deepEqual(row_of(result, 'INS_HNTC2_FREQ'),
        { name: 'INS_HNTC2_FREQ', log: 80, value: 80, step: 2, changed: true, note: null })
    assert.equal(summary_param_values(result.rows, 8).INS_HNTC2_FREQ, 80)
})

test('summary_rows: выключение notch — меняется только ENABLE, прочие поля сравниваются как обычно', () => {
    const steps = []
    steps[2] = { accepted: accepted_values(STEP2_NAMES, BASE_LOG, { INS_HNTCH_ENABLE: 0, INS_HNTCH_FREQ: 75 }) }
    const result = summary_rows(rows_ctx({ steps: steps }))
    assert.deepEqual(result.rows.filter((r) => r.changed).map((r) => r.name), ['INS_HNTCH_ENABLE', 'INS_HNTCH_FREQ'])
    assert.equal(row_of(result, 'INS_HNTCH_BW').changed, false)
    assert.equal(row_of(result, 'INS_HNTCH_BW').note, null)
})

test('summary_rows: включение первого notch — все поля INS_HNTCH_* изменены', () => {
    // В логе первый notch выключен: из его полей есть только ENABLE
    const log = Object.fromEntries(Object.entries(BASE_LOG).filter(([name]) => !name.startsWith('INS_HNTCH_')))
    log.INS_HNTCH_ENABLE = 0
    const steps = []
    steps[2] = { accepted: accepted_values(STEP2_NAMES, log, { INS_HNTCH_ENABLE: 1, INS_HNTCH_FREQ: 80 }) }
    const result = summary_rows(rows_ctx({ log: log, steps: steps }))
    const notch1 = result.rows.filter((r) => r.name.startsWith('INS_HNTCH_'))
    assert.deepEqual(notch1.map((r) => r.name), Object.values(notch_param_names()[0]).filter((name) => !name.endsWith('_ESCMSK')))
    for (const row of notch1) {
        assert.equal(row.changed, true, row.name)
        assert.equal(row.log, (row.name === 'INS_HNTCH_ENABLE') ? 0 : null, row.name)
    }
    // Второй notch остаётся выключенным: его поля без лога не пишутся
    assert.deepEqual(result.rows.filter((r) => r.changed).map((r) => r.name), notch1.map((r) => r.name))
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

test('summary_rows: шаг 4 без axes или с metrics null — правка без пометки', () => {
    const accepted = accepted_values(STEP4_NAMES, BASE_LOG, { ATC_RAT_RLL_P: 0.15 })
    const no_metrics = step4_axes()
    no_metrics.roll.metrics = null
    for (const step4 of [{ accepted: accepted }, { accepted: accepted, axes: no_metrics }]) {
        const steps = []
        steps[4] = step4
        const row = row_of(summary_rows(rows_ctx({ steps: steps })), 'ATC_RAT_RLL_P')
        assert.equal(row.changed, true)
        assert.equal(row.note, null)
    }
})

// ---------------------------------------------------------------- .param

test('summary_param_text: только изменённые, текст — param_file_text их значений; без изменений — null', () => {
    const steps = []
    steps[2] = { accepted: accepted_values(STEP2_NAMES, BASE_LOG, { INS_HNTCH_FREQ: 75, INS_HNTCH_FM_RAT: 0.7 }) }
    steps[3] = { accepted: accepted_values(STEP3_NAMES, BASE_LOG, { ATC_RAT_RLL_FLTD: 25, INS_ACCEL_FILTER: 10 }) }
    steps[4] = { accepted: accepted_values(STEP4_NAMES, BASE_LOG, { ATC_RAT_PIT_D: 0.004 }), axes: step4_axes() }
    const result = summary_rows(rows_ctx({ steps: steps }))
    assert.equal(summary_param_text(result.rows, 8),
        'ATC_RAT_PIT_D,0.004\nATC_RAT_RLL_FLTD,25\nINS_ACCEL_FILTER,10\nINS_HNTCH_FM_RAT,0.7\nINS_HNTCH_FREQ,75\n')
    assert.equal(summary_param_text(result.rows, 8), param_file_text(summary_param_values(result.rows, 8)))
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
    assert.equal(summary_file_name(''), 'tune.param')
})

// ---------------------------------------------------------------- отпечаток входов

// Вход отпечатка: вход итога (лог log — по умолчанию BASE_LOG, версия фильтра 4, маска HMNCS 8 бит) плюс интервал и
// ключ FFT шага 1; steps — принятые шаги
function inputs_ctx(steps = [], log = BASE_LOG) {
    return { ...rows_ctx({ log: log, steps: steps, filter_version: 4 }), start: 10, end: 100, fft_key: 'batch:16' }
}

// Принятое шагов 2–4 с отличиями от лога: FREQ первого notch; INS_GYRO_FILTER и FLTD крена; P крена
function accepted_steps() {
    const steps = []
    steps[2] = { accepted: accepted_values(STEP2_NAMES, BASE_LOG, { INS_HNTCH_FREQ: 75 }) }
    steps[3] = { accepted: accepted_values(STEP3_NAMES, BASE_LOG, { INS_GYRO_FILTER: 45, ATC_RAT_RLL_FLTD: 25 }) }
    steps[4] = { accepted: accepted_values(STEP4_NAMES, BASE_LOG, { ATC_RAT_RLL_P: 0.125 }), axes: step4_axes() }
    return steps
}

// Шаги 2–4 приняты по порядку, у каждого — отпечаток на момент его «Принять»
function inputs_ctx_accepted() {
    const all = accepted_steps()
    const ctx = inputs_ctx()
    for (const n of [2, 3, 4]) {
        ctx.steps[n] = { ...all[n], inputs: summary_inputs_key(n, ctx) }
    }
    return ctx
}

test('summary_inputs_key: JSON [начало, конец, ключ FFT, версия фильтра, отличия от лога шагов 2..n−1 — пары [имя, значение] по алфавиту]', () => {
    const ctx = inputs_ctx(accepted_steps())
    assert.deepEqual(JSON.parse(summary_inputs_key(2, ctx)), [10, 100, 'batch:16', 4, []])
    assert.deepEqual(JSON.parse(summary_inputs_key(3, ctx)), [10, 100, 'batch:16', 4, [['INS_HNTCH_FREQ', 75]]])
    // Шаг 4: ключа FFT и версии фильтра нет; отличия шагов 2 и 3 — одним списком по алфавиту
    assert.deepEqual(JSON.parse(summary_inputs_key(4, ctx)),
        [10, 100, null, null, [['ATC_RAT_RLL_FLTD', 25], ['INS_GYRO_FILTER', 45], ['INS_HNTCH_FREQ', 75]]])
    // Порядок имён в принятом не важен
    const swapped = inputs_ctx(accepted_steps())
    swapped.steps[3] = { accepted: Object.fromEntries(Object.entries(swapped.steps[3].accepted).reverse()) }
    assert.equal(summary_inputs_key(4, swapped), summary_inputs_key(4, ctx))
})

test('summary_inputs_key: нет интервала, ключа FFT или версии фильтра (undefined) — null', () => {
    assert.deepEqual(JSON.parse(summary_inputs_key(2, { steps: [] })), [null, null, null, null, []])
    assert.deepEqual(JSON.parse(summary_inputs_key(4, { steps: [] })), [null, null, null, null, []])
})

test('summary_inputs_key: шаг 3 не принят и принят «Как в логе» — один ключ шага 4; принят с отличием — шаг 4 устарел', () => {
    // В логе нет INS_ACCEL_FILTER: форма шага 3 из лога берёт для него заводское значение (lowpass_log_values)
    const log = { ...BASE_LOG }
    delete log.INS_ACCEL_FILTER
    const all = accepted_steps()
    const ctx = inputs_ctx([], log)
    ctx.steps[2] = all[2]
    // Шаг 4 принят раньше шага 3
    ctx.steps[4] = { ...all[4], inputs: summary_inputs_key(4, ctx) }
    ctx.steps[3] = { accepted: lowpass_log_values(ctx.params) }
    assert.equal(ctx.steps[3].accepted.INS_ACCEL_FILTER, lowpass_rules.defaults.accel_hz, 'чего нет в логе — заводское')
    assert.equal(summary_inputs_key(4, ctx), ctx.steps[4].inputs, 'принят «Как в логе» — тот же ключ, что у непринятого')
    assert.equal(summary_stale(4, ctx), false)
    ctx.steps[3] = { accepted: { ...lowpass_log_values(ctx.params), INS_GYRO_FILTER: 45 } }
    assert.notEqual(summary_inputs_key(4, ctx), ctx.steps[4].inputs)
    assert.equal(summary_stale(4, ctx), true, 'принят с отличием от лога — шаг 4 устарел')
})

test('summary_inputs_key: поля выключенного notch с умолчаниями (в логе их нет) ключ шага 3 не меняют; включённый notch — меняет', () => {
    const ctx = inputs_ctx()
    const not_accepted = summary_inputs_key(3, ctx)
    // Форма шага 2 из лога: полям второго notch, которых в логе нет, — умолчания (values_from_log), ENABLE 0 из лога
    const defaults = { INS_HNTC2_FREQ: 80, INS_HNTC2_BW: 40, INS_HNTC2_ATT: 40, INS_HNTC2_HMNCS: 3, INS_HNTC2_MODE: 1, INS_HNTC2_FM_RAT: 1 }
    ctx.steps[2] = { accepted: accepted_values(STEP2_NAMES, BASE_LOG, defaults) }
    assert.equal(summary_inputs_key(3, ctx), not_accepted, 'принят «Как в логе» — тот же ключ, что у непринятого')
    // Второй notch включается: все его поля — изменения
    ctx.steps[2] = { accepted: accepted_values(STEP2_NAMES, BASE_LOG, { ...defaults, INS_HNTC2_ENABLE: 1 }) }
    const changes = JSON.parse(summary_inputs_key(3, ctx))[4]
    assert.deepEqual(changes.map(([name]) => name), Object.values(notch_param_names()[1]).sort())
    assert.deepEqual(changes.find(([name]) => name === 'INS_HNTC2_FREQ'), ['INS_HNTC2_FREQ', 80])
})

test('summary_inputs_key: INS_GYRO_FILTER шагов 2 и 3 расходится — в ключе шага 4 значение шага 3', () => {
    const ctx = inputs_ctx()
    ctx.steps[2] = { accepted: accepted_values(STEP2_NAMES, BASE_LOG, { INS_GYRO_FILTER: 50 }) }
    ctx.steps[3] = { accepted: accepted_values(STEP3_NAMES, BASE_LOG, { INS_GYRO_FILTER: 45 }) }
    assert.deepEqual(JSON.parse(summary_inputs_key(3, ctx))[4], [['INS_GYRO_FILTER', 50]])
    assert.deepEqual(JSON.parse(summary_inputs_key(4, ctx))[4], [['INS_GYRO_FILTER', 45]])
    // Шаг 3 вернул значение лога — действует оно: отличий нет
    ctx.steps[3] = { accepted: accepted_values(STEP3_NAMES, BASE_LOG) }
    assert.deepEqual(JSON.parse(summary_inputs_key(4, ctx))[4], [])
})

test('summary_stale: принятое с отпечатком текущего состояния — не устарело; смена отличий шага 2, интервала или FFT — устарело', () => {
    const fresh = inputs_ctx_accepted
    for (const n of [2, 3, 4]) {
        assert.equal(summary_stale(n, fresh()), false, 'шаг ' + n)
    }

    const accepted2 = fresh()
    accepted2.steps[2] = { ...accepted2.steps[2], accepted: accepted_values(STEP2_NAMES, BASE_LOG, { INS_HNTCH_FREQ: 70 }) }
    assert.equal(summary_stale(3, accepted2), true)
    assert.equal(summary_stale(4, accepted2), true)

    const start = fresh()
    start.start = 12
    assert.equal(summary_stale(3, start), true)

    const end = fresh()
    end.end = 90
    assert.equal(summary_stale(3, end), true)

    const fft = fresh()
    fft.fft_key = 'raw:1024'
    assert.equal(summary_stale(3, fft), true)

    // Шаг 2 (с отличием от лога) приняли позже шага 3 — шаг 3 считал от лога: устарело
    const late = fresh()
    const step2 = late.steps[2]
    late.steps[2] = null
    late.steps[3].inputs = summary_inputs_key(3, late)
    late.steps[2] = step2
    assert.equal(summary_stale(3, late), true)
})

test('summary_stale: смена версии фильтра — шаги 2 и 3 устарели, шаг 4 — нет', () => {
    // Шаги 2–4 приняты при версии 4, затем на шаге 1 поставили 3 (форма шага 2 писала бы ESCMSK 0) — шаги 2 и 3
    // устарели, шаг 4 — нет (ESCMSK в логе нет, маска HMNCS — те же 8 бит: отличия шагов 2–3 те же); вернули 4 — шаг 2
    // снова не устарел
    const ctx = inputs_ctx_accepted()
    ctx.filter_version = 3
    assert.equal(summary_stale(2, ctx), true)
    assert.equal(summary_stale(3, ctx), true)
    assert.equal(summary_stale(4, ctx), false)
    ctx.filter_version = 4
    assert.equal(summary_stale(2, ctx), false)
})

test('summary_stale: непринятый шаг — не устарел; принятое без отпечатка — устарело', () => {
    const ctx = inputs_ctx(accepted_steps())
    ctx.steps[4] = null
    assert.equal(summary_stale(4, ctx), false)
    assert.equal(summary_stale(3, ctx), true)
})

test('summary_inputs_key: у шага 2 не зависит от шага 3, у шага 4 — от ключа FFT', () => {
    const ctx = inputs_ctx(accepted_steps())
    const key2 = summary_inputs_key(2, ctx)
    ctx.steps[3] = { accepted: accepted_values(STEP3_NAMES, BASE_LOG, { INS_GYRO_FILTER: 50 }) }
    assert.equal(summary_inputs_key(2, ctx), key2)
    ctx.steps[3] = null
    assert.equal(summary_inputs_key(2, ctx), key2)

    const step4 = inputs_ctx_accepted()
    step4.fft_key = null
    assert.equal(summary_stale(4, step4), false)
    step4.fft_key = 'raw:2048'
    assert.equal(summary_stale(4, step4), false)
    // А отличия шага 3 — входят
    step4.steps[3] = { ...step4.steps[3], accepted: accepted_values(STEP3_NAMES, BASE_LOG, { INS_GYRO_FILTER: 50 }) }
    assert.equal(summary_stale(4, step4), true)
})

test('summary_inputs_key: depends[n] — в изменения шага n только эти имена; у шагов без списка — все изменения', () => {
    const ctx = { ...inputs_ctx(accepted_steps()), depends: { 4: ['INS_HNTCH_FREQ'] } }
    assert.deepEqual(JSON.parse(summary_inputs_key(4, ctx))[4], [['INS_HNTCH_FREQ', 75]])
    // Список шага 4 ключ шага 3 не трогает
    assert.equal(summary_inputs_key(3, ctx), summary_inputs_key(3, inputs_ctx(accepted_steps())))
    // Пустой список — изменений нет; списка нет (undefined, null, нет у шага) — все
    assert.deepEqual(JSON.parse(summary_inputs_key(4, { ...ctx, depends: { 4: [] } }))[4], [])
    for (const depends of [undefined, null, {}]) {
        assert.equal(summary_inputs_key(4, { ...ctx, depends: depends }), summary_inputs_key(4, inputs_ctx(accepted_steps())), JSON.stringify(depends))
    }
})

test('summary_stale: шаг 4 со списком фильтров — новое «Принять» шага 3 с другими пределами ускорения, FLTT и INS_ACCEL_FILTER его не делает устаревшим, с другим FLTD — делает; SCHED_LOOP_RATE шага 2 — тоже нет', () => {
    // Шаги 2–4 приняты по порядку при том же списке, что даёт страница
    const all = accepted_steps()
    const ctx = { ...inputs_ctx(), depends: { 4: DEPENDS4 } }
    for (const n of [2, 3, 4]) {
        ctx.steps[n] = { ...all[n], inputs: summary_inputs_key(n, ctx) }
    }
    assert.deepEqual([2, 3, 4].map((n) => summary_stale(n, ctx)), [false, false, false])

    // Шаг 3 принят заново: пределы ускорения (имена лога), FLTT всех осей и INS_ACCEL_FILTER другие
    const accel = STEP3_NAMES.filter((name) => name.startsWith('ATC_ACC'))
    assert.equal(accel.length, 3, 'пределы ускорения трёх осей: ' + accel.join(', '))
    const unrelated = { INS_ACCEL_FILTER: 15, ATC_RAT_RLL_FLTT: 30, ATC_RAT_PIT_FLTT: 30, ATC_RAT_YAW_FLTT: 5,
                        ...Object.fromEntries(accel.map((name) => [name, BASE_LOG[name] / 2])) }
    ctx.steps[3] = { accepted: { ...ctx.steps[3].accepted, ...unrelated } }
    ctx.steps[3].inputs = summary_inputs_key(3, ctx)
    assert.equal(summary_rows(ctx).rows.filter((row) => (row.name in unrelated) && row.changed).length, Object.keys(unrelated).length,
        'в итоге они изменены')
    assert.equal(summary_stale(4, ctx), false, 'прогноз шага 4 от них не зависит — не устарел')
    assert.deepEqual(JSON.parse(summary_inputs_key(4, ctx))[4], [['ATC_RAT_RLL_FLTD', 25], ['INS_GYRO_FILTER', 45], ['INS_HNTCH_FREQ', 75]])
    // Без списка те же изменения сделали бы шаг 4 устаревшим
    assert.equal(summary_stale(4, { ...ctx, depends: undefined }), true)

    // Другой FLTD тангажа — регулятор вариантов шага 4 другой: устарел
    ctx.steps[3] = { ...ctx.steps[3], accepted: { ...ctx.steps[3].accepted, ATC_RAT_PIT_FLTD: 30 } }
    assert.equal(summary_stale(4, ctx), true, 'другой FLTD — шаг 4 устарел')
    ctx.steps[3] = { ...ctx.steps[3], accepted: { ...ctx.steps[3].accepted, ATC_RAT_PIT_FLTD: BASE_LOG.ATC_RAT_PIT_FLTD } }
    assert.equal(summary_stale(4, ctx), false, 'FLTD вернули — снова не устарел')

    // Шаг 2 принят заново с другим SCHED_LOOP_RATE: шаг 3 устарел (у него списка нет), шаг 4 — нет: модель регулятора
    // считается на частоте контура лога
    ctx.steps[2] = { ...ctx.steps[2], accepted: { ...ctx.steps[2].accepted, SCHED_LOOP_RATE: 800 } }
    ctx.steps[2].inputs = summary_inputs_key(2, ctx)
    assert.deepEqual([2, 3, 4].map((n) => summary_stale(n, ctx)), [false, true, false])
})

// ---------------------------------------------------------------- что перелететь

// Подсказка о включаемом втором notch при INS_HNTC2_ENABLE = 0 в логе — дословно текст step2_second_notch_hint
// до выноса в ядро (steps/step2.js)
const HNTC2_ENABLE_HINT = 'В логе INS_HNTC2_ENABLE = 0: на аппарате сначала запишите INS_HNTC2_ENABLE = 1 ' +
    'и обновите список параметров — остальные INS_HNTC2_* появятся только после этого, затем загрузите файл ещё раз.'

// Совет тестового полёта — подставной (страница передаёт step4_test_flight_short, он без точки и с двоеточием)
const TEST_FLIGHT = 'нужен тестовый полёт: Acro'

// Вход summary_refly: строки итога — summary_rows по принятым шагам
function refly_ctx({ checks = [], steps = [], log = BASE_LOG, filter_version = 2, reboot_names = [], unreliable_axes = [] } = {}) {
    return { checks: checks, rows: summary_rows(rows_ctx({ log: log, steps: steps, filter_version: filter_version })).rows,
             reboot_names: reboot_names, unreliable_axes: unreliable_axes, test_flight: TEST_FLIGHT }
}

// Принятый шаг 2: правки changes поверх лога log
function steps_with2(changes, log = BASE_LOG) {
    const steps = []
    steps[2] = { accepted: accepted_values(STEP2_NAMES, log, changes) }
    return steps
}

function sources_of(items) {
    return items.map((item) => item.source)
}

function of_source(items, source) {
    return items.filter((item) => item.source === source)
}

// Имена параметров в тексте пункта — состав пункта без привязки к формулировке
function param_names_in(text) {
    return text.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? []
}

test('summary_period: точка, если фраза не кончается на . ! ?', () => {
    assert.equal(summary_period('Проверьте крепление'), 'Проверьте крепление.')
    assert.equal(summary_period('Проверьте крепление.'), 'Проверьте крепление.')
    assert.equal(summary_period('Готово!'), 'Готово!')
    assert.equal(summary_period('Почему?'), 'Почему?')
})

test('summary_lower_first: обычное слово — со строчной; имена параметров, сокращения и текст не с буквы — как есть', () => {
    assert.equal(summary_lower_first('Включите бит PID'), 'включите бит PID')
    assert.equal(summary_lower_first('Повисите не меньше 30 с'), 'повисите не меньше 30 с')
    assert.equal(summary_lower_first('Batch: INS_LOG_BAT_MASK = 1'), 'batch: INS_LOG_BAT_MASK = 1')
    assert.equal(summary_lower_first('MOT_HOVER_LEARN = 2 (обучение с сохранением)'), 'MOT_HOVER_LEARN = 2 (обучение с сохранением)')
    assert.equal(summary_lower_first('ESC-телеметрия'), 'ESC-телеметрия')
    assert.equal(summary_lower_first('проверьте крепление'), 'проверьте крепление')
    assert.equal(summary_lower_first('2–3 минуты'), '2–3 минуты')
    assert.equal(summary_lower_first('Я'), 'Я')
    assert.equal(summary_lower_first(''), '')
})

test('summary_notch_enable_hint: текст подсказки шага 2 дословно; ENABLE нет в логе — 0; префикс — имя без ENABLE', () => {
    assert.equal(summary_notch_enable_hint('INS_HNTC2_ENABLE', 0), HNTC2_ENABLE_HINT)
    assert.equal(summary_notch_enable_hint('INS_HNTC2_ENABLE', null), HNTC2_ENABLE_HINT)
    assert.equal(summary_notch_enable_hint('INS_HNTCH_ENABLE', -1),
        'В логе INS_HNTCH_ENABLE = -1: на аппарате сначала запишите INS_HNTCH_ENABLE = 1 ' +
        'и обновите список параметров — остальные INS_HNTCH_* появятся только после этого, затем загрузите файл ещё раз.')
})

// Единственное место, где тексты пунктов проверяются целиком; в остальных тестах — состав
test('summary_refly: тексты пунктов — законченные фразы с точкой; порядок — проверки, notch, перезагрузка, тестовый полёт, повтор', () => {
    const checks = [
        { id: 'pid_log', status: 'warn', title: 'Сообщения PID', text: 'PID с частотой 10 Гц',
          fix: 'Включите бит ATTITUDE_FAST в LOG_BITMASK и перелетите: без него Copter пишет PID с частотой 10 Гц' },
        { id: 'vibe', status: 'fail', title: 'Вибрации', text: 'высокие', fix: 'Проверьте крепление автопилота.' },
    ]
    const steps = steps_with2({ SCHED_LOOP_RATE: 800, INS_HNTCH_HMNCS: 7, INS_HNTC2_ENABLE: 1 })
    const ctx = refly_ctx({ checks: checks, steps: steps, reboot_names: ['SCHED_LOOP_RATE', 'INS_HNTCH_HMNCS'],
        unreliable_axes: ['roll', 'pitch'] })
    assert.deepEqual(summary_refly(ctx), [
        { source: 'check', text: 'Сообщения PID — включите бит ATTITUDE_FAST в LOG_BITMASK и перелетите: без него Copter ' +
            'пишет PID с частотой 10 Гц.' },
        { source: 'check', text: 'Вибрации — проверьте крепление автопилота.' },
        { source: 'notch', text: HNTC2_ENABLE_HINT },
        { source: 'reboot', text: 'После записи перезагрузите полётный контроллер — только после перезагрузки действуют: ' +
            'SCHED_LOOP_RATE, INS_HNTCH_HMNCS.' },
        { source: 'test_flight', text: 'Крен, тангаж — нужен тестовый полёт: Acro.' },
        { source: 'repeat', text: 'Слетайте тем же профилем и загрузите лог в мастер: шаг 0 покажет, что применено, ' +
            'шаги 2–4 — сбылся ли прогноз.' },
    ])
    // Метаданные не загрузились — общий пункт перезагрузки
    assert.deepEqual(of_source(summary_refly({ ...ctx, reboot_names: null }), 'reboot'), [{ source: 'reboot',
        text: 'Описания параметров не загрузились, и мастер не знает, какие изменённые параметры требуют ' +
            'перезагрузки: после записи перезагрузите полётный контроллер — так надёжнее.' }])
})

test('summary_refly: ничего не изменено, проверок и ненадёжных осей нет — список пуст; checks null — как пустой', () => {
    assert.deepEqual(summary_refly(refly_ctx()), [])
    assert.deepEqual(summary_refly({ ...refly_ctx(), checks: null }), [])
    // Шаг 2 принят без изменений — тоже пусто
    assert.deepEqual(summary_refly(refly_ctx({ steps: steps_with2({}) })), [])
})

test('summary_refly: проверки warn и fail с fix — по порядку проверок; ok и без fix — нет', () => {
    const checks = [
        { id: 'pid_log', status: 'warn', title: 'Сообщения PID', text: 'PID с частотой 10 Гц', fix: 'Включите бит ATTITUDE_FAST' },
        { id: 'vibe', status: 'ok', title: 'Вибрации', text: 'в норме', fix: 'не показывать' },
        { id: 'clipping', status: 'warn', title: 'Клиппинг', text: 'есть', fix: null },
        { id: 'flight', status: 'warn', title: 'Полёт', text: 'короткий', fix: '' },
        { id: 'tracking', status: 'warn', title: 'Слежение', text: 'нет' },
        { id: 'hover_throttle', status: 'fail', title: 'Газ висения', text: 'высокий', fix: 'Облегчите аппарат' },
    ]
    const items = summary_refly(refly_ctx({ checks: checks }))
    assert.deepEqual(sources_of(items), ['check', 'check'])
    // Какой проверке принадлежит пункт — по её fix в тексте (первая буква обычного слова — строчная)
    assert.deepEqual(items.map((item) => checks.find((c) => (c.fix ?? '') !== '' && item.text.includes(summary_lower_first(c.fix))).id),
        ['pid_log', 'hover_throttle'])
    assert.equal(items[0].text, 'Сообщения PID — включите бит ATTITUDE_FAST.')
    // fix с имени параметра — как есть
    const learn = [{ id: 'hover_throttle', status: 'warn', title: 'Газ висения', text: 'расхождение', fix: 'MOT_HOVER_LEARN = 2 (обучение с сохранением)' }]
    assert.deepEqual(summary_refly(refly_ctx({ checks: learn })).map((item) => item.text), ['Газ висения — MOT_HOVER_LEARN = 2 (обучение с сохранением).'])
})

test('summary_refly: включение второго notch — пункт с подсказкой для INS_HNTC2_ENABLE', () => {
    const steps = steps_with2({ INS_HNTC2_ENABLE: 1, INS_HNTC2_FREQ: 153 })
    const items = summary_refly(refly_ctx({ steps: steps }))
    assert.deepEqual(sources_of(items), ['notch', 'repeat'])
    assert.equal(items[0].text, summary_notch_enable_hint('INS_HNTC2_ENABLE', 0))

    // ENABLE нет в логе вовсе — как 0, тот же текст, что у шага 2
    const no_enable = { ...BASE_LOG }
    delete no_enable.INS_HNTC2_ENABLE
    assert.deepEqual(of_source(summary_refly(refly_ctx({ log: no_enable, steps: steps })), 'notch').map((item) => item.text),
        [summary_notch_enable_hint('INS_HNTC2_ENABLE', 0)])
})

test('summary_refly: notch не включается (остаётся выключенным, уже включён, выключается) — пункта нет', () => {
    for (const changes of [{ INS_HNTC2_FREQ: 153 }, { INS_HNTCH_FREQ: 75 }, { INS_HNTCH_ENABLE: 0 }]) {
        assert.deepEqual(of_source(summary_refly(refly_ctx({ steps: steps_with2(changes) })), 'notch'), [], JSON.stringify(changes))
    }
})

test('summary_refly: включаются оба notch — два пункта по порядку notch', () => {
    const log = Object.fromEntries(Object.entries(BASE_LOG).filter(([name]) => !name.startsWith('INS_HNTCH_')))
    log.INS_HNTCH_ENABLE = 0
    const steps = steps_with2({ INS_HNTCH_ENABLE: 1, INS_HNTC2_ENABLE: 1 }, log)
    assert.deepEqual(of_source(summary_refly(refly_ctx({ log: log, steps: steps })), 'notch').map((item) => item.text),
        [summary_notch_enable_hint('INS_HNTCH_ENABLE', 0), summary_notch_enable_hint('INS_HNTC2_ENABLE', 0)])
})

test('summary_refly: изменённые из reboot_names — один пункт с именами по порядку строк; неизменённые — нет', () => {
    const reboot_names = ['SCHED_LOOP_RATE', 'INS_HNTCH_HMNCS']
    const reboot_of = (changes, names) => of_source(summary_refly(refly_ctx({ steps: steps_with2(changes), reboot_names: names })), 'reboot')

    const both = reboot_of({ SCHED_LOOP_RATE: 800, INS_HNTCH_HMNCS: 7, INS_HNTCH_FREQ: 75 }, reboot_names)
    assert.equal(both.length, 1)
    assert.deepEqual(param_names_in(both[0].text), ['SCHED_LOOP_RATE', 'INS_HNTCH_HMNCS'])

    // HMNCS не изменён — только SCHED_LOOP_RATE
    assert.deepEqual(reboot_of({ SCHED_LOOP_RATE: 800, INS_HNTCH_FREQ: 75 }, reboot_names).map((item) => param_names_in(item.text)),
        [['SCHED_LOOP_RATE']])

    // SCHED_LOOP_RATE совпал с логом — пункта нет; метаданные есть, перезагрузка не нужна ([]) — тоже нет
    assert.deepEqual(reboot_of({ SCHED_LOOP_RATE: 400, INS_HNTCH_FREQ: 75 }, ['SCHED_LOOP_RATE']), [])
    assert.deepEqual(reboot_of({ SCHED_LOOP_RATE: 800 }, []), [])

    // Поля включаемого notch изменены — его HMNCS, OPTS, REF тоже в пункте, по порядку строк
    const notch2 = notch_param_names()[1]
    const notch2_reboot = [notch2.harmonics, notch2.options, notch2.ref]
    assert.deepEqual(reboot_of({ INS_HNTC2_ENABLE: 1 }, notch2_reboot).map((item) => param_names_in(item.text)),
        [Object.values(notch2).filter((name) => notch2_reboot.includes(name))])
})

test('summary_refly: метаданные не загрузились (reboot_names null) — общий пункт без имён, если есть изменённые', () => {
    const items = summary_refly(refly_ctx({ steps: steps_with2({ INS_HNTCH_FREQ: 75 }), reboot_names: null }))
    assert.deepEqual(sources_of(items), ['reboot', 'repeat'])
    assert.deepEqual(param_names_in(items[0].text), [])
    // Изменённых нет — пункта нет
    assert.deepEqual(summary_refly(refly_ctx({ steps: steps_with2({}), reboot_names: null })), [])
})

test('summary_refly: ненадёжные оси — пункт тестового полёта с осями по порядку pidtune_axes, первая с заглавной', () => {
    const flight_of = (axes) => of_source(summary_refly(refly_ctx({ unreliable_axes: axes })), 'test_flight')

    const roll_pitch = flight_of(['roll', 'pitch'])
    assert.equal(roll_pitch.length, 1)
    assert.ok(roll_pitch[0].text.startsWith('Крен, тангаж '), roll_pitch[0].text)
    assert.ok(roll_pitch[0].text.includes(TEST_FLIGHT), roll_pitch[0].text)

    // Порядок — pidtune_axes, а не порядок в unreliable_axes
    assert.ok(flight_of(['yaw', 'roll'])[0].text.startsWith('Крен, рыскание '))
    assert.ok(flight_of(['yaw'])[0].text.startsWith('Рыскание '))

    // Ненадёжных осей нет — пункта нет
    assert.deepEqual(flight_of([]), [])
    assert.deepEqual(flight_of(null), [])
})

test('summary_refly: все оси ненадёжны, менять нечего (шаг 4 не принят) — только тестовый полёт, без «repeat»', () => {
    assert.deepEqual(sources_of(summary_refly(refly_ctx({ unreliable_axes: ['roll', 'pitch', 'yaw'] }))), ['test_flight'])
    const checks = [{ id: 'vibe', status: 'warn', title: 'Вибрации', text: 'высокие', fix: 'Проверьте крепление' }]
    assert.deepEqual(sources_of(summary_refly(refly_ctx({ checks: checks, steps: steps_with2({}), unreliable_axes: ['pitch'] }))),
        ['check', 'test_flight'])
})

test('summary_refly: «repeat» — последним и только при изменённых строках', () => {
    // Изменён шаг 2 или шаг 4
    const step4_changed = []
    step4_changed[4] = { accepted: accepted_values(STEP4_NAMES, BASE_LOG, { ATC_RAT_RLL_P: 0.15 }), axes: step4_axes() }
    for (const steps of [steps_with2({ INS_HNTCH_FREQ: 75 }), step4_changed]) {
        assert.deepEqual(sources_of(summary_refly(refly_ctx({ steps: steps, unreliable_axes: ['roll'] }))), ['test_flight', 'repeat'])
    }
    // Принято без изменений — повторять нечего
    assert.deepEqual(of_source(summary_refly(refly_ctx({ steps: steps_with2({}) })), 'repeat'), [])
})

// Метаданные в форме FilterReview/params.json: группы по префиксу, внутри — записи по полному имени
const FAKE_METADATA = {
    INS: { INS_GYRO_FILTER: { DisplayName: 'Gyro filter cutoff frequency' } },
    INS_HNTCH_: {
        INS_HNTCH_FREQ: { DisplayName: 'Harmonic Notch Filter base frequency' },
        INS_HNTCH_HMNCS: { DisplayName: 'Harmonic Notch Filter harmonics', RebootRequired: 'True' },
        INS_HNTCH_OPTS: { DisplayName: 'Harmonic Notch Filter options', RebootRequired: 'False' },
    },
    SCHED_: { SCHED_LOOP_RATE: { DisplayName: 'Scheduling main loop rate', RebootRequired: 'True' } },
    json: { version: 0 },
}

// Простой поиск записи: группа, в которой есть имя
function find_in_groups(data, name) {
    const group = Object.values(data).find((g) => name in g)
    return (group != null) ? group[name] : null
}

test('summary_reboot_names: имена с RebootRequired = "True" в порядке names; без метаданных — null, а не []', () => {
    const names = ['INS_GYRO_FILTER', 'SCHED_LOOP_RATE', 'INS_HNTCH_FREQ', 'INS_HNTCH_HMNCS', 'INS_HNTCH_OPTS', 'ATC_RAT_RLL_P']
    assert.deepEqual(summary_reboot_names(names, FAKE_METADATA, find_in_groups), ['SCHED_LOOP_RATE', 'INS_HNTCH_HMNCS'])
    // Метаданные есть, перезагрузка не нужна — пустой массив
    assert.deepEqual(summary_reboot_names([], FAKE_METADATA, find_in_groups), [])
    assert.deepEqual(summary_reboot_names(['INS_HNTCH_FREQ'], FAKE_METADATA, find_in_groups), [])
    // Поиск получает метаданные и имя
    const calls = []
    summary_reboot_names(['SCHED_LOOP_RATE'], FAKE_METADATA, (data, name) => { calls.push([data, name]); return null })
    assert.deepEqual(calls, [[FAKE_METADATA, 'SCHED_LOOP_RATE']])
    // Метаданные не загрузились — null (сводка покажет общий пункт), поиск не зовётся
    assert.equal(summary_reboot_names(names, null, () => { throw new Error('поиск без метаданных') }), null)
})

