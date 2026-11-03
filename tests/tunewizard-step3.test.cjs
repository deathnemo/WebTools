// Тесты шага 3 мастера настройки (TuneWizard/steps/step3.js) без браузера — то, что не зависит от расчёта спектра:
// значения формы при первом заполнении с INS_GYRO_FILTER шага 2 и заметка о нём, отказ «Принять» (пустые поля,
// отрицательные частоты и пределы ускорения), причина «сравнить нельзя» (нет данных «до» вовсе или у первичного
// гироскопа), ключ контекста оценки без размера винта и вердикт принятого (не устаревает от размера винта, называет
// рекомендованный вариант), «Применить вариант» при неготовом расчёте шага 1 — под оверлеем одной функцией.
// QuadPlane (этап 9): форма, Kd, отказы и заметки с именами Q_A_* (пределы Q_A_ACCEL_* и Q_A_ACC_*), без блока размера
// винта и варианта по нему, вердикт без рекомендации, описания Q_A_<X> по ATC_<X>, ось Z и подпись D у tailsitter.
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

// В порядке index.html: ядро (vehicle.js — профили аппаратов; lowpass.js при загрузке нужен candidates.js, common.js —
// summary.js и его зависимости), общий модуль шагов, шаг 3
for (const file of ['Libraries/Param_Helpers.js', 'TuneWizard/core/vehicle.js', 'TuneWizard/core/filters.js', 'TuneWizard/core/candidates.js',
                    'TuneWizard/core/lowpass.js', 'TuneWizard/core/pid.js', 'TuneWizard/core/pidtune.js', 'TuneWizard/core/params.js', 'TuneWizard/core/summary.js',
                    'TuneWizard/steps/common.js', 'TuneWizard/steps/step3.js']) {
    const full = path.join(repo, file)
    vm.runInThisContext(fs.readFileSync(full, 'utf8'), { filename: full })
}

// Страница с загруженным логом params (объект имя → значение): интервал 10–20 с, версия фильтра 2, данных гироскопа
// «до» нет (have_pre), принято только step2 (запись state.steps[2] или null); форма шага 3 построена и заполнена
// (step3_initial_values), поле размера винта — prop (строка, '' — пусто); состояние шага 3 — как после step3_reset.
// Расчёт шага 1 — ready. profile — профиль аппарата лога (state.profile; null — как у страницы без вида: Copter)
function reset_page({ params = user_log, prop = '', ready = true, step2 = null, profile = null } = {}) {
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
        log: {}, params: fake_params(params), profile: profile, settings: { start: 10, end: 20 }, spectrum: { filter_version: 2 },
        gyro: { have_pre: false, primary: 0, first_gyro: 0 }, env: {}, tracking: [], steps: steps,
    }
    step3_reset()
    step3.form_names = lowpass_param_names(state.params, state.profile)
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

// ---------- QuadPlane (этап 9, дизайн docs/plans/2026-10-30-tune-wizard-stage9-design.md, раздел 6) ----------

// Значения третьего лога (ArduPlane 4.6.3, tailsitter QUAD/X): регулятор Q_A_*, пределы Q_A_ACCEL_* в сантиградусах/с²
const qp_log = {
    INS_GYRO_FILTER: 40, INS_ACCEL_FILTER: 20,
    Q_A_RAT_RLL_FLTT: 25.5, Q_A_RAT_RLL_FLTE: 0, Q_A_RAT_RLL_FLTD: 25.5,
    Q_A_RAT_PIT_FLTT: 25.5, Q_A_RAT_PIT_FLTE: 0, Q_A_RAT_PIT_FLTD: 25.5,
    Q_A_RAT_YAW_FLTT: 25.5, Q_A_RAT_YAW_FLTE: 2, Q_A_RAT_YAW_FLTD: 0,
    Q_A_ACCEL_R_MAX: 70000, Q_A_ACCEL_P_MAX: 70000, Q_A_ACCEL_Y_MAX: 28800,
    Q_A_RAT_RLL_D: 0.003, Q_A_RAT_PIT_D: 0.0028, Q_FRAME_CLASS: 1, Q_TAILSIT_ENABLE: 2,
}
const quadplane = () => vehicle_profiles.quadplane

// Значения третьего лога без имён names
function qp_log_without(...names) {
    return Object.fromEntries(Object.entries(qp_log).filter(([name]) => !names.includes(name)))
}

test('QuadPlane: форма и Kd — Q_A_*; блока размера винта нет, размер в поле варианта не даёт; таблица — FLTD / FLTT Q_A_*', () => {
    reset_page({ params: qp_log, profile: quadplane(), prop: '10' })
    assert.deepEqual(step3.form_names, lowpass_param_names(state.params, quadplane()))
    assert.equal(step3.form_names.some((name) => name.startsWith('ATC_')), false, 'ни одного имени Copter')
    assert.equal(document.getElementById('lpf_Q_A_RAT_RLL_FLTD').value, '25.5', 'форма — значения лога Q_A_*')
    assert.equal(document.getElementById('lpf_Q_A_ACCEL_R_MAX').value, '70000')
    assert.deepEqual(step3_kd(), { roll: 0.003, pitch: 0.0028 })

    // Блок размера винта скрыт, вместо него — заметка; размер из памяти браузера (поле) в расчёт не идёт
    assert.equal(document.getElementById('prop_lab').hidden, true)
    assert.equal(document.getElementById('step3_vehicle_note').hidden, false)
    assert.equal(document.getElementById('prop_hint').hidden, true)
    assert.equal(step3_prop_size(), null)
    assert.equal(JSON.parse(step3_calc_key()).at(-1), null, 'ключ расчёта — без размера винта')
    step3_compute()
    assert.deepEqual(step3.candidates.map((c) => c.id), ['log', 'half'])
    assert.equal(step3_recommended_id(), null, 'рекомендации нет')
    assert.equal(step3.selected_id, 'log', 'выбор по умолчанию — «Как в логе»')
    assert.deepEqual(step3.candidates[1].values, {
        ...lowpass_log_values(state.params, quadplane()),
        Q_A_RAT_RLL_FLTT: 20, Q_A_RAT_RLL_FLTD: 20, Q_A_RAT_PIT_FLTT: 20, Q_A_RAT_PIT_FLTD: 20, Q_A_RAT_YAW_FLTT: 20,
    }, '«Лог + правило /2» — FLTT и FLTD 20')

    step3_render_candidates()
    const body = document.getElementById('candidates3').querySelector('tbody').innerHTML
    assert.match(body, /<td class="num">25\.5 \/ 25\.5<\/td>/, 'FLTD / FLTT лога — из Q_A_*')
    assert.match(body, /<td class="num">20 \/ 20<\/td>/, 'FLTD / FLTT правила /2')
    assert.doesNotMatch(body, /рекомендуется/)
    const note = document.getElementById('candidates3_note').textContent
    assert.doesNotMatch(note, /Введите размер винта/)
    assert.match(note, /Шум D крена VTOL — по оси Z гироскопа, тангажа — по оси Y\. /)
    assert.match(note, /рыскание и пределы ускорения — без метрик, пределы — из лога \(формулы у QuadPlane нет\), правятся в форме\./)

    // Новый лог Copter: блок размера винта — снова виден (step3_reset → step3_render_prop)
    reset_page({ prop: '10' })
    assert.equal(document.getElementById('prop_lab').hidden, false)
    assert.equal(document.getElementById('step3_vehicle_note').hidden, true)
    assert.equal(step3_prop_size(), 10)
})

test('QuadPlane: вердикт без рекомендации — «Лог + правило /2» против лога; совпал с логом; фильтр гироскопа выключен; принятое', () => {
    reset_page({ params: qp_log, profile: quadplane() })
    step3_compute()
    step3_render_verdict()
    // Блок вердикта — заново после каждого reset_page: он пересоздаёт элементы страницы
    const verdict = () => document.getElementById('verdict3')
    assert.equal(verdict().textContent, 'Рекомендации нет: формулы по размеру винта для QuadPlane нет — выбор за вами. «Лог + правило /2» против лога. ' +
        'Меняется: Q_A_RAT_RLL_FLTT 25.5 → 20, Q_A_RAT_RLL_FLTD 25.5 → 20, Q_A_RAT_PIT_FLTT 25.5 → 20, Q_A_RAT_PIT_FLTD 25.5 → 20, Q_A_RAT_YAW_FLTT 25.5 → 20. ' +
        'Сравнить варианты с логом нельзя: нужны данные гироскопа до фильтров (INS_LOG_BAT_OPT / INS_RAW_LOG_OPT). Чтобы взять его, выберите его в таблице и ' +
        'нажмите «Применить вариант», затем «Принять»; чтобы оставить лог — «Принять» со значениями «Как в логе». Notch — из лога (шаг 2 не принят).')
    assert.equal(verdict().className, 'verdict verdict--warn', 'без сравнения с логом — ВНИМ')
    // Значения варианта уже в форме
    step3_set_form_values(step3.candidates[1].values)
    step3_render_verdict()
    assert.match(verdict().textContent, / Его значения уже в форме — нажмите «Принять»\. Notch — из лога/)
    // В форме «Свой» (не лог и не вариант): оставить лог — вернуть его значения «Применить вариант», как в ветке «совпадают»
    step3_set_form_values({ ...step3.candidates[0].values, Q_A_ACCEL_R_MAX: 60000 })
    step3_update_custom()
    assert.equal(step3_form_row()?.id, 'custom')
    step3_render_verdict()
    assert.match(verdict().textContent, /; чтобы оставить лог — выберите «Как в логе» и нажмите «Применить вариант», затем «Принять» \(в форме сейчас другие значения\)\. Notch — из лога/)

    // Правило /2 совпало с логом — менять нечего
    reset_page({ params: { ...qp_log, Q_A_RAT_RLL_FLTT: 20, Q_A_RAT_RLL_FLTD: 20, Q_A_RAT_PIT_FLTT: 20, Q_A_RAT_PIT_FLTD: 20, Q_A_RAT_YAW_FLTT: 20 }, profile: quadplane() })
    step3_compute()
    step3_render_verdict()
    assert.match(verdict().textContent, /^Рекомендации нет: формулы по размеру винта для QuadPlane нет — выбор за вами\. Значения лога совпадают с «Лог \+ правило \/2» — менять нечего\. Сравнить/)
    assert.equal(verdict().className, 'verdict verdict--ok')

    // Фильтр гироскопа выключен — варианта /2 нет
    reset_page({ params: { ...qp_log, INS_GYRO_FILTER: 0 }, profile: quadplane() })
    step3_compute()
    step3_render_verdict()
    assert.match(verdict().textContent, /Варианта «Лог \+ правило \/2» нет: фильтр гироскопа в логе выключен \(INS_GYRO_FILTER 0\) — свои значения задайте в форме\./)

    // Принято «Как в логе» — без «Рекомендовался»
    reset_page({ params: qp_log, profile: quadplane() })
    step3_compute()
    state.steps[3] = {
        accepted: form_values(), candidate_id: 'log', prop_in: null, metrics: null, flags: null,
        calc_key: step3.key, context_key: step3.context_key, inputs: 'x', evaluated_at: 0,
    }
    step3_render_verdict()
    assert.equal(verdict().textContent, 'Принято: «Как в логе» (без сравнения с логом). Notch — из лога (шаг 2 не принят).')
})

test('QuadPlane: отказ «Принять», заметки Kd и NEF — имена Q_A_*; описания Q_A_<X> — ATC_<X>, у Q_A_ACCEL_* — сантиградусы', () => {
    reset_page({ params: qp_log, profile: quadplane() })
    assert.equal(step3_accept_refusal({ ...form_values(), Q_A_ACCEL_R_MAX: -5 }), 'Принять нельзя — отрицательные пределы ускорения: Q_A_ACCEL_R_MAX.')
    assert.equal(step3_accept_refusal({ ...form_values(), Q_A_RAT_PIT_FLTD: -1 }), 'Принять нельзя — отрицательные частоты: Q_A_RAT_PIT_FLTD.')
    // Новые имена пределов (4.7+, °/с²); чего нет в логе — заводское QuadPlane
    reset_page({ params: { ...qp_log_without('Q_A_ACCEL_R_MAX', 'Q_A_ACCEL_P_MAX', 'Q_A_ACCEL_Y_MAX'), Q_A_ACC_R_MAX: 700 }, profile: quadplane() })
    assert.deepEqual(step3.form_names.slice(-3), ['Q_A_ACC_R_MAX', 'Q_A_ACC_P_MAX', 'Q_A_ACC_Y_MAX'])
    assert.equal(document.getElementById('lpf_Q_A_ACC_P_MAX').value, '400', 'нет в логе — заводское QuadPlane 400 °/с²')
    assert.equal(step3_accept_refusal({ ...form_values(), Q_A_ACC_Y_MAX: -1 }), 'Принять нельзя — отрицательные пределы ускорения: Q_A_ACC_Y_MAX.')

    // Заметки: NEF ≠ 0, D выключен, нет Kd
    reset_page({ params: { ...qp_log_without('Q_A_RAT_PIT_D'), Q_A_RAT_RLL_NEF: 1, Q_A_RAT_RLL_D: 0 }, profile: quadplane() })
    step3_render_warnings()
    assert.deepEqual(document.getElementById('warnings3').innerHTML.split('<br>'), [
        'Notch-фильтр ошибки ПИД крена (Q_A_RAT_RLL_NEF = 1) стоит до FLTE и не учтён в шуме D и задержке',
        'D крена выключен (Q_A_RAT_RLL_D = 0): шум D и путь D крена не сравниваются.',
        'Нет Q_A_RAT_PIT_D в логе — неполные данные: шум D тангажа не оценивается.',
    ])
    assert.equal(step3_d_off_reason('roll', 0), 'D выключен (Q_A_RAT_RLL_D = 0)')
    assert.equal(step3_d_absent_reason('pitch', null), 'в логе нет Q_A_RAT_PIT_D')

    // Описания: метаданные FilterReview — только ATC_*; у Q_A_<X> — описание ATC_<X>, у старых пределов — ACC_ с cdeg/s/s
    step_metadata_state.data = {
        ATC_: {
            ATC_ACC_R_MAX: { Description: 'Maximum acceleration in roll axis', Units: 'deg/s/s' },
            ATC_RAT_RLL_FLTD: { Description: 'Roll axis rate controller derivative frequency in Hz', Units: 'Hz' },
        },
    }
    try {
        assert.deepEqual(step3_param_metadata('Q_A_RAT_RLL_FLTD'), { Description: 'Roll axis rate controller derivative frequency in Hz', Units: 'Hz' })
        assert.deepEqual(step3_param_metadata('Q_A_ACC_R_MAX'), { Description: 'Maximum acceleration in roll axis', Units: 'deg/s/s' })
        assert.deepEqual(step3_param_metadata('Q_A_ACCEL_R_MAX'), { Description: 'Maximum acceleration in roll axis', Units: 'cdeg/s/s' })
        assert.deepEqual(step3_param_metadata('ATC_ACCEL_R_MAX'), { Description: 'Maximum acceleration in roll axis', Units: 'cdeg/s/s' }, 'Copter — как раньше')
        assert.equal(step3_param_metadata('Q_A_RAT_YAW_FLTD'), null, 'нет и у ATC_ — нет')
        assert.equal(step_find_metadata(step_metadata_state.data, 'Q_M_THST_HOVER'), null, 'подменяется только префикс регулятора')
    } finally {
        step_metadata_state.data = null
    }
})

test('QuadPlane tailsitter: подпись оси D — «Крен VTOL (Z)», тангаж — «Тангаж», цвет — оси Z; обычный QuadPlane и Copter — «Крен», ось X', () => {
    reset_page({ params: qp_log, profile: quadplane() })
    assert.deepEqual([step3_axis_label('roll'), step3_axis_label('pitch')], ['Крен VTOL (Z)', 'Тангаж'])
    assert.deepEqual(step3_axes(), { roll: { param: 'RLL', gyro: 'z' }, pitch: { param: 'PIT', gyro: 'y' } })
    // Цвет трасс D (крен: лог и выбранный, тангаж: лог и выбранный) — цвет оси гироскопа
    const data = [0, 1, 2, 3].map(() => ({ line: {} }))
    const palette = { axis: { x: 'X', y: 'Y', z: 'Z' } }
    dterm3_theme(palette, data, {})
    assert.deepEqual(data.map((trace) => trace.line.color), ['Z', 'Z', 'Y', 'Y'])

    reset_page({ params: { ...qp_log, Q_TAILSIT_ENABLE: 0 }, profile: quadplane() })
    assert.deepEqual([step3_axis_label('roll'), step3_axis_label('pitch')], ['Крен', 'Тангаж'])
    reset_page()
    assert.deepEqual([step3_axis_label('roll'), step3_axis_label('pitch')], ['Крен', 'Тангаж'])
    dterm3_theme(palette, data, {})
    assert.deepEqual(data.map((trace) => trace.line.color), ['X', 'X', 'Y', 'Y'])
})
