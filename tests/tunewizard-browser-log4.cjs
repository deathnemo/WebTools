// Прогон мастера настройки на четвёртом логе — настоящем тестовом полёте Acro «Rate Loop Only» (ArduCopter 4.7.2, ACRO 289–370 с,
// интервал по умолчанию 282–370 с захватывает соседний режим). Проверяется шаг 4 этапа 10: на интервале по умолчанию режимы
// смешаны — «ненадёжно (б)» у всех осей без «±» и строки (г), кнопка «Интервал — участок ACRO»; на участке ACRO — крен и
// тангаж «надёжно» с запасом 1σ у правил (тангаж — «на границе 20 %», у крена допустимы оба исхода: «на границе 20 %» или
// «менять нечего» — по зерну суррогатов), рыскание — «мало
// точности (г)» с советом «ещё ≈ N с»; плитки с «±», строка (г) в таблице качества, пометка раннего отклика у «Нарастания»
// крена, сводка и шаг 5 без «нужен тестовый полёт». Отдельный скрипт, чтобы не удлинять основной прогон
// (tests/tunewizard-browser.cjs).
// Запуск: npm run test:tunewizard-log4
// Нужны: четвёртый лог (TUNEWIZARD_LOG4 или TuneWizard/logs/2 01.01.1970 2-00-00.bin), браузер (CHROME_PATH — путь к
// chrome.exe; без него Playwright берёт свой Chromium, если он установлен) и python для http.server. Без лога тест
// пропускается с сообщением
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { chromium } = require('playwright')

const repo = path.resolve(__dirname, '..')
const logs_dir = path.join(repo, 'TuneWizard', 'logs')
const port = 8799
const log4_name = '2 01.01.1970 2-00-00.bin'
const axes = ['roll', 'pitch', 'yaw']

function find_log() {
    if (process.env.TUNEWIZARD_LOG4) {
        return process.env.TUNEWIZARD_LOG4
    }
    const full = path.join(logs_dir, log4_name)
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

// Состояние шага 4: статусы, правила, точность, шум, сводка, кнопка интервала
function read4(page) {
    return page.evaluate(() => {
        const calc = (axis) => {
            const c = step4.calc[axis]
            const p = c.quality?.checks?.precision ?? null
            return { status: c.status, change: c.rule?.change ?? null, borderline: c.rule?.borderline ?? null, noise: c.quality?.noise != null,
                     need_s: p?.need_s ?? null, applied: p?.applied ?? null, halves_null: c.quality?.noise?.halves_null ?? null, sigma_step: c.quality?.noise?.sigma_step ?? null }
        }
        return {
            calc: Object.fromEntries(['roll', 'pitch', 'yaw'].map((axis) => [axis, calc(axis)])),
            verdict: document.getElementById('verdict4').textContent,
            acro_button: document.getElementById('step4_acro_row').checkVisibility(),
            acro_interval: step4_acro_interval(),
            interval: [state.settings.start, state.settings.end],
        }
    })
}

// Вкладка оси: плитки (название → [значение, подпись]) и названия строк таблицы качества
async function tab4(page, axis) {
    await page.click('#step4_tab_' + axis)
    return page.evaluate(() => ({
        tiles: Object.fromEntries([...document.querySelectorAll('#metrics4 .stat')].map((s) => [s.querySelector('.stat__k').textContent,
            [s.querySelector('.stat__v').textContent, s.querySelector('.stat__s')?.textContent ?? '']])),
        quality: [...document.querySelectorAll('#quality4 tbody tr')].map((tr) => tr.cells[0].firstChild.textContent),
    }))
}

async function main() {
    const log_path = find_log()
    if (log_path == null) {
        console.log('tunewizard-browser-log4: четвёртый лог не найден (TUNEWIZARD_LOG4 или TuneWizard/logs/' + log4_name + ') — пропуск')
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

        // Шаг 0: плата, прошивка, интервал по умолчанию — режимы смешаны (ACRO с соседним)
        await page.setInputFiles('#fileItem', log_path)
        await page.locator('#log_verdict').waitFor({ state: 'visible', timeout: 180000 })
        await wait_overlay(page)
        assert.deepEqual(await visible_steps(page), ['0'])
        const info = await page.evaluate(() => ({ board: state.info.board, fw: state.info.fw_string, interval: [state.settings.start, state.settings.end] }))
        assert.equal(info.board, 'StellarH7V2 0045002A 33335108 33313637')
        assert.match(info.fw, /^ArduCopter V4\.7\.2/, info.fw)
        assert.deepEqual(info.interval, [282, 370], 'интервал по умолчанию')

        // Шаг 1: окно 2048, поток GYR не рвётся — окна FFT есть
        await page.fill('#FFTWindow_size', '2048')
        await page.dispatchEvent('#FFTWindow_size', 'change')
        await page.click('#wizbar button:nth-child(2)')
        await wait_overlay(page)
        const s1 = await page.evaluate(() => ({ ready: step1_ready(), fft_key: step1.fft_key, peaks: document.querySelectorAll('#peaks1 tbody tr').length }))
        assert.deepEqual([s1.ready, s1.fft_key], [true, 'raw:2048'], 'окно 2048: расчёт готов')
        assert.ok(s1.peaks > 0, 'пики спектра: ' + s1.peaks)

        // Шаг 4, интервал по умолчанию: смешение режимов — прежнее «ненадёжно (б)», шума и строки (г) нет, есть кнопка участка ACRO
        await page.click('#wizbar button:nth-child(5)')
        await wait_overlay(page)
        const d4 = await read4(page)
        for (const axis of axes) {
            assert.equal(d4.calc[axis].status, 'unreliable', axis + ' на 282–370 с: ' + JSON.stringify(d4.calc[axis]))
            assert.equal(d4.calc[axis].noise, false, axis + ': шума суррогатов на смешанном интервале нет')
        }
        assert.match(d4.verdict, /\(б\)/, d4.verdict)
        assert.equal(d4.acro_button, true, 'кнопка «Интервал — участок ACRO» видна')
        assert.deepEqual(d4.acro_interval, { start: 289, end: 370 })
        for (const axis of axes) {
            const t = await tab4(page, axis)
            assert.ok(!Object.values(t.tiles).some(([v]) => v.includes(' ± ')), axis + ': на смешанном интервале «±» нет: ' + JSON.stringify(t.tiles))
            assert.ok(!t.quality.some((title) => title.includes('(г)')), axis + ': строки (г) нет: ' + t.quality.join('; '))
        }

        // Кнопка → участок ACRO 289–370 с; время расчёта шага 4
        const t0 = Date.now()
        await page.click('#step4_acro_interval')
        await wait_overlay(page)
        await page.waitForFunction(() => (state.settings.start === 289) && (state.settings.end === 370) && (step4.calc?.roll?.status === 'ok') && (step4.calc?.yaw?.status === 'imprecise'),
                                   null, { timeout: 180000 })
        const calc_s = (Date.now() - t0) / 1000
        const a4 = await read4(page)
        assert.deepEqual(a4.interval, [289, 370])
        assert.deepEqual([a4.calc.roll.status, a4.calc.roll.change], ['ok', null], 'крен: надёжно, правил нет — ' + JSON.stringify(a4.calc.roll))
        assert.deepEqual([a4.calc.pitch.status, a4.calc.pitch.borderline], ['ok', 20], 'тангаж: на границе 20 % — ' + JSON.stringify(a4.calc.pitch))
        assert.equal(a4.calc.yaw.status, 'imprecise', 'рыскание: мало точности (г)')
        const need = a4.calc.yaw.need_s
        assert.ok((need >= 50) && (need <= 110) && (need % 5 === 0), 'рыскание: ещё ' + need + ' с (50–110, кратно 5)')
        for (const axis of axes) {
            assert.equal(a4.calc[axis].noise, true, axis + ': шум суррогатов есть')
        }
        assert.ok(!/нужен тестовый полёт|Слетайте/.test(a4.verdict), 'в сводке нет «нужен тестовый полёт» и «Слетайте»: ' + a4.verdict)
        const advice_yaw = 'рыскание — ещё ≈ ' + need + ' с резких манёвров по рысканию в Acro «Rate Loop Only», полными отклонениями стика'
        assert.ok(a4.verdict.includes(advice_yaw), 'совет по рысканию в сводке: ' + a4.verdict)
        assert.ok(calc_s <= 10, 'расчёт шага 4 на участке ACRO: ' + calc_s.toFixed(1) + ' с (не больше 10)')
        const pitch = await tab4(page, 'pitch')
        assert.ok(pitch.tiles['Перерегулирование'][0].includes(' ± '), 'тангаж: плитка перерегулирования с «±»: ' + JSON.stringify(pitch.tiles))
        assert.ok(pitch.tiles['Нарастание 10–90 %'][0].includes(' ± '), 'тангаж: нарастание с «±»')
        assert.ok(pitch.quality.some((title) => title.includes('(г) точность отклика')), 'тангаж: строка (г): ' + pitch.quality.join('; '))
        const roll = await tab4(page, 'roll')
        assert.ok(roll.tiles['Нарастание 10–90 %'][1].includes('начало отклика не определено'), 'крен: пометка раннего отклика: ' + roll.tiles['Нарастание 10–90 %'][1])
        const line4 = JSON.stringify(Object.fromEntries(axes.map((axis) => [axis, a4.calc[axis].status])))

        // Повторный расчёт — те же числа (зёрна суррогатов фиксированы)
        // Запоминаем прежний объект расчёта и ждём новый: иначе ожидание оверлея могло бы завершиться сразу и сравнить расчёт с самим собой
        await page.evaluate(() => {
            window.__calc_before = step4.calc
            step4.key = null
            step4_show()
        })
        await page.waitForFunction(() => (step4.calc != null) && (step4.calc !== window.__calc_before) && (step4.calc.yaw?.status != null) &&
                                         (document.getElementById('loading').style.visibility === 'hidden'), null, { timeout: 180000 })
        const again = await read4(page)
        assert.equal(again.calc.yaw.need_s, need, 'повторный расчёт: ещё N с')
        for (const axis of axes) {
            assert.ok(Number.isFinite(a4.calc[axis].halves_null) && Number.isFinite(a4.calc[axis].sigma_step), axis + ': шум (б) и σ отклика посчитаны: ' + JSON.stringify(a4.calc[axis]))
            assert.equal(again.calc[axis].halves_null, a4.calc[axis].halves_null, axis + ': повторный расчёт — шум (б) тот же')
            assert.equal(again.calc[axis].sigma_step, a4.calc[axis].sigma_step, axis + ': повторный расчёт — σ отклика та же')
        }

        // Шаг 5 на участке ACRO, ничего не принято: вердикт «см. советы по осям», в списке — совет по рысканию
        await page.click('#wizbar button:nth-child(6)')
        const v5 = await page.evaluate(() => ({ verdict: document.getElementById('verdict5').textContent,
                                                 refly: [...document.querySelectorAll('#refly5 li')].map((li) => li.textContent) }))
        assert.match(v5.verdict, /см\. советы по осям/, v5.verdict)
        assert.ok(v5.refly.includes('Рыскание — ещё ≈ ' + need + ' с резких манёвров по рысканию в Acro «Rate Loop Only», полными отклонениями стика.'), 'совет в списке: ' + v5.refly.join(' | '))
        assert.ok(!v5.refly.some((t) => /нужен тестовый полёт|Слетайте/.test(t)), 'в списке нет «нужен тестовый полёт»: ' + v5.refly.join(' | '))

        // Возврат интервала по умолчанию на шаге 0 — снова «ненадёжно» без «±» и (г)
        await page.click('#wizbar button:nth-child(1)')
        await page.fill('#TimeStart', '282')
        await page.dispatchEvent('#TimeStart', 'change')
        await page.fill('#TimeEnd', '370')
        await page.dispatchEvent('#TimeEnd', 'change')
        await page.click('#wizbar button:nth-child(5)')
        await wait_overlay(page)
        await page.waitForFunction(() => (state.settings.start === 282) && (step4.calc?.roll?.status === 'unreliable'), null, { timeout: 180000 })
        const back = await read4(page)
        for (const axis of axes) {
            assert.equal(back.calc[axis].status, 'unreliable', axis + ' снова ненадёжно')
            const t = await tab4(page, axis)
            assert.ok(!Object.values(t.tiles).some(([v]) => v.includes(' ± ')), axis + ': «±» нет')
            assert.ok(!t.quality.some((title) => title.includes('(г)')), axis + ': строки (г) нет')
        }

        // Шаг 5 на интервале по умолчанию: вердикт и список «Что перелететь» не расходятся — советы по осям, а не «нужен тестовый полёт»
        await page.click('#wizbar button:nth-child(6)')
        const back5 = await page.evaluate(() => ({ verdict: document.getElementById('verdict5').textContent,
                                                    refly: [...document.querySelectorAll('#refly5 li')].map((li) => li.textContent) }))
        assert.match(back5.verdict, /см\. советы по осям/, back5.verdict)
        assert.ok(!/нужен тестовый полёт/.test(back5.verdict), 'в вердикте шага 5 нет «нужен тестовый полёт»: ' + back5.verdict)
        assert.ok(back5.refly.some((t) => t.includes('сузьте интервал анализа до участка ACRO (289–370 с)')), 'в списке — сузить интервал: ' + back5.refly.join(' | '))

        assert.deepEqual(problems, [], 'ошибки консоли')
        console.log('tunewizard-browser-log4: шаги 0, 1, 4, 5 пройдены на ' + path.basename(log_path) + ' (' + info.board + ', ' + info.fw + '); шаг 4 на ACRO 289–370 с: ' + line4 +
            ', рыскание — ещё ≈ ' + need + ' с, расчёт ' + calc_s.toFixed(1) + ' с')
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
