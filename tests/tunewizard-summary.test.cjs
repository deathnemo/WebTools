// Тесты итога прохода мастера настройки (TuneWizard/core/summary.js): сравнение значений как float32 и масок,
// строки итога по принятым шагам 2–4 (порядок источников и расхождение INS_GYRO_FILTER, ESCMSK по версии фильтра,
// включаемый notch, параметры без лога, ненадёжные оси шага 4), значения и текст .param из изменённых, имя
// файла, отпечаток входов принятого шага и «устарело», «что перелететь» (проверки шага 0, включаемый notch,
// перезагрузка, тестовый полёт, повтор) и имена с перезагрузкой по метаданным.
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

// Состояние для отпечатка: интервал, ключ FFT и версия фильтра шага 1, принятые шаги 2 и 3
function inputs_ctx() {
    const steps = []
    steps[2] = { accepted: { INS_HNTCH_FREQ: 80, INS_GYRO_FILTER: 40 } }
    steps[3] = { accepted: { INS_GYRO_FILTER: 45, INS_ACCEL_FILTER: 10 } }
    return { start: 10, end: 100, fft_key: 'batch:16', filter_version: 4, steps: steps }
}

// Состояние, в котором шаги 2–4 приняты с отпечатками от него самого
function inputs_ctx_accepted() {
    const ctx = inputs_ctx()
    ctx.steps[4] = { accepted: { ATC_RAT_RLL_P: 0.135 } }
    for (const n of [2, 3, 4]) {
        ctx.steps[n].inputs = summary_inputs_key(n, ctx)
    }
    return ctx
}

test('summary_inputs_key: JSON [начало, конец, ключ FFT, версия фильтра, принятое шагов 2..n−1 с именами по алфавиту]', () => {
    const ctx = inputs_ctx()
    assert.deepEqual(JSON.parse(summary_inputs_key(2, ctx)), [10, 100, 'batch:16', 4, []])
    assert.deepEqual(JSON.parse(summary_inputs_key(3, ctx)),
        [10, 100, 'batch:16', 4, [[['INS_GYRO_FILTER', 40], ['INS_HNTCH_FREQ', 80]]]])
    // Шаг 4: ключа FFT и версии фильтра нет; непринятый шаг — null
    ctx.steps[2] = null
    assert.deepEqual(JSON.parse(summary_inputs_key(4, ctx)),
        [10, 100, null, null, [null, [['INS_ACCEL_FILTER', 10], ['INS_GYRO_FILTER', 45]]]])
    // Порядок имён в принятом не важен
    const swapped = inputs_ctx()
    swapped.steps[2] = { accepted: { INS_GYRO_FILTER: 40, INS_HNTCH_FREQ: 80 } }
    assert.equal(summary_inputs_key(3, swapped), summary_inputs_key(3, inputs_ctx()))
})

test('summary_inputs_key: нет интервала, ключа FFT или версии фильтра (undefined) — null', () => {
    assert.deepEqual(JSON.parse(summary_inputs_key(2, { steps: [] })), [null, null, null, null, []])
    assert.deepEqual(JSON.parse(summary_inputs_key(4, { steps: [] })), [null, null, null, null, [null, null]])
})

test('summary_stale: принятое с отпечатком текущего состояния — не устарело; смена принятого шага 2, интервала или FFT — устарело', () => {
    const fresh = inputs_ctx_accepted
    for (const n of [2, 3, 4]) {
        assert.equal(summary_stale(n, fresh()), false, 'шаг ' + n)
    }

    const accepted2 = fresh()
    accepted2.steps[2] = { ...accepted2.steps[2], accepted: { INS_HNTCH_FREQ: 75, INS_GYRO_FILTER: 40 } }
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

    // Шаг 2 приняли позже шага 3 — шаг 3 считал от лога: устарело
    const late = inputs_ctx()
    late.steps[2] = null
    late.steps[3].inputs = summary_inputs_key(3, late)
    late.steps[2] = inputs_ctx().steps[2]
    assert.equal(summary_stale(3, late), true)
})

test('summary_stale: смена версии фильтра — шаги 2 и 3 устарели, шаг 4 — нет', () => {
    // Лог с версией 4: шаги 2–4 приняты при версии 4, затем на шаге 1 поставили 3 (форма шага 2 писала бы ESCMSK 0) —
    // шаги 2 и 3 устарели, шаг 4 — нет; вернули 4 — шаг 2 снова не устарел
    const ctx = inputs_ctx_accepted()
    ctx.filter_version = 3
    assert.equal(summary_stale(2, ctx), true)
    assert.equal(summary_stale(3, ctx), true)
    assert.equal(summary_stale(4, ctx), false)
    ctx.filter_version = 4
    assert.equal(summary_stale(2, ctx), false)
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

// ---------------------------------------------------------------- что перелететь

// Текст подсказки step2_second_notch_hint до выноса в ядро (steps/step2.js) — дословно, при INS_HNTC2_ENABLE = 0
// в логе
const STEP2_HINT_OLD = 'В логе INS_HNTC2_ENABLE = 0: на аппарате сначала запишите INS_HNTC2_ENABLE = 1 ' +
    'и обновите список параметров — остальные INS_HNTC2_* появятся только после этого, затем загрузите файл ещё раз.'

const REPEAT = { source: 'repeat',
    text: 'Слетайте тем же профилем и загрузите лог в мастер: шаг 0 покажет, что применено, шаги 2–4 — сбылся ли прогноз.' }

// Совет тестового полёта — подставной (страница передаёт step4_test_flight_short)
const TEST_FLIGHT = 'нужен тестовый полёт'

// Вход summary_refly: строки итога — summary_rows по тем же принятым шагам
function refly_ctx({ checks = [], steps = [], log = BASE_LOG, filter_version = 2, reboot_names = [] } = {}) {
    return { checks: checks, rows: summary_rows(rows_ctx({ log: log, steps: steps, filter_version: filter_version })).rows,
             steps: steps, reboot_names: reboot_names, test_flight: TEST_FLIGHT }
}

function of_source(items, source) {
    return items.filter((item) => item.source === source)
}

test('summary_notch_enable_hint: текст подсказки шага 2 дословно; ENABLE нет в логе — 0; префикс — имя без ENABLE', () => {
    assert.equal(summary_notch_enable_hint('INS_HNTC2_ENABLE', 0), STEP2_HINT_OLD)
    assert.equal(summary_notch_enable_hint('INS_HNTC2_ENABLE', null), STEP2_HINT_OLD)
    assert.equal(summary_notch_enable_hint('INS_HNTCH_ENABLE', -1),
        'В логе INS_HNTCH_ENABLE = -1: на аппарате сначала запишите INS_HNTCH_ENABLE = 1 ' +
        'и обновите список параметров — остальные INS_HNTCH_* появятся только после этого, затем загрузите файл ещё раз.')
})

test('summary_refly: ничего не принято и проверок нет — только «repeat»; checks null — как пустой список', () => {
    assert.deepEqual(summary_refly(refly_ctx()), [REPEAT])
    assert.deepEqual(summary_refly({ ...refly_ctx(), checks: null }), [REPEAT])
})

test('summary_refly: проверки warn и fail с fix — «title: fix» по порядку; ok и без fix — нет', () => {
    const checks = [
        { id: 'pid_log', status: 'warn', title: 'Сообщения PID', text: 'PID с частотой 10 Гц', fix: 'Включите бит ATTITUDE_FAST' },
        { id: 'vibe', status: 'ok', title: 'Вибрации', text: 'в норме', fix: 'не показывать' },
        { id: 'clipping', status: 'warn', title: 'Клиппинг', text: 'есть', fix: null },
        { id: 'flight', status: 'warn', title: 'Полёт', text: 'короткий', fix: '' },
        { id: 'tracking', status: 'warn', title: 'Слежение', text: 'нет' },
        { id: 'hover_throttle', status: 'fail', title: 'Газ висения', text: 'высокий', fix: 'Облегчите аппарат' },
    ]
    assert.deepEqual(summary_refly(refly_ctx({ checks: checks })), [
        { source: 'check', text: 'Сообщения PID: Включите бит ATTITUDE_FAST' },
        { source: 'check', text: 'Газ висения: Облегчите аппарат' },
        REPEAT,
    ])
})

test('summary_refly: включение второго notch — пункт с подсказкой шага 2 (INS_HNTC2_ENABLE, префикс INS_HNTC2_)', () => {
    const steps = []
    steps[2] = { accepted: accepted_values(STEP2_NAMES, BASE_LOG, { INS_HNTC2_ENABLE: 1, INS_HNTC2_FREQ: 153 }) }
    const items = summary_refly(refly_ctx({ steps: steps }))
    assert.deepEqual(items, [{ source: 'notch', text: STEP2_HINT_OLD }, REPEAT])
    assert.match(items[0].text, /INS_HNTC2_ENABLE = 1/)
    assert.match(items[0].text, /остальные INS_HNTC2_\* появятся/)

    // ENABLE нет в логе вовсе — «= 0», как у шага 2
    const no_enable = { ...BASE_LOG }
    delete no_enable.INS_HNTC2_ENABLE
    assert.deepEqual(of_source(summary_refly(refly_ctx({ log: no_enable, steps: steps })), 'notch'),
        [{ source: 'notch', text: STEP2_HINT_OLD }])
})

test('summary_refly: notch не включается (остаётся выключенным, уже включён, выключается) — пункта нет', () => {
    for (const changes of [{ INS_HNTC2_FREQ: 153 }, { INS_HNTCH_FREQ: 75 }, { INS_HNTCH_ENABLE: 0 }]) {
        const steps = []
        steps[2] = { accepted: accepted_values(STEP2_NAMES, BASE_LOG, changes) }
        assert.deepEqual(of_source(summary_refly(refly_ctx({ steps: steps })), 'notch'), [], JSON.stringify(changes))
    }
})

test('summary_refly: включаются оба notch — два пункта по порядку notch', () => {
    const log = Object.fromEntries(Object.entries(BASE_LOG).filter(([name]) => !name.startsWith('INS_HNTCH_')))
    log.INS_HNTCH_ENABLE = 0
    const steps = []
    steps[2] = { accepted: accepted_values(STEP2_NAMES, log, { INS_HNTCH_ENABLE: 1, INS_HNTC2_ENABLE: 1 }) }
    assert.deepEqual(of_source(summary_refly(refly_ctx({ log: log, steps: steps })), 'notch').map((item) => item.text),
        [summary_notch_enable_hint('INS_HNTCH_ENABLE', 0), STEP2_HINT_OLD])
})

test('summary_refly: изменённые из reboot_names — один пункт с именами по порядку строк; неизменённые — нет', () => {
    const reboot_names = ['SCHED_LOOP_RATE', 'INS_HNTCH_HMNCS']
    const steps = []
    steps[2] = { accepted: accepted_values(STEP2_NAMES, BASE_LOG, { SCHED_LOOP_RATE: 800, INS_HNTCH_HMNCS: 7, INS_HNTCH_FREQ: 75 }) }
    assert.deepEqual(of_source(summary_refly(refly_ctx({ steps: steps, reboot_names: reboot_names })), 'reboot'), [{
        source: 'reboot',
        text: 'После записи перезагрузите полётный контроллер: изменены SCHED_LOOP_RATE, INS_HNTCH_HMNCS — они действуют после перезагрузки.',
    }])

    // HMNCS не изменён — только SCHED_LOOP_RATE
    steps[2] = { accepted: accepted_values(STEP2_NAMES, BASE_LOG, { SCHED_LOOP_RATE: 800, INS_HNTCH_FREQ: 75 }) }
    assert.deepEqual(of_source(summary_refly(refly_ctx({ steps: steps, reboot_names: reboot_names })), 'reboot').map((item) => item.text),
        ['После записи перезагрузите полётный контроллер: изменены SCHED_LOOP_RATE — они действуют после перезагрузки.'])

    // SCHED_LOOP_RATE совпал с логом — пункта нет
    steps[2] = { accepted: accepted_values(STEP2_NAMES, BASE_LOG, { SCHED_LOOP_RATE: 400, INS_HNTCH_FREQ: 75 }) }
    assert.deepEqual(of_source(summary_refly(refly_ctx({ steps: steps, reboot_names: ['SCHED_LOOP_RATE'] })), 'reboot'), [])
})

test('summary_refly: ненадёжные крен и тангаж — «крен, тангаж: » + совет; все надёжны или metrics null — пункта нет', () => {
    const steps = []
    steps[4] = { accepted: accepted_values(STEP4_NAMES, BASE_LOG), axes: step4_axes({ roll: false, pitch: false }) }
    assert.deepEqual(of_source(summary_refly(refly_ctx({ steps: steps })), 'test_flight'),
        [{ source: 'test_flight', text: 'крен, тангаж: ' + TEST_FLIGHT }])

    // Оси — в порядке pidtune_axes
    steps[4] = { accepted: accepted_values(STEP4_NAMES, BASE_LOG), axes: step4_axes({ yaw: false, roll: false }) }
    assert.deepEqual(of_source(summary_refly(refly_ctx({ steps: steps })), 'test_flight').map((item) => item.text),
        ['крен, рыскание: ' + TEST_FLIGHT])

    const no_metrics = step4_axes()
    no_metrics.roll.metrics = null
    for (const axes of [step4_axes(), no_metrics, undefined]) {
        steps[4] = { accepted: accepted_values(STEP4_NAMES, BASE_LOG), axes: axes }
        assert.deepEqual(of_source(summary_refly(refly_ctx({ steps: steps })), 'test_flight'), [])
    }
})

test('summary_refly: шаг 4 не принят — пункта тестового полёта нет', () => {
    const steps = []
    steps[2] = { accepted: accepted_values(STEP2_NAMES, BASE_LOG, { INS_HNTCH_FREQ: 75 }) }
    assert.deepEqual(summary_refly(refly_ctx({ steps: steps })), [REPEAT])
})

test('summary_refly: порядок пунктов — проверки, notch, перезагрузка, тестовый полёт, последним «repeat»', () => {
    const checks = [{ id: 'vibe', status: 'warn', title: 'Вибрации', text: 'высокие', fix: 'Проверьте крепление' }]
    const steps = []
    steps[2] = { accepted: accepted_values(STEP2_NAMES, BASE_LOG, { SCHED_LOOP_RATE: 800, INS_HNTC2_ENABLE: 1 }) }
    steps[4] = { accepted: accepted_values(STEP4_NAMES, BASE_LOG), axes: step4_axes({ pitch: false }) }
    const items = summary_refly(refly_ctx({ checks: checks, steps: steps, reboot_names: ['SCHED_LOOP_RATE', 'INS_HNTC2_HMNCS'] }))
    assert.deepEqual(items.map((item) => item.source), ['check', 'notch', 'reboot', 'test_flight', 'repeat'])
    // Поля включаемого notch изменены — его HMNCS тоже в пункте перезагрузки
    assert.equal(items[2].text,
        'После записи перезагрузите полётный контроллер: изменены SCHED_LOOP_RATE, INS_HNTC2_HMNCS — они действуют после перезагрузки.')
    assert.equal(items[3].text, 'тангаж: ' + TEST_FLIGHT)
    assert.deepEqual(items.at(-1), REPEAT)
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

test('summary_reboot_names: имена с RebootRequired = "True" в порядке names; без метаданных — []', () => {
    const names = ['INS_GYRO_FILTER', 'SCHED_LOOP_RATE', 'INS_HNTCH_FREQ', 'INS_HNTCH_HMNCS', 'INS_HNTCH_OPTS', 'ATC_RAT_RLL_P']
    assert.deepEqual(summary_reboot_names(names, FAKE_METADATA, find_in_groups), ['SCHED_LOOP_RATE', 'INS_HNTCH_HMNCS'])
    assert.deepEqual(summary_reboot_names([], FAKE_METADATA, find_in_groups), [])
    // Поиск получает метаданные и имя
    const calls = []
    summary_reboot_names(['SCHED_LOOP_RATE'], FAKE_METADATA, (data, name) => { calls.push([data, name]); return null })
    assert.deepEqual(calls, [[FAKE_METADATA, 'SCHED_LOOP_RATE']])
    // Метаданные не загрузились — поиск не зовётся
    assert.deepEqual(summary_reboot_names(names, null, () => { throw new Error('поиск без метаданных') }), [])
})
