// Тесты памяти прохода мастера настройки (TuneWizard/core/passmem.js): чтение и запись хранилища (версия,
// испорченный JSON, недоступное хранилище), ключ аппарата и запасной ключ, запись прохода (изменённые параметры,
// оценки шагов 2–4), предел числа аппаратов, «забыть» и список, «применено / другое значение / нет в логе»,
// «лог прошлого прохода», статус шага и условия строки сравнения (всё применено, частично, ось ненадёжна).
// Скрипты ядра — классические (общая глобальная область), поэтому загружаются как на странице:
// по порядку через vm.runInThisContext (как в tests/tunewizard-summary.test.cjs).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const repo = path.resolve(__dirname, '..')

// Загрузить скрипты страницы в глобальную область, в том порядке, что и index.html
function load_page_scripts(files) {
    for (const file of files) {
        const full = path.join(repo, file)
        vm.runInThisContext(fs.readFileSync(full, 'utf8'), { filename: full })
    }
}

// Как в tests/tunewizard-summary.test.cjs плюс core/passmem.js: summary_same (summary.js; ему — params.js и
// Param_Helpers.js), lowpass_pid_axes (lowpass.js; ему при загрузке нужен candidate_rules из candidates.js),
// pidtune_axes (pidtune.js; ему — константы core/pid.js)
load_page_scripts([
    'Libraries/Param_Helpers.js',
    'TuneWizard/core/filters.js',
    'TuneWizard/core/candidates.js',
    'TuneWizard/core/lowpass.js',
    'TuneWizard/core/pid.js',
    'TuneWizard/core/pidtune.js',
    'TuneWizard/core/params.js',
    'TuneWizard/core/summary.js',
    'TuneWizard/core/passmem.js',
])

// ---------------------------------------------------------------- поддельные данные

// Хранилище с интерфейсом localStorage над словарём data (строки)
function fake_storage(data = {}) {
    return {
        data: data,
        getItem: (key) => (key in data) ? data[key] : null,
        setItem: (key, value) => { data[key] = String(value) },
        removeItem: (key) => { delete data[key] },
    }
}

// Хранилище, которое бросает: при чтении (приватный режим, запрет хранилища) или при записи (квота)
function throwing_storage({ get = false, set = false } = {}) {
    return {
        getItem: (key) => { if (get) throw new Error('SecurityError'); return null },
        setItem: () => { if (set) throw new Error('QuotaExceededError') },
        removeItem: () => {},
    }
}

// Параметры лога с интерфейсом log_params: get(name) — значение или null, has(name)
function fake_params(values) {
    return {
        get: (name) => (name in values) ? values[name] : null,
        has: (name) => name in values,
    }
}

// Строка контроллера и рама тестового лога (2026-06-18 18-54-42_anon.bin)
const BOARD = 'StellarH7V2 0034002E 35335104 39363630'
const LOG_NAME = '2026-06-18 18-54-42_anon.bin'
const INFO = { board: BOARD, frame: 'QUAD/X_REV', fw_string: 'ArduCopter V4.6.3 (3fc7011a)' }

// Строки итога (summary_rows(…).rows): изменённые и нет. ATC_RAT_RLL_FLTD — шаг 3, но с префиксом оси крена шага 4
const ROWS = [
    { name: 'INS_HNTCH_FREQ', log: 80, value: 75, step: 2, changed: true, note: null },
    { name: 'INS_HNTCH_BW', log: 40, value: 40, step: 2, changed: false, note: null },
    { name: 'INS_HNTCH_HMNCS', log: 3, value: 128, step: 2, changed: true, note: null },
    { name: 'INS_HNTC2_FREQ', log: null, value: 153, step: 2, changed: false, note: 'нет в логе — не пишется' },
    { name: 'INS_GYRO_FILTER', log: 40, value: 40, step: 3, changed: false, note: null },
    { name: 'ATC_RAT_RLL_FLTD', log: 20, value: 25, step: 3, changed: true, note: null },
    { name: 'ATC_RAT_RLL_P', log: Math.fround(0.135), value: 0.7, step: 4, changed: true, note: null },
    { name: 'ATC_RAT_PIT_D', log: Math.fround(0.0036), value: 0.004, step: 4, changed: true,
      note: 'ось ненадёжна — значение введено вручную' },
    { name: 'ATC_RAT_YAW_P', log: Math.fround(0.18), value: Math.fround(0.18), step: 4, changed: false, note: null },
]

// Лог, в котором все изменённые из ROWS применены (значения как float32 из лога, маска HMNCS — со знаком при 8 битах)
const APPLIED_LOG = {
    INS_HNTCH_FREQ: 75, INS_HNTCH_HMNCS: -128, ATC_RAT_RLL_FLTD: 25,
    ATC_RAT_RLL_P: 0.699999988, ATC_RAT_PIT_D: Math.fround(0.004),
}

// Лог прошлого прохода: все изменённые из ROWS — как «было»
const PASS_LOG = {
    INS_HNTCH_FREQ: 80, INS_HNTCH_HMNCS: 3, ATC_RAT_RLL_FLTD: 20,
    ATC_RAT_RLL_P: Math.fround(0.135), ATC_RAT_PIT_D: Math.fround(0.0036),
}

// Сводка оценки шага 2 (поля step2_metrics_summary: current и log)
function step2_eval(band_dB, lag10, lag30) {
    return { band_dB: band_dB, band_f2_dB: null, lag_ms: { 10: lag10, 30: lag30 }, warnings: [] }
}

// Сводка оценки шага 3 (поля step3_metrics_summary); dterm — { roll: дБ | null, pitch: дБ | null },
// lag — { roll: [P10, P30, D10, D30], pitch: […] }
function step3_eval(gyro_dB, dterm, lag) {
    const paths = (v) => ({ P: { 10: v[0], 30: v[1] }, D: { 10: v[2], 30: v[3] } })
    return {
        kd: { roll: 0.0036, pitch: 0.0036 },
        gyro: { band_dB: gyro_dB, lag_ms: { 10: 0.5, 30: 1.5 } },
        dterm: { roll: (dterm.roll != null) ? { dB: dterm.roll } : null, pitch: (dterm.pitch != null) ? { dB: dterm.pitch } : null },
        lag_ms: { roll: paths(lag.roll), pitch: paths(lag.pitch) },
        warnings: [],
    }
}

// Сводка оси шага 4 (поля step4_metrics_summary): measured — [rise_s, overshoot_pct], log — [pm_deg, crossover_hz],
// prediction — [overshoot_pct, rise_s, pm_deg, unstable]; null — нет
function step4_eval({ reliable, measured = null, log = null, prediction = null }) {
    return {
        source: 'PIDR', status: reliable ? 'ok' : 'few_steps', reliable: reliable, prediction_valid: prediction != null,
        windows: 14, data_s: 42.5,
        measured: (measured != null) ? { rise_s: measured[0], overshoot_pct: measured[1], plateau: 1.02, settle_s: 0.21, osc: false } : null,
        log: (log != null) ? { pm_deg: log[0], crossover_hz: log[1], unstable: false, rise_s: 0.06, overshoot_pct: 15, settle_s: 0.3 } : null,
        prediction: (prediction != null) ? { pm_deg: prediction[2], crossover_hz: 9.5, unstable: prediction[3], rise_s: prediction[1],
                                             overshoot_pct: prediction[0], settle_s: 0.2 } : null,
        d_noise_dB: -44.5,
    }
}

// state.steps с принятыми шагами 2–4 и метриками. Ось крена надёжна, тангажа — нет (значение введено вручную),
// рыскания — надёжна, но прогноз недостоверен (prediction null)
function fake_steps() {
    const steps = []
    steps[2] = {
        accepted: { INS_HNTCH_FREQ: 75, INS_HNTCH_HMNCS: 128 }, candidate_id: 'current', flags: null, evaluated_at: 1,
        metrics: {
            peaks: [{ freq: 80, axes: ['x'], source: null, pre_dB: -20, post_dB: -35, log_post_dB: -33 }],
            current: step2_eval(-42.5, 0.81, 2.43),
            log: step2_eval(-40.25, 0.92, 2.71),
        },
    }
    steps[3] = {
        accepted: { INS_GYRO_FILTER: 40, ATC_RAT_RLL_FLTD: 25 }, candidate_id: 'custom', prop_in: 5, flags: null,
        calc_key: 'k3', evaluated_at: 2,
        metrics: {
            current: step3_eval(-51.5, { roll: -31.25, pitch: null }, { roll: [1.1, 3.3, 1.4, 4.2], pitch: [1.2, 3.4, 1.5, 4.3] }),
            log: step3_eval(-50, { roll: -30, pitch: -29.5 }, { roll: [1, 3, 1.3, 4], pitch: [1.05, 3.1, 1.35, 4.1] }),
        },
    }
    steps[4] = {
        accepted: { ATC_RAT_RLL_P: 0.7, ATC_RAT_PIT_D: 0.004 }, calc_key: 'k4', evaluated_at: 3,
        axes: {
            roll: { candidate_id: 'custom', flags: null,
                    metrics: step4_eval({ reliable: true, measured: [0.055, 12.5], log: [48, 11.2], prediction: [8.5, 0.05, 55, false] }) },
            pitch: { candidate_id: 'custom', flags: null, metrics: step4_eval({ reliable: false, log: [47, 11] }) },
            yaw: { candidate_id: 'current', flags: null, metrics: step4_eval({ reliable: true, measured: [0.12, 4], log: [60, 4.5] }) },
        },
    }
    return steps
}

// Проход по ROWS и fake_steps (или переданным steps)
function fake_pass({ steps = fake_steps(), rows = ROWS, key = 'fc:' + BOARD, saved_at = 1000 } = {}) {
    return passmem_record({ key: key, info: INFO, file_name: LOG_NAME, rows: rows, steps: steps, saved_at: saved_at })
}

// ---------------------------------------------------------------- хранилище

test('константы: ключ tunewizard_v1, версия 1, не больше 20 аппаратов', () => {
    assert.equal(PASSMEM_KEY, 'tunewizard_v1')
    assert.equal(PASSMEM_VERSION, 1)
    assert.equal(PASSMEM_MAX, 20)
})

test('passmem_write и passmem_read: туда-обратно; в хранилище — { version, passes } под PASSMEM_KEY', () => {
    const storage = fake_storage()
    const passes = { ['fc:' + BOARD]: fake_pass() }
    assert.equal(passmem_write(storage, passes), null)
    assert.deepEqual(Object.keys(storage.data), [PASSMEM_KEY])
    assert.deepEqual(JSON.parse(storage.data[PASSMEM_KEY]), { version: PASSMEM_VERSION, passes: passes })
    assert.deepEqual(passmem_read(storage), { passes: passes, error: null })
})

test('passmem_read: ключа нет — пусто без ошибки', () => {
    assert.deepEqual(passmem_read(fake_storage()), { passes: {}, error: null })
    assert.deepEqual(passmem_read(fake_storage({ other_key: '{}' })), { passes: {}, error: null })
})

test('passmem_read: испорченный JSON, чужая версия, нет passes — "corrupt"', () => {
    const corrupt = { passes: {}, error: 'corrupt' }
    const texts = [
        '{не JSON',
        '',
        JSON.stringify({ version: 2, passes: {} }),
        JSON.stringify({ passes: {} }),
        JSON.stringify({ version: '1', passes: {} }),
        JSON.stringify({ version: 1 }),
        JSON.stringify({ version: 1, passes: null }),
        JSON.stringify({ version: 1, passes: [] }),
        JSON.stringify({ version: 1, passes: 'x' }),
        'null',
        '[]',
    ]
    for (const text of texts) {
        assert.deepEqual(passmem_read(fake_storage({ [PASSMEM_KEY]: text })), corrupt, text)
    }
})

test('passmem_read: хранилища нет или оно бросает — "unavailable"', () => {
    const unavailable = { passes: {}, error: 'unavailable' }
    assert.deepEqual(passmem_read(null), unavailable)
    assert.deepEqual(passmem_read(throwing_storage({ get: true })), unavailable)
})

test('passmem_write: setItem бросает (квота) или хранилища нет — "unavailable"', () => {
    assert.equal(passmem_write(throwing_storage({ set: true }), {}), 'unavailable')
    assert.equal(passmem_write(null, {}), 'unavailable')
    // Без исключения — null
    assert.equal(passmem_write(throwing_storage(), {}), null)
})

// ---------------------------------------------------------------- ключ аппарата

test('passmem_aircraft_key: строка контроллера тестового лога — ключ fc:', () => {
    assert.equal(passmem_aircraft_key(INFO, LOG_NAME), 'fc:StellarH7V2 0034002E 35335104 39363630')
    // Имя файла и рама на ключ не влияют: тот же аппарат — тот же ключ
    assert.equal(passmem_aircraft_key({ ...INFO, frame: 'HEXA/X' }, 'другой.bin'), 'fc:' + BOARD)
})

test('passmem_aircraft_key: без строки контроллера — запасной ключ log: с рамой и именем файла', () => {
    assert.equal(passmem_aircraft_key({ ...INFO, board: null }, LOG_NAME), 'log:—·QUAD/X_REV·' + LOG_NAME)
    assert.equal(passmem_aircraft_key({ ...INFO, board: '' }, LOG_NAME), 'log:—·QUAD/X_REV·' + LOG_NAME)
    // Рамы нет (null или поля нет вовсе) — «—»
    assert.equal(passmem_aircraft_key({ board: null, frame: null, fw_string: INFO.fw_string }, LOG_NAME), 'log:—·—·' + LOG_NAME)
    assert.equal(passmem_aircraft_key({ board: null, fw_string: INFO.fw_string }, LOG_NAME), 'log:—·—·' + LOG_NAME)
    // Разные логи без строки контроллера — разные ключи
    assert.notEqual(passmem_aircraft_key({ board: null }, 'a.bin'), passmem_aircraft_key({ board: null }, 'b.bin'))
})

// ---------------------------------------------------------------- запись прохода

test('passmem_record: подпись прохода и изменённые — только строки с changed, поля { name, log, value, step }', () => {
    const pass = fake_pass()
    assert.equal(pass.key, 'fc:' + BOARD)
    assert.equal(pass.board, BOARD)
    assert.equal(pass.frame, 'QUAD/X_REV')
    assert.equal(pass.fw, 'ArduCopter V4.6.3 (3fc7011a)')
    assert.equal(pass.file_name, LOG_NAME)
    assert.equal(pass.saved_at, 1000)
    assert.deepEqual(pass.changed, [
        { name: 'INS_HNTCH_FREQ', log: 80, value: 75, step: 2 },
        { name: 'INS_HNTCH_HMNCS', log: 3, value: 128, step: 2 },
        { name: 'ATC_RAT_RLL_FLTD', log: 20, value: 25, step: 3 },
        { name: 'ATC_RAT_RLL_P', log: Math.fround(0.135), value: 0.7, step: 4 },
        { name: 'ATC_RAT_PIT_D', log: Math.fround(0.0036), value: 0.004, step: 4 },
    ])
})

test('passmem_record: оценки шага 2 — полоса и задержка на 30 Гц лога и принятого', () => {
    assert.deepEqual(fake_pass().estimates[2], {
        log: { band_dB: -40.25, lag30_ms: 2.71 },
        accepted: { band_dB: -42.5, lag30_ms: 2.43 },
    })
})

test('passmem_record: оценки шага 3 — шум гироскопа, шум D крена и тангажа, задержка путей P и D на 30 Гц', () => {
    assert.deepEqual(fake_pass().estimates[3], {
        log: { gyro_band_dB: -50, dterm_dB: { roll: -30, pitch: -29.5 },
               lag30_ms: { roll: { P: 3, D: 4 }, pitch: { P: 3.1, D: 4.1 } } },
        // Шума D тангажа нет (dterm.pitch null) — null
        accepted: { gyro_band_dB: -51.5, dterm_dB: { roll: -31.25, pitch: null },
                    lag30_ms: { roll: { P: 3.3, D: 4.2 }, pitch: { P: 3.4, D: 4.3 } } },
    })
})

test('passmem_record: оценки шага 4 — по осям надёжность, измерение, лог и прогноз; нет — null', () => {
    assert.deepEqual(fake_pass().estimates[4], {
        roll: { reliable: true, measured: { overshoot_pct: 12.5, rise_s: 0.055 }, log: { pm_deg: 48, crossover_hz: 11.2 },
                prediction: { overshoot_pct: 8.5, rise_s: 0.05, pm_deg: 55, unstable: false } },
        pitch: { reliable: false, measured: null, log: { pm_deg: 47, crossover_hz: 11 }, prediction: null },
        yaw: { reliable: true, measured: { overshoot_pct: 4, rise_s: 0.12 }, log: { pm_deg: 60, crossover_hz: 4.5 }, prediction: null },
    })
})

test('passmem_record: непринятые шаги и шаги без метрик — оценки null', () => {
    assert.deepEqual(fake_pass({ steps: [], rows: [] }).estimates, { 2: null, 3: null, 4: null })
    assert.deepEqual(fake_pass({ steps: [], rows: [] }).changed, [])

    const steps = fake_steps()
    steps[2].metrics = null
    steps[3].metrics = null
    const pass = fake_pass({ steps: steps })
    assert.equal(pass.estimates[2], null)
    assert.equal(pass.estimates[3], null)
    assert.notEqual(pass.estimates[4], null)

    // Принят только шаг 3
    const only3 = []
    only3[3] = fake_steps()[3]
    assert.deepEqual(Object.entries(fake_pass({ steps: only3 }).estimates).map(([n, e]) => [n, e != null]),
        [['2', false], ['3', true], ['4', false]])
})

test('passmem_record: undefined — null (запись уходит в JSON без потерь); рамы в info пока нет — null', () => {
    const steps = fake_steps()
    delete steps[2].metrics.current.lag_ms[30]
    delete steps[3].metrics.log.lag_ms.roll.D
    delete steps[4].axes.yaw.metrics.measured.overshoot_pct
    const pass = passmem_record({ key: 'k', info: { board: BOARD, fw_string: undefined }, file_name: LOG_NAME,
        rows: ROWS, steps: steps, saved_at: 5 })
    assert.equal(pass.frame, null)
    assert.equal(pass.fw, null)
    assert.equal(pass.estimates[2].accepted.lag30_ms, null)
    assert.deepEqual(pass.estimates[3].log.lag30_ms.roll, { P: 3, D: null })
    assert.equal(pass.estimates[4].yaw.measured.overshoot_pct, null)
    // Строгое сравнение отличает { x: undefined } от {}: после JSON запись та же
    assert.deepEqual(JSON.parse(JSON.stringify(pass)), pass)
    assert.deepEqual(JSON.parse(JSON.stringify(fake_pass())), fake_pass())
})

// ---------------------------------------------------------------- проходы

// Проход с ключом key и датой saved_at (подпись — как у fake_pass)
function pass_at(key, saved_at) {
    return fake_pass({ key: key, saved_at: saved_at, steps: [], rows: [] })
}

test('passmem_put: запись по ключу, новый объект; тот же ключ — замена', () => {
    const passes = { a: pass_at('a', 1) }
    const next = passmem_put(passes, pass_at('b', 2))
    assert.deepEqual(Object.keys(next).sort(), ['a', 'b'])
    // Исходный объект не тронут
    assert.deepEqual(Object.keys(passes), ['a'])
    const replaced = passmem_put(next, pass_at('a', 3))
    assert.equal(replaced.a.saved_at, 3)
    assert.equal(Object.keys(replaced).length, 2)
})

test('passmem_put: предел 20 — 21-й проход вытесняет самый старый, а не последний добавленный', () => {
    // Порядок добавления не совпадает с датами: самый старый (saved_at 100) добавлен десятым
    let passes = {}
    for (let i = 0; i < PASSMEM_MAX; i++) {
        passes = passmem_put(passes, pass_at('k' + i, (i === 9) ? 100 : 1000 + i))
    }
    assert.equal(Object.keys(passes).length, PASSMEM_MAX)
    const next = passmem_put(passes, pass_at('new', 5000))
    assert.equal(Object.keys(next).length, PASSMEM_MAX)
    assert.equal('k9' in next, false)
    assert.equal('new' in next, true)
    assert.equal('k19' in next, true)

    // Замена прохода того же аппарата при полной памяти — никто не вытесняется
    const same = passmem_put(passes, pass_at('k0', 6000))
    assert.equal(Object.keys(same).length, PASSMEM_MAX)
    assert.equal('k9' in same, true)
    assert.equal(same.k0.saved_at, 6000)
})

test('passmem_put: добавляемый проход не вытесняется, даже если его дата самая старая (часы сбиты)', () => {
    let passes = {}
    for (let i = 0; i < PASSMEM_MAX; i++) {
        passes = passmem_put(passes, pass_at('k' + i, 1000 + i))
    }
    const next = passmem_put(passes, pass_at('new', 10))
    assert.equal(Object.keys(next).length, PASSMEM_MAX)
    assert.equal('new' in next, true)
    assert.equal('k0' in next, false)
})

test('passmem_forget: новый объект без ключа; нет такого ключа — копия', () => {
    const passes = { a: pass_at('a', 1), b: pass_at('b', 2) }
    assert.deepEqual(Object.keys(passmem_forget(passes, 'a')), ['b'])
    assert.deepEqual(Object.keys(passes), ['a', 'b'])
    const copy = passmem_forget(passes, 'нет')
    assert.deepEqual(copy, passes)
    assert.notEqual(copy, passes)
})

test('passmem_list: проходы по убыванию даты сохранения', () => {
    const passes = { a: pass_at('a', 20), b: pass_at('b', 30), c: pass_at('c', 10) }
    assert.deepEqual(passmem_list(passes).map((pass) => pass.key), ['b', 'a', 'c'])
    assert.deepEqual(passmem_list({}), [])
})

// ---------------------------------------------------------------- применено

test('passmem_applied: применено (0.7 против 0.699999988, маска со знаком), другое значение, нет в логе', () => {
    const log = { ...APPLIED_LOG, INS_HNTCH_FREQ: 80 }
    delete log.ATC_RAT_PIT_D
    const result = passmem_applied(fake_pass(), fake_params(log), 8)
    assert.deepEqual(result.rows, [
        { name: 'INS_HNTCH_FREQ', step: 2, proposed: 75, now: 80, status: 'other' },
        { name: 'INS_HNTCH_HMNCS', step: 2, proposed: 128, now: -128, status: 'applied' },
        { name: 'ATC_RAT_RLL_FLTD', step: 3, proposed: 25, now: 25, status: 'applied' },
        { name: 'ATC_RAT_RLL_P', step: 4, proposed: 0.7, now: 0.699999988, status: 'applied' },
        { name: 'ATC_RAT_PIT_D', step: 4, proposed: 0.004, now: null, status: 'absent' },
    ])
    assert.equal(result.applied, 3)
    assert.equal(result.total, 5)
    assert.equal(result.same_log, false)

    // Всё применено
    const all = passmem_applied(fake_pass(), fake_params(APPLIED_LOG), 8)
    assert.equal(all.applied, 5)
    assert.equal(all.total, 5)
    assert.ok(all.rows.every((row) => row.status === 'applied'))

    // Маска HMNCS сравнивается по размеру маски: при 32 битах −128 — другое значение
    assert.equal(passmem_applied(fake_pass(), fake_params(APPLIED_LOG), 32).rows[1].status, 'other')
})

test('passmem_applied: same_log — все значения как «было» прошлого прохода (лог ещё не применялся)', () => {
    assert.equal(passmem_applied(fake_pass(), fake_params(PASS_LOG), 8).same_log, true)
    // Значения лога — как float32 и маска со знаком: тоже «было»
    assert.equal(passmem_applied(fake_pass(), fake_params({ ...PASS_LOG, ATC_RAT_RLL_P: 0.135 }), 8).same_log, true)
    // Одно значение другое — уже не лог прошлого прохода
    assert.equal(passmem_applied(fake_pass(), fake_params({ ...PASS_LOG, INS_HNTCH_FREQ: 75 }), 8).same_log, false)
    // Параметр был в логе, а теперь его нет — не тот же лог
    const missing = { ...PASS_LOG }
    delete missing.ATC_RAT_RLL_FLTD
    assert.equal(passmem_applied(fake_pass(), fake_params(missing), 8).same_log, false)

    // Параметра не было в логе прошлого прохода (включаемый notch) и нет сейчас — «было» совпало
    const enabling = [{ name: 'INS_HNTC2_FREQ', log: null, value: 153, step: 2, changed: true, note: null }]
    assert.equal(passmem_applied(fake_pass({ rows: enabling }), fake_params({}), 8).same_log, true)
    assert.equal(passmem_applied(fake_pass({ rows: enabling }), fake_params({}), 8).rows[0].status, 'absent')

    // Изменений в проходе нет — не «лог прошлого прохода»
    const empty = passmem_applied(fake_pass({ rows: [] }), fake_params(PASS_LOG), 8)
    assert.deepEqual(empty, { rows: [], applied: 0, total: 0, same_log: false })
})

// ---------------------------------------------------------------- статус шага и строка сравнения

// Проход по fake_steps и «применено» для лога log
function pass_and_applied(log, steps = fake_steps()) {
    const pass = fake_pass({ steps: steps })
    return { pass: pass, applied: passmem_applied(pass, fake_params(log), 8) }
}

test('passmem_step_status: шаг ничего не менял — "none"; не все его изменённые применены — "partial"; все — "applied"', () => {
    const rows = ROWS.filter((row) => row.step !== 3)
    const pass = fake_pass({ rows: rows })
    const all = passmem_applied(pass, fake_params(APPLIED_LOG), 8)
    assert.equal(passmem_step_status(pass, all, 2), 'applied')
    assert.equal(passmem_step_status(pass, all, 3), 'none')
    assert.equal(passmem_step_status(pass, all, 4), 'applied')

    const partly = passmem_applied(pass, fake_params({ ...APPLIED_LOG, INS_HNTCH_FREQ: 80 }), 8)
    assert.equal(passmem_step_status(pass, partly, 2), 'partial')
    assert.equal(passmem_step_status(pass, partly, 4), 'applied')

    // Нет в логе — тоже не применено
    const absent = { ...APPLIED_LOG }
    delete absent.ATC_RAT_PIT_D
    assert.equal(passmem_step_status(pass, passmem_applied(pass, fake_params(absent), 8), 4), 'partial')
})

test('passmem_compare: шаги 2–3 — всё применено → ok с was (лог прохода), predicted (принятое) и now', () => {
    const { pass, applied } = pass_and_applied(APPLIED_LOG)
    const now2 = { band_dB: -42, lag30_ms: 2.5 }
    assert.deepEqual(passmem_compare(pass, applied, 2, now2), {
        status: 'ok', was: pass.estimates[2].log, predicted: pass.estimates[2].accepted, now: now2,
    })
    assert.deepEqual(passmem_compare(pass, applied, 2, now2).was, { band_dB: -40.25, lag30_ms: 2.71 })
    assert.deepEqual(passmem_compare(pass, applied, 2, now2).predicted, { band_dB: -42.5, lag30_ms: 2.43 })

    const now3 = { gyro_band_dB: -51, dterm_dB: { roll: -31, pitch: -30 }, lag30_ms: { roll: { P: 3.2, D: 4.1 }, pitch: { P: 3.3, D: 4.2 } } }
    assert.deepEqual(passmem_compare(pass, applied, 3, now3), {
        status: 'ok', was: pass.estimates[3].log, predicted: pass.estimates[3].accepted, now: now3,
    })
})

test('passmem_compare: применено не всё изменённое шага — partial; другой шаг на это не влияет', () => {
    const { pass, applied } = pass_and_applied({ ...APPLIED_LOG, INS_HNTCH_HMNCS: 3 })
    assert.deepEqual(passmem_compare(pass, applied, 2, { band_dB: -42, lag30_ms: 2.5 }), { status: 'partial' })
    assert.equal(passmem_compare(pass, applied, 3, {}).status, 'ok')
})

test('passmem_compare: шаг ничего не менял, оценок шага нет или прохода нет — null', () => {
    // Шаг 3 принят с оценками, но ничего не изменил
    const rows = ROWS.filter((row) => row.step !== 3)
    const pass = fake_pass({ rows: rows })
    const applied = passmem_applied(pass, fake_params(APPLIED_LOG), 8)
    assert.equal(passmem_compare(pass, applied, 3, {}), null)

    // Шаг 2 менял, но принят без метрик — оценок нет
    const steps = fake_steps()
    steps[2].metrics = null
    const no_metrics = pass_and_applied(APPLIED_LOG, steps)
    assert.equal(no_metrics.pass.estimates[2], null)
    assert.equal(passmem_compare(no_metrics.pass, no_metrics.applied, 2, {}), null)

    // Прохода нет (страница не нашла проход аппарата)
    assert.equal(passmem_compare(null, null, 2, {}), null)
})

test('passmem_compare: шаг 4 — ось надёжна, всё по оси применено → ok с измерением и логом оси, прогнозом и now', () => {
    const { pass, applied } = pass_and_applied(APPLIED_LOG)
    const now = { reliable: true, measured: { rise_s: 0.05, overshoot_pct: 9 }, log: { pm_deg: 54, crossover_hz: 12 } }
    assert.deepEqual(passmem_compare(pass, applied, 4, now, 'roll'), {
        status: 'ok',
        was: { measured: { overshoot_pct: 12.5, rise_s: 0.055 }, log: { pm_deg: 48, crossover_hz: 11.2 } },
        predicted: { overshoot_pct: 8.5, rise_s: 0.05, pm_deg: 55, unstable: false },
        now: now,
    })
})

test('passmem_compare: шаг 4 — ось ненадёжна в проходе или сейчас — unreliable', () => {
    const { pass, applied } = pass_and_applied(APPLIED_LOG)
    const reliable_now = { reliable: true, measured: { rise_s: 0.05, overshoot_pct: 9 }, log: { pm_deg: 54, crossover_hz: 12 } }
    // Тангаж ненадёжен в проходе (значение введено вручную), хотя сейчас надёжен
    assert.deepEqual(passmem_compare(pass, applied, 4, reliable_now, 'pitch'), { status: 'unreliable' })
    // Крен надёжен в проходе, но ненадёжен сейчас
    assert.deepEqual(passmem_compare(pass, applied, 4, { reliable: false, measured: null, log: null }, 'roll'), { status: 'unreliable' })
})

test('passmem_compare: шаг 4 — «применено» по параметрам оси; изменения другой оси и шага 3 с тем же префиксом не влияют', () => {
    const now = { reliable: true, measured: { rise_s: 0.05, overshoot_pct: 9 }, log: { pm_deg: 54, crossover_hz: 12 } }
    // Тангаж не применён, ATC_RAT_RLL_FLTD (шаг 3, префикс крена) — тоже: крен всё равно ok
    const pitch_not = pass_and_applied({ ...APPLIED_LOG, ATC_RAT_PIT_D: Math.fround(0.0036), ATC_RAT_RLL_FLTD: 20 })
    assert.equal(passmem_compare(pitch_not.pass, pitch_not.applied, 4, now, 'roll').status, 'ok')
    assert.deepEqual(passmem_compare(pitch_not.pass, pitch_not.applied, 4, now, 'pitch'), { status: 'partial' })
    // Шаг 4 в целом применён не весь
    assert.equal(passmem_step_status(pitch_not.pass, pitch_not.applied, 4), 'partial')

    // Крен не применён — partial, даже если ось надёжна
    const roll_not = pass_and_applied({ ...APPLIED_LOG, ATC_RAT_RLL_P: Math.fround(0.135) })
    assert.deepEqual(passmem_compare(roll_not.pass, roll_not.applied, 4, now, 'roll'), { status: 'partial' })

    // Рыскание шаг 4 не менял — строки нет, хотя ось надёжна и оценки есть
    assert.equal(passmem_compare(pitch_not.pass, pitch_not.applied, 4, now, 'yaw'), null)
})

test('passmem_compare: шаг 4 — нет записи оси в оценках — null', () => {
    const { pass, applied } = pass_and_applied(APPLIED_LOG)
    pass.estimates[4].roll = null
    assert.equal(passmem_compare(pass, applied, 4, { reliable: true, measured: null, log: null }, 'roll'), null)
})
