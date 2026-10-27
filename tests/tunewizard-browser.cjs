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

// Ширина графиков ids равна ширине контейнера (±2 px; Plotly берёт ширину у контейнера с рамкой — getComputedStyle
// при box-sizing: border-box). Проверять в окне без полностраничного снимка: снимок меняет размер окна, обработчик
// responsive у Plotly подгоняет графики и маскирует узкий. Подгонка размера (Plots.resize) отложена — ждём до 5 с
async function assert_plot_widths(page, ids) {
    const widths = (ids) => ids.map((id) => {
        const gd = document.getElementById(id)
        return [id, gd._fullLayout.width, gd.getBoundingClientRect().width]
    })
    await page.waitForFunction((ids) => ids.every((id) => {
        const gd = document.getElementById(id)
        return Math.abs(gd._fullLayout.width - gd.getBoundingClientRect().width) <= 2
    }), ids, { timeout: 5000 }).catch(() => {})
    for (const [id, plot_width, box_width] of await page.evaluate(widths, ids)) {
        assert.ok(Math.abs(plot_width - box_width) <= 2, id + ': ширина графика ' + plot_width + ' px — ширина контейнера ' + box_width + ' px')
    }
}

// Запомнить объекты FFT экземпляров гироскопа и проверить, что они те же: перерисовка без пересчёта FFT
function remember_fft(page) {
    return page.evaluate(() => { window.__fft = state.gyro.map((g) => g?.FFT ?? null) })
}
function same_fft(page) {
    return page.evaluate(() => state.gyro.every((g, i) => (g?.FFT ?? null) === window.__fft[i]) && state.gyro.some((g) => g?.FFT != null))
}

// Сводка шага 2: строки таблицы вариантов, рекомендованный вариант, значения формы и метрики
function step2_summary(page) {
    return page.evaluate(() => {
        const rows = [...document.querySelectorAll('#candidates2 tbody tr')]
        return {
            titles: rows.map((tr) => tr.querySelector('label').textContent),
            recommended_rows: rows.filter((tr) => tr.classList.contains('recommended')).length,
            recommended_marks: (document.getElementById('candidates2').textContent.match(/рекомендуется/g) ?? []).length,
            best_id: step2.ranking.best_id,
            verdict: document.getElementById('verdict2').textContent,
            verdict_class: document.getElementById('verdict2').className,
            metrics: [...document.querySelectorAll('#metrics2 .stat')].map((tile) => tile.textContent),
            changed: [...document.querySelectorAll('#notch_form p.changed')].map((p) => p.dataset.name),
            est_y: Array.from(document.getElementById('Spectrum2').data[3].y),
        }
    })
}

// Снимок шага 1, который шаг 2 трогать не должен: объекты FFT.H экземпляров (state.filters — параметры лога)
// и данные оценки «после» на Spectrum1
function remember_step1(page) {
    return page.evaluate(() => {
        window.__step1_H = state.gyro.map((g) => g?.FFT?.H ?? null)
        window.__step1_est = Array.from(document.getElementById('Spectrum1').data[spec_trace_index(0, 2, 0)].y)
    })
}
function step1_untouched(page) {
    return page.evaluate(() => ({
        H: state.gyro.every((g, i) => (g?.FFT?.H ?? null) === window.__step1_H[i]) && window.__step1_H.some((H) => H != null),
        est: JSON.stringify(Array.from(document.getElementById('Spectrum1').data[spec_trace_index(0, 2, 0)].y)) === JSON.stringify(window.__step1_est),
    }))
}

// Сразу после «Принять» шага n (2–4): в state.steps[n].inputs — отпечаток входов текущего состояния (step_inputs_key),
// и принятое не устарело (step_accepted_stale)
async function assert_accepted_fresh(page, n) {
    const fresh = await page.evaluate((n) => ({ inputs: state.steps[n].inputs === step_inputs_key(n), stale: step_accepted_stale(n) }), n)
    assert.deepEqual(fresh, { inputs: true, stale: false }, 'шаг ' + n + ': отпечаток входов принятого — от текущего состояния')
}

// Сводка шага 3: строки таблицы вариантов (подписи, рекомендованные, текст строки по id), выбранная строка, вердикт
function step3_summary(page) {
    return page.evaluate(() => {
        const rows = [...document.querySelectorAll('#candidates3 tbody tr')]
        const title = (tr) => tr.querySelector('label').textContent
        return {
            titles: rows.map(title),
            recommended: rows.filter((tr) => tr.classList.contains('recommended')).map(title),
            recommended_marks: (document.getElementById('candidates3').textContent.match(/рекомендуется/g) ?? []).length,
            selected: document.querySelector('#candidates3 input[name="cand3"]:checked')?.value ?? null,
            row_text: Object.fromEntries(rows.map((tr) => [tr.querySelector('input[name="cand3"]').value, tr.textContent])),
            verdict: document.getElementById('verdict3').textContent,
            verdict_class: document.getElementById('verdict3').className,
        }
    })
}

// Дождаться устоявшейся таблицы шага 3: пересчёт правок прошёл (отложенного нет) и в таблице есть строка title
function wait_step3_row(page, title) {
    return page.waitForFunction((title) => (step3.edit_timer == null) &&
        [...document.querySelectorAll('#candidates3 tbody label')].some((label) => label.textContent === title), title, { timeout: 30000 })
}

// Сводка графиков шага 3 без жёстких индексов трасс: трассы с данными, наибольшая частота, фон, видимые вертикали;
// группы легенды (legendgroup → видимость трасс и заголовок группы); трассы выбранной строки — по штриху step3_dash.sel:
// их подписи в легенде и отпечаток данных (сумма конечных y по трассе) — чтобы заметить смену данных
function step3_plots(page) {
    return page.evaluate(() => Object.fromEntries(['Spectrum3', 'DTerm3', 'Bode3'].map((id) => {
        const gd = document.getElementById(id)
        const with_data = gd.data.filter((t) => t.x.length > 0)
        const groups = {}
        for (const trace of gd.data) {
            groups[trace.legendgroup] ??= { visible: [], title: trace.legendgrouptitle?.text ?? null }
            groups[trace.legendgroup].visible.push(trace.visible)
        }
        const selected = gd.data.filter((t) => t.line.dash === step3_dash.sel)
        return [id, {
            with_data: with_data.length,
            traces: gd.data.length,
            max_x: with_data.length ? Math.max(...with_data.map((t) => Math.max(...t.x))) : null,
            min_x: with_data.length ? Math.min(...with_data.map((t) => Math.min(...t.x))) : null,
            xtype: gd.layout.xaxis.type,
            bg: gd.layout.paper_bgcolor,
            vlines: (gd.layout.shapes ?? []).filter((s) => s.visible).map((s) => [s.name, s.x0]),
            groups: groups,
            selected_names: selected.filter((t) => t.showlegend !== false).map((t) => t.name),
            selected_sums: selected.map((t) => Array.from(t.y).reduce((sum, v) => Number.isFinite(v) ? sum + v : sum, 0).toFixed(6)),
        }]
    })))
}

// Сводка шага 4: открытая ось, вкладки (выбрана ли, состояние оси, что в форме), сводка и вердикт оси, строки таблицы
// (подписи, рекомендованные, отмеченная), итоги проверок (а)–(в); из расчёта открытой оси — статус, непройденные
// проверки, достоверность прогноза, окна и секунды отобранных данных
function step4_summary(page) {
    return page.evaluate(() => {
        const rows = [...document.querySelectorAll('#candidates4 tbody tr')]
        const title = (tr) => tr.querySelector('label').textContent
        const res = step4.calc?.[step4.axis] ?? null
        return {
            axis: step4.axis,
            tabs: [...document.querySelectorAll('#step4_tabs [role="tab"]')].map((tab) => ({ id: tab.id, selected: tab.getAttribute('aria-selected'),
                state: tab.querySelector('.s').textContent, form: tab.querySelector('.f').textContent })),
            verdict: document.getElementById('verdict4').textContent,
            verdict_class: document.getElementById('verdict4').className,
            axis_verdict: document.getElementById('axis_verdict4').textContent,
            axis_verdict_class: document.getElementById('axis_verdict4').className,
            titles: rows.map(title),
            recommended: rows.filter((tr) => tr.classList.contains('recommended')).map(title),
            recommended_marks: (document.getElementById('candidates4').textContent.match(/рекомендуется/g) ?? []).length,
            selected: document.querySelector('#candidates4 input[name="cand4"]:checked')?.value ?? null,
            quality: [...document.querySelectorAll('#quality4 tbody tr')].map((tr) => tr.lastElementChild.textContent),
            status: res?.status ?? null,
            failed: step4_failed_checks(res?.quality),
            predict_ok: res?.predict_ok ?? null,
            windows: res?.seg?.windows ?? 0,
            windows_text: step4_windows_text(res?.seg?.windows ?? 0),
            data_s: res?.seg?.data_s ?? 0,
            batches: (res?.set_index != null) ? (res.source.sets[res.set_index]?.length ?? 0) : 0,
            plateau: res?.metrics?.plateau ?? null,
            max_points: tarac4_max_points,
        }
    })
}

// Сводка графиков шага 4: трассы (имя, точек, конечных y, видимость, отпечаток данных — сумма конечных y), трассы
// с данными, видимые фигуры, фон, тип оси x, наименьшая частота с данными, подпись под графиком
function step4_plots(page) {
    return page.evaluate(() => Object.fromEntries(step4_plot_ids.map((id, i) => {
        const gd = document.getElementById(id)
        const traces = gd.data.map((t) => {
            const y = Array.from(t.y).filter(Number.isFinite)
            return { name: t.name, n: t.x.length, finite: y.length, visible: t.visible, sum: y.reduce((sum, v) => sum + v, 0).toFixed(6) }
        })
        const with_data = gd.data.filter((t) => Array.from(t.y).some(Number.isFinite))
        // Окна PIDReview — сотни тысяч точек: наименьшее — свёрткой, а не Math.min(...) (переполнил бы стек аргументов)
        const min_x = with_data.flatMap((t) => Array.from(t.x)).reduce((min, x) => (Number.isFinite(x) && ((min == null) || (x < min))) ? x : min, null)
        const note = document.getElementById(step4_note_ids[i])
        return [id, {
            traces: traces,
            with_data: with_data.length,
            shapes: (gd.layout.shapes ?? []).filter((s) => s.visible).map((s) => s.name),
            shape_y: Object.fromEntries((gd.layout.shapes ?? []).filter((s) => s.visible).map((s) => [s.name, s.y0])),
            bg: gd.layout.paper_bgcolor,
            xtype: gd.layout.xaxis.type,
            min_x: min_x,
            note: note.hidden ? null : note.textContent,
        }]
    })))
}

// Ключ значений формы и ключ значений варианта id — одинаковые, если вариант применён
function form_matches_variant(page, id) {
    return page.evaluate((id) => step2_key(values_from_form()) === step2_key(step2_rows().find((r) => r.id === id).values), id)
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

        // Только тёмная тема «Графит»: переключателя нет, color-scheme тёмная, фон страницы — токен --bg
        assert.equal(await page.locator('.themebar').count(), 0, 'переключателя темы нет')
        const theme = await page.evaluate(() => {
            const root = getComputedStyle(document.documentElement)
            // Цвет токена в том виде, в каком его отдаёт getComputedStyle для фона (rgb(…))
            const probe = document.createElement('div')
            probe.style.background = root.getPropertyValue('--bg')
            document.body.appendChild(probe)
            const bg = getComputedStyle(probe).backgroundColor
            probe.remove()
            return { scheme: root.colorScheme, body: getComputedStyle(document.body).backgroundColor, bg: bg }
        })
        assert.match(theme.scheme, /dark/, 'color-scheme: dark')
        assert.equal(theme.body, theme.bg, 'фон страницы — --bg')

        // Загрузка лога
        await page.setInputFiles('#fileItem', log_path)
        await page.locator('#log_verdict').waitFor({ state: 'visible', timeout: 180000 })
        await page.waitForFunction(() => document.getElementById('loading').style.visibility === 'hidden', null, { timeout: 180000 })
        assert.match(await page.title(), /Мастер настройки: /)
        assert.match(await page.locator('#log_verdict').getAttribute('class'), /verdict--(ok|warn|fail)/)
        assert.ok((await page.locator('#log_info .stat').count()) >= 9, 'плитки сведений')
        // Рама из MSG «Frame: …» и номер платы APJ из VER — для подписи и запасного ключа аппарата памяти прохода
        assert.deepEqual(await page.evaluate(() => ({ frame: state.info.frame, board_id: state.info.board_id })), { frame: 'QUAD/X_REV', board_id: 1503 },
                         'рама и номер платы тестового лога')
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

        // Шаги с данными
        // Проверка gyro_log и pid_log на реальном логе не fail — открыты все шаги
        assert.deepEqual(await step_buttons_disabled(page), [false, false, false, false, false, false], 'после загрузки лога Copter доступны все шаги')
        await page.click('#wizbar button:nth-child(1)')
        assert.deepEqual(await visible_steps(page), ['0'])
        const surface = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--surface').trim())
        assert.equal(await page.evaluate(() => document.getElementById('FlightData').layout.paper_bgcolor), surface, 'фон графика полёта — --surface')

        // Скриншоты для глаз — рядом с логами, в репозиторий не попадают
        const shots = path.join(logs_dir, 'screenshots')
        fs.mkdirSync(shots, { recursive: true })
        await page.screenshot({ path: path.join(shots, 'step0.png'), fullPage: true })

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

        // Фон графиков шага 1 и скриншот
        assert.equal(await page.evaluate(() => document.getElementById('Spectrum1').layout.paper_bgcolor), surface, 'фон спектра — --surface')
        // Ширина графиков шага — до его снимка (узкий график после регистрации в скрытой секции ловит проверка после
        // перезагрузки в конце: снимок step0.png уже включил autosize всем графикам)
        await assert_plot_widths(page, ['Spectrum1', 'Spectrogram1'])
        await page.screenshot({ path: path.join(shots, 'step1.png'), fullPage: true })
        await page.click('#wizbar button:nth-child(1)')
        assert.deepEqual(await visible_steps(page), ['0'])

        // Шаг 2: форма из лога, варианты со сравнением, «Применить вариант», ручная правка, .param, «Принять».
        // Перед ним — снимок шага 1: шаг 2 не должен менять FFT.H и оценку «после» шага 1
        await page.click('#wizbar button:nth-child(2)')
        await wait_overlay(page)
        await remember_step1(page)
        await page.click('#wizbar button:nth-child(3)')
        assert.deepEqual(await visible_steps(page), ['2'])
        await wait_overlay(page)
        // Разметка формы по метаданным (load_param_inputs) асинхронна: ждём подписи и список MODE
        await page.waitForFunction(() => (document.querySelector('label[for="INS_HNTCH_MODE"]') != null) && step2.form_ready, null, { timeout: 30000 })
        assert.equal(await page.inputValue('#INS_HNTCH_MODE'), '3', 'INS_HNTCH_MODE из лога (ESC-телеметрия)')
        assert.equal(await page.evaluate(() => document.getElementById('INS_HNTCH_MODE').tagName), 'SELECT', 'MODE — список значений из params.json')
        assert.equal(await page.evaluate(() => step2_key(values_from_form()) === step2_key(values_from_log())), true, 'все поля формы — значения лога')
        assert.equal(await page.textContent('#notch_form .inlog[data-for="INS_HNTCH_MODE"]'), 'в логе: 3')
        assert.equal(await page.isDisabled('#INS_HNTC2_FREQ'), true, 'поля выключенного второго notch недоступны')
        assert.equal(await page.isHidden('#INS_HNTCH_ESCMSK'), true, 'ESCMSK скрыт при версии фильтра ниже 4')
        const v1 = await step2_summary(page)
        assert.deepEqual(v1.changed, [], 'до правок изменённых полей нет')
        assert.ok(v1.titles.includes('Как в логе'), 'строка «Как в логе»: ' + v1.titles.join('; '))
        assert.ok(v1.titles.some((t) => t.startsWith('Автоподбор')), 'строка автоподбора: ' + v1.titles.join('; '))
        assert.equal(v1.recommended_rows, 1, 'ровно одна строка помечена как рекомендуемая')
        assert.equal(v1.recommended_marks, 1, 'ровно одна пометка «рекомендуется»')
        assert.match(v1.verdict_class, /verdict--(ok|warn)/)
        // Рекомендованный вариант не хуже лога: по полосе 20–400 Гц и по задержке на 30 Гц (не больше лога + 0.5 мс)
        const best = await page.evaluate(() => {
            const e = step2.evaluations
            const id = step2.ranking.best_id
            return { band: e[id].band_dB, log_band: e.log.band_dB, lag: e[id].lag_ms[30], log_lag: e.log.lag_ms[30], limit: candidate_rules.max_lag_increase_ms }
        })
        assert.ok(best.band <= best.log_band, 'рекомендованный вариант не хуже лога по полосе: ' + JSON.stringify(best))
        assert.ok(best.lag <= best.log_lag + best.limit, 'и по задержке на 30 Гц: ' + JSON.stringify(best))
        assert.ok(v1.metrics.some((t) => /дБ/.test(t)) && v1.metrics.some((t) => /мс/.test(t)), 'метрики в дБ и мс: ' + v1.metrics.join(' | '))
        assert.match(await page.textContent('#candidates2 tbody'), /гарм\. 1, 3/, 'маски вариантов словами (HMNCS 5 — гармоники 1 и 3)')
        assert.match(await page.textContent('#candidates2 thead'), /Шум после фильтров на пиках, дБ/, 'общий заголовок столбцов пиков')
        assert.match(await page.textContent('#notch_form .inlog[data-for="INS_HNTC2_FREQ"]'), /^в логе нет \(взято 80\)$/, 'параметр без записи в логе — с умолчанием')
        // 8-битная HMNCS (нет INS_RAW_LOG_OPT, версия фильтра ниже 3): int8 −128 из лога — гармоника 8, а не 8–16
        const hmncs_int8 = await page.evaluate(() => {
            const get = state.params.get
            const version = state.env.filter_version
            try {
                state.params.get = (name) => (name === 'INS_HNTCH_HMNCS') ? -128 : ((name === 'INS_RAW_LOG_OPT') ? null : get(name))
                state.env.filter_version = 2
                return values_from_log().INS_HNTCH_HMNCS
            } finally {
                state.params.get = get
                state.env.filter_version = version
            }
        })
        assert.equal(hmncs_int8, 128, 'int8-маска гармоник из лога без знака')

        // Ветка вердикта: автоподбор не удался, но есть вариант второго notch — неудача приставкой к обычному тексту
        const fit_failed = await page.evaluate(() => {
            const saved = { fit: step2.fit, candidates: step2.candidates, evaluations: step2.evaluations, ranking: step2.ranking }
            try {
                const keep = saved.candidates.filter((c) => ['log', 'second'].includes(c.id))
                if (!keep.some((c) => c.id === 'second')) {
                    return null
                }
                step2.fit = { result: null, errors: ['нет ESC-телеметрии'] }
                step2.candidates = keep
                step2.evaluations = Object.fromEntries(keep.map((c) => [c.id, saved.evaluations[c.id]]))
                step2.ranking = rank_candidates(step2.evaluations)
                step2_render_verdict()
                return { text: document.getElementById('verdict2').textContent, cls: document.getElementById('verdict2').className }
            } finally {
                Object.assign(step2, saved)
                step2.ranking = rank_candidates(step2.evaluations)
                step2_render_verdict()
            }
        })
        assert.ok(fit_failed != null, 'на тестовом логе есть вариант второго notch')
        assert.match(fit_failed.text, /^Автоподбор не удался: нет ESC-телеметрии\. (Рекомендуется|Текущие настройки лучше)/, 'неудача автоподбора — приставка: ' + fit_failed.text)
        assert.match(fit_failed.cls, /verdict--warn/)
        assert.equal(await page.textContent('#verdict2'), v1.verdict, 'вердикт восстановлен')

        // «Применить вариант»: рекомендованный, а если это лог — автоподбор; форма и оценка «после» меняются
        const apply_id = (v1.best_id === 'log') ? 'fit' : v1.best_id
        await page.check('#cand2_' + apply_id)
        await page.click('#cand2_apply')
        await wait_overlay(page)
        assert.equal(await form_matches_variant(page, apply_id), true, 'форма заполнена значениями варианта ' + apply_id)
        const v2 = await step2_summary(page)
        assert.ok(v2.changed.length > 0, 'поля, отличные от лога, помечены')
        // Подсветка изменённого — у числового поля, а не у флажков маски
        const highlight = await page.evaluate(() => {
            const p = [...document.querySelectorAll('#notch_form p.changed')].find((row) => row.querySelector(':scope > input[type=checkbox]') != null)
            if (p == null) {
                return null
            }
            return { number: getComputedStyle(p.querySelector(':scope > input[type=number]')).boxShadow, check: getComputedStyle(p.querySelector(':scope > input[type=checkbox]')).boxShadow }
        })
        if (highlight != null) {
            assert.notEqual(highlight.number, 'none', 'изменённое числовое поле подсвечено')
            assert.equal(highlight.check, 'none', 'флажки маски не подсвечиваются')
        }
        assert.notDeepEqual(v2.est_y, v1.est_y, 'оценка «после» на спектре пересчитана')

        // Ручная правка и «Пересчитать фильтры»: строка «Текущий (из формы)»
        const att = Number(await page.inputValue('#INS_HNTCH_ATT')) + 5
        await page.fill('#INS_HNTCH_ATT', String(att))
        await page.dispatchEvent('#INS_HNTCH_ATT', 'change')
        assert.match(await page.getAttribute('#notch_recalc', 'class') ?? '', /primary/, 'правка подсвечивает «Пересчитать фильтры»')
        await page.click('#notch_recalc')
        await wait_overlay(page)
        const v3 = await step2_summary(page)
        assert.ok(v3.titles.some((t) => t.startsWith('Текущий (из формы)')), 'строка «Текущий»: ' + v3.titles.join('; '))
        assert.equal(v3.titles.filter((t) => t.startsWith('Текущий')).length, 1, 'одна строка «Текущий»')
        assert.notDeepEqual(v3.est_y, v2.est_y, 'оценка «после» для правки пересчитана')
        assert.ok(v3.metrics.some((t) => /дБ/.test(t)) && v3.metrics.some((t) => /мс/.test(t)), 'метрики в дБ и мс')
        assert.equal(v3.recommended_marks, 1, 'после «Пересчитать» пометка «рекомендуется» по-прежнему одна')
        assert.match(await page.textContent('#candidates2 tbody tr:last-child'), /ручные значения в рекомендации не участвуют/, 'строка «Текущий» — вне рекомендации')

        // Шаг 1 после «Применить вариант» и «Пересчитать фильтры» прежний: те же FFT.H и та же оценка «после»
        await page.click('#wizbar button:nth-child(2)')
        await wait_overlay(page)
        assert.deepEqual(await step1_untouched(page), { H: true, est: true }, 'шаг 2 не меняет расчёт шага 1')
        await page.click('#wizbar button:nth-child(3)')
        await wait_overlay(page)
        assert.equal((await step2_summary(page)).titles.filter((t) => t.startsWith('Текущий')).length, 1, 'возврат на шаг 2 сохраняет строку «Текущий»')

        // Бодэ: «свернуть фазу» — ось фазы ±180°
        await page.check('#bode2_wrap')
        await wait_overlay(page)
        assert.deepEqual(await page.evaluate(() => document.getElementById('Bode2').layout.yaxis2.range), [-180, 180], 'свёрнутая фаза в ±180°')
        await page.uncheck('#bode2_wrap')
        await wait_overlay(page)
        assert.ok(await page.evaluate(() => document.getElementById('Bode2').data[2].y.length > 0), 'бодэ нарисовано')

        // «Сохранить .param»: загрузка файла с параметрами notch
        const [download] = await Promise.all([page.waitForEvent('download'), page.click('#notch_save')])
        assert.equal(download.suggestedFilename(), 'notch.param')
        const param_text = fs.readFileSync(await download.path(), 'utf8')
        assert.match(param_text, /^INS_HNTCH_FREQ,/m, '.param содержит INS_HNTCH_FREQ')
        assert.match(param_text, new RegExp('^INS_HNTCH_ATT,' + att + '$', 'm'), '.param содержит правку INS_HNTCH_ATT')
        assert.doesNotMatch(param_text, /SCHED_LOOP_RATE|ESCMSK/, 'в .param только INS_*, без ESCMSK при версии фильтра ниже 4')
        if (/^INS_HNTC2_ENABLE,1$/m.test(param_text)) {
            assert.match(await page.textContent('#notch_file_note'), /сначала запишите INS_HNTC2_ENABLE = 1/, 'подсказка про включение второго notch на аппарате')
        }

        // «Загрузить .param»: значение из файла в форму и пересчёт
        const param_file = path.join(shots, 'test_notch.param')
        fs.writeFileSync(param_file, '# тест\nINS_HNTCH_ATT,33\nINS_HNTCH_BW 21\nNOT_A_PARAM,1\n')
        await page.setInputFiles('#notch_load_file', param_file)
        await page.waitForFunction(() => document.getElementById('INS_HNTCH_ATT').value === '33', null, { timeout: 30000 })
        await wait_overlay(page)
        assert.equal(await page.inputValue('#INS_HNTCH_BW'), '21', 'формат MAVProxy из файла')
        assert.match(await page.textContent('#notch_file_note'), /взято параметров формы: 2 из 22/)
        fs.rmSync(param_file)

        // Смена интервала на шаге 0 помечает варианты устаревшими, «Подобрать заново» считает их для нового интервала
        await page.click('#wizbar button:nth-child(1)')
        await page.fill('#TimeStart', String(start + 20))
        await page.dispatchEvent('#TimeStart', 'change')
        await page.click('#wizbar button:nth-child(3)')
        await wait_overlay(page)
        assert.equal(await page.isVisible('#candidates2_stale'), true, 'варианты помечены устаревшими')
        assert.match(await page.getAttribute('#cand2_refit', 'class') ?? '', /primary/, '«Подобрать заново» подсвечена')
        assert.equal(await page.inputValue('#INS_HNTCH_ATT'), '33', 'смена интервала не трогает форму')
        await page.click('#cand2_refit')
        await wait_overlay(page)
        assert.equal(await page.isVisible('#candidates2_stale'), false, 'после «Подобрать заново» варианты актуальны')
        assert.doesNotMatch(await page.getAttribute('#cand2_refit', 'class') ?? '', /primary/)
        assert.equal((await step2_summary(page)).recommended_marks, 1, 'для нового интервала снова одна пометка «рекомендуется»')

        // Фон графиков шага 2 и скриншот
        assert.equal(await page.evaluate(() => document.getElementById('Spectrum2').layout.paper_bgcolor), surface, 'фон спектра шага 2 — --surface')
        assert.equal(await page.evaluate(() => document.getElementById('Bode2').layout.paper_bgcolor), surface, 'фон бодэ — --surface')
        await assert_plot_widths(page, ['Spectrum2', 'Bode2', 'Spectrogram2'])
        await page.screenshot({ path: path.join(shots, 'step2.png'), fullPage: true })

        // «Принять»: значения формы, метрики и отметки против лога в state.steps[2], открыт шаг 3
        await page.click('#notch_accept')
        await wait_overlay(page)
        assert.deepEqual(await visible_steps(page), ['3'], '«Принять» открывает шаг 3')
        const accepted = await page.evaluate(() => state.steps[2])
        assert.equal(accepted.accepted.INS_HNTCH_ATT, 33, 'принятые значения — из формы')
        assert.equal(accepted.candidate_id, 'current', 'правка вручную — вариант «current»')
        assert.ok((accepted.metrics != null) && Number.isFinite(accepted.metrics.current.band_dB) && Number.isFinite(accepted.metrics.current.lag_ms[30]), 'метрики принятого')
        assert.ok((accepted.flags != null) && Array.isArray(accepted.flags.worse_peaks), 'отметки принятого против лога')
        assert.match(await page.textContent('#verdict2'), /^Принято/, 'вердикт шага 2 — «Принято»')
        await assert_accepted_fresh(page, 2)

        // Принять вариант, который хуже лога: вердикт warn «Принято, но хуже лога»
        await page.click('#wizbar button:nth-child(3)')
        await wait_overlay(page)
        const flagged_id = await page.evaluate(() => Object.entries(step2.ranking.flags).find(([id, f]) => (id !== 'log') && ((f.worse_peaks.length > 0) || f.lag_over))?.[0] ?? null)
        assert.ok(flagged_id != null, 'на тестовом логе есть вариант хуже лога')
        await page.check('#cand2_' + flagged_id)
        await page.click('#cand2_apply')
        await wait_overlay(page)
        await page.click('#notch_accept')
        await wait_overlay(page)
        assert.deepEqual(await visible_steps(page), ['3'])
        const flagged = await page.evaluate(() => ({ text: document.getElementById('verdict2').textContent, cls: document.getElementById('verdict2').className,
                                                      id: state.steps[2].candidate_id, flags: state.steps[2].flags }))
        assert.equal(flagged.id, flagged_id, 'принят вариант ' + flagged_id)
        assert.ok((flagged.flags.worse_peaks.length > 0) || flagged.flags.lag_over, 'отметки принятого: ' + JSON.stringify(flagged.flags))
        assert.match(flagged.cls, /verdict--warn/, 'принятое хуже лога — предупреждение')
        assert.match(flagged.text, /^Принято, но хуже лога: /, flagged.text)
        await assert_accepted_fresh(page, 2)

        // Шаг 3: варианты низкочастотных фильтров, размер винта, графики, «Принять». Notch-база — принятое на шаге 2
        // (выше принят вариант хуже лога), интервал сдвинут на 20 с, поэтому числа сравниваются с «Как в логе» того же
        // расчёта, а не с замером дизайна. Ожидания опираются на константы тестового лога: INS_GYRO_FILTER 40,
        // ATC_RAT_RLL/PIT_FLTD 30, FLTE 0, пределы ускорения не заводские (ATC_ACCEL_R/P_MAX 90000 — AutoTune), Kd крена
        // и тангажа не нулевые, SCHED_LOOP_RATE 400. Браузер теста — новый контекст с пустым хранилищем, поэтому поле
        // размера винта при загрузке страницы осталось пустым
        await page.click('#wizbar button:nth-child(1)')
        assert.equal(await page.inputValue('#prop_in'), '', 'размер винта пуст: хранилище браузера теста пустое')
        await page.click('#wizbar button:nth-child(4)')
        assert.deepEqual(await visible_steps(page), ['3'], 'открыт шаг 3')
        await wait_overlay(page)
        const w1 = await step3_summary(page)
        assert.deepEqual(w1.titles, ['Как в логе', 'Лог + правило /2'], 'без размера винта — два варианта')
        assert.equal(w1.recommended_marks, 0, 'без размера винта рекомендации нет')
        assert.match(w1.verdict_class, /verdict--warn/, 'без размера винта — предупреждение')
        assert.match(w1.verdict, /^Введите размер винта/, w1.verdict)
        assert.equal(await page.evaluate(() => candidate_key(step3.base) === candidate_key(state.steps[2].accepted)), true, 'notch-база — принятое на шаге 2')
        assert.match(await page.textContent('#candidates3_note'), /Notch — принятый на шаге 2/, 'подпись таблицы называет notch-базу')
        const log3 = await page.evaluate(() => lowpass_log_values(state.params))
        // Действие (щелчок или Tab) раньше пересчёта правки: отложенный пересчёт ещё не прошёл
        const edit_pending = () => page.evaluate(() => step3.edit_timer != null)

        // Первый ввод размера и сразу «Применить вариант» — щелчок раньше пересчёта правки (400 мс): кнопка сама
        // досчитывает правку и применяет вариант по размеру для введённого размера
        await page.fill('#prop_in', '10')
        assert.equal(await edit_pending(), true, 'действие раньше пересчёта правки')
        await page.click('#cand3_apply')
        await wait_overlay(page)
        assert.equal(await page.inputValue('#lpf_INS_GYRO_FILTER'), '42', 'набор размера и сразу «Применить вариант» — значения для 10″')
        const w2 = await step3_summary(page)
        assert.deepEqual(w2.titles, ['Как в логе', 'По размеру винта (10″)', 'Лог + правило /2'], 'с размером винта — три варианта')
        assert.deepEqual(w2.recommended, ['По размеру винта (10″)'], 'рекомендуется вариант по размеру')
        assert.equal(w2.recommended_marks, 1, 'ровно одна пометка «рекомендуется»')
        const prop10 = await page.evaluate(() => {
            const row = step3_rows().find((r) => r.id === 'prop')
            return { values: row.values, accel_from_log: row.accel_from_log }
        })
        assert.equal(prop10.values.INS_GYRO_FILTER, 42, 'INS_GYRO_FILTER по формуле Mission Planner для 10″')
        assert.equal(prop10.values.ATC_RAT_RLL_FLTD, 21, 'FLTD крена = INS_GYRO_FILTER / 2')
        assert.equal(prop10.values.ATC_RAT_PIT_FLTD, 21, 'FLTD тангажа = INS_GYRO_FILTER / 2')
        assert.equal(prop10.accel_from_log, true, 'пределы ускорения не заводские (AutoTune) — из лога')
        assert.equal(prop10.values.ATC_ACCEL_R_MAX, 90000, 'ATC_ACCEL_R_MAX из лога')
        assert.equal(await page.inputValue('#lpf_ATC_ACCEL_R_MAX'), '90000', 'в форме — предел ускорения лога')
        assert.match(w2.row_text.prop, /пределы ускорения — из лога/, 'строка по размеру поясняет пределы ускорения')
        assert.match(w2.verdict, /AutoTune/, 'вердикт объясняет пределы ускорения из лога: ' + w2.verdict)
        assert.match(w2.verdict_class, /verdict--(ok|warn)/, 'вердикт с рекомендацией')

        // «Лог + правило /2» (FLTD 30 → 20): шум D крена ниже лога, задержка пути D больше
        const half = await page.evaluate(() => {
            const e = step3.evaluations
            return { d: e.half.dterm.roll.dB, d_log: e.log.dterm.roll.dB, lag: e.half.lag_ms.roll.D[30], lag_log: e.log.lag_ms.roll.D[30] }
        })
        assert.ok(half.d < half.d_log, '«Лог + правило /2»: шум D крена ниже лога: ' + JSON.stringify(half))
        assert.ok(half.lag > half.lag_log, '«Лог + правило /2»: задержка пути D больше: ' + JSON.stringify(half))

        // Выбран «Лог + правило /2», набор размера и сразу «Применить вариант»: выбор пользователя сохраняется при
        // пересчёте — применён half, а не вариант по размеру
        await page.check('#cand3_half')
        await page.fill('#prop_in', '20')
        assert.equal(await edit_pending(), true, 'действие раньше пересчёта правки')
        await page.click('#cand3_apply')
        await wait_overlay(page)
        assert.equal(Number(await page.inputValue('#lpf_INS_GYRO_FILTER')), log3.INS_GYRO_FILTER, 'применён half: INS_GYRO_FILTER из лога')
        assert.equal(await page.inputValue('#lpf_ATC_RAT_RLL_FLTD'), '20', 'применён half: FLTD крена 20')
        assert.equal(await page.inputValue('#lpf_ATC_RAT_PIT_FLTD'), '20', 'применён half: FLTD тангажа 20')
        // 20″: у варианта по размеру отметка «медленнее лога» — задержка на 30 Гц больше лога больше чем на 1 мс
        const w3 = await step3_summary(page)
        assert.ok(w3.titles.includes('По размеру винта (20″)'), w3.titles.join('; '))
        assert.equal(w3.selected, 'half', 'выбор «Лог + правило /2» сохранён')
        const prop20 = await page.evaluate(() => ({ slower: step3.flags.prop.slower, lag: step3.evaluations.prop.lag_ms, log: step3.evaluations.log.lag_ms }))
        assert.ok(prop20.slower.length > 0, '20″ — медленнее лога: ' + JSON.stringify(prop20))
        for (const s of prop20.slower) {
            assert.ok(prop20.lag[s.axis][s.path][30] - prop20.log[s.axis][s.path][30] > 1, 'задержка больше лога на 1 мс: ' + JSON.stringify(s))
        }
        assert.match(w3.row_text.prop, /медленнее лога больше чем на 1 мс на 30 Гц/, w3.row_text.prop)
        assert.match(w3.verdict_class, /verdict--warn/, 'рекомендованный хуже лога — предупреждение')
        assert.match(w3.verdict, /но он хуже лога/, w3.verdict)

        // Набор размера и сразу Tab: пересчёт перерисовывает таблицу, а фокус не уходит в BODY — остаётся на радио таблицы
        await page.fill('#prop_in', '12')
        assert.equal(await edit_pending(), true, 'действие раньше пересчёта правки')
        await page.keyboard.press('Tab')
        await wait_step3_row(page, 'По размеру винта (12″)')
        const focus = await page.evaluate(() => ({ tag: document.activeElement.tagName, name: document.activeElement.name }))
        assert.deepEqual(focus, { tag: 'INPUT', name: 'cand3' }, 'фокус после Tab не ушёл в BODY — на радио таблицы')
        // Перерисовка таблицы при фокусе на неотмеченном радио возвращает фокус на отмеченное (иначе пробел выбрал бы
        // другую строку): фокус на «Как в логе» при выбранном half, правка размера — программно, чтобы фокус остался
        // на радио, — и пересчёт после паузы в наборе
        await page.focus('#cand3_log')
        assert.deepEqual(await page.evaluate(() => [document.activeElement.id, step3.selected_id]), ['cand3_log', 'half'], 'фокус на неотмеченном радио «Как в логе»')
        await page.evaluate(() => {
            const field = document.getElementById('prop_in')
            field.value = '10'
            field.dispatchEvent(new Event('input', { bubbles: true }))
        })
        await wait_step3_row(page, 'По размеру винта (10″)')
        assert.deepEqual(await page.evaluate(() => [document.activeElement.id, document.activeElement.checked]), ['cand3_half', true], 'после перерисовки фокус — на отмеченном радио')

        // Правка поля формы — строка «Свой» после паузы в наборе, она выбрана
        await page.fill('#lpf_ATC_RAT_RLL_FLTD', '25')
        await wait_step3_row(page, 'Свой')
        const w4 = await step3_summary(page)
        assert.equal(w4.titles.filter((t) => t === 'Свой').length, 1, 'одна строка «Свой»: ' + w4.titles.join('; '))
        assert.equal(w4.selected, 'custom', 'после правки формы выбрана строка «Свой»')

        // Графики выбранной строки («Свой») против лога: данные, фон, частоты, ось бодэ
        const g3 = await step3_plots(page)
        for (const id of ['Spectrum3', 'DTerm3', 'Bode3']) {
            assert.equal(g3[id].with_data, g3[id].traces, id + ': все трассы с данными')
            assert.equal(g3[id].bg, surface, id + ': фон — --surface')
        }
        await assert_plot_widths(page, ['Spectrum3', 'DTerm3', 'Bode3'])
        assert.ok(g3.Spectrum3.groups.pre.visible.every((v) => v === 'legendonly'), '«до фильтров» — только в легенде: ' + JSON.stringify(g3.Spectrum3.groups.pre))
        assert.ok([...g3.Spectrum3.groups.log.visible, ...g3.Spectrum3.groups.sel.visible].every((v) => v === true), 'как в логе и выбранный — видны')
        assert.equal(g3.Spectrum3.groups.sel.title, 'выбранный: Свой', 'в легенде спектра — название выбранной строки')
        for (const id of ['DTerm3', 'Bode3']) {
            assert.ok((g3[id].selected_names.length > 0) && g3[id].selected_names.every((name) => name.endsWith('выбранный: Свой')),
                      id + ': в легенде — название выбранной строки: ' + g3[id].selected_names.join('; '))
        }
        assert.deepEqual(g3.Spectrum3.vlines, [['log', log3.INS_GYRO_FILTER], ['sel', log3.INS_GYRO_FILTER]], 'вертикали на INS_GYRO_FILTER лога и выбранного')
        assert.ok(Math.abs(g3.DTerm3.max_x - 200) < 0.01, 'D-составляющая — до SCHED_LOOP_RATE / 2 = 200 Гц: ' + g3.DTerm3.max_x)
        assert.equal(g3.Bode3.xtype, 'log', 'бодэ — логарифмическая ось частот')
        assert.ok((g3.Bode3.min_x >= 1) && (g3.Bode3.min_x < 1.1) && (Math.abs(g3.Bode3.max_x - 200) < 0.01), 'бодэ — от 1 Гц до 200 Гц: ' + g3.Bode3.min_x + '…' + g3.Bode3.max_x)
        assert.equal(g3.Bode3.vlines.length, 4, 'вертикали 10 и 30 Гц на обоих подграфиках бодэ')
        // У «Свой» FLTD крена 25, тангажа 20 — путь D выбранного у осей разный
        await page.evaluate(() => { window.__bode3_roll = Array.from(document.getElementById('Bode3').data[bode3_trace_index(0, 1, 1)].y) })
        await page.check('#bode3_pitch')
        assert.equal(await page.evaluate(() => {
            const y = Array.from(document.getElementById('Bode3').data[bode3_trace_index(0, 1, 1)].y)
            return (y.length > 0) && (JSON.stringify(y) !== JSON.stringify(window.__bode3_roll))
        }), true, 'бодэ тангажа — свои данные')
        await page.check('#bode3_roll')

        // Один лишь выбор строки (без «Применить») перерисовывает графики: вертикаль, легенда и данные выбранного
        await page.check('#cand3_prop')
        const g_prop = await step3_plots(page)
        assert.deepEqual(g_prop.Spectrum3.vlines, [['log', log3.INS_GYRO_FILTER], ['sel', 42]], 'выбор строки — вертикаль INS_GYRO_FILTER выбранного 42 Гц')
        assert.equal(g_prop.Spectrum3.groups.sel.title, 'выбранный: По размеру винта (10″)', 'выбор строки — название в легенде спектра')
        for (const id of ['DTerm3', 'Bode3']) {
            assert.notDeepEqual(g_prop[id].selected_sums, g3[id].selected_sums, id + ': выбор строки — данные выбранного сменились')
            assert.ok(g_prop[id].selected_names.every((name) => name.endsWith('выбранный: По размеру винта (10″)')), id + ': выбор строки — название в легенде: ' +
                      g_prop[id].selected_names.join('; '))
        }

        // «Принять» рекомендованного: значения формы и вариант в state.steps[3], открыт шаг 4
        await page.click('#cand3_apply')
        await wait_overlay(page)
        await page.click('#lpf_accept')
        await wait_overlay(page)
        assert.deepEqual(await visible_steps(page), ['4'], '«Принять» открывает шаг 4')
        const accepted3 = await page.evaluate(() => state.steps[3])
        assert.equal(accepted3.accepted.INS_GYRO_FILTER, 42, 'принятый INS_GYRO_FILTER — из формы')
        assert.equal(accepted3.candidate_id, 'prop', 'принят вариант по размеру')
        assert.equal(accepted3.prop_in, 10, 'размер винта принятого')
        assert.ok((accepted3.metrics != null) && (accepted3.flags != null), 'метрики и отметки принятого')
        const verdict3_prop = await page.textContent('#verdict3')
        assert.match(verdict3_prop, /^Принято/, verdict3_prop)
        await assert_accepted_fresh(page, 3)

        // Правка поля формы и сразу «Принять» (щелчок раньше пересчёта правки): принимаются значения формы — «Свой»
        await page.click('#wizbar button:nth-child(4)')
        await wait_overlay(page)
        await page.fill('#lpf_INS_GYRO_FILTER', '38')
        assert.equal(await edit_pending(), true, 'действие раньше пересчёта правки')
        await page.click('#lpf_accept')
        await wait_overlay(page)
        assert.deepEqual(await visible_steps(page), ['4'], '«Принять» своих значений открывает шаг 4')
        const custom3 = await page.evaluate(() => state.steps[3])
        assert.equal(custom3.accepted.INS_GYRO_FILTER, 38, 'правка и сразу «Принять» — значение формы')
        assert.equal(custom3.candidate_id, 'custom', 'правка вручную — вариант «custom»')
        assert.match(await page.textContent('#verdict3'), /^Принято/, 'вердикт шага 3 — «Принято»')
        await assert_accepted_fresh(page, 3)

        // Скриншот шага 3: принятые свои значения, строка «Свой» выбрана
        await page.click('#wizbar button:nth-child(4)')
        await wait_overlay(page)
        assert.ok((await step3_summary(page)).titles.includes('Свой'), 'строка «Свой» на месте')
        await page.screenshot({ path: path.join(shots, 'step3.png'), fullPage: true })
        await page.click('#wizbar button:nth-child(1)')

        // Шаг 4 «PID по осям» — после шага 3: приняты notch шага 2 и свои значения шага 3, интервал — снова по умолчанию
        // (выше начало сдвигалось на 20 с; на сдвинутом у крена не проходят (а) и (б)). Факт лога пользователя на всём
        // интервале (раздел 3 дизайна): ни одна ось не проходит проверки качества измерения — у всех не пройдена (б)
        // (смешение режимов ACRO, STABILIZE, POSHOLD), поэтому правил и прогноза нет: в таблицах только «Как в логе»,
        // бодэ L пуст, сводка советует тестовый полёт. Варианты и прогноз проверяются ниже явной подменой
        await page.fill('#TimeStart', String(start))
        await page.dispatchEvent('#TimeStart', 'change')
        await page.click('#wizbar button:nth-child(5)')
        assert.deepEqual(await visible_steps(page), ['4'], 'открыт шаг 4')
        await wait_overlay(page)
        const p4 = await step4_summary(page)
        assert.deepEqual(p4.tabs.map((tab) => tab.id), ['step4_tab_roll', 'step4_tab_pitch', 'step4_tab_yaw'], 'три вкладки осей')
        assert.match(p4.verdict_class, /verdict--warn/, 'сводка — предупреждение')
        assert.match(p4.verdict, /^Измерение ненадёжно на всех осях/, p4.verdict)
        assert.match(p4.verdict, /тестовый полёт: Acro с ACRO_OPTIONS «Rate Loop Only»/, 'сводка советует тестовый полёт: ' + p4.verdict)
        const axes4 = {}
        for (const axis of ['roll', 'pitch', 'yaw']) {
            await page.click('#step4_tab_' + axis)
            const s = await step4_summary(page)
            assert.equal(s.axis, axis, 'открыта вкладка ' + axis)
            assert.deepEqual(s.tabs.map((tab) => tab.selected), ['roll', 'pitch', 'yaw'].map((a) => String(a === axis)), axis + ': выбрана своя вкладка')
            assert.equal(s.status, 'unreliable', axis + ': измерение ненадёжно')
            assert.ok(s.failed.includes('(б)'), axis + ': не пройдена проверка (б): ' + s.failed.join(', '))
            assert.equal(s.quality[1], 'не пройдена', axis + ': в таблице проверок (б) — «не пройдена»')
            assert.match(s.axis_verdict, /^Измерение ненадёжно — правил и прогноза нет: /, axis + ': ' + s.axis_verdict)
            assert.match(s.axis_verdict, /Слетайте тестовый лог: Acro с ACRO_OPTIONS бит 1 «Rate Loop Only»/, axis + ': вердикт объясняет тестовый полёт')
            assert.deepEqual(s.titles, ['Как в логе'], axis + ': в таблице только «Как в логе»')
            assert.equal(s.recommended_marks, 0, axis + ': рекомендации нет')
            assert.equal(s.predict_ok, false, axis + ': прогноза нет')
            const g = await step4_plots(page)
            const [windows, mean, measured, pred_log, pred] = g.StepResp4.traces
            assert.ok(measured.finite > 0 && measured.visible === true, axis + ': измеренный отклик на графике')
            assert.equal(measured.name, 'измеренный (КИХ МНК) — ' + s.tabs.find((tab) => tab.selected === 'true').state, axis + ': пометка в легенде — состояние оси')
            assert.match(measured.name, /— ненадёжно .*\(б\)$/, axis + ': пометка в легенде: ' + measured.name)
            assert.equal(pred_log.n, 0, axis + ': прогноза «как в логе» нет')
            assert.match(g.StepResp4.note, /^Измеренный отклик — с пометкой: измерение ненадёжно \(.*\(б\).*\); по нему не судят/, axis + ': пометка в подписи: ' + g.StepResp4.note)
            assert.equal(pred.n, 0, axis + ': прогноза на графике нет')
            assert.ok((windows.finite > 0) && (mean.finite > 0) && (windows.visible === 'legendonly') && (mean.visible === 'legendonly'), axis + ': отклик PIDReview — только в легенде')
            assert.match(mean.name, /занижено методом/, axis + ': подпись, что отклик PIDReview занижен методом')
            assert.match(windows.name, /^PIDReview: окна \(200 из \d+\)$/, axis + ': окон PIDReview на графике — 200, равномерной выборкой: ' + windows.name)
            assert.deepEqual(g.StepResp4.shapes, ['one', 'band_lo', 'band_hi'], axis + ': горизонтали 1 и ±5 % от плато')
            assert.ok((Math.abs(g.StepResp4.shape_y.band_lo - s.plateau * 0.95) < 1e-9) && (Math.abs(g.StepResp4.shape_y.band_hi - s.plateau * 1.05) < 1e-9) &&
                      (g.StepResp4.shape_y.one === 1), axis + ': горизонтали — 1 и плато ' + s.plateau + ' ×0.95 / ×1.05: ' + JSON.stringify(g.StepResp4.shape_y))
            assert.equal(g.TarAct4.with_data, 2, axis + ': цель и факт с данными')
            // Прореживание: не больше tarac4_max_points точек, и на пакет — разрыв и лишний неполный отрезок
            assert.ok(g.TarAct4.traces.every((t) => t.n <= s.max_points + 3 * s.batches), axis + ': цель и факт прорежены для отрисовки: ' +
                      g.TarAct4.traces.map((t) => t.n).join(', ') + ' (предел ' + s.max_points + ' + 3 × ' + s.batches + ' пакетов)')
            assert.deepEqual(g.TarAct4.traces.map((t) => t.name), ['факт', 'цель'], axis + ': цель рисуется поверх факта')
            assert.equal(g.DSpec4.with_data, 2, axis + ': спектры D и выхода с данными')
            assert.deepEqual(g.DSpec4.shapes, ['d_noise'], axis + ': вертикаль шума D')
            assert.equal(g.LBode4.with_data, 0, axis + ': бодэ L пуст')
            assert.deepEqual(g.LBode4.shapes, [], axis + ': отметок на бодэ нет')
            assert.match(g.LBode4.note, /^Бодэ L — только при достоверном прогнозе: измерение ненадёжно/, axis + ': причина пустого бодэ: ' + g.LBode4.note)
            axes4[axis] = { windows: s.windows, windows_text: s.windows_text, data_s: s.data_s, failed: s.failed, plots: g }
        }
        for (const axis of ['roll', 'pitch']) {
            assert.ok(axes4[axis].data_s >= 10, axis + ': отобранных данных не меньше 10 с: ' + axes4[axis].windows + ' окон, ' + axes4[axis].data_s.toFixed(1) + ' с')
        }
        // Переключение вкладки меняет графики: у крена и тангажа — свои данные
        for (const [id, index] of [['StepResp4', 2], ['TarAct4', 0], ['DSpec4', 1]]) {
            assert.notEqual(axes4.roll.plots[id].traces[index].sum, axes4.pitch.plots[id].traces[index].sum, id + ': у тангажа свои данные')
        }

        // Правки формы: настоящий набор с клавиатуры (выделить всё тройным щелчком и напечатать), пересчёт правки ещё не
        // прошёл (отложен на 400 мс), дождаться, пока правки досчитаются
        const edit_pending4 = () => page.evaluate(() => step4.edit_timer != null)
        const type_into = async (selector, text) => {
            await page.click(selector, { clickCount: 3 })
            await page.keyboard.type(text)
        }
        const wait_edits4 = () => page.waitForFunction(() => (step4.edit_timer == null) && !step4.edit_postponed, null, { timeout: 30000 })

        // ПОДМЕНА, а не данные лога: у тангажа — режим тестового полёта Acro «Rate Loop Only» (pidtune_log_mode) и
        // пройденные проверки (а), (б) (pidtune_quality при rate_only), чтобы проверить варианты и прогноз — на логе
        // пользователя надёжной оси нет. Фильтры шагов 2–3 — принятые выше: notch без третьей гармоники (HMNCS 5 → 1),
        // INS_GYRO_FILTER 38, FLTD 21 — прогноз идёт с поправкой фильтров гироскопа, и она не даёт ложного «прогноз
        // неустойчив» (ядро сглаживает поправку выше 5× частоты среза). После проверок подмена снимается и шаг
        // пересчитывается
        await page.evaluate(() => {
            window.__step4_orig = { mode: pidtune_log_mode, quality: pidtune_quality }
            pidtune_log_mode = (...args) => {
                const mode = window.__step4_orig.mode(...args)
                return (args[4] === 'pitch') ? { ...mode, rate_only: true, mixed_modes: [] } : mode
            }
            pidtune_quality = (segments, rate_hz, fir, options, rules) => {
                const quality = window.__step4_orig.quality(segments, rate_hz, fir, options, rules)
                if ((fir == null) || !options?.rate_only) {
                    return quality
                }
                quality.checks.ridge.ok = true
                quality.checks.halves.ok = true
                return { ...quality, ok: true, reasons: [] }
            }
            step4.key = null
            step4_show()
        })
        await wait_overlay(page)
        await page.click('#step4_tab_pitch')
        const sub4 = await step4_summary(page)
        assert.equal(sub4.status, 'ok', 'подмена: измерение тангажа надёжно')
        assert.equal(sub4.predict_ok, true, 'подмена: прогноз тангажа достоверен')
        assert.match(sub4.axis_verdict, /Лог тестового полёта Acro «Rate Loop Only»/, 'подмена: вердикт тангажа — тестовый полёт')
        assert.ok(sub4.titles.length >= 4, 'подмена: варианты тангажа: ' + sub4.titles.join('; '))
        assert.equal(sub4.recommended.length, 1, 'подмена: одна строка рекомендуется: ' + sub4.recommended.join('; '))
        assert.equal(sub4.recommended_marks, 1, 'подмена: одна пометка «рекомендуется»')
        assert.equal(sub4.quality[2], 'не применяется (Rate Loop Only)', 'подмена: (в) в Rate Loop Only не применяется')
        const unstable4 = await page.evaluate(() => step4_rows('pitch').filter((r) => ['log', 'p_minus', 'p_plus', 'd_minus', 'd_plus'].includes(r.id))
            .map((r) => [r.id, r.flags.unstable, r.pred.noncausal]))
        assert.equal(unstable4.length, 5, 'подмена: «Как в логе», P ±10 % и D ±10 %: ' + JSON.stringify(unstable4))
        assert.ok(unstable4.every(([, unstable]) => unstable === false), 'подмена: с фильтрами шагов 2–3 нет ложного «прогноз неустойчив»: ' + JSON.stringify(unstable4))
        const sub_title = (id) => page.evaluate((id) => step4_rows('pitch').find((r) => r.id === id).title, id)
        const gs1 = await step4_plots(page)
        assert.equal(gs1.LBode4.with_data, 4, 'подмена: бодэ L — амплитуда и фаза лога и выбранного')
        assert.equal(gs1.LBode4.xtype, 'log', 'бодэ L — логарифмическая ось частот')
        assert.ok(gs1.LBode4.min_x >= 0.5 && gs1.LBode4.min_x < 0.6, 'бодэ L — от 0.5 Гц, без 0 Гц: ' + gs1.LBode4.min_x)
        assert.deepEqual(gs1.LBode4.shapes, ['ref:zero', 'ref:m180', 'log:fc', 'log:fc', 'log:pm', 'sel:fc', 'sel:fc', 'sel:pm'], 'подмена: отметки частоты среза и запаса фазы')
        assert.match(gs1.LBode4.traces[0].name, /^лог · срез [\d.]+ Гц · запас [\d.]+°$/, 'частота среза и запас лога в легенде: ' + gs1.LBode4.traces[0].name)
        assert.equal(gs1.LBode4.note, null, 'подмена: подписи-причины у бодэ нет')
        const sel_title = await sub_title(sub4.selected)
        assert.equal(gs1.StepResp4.traces[4].name, 'прогноз «' + sel_title + '»', 'подмена: на графике отклика — прогноз выбранного варианта')
        assert.ok(gs1.StepResp4.traces[4].finite > 0, 'подмена: прогноз выбранного варианта с данными')
        assert.match(gs1.StepResp4.traces[2].name, /^измеренный \(КИХ МНК\)$/, 'подмена: без пометки «ненадёжно»')
        // Фильтры шагов 2–3 отличаются от лога — прогноз «как в логе» с ними, только в легенде
        assert.equal(gs1.StepResp4.traces[3].name, 'прогноз «как в логе» (фильтры шагов 2–3)')
        assert.ok((gs1.StepResp4.traces[3].finite > 0) && (gs1.StepResp4.traces[3].visible === 'legendonly'), 'подмена: прогноз «как в логе» с фильтрами — в легенде с данными')
        // Выбор другой строки щелчком — прогноз на графиках меняется
        const other4 = await page.evaluate(() => step4_rows('pitch').find((r) => (r.id !== step4.selected.pitch) && (r.pred?.step != null))?.id ?? null)
        assert.ok(other4 != null, 'подмена: есть другой устойчивый вариант')
        await page.check('#cand4_' + other4)
        const gs2 = await step4_plots(page)
        const other_title = await sub_title(other4)
        assert.equal(gs2.StepResp4.traces[4].name, 'прогноз «' + other_title + '»', 'выбор строки — прогноз этой строки на графике отклика')
        assert.notEqual(gs2.StepResp4.traces[4].sum, gs1.StepResp4.traces[4].sum, 'выбор строки — данные прогноза на графике отклика сменились')
        assert.equal(gs2.StepResp4.traces[3].sum, gs1.StepResp4.traces[3].sum, 'выбор строки — прогноз «как в логе» прежний')
        assert.ok(gs2.LBode4.traces[1].name.startsWith('«' + other_title + '» · срез'), 'выбор строки — название на бодэ: ' + gs2.LBode4.traces[1].name)
        assert.notEqual(gs2.LBode4.traces[1].sum, gs1.LBode4.traces[1].sum, 'выбор строки — данные выбранного на бодэ сменились')
        assert.equal(gs2.LBode4.traces[0].sum, gs1.LBode4.traces[0].sum, 'выбор строки — бодэ лога прежнее')
        // Стрелки в таблице меняют выбранную строку, а с ней и графики
        await page.focus('#cand4_' + other4)
        await page.keyboard.press('ArrowDown')
        const arrow4 = await step4_summary(page)
        assert.notEqual(arrow4.selected, other4, 'стрелка вниз — выбрана другая строка')
        assert.equal(await page.evaluate(() => step4.selected.pitch), arrow4.selected, 'выбор стрелкой — в step4.selected')
        assert.notEqual((await step4_plots(page)).LBode4.traces[1].sum, gs2.LBode4.traces[1].sum, 'выбор стрелкой — бодэ выбранного сменилось')
        // Неустойчивый вариант: «Свой» тангажа P = I = 0.5 (×5 к логу) — линии прогноза на графике отклика нет, причина
        // в подписи; на бодэ L варианта есть (по ней видно, почему), запас фазы не больше 0
        await type_into('#pidf_ATC_RAT_PIT_P', '0.5')
        await type_into('#pidf_ATC_RAT_PIT_I', '0.5')
        await page.waitForFunction(() => (step4.edit_timer == null) && !step4.edit_postponed && (step4.selected.pitch === 'custom') &&
            (step4_rows('pitch').find((r) => r.id === 'custom')?.values.I === Math.fround(0.5)), null, { timeout: 30000 })
        const gu = await step4_plots(page)
        assert.equal(gu.StepResp4.traces[4].n, 0, 'неустойчивый «Свой» — линии прогноза нет')
        assert.match(gu.StepResp4.note, /Прогноз «Свой»: контур неустойчив \(запас фазы -[\d.]+°\) — линии отклика нет\./, 'причина в подписи: ' + gu.StepResp4.note)
        assert.ok(gu.LBode4.traces[1].finite > 0, 'неустойчивый «Свой» — L на бодэ есть')
        assert.match(gu.LBode4.traces[1].name, /^«Свой» · срез [\d.]+ Гц · запас -[\d.]+°$/, 'запас фазы неустойчивого — не больше 0: ' + gu.LBode4.traces[1].name)
        assert.match(gu.LBode4.note, /^«Свой»: контур неустойчив/, 'причина под бодэ: ' + gu.LBode4.note)
        // «Свой» тангажа D ×4 (P и I — лога): неустойчив по причинности отклика при запасе первого пересечения больше 0 —
        // запас недостоверен: в таблице «—», на бодэ без чисел и без отметок выбранного, как в таблице
        await page.evaluate(() => {
            const gains = step4.calc.pitch.gains
            step4_set_form_values({ ATC_RAT_PIT_P: gains.P, ATC_RAT_PIT_I: gains.I, ATC_RAT_PIT_D: gains.D * 4 })
            step4_flush_edits(true)
        })
        const d4 = await page.evaluate(() => {
            const row = step4_rows('pitch').find((r) => r.id === 'custom')
            const tr = [...document.querySelectorAll('#candidates4 tbody tr')].find((tr) => tr.querySelector('input').value === 'custom')
            return { selected: step4.selected.pitch, unstable: row.pred.unstable, pm: row.pred.pm_deg, cells: [...tr.querySelectorAll('td.num')].slice(3, 5).map((td) => td.firstChild.textContent) }
        })
        assert.equal(d4.selected, 'custom', 'D ×4: выбрана строка «Свой»')
        assert.ok(d4.unstable && (d4.pm > 0), 'D ×4: неустойчив по причинности при запасе больше 0: ' + JSON.stringify(d4))
        assert.deepEqual(d4.cells, ['—', '—'], 'D ×4: в таблице запас и срез — «—»')
        const gd4 = await step4_plots(page)
        assert.equal(gd4.LBode4.traces[1].name, '«Свой» · запас недостоверен', 'D ×4: на бодэ — «запас недостоверен» без чисел')
        assert.ok(gd4.LBode4.traces[1].finite > 0, 'D ×4: L варианта на бодэ есть')
        assert.deepEqual(gd4.LBode4.shapes, ['ref:zero', 'ref:m180', 'log:fc', 'log:fc', 'log:pm'], 'D ×4: отметок выбранного нет, у лога — есть')
        assert.match(gd4.LBode4.note, /^«Свой»: прогноз неустойчив .* — частота среза и запас фазы недостоверны\.$/, 'D ×4: причина под бодэ: ' + gd4.LBode4.note)
        // Пустое поле D тангажа: прогноз неполный — линий выбранного нет, причина в подписях отклика и бодэ
        await page.evaluate(() => {
            document.getElementById('pidf_ATC_RAT_PIT_D').value = ''
            step4_flush_edits(true)
        })
        const ge = await step4_plots(page)
        assert.equal(ge.LBode4.traces[1].n, 0, 'пустое поле: линии выбранного на бодэ нет')
        assert.match(ge.LBode4.note, /^«Свой»: прогноз неполный: .* — линии нет\.$/, 'пустое поле: причина под бодэ: ' + ge.LBode4.note)
        assert.match(ge.StepResp4.note, /Прогноз «Свой»: прогноз неполный: .* — линии отклика нет\./, 'пустое поле: причина под откликом: ' + ge.StepResp4.note)
        await page.evaluate(() => {
            step4_set_form_values(step4_log_values_of('pitch'))
            step4_flush_edits(true)
        })
        assert.deepEqual((await step4_summary(page)).titles, sub4.titles, 'поля тангажа снова из лога — строки «Свой» нет')
        const sub_lines = { titles: sub4.titles, recommended: sub4.recommended, log: gs1.LBode4.traces[0].name }
        // Снять подмену и пересчитать: снова ненадёжно на всех осях, бодэ пуст
        await page.evaluate(() => {
            pidtune_log_mode = window.__step4_orig.mode
            pidtune_quality = window.__step4_orig.quality
            step4.key = null
            step4_show()
        })
        await wait_overlay(page)
        const back4 = await step4_summary(page)
        assert.match(back4.verdict, /^Измерение ненадёжно на всех осях/, 'подмена снята: ' + back4.verdict)
        assert.deepEqual(back4.titles, ['Как в логе'], 'подмена снята: в таблице только «Как в логе»')
        assert.equal((await step4_plots(page)).LBode4.with_data, 0, 'подмена снята: бодэ L пуст')

        // Регрессия правок: настоящий набор с клавиатуры и немедленный щелчок — раньше пересчёта правки (400 мс), кнопки
        // досчитывают правки сами, а щелчок не теряется
        // Правка P крена и сразу «Принять»: принимаются значения формы, у крена — «Свой»
        await page.click('#step4_tab_roll')
        await type_into('#pidf_ATC_RAT_RLL_P', '0.125')
        assert.equal(await edit_pending4(), true, 'щелчок раньше пересчёта правки')
        await page.click('#pidf_accept')
        await wait_overlay(page)
        assert.deepEqual(await visible_steps(page), ['5'], '«Принять» шага 4 открывает шаг 5')
        const acc4 = await page.evaluate(() => state.steps[4])
        assert.equal(acc4.accepted.ATC_RAT_RLL_P, Math.fround(0.125), 'правка и сразу «Принять» — значение формы')
        assert.deepEqual([acc4.axes.roll.candidate_id, acc4.axes.pitch.candidate_id, acc4.axes.yaw.candidate_id], ['custom', 'log', 'log'], 'у крена «Свой», у остальных — лог')
        await assert_accepted_fresh(page, 4)
        // Шаги 2–3 приняты на интервале, сдвинутом на 20 с, а интервал с тех пор вернули — их принятое устарело
        assert.deepEqual(await page.evaluate(() => [step_accepted_stale(2), step_accepted_stale(3)]), [true, true], 'после смены интервала шаги 2–3 устарели')
        await page.click('#wizbar button:nth-child(5)')
        await wait_overlay(page)
        const e1 = await step4_summary(page)
        assert.deepEqual(e1.titles, ['Как в логе', 'Свой'], 'у крена строка «Свой»')
        assert.equal(e1.selected, 'custom', 'выбрана строка «Свой»')
        assert.match(e1.verdict, /^Принято: крен свои значения, тангаж «Как в логе», рыскание «Как в логе»\.$/, e1.verdict)
        // Строка «Как в логе» крена выбрана; правка поля тангажа и сразу «Применить вариант»: вкладка остаётся на крене,
        // применена строка крена (поля крена — значения лога), правка тангажа — в его строке «Свой»
        await page.check('#cand4_log')
        await type_into('#pidf_ATC_RAT_PIT_P', '0.1')
        assert.equal(await edit_pending4(), true, 'щелчок раньше пересчёта правки')
        await page.click('#cand4_apply')
        await wait_edits4()
        const e2 = await page.evaluate(() => {
            const form = step4_axis_gains(step4_values_from_form(), 'roll')
            const log = step4_log_gains('roll')
            return { axis: step4.axis, roll_log: step4_gain_keys.every((k) => step4_same_value(form[k], log[k])), pitch_p: document.getElementById('pidf_ATC_RAT_PIT_P').value,
                     pitch_rows: step4_rows('pitch').map((r) => r.id), pitch_mark: document.querySelector('#step4_tab_pitch .f').textContent }
        })
        assert.equal(e2.axis, 'roll', '«Применить вариант» после правки тангажа — вкладка осталась на крене')
        assert.equal(e2.roll_log, true, 'применена строка крена «Как в логе»')
        assert.equal(e2.pitch_p, '0.1', 'правка тангажа осталась в поле')
        assert.ok(e2.pitch_rows.includes('custom'), 'у тангажа строка «Свой»: ' + e2.pitch_rows.join(', '))
        assert.equal(e2.pitch_mark, 'в форме свои значения', 'пометка на вкладке тангажа')
        // Правка поля рыскания и сразу щелчок по вкладке рыскания: вкладка открывается, в таблице — «Свой», она выбрана
        await type_into('#pidf_ATC_RAT_YAW_P', '0.25')
        assert.equal(await edit_pending4(), true, 'щелчок раньше пересчёта правки')
        await page.click('#step4_tab_yaw')
        await page.waitForFunction(() => (step4.edit_timer == null) && !step4.edit_postponed && step4_rows('yaw').some((r) => r.id === 'custom'), null, { timeout: 30000 })
        const e3 = await step4_summary(page)
        assert.equal(e3.axis, 'yaw', 'правка и сразу щелчок по вкладке — вкладка рыскания открыта')
        assert.equal(e3.tabs[2].selected, 'true', 'вкладка рыскания выбрана')
        assert.deepEqual(e3.titles, ['Как в логе', 'Свой'], 'у рыскания строка «Свой»')
        assert.equal(e3.selected, 'custom', 'у рыскания выбрана строка «Свой»')
        // Окно FFT 1024 и сразу «Принять»: принято с новым окном
        await type_into('#step4_window', '1024')
        await page.click('#pidf_accept')
        await wait_overlay(page)
        assert.deepEqual(await visible_steps(page), ['5'], '«Принять» с новым окном открывает шаг 5')
        const acc_w = await page.evaluate(() => ({ window: step4.window, key_window: JSON.parse(state.steps[4].calc_key)[2], yaw_p: state.steps[4].accepted.ATC_RAT_YAW_P }))
        assert.deepEqual(acc_w, { window: 1024, key_window: 1024, yaw_p: Math.fround(0.25) }, 'окно FFT 1024 и сразу «Принять» — принято с новым окном')
        await assert_accepted_fresh(page, 4)
        await page.click('#wizbar button:nth-child(5)')
        await wait_overlay(page)
        assert.equal(await page.inputValue('#step4_window'), '1024', 'в поле — окно 1024')
        assert.match((await step4_summary(page)).verdict, /^Принято: /, 'вердикт шага 4 — «Принято»')
        assert.equal((await step4_plots(page)).DSpec4.traces[1].n, 513, 'спектр выхода — окном 1024 (513 бинов)')

        // Устаревание: «Принять» на шаге 3 с другими значениями (INS_GYRO_FILTER 39) после «Принять» на шаге 4 — фильтры
        // для прогноза сменились, вердикт шага 4 — «Принято раньше …»
        await page.click('#wizbar button:nth-child(4)')
        await wait_overlay(page)
        await page.fill('#lpf_INS_GYRO_FILTER', '39')
        await page.click('#lpf_accept')
        await wait_overlay(page)
        assert.deepEqual(await visible_steps(page), ['4'], '«Принять» шага 3 открывает шаг 4')
        assert.equal(await page.evaluate(() => state.steps[3].accepted.INS_GYRO_FILTER), 39, 'на шаге 3 принят INS_GYRO_FILTER 39')
        const stale4 = await step4_summary(page)
        assert.match(stale4.verdict, /^Принято раньше для другого интервала, окна FFT, набора или фильтров шагов 2–3/, stale4.verdict)
        assert.match(stale4.verdict_class, /verdict--warn/, '«Принято раньше» — предупреждение')
        // Отпечаток входов: принятое шага 4 устарело (сменилось принятое шага 3), шага 3 — нет
        await assert_accepted_fresh(page, 3)
        assert.equal(await page.evaluate(() => step_accepted_stale(4)), true, 'шаг 3 принят заново — принятое шага 4 устарело')

        // Графики шага 4 на крене: данные, фон --surface, ширина как у контейнера (проверка после перезагрузки страницы
        // в конце строже: снимки выше уже включили autosize), скриншот
        await page.click('#step4_tab_roll')
        const g4 = await step4_plots(page)
        for (const id of ['StepResp4', 'TarAct4', 'DSpec4']) {
            assert.ok(g4[id].with_data > 0, id + ': с данными')
        }
        for (const id of ['StepResp4', 'TarAct4', 'DSpec4', 'LBode4']) {
            assert.equal(g4[id].bg, surface, id + ': фон — --surface')
        }
        await assert_plot_widths(page, ['StepResp4', 'TarAct4', 'DSpec4', 'LBode4'])
        await page.screenshot({ path: path.join(shots, 'step4.png'), fullPage: true })
        await page.click('#wizbar button:nth-child(1)')

        // Версия фильтра — во входах шагов 2–3: другая версия на шаге 1 («Пересчитать», FFT тот же) меняет отпечаток шага 2 и
        // делает принятое шага 3 устаревшим, возврат версии — снова актуальным (шаг 2 уже устарел из-за интервала, у него —
        // сам отпечаток до и после; раскладку ключа проверяют юнит-тесты)
        await page.click('#wizbar button:nth-child(2)')
        await wait_overlay(page)
        const before_fv = await page.evaluate(() => ({ version: state.spectrum.filter_version, fft_key: step1.fft_key, key2: step_inputs_key(2) }))
        const other_fv = (before_fv.version < 4) ? before_fv.version + 1 : 3
        await page.check('#spec_fv_' + other_fv)
        await page.click('#spec_recalc')
        await wait_overlay(page)
        const fv_stale = await page.evaluate(() => ({ version: state.spectrum.filter_version, fft_key: step1.fft_key, key2: step_inputs_key(2), stale3: step_accepted_stale(3) }))
        assert.deepEqual({ ...fv_stale, key2: fv_stale.key2 !== before_fv.key2 }, { version: other_fv, fft_key: before_fv.fft_key, key2: true, stale3: true },
                         'другая версия фильтра — отпечаток шага 2 сменился, принятое шага 3 устарело')
        await page.check('#spec_fv_' + before_fv.version)
        await page.click('#spec_recalc')
        await wait_overlay(page)
        assert.deepEqual(await page.evaluate(() => ({ key2: step_inputs_key(2), stale3: step_accepted_stale(3) })), { key2: before_fv.key2, stale3: false },
                         'версию фильтра вернули — отпечаток шага 2 прежний, принятое шага 3 снова актуально')
        await page.click('#wizbar button:nth-child(1)')

        // Повторная загрузка того же лога (поле выбора очищается после чтения, change срабатывает снова):
        // шаг 1 считается заново начисто
        await page.evaluate(() => { window.__old_log = state.log; window.__fft = null })
        await page.setInputFiles('#fileItem', log_path)
        await page.waitForFunction(() => (state.log != null) && (state.log !== window.__old_log) &&
            (document.getElementById('loading').style.visibility === 'hidden'), null, { timeout: 180000 })
        assert.equal(await page.evaluate(() => state.gyro === null), true, 'новый лог — гироскоп ещё не загружен')
        // Сразу с шага 0 на шаг 2 (шаг 1 не открывался — расчёт через step1_prepare): форма снова из лога, без строки
        // «Текущий», принятое забыто
        await page.click('#wizbar button:nth-child(3)')
        await wait_overlay(page)
        const v4 = await step2_summary(page)
        assert.equal(await page.evaluate(() => step1_ready()), true, 'шаг 2 сам досчитал шаг 1')
        assert.equal(await page.evaluate(() => step2_key(values_from_form()) === step2_key(values_from_log())), true, 'форма снова из лога')
        assert.deepEqual(v4.titles, v1.titles, 'те же варианты')
        assert.equal(v4.recommended_marks, 1)
        assert.equal(await page.evaluate(() => state.steps[2] ?? null), null, 'принятое на шаге 2 сброшено')
        // Шаг 3 после повторной загрузки: принятое забыто, форма снова из лога, строки «Свой» нет; размер винта остался
        assert.equal(await page.evaluate(() => state.steps[3] ?? null), null, 'принятое на шаге 3 сброшено')
        await page.click('#wizbar button:nth-child(4)')
        await wait_overlay(page)
        const w5 = await step3_summary(page)
        assert.deepEqual(w5.titles, w2.titles, 'после повторной загрузки — те же три варианта, без «Свой»')
        assert.equal(await page.evaluate(() => candidate_key(step3_values_from_form()) === candidate_key(lowpass_log_values(state.params))), true, 'форма шага 3 снова из лога')
        assert.doesNotMatch(w5.verdict, /^Принято/, 'вердикт шага 3 — не «Принято»: ' + w5.verdict)
        const g5 = await step3_plots(page)
        for (const id of ['Spectrum3', 'DTerm3', 'Bode3']) {
            assert.equal(g5[id].with_data, g5[id].traces, id + ': после повторной загрузки — снова с данными')
        }
        // Шаг 4 после повторной загрузки: принятое забыто, форма снова из лога, строк «Свой» нет, вкладка — крен
        assert.equal(await page.evaluate(() => state.steps[4] ?? null), null, 'принятое на шаге 4 сброшено')
        await page.click('#wizbar button:nth-child(5)')
        await wait_overlay(page)
        const p5 = await step4_summary(page)
        assert.equal(p5.axis, 'roll', 'после повторной загрузки — вкладка крена')
        assert.deepEqual(p5.titles, ['Как в логе'], 'после повторной загрузки — только «Как в логе»')
        assert.doesNotMatch(p5.verdict, /^Принято/, 'вердикт шага 4 — не «Принято»: ' + p5.verdict)
        assert.equal(await page.evaluate(() => candidate_key(step4_values_from_form()) === candidate_key(step4_log_values())), true, 'форма шага 4 снова из лога')
        assert.ok((await step4_plots(page)).StepResp4.traces[2].finite > 0, 'после повторной загрузки — измеренный отклик снова на графике')
        // Шаг 1 после этого — тот же, что при первом прогоне
        await page.click('#wizbar button:nth-child(2)')
        await wait_overlay(page)
        const s4 = await step1_summary(page)
        assert.ok(s4.with_data >= 3 && s4.peaks >= 1, 'после повторной загрузки спектр и пики снова есть')
        assert.deepEqual(s4.peak_rows, s1.peak_rows, 'та же таблица пиков')
        assert.equal(s4.verdict, s1.verdict, 'тот же вердикт')
        await page.click('#wizbar button:nth-child(1)')

        // Размер винта переживает перезагрузку страницы (localStorage). Перезагрузка забывает лог — поэтому в самом конце
        await page.reload({ waitUntil: 'networkidle' })
        assert.equal(await page.inputValue('#prop_in'), '10', 'размер винта из памяти браузера после перезагрузки')

        // Ширина графиков, впервые показанных после регистрации в скрытой секции. Проверки ширины выше её не ловят:
        // первый же полностраничный снимок (step0.png) меняет размер окна, обработчик responsive у Plotly включает
        // autosize всем графикам, и даже скрытым, — дальше любой react берёт ширину контейнера. После перезагрузки
        // снимков ещё не было: лог заново и шаги 1–4 по очереди, без снимков. У шага 4 графики ещё и в панели оси, скрытой
        // до первого расчёта
        await page.setInputFiles('#fileItem', log_path)
        await page.locator('#log_verdict').waitFor({ state: 'visible', timeout: 180000 })
        await wait_overlay(page)
        assert.equal(await page.evaluate(() => document.getElementById('Spectrum1').layout.autosize ?? null), null, 'снимков после перезагрузки не было: autosize не включён')
        for (const [button, ids] of [[2, ['Spectrum1', 'Spectrogram1']], [3, ['Spectrum2', 'Bode2', 'Spectrogram2']], [4, ['Spectrum3', 'DTerm3', 'Bode3']],
                                     [5, ['StepResp4', 'TarAct4', 'DSpec4', 'LBode4']]]) {
            await page.click('#wizbar button:nth-child(' + button + ')')
            await wait_overlay(page)
            await assert_plot_widths(page, ids)
        }

        assert.deepEqual(problems, [], 'ошибки консоли')
        console.log('tunewizard-browser: шаги 0–4 пройдены, проверок ' + statuses.length + ' (' + statuses.join(', ') + '); шаг 1: трасс с данными ' + s1.with_data +
            ', бинов ' + s1.x_len + ', пиков ' + s1.peaks + ', вердикт «' + s1.verdict + '»; скриншоты в ' + shots)
        console.log('  пики: ' + s1.peak_rows.map((row) => row.join(' | ')).join(' ; '))
        console.log('  шаг 2: варианты ' + v1.titles.join('; ') + '; рекомендован ' + v1.best_id + '; вердикт «' + v1.verdict + '»')
        console.log('  шаг 3: варианты ' + w2.titles.join('; ') + '; рекомендован ' + w2.recommended.join('; ') + '; вердикт «' + w2.verdict + '»')
        const axis_names4 = { roll: 'крен', pitch: 'тангаж', yaw: 'рыскание' }
        console.log('  шаг 4: ' + Object.entries(axes4).map(([axis, a]) => axis_names4[axis] + ' — ' + a.windows_text + ', ' + a.data_s.toFixed(1) + ' с данных, ' +
            ((a.failed.length == 1) ? 'не пройдена ' : 'не пройдены ') + a.failed.join(', ')).join('; ') + '; итог — измерение ненадёжно на всех осях, прогноз ' +
            'недостоверен (правил и прогноза нет); под подменой у тангажа (фильтры шагов 2–3, без ложного «неустойчив») — варианты ' + sub_lines.titles.join('; ') + ', рекомендуется «' +
            sub_lines.recommended.join('; ') + '», бодэ ' + sub_lines.log)
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
