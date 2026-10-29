// Иконка мастера настройки (TuneWizard) для главной страницы WebTools: images/TuneWizard_Icon.png.
// Запуск: npm run tunewizard:icon — вручную, только чтобы обновить иконку; файл коммитится. В обычный браузерный тест
// скрипт не входит, иначе каждый прогон менял бы картинку.
// Нужны те же лог, браузер и python, что для tests/tunewizard-browser.cjs: лог .bin (переменная TUNEWIZARD_LOG или
// первый .bin в TuneWizard/logs/), CHROME_PATH — путь к chrome.exe (без него Playwright берёт свой Chromium, если он
// установлен) и python для http.server.
//
// Иконка — снимок экрана, как у соседних инструментов: полоса шагов и под ней спектр шага 2 (Spectrum2). Между ними
// на шаге 2 — таблицы вариантов и форма (сплошная область выше 3000 px), поэтому полоса и график снимаются отдельными
// кусками и склеиваются на canvas одной картинкой, полоса сверху. Окно — 760 px: при ширине до 900 px полоса шагов
// встаёт в три столбца (две строки), и склейка выходит около 4:3, как у соседних иконок (FilterReview 200×147,
// PIDReview 200×186); в окне 1400 px она была бы около 2.8:1 с полосой высотой в несколько пикселей. Склейка
// уменьшается до 400 px по ширине (на главной картинка показывается в 200 px — двойная плотность для чётких экранов)
// в самой странице: createImageBitmap и canvas со сглаживанием высокого качества.
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { chromium } = require('playwright')

const repo = path.resolve(__dirname, '..')
const logs_dir = path.join(repo, 'TuneWizard', 'logs')
const icon_path = path.join(repo, 'images', 'TuneWizard_Icon.png')
const port = 8794
// Окно снимка (см. шапку): полоса шагов в три столбца, склейка около 4:3
const viewport = { width: 760, height: 1000 }
// Ширина иконки, px
const icon_width = 400
// Зазор между полосой шагов и графиком на склейке, px снимка (цвет — фон страницы)
const gap = 16

function find_log() {
    if (process.env.TUNEWIZARD_LOG) {
        return process.env.TUNEWIZARD_LOG
    }
    if (!fs.existsSync(logs_dir)) {
        return null
    }
    // В TuneWizard/logs/ рядом с тестовым логом лежит второй (другой аппарат), по алфавиту он первый — тестовый предпочтительнее
    const names = fs.readdirSync(logs_dir).filter((name) => name.toLowerCase().endsWith('.bin'))
    const bin = names.includes('2026-06-18 18-54-42_anon.bin') ? '2026-06-18 18-54-42_anon.bin' : names[0]
    return bin ? path.join(logs_dir, bin) : null
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

// Дождаться, пока оверлей загрузки (loading_call) скроется: расчёты шагов идут под ним
function wait_overlay(page) {
    return page.waitForFunction(() => document.getElementById('loading').style.visibility === 'hidden', null, { timeout: 180000 })
}

// Склеить снимки (PNG в base64) столбиком через зазор gap цвета фона страницы и уменьшить до ширины icon_width
// с сохранением пропорций. Выполняется в странице: createImageBitmap и canvas, imageSmoothingQuality = "high".
// Возвращает размеры кусков, склейки и иконки и PNG иконки в base64
function compose_icon(page, pieces) {
    return page.evaluate(async ({ pieces, spacing, width }) => {
        const bitmap = (b64) => createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'image/png' }))
        const images = await Promise.all(pieces.map(bitmap))
        const full = document.createElement('canvas')
        full.width = Math.max(...images.map((img) => img.width))
        full.height = images.reduce((sum, img) => sum + img.height, 0) + spacing * (images.length - 1)
        const ctx = full.getContext('2d')
        ctx.fillStyle = getComputedStyle(document.body).backgroundColor
        ctx.fillRect(0, 0, full.width, full.height)
        let y = 0
        for (const img of images) {
            ctx.drawImage(img, 0, y)
            y += img.height + spacing
        }
        const icon = document.createElement('canvas')
        icon.width = width
        icon.height = Math.round(full.height * width / full.width)
        const icon_ctx = icon.getContext('2d')
        icon_ctx.imageSmoothingEnabled = true
        icon_ctx.imageSmoothingQuality = 'high'
        icon_ctx.drawImage(await createImageBitmap(full), 0, 0, icon.width, icon.height)
        return {
            pieces: images.map((img) => [img.width, img.height]),
            full: [full.width, full.height],
            size: [icon.width, icon.height],
            png: icon.toDataURL('image/png').split(',')[1],
        }
    }, { pieces: pieces, spacing: gap, width: icon_width })
}

async function main() {
    const log_path = find_log()
    if (log_path == null) {
        throw new Error('лог не найден (TUNEWIZARD_LOG или TuneWizard/logs/*.bin) — иконку снимать не с чего')
    }
    const python = process.platform === 'win32' ? 'python' : 'python3'
    const problems = []
    let server = null
    let browser = null
    try {
        server = spawn(python, ['-m', 'http.server', '--bind', '127.0.0.1', String(port)], { cwd: repo, stdio: 'ignore' })
        server.on('error', (e) => problems.push('http.server: ' + e.message))
        browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined })
        const page = await browser.newPage({ viewport: viewport })
        page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()) })
        page.on('pageerror', (e) => problems.push('pageerror: ' + e.message))
        await wait_for_server(page, 'http://127.0.0.1:' + port + '/TuneWizard/', server)

        // Загрузка лога
        await page.setInputFiles('#fileItem', log_path)
        await page.locator('#log_verdict').waitFor({ state: 'visible', timeout: 180000 })
        await wait_overlay(page)

        // Шаг 2: расчёты под оверлеем, затем разметка формы по метаданным (step2.form_ready) и спектр с данными,
        // подогнанный по ширине контейнера (Plotly подгоняет размер отложенно, ±2 px — как в браузерном тесте)
        await page.click('#wizbar button:nth-child(3)')
        await wait_overlay(page)
        await page.waitForFunction(() => {
            const gd = document.getElementById('Spectrum2')
            return step2.form_ready && (gd._fullLayout != null) && (gd.data ?? []).some((t) => (t.y != null) && (t.y.length > 0)) &&
                (Math.abs(gd._fullLayout.width - gd.getBoundingClientRect().width) <= 2)
        }, null, { timeout: 60000 })
        // Дождаться идущих загрузок шрифтов (отказ загрузки попадёт в problems и остановит запись ниже); курсор и фокус
        // убраны, чтобы на снимке не было наведения и рамки фокуса
        await page.evaluate(() => document.fonts.ready.then(() => null))
        await page.mouse.move(0, 0)
        await page.evaluate(() => document.activeElement?.blur())

        // Куски склейки: полоса шагов сверху, под ней спектр
        const pieces = []
        for (const selector of ['#wizbar', '#Spectrum2']) {
            pieces.push((await page.locator(selector).screenshot()).toString('base64'))
        }
        // Ошибки страницы (например, не загрузились шрифты Google Fonts — снимок вышел бы с запасными) — иконку
        // не записывать; сами сообщения печатает catch ниже
        if (problems.length) {
            throw new Error('на странице были ошибки — иконка не записана')
        }
        const icon = await compose_icon(page, pieces)
        fs.writeFileSync(icon_path, Buffer.from(icon.png, 'base64'))
        console.log('tunewizard-icon: ' + path.relative(repo, icon_path).split(path.sep).join('/') + ' — ' + icon.size.join('×') + ' px')
        console.log('  окно ' + viewport.width + ' px; полоса шагов ' + icon.pieces[0].join('×') + ', спектр ' + icon.pieces[1].join('×') +
                    ', зазор ' + gap + ' — склейка ' + icon.full.join('×') + ' px')
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
