# Сервер мастера настройки для Windows: двойной клик по «Мастер настройки.cmd» запускает этот скрипт и открывает мастер
# в браузере. Мастеру нужен адрес http://: со страницы file:// Chrome не загружает ES-модуль парсера логов
# (modules/JsDataflashParser/parser.js) и описания параметров (fetch FilterReview/params.json).
# Сервер — System.Net.Sockets.TcpListener на петлевом адресе 127.0.0.1: без прав администратора (HttpListener нужен
# netsh http add urlacl) и без окна брандмауэра. Отдаются только файлы внутри корня, методы GET и HEAD, только по
# адресу 127.0.0.1 или localhost (заголовок Host — защита от DNS rebinding: в корне репозитория лежат логи пилота и
# .git). Запросы — по одному, но соединения ждут запроса без блокировки (Socket.Select): пустое соединение (Chrome
# открывает их заранее) или недописанный запрос не задерживают остальные и закрываются через 15 с. Медленный читатель
# ответа задерживает остальных до SendTimeout (15 с) — браузер на петлевом адресе читает сразу.
# Порт занят мастером из этой же папки (или python -m http.server из VS Code — без заголовка X-TuneWizard-Root) —
# открыть вкладку и выйти с кодом 0; мастером из другой папки или чужой программой — сообщение и код 2: другой порт не
# берётся, память прохода привязана к адресу страницы. Коды выхода: 0 — мастер работает или вкладка открыта; 2 — отказ
# с сообщением (в интерактивной консоли сервер уже дождался клавиши, «Мастер настройки.cmd» второй раз не ждёт); прочие
# (1 — сбой PowerShell, например параметр или политика) — .cmd оставляет окно открытым.
# Файл — UTF-8 с BOM: без BOM PowerShell 5.1 читает русский текст как ANSI.
# Параметры: -Root — корень (по умолчанию два уровня выше скрипта: репозиторий или переносная папка), -Port (8000),
# -NoBrowser — не открывать браузер (тест tests/tunewizard-serve.cjs).
param(
    [string]$Root = '',
    [ValidateRange(1, 65535)][int]$Port = 8000,
    [switch]$NoBrowser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $Root) {
    $Root = Join-Path $PSScriptRoot '..\..'
}

# Типы файлов по расширению; .js — обязательно text/javascript: модуль с другим типом браузер не загрузит
$types = @{
    '.html' = 'text/html; charset=utf-8'; '.htm' = 'text/html; charset=utf-8'
    '.js' = 'text/javascript; charset=utf-8'; '.mjs' = 'text/javascript; charset=utf-8'
    '.json' = 'application/json'; '.css' = 'text/css'
    '.png' = 'image/png'; '.ico' = 'image/x-icon'; '.svg' = 'image/svg+xml'; '.gif' = 'image/gif'; '.jpg' = 'image/jpeg'; '.jpeg' = 'image/jpeg'
    '.map' = 'text/plain; charset=utf-8'; '.txt' = 'text/plain; charset=utf-8'; '.param' = 'text/plain; charset=utf-8'
}
$reasons = @{ 200 = 'OK'; 301 = 'Moved Permanently'; 400 = 'Bad Request'; 403 = 'Forbidden'; 404 = 'Not Found'; 405 = 'Method Not Allowed'
              431 = 'Request Header Fields Too Large'; 500 = 'Internal Server Error' }
$error_texts = @{ 400 = 'Неверный запрос.'; 403 = 'Доступ запрещён: отдаются только файлы папки мастера по адресу 127.0.0.1 или localhost.'; 404 = 'Файл не найден.'
                  405 = 'Метод не поддерживается: только GET и HEAD.'; 431 = 'Слишком длинный запрос.'; 500 = 'Ошибка сервера — подробности в окне консоли.' }
# Знаки, недопустимые в имени файла Windows (двоеточие абсолютного пути «C:», NUL, «*», «<» …); косые черты — разделители
[char[]]$bad_name_chars = [IO.Path]::GetInvalidFileNameChars() | Where-Object { ($_ -ne [char]'/') -and ($_ -ne [char]'\') }
# Заголовок запроса ищется в байтах как в тексте Latin-1 (байт — знак), строка запроса читается как UTF-8
$latin1 = [Text.Encoding]::GetEncoding(28591)
# Имена устройств Windows (NUL, CON, COM1 …, в том числе с расширением): файлом не открываются — 403
$device_name = '^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$'
# Пустое соединение или незаконченный заголовок дольше этого — закрыть; заголовок запроса длиннее head_limit — 431
$idle_seconds = 15
$head_limit = 65536
# Код выхода при отказе с сообщением (порт занят, нет страницы мастера) — «Мастер настройки.cmd» второй раз не ждёт
$refused_code = 2
# Начат ли ответ на текущий запрос: после заголовков ответа 500 уже не отправить
$script:response_started = $false
$script:stdout = $null

# Строка в консоль. В окне — Write-Host (консоль выводит Юникод при любой кодовой странице); вывод перенаправлен (тест)
# — байты UTF-8 прямо в stdout, без смены кодовой страницы консоли. Color — цвет в окне (пусто — обычный)
function Write-Line([string]$Text, [string]$Color = '') {
    if ([Console]::IsOutputRedirected) {
        if ($null -eq $script:stdout) {
            $script:stdout = [Console]::OpenStandardOutput()
        }
        $bytes = [Text.Encoding]::UTF8.GetBytes($Text + "`n")
        $script:stdout.Write($bytes, 0, $bytes.Length)
        $script:stdout.Flush()
    } elseif ($Color) {
        Write-Host $Text -ForegroundColor $Color
    } else {
        Write-Host $Text
    }
}

# Ждать клавишу, чтобы окно не закрылось до прочтения сообщения, — только если консоль интерактивна и ввод не
# перенаправлен (в тесте ждать нельзя)
function Wait-Key {
    if ([Environment]::UserInteractive -and (-not [Console]::IsInputRedirected)) {
        Write-Line 'Нажмите любую клавишу, чтобы закрыть окно.'
        try {
            [void][Console]::ReadKey($true)
        } catch {
        }
    }
}

# Сообщение об отказе запуска, ожидание клавиши и выход с кодом отказа (refused_code)
function Exit-Refused([string]$Text) {
    Write-Line $Text 'Yellow'
    Wait-Key
    exit $refused_code
}

# Открыть адрес в браузере по умолчанию (не при -NoBrowser); не вышло — адрес для ручного ввода
function Open-Wizard([string]$Url) {
    if ($NoBrowser) {
        return
    }
    try {
        Start-Process $Url
    } catch {
        Write-Line ('Не удалось открыть браузер — откройте адрес вручную: ' + $Url) 'Yellow'
    }
}

# Слушает ли кто-то 127.0.0.1:Port — пробное подключение не дольше 0.5 с. Нужно до Start(): программа, которая
# слушает все адреса (0.0.0.0, ::, python -m http.server без --bind), не мешает занять 127.0.0.1, и второй сервер
# перехватил бы адрес
function Test-PortBusy([int]$Port) {
    $client = New-Object Net.Sockets.TcpClient
    try {
        $connect = $client.BeginConnect([Net.IPAddress]::Loopback, $Port, $null, $null)
        if (-not $connect.AsyncWaitHandle.WaitOne(500)) {
            return $false
        }
        $client.EndConnect($connect)
        return $true
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

# Мастер ли отвечает по адресу Url (<title>Мастер настройки) и из какой папки: @{ Wizard = $true/$false; Root = полный
# путь корня из заголовка X-TuneWizard-Root или $null — заголовка нет (python http.server). Ответ читается как UTF-8 —
# python не пишет charset, а Invoke-WebRequest тогда читал бы русский текст как Latin-1; без прокси — адрес петлевой
function Get-WizardOnPort([string]$Url) {
    $none = @{ Wizard = $false; Root = $null }
    try {
        $request = [Net.HttpWebRequest]::Create($Url)
        $request.Proxy = $null
        $request.KeepAlive = $false
        $request.Timeout = 5000
        $request.ReadWriteTimeout = 5000
        $response = $request.GetResponse()
        try {
            $reader = New-Object IO.StreamReader($response.GetResponseStream(), [Text.Encoding]::UTF8)
            if (-not $reader.ReadToEnd().Contains('<title>Мастер настройки')) {
                return $none
            }
            $root_header = $response.Headers['X-TuneWizard-Root']
            return @{ Wizard = $true; Root = $(if ($root_header) { [Uri]::UnescapeDataString($root_header) } else { $null }) }
        } finally {
            $response.Close()
        }
    } catch {
        return $none
    }
}

# Исключение сокета в цепочке ошибки (PowerShell оборачивает исключения методов .NET) или $null
function Get-SocketException($ErrorRecord) {
    $e = $ErrorRecord.Exception
    while ($null -ne $e) {
        if ($e -is [Net.Sockets.SocketException]) {
            return $e
        }
        $e = $e.InnerException
    }
    return $null
}

# Путь запроса → файл внутри корня. RawPath — путь из строки запроса без query и фрагмента, как прислал клиент
# (%-кодирование не снято), Query — «?…» или пусто (для адреса 301). Выход — @{ Status = 200; File = полный путь },
# @{ Status = 301; Location = … }, 403 или 404. 403: сегмент из одних точек («..», в том числе %2e%2e), недопустимый
# в имени файла знак (двоеточие абсолютного пути и «::$DATA», NUL), имя устройства (NUL, CON …) или путь после
# нормализации вне корня; обратная косая черта — разделитель, как прямая, пустые сегменты и «.» отбрасываются.
# Папка — её index.html, без косой черты в конце — 301 на адрес с ней (иначе относительные ссылки страницы сломаются);
# адрес 301 собирается из нормализованных сегментов (не из сырого пути: «//TuneWizard» дал бы «//TuneWizard/» — адрес
# другого сайта). Корень без index.html (переносная папка) — 301 на /TuneWizard/
function Resolve-RequestFile([string]$RawPath, [string]$Query) {
    $decoded = [Uri]::UnescapeDataString($RawPath).Replace('\', '/')
    $segments = @($decoded.Split('/') | Where-Object { ($_ -ne '') -and ($_ -ne '.') })
    foreach ($segment in $segments) {
        $dots_only = (($segment -replace '[. ]', '') -eq '') -and (($segment -replace '[^.]', '').Length -ge 2)
        if ($dots_only -or ($segment.IndexOfAny($bad_name_chars) -ge 0) -or ($segment.TrimEnd('. ') -match $device_name)) {
            return @{ Status = 403 }
        }
    }
    if (($segments.Count -eq 0) -and (-not [IO.File]::Exists($root_prefix + 'index.html'))) {
        return @{ Status = 301; Location = '/TuneWizard/' }
    }
    try {
        $full = [IO.Path]::GetFullPath($root_full + '\' + ($segments -join '\'))
    } catch {
        return @{ Status = 403 }
    }
    if (-not ($full.TrimEnd('\') + '\').StartsWith($root_prefix, [StringComparison]::OrdinalIgnoreCase)) {
        return @{ Status = 403 }
    }
    if ([IO.Directory]::Exists($full)) {
        if (-not $RawPath.EndsWith('/')) {
            # Корень («/%2e») — «/», а не «//»
            $joined = ($segments | ForEach-Object { [Uri]::EscapeDataString($_) }) -join '/'
            $location = $(if ($joined) { '/' + $joined + '/' } else { '/' }) + $Query
            return @{ Status = 301; Location = $location }
        }
        $full = [IO.Path]::Combine($full, 'index.html')
    }
    if (-not [IO.File]::Exists($full)) {
        return @{ Status = 404 }
    }
    return @{ Status = 200; File = $full }
}

# Ответ: строка состояния и заголовки (Content-Length; Cache-Control: no-cache — правки файлов видны без очистки кэша;
# Connection: close — одно соединение на запрос; X-TuneWizard-Root — корень в %-кодировании, по нему второй запуск
# отличает мастер из другой папки; Extra — строки дополнительных заголовков), затем тело — байты Body или файл File
# (открывается до заголовков: не открылся — ещё можно ответить 500); при HeadOnly тело не отправляется
function Send-Response($Socket, [int]$Status, [string]$Type, [byte[]]$Body = $null, [string]$File = '', [string[]]$Extra = @(), [bool]$HeadOnly = $false) {
    $file_stream = $null
    $stream = New-Object Net.Sockets.NetworkStream($Socket, $false)
    try {
        if ($File) {
            $file_stream = New-Object IO.FileStream($File, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
            $length = $file_stream.Length
        } else {
            $length = if ($null -ne $Body) { $Body.Length } else { 0 }
        }
        # Запятая в PowerShell связывает сильнее «+» — каждая строка в скобках
        $lines = @(('HTTP/1.1 ' + $Status + ' ' + $reasons[$Status]), ('Content-Type: ' + $Type), ('Content-Length: ' + $length), 'Cache-Control: no-cache',
                   'Connection: close', ('X-TuneWizard-Root: ' + $root_header)) + $Extra
        $head = [Text.Encoding]::UTF8.GetBytes(($lines -join "`r`n") + "`r`n`r`n")
        $script:response_started = $true
        $stream.Write($head, 0, $head.Length)
        if (-not $HeadOnly) {
            if ($null -ne $file_stream) {
                $file_stream.CopyTo($stream, 65536)
            } elseif ($length -gt 0) {
                $stream.Write($Body, 0, $Body.Length)
            }
        }
        $stream.Flush()
    } finally {
        if ($null -ne $file_stream) {
            $file_stream.Dispose()
        }
        $stream.Dispose()
    }
}

# Ответ-ошибка: короткая страница с причиной по-русски (Text, по умолчанию — по коду) и ссылкой на мастер
function Send-Error($Socket, [int]$Status, [bool]$HeadOnly = $false, [string[]]$Extra = @(), [string]$Text = '') {
    if (-not $Text) {
        $Text = $error_texts[$Status]
    }
    $html = '<!doctype html><meta charset="utf-8"><title>' + $Status + '</title><p>' + $Status + ' — ' + $Text +
            '</p><p><a href="/TuneWizard/">Мастер настройки</a></p>'
    Send-Response -Socket $Socket -Status $Status -Type 'text/html; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($html)) -Extra $Extra -HeadOnly $HeadOnly
}

# Подходит ли заголовок Host: нет его или пусто (HTTP/1.0), 127.0.0.1:порт или localhost:порт без учёта регистра.
# Другое имя — страница чужого сайта, имя которого указали на 127.0.0.1 (DNS rebinding), — отказ
function Test-HostHeader([string[]]$Lines) {
    foreach ($line in $Lines) {
        $colon = $line.IndexOf(':')
        if (($colon -gt 0) -and ($line.Substring(0, $colon).Trim() -eq 'Host')) {
            $value = $line.Substring($colon + 1).Trim()
            if (($value -ne '') -and ($value -ne ('127.0.0.1:' + $Port)) -and ($value -ne ('localhost:' + $Port))) {
                return $false
            }
        }
    }
    return $true
}

# Один запрос по заголовку Head (текст до пустой строки): строка запроса — метод, путь, версия; из остальных заголовков
# нужен только Host. Путь — без query и фрагмента; путь не от корня (адрес прокси «http://…», «*») или с управляющими
# знаками — 400; Host не 127.0.0.1 и не localhost — 403
function Invoke-Request($Socket, [string]$Head) {
    $head_lines = @($Head.Split("`n") | ForEach-Object { $_.TrimEnd("`r") })
    $parts = $head_lines[0].Split(' ')
    if (($parts.Count -ne 3) -or (-not $parts[1].StartsWith('/')) -or ($parts[1] -match '[\x00-\x1f\x7f]') -or (-not $parts[2].StartsWith('HTTP/'))) {
        Send-Error $Socket 400
        return
    }
    if (-not (Test-HostHeader ($head_lines | Select-Object -Skip 1))) {
        Send-Error $Socket 403 -Text 'Доступ запрещён: мастер открывается только по адресу 127.0.0.1 или localhost.'
        return
    }
    $head_only = $parts[0] -ceq 'HEAD'
    if (($parts[0] -cne 'GET') -and (-not $head_only)) {
        Send-Error $Socket 405 -Extra @('Allow: GET, HEAD')
        return
    }
    $target = $parts[1]
    $raw_path = $target
    $query = ''
    $cut = $target.IndexOfAny([char[]]@('?', '#'))
    if ($cut -ge 0) {
        $raw_path = $target.Substring(0, $cut)
        if ($target[$cut] -eq [char]'?') {
            $query = $target.Substring($cut).Split('#')[0]
        }
    }
    $result = Resolve-RequestFile $raw_path $query
    if ($result.Status -eq 200) {
        $type = $types[[IO.Path]::GetExtension($result.File)]
        if ($null -eq $type) {
            $type = 'application/octet-stream'
        }
        Send-Response -Socket $Socket -Status 200 -Type $type -File $result.File -HeadOnly $head_only
    } elseif ($result.Status -eq 301) {
        $html = '<!doctype html><meta charset="utf-8"><a href="' + [Net.WebUtility]::HtmlEncode($result.Location) + '">' + [Net.WebUtility]::HtmlEncode($result.Location) + '</a>'
        Send-Response -Socket $Socket -Status 301 -Type 'text/html; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($html)) -Extra @('Location: ' + $result.Location) -HeadOnly $head_only
    } else {
        Send-Error $Socket $result.Status $head_only
    }
}

# Ответить на запрос с перехватом: клиент ушёл (сбой сокета) — молча; другая ошибка — строка в консоли и 500, если
# ответ ещё не начат. Сервер работает дальше
function Invoke-RequestSafe($Socket, [string]$Head) {
    $script:response_started = $false
    try {
        Invoke-Request $Socket $Head
    } catch {
        if ($null -ne (Get-SocketException $_)) {
            return
        }
        # Причина — из исходного исключения .NET, без обёртки PowerShell «Исключение при вызове …»
        $cause = $_.Exception
        while ($null -ne $cause.InnerException) {
            $cause = $cause.InnerException
        }
        $line = $Head.Split("`n")[0].TrimEnd("`r")
        Write-Line ('Ошибка запроса «' + $line + '»: ' + $cause.Message) 'Red'
        if (-not $script:response_started) {
            try {
                Send-Error $Socket 500
            } catch {
            }
        }
    }
}

# Закрыть соединение: сначала конец передачи (FIN после всех данных ответа), затем сокет
function Close-Connection($Socket) {
    try {
        $Socket.Shutdown([Net.Sockets.SocketShutdown]::Send)
    } catch {
    }
    try {
        $Socket.Close()
    } catch {
    }
}

# Дочитать пришедшие байты соединения Connection (без ожидания: Select сказал, что они есть). Заголовок запроса
# целиком — ответить; клиент закрыл соединение, сбой или заголовок длиннее head_limit (431) — закрыть. Законченное
# соединение — Done = $true
function Receive-Head($Connection) {
    $socket = $Connection.Socket
    $end = -1
    try {
        $count = [Math]::Min($socket.Available, $head_limit + 1)
        if ($count -le 0) {
            $Connection.Done = $true
        } else {
            $buffer = New-Object byte[] $count
            $got = $socket.Receive($buffer)
            $Connection.Data.Write($buffer, 0, $got)
            $text = $latin1.GetString($Connection.Data.GetBuffer(), 0, [int]$Connection.Data.Length)
            $end = $text.IndexOf("`r`n`r`n")
            if ($end -lt 0) {
                $end = $text.IndexOf("`n`n")
            }
            # Длина заголовка — и когда конец уже пришёл (заголовок мог прийти за несколько чтений), и пока его нет
            if ((($end -lt 0) -and ($Connection.Data.Length -gt $head_limit)) -or ($end -gt $head_limit)) {
                $Connection.Done = $true
                Send-Error $socket 431
            }
        }
    } catch {
        $Connection.Done = $true
    }
    if ((-not $Connection.Done) -and ($end -ge 0)) {
        $Connection.Done = $true
        Invoke-RequestSafe $socket ([Text.Encoding]::UTF8.GetString($Connection.Data.GetBuffer(), 0, $end))
    }
    if ($Connection.Done) {
        Close-Connection $socket
    }
}

# ---------- Запуск ----------

$root_full = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
$root_prefix = $root_full + '\'
# Корень в заголовке ответа — в %-кодировании: заголовок HTTP только латиница, а путь бывает с кириллицей
$root_header = [Uri]::EscapeDataString($root_full)
$url = 'http://127.0.0.1:' + $Port + '/TuneWizard/'
if (-not [Console]::IsOutputRedirected) {
    try {
        $Host.UI.RawUI.WindowTitle = 'Мастер настройки — 127.0.0.1:' + $Port
    } catch {
    }
}
if (-not [IO.File]::Exists($root_prefix + 'TuneWizard\index.html')) {
    Exit-Refused ('Не найдена страница мастера: ' + $root_prefix + 'TuneWizard\index.html — запускайте «Мастер настройки.cmd» из его папки.')
}

$listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $Port)
$busy = Test-PortBusy $Port
$start_error = $null
if (-not $busy) {
    try {
        $listener.Start()
    } catch {
        $start_error = $_
    }
}
if ($busy -or ($null -ne $start_error)) {
    # Порт занят: мастером из этой папки (или без заголовка корня — python http.server) — открыть вкладку, второй
    # сервер не нужен; мастером из другой папки или чужой программой — отказ
    $wizard = Get-WizardOnPort $url
    if ($wizard.Wizard) {
        if (($null -eq $wizard.Root) -or ($wizard.Root -eq $root_full)) {
            Write-Line ('Мастер настройки уже запущен: ' + $url)
            Open-Wizard $url
            exit 0
        }
        Exit-Refused ('На порту ' + $Port + ' уже работает мастер из другой папки: ' + $wizard.Root + '. Закройте его окно и запустите снова.')
    }
    $socket_error = $(if ($null -ne $start_error) { Get-SocketException $start_error } else { $null })
    if ($busy -or (($null -ne $socket_error) -and ($socket_error.SocketErrorCode -eq [Net.Sockets.SocketError]::AddressAlreadyInUse))) {
        Exit-Refused ('Порт ' + $Port + ' занят другой программой — закройте её и запустите мастер снова.')
    }
    Exit-Refused ('Порт ' + $Port + ' недоступен: ' + $start_error.Exception.Message)
}

# Соединения, ждущие запроса: сокет, пришедшие байты, время приёма, закончено ли
$connections = New-Object Collections.Generic.List[object]
try {
    Write-Line ''
    if ($NoBrowser) {
        Write-Line ('Мастер настройки: ' + $url) 'Green'
    } else {
        Write-Line ('Мастер настройки открыт в браузере: ' + $url) 'Green'
    }
    Write-Line ('Папка: ' + $root_full)
    Write-Line 'Чтобы остановить — закройте это окно.'
    Open-Wizard $url
    while ($true) {
        # Ждать не дольше 0.25 с: между ожиданиями PowerShell обрабатывает Ctrl+C
        $readable = New-Object Collections.ArrayList
        [void]$readable.Add($listener.Server)
        foreach ($connection in $connections) {
            [void]$readable.Add($connection.Socket)
        }
        [Net.Sockets.Socket]::Select($readable, $null, $null, 250000)
        if ($readable.Contains($listener.Server)) {
            while ($listener.Pending()) {
                $socket = $listener.AcceptSocket()
                $socket.SendTimeout = 15000
                $socket.NoDelay = $true
                $connections.Add([pscustomobject]@{ Socket = $socket; Data = (New-Object IO.MemoryStream); Since = [DateTime]::UtcNow; Done = $false })
            }
        }
        $now = [DateTime]::UtcNow
        foreach ($connection in $connections.ToArray()) {
            if ($readable.Contains($connection.Socket)) {
                Receive-Head $connection
            } elseif (($now - $connection.Since).TotalSeconds -gt $idle_seconds) {
                $connection.Done = $true
                Close-Connection $connection.Socket
            }
            if ($connection.Done) {
                [void]$connections.Remove($connection)
            }
        }
    }
} finally {
    # Ctrl+C: закрыть соединения и порт (закрытие окна завершает процесс — порт освобождает Windows)
    foreach ($connection in $connections) {
        Close-Connection $connection.Socket
    }
    $listener.Stop()
    Write-Line 'Сервер мастера настройки остановлен.'
}
