// Smoke-прогон мастера настройки (TuneWizard) в настоящем браузере через Playwright.
// Запуск: npm run test:tunewizard
// Нужны: лог .bin (переменная TUNEWIZARD_LOG или первый .bin в TuneWizard/logs/), браузер
// (CHROME_PATH — путь к chrome.exe; без него Playwright берёт свой Chromium, если он установлен)
// и python для http.server. Без лога тест пропускается с сообщением, чтобы не падать на чистой машине.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { chromium } = require('playwright')

const repo = path.resolve(__dirname, '..')
const logs_dir = path.join(repo, 'TuneWizard', 'logs')
const port = 8791

function find_log() {
    if (process.env.TUNEWIZARD_LOG) {
        return process.env.TUNEWIZARD_LOG
    }
    if (!fs.existsSync(logs_dir)) {
        return null
    }
    const bin = fs.readdirSync(logs_dir).find((name) => name.toLowerCase().endsWith('.bin'))
    return bin ? path.join(logs_dir, bin) : null
}

// Секции шагов, которые реально отображаются: атрибут hidden может быть перебит CSS, поэтому смотрим computed style
function visible_steps(page) {
    return page.evaluate(() => [...document.querySelectorAll('section[data-step]')]
        .filter((s) => getComputedStyle(s).display !== 'none')
        .map((s) => s.dataset.step))
}

function step_buttons_disabled(page) {
    return page.evaluate(() => [...document.querySelectorAll('#wizbar button')].map((b) => b.disabled))
}

// Дождаться, пока оверлей загрузки (loading_call) скроется: расчёты шагов идут под ним
function wait_overlay(page) {
    return page.waitForFunction(() => document.getElementById('loading').style.visibility === 'hidden', null, { timeout: 180000 })
}

// Сводка графиков шага 1: трассы среднего спектра с данными, длина оси частот, видимые трассы, тепловая карта
function step1_summary(page) {
    return page.evaluate(() => {
        const spectrum = document.getElementById('Spectrum1')
        const with_data = spectrum.data.filter((t) => (t.y != null) && (t.y.length > 0))
        const heat = document.getElementById('Spectrogram1').data[0]
        return {
            with_data: with_data.length,
            x_len: with_data.length ? with_data[0].x.length : 0,
            visible: spectrum.data.filter((t) => t.visible === true).map((t) => t.name),
            yaxis: spectrum.layout.yaxis.title.text,
            z_len: heat.z.length,
            peaks: document.querySelectorAll('#peaks1 tbody tr').length,
            verdict: document.getElementById('verdict1').textContent,
            verdict_class: document.getElementById('verdict1').className,
            window_size: document.getElementById('FFTWindow_size').value,
            xaxis: spectrum.layout.xaxis.title.text,
            xtype: spectrum.layout.xaxis.type,
            sg_yaxis: document.getElementById('Spectrogram1').layout.yaxis.title.text,
            sg_ytype: document.getElementById('Spectrogram1').layout.yaxis.type,
            columns: [...document.querySelectorAll('#peaks1 thead th')].map((th) => th.textContent),
            peak_rows: [...document.querySelectorAll('#peaks1 tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent)),
        }
    })
}

// Запомнить объекты FFT экземпляров гироскопа и проверить, что они те же: перерисовка без пересчёта FFT
function remember_fft(page) {
    return page.evaluate(() => { window.__fft = state.gyro.map((g) => g?.FFT ?? null) })
}
function same_fft(page) {
    return page.evaluate(() => state.gyro.every((g, i) => (g?.FFT ?? null) === window.__fft[i]) && state.gyro.some((g) => g?.FFT != null))
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

async function main() {
    const log_path = find_log()
    if (log_path == null) {
        console.log('tunewizard-browser: лог не найден (TUNEWIZARD_LOG или TuneWizard/logs/*.bin) — пропуск')
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
        await wait_for_server(page, 'http://127.0.0.1:' + port + '/TuneWizard/', server)

        // Каркас до загрузки
        assert.equal(await page.locator('#wizbar button').count(), 6, 'шесть кнопок шагов')
        assert.deepEqual(await step_buttons_disabled(page), [false, true, true, true, true, true], 'до загрузки доступен только шаг 0')
        assert.deepEqual(await visible_steps(page), ['0'], 'видна только секция шага 0')
        assert.deepEqual(await page.evaluate(() => ['log_verdict', 'log_info', 'log_checks'].filter((id) => getComputedStyle(document.getElementById(id)).display !== 'none')), [], 'блоки результата скрыты до загрузки')

        // Тема
        await page.click('.themebar button[data-t="dark"]')
        assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), 'dark')
        assert.equal(await page.evaluate(() => localStorage.getItem('theme_v1')), 'dark')
        await page.click('.themebar button[data-t="light"]')

        // Загрузка лога
        await page.setInputFiles('#fileItem', log_path)
        await page.locator('#log_verdict').waitFor({ state: 'visible', timeout: 180000 })
        await page.waitForFunction(() => document.getElementById('loading').style.visibility === 'hidden', null, { timeout: 180000 })
        assert.match(await page.title(), /Мастер настройки: /)
        assert.match(await page.locator('#log_verdict').getAttribute('class'), /verdict--(ok|warn|fail)/)
        assert.ok((await page.locator('#log_info .stat').count()) >= 9, 'плитки сведений')
        const count = await page.locator('#log_checks .check').count()
        assert.ok(count >= 7 && count <= 9, 'от 7 до 9 проверок (clipping и газ висения зависят от лога)')
        const titles = await page.evaluate(() => [...document.querySelectorAll('#log_checks .check h3')].map((h) => h.textContent))
        for (const title of ['Аппарат', 'Сообщения PID', 'Данные гироскопа', 'Источник трекинга notch', 'Полёт', 'Вибрации']) {
            assert.ok(titles.includes(title), 'есть проверка «' + title + '»')
        }
        const statuses = await page.evaluate(() => [...document.querySelectorAll('#log_checks .check')].map((c) => c.className.replace('check check--', '')))
        for (const status of statuses) {
            assert.ok(['ok', 'warn', 'fail'].includes(status), 'статус проверки: ' + status)
        }

        // Интервал анализа и график
        const start = Number(await page.inputValue('#TimeStart'))
        const end = Number(await page.inputValue('#TimeEnd'))
        assert.ok(end > start, 'интервал по умолчанию не пуст')
        assert.deepEqual(await page.evaluate(() => document.getElementById('FlightData').layout.xaxis.range), [start, end], 'график показывает интервал анализа')
        assert.ok(await page.evaluate(() => document.getElementById('FlightData').data.some((t) => t.x.length > 0)), 'на графике есть данные')
        // Конец меньше начала — откат
        await page.fill('#TimeEnd', String(start - 1))
        await page.dispatchEvent('#TimeEnd', 'change')
        assert.equal(Number(await page.inputValue('#TimeEnd')), end, 'неверный интервал откатывается')
        // Окно FFT действует только на raw-лог: в логе только batch — поле выключено сразу после загрузки.
        // Округление к степени двойки проверяем, временно включив поле
        const only_batch = await page.evaluate(() => !('GYR' in state.log.messageTypes))
        assert.equal(await page.isDisabled('#FFTWindow_size'), only_batch, 'поле окна FFT выключено, если raw-лога нет')
        await page.evaluate(() => { document.getElementById('FFTWindow_size').disabled = false })
        await page.fill('#FFTWindow_size', '1025')
        await page.dispatchEvent('#FFTWindow_size', 'change')
        assert.equal(await page.inputValue('#FFTWindow_size'), '2048', 'окно FFT округляется к степени двойки')
        await page.evaluate((disabled) => { document.getElementById('FFTWindow_size').disabled = disabled }, only_batch)

        // Шаги и тема с данными
        // Проверка gyro_log и pid_log на реальном логе не fail — открыты все шаги
        assert.deepEqual(await step_buttons_disabled(page), [false, false, false, false, false, false], 'после загрузки лога Copter доступны все шаги')
        await page.click('#wizbar button:nth-child(1)')
        assert.deepEqual(await visible_steps(page), ['0'])
        await page.click('.themebar button[data-t="dark"]')
        const surface = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--surface').trim())
        assert.equal(await page.evaluate(() => document.getElementById('FlightData').layout.paper_bgcolor), surface, 'график перекрашен под тёмную тему')

        // Скриншоты для глаз — рядом с логами, в репозиторий не попадают
        const shots = path.join(logs_dir, 'screenshots')
        fs.mkdirSync(shots, { recursive: true })
        await page.screenshot({ path: path.join(shots, 'step0_dark.png'), fullPage: true })
        await page.click('.themebar button[data-t="light"]')
        await page.screenshot({ path: path.join(shots, 'step0_light.png'), fullPage: true })

        // Шаг 1: спектр, спектрограмма, пики и вердикт считаются при первом показе
        await page.click('#wizbar button:nth-child(2)')
        assert.deepEqual(await visible_steps(page), ['1'])
        await wait_overlay(page)
        const s1 = await step1_summary(page)
        assert.ok(s1.with_data >= 3, 'в среднем спектре не меньше трёх трасс с данными: ' + s1.with_data)
        assert.ok(s1.visible.length >= 3, 'видны трассы первичного гироскопа: ' + s1.visible.join(', '))
        assert.equal(s1.yaxis, 'Амплитуда, дБ')
        assert.ok(s1.z_len > 0, 'тепловая карта спектрограммы не пуста')
        assert.ok(s1.peaks >= 1, 'в таблице пиков есть строки')
        assert.match(s1.verdict, /Гц/, 'вердикт называет частоту')
        assert.match(s1.verdict_class, /verdict--(ok|warn)/)
        assert.equal(await page.isDisabled('#open_filterreview'), false, '«Открыть в FilterReview» доступна с загруженным логом')
        assert.deepEqual(s1.columns, ['Частота, Гц', 'Оси', 'Уровень, дБ', 'Над шумом, дБ', 'Источник', 'Метод'])
        assert.ok(s1.peak_rows.every((row) => /^[XYZ](, [XYZ])*$/.test(row[1])), 'в столбце «Оси» — оси пика: ' + JSON.stringify(s1.peak_rows))
        // В логе есть ESC-телеметрия и запись «до»: атрибуция по порядковому спектру, в подписи — процентили частоты ESC
        assert.ok(s1.peak_rows.every((row) => row[5] === 'порядковый спектр'), 'метод атрибуции: ' + JSON.stringify(s1.peak_rows))
        assert.match(await page.textContent('#peaks1_note'), /порядковому спектру ESC.*p5 [\d.]+, p50 [\d.]+, p95 [\d.]+ Гц/, 'подпись называет метод и процентили')
        // Линии логированных notch (FTN в этом логе) — только в легенде, тонкие, как выключенный SpecNotchShowLogged в FilterReview
        const logged_lines = await page.evaluate(() => document.getElementById('Spectrogram1').data.slice(1).map((t) => [t.visible, t.line.width]))
        assert.ok(logged_lines.length > 0 && logged_lines.every(([visible, width]) => (visible === 'legendonly') && (width === 1)), 'линии notch: ' + JSON.stringify(logged_lines))
        assert.equal(await page.isDisabled('#FFTWindow_size'), true, 'batch-лог: поле окна FFT шага 0 выключено')
        assert.match(await page.textContent('#spec_wpb_hint'), /допустимо окон на пакет: 1, 3, 7, 15, 31, 62, 63$/, 'подсказка окон на пакет для пакета 1024 (floor(1024 / (1 + (w − 1)·0.5)) — степень двойки)')

        // Шкалы, единицы, ось и алиасинг перерисовывают без FFT: объекты FFT те же
        await remember_fft(page)
        await page.check('#spec_amp_linear')
        await wait_overlay(page)
        assert.equal((await step1_summary(page)).yaxis, 'Амплитуда', 'линейная шкала')
        await page.check('#spec_amp_dB')
        await wait_overlay(page)
        assert.equal((await step1_summary(page)).yaxis, 'Амплитуда, дБ')
        await page.check('#spec_freq_RPM')
        await wait_overlay(page)
        let view = await step1_summary(page)
        assert.equal(view.xaxis, 'Обороты, RPM', 'ось спектра в RPM')
        assert.equal(view.sg_yaxis, 'Обороты, RPM', 'ось спектрограммы в RPM')
        await page.check('#spec_freq_log')
        await wait_overlay(page)
        view = await step1_summary(page)
        assert.equal(view.xtype, 'log', 'логарифмическая ось спектра')
        assert.equal(view.sg_ytype, 'log', 'логарифмическая ось спектрограммы')
        await page.uncheck('#spec_freq_log')
        await wait_overlay(page)
        await page.check('#spec_freq_Hz')
        await wait_overlay(page)
        await page.check('#spec_alias_fold')
        await wait_overlay(page)
        view = await step1_summary(page)
        assert.ok(view.x_len > 0 && view.x_len !== s1.x_len, 'свёрнутый спектр — своя сетка частот: ' + view.x_len)
        assert.equal(await page.evaluate(() => Math.max(...document.getElementById('Spectrum1').data.find((t) => t.x.length > 0).x)), 200, 'свёрнутый спектр — до SCHED_LOOP_RATE / 2')
        await page.check('#spec_alias_none')
        await wait_overlay(page)
        view = await step1_summary(page)
        assert.equal(view.xtype, 'linear')
        assert.equal(view.x_len, s1.x_len)
        assert.equal(await same_fft(page), true, 'смена шкал и алиасинга не пересчитывала FFT')

        // Окон на пакет 2: окно floor(1024/1.5) = 682 не степень двойки — вердикт fail без ошибок консоли (так же в FilterReview)
        await page.fill('#spec_window_per_batch', '2')
        await page.dispatchEvent('#spec_window_per_batch', 'change')
        assert.match(await page.getAttribute('#spec_recalc', 'class') ?? '', /primary/, 'изменение панели подсвечивает «Пересчитать»')
        await page.click('#spec_recalc')
        await wait_overlay(page)
        const s2 = await step1_summary(page)
        assert.match(s2.verdict_class, /verdict--fail/)
        assert.match(s2.verdict, /степенью двойки/)
        assert.equal(s2.with_data, 0, 'при ошибке FFT графики пусты')
        // Окон на пакет 3: окно 1024/2 = 512 — ось частот короче
        await page.fill('#spec_window_per_batch', '3')
        await page.dispatchEvent('#spec_window_per_batch', 'change')
        await page.click('#spec_recalc')
        await wait_overlay(page)
        const s3 = await step1_summary(page)
        assert.match(s3.verdict_class, /verdict--(ok|warn)/)
        assert.ok(s3.x_len > 0 && s3.x_len !== s1.x_len, 'длина оси частот изменилась: ' + s1.x_len + ' → ' + s3.x_len)
        assert.equal(s3.window_size, '512', 'окно batch показано в поле шага 0')
        assert.doesNotMatch(await page.getAttribute('#spec_recalc', 'class') ?? '', /primary/, 'после пересчёта подсветки нет')
        await page.fill('#spec_window_per_batch', '1')
        await page.dispatchEvent('#spec_window_per_batch', 'change')
        await page.click('#spec_recalc')
        await wait_overlay(page)
        assert.equal((await step1_summary(page)).x_len, s1.x_len, 'одно окно на пакет — прежняя длина')

        // Тема на шаге 1 и скриншоты
        await page.click('.themebar button[data-t="dark"]')
        assert.equal(await page.evaluate(() => document.getElementById('Spectrum1').layout.paper_bgcolor), surface, 'спектр перекрашен под тёмную тему')
        await page.screenshot({ path: path.join(shots, 'step1_dark.png'), fullPage: true })
        await page.click('.themebar button[data-t="light"]')
        await page.screenshot({ path: path.join(shots, 'step1_light.png'), fullPage: true })
        await page.click('#wizbar button:nth-child(1)')
        assert.deepEqual(await visible_steps(page), ['0'])

        // Повторная загрузка того же лога (поле выбора очищается после чтения, change срабатывает снова):
        // шаг 1 считается заново начисто
        await page.evaluate(() => { window.__old_log = state.log; window.__fft = null })
        await page.setInputFiles('#fileItem', log_path)
        await page.waitForFunction(() => (state.log != null) && (state.log !== window.__old_log) &&
            (document.getElementById('loading').style.visibility === 'hidden'), null, { timeout: 180000 })
        assert.equal(await page.evaluate(() => state.gyro === null), true, 'новый лог — гироскоп ещё не загружен')
        await page.click('#wizbar button:nth-child(2)')
        await wait_overlay(page)
        const s4 = await step1_summary(page)
        assert.ok(s4.with_data >= 3 && s4.peaks >= 1, 'после повторной загрузки спектр и пики снова есть')
        assert.deepEqual(s4.peak_rows, s1.peak_rows, 'та же таблица пиков')
        assert.equal(s4.verdict, s1.verdict, 'тот же вердикт')
        await page.click('#wizbar button:nth-child(1)')

        assert.deepEqual(problems, [], 'ошибки консоли')
        console.log('tunewizard-browser: шаги 0–1 пройдены, проверок ' + statuses.length + ' (' + statuses.join(', ') + '); шаг 1: трасс с данными ' + s1.with_data +
            ', бинов ' + s1.x_len + ', пиков ' + s1.peaks + ', вердикт «' + s1.verdict + '»; скриншоты в ' + shots)
        console.log('  пики: ' + s1.peak_rows.map((row) => row.join(' | ')).join(' ; '))
    } catch (e) {
        // При падении показать накопленные сообщения консоли и сервера — иначе причина теряется
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
