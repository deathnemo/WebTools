// Прогон мастера настройки на третьем логе — QuadPlane (VTOL-часть ArduPlane), которого нет в основном браузерном тесте:
// ArduPlane 4.6.3, tailsitter QUAD/X (Q_TAILSIT_ENABLE = 2), весь полёт в QSTABILIZE, газ VTOL-моторов в QTUN.ThO
// (CTUN.ThO — самолётный мотор, нули), PIQR/PIQP/PIQY 24 Гц, batch гироскопа ICM45686 с INS_LOG_BAT_OPT = 5, ESC-телеметрия.
// Этап 9 (docs/plans/2026-10-30-tune-wizard-stage9-design.md, разделы 2, 4, 5, 7): шаг 0 — вид и плитки, интервал по
// умолчанию — VTOL-окно, проверки; шаг 1 — спектр, заметка об осях tailsitter, «до» и «после» batch; шаг 2 — варианты
// notch; шаг 4 — выключен с подсказкой. Шаги 3 и 5 добавят задачи 3–4 этапа. Отдельный скрипт, как прогон второго лога
// (tests/tunewizard-browser-log2.cjs).
// Запуск: npm run test:tunewizard-log3
// Нужны: третий лог (TUNEWIZARD_LOG3 или TuneWizard/logs/1 01.01.1980 2-00-00.bin), браузер (CHROME_PATH — путь к
// chrome.exe; без него Playwright берёт свой Chromium, если он установлен) и python для http.server. Без лога тест
// пропускается с сообщением
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { chromium } = require('playwright')

const repo = path.resolve(__dirname, '..')
const logs_dir = path.join(repo, 'TuneWizard', 'logs')
const port = 8798
const log3_name = '1 01.01.1980 2-00-00.bin'

function find_log() {
    if (process.env.TUNEWIZARD_LOG3) {
        return process.env.TUNEWIZARD_LOG3
    }
    const full = path.join(logs_dir, log3_name)
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

async function main() {
    const log_path = find_log()
    if (log_path == null) {
        console.log('tunewizard-browser-log3: третий лог не найден (TUNEWIZARD_LOG3 или TuneWizard/logs/' + log3_name + ') — пропуск')
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

        // ---------- Шаг 0: вид аппарата, плитки, интервал VTOL, график полёта, проверки, шаг 4 закрыт
        await page.setInputFiles('#fileItem', log_path)
        await page.locator('#log_verdict').waitFor({ state: 'visible', timeout: 180000 })
        await wait_overlay(page)
        assert.deepEqual(await visible_steps(page), ['0'])
        const s0 = await page.evaluate(() => {
            const note = document.getElementById('interval_vtol_note')
            const throttle = document.getElementById('FlightData').data[2]
            let throttle_max = 0
            for (const value of throttle.y) {
                throttle_max = Math.max(throttle_max, value)
            }
            return {
                kind: state.kind, profile: state.profile?.kind ?? null, info_kind: state.info.kind, vehicle: state.info.vehicle, tailsitter: state.info.tailsitter,
                fw: state.info.fw_string, board: state.info.board, throttle_source: state.info.throttle_source,
                interval: [state.settings.start, state.settings.end], fields: [document.getElementById('TimeStart').value, document.getElementById('TimeEnd').value],
                flight: state.info.flight,
                tiles: Object.fromEntries([...document.querySelectorAll('#log_info .stat')].map((tile) =>
                    [tile.querySelector('.stat__k').textContent, { value: tile.querySelector('.stat__v').textContent, accent: tile.classList.contains('stat--accent') }])),
                note: note.checkVisibility() ? note.textContent : null,
                throttle: { name: throttle.name, axis: document.getElementById('FlightData').layout.yaxis3.title.text, count: throttle.y.length, max: throttle_max },
                checks: Object.fromEntries(state.checks.map((c) => [c.id, { status: c.status, text: c.text, fix: c.fix }])),
                wizbar: [...document.querySelectorAll('#wizbar button')].map((b) => ({ disabled: b.disabled, title: b.getAttribute('title') })),
                closed4: state.profile.closed_steps[4],
            }
        })
        assert.deepEqual([s0.kind, s0.profile, s0.info_kind, s0.vehicle, s0.tailsitter], ['quadplane', 'quadplane', 'quadplane', 'QuadPlane', true], 'QuadPlane tailsitter')
        assert.match(s0.fw, /^ArduPlane V4\.6\.3/, s0.fw)
        assert.equal(s0.throttle_source, 'QTUN.ThO', 'газ VTOL-моторов, а не CTUN.ThO самолётного мотора')
        // Плитки: вид подсвечен как поддержанный, окно и газ — VTOL
        assert.deepEqual(s0.tiles['Аппарат'], { value: 'QuadPlane · tailsitter', accent: true })
        assert.equal(s0.tiles['Полёт с газом'], undefined, 'у QuadPlane плитки «Полёт с газом» нет')
        assert.deepEqual([s0.tiles['Висение VTOL']?.value, s0.tiles['Средний газ VTOL']?.value], ['1 мин 5 с', '0.47'], JSON.stringify(s0.tiles))
        // Интервал по умолчанию — VTOL-окно (QSTABILIZE) ≈317–382 с, в полях то же; подпись о Q-режимах видна
        assert.ok((Math.abs(s0.interval[0] - 317) <= 1) && (Math.abs(s0.interval[1] - 382) <= 1), 'интервал ' + s0.interval.join('–'))
        assert.deepEqual(s0.fields, s0.interval.map(String))
        assert.deepEqual([s0.flight.start, s0.flight.end, s0.flight.modes, s0.flight.segments], [...s0.interval, [17], []], JSON.stringify(s0.flight))
        assert.ok((s0.note != null) && s0.note.includes('у QuadPlane — только VTOL-режимы (Q-режимы)'), 'подпись под полями интервала: ' + s0.note)
        // График полёта: газ VTOL-моторов (у CTUN.ThO — нули)
        assert.deepEqual([s0.throttle.name, s0.throttle.axis], ['Газ VTOL', 'Газ VTOL'])
        assert.ok((s0.throttle.count > 0) && (s0.throttle.max > 0.3), 'ряд газа VTOL: ' + JSON.stringify(s0.throttle))
        // Проверки шага 0 — дизайн этапа 9, раздел 4 ([лог])
        const statuses = Object.fromEntries(Object.entries(s0.checks).map(([id, c]) => [id, c.status]))
        assert.deepEqual(statuses, { vehicle: 'ok', pid_log: 'warn', gyro_log: 'ok', pre_post: 'warn', tracking: 'ok', flight: 'ok', vibe: 'fail', clipping: 'warn', hover_throttle: 'warn' })
        assert.match(s0.checks.vehicle.text, /^QuadPlane \(tailsitter\), ArduPlane V4\.6\.3/, s0.checks.vehicle.text)
        assert.match(s0.checks.pid_log.text, /^PIQR\/PIQP\/PIQY есть, но PIQR пишется с частотой 24\.\d Гц .*шаг 4 для QuadPlane пока недоступен$/, s0.checks.pid_log.text)
        assert.match(s0.checks.pid_log.fix, /^Включите бит ATTITUDE_FULLRATE \(20\) в LOG_BITMASK/, s0.checks.pid_log.fix)
        assert.doesNotMatch(s0.checks.pid_log.fix, /бит 12|PID \(12\)/)
        assert.match(s0.checks.pre_post.text, /INS_LOG_BAT_OPT = 5/, s0.checks.pre_post.text)
        assert.match(s0.checks.flight.text, /^Висение VTOL 6\d с \(31\d–38\d с, QSTABILIZE\), средний газ 0\.47$/, s0.checks.flight.text)
        assert.match(s0.checks.vibe.text, /71\.6 м\/с²/, s0.checks.vibe.text)
        assert.equal(s0.checks.hover_throttle.text, 'Q_M_THST_HOVER 0.35, средний газ VTOL 0.47: расхождение 0.12')
        assert.match(s0.checks.hover_throttle.fix, /^Q_M_HOVER_LEARN = 2 .* в QHOVER или QLOITER: в QSTABILIZE и QACRO газ висения не учится$/, s0.checks.hover_throttle.fix)
        // Полоса шагов: шаг 4 выключен с подсказкой (дизайн, раздел 7), у остальных подсказки нет; set_step(4) шаг не меняет
        assert.deepEqual(s0.wizbar.map((b) => b.disabled), [false, false, false, false, true, false], 'шаг 4 выключен, шаги 1–3 и 5 доступны')
        assert.match(s0.closed4, /^Шаг 4 \(PID\) для QuadPlane пока недоступен: .+Нужен лог QACRO/, s0.closed4)
        assert.deepEqual(s0.wizbar.map((b) => b.title), [null, null, null, null, s0.closed4, null], 'подсказка — только у шага 4')
        assert.equal(await page.evaluate(() => { set_step(4); return state.step }), 0, 'на закрытый шаг 4 не перейти')
        assert.deepEqual(await visible_steps(page), ['0'])

        // ---------- Шаг 1: спектр посчитан, заметка об осях tailsitter, SCHED_LOOP_RATE без лога — из профиля, «до» и «после»
        await page.click('#wizbar button:nth-child(2)')
        await wait_overlay(page)
        const s1 = await page.evaluate(() => {
            const spectrum = document.getElementById('Spectrum1')
            const note = document.getElementById('spec_axes_note')
            // Заводская частота контура профиля, если SCHED_LOOP_RATE нет в логе (у QuadPlane 300)
            const saved = state.params
            let loop_default = null
            try {
                state.params = { ...saved, get: (name) => (name === 'SCHED_LOOP_RATE') ? null : saved.get(name) }
                loop_default = values_from_log().SCHED_LOOP_RATE
            } finally {
                state.params = saved
            }
            // Средние спектры «до» и «после» первичного гироскопа в интервале, дБ: разность «после − до» в полосах
            // (INS_LOG_BAT_OPT = 5 — бит 0 вместе с битом 2, дизайн этапа 9, раздел 5)
            const gyro = state.gyro
            const range = [state.settings.start, state.settings.end]
            const amp = spectrum_amplitude_scale('dB')
            const sensor = gyro.primary ?? gyro.first_gyro
            const pre = find_instance(gyro, sensor, false)
            const post = find_instance(gyro, sensor, true)
            const bands = {}
            if ((pre != null) && (post != null)) {
                const a = mean_spectrum(gyro[pre].FFT, amp, range, alias_obj(gyro[pre].FFT, { mode: 'none' }))
                const b = mean_spectrum(gyro[post].FFT, amp, range, alias_obj(gyro[post].FFT, { mode: 'none' }))
                for (const [name, f0, f1] of [['low', 5, 30], ['high', 100, 200]]) {
                    bands[name] = {}
                    for (const axis of ['x', 'y', 'z']) {
                        let sum = 0
                        let count = 0
                        for (let k = 0; k < Math.min(a.bins.length, b.bins.length); k++) {
                            if ((a.bins[k] >= f0) && (a.bins[k] < f1)) {
                                sum += b[axis][k] - a[axis][k]
                                count++
                            }
                        }
                        bands[name][axis] = sum / count
                    }
                }
            }
            return {
                ready: step1_ready(), fft_key: step1.fft_key, error: step1.error, type: gyro.type, have_pre: gyro.have_pre, have_post: gyro.have_post,
                sensor: sensor, pre: pre, post: post, bands: bands,
                with_data: spectrum.data.filter((t) => (t.y != null) && (t.y.length > 0)).length,
                visible: spectrum.data.filter((t) => t.visible === true).length,
                peaks: document.querySelectorAll('#peaks1 tbody tr').length,
                verdict: document.getElementById('verdict1').textContent, verdict_class: document.getElementById('verdict1').className,
                info: document.getElementById('spec_info').textContent,
                note: note.checkVisibility() ? note.textContent : null,
                loop_rate: values_from_log().SCHED_LOOP_RATE, loop_log: state.params.get('SCHED_LOOP_RATE'), loop_default: loop_default,
            }
        })
        assert.deepEqual([s1.ready, s1.fft_key, s1.error, s1.type, s1.have_pre, s1.have_post], [true, 'batch:1', null, 'batch', true, true], 'batch до и после, расчёт готов')
        assert.ok((s1.with_data >= 6) && (s1.visible >= 6), 'спектр «до» и «после» по трём осям: с данными ' + s1.with_data + ', видны ' + s1.visible)
        assert.ok(s1.peaks > 0, 'пики шума найдены')
        assert.match(s1.verdict_class, /verdict--(ok|warn)/, s1.verdict)
        assert.match(s1.info, /дискретизация 31\d\d\.\d\d Гц/, 'batch на частоте датчика ≈3.2 кГц: ' + s1.info)
        assert.equal(s1.note, 'Tailsitter: ось Z гироскопа — крен VTOL, Y — тангаж, X — рыскание (со знаком минус).')
        assert.deepEqual([s1.loop_rate, s1.loop_log, s1.loop_default], [400, 400, 300], 'SCHED_LOOP_RATE — из лога, без него — заводское QuadPlane')
        // Бит 0 с битом 2 на ICM45686 (драйвер Invensensev3 выборку на частоте датчика не включает — бит 0 не действует):
        // «после» — настоящее «после фильтров»: до INS_GYRO_FILTER совпадает с «до», на 100–200 Гц ниже на десятки дБ
        for (const axis of ['x', 'y', 'z']) {
            assert.ok(Math.abs(s1.bands.low[axis]) < 4, 'ось ' + axis + ': «после − до» на 5–30 Гц ' + s1.bands.low[axis].toFixed(2) + ' дБ')
            assert.ok(s1.bands.high[axis] < -15, 'ось ' + axis + ': «после − до» на 100–200 Гц ' + s1.bands.high[axis].toFixed(2) + ' дБ')
        }

        // ---------- Шаг 2: варианты notch посчитаны
        await page.click('#wizbar button:nth-child(3)')
        await wait_overlay(page)
        await page.waitForFunction(() => (document.querySelector('label[for="INS_HNTCH_MODE"]') != null) && step2.form_ready && (step2.ranking != null), null, { timeout: 120000 })
        const s2 = await page.evaluate(() => ({
            verdict: document.getElementById('verdict2').textContent, verdict_class: document.getElementById('verdict2').className, best: step2.ranking.best_id,
            titles: [...document.querySelectorAll('#candidates2 tbody tr label')].map((label) => label.textContent),
            form_is_log: step2_key(values_from_form()) === step2_key(values_from_log()),
        }))
        assert.ok(s2.titles.includes('Как в логе') && s2.titles.some((title) => title.startsWith('Автоподбор')), 'варианты: ' + s2.titles.join('; '))
        assert.ok(s2.best != null, 'рекомендация есть')
        assert.equal(s2.form_is_log, true, 'форма из лога')
        assert.match(s2.verdict_class, /verdict--(ok|warn)/, s2.verdict)

        // ---------- Шаг 4: кнопка выключена и с подсказкой и после шагов 1–2
        const b4 = await page.evaluate(() => { const b = document.querySelector('#wizbar button:nth-child(5)'); return [b.disabled, b.getAttribute('title')] })
        assert.deepEqual(b4, [true, s0.closed4])

        assert.deepEqual(problems, [], 'ошибки консоли')
        const band_text = (band) => ['x', 'y', 'z'].map((axis) => axis.toUpperCase() + ' ' + s1.bands[band][axis].toFixed(1)).join(', ')
        console.log('tunewizard-browser-log3: шаги 0–2 и закрытый шаг 4 пройдены на ' + path.basename(log_path) + ' (' + s0.board + ', ' + s0.fw + ')')
        console.log('  шаг 0: интервал ' + s0.interval.join('–') + ' с, «' + s0.checks.flight.text + '»; проверки ' + JSON.stringify(statuses))
        console.log('  шаг 1: трасс с данными ' + s1.with_data + ', пиков ' + s1.peaks + ', вердикт «' + s1.verdict + '»; «после − до», дБ: 5–30 Гц ' + band_text('low') +
            '; 100–200 Гц ' + band_text('high'))
        console.log('  шаг 2: варианты ' + s2.titles.join('; ') + '; вердикт «' + s2.verdict + '»')
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
