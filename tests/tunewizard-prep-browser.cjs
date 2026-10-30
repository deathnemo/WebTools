// Браузерный тест блока «Подготовка к следующему полёту» шага 0 без лога: страница мастера и синтетический файл
// параметров tests/fixtures/prep.param (не файл пользователя), поэтому тест идёт на любом компьютере — логи не нужны.
// Проверяется: блок по файлу без лога (шаги 1–5 недоступны), список и вердикт по цели «Фильтры и PID», предложение
// положения 6 для ACRO и выбор другого, таблица положений, файл исправлений _prep.param (скачивание) и заметка о
// перезагрузке, план полёта, печать плана, цель «Фильтры» (без пунктов Acro и PID и без таблицы), цель после перезагрузки
// страницы, отказы (файл не Copter, двоичный файл), «Убрать файл», ошибок консоли нет. Ожидаемое по фикстуре проверено
// ядром core/prep.js под Node.
// Запуск: npm run test:tunewizard-prep
// Нужны: браузер (CHROME_PATH — путь к chrome.exe; без него Playwright берёт свой Chromium, если он установлен) и python
// для http.server. Файлы отказов (без ATC_RAT_RLL_P и двоичный) тест пишет во временную папку ОС и удаляет в конце
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { chromium } = require('playwright')

const repo = path.resolve(__dirname, '..')
const port = 8796
const fixture = path.join(__dirname, 'fixtures', 'prep.param')
// Ключ цели в памяти браузера (steps/prep.js, prep0_storage_key)
const goal_key = 'tunewizard_prep_goal'
// LOG_BITMASK фикстуры (без битов 0 и 12) и после исправления: | 1 (ATTITUDE_FAST) | 4096 (PID) — значение посчитано
// ядром (prep_changes) под Node
const fixture_bitmask = 176126
const fixed_bitmask = 180223
// Пункты по целям для фикстуры (prep_check): «Фильтры и PID» — без log_buffer (записи гироскопа нет — после исправления
// batch, буфер проверяется только при raw); «Фильтры» — без пунктов PID и Acro
const both_ids = ['log_backend', 'log_pid', 'log_fast', 'gyro_data', 'gyro_prepost', 'notch_source', 'acro_slot', 'acro_exit', 'acro_rate_only',
    'acro_trainer', 'fstrate', 'hover_learn']
const both_fail = ['log_pid', 'log_fast', 'gyro_data', 'acro_slot', 'acro_rate_only', 'acro_trainer']
const filters_ids = ['log_backend', 'gyro_data', 'gyro_prepost', 'notch_source', 'hover_learn']
const pid_only_ids = ['log_pid', 'log_fast', 'acro_slot', 'acro_exit', 'acro_rate_only', 'acro_trainer', 'fstrate']
// Строки файла исправлений при цели «Фильтры и PID» и положении 6 (param_file_text — по имени)
const both_lines = ['ACRO_OPTIONS,2', 'ACRO_TRAINER,0', 'FLTMODE6,1', 'INS_LOG_BAT_MASK,1', 'INS_LOG_BAT_OPT,4', 'LOG_BITMASK,' + fixed_bitmask]
const reboot_text = 'После записи перезагрузите полётный контроллер: INS_LOG_BAT_MASK, INS_LOG_BAT_OPT.'

function visible_steps(page) {
    return page.evaluate(() => [...document.querySelectorAll('section[data-step]')]
        .filter((s) => getComputedStyle(s).display !== 'none')
        .map((s) => s.dataset.step))
}

function step_buttons_disabled(page) {
    return page.evaluate(() => [...document.querySelectorAll('#wizbar button')].map((b) => b.disabled))
}

async function wait_for_server(page, url, server) {
    for (let i = 0; i < 40; i++) {
        if (server.exitCode != null) {
            throw new Error('http.server завершился с кодом ' + server.exitCode + ' (занят порт ' + port + ' или нет python?)')
        }
        try {
            await page.goto(url, { waitUntil: 'networkidle' })
            return
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 250))
        }
    }
    throw new Error('http.server не поднялся на ' + url)
}

// Выбрать файл в «Проверить .param…» и дождаться, пока блок его прочитает (prep0_read_file асинхронный): новый источник
// или новая ошибка чтения
async function pick_param(page, file) {
    await page.evaluate(() => { window.__prep_seen = [prep0_state.file, prep0_state.error] })
    await page.setInputFiles('#prep0_file', file)
    await page.waitForFunction(() => (prep0_state.file !== window.__prep_seen[0]) || ((prep0_state.error != null) && (prep0_state.error !== window.__prep_seen[1])),
                               null, { timeout: 10000 })
}

// Блок «Подготовка к следующему полёту»: видимость частей и их содержимое (скрытая часть — null); items — пункты ядра
// (prep0_context) для сверки со списком на странице; modes — строки таблицы положений [положение, PWM, режим, пометка,
// выделена]
function prep0(page) {
    return page.evaluate(() => {
        const el = (id) => document.getElementById(id)
        const seen = (id) => el(id).checkVisibility()
        const main = (td) => td.firstChild?.textContent ?? ''
        const small = (td) => td.querySelector('small')?.textContent ?? null
        const ctx = prep0_context()
        return {
            visible: seen('prep0'),
            controls: seen('prep0_controls'),
            goal: el('prep0_goal').value,
            goal_text: seen('prep0_goal_text') ? el('prep0_goal_text').textContent : null,
            source: seen('prep0_source') ? el('prep0_source').textContent : null,
            unfile: seen('prep0_unfile'),
            verdict: seen('prep0_verdict') ? el('prep0_verdict').textContent : null,
            verdict_class: el('prep0_verdict').className,
            checks: seen('prep0_checks') ? [...document.querySelectorAll('#prep0_checks .check')].map((c) => ({ status: c.className.replace('check check--', ''),
                title: c.querySelector('h3').textContent })) : null,
            items: ctx?.items?.map((item) => ({ id: item.id, status: item.status, title: item.title })) ?? null,
            slot: seen('prep0_slot_field') ? { value: el('prep0_slot').value, options: [...el('prep0_slot').options].map((o) => o.value) } : null,
            modes_head: seen('prep0_modes_head'),
            modes: seen('prep0_modes') ? [...document.querySelectorAll('#prep0_modes tbody tr')].map((tr) => [main(tr.cells[0]), main(tr.cells[1]), main(tr.cells[2]),
                small(tr.cells[2]), tr.classList.contains('recommended')]) : null,
            download: seen('prep0_actions') ? !el('prep0_download').disabled : null,
            note: seen('prep0_note') ? el('prep0_note').textContent : null,
            plan: seen('prep0_plan') ? [...document.querySelectorAll('#prep0_plan li')].map((li) => li.textContent) : null,
        }
    })
}

// Пункты по id → статус
function statuses(items) {
    return Object.fromEntries(items.map((item) => [item.id, item.status]))
}

// Скачать файл исправлений: имя и строки файла; text — для сверки с ядром
async function download_prep(page) {
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#prep0_download')])
    const text = fs.readFileSync(await download.path(), 'utf8')
    return { name: download.suggestedFilename(), text: text, lines: text.split('\n').filter((line) => line !== '') }
}

async function main() {
    const started = Date.now()
    const python = process.platform === 'win32' ? 'python' : 'python3'
    const problems = []
    let server = null
    let browser = null
    let tmp = null
    try {
        // Файлы отказов — во временной папке ОС: параметры без ATC_RAT_RLL_P (как у Plane: «не похож на параметры Copter»)
        // и несколько байтов двоичного файла (начало сообщения DataFlash — «не файл параметров ArduPilot»)
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tunewizard-prep-'))
        const plane = path.join(tmp, 'plane.param')
        fs.writeFileSync(plane, fs.readFileSync(fixture, 'utf8').split('\n').filter((line) => !line.startsWith('ATC_RAT_RLL_P,')).join('\n'))
        const binary = path.join(tmp, 'binary.bin')
        fs.writeFileSync(binary, Buffer.from([0xA3, 0x95, 0x80, 0x80, 0x59, 0x46, 0x4D, 0x54, 0x00, 0xFF, 0x0A, 0x01, 0x02]))

        server = spawn(python, ['-m', 'http.server', '--bind', '127.0.0.1', String(port)], { cwd: repo, stdio: 'ignore' })
        server.on('error', (e) => problems.push('http.server: ' + e.message))
        browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined })
        const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
        page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()) })
        page.on('pageerror', (e) => problems.push('pageerror: ' + e.message))
        const base = 'http://127.0.0.1:' + port
        await wait_for_server(page, base + '/TuneWizard/', server)

        // Без лога и файла блока нет; цель — по умолчанию «Фильтры и PID», в памяти браузера её ещё нет
        const empty = await prep0(page)
        assert.deepEqual([empty.visible, empty.goal], [false, 'both'], 'без лога и файла блок скрыт, цель по умолчанию — «Фильтры и PID»')
        assert.equal(await page.evaluate((key) => localStorage.getItem(key), goal_key), null, 'цель в памяти браузера не записана')

        // Файл без лога: блок виден, шаги 1–5 недоступны, блоков лога нет
        await pick_param(page, fixture)
        assert.deepEqual(await visible_steps(page), ['0'], 'видна только секция шага 0')
        assert.deepEqual(await step_buttons_disabled(page), [false, true, true, true, true, true], 'без лога шаги 1–5 недоступны')
        assert.deepEqual(await page.evaluate(() => ['log_verdict', 'log_info', 'log_checks', 'memory0'].filter((id) => document.getElementById(id).checkVisibility())), [],
                         'блоков лога и памяти нет')

        // Цель «Фильтры и PID»: список — пункты ядра по порядку; fail — запись PID и ATTITUDE_FAST, гироскопа, ACRO, Rate
        // Loop Only, тренер; выход из ACRO есть (положения 1–5)
        const both = await prep0(page)
        assert.deepEqual([both.visible, both.controls, both.goal, both.goal_text, both.source, both.unfile],
                         [true, true, 'both', 'шаги 1–4: висение и Acro в одном полёте', 'По файлу «prep.param».', true], 'блок по файлу, «Убрать файл» видна')
        assert.deepEqual(both.checks, both.items.map((item) => ({ status: item.status, title: item.title })), 'список на странице — пункты ядра')
        assert.deepEqual(both.items.map((item) => item.id), both_ids, 'пункты цели «Фильтры и PID»')
        assert.deepEqual(statuses(both.items), Object.fromEntries(both_ids.map((id) => [id, both_fail.includes(id) ? 'fail' : 'ok'])),
                         'fail: log_pid, log_fast, gyro_data, acro_slot, acro_rate_only, acro_trainer; остальные (и acro_exit) — ok')
        assert.deepEqual([both.verdict, both.verdict_class], ['Не готово: 6 блокирующих проблем — см. список', 'verdict verdict--fail'], 'вердикт')
        // Положение для ACRO: предложено 6; таблица — режимы сейчас, 6 станет ACRO, выход — положение 1
        assert.deepEqual(both.slot, { value: '6', options: ['', '1', '2', '3', '4', '5', '6'] }, 'поле «Положение для ACRO» предлагает 6')
        assert.equal(both.modes_head, true)
        assert.deepEqual(both.modes, [
            ['1', 'до 1230', 'STABILIZE', 'выход из ACRO', false],
            ['2', '1231–1360', 'STABILIZE', null, false],
            ['3', '1361–1490', 'STABILIZE', null, false],
            ['4', '1491–1620', 'ALT_HOLD', null, false],
            ['5', '1621–1749', 'ALT_HOLD', null, false],
            ['6', 'от 1750', 'ALT_HOLD', 'станет ACRO (файл исправлений)', true],
        ], 'таблица положений переключателя')

        // Файл исправлений: только изменения, LOG_BITMASK — биты 0 и 12 добавлены к маске файла; текст — как у ядра
        // (param_file_text от prep_changes); заметка — имя, число параметров и перезагрузка для batch
        assert.equal(both.download, true, 'есть что записать — «Скачать .param исправлений» доступна')
        const file_both = await download_prep(page)
        assert.equal(file_both.name, 'prep_prep.param', 'имя файла — имя .param + _prep.param')
        assert.deepEqual(file_both.lines, both_lines, 'строки файла исправлений')
        const bitmask = Number(file_both.lines.find((line) => line.startsWith('LOG_BITMASK,')).split(',')[1])
        assert.deepEqual([bitmask & 1, bitmask & (1 << 12), bitmask & ~(1 | (1 << 12))], [1, 1 << 12, fixture_bitmask], 'LOG_BITMASK: биты 0 и 12 включены, остальные — как в файле')
        assert.equal(file_both.text, await page.evaluate(() => {
            const ctx = prep0_context()
            return param_file_text(prep_changes(ctx.source.params, ctx.items))
        }), 'файл — param_file_text от prep_changes')
        assert.match(both.note, /^Файл prep_prep\.param: 6 параметров — /, both.note)
        assert.ok(both.note.includes('LOG_BITMASK = ' + fixed_bitmask) && both.note.includes('FLTMODE6 = 1'), both.note)
        assert.ok(both.note.endsWith(' ' + reboot_text), 'заметка называет перезагрузку: ' + both.note)

        // План: висение, затем ACRO положением 6 и выход положением 1, в конце — посадка и «Интервал — участок ACRO»
        assert.equal(both.plan.length, 5, 'пунктов плана: ' + both.plan.join(' | '))
        assert.match(both.plan[0], /^Взлёт в STABILIZE или ALT_HOLD, висение не меньше/, both.plan[0])
        assert.equal(both.plan[1], 'После висения наберите безопасную высоту и включите ACRO положением 6 (PWM от 1750).')
        assert.match(both.plan[2], /^2–3 минуты резких отклонений стиков/, both.plan[2])
        assert.equal(both.plan[3], 'Выход из ACRO — положением 1 (PWM до 1230): в Acro аппарат сам не выравнивается.')
        assert.equal(both.plan[4], 'Посадка; загрузите лог в мастер, на шаге 4 — «Интервал — участок ACRO».')

        // Другое положение для ACRO — 5: в файле FLTMODE5, план с положением 5; «— выберите —» — FLTMODE нет в файле, план
        // без положения; снова 6
        await page.selectOption('#prep0_slot', '5')
        const slot5 = await prep0(page)
        assert.deepEqual([slot5.slot.value, slot5.modes[4][3], slot5.modes[5][3], statuses(slot5.items).acro_exit], ['5', 'станет ACRO (файл исправлений)', null, 'ok'],
                         'положение 5 станет ACRO, выход остаётся')
        assert.ok(slot5.note.includes('FLTMODE5 = 1') && !slot5.note.includes('FLTMODE6'), slot5.note)
        assert.equal(slot5.plan[1], 'После висения наберите безопасную высоту и включите ACRO положением 5 (PWM 1621–1749).')
        await page.selectOption('#prep0_slot', { value: '' })
        const slot_none = await prep0(page)
        assert.equal(slot_none.slot.value, '', 'положение не выбрано')
        assert.equal(statuses(slot_none.items).acro_slot, 'fail')
        assert.ok(!slot_none.note.includes('FLTMODE'), 'без положения FLTMODE в файл не идёт: ' + slot_none.note)
        assert.match(slot_none.plan[1], /включите ACRO — положение для ACRO не выбрано/, slot_none.plan[1])
        await page.selectOption('#prep0_slot', '6')
        assert.deepEqual((await prep0(page)).note, both.note, 'снова положение 6')

        // «Печать плана» (window.print — заглушка: настоящий диалог в headless не завершается штатно): класс print-prep на
        // body и шапка печати с целью и файлом; при печати на шаге 0 — только блок подготовки с шапкой печати, без полей и
        // кнопок, на белом фоне; выход из печати (matchMedia, как без afterprint в headless) и afterprint снимают класс
        await page.evaluate(() => {
            window.__print_calls = 0
            window.print = () => { window.__print_calls++ }
        })
        await page.click('#prep0_print')
        const head = await page.evaluate(() => ({ calls: window.__print_calls, cls: document.body.classList.contains('print-prep'),
                                                   text: document.getElementById('prep0_print_head').textContent }))
        assert.deepEqual([head.calls, head.cls], [1, true], '«Печать плана» — класс print-prep и window.print')
        assert.match(head.text, /^Мастер настройки · Подготовка к полёту · цель «Фильтры и PID» · файл «prep\.param» · \d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}$/, head.text)
        const print_view = () => page.evaluate(() => {
            const seen = (el) => el.checkVisibility()
            const prep = document.getElementById('prep0')
            return {
                step0: [...document.querySelector('section[data-step="0"]').children].filter(seen).map((el) => el.id || el.className),
                head: seen(document.getElementById('prep0_print_head')),
                parts: ['prep0_source', 'prep0_verdict', 'prep0_checks', 'prep0_modes', 'prep0_plan'].filter((id) => seen(document.getElementById(id))),
                inputs: [...prep.querySelectorAll('.fld, select, input, button')].filter(seen).length,
                wizbar: seen(document.querySelector('.wizbar')),
                lede: seen(document.querySelector('.hero .lede')),
                other_steps: [...document.querySelectorAll('section[data-step]:not([data-step="0"])')].filter(seen).length,
                bg: getComputedStyle(document.body).backgroundColor,
            }
        })
        await page.emulateMedia({ media: 'print' })
        assert.deepEqual(await print_view(), { step0: ['prep0'], head: true, parts: ['prep0_source', 'prep0_verdict', 'prep0_checks', 'prep0_modes', 'prep0_plan'], inputs: 0,
                                               wizbar: false, lede: false, other_steps: 0, bg: 'rgb(255, 255, 255)' }, 'печать плана — только шапка печати и блок подготовки')
        await page.emulateMedia({ media: 'screen' })
        await page.waitForFunction(() => !document.body.classList.contains('print-prep'), null, { timeout: 3000 }).catch(() => {})
        assert.equal(await page.evaluate(() => document.body.classList.contains('print-prep')), false, 'выход из печати (matchMedia) снимает print-prep')
        await page.click('#prep0_print')
        assert.equal(await page.evaluate(() => document.body.classList.contains('print-prep')), true)
        await page.evaluate(() => window.dispatchEvent(new Event('afterprint')))
        assert.equal(await page.evaluate(() => document.body.classList.contains('print-prep')), false, 'afterprint снимает print-prep')
        // Печать без кнопки (Ctrl+P) — весь шаг 0, без шапки печати подготовки
        await page.emulateMedia({ media: 'print' })
        const ctrl_p = await print_view()
        assert.ok(ctrl_p.step0.length > 1 && ctrl_p.step0.includes('prep0') && !ctrl_p.head, 'печать без кнопки — шаг 0 целиком: ' + ctrl_p.step0.join(', '))
        await page.emulateMedia({ media: 'screen' })
        assert.equal(await page.isVisible('#prep0_print_head'), false, 'на экране шапки печати нет')

        // Цель «Фильтры»: пунктов PID и Acro, поля положения и таблицы нет; в файле — только batch; план без ACRO; цель
        // записана в память браузера
        await page.selectOption('#prep0_goal', 'filters')
        const filters = await prep0(page)
        assert.deepEqual(filters.items.map((item) => item.id), filters_ids, 'пункты цели «Фильтры»')
        assert.ok(!filters.items.some((item) => pid_only_ids.includes(item.id)), 'пунктов PID и Acro нет')
        assert.deepEqual(filters.checks, filters.items.map((item) => ({ status: item.status, title: item.title })), 'список на странице — пункты ядра')
        assert.deepEqual(statuses(filters.items), { log_backend: 'ok', gyro_data: 'fail', gyro_prepost: 'ok', notch_source: 'ok', hover_learn: 'ok' })
        assert.deepEqual([filters.verdict, filters.goal_text, filters.slot, filters.modes_head, filters.modes],
                         ['Не готово: 1 блокирующая проблема — см. список', 'шаги 1–3: висение в любом режиме', null, false, null], 'без поля положения и таблицы')
        assert.equal(filters.note, 'Файл prep_prep.param: 2 параметра — INS_LOG_BAT_MASK = 1, INS_LOG_BAT_OPT = 4. ' + reboot_text)
        assert.deepEqual((await download_prep(page)).lines, ['INS_LOG_BAT_MASK,1', 'INS_LOG_BAT_OPT,4'], 'файл цели «Фильтры» — только batch')
        assert.equal(filters.plan.length, 2, 'план — висение и посадка: ' + filters.plan.join(' | '))
        assert.ok(!filters.plan.some((text) => text.includes('ACRO')), 'в плане нет ACRO: ' + filters.plan.join(' | '))
        assert.equal(await page.evaluate((key) => localStorage.getItem(key), goal_key), 'filters', 'цель записана в память браузера')

        // Перезагрузка страницы: цель — из памяти браузера, файл не хранится — блок скрыт до повторного выбора
        await page.reload({ waitUntil: 'networkidle' })
        const reloaded = await prep0(page)
        assert.deepEqual([reloaded.visible, reloaded.goal, await page.evaluate(() => prep0_state.goal)], [false, 'filters', 'filters'], 'после перезагрузки цель «Фильтры»')
        await pick_param(page, fixture)
        assert.deepEqual((await prep0(page)).items.map((item) => item.id), filters_ids, 'файл снова — по цели «Фильтры»')
        await page.selectOption('#prep0_goal', 'both')
        assert.equal(await page.evaluate((key) => localStorage.getItem(key), goal_key), 'both')

        // Отказ: в файле нет ATC_RAT_RLL_P — не Copter: в вердикте причина, списка, таблицы, файла и плана нет; «Убрать файл»
        // видна
        await pick_param(page, plane)
        const refused = await prep0(page)
        assert.match(refused.verdict, /^Подготовка к полёту — только для Copter: файл «plane\.param» не похож на параметры Copter — нет ATC_RAT_RLL_P$/, refused.verdict)
        assert.deepEqual([refused.verdict_class, refused.source, refused.unfile, refused.checks, refused.slot, refused.modes, refused.download, refused.note, refused.plan],
                         ['verdict verdict--fail', 'По файлу «plane.param».', true, null, null, null, null, null, null], 'не Copter — без списка, файла и плана')
        assert.equal(await page.evaluate(() => prep0_summary()), null, 'не Copter — в сводку шага 5 подготовки нет')

        // Двоичный файл — не файл параметров: источник прежний (фикстура), причина — в строке источника, список тот же
        await pick_param(page, fixture)
        const before_binary = await prep0(page)
        await pick_param(page, binary)
        const after_binary = await prep0(page)
        assert.equal(after_binary.source, '«binary.bin» — это не файл параметров ArduPilot: нет строк «ИМЯ,значение». По файлу «prep.param».', after_binary.source)
        assert.deepEqual([after_binary.checks, after_binary.verdict, after_binary.note], [before_binary.checks, before_binary.verdict, before_binary.note], 'источник не изменился')
        assert.equal(await page.evaluate(() => prep0_state.file.name), 'prep.param')

        // «Убрать файл» без лога — блок скрыт; двоичный файл без источника — только причина в вердикте, без полей
        await page.click('#prep0_unfile')
        const removed = await prep0(page)
        assert.deepEqual([removed.visible, await page.evaluate(() => [prep0_state.file, prep0_state.error])], [false, [null, null]], '«Убрать файл» — блок скрыт')
        await pick_param(page, binary)
        const binary_only = await prep0(page)
        assert.deepEqual([binary_only.visible, binary_only.controls, binary_only.verdict, binary_only.verdict_class, binary_only.checks, binary_only.plan],
                         [true, false, '«binary.bin» — это не файл параметров ArduPilot: нет строк «ИМЯ,значение»', 'verdict verdict--fail', null, null],
                         'двоичный файл без источника — причина в вердикте')

        assert.deepEqual(problems, [], 'ошибки консоли')
        console.log('tunewizard-prep-browser: подготовка к полёту без лога пройдена за ' + ((Date.now() - started) / 1000).toFixed(1) + ' с; «Фильтры и PID» — «' +
            both.verdict + '», файл ' + file_both.name + ': ' + file_both.lines.join(' '))
    } catch (e) {
        if (problems.length) {
            console.error('Сообщения консоли:', problems)
        }
        throw e
    } finally {
        if (browser) {
            await browser.close()
        }
        if (server) {
            server.kill()
        }
        if (tmp) {
            fs.rmSync(tmp, { recursive: true, force: true })
        }
    }
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
