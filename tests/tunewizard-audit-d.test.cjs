// Тесты правок аудита области D шага 4 (TuneWizard/steps/step4.js) без браузера: коэффициенты, сменившиеся после
// интервала анализа (I-2: «Набор интервала», подписи «в наборе интервала», предупреждения, set_values принятого),
// кнопка «Интервал — участок ACRO» (I-3: целые секунды внутри участка, подсказка в сводке и вердикте), «Применить
// вариант» одним step_run (M-5), плитка «Шум D» без окон в интервале (M-6), заметки NTF и PDMX (M-7), FFT только нужных
// компонент (M-8), отказ «не заполнены или не числа» (M-10).
// Скрипты классические (общая глобальная область) — загружаются как на странице через vm.runInThisContext (как в
// tests/tunewizard-common.test.cjs); DOM, оверлей, память, шаги 0–1 и 5 — заглушки ниже. Лог — поддельный PIDR
// (первый порядок с запаздыванием, цель — две синусоиды) с двумя наборами PARM: смена P и I после последних данных.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const repo = path.resolve(__dirname, '..')
globalThis.FFTJS = require('../modules/fft.js/lib/fft.js')

// ---------------------------------------------------------------- заглушки страницы

// Элементы по id: поля формы — value, блоки — textContent/innerHTML/hidden, дочерние по селектору — свои объекты
const elements = {}
function element(id) {
    if (elements[id] == null) {
        const children = {}
        elements[id] = {
            id, className: '', textContent: '', innerHTML: '', hidden: true, disabled: false, value: '', tabIndex: 0,
            addEventListener() {}, setAttribute() {}, removeAttribute() {}, focus() {}, contains: () => false,
            querySelector: (selector) => (children[selector] ??= { textContent: '', innerHTML: '', className: '', title: '' }),
        }
    }
    return elements[id]
}
// p.param формы шага 4: dataset и подпись .inlog (step4_render_inlog, step4_mark_changed)
const form_params = []
globalThis.document = {
    getElementById: element,
    querySelectorAll: (selector) => (selector === '#pidf_form p.param') ? form_params : [],
    addEventListener() {},
    activeElement: null,
}
globalThis.window = { addEventListener() {} }
globalThis.html_escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
// Оверлей загрузки: loading_call только ставит функцию в очередь — тест сам выполняет её
const overlay_queue = []
globalThis.loading_call = (fun) => { overlay_queue.push(fun) }
async function flush_overlay() {
    while (overlay_queue.length > 0) {
        await overlay_queue.shift()()
    }
}
globalThis.memory_show = () => {}
globalThis.set_step = () => {}
// Реестр графиков (plots.js не грузится): графиков нет — plot_clear общего модуля ничего не делает
globalThis.plot = () => null
globalThis.render_plot = () => {}
globalThis.step1 = { fft_key: null, error: null }
globalThis.step1_ready = () => true
globalThis.step1_prepare = () => true
// Фильтры гироскопа лога (steps/step1.js не грузится): постоянные — поправки фильтров нет
globalThis.values_from_log = () => ({ INS_GYRO_FILTER: 40, SCHED_LOOP_RATE: 400 })
globalThis.step2_param_names = () => ['INS_GYRO_FILTER', 'SCHED_LOOP_RATE']
globalThis.state = {
    file_name: null, log: null, version: null, params: null, info: null, settings: { start: 0, end: 0, min: null, max: null, window_size: 1024 },
    step: 4, steps: [], spectrum: { filter_version: null }, gyro: null, tracking: null, env: null, file: null,
}

for (const file of ['Libraries/Array_Math.js', 'Libraries/fft.js', 'Libraries/Param_Helpers.js', 'TuneWizard/core/log.js', 'TuneWizard/core/gyro.js',
                    'TuneWizard/core/tracking/Atmosphere_model.js', 'TuneWizard/core/tracking/BaseClass.js', 'TuneWizard/core/tracking/Static.js',
                    'TuneWizard/core/tracking/Throttle.js', 'TuneWizard/core/tracking/RPM.js', 'TuneWizard/core/tracking/ESC.js',
                    'TuneWizard/core/tracking/FFT.js', 'TuneWizard/core/tracking/Logged.js', 'TuneWizard/core/filters.js', 'TuneWizard/core/spectrum.js',
                    'TuneWizard/core/metrics.js', 'TuneWizard/core/autofit.js', 'TuneWizard/core/candidates.js', 'TuneWizard/core/lowpass.js',
                    'TuneWizard/core/pid.js', 'TuneWizard/core/pidtune.js', 'TuneWizard/core/params.js', 'TuneWizard/core/summary.js',
                    'TuneWizard/core/passmem.js', 'TuneWizard/steps/common.js', 'TuneWizard/steps/step4.js']) {
    const full = path.join(repo, file)
    vm.runInThisContext(fs.readFileSync(full, 'utf8'), { filename: full })
}

// ---------------------------------------------------------------- поддельный лог

const R2D = 180 / Math.PI
const RATE_HZ = 400

// Поддельный лог с интерфейсом парсера: messages = { ИМЯ: { поле: массив } }, params = [[имя, значение, время с], ...]
function fake_log({ messages = {}, params = [] } = {}) {
    const types = { ...messages }
    if (params.length > 0) {
        types.PARM = { TimeUS: params.map((p) => Math.round((p[2] ?? 0) * 1e6)), Name: params.map((p) => p[0]), Value: params.map((p) => p[1]) }
    }
    return {
        messageTypes: Object.fromEntries(Object.keys(types).map((name) => [name, {}])),
        get(name, field) {
            const msg = types[name]
            if (msg == null) return undefined
            return field ? msg[field] : msg
        },
    }
}

// Параметры крена на 0.5 с: P 0.1, I 0.1, D 0.003, фильтры, NTF 1 и PDMX 0.5 (заметки M-7)
function roll_params(t = 0.5) {
    return [['ATC_RAT_RLL_P', 0.1, t], ['ATC_RAT_RLL_I', 0.1, t], ['ATC_RAT_RLL_D', 0.003, t], ['ATC_RAT_RLL_FF', 0, t], ['ATC_RAT_RLL_FLTD', 20, t],
            ['ATC_RAT_RLL_FLTE', 0, t], ['ATC_RAT_RLL_FLTT', 20, t], ['ATC_RAT_RLL_NTF', 1, t], ['ATC_RAT_RLL_PDMX', 0.5, t],
            ['ACRO_OPTIONS', 2, t], ['ACRO_TRAINER', 0, t], ['SCHED_LOOP_RATE', 400, t], ['INS_GYRO_FILTER', 40, t]]
}

// Лог: PIDR 0…dur_s с (цель — случайные уровни ±50…200 °/с по 0.3–1 с, сглаженные 20 мс — широкополосная, как стики
// тестового полёта; факт — первый порядок 40 мс), ACRO с 0 с, параметры крена на 0.5 с и смена P, I на 0.12
// в change_s (после данных — набор без данных, как сохранение AutoTune при дизарме)
function make_log(dur_s = 60, change_s = 100) {
    const n = Math.round(dur_s * RATE_HZ)
    const TimeUS = new Array(n)
    const tar = new Array(n)
    const act = new Array(n)
    let seed = 7
    const rnd = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        return seed / 4294967296
    }
    const smooth = 1 - Math.exp(-1 / (RATE_HZ * 0.02))
    const a = 1 - Math.exp(-1 / (RATE_HZ * 0.04))
    let level = 0
    let next = 0
    let req = 0
    let y = 0
    for (let k = 0; k < n; k++) {
        if (k >= next) {
            level = ((rnd() < 0.5) ? -1 : 1) * (50 + 150 * rnd()) / R2D
            next = k + Math.round((0.3 + 0.7 * rnd()) * RATE_HZ)
        }
        TimeUS[k] = Math.round(k / RATE_HZ * 1e6)
        req += smooth * (level - req)
        tar[k] = req
        y += a * (tar[k] - y)
        act[k] = y
    }
    const zero = new Array(n).fill(0)
    return fake_log({
        messages: {
            PIDR: { TimeUS, Tar: tar, Act: act, Err: tar.map((v, k) => v - act[k]), P: zero, I: zero, D: zero, FF: zero },
            MODE: { TimeUS: [0], Mode: [1] },
            VER: { Maj: [4], Min: [6], Pat: [3] },
        },
        params: [...roll_params(), ['ATC_RAT_RLL_P', 0.12, change_s], ['ATC_RAT_RLL_I', 0.12, change_s]],
    })
}

// Загрузить лог в состояние страницы и шага, посчитать шаг на интервале range (step4_compute — как step4_show)
function load(log, range) {
    globalThis.state.log = log
    globalThis.state.params = log_params(log)
    globalThis.state.version = { fw_string: 'ArduCopter V4.6.3 (abcdef12)' }
    globalThis.state.info = { build_type: 2 }
    globalThis.state.settings = { start: range[0], end: range[1], min: 0, max: 60, window_size: 1024 }
    globalThis.state.steps = []
    step4_reset()
    step4.pid = load_pid(log, { build_type: 2 })
    step4_compute()
}

// Поля формы — значения лога (как step4_fill_form, без разметки): элементы pidf_<имя> и список p.param
function fill_form() {
    form_params.length = 0
    for (const axis of step4_axis_list) {
        for (const k of step4_gain_keys) {
            const name = pidtune_axes[axis].rate + k
            const span = { textContent: '' }
            form_params.push({ dataset: { name, axis }, classList: { toggle() {} }, querySelector: () => span })
        }
    }
    step4_set_form_values(step4_log_values())
    step4_render_inlog()
    step4.filled = true
    step4_edit_done()
}

function inlog(name) {
    return form_params.find((p) => p.dataset.name === name).querySelector('.inlog').textContent
}

// ---------------------------------------------------------------- тесты

test('I-2: смена PID после интервала — набор интервала, «Набор интервала», подписи и предупреждения, set_values принятого', async () => {
    load(make_log(60, 100), [10, 50])
    const res = step4.calc.roll
    assert.equal(step4.error, null)
    assert.equal(res.sets.length, 1, 'набор после данных (без данных) в интервал не входит')
    assert.equal(res.set_index, 0)
    assert.ok(step4_same_value(res.gains.P, 0.1), 'коэффициенты набора интервала: P ' + res.gains.P)
    assert.equal(res.status, 'ok', 'синтетика проходит проверки: ' + (res.rule?.reason ?? ''))
    // FFT — только нужных шагу компонент (M-8)
    assert.deepEqual(Object.keys(res.source.sets[0].FFT).sort(), ['Act', 'D', 'Out', 'Tar', 'time'])

    const after = step4_gains_after(res)
    assert.deepEqual(after.changed, ['P', 'I'])
    assert.ok(step4_same_value(after.end.P, 0.12) && step4_same_value(after.end.I, 0.12) && step4_same_value(after.end.D, 0.003))
    assert.equal(step4_gains_after(step4.calc.pitch), null, 'ось без данных — коэффициенты и так конца лога')
    assert.deepEqual(step4_axes_changed_after(), ['roll'])
    assert.equal(res.candidates[0].id, 'log')
    assert.equal(res.candidates[0].title, 'Набор интервала')
    assert.equal(step4.calc.pitch.candidates[0].title, 'Как в логе')

    // set_values — набор анализа (float32), оси без параметров — null
    const set_values = step4_set_values()
    assert.deepEqual([set_values.ATC_RAT_RLL_P, set_values.ATC_RAT_RLL_I, set_values.ATC_RAT_RLL_D], [Math.fround(0.1), Math.fround(0.1), Math.fround(0.003)])
    assert.equal(set_values.ATC_RAT_PIT_P, null)
    assert.equal(Object.keys(set_values).length, 9)

    // Подписи формы
    fill_form()
    assert.equal(inlog('ATC_RAT_RLL_P'), 'в наборе интервала: 0.1 (в конце лога 0.12)')
    assert.equal(inlog('ATC_RAT_RLL_D'), 'в наборе интервала: 0.003')
    assert.equal(inlog('ATC_RAT_PIT_P'), 'в логе нет')

    // Вердикт оси и сводка
    step4.axis = 'roll'
    step4_render_axis_verdict()
    const verdict = element('axis_verdict4')
    assert.match(verdict.textContent, /После интервала анализа параметры менялись: в конце лога P = 0\.12, I = 0\.12, D = 0\.003 \(в наборе интервала P = 0\.1, I = 0\.1, D = 0\.003\)\. Принятое перепишет значения конца лога\./)
    assert.match(verdict.textContent, /Прогноз недостоверен|Предлагается «По правилам»/)
    assert.equal(verdict.className, 'verdict verdict--warn')
    step4_render_summary()
    const summary = element('verdict4')
    assert.match(summary.textContent, /^Предлагается: крен — /)
    assert.match(summary.textContent, / PID крена менялись после интервала анализа — принятое перепишет значения конца лога \(подробности — во вкладках осей\)\.$/)
    assert.equal(summary.className, 'verdict verdict--warn')
    // Таблица: название строки и оценка
    step4_render_candidates()
    const tbody = element('candidates4').querySelector('tbody').innerHTML
    assert.ok(tbody.includes('>Набор интервала</label>'), tbody.slice(0, 300))
    assert.ok(tbody.includes('набор интервала (в конце лога другие значения)'), 'оценка строки лога')
    assert.ok(!tbody.includes('Как в логе'))

    // «Принять»: пустые поля тангажа и рыскания — отказ «не заполнены или не числа» (M-10); заполнены — set_values в итоге
    globalThis.step4_redraw_all = () => {}
    step4_accept()
    await flush_overlay()
    assert.equal(summary.textContent, 'Принять нельзя — не заполнены или не числа поля: ATC_RAT_PIT_P, ATC_RAT_PIT_I, ATC_RAT_PIT_D, ATC_RAT_YAW_P, ATC_RAT_YAW_I, ATC_RAT_YAW_D.')
    assert.equal(state.steps[4], undefined)
    for (const name of step4_param_names()) {
        if (element('pidf_' + name).value === '') {
            element('pidf_' + name).value = '0.05'
        }
    }
    step4_edit_done()
    step4_accept()
    await flush_overlay()
    const accepted = state.steps[4]
    assert.ok(accepted != null, 'принято')
    assert.equal(accepted.accepted.ATC_RAT_RLL_P, Math.fround(0.1))
    assert.deepEqual(accepted.set_values, set_values)
    assert.equal(accepted.axes.roll.candidate_id, 'log')
})

test('I-2: смена PID внутри интервала — набор интервала и есть конец лога: «Как в логе», предупреждения нет', () => {
    load(make_log(60, 30), [10, 50])
    const res = step4.calc.roll
    assert.equal(res.sets.length, 2)
    assert.equal(res.set_index, 1, 'набор, действующий в конце интервала')
    assert.ok(step4_same_value(res.gains.P, 0.12), 'коэффициенты второго набора: P ' + res.gains.P)
    assert.equal(step4_gains_after(res), null)
    assert.equal(res.candidates[0].title, 'Как в логе')
    assert.deepEqual(step4_axes_changed_after(), [])
    fill_form()
    assert.equal(inlog('ATC_RAT_RLL_P'), 'в логе: 0.12')
    step4.axis = 'roll'
    step4_render_axis_verdict()
    assert.ok(!element('axis_verdict4').textContent.includes('После интервала анализа'))
    step4_render_summary()
    assert.ok(!element('verdict4').textContent.includes('менялись после интервала'))
})

test('I-3: «Интервал — участок ACRO» — целые секунды внутри участка, подсказка в сводке и вердикте один раз, кнопка ставит поля шага 0', () => {
    load(make_log(60, 100), [10, 50])
    const res = step4.calc.roll
    assert.equal(step4_acro_interval(), null, 'Rate Loop Only во всём интервале — участка нет')
    assert.equal(step4_acro_hint(), null)
    // Участок 20.3–300.7 с → 21–300; ровно на секундах — как есть; короче секунды после округления — нет
    res.mode.rate_only_segment = { start: 20.3, end: 300.7 }
    assert.deepEqual(step4_acro_interval(), { start: 21, end: 300 })
    assert.equal(step4_acro_hint(), 'лог тестового полёта: сузьте интервал анализа до участка ACRO (21–300 с) — кнопка «Интервал — участок ACRO» под сводкой шага')
    assert.match(step4_acro_hint(true), /^Лог тестового полёта: /)
    res.mode.rate_only_segment = { start: 20, end: 300 }
    assert.deepEqual(step4_acro_interval(), { start: 20, end: 300 })
    res.mode.rate_only_segment = { start: 20.2, end: 20.9 }
    assert.equal(step4_acro_interval(), null)

    // Смешанный интервал: подсказка в вердикте оси один раз (смешение режимов + совет), в сводке — вместо тестового полёта
    res.mode.rate_only_segment = { start: 20.3, end: 300.7 }
    res.mode.rate_only = false
    res.mode.mixed_modes = ['STABILIZE', 'ACRO', 'LAND']
    res.status = 'unreliable'
    res.quality = { ...res.quality, ok: false, reasons: ['половины данных дают разный отклик: RMS 0.05 (порог 0.035)'] }
    step4.axis = 'roll'
    step4_render_axis_verdict()
    const verdict = element('axis_verdict4').textContent
    assert.equal((verdict.match(/сузьте интервал анализа до участка ACRO \(21–300 с\)/g) ?? []).length, 1, verdict)
    assert.ok(!verdict.includes('Слетайте тестовый лог'), verdict)
    step4_render_summary()
    const summary = element('verdict4').textContent
    assert.match(summary, /лог тестового полёта: сузьте интервал анализа до участка ACRO \(21–300 с\) — кнопка «Интервал — участок ACRO» под сводкой шага/)
    assert.ok(!summary.includes('нужен тестовый полёт'), summary)
    // Без участка — прежний совет (с ACRO_TRAINER = 0, I-4)
    res.mode.rate_only_segment = null
    step4_render_axis_verdict()
    assert.match(element('axis_verdict4').textContent, /Слетайте тестовый лог: Acro с ACRO_OPTIONS бит 1 «Rate Loop Only» \(значение 2, или 3 вместе с Air-mode\) и ACRO_TRAINER = 0/)
    step4_render_summary()
    assert.match(element('verdict4').textContent, /нужен тестовый полёт: Acro с ACRO_OPTIONS «Rate Loop Only» \(2, или 3 с Air-mode\) и ACRO_TRAINER = 0/)

    // Кнопка: поля шага 0, interval_input_changed, пересчёт шага
    res.mode.rate_only_segment = { start: 20.3, end: 300.7 }
    const calls = []
    globalThis.interval_input_changed = () => calls.push(['interval', element('TimeStart').value, element('TimeEnd').value])
    const shown = globalThis.step4_show
    globalThis.step4_show = () => calls.push(['show'])
    step4_acro_apply()
    assert.deepEqual(calls, [['interval', 21, 300], ['show']])
    res.mode.rate_only_segment = null
    step4_acro_apply()
    assert.equal(calls.length, 2, 'без участка кнопка ничего не делает')
    globalThis.step4_show = shown
})

test('M-5: «Применить вариант» — один step_run, при устаревшем расчёте пересчёт внутри него', async () => {
    load(make_log(60, 100), [10, 50])
    fill_form()
    globalThis.step4_redraw_all = () => {}
    step4.axis = 'roll'
    // «P −10 %» — своя строка (у вялого отклика «P +10 %» совпадает с «По правилам» и строки p_plus нет)
    const p_minus = step4_rows('roll').find((r) => r.id === 'p_minus')
    assert.ok(p_minus != null, 'строка «P −10 %» есть: ' + step4_rows('roll').map((r) => r.id).join(', '))
    step4.selected.roll = 'p_minus'
    overlay_queue.length = 0
    step4_apply()
    assert.equal(overlay_queue.length, 1, 'один оверлей')
    await flush_overlay()
    assert.equal(element('pidf_ATC_RAT_RLL_P').value, param_to_string(p_minus.values.P))
    assert.equal(step4_form_row('roll').id, 'p_minus')
    assert.equal(overlay_queue.length, 0)
    // Расчёт устарел (другой ключ): досчёт правок с пересчётом — внутри того же step_run
    step4.selected.roll = 'log'
    step4.key = 'устарел'
    step4_apply()
    assert.equal(overlay_queue.length, 1, 'один оверлей и при устаревшем расчёте')
    await flush_overlay()
    assert.notEqual(step4.key, 'устарел', 'расчёт пересчитан')
    assert.equal(element('pidf_ATC_RAT_RLL_P').value, '0.1')
    assert.equal(step4_form_row('roll').id, 'log')
    assert.equal(overlay_queue.length, 0)
})

test('M-6: шум D — только по окнам интервала: без отрезков, окон или окон FFT в интервале плитка «—», «горячих моторов» нет', () => {
    load(make_log(60, 100), [10, 50])
    const res = step4.calc.roll
    assert.ok(res.d_noise != null)
    assert.equal(step4_d_noise_in(res), res.d_noise)
    assert.equal(step4_d_noise_in({ ...res, seg: null }), null)
    assert.equal(step4_d_noise_in({ ...res, seg: { ...res.seg, windows: 0 } }), null)
    assert.equal(step4_d_noise_in({ ...res, range: [70, 80] }), null, 'окон FFT в интервале нет')
    const hot = { dB: -30, rms: 0.03, off: false, over: true, windows: 1 }
    step4.axis = 'roll'
    step4.calc.roll = { ...res, seg: null, status: 'little', d_noise: hot }
    step4_render_metrics()
    const tiles = element('metrics4').innerHTML
    assert.ok(tiles.includes('Шум D &gt; 50 Гц</span><span class="stat__v">—</span><span class="stat__s">нет окон в интервале</span>'), tiles)
    step4_render_axis_verdict()
    assert.ok(!element('axis_verdict4').textContent.includes('горячие моторы'))
    assert.equal(step4_metrics_summary('roll', null).d_noise_dB, null)
    // С окнами — число и предупреждение
    step4.calc.roll = { ...res, d_noise: hot }
    step4_render_metrics()
    assert.ok(element('metrics4').innerHTML.includes('<span class="stat__v">-30.0 дБ</span>'))
    step4_render_axis_verdict()
    assert.match(element('axis_verdict4').textContent, /Шум D выше 50 Гц -30\.0 дБ — выше порога -40 дБ: горячие моторы/)
    assert.equal(step4_metrics_summary('roll', null).d_noise_dB, -30)
})

test('M-7: заметки NTF и PDMX — по образцу NEF и SMAX', () => {
    load(make_log(60, 100), [10, 50])
    step4.axis = 'roll'
    step4_render_warnings()
    const lines = element('warnings4').innerHTML.split('<br>')
    assert.ok(lines.some((l) => l.startsWith('Notch-фильтр цели ПИД (ATC_RAT_RLL_NTF = 1) в модели регулятора не учтён: цель в логе записана после него')), lines.join(' | '))
    assert.ok(lines.some((l) => l.startsWith('Ограничитель суммы P + D ATC_RAT_RLL_PDMX = 0.5 не моделируется')), lines.join(' | '))
    assert.ok(!lines.some((l) => l.includes('NEF')), 'NEF в логе нет — заметки нет')
})

test('M-10: отказ «Принять» — «не заполнены или не числа», отрицательные — отдельно', () => {
    const values = Object.fromEntries(step4_param_names().map((name) => [name, 0.1]))
    assert.equal(step4_accept_refusal(values), null)
    assert.equal(step4_accept_refusal({ ...values, ATC_RAT_RLL_P: NaN }), 'Принять нельзя — не заполнены или не числа поля: ATC_RAT_RLL_P.')
    assert.equal(step4_accept_refusal({ ...values, ATC_RAT_PIT_I: NaN, ATC_RAT_YAW_D: -1 }),
                 'Принять нельзя — не заполнены или не числа поля: ATC_RAT_PIT_I; отрицательные значения: ATC_RAT_YAW_D.')
})
