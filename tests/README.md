# SimpleGCS protocol tests

`npm test` runs deterministic Node tests without external services. The
`fixtures/mavlink.json` wire bytes come from pymavlink, covering every telemetry
message consumed by SimpleGCS plus heartbeat, COMMAND_INT, COMMAND_ACK,
MISSION_ITEM_INT and FILE_TRANSFER_PROTOCOL. Signing fixtures have a fixed test
key/timestamp and are independent of deployment credentials.

`mavlink.test.cjs` checks encoding, fragmented/coalesced decoding, CRC recovery,
MAVLink 1/2, 64-bit fields, array payloads, SHA256, signatures and replay rejection.
`mavftp.test.cjs` passes real encoded MAVLink packets through an in-memory
vehicle and uses a fake clock for retries. It covers EOF/tail loss, reordered
and duplicate bursts, pipelined gap reads, partial replies, sequence wrap,
stale sessions, malformed replies, limits and reentrant completion.
`ftp_manager.test.cjs` covers serialization, disconnect/cancel, watchdogs and
late callbacks. `browser.cjs` exercises the real UI with signed simulated
telemetry and FTP replies, including circle rendering and mouse long-press.

Browser tests need `npm ci` and Playwright Chromium (or `CHROME_PATH` /
`SIMPLEGCS_CDP_URL`). They still load the page's external map/UI resources.
The live SITL procedure is documented in `SimpleGCS/README.md`; it requires an
explicitly selected simulator and relay and is not part of unattended tests.

`mavparam.test.cjs` checks packed defaults against independent Python/MAVProxy
fixtures, exact int32 values, malformed records, file formats, type validation,
search, resets, verified uploads, disconnect handling and offline definition
caching. `generate_params.py` regenerates its fixtures and requires MAVProxy.
FTP tests also cover acknowledged writes/closes and virtual files whose size is
only an estimate, including fixed-size recovery reads and lost final packets.
Browser tests exercise the parameter editor at desktop and phone viewport sizes,
including metadata search, edits, read-only fields, resets, file save/import,
and touch-operated bitmask controls.


PR review regressions additionally cover ArduPilot's cached burst replies with
loss and sequence wrap, the signing new-stream boundary and mixed-version
resynchronization. `commands.test.cjs` covers immediate sends, multiple
outstanding ACKs, denials, timeouts, progress and disconnect cancellation. Grid tests
compare CSS-pixel coordinates at DPR 1/2/3. Interaction tests cover mission
command/frame filtering, original sequence labels, stale fence/mission replies,
and both fingers remaining down during a cancelled hold.

The browser suite validates real popup exclusions and normal long press, force
command confirmation cancellation, stale-vehicle detection amid foreign relay
traffic, browser-valid stall close codes, signing replay rejection across
reconnect, connection drafts, and mouse/touch video dragging. The mock WebSocket
rejects invalid close codes. `npm run test:video` covers authenticated signaling,
hidden/closed player cleanup, native-HLS fallback, settings cancellation and an
optional local MediaMTX stream (see the SimpleGCS README).

FTP tests verify explicit reset retry correlation, immediate watchdogs without
link-setup resets, and no TerminateSession before an acknowledged open/create.
OpenFileRO and ReadFile replies are exercised across sequence 65535 → 0.
Browser tests keep a dead peer in CLOSING, check prompt reconnect and late-close
isolation, preserve the same vehicle's pan/zoom, and recenter after a vehicle change
or explicit disconnect. A duplicated tab with copied session storage must acquire
a different component ID. Review validation also removes individual fixes in
isolated copies and verifies that the targeted regression tests fail.

## Мастер настройки (TuneWizard)

`tunewizard.test.cjs` — тесты ядра `TuneWizard/core` под Node на поддельных логах с интерфейсом парсера
(история параметров, окно полёта по газу, сводка VIBE, проверки пригодности лога, рама из MSG и номер платы APJ
для ключа памяти прохода). `npm run test:tunewizard`
запускает `tunewizard-browser.cjs`: прогон шагов 0–5 в настоящем браузере (Playwright, `CHROME_PATH` — путь
к chrome.exe) на локальном логе (`TUNEWIZARD_LOG` или первый `.bin` в `TuneWizard/logs/`); без лога тест
пропускается. Сначала, до лога, — главная WebTools (`/index.html`): ссылка `./TuneWizard` одна, её иконка
`images/TuneWizard_Icon.png` загрузилась (`naturalWidth > 0`), строка «Мастер настройки» (`lang="ru"`) стоит сразу
после PID Review, переход по ссылке открывает страницу с заголовком «Мастер настройки»; затем мастер открывается
заново, как обычно. Тест привязан к тестовому логу: строка контроллера (`test_board`) и номер платы APJ (`board_id 1503`)
в ключах памяти прохода, плата и рама в плитках сводки и константы параметров — с другим логом проверки памяти
и сводки упадут. На тестовом логе все оси шага 4 «измерение ненадёжно» (проверка (б)), сводка советует тестовый
полёт; таблица вариантов, прогноз и бодэ разомкнутого контура проверяются явной подменой режима лога и качества
измерения (помечена в тесте и затем снимается). Он же проверяет регрессию правок полей шагов 3 и 4 (набор и
немедленный щелчок или Tab раньше отложенного пересчёта; на шаге 4 — «Принять», «Применить вариант» и вкладка
оси сразу после правки, окно FFT и сразу «Принять») и в конце — ширину графиков шагов 1–4 после перезагрузки
страницы, до первого снимка: полностраничный снимок включает графикам `autosize` и маскирует дефекты ширины.
Шаг 5 проверяется после устаревания (шаг 2 принят на другом интервале, шаг 4 — до нового «Принять» на шаге 3):
плитки, вердикт, таблица шагов с «устарело» и кнопкой «К шагу N» (после «К шагу 2» вердикт шага 2 — «Принято
раньше…»), изменения «было → станет» и расхождение
`INS_GYRO_FILTER` шагов 2 и 3, свёрнутый список без изменений, «что сделать перед следующим полётом» (тестовый
полёт, перезагрузка по метаданным, общий пункт о перезагрузке при сбое их загрузки и никакого — пока они
грузятся, последним — «слетайте тем же профилем»). «Скачать .param» — событие загрузки Playwright: имя `<лог>_tune.param`, в файле только
изменённые параметры итога; затем память в `localStorage` — проход аппарата, оценки устаревших шагов пустые.
«Запомнить проход» — и при недоступном хранилище (текст в заметке, сводка цела). Печать: «Печать» вызывает
`window.print`, `beforeprint`/`afterprint` — шапка печати и раскрытый на время печати список «без изменений»,
эмуляция печати — видна только сводка на белом фоне, на шаге 0 печатается его секция с графиком полёта. Ещё —
нет горизонтальной прокрутки и на узком окне; смена версии фильтра на шаге 1 делает принятое шага 3 устаревшим,
возврат — снова актуальным; после повторной загрузки лога — «менять нечего», кнопки файла и памяти выключены.
Блок «Прошлый проход» шага 0 — после повторной загрузки того же лога: «это лог прошлого прохода»; «Забыть» не
трогает запись, заменённую более новым сохранением, затем удаляет проход; хранилища нет — блок скрыт; испорченная
память и битая запись — предупреждение; проход без изменений — блока нет; синтетический проход — «Применено 3 из
3» и «2 из 3»; лог без строки контроллера — список проходов (проход того же файла выбран сразу), выбор, «Забыть
выбранный проход», узкое окно. Строки сравнения шагов 2–4: с проходом, сохранённым на шаге 5 из этого же лога
(лог прошлого прохода), строк нет; на синтетических проходах: шаг 2 — числа «в этом логе»
равны оценке «Как в логе»; шаг 3 — «применены не все», полная строка и после «Принять» на шаге 2 с другим notch —
без «в этом логе»; шаг 4 — на тестовом логе «измерение ненадёжно», а под подменой качества измерения — строка оси
с измерением и запасом фазы, при недостоверном прогнозе оси сейчас, при неустойчивом и недостоверном прогнозе
прохода и «применены не все». Скриншоты пишутся в `TuneWizard/logs/screenshots/`: `landing.png` (главная WebTools),
`step0.png` … `step4.png`,
`step5.png`, `step5-print.png` (эмуляция печати), `step0-memory.png`, `step0-memory-pick.png` (список проходов),
`step2-memory.png` (строка сравнения). `tunewizard-core.test.cjs` — перенесённая из FilterReview математика (загрузка
IMU, FFT, фильтры, трекинг, спектр, автоподбор) и исправления её дефектов; `tunewizard-steps.test.cjs` — пики
спектра, атрибуция по порядковому спектру, сравнение вариантов notch и оценка вариантов шага 3 на синтетическом
гироскопе (шум гироскопа и D-составляющей, свёртка к частоте контура, задержка путей P и D, бодэ);
`tunewizard-lowpass.test.cjs` — формулы Mission Planner по размеру винта (с округлением C# и `RoundTo`), имена
и единицы пределов ускорения, варианты, фильтры ПИД первого порядка (в том числе против симуляции разностных
уравнений `AC_PID::update_all` во времени) и отметки вариантов — ровно на порогах и при неполных данных;
`tunewizard-params.test.cjs` — файл параметров и битовые маски; `tunewizard-plots.test.cjs` — реестр графиков;
`tunewizard-common.test.cjs` — общий модуль шагов (подписи и ячейки, число со словом в нужной форме, перехват
ошибок в вердикт, вложенный `step_run` под оверлеем внешнего, досчёт шага 1, «Открыть в …», одна загрузка
метаданных и флаг её сбоя, флаг указателя, каркас механизма правок, контекст итога и отпечаток входов из состояния
страницы — каждое поле состояния входит в отпечаток, «Как в логе» на шаге 3 шаг 4 устаревшим не делает, у шага 4 —
только его фильтры (список имён в контексте; FLTT, `INS_ACCEL_FILTER` и `SCHED_LOOP_RATE` его устаревшим не
делают), без лога «устарело» нет);
`tunewizard-summary.test.cjs` — итог прохода `core/summary.js`: сравнение как float32 и маски (HMNCS без знака,
в `.param` — со знаком), `ESCMSK` при версии фильтра ниже 4, включаемый notch — все поля, порядок источников и
расхождение `INS_GYRO_FILTER`, пометка ручной правки ненадёжной оси, текст и имя `.param` только из изменённых,
непринятые шаги, отпечаток входов и «устарело» (отличия от лога, версия фильтра, ключ FFT только у шагов 2–3,
у шага 4 — только имена из списка: пределы ускорения, FLTT и `INS_ACCEL_FILTER` — нет, FLTD — да),
«что сделать перед следующим полётом» (состав и порядок пунктов, «что сделать» проверки — продолжением фразы со
строчной, кроме имён параметров, перезагрузка по метаданным и без них);
`tunewizard-passmem.test.cjs` — память прохода `core/passmem.js`: запись и чтение, версия, испорченный JSON и битые
записи, недоступное хранилище и квота; ключ аппарата и запасной ключ; запись прохода (оценки шагов 2–4, пустые у
устаревшего и перекрытого шага, NaN и бесконечность — null); предел 20 аппаратов; «применено / другое значение /
нет в логе» и «лог прошлого прохода»; условия строки сравнения (всё применено, частично — накопительно по шагам,
ось ненадёжна, изменения другой оси не влияют); совместимость с записанной вручную строкой формата v1;
`tunewizard-pid.test.cjs` — перенос PIDReview (загрузка `PIDR` и `RATE`, наборы параметров,
пакеты, FFT, отклик на ступеньку) и исправления дефектов upstream 1, 2, 3, 5, 6; `tunewizard-pidtune.test.cjs` —
шаг 4: метрики отклика на известных системах, КИХ МНК на синтетике rate-only против правды, проверки качества
(и их отказ с угловым контуром и при смене объекта), режим лога, правила ровно на порогах, модель регулятора
против разностных уравнений `AC_PID::update_all`, прогноз вариантов против прямой симуляции `update_all`
с новыми коэффициентами, сглаживание поправки фильтров гироскопа (снятие notch выше частоты Найквиста контура
без ложной непричинности), достоверность, варианты и отметки на порогах.
Скрипты загружаются как на странице через `vm.runInThisContext`. `npm run test:tunewizard-compare` запускает
`tunewizard-compare.cjs`: тот же лог в FilterReview и в мастере с одинаковыми интервалом, окном, шкалами и
параметрами. Эталон — FilterReview с теми же исправлениями дефектов (тест подменяет их в коде FilterReview и
падает, если подмена не нашла своё место); сравниваются средний спектр, спектрограмма, бодэ и оценка «после»
(допуск 1e-6). Отдельно печатается, чем исходный FilterReview отличается от мастера, и проверяется, что
отличия ровно ожидаемые. Правила этой проверки без браузера (сетка бодэ короче при ρ < 1, raw-лог, конец лога
на границе пакета) проверяет `tunewizard-compare-rules.test.cjs`. `npm run test:tunewizard-pid-compare` запускает
`tunewizard-pid-compare.cjs`: тот же лог в PIDReview и в мастере (интервал мастера по умолчанию, окно 512).
Эталон — PIDReview с теми же исправлениями дефектов (подмена строк дефектов 1, 2, 3, 5, 6, каждая обязана
найтись); по осям `PIDR`, `PIDP`, `PIDY` поэлементно сравниваются число окон, окна и среднее отклика на ступеньку,
ось времени и средняя частота FFT (допуск 1e-6). Отдельно печатается отчёт, чем исходный PIDReview отличается
от мастера (на любом логе — дефект 2: пакет на отсчёт короче, частота выше), и проверяется, что отличия ровно
ожидаемые. Правила этого отчёта без браузера проверяет `tunewizard-pid-compare-rules.test.cjs`.

`npm run tunewizard:icon` запускает `tunewizard-icon.cjs` — не тест, а скрипт, который делает иконку мастера для
главной WebTools `images/TuneWizard_Icon.png`. Лог, Chrome (`CHROME_PATH`) и python — те же, что у браузерного
теста (без лога скрипт падает: снимать не с чего). Он загружает лог, открывает шаг 2 в окне 760 px (полоса шагов
встаёт в две строки), снимает полосу шагов и спектр `Spectrum2` отдельными кусками, склеивает их на canvas
в странице и уменьшает до 400 px по ширине. Запускать вручную, когда вид шагов заметно изменился, затем посмотреть
картинку и закоммитить файл. В `npm test` и `npm run test:tunewizard` скрипт не входит — иначе каждый прогон менял
бы картинку; браузерный тест только проверяет, что иконка на главной загружается.
