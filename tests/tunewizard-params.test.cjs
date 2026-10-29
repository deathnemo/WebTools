// Тесты файла параметров мастера настройки (TuneWizard/core/params.js): текст .param и его разбор.
// Скрипты — классические (общая глобальная область), поэтому загружаются как на странице:
// по порядку через vm.runInThisContext (как в tests/tunewizard-core.test.cjs).
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

load_page_scripts([
    'Libraries/Param_Helpers.js',
    'TuneWizard/core/params.js',
])

test('param_file_text: строки «ИМЯ,ЗНАЧЕНИЕ» в натуральном порядке имён', () => {
    const text = param_file_text({ INS_HNTCH_FREQ: 40, INS_HNTC2_ENABLE: 0, INS_GYRO_FILTER: 20, INS_HNTCH_ATT: 15 })
    assert.equal(text, 'INS_GYRO_FILTER,20\nINS_HNTC2_ENABLE,0\nINS_HNTCH_ATT,15\nINS_HNTCH_FREQ,40\n')
})

test('param_file_text: числа — кратчайшая запись того же float32 (param_to_string)', () => {
    // 0.7 во float32 — 0.699999988…: записывается как 0.7, а не 0.699999988079071
    const text = param_file_text({ INS_HNTCH_FM_RAT: Math.fround(0.7), INS_HNTCH_REF: 0.25, INS_HNTCH_BW: 18.5 })
    assert.equal(text, 'INS_HNTCH_BW,18.5\nINS_HNTCH_FM_RAT,0.7\nINS_HNTCH_REF,0.25\n')
    assert.equal(param_to_string(Math.fround(0.7)), '0.7')
})

test('parse_param_file: обратно то же, что записали', () => {
    const values = { INS_GYRO_FILTER: 20, INS_HNTCH_ENABLE: 1, INS_HNTCH_MODE: 3, INS_HNTCH_FREQ: 37, INS_HNTCH_BW: 19,
                     INS_HNTCH_ATT: 24, INS_HNTCH_REF: 1, INS_HNTCH_FM_RAT: 1, INS_HNTCH_HMNCS: 5, INS_HNTCH_OPTS: 6, INS_HNTC2_FREQ: 153 }
    assert.deepEqual(parse_param_file(param_file_text(values)), values)
    // Дробные значения float32 переживают круг через текст с точностью float32
    const parsed = parse_param_file(param_file_text({ INS_HNTCH_FM_RAT: Math.fround(0.7) }))
    assert.equal(Math.fround(parsed.INS_HNTCH_FM_RAT), Math.fround(0.7))
})

test('parse_param_file: комментарии, пустые строки, CRLF и последнее значение при повторе', () => {
    const text = '# Файл от мастера\r\n\r\nINS_HNTCH_FREQ,40\r\n   \r\nINS_HNTCH_ATT,15  # ослабление\r\n#INS_HNTCH_BW,99\r\nINS_HNTCH_FREQ,45\r\n'
    assert.deepEqual(parse_param_file(text), { INS_HNTCH_FREQ: 45, INS_HNTCH_ATT: 15 })
})

test('parse_param_file: формат Mission Planner «ИМЯ,ЗНАЧЕНИЕ»', () => {
    assert.deepEqual(parse_param_file('INS_HNTCH_ENABLE,1\nINS_HNTCH_REF,0.25\nINS_HNTCH_HMNCS,7\n'),
        { INS_HNTCH_ENABLE: 1, INS_HNTCH_REF: 0.25, INS_HNTCH_HMNCS: 7 })
})

test('parse_param_file: формат MAVProxy «ИМЯ ЗНАЧЕНИЕ», табуляция и «=»', () => {
    const text = 'INS_HNTCH_ENABLE        1\nINS_HNTCH_FREQ\t40.5\nINS_HNTCH_BW = 20\nINS_HNTCH_ATT=30\n'
    assert.deepEqual(parse_param_file(text), { INS_HNTCH_ENABLE: 1, INS_HNTCH_FREQ: 40.5, INS_HNTCH_BW: 20, INS_HNTCH_ATT: 30 })
})

test('parse_param_file: строки без числового значения пропускаются', () => {
    const text = 'INS_HNTCH_FREQ\nINS_HNTCH_BW,\nINS_HNTCH_ATT,abc\nINS_HNTCH_REF,-0.5\n'
    assert.deepEqual(parse_param_file(text), { INS_HNTCH_REF: -0.5 })
})

// Параметры без лога: values = { имя: значение }
function fake_params(values) {
    return { get: (name) => (name in values) ? values[name] : null }
}

test('is_bitmask_param: маски notch — HMNCS, OPTS, ESCMSK', () => {
    for (const name of ['INS_HNTCH_HMNCS', 'INS_HNTC2_OPTS', 'INS_HNTCH_ESCMSK']) {
        assert.equal(is_bitmask_param(name), true, name)
    }
    for (const name of ['INS_HNTCH_FREQ', 'INS_HNTCH_FM_RAT', 'INS_GYRO_FILTER', 'SCHED_LOOP_RATE']) {
        assert.equal(is_bitmask_param(name), false, name)
    }
})

test('hmncs_bits: 32 бита при INS_RAW_LOG_OPT в логе или версии фильтра от 3, иначе 8 (update_hidden_params)', () => {
    assert.equal(hmncs_bits(fake_params({}), 2), 8)
    assert.equal(hmncs_bits(fake_params({}), 3), 32)
    assert.equal(hmncs_bits(fake_params({ INS_RAW_LOG_OPT: 0 }), 1), 32)
})

test('mask_unsigned: int8-маска из лога без знака, как parameter_get_value (−128 → 128)', () => {
    assert.equal(mask_unsigned(-128, 8), 128, 'гармоника 8 в int8')
    assert.equal(mask_unsigned(-123, 8), 133, 'гармоники 1, 2, 3, 8: 0b10000101 = 133')
    assert.equal(mask_unsigned(-1, 8), 255)
    assert.equal(mask_unsigned(5, 8), 5)
    assert.equal(mask_unsigned(-128, 32), -128, '32-битная маска не меняется')
    assert.equal(mask_unsigned(2**31 + 1, 32), 2**31 + 1)
})

test('mask_signed: 8-битная маска со старшим битом пишется со знаком; круг unsigned ↔ signed', () => {
    assert.equal(mask_signed(128, 8), -128)
    assert.equal(mask_signed(133, 8), -123)
    assert.equal(mask_signed(127, 8), 127)
    assert.equal(mask_signed(200, 32), 200, '32-битная маска не меняется')
    for (let v = -128; v < 128; v++) {
        assert.equal(mask_signed(mask_unsigned(v, 8), 8), v)
    }
})

test('escmsk_present: INS_*_ESCMSK есть у аппарата, если записан в лог или версия фильтра не ниже 4', () => {
    const params = (names) => ({ has: (name) => names.includes(name) })
    // Записан в лог при версии фильтра 2 (например, версия сменена на шаге 1) — есть; FilterReview смотрел бы только на версию
    assert.equal(escmsk_present(params(['INS_HNTCH_ESCMSK']), 2), true)
    assert.equal(escmsk_present(params([]), 4), true, 'версия фильтра 4 без записи в логе')
    assert.equal(escmsk_present(params([]), 2), false)
    assert.equal(escmsk_present(params([]), null), false, 'версия не определена — как ниже 4')
    // Решает маска первого notch: одна запись INS_HNTC2_ESCMSK правила не включает
    assert.equal(escmsk_present(params(['INS_HNTC2_ESCMSK']), 3), false)
})
