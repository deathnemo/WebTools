// Тест сервера мастера для Windows — TuneWizard/windows/serve.ps1 (PowerShell 5.1, его запускает двойной клик по
// «Мастер настройки.cmd»). Проверяется:
// - файлы запуска: serve.ps1 в UTF-8 с BOM, .cmd в UTF-8 без BOM, передаёт аргументы дальше;
// - HTTP: типы .html/.js/.json/.png/.svg, файлы байт в байт (и Plotly 3.5 МБ), заголовок X-TuneWizard-Root, HEAD без
//   тела, query отбрасывается, %-кодирование снимается; 301 на папку без косой черты — адрес из нормализованных
//   сегментов («//TuneWizard», «/\images» не уводят на другой сайт), корень без index.html — на /TuneWizard/; 404, в том
//   числе папка без index.html; 403 на выход из корня (.., %2e%2e, ..\, %5c, абсолютные пути, NUL, ::$DATA, имена
//   устройств) и на чужой Host (DNS rebinding); 405, 400, 431 (заголовок длиннее 64 КБ за два чтения); пустое
//   соединение и незаконченный запрос не задерживают других; 500 на заблокированном файле — сервер работает дальше;
// - страница мастера в Chrome — парсер логов (ES-модуль) загружен, описания параметров пришли, файл
//   tests/fixtures/prep.param — блок подготовки виден; FilterReview и PIDReview открываются; ошибок консоли и ответов
//   4xx нет;
// - запуски на занятом порте: мастер этой папки — код 0 без второго сервера (serve.ps1 и .cmd), мастер другой папки —
//   код 2 и сообщение, мастер без X-TuneWizard-Root (как python http.server) — код 0; чужой сервер на всех адресах
//   (listen без host — двойной стек, Start() на 127.0.0.1 его не заметил бы) — код 2 и сообщение, .cmd второй раз не
//   ждёт; .cmd без своей папки и при сбое PowerShell — код 1 и сообщение; запуск после остановки — порт снова свой.
// Запуск: npm run test:tunewizard-serve [-- <корень>] — корень по умолчанию — репозиторий; сборка переносной папки
// прогоняет тот же тест на ней (её serve.ps1, .cmd и файлы). Порт 8797.
// Нужны: Windows (powershell.exe), браузер (CHROME_PATH — путь к chrome.exe; без него Playwright берёт свой Chromium,
// если он установлен). Логи не нужны. Вторую папку мастера и заблокированный файл тест создаёт во временной папке ОС
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
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
// Коды выхода serve.ps1 и .cmd: отказ с сообщением; сбой PowerShell или нет папки рядом с .cmd
const refused_code = 2
const failed_code = 1
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
    '/%5c%5c%3f%5cC:%5cWindows%5cwin.ini', '/TuneWizard/index.html%00.png', '/TuneWizard/index.html::$DATA', '/NUL', '/TuneWizard/con.js', '/TuneWizard/COM1']

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

// Запустить «Мастер настройки.cmd» из папки dir с аргументами args как двойной клик: cmd /s /c ""путь" args" из
// другой текущей папки; ввод перенаправлен — pause не ждёт. Консоль — теста: без неё (detached) PowerShell получил бы
// свою и писал бы туда, мимо вывода; кодовую страницу, сменённую для русских сообщений, .cmd возвращает после pause.
// Итог — как у start_serve
function start_cmd(dir, args) {
    const file = path.join(dir, 'Мастер настройки.cmd')
    const proc = spawn('cmd.exe', ['/d /s /c ""' + file + '" ' + args.join(' ') + '"'], { cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
                                                                                     windowsVerbatimArguments: true })
    const chunks = []
    proc.stdout.on('data', (d) => chunks.push(d))
    proc.stderr.on('data', (d) => chunks.push(d))
    const exited = new Promise((resolve) => {
        proc.on('exit', (code) => resolve(code))
        proc.on('error', (e) => {
            chunks.push(Buffer.from('ошибка запуска cmd: ' + e.message))
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

// HTTP-запрос как есть (путь не нормализуется): статус, заголовки, тело; headers — свои заголовки (Host)
function request(raw_path, method = 'GET', headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: port, path: raw_path, method: method, headers: headers, agent: false }, (res) => {
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

// Сырой обмен по TCP: отправить text (массив — частями с паузой 200 мс), прочитать всё до закрытия соединения сервером
function raw_exchange(text) {
    const parts = Array.isArray(text) ? text : [text]
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', async () => {
            for (let i = 0; i < parts.length; i++) {
                if (i > 0) {
                    await sleep(200)
                }
                socket.write(parts[i])
            }
        })
        const chunks = []
        socket.setTimeout(10000, () => socket.destroy(new Error('нет ответа за 10 с: ' + JSON.stringify(parts[0].slice(0, 60)))))
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

// Сервер Node с обработчиком handler на порту теста: host — адрес (undefined — все адреса, двойной стек «::»)
async function listen(handler, host) {
    const server = http.createServer(handler)
    await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, resolve)
    })
    return server
}

// Заблокировать файл другим процессом (FileShare.None): PowerShell держит его открытым, пока открыт его ввод. Итог —
// процесс, обещание «заблокирован» и обещание кода выхода
function lock_file(file) {
    const proc = spawn('powershell', ['-NoProfile', '-Command', "$f = [IO.File]::Open($env:TW_LOCK, 'Open', 'Read', 'None'); [Console]::Out.WriteLine('locked'); " +
        '[Console]::Out.Flush(); [void][Console]::In.ReadLine(); $f.Close()'], { env: { ...process.env, TW_LOCK: file }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const exited = new Promise((resolve) => proc.on('exit', (code) => resolve(code)))
    const ready = new Promise((resolve, reject) => {
        proc.stdout.on('data', (d) => { if (d.toString().includes('locked')) resolve() })
        exited.then((code) => reject(new Error('блокировка файла: powershell завершился с кодом ' + code)))
    })
    return { proc: proc, ready: ready, exited: exited }
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
        assert.equal(decodeURIComponent(res.headers['x-tunewizard-root']).toLowerCase(), root.toLowerCase(), 'X-TuneWizard-Root — корень: ' + url)
        assert.ok(res.body.equals(expected), 'файл байт в байт: ' + url)
        checked++
    }

    // Корень: в репозитории — главная WebTools, в переносной папке (нет index.html) — 301 на мастер
    const top = await request('/')
    if (fs.existsSync(path.join(root, 'index.html'))) {
        assert.deepEqual([top.status, top.headers['content-type']], [200, 'text/html; charset=utf-8'], 'корень с index.html')
    } else {
        assert.deepEqual([top.status, top.headers.location], [301, '/TuneWizard/'], 'корень без index.html — на мастер')
    }
    checked++

    // HEAD — заголовки без тела (сырой обмен: http-клиент Node лишние байты после HEAD не показал бы)
    const head = await raw_exchange('HEAD /TuneWizard/wizard.js HTTP/1.1\r\nHost: 127.0.0.1:' + port + '\r\n\r\n')
    const head_text = head.toString('latin1')
    assert.match(head_text, /^HTTP\/1\.1 200 OK\r\n/, head_text)
    assert.ok(head_text.includes('\r\nContent-Type: text/javascript; charset=utf-8\r\n'), head_text)
    assert.ok(head_text.includes('\r\nContent-Length: ' + fs.statSync(path.join(root, 'TuneWizard/wizard.js')).size + '\r\n'), head_text)
    assert.ok(head_text.endsWith('\r\n\r\n'), 'HEAD без тела: ' + head.length + ' байт')
    checked++

    // Папка без косой черты — 301 на адрес с ней (query сохраняется), адрес — из нормализованных сегментов: «//…» и
    // «/\…» дали бы адрес другого сайта; нет файла — 404, папка без index.html — тоже
    const redirects = [['/TuneWizard', '/TuneWizard/'], ['/FilterReview?x=1', '/FilterReview/?x=1'], ['//TuneWizard', '/TuneWizard/'], ['/\\images', '/images/'],
        ['/%5cimages', '/images/'], ['/./TuneWizard', '/TuneWizard/'],
        ['/%2e', fs.existsSync(path.join(root, 'index.html')) ? '/' : '/TuneWizard/']]
    for (const [url, location] of redirects) {
        const moved = await request(url)
        assert.deepEqual([moved.status, moved.headers.location], [301, location], '301: ' + url)
        checked++
    }
    const missing = await request('/TuneWizard/' + encodeURIComponent('нет-такого') + '.js')
    assert.equal(missing.status, 404, 'нет файла — 404')
    assert.match(missing.body.toString('utf8'), /404 — Файл не найден\./)
    assert.equal((await request('/TuneWizard/core/')).status, 404, 'папка без index.html — 404')
    checked += 2

    // Host: чужое имя (DNS rebinding) — 403; localhost без учёта регистра и запрос без Host (HTTP/1.0) — отвечают
    const rebinding = await request('/TuneWizard/', 'GET', { Host: 'attacker.example:' + port })
    assert.equal(rebinding.status, 403, 'Host attacker.example — 403')
    assert.ok(!rebinding.body.toString('utf8').includes('<title>Мастер настройки'), 'страница мастера не отдана')
    assert.equal((await request('/TuneWizard/', 'GET', { Host: 'LocalHost:' + port })).status, 200, 'Host LocalHost')
    const no_host = (await raw_exchange('GET /TuneWizard/wizard.js HTTP/1.0\r\n\r\n')).toString('latin1')
    assert.match(no_host, /^HTTP\/1\.1 200 OK\r\n/, 'без Host: ' + no_host.slice(0, 80))
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
    // Заголовок 70 000 байт, пришедший за два чтения (конец — во втором), — 431
    const long_head = ['GET /TuneWizard/ HTTP/1.1\r\nHost: 127.0.0.1:' + port + '\r\nX-Pad: ' + 'a'.repeat(40000), 'a'.repeat(30000) + '\r\n\r\n']
    const too_long = (await raw_exchange(long_head)).toString('latin1')
    assert.match(too_long, /^HTTP\/1\.1 431 Request Header Fields Too Large\r\n/, 'длинный заголовок: ' + too_long.slice(0, 80))
    checked += 4

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
        partial.write('TP/1.1\r\nHost: 127.0.0.1:' + port + '\r\n\r\n')
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

        // Время до события load (все файлы страницы получены) — часами теста; затем networkidle (ещё 0.5 с без запросов)
        const t0 = Date.now()
        const response = await page.goto(base + '/TuneWizard/', { waitUntil: 'load' })
        const load_ms = Date.now() - t0
        await page.waitForLoadState('networkidle')
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
        return { load_ms: load_ms, requests: wizard_requests, metadata: loaded.metadata, prep_verdict: prep.verdict }
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
    let locker = null
    let tmp = null
    try {
        // Файлы запуска: serve.ps1 в UTF-8 с BOM (PowerShell 5.1 без BOM читает русский текст как ANSI); .cmd — UTF-8 без
        // BOM (cmd прочитал бы BOM частью первой команды), запускает serve.ps1 с корнем своей папки и передаёт аргументы
        const bom = Buffer.from([0xEF, 0xBB, 0xBF])
        assert.ok(fs.readFileSync(script).subarray(0, 3).equals(bom), 'serve.ps1 начинается с BOM UTF-8: ' + script)
        const cmd = fs.readFileSync(launcher)
        assert.ok(!cmd.subarray(0, 3).equals(bom) && !cmd.toString('utf8').includes('�'), '«Мастер настройки.cmd» — UTF-8 без BOM')
        assert.ok(cmd.toString('utf8').includes('"%~dp0TuneWizard\\windows\\serve.ps1" -Root "%~dp0." %*'), '.cmd запускает serve.ps1 с корнем своей папки и аргументами')

        // Вторая папка мастера во временной папке ОС: страница мастера и файл, который заблокирует другой процесс (500);
        // корневого index.html нет — как в переносной папке
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tunewizard-serve-'))
        fs.mkdirSync(path.join(tmp, 'TuneWizard'))
        fs.copyFileSync(path.join(root, 'TuneWizard', 'index.html'), path.join(tmp, 'TuneWizard', 'index.html'))
        fs.writeFileSync(path.join(tmp, 'TuneWizard', 'locked.js'), '// файл блокирует тест\n')

        server = start_serve(['-Root', root, '-Port', String(port)])
        await wait_ready(server)
        assert.match(server.output(), /Мастер настройки: http:\/\/127\.0\.0\.1:8797\/TuneWizard\//, 'сообщение о запуске: ' + server.output())

        const checked = await check_http()
        const page = await check_browser(problems)
        assert.deepEqual(problems, [], 'ошибки консоли и ответы 4xx')

        // Запуски на порту, занятом мастером этой папки: serve.ps1 с корнем по умолчанию (два уровня выше скрипта) и .cmd
        // (аргументы передаёт дальше) — код 0, второй сервер не поднимается; мастер другой папки — отказ с путём занятой
        const t_second = Date.now()
        other = start_serve(['-Port', String(port)])
        const second_code = await exit_code(other, 20000, 'второй запуск')
        const second_s = (Date.now() - t_second) / 1000
        assert.equal(second_code, 0, 'второй запуск — код 0; вывод: ' + other.output())
        assert.match(other.output(), /Мастер настройки уже запущен: http:\/\/127\.0\.0\.1:8797\/TuneWizard\//, other.output())
        other = start_cmd(root, ['-Port', String(port), '-NoBrowser'])
        assert.equal(await exit_code(other, 20000, '.cmd на порту с мастером'), 0, '.cmd — код 0; вывод: ' + other.output())
        assert.match(other.output(), /Мастер настройки уже запущен: http:\/\/127\.0\.0\.1:8797\/TuneWizard\//, other.output())
        other = start_serve(['-Root', tmp, '-Port', String(port)])
        assert.equal(await exit_code(other, 20000, 'мастер другой папки'), refused_code, 'мастер другой папки — отказ; вывод: ' + other.output())
        assert.ok(other.output().includes('На порту 8797 уже работает мастер из другой папки: ' + root + '. Закройте его окно и запустите снова.'), other.output())
        assert.equal((await request('/TuneWizard/')).status, 200, 'первый сервер работает')
        await stop_serve(server)
        server = null

        // .cmd без своей папки (прямо из zip-архива, копия на рабочем столе) и при сбое PowerShell (-Port 0 не проходит
        // проверку параметра) — код 1 и сообщение по-русски (в окне — ожидание клавиши; здесь ввод перенаправлен)
        const alone = path.join(tmp, 'Копия на рабочем столе')
        fs.mkdirSync(alone)
        fs.copyFileSync(launcher, path.join(alone, 'Мастер настройки.cmd'))
        other = start_cmd(alone, [])
        assert.equal(await exit_code(other, 20000, '.cmd без своей папки'), failed_code, '.cmd без своей папки; вывод: ' + other.output())
        assert.match(other.output(), /Распакуйте весь архив в папку и запустите «Мастер настройки\.cmd» оттуда\./, other.output())
        other = start_cmd(root, ['-Port', '0'])
        assert.equal(await exit_code(other, 20000, '.cmd при сбое PowerShell'), failed_code, '.cmd при сбое PowerShell; вывод: ' + other.output())
        assert.match(other.output(), /Мастер настройки завершился с ошибкой \(код 1\) — причина в сообщении выше\./, other.output())

        // Чужой сервер на всех адресах (listen без host — двойной стек): Start() на 127.0.0.1 его не заметил бы — находит
        // пробное подключение; на /TuneWizard/ отвечает не мастер — отказ; .cmd — тот же код и не ждёт второй раз
        const foreign_paths = []
        foreign = await listen((req, res) => {
            foreign_paths.push(req.url)
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end('<!doctype html><title>Другая программа</title>')
        }, undefined)
        other = start_serve(['-Port', String(port)])
        assert.equal(await exit_code(other, 20000, 'порт занят чужим сервером'), refused_code, 'порт занят чужим — отказ; вывод: ' + other.output())
        assert.match(other.output(), /Порт 8797 занят другой программой — закройте её и запустите мастер снова\./, other.output())
        assert.deepEqual(foreign_paths, ['/TuneWizard/'], 'сервер проверил, мастер ли на порту')
        other = start_cmd(root, ['-Port', String(port), '-NoBrowser'])
        assert.equal(await exit_code(other, 20000, '.cmd на порту чужого сервера'), refused_code, '.cmd — код отказа; вывод: ' + other.output())
        assert.ok(other.output().includes('занят другой программой') && !other.output().includes('завершился с ошибкой'), '.cmd второй раз не ждёт: ' + other.output())
        await new Promise((resolve) => foreign.close(resolve))
        foreign = null

        // Мастер без X-TuneWizard-Root (как python -m http.server из VS Code) — открыть вкладку, код 0
        const page_html = fs.readFileSync(path.join(root, 'TuneWizard', 'index.html'))
        foreign = await listen((req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/html' })
            res.end(page_html)
        }, '127.0.0.1')
        other = start_serve(['-Port', String(port)])
        assert.equal(await exit_code(other, 20000, 'мастер без заголовка корня'), 0, 'мастер без X-TuneWizard-Root — код 0; вывод: ' + other.output())
        assert.match(other.output(), /Мастер настройки уже запущен/, other.output())
        await new Promise((resolve) => foreign.close(resolve))
        foreign = null

        // Запуск после остановки (порт снова свой) — на второй папке: корень без index.html — 301 на мастер; файл,
        // заблокированный другим процессом, — 500 и строка в консоли, сервер работает дальше
        locker = lock_file(path.join(tmp, 'TuneWizard', 'locked.js'))
        await locker.ready
        const t_restart = Date.now()
        server = start_serve(['-Root', tmp, '-Port', String(port)])
        await wait_ready(server)
        const restart_s = (Date.now() - t_restart) / 1000
        const top = await request('/')
        assert.deepEqual([top.status, top.headers.location], [301, '/TuneWizard/'], 'корень без index.html — 301 на мастер')
        assert.equal((await request('/TuneWizard/locked.js')).status, 500, 'заблокированный файл — 500')
        const error_line = 'Ошибка запроса «GET /TuneWizard/locked.js HTTP/1.1»: '
        for (let i = 0; (i < 20) && !server.output().includes(error_line); i++) {
            await sleep(100)
        }
        assert.ok(server.output().includes(error_line), 'строка об ошибке в консоли: ' + server.output())
        assert.equal((await request('/TuneWizard/')).status, 200, 'после 500 сервер работает')
        await stop_serve(server)
        server = null
        locker.proc.stdin.end()
        await within(locker.exited, 5000)

        console.log('tunewizard-serve: сервер PowerShell проверен за ' + ((Date.now() - started) / 1000).toFixed(1) + ' с, корень ' + root)
        console.log('  HTTP-проверок: ' + checked + '; мастер в Chrome — load за ' + page.load_ms + ' мс, запросов к серверу ' + page.requests +
            ', групп описаний параметров ' + page.metadata + '; подготовка — «' + page.prep_verdict + '»; FilterReview и PIDReview открылись')
        console.log('  порт с мастером этой папки — код 0 (serve.ps1 за ' + second_s.toFixed(1) + ' с и .cmd), другой папки — ' + refused_code +
            '; чужой сервер на всех адресах — ' + refused_code + '; .cmd без папки и при сбое PowerShell — ' + failed_code + '; запуск после остановки — ' +
            restart_s.toFixed(1) + ' с, 500 на заблокированном файле')
    } catch (e) {
        if (problems.length) {
            console.error('Сообщения консоли:', problems)
        }
        throw e
    } finally {
        // Сбой одной остановки не должен оставить остальные процессы, порт и временную папку
        for (const s of [server, other, locker]) {
            try {
                await stop_serve(s)
            } catch {
            }
        }
        if (foreign) {
            foreign.close()
        }
        if (tmp) {
            fs.rmSync(tmp, { recursive: true, force: true })
        }
    }
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
