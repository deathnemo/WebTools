// Прогон мастера настройки на третьем логе — QuadPlane (VTOL-часть ArduPlane), которого нет в основном браузерном тесте:
// ArduPlane 4.6.3, tailsitter QUAD/X (Q_TAILSIT_ENABLE = 2), весь полёт в QSTABILIZE, газ VTOL-моторов в QTUN.ThO
// (CTUN.ThO — самолётный мотор, нули), PIQR/PIQP/PIQY 24 Гц, batch гироскопа ICM45686 с INS_LOG_BAT_OPT = 5, ESC-телеметрия.
// Этап 9 (docs/plans/2026-10-30-tune-wizard-stage9-design.md, разделы 2, 4, 5, 7): шаг 0 — вид и плитки, интервал по
// умолчанию — VTOL-окно, проверки; шаг 1 — спектр, заметка об осях tailsitter, «до» и «после» batch; шаг 2 — варианты
// notch; шаг 3 (раздел 6) — имена Q_A_*, значения лога, без размера винта и рекомендации (и в текстах шага), «Лог +
// правило /2», шум D крена по оси Z, «Принять» — переход к шагу 5; шаг 4 — выключен с подсказкой; шаг 5 (раздел 8) —
// сводка с Q_A_*, строка шага 4 «недоступен», повтор — шаги 2–3, _tune.param, «Запомнить проход» (ключ с видом
// аппарата), повторная загрузка лога — прошлый проход на шаге 0. В конце — лог Copter (второй лог, если есть): всё, что
// показано только для QuadPlane, сбрасывается, прошлый проход QuadPlane не показан. Отдельный скрипт, как прогон второго
// лога (tests/tunewizard-browser-log2.cjs).
// Запуск: npm run test:tunewizard-log3
// Нужны: третий лог (TUNEWIZARD_LOG3 или TuneWizard/logs/1 01.01.1980 2-00-00.bin), браузер (CHROME_PATH — путь к
// chrome.exe; без него Playwright берёт свой Chromium, если он установлен) и python для http.server. Без лога тест
// пропускается с сообщением; без второго лога (TUNEWIZARD_LOG2 или TuneWizard/logs/1 01.01.1970 2-00-00.bin) — только
// проверка сброса на лог Copter
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { chromium } = require('playwright')

const repo = path.resolve(__dirname, '..')
const logs_dir = path.join(repo, 'TuneWizard', 'logs')
const port = 8798
const log3_name = '1 01.01.1980 2-00-00.bin'
const log2_name = '1 01.01.1970 2-00-00.bin'

function find_log() {
    if (process.env.TUNEWIZARD_LOG3) {
        return process.env.TUNEWIZARD_LOG3
    }
    const full = path.join(logs_dir, log3_name)
    return fs.existsSync(full) ? full : null
}

// Лог Copter для проверки сброса после QuadPlane — второй лог (как в tests/tunewizard-browser-log2.cjs); null — нет
function find_copter_log() {
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
                default_note: document.getElementById('interval_default_note').checkVisibility(),
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
        assert.equal(s0.default_note, false, 'общее «по умолчанию — участок с ненулевым газом» заменено подписью VTOL-окна')
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
        assert.match(s0.closed4, /^Шаг 4 \(PID\) для QuadPlane пока недоступен: метод ещё не проверен на логе QuadPlane, .+ лог полёта в QACRO с PID на частоте цикла\./, s0.closed4)
        assert.doesNotMatch(s0.closed4, /25 Гц|QSTABILIZE/, 'без частностей этого лога')
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

        // ---------- Шаг 3: Q_A_*, значения лога, без размера винта и рекомендации, «Лог + правило /2», ось Z tailsitter
        // Размер винта Copter в поле (память браузера) у QuadPlane не действует
        await page.evaluate(() => { document.getElementById('prop_in').value = '10' })
        await page.click('#wizbar button:nth-child(4)')
        await wait_overlay(page)
        await page.waitForFunction(() => (step3.candidates != null) && (step_metadata() != null) && (document.querySelector('#lpf_form p.param .units')?.textContent !== ''),
                                   null, { timeout: 120000 })
        const s3 = await page.evaluate(() => {
            const dterm = document.getElementById('DTerm3')
            const units = Object.fromEntries([...document.querySelectorAll('#lpf_form p.param')].map((p) => [p.dataset.name, p.querySelector('.units').textContent]))
            const e = step3.evaluations?.log ?? null
            const section = document.querySelector('section[data-step="3"]')
            return {
                // Тексты шага без размера винта: заголовок, вступление, заметка под формой (части data-prop3), порог правила /2
                title: section.querySelector('h2').innerText, lede: section.querySelector('.lede').innerText,
                form_note: document.getElementById('lpf_form').nextElementSibling.innerText,
                vehicle_text: document.getElementById('step3_vehicle_note').innerText,
                pid_min: [document.querySelector('[data-rule3="pid_min"]').textContent, String(lowpass_rules.pid_filter_min_hz)],
                prop_lab: document.getElementById('prop_lab').checkVisibility(), vehicle_note: document.getElementById('step3_vehicle_note').checkVisibility(),
                names: step3.form_names, units: units, groups: [...document.querySelectorAll('#lpf_form h3')].map((h) => h.textContent),
                ids: step3.candidates.map((c) => c.id), recommended: step3_recommended_id(), selected: step3.selected_id,
                log: step3.candidates[0].values, half: step3.candidates[1]?.values ?? null,
                axes: step3.ctx?.pid_axes ?? null, loop_rate: step3.ctx?.loop_rate ?? null,
                dterm_dB: (e != null) ? [e.dterm.roll?.dB, e.dterm.pitch?.dB] : null, flags: step3.flags,
                verdict: document.getElementById('verdict3').textContent, verdict_class: document.getElementById('verdict3').className,
                note: document.getElementById('candidates3_note').textContent,
                dterm_groups: dterm.data.map((t) => t.legendgrouptitle.text), dterm_colors: dterm.data.map((t) => t.line.color),
                dterm_drawn: dterm.data.filter((t) => t.y.length > 0).length, palette: plot_palette().axis,
            }
        })
        assert.deepEqual([s3.prop_lab, s3.vehicle_note], [false, true], 'блока размера винта нет, заметка QuadPlane видна')
        // Тексты шага — без размера винта и формул Mission Planner; рыскание и пределы — не «по правилам»
        assert.equal(s3.title, 'Фильтры гироскопа и ПИД')
        assert.match(s3.lede, /^Мастер сравнивает варианты частот фильтра гироскопа и фильтров ПИД по данным лога: шум гироскопа после фильтров/, s3.lede)
        assert.doesNotMatch(s3.lede, /размеру винта|Mission Planner/)
        assert.match(s3.form_note, / FLTT фильтрует только цель и в метрики не входит; рыскание \(FLTT — по правилу \/2\) и пределы ускорения \(из лога\) — без метрик\. Файла/, s3.form_note)
        assert.doesNotMatch(s3.form_note, /по правилам/)
        assert.equal(s3.pid_min[0], s3.pid_min[1], 'порог правила /2 в заметке — из lowpass_rules')
        assert.match(s3.vehicle_text, /= max\(10, INS_GYRO_FILTER \/ 2\)/)
        assert.equal(s3.names.some((name) => name.startsWith('ATC_')), false, 'имена шага — без ATC_*: ' + s3.names.join(', '))
        assert.deepEqual(s3.names.slice(-3), ['Q_A_ACCEL_R_MAX', 'Q_A_ACCEL_P_MAX', 'Q_A_ACCEL_Y_MAX'], 'пределы 4.6 — Q_A_ACCEL_*')
        assert.deepEqual([s3.units.Q_A_ACCEL_R_MAX, s3.units.Q_A_RAT_RLL_FLTD], ['cdeg/s/s', 'Hz'], 'описания Q_A_* — по ATC_*, пределы — сантиградусы/с²')
        assert.ok(s3.groups.includes('Крен · Q_A_RAT_RLL_*') && s3.groups.includes('Пределы ускорения · Q_A_ACCEL_*_MAX'), s3.groups.join('; '))
        assert.deepEqual([s3.ids, s3.recommended, s3.selected], [['log', 'half'], null, 'log'], 'варианты без «по размеру винта», рекомендации нет')
        // «Как в логе» — значения лога (дизайн, раздел 6 [лог]), «Лог + правило /2» — FLTT и FLTD 20
        assert.deepEqual([s3.log.Q_A_RAT_RLL_FLTD, s3.log.Q_A_RAT_PIT_FLTD, s3.log.INS_GYRO_FILTER], [25.5, 25.5, 40])
        assert.deepEqual([s3.log.Q_A_ACCEL_R_MAX, s3.log.Q_A_ACCEL_P_MAX, s3.log.Q_A_ACCEL_Y_MAX], [70000, 70000, 28800])
        assert.deepEqual([s3.half.Q_A_RAT_RLL_FLTT, s3.half.Q_A_RAT_RLL_FLTD, s3.half.Q_A_RAT_PIT_FLTT, s3.half.Q_A_RAT_PIT_FLTD, s3.half.Q_A_RAT_YAW_FLTT],
                         [20, 20, 20, 20, 20])
        // Метрики: шум D крена — по оси Z (tailsitter), контур — SCHED_LOOP_RATE лога
        assert.deepEqual([s3.axes?.roll.gyro, s3.axes?.pitch.gyro, s3.loop_rate], ['z', 'y', 400])
        assert.ok((s3.dterm_dB != null) && s3.dterm_dB.every(Number.isFinite), 'шум D посчитан: ' + JSON.stringify(s3.dterm_dB))
        assert.match(s3.verdict, /^Рекомендации нет: формулы по размеру винта для QuadPlane нет — выбор за вами\. «Лог \+ правило \/2» против лога/, s3.verdict)
        assert.match(s3.verdict, /Меняется: Q_A_RAT_RLL_FLTT 25\.5 → 20, Q_A_RAT_RLL_FLTD 25\.5 → 20, .*Шум гироскопа /, s3.verdict)
        assert.match(s3.verdict_class, /verdict--(ok|warn)/, s3.verdict)
        assert.doesNotMatch(s3.note, /Введите размер винта/)
        assert.match(s3.note, /Шум D крена VTOL — по оси Z гироскопа/)
        // График D: крен VTOL — подпись и цвет оси Z, тангаж — оси Y
        assert.deepEqual(s3.dterm_groups, ['Крен VTOL (Z)', 'Крен VTOL (Z)', 'Тангаж', 'Тангаж'])
        assert.deepEqual(s3.dterm_colors, [s3.palette.z, s3.palette.z, s3.palette.y, s3.palette.y])
        assert.equal(s3.dterm_drawn, 4, 'трассы D обеих осей нарисованы')

        // «Лог + правило /2» → «Применить вариант» → «Принять»: принято с именами Q_A_*, шаг 4 закрыт — переход к сводке
        // (шаг 5; дизайн этапа 9, раздел 8, решение координатора 03.11.2026)
        await page.check('#cand3_half')
        await page.click('#cand3_apply')
        await page.waitForFunction(() => (step3.edit_timer == null) && (step3_form_row()?.id === 'half'), null, { timeout: 60000 })
        await page.click('#lpf_accept')
        await wait_overlay(page)
        const a3 = await page.evaluate(() => ({ step: state.step, id: state.steps[3]?.candidate_id, names: Object.keys(state.steps[3]?.accepted ?? {}),
                                                 verdict: document.getElementById('verdict3').textContent }))
        assert.deepEqual([a3.step, a3.id], [5, 'half'], 'после «Принять» шага 3 — сводка: шаг 4 закрыт')
        assert.deepEqual(await visible_steps(page), ['5'])
        assert.deepEqual(a3.names, s3.names, 'принятые — под именами формы (Q_A_*)')
        assert.match(a3.verdict, /^Принято: «Лог \+ правило \/2» — шум гироскопа /, a3.verdict)

        // ---------- Шаг 5: сводка с именами Q_A_*, строка шага 4 «недоступен», повтор — шаги 2–3, .param, память прохода
        await page.waitForFunction(() => !document.getElementById('verdict5').hidden && (step_metadata() != null), null, { timeout: 60000 })
        const s5 = await page.evaluate(() => {
            const rows = (selector) => [...document.querySelectorAll(selector + ' tbody tr')].map((tr) => [...tr.cells].map((td) => td.textContent))
            const ctx = step_summary_context()
            const summary = summary_rows(ctx)
            return {
                verdict: document.getElementById('verdict5').textContent, verdict_class: document.getElementById('verdict5').className,
                steps: rows('#steps5'), changes: rows('#changes5'), unchanged: rows('#unchanged5').map((row) => row[0]),
                refly: [...document.querySelectorAll('#refly5 li')].map((li) => li.textContent),
                buttons: ['step5_download', 'step5_remember'].map((id) => document.getElementById(id).disabled),
                names3: ctx.names[3], param: summary_param_text(summary.rows, ctx.bits),
                changed: summary.rows.filter((row) => row.changed).length,
            }
        })
        assert.deepEqual(s5.names3, s3.names, 'имена шага 3 в контексте итога — с префиксом профиля (Q_A_*)')
        assert.doesNotMatch(s5.verdict, /^Менять нечего/, 'принят шаг 3 с изменениями — не «менять нечего»: ' + s5.verdict)
        assert.match(s5.verdict, new RegExp('^(Готово: изменено|Изменено) ' + s5.changed + ' параметр'), s5.verdict)
        assert.ok(s5.changed > 0)
        assert.deepEqual(s5.steps.map((row) => row[1]), ['не принят', 'принят', 'недоступен'], JSON.stringify(s5.steps))
        assert.equal(s5.steps[2][2], s0.closed4, 'строка шага 4 — текст подсказки закрытого шага')
        assert.ok(s5.changes.length === s5.changed, JSON.stringify(s5.changes))
        assert.ok(s5.changes.every((row) => row[0].startsWith('Q_A_RAT_') && (row[3] === '3')), 'изменены только Q_A_* шага 3: ' + JSON.stringify(s5.changes))
        assert.ok([...s5.changes.map((row) => row[0]), ...s5.unchanged].every((name) => !name.startsWith('ATC_')), 'в сводке нет ATC_*')
        assert.ok(s5.unchanged.includes('Q_A_ACCEL_R_MAX') && s5.unchanged.includes('INS_GYRO_FILTER'), s5.unchanged.join(', '))
        assert.match(s5.refly.at(-1), /^Слетайте тем же профилем и загрузите лог в мастер: шаг 0 покажет, что применено, шаги 2–3 — сбылся ли прогноз\.$/, s5.refly.at(-1))
        assert.deepEqual(s5.buttons, [false, false], '«Скачать .param» и «Запомнить проход» доступны')
        // «Скачать .param»: файл <лог>_tune.param — только изменённые Q_A_* (тот же текст, что у ядра)
        const [download5] = await Promise.all([page.waitForEvent('download'), page.click('#step5_download')])
        assert.equal(download5.suggestedFilename(), path.basename(log_path).replace(/\.[^.]*$/, '') + '_tune.param')
        const param5 = fs.readFileSync(await download5.path(), 'utf8')
        assert.equal(param5, s5.param)
        assert.ok(param5.trim().split('\n').every((line) => /^Q_A_RAT_[A-Z]{3}_FLT[TD],20$/.test(line)), param5)
        // «Запомнить проход»: ключ — с видом аппарата, в записи kind и имена Q_A_*
        await page.click('#step5_remember')
        const m5 = await page.evaluate(() => {
            const data = JSON.parse(localStorage.getItem('tunewizard_v1'))
            const key = passmem_aircraft_key(state.info, state.file_name)
            return { note: document.getElementById('step5_note').textContent, keys: Object.keys(data.passes), key: key, record: data.passes[key] }
        })
        assert.equal(m5.note, 'Память прохода сохранена.')
        assert.match(m5.key, /^quadplane·(fc|log):/, m5.key)
        assert.deepEqual(m5.keys, [m5.key])
        assert.equal(m5.record.kind, 'quadplane')
        assert.deepEqual(m5.record.changed.map((change) => change.name), s5.changes.map((row) => row[0]))
        assert.equal(m5.record.estimates[4], null, 'шага 4 нет — оценок нет')

        // ---------- Тот же лог снова: шаг 0 показывает прошлый проход — «это лог прошлого прохода»
        await page.setInputFiles('#fileItem', log_path)
        await page.waitForFunction(() => (state.info != null) && (state.step === 0) && (memory_state.key != null), null, { timeout: 180000 })
        await wait_overlay(page)
        const m0 = await page.evaluate(() => ({
            visible: document.getElementById('memory0').checkVisibility(), key: memory_state.key, pass: memory_state.pass?.key ?? null,
            head: document.getElementById('memory0_head').textContent, verdict: document.getElementById('memory0_verdict').textContent,
            rows: [...document.querySelectorAll('#memory0_table tbody tr')].map((tr) => [...tr.cells].map((td) => td.textContent)),
        }))
        assert.deepEqual([m0.visible, m0.key, m0.pass], [true, m5.key, m5.key], 'проход QuadPlane найден по ключу с видом')
        assert.match(m0.head, new RegExp('^Сохранён .+, лог ' + path.basename(log_path).replace(/\./g, '\\.') + ', прошивка ArduPlane V4\\.6\\.3'), m0.head)
        assert.equal(m0.verdict, 'Это лог прошлого прохода — значения ещё не применялись.')
        assert.deepEqual(m0.rows.map((row) => [row[0], row[3], row[4]]), s5.changes.map((row) => [row[0], '3', 'другое значение']))

        // ---------- Шаг 4: кнопка выключена и с подсказкой и после шагов 1–3
        const b4 = await page.evaluate(() => { const b = document.querySelector('#wizbar button:nth-child(5)'); return [b.disabled, b.getAttribute('title')] })
        assert.deepEqual(b4, [true, s0.closed4])

        // ---------- Ошибка загрузки после QuadPlane (файл не лог): подпись газа графика — снова «Газ» (reset)
        await page.setInputFiles('#fileItem', path.join(repo, 'tests', 'fixtures', 'prep.param'))
        await page.waitForFunction(() => (state.log == null) && document.getElementById('log_verdict').classList.contains('verdict--fail'), null, { timeout: 60000 })
        const failed = await page.evaluate(() => {
            const flight = document.getElementById('FlightData')
            return { throttle: [flight.data[2].name, flight.layout.yaxis3.title.text], b4: document.querySelector('#wizbar button:nth-child(5)').getAttribute('title'),
                     prop_lab: document.getElementById('prop_lab').hidden }
        })
        assert.deepEqual(failed, { throttle: ['Газ', 'Газ'], b4: null, prop_lab: false }, 'после ошибки загрузки — без следов QuadPlane')

        // ---------- Лог Copter после QuadPlane: подсказка шага 4 снята и шаг доступен, заметки VTOL и tailsitter скрыты,
        // подпись газа «Газ», блок размера винта шага 3 снова виден
        const copter_log = find_copter_log()
        let reset = null
        if (copter_log != null) {
            await page.setInputFiles('#fileItem', copter_log)
            await page.waitForFunction(() => state.kind === 'copter', null, { timeout: 180000 })
            await wait_overlay(page)
            reset = await page.evaluate(() => {
                const b = document.querySelector('#wizbar button:nth-child(5)')
                const flight = document.getElementById('FlightData')
                return {
                    kind: state.kind, b4: [b.disabled, b.getAttribute('title')],
                    vtol_note: document.getElementById('interval_vtol_note').hidden, default_note: document.getElementById('interval_default_note').hidden,
                    axes_note: document.getElementById('spec_axes_note').hidden,
                    throttle: [flight.data[2].name, flight.layout.yaxis3.title.text],
                    tiles: [...document.querySelectorAll('#log_info .stat__k')].map((k) => k.textContent),
                    prop_lab: document.getElementById('prop_lab').hidden, vehicle_note3: document.getElementById('step3_vehicle_note').hidden,
                    prop3: [...document.querySelectorAll('[data-prop3]')].map((part) => [part.dataset.prop3, part.hidden]),
                    memory0: document.getElementById('memory0').checkVisibility(), memory_key: memory_state.key, memory_pass: memory_state.pass,
                    memory_list: memory_step0.list.map((pass) => pass.key),
                }
            })
            assert.equal(reset.kind, 'copter')
            assert.deepEqual(reset.b4, [false, null], 'шаг 4 доступен, подсказки нет')
            assert.deepEqual([reset.vtol_note, reset.default_note, reset.axes_note], [true, false, true], 'подпись VTOL-окна и заметка tailsitter скрыты, общая подпись — полная')
            assert.deepEqual(reset.throttle, ['Газ', 'Газ'], 'ряд и ось газа — «Газ»')
            assert.ok(reset.tiles.includes('Средний газ') && !reset.tiles.includes('Средний газ VTOL'), reset.tiles.join('; '))
            assert.deepEqual([reset.prop_lab, reset.vehicle_note3], [false, true], 'шаг 3: блок размера винта виден, заметки QuadPlane нет')
            assert.deepEqual(reset.prop3, [['on', false], ['on', false], ['off', true], ['on', false], ['off', true]], 'тексты шага 3 — снова про размер винта')
            // Прошлый проход QuadPlane лог Copter не показывает и не предлагает в списке (другой вид аппарата)
            assert.match(reset.memory_key, /^(fc|log):/, reset.memory_key)
            assert.deepEqual([reset.memory0, reset.memory_pass, reset.memory_list], [false, null, []], 'блок «Прошлый проход» скрыт')
        }

        assert.deepEqual(problems, [], 'ошибки консоли')
        const band_text = (band) => ['x', 'y', 'z'].map((axis) => axis.toUpperCase() + ' ' + s1.bands[band][axis].toFixed(1)).join(', ')
        console.log('tunewizard-browser-log3: шаги 0–3, 5 и закрытый шаг 4 пройдены на ' + path.basename(log_path) + ' (' + s0.board + ', ' + s0.fw + ')')
        console.log('  шаг 0: интервал ' + s0.interval.join('–') + ' с, «' + s0.checks.flight.text + '»; проверки ' + JSON.stringify(statuses))
        console.log('  шаг 1: трасс с данными ' + s1.with_data + ', пиков ' + s1.peaks + ', вердикт «' + s1.verdict + '»; «после − до», дБ: 5–30 Гц ' + band_text('low') +
            '; 100–200 Гц ' + band_text('high'))
        console.log('  шаг 2: варианты ' + s2.titles.join('; ') + '; вердикт «' + s2.verdict + '»')
        console.log('  шаг 3: варианты ' + s3.ids.join(', ') + ', шум D крена (Z) / тангажа (Y) ' + s3.dterm_dB.map((v) => v.toFixed(1)).join(' / ') + ' дБ; вердикт «' + s3.verdict + '»')
        console.log('  шаг 5: «' + s5.verdict + '»; .param: ' + param5.trim().split('\n').join(', ') + '; память — ' + m5.key)
        console.log('  лог Copter после QuadPlane: ' + ((reset != null) ? 'сброс проверен на ' + path.basename(copter_log) : 'второго лога нет — не проверялся'))
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
