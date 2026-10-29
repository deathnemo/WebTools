// Тесты шага 3 мастера настройки (TuneWizard/steps/step3.js) без браузера — то, что не зависит от расчёта спектра:
// значения формы при первом заполнении с INS_GYRO_FILTER шага 2 и заметка о нём, отказ «Принять» (пустые поля,
// отрицательные частоты и пределы ускорения), причина «сравнить нельзя» (нет данных «до» вовсе или у первичного
// гироскопа), ключ контекста оценки без размера винта и вердикт принятого (не устаревает от размера винта, называет
// рекомендованный вариант), «Применить вариант» при неготовом расчёте шага 1 — под оверлеем одной функцией.
// Страница — заглушки, как в tests/tunewizard-common.test.cjs: элементы по id, оверлей — очередь функций, расчёт
// шага 1 задаётся тестом; данных гироскопа «до» нет — варианты без оценки (это и нужно: оценка проверена в
// tests/tunewizard-steps.test.cjs). Скрипты — классические (общая глобальная область), грузятся по порядку index.html.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const repo = path.resolve(__dirname, '..')

// Элементы страницы по id: поля формы (value), блоки (hidden, textContent, innerHTML, className, disabled); части
// таблицы — querySelector по селектору у элемента
const elements = {}
function element() {
    const parts = {}
    return {
        value: '', hidden: true, textContent: '', innerHTML: '', className: '', disabled: false, min: '', max: '', step: '',
        classList: { toggle() {}, contains: () => false },
        querySelector: (selector) => (parts[selector] ??= element()),
        contains: () => false,
        addEventListener() {},
        focus() {},
    }
}
globalThis.document = {
    getElementById: (id) => (elements[id] ??= element()),
    querySelectorAll: () => [],
    addEventListener() {},
    activeElement: null,
}
globalThis.window = { addEventListener() {} }
globalThis.html_escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

// Оверлей загрузки: loading_call только запоминает функцию — тест сам решает, когда её выполнить
const overlay_queue = []
globalThis.loading_call = (fun) => { overlay_queue.push(fun) }
async function flush_overlay() {
    while (overlay_queue.length > 0) {
        await overlay_queue.shift()()
    }
}

// Расчёт шага 1: готовность и досчёт задаёт тест (step1_prepare возвращает prepare_result и делает шаг готовым)
const step1_state = { ready: false, prepare_result: true, prepare_calls: 0 }
globalThis.step1 = { fft_key: 'batch:1', error: null }
globalThis.step1_ready = () => step1_state.ready
globalThis.step1_prepare = () => {
    step1_state.prepare_calls++
    step1_state.ready = step1_state.prepare_result
    return step1_state.prepare_result
}

// Notch-база из лога (steps/step1.js) — контур 400 Гц, notch как в логе этапа 2
const notch_log = { INS_GYRO_FILTER: 40, SCHED_LOOP_RATE: 400, INS_HNTCH_ENABLE: 1, INS_HNTCH_FREQ: 80, INS_HNTCH_BW: 40, INS_HNTCH_ATT: 40, INS_HNTCH_HMNCS: 3 }
globalThis.values_from_log = () => ({ ...notch_log })

// Графики и память прохода шага под Node не нужны
globalThis.plot = () => null
globalThis.memory_show = () => {}
globalThis.register_plot = () => {}
globalThis.render_plot = () => {}

// Параметры без лога: values = { имя: значение }
function fake_params(values) {
    return { get: (name) => (name in values) ? values[name] : null, has: (name) => name in values, changed: () => false }
}

// Значения лога пользователя (ArduCopter 4.6.3, старые имена пределов ускорения, сантиградусы/с²) и Kd
const user_log = {
    INS_GYRO_FILTER: 40, INS_ACCEL_FILTER: 10,
    ATC_RAT_RLL_FLTT: 20, ATC_RAT_RLL_FLTE: 0, ATC_RAT_RLL_FLTD: 30,
    ATC_RAT_PIT_FLTT: 20, ATC_RAT_PIT_FLTE: 0, ATC_RAT_PIT_FLTD: 30,
    ATC_RAT_YAW_FLTT: 20, ATC_RAT_YAW_FLTE: 1, ATC_RAT_YAW_FLTD: 0,
    ATC_ACCEL_R_MAX: 90000, ATC_ACCEL_P_MAX: 90000, ATC_ACCEL_Y_MAX: 50000,
    ATC_RAT_RLL_D: 0.004, ATC_RAT_PIT_D: 0.005,
}

globalThis.state = {}

// В порядке index.html: ядро (lowpass.js при загрузке нужен candidates.js, common.js — summary.js и его зависимости),
// общий модуль шагов, шаг 3
for (const file of ['Libraries/Param_Helpers.js', 'TuneWizard/core/filters.js', 'TuneWizard/core/candidates.js', 'TuneWizard/core/lowpass.js',
                    'TuneWizard/core/pid.js', 'TuneWizard/core/pidtune.js', 'TuneWizard/core/params.js', 'TuneWizard/core/summary.js',
                    'TuneWizard/steps/common.js', 'TuneWizard/steps/step3.js']) {
    const full = path.join(repo, file)
    vm.runInThisContext(fs.readFileSync(full, 'utf8'), { filename: full })
}

// Страница с загруженным логом params (объект имя → значение): интервал 10–20 с, версия фильтра 2, данных гироскопа
// «до» нет (have_pre), принято только step2 (запись state.steps[2] или null); форма шага 3 построена и заполнена
// (step3_initial_values), поле размера винта — prop (строка, '' — пусто); состояние шага 3 — как после step3_reset.
// Расчёт шага 1 — ready
function reset_page({ params = user_log, prop = '', ready = true, step2 = null } = {}) {
    for (const key of Object.keys(elements)) {
        delete elements[key]
    }
    overlay_queue.length = 0
    Object.assign(step1_state, { ready: ready, prepare_result: true, prepare_calls: 0 })
    step1.error = null
    const steps = []
    if (step2 != null) {
        steps[2] = step2
    }
    globalThis.state = {
        log: {}, params: fake_params(params), settings: { start: 10, end: 20 }, spectrum: { filter_version: 2 },
        gyro: { have_pre: false, primary: 0, first_gyro: 0 }, env: {}, tracking: [], steps: steps,
    }
    step3_reset()
    step3.form_names = lowpass_param_names(state.params)
    step3.form_built = true
    step3_fill_form(step3_initial_values())
    step3.filled = true
    document.getElementById('prop_in').value = prop
}

// Значения формы шага 3 числами (объект имя → число)
function form_values() {
    return step3_values_from_form()
}

test('step3_initial_values: лог, а INS_GYRO_FILTER — принятый на шаге 2, если он принят и отличается от лога', () => {
    reset_page()
    const log_values = lowpass_log_values(state.params)
    assert.deepEqual(step3_initial_values(), log_values, 'шаг 2 не принят — значения лога')
    state.steps[2] = { accepted: { ...notch_log, INS_GYRO_FILTER: 40 } }
    assert.deepEqual(step3_initial_values(), log_values, 'принят как в логе — значения лога')
    state.steps[2] = { accepted: { ...notch_log, INS_GYRO_FILTER: 50 } }
    assert.deepEqual(step3_initial_values(), { ...log_values, INS_GYRO_FILTER: 50 }, 'принят другой — он в форме, остальное из лога')
    // Принятое шагом 2 — из его формы (double): в форму шага 3 — float32, как значения лога и вариантов
    state.steps[2] = { accepted: { ...notch_log, INS_GYRO_FILTER: 40.1 } }
    assert.equal(step3_initial_values().INS_GYRO_FILTER, Math.fround(40.1))
    for (const bad of [NaN, undefined, null, '50']) {
        state.steps[2] = { accepted: { ...notch_log, INS_GYRO_FILTER: bad } }
        assert.deepEqual(step3_initial_values(), log_values, 'нечисловое принятое ' + bad + ' — значения лога')
    }
    // Первое заполнение формы (reset_page) берёт эти значения: поле — принятое шагом 2, строка таблицы — «Свой»
    reset_page({ step2: { accepted: { ...notch_log, INS_GYRO_FILTER: 50 } } })
    assert.equal(document.getElementById('lpf_INS_GYRO_FILTER').value, '50')
    assert.equal(form_values().INS_GYRO_FILTER, 50)
    step3_compute()
    assert.equal(step3_form_row()?.id, 'custom', 'значения формы не совпали ни с одним вариантом — строка «Свой»')
    assert.deepEqual(step3.candidates.map((c) => c.values.INS_GYRO_FILTER), [40, 40], 'варианты — от лога, а не от шага 2')
})

test('step3_step2_gyro_note: заметка, пока в форме не принятое шагом 2 значение, отличное от лога', () => {
    reset_page()
    assert.equal(step3_step2_gyro_note(40), null, 'шаг 2 не принят')
    state.steps[2] = { accepted: { ...notch_log, INS_GYRO_FILTER: 40 } }
    assert.equal(step3_step2_gyro_note(42), null, 'принят как в логе — шаг 3 ничего не теряет')
    state.steps[2] = { accepted: { ...notch_log, INS_GYRO_FILTER: 50 } }
    assert.equal(step3_step2_gyro_note(50), null, 'в форме принятое шагом 2')
    assert.equal(step3_step2_gyro_note(Math.fround(50)), null, 'float32 формы против double шага 2')
    assert.equal(step3_step2_gyro_note(40), 'На шаге 2 принят INS_GYRO_FILTER 50 (в логе 40). Шаг 3 решает этот параметр: в файл пойдёт значение из этой формы — 40.')
    assert.equal(step3_step2_gyro_note(42), 'На шаге 2 принят INS_GYRO_FILTER 50 (в логе 40). Шаг 3 решает этот параметр: в файл пойдёт значение из этой формы — 42.')
    assert.equal(step3_step2_gyro_note(NaN), 'На шаге 2 принят INS_GYRO_FILTER 50 (в логе 40). Шаг 3 решает этот параметр: в файл пойдёт значение из этой формы.', 'пустое поле')
    // Заметки под вердиктом: после «Применить вариант» со значением лога заметка видна, с принятым шагом 2 — нет
    reset_page({ step2: { accepted: { ...notch_log, INS_GYRO_FILTER: 50 } } })
    step3_compute()
    step3_render_warnings()
    assert.doesNotMatch(document.getElementById('warnings3').innerHTML, /На шаге 2 принят/, 'в форме принятое шагом 2 — без заметки')
    step3_set_form_values(step3_log_candidate().values)
    step3_render_warnings()
    assert.match(document.getElementById('warnings3').innerHTML, /На шаге 2 принят INS_GYRO_FILTER 50 \(в логе 40\)\. Шаг 3 решает этот параметр: в файл пойдёт значение из этой формы — 40\./)
    assert.equal(document.getElementById('warnings3').hidden, false)
})

test('step3_accept_refusal: пустые поля, отрицательные частоты и отрицательные пределы ускорения; ноль предела — можно', () => {
    reset_page()
    const values = form_values()
    assert.equal(step3_accept_refusal(values), null, 'значения лога принимаются')
    assert.equal(step3_accept_refusal({ ...values, ATC_ACCEL_R_MAX: 0, ATC_ACCEL_Y_MAX: 0 }), null, 'предел 0 — выключен, допустимо')
    assert.equal(step3_accept_refusal({ ...values, ATC_RAT_RLL_FLTE: -1 }), 'Принять нельзя — отрицательные частоты: ATC_RAT_RLL_FLTE.')
    assert.equal(step3_accept_refusal({ ...values, ATC_ACCEL_R_MAX: -5 }), 'Принять нельзя — отрицательные пределы ускорения: ATC_ACCEL_R_MAX.')
    assert.equal(step3_accept_refusal({ ...values, ATC_ACCEL_P_MAX: -1, ATC_ACCEL_Y_MAX: -0.5 }), 'Принять нельзя — отрицательные пределы ускорения: ATC_ACCEL_P_MAX, ATC_ACCEL_Y_MAX.')
    assert.equal(step3_accept_refusal({ ...values, INS_GYRO_FILTER: NaN }), 'Принять нельзя — не заполнены поля: INS_GYRO_FILTER.')
    assert.equal(step3_accept_refusal({ ...values, INS_ACCEL_FILTER: NaN, ATC_RAT_PIT_FLTD: -2, ATC_ACCEL_R_MAX: -1 }),
        'Принять нельзя — не заполнены поля: INS_ACCEL_FILTER; отрицательные частоты: ATC_RAT_PIT_FLTD; отрицательные пределы ускорения: ATC_ACCEL_R_MAX.')
    // Новые имена пределов (°/с²) — те же правила
    const new_log = Object.fromEntries(Object.entries(user_log).filter(([name]) => !name.startsWith('ATC_ACCEL_')))
    reset_page({ params: { ...new_log, ATC_ACC_R_MAX: 1100 } })
    assert.equal(step3_accept_refusal({ ...form_values(), ATC_ACC_P_MAX: -1 }), 'Принять нельзя — отрицательные пределы ускорения: ATC_ACC_P_MAX.')
})

test('step3_no_compare_reason: контур не положителен; нет данных «до» вовсе; нет их у первичного гироскопа', () => {
    reset_page()
    step3_compute()
    assert.equal(step3.ctx, null, 'без данных «до» контекста оценки нет')
    assert.equal(step3_no_compare_reason(), 'нужны данные гироскопа до фильтров (INS_LOG_BAT_OPT / INS_RAW_LOG_OPT)')
    // Данные «до» есть, но не у первичного гироскопа (в лог попали не все IMU): step_gyro_sensor не находит экземпляр
    state.gyro = { have_pre: true, primary: 1, first_gyro: 0 }
    assert.equal(step3_no_compare_reason(), 'у первичного гироскопа 2 нет данных до фильтров (есть у другого) — проверьте INS_LOG_BAT_MASK')
    state.gyro = { have_pre: true, primary: null, first_gyro: 0 }
    assert.equal(step3_no_compare_reason(), 'у первичного гироскопа 1 нет данных до фильтров (есть у другого) — проверьте INS_LOG_BAT_MASK', 'без первичного — первый с данными')
    // Контур notch-базы не положителен — причина в нём, откуда бы он ни был
    step3.base = { ...notch_log, SCHED_LOOP_RATE: 0 }
    assert.equal(step3_no_compare_reason(), 'частота контура SCHED_LOOP_RATE (из лога) — 0, а нужна положительная')
    state.steps[2] = { accepted: { ...notch_log, SCHED_LOOP_RATE: -400 } }
    step3.base = state.steps[2].accepted
    assert.equal(step3_no_compare_reason(), 'частота контура SCHED_LOOP_RATE (принята на шаге 2) — -400, а нужна положительная')
    // Оценка есть — причины нет
    step3.evaluations = { log: {} }
    assert.equal(step3_no_compare_reason(), null)
})

test('step3_context_key: без размера винта; step3_calc_key — с ним; вердикт принятого не устаревает от размера винта и называет рекомендованный', () => {
    reset_page()
    const context = step3_context_key()
    assert.deepEqual(JSON.parse(context), [10, 20, 'batch:1', 2, candidate_key(notch_log)], 'интервал, FFT, версия фильтра, notch-база')
    assert.deepEqual(JSON.parse(step3_calc_key()), [...JSON.parse(context), null], 'ключ расчёта — контекст и размер винта (пусто — null)')
    document.getElementById('prop_in').value = '10'
    assert.equal(step3_context_key(), context, 'размер винта контекст не меняет')
    assert.deepEqual(JSON.parse(step3_calc_key()), [...JSON.parse(context), 10])
    document.getElementById('prop_in').value = '-3'
    assert.deepEqual(JSON.parse(step3_calc_key()), [...JSON.parse(context), null], 'непригодный размер — как пустой')
    state.settings.start = 11
    assert.notEqual(step3_context_key(), context, 'интервал меняет контекст')
    state.settings.start = 10
    state.steps[2] = { accepted: { ...notch_log, INS_HNTCH_FREQ: 90 } }
    assert.notEqual(step3_context_key(), context, 'принятый notch меняет контекст')
    state.steps[2] = { accepted: { ...notch_log, INS_GYRO_FILTER: 50 } }
    assert.notEqual(step3_context_key(), context, 'INS_GYRO_FILTER шага 2 — часть notch-базы, тоже')

    // «Принять» «Как в логе» без размера винта, затем ввод размера: принятое актуально, вердикт называет рекомендованный
    reset_page()
    step3_compute()
    state.steps[3] = {
        accepted: form_values(), candidate_id: 'log', prop_in: null, metrics: null, flags: null,
        calc_key: step3.key, context_key: step3.context_key, inputs: 'x', evaluated_at: 0,
    }
    const verdict = document.getElementById('verdict3')
    step3_render_verdict()
    assert.equal(verdict.textContent, 'Принято: «Как в логе» (без сравнения с логом). Notch — из лога (шаг 2 не принят).')
    assert.equal(verdict.className, 'verdict verdict--ok')
    document.getElementById('prop_in').value = '10'
    assert.equal(step3_stale(), true, 'варианты для нового размера считаются заново')
    step3_compute()
    assert.equal(step3.key !== state.steps[3].calc_key, true, 'ключ расчёта сменился')
    assert.equal(step3.context_key, state.steps[3].context_key, 'контекст оценки — тот же')
    step3_render_verdict()
    assert.equal(verdict.textContent, 'Принято: «Как в логе» (без сравнения с логом). Рекомендовался «По размеру винта (10″)». Notch — из лога (шаг 2 не принят).')
    assert.equal(verdict.className, 'verdict verdict--ok')
    // Принят рекомендованный — без «рекомендовался»
    step3_set_form_values(step3_rows().find((r) => r.id === 'prop').values)
    state.steps[3] = { ...state.steps[3], accepted: form_values(), candidate_id: 'prop', prop_in: 10 }
    step3_render_verdict()
    assert.equal(verdict.textContent, 'Принято: «По размеру винта (10″)» (без сравнения с логом). Notch — из лога (шаг 2 не принят).')
    // Другой контекст (принятый notch) — «Принято раньше…», размер винта в тексте не упоминается
    state.steps[2] = { accepted: { ...notch_log, INS_HNTCH_FREQ: 90 } }
    step3_compute()
    step3_render_verdict()
    assert.equal(verdict.textContent, 'Принято раньше для другого интервала, окна FFT или notch — проверьте и примите заново.')
    assert.equal(verdict.className, 'verdict verdict--warn')
})

test('step3_apply при неготовом расчёте шага 1: под оверлеем одной функцией — расчёт шага 1, варианты, значения рекомендованного в форме', async () => {
    reset_page({ prop: '10', ready: false })
    step3_apply()
    assert.equal(overlay_queue.length, 1, 'расчёт шага 1 не готов — всё под оверлеем')
    assert.equal(step3.candidates, null, 'до оверлея ничего не посчитано')
    assert.equal(document.getElementById('lpf_INS_GYRO_FILTER').value, '40', 'форма пока не тронута')
    await flush_overlay()
    assert.equal(step1_state.prepare_calls, 1, 'шаг 1 досчитан')
    assert.deepEqual(step3.candidates.map((c) => c.id), ['log', 'prop', 'half'])
    assert.equal(step3.selected_id, 'prop', 'выбор по умолчанию — рекомендованный')
    assert.equal(document.getElementById('lpf_INS_GYRO_FILTER').value, '42', 'в форме значения по размеру винта 10″')
    assert.equal(document.getElementById('lpf_ATC_RAT_RLL_FLTD').value, '21')
    assert.equal(step3_form_row()?.id, 'prop')
    assert.equal(step3.edit_prop, '10', 'правки отмечены посчитанными')
    const verdict = document.getElementById('verdict3')
    assert.match(verdict.textContent, /^Рекомендуется «По размеру винта \(10″\)»\. Меняется: INS_GYRO_FILTER 40 → 42, /, verdict.textContent)
    assert.match(verdict.textContent, / Сравнить варианты с логом нельзя: нужны данные гироскопа до фильтров \(INS_LOG_BAT_OPT \/ INS_RAW_LOG_OPT\)\. .*Значения уже в форме — нажмите «Принять»\./, verdict.textContent)
    assert.equal(document.getElementById('candidates3').hidden, false, 'таблица показана')
    assert.equal(document.getElementById('cand3_apply').disabled, false)

    // Расчёт готов — сразу, без оверлея: выбранная строка в форму
    reset_page({ prop: '10', ready: true })
    step3_compute()
    step3_redraw_all()
    step3_edit_done()
    step3.selected_id = 'half'
    step3_apply()
    assert.equal(overlay_queue.length, 0, 'без оверлея')
    assert.equal(document.getElementById('lpf_ATC_RAT_RLL_FLTD').value, '20', 'применён «Лог + правило /2»')
    assert.equal(document.getElementById('lpf_INS_GYRO_FILTER').value, '40')

    // Ошибка расчёта шага 1 — в вердикте, форма не тронута
    reset_page({ prop: '10', ready: false })
    step1_state.prepare_result = false
    step1.error = 'Нет окон FFT'
    step3_apply()
    await flush_overlay()
    assert.equal(step3.error, 'Нет окон FFT')
    const verdict_fail = document.getElementById('verdict3')
    assert.equal(verdict_fail.textContent, 'Нет окон FFT')
    assert.equal(verdict_fail.className, 'verdict verdict--fail')
    assert.equal(document.getElementById('lpf_INS_GYRO_FILTER').value, '40', 'форма не тронута')
    assert.equal(step3.candidates, null)
})
