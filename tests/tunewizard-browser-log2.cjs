// Прогон мастера настройки на втором логе — другом аппарате, которого нет в основном браузерном тесте: ArduCopter 4.7.2,
// версия фильтра 4, raw-гироскоп (GYR, ≈ 2 кГц, поток рвётся каждую секунду — LOG_FILE_BUFSIZE 8), полёт в STABILIZE,
// ACRO_OPTIONS 3, имена пределов ускорения ATC_ACC_*. Шаги 0–5 проходятся без «Принять»: проверяется то, что на тестовом
// логе 4.6 (batch, ESC-телеметрия, ATC_ACCEL_*) не проверить, и блок «Прошлый проход» для аппарата, прохода которого в
// памяти нет (список для выбора вручную). Отдельный скрипт, чтобы не удлинять основной прогон (tests/tunewizard-browser.cjs).
// Запуск: npm run test:tunewizard-log2
// Нужны: второй лог (TUNEWIZARD_LOG2 или TuneWizard/logs/1 01.01.1970 2-00-00.bin), браузер (CHROME_PATH — путь к
// chrome.exe; без него Playwright берёт свой Chromium, если он установлен) и python для http.server. Без лога тест
// пропускается с сообщением
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { chromium } = require('playwright')

const repo = path.resolve(__dirname, '..')
const logs_dir = path.join(repo, 'TuneWizard', 'logs')
const port = 8795
const log2_name = '1 01.01.1970 2-00-00.bin'
// Строка полётного контроллера тестового лога основного теста — проход «другого аппарата» в памяти
const test_board = 'StellarH7V2 0034002E 35335104 39363630'
const fc_key = 'fc:' + test_board

function find_log() {
    if (process.env.TUNEWIZARD_LOG2) {
        return process.env.TUNEWIZARD_LOG2
    }
    const full = path.join(logs_dir, log2_name)
    return fs.existsSync(full) ? full : null
}

function visible_steps(page) {
    return page.evaluate(() => [...document.querySelectorAll('section[data-step]')]
        .filter((s) => getComputedStyle(s).display !== 'none')
        .map((s) => s.dataset.step))
}

function wait_overlay(page) {
    return page.waitForFunction(() => document.getElementById('loading').style.visibility === 'hidden', null, { timeout: 180000 })
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

// Блок «Прошлый проход» шага 0: видимость, подпись, список, строки таблицы, вердикт, проход в memory_state
function memory0(page) {
    return page.evaluate(() => {
        const seen = (id) => document.getElementById(id).checkVisibility()
        const select = document.getElementById('memory0_pick')
        return {
            visible: seen('memory0'),
            head: seen('memory0_head') ? document.getElementById('memory0_head').textContent : null,
            verdict: seen('memory0_verdict') ? document.getElementById('memory0_verdict').textContent : null,
            rows: seen('memory0_table') ? [...document.querySelectorAll('#memory0_table tbody tr')].map((tr) => [...tr.cells].map((td) => td.textContent)) : null,
            pick: seen('memory0_pick_field') ? { value: select.value, options: [...select.options].map((o) => o.value) } : null,
            forget: seen('memory0_forget') ? document.getElementById('memory0_forget').textContent : null,
            key: memory_state.key,
            pass: memory_state.pass?.key ?? null,
        }
    })
}

async function main() {
    const log_path = find_log()
    if (log_path == null) {
        console.log('tunewizard-browser-log2: второй лог не найден (TUNEWIZARD_LOG2 или TuneWizard/logs/' + log2_name + ') — пропуск')
        return
    }
    const python = process.platform === 'win32' ? 'python' : 'python3'
    const problems = []
    let server = null
    let browser = null
    try {
        server = spawn(python, ['-m', 'http.server', '--bind', '127.0.0.1', String(port)], { cwd: repo, stdio: 'ignore' })
        server.on('error', (e) => problems.push('http.server: ' + e.message))
        browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined })
        const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
        page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()) })
        page.on('pageerror', (e) => problems.push('pageerror: ' + e.message))
        const base = 'http://127.0.0.1:' + port
        await wait_for_server(page, base + '/TuneWizard/', server)

        // В памяти — проход тестового лога (другой аппарат): после загрузки второго лога его проход не найден, но память
        // не пуста — список для выбора вручную
        await page.evaluate(([key, board]) => {
            const record = { key: key, board: board, frame: 'QUAD/X_REV', fw: 'ArduCopter V4.6.3', file_name: 'прошлый.bin', saved_at: Date.now() - 86400000,
                             changed: [{ name: 'INS_GYRO_FILTER', log: 40, value: 42, step: 3 }, { name: 'ATC_ACCEL_R_MAX', log: 90000, value: 110000, step: 3 }],
                             estimates: null }
            localStorage.setItem('tunewizard_v1', JSON.stringify({ version: 1, passes: { [key]: record } }))
        }, [fc_key, test_board])

        // Шаг 0: лог другого аппарата, raw-гироскоп — поле окна FFT доступно
        await page.setInputFiles('#fileItem', log_path)
        await page.locator('#log_verdict').waitFor({ state: 'visible', timeout: 180000 })
        await wait_overlay(page)
        assert.deepEqual(await visible_steps(page), ['0'])
        const info = await page.evaluate(() => ({ board: state.info.board, fw: state.info.fw_string, vehicle: state.info.vehicle, version: state.spectrum.filter_version,
                                                   raw: 'GYR' in state.log.messageTypes, batch: ('ISBH' in state.log.messageTypes) && ('ISBD' in state.log.messageTypes),
                                                   acro_options: state.params.get('ACRO_OPTIONS'), acc: state.params.has('ATC_ACC_R_MAX'), accel: state.params.has('ATC_ACCEL_R_MAX'),
                                                   window: state.settings.window_size }))
        assert.notEqual(info.board, test_board, 'другой аппарат: ' + info.board)
        assert.match(info.board, /^StellarH7V2 /, 'та же плата, другой номер процессора: ' + info.board)
        assert.match(info.fw, /^ArduCopter V4\.7\.2/, info.fw)
        assert.deepEqual([info.vehicle, info.version, info.raw, info.batch, info.acro_options, info.acc, info.accel, info.window], ['Copter', 4, true, false, 3, true, false, 1024],
                         'Copter 4.7.2: версия фильтра 4, только raw-гироскоп, ACRO_OPTIONS 3, пределы ускорения ATC_ACC_*')
        assert.equal(await page.isDisabled('#FFTWindow_size'), false, 'raw-лог: поле окна FFT шага 0 доступно')
        assert.equal(await page.inputValue('#FFTWindow_size'), '1024')
        assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#wizbar button')].map((b) => b.disabled)), [false, false, false, false, false, false],
                         'после загрузки доступны все шаги')

        // Блок «Прошлый проход»: прохода этого аппарата нет, а проход другого есть — список без выбора с подписью; выбор —
        // таблица чужого прохода («нет в логе» для ATC_ACCEL_R_MAX: здесь имя ATC_ACC_R_MAX); память пуста — блока нет
        const m0 = await memory0(page)
        assert.deepEqual([m0.visible, m0.head, m0.pick, m0.rows, m0.verdict, m0.forget, m0.pass, m0.key],
                         [true, 'Проход этого аппарата не найден — выбрать другой (например, после замены полётного контроллера).', { value: '', options: ['', fc_key] },
                          null, null, null, null, 'fc:' + info.board], 'список проходов без выбора')
        await page.selectOption('#memory0_pick', fc_key)
        const picked = await memory0(page)
        assert.deepEqual([picked.pass, picked.rows.map((cells) => [cells[0], cells[4]]), picked.forget],
                         [fc_key, [['INS_GYRO_FILTER', 'другое значение'], ['ATC_ACCEL_R_MAX', 'нет в логе']], 'Забыть выбранный проход'], 'выбран проход другого аппарата')
        assert.match(picked.verdict, /^Применено 0 из 2\.$/)
        await page.evaluate(() => {
            localStorage.removeItem('tunewizard_v1')
            memory_render_step0()
        })
        assert.deepEqual((await memory0(page)).visible, false, 'память пуста — блока «Прошлый проход» нет')

        // Шаг 1: raw-лог — поле «Окон на пакет» скрыто, спектр и пики есть, ключ FFT — окно raw
        await page.click('#wizbar button:nth-child(2)')
        await wait_overlay(page)
        const s1 = await page.evaluate(() => {
            const spectrum = document.getElementById('Spectrum1')
            return {
                ready: step1_ready(), fft_key: step1.fft_key, error: step1.error,
                with_data: spectrum.data.filter((t) => (t.y != null) && (t.y.length > 0)).length,
                visible: spectrum.data.filter((t) => t.visible === true).map((t) => t.name),
                peaks: document.querySelectorAll('#peaks1 tbody tr').length,
                verdict: document.getElementById('verdict1').textContent, verdict_class: document.getElementById('verdict1').className,
                batch_field: document.getElementById('spec_batch_field').hidden, raw_note: document.getElementById('spec_raw_note').hidden,
                have_pre: state.gyro.have_pre, have_post: state.gyro.have_post, window_disabled: document.getElementById('FFTWindow_size').disabled,
                info: document.getElementById('spec_info').textContent,
            }
        })
        assert.deepEqual([s1.ready, s1.fft_key, s1.error, s1.batch_field, s1.raw_note, s1.window_disabled], [true, 'raw:1024', null, true, false, false],
                         'raw-лог: расчёт готов, поле окон на пакет скрыто, окно FFT шага 0 доступно')
        assert.ok((s1.with_data >= 3) && (s1.visible.length >= 3), 'спектр с данными: ' + s1.with_data + ', видны ' + s1.visible.join(', '))
        assert.equal(s1.have_pre, true, 'есть данные гироскопа до фильтров — шаги 2–3 сравнивают варианты')
        // Записанного «после» нет — видна оценка «после»; есть — оценка в легенде (как в FilterReview)
        assert.equal(s1.visible.some((name) => name.includes('оценка')), !s1.have_post, 'оценка «после» видна только без записанного «после»: ' + s1.visible.join(', '))
        assert.match(s1.verdict_class, /verdict--(ok|warn)/, s1.verdict)
        assert.match(s1.verdict, /Гц/, s1.verdict)
        assert.match(s1.info, /дискретизация 19\d\d\.\d\d Гц/, 'частота дискретизации raw около 2 кГц: ' + s1.info)
        // Поток GYR рвётся каждую секунду: окно 2048 (≈ 1.03 с при 1986 Гц) не помещается ни в один кусок — окон FFT нет,
        // вердикт об этом; окно 1024 — снова расчёт
        await page.click('#wizbar button:nth-child(1)')
        await page.fill('#FFTWindow_size', '2048')
        await page.dispatchEvent('#FFTWindow_size', 'change')
        assert.equal(await page.evaluate(() => state.settings.window_size), 2048)
        await page.click('#wizbar button:nth-child(2)')
        await wait_overlay(page)
        const s2048 = await page.evaluate(() => ({ fft_key: step1.fft_key, verdict: document.getElementById('verdict1').textContent, cls: document.getElementById('verdict1').className,
                                                    with_data: document.getElementById('Spectrum1').data.filter((t) => (t.y != null) && (t.y.length > 0)).length }))
        assert.equal(s2048.fft_key, 'raw:2048')
        assert.deepEqual([s2048.cls, s2048.with_data], ['verdict verdict--fail', 0], 'окно 2048 — окон FFT нет: ' + s2048.verdict)
        assert.match(s2048.verdict, /окон FFT/, s2048.verdict)
        await page.click('#wizbar button:nth-child(1)')
        await page.fill('#FFTWindow_size', '1024')
        await page.dispatchEvent('#FFTWindow_size', 'change')
        await page.click('#wizbar button:nth-child(2)')
        await wait_overlay(page)
        assert.deepEqual(await page.evaluate(() => [step1.fft_key, step1_ready()]), ['raw:1024', true], 'окно 1024 — расчёт снова есть')

        // Шаг 2: без ESC-телеметрии текущие настройки лучше вариантов; ESCMSK виден (версия фильтра 4)
        await page.click('#wizbar button:nth-child(3)')
        await wait_overlay(page)
        await page.waitForFunction(() => (document.querySelector('label[for="INS_HNTCH_MODE"]') != null) && step2.form_ready && (step2.ranking != null), null, { timeout: 60000 })
        const v2 = await page.evaluate(() => ({
            verdict: document.getElementById('verdict2').textContent, verdict_class: document.getElementById('verdict2').className, best: step2.ranking.best_id,
            titles: [...document.querySelectorAll('#candidates2 tbody tr label')].map((label) => label.textContent),
            marks: (document.getElementById('candidates2').textContent.match(/рекомендуется/g) ?? []).length,
            escmsk: !document.getElementById('INS_HNTCH_ESCMSK').closest('p').hidden, form_is_log: step2_key(values_from_form()) === step2_key(values_from_log()),
        }))
        assert.ok(v2.verdict.startsWith('Текущие настройки лучше'), v2.verdict)
        assert.deepEqual([v2.best, v2.marks, v2.escmsk, v2.form_is_log], ['log', 1, true, true], 'рекомендован лог, ESCMSK виден, форма из лога: ' + v2.titles.join('; '))

        // Шаг 3: имена пределов ускорения ATC_ACC_*; без размера винта — просьба ввести его
        await page.click('#wizbar button:nth-child(4)')
        await wait_overlay(page)
        const w3 = await page.evaluate(() => ({ verdict: document.getElementById('verdict3').textContent, acc: document.getElementById('lpf_ATC_ACC_R_MAX') != null,
                                                 accel: document.getElementById('lpf_ATC_ACCEL_R_MAX') != null,
                                                 titles: [...document.querySelectorAll('#candidates3 tbody tr label')].map((label) => label.textContent) }))
        assert.deepEqual([w3.acc, w3.accel], [true, false], 'форма шага 3 — ATC_ACC_*')
        assert.match(w3.verdict, /^Введите размер винта/, w3.verdict)
        assert.deepEqual(w3.titles, ['Как в логе', 'Лог + правило /2'])

        // Шаг 4: полёт в STABILIZE — надёжного измерения нет ни на одной оси, участка ACRO нет (кнопки интервала нет)
        await page.click('#wizbar button:nth-child(5)')
        await wait_overlay(page)
        const p4 = await page.evaluate(() => ({
            statuses: Object.fromEntries(['roll', 'pitch', 'yaw'].map((axis) => [axis, step4.calc[axis].status])),
            modes: step4.calc.roll.mode?.modes ?? null, rate_hz: step4.calc.roll.rate_hz ?? null,
            verdict: document.getElementById('verdict4').textContent, verdict_class: document.getElementById('verdict4').className,
            acro_row: document.getElementById('step4_acro_row').hidden,
        }))
        assert.ok(Object.values(p4.statuses).every((status) => status !== 'ok'), 'ни одна ось не надёжна: ' + JSON.stringify(p4.statuses))
        assert.deepEqual(p4.modes, ['STABILIZE'], 'режим лога')
        assert.equal(p4.acro_row, true, 'участка ACRO нет — кнопки «Интервал — участок ACRO» нет')
        assert.match(p4.verdict_class, /verdict--(warn|fail)/, p4.verdict)
        assert.match(p4.verdict, /нужен тестовый полёт: Acro с ACRO_OPTIONS «Rate Loop Only» \(2, или 3 с Air-mode\) и ACRO_TRAINER = 0/, p4.verdict)

        // Шаг 5: ничего не принято — менять нечего
        await page.click('#wizbar button:nth-child(6)')
        const v5 = await page.evaluate(() => ({ verdict: document.getElementById('verdict5').textContent, disabled: ['step5_download', 'step5_remember'].map((id) => document.getElementById(id).disabled),
                                                 board: [...document.querySelectorAll('#tiles5 .stat .stat__v')][0].textContent }))
        assert.match(v5.verdict, /^Менять нечего: ни один из шагов 2–4 не принят\./, v5.verdict)
        assert.deepEqual([v5.disabled, v5.board], [[true, true], 'StellarH7V2'])

        assert.deepEqual(problems, [], 'ошибки консоли')
        console.log('tunewizard-browser-log2: шаги 0–5 пройдены на ' + path.basename(log_path) + ' (' + info.board + ', ' + info.fw + '); шаг 1: трасс с данными ' + s1.with_data +
            ' (записано «до»' + (s1.have_post ? ' и «после»' : '') + '), пиков ' + s1.peaks + ', вердикт «' + s1.verdict + '»')
        console.log('  шаг 2: варианты ' + v2.titles.join('; ') + '; вердикт «' + v2.verdict + '»')
        console.log('  шаг 4: ' + JSON.stringify(p4.statuses) + ', PID ' + ((p4.rate_hz != null) ? p4.rate_hz.toFixed(0) + ' Гц' : '—') + '; вердикт «' + p4.verdict + '»')
        console.log('  шаг 5: «' + v5.verdict + '»')
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
    }
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
