# Мастер настройки — этап 7: подготовка к полёту (план реализации)

**Исполнение:** координатор (основной сеанс) отдаёт каждую задачу исполнителю-субагенту, затем — ревью на соответствие плану и ревью качества (журнал, раздел 7); замечания исправляет исполнитель той же задачи.

**Цель:** блок «Подготовка к следующему полёту» на шаге 0 — проверка параметров для качественного лога по цели полёта (фильтры / PID / оба), по параметрам лога или по загруженному `.param` (и без лога), файл `.param` исправлений, план полёта с печатью; пункты подготовки — в «что сделать перед следующим полётом» шага 5.

**Архитектура:** по `docs/plans/2026-10-30-tune-wizard-stage7-design.md` (утверждён 30.10.2026).

- `TuneWizard/core/prep.js` — ядро без DOM (префикс `prep_`), подключается после `core/passmem.js`: берёт `pidtune_mode_names` и `pidtune_rules` (`acro_mode`, `acro_rate_only_bit`) из `core/pidtune.js`, а не дублирует их.
- `TuneWizard/steps/prep.js` — блок на шаге 0 (префикс `prep0_`, id элементов `prep0_*`), подключается после `steps/common.js`.

**Стек:** как на этапах 2–6 (браузерный JS без сборки, `node --test`, ESLint, Playwright + Chrome через `CHROME_PATH`).

**Соглашения:**

- Русский язык в коде, комментариях, интерфейсе и сообщениях. Стиль соседнего кода: 4 пробела, без `;`, объявления `function`, комментарий-контракт перед функцией, правила с источниками (`[код] файл:строки`, `[наше]`, `[решение пользователя 30.10.2026]`).
- Коммит на задачу с трейлером `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. `git add` только по именам файлов: `modules/ardupilot` и `TuneWizard/logs/` не коммитить. Сообщение коммита — через файл (`git commit -F`): PowerShell 5.1 ломает кавычки в `-m`.
- Ветка `tune-wizard-next3`. После каждой задачи — `git push origin tune-wizard-next3`. В upstream ArduPilot ничего не отправлять, в `main` не пушить. Журнал `docs/tunewizard-journal.md` обновляет координатор.
- Только тёмная тема «Графит»: цвета — токены CSS; печать — белый фон (блок `@media print` в `TuneWizard/index.html`).
- Окончания строк — как в файле (`git diff --check`).

**Общая глобальная область страницы.** Новые глобальные имена — только `prep_` (ядро) и `prep0_` (страница); оба свободны (проверено `grep` по `Libraries/`, `TuneWizard/`, `tests/tunewizard*.cjs`). Перед новым именем — `grep`. Ядро не зовёт `steps/` и не трогает `state`: всё нужное получает аргументами.

**Тесты ядра под Node** грузят скрипты через `vm.runInThisContext` в порядке страницы (`load_page_scripts`, как в `tests/tunewizard-summary.test.cjs`). Новые файлы ядра в `DUAL_SCRIPTS` (`eslint.config.mjs`) не добавляются; глобалы страницы ESLint берёт из тегов `<script>` в `TuneWizard/index.html`.

**Проверки (этот компьютер, Windows):** один раз `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci` (Chromium Playwright не нужен — есть Chrome); затем `npm run lint`; `npm test`; `CHROME_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe" npm run test:tunewizard-prep` (с задачи 4). Тестового лога здесь нет: `npm run test:tunewizard` без него берёт первый `.bin` в `TuneWizard/logs/` — второй лог — и падает на проверках, привязанных к тестовому логу (память прохода, `test_board`); здесь он не показателен (уточнено ревью задачи 2), прогон — на основном компьютере или после переноса тестового лога (в PR так и написать). `npm run test:tunewizard-log2` здесь идёт. Второй лог `TuneWizard/logs/1 01.01.1970 2-00-00.bin` и `TuneWizard/logs/1.param` (не в git) — для ручной проверки страницы.

**Что уже есть и переиспользуется:**

- параметры лога `state.params` — `get(name)` → значение или `null`, `has(name)` (`log_params`, `core/log.js`); `.param` — `parse_param_file(text)` → объект имя → число, `param_file_text(values)` (`core/params.js`; нужен `Libraries/Param_Helpers.js`);
- проверки шага 0 — `state.checks`: `[{ id, status, title, text, fix }]`, id: `vehicle`, `pid_log`, `gyro_log`, `pre_post`, `tracking`, `flight`, `vibe`, `clipping`, `hover_throttle`; вывод — `render_checks()` (`wizard.js`, разметка `.checks` / `.check--ok|warn|fail`, подписи OK / ВНИМ / СТОП);
- `pidtune_mode_names` (номер режима Copter → имя), `pidtune_rules.acro_mode` (1), `pidtune_rules.acro_rate_only_bit` (2 — значение бита) — `core/pidtune.js`;
- `html_escape`, `show_verdict`, `set_step`, `state` — `wizard.js`; `step_try`, `step_plural` — `steps/common.js`; `saveAs` — `Libraries/FileSaver.js`; печать по образцу `step5_before_print` / `step5_after_print` (`steps/step5.js`);
- «что перелететь» — `summary_refly(ctx)` (`core/summary.js`), вызывается из `step5_render_refly` (`steps/step5.js`);
- загрузка лога — `load()`, сброс — `reset()`, ошибка — `load_failed()`, инициализация — `init_wizard()` (`wizard.js`; хуки шагов вызываются через `typeof … === "function"`).

---

### Задача 1: ядро `core/prep.js` и тесты под Node

**Файлы:** создать `TuneWizard/core/prep.js`, `tests/tunewizard-prep.test.cjs`; изменить `TuneWizard/index.html` — `<script src="core/prep.js">` после `core/passmem.js`.

**Константы** `prep_rules` (каждая с источником в комментарии):

- биты `LOG_BITMASK`: ATTITUDE_FAST 0, PID 12, IMU_RAW 19 — [код] `ArduCopter/defines.h:87,99,105`;
- `LOG_BACKEND_TYPE` бит File 0 — [код] `AP_Logger.cpp:97–100`;
- `INS_RAW_LOG_OPT`: основной гироскоп 0, все 1, после фильтров 2, до и после 3 — [код] `AP_InertialSensor.cpp:693–698`, `AP_InertialSensor_Backend.cpp:480–500`;
- `INS_LOG_BAT_OPT`: после фильтров 1, до и после 2 — [код] `BatchSampler.cpp:28`; исправление batch — `INS_LOG_BAT_MASK = 1`, `INS_LOG_BAT_OPT = 4` (как совет `checks.js`); raw для подсказки — `INS_RAW_LOG_OPT = 9`;
- буфер: порог 50 КиБ, в файл 64 — [код] `AP_Logger.cpp:27–35` (умолчания), [наше] второй лог 30.10.2026;
- notch: `INS_HNTCH_MODE` ESC = 3 — [код] `HarmonicNotchFilter.cpp:127`; `SERIALn_PROTOCOL` телеметрия ESC = 16 — [код] `AP_SerialManager.h:55`;
- режимы с самовыравниванием для выхода из Acro: 0, 2, 5, 16 (STABILIZE, ALT_HOLD, LOITER, POSHOLD) — [наше], решение пользователя 30.10.2026;
- положения переключателя: верхние границы PWM 1230, 1360, 1490, 1620, 1749, затем от 1750 — [код] `RC_Channel.cpp:597–609`;
- перезагрузка: `INS_LOG_BAT_MASK` — [код] `BatchSampler.cpp:22` (`@RebootRequired`); `LOG_BACKEND_TYPE`, `LOG_FILE_BUFSIZE` — выбираются при запуске логгера [код] `AP_Logger.cpp:256`, `AP_Logger_File.cpp:74–78`.

**Функции** (контракт — комментарием перед каждой):

- `prep_goals` — `{ filters: { title: "Фильтры", … }, pid: { title: "PID", … }, both: { title: "Фильтры и PID", … } }`; правило применяется к цели, если его цели (`["filters"]`, `["pid"]` или обе) пересекаются с выбранной (`both` — обе).
- `prep_mode_slots(params)` → `[{ slot: 1…6, name: "FLTMODE<n>", mode, mode_name, pwm }]`: `mode` — число или `null` (нет параметра), `mode_name` — из `pidtune_mode_names` (нет — «режим N»), `pwm` — текст диапазона («до 1230», «1231–1360», …, «от 1750»).
- `prep_acro_suggestion(params)` → номер положения или `null`: 6, если в `FLTMODE6` не ACRO, а среди остальных положений есть режим с самовыравниванием; иначе `null`. Если ACRO уже есть — `null`.
- `prep_check(params, goal, ctx)` → `[{ id, status, title, text, fix, changes }]` — правила цели в порядке таблицы раздела 3 дизайна. `params.get(name)` → число или `null`; `ctx = { acro_slot, hover_check }`: `acro_slot` — выбранное положение для ACRO (1–6 или `null`), `hover_check` — проверка шага 0 `hover_throttle` или `null`. `changes` — `[{ name, value }]` или для масок `[{ name, set, clear }]` (`set`/`clear` — значения битов), `[]` — нечего менять. Параметра, нужного правилу, нет — статус `warn`, текст «параметра X нет — проверьте версию прошивки», `changes = []`.
  - `log_backend`, `log_pid`, `log_fast`, `gyro_data`, `gyro_prepost`, `log_buffer`, `notch_source`, `acro_slot`, `acro_exit`, `acro_rate_only`, `acro_trainer`, `fstrate`, `hover_learn` — по таблице дизайна. Уточнения:
  - `gyro_data`: при fail — исправление batch; в `fix` — и подсказка raw для плат H7 и быстрее (`INS_RAW_LOG_OPT = 9`).
  - `gyro_prepost` и `log_buffer` считаются от источника, который будет после исправления `gyro_data` (нет записи → batch: `gyro_prepost` ok, `log_buffer` не применяется). И raw, и batch включены — оценивать raw (его берёт мастер, `log_messages`).
  - `acro_slot`: ACRO есть — ok, текст называет положения; нет — fail; `changes` — `FLTMODE<acro_slot> = 1`, только если `acro_slot` задан; `fix` — «выберите положение для ACRO в таблице ниже».
  - `acro_exit` — по режимам *после* применения `acro_slot`: среди положений не ACRO есть режим с самовыравниванием — ok (назвать положение); нет — fail без `changes`. В тексте — «проверьте, что тумблер достаёт до этого положения».
  - `hover_learn`: `MOT_HOVER_LEARN = 2` — ok; иначе при `hover_check?.status === "warn"` — warn, `changes` `2`; иначе ok с советом в тексте, без `changes`.
- `prep_changes(params, items)` → объект имя → значение: маски — от значения `params` с `set`/`clear` всех пунктов по очереди; значение, равное текущему (как float32), не попадает.
- `prep_reboot_names(names)` → имена из `names`, которым нужна перезагрузка (список в `prep_rules`), в порядке `names`.
- `prep_flight_plan(goal, ctx)` → пункты текста. `ctx = { acro_slot, exit_slot, checks }`: `acro_slot` — положение ACRO (найденное или выбранное), `exit_slot` — положение выхода, `checks` — проверки шага 0 или `null`. Пункты — раздел 5 дизайна: «До полёта: …» для проверок `vibe`, `clipping`, `tracking` со статусом warn/fail («title — fix»); висение (Ф); Acro (P) с номерами положений; Ф + P — сначала висение; конец — посадка и загрузка лога, на шаге 4 — «Интервал — участок ACRO».
- `prep_file_name(source_name)` → `<имя без расширения>_prep.param` (`null` или пусто — `prep.param`).

**Тесты** (`tests/tunewizard-prep.test.cjs`; скрипты: `Libraries/Param_Helpers.js`, `core/pid.js`, `core/pidtune.js`, `core/params.js`, `core/prep.js` — проверить, что хватает; `fake_params` как в `tunewizard-summary.test.cjs`):

- каждое правило — ok / warn / fail на своей цели и отсутствие на чужой; нет параметра — warn;
- `gyro_data` при fail даёт batch, `gyro_prepost` и `log_buffer` после этого не ругаются; raw + post-only → warn и `(opt | 8) & ~4`; batch post-only → `(opt | 4) & ~2`; raw и буфер 8 → warn, 64;
- `notch_source`: ESC без `SERVO_BLH_BDMASK` и без `SERIALn_PROTOCOL = 16` — warn; с любым из них — ok; notch выключен — ok;
- `acro_slot` / `acro_exit` / `prep_acro_suggestion`: нет ACRO, предложение 6; единственный режим выхода в `FLTMODE6` — предложения нет; выбор положения → `changes` и пересчёт `acro_exit`;
- `prep_changes`: `log_pid` и `log_fast` на одном `LOG_BITMASK` складываются; значение, равное текущему, не попадает; текст файла через `param_file_text` содержит ожидаемые строки;
- `hover_learn` с `hover_check` warn / ok / null;
- `prep_flight_plan` по трём целям и с проверками шага 0;
- параметры и из `parse_param_file` (обёрнутые в `get`), и из объекта как у `log_params`;
- константы совпадают с `pidtune_rules` (как равенство `pid_log_min_rate_hz` в `tunewizard-pid.test.cjs`).

**Проверки:** lint, `npm test`.

**Коммит:** `TuneWizard: ядро подготовки к полёту (core/prep.js) и тесты`, push.

---

### Задача 2: блок на шаге 0

**Файлы:** создать `TuneWizard/steps/prep.js`; изменить `TuneWizard/index.html` (разметка, стили печати, `<script src="steps/prep.js">` после `steps/common.js`), `TuneWizard/wizard.js` (хуки).

- **Разметка** (шаг 0): в первой строке `.lab` — второй выбор файла рядом с логом: `<input id="prep0_file" type="file" accept=".param,.parm,.txt">` и `<label class="pickbtn" for="prep0_file">Проверить .param…</label>`. Блок `<div id="prep0" hidden>` после `#log_checks` и до `#memory0`: шапка `.head` («Подготовка» / «Подготовка к следующему полёту»), строка источника `#prep0_source` с кнопкой «Убрать файл» (`#prep0_unfile`), поле цели `<select id="prep0_goal">`, вердикт `#prep0_verdict`, список `#prep0_checks` (как `.checks`), таблица положений `#prep0_modes` (столбцы: положение, PWM, режим сейчас) с полем `<select id="prep0_slot">` «Положение для ACRO» — видны, если цель включает PID; кнопки «Скачать .param исправлений» (`#prep0_download`) и «Печать плана» (`#prep0_print`), заметка `#prep0_note`, план `<ol id="prep0_plan">`, шапка печати `#prep0_print_head` (видна только при печати, как `.print-head` шага 5).
- **Источник:** загружен файл — он (`parse_param_file`, обёртка `get`/`has`); иначе `state.params`; нет ни того ни другого — блок скрыт. Файл не сбрасывается при загрузке лога (`reset()`), «Убрать файл» — возврат к логу. Строка источника: «По файлу «…»» / «По параметрам лога «…»»; при файле и логе — «файл важнее параметров лога».
- **Цель:** `localStorage` ключ `tunewizard_prep_goal` (чтение и запись в `try/catch`, без хранилища — по умолчанию `both`). Прочитанное значение проверить по ключам `prep_goals` до вызова ядра: `prep_goal_parts` бросает на неизвестную цель (ревью задачи 1).
- **Положение ACRO:** при fail `acro_slot` — `<select>` с `FLTMODE1–6` (режим сейчас и PWM), выбрано `prep_acro_suggestion`, если оно есть, иначе пусто («— выберите —»). Смена — перерисовка блока. ACRO уже есть — поля нет.
- **Список и вердикт** — разметка и подписи как `render_checks()`; вердикт: «Готово к полёту: <цель>» / «С оговорками: N» / «Не готово: N — см. список».
- **Файл:** `prep_changes` пусто — кнопка выключена, подпись «менять нечего»; иначе `saveAs` с `param_file_text`, имя `prep_file_name(источник)`, заметка: «Файл …: N параметров» и, если `prep_reboot_names` не пусто, «после записи перезагрузите полётный контроллер: …». Значения пунктов `acro_exit`, `notch_source`, `fstrate` в файл не идут (их `changes` пусты).
- **План:** `prep_flight_plan` с найденным или выбранным положением ACRO и положением выхода; проверки шага 0 — `state.checks`.
- **Печать плана:** класс `print-prep` на `body` до `window.print()`, снятие — на `afterprint`; в `@media print` при `body.print-prep` на шаге 0 видны только шапка печати, `#prep0` без полей ввода и кнопок (цель — текстом в шапке). Ctrl+P без кнопки печатает шаг 0 как раньше.
- **Хуки `wizard.js`:** `init_wizard` — `prep0_init()`; конец `load()` и `load_failed()` / `reset()` — `prep0_render()` (через `typeof … === "function"`, как у остальных шагов); `hover_check` — `state.checks?.find((c) => c.id === "hover_throttle") ?? null`.
- Ошибка внутри блока не роняет шаг 0: отрисовка через `step_try` с выводом в `#prep0_verdict`.
- `prep0_items()` → пункты для текущего источника, цели и положения (нужно задаче 3). С правок задачи 3 по ревью — `prep0_summary()` → `{ items, file_name, reboot_names }` или `null`.

**Проверки:** lint, `npm test`; вручную — страница с `TuneWizard/logs/1.param` без лога (блок, смена цели, положение 6, скачивание), со вторым логом, лог + файл, печать плана (предпросмотр).

**Коммит:** `TuneWizard: блок подготовки к полёту на шаге 0`, push.

---

### Задача 3: сводка и совет шага 0 про raw

**Файлы:** изменить `TuneWizard/core/summary.js`, `TuneWizard/steps/step5.js`, `TuneWizard/core/checks.js`, `tests/tunewizard-summary.test.cjs`, тест текста проверки шага 0 (найти `grep "INS_RAW_LOG_OPT = 8" tests/`).

- `summary_refly`: `ctx.prep` — пункты подготовки (`prep0_items()`; `null` или `[]` — нет); пункты warn и fail с непустым `fix` — источник `"prep"`, текст «title — fix» (`summary_lower_first`), сразу после пунктов `"check"`. Контракт в комментарии дополнить.
- `step5_render_refly`: `prep: (typeof prep0_items === "function") ? prep0_items() : null`.
- **Сделано с правками по ревью** (`ecd7b03`): `ctx.prep` — объект `prep0_summary()`; повторы проверок шага 0 и пунктов подготовки убираются; общий пункт `"prep_file"` — файл `_prep.param` шага 0 и перезагрузка; batch с битом 2 и битом 1 или 0 — warn, исправление `INS_LOG_BAT_OPT = 4` (дизайн, раздел 6).
- `checks.js`, проверка `gyro_log` (нет данных): совет raw — «`INS_RAW_LOG_OPT = 9` (основной гироскоп до и после фильтров; бит IMU_RAW не нужен)» вместо «бит IMU_RAW (19) в LOG_BITMASK, INS_RAW_LOG_OPT = 8» — [код] `AP_InertialSensor_Backend.cpp:480–487`.
- `checks.js`, проверка `pre_post` для batch: биты 1 и 2 `INS_LOG_BAT_OPT` вместе — warn «обе половины пишутся после фильтров: спектр «до» на шаге 1 на самом деле после фильтров», fix — снять бит 1 (−2). [код] `AP_InertialSensor.h:351–353` (`doing_post_filter_logging`), `BatchSampler.cpp:97–102`, `AP_InertialSensor_Backend.cpp:507`. Найдено ревью задачи 1; то же правило — `gyro_prepost` в `core/prep.js`.
- Тесты: источник `prep` (порядок, текст, ok-пункты не попадают, `null`), новый текст совета, batch с битами 1 и 2.

**Проверки:** lint, `npm test`.

**Коммит:** `TuneWizard: подготовка к полёту в сводке, совет raw-записи`, push.

---

### Задача 4: браузерный тест без лога

**Файлы:** создать `tests/fixtures/prep.param`, `tests/tunewizard-prep-browser.cjs`; изменить `package.json` (`"test:tunewizard-prep": "node tests/tunewizard-prep-browser.cjs"`), `tests/tunewizard-browser.cjs` (проверки с логом).

- Фикстура — синтетическая (не файл пользователя), с комментарием-шапкой `#`: без ACRO в `FLTMODE1–6` (1–3 STABILIZE, 4–6 ALT_HOLD), `ACRO_OPTIONS 0`, `ACRO_TRAINER 2`, `INS_RAW_LOG_OPT 0`, `INS_LOG_BAT_MASK 0`, `LOG_BITMASK` без PID и ATTITUDE_FAST, `LOG_BACKEND_TYPE 1`, `LOG_FILE_BUFSIZE 8`, `INS_HNTCH_ENABLE 1`, `INS_HNTCH_MODE 3`, `SERVO_BLH_BDMASK 15`, `FSTRATE_ENABLE 0`, `MOT_HOVER_LEARN 2`, `ATC_RAT_RLL_P` (без него блок отказывает: «файл «…» не похож на параметры Copter» — правка задачи 2 по ревью).
- Скрипт — по образцу `tests/tunewizard-browser-log2.cjs` (сервер python, Chrome через `CHROME_PATH`, сбор ошибок консоли), но лог не нужен — тест идёт всегда:
  - открыть мастер, загрузить фикстуру в `#prep0_file`; блок виден, шаги 1–5 недоступны;
  - цель «Фильтры и PID»: fail у `log_pid`, `log_fast`, `gyro_data`, `acro_slot`, `acro_rate_only`, `acro_trainer`; поле положения предлагает 6; `acro_exit` ok;
  - цель «Фильтры» — пунктов Acro и PID нет; цель запоминается после перезагрузки страницы;
  - скачать файл (`page.waitForEvent("download")`): строки `ACRO_OPTIONS,2`, `ACRO_TRAINER,0`, `FLTMODE6,1`, `INS_LOG_BAT_MASK,1`, `INS_LOG_BAT_OPT,4`, `LOG_BITMASK` с битами 0 и 12; заметка называет перезагрузку;
  - план содержит положение 6 и выход положением 1;
  - «Убрать файл» — блок скрыт; ошибок консоли нет;
  - отказы: синтетический `.param` без `ATC_RAT_RLL_P` — вердикт «не похоже на параметры Copter», нет списка, файла и плана; двоичный файл (например, байты в scratchpad, не лог пользователя) — «не файл параметров ArduPilot», источник не меняется.
- `tests/tunewizard-browser.cjs` (с логом, здесь не идёт): на шаге 0 блок по параметрам тестового лога виден; на шаге 5 при пунктах подготовки warn/fail они есть в «что перелететь». Значения — посчитать ядром под Node по параметрам тестового лога заранее нельзя (лога нет) — писать проверки на наличие и порядок, без конкретных чисел.

**Проверки:** lint, `npm test`, `CHROME_PATH=… npm run test:tunewizard-prep`.

**Коммит:** `TuneWizard: браузерный тест подготовки к полёту без лога`, push.

---

### Задача 5: документы и финальный прогон

**Файлы:** `TuneWizard/Readme.md` (раздел «Подготовка к полёту»: цель, правила с источниками, источник параметров, файл, план, печать; в «Структуре» — `core/prep.js`, `steps/prep.js`; «Готовность» — этап 7), `tests/README.md` (тесты ядра и браузерный без лога).

**Проверки:** lint, `npm test`, `npm run test:tunewizard-prep`; ручной прогон с `TuneWizard/logs/1.param` и вторым логом.

**Коммит:** `TuneWizard: документы этапа 7`, push. Журнал и PR (`gh pr create --repo deathnemo/WebTools --base main`) — координатор.
