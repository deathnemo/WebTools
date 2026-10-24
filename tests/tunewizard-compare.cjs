// Регрессия мастера настройки против FilterReview в настоящем браузере (Playwright + Chrome).
// Запуск: npm run test:tunewizard-compare
// Один лог открывается в FilterReview и в мастере с одинаковыми интервалом анализа, типом лога, числом окон
// на пакет, версией фильтра (как выбрана в FilterReview) и шкалой частоты (Гц, линейная ось); данные графиков
// сравниваются поэлементно: средний спектр первичного гироскопа (до / после / оценка «после» по X, Y, Z)
// и спектрограмма (оси и первые 5 строк матрицы) — в двух конфигурациях: дБ без алиасинга и PSD со свёрнутым
// алиасингом. Допуск |a − b| ≤ 1e-6·max(1, |a|); при расхождении — первая позиция и значения, код выхода 1.
// Нужны те же лог, браузер и python, что для tests/tunewizard-browser.cjs; без лога тест пропускается.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { chromium } = require('playwright')

const repo = path.resolve(__dirname, '..')
const logs_dir = path.join(repo, 'TuneWizard', 'logs')
const port = 8792
const tolerance = 1e-6

// Типы и оси трасс FilterReview для сенсора 0: индекс get_FFT_data_index(0, type, axis) = type·3 + axis
const FR_TYPES = ['Pre-filter', 'Post-filter', 'Estimated post']
const WIZARD_TYPES = ['до', 'после', 'оценка']
const AXES = ['X', 'Y', 'Z']

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

function wait_overlay(page) {
    return page.waitForFunction(() => document.getElementById('loading').style.visibility === 'hidden', null, { timeout: 180000 })
}

// Снимок графиков FilterReview: трассы сенсора 0 и спектрограмма. Внутри страницы массивы (и типизированные)
// переводятся в обычные, нечисловые значения (±Infinity, NaN, дыры разрывов спектрограммы) — в строки, чтобы
// пережить передачу из браузера и сравниваться как есть
function snapshot_filterreview(page) {
    return page.evaluate(() => {
        const snap = (a) => (a == null) ? null : Array.from(a, (v) => Number.isFinite(v) ? v : String(v))
        const traces = []
        for (let i = 0; i < 9; i++) {
            const t = fft_plot.data[i]
            traces.push({ index: i, name: t.name, x: snap(t.x), y: snap(t.y) })
        }
        const heat = Spectrogram.data[0]
        return { traces, heat: { x: snap(heat.x), y: snap(heat.y), z: (heat.z ?? []).slice(0, 5).map(snap), rows: (heat.z ?? []).length } }
    })
}

// Снимок графиков мастера: трассы по именам «Гироскоп 1 · тип · ось» и спектрограмма (данные — как у FilterReview)
function snapshot_wizard(page) {
    return page.evaluate(() => {
        const snap = (a) => (a == null) ? null : Array.from(a, (v) => Number.isFinite(v) ? v : String(v))
        const traces = {}
        for (const t of document.getElementById('Spectrum1').data) {
            traces[t.name] = { x: snap(t.x), y: snap(t.y) }
        }
        const heat = document.getElementById('Spectrogram1').data[0]
        return { traces, heat: { x: snap(heat.x), y: snap(heat.y), z: heat.z.slice(0, 5).map(snap), rows: heat.z.length } }
    })
}

// Сравнение двух массивов; возвращает { ok, count, max_rel, mismatch }
function compare_arrays(label, a, b) {
    if ((a == null) || (b == null)) {
        return { ok: false, count: 0, max_rel: 0, mismatch: label + ': нет данных (FilterReview ' + (a == null ? 'null' : a.length) + ', мастер ' + (b == null ? 'null' : b.length) + ')' }
    }
    if (a.length !== b.length) {
        return { ok: false, count: 0, max_rel: 0, mismatch: label + ': длина FilterReview ' + a.length + ', мастер ' + b.length }
    }
    let max_rel = 0
    for (let i = 0; i < a.length; i++) {
        if ((typeof a[i] === 'string') || (typeof b[i] === 'string')) {
            if (a[i] !== b[i]) {
                return { ok: false, count: i, max_rel, mismatch: label + '[' + i + ']: FilterReview ' + a[i] + ', мастер ' + b[i] }
            }
            continue
        }
        const scale = Math.max(1, Math.abs(a[i]))
        const rel = Math.abs(a[i] - b[i]) / scale
        max_rel = Math.max(max_rel, rel)
        if (rel > tolerance) {
            return { ok: false, count: i, max_rel, mismatch: label + '[' + i + ']: FilterReview ' + a[i] + ', мастер ' + b[i] + ', |a−b|/max(1,|a|) = ' + rel.toExponential(3) }
        }
    }
    return { ok: true, count: a.length, max_rel, mismatch: null }
}

// Поэлементное сравнение снимков FilterReview и мастера одной конфигурации; label — подпись конфигурации
function compare_snapshots(label, fr_snap, wz_snap) {
    const results = []
    for (let t = 0; t < 3; t++) {
        for (let a = 0; a < 3; a++) {
            const fr_trace = fr_snap.traces[t * 3 + a]
            const name = 'Гироскоп 1 · ' + WIZARD_TYPES[t] + ' · ' + AXES[a]
            if ((fr_trace.y == null) || (fr_trace.y.length == 0)) {
                console.log('  ' + label + ': пропуск ' + name + ' — в FilterReview нет данных (' + FR_TYPES[t] + ' ' + AXES[a] + ')')
                continue
            }
            const wz_trace = wz_snap.traces[name]
            results.push(compare_arrays(label + ' · ' + name + ' · x', fr_trace.x, wz_trace?.x))
            results.push(compare_arrays(label + ' · ' + name + ' · y', fr_trace.y, wz_trace?.y))
        }
    }
    results.push(compare_arrays(label + ' · спектрограмма · x (время)', fr_snap.heat.x, wz_snap.heat.x))
    results.push(compare_arrays(label + ' · спектрограмма · y (частота)', fr_snap.heat.y, wz_snap.heat.y))
    if (fr_snap.heat.rows !== wz_snap.heat.rows) {
        results.push({ ok: false, count: 0, max_rel: 0, mismatch: label + ' · спектрограмма: строк FilterReview ' + fr_snap.heat.rows + ', мастер ' + wz_snap.heat.rows })
    }
    for (let j = 0; j < fr_snap.heat.z.length; j++) {
        results.push(compare_arrays(label + ' · спектрограмма · z[' + j + ']', fr_snap.heat.z[j], wz_snap.heat.z[j]))
    }
    // Сравнение без единого числа ничего не доказывает
    assert.ok(results.some((r) => r.count > 0), label + ': нет ни одного сравненного значения')
    return results
}

async function main() {
    const log_path = find_log()
    if (log_path == null) {
        console.log('tunewizard-compare: лог не найден (TUNEWIZARD_LOG или TuneWizard/logs/*.bin) — пропуск')
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

        // 1. FilterReview: загрузка лога, шкалы как в мастере по умолчанию, re_calc и снимок графиков
        const fr = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
        fr.on('pageerror', (e) => problems.push('FilterReview pageerror: ' + e.message))
        fr.on('dialog', (d) => { problems.push('FilterReview alert: ' + d.message()); d.dismiss() })
        await wait_for_server(fr, 'http://127.0.0.1:' + port + '/FilterReview/', server)
        await fr.setInputFiles('#fileItem', log_path)
        // readFile ставит заголовок после окончания load
        await fr.waitForFunction(() => document.title.startsWith('Filter Review: '), null, { timeout: 180000 })
        await wait_overlay(fr)
        const fr_settings = await fr.evaluate(() => ({
            start: document.getElementById('TimeStart').value,
            end: document.getElementById('TimeEnd').value,
            window_per_batch: document.getElementById('FFTWindow_per_batch').value,
            window_size: document.getElementById('FFTWindow_size').value,
            batch: document.getElementById('log_type_batch').checked,
        }))
        fr_settings.filter_version = await fr.evaluate(() => [1, 2, 3, 4].find((v) => document.getElementById('filter_version_' + v).checked))
        for (const id of ['#ScaleLog', '#freq_ScaleLinear', '#freq_Scale_Hz', '#Aliasing_none']) {
            await fr.check(id)
        }
        await fr.evaluate(() => re_calc())
        const fr_snap = await snapshot_filterreview(fr)
        // Вторая конфигурация: PSD и свёрнутый алиасинг (Aliasing_on) — проверка PSD и alias_obj на настоящих данных
        await fr.check('#ScalePSD')
        await fr.check('#Aliasing_on')
        await fr.evaluate(() => re_calc())
        const fr_snap_psd = await snapshot_filterreview(fr)

        // 2. Мастер: тот же лог, интервал FilterReview, тот же тип лога, окна на пакет и версия фильтра, дБ / Гц / без алиасинга
        const wz = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
        wz.on('console', (m) => { if (m.type() === 'error') problems.push('мастер console: ' + m.text()) })
        wz.on('pageerror', (e) => problems.push('мастер pageerror: ' + e.message))
        wz.on('dialog', (d) => { problems.push('мастер alert: ' + d.message()); d.dismiss() })
        await wz.goto('http://127.0.0.1:' + port + '/TuneWizard/', { waitUntil: 'networkidle' })
        await wz.setInputFiles('#fileItem', log_path)
        await wz.locator('#log_verdict').waitFor({ state: 'visible', timeout: 180000 })
        await wait_overlay(wz)
        // Интервал по умолчанию у мастера свой (окно газа из core/log.js) — для справки в выводе
        const wz_default = [await wz.inputValue('#TimeStart'), await wz.inputValue('#TimeEnd')]
        await wz.fill('#TimeStart', fr_settings.start)
        await wz.fill('#TimeEnd', fr_settings.end)
        await wz.dispatchEvent('#TimeStart', 'change')
        await wz.dispatchEvent('#TimeEnd', 'change')
        assert.deepEqual([await wz.inputValue('#TimeStart'), await wz.inputValue('#TimeEnd')], [fr_settings.start, fr_settings.end], 'интервал мастера равен интервалу FilterReview')

        await wz.click('#wizbar button:nth-child(2)')
        await wait_overlay(wz)
        assert.equal(await wz.isChecked('#spec_log_batch'), fr_settings.batch, 'тот же тип лога (batch)')
        await wz.fill('#spec_window_per_batch', fr_settings.window_per_batch)
        await wz.dispatchEvent('#spec_window_per_batch', 'change')
        await wz.check('#spec_fv_' + fr_settings.filter_version)
        for (const id of ['#spec_amp_dB', '#spec_freq_Hz', '#spec_alias_none']) {
            if (!(await wz.isChecked(id))) {
                await wz.check(id)
                await wait_overlay(wz)
            }
        }
        if (await wz.isChecked('#spec_freq_log')) {
            await wz.uncheck('#spec_freq_log')
            await wait_overlay(wz)
        }
        await wz.click('#spec_recalc')
        await wait_overlay(wz)
        const wz_fv = await wz.evaluate(() => [1, 2, 3, 4].find((v) => document.getElementById('spec_fv_' + v).checked))
        assert.equal(wz_fv, fr_settings.filter_version, 'версия фильтра мастера равна версии FilterReview')
        // Выбор спектрограммы по умолчанию — как в FilterReview: первичный гироскоп, до фильтров, ось X
        assert.deepEqual(await wz.evaluate(() => ['spec_sg_inst0', 'spec_sg_pre', 'spec_sg_x'].map((id) => document.getElementById(id).checked)), [true, true, true], 'спектрограмма: гироскоп 1, до, X')
        const wz_window = await wz.inputValue('#FFTWindow_size')
        assert.equal(wz_window, fr_settings.window_size, 'окно FFT, вычисленное из числа окон на пакет, совпадает с FilterReview')
        const wz_snap = await snapshot_wizard(wz)
        await wz.check('#spec_amp_PSD')
        await wait_overlay(wz)
        await wz.check('#spec_alias_fold')
        await wait_overlay(wz)
        const wz_snap_psd = await snapshot_wizard(wz)

        // 3. Сравнение обеих конфигураций
        assert.deepEqual(problems, [], 'ошибки страниц')
        const configs = [['дБ, без алиасинга', fr_snap, wz_snap], ['PSD, свёрнутый алиасинг', fr_snap_psd, wz_snap_psd]]
        let failed_total = 0
        const summary = []
        for (const [label, fr_s, wz_s] of configs) {
            const results = compare_snapshots(label, fr_s, wz_s)
            const failed = results.filter((r) => !r.ok)
            const count = results.reduce((sum, r) => sum + r.count, 0)
            const max_rel = results.reduce((max, r) => Math.max(max, r.max_rel), 0)
            if (failed.length > 0) {
                console.error('tunewizard-compare: ' + label + ' — расхождений ' + failed.length + ' из ' + results.length + ' массивов; первое: ' + failed[0].mismatch)
                for (const r of failed.slice(1, 6)) {
                    console.error('  ' + r.mismatch)
                }
                failed_total += failed.length
            }
            summary.push(label + ': ' + results.length + ' массивов, ' + count + ' значений, наибольшее относительное отклонение ' + max_rel.toExponential(2))
        }
        if (failed_total > 0) {
            process.exitCode = 1
            return
        }
        console.log('tunewizard-compare: совпадение с FilterReview (допуск ' + tolerance + ') — ' + summary.join('; ') + '. Интервал ' + fr_settings.start + '–' +
            fr_settings.end + ' с (у мастера по умолчанию ' + wz_default.join('–') + ' с), окон на пакет ' + fr_settings.window_per_batch + ', окно ' + wz_window +
            ', версия фильтра ' + wz_fv + ', строк спектрограммы ' + wz_snap.heat.rows)
    } catch (e) {
        if (problems.length) {
            console.error('Сообщения страниц:', problems)
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
