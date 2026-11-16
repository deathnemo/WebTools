// Прогон мастера настройки на одном логе в Chrome (без окна): шаги 0–4, вердикты, расчёт шага 4 по осям — на интервале
// по умолчанию и на участке ACRO. Только чтение: ничего не принимает и в память прохода не пишет.
// Запуск: node run_wizard.cjs <репозиторий> <лог> <файл результата .json>
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { createRequire } = require('node:module')

const [repo, log_path, out_path] = process.argv.slice(2)
const { chromium } = createRequire(path.join(repo, 'package.json'))('playwright')
const port = 8799
const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'

function wait_overlay(page) {
    return page.waitForFunction(() => document.getElementById('loading').style.visibility === 'hidden', null, { timeout: 300000 })
}

async function wait_for_server(page, url, server) {
    for (let i = 0; i < 60; i++) {
        if (server.exitCode != null) throw new Error('http.server завершился с кодом ' + server.exitCode)
        try {
            await page.goto(url, { waitUntil: 'networkidle' })
            return
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 250))
        }
    }
    throw new Error('http.server не поднялся')
}

// Сжатая копия расчёта оси: длинные массивы — длиной, глубина ограничена
function step4_snapshot(page) {
    return page.evaluate(() => {
        function slim(v, depth) {
            if (v == null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v
            if (typeof v === 'function') return undefined
            if (ArrayBuffer.isView(v)) return '[' + v.length + ']'
            if (Array.isArray(v)) {
                if (v.length > 12) return '[' + v.length + ']'
                return (depth <= 0) ? '[…]' : v.map((x) => slim(x, depth - 1))
            }
            if (depth <= 0) return '{…}'
            const out = {}
            for (const [k, x] of Object.entries(v)) {
                if (['source', 'pidreview', 'grid', 'fir', 'seg'].includes(k)) continue
                out[k] = slim(x, depth - 1)
            }
            return out
        }
        const axes = {}
        for (const axis of ['roll', 'pitch', 'yaw']) {
            const r = step4.calc?.[axis]
            if (r == null) { axes[axis] = null; continue }
            const s = slim(r, 5)
            s.data_s = r.seg?.data_s ?? null
            s.n_segments = r.seg?.segments?.length ?? null
            s.fir_ridge = r.fir?.ridge ?? null
            s.source_id = r.source?.id ?? null
            const tab = document.getElementById('step4_tab_' + axis)
            s.tab = tab ? [...tab.querySelectorAll('span')].map((x) => x.textContent).join(' | ') : null
            axes[axis] = s
        }
        return {
            range: [state.settings.start, state.settings.end],
            error: step4.error,
            verdict: document.getElementById('verdict4').textContent,
            verdict_class: document.getElementById('verdict4').className,
            acro_row_hidden: document.getElementById('step4_acro_row').hidden,
            axes: axes,
        }
    })
}

async function main() {
    const result = { log: log_path }
    const problems = []
    const server = spawn('python', ['-m', 'http.server', '--bind', '127.0.0.1', String(port)], { cwd: repo, stdio: 'ignore' })
    let browser = null
    try {
        browser = await chromium.launch({ headless: true, executablePath: chrome })
        const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
        page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()) })
        page.on('pageerror', (e) => problems.push('pageerror: ' + e.message))
        await wait_for_server(page, 'http://127.0.0.1:' + port + '/TuneWizard/', server)

        // Шаг 0
        const t0 = Date.now()
        await page.setInputFiles('#fileItem', log_path)
        await page.locator('#log_verdict').waitFor({ state: 'visible', timeout: 300000 })
        await wait_overlay(page)
        result.load_s = (Date.now() - t0) / 1000
        result.step0 = await page.evaluate(() => ({
            verdict: document.getElementById('log_verdict').textContent,
            checks: state.checks.map((c) => '[' + c.status + '] ' + (c.title ?? c.id) + ': ' + (c.text ?? '')),
            range: [state.settings.start, state.settings.end],
            window: state.settings.window_size,
            prep: document.getElementById('prep0')?.innerText?.slice(0, 3000) ?? null,
        }))

        // Шаг 1 с окном по умолчанию и с окном 2048
        await page.click('#wizbar button:nth-child(2)')
        await wait_overlay(page)
        const step1 = () => page.evaluate(() => ({
            ready: step1_ready(), fft_key: step1.fft_key, error: step1.error,
            verdict: document.getElementById('verdict1').textContent, info: document.getElementById('spec_info').textContent,
            peaks: [...document.querySelectorAll('#peaks1 tbody tr')].map((tr) => [...tr.cells].map((td) => td.textContent).join(' | ')),
            have_pre: state.gyro.have_pre, have_post: state.gyro.have_post,
        }))
        result.step1 = await step1()
        if (result.step0.window !== 2048) {
            await page.click('#wizbar button:nth-child(1)')
            await page.fill('#FFTWindow_size', '2048')
            await page.dispatchEvent('#FFTWindow_size', 'change')
            await page.click('#wizbar button:nth-child(2)')
            await wait_overlay(page)
            result.step1_2048 = await step1()
            await page.click('#wizbar button:nth-child(1)')
            await page.fill('#FFTWindow_size', String(result.step0.window))
            await page.dispatchEvent('#FFTWindow_size', 'change')
            await page.click('#wizbar button:nth-child(2)')
            await wait_overlay(page)
        }

        // Шаг 2
        await page.click('#wizbar button:nth-child(3)')
        await wait_overlay(page)
        await page.waitForFunction(() => step2.form_ready && (step2.ranking != null), null, { timeout: 120000 }).catch(() => {})
        result.step2 = await page.evaluate(() => ({
            verdict: document.getElementById('verdict2').textContent, best: step2.ranking?.best_id ?? null,
            rows: [...document.querySelectorAll('#candidates2 tbody tr')].map((tr) => tr.innerText.replace(/\s+/g, ' ').trim()),
        }))

        // Шаг 3 (размера винта нет — только вердикт)
        await page.click('#wizbar button:nth-child(4)')
        await wait_overlay(page)
        result.step3 = await page.evaluate(() => ({ verdict: document.getElementById('verdict3').textContent }))

        // Шаг 4: интервал по умолчанию, затем участок ACRO
        await page.click('#wizbar button:nth-child(5)')
        await wait_overlay(page)
        result.step4_default = await step4_snapshot(page)
        if (!result.step4_default.acro_row_hidden) {
            await page.click('#step4_acro_interval')
            await wait_overlay(page)
            await page.waitForTimeout(500)
            await wait_overlay(page)
            result.step4_acro = await step4_snapshot(page)
        }
        result.problems = problems
    } finally {
        if (browser) await browser.close()
        server.kill()
    }
    fs.writeFileSync(out_path, JSON.stringify(result, null, 1))
    console.log('готово:', out_path, 'загрузка', result.load_s, 'с; ошибок консоли', problems.length)
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
