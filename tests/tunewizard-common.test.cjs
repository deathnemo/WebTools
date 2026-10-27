// Тесты общего модуля шагов мастера настройки (TuneWizard/steps/common.js) без браузера: число со знаком, запись
// значения параметра и ячейка таблицы, перехват ошибок действия в вердикт, вложенный step_run под оверлеем внешнего,
// досчёт расчёта шага 1, «Открыть в …», описания параметров из метаданных (одна загрузка), флаг нажатой кнопки мыши,
// каркас механизма правок полей и отпечаток входов принятого шага. Скрипт классический (общая глобальная область),
// поэтому загружается как на странице — через vm.runInThisContext (как в tests/tunewizard-core.test.cjs). Глобалы
// страницы, которые он зовёт (document, window, fetch, loading_call, state, html_escape, step1, step1_ready,
// step1_prepare), — заглушки ниже; модуль обращается к ним только при вызове. param_to_string — настоящий, из
// Libraries/Param_Helpers.js; summary_inputs_key и summary_stale — настоящие, из core/summary.js (с его зависимостями,
// в порядке страницы).
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

// В порядке index.html: core/summary.js и то, что ему нужно (Param_Helpers.js, filters.js, pid.js и pidtune.js,
// params.js), затем общий модуль шагов
for (const file of ['Libraries/Param_Helpers.js', 'TuneWizard/core/filters.js', 'TuneWizard/core/pid.js', 'TuneWizard/core/pidtune.js',
                    'TuneWizard/core/params.js', 'TuneWizard/core/summary.js', 'TuneWizard/steps/common.js']) {
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
    const first = step_load_metadata()
    assert.equal(step_load_metadata(), first, 'тот же промис')
    assert.equal(await first, data)
    assert.equal(await step_load_metadata(), data)
    assert.equal(calls, 1)
    assert.equal(step_metadata(), data)
})

test('step_load_metadata: ошибка загрузки — null и предупреждение в консоль, исключения нет', async (t) => {
    const saved = vm.runInThisContext('({ ...step_metadata_state })')
    vm.runInThisContext('step_metadata_state.promise = null; step_metadata_state.data = null')
    const warned = t.mock.method(console, 'warn', () => {})
    globalThis.fetch = async () => ({ ok: false, status: 404, statusText: 'Not Found', url: '../FilterReview/params.json' })
    assert.equal(await step_load_metadata(), null)
    assert.equal(step_metadata(), null)
    assert.equal(warned.mock.callCount(), 1)
    assert.match(warned.mock.calls[0].arguments[0], /не загрузились.*HTTP 404 Not Found/)
    vm.runInThisContext('step_metadata_state.promise = null; step_metadata_state.data = null')
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

test('step_inputs_key, step_accepted_stale: отпечаток входов из состояния страницы — интервал, ключ FFT и версия фильтра шага 1, принятое шагов', () => {
    state.settings = { start: 10, end: 100 }
    state.spectrum = { filter_version: 2 }
    state.steps = []
    step1.fft_key = 'batch:1'
    assert.deepEqual(JSON.parse(step_inputs_key(2)), [10, 100, 'batch:1', 2, []])
    for (const n of [2, 3, 4]) {
        assert.equal(step_accepted_stale(n), false, 'шаг ' + n + ' не принят — не устарел')
    }

    // «Принять» по шагам: отпечаток — до записи state.steps[n], у шага n — от принятого шагов < n
    state.steps[2] = { accepted: { INS_HNTCH_FREQ: 80, INS_HNTCH_ATT: 33 } }
    state.steps[2].inputs = step_inputs_key(2)
    state.steps[3] = { accepted: { INS_GYRO_FILTER: 42 }, inputs: step_inputs_key(3) }
    state.steps[4] = { accepted: { ATC_RAT_RLL_P: 0.125 }, inputs: step_inputs_key(4) }
    assert.deepEqual(JSON.parse(state.steps[3].inputs), [10, 100, 'batch:1', 2, [[['INS_HNTCH_ATT', 33], ['INS_HNTCH_FREQ', 80]]]])
    assert.deepEqual(JSON.parse(state.steps[4].inputs), [10, 100, null, null, [[['INS_HNTCH_ATT', 33], ['INS_HNTCH_FREQ', 80]], [['INS_GYRO_FILTER', 42]]]])
    const fresh = () => [2, 3, 4].map((n) => step_accepted_stale(n))
    assert.deepEqual(fresh(), [false, false, false], 'сразу после «Принять» — не устарело')

    // Каждое поле состояния входит в отпечаток: опечатка в имени дала бы undefined → null, и смена прошла бы незаметно.
    // [поле, сменить, вернуть, устарело ли у шагов 2, 3, 4]
    const cases = [
        ['state.settings.start', () => { state.settings.start = 20 }, () => { state.settings.start = 10 }, [true, true, true]],
        ['state.settings.end', () => { state.settings.end = 90 }, () => { state.settings.end = 100 }, [true, true, true]],
        ['step1.fft_key', () => { step1.fft_key = 'batch:3' }, () => { step1.fft_key = 'batch:1' }, [true, true, false]],
        ['state.spectrum.filter_version', () => { state.spectrum.filter_version = 4 }, () => { state.spectrum.filter_version = 2 }, [true, true, false]],
        ['state.steps[2].accepted', () => { state.steps[2].accepted.INS_HNTCH_ATT = 40 }, () => { state.steps[2].accepted.INS_HNTCH_ATT = 33 }, [false, true, true]],
        ['state.steps[3].accepted', () => { state.steps[3].accepted.INS_GYRO_FILTER = 39 }, () => { state.steps[3].accepted.INS_GYRO_FILTER = 42 }, [false, false, true]],
    ]
    for (const [field, change, restore, stale] of cases) {
        change()
        assert.deepEqual(fresh(), stale, field + ': устаревание шагов 2, 3, 4')
        restore()
        assert.deepEqual(fresh(), [false, false, false], field + ': вернули — не устарело')
    }

    // Принятое без отпечатка — устарело
    delete state.steps[3].inputs
    assert.equal(step_accepted_stale(3), true)
    step1.fft_key = null
})
