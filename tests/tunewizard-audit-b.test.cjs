// Тесты помощников шага 2 мастера настройки (TuneWizard/steps/step2.js) без браузера — исправления аудита 28.10.2026,
// область B: приведение значений полей формы (SCHED_LOOP_RATE ≤ 0, маски), маски словами, правило ESCMSK, подсказки
// про включаемые notch, признак «notch лога не смоделирован», значения словами; стык областей B и C — срез INS_GYRO_FILTER
// в оценке шага 2 ограничен, как в прошивке (step2_model_values, step2_evaluate).
// Скрипты — классические (общая глобальная область), поэтому загружаются как на странице через vm.runInThisContext
// (как в tests/tunewizard-core.test.cjs); step2.js при загрузке к DOM не обращается, а проверяемые помощники — чистые.
// Глобалы страницы, которые они зовут (state, evaluate_candidate), подменяются в тестах; lowpass_gyro_cutoff —
// настоящий (core/lowpass.js, ему при загрузке нужен core/candidates.js)
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
    'TuneWizard/core/filters.js',
    'TuneWizard/core/candidates.js',
    'TuneWizard/core/lowpass.js',
    'TuneWizard/core/summary.js',
    'TuneWizard/steps/step2.js',
])

// Состояние страницы для помощников: параметры лога (get → значение или null, has) и версия фильтра
function set_state(params, filter_version) {
    globalThis.state = {
        params: { get: (name) => (name in params) ? params[name] : null, has: (name) => name in params },
        env: { filter_version },
    }
}

test('step2_field_value: SCHED_LOOP_RATE не больше нуля — значение лога с записью в поле; пустое поле — лог без записи', () => {
    // Раньше 0 доходил до alias_obj → new Array(NaN) → «Ошибка шага 2: Invalid array length»
    assert.deepEqual(step2_field_value('SCHED_LOOP_RATE', '0', 400, null), { value: 400, text: '400' })
    assert.deepEqual(step2_field_value('SCHED_LOOP_RATE', '-50', 400, null), { value: 400, text: '400' })
    assert.deepEqual(step2_field_value('SCHED_LOOP_RATE', '', 400, null), { value: 400, text: null })
    assert.deepEqual(step2_field_value('SCHED_LOOP_RATE', '800', 400, null), { value: 800, text: null })
    // Обычное поле: нечисловое — лог без записи, число — как есть; ноль допустим не только у SCHED_LOOP_RATE
    assert.deepEqual(step2_field_value('INS_HNTCH_ATT', 'abc', 15, null), { value: 15, text: null })
    assert.deepEqual(step2_field_value('INS_HNTCH_ATT', '22.5', 15, null), { value: 22.5, text: null })
    assert.deepEqual(step2_field_value('INS_GYRO_FILTER', '0', 40, null), { value: 0, text: null })
})

test('step2_field_value: маски — целая часть; 8-битная без знака по модулю 256; 32-битная отрицательная или ≥ 2^32 — из лога', () => {
    // 32-битные OPTS/ESCMSK/HMNCS: «1.5» и «−1» раньше уходили в оценку и в .param как есть
    assert.deepEqual(step2_field_value('INS_HNTCH_OPTS', '1.5', 6, 32), { value: 1, text: '1' })
    assert.deepEqual(step2_field_value('INS_HNTCH_OPTS', '-1', 6, 32), { value: 6, text: '6' })
    assert.deepEqual(step2_field_value('INS_HNTCH_ESCMSK', '4294967296', 0, 32), { value: 0, text: '0' })
    assert.deepEqual(step2_field_value('INS_HNTCH_HMNCS', '2147483648', 5, 32), { value: 2147483648, text: '2147483648' }, 'бит 31 без округления до float32')
    assert.deepEqual(step2_field_value('INS_HNTCH_HMNCS', '5', 5, 32), { value: 5, text: '5' })
    assert.deepEqual(step2_field_value('INS_HNTCH_HMNCS', '', 5, 32), { value: 5, text: null })
    // 8-битная HMNCS: int8 из .param и от флажка бита 7 в ParameterMetadata — гармоника 8 (как parameter_get_value);
    // «256» раньше давала в оценке 0, а в поле оставалась 256
    assert.deepEqual(step2_field_value('INS_HNTCH_HMNCS', '-128', 5, 8), { value: 128, text: '128' })
    assert.deepEqual(step2_field_value('INS_HNTCH_HMNCS', '-123', 5, 8), { value: 133, text: '133' })
    assert.deepEqual(step2_field_value('INS_HNTCH_HMNCS', '256', 5, 8), { value: 0, text: '0' })
    assert.deepEqual(step2_field_value('INS_HNTCH_HMNCS', '133', 5, 8), { value: 133, text: '133' })
})

test('step2_masks_text: гармоник не больше MAX_NUM_HARMONICS, биты OPTS словами', () => {
    const names = notch_param_names()[0]
    assert.equal(step2_masks_text({ [names.harmonics]: 5, [names.options]: 6 }, names), 'гарм. 1, 3 · multi, loop')
    assert.equal(step2_masks_text({ [names.harmonics]: 0, [names.options]: 0 }, names), 'гарм. нет')
    // Все 32 бита — только 16 гармоник, сколько строит HarmonicNotchFilter (раньше перечислялись 1…32)
    const all = step2_masks_text({ [names.harmonics]: 0xFFFFFFFF, [names.options]: 0 }, names)
    assert.equal(all, 'гарм. ' + Array.from({ length: MAX_NUM_HARMONICS }, (_, n) => n + 1).join(', '))
    assert.equal(MAX_NUM_HARMONICS, 16)
})

test('step2_escmsk_present: правило escmsk_present ядра для текущего лога и версии фильтра (записан в лог или версия не ниже 4)', () => {
    // Записан в лог при версии фильтра 2 (например, версия сменена на шаге 1) — есть; версия 4 без записи — есть
    set_state({ INS_HNTCH_ESCMSK: 3 }, 2)
    assert.equal(step2_escmsk_present(), true)
    set_state({}, 4)
    assert.equal(step2_escmsk_present(), true)
    set_state({}, 2)
    assert.equal(step2_escmsk_present(), false)
    // Версия фильтра не задана — считается 1. Значения лога шага 2 — values_from_log шага 1 с тем же правилом
    // (tests/tunewizard-audit-a.test.cjs), отдельной обёртки больше нет
    globalThis.state = { params: { get: () => null, has: () => false }, env: null }
    assert.equal(step2_escmsk_present(), false)
    assert.equal(typeof globalThis.step2_log_values, 'undefined')
})

test('step2_model_values и step2_evaluate: INS_GYRO_FILTER выше 0.4 частоты гироскопа ограничен для модели с предупреждением (как lowpass_gyro_cutoff шага 3)', () => {
    const values = { INS_GYRO_FILTER: 1000, SCHED_LOOP_RATE: 400, INS_HNTCH_FREQ: 80 }
    // В пределах — те же значения (тот же объект), без предупреждения; частоты выборки нет (NaN) — тоже как есть
    assert.deepEqual(step2_model_values(values, 4000), { values: values, warning: null })
    assert.equal(step2_model_values(values, 4000).values, values)
    assert.deepEqual(step2_model_values(values, NaN), { values: values, warning: null })
    // Выше 0.4·fs — копия с ограниченным срезом, исходные значения не тронуты
    const model = step2_model_values(values, 1000)
    assert.deepEqual(model.values, { INS_GYRO_FILTER: 400, SCHED_LOOP_RATE: 400, INS_HNTCH_FREQ: 80 })
    assert.equal(values.INS_GYRO_FILTER, 1000)
    assert.match(model.warning, /^INS_GYRO_FILTER 1000 выше 0\.4 частоты гироскопа \(1000 Гц\): прошивка ограничит до 400 Гц — так и посчитано$/)

    // step2_evaluate: evaluate_candidate получает ограниченные значения, оценка — с исходными values и предупреждением в конце
    const seen = []
    const saved = globalThis.evaluate_candidate
    try {
        globalThis.evaluate_candidate = (v, ctx) => {
            seen.push(v)
            return (ctx.sensor === 1) ? null : { values: v, warnings: ['трекинг'], band_dB: -60 }
        }
        const ctx = { gyro: [{ FFT: { average_sample_rate: 1000 } }, { FFT: null }], sensor: 0 }
        const evaluation = step2_evaluate(values, ctx)
        assert.deepEqual(seen, [{ INS_GYRO_FILTER: 400, SCHED_LOOP_RATE: 400, INS_HNTCH_FREQ: 80 }])
        assert.equal(evaluation.values, values, 'в оценке — исходные значения варианта')
        assert.deepEqual(evaluation.warnings, ['трекинг', model.warning])
        assert.equal(evaluation.band_dB, -60)
        // В пределах — оценка как есть (тот же объект, предупреждений не добавлено)
        const fine = step2_evaluate({ INS_GYRO_FILTER: 40 }, ctx)
        assert.deepEqual(fine, { values: { INS_GYRO_FILTER: 40 }, warnings: ['трекинг'], band_dB: -60 })
        // Экземпляр без FFT: частоты выборки нет — значения как есть, null от evaluate_candidate — null
        assert.equal(step2_evaluate(values, { ...ctx, sensor: 1 }), null)
        assert.deepEqual(seen[seen.length - 1], values, 'без частоты выборки срез не ограничивается')
    } finally {
        globalThis.evaluate_candidate = saved
    }
})

test('step2_notch_enable_hints: подсказка на каждый notch, выключенный в логе и включаемый в значениях', () => {
    // Первый notch в логе выключен, второго в логе нет
    set_state({ INS_HNTCH_ENABLE: 0 }, 2)
    const hints = step2_notch_enable_hints({ INS_HNTCH_ENABLE: 1, INS_HNTC2_ENABLE: 1 })
    assert.equal(hints.length, 2)
    assert.match(hints[0], /^В логе INS_HNTCH_ENABLE = 0: на аппарате сначала запишите INS_HNTCH_ENABLE = 1 и обновите список параметров — остальные INS_HNTCH_\* появятся/)
    assert.match(hints[1], /^В логе INS_HNTC2_ENABLE = 0: на аппарате сначала запишите INS_HNTC2_ENABLE = 1/)
    assert.equal(step2_notch_enable_hints({ INS_HNTCH_ENABLE: 1, INS_HNTC2_ENABLE: 0 }).length, 1)
    assert.deepEqual(step2_notch_enable_hints({ INS_HNTCH_ENABLE: 0, INS_HNTC2_ENABLE: 0 }), [])
    // Оба включены в логе — подсказок нет
    set_state({ INS_HNTCH_ENABLE: 1, INS_HNTC2_ENABLE: 1 }, 2)
    assert.deepEqual(step2_notch_enable_hints({ INS_HNTCH_ENABLE: 1, INS_HNTC2_ENABLE: 1 }), [])
})

test('step2_log_unmodeled: включённый в логе notch, который не работает, — текст его предупреждений; иначе null', () => {
    const log = (enable, notch_enabled, notch_warnings) => ({ values: { INS_HNTCH_ENABLE: enable[0], INS_HNTC2_ENABLE: enable[1] }, notch_enabled, notch_warnings })
    assert.equal(step2_log_unmodeled(log([1, 0], [false, false], [['Нет данных трекинга для notch RPM1'], []])), 'Нет данных трекинга для notch RPM1')
    assert.equal(step2_log_unmodeled(log([1, 1], [true, false], [[], ['Неподдерживаемый режим notch 7']])), 'Неподдерживаемый режим notch 7')
    assert.equal(step2_log_unmodeled(log([1, 1], [false, false], [['a', 'a'], ['b']])), 'a; b', 'повторы предупреждений — один раз')
    assert.equal(step2_log_unmodeled(log([1, 0], [false, false], [[], []])), 'notch 1 включён, но не смоделирован')
    // Работает; выключен в логе; оценки нет; оценка без notch_enabled (вручную) — null
    assert.equal(step2_log_unmodeled(log([1, 0], [true, false], [[], []])), null)
    assert.equal(step2_log_unmodeled(log([0, 0], [false, false], [[], []])), null)
    assert.equal(step2_log_unmodeled(null), null)
    assert.equal(step2_log_unmodeled({ values: { INS_HNTCH_ENABLE: 1 }, peaks: [] }), null)
})

test('step2_value_text: маски — как есть, остальные — кратчайшей записью того же float32', () => {
    assert.equal(step2_value_text('INS_HNTCH_HMNCS', 2147483649), '2147483649')
    assert.equal(step2_value_text('INS_HNTCH_ESCMSK', 2147483648), '2147483648')
    // param_to_string округляет маску с битом 31 до float32 — поэтому для масок он не годится (M9 аудита)
    assert.equal(param_to_string(2147483648), '2147483600')
    assert.equal(step2_value_text('INS_HNTCH_OPTS', 6), '6')
    assert.equal(step2_value_text('INS_HNTCH_FM_RAT', Math.fround(0.7)), '0.7')
    assert.equal(step2_value_text('INS_HNTCH_FREQ', 40), '40')
})
