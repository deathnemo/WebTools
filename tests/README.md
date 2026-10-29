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
к chrome.exe) на локальном логе (`TUNEWIZARD_LOG`, иначе тестовый лог `2026-06-18 18-54-42_anon.bin` в
`TuneWizard/logs/`, а без него — первый `.bin` там; так же выбирают лог тесты сравнения и скрипт иконки); без лога тест
пропускается — целиком, вместе с проверкой главной. Она идёт первой — после поиска лога, до его загрузки: главная
WebTools (`/index.html`) без ошибок консоли, ссылка `./TuneWizard` одна, её иконка `images/TuneWizard_Icon.png`
загрузилась (`naturalWidth > 0`), строка «Мастер настройки» (`lang="ru"`) стоит сразу после PID Review, переход
по ссылке открывает страницу с заголовком «Мастер настройки»; затем мастер открывается заново, как обычно. Тест привязан к тестовому логу: строка контроллера (`test_board`) и номер платы APJ (`board_id 1503`)
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
`step0.png` … `step4.png`, `step5.png`, `step5-print.png` (эмуляция печати), `step0-memory.png`,
`step0-memory-pick.png` (список проходов), `step2-memory.png` (строка сравнения). Прогон — около минуты.

После аудита 28–29.10.2026 браузерный тест проверяет ещё: шаг 1 — поле «Окон на пакет» скрыто до лога и видно на
batch-логе, окно raw шага 0 не подменяется окном batch, пустое поле окон на пакет — одно окно, подсказка допустимых окон
без окон короче 64, подпись спектрограммы для гироскопа без данных, исключение в источниках трекинга (подмена
`create_tracking`) — ошибка в вердикте и восстановление показом шага, выбор файла с шага 2 открывает шаг 0; шаг 2 —
подмены параметров лога (notch лога выключен — допуск задержки не применяется, notch по RPM без данных — опора не
смоделирована, ESCMSK записан при версии фильтра ниже 4 — поле и `.param`), ловушка «Принять» без «Применить вариант»
(вердикт называет рекомендованный), приведение полей (`SCHED_LOOP_RATE` 0, маски 1.5 и −1), `INS_GYRO_FILTER` 1000 —
метрики конечны и предупреждение об ограничении среза, значение вне списка из `.param` пропускается, «Пересчитать» при
устаревших вариантах сохраняет выбранную строку; шаг 3 — `INS_GYRO_FILTER` 1000 с предупреждением, дробные размер винта
и FLTE (`step="any"`, границы 4–40″), отказ «отрицательные пределы ускорения», `INS_GYRO_FILTER` шага 2 в форме шага 3 и
заметка после «Применить вариант», «Принять» «Как в логе» с названным рекомендованным и без устаревания от размера
винта; шаг 4 — `ACRO_TRAINER = 0` в совете, FFT только нужных компонент, подмены: запас фазы «не определён»
(`pidtune_margins`), участок ACRO с кнопкой «Интервал — участок ACRO» (режим лога), PID тангажа менялись после интервала
(`state.params.get`) — «Набор интервала», подписи, `set_values` принятого и пометки сводки; шаг 5 — адрес страницы в
заметке, размер маски в записи памяти, расхождение `INS_GYRO_FILTER` шагов 2 и 3 в вердикте и под таблицей, «Запомнить
проход» без изменений закрывает проход и заменяет память другой версии; память — испорченная и другой версии при
загрузке не переписываются, список проходов, когда прохода этого аппарата нет (замена полётного контроллера).

`npm run test:tunewizard-log2` запускает `tunewizard-browser-log2.cjs`: второй лог (`TUNEWIZARD_LOG2` или
`TuneWizard/logs/1 01.01.1970 2-00-00.bin`; без него пропуск) — другой аппарат (ArduCopter 4.7.2, версия фильтра 4,
raw-гироскоп GYR ≈ 2 кГц с записью «до» и «после», STABILIZE, `ACRO_OPTIONS` 3, пределы `ATC_ACC_*`), шаги 0–5 без
«Принять»: поле окна FFT доступно и поле окон на пакет скрыто, окно 2048 не помещается в куски потока GYR (окон FFT
нет, вердикт об этом), шаг 2 — «Текущие настройки лучше» и ESCMSK виден, шаг 3 — `ATC_ACC_*` и просьба ввести размер
винта, шаг 4 — ни одной надёжной оси и без кнопки участка ACRO, шаг 5 — «менять нечего»; блок «Прошлый проход» с
проходом тестового лога в памяти — список «проход этого аппарата не найден», выбор показывает таблицу («другое
значение», «нет в логе»). Около 7 с.

`tunewizard-core.test.cjs` — перенесённая из FilterReview математика (загрузка
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
в `.param` — со знаком), `ESCMSK` по правилу `escmsk_present` (записан в лог или версия фильтра не ниже 4 — как в
`.param` шага 2), включаемый notch — все поля, порядок источников и
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
`tunewizard-audit-a.test.cjs` — исправления аудита области A (ядро шагов 0–1): NaN в оборотах ESC/RPM (и мотор или
датчик без единого числового отсчёта — без данных, а не цель NaN), источники
трекинга и шаг 1 под заглушками страницы (ошибка трекинга восстановима, окно raw отдельно от batch, подсказка окон на
пакет, пустое поле, подпись спектрограммы), правило ESCMSK в `values_from_log` (`escmsk_present` из `core/params.js`,
проверяется и в `tunewizard-params.test.cjs`); `tunewizard-audit-b.test.cjs` — помощники шага 2 (приведение полей формы,
маски словами, правило ESCMSK, подсказки включаемого notch, «notch лога не смоделирован», ограничение среза
`INS_GYRO_FILTER` в оценке — `step2_model_values`, `step2_evaluate`); `tunewizard-audit-d.test.cjs` — правки шага 4 под
заглушками на поддельном PIDR («Набор интервала», кнопка участка ACRO, «Применить вариант» одним `step_run`, шум D без
окон, заметки NTF/PDMX, FFT только нужных компонент, отказ «Принять»); `tunewizard-step3.test.cjs` — шаг 3 под
заглушками (`INS_GYRO_FILTER` шага 2 в форме и заметка, отказ «Принять», причина «сравнить нельзя», ключ контекста без
размера винта, вердикт принятого, «Применить вариант» при неготовом шаге 1);
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
отличия ровно ожидаемые. Намеренное отличие, не связанное с дефектами: `INS_*_ESCMSK`, записанный в лог при
версии фильтра ниже 4, мастер берёт из лога (`escmsk_present`), а FilterReview обнуляет — если на логе так,
оценка «после» и бодэ идут только в отчёт. Правила этой проверки без браузера (сетка бодэ короче при ρ < 1,
raw-лог, конец лога на границе пакета, маска ESCMSK из лога) проверяет `tunewizard-compare-rules.test.cjs`. `npm run test:tunewizard-pid-compare` запускает
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
в странице и уменьшает до 400 px по ширине. Если на странице были ошибки (например, не загрузились шрифты — снимок
вышел бы с запасными), скрипт падает с их списком и PNG не записывает. Запускать вручную, когда вид шагов заметно изменился, затем посмотреть
картинку и закоммитить файл. В `npm test` и `npm run test:tunewizard` скрипт не входит — иначе каждый прогон менял
бы картинку; браузерный тест только проверяет, что иконка на главной загружается.
