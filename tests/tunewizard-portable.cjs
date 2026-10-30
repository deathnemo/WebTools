// Сборка переносной папки мастера настройки для других пилотов (этап 8): «Мастер настройки <ГГГГ-ММ-ДД> <коммит>/» и
// zip того же имени рядом. Пилоту не нужны ни репозиторий, ни Python: двойной клик по «Мастер настройки.cmd» в папке
// поднимает сервер TuneWizard/windows/serve.ps1 (PowerShell 5.1) и открывает мастер в браузере.
// Запуск: npm run tunewizard:portable [-- --out <папка>] — вручную, в обычные проверки не входит (как скрипт иконки).
// Выход — dist/ репозитория (в .gitignore) или папка --out; прежняя сборка с тем же именем удаляется и собирается
// заново. Нужны: Windows (powershell.exe — архив через Compress-Archive) и git (версия — коммит HEAD).
//
// Состав — списки ниже: TuneWizard/ без logs/ (логи пилота), FilterReview/ и PIDReview/ целиком (кнопки «Открыть в …»
// работают без интернета), из Libraries/, modules/ и images/ — только файлы, на которые ссылаются три страницы и их
// скрипты; в корне — «Мастер настройки.cmd» (CRLF: в git он с LF) и «Прочитай меня.txt» (текст — здесь; UTF-8 с BOM и
// CRLF, чтобы Блокнот любой Windows показал кириллицу). Файлы копируются, а не ссылки: символьная ссылка или junction в
// составе — ошибка сборки. После копирования — проверка ссылок собранной папки: у каждого относительного src/href трёх
// страниц и у каждого строкового import('…'), fetch("…"), load_param_inputs("…"), step_open_in("…") в их скриптах и
// скриптах TuneWizard/ должен быть файл — иначе ошибка с перечнем (защита от «забыли новый файл»; внешние http(s)://,
// «#…», data: пропускаются). Незакоммиченные изменения в файлах состава (и в этом скрипте — он пишет «Прочитай меня») —
// предупреждение и «+изменения» в версии и имени.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const repo = path.resolve(__dirname, '..')
const title = 'Мастер настройки'
const launcher_name = 'Мастер настройки.cmd'
const readme_name = 'Прочитай меня.txt'
const address = 'http://127.0.0.1:8000/TuneWizard/'
// Пометка версии при незакоммиченных изменениях в файлах состава
const dirty_mark = '+изменения'
// Папки целиком (пути от корня репозитория через «/») и исключённое из них
const whole_dirs = ['TuneWizard', 'FilterReview', 'PIDReview']
const excluded = ['TuneWizard/logs']
// Отдельные файлы — то, на что ссылаются страницы мастера, FilterReview и PIDReview (сверяется проверкой ссылок)
const single_files = [
    // Общие скрипты WebTools (теги <script> страниц)
    'Libraries/Array_Math.js',
    'Libraries/DecodeDevID.js',
    'Libraries/FileSaver.js',
    'Libraries/LoadingOverlay.js',
    'Libraries/LogHelpers.js',
    'Libraries/OpenIn.js',
    'Libraries/Param_Helpers.js',
    'Libraries/ParameterMetadata.js',
    'Libraries/Plotly_helpers.js',
    'Libraries/fft.js',
    // Парсер логов (ES-модуль, import из wizard.js, FilterReview.js, PIDReview.js), графики, FFT, всплывающие подсказки
    // FilterReview и PIDReview
    'modules/JsDataflashParser/parser.js',
    'modules/plotly.js/dist/plotly.min.js',
    'modules/fft.js/dist/fft.js',
    'modules/build/floating-ui/dist/umd/popper.min.js',
    'modules/build/tippyjs/dist/tippy-bundle.umd.min.js',
    // Значок вкладки, шапка FilterReview и PIDReview, знак подсказки
    'images/AP_favicon.png',
    'images/ArduPilot.png',
    'images/GitHub_Logo.png',
    'images/github-mark.png',
    'images/question-circle.svg',
]
// Страницы, ссылки которых проверяются после сборки
const pages = ['TuneWizard/index.html', 'FilterReview/index.html', 'PIDReview/index.html']
// Чего в собранной папке быть не должно (имя любой папки пути)
const forbidden_dirs = ['logs', '.git', 'node_modules', 'tests']

// Аргументы командной строки → { out } (папка выхода или null — dist/ репозитория); неизвестный аргумент — ошибка
function parse_args(argv) {
    const args = { out: null }
    for (let i = 0; i < argv.length; i++) {
        if ((argv[i] === '--out') && (i + 1 < argv.length)) {
            args.out = argv[++i]
        } else {
            throw new Error('неизвестный аргумент «' + argv[i] + '»; запуск: node tests/tunewizard-portable.cjs [--out <папка>]')
        }
    }
    return args
}

// Команда git в репозитории → вывод без концевых пробелов; имена файлов — как есть (без \-кодирования кириллицы)
function git(args) {
    return execFileSync('git', ['-C', repo, '-c', 'core.quotepath=false', ...args], { encoding: 'utf8' }).trimEnd()
}

// Путь от корня репозитория через «/» → полный путь
function full(rel) {
    return path.join(repo, ...rel.split('/'))
}

// Ни одна папка пути rel (от корня репозитория) и сам файл не символьная ссылка и не junction (lstat Node на Windows
// считает junction ссылкой): копия взяла бы файлы из чужой папки, а удаление — стёрло бы цель (журнал, раздел 8)
function check_not_link(rel) {
    const parts = rel.split('/')
    for (let i = 1; i <= parts.length; i++) {
        const sub = parts.slice(0, i).join('/')
        if (fs.lstatSync(full(sub)).isSymbolicLink()) {
            throw new Error('в составе символьная ссылка или junction: ' + sub + ' — копируются только настоящие файлы и папки')
        }
    }
}

// Файлы папки rel (от корня репозитория) рекурсивно, кроме excluded → пути от корня через «/»; ссылка или junction —
// ошибка, прочее (не файл и не папка) — тоже
function walk(rel, out) {
    for (const entry of fs.readdirSync(full(rel)).sort()) {
        const sub = rel + '/' + entry
        if (excluded.includes(sub)) {
            continue
        }
        const stat = fs.lstatSync(full(sub))
        if (stat.isSymbolicLink()) {
            throw new Error('в составе символьная ссылка или junction: ' + sub + ' — копируются только настоящие файлы и папки')
        } else if (stat.isDirectory()) {
            walk(sub, out)
        } else if (stat.isFile()) {
            out.push(sub)
        } else {
            throw new Error('в составе не файл и не папка: ' + sub)
        }
    }
    return out
}

// Состав (без файлов, которые сборка пишет сама) → пути от корня через «/»; нет файла списка — ошибка с подсказкой
function collect() {
    const files = []
    for (const dir of whole_dirs) {
        check_not_link(dir)
        walk(dir, files)
    }
    for (const rel of single_files) {
        if (!fs.existsSync(full(rel))) {
            const hint = rel.startsWith('modules/') ? ' (подмодули: git submodule update --init)' : ''
            throw new Error('нет файла состава в репозитории: ' + rel + hint)
        }
        check_not_link(rel)
        files.push(rel)
    }
    check_not_link(launcher_name)
    return files
}

// Незакоммиченные изменения в файлах состава → строки git status (пусто — нет). Файлы подмодулей проверяются по папке
// подмодуля (git status пути внутри подмодуля не видит): изменённые файлы или другой коммит подмодуля; неотслеживаемые
// файлы подмодулей не считаются
function changes() {
    const submodules = fs.existsSync(full('.gitmodules'))
        ? git(['config', '-f', '.gitmodules', '--get-regexp', 'path']).split('\n').map((line) => line.split(' ').slice(1).join(' '))
        : []
    const paths = new Set([...whole_dirs, launcher_name, path.relative(repo, __filename).split(path.sep).join('/')])
    for (const rel of single_files) {
        paths.add(submodules.find((sub) => rel.startsWith(sub + '/')) ?? rel)
    }
    const status = git(['status', '--porcelain', '--ignore-submodules=untracked', '--', ...paths])
    return status ? status.split('\n') : []
}

// Сегодняшняя дата ГГГГ-ММ-ДД по местному времени
function today() {
    const now = new Date()
    return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0')
}

// Удалить прежнюю сборку target (папку или файл), только если она прямо внутри папки выхода out; ссылку не удалять —
// удаление могло бы задеть её цель
function remove_old(out, target) {
    const rel = path.relative(out, target)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) {
        throw new Error('удаление вне папки выхода запрещено: ' + target)
    }
    if (!fs.existsSync(target)) {
        return
    }
    if (fs.lstatSync(target).isSymbolicLink()) {
        throw new Error('на месте сборки символьная ссылка или junction — удалите её вручную: ' + target)
    }
    fs.rmSync(target, { recursive: true, force: true })
}

// «Мастер настройки.cmd» в папку dir: UTF-8 без BOM, концы строк CRLF (cmd читает файл построчно; в git он с LF)
function write_launcher(dir) {
    const bytes = fs.readFileSync(full(launcher_name))
    if (bytes.subarray(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF]))) {
        throw new Error(launcher_name + ' начинается с BOM — cmd прочитал бы его частью первой команды')
    }
    fs.writeFileSync(path.join(dir, launcher_name), bytes.toString('utf8').replace(/\r?\n/g, '\r\n'))
}

// Текст «Прочитай меня.txt» для версии version (строка «2026-10-30, коммит 810a5ff…»); строки — до 100 знаков: в
// старом Блокноте перенос по словам выключен
function readme_text(version) {
    return [
        'Мастер настройки (TuneWizard) — переносная папка',
        'Версия: ' + version,
        '',
        'ЧТО ЭТО',
        'Пошаговый мастер настройки ArduCopter по одному логу полёта .bin: проверки лога, спектр шума,',
        'гармонический notch, низкочастотные фильтры, PID по осям, сводка и файл .param. Мастер предлагает',
        'значения — вы подтверждаете. В папке есть и FilterReview с PIDReview из ArduPilot WebTools',
        '(кнопки «Открыть в …»). Всё работает на этом компьютере: лог никуда не отправляется, интернет',
        'не нужен (без него шрифты страницы — системные).',
        '',
        'КАК ЗАПУСТИТЬ',
        '1. Распакуйте весь архив в папку — файлы прямо из архива не запускаются.',
        '2. Дважды щёлкните «' + launcher_name + '». Откроется окно консоли, а мастер — в браузере по адресу',
        '   ' + address,
        '3. На шаге 0 выберите лог .bin.',
        '',
        'При первом запуске файла из интернета Windows может спросить «Запустить этот файл?» — нажмите',
        '«Запустить». Если появилось синее окно «Система Windows защитила ваш компьютер» — «Подробнее»,',
        'затем «Выполнить в любом случае». Чтобы Windows не спрашивала: до распаковки щёлкните архив правой',
        'кнопкой, «Свойства», отметьте «Разблокировать», «ОК».',
        '',
        'КАК ОСТАНОВИТЬ',
        'Закройте окно консоли — мастер остановится: открытая вкладка перестанет загружать файлы. Чтобы',
        'продолжить, снова запустите «' + launcher_name + '». Если окно уже открыто, повторный запуск',
        'просто откроет вкладку.',
        '',
        'БРАУЗЕР',
        'Нужен Google Chrome или Microsoft Edge. Мастер открывается в браузере, который выбран в Windows по',
        'умолчанию; если это другой браузер, откройте адрес ' + address + ' в Chrome',
        'или Edge вручную.',
        '',
        'ПАМЯТЬ ПРОХОДА',
        'Мастер запоминает прошлый проход каждого аппарата — в браузере, для адреса http://127.0.0.1:8000,',
        'а не в этой папке. Новая версия папки память видит; другой браузер или компьютер — нет. Очистка',
        'данных сайтов в браузере стирает и память.',
        '',
        'ЕСЛИ МАСТЕР НЕ ЗАПУСТИЛСЯ',
        '- «Порт 8000 занят другой программой» — закройте её и запустите мастер снова. Другой порт мастер',
        '  не берёт: память прохода привязана к адресу.',
        '- «Уже работает мастер из другой папки» — закройте окно консоли другой версии мастера.',
        '- «Распакуйте весь архив» — «' + launcher_name + '» запущен не из своей папки.',
        '',
    ].join('\r\n')
}

// «Прочитай меня.txt» в папку dir: UTF-8 с BOM, CRLF
function write_readme(dir, version) {
    fs.writeFileSync(path.join(dir, readme_name), Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(readme_text(version), 'utf8')]))
}

// Все файлы папки dir рекурсивно → [{ rel (через «/»), size }]
function list_files(dir, rel = '', out = []) {
    for (const entry of fs.readdirSync(path.join(dir, rel)).sort()) {
        const sub = rel ? rel + '/' + entry : entry
        const stat = fs.lstatSync(path.join(dir, sub))
        if (stat.isDirectory()) {
            list_files(dir, sub, out)
        } else {
            out.push({ rel: sub, size: stat.size })
        }
    }
    return out
}

// Ссылка ref со страницы или из скрипта, разрешённая от адреса base (путь от корня папки через «/», например
// «TuneWizard/index.html») → путь файла от корня папки, или null — ссылка не на файл папки (внешняя, «#…», data:,
// пустая). Папка («…/») — её index.html
function resolve_ref(ref, base) {
    const text = ref.trim()
    if (!text || text.startsWith('#') || text.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(text)) {
        return null
    }
    let target = decodeURIComponent(new URL(text, 'http://127.0.0.1/' + base).pathname).replace(/^\//, '')
    if (!target || target.endsWith('/')) {
        target += 'index.html'
    }
    return target
}

// Есть ли в собранной папке dir файл rel; папка без косой черты (сервер отвечает 301) — есть, если в ней index.html
function ref_exists(dir, rel) {
    const file = path.join(dir, ...rel.split('/'))
    if (!fs.existsSync(file)) {
        return false
    }
    return fs.statSync(file).isFile() || fs.existsSync(path.join(file, 'index.html'))
}

// Ссылки страницы html: значения src/href тегов (без комментариев и тела встроенных <script>/<style> — там «<» бывает
// не тегом) и src тегов <script> — скрипты страницы
function page_refs(html) {
    const text = html.replace(/<!--[\s\S]*?-->/g, '').replace(/(<(script|style)\b[^>]*>)[\s\S]*?(<\/\2\s*>)/gi, '$1$3')
    const refs = []
    const scripts = []
    for (const [tag] of text.matchAll(/<[a-z][^>]*>/gi)) {
        for (const m of tag.matchAll(/\s(src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
            const value = m[2] ?? m[3] ?? m[4]
            refs.push(value)
            if (/^<script\b/i.test(tag) && (m[1].toLowerCase() === 'src')) {
                scripts.push(value)
            }
        }
    }
    return { refs: refs, scripts: scripts }
}

// Строковые адреса в скрипте: import('…') — от адреса скрипта; fetch("…"), load_param_inputs("…") (грузит описания
// параметров), step_open_in("…") (открывает инструмент) — от адреса страницы. Только строка целиком (за ней «,» или
// «)»): начало адреса («"../x/" + name») и шаблон с ${…} — не адрес, пропуск
function script_refs(source) {
    const out = []
    for (const m of source.matchAll(/\b(import|fetch|load_param_inputs|step_open_in)\(\s*(["'`])([^"'`$]*)\2(?=\s*[,)])/g)) {
        out.push({ call: m[1], ref: m[3] })
    }
    return out
}

// Проверка ссылок собранной папки dir: страницы pages, их скрипты и все скрипты TuneWizard/ (страница —
// TuneWizard/index.html). Итог — { checked: число разных проверенных файлов, used: Set путей, missing: [строки без
// повторов — одна картинка-подсказка встречается на странице десятки раз] }
function check_links(dir) {
    const used = new Set()
    const missing = new Set()
    const scripts_seen = new Set()
    function check(ref, base, where) {
        const target = resolve_ref(ref, base)
        if (target == null) {
            return
        }
        used.add(target)
        if (!ref_exists(dir, target)) {
            missing.add(where + ': «' + ref + '» → ' + target)
        }
    }
    function check_script(script, page) {
        const key = script + ' ' + page
        if (scripts_seen.has(key) || !fs.existsSync(path.join(dir, ...script.split('/')))) {
            return
        }
        scripts_seen.add(key)
        for (const { call, ref } of script_refs(fs.readFileSync(path.join(dir, ...script.split('/')), 'utf8'))) {
            check(ref, (call === 'import') ? script : page, script + ' ' + call + '()')
        }
    }
    for (const page of pages) {
        const file = path.join(dir, ...page.split('/'))
        if (!fs.existsSync(file)) {
            missing.add('нет страницы ' + page)
            continue
        }
        const { refs, scripts } = page_refs(fs.readFileSync(file, 'utf8'))
        for (const ref of refs) {
            check(ref, page, page)
        }
        for (const src of scripts) {
            const script = resolve_ref(src, page)
            if (script != null) {
                check_script(script, page)
            }
        }
    }
    for (const { rel } of list_files(path.join(dir, 'TuneWizard'))) {
        if (rel.endsWith('.js')) {
            check_script('TuneWizard/' + rel, 'TuneWizard/index.html')
        }
    }
    return { checked: used.size, used: used, missing: [...missing] }
}

// Архив zip папки dir (папка — верхний уровень архива) через Compress-Archive PowerShell. Пути — через переменные
// окружения и -LiteralPath: кириллица и пробелы не требуют кавычек, «[ ]» не читаются как подстановка
function make_zip(dir, zip) {
    const command = "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; " +
        'Compress-Archive -LiteralPath $env:TW_PORTABLE_DIR -DestinationPath $env:TW_PORTABLE_ZIP -CompressionLevel Optimal'
    try {
        execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command],
                     { env: { ...process.env, TW_PORTABLE_DIR: dir, TW_PORTABLE_ZIP: zip }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
        throw new Error('Compress-Archive не создал архив ' + zip + ': ' + (e.stderr ? e.stderr.toString() : e.message))
    }
}

// Размер в мегабайтах (1 МБ = 1024² байт) с одним знаком
function mb(bytes) {
    return (bytes / 1048576).toFixed(1) + ' МБ'
}

function main() {
    if (process.platform !== 'win32') {
        throw new Error('сборка переносной папки — на Windows (архив через PowerShell Compress-Archive)')
    }
    const args = parse_args(process.argv.slice(2))
    const out = path.resolve(args.out ?? path.join(repo, 'dist'))
    // Папка выхода внутри папки состава попала бы в следующую сборку
    for (const rel of [...whole_dirs, 'Libraries', 'images', 'modules']) {
        const inside = path.relative(full(rel), out)
        if (!inside.startsWith('..') && !path.isAbsolute(inside)) {
            throw new Error('папка выхода внутри папки состава ' + rel + ': ' + out)
        }
    }

    const files = collect()
    const commit = git(['rev-parse', '--short', 'HEAD'])
    const dirty = changes()
    const date = today()
    const name = title + ' ' + date + ' ' + commit + (dirty.length ? dirty_mark : '')
    const version = date + ', коммит ' + commit + (dirty.length ? dirty_mark + ' (собрано с незакоммиченными правками)' : '')
    const target = path.join(out, name)
    const zip = target + '.zip'

    fs.mkdirSync(out, { recursive: true })
    remove_old(out, target)
    remove_old(out, zip)
    for (const rel of files) {
        const dest = path.join(target, ...rel.split('/'))
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.copyFileSync(full(rel), dest)
    }
    write_launcher(target)
    write_readme(target, version)

    // Проверки собранной папки; не прошли — папка удаляется, архива нет (такую папку раздавать нельзя)
    const built = list_files(target)
    const problems = built.filter(({ rel }) => rel.split('/').slice(0, -1).some((part) => forbidden_dirs.includes(part)))
        .map(({ rel }) => 'лишнее в папке: ' + rel)
    const links = check_links(target)
    problems.push(...links.missing.map((line) => 'ссылка без файла — ' + line))
    if (problems.length) {
        fs.rmSync(target, { recursive: true, force: true })
        throw new Error('сборка не прошла проверку, папка удалена:\n  ' + problems.join('\n  '))
    }
    const unused = single_files.filter((rel) => !links.used.has(rel))

    make_zip(target, zip)
    const size = built.reduce((sum, f) => sum + f.size, 0)
    if (dirty.length) {
        console.warn('Внимание: незакоммиченные изменения в файлах состава — в версии и имени «' + dirty_mark + '»:\n  ' + dirty.join('\n  '))
    }
    if (unused.length) {
        console.warn('Внимание: на эти файлы списка страницы не ссылаются — убрать из single_files?\n  ' + unused.join('\n  '))
    }
    console.log('tunewizard-portable: ' + target)
    console.log('  файлов ' + built.length + ', ' + mb(size) + '; архив ' + path.basename(zip) + ' — ' + mb(fs.statSync(zip).size))
    console.log('  ссылки страниц и скриптов: ' + links.checked + ' файлов, все на месте')
}

try {
    main()
} catch (e) {
    console.error('tunewizard-portable: ' + e.message)
    process.exit(1)
}
