# Мастер настройки (TuneWizard) — этап 1: каркас, темы, шаг 0

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Цель:** страница `TuneWizard/` с переключателем тем и полосой шагов, на которой шаг 0 загружает `.bin`, показывает карточку лога, список проверок пригодности и график полёта с выбором интервала анализа.

**Архитектура:** по дизайну `docs/plans/2026-10-23-tune-wizard-design.md`. Математика и проверки — в `TuneWizard/core/*.js` (классические скрипты без `document`, экспорт через `typeof module`, тестируются под Node). Страница `index.html` + `wizard.js` — состояние, навигация, Plotly. Оригинальные FilterReview/PIDReview не трогаем.

**Стек:** браузерный JS без сборки, Plotly из `modules/plotly.js`, парсер `modules/JsDataflashParser/parser.js` (ES-модуль, `export default DataflashParser`), общие `Libraries/` (LogHelpers, Param_Helpers, LoadingOverlay, Plotly_helpers), тесты `node --test` (Node 24, `npm test`), ESLint (`npm run lint`).

**Соглашения:**
- Всё на русском: тексты страницы, комментарии, сообщения коммитов. Имена параметров, сообщений лога, `id`/`class` — латиницей.
- Коммит после каждой задачи; сообщение в стиле `TuneWizard: …`, в конце строка `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- В новом терминале до перезапуска VS Code Node не в PATH: `$env:Path = "C:\Program Files\nodejs;" + $env:Path` (PowerShell) или `export PATH="/c/Program Files/nodejs:$PATH"` (Git Bash).
- Ветка `tune-wizard` уже создана и отслеживает `origin/tune-wizard`.

**Факты о данных, на которые опирается код:**
- Парсер: `log.processData(arrayBuffer, [])`, `log.messageTypes` (объект имя → описание; у сообщений с экземплярами есть `.instances`), `log.get(name)` → объект массивов всех полей, `log.get(name, field)` → массив поля, `log.get_instance(name, inst, field)`.
- `get_version_and_board(log)` (`Libraries/LogHelpers.js`) → `{ flight_controller, board_id, fw_string, fw_hash, os_string, build_type, filter_version }`; `build_type` 2 = Copter.
- Поля: `VIBE`: `TimeUS, IMU, VibeX, VibeY, VibeZ, Clip` (Clip — счётчик нарастающим итогом); `CTUN`: `ThO` — выход газа 0–1, `ThH` — расчётный газ висения; `RATE`: `AOut` — выход газа; `ATT`: `Roll, Pitch`; `POS`: `RelHomeAlt`.
- `LOG_BITMASK`: бит PID = 12, IMU_RAW = 19 (`ArduCopter/defines.h`). `INS_LOG_BAT_OPT`: бит 1 — post-filter, бит 2 — pre+post. `INS_RAW_LOG_OPT`: бит 2 — post-filter, бит 3 — pre+post (см. `FilterReview.js:2243`).
- Классические скрипты одной страницы делят глобальную лексическую область: **нельзя объявлять одно и то же `const`/`let` в двух файлах** (будет `SyntaxError`). `US2S` объявляется только в `core/log.js`.

---

### Задача 1: ядро `core/log.js` — сведения о логе, параметры, газ, VIBE

**Файлы:**
- Создать: `TuneWizard/core/log.js`
- Создать: `tests/tunewizard.test.cjs`
- Изменить: `eslint.config.mjs:56` (список `DUAL_SCRIPTS`)

**Шаг 1: добавить файлы ядра в `DUAL_SCRIPTS`**

В `eslint.config.mjs` строку

```js
const DUAL_SCRIPTS = ['AirspeedFit/airspeedfit_core.js', 'SimpleGCS/commands.js']
```

заменить на

```js
const DUAL_SCRIPTS = [
  'AirspeedFit/airspeedfit_core.js',
  'SimpleGCS/commands.js',
  // Ядро мастера настройки: те же скрипты гоняются под Node в tests/tunewizard.test.cjs
  'TuneWizard/core/log.js',
  'TuneWizard/core/checks.js'
]
```

**Шаг 2: написать падающие тесты**

Создать `tests/tunewizard.test.cjs`:

```js
// Тесты ядра мастера настройки (TuneWizard/core). Логи — поддельные объекты с интерфейсом парсера.
const test = require('node:test')
const assert = require('node:assert/strict')

const core_log = require('../TuneWizard/core/log.js')

// Поддельный лог: messages = { ИМЯ: { поле: массив } }, params = [[имя, значение, TimeUS], ...]
function fake_log({ messages = {}, params = [] } = {}) {
  const types = { ...messages }
  if (params.length > 0) {
    types.PARM = {
      TimeUS: params.map((p) => p[2] ?? 0),
      Name: params.map((p) => p[0]),
      Value: params.map((p) => p[1])
    }
  }
  return {
    messageTypes: Object.fromEntries(Object.keys(types).map((name) => [name, {}])),
    get(name, field) {
      const msg = types[name]
      if (msg == null) return undefined
      return field ? msg[field] : msg
    },
    get_instance(name, instance, field) {
      return this.get(name, field)
    }
  }
}

const copter_version = { build_type: 2, fw_string: 'ArduCopter V4.6.0', flight_controller: 'CubeOrange', filter_version: 2 }

test('log_params: последнее значение, история изменений, отсутствующий параметр', () => {
  const log = fake_log({ params: [
    ['ATC_RAT_RLL_P', 0.1, 1e6],
    ['ATC_RAT_RLL_P', 0.1, 2e6],   // повтор без изменения не попадает в историю
    ['ATC_RAT_RLL_P', 0.15, 30e6],
    ['INS_GYRO_FILTER', 40, 1e6]
  ] })
  const params = core_log.log_params(log)
  assert.equal(params.get('ATC_RAT_RLL_P'), 0.15)
  assert.equal(params.get('INS_GYRO_FILTER'), 40)
  assert.equal(params.get('NOPE'), null)
  assert.equal(params.has('NOPE'), false)
  assert.deepEqual(params.history('ATC_RAT_RLL_P'), [{ time: 1, value: 0.1 }, { time: 30, value: 0.15 }])
  assert.equal(params.changed('ATC_RAT_RLL_P'), true)
  assert.equal(params.changed('INS_GYRO_FILTER'), false)
})

test('log_messages: флаги наличия сообщений', () => {
  const log = fake_log({ messages: { PIDR: {}, PIDP: {}, PIDY: {}, GYR: {}, ESC: {}, ATT: {} } })
  const m = core_log.log_messages(log)
  assert.equal(m.pid, true)
  assert.equal(m.rate, false)
  assert.equal(m.gyro_raw, true)
  assert.equal(m.gyro_batch, false)
  assert.equal(m.esc, true)
  assert.equal(m.rpm, false)
  assert.equal(m.vibe, false)
})

test('throttle_window: от первого до последнего ненулевого газа с отступом 1 с', () => {
  const time = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  const throttle = [0, 0, 0.3, 0.4, 0.4, 0.4, 0.4, 0.4, 0.3, 0, 0]
  assert.deepEqual(core_log.throttle_window(time, throttle), { start: 3, end: 7 })
  assert.equal(core_log.throttle_window(time, new Array(11).fill(0)), null)
  // Слишком короткий полёт: окно схлопывается
  assert.equal(core_log.throttle_window([0, 1, 2], [0, 0.5, 0]), null)
})

test('mean_throttle: средний ненулевой газ внутри окна', () => {
  const time = [0, 1, 2, 3, 4, 5]
  const throttle = [0, 0.2, 0.4, 0.6, 0, 0.9]
  // Сумма чисел с плавающей точкой: сравниваем с допуском
  assert.ok(Math.abs(core_log.mean_throttle(time, throttle, { start: 1, end: 4 }) - 0.4) < 1e-9)
  assert.equal(core_log.mean_throttle(time, [0, 0, 0, 0, 0, 0], { start: 1, end: 4 }), null)
})

test('throttle_series: CTUN.ThO предпочтительнее RATE.AOut', () => {
  const both = fake_log({ messages: {
    CTUN: { TimeUS: [0, 1e6], ThO: [0.3, 0.4] },
    RATE: { TimeUS: [0, 1e6], AOut: [0.5, 0.6] }
  } })
  assert.deepEqual(core_log.throttle_series(both), { time: [0, 1], throttle: [0.3, 0.4], source: 'CTUN.ThO' })
  const rate_only = fake_log({ messages: { RATE: { TimeUS: [0, 2e6], AOut: [0.5, 0.6] } } })
  assert.deepEqual(core_log.throttle_series(rate_only), { time: [0, 2], throttle: [0.5, 0.6], source: 'RATE.AOut' })
  assert.equal(core_log.throttle_series(fake_log()), null)
})

test('percentile: 95-й процентиль', () => {
  const values = Array.from({ length: 100 }, (_, i) => i + 1)
  assert.equal(core_log.percentile(values, 0.95), 95)
  assert.equal(core_log.percentile([], 0.95), null)
})

test('vibe_summary: по экземплярам IMU — p95 и максимум по осям, clipping', () => {
  const log = fake_log({ messages: { VIBE: {
    TimeUS: [0, 1e6, 2e6, 3e6],
    IMU: [0, 1, 0, 1],
    VibeX: [10, 20, 12, 22],
    VibeY: [5, 6, 7, 8],
    VibeZ: [30, 40, 35, 45],
    Clip: [0, 0, 3, 1]       // нарастающий итог: IMU0 дошёл до 3, IMU1 до 1
  } } })
  const vibe = core_log.vibe_summary(log)
  assert.equal(vibe.imus.length, 2)
  assert.equal(vibe.imus[0].imu, 0)
  assert.equal(vibe.imus[0].max, 35)
  assert.equal(vibe.imus[1].max, 45)
  assert.equal(vibe.imus[0].clip, 3)
  assert.equal(vibe.imus[1].clip, 1)
  assert.equal(vibe.max, 45)
  assert.equal(vibe.clip, 4)
  assert.ok(vibe.level >= 35 && vibe.level <= 45)
  assert.equal(core_log.vibe_summary(fake_log()), null)
})

test('log_info: аппарат, длительность, окно полёта, средний газ', () => {
  const n = 61
  const TimeUS = Array.from({ length: n }, (_, i) => i * 1e6)
  const ThO = TimeUS.map((_, i) => (i >= 5 && i <= 55) ? 0.35 : 0)
  const log = fake_log({ messages: {
    ATT: { TimeUS, Roll: new Array(n).fill(0), Pitch: new Array(n).fill(0) },
    CTUN: { TimeUS, ThO },
    GYR: {}, PIDR: {}, PIDP: {}, PIDY: {}
  } })
  const info = core_log.log_info(log, copter_version)
  assert.equal(info.vehicle, 'Copter')
  assert.equal(info.fw_string, 'ArduCopter V4.6.0')
  assert.equal(info.board, 'CubeOrange')
  assert.equal(info.filter_version, 2)
  assert.equal(info.duration_s, 60)
  assert.equal(info.throttle_source, 'CTUN.ThO')
  assert.equal(info.flight.start, 6)
  assert.equal(info.flight.end, 54)
  assert.equal(info.flight.duration_s, 48)
  assert.ok(Math.abs(info.flight.mean_throttle - 0.35) < 1e-9)
  assert.equal(info.messages.pid, true)
})

test('log_info: без полёта и без ATT', () => {
  const log = fake_log({ messages: { RATE: { TimeUS: [0, 1e6, 2e6], AOut: [0, 0, 0] } } })
  const info = core_log.log_info(log, { build_type: 3 })
  assert.equal(info.vehicle, 'Plane')
  assert.equal(info.flight, null)
  assert.equal(info.duration_s, 2)
})
```

**Шаг 3: убедиться, что тесты падают**

Запуск: `node --test tests/tunewizard.test.cjs`
Ожидание: FAIL — `Cannot find module '../TuneWizard/core/log.js'`.

**Шаг 4: реализовать `TuneWizard/core/log.js`**

```js
// Сведения о логе и доступ к параметрам. Без DOM: работает в браузере и под Node (тесты).
// Лог — объект парсера JsDataflashParser: messageTypes, get(name, field), get_instance(name, instance, field).

// Микросекунды лога → секунды. Объявлено только здесь: другие скрипты страницы используют этот глобал.
const US2S = 1 / 1000000

// Типы сборки из VER.BU (как в Libraries/LogHelpers.js)
const BUILD_NAMES = { 1: "Rover", 2: "Copter", 3: "Plane", 4: "AntennaTracker", 7: "Sub", 12: "Blimp" }

function us_to_s(TimeUS) {
    return Array.from(TimeUS, (t) => t * US2S)
}

// Доступ к параметрам из сообщений PARM: последнее значение и история изменений
function log_params(log) {
    const history = {}
    if ("PARM" in log.messageTypes) {
        const PARM = log.get("PARM")
        for (let i = 0; i < PARM.Name.length; i++) {
            const name = PARM.Name[i]
            const value = PARM.Value[i]
            const list = history[name] ??= []
            // Повторная запись того же значения — не изменение
            if ((list.length == 0) || (list[list.length - 1].value != value)) {
                list.push({ time: PARM.TimeUS[i] * US2S, value })
            }
        }
    }
    return {
        has: (name) => name in history,
        get: (name) => (name in history) ? history[name][history[name].length - 1].value : null,
        history: (name) => history[name] ?? [],
        changed: (name) => (history[name]?.length ?? 0) > 1,
    }
}

// Какие сообщения есть в логе
function log_messages(log) {
    const has = (name) => name in log.messageTypes
    return {
        pid: has("PIDR") && has("PIDP") && has("PIDY"),
        rate: has("RATE"),
        gyro_raw: has("GYR"),
        gyro_batch: has("ISBH") && has("ISBD"),
        esc: has("ESC"),
        rpm: has("RPM"),
        vibe: has("VIBE"),
        ctun: has("CTUN"),
        att: has("ATT"),
        pos: has("POS"),
        ftn: has("FTN1"),
    }
}

// Ряд «газ» 0–1 для окна полёта: CTUN.ThO (выход газа), иначе RATE.AOut
function throttle_series(log) {
    if ("CTUN" in log.messageTypes) {
        return { time: us_to_s(log.get("CTUN", "TimeUS")), throttle: Array.from(log.get("CTUN", "ThO")), source: "CTUN.ThO" }
    }
    if ("RATE" in log.messageTypes) {
        return { time: us_to_s(log.get("RATE", "TimeUS")), throttle: Array.from(log.get("RATE", "AOut")), source: "RATE.AOut" }
    }
    return null
}

// Окно полёта: от первого до последнего ненулевого газа, с отступом margin секунд внутрь,
// чтобы отрезать набор и сброс газа (как в FilterReview)
function throttle_window(time, throttle, margin = 1) {
    let first = -1
    let last = -1
    for (let i = 0; i < throttle.length; i++) {
        if (throttle[i] > 0) {
            if (first < 0) {
                first = i
            }
            last = i
        }
    }
    if (first < 0) {
        return null
    }
    const start = Math.ceil(time[first]) + margin
    const end = Math.floor(time[last]) - margin
    if (end <= start) {
        return null
    }
    return { start, end }
}

// Средний ненулевой газ внутри окна
function mean_throttle(time, throttle, window) {
    let sum = 0
    let count = 0
    for (let i = 0; i < throttle.length; i++) {
        if ((time[i] < window.start) || (time[i] > window.end) || !(throttle[i] > 0)) {
            continue
        }
        sum += throttle[i]
        count++
    }
    return (count > 0) ? sum / count : null
}

// Процентиль по ближайшему рангу
function percentile(values, fraction) {
    if (values.length == 0) {
        return null
    }
    const sorted = Array.from(values).sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
}

// Сводка VIBE по экземплярам IMU: p95 и максимум по осям, число событий clipping.
// Clip в логе — счётчик нарастающим итогом, поэтому берём максимум.
function vibe_summary(log) {
    if (!("VIBE" in log.messageTypes)) {
        return null
    }
    const VIBE = log.get("VIBE")
    const by_imu = {}
    for (let i = 0; i < VIBE.TimeUS.length; i++) {
        const s = by_imu[VIBE.IMU[i]] ??= { x: [], y: [], z: [], clip: 0 }
        s.x.push(VIBE.VibeX[i])
        s.y.push(VIBE.VibeY[i])
        s.z.push(VIBE.VibeZ[i])
        s.clip = Math.max(s.clip, VIBE.Clip[i])
    }
    const imus = Object.entries(by_imu).map(([imu, s]) => {
        const p95 = { x: percentile(s.x, 0.95), y: percentile(s.y, 0.95), z: percentile(s.z, 0.95) }
        return {
            imu: Number(imu),
            p95,
            level: Math.max(p95.x, p95.y, p95.z),
            max: Math.max(...s.x, ...s.y, ...s.z),
            clip: s.clip,
        }
    })
    return {
        imus,
        level: Math.max(...imus.map((s) => s.level)),
        max: Math.max(...imus.map((s) => s.max)),
        clip: imus.reduce((sum, s) => sum + s.clip, 0),
    }
}

// Сводная информация о логе. version — результат get_version_and_board(log) из Libraries/LogHelpers.js
function log_info(log, version) {
    const messages = log_messages(log)

    // Длительность по первому подходящему сообщению с TimeUS
    let duration_s = null
    for (const name of ["ATT", "RATE", "CTUN", "IMU"]) {
        if (name in log.messageTypes) {
            const t = log.get(name, "TimeUS")
            if (t.length > 1) {
                duration_s = (t[t.length - 1] - t[0]) * US2S
                break
            }
        }
    }

    const throttle = throttle_series(log)
    const window = throttle ? throttle_window(throttle.time, throttle.throttle) : null

    return {
        vehicle: BUILD_NAMES[version.build_type] ?? null,
        build_type: version.build_type ?? null,
        fw_string: version.fw_string ?? null,
        board: version.flight_controller ?? null,
        filter_version: version.filter_version ?? null,
        duration_s,
        messages,
        throttle_source: throttle?.source ?? null,
        flight: window ? {
            start: window.start,
            end: window.end,
            duration_s: window.end - window.start,
            mean_throttle: mean_throttle(throttle.time, throttle.throttle, window),
        } : null,
    }
}

if (typeof module !== "undefined") {
    module.exports = { US2S, us_to_s, log_params, log_messages, throttle_series, throttle_window, mean_throttle, percentile, vibe_summary, log_info }
}
```

**Шаг 5: убедиться, что тесты проходят**

Запуск: `node --test tests/tunewizard.test.cjs`
Ожидание: `ℹ pass 9`, `ℹ fail 0`.

Запуск: `npm run lint`
Ожидание: без ошибок (код выхода 0).

**Шаг 6: коммит**

```bash
git add eslint.config.mjs TuneWizard/core/log.js tests/tunewizard.test.cjs
git commit -F - <<'EOF'
TuneWizard: ядро log.js — сведения о логе, параметры, газ, VIBE

Чистые функции без DOM с тестами под Node: история параметров,
флаги сообщений, окно полёта по газу, сводка VIBE, log_info.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Задача 2: ядро `core/checks.js` — проверки пригодности лога

**Файлы:**
- Создать: `TuneWizard/core/checks.js`
- Изменить: `tests/tunewizard.test.cjs` (дописать тесты)

**Шаг 1: дописать падающие тесты**

В конец `tests/tunewizard.test.cjs` добавить:

```js
const checks = require('../TuneWizard/core/checks.js')

// Сведения о хорошем логе Copter; тесты переопределяют нужные поля
function good_info(over = {}) {
  return {
    vehicle: 'Copter', fw_string: 'ArduCopter V4.6.0', board: 'CubeOrange', filter_version: 2, duration_s: 120,
    messages: { pid: true, rate: true, gyro_raw: true, gyro_batch: false, esc: true, rpm: false, vibe: true, ctun: true, att: true, pos: true, ftn: false },
    throttle_source: 'CTUN.ThO',
    flight: { start: 5, end: 100, duration_s: 95, mean_throttle: 0.33 },
    ...over
  }
}
function fake_params(values) {
  return { get: (name) => (name in values) ? values[name] : null, has: (name) => name in values }
}
const good_params = fake_params({ MOT_THST_HOVER: 0.35, MOT_HOVER_LEARN: 2, INS_RAW_LOG_OPT: 8, INS_GYRO_FILTER: 40 })
const good_vibe = { imus: [{ imu: 0, level: 12, max: 20, clip: 0 }], level: 12, max: 20, clip: 0 }

function by_id(list, id) {
  const found = list.find((c) => c.id === id)
  assert.ok(found, `нет проверки ${id}`)
  return found
}

test('run_checks: хороший лог — все проверки ok', () => {
  const list = checks.run_checks(good_info(), good_params, good_vibe)
  for (const c of list) assert.equal(c.status, 'ok', `${c.id}: ${c.text}`)
  assert.equal(checks.checks_summary(list).status, 'ok')
})

test('run_checks: не Copter — fail, итог fail', () => {
  const list = checks.run_checks(good_info({ vehicle: 'Plane' }), good_params, good_vibe)
  assert.equal(by_id(list, 'vehicle').status, 'fail')
  assert.equal(checks.checks_summary(list).status, 'fail')
})

test('run_checks: PID — ok / warn (только RATE) / fail', () => {
  const only_rate = good_info({ messages: { ...good_info().messages, pid: false, rate: true } })
  assert.equal(by_id(checks.run_checks(only_rate, good_params, good_vibe), 'pid_log').status, 'warn')
  const none = good_info({ messages: { ...good_info().messages, pid: false, rate: false } })
  assert.equal(by_id(checks.run_checks(none, good_params, good_vibe), 'pid_log').status, 'fail')
})

test('run_checks: нет данных гироскопа — fail с подсказкой', () => {
  const info = good_info({ messages: { ...good_info().messages, gyro_raw: false, gyro_batch: false } })
  const c = by_id(checks.run_checks(info, good_params, good_vibe), 'gyro_log')
  assert.equal(c.status, 'fail')
  assert.match(c.fix, /INS_LOG_BAT_MASK/)
})

test('run_checks: raw pre/post по INS_RAW_LOG_OPT', () => {
  const post_only = fake_params({ INS_RAW_LOG_OPT: 4 })
  assert.equal(by_id(checks.run_checks(good_info(), post_only, good_vibe), 'pre_post').status, 'warn')
  const pre_only = fake_params({ INS_RAW_LOG_OPT: 0 })
  assert.equal(by_id(checks.run_checks(good_info(), pre_only, good_vibe), 'pre_post').status, 'ok')
})

test('run_checks: batch pre/post по INS_LOG_BAT_OPT', () => {
  const info = good_info({ messages: { ...good_info().messages, gyro_raw: false, gyro_batch: true } })
  assert.equal(by_id(checks.run_checks(info, fake_params({ INS_LOG_BAT_OPT: 4 }), good_vibe), 'pre_post').status, 'ok')
  assert.equal(by_id(checks.run_checks(info, fake_params({ INS_LOG_BAT_OPT: 2 }), good_vibe), 'pre_post').status, 'warn')
})

test('run_checks: источник трекинга — ESC ok, RPM ok, только газ warn', () => {
  const rpm = good_info({ messages: { ...good_info().messages, esc: false, rpm: true } })
  assert.equal(by_id(checks.run_checks(rpm, good_params, good_vibe), 'tracking').status, 'ok')
  const throttle = good_info({ messages: { ...good_info().messages, esc: false, rpm: false } })
  assert.equal(by_id(checks.run_checks(throttle, good_params, good_vibe), 'tracking').status, 'warn')
})

test('run_checks: полёт — нет газа fail, короткий warn', () => {
  assert.equal(by_id(checks.run_checks(good_info({ flight: null }), good_params, good_vibe), 'flight').status, 'fail')
  const short = good_info({ flight: { start: 5, end: 25, duration_s: 20, mean_throttle: 0.33 } })
  assert.equal(by_id(checks.run_checks(short, good_params, good_vibe), 'flight').status, 'warn')
})

test('run_checks: вибрации — пороги 30/60 и clipping', () => {
  const warn = { ...good_vibe, level: 45 }
  assert.equal(by_id(checks.run_checks(good_info(), good_params, warn), 'vibe').status, 'warn')
  const fail = { ...good_vibe, level: 70 }
  assert.equal(by_id(checks.run_checks(good_info(), good_params, fail), 'vibe').status, 'fail')
  const clip = { ...good_vibe, clip: 5 }
  assert.equal(by_id(checks.run_checks(good_info(), good_params, clip), 'clipping').status, 'warn')
  assert.equal(by_id(checks.run_checks(good_info(), good_params, null), 'vibe').status, 'warn')
})

test('run_checks: газ висения против MOT_THST_HOVER', () => {
  const far = fake_params({ MOT_THST_HOVER: 0.5, MOT_HOVER_LEARN: 0 })
  const c = by_id(checks.run_checks(good_info(), far, good_vibe), 'hover_throttle')
  assert.equal(c.status, 'warn')
  assert.match(c.fix, /MOT_HOVER_LEARN/)
  const close = fake_params({ MOT_THST_HOVER: 0.31 })
  assert.equal(by_id(checks.run_checks(good_info(), close, good_vibe), 'hover_throttle').status, 'ok')
})

test('checks_summary: счётчики', () => {
  const s = checks.checks_summary([{ status: 'ok' }, { status: 'warn' }, { status: 'warn' }])
  assert.deepEqual(s, { status: 'warn', ok: 1, warn: 2, fail: 0 })
})
```

**Шаг 2: убедиться, что тесты падают**

Запуск: `node --test tests/tunewizard.test.cjs`
Ожидание: FAIL — `Cannot find module '../TuneWizard/core/checks.js'`.

**Шаг 3: реализовать `TuneWizard/core/checks.js`**

```js
// Проверки пригодности лога (шаг 0). Чистые функции без DOM.
// Источники порогов: [wiki] — ardupilot.org, [код] — исходники ArduPilot, [наше] — эвристика, у ArduPilot числа нет.

const check_rules = {
    vibe_warn: 30,                  // м/с²: выше — возможны проблемы [wiki, Measuring Vibration]
    vibe_fail: 60,                  // м/с²: выше — почти наверняка проблемы [wiki, Measuring Vibration]
    hover_min_s: 30,                // с: минимальное висение для усреднения спектра [wiki, Initial tuning flight]
    hover_throttle_tolerance: 0.05, // допустимое расхождение MOT_THST_HOVER и среднего газа [наше]
    log_bitmask_pid: 12,            // номер бита PID в LOG_BITMASK [код, ArduCopter/defines.h MASK_LOG_PID]
    log_bitmask_imu_raw: 19,        // номер бита IMU_RAW [код, MASK_LOG_IMU_RAW]
}

// info — из log_info, params — из log_params, vibe — из vibe_summary (может быть null).
// Возвращает список { id, status: "ok" | "warn" | "fail", title, text, fix }.
function run_checks(info, params, vibe) {
    const checks = []
    const add = (id, status, title, text, fix) => checks.push({ id, status, title, text, fix: fix ?? null })
    const m = info.messages
    const r = check_rules

    // Аппарат
    if (info.vehicle === "Copter") {
        add("vehicle", "ok", "Аппарат", "Copter, " + (info.fw_string ?? "версия неизвестна") + (info.board ? ", " + info.board : ""))
    } else {
        add("vehicle", "fail", "Аппарат", "Лог от " + (info.vehicle ?? "неизвестного аппарата") + "; мастер поддерживает только Copter", "Загрузите лог ArduCopter")
    }

    // Сообщения PID
    const pid_fix = "Включите бит PID (" + r.log_bitmask_pid + ") в LOG_BITMASK и перелетите"
    if (m.pid) {
        add("pid_log", "ok", "Сообщения PID", "PIDR/PIDP/PIDY есть: доступны компоненты P/I/D/FF, отфильтрованные цель и ошибка")
    } else if (m.rate) {
        add("pid_log", "warn", "Сообщения PID", "Есть только RATE: на шаге 4 не будет компонент P/I/D", pid_fix)
    } else {
        add("pid_log", "fail", "Сообщения PID", "Нет ни PID, ни RATE: шаг 4 недоступен", pid_fix)
    }

    // Данные гироскопа
    if (m.gyro_raw || m.gyro_batch) {
        add("gyro_log", "ok", "Данные гироскопа", "Есть " + (m.gyro_raw ? "raw (GYR)" : "batch (ISBH/ISBD)") + ": шаги 1–3 доступны")
    } else {
        add("gyro_log", "fail", "Данные гироскопа", "Нет ни raw (GYR), ни batch (ISBH/ISBD): шаги 1–3 недоступны",
            "Batch: INS_LOG_BAT_MASK = 1, INS_LOG_BAT_OPT = 4. Raw (платы H7): бит IMU_RAW (" + r.log_bitmask_imu_raw + ") в LOG_BITMASK, INS_RAW_LOG_OPT = 8")
    }

    // До/после фильтров
    if (m.gyro_raw) {
        const opt = params.get("INS_RAW_LOG_OPT") ?? 0
        if (opt & (1 << 3)) {
            add("pre_post", "ok", "До/после фильтров", "Raw-лог до и после фильтров: оценку «станет» можно сверить с реальными данными")
        } else if (opt & (1 << 2)) {
            add("pre_post", "warn", "До/после фильтров", "Raw-лог только после фильтров: спектра до фильтров и оценки «станет» не будет", "INS_RAW_LOG_OPT = 8 (до и после)")
        } else {
            add("pre_post", "ok", "До/после фильтров", "Raw-лог только до фильтров: оценка «станет» строится расчётом, реальных данных после фильтров нет")
        }
    } else if (m.gyro_batch) {
        const opt = params.get("INS_LOG_BAT_OPT") ?? 0
        if (opt & (1 << 2)) {
            add("pre_post", "ok", "До/после фильтров", "Batch-лог до и после фильтров: оценку «станет» можно сверить с реальными данными")
        } else if (opt & (1 << 1)) {
            add("pre_post", "warn", "До/после фильтров", "Batch-лог только после фильтров: спектра до фильтров и оценки «станет» не будет", "INS_LOG_BAT_OPT = 4 (до и после)")
        } else {
            add("pre_post", "ok", "До/после фильтров", "Batch-лог только до фильтров: оценка «станет» строится расчётом, реальных данных после фильтров нет")
        }
    }

    // Источник трекинга notch
    if (m.esc) {
        add("tracking", "ok", "Источник трекинга notch", "ESC-телеметрия (ESC): лучший источник, сам подстраивается под нагрузку")
    } else if (m.rpm) {
        add("tracking", "ok", "Источник трекинга notch", "Датчик оборотов (RPM)")
    } else {
        add("tracking", "warn", "Источник трекинга notch", "Нет ESC-телеметрии и RPM: доступен только трекинг по газу (INS_HNTCH_MODE = 1)",
            "Если регуляторы умеют телеметрию или двунаправленный DShot — включите, это точнее")
    }

    // Полёт
    if (info.flight == null) {
        add("flight", "fail", "Полёт", "Газ не поднимался выше нуля: полёта в логе нет")
    } else if (info.flight.duration_s < r.hover_min_s) {
        add("flight", "warn", "Полёт", "Полёт с газом " + Math.round(info.flight.duration_s) + " с: мало для усреднения спектра", "Висение не меньше " + r.hover_min_s + " с без ввода")
    } else {
        add("flight", "ok", "Полёт", "Полёт с газом " + Math.round(info.flight.duration_s) + " с, средний газ " + (info.flight.mean_throttle ?? 0).toFixed(2))
    }

    // Вибрации
    if (vibe == null) {
        add("vibe", "warn", "Вибрации", "Сообщений VIBE нет: уровень вибраций не проверить")
    } else {
        const level = Math.round(vibe.level)
        const text = "Уровень (95-й процентиль) " + level + " м/с², максимум " + Math.round(vibe.max) + " м/с²"
        if (vibe.level >= r.vibe_fail) {
            add("vibe", "fail", "Вибрации", text + ": выше " + r.vibe_fail + " — почти наверняка проблемы", "Проверьте крепление автопилота, балансировку пропеллеров и моторов")
        } else if (vibe.level >= r.vibe_warn) {
            add("vibe", "warn", "Вибрации", text + ": выше " + r.vibe_warn + " — возможны проблемы", "Проверьте крепление автопилота и балансировку пропеллеров")
        } else {
            add("vibe", "ok", "Вибрации", text)
        }
        if (vibe.clip > 0) {
            add("clipping", "warn", "Clipping", vibe.clip + " событий clipping акселерометра", "Проверьте крепление автопилота и балансировку пропеллеров")
        } else {
            add("clipping", "ok", "Clipping", "Событий clipping нет")
        }
    }

    // Газ висения против MOT_THST_HOVER
    const hover = params.get("MOT_THST_HOVER")
    const mean = info.flight?.mean_throttle ?? null
    if ((hover != null) && (mean != null)) {
        const diff = Math.abs(hover - mean)
        const text = "MOT_THST_HOVER " + hover.toFixed(2) + ", средний газ в полёте " + mean.toFixed(2)
        if (diff > r.hover_throttle_tolerance) {
            const learning = params.get("MOT_HOVER_LEARN") == 2
            add("hover_throttle", "warn", "Газ висения", text + ": расхождение " + diff.toFixed(2) + (learning ? " (обучение включено, значение сохранится после полёта)" : ""),
                learning ? "Повисите не меньше 30 с в AltHold, чтобы значение обучилось" : "MOT_HOVER_LEARN = 2 (обучение с сохранением)")
        } else {
            add("hover_throttle", "ok", "Газ висения", text)
        }
    }

    return checks
}

// Итог по списку проверок
function checks_summary(checks) {
    const count = { ok: 0, warn: 0, fail: 0 }
    for (const c of checks) {
        count[c.status]++
    }
    const status = (count.fail > 0) ? "fail" : (count.warn > 0) ? "warn" : "ok"
    return { status, ...count }
}

if (typeof module !== "undefined") {
    module.exports = { check_rules, run_checks, checks_summary }
}
```

**Шаг 4: убедиться, что тесты проходят**

Запуск: `node --test tests/tunewizard.test.cjs`
Ожидание: `ℹ pass 20`, `ℹ fail 0`.

Запуск: `npm run lint` → код выхода 0.

**Шаг 5: коммит**

```bash
git add TuneWizard/core/checks.js tests/tunewizard.test.cjs
git commit -F - <<'EOF'
TuneWizard: ядро checks.js — проверки пригодности лога

Аппарат, бит PID, данные гироскопа, pre/post, источник трекинга,
длительность полёта, VIBE и clipping, газ висения. Пороги в одном
блоке check_rules с указанием источника.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Задача 3: страница `index.html` и `wizard.js` — темы, полоса шагов, навигация

Проверка этой задачи ручная (страница без данных), поэтому шаги — «написать → открыть в браузере → линт → коммит».

**Файлы:**
- Создать: `TuneWizard/index.html`
- Создать: `TuneWizard/wizard.js`

**Шаг 1: создать `TuneWizard/index.html`**

```html
<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Мастер настройки</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap">

<script src="../modules/plotly.js/dist/plotly.min.js"></script>

<script type="text/javascript" src="../Libraries/LogHelpers.js"></script>
<script type="text/javascript" src="../Libraries/Param_Helpers.js"></script>
<script type="text/javascript" src="../Libraries/LoadingOverlay.js"></script>
<script type="text/javascript" src="../Libraries/Plotly_helpers.js"></script>

<script type="text/javascript" src="core/log.js"></script>
<script type="text/javascript" src="core/checks.js"></script>
<script type="text/javascript" src="wizard.js"></script>

<style>
/* Токены оформления: светлая тема «Светлый технический», тёмная «Графит» (общие правила проектов, 23.10.2026) */
:root{
  --bg:#F0F1EE; --surface:#FCFCFB; --surface-2:#F6F7F4; --sunk:#F6F7F4;
  --ink:#1A1D19; --ink-2:#4B514A; --ink-3:#787E77;
  --line:#DBDED8; --line-soft:#E4E7E1;
  --accent:#B45309; --accent-soft:rgba(180,83,9,.10);
  --low:#0D9488;   --low-soft:rgba(13,148,136,.10);
  --ok:#4D7C0F;    --ok-soft:rgba(77,124,15,.10);
  --high:#B91C1C;  --high-soft:rgba(185,28,28,.10);
  --shadow:0 1px 0 rgba(26,29,25,.05);
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    --bg:#212426; --surface:#2E3234; --surface-2:#262A2C; --sunk:#262A2C;
    --ink:#E9EBE7; --ink-2:#B8BDB7; --ink-3:#9AA09A;
    --line:#3B4043; --line-soft:#353A3D;
    --accent:#E0A64A; --accent-soft:rgba(224,166,74,.14);
    --low:#4FC3D1;   --low-soft:rgba(79,195,209,.14);
    --ok:#A9D166;    --ok-soft:rgba(169,209,102,.14);
    --high:#F08A7A;  --high-soft:rgba(240,138,122,.14);
    --shadow:none;
  }
}
:root[data-theme="dark"]{
  --bg:#212426; --surface:#2E3234; --surface-2:#262A2C; --sunk:#262A2C;
  --ink:#E9EBE7; --ink-2:#B8BDB7; --ink-3:#9AA09A;
  --line:#3B4043; --line-soft:#353A3D;
  --accent:#E0A64A; --accent-soft:rgba(224,166,74,.14);
  --low:#4FC3D1;   --low-soft:rgba(79,195,209,.14);
  --ok:#A9D166;    --ok-soft:rgba(169,209,102,.14);
  --high:#F08A7A;  --high-soft:rgba(240,138,122,.14);
  --shadow:none;
}
*{box-sizing:border-box}
body{margin:0; background:var(--bg); color:var(--ink);
  font-family:"IBM Plex Sans",-apple-system,"Segoe UI",sans-serif; font-size:14px; line-height:1.55}
.wrap{max-width:1400px; margin:0 auto; padding:24px 16px 64px; display:flex; flex-direction:column; gap:20px}
h1,h2,h3{font-family:Archivo,"IBM Plex Sans",sans-serif; margin:0}
h1{font-size:28px; font-weight:700; letter-spacing:-.02em; line-height:1.15}
h2{font-size:17px; font-weight:600}
h3{font-size:14px; font-weight:600}
p{margin:0}
.mono{font-family:"IBM Plex Mono",ui-monospace,monospace}
.eyebrow{font-family:"IBM Plex Mono",ui-monospace,monospace; font-size:10px; font-weight:600;
  letter-spacing:.11em; text-transform:uppercase; color:var(--ink-3)}
.lede{color:var(--ink-2); font-size:15px; max-width:70ch}
header.hero{display:flex; flex-direction:column; gap:8px; border-bottom:1px solid var(--line); padding-bottom:14px}
section{display:flex; flex-direction:column; gap:14px}
section > .head{display:flex; flex-direction:column; gap:3px; border-bottom:1px solid var(--line); padding-bottom:8px}

/* Переключатель темы */
.themebar{display:flex; align-items:center; gap:6px; justify-content:flex-end; flex-wrap:wrap}
.themebar__k{font-family:"IBM Plex Mono",ui-monospace,monospace; font-size:10px; letter-spacing:.09em; text-transform:uppercase; color:var(--ink-3); margin-right:4px}
button,label.pickbtn{font-family:"IBM Plex Sans",sans-serif; font-size:12px; padding:5px 11px; cursor:pointer;
  background:var(--surface-2); color:var(--ink-2); border:1px solid var(--line); border-radius:2px}
button:hover,label.pickbtn:hover{color:var(--ink); border-color:var(--ink-3)}
button:disabled{opacity:.45; cursor:not-allowed}
button[aria-pressed="true"],button.primary{color:var(--accent); border-color:var(--accent); background:var(--accent-soft)}
button:focus-visible,input:focus-visible,label.pickbtn:focus-visible{outline:2px solid var(--low); outline-offset:2px}

/* Полоса шагов */
.wizbar{display:grid; grid-template-columns:repeat(6,minmax(0,1fr)); gap:0; border:1px solid var(--line); background:var(--surface); box-shadow:var(--shadow)}
.wizbar button{border:0; border-right:1px solid var(--line); border-radius:0; background:var(--surface); padding:10px 8px; text-align:left;
  display:flex; flex-direction:column; gap:2px; color:var(--ink-2)}
.wizbar button:last-child{border-right:0}
.wizbar button .n{font-family:"IBM Plex Mono",ui-monospace,monospace; font-size:10px; letter-spacing:.09em; text-transform:uppercase; color:var(--ink-3)}
.wizbar button .t{font-family:Archivo,"IBM Plex Sans",sans-serif; font-size:13px; font-weight:600; color:var(--ink)}
.wizbar button[aria-current="step"]{background:var(--accent-soft); box-shadow:inset 0 -2px 0 var(--accent)}
.wizbar button[aria-current="step"] .n{color:var(--accent)}
.wizbar button:disabled .t{color:var(--ink-3)}
@media (max-width:900px){.wizbar{grid-template-columns:repeat(3,minmax(0,1fr))} .wizbar button{border-bottom:1px solid var(--line)}}

/* Карточки и поля */
.lab{display:flex; flex-direction:column; gap:12px; background:var(--surface); border:1px solid var(--line); padding:14px; box-shadow:var(--shadow)}
.row{display:flex; align-items:flex-end; gap:12px; flex-wrap:wrap}
.fld{display:flex; flex-direction:column; gap:5px; min-width:0}
.fld label{font-family:"IBM Plex Mono",ui-monospace,monospace; font-size:10.5px; letter-spacing:.05em; text-transform:uppercase; color:var(--ink-3)}
.fld input[type=number]{font-family:"IBM Plex Mono",ui-monospace,monospace; font-size:14px; padding:7px 10px; width:110px;
  border:1px solid var(--line); background:var(--sunk); color:var(--ink)}
.fld input:disabled{opacity:.45}
input[type=file]{display:none}
.unit{text-transform:none}
.note{border-left:2px solid var(--line); padding-left:13px; color:var(--ink-3); font-size:13px; max-width:100ch}

/* Плитки */
.stats{display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); border:1px solid var(--line); background:var(--surface)}
.stat{padding:11px 13px; display:flex; flex-direction:column; gap:2px; border-right:1px solid var(--line); border-bottom:1px solid var(--line-soft)}
.stat__k{font-family:"IBM Plex Mono",ui-monospace,monospace; font-size:10px; letter-spacing:.09em; text-transform:uppercase; color:var(--ink-3)}
.stat__v{font-family:"IBM Plex Mono",ui-monospace,monospace; font-size:18px; font-weight:500; letter-spacing:-.02em; line-height:1.3; overflow-wrap:anywhere}
.stat--accent .stat__v{color:var(--accent)}

/* Вердикт и список проверок */
.verdict{font-family:"IBM Plex Mono",ui-monospace,monospace; font-size:12.5px; padding:10px 13px; border:1px solid var(--line); background:var(--surface-2); color:var(--ink-2)}
.verdict--ok{border-color:var(--ok); color:var(--ok)}
.verdict--warn{border-color:var(--accent); color:var(--accent)}
.verdict--fail{border-color:var(--high); color:var(--high)}
.checks{display:flex; flex-direction:column; border:1px solid var(--line); background:var(--surface); box-shadow:var(--shadow)}
.check{display:grid; grid-template-columns:64px 1fr; border-bottom:1px solid var(--line-soft)}
.check:last-child{border-bottom:0}
.check__s{font-family:"IBM Plex Mono",ui-monospace,monospace; font-size:11px; font-weight:600; letter-spacing:.06em; display:flex; align-items:flex-start; justify-content:center; padding:12px 0; background:var(--surface-2)}
.check--ok .check__s{color:var(--ok)} .check--warn .check__s{color:var(--accent)} .check--fail .check__s{color:var(--high)}
.check__b{padding:11px 14px; display:flex; flex-direction:column; gap:2px}
.check__b p{color:var(--ink-2); font-size:13px}
.check__b .fix{color:var(--ink-3); font-size:12.5px}
.check__b .fix b{color:var(--ink-2); font-weight:600}

/* Графики */
.plot{width:100%; height:420px; border:1px solid var(--line); background:var(--surface)}
#loading{background-color:var(--bg)!important}
#loading h1{color:var(--ink)}

@media print{
  :root{--bg:#fff; --surface:#fff; --surface-2:#fff; --sunk:#fff; --ink:#111; --ink-2:#333; --ink-3:#666; --line:#bbb; --line-soft:#ddd; --shadow:none}
  .themebar,.wizbar,button,label.pickbtn{display:none!important}
  body{background:#fff; color:#111}
  .lab,.stats,.checks,.plot{break-inside:avoid}
}
</style>
</head>
<body>
<div class="wrap">

<div class="themebar" role="group" aria-label="Тема оформления">
  <span class="themebar__k">Тема</span>
  <button type="button" data-t="auto">как в системе</button>
  <button type="button" data-t="light">светлая</button>
  <button type="button" data-t="dark">тёмная</button>
</div>

<header class="hero">
  <span class="eyebrow">ArduPilot · Copter</span>
  <h1>Мастер настройки</h1>
  <p class="lede">Один лог — шесть шагов: проверка лога, спектр гироскопов, гармонический notch, низкочастотные фильтры, PID по осям и сводка с файлом параметров. На каждом шаге мастер предлагает значения, вы их правите и подтверждаете.</p>
</header>

<nav class="wizbar" id="wizbar" aria-label="Шаги мастера"></nav>

<section data-step="0">
  <div class="head"><span class="eyebrow">00 · Лог и проверки</span><h2>Загрузите лог полёта</h2></div>
  <div class="lab">
    <div class="row">
      <div class="fld">
        <label for="fileItem">Файл .bin</label>
        <label class="pickbtn" for="fileItem" id="fileLabel">Выбрать лог…</label>
        <input id="fileItem" type="file" accept=".bin" onchange="read_file(this)">
      </div>
      <div class="fld">
        <label for="TimeStart">Начало анализа, <span class="unit">с</span></label>
        <input id="TimeStart" type="number" min="0" step="1" value="0" disabled onchange="interval_input_changed()">
      </div>
      <div class="fld">
        <label for="TimeEnd">Конец анализа, <span class="unit">с</span></label>
        <input id="TimeEnd" type="number" min="0" step="1" value="0" disabled onchange="interval_input_changed()">
      </div>
      <div class="fld">
        <label for="FFTWindow_size">Окно FFT, <span class="unit">отсчётов</span></label>
        <input id="FFTWindow_size" type="number" min="64" step="1" value="1024" disabled onchange="window_size_changed(this)">
      </div>
    </div>
    <p class="note">Интервал анализа задаётся ползунком под графиком полёта или полями выше. По умолчанию — участок с ненулевым газом с отступом по секунде с каждой стороны. Окно FFT — степень двойки.</p>
  </div>

  <div class="verdict" id="log_verdict" hidden></div>
  <div class="stats" id="log_info" hidden></div>
  <div class="checks" id="log_checks" hidden></div>

  <div class="head"><span class="eyebrow">Полёт</span><h2>Крен, тангаж, газ и высота</h2></div>
  <div id="FlightData" class="plot"></div>
</section>

<section data-step="1" hidden>
  <div class="head"><span class="eyebrow">01 · Спектр до фильтров</span><h2>Шаг появится на этапе 2</h2></div>
</section>
<section data-step="2" hidden>
  <div class="head"><span class="eyebrow">02 · Гармонический notch</span><h2>Шаг появится на этапе 2</h2></div>
</section>
<section data-step="3" hidden>
  <div class="head"><span class="eyebrow">03 · Низкочастотные фильтры</span><h2>Шаг появится на этапе 3</h2></div>
</section>
<section data-step="4" hidden>
  <div class="head"><span class="eyebrow">04 · PID по осям</span><h2>Шаг появится на этапе 4</h2></div>
</section>
<section data-step="5" hidden>
  <div class="head"><span class="eyebrow">05 · Сводка</span><h2>Шаг появится на этапе 5</h2></div>
</section>

</div>

<script>
    init_loading_overlay()
    init_theme()
    init_wizard()
</script>
</body>
</html>
```

**Шаг 2: создать `TuneWizard/wizard.js`**

```js
// Мастер настройки: состояние, навигация по шагам, темы и графики. Математика — в core/.

// Парсер логов — ES-модуль, подгружается асинхронно; load() ждёт import_done
var DataflashParser
const import_done = import('../modules/JsDataflashParser/parser.js').then((mod) => { DataflashParser = mod.default })

// Названия шагов для полосы навигации
const STEP_TITLES = ["Лог и проверки", "Спектр до фильтров", "Гармонический notch", "Низкочастотные фильтры", "PID по осям", "Сводка"]

// Состояние мастера. Лог и производные — только здесь; шаги читают и пишут steps[n]
const state = {
    file_name: null,
    log: null,
    version: null,
    params: null,
    info: null,
    vibe: null,
    checks: null,
    settings: { start: 0, end: 0, window_size: 1024 },
    step: 0,
    steps: [],
}

// ---------- Тема ----------

function token(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function apply_theme(name) {
    const root = document.documentElement
    if (name === "auto") {
        root.removeAttribute("data-theme")
    } else {
        root.setAttribute("data-theme", name)
    }
    for (const button of document.querySelectorAll(".themebar button[data-t]")) {
        button.setAttribute("aria-pressed", String(button.dataset.t === name))
    }
    restyle_plots()
}

function init_theme() {
    let saved = null
    try {
        saved = localStorage.getItem("theme_v1")
    } catch (e) {
        // Хранилище недоступно — работаем без памяти темы
    }
    apply_theme(saved ?? "auto")
    for (const button of document.querySelectorAll(".themebar button[data-t]")) {
        button.addEventListener("click", () => {
            apply_theme(button.dataset.t)
            try {
                localStorage.setItem("theme_v1", button.dataset.t)
            } catch (e) {
                // см. выше
            }
        })
    }
    // Смена системной темы при выборе «как в системе»
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
        if (!document.documentElement.hasAttribute("data-theme")) {
            restyle_plots()
        }
    })
}

// Цвета линий графиков из токенов: главная, вторая, хорошо, плохо
function plot_colors() {
    return [token("--accent"), token("--low"), token("--ok"), token("--high")]
}

// Общая часть layout Plotly под текущую тему
function plot_layout_theme() {
    const font = { family: '"IBM Plex Mono", ui-monospace, monospace', size: 11, color: token("--ink-2") }
    return {
        paper_bgcolor: token("--surface"),
        plot_bgcolor: token("--surface"),
        font,
        axis: {
            gridcolor: token("--line-soft"),
            linecolor: token("--line"),
            zerolinecolor: token("--line"),
            tickfont: font,
            title: { font },
        },
    }
}

// ---------- График полёта ----------

const flight_data = { data: [], layout: {} }

function setup_flight_plot() {
    const names = ["Крен", "Тангаж", "Газ", "Высота"]
    const units = ["°", "°", "", "м"]
    const colors = plot_colors()
    const theme = plot_layout_theme()

    flight_data.data = []
    for (let i = 0; i < names.length; i++) {
        flight_data.data[i] = {
            mode: "lines",
            name: names[i],
            meta: names[i],
            line: { color: colors[i], width: 1.2 },
            yaxis: (i == 0) ? "y" : "y" + (i + 1),
            hovertemplate: "<extra></extra>%{meta}<br>%{x:.2f} с<br>%{y:.2f} " + units[i],
            x: [],
            y: [],
        }
    }

    flight_data.layout = {
        paper_bgcolor: theme.paper_bgcolor,
        plot_bgcolor: theme.plot_bgcolor,
        font: theme.font,
        xaxis: { ...theme.axis, title: { text: "Время, с", font: theme.font }, domain: [0.07, 0.93], zeroline: false, showline: true, mirror: true, rangeslider: {} },
        showlegend: false,
        margin: { b: 50, l: 50, r: 50, t: 20 },
    }
    const positions = [0, 0.06, 0.94, 1]
    for (let i = 0; i < names.length; i++) {
        const key = (i == 0) ? "yaxis" : "yaxis" + (i + 1)
        flight_data.layout[key] = {
            ...theme.axis,
            title: { text: names[i], font: { ...theme.font, color: colors[i] } },
            tickfont: { ...theme.font, color: colors[i] },
            zeroline: false,
            showline: true,
            mirror: true,
            side: (i < 2) ? "left" : "right",
            position: positions[i],
            color: colors[i],
        }
        if (i > 0) {
            flight_data.layout[key].overlaying = "y"
        }
    }

    const plot = document.getElementById("FlightData")
    Plotly.purge(plot)
    Plotly.newPlot(plot, flight_data.data, flight_data.layout, { displaylogo: false, responsive: true })

    // Ползунок и зум по X задают интервал анализа
    plot.on("plotly_relayout", (data) => {
        if (data["xaxis.range"] !== undefined) {
            set_interval(data["xaxis.range"][0], data["xaxis.range"][1])
        } else if ((data["xaxis.range[0]"] !== undefined) && (data["xaxis.range[1]"] !== undefined)) {
            set_interval(data["xaxis.range[0]"], data["xaxis.range[1]"])
        } else if (data["xaxis.autorange"] === true && state.info != null) {
            set_interval(state.settings.min, state.settings.max)
        }
    })
}

// Перерисовать графики под новую тему, данные сохраняются
function restyle_plots() {
    if (typeof Plotly === "undefined" || document.getElementById("FlightData") == null || flight_data.data.length == 0) {
        return
    }
    const colors = plot_colors()
    const theme = plot_layout_theme()
    flight_data.layout.paper_bgcolor = theme.paper_bgcolor
    flight_data.layout.plot_bgcolor = theme.plot_bgcolor
    flight_data.layout.font = theme.font
    Object.assign(flight_data.layout.xaxis, theme.axis, { title: { text: "Время, с", font: theme.font } })
    for (let i = 0; i < flight_data.data.length; i++) {
        flight_data.data[i].line.color = colors[i]
        const key = (i == 0) ? "yaxis" : "yaxis" + (i + 1)
        Object.assign(flight_data.layout[key], theme.axis, {
            title: { text: flight_data.data[i].name, font: { ...theme.font, color: colors[i] } },
            tickfont: { ...theme.font, color: colors[i] },
            color: colors[i],
        })
    }
    Plotly.react("FlightData", flight_data.data, flight_data.layout, { displaylogo: false, responsive: true })
}

// ---------- Интервал анализа и окно FFT ----------

function set_interval(start, end) {
    start = Math.floor(start)
    end = Math.ceil(end)
    if (state.settings.min != null) {
        start = Math.max(start, state.settings.min)
        end = Math.min(end, state.settings.max)
    }
    state.settings.start = start
    state.settings.end = end
    document.getElementById("TimeStart").value = start
    document.getElementById("TimeEnd").value = end
}

function interval_input_changed() {
    const start = parseFloat(document.getElementById("TimeStart").value)
    const end = parseFloat(document.getElementById("TimeEnd").value)
    if (!(end > start)) {
        set_interval(state.settings.start, state.settings.end)
        return
    }
    set_interval(start, end)
    flight_data.layout.xaxis.range = [state.settings.start, state.settings.end]
    flight_data.layout.xaxis.autorange = false
    Plotly.relayout("FlightData", { "xaxis.range": [state.settings.start, state.settings.end] })
}

// Окно FFT — ближайшая степень двойки в сторону изменения
function window_size_changed(input) {
    const value = parseInt(input.value)
    let size = state.settings.window_size
    if (value > size) {
        size *= 2
    } else if (value < size) {
        size = Math.max(64, size / 2)
    }
    state.settings.window_size = size
    input.value = size
}

// ---------- Шаги ----------

function step_available(n) {
    if (n == 0) {
        return true
    }
    return (state.info != null) && (state.info.vehicle === "Copter")
}

function set_step(n) {
    if (!step_available(n)) {
        return
    }
    state.step = n
    for (const section of document.querySelectorAll("section[data-step]")) {
        section.hidden = Number(section.dataset.step) !== n
    }
    update_wizbar()
    if (n == 0) {
        restyle_plots()
    }
}

function update_wizbar() {
    const buttons = document.querySelectorAll("#wizbar button")
    for (let i = 0; i < buttons.length; i++) {
        buttons[i].disabled = !step_available(i)
        if (i === state.step) {
            buttons[i].setAttribute("aria-current", "step")
        } else {
            buttons[i].removeAttribute("aria-current")
        }
    }
}

function init_wizard() {
    const bar = document.getElementById("wizbar")
    for (let i = 0; i < STEP_TITLES.length; i++) {
        const button = document.createElement("button")
        button.type = "button"
        button.innerHTML = '<span class="n">Шаг ' + i + '</span><span class="t">' + STEP_TITLES[i] + '</span>'
        button.addEventListener("click", () => set_step(i))
        bar.appendChild(button)
    }
    setup_flight_plot()
    set_step(0)
}

// ---------- Загрузка лога (шаг 0) ----------

function read_file(input) {
    const file = input.files[0]
    if (file == null) {
        return
    }
    const reader = new FileReader()
    reader.onload = function () {
        loading_call(async () => {
            state.file_name = file.name
            await load(reader.result)
        })
    }
    reader.readAsArrayBuffer(file)
}

function show_verdict(status, text) {
    const verdict = document.getElementById("log_verdict")
    verdict.className = "verdict verdict--" + status
    verdict.textContent = text
    verdict.hidden = false
}

function reset() {
    document.title = "Мастер настройки"
    state.log = null
    state.version = null
    state.params = null
    state.info = null
    state.vibe = null
    state.checks = null
    state.settings = { start: 0, end: 0, min: null, max: null, window_size: state.settings.window_size }
    state.steps = []
    for (const id of ["TimeStart", "TimeEnd", "FFTWindow_size"]) {
        document.getElementById(id).disabled = true
    }
    document.getElementById("log_verdict").hidden = true
    document.getElementById("log_info").hidden = true
    document.getElementById("log_checks").hidden = true
    for (const trace of flight_data.data) {
        trace.x = []
        trace.y = []
    }
    update_wizbar()
}

async function load(buffer) {
    await import_done
    const start = performance.now()
    reset()

    const log = new DataflashParser()
    log.processData(buffer, [])
    if (!("PARM" in log.messageTypes)) {
        show_verdict("fail", "В файле нет параметров (PARM): это не лог ArduPilot или он повреждён")
        return
    }

    state.log = log
    state.version = get_version_and_board(log)
    state.params = log_params(log)
    state.info = log_info(log, state.version)
    state.vibe = vibe_summary(log)
    state.checks = run_checks(state.info, state.params, state.vibe)

    document.title = "Мастер настройки: " + state.file_name
    document.getElementById("fileLabel").textContent = state.file_name

    render_info()
    render_checks()
    plot_flight()

    for (const id of ["TimeStart", "TimeEnd", "FFTWindow_size"]) {
        document.getElementById(id).disabled = false
    }
    update_wizbar()
    console.log("Загрузка заняла " + Math.round(performance.now() - start) + " мс")
}

function stat(key, value, accent) {
    return '<div class="stat' + (accent ? " stat--accent" : "") + '"><span class="stat__k">' + key + '</span><span class="stat__v">' + value + '</span></div>'
}

function format_seconds(s) {
    if (s == null) {
        return "—"
    }
    const m = Math.floor(s / 60)
    const sec = Math.round(s - m * 60)
    return (m > 0) ? m + " мин " + sec + " с" : sec + " с"
}

function render_info() {
    const info = state.info
    const params = state.params
    const flight = info.flight
    const html = [
        stat("Аппарат", info.vehicle ?? "—", info.vehicle === "Copter"),
        stat("Прошивка", info.fw_string ?? "—"),
        stat("Плата", info.board ?? "—"),
        stat("Длительность лога", format_seconds(info.duration_s)),
        stat("Полёт с газом", flight ? format_seconds(flight.duration_s) : "нет"),
        stat("Средний газ", (flight && flight.mean_throttle != null) ? flight.mean_throttle.toFixed(2) : "—"),
        stat("INS_GYRO_FILTER", params.get("INS_GYRO_FILTER") ?? "—"),
        stat("SCHED_LOOP_RATE", params.get("SCHED_LOOP_RATE") ?? "—"),
        stat("Версия фильтра", info.filter_version ?? "—"),
    ]
    const box = document.getElementById("log_info")
    box.innerHTML = html.join("")
    box.hidden = false
}

function render_checks() {
    const labels = { ok: "OK", warn: "ВНИМ", fail: "СТОП" }
    const box = document.getElementById("log_checks")
    box.innerHTML = state.checks.map((c) =>
        '<div class="check check--' + c.status + '"><span class="check__s">' + labels[c.status] + '</span>' +
        '<div class="check__b"><h3>' + c.title + '</h3><p>' + c.text + '</p>' +
        (c.fix ? '<p class="fix"><b>Что сделать:</b> ' + c.fix + '</p>' : "") + '</div></div>'
    ).join("")
    box.hidden = false

    const summary = checks_summary(state.checks)
    const texts = {
        ok: "Лог пригоден: все проверки пройдены",
        warn: "Лог пригоден с оговорками: " + summary.warn + " предупреждений",
        fail: "Есть блокирующие проблемы: " + summary.fail + " — см. список ниже",
    }
    show_verdict(summary.status, texts[summary.status])
}

function plot_flight() {
    const log = state.log
    if ("ATT" in log.messageTypes) {
        const time = us_to_s(log.get("ATT", "TimeUS"))
        flight_data.data[0].x = time
        flight_data.data[0].y = log.get("ATT", "Roll")
        flight_data.data[1].x = time
        flight_data.data[1].y = log.get("ATT", "Pitch")
    }
    const throttle = throttle_series(log)
    if (throttle != null) {
        flight_data.data[2].x = throttle.time
        flight_data.data[2].y = throttle.throttle
    }
    if ("POS" in log.messageTypes) {
        flight_data.data[3].x = us_to_s(log.get("POS", "TimeUS"))
        flight_data.data[3].y = log.get("POS", "RelHomeAlt")
    }

    // Границы данных и интервал по умолчанию: полёт с газом, иначе весь лог
    let min = Infinity
    let max = -Infinity
    for (const trace of flight_data.data) {
        if (trace.x.length > 0) {
            min = Math.min(min, trace.x[0])
            max = Math.max(max, trace.x[trace.x.length - 1])
        }
    }
    if (!Number.isFinite(min)) {
        min = 0
        max = state.info.duration_s ?? 0
    }
    state.settings.min = Math.floor(min)
    state.settings.max = Math.ceil(max)
    const flight = state.info.flight
    set_interval(flight ? flight.start : min, flight ? flight.end : max)
    for (const id of ["TimeStart", "TimeEnd"]) {
        document.getElementById(id).min = state.settings.min
        document.getElementById(id).max = state.settings.max
    }

    flight_data.layout.xaxis.range = [state.settings.start, state.settings.end]
    flight_data.layout.xaxis.autorange = false
    Plotly.react("FlightData", flight_data.data, flight_data.layout, { displaylogo: false, responsive: true })
}
```

**Шаг 3: проверить в браузере**

Запуск (из корня репозитория): `python -m http.server --bind 127.0.0.1 8000`
Открыть `http://127.0.0.1:8000/TuneWizard/`.
Ожидание: заголовок «Мастер настройки», полоса из шести шагов (активен «Шаг 0», остальные недоступны), карточка с кнопкой «Выбрать лог…» и тремя отключёнными полями, пустой график полёта. Переключатель темы меняет фон страницы и графика; выбор сохраняется после перезагрузки страницы. В консоли браузера ошибок нет.

**Шаг 4: линт**

Запуск: `npm run lint` → код выхода 0. Если ESLint ругается на неиспользуемые глобалы страницы — это ошибка в коде, не подавлять.

**Шаг 5: коммит**

```bash
git add TuneWizard/index.html TuneWizard/wizard.js
git commit -F - <<'EOF'
TuneWizard: каркас страницы, темы и полоса шагов

Страница мастера с токенами двух тем и переключателем, навигация
по шести шагам, пустой график полёта в цветах темы.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Задача 4: шаг 0 на реальном логе — ручная проверка и правки

Код шага 0 уже в `wizard.js` (задача 3). Здесь — проверка на реальном `.bin` из `TuneWizard/logs/` и исправление того, что всплывёт.

**Файлы:**
- Возможные правки: `TuneWizard/wizard.js`, `TuneWizard/core/log.js`, `TuneWizard/core/checks.js`, `tests/tunewizard.test.cjs`

**Шаг 1: загрузить лог**

Открыть `http://127.0.0.1:8000/TuneWizard/`, нажать «Выбрать лог…», выбрать файл из `TuneWizard/logs/`.
Ожидание: во время загрузки — оверлей «Loading»; затем вердикт (ok/warn/fail), плитки сведений, список проверок, график с четырьмя рядами, интервал анализа — участок с газом, поля активны, шаги 1–5 стали доступны (если аппарат Copter).

**Шаг 2: сверить с FilterReview**

Открыть тот же лог в `http://127.0.0.1:8000/FilterReview/`.
Ожидание: «Analysis time» Start/End совпадают с «Начало/Конец анализа» мастера; график полёта выглядит так же (крен, тангаж, газ, высота).

**Шаг 3: проверить интервал**

Потянуть ползунок под графиком — поля «Начало/Конец» меняются. Ввести в поля значения — график перестраивается. Ввести конец меньше начала — поля откатываются.

**Шаг 4: проверить окно FFT**

Стрелками в поле «Окно FFT» — значение ходит по степеням двойки (512 → 1024 → 2048), ниже 64 не опускается.

**Шаг 5: проверить тёмную тему с данными**

Переключить тему — график перерисовывается в цветах темы, данные на месте.

**Шаг 6: исправить найденное**

Для каждой ошибки в ядре — сначала падающий тест в `tests/tunewizard.test.cjs`, потом правка. Для ошибок в `wizard.js` — правка и повторная ручная проверка.

Запуск: `node --test tests/tunewizard.test.cjs && npm run lint`
Ожидание: все тесты проходят, линт чистый.

**Шаг 7: коммит (если были правки)**

```bash
git add TuneWizard tests/tunewizard.test.cjs
git commit -F - <<'EOF'
TuneWizard: шаг 0 — правки по проверке на реальном логе

<что именно исправлено>

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Задача 5: Readme и завершение этапа

**Файлы:**
- Создать: `TuneWizard/Readme.md`

**Шаг 1: создать `TuneWizard/Readme.md`**

```markdown
## Мастер настройки

Пошаговый мастер настройки Copter по одному логу `.bin`: проверка лога, спектр гироскопов, гармонический notch, низкочастотные фильтры, PID по осям, сводка и файл параметров. Объединяет расчёты FilterReview и PIDReview; оригинальные инструменты не изменяет.

Дизайн: `docs/plans/2026-10-23-tune-wizard-design.md`. Этапы реализации — в `docs/plans/`.

### Запуск

Из корня репозитория: `python -m http.server --bind 127.0.0.1`, затем `http://127.0.0.1:8000/TuneWizard/`.

### Структура

- `index.html`, `wizard.js` — страница, состояние, навигация, графики Plotly.
- `core/` — математика и проверки без DOM; те же файлы гоняются под Node: `node --test tests/tunewizard.test.cjs`.
- `logs/` — локальные логи для ручной проверки, в репозиторий не попадают.

### Готовность

- Этап 1: каркас, темы, шаг 0 (лог и проверки) — готово.
- Этапы 2–6: спектр и notch, фильтры, PID, сводка, лендинг — в работе.
```

**Шаг 2: полная проверка**

Запуск: `npm test && npm run lint`
Ожидание: все тесты (116 прежних + новые) проходят, линт чистый.

**Шаг 3: коммит и push**

```bash
git add TuneWizard/Readme.md
git commit -F - <<'EOF'
TuneWizard: Readme и завершение этапа 1

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
git push origin tune-wizard
```

---

## Что сознательно не вошло в этап 1

- Память прошлого прохода («предлагалось → в логе сейчас») — читается и пишется на этапе 5 вместе со сводкой.
- Ссылка и иконка на лендинге — этап 6.
- Tippy-подсказки — добавим, когда появятся поля параметров (этап 2).
