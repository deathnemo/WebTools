// Тесты общего модуля шагов мастера настройки (TuneWizard/steps/common.js) без браузера: число со знаком, число со
// словом в нужной форме, запись значения параметра и ячейка таблицы, перехват ошибок действия в вердикт, вложенный
// step_run под оверлеем внешнего, досчёт расчёта шага 1, «Открыть в …», описания параметров из метаданных (одна
// загрузка, флаг сбоя), флаг нажатой кнопки мыши, каркас механизма правок полей, контекст итога (с именами, от которых
// зависит шаг 4) и отпечаток входов принятого шага (и «устарело» без лога).
// Скрипт классический (общая глобальная область), поэтому загружается как на странице — через vm.runInThisContext
// (как в tests/tunewizard-core.test.cjs). Глобалы страницы, которые он зовёт (document, window, fetch, loading_call,
// state, html_escape, step1, step1_ready, step1_prepare, step2_param_names, step4_param_names), — заглушки ниже; модуль
// обращается к ним только при вызове.
// param_to_string — настоящий, из Libraries/Param_Helpers.js; summary_inputs_key и summary_stale (core/summary.js, с его
// зависимостями: notch_param_names, pidtune_axes), lowpass_param_names (core/lowpass.js) и hmncs_bits (core/params.js) —
// настоящие, в порядке страницы.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const repo = path.resolve(__dirname, '..')

// Элементы страницы по id: блок вердикта — объект с полями, которые пишет step_verdict. Обработчики document и window
// (флаг указателя) запоминаются по типу события — тест вызывает их сам
const elements = {}
const doc_handlers = {}
const win_handlers = {}
globalThis.document = {
    getElementById: (id) => (elements[id] ??= { className: '', textContent: '', hidden: true }),
    addEventListener: (type, fn) => { (doc_handlers[type] ??= []).push(fn) },
}
globalThis.window = { addEventListener: (type, fn) => { (win_handlers[type] ??= []).push(fn) }, open: () => null }
globalThis.html_escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
globalThis.state = { file: null }

// Оверлей загрузки: loading_call только запоминает функцию — тест сам решает, когда её выполнить
const overlay_queue = []
globalThis.loading_call = (fun) => { overlay_queue.push(fun) }

// Расчёт шага 1: готовность и досчёт задаются в каждом тесте
globalThis.step1 = { error: null }
globalThis.step1_ready = () => false
globalThis.step1_prepare = () => false

// Имена параметров шагов 2 и 4 (steps/step2.js и steps/step4.js под Node не грузятся) — тот же состав: шаг 2 —
// INS_GYRO_FILTER, SCHED_LOOP_RATE и поля обоих notch; шаг 4 — P, I, D трёх осей
globalThis.step2_param_names = () => ['INS_GYRO_FILTER', 'SCHED_LOOP_RATE', ...notch_param_names().flatMap((notch) => Object.values(notch))]
globalThis.step4_param_names = () => Object.values(pidtune_axes).flatMap((axis) => ['P', 'I', 'D'].map((k) => axis.rate + k))

// В порядке index.html: core/summary.js и то, что ему нужно (Param_Helpers.js, filters.js, pid.js и pidtune.js,
// params.js), lowpass.js (ему при загрузке — candidates.js), затем общий модуль шагов
for (const file of ['Libraries/Param_Helpers.js', 'TuneWizard/core/filters.js', 'TuneWizard/core/candidates.js', 'TuneWizard/core/lowpass.js',
                    'TuneWizard/core/pid.js', 'TuneWizard/core/pidtune.js', 'TuneWizard/core/params.js', 'TuneWizard/core/summary.js',
                    'TuneWizard/steps/common.js']) {
    const full = path.join(repo, file)
    vm.runInThisContext(fs.readFileSync(full, 'utf8'), { filename: full })
}

// Выполнить всё, что step_run поставил под оверлей (по порядку, как loading_call через два кадра)
async function flush_overlay() {
    while (overlay_queue.length > 0) {
        await overlay_queue.shift()()
    }
}

// Глубина вложенности step_run — const модуля в общей лексической области, снаружи видна только через vm
function run_depth() {
    return vm.runInThisContext('step_run_state.depth')
}

test('step_signed: знак у положительных и отрицательных, округлённый ноль — без минуса', () => {
    assert.equal(step_signed(1.234, 2), '+1.23')
    assert.equal(step_signed(-1.236, 2), '-1.24')
    assert.equal(step_signed(0, 1), '0.0')
    assert.equal(step_signed(-0.004, 2), '0.00')
    assert.equal(step_signed(0.04, 1), '0.0')
    assert.equal(step_signed(-0.05, 1), '-0.1')
})

test('step_plural: число со словом — формы для 1, 2–4 и 5+, 11–14 — как 5+', () => {
    const windows = ['окно', 'окна', 'окон']
    assert.deepEqual([0, 1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111, 112, 553, 811].map((n) => step_plural(n, windows)),
        ['0 окон', '1 окно', '2 окна', '4 окна', '5 окон', '11 окон', '12 окон', '14 окон', '21 окно', '22 окна', '25 окон',
         '101 окно', '111 окон', '112 окон', '553 окна', '811 окон'])
    const params = ['параметр', 'параметра', 'параметров']
    assert.deepEqual([1, 3, 12].map((n) => step_plural(n, params)), ['1 параметр', '3 параметра', '12 параметров'])
})

test('step_try: ошибка — «Ошибка шага N: …» в вердикт и в консоль, наружу не бросается', (t) => {
    const logged = t.mock.method(console, 'error', () => {})
    assert.doesNotThrow(() => step_try(() => { throw new Error('сбой расчёта') }, 'verdict3', 'шага 3'))
    const verdict = document.getElementById('verdict3')
    assert.equal(verdict.className, 'verdict verdict--fail')
    assert.equal(verdict.textContent, 'Ошибка шага 3: сбой расчёта')
    assert.equal(verdict.hidden, false)
    assert.equal(logged.mock.callCount(), 1)

    // Без ошибки — fn выполнена, вердикт не трогается
    const quiet = document.getElementById('verdict_quiet')
    let ran = false
    step_try(() => { ran = true }, 'verdict_quiet', 'шага 9')
    assert.equal(ran, true)
    assert.deepEqual(quiet, { className: '', textContent: '', hidden: true })
})

test('step_run: невложенный вызов — через loading_call, fn выполняется под оверлеем', async () => {
    let ran = false
    step_run(() => { ran = true }, 'verdict2', 'шага 2')
    assert.equal(overlay_queue.length, 1, 'функция поставлена под оверлей')
    assert.equal(ran, false, 'до оверлея fn не выполняется')
    await flush_overlay()
    assert.equal(ran, true)
    assert.equal(run_depth(), 0)
})

test('step_run: вложенный вызов выполняется сразу внутри внешнего, без своего loading_call', async () => {
    const order = []
    step_run(() => {
        order.push('внешний: начало')
        step_run(() => order.push('вложенный'), 'verdict3', 'шага 3')
        assert.equal(overlay_queue.length, 0, 'вложенный не ставит свой оверлей')
        order.push('внешний: конец')
    }, 'verdict2', 'шага 2')
    await flush_overlay()
    assert.deepEqual(order, ['внешний: начало', 'вложенный', 'внешний: конец'])
    assert.equal(run_depth(), 0)

    // После внешнего следующий вызов снова идёт через loading_call
    step_run(() => {}, 'verdict2', 'шага 2')
    assert.equal(overlay_queue.length, 1)
    await flush_overlay()
})

test('step_run: ошибка вложенного — в его вердикт, внешний продолжается; ошибка внешнего сбрасывает вложенность', async (t) => {
    t.mock.method(console, 'error', () => {})
    let after = false
    step_run(() => {
        step_run(() => { throw new Error('шаг 3 упал') }, 'verdict3', 'шага 3')
        after = true
        throw new Error('шаг 2 упал')
    }, 'verdict2', 'шага 2')
    await flush_overlay()
    assert.equal(after, true, 'внешний продолжился после ошибки вложенного')
    assert.equal(document.getElementById('verdict3').textContent, 'Ошибка шага 3: шаг 3 упал')
    assert.equal(document.getElementById('verdict2').textContent, 'Ошибка шага 2: шаг 2 упал')
    assert.equal(run_depth(), 0)
    step_run(() => {}, 'verdict2', 'шага 2')
    assert.equal(overlay_queue.length, 1, 'после ошибки внешнего вызов снова под своим оверлеем')
    await flush_overlay()
})

test('step_ensure_step1: null — расчёт шага 1 готов или досчитан, иначе текст ошибки', () => {
    let prepared = 0
    globalThis.step1_prepare = () => { prepared++; return false }

    globalThis.step1_ready = () => true
    assert.equal(step_ensure_step1(), null)
    assert.equal(prepared, 0, 'готовый расчёт не досчитывается')

    globalThis.step1_ready = () => false
    globalThis.step1_prepare = () => { prepared++; return true }
    assert.equal(step_ensure_step1(), null)
    assert.equal(prepared, 1)

    globalThis.step1_prepare = () => false
    step1.error = 'В логе нет данных гироскопа'
    assert.equal(step_ensure_step1(), 'В логе нет данных гироскопа')
    step1.error = null
    assert.equal(step_ensure_step1(), 'Расчёт спектра шага 1 не готов')
})

test('step_value_text: кратчайшая запись float32, нечисловое — «—»', () => {
    assert.equal(step_value_text(Math.fround(0.1163)), '0.1163')
    assert.equal(step_value_text(0.12790000438690186), '0.1279')
    assert.equal(step_value_text(400), '400')
    assert.equal(step_value_text(NaN), '—')
    assert.equal(step_value_text(null), '—')
})

test('step_cell: числовая ячейка с мелкой строкой, классом и подсказкой; текст экранируется', () => {
    assert.equal(step_cell('1.5', '+0.2', 'worse', 'запас <1>'), '<td class="num worse" title="запас &lt;1&gt;">1.5<small>+0.2</small></td>')
    assert.equal(step_cell('a&b', null, '', null), '<td class="num">a&amp;b</td>')
})

test('step_find_metadata: префиксный обход как recursive_search, null — описания нет', () => {
    const data = { ATC_: { ATC_RAT_: { ATC_RAT_RLL_P: { Description: 'P крена' }, ATC_RAT_RLL_PDMX: { Description: 'PDMX' } } }, INS_: { INS_GYRO_FILTER: { Description: 'фильтр' } } }
    assert.equal(step_find_metadata(data, 'ATC_RAT_RLL_P').Description, 'P крена')
    assert.equal(step_find_metadata(data, 'ATC_RAT_RLL_PDMX').Description, 'PDMX')
    assert.equal(step_find_metadata(data, 'INS_GYRO_FILTER').Description, 'фильтр')
    assert.equal(step_find_metadata(data, 'ATC_RAT_YAW_P'), null)
})

test('step_load_metadata: один запрос на страницу, повторный вызов — тот же промис; объект доступен step_metadata()', async () => {
    let calls = 0
    const data = { ATC_RAT_RLL_P: { Description: 'P' } }
    globalThis.fetch = async (url) => {
        calls++
        assert.equal(url, '../FilterReview/params.json')
        return { ok: true, json: async () => data }
    }
    assert.equal(step_metadata(), null)
    assert.equal(step_metadata_failed(), false, 'до загрузки — не сбой')
    const first = step_load_metadata()
    assert.equal(step_load_metadata(), first, 'тот же промис')
    assert.equal(step_metadata_failed(), false, 'пока грузятся — не сбой')
    assert.equal(await first, data)
    assert.equal(await step_load_metadata(), data)
    assert.equal(calls, 1)
    assert.equal(step_metadata(), data)
    assert.equal(step_metadata_failed(), false, 'загрузились — не сбой')
})

test('step_load_metadata: ошибка загрузки — null, флаг сбоя и предупреждение в консоль, исключения нет', async (t) => {
    const saved = vm.runInThisContext('({ ...step_metadata_state })')
    vm.runInThisContext('step_metadata_state.promise = null; step_metadata_state.data = null; step_metadata_state.failed = false')
    const warned = t.mock.method(console, 'warn', () => {})
    globalThis.fetch = async () => ({ ok: false, status: 404, statusText: 'Not Found', url: '../FilterReview/params.json' })
    const loading = step_load_metadata()
    // «Грузятся» и «не загрузились» step_metadata() не различает (null в обоих случаях) — различает флаг сбоя
    assert.equal(step_metadata_failed(), false, 'пока грузятся — не сбой')
    assert.equal(await loading, null)
    assert.equal(step_metadata(), null)
    assert.equal(step_metadata_failed(), true, 'не загрузились — сбой')
    assert.equal(warned.mock.callCount(), 1)
    assert.match(warned.mock.calls[0].arguments[0], /не загрузились.*HTTP 404 Not Found/)
    // Ошибка самого запроса (сеть) — тоже сбой
    vm.runInThisContext('step_metadata_state.promise = null; step_metadata_state.data = null; step_metadata_state.failed = false')
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch') }
    assert.equal(await step_load_metadata(), null)
    assert.equal(step_metadata_failed(), true, 'сеть недоступна — сбой')
    vm.runInThisContext('step_metadata_state.promise = null; step_metadata_state.data = null; step_metadata_state.failed = false')
    Object.assign(vm.runInThisContext('step_metadata_state'), saved)
})

test('step_open_in: без файла — ничего; вкладка не открылась — on_blocked; открылась — файл сообщением после загрузки', () => {
    const opened = []
    let blocked = 0
    window.open = (url) => { opened.push(url); return null }
    step_open_in('../PIDReview/', () => blocked++)
    assert.deepEqual(opened, [], 'без файла окно не открывается')

    state.file = { name: 'log.bin' }
    step_open_in('../PIDReview/', () => blocked++)
    assert.deepEqual(opened, ['../PIDReview/'])
    assert.equal(blocked, 1)

    const messages = []
    const listeners = {}
    globalThis.location = { origin: 'http://127.0.0.1:8000' }
    window.open = (url) => ({ addEventListener: (type, fn) => { listeners[type] = fn }, postMessage: (data, origin) => messages.push([data, origin]) })
    step_open_in('../FilterReview/', () => blocked++)
    assert.equal(blocked, 1)
    assert.deepEqual(messages, [], 'до загрузки страницы сообщения нет')
    listeners.load()
    assert.deepEqual(messages, [[{ type: 'file', data: state.file }, 'http://127.0.0.1:8000']])
    state.file = null
})

test('step_edit_controller: набор — пересчёт после паузы; change — следующей задачей, при нажатой кнопке — после отпускания', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const owner = { edit_timer: null, edit_postponed: false }
    const calls = []
    const edits = step_edit_controller(owner, { delay_ms: 400, flush: (...args) => calls.push(args.length) })
    const pointer = vm.runInThisContext('step_pointer')
    assert.equal(pointer.installed, true, 'обработчики указателя поставлены при первой подписке')
    assert.equal(doc_handlers.pointerdown.length, 1, 'один обработчик pointerdown на страницу')
    const press = () => doc_handlers.pointerdown[0]({ button: 0 })
    const release = () => doc_handlers.pointerup[0]()

    // Набор: таймер, пересчёт через 400 мс, без аргументов (force — ложно)
    edits.input()
    assert.notEqual(owner.edit_timer, null)
    t.mock.timers.tick(399)
    assert.deepEqual(calls, [])
    t.mock.timers.tick(1)
    assert.deepEqual(calls, [0])

    // change без нажатой кнопки — следующей задачей
    edits.change()
    t.mock.timers.tick(0)
    assert.deepEqual(calls, [0, 0])

    // change при нажатой кнопке — после отпускания (следующей задачей после щелчка)
    press()
    assert.equal(pointer.down, true)
    edits.change()
    assert.equal(owner.edit_postponed, true)
    t.mock.timers.tick(10)
    assert.deepEqual(calls, [0, 0], 'пока кнопка нажата — не пересчитывается')
    release()
    assert.equal(pointer.down, false)
    assert.equal(owner.edit_postponed, false)
    t.mock.timers.tick(0)
    assert.deepEqual(calls, [0, 0, 0])

    // Правая кнопка флаг не ставит; движение без нажатых кнопок и уход из окна снимают его
    doc_handlers.pointerdown[0]({ button: 2 })
    assert.equal(pointer.down, false)
    press()
    doc_handlers.pointermove[0]({ buttons: 0 })
    assert.equal(pointer.down, false)
    press()
    win_handlers.blur[0]()
    assert.equal(pointer.down, false)

    // begin: снимает таймер; при нажатой кнопке без force — откладывает и даёт false, с force — true
    edits.input()
    press()
    assert.equal(edits.begin(false), false)
    assert.equal(owner.edit_timer, null)
    assert.equal(owner.edit_postponed, true)
    assert.equal(edits.begin(true), true)
    release()
    t.mock.timers.tick(400)
    assert.deepEqual(calls, [0, 0, 0, 0], 'снятый таймер не сработал, отложенный пересчёт — один')

    // Второй контроллер — тот же флаг и те же обработчики
    step_edit_controller({ edit_timer: null, edit_postponed: false }, { delay_ms: 400, flush: () => {} })
    assert.equal(doc_handlers.pointerdown.length, 1)
})

test('step_inputs_key, step_accepted_stale: отпечаток из состояния страницы — интервал, ключ FFT и версия фильтра шага 1, отличия принятого от лога', (t) => {
    // Поля state и step1, которые тест меняет, — вернуть после него
    const saved = { settings: state.settings, spectrum: state.spectrum, steps: state.steps, params: state.params, fft_key: step1.fft_key }
    t.after(() => {
        Object.assign(state, { settings: saved.settings, spectrum: saved.spectrum, steps: saved.steps, params: saved.params })
        step1.fft_key = saved.fft_key
    })

    // Параметры лога с интерфейсом log_params; 8-битная маска HMNCS первого notch записана со знаком (−128 — гармоника 8)
    const log = { INS_GYRO_FILTER: 40, SCHED_LOOP_RATE: 400, INS_HNTCH_ENABLE: 1, INS_HNTCH_FREQ: 80, INS_HNTCH_HMNCS: -128,
                  INS_HNTC2_ENABLE: 0, INS_ACCEL_FILTER: 20, ATC_RAT_RLL_FLTT: 20, ATC_RAT_RLL_FLTD: 20, ATC_RAT_RLL_P: Math.fround(0.135) }
    // Принятое шага: по всем именам шага — значение из changes, иначе из лога, иначе 0
    const accepted_of = (names, changes = {}) => Object.fromEntries(names.map((name) => [name, (name in changes) ? changes[name] : (log[name] ?? 0)]))
    state.params = { get: (name) => log[name] ?? null, has: (name) => name in log }
    state.settings = { start: 10, end: 100 }
    state.spectrum = { filter_version: 2 }
    state.steps = []
    step1.fft_key = 'batch:1'
    assert.deepEqual(JSON.parse(step_inputs_key(2)), [10, 100, 'batch:1', 2, []])
    for (const n of [2, 3, 4]) {
        assert.equal(step_accepted_stale(n), false, 'шаг ' + n + ' не принят — не устарел')
    }

    // «Принять» по шагам. У шага 2 маска 128 — при 8 битах (версия фильтра 2) та же гармоника 8, что −128 лога: не отличие
    state.steps[2] = { accepted: accepted_of(step2_param_names(), { INS_HNTCH_FREQ: 75, INS_HNTCH_HMNCS: 128 }), inputs: step_inputs_key(2) }
    state.steps[3] = { accepted: accepted_of(lowpass_param_names(state.params), { INS_GYRO_FILTER: 42 }), inputs: step_inputs_key(3) }
    state.steps[4] = { accepted: accepted_of(step4_param_names(), { ATC_RAT_RLL_P: 0.125 }), inputs: step_inputs_key(4) }
    assert.deepEqual(JSON.parse(state.steps[3].inputs), [10, 100, 'batch:1', 2, [['INS_HNTCH_FREQ', 75]]])
    assert.deepEqual(JSON.parse(state.steps[4].inputs), [10, 100, null, null, [['INS_GYRO_FILTER', 42], ['INS_HNTCH_FREQ', 75]]])
    const fresh = () => [2, 3, 4].map((n) => step_accepted_stale(n))
    assert.deepEqual(fresh(), [false, false, false], 'сразу после «Принять» — не устарело')

    // Каждое поле состояния входит в отпечаток: опечатка в имени дала бы undefined → null, и смена прошла бы незаметно.
    // Версия фильтра 3 — ещё и 32-битная маска HMNCS (hmncs_bits от той же версии): 128 и −128 уже разные, у шага 2
    // появляется отличие — устаревает и шаг 4. [поле, сменить, вернуть, устарело ли у шагов 2, 3, 4]
    const cases = [
        ['state.settings.start', () => { state.settings.start = 20 }, () => { state.settings.start = 10 }, [true, true, true]],
        ['state.settings.end', () => { state.settings.end = 90 }, () => { state.settings.end = 100 }, [true, true, true]],
        ['step1.fft_key', () => { step1.fft_key = 'batch:3' }, () => { step1.fft_key = 'batch:1' }, [true, true, false]],
        ['state.spectrum.filter_version', () => { state.spectrum.filter_version = 3 }, () => { state.spectrum.filter_version = 2 }, [true, true, true]],
        ['state.params', () => { log.INS_HNTCH_FREQ = 75 }, () => { log.INS_HNTCH_FREQ = 80 }, [false, true, true]],
        ['state.steps[2].accepted', () => { state.steps[2].accepted.INS_HNTCH_FREQ = 70 }, () => { state.steps[2].accepted.INS_HNTCH_FREQ = 75 }, [false, true, true]],
        ['state.steps[3].accepted', () => { state.steps[3].accepted.INS_GYRO_FILTER = 39 }, () => { state.steps[3].accepted.INS_GYRO_FILTER = 42 }, [false, false, true]],
        // Шаг 4 зависит только от фильтров (step_depends4_names): FLTD шага 3 — да, FLTT и INS_ACCEL_FILTER шага 3 и
        // SCHED_LOOP_RATE шага 2 — нет (у шага 3 списка нет: SCHED_LOOP_RATE его устаревшим делает)
        ['state.steps[3].accepted (FLTD)', () => { state.steps[3].accepted.ATC_RAT_RLL_FLTD = 25 }, () => { state.steps[3].accepted.ATC_RAT_RLL_FLTD = 20 }, [false, false, true]],
        ['state.steps[3].accepted (FLTT)', () => { state.steps[3].accepted.ATC_RAT_RLL_FLTT = 30 }, () => { state.steps[3].accepted.ATC_RAT_RLL_FLTT = 20 }, [false, false, false]],
        ['state.steps[3].accepted (INS_ACCEL_FILTER)', () => { state.steps[3].accepted.INS_ACCEL_FILTER = 15 }, () => { state.steps[3].accepted.INS_ACCEL_FILTER = 20 }, [false, false, false]],
        ['state.steps[2].accepted (SCHED_LOOP_RATE)', () => { state.steps[2].accepted.SCHED_LOOP_RATE = 800 }, () => { state.steps[2].accepted.SCHED_LOOP_RATE = 400 }, [false, true, false]],
    ]
    for (const [field, change, restore, stale] of cases) {
        change()
        assert.deepEqual(fresh(), stale, field + ': устаревание шагов 2, 3, 4')
        restore()
        assert.deepEqual(fresh(), [false, false, false], field + ': вернули — не устарело')
    }

    // Шаг 3 «Как в логе» после шага 4 — то же, что не принят: принятое шага 4 не устарело
    state.steps[3] = null
    state.steps[4].inputs = step_inputs_key(4)
    state.steps[3] = { accepted: accepted_of(lowpass_param_names(state.params)) }
    state.steps[3].inputs = step_inputs_key(3)
    assert.deepEqual(fresh(), [false, false, false], 'шаг 3 принят «Как в логе» — шаг 4 не устарел')

    // Контекст итога и отпечатка — один построитель: версия фильтра и размер маски HMNCS — от state.spectrum.filter_version
    const ctx = step_summary_context()
    assert.equal(ctx.filter_version, 2)
    assert.equal(ctx.bits, 8, 'версия фильтра 2, в логе нет INS_RAW_LOG_OPT — маска HMNCS 8 бит')
    assert.equal(step_hmncs_bits(), ctx.bits, 'размер маски — один помощник у итога и блока «Прошлый проход»')
    assert.equal(ctx.steps, state.steps)
    assert.equal(ctx.params, state.params)
    assert.deepEqual([ctx.start, ctx.end, ctx.fft_key], [10, 100, 'batch:1'])
    // Имена, от которых зависит шаг 4, — только у шага 4: поля обоих notch, INS_GYRO_FILTER, FLTE и FLTD трёх осей; без
    // SCHED_LOOP_RATE, FLTT, INS_ACCEL_FILTER, пределов ускорения и коэффициентов
    assert.deepEqual(Object.keys(ctx.depends), ['4'])
    assert.deepEqual([...ctx.depends[4]].sort(), [...notch_param_names().flatMap((notch) => Object.values(notch)), 'INS_GYRO_FILTER',
        'ATC_RAT_RLL_FLTE', 'ATC_RAT_RLL_FLTD', 'ATC_RAT_PIT_FLTE', 'ATC_RAT_PIT_FLTD', 'ATC_RAT_YAW_FLTE', 'ATC_RAT_YAW_FLTD'].sort())
    for (const name of ['SCHED_LOOP_RATE', 'ATC_RAT_RLL_FLTT', 'INS_ACCEL_FILTER', 'ATC_ACCEL_R_MAX', 'ATC_ACC_R_MAX', 'ATC_RAT_RLL_P']) {
        assert.ok(!ctx.depends[4].includes(name), name)
    }
})

test('step_accepted_stale: без лога и для непринятого шага — false', () => {
    const saved = { settings: state.settings, spectrum: state.spectrum, steps: state.steps, params: state.params }
    try {
        // Как после reset(): лога нет (state.params null), принятого нет
        state.params = null
        state.steps = []
        state.settings = { start: 0, end: 0 }
        state.spectrum = { filter_version: null }
        for (const n of [2, 3, 4]) {
            assert.equal(step_accepted_stale(n), false, 'шаг ' + n + ' без лога — не устарел')
        }
        // Шаг не принят (null или нет записи), а у другого шага принятое есть — тоже false
        state.steps = [undefined, undefined, { accepted: {}, inputs: 'x' }, null]
        assert.equal(step_accepted_stale(3), false, 'шаг 3 не принят (null) — не устарел')
        assert.equal(step_accepted_stale(4), false, 'шаг 4 не принят (нет записи) — не устарел')
    } finally {
        Object.assign(state, saved)
    }
})
