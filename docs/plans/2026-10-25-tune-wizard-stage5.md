# Мастер настройки — этап 5: сводка, `.param`, память прохода, печать (план реализации)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Цель:** шаг 5 мастера «Сводка» — итог принятого на шагах 2–4, файл `.param` из изменённых параметров, «что перелететь», печать; память прохода по аппаратам с проверкой «применено» на шаге 0 и строкой «было → прогноз → в этом логе» на шагах 2–4.

**Архитектура:** по `docs/plans/2026-10-25-tune-wizard-stage5-design.md`.

- `TuneWizard/core/summary.js` — итог прохода без DOM (префикс `summary_`).
- `TuneWizard/core/passmem.js` — память прохода без DOM (префикс `passmem_`, константы `PASSMEM_`).
- `TuneWizard/steps/memory.js` — память на странице: хранилище браузера, блок шага 0, строки сравнения шагов 2–4 (префикс `memory_`).
- `TuneWizard/steps/step5.js` — страница сводки (префиксы `step5`, `step5_`).

**Стек:** как на этапах 2–4 (браузерный JS без сборки, `node --test`, ESLint, Playwright + Chrome через `CHROME_PATH`).

**Соглашения:**

- Русский язык в коде, комментариях, интерфейсе и сообщениях. Стиль соседнего кода: 4 пробела, без `;`, объявления `function`, комментарий-контракт перед функцией, решения с источниками (`[наше]`, `[решение пользователя 25.10.2026]`, `[код]`).
- Коммит на задачу с трейлером `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. `git add` только по именам файлов: `modules/ardupilot` и `TuneWizard/logs/` не коммитить.
- Ветка `tune-wizard-stage5` (от `main` = `77d67e0`). После каждой задачи — `git push origin tune-wizard-stage5`. В upstream ArduPilot ничего не отправлять. Журнал `docs/tunewizard-journal.md` обновляет координатор.
- Только тёмная тема «Графит»: цвета — токены CSS. Печать — белый фон (блок `@media print` уже есть в `index.html`).

**Общая глобальная область страницы.** Новые глобальные имена — только с префиксами выше (проверено: `summary_`, `passmem_`, `memory_`, `step5` свободны). Перед добавлением имени — `grep` по `Libraries/` и `TuneWizard/`. `core/` не зовёт `steps/` и не объявляет `state`, `US2S`, `css_token`, `stat_tile`, `html_escape`: всё, что нужно от страницы (списки имён шагов, тексты шагов, хранилище), ядро получает аргументами.

**Тесты ядра под Node** грузят скрипты через `vm.runInThisContext` в порядке страницы (как `load_page_scripts` в `tests/tunewizard-pidtune.test.cjs`). Новые файлы ядра в `DUAL_SCRIPTS` (`eslint.config.mjs`) не добавляются — как `core/lowpass.js` и `core/pidtune.js`.

**Проверки (везде):** `npm run lint`; `npm test`; `CHROME_PATH="C:/Users/taa03/AppData/Local/Google/Chrome/Application/chrome.exe" npm run test:tunewizard`. Node — `export PATH="/c/Program Files/nodejs:$PATH"`. Тесты сравнения (`test:tunewizard-compare`, `test:tunewizard-pid-compare`) — в задаче 8.

**Лог для проверки:** `TuneWizard/logs/2026-06-18 18-54-42_anon.bin` (не в git):

- ArduCopter 4.6.3, версия фильтра 2 → маска HMNCS 8 бит, если в логе нет `INS_RAW_LOG_OPT` (`hmncs_bits`), `ESCMSK` не пишется;
- строка контроллера в MSG — `StellarH7V2 0034002E 35335104 39363630` (`state.info.board`), рама — MSG «Frame: QUAD/X_REV»;
- `INS_HNTC2_ENABLE` = 0: полей `INS_HNTC2_*` в логе нет;
- на шаге 4 все оси «измерение ненадёжно».

**Что уже есть и переиспользуется:**

- принятое шагов: `state.steps[2] = { accepted, candidate_id, metrics: { peaks, current, log }, flags, evaluated_at }` (`step2_accept`, `step2_metrics_summary`); `state.steps[3] = { accepted, candidate_id, prop_in, metrics: { current, log }, flags, calc_key, evaluated_at }` (`step3_accept`, `step3_metrics_summary`: `gyro.band_dB`, `gyro.lag_ms`, `dterm[axis].dB`, `lag_ms[axis].P/D[10|30]`); `state.steps[4] = { accepted, axes: { roll|pitch|yaw: { candidate_id, flags, metrics } }, calc_key, evaluated_at }` (`step4_metrics_summary`: `reliable`, `measured.{rise_s, overshoot_pct}`, `log.{pm_deg, crossover_hz}`, `prediction.{pm_deg, overshoot_pct, rise_s, unstable}`);
- имена параметров шагов: `step2_param_names()`, `lowpass_param_names(state.params)`, `step4_param_names()`;
- параметры лога `state.params`: `get(name)` — последнее значение или `null`, `has(name)` (`log_params`, `core/log.js`);
- `.param`: `param_file_text`, `is_bitmask_param`, `hmncs_bits`, `mask_unsigned`, `mask_signed` (`core/params.js`); `notch_param_names()` (`core/filters.js`); `pidtune_axes` (`core/pidtune.js`);
- метаданные параметров: `step_load_metadata()` → промис, `step_find_metadata(data, name)` (`steps/common.js`);
- текст совета тестового полёта — `step4_test_flight_short` (`steps/step4.js`); подсказка второго notch — `step2_second_notch_hint` (`steps/step2.js`);
- проверки шага 0 — `state.checks`: `[{ id, status: ok|warn|fail, title, text, fix }]`;
- ключ FFT шага 1 — `step1.fft_key`; интервал — `state.settings.start/end`.

---

### Задача 1: `core/summary.js` — строки итога, `.param`, отпечаток входов

**Файлы:**

- создать `TuneWizard/core/summary.js`, `tests/tunewizard-summary.test.cjs`;
- изменить `TuneWizard/index.html` — подключить `core/summary.js` после `core/pidtune.js`.

**Функции** (контракт — комментарием перед каждой):

- `summary_same(name, a, b, bits)` — одно ли значение: оба `null` — да; один `null` — нет; маски (`is_bitmask_param`) — целые, сравниваются `mask_unsigned(…, bits)` для `*_HMNCS` и как есть для остальных масок; прочее — `Math.fround(a) === Math.fround(b)`.
- `summary_rows(ctx)` → `{ rows, conflicts, accepted }`. `ctx = { params, steps, names: { 2: […], 3: […], 4: […] }, filter_version, bits }`:
  - `accepted` — `{ 2: bool, 3: bool, 4: bool }` (шаг принят, `steps[n] != null`);
  - строки только принятых шагов, в порядке шагов 2 → 3 → 4 и порядке имён шага; строка `{ name, log, value, step, changed, note }`, `log = params.has(name) ? params.get(name) : null`;
  - `INS_GYRO_FILTER` (и любое имя, которое есть у двух шагов) — одна строка от последнего принятого шага; если значения шагов не `summary_same` — запись в `conflicts`: `{ name, values: { 2: x, 3: y }, used: 3 }`;
  - `*_ESCMSK` при `filter_version < 4` — строки нет (как `step2_save_param`);
  - **включаемый notch**: для каждого из `notch_param_names()` — если `log` поля `enable` `null` или ≤ 0, а принятое > 0, то все поля этого notch `changed = true`, у отсутствующих в логе `log = null`;
  - иначе параметр, которого нет в логе (`log = null`): `changed = false`, `note = "нет в логе — не пишется"`;
  - иначе `changed = !summary_same(name, log, value, bits)`;
  - строка шага 4 с `changed`, ось которой (`pidtune_axes[axis].rate` — префикс имени) в `steps[4].axes[axis].metrics.reliable === false`: `note = "ось ненадёжна — значение введено вручную"`.
- `summary_param_values(rows, bits)` → объект имя → число из строк с `changed`; `*_HMNCS` — `mask_signed(value, bits)` (как `step2_save_param`).
- `summary_param_text(rows, bits)` → `param_file_text(summary_param_values(rows, bits))` или `null`, если изменённых нет.
- `summary_file_name(log_name)` → имя без последнего расширения + `_tune.param` (`"a.b.bin"` → `"a.b_tune.param"`, `null` → `"tune.param"`).
- `summary_inputs_key(n, ctx)` → строка JSON `[start, end, fft_key, принятое шагов 2..n−1]`, `ctx = { start, end, fft_key, steps }`; `fft_key` — только для шагов 2–3 (они всегда считают шаг 1 до «Принять»), у шага 4 на его месте `null`: шаг 4 можно принять, не открывая шаг 1, и ключ FFT, появившийся позже, давал бы ложное «устарело»; принятое — `steps[k]?.accepted ?? null` с ключами в отсортированном порядке (как `candidate_key`), значения как есть.
- `summary_stale(n, ctx)` → `true`, если `steps[n] != null` и `steps[n].inputs !== summary_inputs_key(n, ctx)`; принятое без `inputs` — тоже устарело (защитная ветка).

**Тесты** (`tests/tunewizard-summary.test.cjs`; поддельные `params` — объект с `get`/`has` поверх словаря; скрипты: `Libraries/Param_Helpers.js`, `core/params.js`, `core/filters.js`, `core/pidtune.js` с их зависимостями в порядке страницы, затем `core/summary.js`):

- непринятые шаги — строк нет, `accepted` false;
- float32: принятое 0.7 при логе 0.699999988 — не изменён; 0.71 — изменён;
- маска HMNCS 8 бит: лог −128, принятое 128 — не изменена; `summary_param_values` пишет −128; при 32 битах — как есть;
- `ESCMSK` при версии фильтра 2 — строки нет, при 4 — есть;
- включаемый второй notch: в логе `INS_HNTC2_ENABLE` = 0 и полей нет, принято ENABLE 1, FREQ 153 — все поля `INS_HNTC2_*` изменены, `log = null`; notch остаётся выключенным — поля без лога не пишутся (`note`);
- `INS_GYRO_FILTER`: шаг 2 — 40, шаг 3 — 45 → одна строка, `step` 3, `value` 45, запись в `conflicts`; одинаковые значения — конфликта нет; принят только шаг 2 — строка от шага 2;
- ненадёжная ось с ручной правкой — `note`; ненадёжная ось со значениями лога — `changed` false, без `note`;
- `summary_param_text` — только изменённые, натуральный порядок имён, `null` без изменений;
- `summary_file_name` — примеры выше;
- `summary_inputs_key` / `summary_stale`: принятое шага 3 с `inputs` от текущего состояния — не устарело; поменять `steps[2].accepted`, интервал или `fft_key` — устарело; у шага 2 ключ не зависит от `steps[3]`; у шага 4 — не зависит от `fft_key`.

**Проверки:** `node --test tests/tunewizard-summary.test.cjs`, lint, `npm test`.

**Коммит:** `TuneWizard: ядро сводки — строки итога, .param, отпечаток входов` (+ трейлер), push.

---

### Задача 2: `core/summary.js` — «что перелететь»

**Файлы:**

- изменить `TuneWizard/core/summary.js`, `tests/tunewizard-summary.test.cjs`;
- изменить `TuneWizard/steps/step2.js` — `step2_second_notch_hint` берёт текст из ядра.

**Функции:**

- `summary_notch_enable_hint(enable_name, log_value)` → текст «В логе <ENABLE> = <log_value | 0>: на аппарате сначала запишите <ENABLE> = 1 и обновите список параметров — остальные <PREFIX>* появятся только после этого, затем загрузите файл ещё раз.» (префикс — имя без `ENABLE`; число — `param_to_string`). `step2_second_notch_hint(values)` оставляет свою проверку и зовёт эту функцию для `INS_HNTC2_ENABLE` — текст шага 2 не меняется (браузерный тест шага 2 это проверяет).
- `summary_refly(ctx)` → `[{ source, text }]`, `ctx = { checks, rows, steps, reboot_names, test_flight }`, по порядку:
  1. `source: "check"` — проверки со статусом `warn` или `fail` и непустым `fix`: `title + ": " + fix`;
  2. `source: "notch"` — для каждого включаемого notch (строка `enable` с `changed`, `log` `null` или ≤ 0, `value` > 0): `summary_notch_enable_hint`;
  3. `source: "reboot"` — если среди изменённых есть имена из `reboot_names`: «После записи перезагрузите полётный контроллер: изменены <имена через запятую> — они действуют после перезагрузки.»;
  4. `source: "test_flight"` — если шаг 4 принят и есть оси с `metrics.reliable === false`: «<оси через запятую>: » + `test_flight` (оси — `pidtune_axes[axis].title`);
  5. `source: "repeat"` — всегда: «Слетайте тем же профилем и загрузите лог в мастер: шаг 0 покажет, что применено, шаги 2–4 — сбылся ли прогноз.»
- `summary_reboot_names(names, metadata)` → имена из `names`, у которых в метаданных `RebootRequired` = `"True"`; поиск — функцией-аргументом (`(data, name) → запись | null`), чтобы ядро не зависело от `steps/common.js`; без метаданных — `[]`.

**Тесты:**

- проверка `warn` с `fix` попадает, `ok` и `warn` без `fix` — нет;
- включение второго notch — пункт с `INS_HNTC2_ENABLE` и префиксом `INS_HNTC2_`; текст `step2_second_notch_hint` не изменился (сравнить с прежней строкой дословно);
- `reboot_names` и изменённые `SCHED_LOOP_RATE`, `INS_HNTCH_HMNCS` — один пункт с обоими именами; неизменённый `SCHED_LOOP_RATE` — пункта нет;
- `summary_reboot_names` на поддельных метаданных и без них;
- ненадёжные крен и тангаж — пункт «крен, тангаж: …»; шаг 4 не принят — пункта нет;
- последний пункт всегда «repeat».

**Проверки:** `node --test tests/tunewizard-summary.test.cjs`, lint, `npm test`, `npm run test:tunewizard` (шаг 2: подсказка второго notch).

**Коммит:** `TuneWizard: ядро сводки — что перелететь` (+ трейлер), push.

---

### Задача 3: `core/passmem.js` — память прохода

Не зависит от задачи 2 — можно параллельно с ней.

**Файлы:**

- создать `TuneWizard/core/passmem.js`, `tests/tunewizard-passmem.test.cjs`;
- изменить `TuneWizard/index.html` — подключить `core/passmem.js` после `core/summary.js`.

**Константы:** `PASSMEM_KEY = "tunewizard_v1"`, `PASSMEM_VERSION = 1`, `PASSMEM_MAX = 20` (решение пользователя: по аппаратам; предел — `[наше]`).

**Функции** (`storage` — объект с `getItem`, `setItem`, `removeItem` или `null`):

- `passmem_read(storage)` → `{ passes, error }`: `storage` `null` или исключение — `{ passes: {}, error: "unavailable" }`; ключа нет — `{ passes: {}, error: null }`; JSON не разбирается, нет `passes` или `version !== PASSMEM_VERSION` — `{ passes: {}, error: "corrupt" }`; записи, не прошедшие проверку формы (`passmem_valid`), отбрасываются — тогда `"corrupt"` с уцелевшими `passes` (ревью задачи 3).
- `passmem_write(storage, passes)` → `null` или `"unavailable"` (исключение `setItem`, квота).
- `passmem_aircraft_key(info, file_name)` → `"fc:" + info.board`, если `board` — непустая строка; иначе `"log:" + [info.board_id ?? «—», info.frame ?? «—», file_name ?? «—»].join("·")` (номер платы APJ — из задачи 4).
- `passmem_record(ctx)` → проход. `ctx = { key, info, file_name, rows, steps, saved_at, stale, conflicts }` (`stale: { 2, 3, 4 }` и `conflicts` из `summary_rows` — по ревью: оценки устаревшего шага и шага, чьё значение перекрыто, — `null`):
  - `{ key, board: info.board, frame: info.frame, fw: info.fw_string, file_name, saved_at, changed: [{ name, log, value, step }], estimates: { 2, 3, 4 } }`; `changed` — строки итога с `changed`;
  - `estimates[2]` (шаг 2 принят и есть `metrics`) — `{ log: { band_dB, lag30_ms }, accepted: { … } }` из `metrics.log` / `metrics.current` (`lag_ms[30]`);
  - `estimates[3]` — `{ log, accepted }`, каждое `{ gyro_band_dB, dterm_dB: { roll, pitch }, lag30_ms: { roll: { P, D }, pitch: { P, D } } }` из `step3_metrics_summary`;
  - `estimates[4]` — `{ roll|pitch|yaw: { reliable, measured: { overshoot_pct, rise_s }, log: { pm_deg, crossover_hz }, prediction: { overshoot_pct, rise_s, pm_deg, unstable } | null } }`;
  - непринятый шаг или шаг без метрик — `null`.
- `passmem_put(passes, record)` → новый объект: запись по `record.key`; больше `PASSMEM_MAX` — удалить с наименьшим `saved_at`.
- `passmem_forget(passes, key)` → новый объект без `key`.
- `passmem_list(passes)` → массив проходов по убыванию `saved_at` (для выбора вручную).
- `passmem_applied(pass, params, bits)` → `{ rows: [{ name, step, proposed, now, status }], applied, total, same_log }`: `now = params.has ? params.get : null`; `status` — `"applied"` (`summary_same`), `"absent"` (`now` `null`), иначе `"other"`. `same_log` — все `now` равны `log` прохода (`summary_same`) и в проходе есть изменения; имя файла страница сравнивает сама.
- `passmem_step_status(applied, n, axis)` → `"none"` (шаг `n`, на шаге 4 — ось, ничего не менял), иначе накопительно по строкам шагов 2..n−1 и шага/оси (на шаге 4 — без строк с префиксом других осей): `"partial"` (не все `applied`), `"applied"` (ревью задачи 3).
- `passmem_compare(pass, applied, n, now, axis)` → `null` (`"none"` или нет `estimates[n]`), `{ status: "partial" }`, `{ status: "unreliable" }` (шаг 4: ось ненадёжна в проходе или `now.reliable === false`), `{ status: "ok", was, predicted, now }` — `was` = `estimates[n].log` (на шаге 4 — `measured` и `log` оси), `predicted` = `accepted` (шаг 4 — `prediction`), `now` — как передано (та же форма, что у `estimates[n].log`; шаг 4 — `{ reliable, measured, log }`).

**Тесты** (`tests/tunewizard-passmem.test.cjs`; хранилище — объект над словарём; скрипты — как в задаче 1 плюс `core/passmem.js`):

- запись и чтение туда-обратно; нет ключа; испорченный JSON и чужая версия — `"corrupt"`; хранилище бросает — `"unavailable"`; `setItem` бросает — `passmem_write` → `"unavailable"`;
- ключ аппарата: строка контроллера тестового лога → `fc:StellarH7V2 0034002E 35335104 39363630`; без `board` — запасной ключ с рамой и именем файла;
- `passmem_record`: изменённые только из `changed`; оценки непринятых шагов `null`; формы `estimates` для шагов 2–4 на поддельных `steps` (поля как у `step2/3/4_metrics_summary`);
- предел 20: 21-й проход вытесняет самый старый, а не последний добавленный;
- `passmem_applied`: применено (0.7 против 0.699999988), другое значение, нет в логе; `same_log`;
- `passmem_step_status` и `passmem_compare`: всё применено → `ok` с `was/predicted/now`; частично → `partial`; шаг ничего не менял → `null`; шаг 4 — ось ненадёжна в проходе или сейчас → `unreliable`.

**Проверки:** `node --test tests/tunewizard-passmem.test.cjs`, lint, `npm test`.

**Коммит:** `TuneWizard: ядро памяти прохода` (+ трейлер), push.

---

### Задача 4: отпечаток входов в шагах 2–4, рама в `log_info`

**Файлы:**

- изменить `TuneWizard/steps/step2.js`, `step3.js`, `step4.js` — «Принять»;
- изменить `TuneWizard/core/log.js` — `info.frame` и `info.board_id`; тест — `tests/tunewizard.test.cjs`;
- изменить `TuneWizard/steps/common.js` — помощник `step_inputs_key(n)`.

**Что сделать:**

- `step_inputs_key(n)` в `common.js` → `summary_inputs_key(n, { start: state.settings.start, end: state.settings.end, fft_key: step1.fft_key, filter_version: state.spectrum.filter_version, steps: state.steps })` (версия фильтра — по ревью задачи 1); парный `step_accepted_stale(n)` → `summary_stale(n, …)` с тем же контекстом.
- `step2_accept`, `step3_accept`, `step4_accept`: в объект `state.steps[n]` добавить `inputs: step_inputs_key(n)`. Ключ берётся **до** записи `state.steps[n]` (у шага `n` ключ от шагов `< n`, так что порядок не важен, но так понятнее).
- `log_info`: `frame` — текст после «Frame: » из первого сообщения MSG, которое так начинается (`log.get("MSG", "Message")`; нет MSG или строки — `null`). В тесте — поддельный лог с MSG `["ArduCopter V4.6.3 (92b0cd78)", "Frame: QUAD/X_REV"]` → `"QUAD/X_REV"`; без строки — `null`.
- `log_info`: `board_id` — номер платы APJ из VER (`version.board_id` от `get_version_and_board`, `null`, если нет) — для запасного ключа памяти (ревью задачи 3).
- Плитки шага 0 не меняются.

**Проверки:** lint, `npm test`, `npm run test:tunewizard`; в браузерном тесте после каждого «Принять» шагов 2–4 — `state.steps[n].inputs === step_inputs_key(n)` и `step_accepted_stale(n) === false`; в блоке «Устаревание» (шаг 3 принят заново после шага 4) — `step_accepted_stale(4) === true`, `step_accepted_stale(3) === false`.

**Коммит:** `TuneWizard: отпечаток входов принятого, рама в сводке лога` (+ трейлер), push.

---

### Задача 5: страница шага 5

**Файлы:**

- создать `TuneWizard/steps/step5.js`, `TuneWizard/steps/memory.js` (в этой задаче только хранилище и сохранение — `memory_storage()`, `memory_save()`; блок шага 0 и строки сравнения — задачи 6–7);
- изменить `TuneWizard/index.html` — разметка секции 5, скрипты (`steps/memory.js` и `steps/step5.js` после `steps/step4.js`), CSS и печать;
- изменить `TuneWizard/wizard.js` — `step5_init` / `step5_show` / `step5_reset` в `init_wizard`, `on_show_step`, `reset`;
- изменить `tests/tunewizard-browser.cjs`.

**Разметка секции 5** (вместо заглушки «Шаг появится на этапе 5»): надзаголовок «05 · Сводка», заголовок «Итог прохода», короткий `lede`; `div.print-head#step5_print_head` (только для печати); `div.verdict#verdict5`; `div.stats#tiles5`; блок «Шаги» — `div.tablewrap#steps5` (таблица: шаг · состояние · итог · действие); блок «Изменения» — `div.tablewrap#changes5` (параметр · было · станет · шаг · пометка), `p.note#conflicts5`, `details#unchanged5` (`summary` — «Без изменений — N параметров», внутри таблица параметр · значение · шаг · пометка); блок «Что перелететь» — `ol#refly5`; ряд кнопок `#step5_download` «Скачать .param», `#step5_remember` «Запомнить проход», `#step5_print` «Печать»; `p.note#step5_note` (сообщения файла и памяти).

**`steps/step5.js`:**

- `step5_context()` — `ctx` для `summary_rows`: `params: state.params`, `steps: state.steps`, `names: { 2: step2_param_names(), 3: lowpass_param_names(state.params), 4: step4_param_names() }`, `filter_version: state.env?.filter_version ?? 1`, `bits: hmncs_bits(state.params, state.env?.filter_version ?? 1)`.
- `step5_show()` — рисует сводку сразу (`step5_render` под `step_try(…, "verdict5", "шага 5")`); если метаданные ещё не загружены (`step_metadata()` — `null`), дополнительно `step_load_metadata().then(() => step5_render())`: пункт о перезагрузке появится после загрузки. **Различать «грузятся» и «не загрузились»** (ревью задачи 2): `step_metadata()` даёт `null` в обоих случаях — в `common.js` в `catch` у `step_load_metadata` ставить `step_metadata_state.failed = true`; странице `reboot_names` = `failed ? null : (data ? summary_reboot_names(…) : [])` — пока грузятся, пункта о перезагрузке нет, после загрузки появится, после сбоя — общий пункт. Тест в `tests/tunewizard-common.test.cjs` на флаг сбоя.
- `step5_render()`:
  - **плитки** (`step_tile`): «Аппарат» — `state.info.board ?? "—"` и рама подписью; «Лог» — `state.file_name`; «Изменено» — число строк `changed` (акцент); «Приняты шаги» — «2, 3, 4» / «нет»;
  - **вердикт** (`step_verdict`): ни один шаг не принят или лог не Copter — `warn` «Менять нечего: ни один из шагов 2–4 не принят.»; есть устаревшие (`step_accepted_stale`), отметки шагов (шаг 2 — `flags` с `worse_peaks`, `lag_over` или `incomplete`, как в `step2_render_verdict`; шаг 3 — `step3_flagged(flags)`; шаг 4 — непустые `axes[*].flags.reasons`) или ненадёжные оси шага 4 — `warn` с перечнем; иначе `ok` «Готово: изменено N параметров.»; принято, но изменений нет — `ok` «Принятые значения совпадают с логом — менять нечего.»;
  - **шаги**: строка на шаг 2–4 — «принят» (+ итог: шаг 2 — полоса и задержка на 30 Гц к логу из `metrics`; шаг 3 — шум гироскопа, шум D крена/тангажа и задержка путей P/D на 30 Гц к логу; шаг 4 — по осям «прогноз перерегулирования X %, запас фазы Y°» или «ненадёжно» / «прогноз недостоверен»), «не принят — параметры шага остаются как в логе», «устарело — примите шаг N заново» с кнопкой «К шагу N» (`set_step(n)`). Отметки — словами теми же функциями, что у вердиктов шагов: шаг 2 — `step2_accepted_flags_text(accepted)`, шаг 3 — `step3_flags_text(flags, metrics.current, metrics.log)` (проверить, что функция принимает сводку `step3_metrics_summary`; если нет — привести, не меняя текст вердикта шага 3), шаг 4 — `flags.reasons.join("; ")`;
  - **изменения**: строки `changed`; «было» — `step_value_text(log)` или «нет в логе»; «станет» — `step_value_text(value)` (маски — как в форме шага 2, числом); `conflicts` — строкой «INS_GYRO_FILTER: шаг 2 — X, шаг 3 — Y, в файл идёт шаг 3.»; `details` — неизменённые;
  - **что перелететь**: `summary_refly({ checks: state.checks, rows, reboot_names: summary_reboot_names(имена изменённых, step_metadata(), step_find_metadata), unreliable_axes, test_flight: step4_test_flight_short })` (по ревью задачи 2: `reboot_names` `null` — метаданные не загрузились, общий пункт о перезагрузке; `unreliable_axes` — ключи осей с ненадёжным измерением: из `state.steps[4].axes[*].metrics.reliable`, а если шаг 4 не принят — из уже посчитанного шага 4 (`step4.calc[axis].status !== "ok"`, только при актуальном расчёте); шаг 4 не открывался — `[]`; «repeat» — только при изменённых строках, при пустом списке блок «Что перелететь» скрыт);
  - кнопки `#step5_download` и `#step5_remember` выключены без изменённых строк.
- `step5_download()` — `saveAs(new Blob([text], { type: "text/plain;charset=utf-8" }), summary_file_name(state.file_name))`, затем `memory_save()`; в `#step5_note` — «Файл <имя>: N параметров. Память прохода сохранена.» или текст ошибки памяти.
- `step5_remember()` — `memory_save()` и сообщение в `#step5_note`.
- `step5_print()` — `window.print()`; перед печатью заполнить `#step5_print_head`: «Мастер настройки · <лог> · <аппарат> · <дата печати>».

**`steps/memory.js` (часть задачи 5):**

- `memory_storage()` → `window.localStorage` или `null` (доступ в `try/catch`).
- `memory_save()` → текст для `#step5_note`: `passmem_read` → `passmem_put(passes, passmem_record({ key: passmem_aircraft_key(state.info, state.file_name), info: state.info, file_name: state.file_name, rows, steps: state.steps, saved_at: Date.now(), stale: { 2: step_accepted_stale(2), 3: step_accepted_stale(3), 4: step_accepted_stale(4) }, conflicts }))` → `passmem_write` (`rows` и `conflicts` — из `summary_rows(step5_context())`); ошибки: `"unavailable"` — «Браузер не даёт сохранить память прохода (приватный режим или запрет хранилища).»; `"corrupt"` при чтении — сохранить (уцелевшие записи + новая) и добавить «Часть прежней памяти не прочитана — удалена.»

**CSS и печать** (`index.html`): `.print-head{display:none}`; в `@media print` — `.hero .lede,.wizbar,.plot,section[data-step]:not([data-step="5"]){display:none!important}`, `.print-head{display:block}`, `tr{break-inside:avoid}`. Остальной вид — существующие классы (`.stats`, `.verdict`, `.tablewrap`, `.note`).

**Браузерный тест** (`tests/tunewizard-browser.cjs`), после блока «Устаревание» (шаг 3 принят заново после шага 4):

- открыть шаг 5: вердикт `warn` с упоминанием устаревшего шага 4; в таблице шагов у шага 4 — «устарело» и кнопка «К шагу 4»;
- строки изменений совпадают с `summary_rows(step5_context()).rows.filter(r => r.changed)` (имена и «станет»); есть `INS_GYRO_FILTER` = 39 от шага 3;
- скачать `.param` (`page.waitForEvent('download')` + клик `#step5_download`): имя `2026-06-18 18-54-42_anon_tune.param`; `parse_param_file` содержимого (в `page.evaluate`) равен `summary_param_values(rows, bits)`; в `localStorage` есть `tunewizard_v1` с проходом `fc:StellarH7V2 0034002E 35335104 39363630`; в записи `estimates[4] === null` (шаг 4 устарел — сквозная проверка ревью задачи 3), `estimates[2].log.band_dB` и `estimates[3].log.lag30_ms.roll.P` — числа (формы метрик страницы совпадают с ядром);
- «что перелететь» — последний пункт «Слетайте тем же профилем…»; есть пункт тестового полёта (все оси ненадёжны);
- печать: `page.emulateMedia({ media: 'print' })` → `.wizbar` и секция шага 0 `display: none`, `#step5_print_head` виден, кнопки скрыты; снимок `step5-print.png`; затем `emulateMedia({ media: 'screen' })`; снимок `step5.png`;
- проверить ширину страницы без горизонтальной прокрутки, как у шагов 3–4.

**Проверки:** lint, `npm test`, `npm run test:tunewizard`.

**Коммит:** `TuneWizard: шаг 5 — сводка, .param, печать` (+ трейлер), push.

---

### Задача 6: шаг 0 — блок «Прошлый проход»

**Файлы:**

- изменить `TuneWizard/steps/memory.js`, `TuneWizard/index.html` (разметка блока на шаге 0 после `#log_checks`), `TuneWizard/wizard.js` (вызов после `render_checks()` в `load`, сброс в `reset`);
- изменить `tests/tunewizard-browser.cjs`.

**Разметка:** `div#memory0[hidden]` — заголовок «Прошлый проход», `p.note#memory0_head`, `div.verdict#memory0_verdict`, `div.tablewrap#memory0_table` (параметр · предлагалось · в логе сейчас · итог), ряд: `select#memory0_pick` (только для лога без строки контроллера), кнопка `#memory0_forget` «Забыть проход этого аппарата».

**`steps/memory.js`:**

- `memory_state = { pass: null, applied: null, key: null }` — выбранный проход для лога (строки сравнения задачи 7 берут его отсюда).
- `memory_render_step0()` (вызов из `load` — под `step_try`, чтобы сбой памяти не ронял загрузку лога; ревью задачи 3):
  - ключ `passmem_aircraft_key(state.info, state.file_name)`; лог со строкой контроллера — проход по ключу; без неё — `select` со списком `passmem_list` («дата · плата · лог»), по умолчанию ничего не выбрано;
  - прохода нет — блок скрыт (при `"corrupt"` — блок только с `warn` «Часть памяти прохода не прочитана — удалена.»); `"corrupt"` и проход аппарата уцелел — проход показывается как обычно, с той же строкой предупреждения; `"unavailable"` — блок скрыт;
  - проход есть: `#memory0_head` — «Сохранён <дата>, лог <имя>, прошивка <fw>»; `passmem_applied` → таблица (итог: «применено» / «другое значение» / «нет в логе»); вердикт: `same_log` и то же имя файла — `warn` «Это лог прошлого прохода — значения ещё не применялись.»; все применены — `ok` «Применено N из N.»; иначе `warn` «Применено K из N.»
- `memory_forget()` — `passmem_forget` + запись + скрыть блок, `memory_state.pass = null`.
- `memory_reset()` — скрыть блок, очистить `memory_state`.

**Браузерный тест:** после скачивания `.param` в задаче 5 тест уже доходит до блока «Повторная загрузка того же лога» — там проверить: `#memory0` виден, вердикт «Это лог прошлого прохода…», строк в таблице столько же, сколько изменённых в проходе. «Забыть проход» → блок скрыт, в `localStorage` прохода нет. Затем записать проход заново (`page.evaluate` с `memory_save()` невозможен без принятого — вместо этого положить синтетический проход в `localStorage` через `page.evaluate`, где `changed[i].value` = текущее значение лога, а `log` — другое) и вызвать `memory_render_step0()`: вердикт «Применено N из N.»

**Проверки:** lint, `npm test`, `npm run test:tunewizard`.

**Коммит:** `TuneWizard: шаг 0 — прошлый проход` (+ трейлер), push.

---

### Задача 7: строки сравнения на шагах 2–4

**Файлы:**

- изменить `TuneWizard/steps/memory.js`, `TuneWizard/steps/step2.js`, `step3.js`, `step4.js`, `TuneWizard/index.html` (по `p.note#memory2`, `#memory3`, `#memory4` под вердиктом шага; у шага 4 — внутри панели оси, под `#axis_verdict4`);
- изменить `tests/tunewizard-browser.cjs`.

**`memory_line(n, now, axis)`** → текст или `null` по `passmem_compare(memory_state.pass, memory_state.applied, n, now, axis)`:

- `null` — строка скрыта;
- `partial` — «Прошлый проход (<дата>): параметры шагов 2–N применены не все — сравнивать нечего.» (накопительно: прогноз шага N считался от принятого на шагах до него; ревью задачи 3);
- `unreliable` — «Прошлый проход (<дата>): измерение ненадёжно — сравнивать нечем.»;
- `ok`:
  - шаг 2: «Прошлый проход (<дата>): полоса <was> → прогноз <predicted> → в этом логе <now> дБ; задержка на 30 Гц <…> мс. Шум зависит от полёта: газ, манёвры.»;
  - шаг 3: шум гироскопа, шум D крена и тангажа, задержка путей P/D на 30 Гц — в том же виде, с той же оговоркой;
  - шаг 4 (ось): «перерегулирование <was> → прогноз <predicted> → в этом логе <now> %; нарастание … мс; запас фазы … °».
- числа — как в метриках шагов (`toFixed` тех же разрядов).

**Где «в этом логе»:** только величины конфигурации лога (ревью задачи 3). Шаг 2 — `step2.evaluations.log` (`band_dB`, `lag_ms[30]`). Шаг 3 — `step3_metrics_summary(step3.evaluations.log)` в форме `estimates[3].log`, но только если notch-база шага 3 — notch лога (`candidate_key(step3.base) === candidate_key(values_from_log())`): после «Принять» на шаге 2 нового прохода оценка «как в логе» считается уже с принятым notch — тогда числа Z нет, вместо него «оценка этого лога видна до «Принять» на шаге 2». Шаг 4 — `step4_metrics_summary(axis, null)`: `measured` всегда; запас фазы и частота среза — только если фильтры для прогноза не отличаются от лога (`!step4_gyro_changed()` и FLTE/FLTD шага 3 не приняты другими), иначе без них. Строка рисуется вместе с вердиктом шага: `step2_render_verdict`, `step3_render_verdict` и `step4_render_axis_verdict` зовут `memory_show(n, axis)` (`axis` — только у шага 4, ось открытой вкладки); нет расчёта — строка скрыта.

**Браузерный тест:** синтетический проход (как в задаче 6) с изменённым параметром шага 2, применённым в логе, и `estimates[2]` → на шаге 2 `#memory2` виден и начинается с «Прошлый проход»; проход с неприменённым параметром шага 3 → `#memory3` — «применены не все»; ось шага 4 (все ненадёжны) → `#memory4` — «измерение ненадёжно». Для синтетики брать значения из `state.params` в `page.evaluate`.

**Проверки:** lint, `npm test`, `npm run test:tunewizard`.

**Коммит:** `TuneWizard: строки сравнения с прошлым проходом на шагах 2–4` (+ трейлер), push.

---

### Задача 8: Readme, описание тестов, финальный прогон

**Файлы:** `TuneWizard/Readme.md` (раздел шага 5, память прохода, печать; убрать «шаг 5 — на этапе 5»), `tests/README.md` (новые тесты; браузерный — шаги 0–5).

**Проверки (все):** lint 0; `npm test`; `npm run test:tunewizard`; `npm run test:tunewizard-compare` и `npm run test:tunewizard-pid-compare` — отклонение 0 (этап их не трогает, но шаги 2–4 правились).

**Коммит:** `TuneWizard: Readme и описание тестов для этапа 5` (+ трейлер), push.
