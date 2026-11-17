# Этап 11 «Свой интервал анализа PID» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** У шага 4 — свой интервал анализа PID, который выбирается ползунком графика полёта на шаге 4 и не трогает фильтры (шаги 1–3).

**Architecture:** Интервал PID — состояние шага 4 (`step4.interval`; `null` — повторяет интервал шага 0). Расчёт, ключ расчёта, «устарело» шага 4 и сводка берут его через `step4_interval()`. Участок ACRO «Rate Loop Only» по умолчанию находит чистая функция ядра `pidtune_acro_interval` в окне полёта. Новый график `PidFlight4` с `rangeslider` — над вкладками осей.

**Tech Stack:** браузерные скрипты с общей глобальной областью, Plotly, тесты `node:test` (ядро и шаг 4 под заглушками через `vm.runInThisContext`), Playwright в Chrome.

**Spec:** `docs/plans/2026-11-17-tune-wizard-stage11-design.md` — исполнитель читает его вместе с планом.

## Global Constraints

- Всё на русском: тексты страницы, комментарии, сообщения коммитов.
- Файлы правятся на месте; окончания строк файла сохраняются (большинство файлов — CRLF).
- Оформление — тема «Графит» и реестр `register_plot`; новых CSS-токенов нет; цвета рядов — из `plot_palette()`.
- Каждый новый скрипт подключается в `TuneWizard/index.html` (ESLint берёт глобалы оттуда); новых скриптов план не требует.
- Шаги 1–3 считают на интервале шага 0 (`state.settings.start/end`) — их код не меняется.
- QuadPlane: шаг 4 закрыт, блока интервала PID у него нет; `step4_interval()` всё равно должна работать (сводка зовёт её у любого лога).
- Подписи источника интервала — ровно: `step0` → «как на шаге 0», `acro` → «участок ACRO «Rate Loop Only»», `own` → «свой».
- Пауза перед пересчётом после ползунка или полей — `step4_interval_delay_ms = 700`.
- Прореживание рядов графика — не больше `pidflight4_max_points = 6000` точек на ряд (как `tarac4_max_points`).
- Коммиты: `git commit -F <файл без BOM>`, в конце строка `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; ветка `tune-wizard-next9`; в `main` не пушить.
- Проверки: `npm run lint`, `npm test`; браузерные — с `CHROME_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe"`.

## Review Focus

1. Программный `Plotly.relayout` графика `PidFlight4` (смена интервала полями, «Как на шаге 0», ACRO) вызывает обработчик `plotly_relayout` — источник не должен стать «свой» сам собой. Тест — задача 4, шаг 1 («Как на шаге 0» → источник остаётся «как на шаге 0»).
2. Ушли с шага 4 до конца паузы 0.7 с — отложенный пересчёт не должен рисовать шаг 4 поверх другого шага. Тест — задача 4, шаг 1.
3. Новый лог не наследует интервал PID прошлого лога. Тест — задача 2, шаг 1 (`step4_reset`).
4. Лог без MODE, без окна полёта или без участка ACRO — интервал как на шаге 0, без ошибок. Тест — задача 1, шаг 1.
5. Интервал PID без данных PID — вердикт зовёт выбрать другой интервал PID, а не «на шаге 0». Тест — задача 2, шаг 1.

---

### Task 1: Участок ACRO для интервала PID и подписи интервала — ядро

**Files:**
- Modify: `TuneWizard/core/pidtune.js` (рядом с `pidtune_log_mode`, ≈ строка 1133)
- Test: `tests/tunewizard-pidtune.test.cjs` (рядом с тестом «pidtune_mode_segments и rate_only_segment», ≈ строка 803; помощники `mode_log`, `log_params`, `ANG` — оттуда)

**Interfaces:**
- Produces:
  - `pidtune_acro_interval(log, params, range, rules = pidtune_rules)` → `{ start, end } | null` — самый длинный участок режима `rules.acro_mode` в `range` (`pidtune_mode_segments(log, range)`; участки уже в границах `range`), на котором каждое действующее `ACRO_OPTIONS` (`pidtune_param_values(params, "ACRO_OPTIONS", [s.start, s.end])`) содержит бит `rules.acro_rate_only_bit`; границы — целые секунды внутрь (`Math.ceil(start)`, `Math.floor(end)`); `null` — участка нет, бит не выставлен или после округления `end <= start`. В отличие от `rate_only_segment`, участок находится и когда весь `range` — ACRO.
  - `pidtune_interval_sources = { step0: "как на шаге 0", acro: "участок ACRO «Rate Loop Only»", own: "свой" }`.
  - `pidtune_interval_text(interval)` → `"289–370 с, участок ACRO «Rate Loop Only»"` — `start + "–" + end + " с, " + pidtune_interval_sources[source]` (тире — «–»).

- [ ] **Step 1: Написать падающий тест** `test('pidtune_acro_interval: участок ACRO «Rate Loop Only» в окне полёта — целые секунды внутрь, весь интервал в ACRO — тоже; без MODE, бита или участка — null; pidtune_interval_text', …)`:

```js
// STAB@0 → ACRO@20.3 → LAND@300.7, бит 2: окно полёта 10–310 → 21–300
const log = mode_log([[0, 0], [20.3, 1], [300.7, 9]], [['ACRO_OPTIONS', 2, 0.3], ...ANG])
const params = log_params(log)
assert.deepEqual(pidtune_acro_interval(log, params, [10, 310]), { start: 21, end: 300 })
// Последний режим — ACRO до конца лога (как четвёртый лог: данные до 386.6 с): окно полёта обрезает участок
const tail = mode_log([[0, 0], [288.07, 1]], [['ACRO_OPTIONS', 2, 0.3], ...ANG])
assert.deepEqual(pidtune_acro_interval(tail, log_params(tail), [282, 370]), { start: 289, end: 370 })
assert.deepEqual(pidtune_acro_interval(tail, log_params(tail), [0, 387]), { start: 289, end: 387 })
// Весь интервал — ACRO: участок — весь интервал
assert.deepEqual(pidtune_acro_interval(log, params, [50, 100]), { start: 50, end: 100 })
// Самый длинный из нескольких
const two = mode_log([[0, 0], [20, 1], [30, 0], [40, 1], [100, 9]], [['ACRO_OPTIONS', 2, 0.3], ...ANG])
assert.deepEqual(pidtune_acro_interval(two, log_params(two), [0, 120]), { start: 40, end: 100 })
// Бит не выставлен, бит включили во время участка, ACRO не было, нет MODE, короче секунды — null
const off = mode_log([[0, 0], [20, 1], [300, 9]], [['ACRO_OPTIONS', 1, 0.3], ...ANG])
assert.equal(pidtune_acro_interval(off, log_params(off), [10, 310]), null)
const late = mode_log([[0, 0], [20, 1], [300, 9]], [['ACRO_OPTIONS', 0, 0.3], ['ACRO_OPTIONS', 2, 50], ...ANG])
assert.equal(pidtune_acro_interval(late, log_params(late), [10, 310]), null)
const stab = mode_log([[0, 0]], [['ACRO_OPTIONS', 2, 0.3], ...ANG])
assert.equal(pidtune_acro_interval(stab, log_params(stab), [10, 310]), null)
assert.equal(pidtune_acro_interval({ messageTypes: {}, get: () => undefined }, params, [10, 310]), null, 'лог без MODE')
assert.equal(pidtune_acro_interval(log, params, [20.2, 20.9]), null)
// Подписи
assert.equal(pidtune_interval_text({ start: 289, end: 370, source: 'acro' }), '289–370 с, участок ACRO «Rate Loop Only»')
assert.equal(pidtune_interval_text({ start: 282, end: 370, source: 'step0' }), '282–370 с, как на шаге 0')
assert.equal(pidtune_interval_text({ start: 300, end: 320, source: 'own' }), '300–320 с, свой')
```

- [ ] **Step 2: Запустить — падает.** `node --test tests/tunewizard-pidtune.test.cjs` → FAIL: `pidtune_acro_interval is not defined`.
- [ ] **Step 3: Реализовать** `pidtune_acro_interval`, `pidtune_interval_sources`, `pidtune_interval_text` в `core/pidtune.js` с комментарием (что и почему: окно полёта — дизайн, раздел 5).
- [ ] **Step 4: Запустить — проходит.** `node --test tests/tunewizard-pidtune.test.cjs` → все pass; `npx eslint TuneWizard/core/pidtune.js tests/tunewizard-pidtune.test.cjs` — чисто.
- [ ] **Step 5: Коммит** «TuneWizard: этап 11 — участок ACRO для интервала PID (ядро)».

### Task 2: Состояние интервала PID и расчёт шага 4

**Files:**
- Modify: `TuneWizard/steps/step4.js` — объект `step4` (≈ 38), `step4_reset` (≈ 254), `step4_calc_key` (≈ 646), `step4_compute` (≈ 862: `range`), `step4_acro_interval`/`step4_acro_hint` (≈ 119–143), `step4_acro_apply` (≈ 1083), вердикт «Нет данных PID …» (≈ 1371)
- Modify: `TuneWizard/index.html:755` — заметка под окном FFT: «Интервал анализа — общий, с шага 0.» → «Интервал PID — над вкладками осей; фильтры (шаги 1–3) считаются на интервале шага 0.»
- Test: `tests/tunewizard-audit-d.test.cjs` — тест I-3 (≈ 273) переписать, новый тест «Этап 11: …»

**Interfaces:**
- Consumes: `pidtune_acro_interval`, `pidtune_interval_text` (задача 1).
- Produces:
  - поля `step4.interval` (`null` | `{ start, end, source: "acro" | "own" }`) и `step4.interval_ready` (`false` — умолчание для лога ещё не выбрано); `step4_reset` возвращает обоим `null`/`false`.
  - `step4_flight_range()` → `[start, end]`: `state.info?.flight` → `[flight.start, flight.end]`, иначе `[state.settings.min, state.settings.max]`.
  - `step4_interval()` → `{ start, end, source: "step0" | "acro" | "own" }`. При первом вызове после `step4_reset` (если `!interval_ready` и лог загружен) выбирает умолчание: `pidtune_acro_interval(state.log, state.params, step4_flight_range())` → `step4.interval = { ...acro, source: "acro" }`; `interval_ready = true`. `step4.interval == null` → `{ start: state.settings.start, end: state.settings.end, source: "step0" }`.
  - `step4_set_interval(start, end, source)` → `boolean`: `Math.floor(start)`, `Math.ceil(end)`, зажим в `[state.settings.min, state.settings.max]`; не числа или `end <= start` — `false`, состояние не меняется; иначе `step4.interval = { start, end, source }`, `true`. Ничего не считает и не рисует.
  - `step4_interval_follow()` — `step4.interval = null` (снова «как на шаге 0»).
  - `step4_acro_interval()` → `{ start, end } | null`: `pidtune_acro_interval(state.log, state.params, пересечение step4_interval() и step4_flight_range())`; `null` — нет лога, нет участка, пересечение пустое или участок совпадает с интервалом PID. Готовый расчёт шага не нужен.
  - `step4_acro_apply()` — `step4_set_interval(acro.start, acro.end, "acro")`, затем `step4_show()`; поля шага 0 и `interval_input_changed` не трогает.
  - `step4_acro_hint(capital)` — текст: «лог тестового полёта: сузьте интервал PID до участка ACRO (A–B с) — кнопка «Интервал — участок ACRO» над вкладками осей шага 4».
  - Ключ расчёта и расчёт: `step4_calc_key` и `step4_compute` берут `step4_interval().start/end` вместо `state.settings.start/end`.
  - Вердикт без данных: «Нет данных PID ни по одной оси в интервале PID — выберите другой интервал PID (график над вкладками осей).»

- [ ] **Step 1: Написать падающий тест** `test('Этап 11: интервал PID — умолчание (участок ACRO в окне полёта или как на шаге 0), свой, «Как на шаге 0», зажим и порядок границ, сброс на новый лог; расчёт и ключ — по интервалу PID', …)` по образцу I-3 (поддельный лог `make_log`, `load`). Проверить:
  - лог с ACRO с 0 с и окном полёта `state.info.flight = { start: 10, end: 50 }` → `step4_interval()` = `{ start: 10, end: 50, source: 'acro' }`; без `state.info.flight` — по `[state.settings.min, state.settings.max]`;
  - лог без бита Rate Loop Only (`ACRO_OPTIONS 1`) → `source: 'step0'`, границы — `state.settings.start/end`; смена `state.settings.start` → `step4_interval().start` следует за ней;
  - `step4_set_interval(12.4, 30.2, 'own')` → `true`, интервал `{ 12, 31, 'own' }`; смена `state.settings` его не меняет; `step4_set_interval(40, 30, 'own')` и `step4_set_interval(NaN, 30, 'own')` → `false`, интервал прежний; `step4_set_interval(-5, 1e6, 'own')` → зажат в `[min, max]`;
  - `step4_interval_follow()` → снова `source: 'step0'`;
  - `step4_calc_key()` начинается с `[12, 31, …]` при своём интервале; `step4_compute()` → `step4.calc.roll.range` = `[12, 31]`;
  - интервал без данных PID (например, `[55, 59]` при данных 0–60 и наборе с 0.5 с — подобрать так, чтобы у всех осей `nodata`) → `verdict4` содержит «в интервале PID — выберите другой интервал PID»;
  - `step4_reset()` → `step4.interval === null`, `step4.interval_ready === false`.
- [ ] **Step 2: Переписать тест I-3** под новое поведение: `step4_acro_interval()` считает по логу (участок ACRO в пересечении интервала PID и окна полёта), а не по `res.mode.rate_only_segment`; текст подсказки — новый (Interfaces); кнопка: `step4_acro_apply()` ставит `step4_interval()` = участок с `source: 'acro'` и зовёт `step4_show`, `interval_input_changed` не вызывается; участок совпадает с интервалом PID → `step4_acro_interval() === null`.
- [ ] **Step 3: Запустить — падают.** `node --test tests/tunewizard-audit-d.test.cjs` → FAIL (`step4_interval is not defined` и I-3).
- [ ] **Step 4: Реализовать** всё из Interfaces в `steps/step4.js` и заметку в `index.html`. `step4_acro_interval` больше не читает `rate_only_segment` (поле ядра остаётся — его проверяет `tunewizard-pidtune.test.cjs`).
- [ ] **Step 5: Запустить — проходит.** `node --test tests/tunewizard-audit-d.test.cjs` → pass; `npm test` → все pass; `npx eslint TuneWizard tests` — чисто.
- [ ] **Step 6: Коммит** «TuneWizard: этап 11 — интервал PID шага 4: состояние, расчёт, участок ACRO».

### Task 3: «Устарело» и сводка по интервалу PID

**Files:**
- Modify: `TuneWizard/steps/common.js:114-127` (`step_summary_context`)
- Modify: `TuneWizard/core/summary.js` (`summary_inputs_key` ≈ 205; текст «параметры менялись после интервала анализа» ≈ 139 и комментарии ≈ 43, 57, 183)
- Modify: `TuneWizard/steps/step4.js:1173` (`step4_accept`: `state.steps[4]`)
- Modify: `TuneWizard/steps/step5.js` — причины (≈ 36), строка шага 4 (`step5_step_result`, ≈ 149), «PID менялись после интервала анализа» (≈ 382)
- Test: `tests/tunewizard-summary.test.cjs` (рядом с тестом `summary_inputs_key`, ≈ 524)

**Interfaces:**
- Consumes: `step4_interval()` (задача 2), `pidtune_interval_text` (задача 1).
- Produces:
  - `step_summary_context()` — плюс поля `pid_start`, `pid_end` (из `step4_interval()`).
  - `summary_inputs_key(n, ctx)`: для `n == 4` первые два элемента — `ctx.pid_start ?? ctx.start`, `ctx.pid_end ?? ctx.end`; для шагов 2–3 — как раньше `ctx.start`, `ctx.end`.
  - `state.steps[4].interval` — `step4_interval()` на момент «Принять» (`{ start, end, source }`).
  - Строка шага 4 сводки: `step5_step_result(4, accepted).text` начинается с `"интервал PID " + pidtune_interval_text(accepted.interval) + "; "`, если `accepted.interval` есть (принятое до этапа 11 — без интервала, как раньше).
  - Причина устаревания шага 4: `step5_stale_inputs[4] = "интервал PID или фильтры шагов 2–3"`.
  - Тексты про изменение PID после интервала: «…после интервала PID» (`core/summary.js` ≈ 139, `step5.js` ≈ 382).

- [ ] **Step 1: Написать падающий тест** `test('summary_inputs_key: шаг 4 — по интервалу PID (pid_start/pid_end), шаги 2–3 — по интервалу шага 0; без pid_* — как раньше', …)`:

```js
const ctx = { ...rows_ctx({ steps: [] }), start: 10, end: 100, pid_start: 20, pid_end: 90, fft_key: 'batch:16', filter_version: 4 }
assert.deepEqual(JSON.parse(summary_inputs_key(4, ctx)).slice(0, 2), [20, 90])
assert.deepEqual(JSON.parse(summary_inputs_key(2, ctx)).slice(0, 2), [10, 100])
assert.deepEqual(JSON.parse(summary_inputs_key(3, ctx)).slice(0, 2), [10, 100])
// Смена интервала шага 0 при своём интервале PID: шаги 2–3 устаревают, шаг 4 — нет; смена интервала PID — наоборот
assert.equal(summary_inputs_key(4, { ...ctx, start: 0 }), summary_inputs_key(4, ctx))
assert.notEqual(summary_inputs_key(2, { ...ctx, start: 0 }), summary_inputs_key(2, ctx))
assert.notEqual(summary_inputs_key(4, { ...ctx, pid_end: 80 }), summary_inputs_key(4, ctx))
assert.equal(summary_inputs_key(2, { ...ctx, pid_end: 80 }), summary_inputs_key(2, ctx))
// Без pid_* (старые вызовы) — интервал шага 0
const { pid_start, pid_end, ...old } = ctx
assert.deepEqual(JSON.parse(summary_inputs_key(4, old)).slice(0, 2), [10, 100])
```

И строку о параметрах после интервала — в существующем тесте `summary_rows`, где проверяется «в конце лога другое значение» (найти по тексту): ожидание «…после интервала PID».
- [ ] **Step 2: Запустить — падает.** `node --test tests/tunewizard-summary.test.cjs` → FAIL.
- [ ] **Step 3: Реализовать** всё из Interfaces.
- [ ] **Step 4: Запустить — проходит.** `npm test` → все pass (поправить ожидания текстов «интервала анализа» → «интервала PID» в других Node-тестах, если они их проверяют); `npx eslint TuneWizard tests` — чисто.
- [ ] **Step 5: Коммит** «TuneWizard: этап 11 — «устарело» и сводка шага 4 по интервалу PID».

### Task 4: Блок «Интервал PID» на шаге 4 — график, поля, кнопки

**Files:**
- Modify: `TuneWizard/index.html` — новый блок после `<p class="lede">` шага 4 (≈ 743) и до `<div class="lab">`; строка `#step4_acro_row` (≈ 759–761) удаляется, кнопка `#step4_acro_interval` переезжает в блок
- Modify: `TuneWizard/steps/step4.js` — `step4_init` (обработчики), `step4_setup_plots` (график), `step4_reset` (список скрываемого, график), `step4_show`/`step4_redraw_all` (отрисовка блока, видимость кнопок)
- Test: `tests/tunewizard-browser.cjs` (шаг 4 — с ≈ 1184; сводка — ≈ 1680–1700)

**Interfaces:**
- Consumes: `step4_interval`, `step4_set_interval`, `step4_interval_follow`, `step4_acro_interval`, `step4_acro_apply`, `step4_flight_range` (задача 2), `pidtune_interval_text`, `pidtune_interval_sources` (задача 1); `tarac4_decimate(parts, key, step)`, `step4_source(axis)`, `flight_data.data[2]` (газ шага 0), `flight_throttle_title()`, `log_mode_segments`, `pidtune_rules.acro_mode`.
- Produces (разметка): `#step4_interval_head` (подзаголовок «Интервал PID» и подпись `#step4_interval_label` — `pidtune_interval_text(step4_interval())`), график `#PidFlight4`, поля `#step4_start` и `#step4_end` (`type="number" step="1"`, подписи «Начало анализа PID, с» / «Конец анализа PID, с»), кнопки `#step4_acro_interval` «Интервал — участок ACRO» и `#step4_interval_step0` «Как на шаге 0», заметка `#step4_interval_note`: «Фильтры (шаги 1–3) считаются на интервале шага 0: A–B с.»
- Produces (код):
  - `pidflight4_data()` → `{ targets: { roll: { x, y }, pitch, yaw }, throttle: { x, y }, acro: [{ start, end }] }`: цель — `"Tar"` всех наборов `step4_source(axis).sets` (части `{ batch, i0: 0, i1: batch.time.length }`), шаг прореживания — `Math.max(1, Math.ceil(отсчётов / pidflight4_max_points))`; газ — `x`/`y` `flight_data.data[2]`; ACRO — участки `log_mode_segments(state.log, [state.settings.min, state.settings.max])` (весь лог) с `mode == pidtune_rules.acro_mode`.
  - График `PidFlight4`: ряды «цель крена», «цель тангажа», «цель рыскания» (ось `y`, °/с) и газ (`yaxis2`, справа, подпись — `flight_throttle_title()`); `xaxis.rangeslider: {}`, `xaxis.range` = интервал PID, `autorange: false`; ACRO — `shapes` `type: "rect"`, `xref: "x"`, `yref: "paper"`, `layer: "below"`, без рамки. Тема (`on_theme`): цели — `palette.series[0]`, `[1]`, `[3]`, газ — `palette.series[2]` (как на шаге 0), заливка ACRO — `palette.ink` с `opacity` 0.12.
  - `step4_render_interval()` — подпись, поля, заметка, видимость кнопок (`#step4_acro_interval` — `step4_acro_interval() != null`; `#step4_interval_step0` — источник не `step0`), диапазон графика (`Plotly.relayout` только если отличается от текущего).
  - Ползунок/зум (`plotly_relayout` на `PidFlight4`: `xaxis.range`, `xaxis.range[0]`/`[1]`; `xaxis.autorange` → `[min, max]`) и `change` полей → если границы отличаются от `step4_interval()` — `step4_set_interval(a, b, "own")`, `step4_render_interval()` и `step4_interval_schedule()`; неверные поля — вернуть значения `step4_interval()`.
  - `step4_interval_schedule()` — `clearTimeout` прежнего, через `step4_interval_delay_ms` → `if (state.step === 4) step4_show()`; таймер снимается в `step4_reset`.
  - «Как на шаге 0» → `step4_interval_follow()`, `step4_render_interval()`, `step4_show()` сразу; «Интервал — участок ACRO» → `step4_acro_apply()`.
  - Данные графика строятся один раз на лог (после загрузки `step4.pid` в `step4_show`); `step4_reset` очищает график.

- [ ] **Step 1: Написать падающие проверки** в `tests/tunewizard-browser.cjs` (тестовый лог, участка ACRO нет), в разделе шага 4:
  - `#PidFlight4` в `assert_plot_widths` шага 4 (вместе с `StepResp4`, `TarAct4`, `DSpec4`, `LBode4`, ≈ 1673 и 2409); у графика 4 ряда с данными и `rangeslider`;
  - подпись `#step4_interval_label` — «A–B с, как на шаге 0», где A–B — поля шага 0; кнопок `#step4_acro_interval` и `#step4_interval_step0` не видно; заметка `#step4_interval_note` называет интервал шага 0;
  - поля `#step4_start`/`#step4_end` → своё значение (на 10 с уже) + `change` → подпись «… свой», `#step4_interval_step0` видна; дождаться пересчёта (`step4.calc.roll.range` = новый интервал); поля шага 0 не изменились, `step_accepted_stale(2)` и `step_accepted_stale(3)` — `false` (шаги 2–3 приняты раньше в тесте), `step_accepted_stale(4)` — `true`, если шаг 4 был принят;
  - «Как на шаге 0» → подпись «… как на шаге 0», после пересчёта `step4.calc.roll.range` = интервал шага 0, и источник остаётся «как на шаге 0» после того, как график сам перерисовался (Review Focus 1);
  - смена интервала полем `#step4_start` и переход на шаг 5 до 0.7 с → через 1 с видим только шаг 5 (`visible_steps` = `['5']`) (Review Focus 2);
  - сводка: в строке принятого шага 4 — «интервал PID A–B с, как на шаге 0»; ожидание причины устаревания шага 4 (≈ 1695) — «сменились интервал PID или фильтры шагов 2–3».
- [ ] **Step 2: Запустить — падает.** `npm run test:tunewizard` → FAIL (нет `#PidFlight4`).
- [ ] **Step 3: Реализовать** разметку и код из Interfaces; убрать `#step4_acro_row` из разметки, `step4_reset` и `step4_redraw_all`.
- [ ] **Step 4: Запустить — проходит.** `npm run lint`; `npm test`; `npm run test:tunewizard`, `test:tunewizard-log2`, `test:tunewizard-log3` → pass (у QuadPlane блок скрыт вместе с шагом 4).
- [ ] **Step 5: Коммит** «TuneWizard: этап 11 — блок «Интервал PID» на шаге 4: график с ползунком, поля, кнопки».

### Task 5: Четвёртый лог, документы, финальный прогон

**Files:**
- Modify: `tests/tunewizard-browser-log4.cjs` (сценарий шага 4, ≈ 125–160; шапка-комментарий)
- Modify: `TuneWizard/Readme.md` (раздел «Как шаг 4 предлагает PID»: абзац о кнопке «Интервал — участок ACRO» → новый абзац «Интервал PID»), `tests/README.md` (описания `-log4` и `tunewizard-browser.cjs`, Node-тесты), `docs/tunewizard-journal.md` (по его разделу 9)

**Interfaces:**
- Consumes: всё из задач 1–4.

- [ ] **Step 1: Переписать сценарий `-log4`:** после шага 0 (интервал 282–370) шаг 4 сразу считает на 289–370: подпись «289–370 с, участок ACRO «Rate Loop Only»», кнопки ACRO нет, крен и тангаж `ok`, рыскание `imprecise` с «ещё ≈ N с» (прежние проверки «участка ACRO» — без нажатия кнопки); затем поля `#step4_start`/`#step4_end` = 282/370 → после пересчёта все оси `unreliable` с (б), кнопка `#step4_acro_interval` видна, `step4_acro_interval()` = `{ start: 289, end: 370 }`; кнопка → снова 289–370, `acro`; всё это время поля шага 0 — 282 и 370, `step1.fft_key` не изменился.
- [ ] **Step 2: Запустить.** `npm run test:tunewizard-log4` → pass.
- [ ] **Step 3: Документы:** Readme — что такое интервал PID, умолчания (участок ACRO в окне полёта, иначе как на шаге 0), ползунок и поля, пауза перед пересчётом, кнопки, что фильтры считаются на интервале шага 0, интервал в строке шага 4 сводки; `tests/README.md` — новые проверки; журнал — разделы 3 (решения 17.11: свой интервал PID, вариант А), 4, 5, 6 (новые файлы этапа), 8 (участок ACRO по всему логу захватывал землю — окно полёта).
- [ ] **Step 4: Финальный прогон:** `npm run lint`; `npm test`; `npm run test:tunewizard`, `-log2`, `-log3`, `-log4`, `-prep`, `-serve`, `-compare`, `-pid-compare` — все pass.
- [ ] **Step 5: Коммит** «TuneWizard: этап 11 — четвёртый лог, документы».
