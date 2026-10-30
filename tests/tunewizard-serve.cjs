// Тест сервера мастера для Windows — TuneWizard/windows/serve.ps1 (PowerShell 5.1, его запускает двойной клик по
// «Мастер настройки.cmd»). Проверяется: файл сервера в UTF-8 с BOM и .cmd только из латиницы; ответы по HTTP — типы
// .html/.js/.json/.png/.svg, файлы байт в байт (и Plotly 3.5 МБ), HEAD без тела, query отбрасывается, %-кодирование
// снимается, 301 на папку без косой черты, 404, 403 на выход из корня (.., %2e%2e, ..\, %5c, абсолютные пути, NUL),
// 405 и 400; пустое соединение и незаконченный запрос не задерживают других; страница мастера в Chrome — парсер
// логов (ES-модуль) загружен, описания параметров пришли, файл tests/fixtures/prep.param — блок подготовки виден;
// FilterReview и PIDReview открываются; ошибок консоли и ответов 4xx нет; второй запуск на занятом мастером порту —
// код 0 без второго сервера; порт занят чужим сервером — код 1 и сообщение; запуск после остановки — порт снова свой.
// Запуск: npm run test:tunewizard-serve [-- <корень>] — корень по умолчанию — репозиторий; сборка переносной папки
// прогоняет тот же тест на ней (её serve.ps1 и её файлы). Порт 8797.
// Нужны: Windows (powershell.exe), браузер (CHROME_PATH — путь к chrome.exe; без него Playwright берёт свой Chromium,
// если он установлен). Логи не нужны
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')
const { chromium } = require('playwright')

const repo = path.resolve(__dirname, '..')
const root = path.resolve(process.argv[2] ?? repo)
const script = path.join(root, 'TuneWizard', 'windows', 'serve.ps1')
const launcher = path.join(root, 'Мастер настройки.cmd')
const fixture = path.join(__dirname, 'fixtures', 'prep.param')
const port = 8797
const base = 'http://127.0.0.1:' + port
// Файлы корня для сверки ответа байт в байт и тип каждого
const files = [
    ['/TuneWizard/', 'TuneWizard/index.html', 'text/html; charset=utf-8'],
    ['/TuneWizard/wizard.js', 'TuneWizard/wizard.js', 'text/javascript; charset=utf-8'],
    ['/modules/JsDataflashParser/parser.js', 'modules/JsDataflashParser/parser.js', 'text/javascript; charset=utf-8'],
    ['/modules/plotly.js/dist/plotly.min.js', 'modules/plotly.js/dist/plotly.min.js', 'text/javascript; charset=utf-8'],
    ['/FilterReview/params.json', 'FilterReview/params.json', 'application/json'],
    ['/images/TuneWizard_Icon.png', 'images/TuneWizard_Icon.png', 'image/png'],
    ['/images/question-circle.svg', 'images/question-circle.svg', 'image/svg+xml'],
    // query отбрасывается, %-кодирование снимается (%69 — «i»)
    ['/TuneWizard/index.html?v=1', 'TuneWizard/index.html', 'text/html; charset=utf-8'],
    ['/TuneWizard/%69ndex.html', 'TuneWizard/index.html', 'text/html; charset=utf-8'],
]
// Выход из корня и недопустимые пути — 403 (запрос отправляется как есть: http.request путь не нормализует)
const forbidden = ['/../package.json', '/%2e%2e/package.json', '/TuneWizard/..%5c..%5cpackage.json', '/TuneWizard/..\\..\\package.json',
    '/TuneWizard/%2e%2e%2f%2e%2e%2fpackage.json', '/TuneWizard/../../package.json', '/C:/Windows/win.ini', '/C:%5cWindows%5cwin.ini',
    '/%5c%5c%3f%5cC:%5cWindows%5cwin.ini', '/TuneWizard/index.html%00.png']

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

// Результат обещания promise или 'timeout' через ms; таймер снимается, чтобы не держать Node после теста
async function within(promise, ms) {
    let timer = null
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), ms) })
    try {
        return await Promise.race([promise, timeout])
    } finally {
        clearTimeout(timer)
    }
}

// Запустить serve.ps1 с аргументами args (без браузера): процесс, обещание кода выхода и вывод (stdout и stderr; сервер
// пишет UTF-8, когда вывод перенаправлен)
function start_serve(args) {
    const proc = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args, '-NoBrowser'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const chunks = []
    proc.stdout.on('data', (d) => chunks.push(d))
    proc.stderr.on('data', (d) => chunks.push(d))
    const exited = new Promise((resolve) => {
        proc.on('exit', (code) => resolve(code))
        proc.on('error', (e) => {
            chunks.push(Buffer.from('ошибка запуска powershell: ' + e.message))
            resolve(-1)
        })
    })
    return { proc: proc, exited: exited, output: () => Buffer.concat(chunks).toString('utf8') }
}

// Код выхода сервера не позже ms, иначе ошибка с выводом
async function exit_code(server, ms, what) {
    const code = await within(server.exited, ms)
    if (code === 'timeout') {
        throw new Error(what + ': serve.ps1 не завершился за ' + (ms / 1000) + ' с; вывод: ' + server.output())
    }
    return code
}

// Остановить сервер вместе с деревом процессов (powershell и его conhost), чтобы не осталось висящих
async function stop_serve(server) {
    if ((server == null) || (server.proc.exitCode != null) || (server.proc.pid == null)) {
        return
    }
    try {
        if (process.platform === 'win32') {
            execFileSync('taskkill', ['/PID', String(server.proc.pid), '/T', '/F'], { stdio: 'ignore' })
        } else {
            server.proc.kill()
        }
    } catch {
        server.proc.kill()
    }
    await within(server.exited, 5000)
}

// HTTP-запрос как есть (путь не нормализуется): статус, заголовки, тело
function request(raw_path, method = 'GET') {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: port, path: raw_path, method: method, agent: false }, (res) => {
            const chunks = []
            res.on('data', (d) => chunks.push(d))
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
            res.on('error', reject)
        })
        req.setTimeout(10000, () => req.destroy(new Error('нет ответа за 10 с: ' + method + ' ' + raw_path)))
        req.on('error', reject)
        req.end()
    })
}

// Сырой обмен по TCP: отправить text, прочитать всё до закрытия соединения сервером
function raw_exchange(text) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => socket.write(text))
        const chunks = []
        socket.setTimeout(10000, () => socket.destroy(new Error('нет ответа за 10 с: ' + JSON.stringify(text))))
        socket.on('data', (d) => chunks.push(d))
        socket.on('end', () => resolve(Buffer.concat(chunks)))
        socket.on('error', reject)
    })
}

// Соединение без запроса (или с началом запроса text) — держать открытым; закрыть — socket.destroy()
function idle_connection(text) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => {
            if (text) {
                socket.write(text)
            }
            resolve(socket)
        })
        socket.on('error', reject)
    })
}

// Дождаться, пока сервер ответит страницей мастера; сервер завершился или отвечает не мастер — ошибка с причиной
async function wait_ready(server) {
    for (let i = 0; i < 80; i++) {
        if (server.proc.exitCode != null) {
            throw new Error('serve.ps1 завершился с кодом ' + server.proc.exitCode + ' (занят порт ' + port + '?); вывод: ' + server.output())
        }
        let res = null
        try {
            res = await request('/TuneWizard/')
        } catch {
            await sleep(250)
            continue
        }
        if ((res.status !== 200) || !res.body.toString('utf8').includes('<title>Мастер настройки</title>')) {
            throw new Error('на порту ' + port + ' отвечает не мастер (занят порт?): HTTP ' + res.status)
        }
        return
    }
    throw new Error('serve.ps1 не поднялся на ' + base + '; вывод: ' + server.output())
}

// HTTP-проверки работающего сервера; число проверенных запросов
async function check_http() {
    let checked = 0
    for (const [url, file, type] of files) {
        const res = await request(url)
        const expected = fs.readFileSync(path.join(root, file))
        assert.equal(res.status, 200, url)
        assert.equal(res.headers['content-type'], type, 'тип ' + url)
        assert.equal(res.headers['content-length'], String(expected.length), 'Content-Length ' + url)
        assert.deepEqual([res.headers['cache-control'], res.headers['connection']], ['no-cache', 'close'], 'заголовки ' + url)
        assert.ok(res.body.equals(expected), 'файл байт в байт: ' + url)
        checked++
    }

    // HEAD — заголовки без тела (сырой обмен: http-клиент Node лишние байты после HEAD не показал бы)
    const head = await raw_exchange('HEAD /TuneWizard/wizard.js HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n')
    const head_text = head.toString('latin1')
    assert.match(head_text, /^HTTP\/1\.1 200 OK\r\n/, head_text)
    assert.ok(head_text.includes('\r\nContent-Type: text/javascript; charset=utf-8\r\n'), head_text)
    assert.ok(head_text.includes('\r\nContent-Length: ' + fs.statSync(path.join(root, 'TuneWizard/wizard.js')).size + '\r\n'), head_text)
    assert.ok(head_text.endsWith('\r\n\r\n'), 'HEAD без тела: ' + head.length + ' байт')
    checked++

    // Папка без косой черты — 301 на адрес с ней (query сохраняется); нет файла — 404
    const moved = await request('/TuneWizard')
    assert.deepEqual([moved.status, moved.headers.location], [301, '/TuneWizard/'], '301 на /TuneWizard/')
    const moved_query = await request('/FilterReview?x=1')
    assert.deepEqual([moved_query.status, moved_query.headers.location], [301, '/FilterReview/?x=1'], '301 с query')
    const missing = await request('/TuneWizard/' + encodeURIComponent('нет-такого') + '.js')
    assert.equal(missing.status, 404, 'нет файла — 404')
    assert.match(missing.body.toString('utf8'), /404 — Файл не найден\./)
    checked += 3

    // Выход из корня — 403, содержимое файла не отдаётся
    for (const url of forbidden) {
        const res = await request(url)
        assert.equal(res.status, 403, '403: ' + url)
        assert.ok(!res.body.toString('utf8').includes('"name"'), 'без содержимого: ' + url)
        checked++
    }

    // Метод не GET/HEAD — 405 с Allow; не HTTP — 400; сервер работает дальше
    const post = await request('/TuneWizard/', 'POST')
    assert.deepEqual([post.status, post.headers.allow], [405, 'GET, HEAD'], 'POST — 405')
    const garbage = (await raw_exchange('HELLO\r\n\r\n')).toString('latin1')
    assert.match(garbage, /^HTTP\/1\.1 400 Bad Request\r\n/, garbage)
    const proxy = (await raw_exchange('GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n')).toString('latin1')
    assert.match(proxy, /^HTTP\/1\.1 400 Bad Request\r\n/, 'адрес прокси — 400: ' + proxy)
    checked += 3

    // Пустое соединение (Chrome открывает такие заранее) и незаконченный запрос не задерживают другой запрос
    const idle = await idle_connection('')
    const partial = await idle_connection('GET /TuneWizard/ HT')
    try {
        const t0 = Date.now()
        const res = await request('/TuneWizard/wizard.js')
        const ms = Date.now() - t0
        assert.equal(res.status, 200)
        assert.ok(ms < 2000, 'ответ при пустом и незаконченном соединении за ' + ms + ' мс')
        // Незаконченный запрос, дописанный позже, получает ответ
        const answer = new Promise((resolve, reject) => {
            const chunks = []
            partial.on('data', (d) => chunks.push(d))
            partial.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')))
            partial.on('error', reject)
        })
        partial.write('TP/1.1\r\nHost: 127.0.0.1\r\n\r\n')
        assert.match(await answer, /^HTTP\/1\.1 200 OK\r\n/, 'дописанный запрос')
        checked += 2
    } finally {
        idle.destroy()
        partial.destroy()
    }
    return checked
}

// Страница мастера в Chrome, затем FilterReview и PIDReview: ошибки консоли, страницы и ответы 4xx/5xx своего адреса —
// в problems; итог — время загрузки мастера, число запросов, проверенное на странице
async function check_browser(problems) {
    let browser = null
    try {
        browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined })
        const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
        page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()) })
        page.on('pageerror', (e) => problems.push('pageerror: ' + e.message))
        page.on('requestfailed', (r) => { if (r.url().startsWith(base)) problems.push('requestfailed: ' + r.url() + ' — ' + (r.failure()?.errorText ?? '')) })
        const types = {}
        let requests = 0
        page.on('response', (r) => {
            if (!r.url().startsWith(base)) {
                return
            }
            requests++
            types[new URL(r.url()).pathname] = r.headers()['content-type']
            if (r.status() >= 400) {
                problems.push('HTTP ' + r.status() + ': ' + r.url())
            }
        })

        const t0 = Date.now()
        const response = await page.goto(base + '/TuneWizard/', { waitUntil: 'networkidle' })
        // networkidle — ещё 0.5 с без запросов; load — все файлы страницы получены
        const idle_ms = Date.now() - t0
        const load_ms = Math.round(await page.evaluate(() => performance.getEntriesByType('navigation')[0].loadEventEnd))
        const wizard_requests = requests
        assert.equal(response.status(), 200)
        assert.equal(await page.title(), 'Мастер настройки')
        assert.equal(types['/modules/JsDataflashParser/parser.js'], 'text/javascript; charset=utf-8', 'парсер логов — тип ES-модуля')
        const loaded = await page.evaluate(async () => {
            await import_done
            const data = await step_load_metadata()
            return { parser: typeof DataflashParser, metadata: (data != null) ? Object.keys(data).length : null, failed: step_metadata_state.failed }
        })
        assert.equal(loaded.parser, 'function', 'DataflashParser загружен')
        assert.ok((loaded.metadata > 0) && !loaded.failed, 'описания параметров пришли: ' + JSON.stringify(loaded))

        // Файл параметров без лога — блок подготовки виден, список проверок есть
        await page.setInputFiles('#prep0_file', fixture)
        await page.waitForFunction(() => prep0_state.file != null, null, { timeout: 10000 })
        const prep = await page.evaluate(() => ({ visible: document.getElementById('prep0').checkVisibility(), checks: document.querySelectorAll('#prep0_checks .check').length,
                                                   verdict: document.getElementById('prep0_verdict').textContent }))
        assert.ok(prep.visible && (prep.checks > 0), 'блок подготовки: ' + JSON.stringify(prep))

        // FilterReview и PIDReview (кнопки «Открыть в …» ведут сюда) — открываются без ошибок
        const titles = []
        for (const tool of ['FilterReview', 'PIDReview']) {
            const res = await page.goto(base + '/' + tool + '/', { waitUntil: 'networkidle' })
            assert.equal(res.status(), 200, tool)
            titles.push(await page.title())
        }
        assert.deepEqual(titles, ['ArduPilot Filter Review', 'ArduPilot PID Review'])
        return { load_ms: load_ms, idle_ms: idle_ms, requests: wizard_requests, metadata: loaded.metadata, prep_verdict: prep.verdict }
    } finally {
        if (browser) {
            await browser.close()
        }
    }
}

async function main() {
    if (process.platform !== 'win32') {
        console.log('tunewizard-serve: сервер мастера — для Windows (powershell.exe) — пропуск')
        return
    }
    const started = Date.now()
    const problems = []
    let server = null
    let other = null
    let foreign = null
    try {
        // Файлы запуска: serve.ps1 в UTF-8 с BOM (PowerShell 5.1 без BOM читает русский текст как ANSI), .cmd — только
        // латиница и путь к serve.ps1
        assert.ok(fs.readFileSync(script).subarray(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF])), 'serve.ps1 начинается с BOM UTF-8: ' + script)
        const cmd = fs.readFileSync(launcher)
        assert.ok(cmd.every((byte) => byte < 0x80), 'в «Мастер настройки.cmd» только латиница')
        assert.ok(cmd.toString('latin1').includes('"%~dp0TuneWizard\\windows\\serve.ps1" -Root "%~dp0."'), '.cmd запускает serve.ps1 с корнем своей папки')

        server = start_serve(['-Root', root, '-Port', String(port)])
        await wait_ready(server)
        assert.match(server.output(), /Мастер настройки: http:\/\/127\.0\.0\.1:8797\/TuneWizard\//, 'сообщение о запуске: ' + server.output())

        const checked = await check_http()
        const page = await check_browser(problems)
        assert.deepEqual(problems, [], 'ошибки консоли и ответы 4xx')

        // Второй запуск на том же порту (корень по умолчанию — два уровня выше скрипта): мастер уже отвечает — код 0,
        // второй сервер не поднимается, первый работает
        const t_second = Date.now()
        other = start_serve(['-Port', String(port)])
        const second_code = await exit_code(other, 20000, 'второй запуск')
        const second_s = (Date.now() - t_second) / 1000
        assert.equal(second_code, 0, 'второй запуск — код 0; вывод: ' + other.output())
        assert.match(other.output(), /Мастер настройки уже запущен: http:\/\/127\.0\.0\.1:8797\/TuneWizard\//, other.output())
        assert.equal((await request('/TuneWizard/')).status, 200, 'первый сервер работает')
        await stop_serve(server)
        server = null

        // Порт занят чужим сервером: проверка запросом /TuneWizard/ — не мастер; код 1 и сообщение
        const foreign_paths = []
        foreign = http.createServer((req, res) => {
            foreign_paths.push(req.url)
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end('<!doctype html><title>Другая программа</title>')
        })
        await new Promise((resolve, reject) => {
            foreign.once('error', reject)
            foreign.listen(port, '127.0.0.1', resolve)
        })
        other = start_serve(['-Port', String(port)])
        const busy_code = await exit_code(other, 20000, 'порт занят чужим сервером')
        assert.equal(busy_code, 1, 'порт занят чужим — код 1; вывод: ' + other.output())
        assert.match(other.output(), /Порт 8797 занят другой программой — закройте её и запустите мастер снова\./, other.output())
        assert.deepEqual(foreign_paths, ['/TuneWizard/'], 'сервер проверил, мастер ли на порту')
        await new Promise((resolve) => foreign.close(resolve))
        foreign = null

        // Запуск после остановки (закрыли окно и сразу открыли снова): порт снова занимается
        const t_restart = Date.now()
        server = start_serve(['-Root', root, '-Port', String(port)])
        await wait_ready(server)
        const restart_s = (Date.now() - t_restart) / 1000
        await stop_serve(server)
        server = null

        console.log('tunewizard-serve: сервер PowerShell проверен за ' + ((Date.now() - started) / 1000).toFixed(1) + ' с, корень ' + root)
        console.log('  HTTP: ' + checked + ' проверок; мастер в Chrome — load за ' + page.load_ms + ' мс (networkidle ' + page.idle_ms + ' мс), запросов к серверу ' +
            page.requests + ', групп описаний параметров ' + page.metadata + '; подготовка — «' + page.prep_verdict + '»; FilterReview и PIDReview открылись')
        console.log('  второй запуск — код 0 за ' + second_s.toFixed(1) + ' с; порт занят чужим — код 1; запуск после остановки — ' + restart_s.toFixed(1) + ' с')
    } catch (e) {
        if (problems.length) {
            console.error('Сообщения консоли:', problems)
        }
        throw e
    } finally {
        // Сбой одной остановки не должен оставить остальные процессы и порт
        for (const s of [server, other]) {
            try {
                await stop_serve(s)
            } catch {
            }
        }
        if (foreign) {
            foreign.close()
        }
    }
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
