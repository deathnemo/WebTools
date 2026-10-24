// Тесты общего модуля шагов мастера настройки (TuneWizard/steps/common.js) без браузера: число со знаком,
// перехват ошибок действия в вердикт, вложенный step_run под оверлеем внешнего, досчёт расчёта шага 1.
// Скрипт классический (общая глобальная область), поэтому загружается как на странице — через vm.runInThisContext
// (как в tests/tunewizard-core.test.cjs). Глобалы страницы, которые он зовёт (document, loading_call, step1,
// step1_ready, step1_prepare), — заглушки ниже; модуль обращается к ним только при вызове.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const repo = path.resolve(__dirname, '..')

// Элементы страницы по id: блок вердикта — объект с полями, которые пишет step_verdict
const elements = {}
globalThis.document = {
    getElementById: (id) => (elements[id] ??= { className: '', textContent: '', hidden: true }),
}

// Оверлей загрузки: loading_call только запоминает функцию — тест сам решает, когда её выполнить
const overlay_queue = []
globalThis.loading_call = (fun) => { overlay_queue.push(fun) }

// Расчёт шага 1: готовность и досчёт задаются в каждом тесте
globalThis.step1 = { error: null }
globalThis.step1_ready = () => false
globalThis.step1_prepare = () => false

const common = path.join(repo, 'TuneWizard', 'steps', 'common.js')
vm.runInThisContext(fs.readFileSync(common, 'utf8'), { filename: common })

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
