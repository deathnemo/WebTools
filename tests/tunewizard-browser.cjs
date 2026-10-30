// Smoke-прогон мастера настройки (TuneWizard) в настоящем браузере через Playwright; в начале — строка мастера
// на главной WebTools.
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
// Строка полётного контроллера тестового лога (MSG) и ключ аппарата памяти прохода по ней
const test_board = 'StellarH7V2 0034002E 35335104 39363630'
const fc_key = 'fc:' + test_board
// Имя тестового лога: в TuneWizard/logs/ рядом лежит второй лог (другой аппарат), по алфавиту он первый
const test_log_name = '2026-06-18 18-54-42_anon.bin'

function find_log() {
    if (process.env.TUNEWIZARD_LOG) {
        return process.env.TUNEWIZARD_LOG
    }
    if (!fs.existsSync(logs_dir)) {
        return null
    }
    const names = fs.readdirSync(logs_dir).filter((name) => name.toLowerCase().endsWith('.bin'))
    const bin = names.includes(test_log_name) ? test_log_name : names[0]
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

// Сводка шага 5: вердикт, плитки, строки таблицы шагов (ячейки и кнопка), изменённые и неизменённые строки,
// расхождения, «что перелететь», кнопки и устаревшие шаги; ожидаемое из ядра — строки summary_rows(step_summary_context())
// (изменённые: имя, «станет», шаг) и имена, которым по метаданным нужна перезагрузка
function step5_summary(page) {
    return page.evaluate(() => {
        const cells = (tr) => [...tr.children].map((td) => td.textContent)
        const rows = summary_rows(step_summary_context()).rows
        const changed = rows.filter((row) => row.changed)
        return {
            verdict: document.getElementById('verdict5').textContent,
            verdict_class: document.getElementById('verdict5').className,
            tiles: [...document.querySelectorAll('#tiles5 .stat')].map((tile) => ({ key: tile.querySelector('.stat__k').textContent,
                value: tile.querySelector('.stat__v').textContent, sub: tile.querySelector('.stat__s')?.textContent ?? null })),
            steps: [...document.querySelectorAll('#steps5 tbody tr')].map((tr) => ({ cells: cells(tr), button: tr.querySelector('button')?.textContent ?? null })),
            changes: [...document.querySelectorAll('#changes5 tbody tr')].map(cells),
            expected: changed.map((row) => [row.name, step_value_text(row.value), String(row.step)]),
            unchanged_summary: document.querySelector('#unchanged5 summary').textContent,
            unchanged: document.querySelectorAll('#unchanged5 tbody tr').length,
            expected_unchanged: rows.length - changed.length,
            conflicts: document.getElementById('conflicts5').hidden ? null : document.getElementById('conflicts5').textContent,
            refly: [...document.querySelectorAll('#refly5 li')].map((li) => li.textContent),
            reboot: summary_reboot_names(changed.map((row) => row.name), step_metadata(), step_find_metadata),
            disabled: ['step5_download', 'step5_remember'].map((id) => document.getElementById(id).disabled),
            stale: [2, 3, 4].map((n) => step_accepted_stale(n)),
        }
    })
}

// Ширина содержимого страницы и окна: без горизонтальной прокрутки первая не больше второй
function page_fits(page) {
    return page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth])
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
        const base = 'http://127.0.0.1:' + port
        // Скриншоты для глаз — рядом с логами, в репозиторий не попадают
        const shots = path.join(logs_dir, 'screenshots')
        fs.mkdirSync(shots, { recursive: true })

        // Главная WebTools: строка «Мастер настройки» первая в таблице инструментов, иконка загрузилась, ссылка ведёт на мастер.
        // Проверка — до лога; затем страница мастера открывается заново, как без неё
        await wait_for_server(page, base + '/index.html', server)
        const landing = await page.evaluate(() => {
            const links = [...document.querySelectorAll('a[href="./TuneWizard"]')]
            const img = links[0]?.querySelector('img') ?? null
            const row = links[0]?.closest('tr') ?? null
            return {
                links: links.length,
                src: img?.getAttribute('src') ?? null,
                loaded: (img != null) && img.complete && (img.naturalWidth > 0),
                heading: row?.querySelector('h2')?.textContent ?? null,
                lang: row?.cells[1]?.lang ?? null,
                row_index: row?.rowIndex ?? null,
            }
        })
        assert.deepEqual(landing, { links: 1, src: 'images/TuneWizard_Icon.png', loaded: true, heading: 'Мастер настройки', lang: 'ru', row_index: 0 },
                         'главная: одна ссылка на мастер с загруженной иконкой, строка «Мастер настройки» на русском первая в таблице')
        assert.deepEqual(problems, [], 'главная: ошибки консоли')
        await page.screenshot({ path: path.join(shots, 'landing.png'), fullPage: true })
        await page.click('a[href="./TuneWizard"]')
        await page.waitForURL(base + '/TuneWizard/', { waitUntil: 'networkidle' })
        assert.equal(await page.evaluate(() => document.title), 'Мастер настройки', 'ссылка с главной открывает мастер')
        await page.goto(base + '/TuneWizard/', { waitUntil: 'networkidle' })

        // Каркас до загрузки
        assert.equal(await page.locator('#wizbar button').count(), 6, 'шесть кнопок шагов')
        assert.deepEqual(await step_buttons_disabled(page), [false, true, true, true, true, true], 'до загрузки доступен только шаг 0')
        assert.deepEqual(await visible_steps(page), ['0'], 'видна только секция шага 0')
        assert.deepEqual(await page.evaluate(() => ['log_verdict', 'log_info', 'log_checks', 'memory0'].filter((id) => getComputedStyle(document.getElementById(id)).display !== 'none')), [], 'блоки результата скрыты до загрузки')
        assert.equal(await page.evaluate(() => document.getElementById('spec_batch_field').hidden), true, 'до загрузки лога поле «Окон на пакет» скрыто (аудит A, M9)')

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
        // Браузер теста — новый контекст с пустым хранилищем: прошлого прохода нет, блок скрыт
        assert.deepEqual(await page.evaluate(() => ({ visible: document.getElementById('memory0').checkVisibility(), key: memory_state.key, pass: memory_state.pass })),
                         { visible: false, key: fc_key, pass: null }, 'памяти нет — блок «Прошлый проход» скрыт')
        // Блок «Подготовка к следующему полёту» — по параметрам тестового лога (файла .param нет), цель по умолчанию: вердикт
        // и список — пункты ядра (prep0_context) по порядку, план есть. Значения пунктов здесь не проверяются — правила
        // проверяют tests/tunewizard-prep.test.cjs и tests/tunewizard-prep-browser.cjs
        const prep0 = await page.evaluate(() => {
            const seen = (id) => document.getElementById(id).checkVisibility()
            const ctx = prep0_context()
            return {
                visible: seen('prep0'),
                source: document.getElementById('prep0_source').textContent,
                unfile: seen('prep0_unfile'),
                verdict: seen('prep0_verdict') ? document.getElementById('prep0_verdict').className : null,
                refusal: ctx?.refusal ?? null,
                checks: [...document.querySelectorAll('#prep0_checks .check')].map((c) => [c.className.replace('check check--', ''), c.querySelector('h3').textContent]),
                items: (ctx?.items ?? []).map((item) => [item.status, item.title]),
                plan: seen('prep0_plan') ? document.querySelectorAll('#prep0_plan li').length : 0,
            }
        })
        assert.deepEqual([prep0.visible, prep0.source, prep0.unfile, prep0.refusal], [true, 'По параметрам лога «' + path.basename(log_path) + '».', false, null],
                         'блок подготовки к полёту — по параметрам лога')
        assert.match(prep0.verdict, /^verdict verdict--(ok|warn|fail)$/, 'вердикт подготовки: ' + prep0.verdict)
        assert.ok(prep0.items.length > 0, 'пункты подготовки есть')
        assert.deepEqual(prep0.checks, prep0.items, 'список подготовки — пункты ядра по порядку')
        assert.ok(prep0.plan > 0, 'план полёта есть')

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
        assert.equal(await page.isVisible('#spec_batch_field'), true, 'batch-лог: поле «Окон на пакет» видно (аудит A, M9)')
        // Окно raw шага 0 (2048 — выставлено выше) расчёт batch не трогает: поле показывает окно batch 1024 только для сведения (аудит A, I5)
        assert.deepEqual(await page.evaluate(() => [state.settings.window_size, document.getElementById('FFTWindow_size').value]), [2048, '1024'],
                         'окно raw в настройках прежнее, в поле — окно batch')
        // Окна короче 64 отсчётов (62 и 63 окна на пакет — окно 32) в подсказке не предлагаются (аудит A, M3)
        assert.match(await page.textContent('#spec_wpb_hint'), /допустимо окон на пакет: 1, 3, 7, 15, 31$/, 'подсказка окон на пакет для пакета 1024 (floor(1024 / (1 + (w − 1)·0.5)) — степень двойки не меньше 64)')

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
        // Пустое поле «Окон на пакет» — 1 (как Math.max(parseInt, 1) в run_batch_fft), а не NaN в ключе FFT, из-за которого
        // панель вечно считалась изменённой (аудит A, M4)
        await page.fill('#spec_window_per_batch', '')
        await page.click('#spec_recalc')
        await wait_overlay(page)
        assert.deepEqual(await page.evaluate(() => [step1.fft_key, state.spectrum.window_per_batch, document.getElementById('spec_window_per_batch').value]),
                         ['batch:1', 1, '1'], 'пустое поле окон на пакет — одно окно')
        assert.doesNotMatch(await page.getAttribute('#spec_recalc', 'class') ?? '', /primary/, 'после пересчёта с пустым полем подсветки нет')
        // Спектрограмма гироскопа без данных: переключатели общие, а у гироскопа 2 окон FFT нет — подпись вместо пустой карты
        // без объяснения (аудит A, M5); радио такого гироскопа выключено — включается только для проверки
        assert.equal(await page.isDisabled('#spec_sg_inst1'), true, 'у гироскопа 2 данных нет — радио выключено')
        await page.evaluate(() => { document.getElementById('spec_sg_inst1').disabled = false })
        await page.check('#spec_sg_inst1')
        await wait_overlay(page)
        assert.equal(await page.isVisible('#spec_sg_note'), true, 'подпись о гироскопе без данных видна')
        assert.match(await page.textContent('#spec_sg_note'), /^У гироскопа 2 нет окон FFT до фильтров: спектрограммы нет\. Выберите другой гироскоп или данные\.$/)
        assert.equal(await page.evaluate(() => document.getElementById('Spectrogram1').data[0].z.length), 0, 'тепловая карта пуста')
        await page.check('#spec_sg_inst0')
        await wait_overlay(page)
        await page.evaluate(() => { document.getElementById('spec_sg_inst1').disabled = true })
        assert.equal(await page.isVisible('#spec_sg_note'), false, 'гироскоп с данными — подписи нет')
        // Исключение в источниках трекинга (аудит A, I2): гироскоп остаётся загруженным, трекинга нет, ошибка — в вердикте
        // (и в консоли — это ожидаемая запись), графики пусты; после починки показ шага считает заново, без «Cannot read
        // properties of null». Подмена create_tracking и сброс state.gyro — как неожиданный формат лога
        await page.evaluate(() => {
            window.__create_tracking = create_tracking
            create_tracking = () => { throw new Error('тестовая ошибка трекинга') }
            state.gyro = null
        })
        try {
            await page.click('#spec_recalc')
            await wait_overlay(page)
            const broken1 = await page.evaluate(() => ({ verdict: document.getElementById('verdict1').textContent, cls: document.getElementById('verdict1').className,
                                                          gyro: state.gyro != null, tracking: state.tracking, ready: step1_ready() }))
            assert.deepEqual([broken1.cls, broken1.gyro, broken1.tracking, broken1.ready], ['verdict verdict--fail', true, null, false], 'ошибка трекинга: гироскоп загружен, трекинга нет')
            assert.equal(broken1.verdict, 'Не удалось подготовить источники трекинга notch по этому логу: тестовая ошибка трекинга')
            assert.equal((await step1_summary(page)).with_data, 0, 'при ошибке трекинга графики пусты')
            const tracking_error = problems.findIndex((text) => text.includes('тестовая ошибка трекинга'))
            assert.ok(tracking_error >= 0, 'ошибка трекинга записана в консоль: ' + JSON.stringify(problems))
            problems.splice(tracking_error, 1)
        } finally {
            await page.evaluate(() => { create_tracking = window.__create_tracking })
        }
        await page.click('#wizbar button:nth-child(1)')
        await page.click('#wizbar button:nth-child(2)')
        await wait_overlay(page)
        const fixed1 = await step1_summary(page)
        assert.equal(await page.evaluate(() => step1_ready()), true, 'источники починены — показ шага досчитал расчёт')
        assert.deepEqual([fixed1.peak_rows, fixed1.verdict], [s1.peak_rows, s1.verdict], 'расчёт после починки — тот же, что при первом показе')
        assert.deepEqual(problems, [], 'после ошибки трекинга других ошибок консоли нет')

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
        // Вердикт с рекомендацией: самое большое изменение на пике, полоса и задержка к логу, причины по остальным вариантам
        // («Остальные — …»), рекомендованный выбран (аудит B)
        assert.match(v1.verdict, /^Рекомендуется «[^»]+»: [\d.]+ Гц [+-][\d.]+ дБ, полоса 20–400 Гц [+-][\d.]+ дБ к логу, задержка на 30 Гц [+-][\d.]+ мс\. Остальные — .+: .+\. Он выбран — нажмите «Применить вариант», затем «Принять»\.$/,
                     v1.verdict)

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

        // ПОДМЕНЫ параметров лога (state.params.get/has) с показом шага заново (форма и варианты из подменённого лога; после
        // проверки подмена снимается и шаг показывается заново — варианты прежние). I1: notch лога выключен — допуск задержки
        // не применяется (lag_gate), опора — лог без notch, об этом вердикт и подпись таблицы. I2: notch лога по RPM без
        // данных — опору «как в логе» смоделировать нельзя, рекомендации нет. M10: ESCMSK записан в лог при версии фильтра
        // ниже 4 — поле видно, маска в .param, значения лога шага 1 — та же маска (общее правило escmsk_present) (аудит B)
        const reshow2 = async () => {
            await page.evaluate(() => {
                Object.assign(step2, { filled: false, candidates: null, evaluations: null, ranking: null, current_row: null, current: null, selected_id: null })
                step2_show()
            })
            await wait_overlay(page)
            await page.waitForFunction(() => step2.form_ready && step2.filled && (step2.candidates != null), null, { timeout: 60000 })
        }
        // Подмена параметров лога: values — имя → значение (есть в логе), missing_prefix — остальные имена с этим префиксом
        // «не записаны» (get null, has false); прочее — из лога
        const substitute_params = (values, missing_prefix = null) => page.evaluate(([values, missing_prefix]) => {
            window.__params = window.__params ?? { get: state.params.get, has: state.params.has }
            const orig = window.__params
            const missing = (name) => (missing_prefix != null) && name.startsWith(missing_prefix)
            state.params.get = (name) => (name in values) ? values[name] : (missing(name) ? null : orig.get(name))
            state.params.has = (name) => (name in values) ? true : (missing(name) ? false : orig.has(name))
        }, [values, missing_prefix])
        const restore_params = () => page.evaluate(() => { Object.assign(state.params, window.__params) })
        try {
            await substitute_params({ INS_HNTCH_ENABLE: 0 }, 'INS_HNTCH_')
            await reshow2()
            const i1 = await page.evaluate(() => ({ lag_gate: step2.ranking.lag_gate, verdict: document.getElementById('verdict2').textContent,
                                                     note: document.getElementById('candidates2_note').textContent, enable: document.getElementById('INS_HNTCH_ENABLE').value }))
            assert.equal(i1.enable, '0', 'подмена: notch лога выключен')
            assert.equal(i1.lag_gate, false, 'подмена: допуск задержки не применяется')
            assert.match(i1.verdict, /^Рекомендуется «Автоподбор \(ESC-телеметрия\) \+ второй notch на 153 Гц»/, i1.verdict)
            assert.match(i1.verdict, /к логу без работающего notch \(допуск \+0\.5 мс не применялся\)/, i1.verdict)
            assert.ok(i1.note.endsWith('Notch лога не работает: допуск задержки не применяется, задержки показаны к логу без notch.'), i1.note)
            await restore_params()
            await substitute_params({ INS_HNTCH_MODE: 2 })
            await reshow2()
            const i2 = await step2_summary(page)
            assert.match(i2.verdict_class, /verdict--warn/, 'подмена: опора не смоделирована — предупреждение')
            assert.ok(i2.verdict.startsWith('Опору «как в логе» смоделировать нельзя: Нет данных трекинга для notch RPM1.'), i2.verdict)
            assert.equal(i2.recommended_marks, 0, 'подмена: пометки «рекомендуется» нет')
            await restore_params()
            await substitute_params({ INS_HNTCH_ESCMSK: 3 })
            await reshow2()
            assert.equal(await page.isVisible('#INS_HNTCH_ESCMSK'), true, 'подмена: ESCMSK записан в лог — поле видно и при версии фильтра ниже 4')
            assert.equal(await page.inputValue('#INS_HNTCH_ESCMSK'), '3')
            assert.equal(await page.evaluate(() => values_from_log().INS_HNTCH_ESCMSK), 3, 'значения лога шага 1 — та же маска')
            const [download_esc] = await Promise.all([page.waitForEvent('download'), page.click('#notch_save')])
            assert.match(fs.readFileSync(await download_esc.path(), 'utf8'), /^INS_HNTCH_ESCMSK,3$/m, 'в .param — записанная маска')
        } finally {
            await restore_params()
        }
        await reshow2()
        assert.equal(await page.isHidden('#INS_HNTCH_ESCMSK'), true, 'подмена снята — ESCMSK снова скрыт')
        assert.deepEqual((await step2_summary(page)).titles, v1.titles, 'подмены сняты — прежние варианты')
        assert.equal(await page.evaluate(() => state.steps[2] ?? null), null, 'шаг 2 ещё не принят')

        // Ловушка первого прохода: «Принять» без «Применить вариант» принимает значения лога — вердикт называет
        // рекомендованный вариант (аудит B); затем шаг 2 снова открыт для «Применить вариант»
        assert.notEqual(v1.best_id, 'log', 'на тестовом логе рекомендуется не лог')
        await page.check('#cand2_log')
        await page.click('#cand2_apply')
        await wait_overlay(page)
        await page.click('#notch_accept')
        await wait_overlay(page)
        assert.deepEqual(await visible_steps(page), ['3'], '«Принять» значений лога открывает шаг 3')
        const trap2 = await page.evaluate(() => ({ text: document.getElementById('verdict2').textContent, cls: document.getElementById('verdict2').className,
                                                    id: state.steps[2].candidate_id }))
        assert.equal(trap2.id, 'log', 'принят вариант «log»')
        assert.match(trap2.cls, /verdict--ok/)
        assert.match(trap2.text, /^Принято: «Как в логе» — полоса -?[\d.]+ дБ \(к логу [+-]?[\d.]+\), задержка на 30 Гц [\d.]+ мс \(к логу [+-]?[\d.]+\); рекомендовался «Как в логе \+ второй notch на 153 Гц»\.$/,
                     trap2.text)
        await page.click('#wizbar button:nth-child(3)')
        await wait_overlay(page)

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

        // Приведение полей формы (аудит B): SCHED_LOOP_RATE не больше нуля — значение лога (раньше alias_obj падал на
        // new Array(NaN)), и с режимом алиасинга «свернуть» (радио шага 1 — переключается скриптом, секция скрыта) пересчёт
        // не даёт «Ошибка шага 2»; маски — целая часть, отрицательная 32-битная — значение лога
        await page.fill('#SCHED_LOOP_RATE', '0')
        await page.dispatchEvent('#SCHED_LOOP_RATE', 'change')
        assert.equal(await page.inputValue('#SCHED_LOOP_RATE'), '400', 'SCHED_LOOP_RATE 0 — значение лога')
        await page.evaluate(() => { document.getElementById('spec_alias_fold').checked = true; step1_view_changed() })
        await wait_overlay(page)
        await page.click('#notch_recalc')
        await wait_overlay(page)
        assert.doesNotMatch(await page.textContent('#verdict2'), /^Ошибка шага 2/, 'пересчёт со свёрнутым спектром не падает')
        assert.equal(await page.evaluate(() => step2.current.values.SCHED_LOOP_RATE), 400)
        await page.evaluate(() => { document.getElementById('spec_alias_none').checked = true; step1_view_changed() })
        await wait_overlay(page)
        const opts_log = await page.evaluate(() => values_from_log().INS_HNTCH_OPTS)
        const opts_before = await page.inputValue('#INS_HNTCH_OPTS')
        await page.fill('#INS_HNTCH_OPTS', '1.5')
        await page.dispatchEvent('#INS_HNTCH_OPTS', 'change')
        assert.equal(await page.inputValue('#INS_HNTCH_OPTS'), '1', 'маска 1.5 — целая часть')
        await page.fill('#INS_HNTCH_OPTS', '-1')
        await page.dispatchEvent('#INS_HNTCH_OPTS', 'change')
        assert.equal(await page.inputValue('#INS_HNTCH_OPTS'), String(opts_log), 'отрицательная 32-битная маска — значение лога')
        await page.fill('#INS_HNTCH_OPTS', opts_before)
        await page.dispatchEvent('#INS_HNTCH_OPTS', 'change')
        // INS_GYRO_FILTER выше 0.4 частоты гироскопа: модель считает с ограниченным срезом, как прошивка (lowpass_gyro_cutoff,
        // как на шаге 3) — метрики, оценка «после» и бодэ конечны, в предупреждениях фильтров — об ограничении (стык областей B и C)
        const gyro_log = await page.evaluate(() => values_from_log().INS_GYRO_FILTER)
        await page.fill('#INS_GYRO_FILTER', '1000')
        await page.dispatchEvent('#INS_GYRO_FILTER', 'change')
        await page.click('#notch_recalc')
        await wait_overlay(page)
        const clamp2 = await page.evaluate(() => ({
            band: step2.current_row.evaluation.band_dB, lag: step2.current_row.evaluation.lag_ms[30], values: step2.current_row.values.INS_GYRO_FILTER,
            est: Array.from(document.getElementById('Spectrum2').data[3].y).every(Number.isFinite), bode: Array.from(document.getElementById('Bode2').data[2].y).every(Number.isFinite),
            tiles: [...document.querySelectorAll('#metrics2 .stat')].map((tile) => tile.textContent), warnings: document.getElementById('warnings2').textContent,
            warnings_hidden: document.getElementById('warnings2').hidden,
        }))
        assert.ok(Number.isFinite(clamp2.band) && Number.isFinite(clamp2.lag) && clamp2.est && clamp2.bode, 'INS_GYRO_FILTER 1000: оценка и графики конечны: ' + JSON.stringify(clamp2))
        assert.equal(clamp2.values, 1000, 'в строке «Текущий» — значение формы, ограничен только срез модели')
        assert.ok((clamp2.tiles.length > 0) && !clamp2.tiles.some((text) => /NaN/.test(text)), 'в плитках нет NaN: ' + clamp2.tiles.join(' | '))
        assert.equal(clamp2.warnings_hidden, false)
        assert.match(clamp2.warnings, /INS_GYRO_FILTER 1000 выше 0\.4 частоты гироскопа \([\d.]+ Гц\): прошивка ограничит до [\d.]+ Гц — так и посчитано/, clamp2.warnings)
        await page.fill('#INS_GYRO_FILTER', String(gyro_log))
        await page.dispatchEvent('#INS_GYRO_FILTER', 'change')
        await page.click('#notch_recalc')
        await wait_overlay(page)
        assert.doesNotMatch(await page.textContent('#warnings2'), /прошивка ограничит/, 'INS_GYRO_FILTER лога — предупреждения об ограничении нет')

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

        // «Загрузить .param»: значение из файла в форму и пересчёт; значение вне списка (INS_HNTCH_MODE 7 — списка значений
        // из метаданных) пропускается с заметкой, поле остаётся прежним (аудит B, M4)
        const param_file = path.join(shots, 'test_notch.param')
        const mode_before = await page.inputValue('#INS_HNTCH_MODE')
        assert.equal(mode_before, '3')
        fs.writeFileSync(param_file, '# тест\nINS_HNTCH_ATT,33\nINS_HNTCH_BW 21\nINS_HNTCH_MODE,7\nNOT_A_PARAM,1\n')
        await page.setInputFiles('#notch_load_file', param_file)
        await page.waitForFunction(() => document.getElementById('INS_HNTCH_ATT').value === '33', null, { timeout: 30000 })
        await wait_overlay(page)
        assert.equal(await page.inputValue('#INS_HNTCH_BW'), '21', 'формат MAVProxy из файла')
        assert.match(await page.textContent('#notch_file_note'), /взято параметров формы: 2 из 22\. Пропущены значения вне списка \(поля не изменились\): INS_HNTCH_MODE = 7\.$/)
        assert.equal(await page.inputValue('#INS_HNTCH_MODE'), mode_before, 'MODE вне списка — поле прежнее')
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
        // «Пересчитать фильтры» при устаревших вариантах сначала подбирает их заново, а выбранная строка (автоподбор) остаётся
        // выбранной (аудит B, M5)
        await page.check('#cand2_fit')
        await page.click('#notch_recalc')
        await wait_overlay(page)
        assert.deepEqual(await page.evaluate(() => [step2_stale(), step2.selected_id, document.querySelector('#candidates2 input[name="cand2"]:checked')?.value ?? null]),
                         [false, 'fit', 'fit'], 'после «Пересчитать» варианты актуальны, выбран автоподбор')
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
        // Память прохода, пока принятое шага 2 актуально: его оценки — числа (формы метрик страницы step2_metrics_summary
        // и ядра passmem_estimates2 совпадают), шаги 3–4 не приняты — null. Запись убирается: сводка шага 5 ниже проверяет
        // запись, сделанную «Скачать .param»
        const mem2 = await page.evaluate(() => {
            const text = memory_save()
            const data = JSON.parse(localStorage.getItem('tunewizard_v1'))
            localStorage.removeItem('tunewizard_v1')
            return { text: text, keys: Object.keys(data.passes), estimates: data.passes[passmem_aircraft_key(state.info, state.file_name)].estimates }
        })
        assert.equal(mem2.text, 'Память прохода сохранена.')
        assert.deepEqual(mem2.keys, [fc_key], 'проход — по строке контроллера')
        for (const part of ['log', 'accepted']) {
            for (const field of ['band_dB', 'lag30_ms']) {
                assert.ok(Number.isFinite(mem2.estimates[2][part][field]), 'оценка шага 2 ' + part + '.' + field + ' — число: ' + JSON.stringify(mem2.estimates[2]))
            }
        }
        assert.deepEqual([mem2.estimates[3], mem2.estimates[4]], [null, null], 'шаги 3–4 не приняты — оценок нет')

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
        // INS_GYRO_FILTER выше 0.4 частоты гироскопа: срез для модели ограничен, как в прошивке (lowpass_gyro_cutoff) — метрики
        // «Свой» конечны, в заметках — об ограничении; затем значение лога (аудит C)
        const custom_gyro = (hz) => page.waitForFunction((hz) => (step3.edit_timer == null) && (step3_rows().find((r) => r.id === 'custom')?.values.INS_GYRO_FILTER === hz),
                                                           hz, { timeout: 30000 })
        await page.fill('#lpf_INS_GYRO_FILTER', '1000')
        await custom_gyro(1000)
        const clamp3 = await page.evaluate(() => {
            const e = step3_rows().find((r) => r.id === 'custom').evaluation
            return { numbers: [e.gyro.band_dB, e.lag_ms.roll.P[30], e.lag_ms.pitch.D[30], e.dterm.roll.dB], warnings: document.getElementById('warnings3').textContent }
        })
        assert.ok(clamp3.numbers.every(Number.isFinite), 'INS_GYRO_FILTER 1000: метрики «Свой» конечны: ' + JSON.stringify(clamp3.numbers))
        assert.match(clamp3.warnings, /INS_GYRO_FILTER 1000 выше 0\.4 частоты гироскопа \([\d.]+ Гц\): прошивка ограничит до [\d.]+ Гц — так и посчитано/, clamp3.warnings)
        await page.fill('#lpf_INS_GYRO_FILTER', String(log3.INS_GYRO_FILTER))
        await custom_gyro(log3.INS_GYRO_FILTER)
        assert.doesNotMatch(await page.textContent('#warnings3'), /прошивка ограничит/, 'INS_GYRO_FILTER лога — заметки об ограничении нет')
        // Поля формы принимают дробные значения (step="any": 9.4″, FLTE 1.2 — поле :valid), границы размера винта 4–40″ —
        // атрибуты поля; значения подставляются без событий и возвращаются (аудит C)
        const valid3 = await page.evaluate(() => {
            const probe = (id, value) => {
                const field = document.getElementById(id)
                const old = field.value
                field.value = value
                const valid = field.validity.valid
                field.value = old
                return valid
            }
            const prop = document.getElementById('prop_in')
            return { prop: probe('prop_in', '9.4'), flte: probe('lpf_ATC_RAT_RLL_FLTE', '1.2'), small: probe('prop_in', '3'), attrs: [prop.min, prop.max, prop.step] }
        })
        assert.deepEqual(valid3, { prop: true, flte: true, small: false, attrs: ['4', '40', 'any'] }, 'дробные размер винта и FLTE допустимы, 3″ — вне границ')

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

        // Отрицательный предел ускорения принять нельзя (аудит C): отказ в вердикте, шаг 4 не открыт, принятое не тронуто
        await page.click('#wizbar button:nth-child(4)')
        await wait_overlay(page)
        const before3 = await page.evaluate(() => state.steps[3].evaluated_at)
        await page.fill('#lpf_ATC_ACCEL_R_MAX', '-5')
        await page.click('#lpf_accept')
        await wait_overlay(page)
        assert.deepEqual(await visible_steps(page), ['3'], 'отказ — шаг 4 не открыт')
        assert.match(await page.textContent('#verdict3'), /^Принять нельзя — отрицательные пределы ускорения: ATC_ACCEL_R_MAX\.$/)
        assert.deepEqual(await page.evaluate(() => [state.steps[3].evaluated_at, state.steps[3].accepted.INS_GYRO_FILTER, state.steps[3].accepted.ATC_ACCEL_R_MAX]),
                         [before3, 38, 90000], 'принятое шага 3 не изменилось')
        await page.fill('#lpf_ATC_ACCEL_R_MAX', '90000')
        await wait_step3_row(page, 'Свой')

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
        assert.match(p4.verdict, /и ACRO_TRAINER = 0/, 'совет тестового полёта называет ACRO_TRAINER = 0 (аудит D)')
        assert.equal(await page.evaluate(() => document.getElementById('step4_acro_row').hidden), true, 'участка ACRO в логе нет — кнопки «Интервал — участок ACRO» нет (аудит D)')
        // FFT компонент — только нужных шагу: Tar и Act (отклик PIDReview), D (шум и спектр D), Out (спектр выхода) (аудит D, M8)
        assert.deepEqual(await page.evaluate(() => Object.keys(step4_source('roll').sets.find((set) => set != null).FFT)), ['time', 'Tar', 'Act', 'D', 'Out'],
                         'FFT набора крена — время и четыре компоненты')
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
            assert.match(s.axis_verdict, /Слетайте тестовый лог: Acro с ACRO_OPTIONS бит 1 «Rate Loop Only» \(значение 2, или 3 вместе с Air-mode\) и ACRO_TRAINER = 0/,
                         axis + ': вердикт объясняет тестовый полёт')
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
        // Варианты и бодэ тангажа под подменой и строка сравнения оси — для итоговой строки прогона (после снятия подмен)
        let sub_lines = null
        let line4 = null
        try {
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
            // Строка сравнения оси с прошлым проходом при надёжном измерении. Синтетический проход — только в memory_state
            // (хранилище не трогается): тангаж менял D, значение применено. Фильтры шагов 2–3 приняты другими, а запас фазы
            // «в этом логе» есть: прогноз лога — с фильтрами лога. Прогноз оси сейчас недостоверен — у запаса фазы два числа
            // и пояснение; прогноз прохода неустойчив — его чисел нет; недостоверен — запаса фазы нет совсем; D тангажа не
            // применён — «применены не все». memory_state, прогноз оси и вердикт оси — вернуть
            line4 = await page.evaluate(() => {
                const res = step4.calc.pitch
                const record = { reliable: true, measured: { overshoot_pct: 12.5, rise_s: 0.055 }, log: { pm_deg: 48, crossover_hz: 11.2 },
                                 prediction: { overshoot_pct: 8.5, rise_s: 0.05, pm_deg: 55, unstable: false } }
                const d = state.params.get('ATC_RAT_PIT_D')
                const pass = { key: memory_state.key, saved_at: Date.now(), changed: [{ name: 'ATC_RAT_PIT_D', log: d * 2, value: d, step: 4 }],
                               estimates: { 2: null, 3: null, 4: { roll: null, pitch: record, yaw: null } } }
                const saved = { ...memory_state }
                const predict_ok = res.predict_ok
                const bits = hmncs_bits(state.params, state.spectrum.filter_version ?? 1)
                const text = () => {
                    step4_render_axis_verdict()
                    const box = document.getElementById('memory4')
                    return box.hidden ? null : box.textContent
                }
                try {
                    Object.assign(memory_state, { pass: pass, applied: passmem_applied(pass, state.params, bits) })
                    const lines = { gyro_changed: step4_gyro_changed(), ok: text() }
                    res.predict_ok = false
                    lines.invalid_now = text()
                    res.predict_ok = predict_ok
                    record.prediction.unstable = true
                    lines.unstable = text()
                    record.prediction = null
                    lines.invalid_was = text()
                    pass.changed[0].value = d * 3
                    memory_state.applied = passmem_applied(pass, state.params, bits)
                    lines.partial = text()
                    return { ...lines, head: 'Прошлый проход (' + memory_date_text(pass.saved_at) + ')',
                             now: [res.metrics.overshoot_pct.toFixed(1), (res.metrics.rise_s * 1000).toFixed(1), res.pred_log.pm_deg.toFixed(1)] }
                } finally {
                    res.predict_ok = predict_ok
                    Object.assign(memory_state, saved)
                    step4_render_axis_verdict()
                }
            })
            const [os4, rise4, pm4] = line4.now
            const head4 = line4.head + ', было → прогноз → в этом логе: '
            assert.equal(line4.gyro_changed, true, 'фильтры гироскопа шагов 2–3 отличаются от лога')
            assert.equal(line4.ok, head4 + 'перерегулирование 12.5 → 8.5 → ' + os4 + ' %; нарастание 55.0 → 50.0 → ' + rise4 + ' мс; запас фазы 48.0 → 55.0 → ' + pm4 + '°.',
                         'строка оси: измерение и запас фазы лога')
            assert.ok(line4.invalid_now.startsWith(head4 + 'перерегулирование 12.5 → 8.5 → ' + os4 + ' %; '), line4.invalid_now)
            assert.ok(line4.invalid_now.endsWith('; запас фазы 48.0 → 55.0°; запас фазы этого лога — только при достоверном прогнозе.'),
                      'прогноз оси сейчас недостоверен — у запаса фазы два числа и пояснение: ' + line4.invalid_now)
            assert.ok(line4.unstable.includes('перерегулирование 12.5 → — → ' + os4 + ' %; ') && line4.unstable.includes('; запас фазы 48.0 → — → ' + pm4 + '°; ') &&
                      line4.unstable.endsWith('; прогноз был неустойчив.'), 'прогноз прохода неустойчив — без его чисел: ' + line4.unstable)
            assert.ok(line4.invalid_was.startsWith(head4 + 'перерегулирование 12.5 → — → ' + os4 + ' %; нарастание 55.0 → — → ' + rise4 + ' мс; ') &&
                      !line4.invalid_was.includes('запас фазы') && line4.invalid_was.endsWith('; прогноз был недостоверен.'),
                      'прогноз прохода недостоверен — запаса фазы нет: ' + line4.invalid_was)
            assert.equal(line4.partial, line4.head + ': параметры шагов 2–3 и этой оси применены не все — сравнивать нечего.')
            assert.deepEqual(await page.evaluate(() => [document.getElementById('memory4').hidden, step4.calc.pitch.predict_ok]), [true, true],
                             'проход и прогноз оси вернули — строки оси нет')
            sub_lines = { titles: sub4.titles, recommended: sub4.recommended, log: gs1.LBode4.traces[0].name }
            // ПОДМЕНА поверх прежней: запас фазы не определён (развёртка фазы недостоверна — pidtune_margins даёт pm_deg null с
            // причиной pm_note): в таблице «—» с причиной в подсказке ячейки, в оценке строки — «запас фазы не определён (…)»,
            // неустойчивым прогноз не считается, в легенде бодэ и плитке лога — «запас не определён» (аудит D)
            await page.evaluate(() => {
                window.__step4_orig.margins = pidtune_margins
                pidtune_margins = (...args) => ({ ...window.__step4_orig.margins(...args), pm_deg: null, gm_db: null, pm_note: 'тест: развёртка фазы недостоверна' })
                step4.key = null
                step4_show()
            })
            await wait_overlay(page)
            await page.click('#step4_tab_pitch')
            const margins4 = await page.evaluate(() => {
                const tr = [...document.querySelectorAll('#candidates4 tbody tr')].find((tr) => tr.querySelector('input').value === 'p_plus')
                const cells = [...tr.querySelectorAll('td.num')]
                return { pm: cells[3].firstChild.textContent, title: cells[3].title, verdict: tr.lastElementChild.textContent,
                         unstable: step4_rows('pitch').map((r) => r.pred?.unstable ?? null), legend: document.getElementById('LBode4').data[0].name,
                         tile: [...document.querySelectorAll('#metrics4 .stat')].map((tile) => tile.textContent).find((text) => text.startsWith('Срез · запас фазы (лог)')) ?? null,
                         axis_verdict: document.getElementById('axis_verdict4').textContent }
            })
            assert.deepEqual([margins4.pm, margins4.title], ['—', 'тест: развёртка фазы недостоверна'], 'запас не определён — «—» с причиной в подсказке')
            assert.match(margins4.verdict, /запас фазы не определён \(тест: развёртка фазы недостоверна\)/, 'оценка строки: ' + margins4.verdict)
            assert.doesNotMatch(margins4.verdict, /неустойчив/, 'без «неустойчив»: ' + margins4.verdict)
            assert.ok(margins4.unstable.every((u) => u === false), 'прогнозы не помечены неустойчивыми: ' + JSON.stringify(margins4.unstable))
            assert.match(margins4.legend, /^лог · срез [\d.]+ Гц · запас не определён$/, 'легенда бодэ лога: ' + margins4.legend)
            assert.match(margins4.tile ?? '', /Срез · запас фазы \(лог\)[\d.]+ Гц · не определёнтест: развёртка фазы недостоверна/, 'плитка лога: ' + margins4.tile)
            assert.match(margins4.axis_verdict, /запас фазы не определён \(лог не определён\)/, 'вердикт оси: ' + margins4.axis_verdict)
        } finally {
            // Снять подмены (и при упавшей проверке); pidtune_margins подменяется позже остальных — вернуть, только если была
            await page.evaluate(() => {
                pidtune_log_mode = window.__step4_orig.mode
                pidtune_quality = window.__step4_orig.quality
                if (window.__step4_orig.margins != null) {
                    pidtune_margins = window.__step4_orig.margins
                }
            })
        }
        // Пересчитать без подмен: снова ненадёжно на всех осях, бодэ пуст
        await page.evaluate(() => {
            step4.key = null
            step4_show()
        })
        await wait_overlay(page)
        const back4 = await step4_summary(page)
        assert.match(back4.verdict, /^Измерение ненадёжно на всех осях/, 'подмена снята: ' + back4.verdict)
        assert.deepEqual(back4.titles, ['Как в логе'], 'подмена снята: в таблице только «Как в логе»')
        assert.equal((await step4_plots(page)).LBode4.with_data, 0, 'подмена снята: бодэ L пуст')

        // ПОДМЕНА: лог тестового полёта с интервалом шире участка ACRO (pidtune_log_mode → rate_only_segment внутри интервала
        // анализа): кнопка «Интервал — участок ACRO», подсказка сузить интервал в сводке и вердикте оси вместо совета слетать
        // снова; щелчок сужает интервал анализа до целых секунд внутри участка и пересчитывает шаг (ключ расчёта сменился).
        // Затем подмена снимается, интервал возвращается (аудит D)
        const seg4 = { start: start + 10.4, end: start + 70.6 }
        const acro_interval = { start: Math.ceil(seg4.start), end: Math.floor(seg4.end) }
        await page.evaluate((seg) => {
            pidtune_log_mode = (...args) => ({ ...window.__step4_orig.mode(...args), rate_only: false, mixed_modes: ['STABILIZE', 'ACRO'], rate_only_segment: seg })
            window.__step4_key = step4.key
            step4.key = null
            step4_show()
        }, seg4)
        try {
            await wait_overlay(page)
            await page.click('#step4_tab_roll')
            const acro4 = await step4_summary(page)
            const hint4 = 'сузьте интервал анализа до участка ACRO (' + acro_interval.start + '–' + acro_interval.end + ' с)'
            assert.equal(await page.isVisible('#step4_acro_row'), true, 'подмена: кнопка «Интервал — участок ACRO» видна')
            assert.ok(acro4.verdict.includes(hint4) && !acro4.verdict.includes('нужен тестовый полёт'), 'подмена: сводка советует сузить интервал: ' + acro4.verdict)
            assert.ok(acro4.axis_verdict.includes(hint4), 'подмена: вердикт оси советует сузить интервал: ' + acro4.axis_verdict)
            assert.match(acro4.axis_verdict, /В интервале режимы STABILIZE, ACRO: смешение режимов ломает проверку \(б\)/, acro4.axis_verdict)
            await page.click('#step4_acro_interval')
            await wait_overlay(page)
            assert.deepEqual(await page.evaluate(() => [state.settings.start, state.settings.end, step4.key !== window.__step4_key, step4_stale(),
                                                         document.getElementById('TimeStart').value, document.getElementById('TimeEnd').value]),
                             [acro_interval.start, acro_interval.end, true, false, String(acro_interval.start), String(acro_interval.end)],
                             '«Интервал — участок ACRO»: интервал анализа — участок, шаг пересчитан')
        } finally {
            // Снять подмену и вернуть интервал (и при упавшей проверке), затем пересчитать шаг
            await page.evaluate(([s, e]) => {
                pidtune_log_mode = window.__step4_orig.mode
                document.getElementById('TimeStart').value = s
                document.getElementById('TimeEnd').value = e
                interval_input_changed()
            }, [start, end])
        }
        await page.evaluate(() => {
            step4.key = null
            step4_show()
        })
        await wait_overlay(page)
        assert.deepEqual(await page.evaluate(() => [state.settings.start, state.settings.end, document.getElementById('step4_acro_row').hidden]), [start, end, true],
                         'подмена снята, интервал прежний — кнопки нет')

        // ПОДМЕНА: PID тангажа менялись после интервала анализа — в конце лога (state.params) другое P, чем в наборе интервала
        // (step4_gains_after): строка «Набор интервала», подпись «в наборе интервала: … (в конце лога …)», предупреждения
        // сводки и вердикта оси; после «Принять» set_values — набор интервала, а сводка шага 5 помечает строку и вердикт
        // (аудит D, I2; аудит E, D-2). Затем подмена снимается
        const pit_p = await page.evaluate(() => {
            window.__params_get = state.params.get
            const get = state.params.get
            const set_value = step4.calc.pitch.gains.P
            state.params.get = (name) => (name === 'ATC_RAT_PIT_P') ? Math.fround(set_value * 1.5) : get(name)
            step4.key = null
            step4_show()
            return set_value
        })
        try {
            await wait_overlay(page)
            await page.click('#step4_tab_pitch')
            const after4 = await step4_summary(page)
            assert.deepEqual(after4.titles, ['Набор интервала'], 'подмена: строка лога — «Набор интервала»')
            assert.match(await page.evaluate(() => document.querySelector('#pidf_form p[data-name="ATC_RAT_PIT_P"] .inlog').textContent),
                         /^в наборе интервала: [\d.]+ \(в конце лога [\d.]+\)$/, 'подпись поля P тангажа')
            assert.match(await page.evaluate(() => document.querySelector('#pidf_form p[data-name="ATC_RAT_PIT_I"] .inlog').textContent),
                         /^в наборе интервала: [\d.]+$/, 'подпись поля I тангажа — без значения конца лога (оно то же)')
            assert.match(after4.verdict, / PID тангажа менялись после интервала анализа — принятое перепишет значения конца лога \(подробности — во вкладках осей\)\.$/, after4.verdict)
            assert.match(after4.verdict_class, /verdict--warn/)
            assert.match(after4.axis_verdict, /После интервала анализа параметры менялись: в конце лога P = [\d.]+, I = [\d.]+, D = [\d.]+ \(в наборе интервала P = [\d.]+, I = [\d.]+, D = [\d.]+\)\. Принятое перепишет значения конца лога\./,
                         after4.axis_verdict)
            assert.match(await page.textContent('#candidates4 tbody tr:first-child td:last-child'), /^набор интервала \(в конце лога другие значения\)/, 'оценка строки лога')
            await page.click('#pidf_accept')
            await wait_overlay(page)
            assert.deepEqual(await visible_steps(page), ['5'], '«Принять» под подменой открывает шаг 5')
            const acc_after = await page.evaluate(() => ({
                set: state.steps[4].set_values.ATC_RAT_PIT_P, accepted: state.steps[4].accepted.ATC_RAT_PIT_P, verdict: document.getElementById('verdict5').textContent,
                row: [...document.querySelectorAll('#changes5 tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent)).find((cells) => cells[0] === 'ATC_RAT_PIT_P') ?? null,
            }))
            assert.deepEqual([acc_after.set, acc_after.accepted], [Math.fround(pit_p), Math.fround(pit_p)], 'set_values и принятое — набор интервала')
            assert.ok((acc_after.row != null) && /в конце лога другое значение: параметры менялись после интервала анализа/.test(acc_after.row[4]),
                      'в изменениях сводки — пометка: ' + JSON.stringify(acc_after.row))
            assert.match(acc_after.verdict, /PID менялись после интервала анализа: принятое перепишет значения конца лога \(см\. пометки\)/, acc_after.verdict)
        } finally {
            await page.evaluate(() => {
                state.params.get = window.__params_get
                step4.key = null
            })
        }
        await page.click('#wizbar button:nth-child(5)')
        await wait_overlay(page)
        await page.click('#step4_tab_pitch')
        assert.deepEqual((await step4_summary(page)).titles, ['Как в логе'], 'подмена снята — строка лога снова «Как в логе»')

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

        // Шаг 5 «Сводка» после устаревания: шаг 2 принят на сдвинутом интервале, а интервал вернули — устарел; шаг 3 принят
        // заново (INS_GYRO_FILTER 39) — актуален; шаг 4 устарел из-за нового принятого шага 3; у шага 4 все оси без
        // надёжного измерения. Метаданные параметров уже загружены шагами 3–4 — пункт о перезагрузке считается по ним
        await page.click('#wizbar button:nth-child(6)')
        assert.deepEqual(await visible_steps(page), ['5'], 'открыт шаг 5')
        await page.waitForFunction(() => step_metadata() != null, null, { timeout: 30000 })
        const v5 = await step5_summary(page)
        assert.deepEqual(v5.stale, [true, false, true], 'устарели шаги 2 и 4, шаг 3 актуален')
        assert.match(v5.verdict_class, /verdict--warn/, 'сводка — предупреждение')
        assert.match(v5.verdict, /^Изменено \d+ параметр\S*, но проверьте: принятое шагов 2, 4 устарело — примите их заново;/, v5.verdict)
        assert.match(v5.verdict, /; оси шага 4 без надёжного измерения: крен, тангаж, рыскание — нужен тестовый полёт\.$/, v5.verdict)
        assert.deepEqual(v5.tiles.map((tile) => [tile.key, tile.value]), [['Аппарат', 'StellarH7V2'], ['Лог', path.basename(log_path)],
                         ['Изменено', String(v5.expected.length)], ['Приняты шаги', '2, 3, 4']], 'плитки сводки')
        assert.equal(v5.tiles[0].sub, 'QUAD/X_REV · 0034002E 35335104 39363630', 'аппарат: плата — значением, рама и номер процессора — подписью')
        assert.equal(v5.tiles[3].sub, 'устарело: 2, 4')
        assert.deepEqual(v5.steps.map((row) => [row.cells[0], row.cells[1], row.button]),
                         [['Шаг 2Гармонический notch', 'устарело', 'К шагу 2'], ['Шаг 3Низкочастотные фильтры', 'принят', null], ['Шаг 4PID по осям', 'устарело', 'К шагу 4']],
                         'таблица шагов: устаревшие — с кнопкой перехода')
        assert.match(v5.steps[2].cells[2], /^Примите шаг 4 заново: после «Принять» сменились интервал анализа или фильтры шагов 2–3\.Принято: крен — ненадёжно; тангаж — ненадёжно; рыскание — ненадёжно$/,
                     v5.steps[2].cells[2])
        assert.match(v5.steps[1].cells[2], /^Шум гироскопа [+-]?[\d.]+ дБ, шум D .*; задержка на 30 Гц: путь P .* \(к логу\)/, v5.steps[1].cells[2])
        // Изменения — изменённые строки итога (имя, «станет», шаг); INS_GYRO_FILTER — 39 от шага 3. Расхождения шагов нет:
        // шаг 2 оставил INS_GYRO_FILTER лога (принятые варианты его не меняли), а расхождение считается только между
        // значениями, отличными от лога (summary_rows)
        assert.deepEqual(v5.changes.map((cells) => [cells[0], cells[2], cells[3]]), v5.expected, 'строки изменений — изменённые строки итога')
        assert.ok(v5.expected.some(([name, value, step]) => (name === 'INS_GYRO_FILTER') && (value === '39') && (step === '3')), 'INS_GYRO_FILTER = 39 от шага 3')
        assert.equal(v5.conflicts, null, 'шаг 2 оставил INS_GYRO_FILTER лога — расхождения шагов нет')
        assert.equal(v5.unchanged, v5.expected_unchanged, 'неизменённые — в свёрнутом списке')
        assert.match(v5.unchanged_summary, new RegExp('^Без изменений — ' + v5.expected_unchanged + ' параметр'), v5.unchanged_summary)
        // Что перелететь: тестовый полёт (все оси ненадёжны), перезагрузка — по метаданным, последним — «слетайте тем же профилем»
        assert.match(v5.refly[v5.refly.length - 1], /^Слетайте тем же профилем/, 'последний пункт: ' + v5.refly.join(' | '))
        assert.ok(v5.refly.some((text) => text.startsWith('Крен, тангаж, рыскание — нужен тестовый полёт: Acro')), 'пункт тестового полёта: ' + v5.refly.join(' | '))
        assert.equal(v5.refly.some((text) => text.startsWith('После записи перезагрузите полётный контроллер — только после перезагрузки действуют: ' + v5.reboot.join(', '))),
                     v5.reboot.length > 0, 'пункт о перезагрузке — по метаданным: ' + JSON.stringify(v5.reboot))
        // Пункты подготовки к полёту (prep0_summary — по параметрам лога, цель по умолчанию): warn и fail с «что сделать» —
        // подряд и по порядку списка шага 0, «title — fix», до тестового полёта; за ними — общий пункт о файле
        // <лог>_prep.param. Без чисел: какие пункты — зависит от параметров тестового лога
        const prep5 = await page.evaluate(() => {
            const prep = prep0_summary()
            const lines = (prep?.items ?? []).filter((item) => ((item.status === 'warn') || (item.status === 'fail')) && ((item.fix ?? '') !== ''))
                .map((item) => summary_period(item.title + ' — ' + summary_lower_first(item.fix)))
            return { lines: lines, file_name: prep?.file_name ?? null }
        })
        const prep5_at = (prep5.lines.length > 0) ? v5.refly.indexOf(prep5.lines[0]) : -1
        if (prep5.lines.length > 0) {
            assert.ok(prep5_at >= 0, 'пункты подготовки в «что перелететь»: ' + prep5.lines.join(' | ') + ' — в сводке: ' + v5.refly.join(' | '))
            assert.deepEqual(v5.refly.slice(prep5_at, prep5_at + prep5.lines.length), prep5.lines, 'пункты подготовки подряд, по порядку списка шага 0')
            const test_flight5 = v5.refly.findIndex((text) => text.startsWith('Крен, тангаж, рыскание — нужен тестовый полёт'))
            assert.ok(prep5_at < test_flight5, 'пункты подготовки — до тестового полёта')
        }
        const prep5_file = v5.refly.findIndex((text) => text.startsWith('Исправления подготовки — в файле '))
        if (prep5.file_name != null) {
            assert.equal(prep5.file_name, path.basename(log_path).replace(/\.[^.]*$/, '') + '_prep.param', 'файл исправлений подготовки — имя лога + _prep.param')
            assert.ok(v5.refly[prep5_file]?.startsWith('Исправления подготовки — в файле ' + prep5.file_name + ' (шаг 0, «Подготовка к следующему полёту»)'),
                      'общий пункт о файле подготовки: ' + v5.refly.join(' | '))
            if (prep5.lines.length > 0) {
                assert.equal(prep5_file, prep5_at + prep5.lines.length, 'общий пункт о файле — сразу за пунктами подготовки')
            }
        } else {
            assert.equal(prep5_file, -1, 'в файл подготовки записать нечего — общего пункта нет')
        }
        assert.deepEqual(v5.disabled, [false, false], 'изменения есть — «Скачать .param» и «Запомнить проход» доступны')
        assert.equal(await page.textContent('#step5_origin'), base, 'в заметке — адрес страницы, к которому привязана память (аудит E)')

        // «К шагу 4» открывает шаг 4
        await page.click('#steps5 button[data-goto="4"]')
        await wait_overlay(page)
        assert.deepEqual(await visible_steps(page), ['4'], '«К шагу 4» открывает шаг 4')
        await page.click('#wizbar button:nth-child(6)')
        assert.deepEqual(await visible_steps(page), ['5'])
        // «К шагу 2»: форма шага 2 — принятое, но оно устарело (принято на другом интервале) — вердикт шага 2 не «Принято…»
        // со старыми метриками, а «Принято раньше…», как «устарело» сводки
        await page.click('#steps5 button[data-goto="2"]')
        await wait_overlay(page)
        assert.deepEqual(await visible_steps(page), ['2'], '«К шагу 2» открывает шаг 2')
        const stale2 = await page.evaluate(() => ({ form: step2_key(values_from_form()) === step2_key(state.steps[2].accepted), stale: step_accepted_stale(2),
                                                    text: document.getElementById('verdict2').textContent, cls: document.getElementById('verdict2').className }))
        assert.deepEqual([stale2.form, stale2.stale], [true, true], 'в форме шага 2 — принятое, и оно устарело')
        assert.match(stale2.text, /^Принято раньше для другого интервала или расчёта шага 1 — проверьте и примите заново\.$/, stale2.text)
        assert.match(stale2.cls, /verdict--warn/, '«Принято раньше» — предупреждение')
        await page.click('#wizbar button:nth-child(6)')
        assert.deepEqual(await visible_steps(page), ['5'])

        // «Скачать .param»: только изменённые параметры итога (устаревшее не блокирует), затем память прохода
        const [download5] = await Promise.all([page.waitForEvent('download'), page.click('#step5_download')])
        const file5_name = path.basename(log_path).replace(/\.[^.]*$/, '') + '_tune.param'
        assert.equal(download5.suggestedFilename(), file5_name, 'имя файла — имя лога + _tune.param')
        const file5 = await page.evaluate((text) => {
            const ctx = step_summary_context()
            const expected = summary_param_values(summary_rows(ctx).rows, ctx.bits)
            const parsed = parse_param_file(text)
            return { names: Object.keys(parsed).sort(), expected: Object.keys(expected).sort(),
                     same: Object.keys(expected).every((name) => Math.fround(parsed[name]) === Math.fround(expected[name])),
                     count_text: step_plural(Object.keys(parsed).length, step5_param_forms) }
        }, fs.readFileSync(await download5.path(), 'utf8'))
        assert.deepEqual(file5.names, file5.expected, 'в .param — изменённые параметры итога')
        assert.equal(file5.same, true, 'значения .param — значения итога (маски HMNCS — как summary_param_values)')
        assert.equal(file5.names.length, v5.expected.length, 'неизменённое в файл не попало')
        assert.equal(await page.textContent('#step5_note'), 'Файл ' + file5_name + ': ' + file5.count_text + '. Память прохода сохранена.', 'заметка о файле и памяти')
        // Память прохода: проход аппарата по строке контроллера; оценки устаревших шагов (2 и 4) — null, актуального
        // шага 3 — числа
        const mem5 = await page.evaluate((key) => {
            const data = JSON.parse(localStorage.getItem('tunewizard_v1'))
            return { version: data.version, keys: Object.keys(data.passes), pass: data.passes[key] ?? null, bits: step_hmncs_bits() }
        }, fc_key)
        assert.equal(mem5.version, 1)
        assert.deepEqual(mem5.keys, [fc_key], 'в памяти — проход этого аппарата')
        assert.deepEqual([mem5.pass.board, mem5.pass.frame, mem5.pass.file_name], [test_board, 'QUAD/X_REV', path.basename(log_path)])
        assert.equal(mem5.pass.bits, mem5.bits, 'в записи — размер маски HMNCS лога (аудит E)')
        assert.deepEqual(mem5.pass.changed.map((change) => change.name).sort(), file5.names, 'в проходе — изменённые параметры')
        assert.deepEqual([mem5.pass.estimates[2], mem5.pass.estimates[4]], [null, null], 'оценки устаревших шагов 2 и 4 — null')
        const est3 = mem5.pass.estimates[3]
        assert.ok([est3.log.gyro_band_dB, est3.accepted.gyro_band_dB, est3.log.lag30_ms.roll.P, est3.log.lag30_ms.pitch.D, est3.log.dterm_dB.roll].every(Number.isFinite),
                  'оценки актуального шага 3 — числа: ' + JSON.stringify(est3))
        // «Запомнить проход» — та же память без файла
        await page.click('#step5_remember')
        assert.equal(await page.textContent('#step5_note'), 'Память прохода сохранена.')
        // Хранилище браузера недоступно (доступ к localStorage бросает, как при запрете хранилища): «Запомнить проход» —
        // текст ошибки в заметке, сводка не ломается; хранилище — вернуть
        await page.evaluate(() => {
            window.__storage = Object.getOwnPropertyDescriptor(window, 'localStorage') ?? null
            Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('Доступ запрещён', 'SecurityError') } })
        })
        await page.click('#step5_remember')
        const blocked5 = await page.evaluate(() => ({ note: document.getElementById('step5_note').textContent, verdict: document.getElementById('verdict5').className }))
        await page.evaluate(() => {
            if (window.__storage != null) {
                Object.defineProperty(window, 'localStorage', window.__storage)
            } else {
                delete window.localStorage
            }
        })
        assert.deepEqual(blocked5, { note: 'Браузер не даёт сохранить память прохода (приватный режим, запрет или переполнение хранилища).', verdict: 'verdict verdict--warn' },
                         'хранилище недоступно — текст в заметке, вердикт сводки прежний')
        assert.equal(await page.evaluate(() => localStorage.getItem('tunewizard_v1') != null), true, 'хранилище вернули, память на месте')
        // Метаданные параметров не загрузились — общий пункт о перезагрузке; ещё грузятся — пункта нет (появится после
        // загрузки); состояние загрузки — вернуть
        const meta5 = await page.evaluate(() => {
            const saved = { ...step_metadata_state }
            const reboot = () => [...document.querySelectorAll('#refly5 li')].map((li) => li.textContent).filter((text) => text.includes('перезагрузите полётный контроллер'))
            try {
                Object.assign(step_metadata_state, { data: null, failed: true })
                step5_render()
                const failed = reboot()
                Object.assign(step_metadata_state, { data: null, failed: false })
                step5_render()
                return { failed: failed, loading: reboot() }
            } finally {
                Object.assign(step_metadata_state, saved)
                step5_render()
            }
        })
        assert.equal(meta5.failed.length, 1, 'метаданные не загрузились — один пункт о перезагрузке: ' + meta5.failed.join(' | '))
        assert.match(meta5.failed[0], /^Описания параметров не загрузились, .*: после записи перезагрузите полётный контроллер — так надёжнее\.$/, meta5.failed[0])
        assert.deepEqual(meta5.loading, [], 'метаданные грузятся — пункта о перезагрузке нет')
        assert.deepEqual((await step5_summary(page)).refly, v5.refly, 'состояние метаданных вернули — пункты прежние')

        // «Печать» — диалог печати браузера (здесь — заглушка window.print). Перед печатью (событие beforeprint: браузер шлёт
        // его и при Ctrl+P, эмуляция печати Playwright — нет) — шапка с логом, аппаратом и временем печати и раскрытый
        // список «без изменений»; после печати (afterprint) список — как был
        await page.evaluate(() => {
            window.__print_calls = 0
            window.print = () => { window.__print_calls++ }
        })
        await page.click('#step5_print')
        assert.equal(await page.evaluate(() => window.__print_calls), 1, '«Печать» вызывает window.print')
        const unchanged_open = () => page.evaluate(() => document.getElementById('unchanged5').open)
        assert.equal(await unchanged_open(), false, 'до печати список «без изменений» свёрнут')
        await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')))
        const print_head = await page.textContent('#step5_print_head')
        assert.ok(print_head.startsWith('Мастер настройки · ' + path.basename(log_path) + ' · ' + test_board + ', QUAD/X_REV · '), print_head)
        assert.match(print_head, / · \d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}$/, 'время печати: ' + print_head)
        assert.equal(await unchanged_open(), true, 'при печати список «без изменений» раскрыт')
        // Правила печати на шаге 5: сводка без вступления, навигации, кнопок, заметки о действии, пояснений для экрана и
        // столбца «Действие»; другие секции (с графиками) скрыты атрибутом hidden; шапка печати и список «без изменений»
        // видны, фон белый
        await page.emulateMedia({ media: 'print' })
        const print5 = await page.evaluate(() => {
            const seen = (el) => el.checkVisibility()
            return {
                wizbar: seen(document.querySelector('.wizbar')),
                lede: seen(document.querySelector('.hero .lede')),
                step0: seen(document.querySelector('section[data-step="0"]')),
                plots: [...document.querySelectorAll('.plot')].filter(seen).length,
                buttons: [...document.querySelectorAll('section[data-step="5"] button')].filter(seen).length,
                note: seen(document.getElementById('step5_note')),
                screen_only: [...document.querySelectorAll('section[data-step="5"] .screen-only')].filter(seen).length,
                action: seen(document.querySelector('#steps5 thead th:nth-child(4)')),
                head: seen(document.getElementById('step5_print_head')),
                unchanged: seen(document.querySelector('#unchanged5 tbody tr')),
                bg: getComputedStyle(document.body).backgroundColor,
            }
        })
        assert.deepEqual(print5, { wizbar: false, lede: false, step0: false, plots: 0, buttons: 0, note: false, screen_only: 0, action: false, head: true, unchanged: true,
                                   bg: 'rgb(255, 255, 255)' }, 'печать шага 5 — только сводка на белом фоне')
        await page.screenshot({ path: path.join(shots, 'step5-print.png'), fullPage: true })
        await page.evaluate(() => window.dispatchEvent(new Event('afterprint')))
        assert.equal(await unchanged_open(), false, 'после печати список «без изменений» снова свёрнут')
        // Печать других шагов не пустая: на шаге 0 видны его секция и график полёта, сводки нет
        await page.evaluate(() => set_step(0))
        const print0 = await page.evaluate(() => ({
            step0: document.querySelector('section[data-step="0"]').checkVisibility(),
            flight: document.getElementById('FlightData').checkVisibility(),
            step5: document.querySelector('section[data-step="5"]').checkVisibility(),
        }))
        assert.deepEqual(print0, { step0: true, flight: true, step5: false }, 'печать шага 0 — его секция и график полёта')
        await page.emulateMedia({ media: 'screen' })
        await page.click('#wizbar button:nth-child(6)')
        assert.deepEqual(await visible_steps(page), ['5'])
        assert.equal(await page.isVisible('#step5_print_head'), false, 'на экране шапки печати нет')
        // Без горизонтальной прокрутки страницы — и на узком окне (таблицы прокручиваются внутри своих рамок)
        const [fit_w, fit_c] = await page_fits(page)
        assert.ok(fit_w <= fit_c, 'шаг 5: ширина страницы ' + fit_w + ' px — окно ' + fit_c + ' px')
        await page.screenshot({ path: path.join(shots, 'step5.png'), fullPage: true })
        await page.setViewportSize({ width: 390, height: 1000 })
        const [narrow_w, narrow_c] = await page_fits(page)
        assert.ok(narrow_w <= narrow_c, 'шаг 5 на узком окне: ширина страницы ' + narrow_w + ' px — окно ' + narrow_c + ' px')
        await page.setViewportSize({ width: 1400, height: 1000 })
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
        // шаг 1 считается заново начисто. Файл выбирается с шага 2 (поле скрыто — Playwright подставляет файл и так):
        // новый лог начинается с шага 0, секция шага 2 не остаётся видимой пустой (аудит A)
        await page.click('#wizbar button:nth-child(3)')
        await wait_overlay(page)
        assert.deepEqual(await visible_steps(page), ['2'])
        await page.evaluate(() => { window.__old_log = state.log; window.__fft = null })
        await page.setInputFiles('#fileItem', log_path)
        await page.waitForFunction(() => (state.log != null) && (state.log !== window.__old_log) &&
            (document.getElementById('loading').style.visibility === 'hidden'), null, { timeout: 180000 })
        assert.deepEqual(await visible_steps(page), ['0'], 'лог выбран с шага 2 — после загрузки видна секция шага 0')
        assert.equal(await page.evaluate(() => state.gyro === null), true, 'новый лог — гироскоп ещё не загружен')

        // Шаг 0, блок «Прошлый проход»: в памяти — проход этого аппарата, сохранённый на шаге 5 из этого же лога. Значения
        // лога равны «было» прохода и имя файла то же — «лог прошлого прохода»; строки — изменённые параметры прохода по
        // порядку (столбцы — как в изменениях шага 5: параметр, предлагалось, в логе сейчас, шаг, итог), итог — «другое
        // значение» (предложенное не стоит) или «нет в логе» (параметра не было); строка контроллера в логе есть — списка
        // выбора нет
        const memory0 = () => page.evaluate(() => {
            const seen = (id) => document.getElementById(id).checkVisibility()
            const select = document.getElementById('memory0_pick')
            return {
                visible: seen('memory0'),
                head: seen('memory0_head') ? document.getElementById('memory0_head').textContent : null,
                verdict: seen('memory0_verdict') ? document.getElementById('memory0_verdict').textContent : null,
                verdict_class: document.getElementById('memory0_verdict').className,
                rows: seen('memory0_table') ? [...document.querySelectorAll('#memory0_table tbody tr')].map((tr) => [...tr.cells].map((td) => td.textContent)) : null,
                pick: seen('memory0_pick_field') ? { value: select.value, options: [...select.options].map((o) => [o.value, o.textContent]) } : null,
                forget: seen('memory0_forget'),
                forget_text: document.getElementById('memory0_forget').textContent,
                row: document.querySelector('#memory0 > .row').checkVisibility(),
                key: memory_state.key,
                pass: memory_state.pass?.key ?? null,
                applied: (memory_state.applied != null) ? [memory_state.applied.applied, memory_state.applied.total] : null,
                focus: document.activeElement?.id ?? null,
                // Ключи проходов в хранилище; JSON не разбирается (испорченная память не переписывается) — null
                stored: (() => {
                    try {
                        return Object.keys(JSON.parse(localStorage.getItem('tunewizard_v1') ?? '{"passes":{}}').passes)
                    } catch {
                        return null
                    }
                })(),
            }
        })
        const pass0 = await page.evaluate((key) => ({ record: JSON.parse(localStorage.getItem('tunewizard_v1')).passes[key], fw: state.info.fw_string }), fc_key)
        pass0.changed = pass0.record.changed
        const m0 = await memory0()
        assert.equal(m0.visible, true, 'проход аппарата есть — блок «Прошлый проход» виден')
        assert.match(m0.head, /^Сохранён \d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}, лог /, m0.head)
        assert.ok(m0.head.endsWith(', лог ' + path.basename(log_path) + ', прошивка ' + pass0.fw), m0.head)
        assert.equal(m0.verdict, 'Это лог прошлого прохода — значения ещё не применялись.')
        assert.match(m0.verdict_class, /verdict--warn/)
        assert.equal(m0.rows.length, pass0.changed.length, 'строк — столько же, сколько изменённых в проходе')
        assert.deepEqual(m0.rows.map((cells) => [cells[0], cells[3], cells[4]]),
                         pass0.changed.map((c) => [c.name, String(c.step), (c.log == null) ? 'нет в логе' : 'другое значение']), 'строки — изменённые параметры прохода')
        assert.deepEqual([m0.pick, m0.forget, m0.forget_text, m0.key, m0.pass, m0.applied], [null, true, 'Забыть проход этого аппарата', fc_key, fc_key, [0, pass0.changed.length]],
                         'списка нет, «Забыть» есть, проход — в memory_state')
        await page.screenshot({ path: path.join(shots, 'step0-memory.png'), fullPage: true })

        // Запись аппарата заменена после загрузки лога (как «Скачать .param» на шаге 5 — та же запись с новой датой):
        // «Забыть» новую запись не трогает — предупреждение, кнопки больше нет, для сравнения остаётся показанный проход
        const replaced_at = await page.evaluate((key) => {
            const passes = passmem_read(localStorage).passes
            const record = { ...passes[key], saved_at: passes[key].saved_at + 60000 }
            passmem_write(localStorage, passmem_put(passes, record))
            return record.saved_at
        }, fc_key)
        await page.click('#memory0_forget')
        const kept0 = await memory0()
        assert.deepEqual([kept0.visible, kept0.verdict, kept0.verdict_class, kept0.forget, kept0.pass, kept0.stored],
                         [true, 'Проход уже заменён более новым сохранением — он остаётся.', 'verdict verdict--warn', false, fc_key, [fc_key]], 'заменённую запись «Забыть» не удаляет')
        assert.deepEqual(await page.evaluate((key) => [passmem_read(localStorage).passes[key].saved_at, memory_state.pass.saved_at], fc_key), [replaced_at, replaced_at - 60000],
                         'в памяти — новая запись, в memory_state — показанный проход')

        // Блок заново — показан новый проход; «Забыть» — блок скрыт, прохода нет ни в памяти браузера, ни в memory_state,
        // фокус — на выборе лога
        await page.evaluate(() => memory_render_step0())
        await page.click('#memory0_forget')
        const forgot0 = await memory0()
        assert.deepEqual([forgot0.visible, forgot0.stored, forgot0.pass, forgot0.applied, forgot0.focus], [false, [], null, null, 'fileItem'], '«Забыть» — проход удалён, блок скрыт')

        // Прохода этого аппарата нет, а проход другого аппарата есть (например, после замены полётного контроллера — другая
        // строка контроллера): список для выбора вручную с подписью об этом, ничего не выбрано; выбор — таблица чужого прохода
        // и «Забыть выбранный проход»; после него список пуст — блок скрыт. Имена — из констант тестового лога (есть в логе)
        const synth_names = ['INS_GYRO_FILTER', 'ATC_RAT_RLL_FLTD', 'ATC_RAT_PIT_FLTD']
        const other_key = 'fc:Другой контроллер 0001'
        await page.evaluate(([names, key]) => {
            const changed = names.map((name) => ({ name: name, log: state.params.get(name) + 5, value: state.params.get(name), step: 3 }))
            passmem_write(localStorage, passmem_put({}, { key: key, board: key.slice(3), frame: 'QUAD/X', fw: 'ArduCopter V4.6.0', file_name: 'другой.bin',
                                                          saved_at: Date.now() - 3 * 86400000, changed: changed, estimates: null }))
            memory_render_step0()
        }, [synth_names, other_key])
        const missing0 = await memory0()
        assert.deepEqual([missing0.visible, missing0.head, missing0.pick.value, missing0.pick.options.map((option) => option[0]), missing0.rows, missing0.verdict, missing0.forget,
                          missing0.pass, missing0.key],
                         [true, 'Проход этого аппарата не найден — выбрать другой (например, после замены полётного контроллера).', '', ['', other_key], null, null, false,
                          null, fc_key], 'прохода аппарата нет, чужой есть — список без выбора')
        await page.selectOption('#memory0_pick', other_key)
        const picked_other = await memory0()
        assert.deepEqual([picked_other.pass, picked_other.verdict, picked_other.rows.map((cells) => cells[0]), picked_other.forget_text, picked_other.key],
                         [other_key, 'Применено 3 из 3.', synth_names, 'Забыть выбранный проход', fc_key], 'выбран чужой проход — его таблица, ключ лога прежний')
        await page.click('#memory0_forget')
        const forgot_other = await memory0()
        assert.deepEqual([forgot_other.visible, forgot_other.stored, forgot_other.pass], [false, [], null], 'чужой проход забыт — список пуст, блок скрыт')

        // Хранилища нет (memory_storage → null): блок скрыт, ключ аппарата лога всё равно есть
        const unavailable0 = await page.evaluate(() => {
            const saved = window.memory_storage
            window.memory_storage = () => null
            try {
                memory_render_step0()
                return { visible: document.getElementById('memory0').checkVisibility(), key: memory_state.key }
            } finally {
                window.memory_storage = saved
            }
        })
        assert.deepEqual(unavailable0, { visible: false, key: fc_key }, 'хранилища нет — блок скрыт, ключ есть')
        // Весь JSON памяти битый, прохода нет: блок — только с предупреждением (подписи, таблицы и пустого ряда нет), что
        // память испорчена и её заменит сохранение на шаге 5; хранилище не трогается (аудит E: загрузка лога — не повод
        // терять память). Хранилище с бросающей записью — тот же текст, записи не было
        const corrupt_text = 'Память прохода испорчена — не используется; её заменит «Запомнить проход» или «Скачать .param» на шаге 5.'
        await page.evaluate(() => {
            localStorage.setItem('tunewizard_v1', '{битый')
            memory_render_step0()
        })
        const broken0 = await memory0()
        assert.deepEqual([broken0.visible, broken0.verdict, broken0.verdict_class, broken0.head, broken0.rows, broken0.row, broken0.stored],
                         [true, corrupt_text, 'verdict verdict--warn', null, null, false, null], 'испорченная память без прохода — только предупреждение')
        assert.equal(await page.evaluate(() => localStorage.getItem('tunewizard_v1')), '{битый', 'испорченная память при загрузке лога не переписана')
        const kept_text0 = await page.evaluate(() => {
            const saved = window.memory_storage
            let writes = 0
            window.memory_storage = () => ({ getItem: () => '{битый', setItem() { writes++; throw new DOMException('Нет места', 'QuotaExceededError') }, removeItem() {} })
            try {
                memory_render_step0()
                return { text: document.getElementById('memory0_verdict').textContent, writes: writes }
            } finally {
                window.memory_storage = saved
            }
        })
        assert.deepEqual(kept_text0, { text: corrupt_text, writes: 0 }, 'испорченная память: тот же текст, записи в хранилище не было')
        // Память другой версии формата при загрузке лога: предупреждение «другой версии», хранилище без изменений; её
        // заменяет «Запомнить проход» на шаге 5 (ниже, после повторной загрузки — проверка version_mem)
        const version_text = 'Память прохода другой версии формата — не используется; её заменит «Запомнить проход» или «Скачать .param» на шаге 5.'
        const version_json = JSON.stringify({ version: 7, passes: { [fc_key]: { key: fc_key, future: true } } })
        await page.evaluate((json) => {
            localStorage.setItem('tunewizard_v1', json)
            memory_render_step0()
        }, version_json)
        const version0 = await memory0()
        assert.deepEqual([version0.visible, version0.verdict, version0.verdict_class, version0.rows, version0.pass, version0.stored], [true, version_text, 'verdict verdict--warn', null, null, [fc_key]],
                         'память другой версии — предупреждение, проход не используется')
        assert.equal(await page.evaluate(() => localStorage.getItem('tunewizard_v1')), version_json, 'память другой версии при загрузке лога не переписана')
        // Проход без изменённых параметров — как прохода нет
        await page.evaluate(() => {
            passmem_write(localStorage, passmem_put({}, { key: memory_state.key, board: state.info.board, frame: null, fw: null, file_name: 'пустой.bin', saved_at: Date.now(),
                                                          changed: [], estimates: null }))
            memory_render_step0()
        })
        const empty0 = await memory0()
        assert.deepEqual([empty0.visible, empty0.pass, empty0.stored], [false, null, [fc_key]], 'проход без изменений — блок скрыт')

        // Проход с другого лога, предложенные значения которого стоят в этом: «Применено N из N»; одно значение чужое —
        // «Применено N−1 из N», итог строки — «другое значение». Имена — synth_names (есть в логе)
        const put_synth = (other) => page.evaluate(([names, other]) => {
            const changed = names.map((name, i) => {
                const now = state.params.get(name)
                return { name: name, log: now + 5, value: (i === other) ? now + 1 : now, step: 3 }
            })
            const record = { key: memory_state.key, board: state.info.board, frame: state.info.frame, fw: state.info.fw_string, file_name: 'прошлый.bin',
                             saved_at: Date.now() - 86400000, changed: changed, estimates: { 2: null, 3: null, 4: null } }
            passmem_write(localStorage, passmem_put(passmem_read(localStorage).passes, record))
            memory_render_step0()
            return names.every((name) => state.params.has(name))
        }, [synth_names, other])
        assert.equal(await put_synth(-1), true, 'параметры синтетического прохода есть в логе')
        const all0 = await memory0()
        assert.deepEqual([all0.visible, all0.verdict, all0.verdict_class, all0.rows.map((cells) => cells[4]), all0.applied],
                         [true, 'Применено 3 из 3.', 'verdict verdict--ok', ['применено', 'применено', 'применено'], [3, 3]], 'все предложенные стоят в логе')
        assert.match(all0.head, /, лог прошлый\.bin, прошивка /, all0.head)
        await put_synth(1)
        const one0 = await memory0()
        assert.deepEqual([one0.verdict, one0.verdict_class, one0.rows.map((cells) => cells[4]), one0.applied],
                         ['Применено 2 из 3.', 'verdict verdict--warn', ['применено', 'другое значение', 'применено'], [2, 3]], 'одно значение чужое')
        // Битая запись рядом (не проходит проверку формы): проход аппарата уцелел — показан, к вердикту — строка
        // предупреждения; битая запись из хранилища удалена
        await page.evaluate(() => {
            const data = JSON.parse(localStorage.getItem('tunewizard_v1'))
            data.passes['fc:битая'] = { key: 'другой' }
            localStorage.setItem('tunewizard_v1', JSON.stringify(data))
            memory_render_step0()
        })
        const bad0 = await memory0()
        assert.deepEqual([bad0.verdict, bad0.verdict_class, bad0.stored], ['Применено 2 из 3. Часть памяти прохода не прочитана — удалена.', 'verdict verdict--warn', [fc_key]],
                         'битая запись — предупреждение и удалена')

        // Лог без строки контроллера: список сохранённых проходов по убыванию даты. Проход с тем же запасным ключом (та же
        // плата, рама и имя файла) выбран сразу — его таблица, кнопка «Забыть выбранный проход»
        const fallback_key = 'log:1503·QUAD/X_REV·' + path.basename(log_path)
        await page.evaluate((names) => {
            window.__board = state.info.board
            state.info.board = null
            const changed = names.map((name) => ({ name: name, log: state.params.get(name) + 5, value: state.params.get(name), step: 3 }))
            const record = { key: passmem_aircraft_key(state.info, state.file_name), board: null, frame: state.info.frame, fw: state.info.fw_string,
                             file_name: state.file_name, saved_at: Date.now() - 2 * 86400000, changed: changed, estimates: null }
            passmem_write(localStorage, passmem_put(passmem_read(localStorage).passes, record))
            memory_render_step0()
        }, synth_names)
        const list0 = await memory0()
        assert.equal(list0.key, fallback_key, 'запасной ключ аппарата')
        assert.deepEqual([list0.visible, list0.pick.value, list0.pick.options.map((option) => option[0]), list0.pass, list0.verdict, list0.rows.length, list0.forget, list0.forget_text],
                         [true, fallback_key, ['', fc_key, fallback_key], fallback_key, 'Применено 3 из 3.', 3, true, 'Забыть выбранный проход'], 'проход того же файла выбран сразу')
        assert.match(list0.pick.options[1][1], new RegExp('^\\d{2}\\.\\d{2}\\.\\d{4}, \\d{2}:\\d{2} · ' + test_board + ', QUAD/X_REV · прошлый\\.bin$'), list0.pick.options[1][1])
        assert.ok(list0.pick.options[2][1].endsWith(' · QUAD/X_REV · ' + path.basename(log_path)), 'без платы — рама: ' + list0.pick.options[2][1])
        await page.screenshot({ path: path.join(shots, 'step0-memory-pick.png'), fullPage: true })
        // Узкое окно: блок со списком не шире окна и не прокручивается сам (таблица — внутри своей рамки). Страницу целиком
        // не меряем: график полёта Plotly подстраивает под окно с задержкой
        await page.setViewportSize({ width: 390, height: 1000 })
        const pick_fit = await page.evaluate(() => {
            const box = document.getElementById('memory0')
            return { right: Math.round(box.getBoundingClientRect().right), window: document.documentElement.clientWidth, scroll: box.scrollWidth, client: box.clientWidth }
        })
        assert.ok((pick_fit.right <= pick_fit.window) && (pick_fit.scroll <= pick_fit.client), 'блок «Прошлый проход» на узком окне: ' + JSON.stringify(pick_fit))
        await page.setViewportSize({ width: 1400, height: 1000 })
        // «Забыть выбранный проход» — он убран из памяти и из списка, список показан заново: ничего не выбрано, таблицы и
        // кнопки нет, фокус — на списке. Выбор оставшегося — его таблица; «Забыть» последнего — блок скрыт
        await page.click('#memory0_forget')
        const rest0 = await memory0()
        assert.deepEqual([rest0.visible, rest0.pick.value, rest0.pick.options.map((option) => option[0]), rest0.rows, rest0.verdict, rest0.forget, rest0.pass, rest0.stored, rest0.focus],
                         [true, '', ['', fc_key], null, null, false, null, [fc_key], 'memory0_pick'], 'выбранный проход забыт, список — без него')
        await page.selectOption('#memory0_pick', fc_key)
        const picked0 = await memory0()
        assert.deepEqual([picked0.pass, picked0.verdict, picked0.rows.map((cells) => cells[0]), picked0.forget], [fc_key, 'Применено 2 из 3.', synth_names, true],
                         'выбран проход — его таблица')
        await page.click('#memory0_forget')
        const last0 = await memory0()
        assert.deepEqual([last0.visible, last0.stored, last0.pass, last0.focus], [false, [], null, 'fileItem'], 'забыт последний проход списка — блок скрыт')
        // Строку контроллера вернуть и построить блок заново: память пуста — блок скрыт; дальше тест память не ждёт, а
        // повторная загрузка в конце — без блока
        await page.evaluate(() => {
            state.info.board = window.__board
            memory_render_step0()
        })
        const end0 = await memory0()
        assert.deepEqual([end0.visible, end0.key, end0.stored], [false, fc_key, []], 'строка контроллера возвращена, память пуста')
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
        // Сводка после повторной загрузки: ничего не принято — «менять нечего», кнопки файла и памяти выключены, шаги —
        // «не принят». Шаг 4 посчитан (не принят), все оси без надёжного измерения — в вердикте хвост о тестовом полёте,
        // в «что перелететь» — его пункт, но не «слетайте тем же профилем»: менять нечего
        await page.click('#wizbar button:nth-child(6)')
        const none5 = await step5_summary(page)
        assert.match(none5.verdict_class, /verdict--warn/, 'ничего не принято — предупреждение')
        assert.equal(none5.verdict, 'Менять нечего: ни один из шагов 2–4 не принят. Оси шага 4 без надёжного измерения: крен, тангаж, рыскание — нужен тестовый полёт (ниже).')
        assert.deepEqual(none5.tiles.map((tile) => tile.value), ['StellarH7V2', path.basename(log_path), '0', 'нет'], 'плитки: изменено 0, принятых шагов нет')
        assert.deepEqual(none5.steps.map((row) => [row.cells[1], row.cells[2], row.button]), [2, 3, 4].map(() => ['не принят', 'Параметры шага остаются как в логе.', null]),
                         'все шаги — «не принят»')
        assert.deepEqual(none5.changes, [['Изменённых параметров нет.']], 'изменений нет')
        assert.deepEqual(none5.disabled, [true, true], 'без изменений «Скачать .param» и «Запомнить проход» выключены')
        assert.ok(none5.refly.some((text) => text.startsWith('Крен, тангаж, рыскание — нужен тестовый полёт')), 'пункт тестового полёта: ' + none5.refly.join(' | '))
        assert.ok(!none5.refly.some((text) => text.startsWith('Слетайте тем же профилем')), 'без изменений «слетайте тем же профилем» нет')
        // Шаг 1 после этого — тот же, что при первом прогоне
        await page.click('#wizbar button:nth-child(2)')
        await wait_overlay(page)
        const s4 = await step1_summary(page)
        assert.ok(s4.with_data >= 3 && s4.peaks >= 1, 'после повторной загрузки спектр и пики снова есть')
        assert.deepEqual(s4.peak_rows, s1.peak_rows, 'та же таблица пиков')
        assert.equal(s4.verdict, s1.verdict, 'тот же вердикт')
        await page.click('#wizbar button:nth-child(1)')

        // Строки сравнения с прошлым проходом на шагах 2–4 (раздел 4.5 дизайна). Синтетический проход этого аппарата —
        // passmem_record по строкам итога changes ([имя, шаг, применено ли]: «было» — значение лога + 5, предложено —
        // значение лога или, если не применено, + 1) и оценкам принятых шагов steps; положен в память, блок шага 0 — заново
        // (memory_render_step0: проход — в memory_state), затем шаг открывается, и строка рисуется с его вердиктом. Шаги 2–4
        // после повторной загрузки посчитаны выше и не приняты. Строки шагов — по атрибуту hidden (секции других шагов
        // скрыты)
        const memory_lines = () => page.evaluate(() => Object.fromEntries([2, 3, 4].map((n) => {
            const box = document.getElementById('memory' + n)
            return [n, box.hidden ? null : box.textContent]
        })))
        const put_pass = (changes, steps) => page.evaluate(([changes, steps]) => {
            const rows = changes.map(([name, step, applied]) => {
                const now = state.params.get(name)
                return { name: name, log: now + 5, value: applied ? now : now + 1, step: step, changed: true }
            })
            const record = passmem_record({ key: memory_state.key, info: state.info, file_name: 'прошлый.bin', rows: rows, steps: steps,
                                            saved_at: Date.now() - 86400000 })
            passmem_write(localStorage, passmem_put(passmem_read(localStorage).passes, record))
            memory_render_step0()
            return { has: changes.every(([name]) => state.params.has(name)), head: 'Прошлый проход (' + memory_date_text(record.saved_at) + ')',
                     pass: memory_state.pass?.key ?? null }
        }, [changes, steps])
        // Оценки принятых шагов прохода — от оценок «Как в логе» этого лога со сдвигом (было и прогноз отличаются от
        // «в этом логе»): шаг 2 — evaluate_candidate, шаг 3 — step3_metrics_summary (шум гироскопа, шум D и задержки);
        // ось крена шага 4 — надёжна в проходе
        const pass_steps = await page.evaluate(() => {
            const e2 = step2.evaluations.log
            const shift2 = (d) => ({ band_dB: e2.band_dB + d, lag_ms: { 30: e2.lag_ms[30] + d / 10 } })
            const e3 = step3_metrics_summary(step3.evaluations.log)
            const map = (obj, fn) => Object.fromEntries(Object.entries(obj).map(([key, value]) => [key, fn(value)]))
            const shift3 = (d) => ({
                ...e3,
                gyro: { ...e3.gyro, band_dB: e3.gyro.band_dB + d },
                dterm: map(e3.dterm, (axis) => (axis != null) ? { dB: axis.dB + d } : null),
                lag_ms: map(e3.lag_ms, (paths) => map(paths, (lag) => ({ ...lag, 30: lag[30] + d / 10 }))),
            })
            const roll = { reliable: true, measured: { overshoot_pct: 12.5, rise_s: 0.055 }, log: { pm_deg: 48, crossover_hz: 11.2 },
                           prediction: { overshoot_pct: 8.5, rise_s: 0.05, pm_deg: 55, unstable: false } }
            return { 2: { metrics: { log: shift2(1.5), current: shift2(-0.5) } }, 3: { metrics: { log: shift3(1.25), current: shift3(-0.75) } },
                     4: { axes: { roll: { metrics: roll } } },
                     now: { band: e2.band_dB.toFixed(2), lag: e2.lag_ms[30].toFixed(2), gyro: e3.gyro.band_dB.toFixed(2), dterm_roll: e3.dterm.roll.dB.toFixed(2),
                            dterm_roll_was: (e3.dterm.roll.dB + 1.25).toFixed(2) } }
        })

        // Лог прошлого прохода: в памяти снова проход, сохранённый на шаге 5 из этого же лога (значения лога равны «было»,
        // имя файла то же — значения ещё не применялись). Строк сравнения на шагах 2–4 нет, хотя по условиям строки шаг 3
        // написал бы «применены не все — сравнивать нечего» (шум: шаг 0 уже говорит, что это лог прошлого прохода)
        const own = await page.evaluate((record) => {
            passmem_write(localStorage, passmem_put(passmem_read(localStorage).passes, record))
            memory_render_step0()
            return { pass: memory_state.pass?.key ?? null, pass_log: memory_is_pass_log(memory_state.pass, memory_state.applied),
                     verdict: document.getElementById('memory0_verdict').textContent,
                     compare3: passmem_compare(memory_state.pass, memory_state.applied, 3, null)?.status ?? null }
        }, pass0.record)
        assert.deepEqual(own, { pass: fc_key, pass_log: true, verdict: 'Это лог прошлого прохода — значения ещё не применялись.', compare3: 'partial' },
                         'проход этого лога из шага 5: по условиям строки шаг 3 — «применены не все»')
        for (const n of [2, 3, 4]) {
            await page.click('#wizbar button:nth-child(' + (n + 1) + ')')
            await wait_overlay(page)
            assert.equal((await memory_lines())[n], null, 'лог прошлого прохода — строки сравнения шага ' + n + ' нет')
        }
        await page.click('#wizbar button:nth-child(1)')

        // Шаг 2 прошлого прохода применён (значение лога = предложенному): «было → прогноз → в этом логе» с числами оценки
        // «Как в логе» этого лога и оговоркой про шум; шаг 3 в проходе не принят — строки нет
        const pass_a = await put_pass([['INS_HNTCH_FREQ', 2, true]], { 2: pass_steps[2] })
        assert.deepEqual([pass_a.has, pass_a.pass], [true, fc_key], 'параметры прохода есть в логе, проход — в memory_state')
        await page.click('#wizbar button:nth-child(3)')
        await wait_overlay(page)
        const mem_a = await memory_lines()
        assert.ok(mem_a[2].startsWith(pass_a.head + ', было → прогноз → в этом логе: полоса '), mem_a[2])
        assert.ok(mem_a[2].includes(' → ' + pass_steps.now.band + ' дБ; задержка на 30 Гц '), 'полоса этого лога — оценка «Как в логе»: ' + mem_a[2])
        assert.ok(mem_a[2].endsWith(' → ' + pass_steps.now.lag + ' мс. Шум зависит от полёта: газ, манёвры.'), mem_a[2])
        assert.match(mem_a[2], /^Прошлый проход \(\d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}\), было → прогноз → в этом логе: полоса -?[\d.]+ → -?[\d.]+ → -?[\d.]+ дБ; /, mem_a[2])
        await page.screenshot({ path: path.join(shots, 'step2-memory.png'), fullPage: true })
        await page.click('#wizbar button:nth-child(4)')
        await wait_overlay(page)
        assert.equal((await memory_lines())[3], null, 'шаг 3 в проходе не принят — строки нет')
        await page.click('#wizbar button:nth-child(1)')

        // Шаг 3 прошлого прохода применён не весь (FLTD тангажа не стоит), шаг 4 менял крен, и он применён: на шаге 3 —
        // «применены не все»; ось крена надёжна в проходе, но на тестовом логе измерение ненадёжно — «сравнивать нечем»;
        // тангаж шаг 4 не менял, оценки оси нет — строки нет; на шаге 2 строка прежнего прохода убрана (шаг 2 не принят)
        const pass_b = await put_pass([['ATC_RAT_PIT_FLTD', 3, false], ['ATC_RAT_RLL_P', 4, true]], { 3: pass_steps[3], 4: pass_steps[4] })
        assert.equal(pass_b.has, true)
        await page.click('#wizbar button:nth-child(3)')
        await wait_overlay(page)
        assert.equal((await memory_lines())[2], null, 'шаг 2 в проходе не принят — строки шага 2 больше нет')
        await page.click('#wizbar button:nth-child(4)')
        await wait_overlay(page)
        assert.equal((await memory_lines())[3], pass_b.head + ': параметры шагов 2–3 применены не все — сравнивать нечего.')
        await page.click('#wizbar button:nth-child(5)')
        await wait_overlay(page)
        assert.equal(await page.evaluate(() => step4.axis), 'roll')
        assert.equal((await memory_lines())[4], pass_b.head + ': измерение ненадёжно — сравнивать нечем.')
        assert.equal(await page.evaluate(() => document.getElementById('memory4').previousElementSibling.id), 'axis_verdict4', 'строка оси — под вердиктом оси')
        await page.click('#step4_tab_pitch')
        assert.equal((await memory_lines())[4], null, 'тангаж: оценки оси в проходе нет — строки нет')
        await page.click('#step4_tab_roll')
        await page.click('#wizbar button:nth-child(1)')

        // Шаги 2–3 прошлого прохода применены: на шаге 3 — «в этом логе» по оценке «Как в логе», пока notch-база шага 3 —
        // notch лога. Смена одного INS_GYRO_FILTER базой не считается (оценка берёт его у варианта); notch — считается;
        // форма шага 2 со значениями лога (float32, маски) — notch лога. «Принять» на шаге 2 варианта с другим notch: шаг 3
        // считает «Как в логе» с принятым notch — числа этого лога нет
        const pass_c = await put_pass([['INS_HNTCH_FREQ', 2, true], ['ATC_RAT_RLL_FLTD', 3, true]], { 2: pass_steps[2], 3: pass_steps[3] })
        assert.equal(pass_c.has, true)
        await page.click('#wizbar button:nth-child(4)')
        await wait_overlay(page)
        const mem_c = (await memory_lines())[3]
        assert.ok(mem_c.startsWith(pass_c.head + ', было → прогноз → в этом логе: шум гироскопа '), mem_c)
        assert.ok(mem_c.includes(' → ' + pass_steps.now.gyro + ' дБ; шум D крена '), 'шум гироскопа этого лога — оценка «Как в логе»: ' + mem_c)
        assert.ok(mem_c.includes('; шум D крена ' + pass_steps.now.dterm_roll_was + ' → ') && mem_c.includes(' → ' + pass_steps.now.dterm_roll + ' дБ, тангажа '),
                  'шум D крена: было прохода и «в этом логе» — оценка «Как в логе»: ' + mem_c)
        assert.match(mem_c, /; задержка на 30 Гц: путь P крена -?[\d.]+ → -?[\d.]+ → -?[\d.]+ мс, тангажа .* мс, путь D крена .* мс, тангажа .* мс\. Шум зависит от полёта: газ, манёвры\.$/, mem_c)
        const notch_is_log = await page.evaluate(() => ({
            form: step2_key(values_from_form()) === step2_key(values_from_log()),
            form_is_log: memory_notch_is_log(values_from_form()),
            gyro_only: memory_notch_is_log({ ...values_from_log(), INS_GYRO_FILTER: values_from_log().INS_GYRO_FILTER + 10 }),
            freq: memory_notch_is_log({ ...values_from_log(), INS_HNTCH_FREQ: values_from_log().INS_HNTCH_FREQ + 10 }),
            other: step2.candidates.find((c) => !memory_notch_is_log(c.values))?.id ?? null,
        }))
        assert.deepEqual([notch_is_log.form, notch_is_log.form_is_log], [true, true], 'форма шага 2 со значениями лога — notch лога (float32 и маски без ложных отличий)')
        assert.deepEqual([notch_is_log.gyro_only, notch_is_log.freq], [true, false], 'notch-база: один INS_GYRO_FILTER — notch лога, другая частота — нет')
        assert.ok(notch_is_log.other != null, 'на тестовом логе есть вариант шага 2 с другим notch')
        await page.click('#wizbar button:nth-child(3)')
        await wait_overlay(page)
        await page.check('#cand2_' + notch_is_log.other)
        await page.click('#cand2_apply')
        await wait_overlay(page)
        await page.click('#notch_accept')
        await wait_overlay(page)
        assert.deepEqual(await visible_steps(page), ['3'], '«Принять» шага 2 открывает шаг 3')
        const mem_d = (await memory_lines())[3]
        assert.match(mem_d, /^Прошлый проход \([^)]+\), было → прогноз: шум гироскопа -?[\d.]+ → -?[\d.]+ дБ; /, mem_d)
        assert.ok(mem_d.startsWith(pass_c.head + ', было → прогноз: '), mem_d)
        assert.doesNotMatch(mem_d, /в этом логе/, 'числа этого лога нет: ' + mem_d)
        assert.ok(mem_d.endsWith('. Оценка этого лога видна до «Принять» на шаге 2: после него шаг 3 считает с принятыми на шаге 2 значениями.'), mem_d)
        // Память и проход — как ждёт дальнейшее: память пуста, прохода нет (принятое шага 2 забудет перезагрузка страницы)
        await page.click('#wizbar button:nth-child(1)')
        assert.deepEqual(await page.evaluate(() => {
            localStorage.removeItem('tunewizard_v1')
            memory_render_step0()
            return [memory_state.pass, document.getElementById('memory0').checkVisibility()]
        }), [null, false], 'синтетический проход убран')

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
        assert.equal(await page.isVisible('#memory0'), false, 'память прохода пуста — блока «Прошлый проход» нет')

        // Стык шагов 2–3 на свежем состоянии (аудит C): INS_GYRO_FILTER 38, принятый на шаге 2 до первого показа шага 3,
        // попадает в форму шага 3 (иначе правка шага 2 терялась: итог берёт INS_GYRO_FILTER у шага 3) — строка «Свой»
        // без заметки о расхождении; «Применить вариант» по размеру (10″ из памяти браузера) перезаписывает поле — заметка,
        // что в файл пойдёт значение формы. Шаг 2 здесь — первый показ после перезагрузки (расчёт шага 1 досчитывается сам)
        await page.click('#wizbar button:nth-child(3)')
        await wait_overlay(page)
        await page.waitForFunction(() => step2.form_ready && step2.filled, null, { timeout: 60000 })
        await page.fill('#INS_GYRO_FILTER', '38')
        await page.dispatchEvent('#INS_GYRO_FILTER', 'change')
        await page.click('#notch_accept')
        await wait_overlay(page)
        assert.deepEqual(await visible_steps(page), ['3'], '«Принять» шага 2 открывает шаг 3')
        assert.equal(await page.evaluate(() => state.steps[2].accepted.INS_GYRO_FILTER), 38)
        const link3 = await step3_summary(page)
        assert.equal(await page.inputValue('#lpf_INS_GYRO_FILTER'), '38', 'форма шага 3 — INS_GYRO_FILTER, принятый на шаге 2')
        // Форма — строка «Свой» (с метриками), а выбрана при первом показе, как всегда, рекомендованная — по размеру винта
        assert.deepEqual([link3.titles.includes('Свой'), await page.evaluate(() => step3_form_row()?.id ?? null), link3.selected], [true, 'custom', 'prop'],
                         'с ним форма — строка «Свой», выбрана рекомендованная: ' + link3.titles.join('; '))
        assert.doesNotMatch(await page.textContent('#warnings3'), /На шаге 2 принят/, 'в форме принятое шага 2 — заметки о расхождении нет')
        await page.check('#cand3_prop')
        await page.click('#cand3_apply')
        await wait_overlay(page)
        assert.equal(await page.inputValue('#lpf_INS_GYRO_FILTER'), '42', 'применён вариант по размеру')
        assert.match(await page.textContent('#warnings3'), /На шаге 2 принят INS_GYRO_FILTER 38 \(в логе 40\)\. Шаг 3 решает этот параметр: в файл пойдёт значение из этой формы — 42\./,
                     'заметка о расхождении с шагом 2')

        for (const [button, ids] of [[2, ['Spectrum1', 'Spectrogram1']], [3, ['Spectrum2', 'Bode2', 'Spectrogram2']], [4, ['Spectrum3', 'DTerm3', 'Bode3']],
                                     [5, ['StepResp4', 'TarAct4', 'DSpec4', 'LBode4']]]) {
            await page.click('#wizbar button:nth-child(' + button + ')')
            await wait_overlay(page)
            await assert_plot_widths(page, ids)
        }

        // «Принять» шага 3 с «Как в логе» при рекомендованном «По размеру винта» — вердикт называет рекомендованный; смена
        // размера винта после «Принять» принятое не старит (размер — не вход контекста оценки) (аудит C). Шаг 2 принят с
        // INS_GYRO_FILTER 38, шаг 3 — 40 (лог): расхождение шагов — в вердикте и под таблицей сводки; изменений нет —
        // «Скачать .param» выключена, «Запомнить проход» доступна и без изменений закрывает прошлый проход аппарата, заменяя
        // память другой версии формата; блок «Прошлый проход» закрытый проход не показывает (аудит E, I1 и I3)
        await page.click('#wizbar button:nth-child(4)')
        await wait_overlay(page)
        await page.check('#cand3_log')
        await page.click('#cand3_apply')
        await wait_overlay(page)
        await page.click('#lpf_accept')
        await wait_overlay(page)
        assert.deepEqual(await visible_steps(page), ['4'], '«Принять» шага 3 открывает шаг 4')
        const log_accept3 = await page.evaluate(() => ({ id: state.steps[3].candidate_id, verdict: document.getElementById('verdict3').textContent, stale: step_accepted_stale(3) }))
        assert.equal(log_accept3.id, 'log', 'принят вариант «log»')
        assert.match(log_accept3.verdict, /^Принято: «Как в логе» — .* \(к логу\)\. Рекомендовался «По размеру винта \(10″\)»\.$/, log_accept3.verdict)
        assert.equal(log_accept3.stale, false, 'принятое шага 3 актуально')
        await page.click('#wizbar button:nth-child(4)')
        await wait_overlay(page)
        await page.fill('#prop_in', '12')
        await wait_step3_row(page, 'По размеру винта (12″)')
        const prop_after3 = await page.evaluate(() => ({ verdict: document.getElementById('verdict3').textContent, stale: step_accepted_stale(3) }))
        assert.match(prop_after3.verdict, /^Принято: «Как в логе» — .* Рекомендовался «По размеру винта \(12″\)»\.$/, 'смена размера винта после «Принять» — не «Принято раньше»: ' + prop_after3.verdict)
        assert.equal(prop_after3.stale, false, 'размер винта принятое не старит')
        await page.fill('#prop_in', '10')
        await wait_step3_row(page, 'По размеру винта (10″)')
        await page.click('#wizbar button:nth-child(6)')
        await page.waitForFunction(() => step_metadata() != null, null, { timeout: 30000 })
        const link5 = await step5_summary(page)
        assert.equal(link5.conflicts, 'INS_GYRO_FILTER: шаг 2 — 38, шаг 3 — 40, действует шаг 3, значение как в логе — в файл не идёт.', 'расхождение под таблицей')
        assert.match(link5.verdict, /^Принятые значения совпадают с логом, но проверьте: INS_GYRO_FILTER: на шаге 2 принято 38, на шаге 3 — 40 \(как в логе\), действует шаг 3, значение как в логе — в файл не идёт;/,
                     link5.verdict)
        assert.deepEqual([link5.expected, link5.disabled, link5.stale], [[], [true, false], [false, false, false]], 'изменений нет: файла нет, «Запомнить проход» доступна')
        await page.evaluate((json) => { localStorage.setItem('tunewizard_v1', json) }, version_json)
        await page.click('#step5_remember')
        assert.equal(await page.textContent('#step5_note'), 'Изменений нет — прошлый проход аппарата закрыт (память очищена для этого аппарата). Прежняя память другой версии заменена.')
        const closed5 = await page.evaluate((key) => {
            const data = JSON.parse(localStorage.getItem('tunewizard_v1'))
            return { version: data.version, keys: Object.keys(data.passes), changed: data.passes[key].changed, estimates: data.passes[key].estimates }
        }, fc_key)
        assert.deepEqual([closed5.version, closed5.keys, closed5.changed], [1, [fc_key], []], 'память версии 1 с закрывающим проходом')
        assert.deepEqual([closed5.estimates[2], closed5.estimates[4]], [null, null], 'оценки перекрытого шага 2 и непринятого шага 4 — null')
        assert.ok(Number.isFinite(closed5.estimates[3]?.log?.gyro_band_dB), 'оценки шага 3 — числа')
        assert.deepEqual(await page.evaluate(() => {
            memory_render_step0()
            return [document.getElementById('memory0').hidden, memory_state.pass]
        }), [true, null], 'закрытый проход блок «Прошлый проход» не показывает')

        assert.deepEqual(problems, [], 'ошибки консоли')
        console.log('tunewizard-browser: главная и шаги 0–5 пройдены, проверок ' + statuses.length + ' (' + statuses.join(', ') + '); шаг 1: трасс с данными ' + s1.with_data +
            ', бинов ' + s1.x_len + ', пиков ' + s1.peaks + ', вердикт «' + s1.verdict + '»; скриншоты в ' + shots)
        console.log('  пики: ' + s1.peak_rows.map((row) => row.join(' | ')).join(' ; '))
        console.log('  шаг 2: варианты ' + v1.titles.join('; ') + '; рекомендован ' + v1.best_id + '; вердикт «' + v1.verdict + '»')
        console.log('  шаг 3: варианты ' + w2.titles.join('; ') + '; рекомендован ' + w2.recommended.join('; ') + '; вердикт «' + w2.verdict + '»')
        const axis_names4 = { roll: 'крен', pitch: 'тангаж', yaw: 'рыскание' }
        console.log('  шаг 4: ' + Object.entries(axes4).map(([axis, a]) => axis_names4[axis] + ' — ' + a.windows_text + ', ' + a.data_s.toFixed(1) + ' с данных, ' +
            ((a.failed.length == 1) ? 'не пройдена ' : 'не пройдены ') + a.failed.join(', ')).join('; ') + '; итог — измерение ненадёжно на всех осях, прогноз ' +
            'недостоверен (правил и прогноза нет); под подменой у тангажа (фильтры шагов 2–3, без ложного «неустойчив») — варианты ' + sub_lines.titles.join('; ') + ', рекомендуется «' +
            sub_lines.recommended.join('; ') + '», бодэ ' + sub_lines.log)
        console.log('  шаг 5: изменено ' + v5.expected.length + ', без изменений ' + v5.expected_unchanged + '; вердикт «' + v5.verdict + '»; что перелететь — пунктов ' +
            v5.refly.length)
        console.log('  прошлый проход: шаг 2 «' + mem_a[2] + '»; шаг 3 «' + mem_c + '»; шаг 3 после «Принять» на шаге 2 «' + mem_d + '»; ось шага 4 под подменой «' +
            line4.ok + '»')
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
