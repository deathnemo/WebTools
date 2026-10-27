// Тесты памяти прохода мастера настройки (TuneWizard/core/passmem.js): чтение и запись хранилища (версия,
// испорченный JSON, битые записи, недоступное хранилище), ключ аппарата и запасной ключ, запись прохода (изменённые
// параметры, оценки шагов 2–4; устаревшие и перекрытые шаги без оценок), одна оценка в форме памяти (её же страница
// передаёт как оценку нового лога), предел числа аппаратов, «забыть» и список,
// «применено / другое значение / нет в логе», «лог прошлого прохода», статус шага (накопительно по шагам 2–n) и
// условия строки сравнения (всё применено, частично, ось ненадёжна), совместимость с записанным форматом v1.
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

// Проход по ROWS и fake_steps (или переданным steps); stale и conflicts — как у страницы (step_accepted_stale,
// summary_rows(…).conflicts), по умолчанию нет
function fake_pass({ steps = fake_steps(), rows = ROWS, key = 'fc:' + BOARD, saved_at = 1000, stale, conflicts } = {}) {
    return passmem_record({ key: key, info: INFO, file_name: LOG_NAME, rows: rows, steps: steps, saved_at: saved_at,
                            stale: stale, conflicts: conflicts })
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

test('passmem_read: битые записи отбрасываются, остальные читаются; что-то отброшено — "corrupt"', () => {
    const good = fake_pass({ key: 'c' })
    const text = (passes) => JSON.stringify({ version: PASSMEM_VERSION, passes: passes })
    assert.deepEqual(passmem_read(fake_storage({ [PASSMEM_KEY]: text({ a: null, b: { key: 'b' }, c: good }) })),
        { passes: { c: good }, error: 'corrupt' })

    // Каждый вид порчи по отдельности — на годной записи под ключом x (сама она читается)
    const base = { ...good, key: 'x' }
    assert.deepEqual(passmem_read(fake_storage({ [PASSMEM_KEY]: text({ c: good, x: base }) })),
        { passes: { c: good, x: base }, error: null })
    const broken = {
        array: [base],
        number: 5,
        // key не тот, что в карте (иначе «Забыть» по pass.key промахнётся), не строка или нет
        key_other: { ...base, key: 'fc:B' },
        key_number: { ...base, key: 7 },
        no_key: { ...base, key: undefined },
        no_changed: { ...base, changed: undefined },
        changed_object: { ...base, changed: {} },
        changed_null_item: { ...base, changed: [null] },
        name_number: { ...base, changed: [{ ...base.changed[0], name: 7 }] },
        no_name: { ...base, changed: [{ log: 1, value: 2, step: 2 }] },
        step_string: { ...base, changed: [{ ...base.changed[0], step: '2' }] },
        saved_at_string: { ...base, saved_at: '1000' },
        estimates_array: { ...base, estimates: [] },
        estimates_number: { ...base, estimates: 1 },
        // Оценки шага — объект или null
        estimates2_number: { ...base, estimates: { ...base.estimates, 2: 5 } },
        estimates3_string: { ...base, estimates: { ...base.estimates, 3: 'x' } },
        estimates4_array: { ...base, estimates: { ...base.estimates, 4: [] } },
    }
    for (const [what, record] of Object.entries(broken)) {
        assert.deepEqual(passmem_read(fake_storage({ [PASSMEM_KEY]: text({ c: good, x: record }) })),
            { passes: { c: good }, error: 'corrupt' }, what)
    }
    // Пример из ревью: ключ записи не совпал с ключом в карте
    assert.deepEqual(passmem_read(fake_storage({ [PASSMEM_KEY]: text({ 'fc:A': { key: 'fc:B', changed: [] } }) })),
        { passes: {}, error: 'corrupt' })
    // Оценки шагов null — годна
    const no_estimates = { ...base, estimates: { 2: null, 3: null, 4: null } }
    assert.equal(passmem_read(fake_storage({ [PASSMEM_KEY]: text({ x: no_estimates }) })).error, null)

    // Без saved_at и estimates, с пустым changed — запись годна
    const minimal = { key: 'm', changed: [] }
    assert.deepEqual(passmem_read(fake_storage({ [PASSMEM_KEY]: text({ m: minimal }) })), { passes: { m: minimal }, error: null })
})

test('passmem_write: setItem бросает (квота) или хранилища нет — "unavailable"', () => {
    assert.equal(passmem_write(throwing_storage({ set: true }), {}), 'unavailable')
    assert.equal(passmem_write(null, {}), 'unavailable')
    // Без исключения — null
    assert.equal(passmem_write(throwing_storage(), {}), null)
})

test('passmem_write: ошибка сериализации — ошибка программы, бросает, а не "unavailable"', () => {
    assert.throws(() => passmem_write(fake_storage(), { a: { key: 'a', saved_at: 1n } }), TypeError)
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
    // info нет, имени файла нет — «—»
    assert.equal(passmem_aircraft_key(null, LOG_NAME), 'log:—·—·' + LOG_NAME)
    assert.equal(passmem_aircraft_key({ board: null, frame: 'QUAD/X_REV' }, null), 'log:—·QUAD/X_REV·—')
    assert.equal(passmem_aircraft_key({ board: null }, undefined), 'log:—·—·—')
})

test('passmem_aircraft_key: плата в запасном ключе — номер платы APJ из VER (board_id); при строке контроллера не нужен', () => {
    assert.equal(passmem_aircraft_key({ board: null, board_id: 1503, frame: 'QUAD/X_REV' }, LOG_NAME), 'log:1503·QUAD/X_REV·' + LOG_NAME)
    assert.equal(passmem_aircraft_key({ ...INFO, board_id: 1503 }, LOG_NAME), 'fc:' + BOARD)
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
    // Поле lag30_ms — часть формата: задержка на старшей частоте шагов 2–3
    assert.equal(lowpass_lag_hz(), 30)
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

test('passmem_record: NaN и бесконечность в оценках — null (в JSON они и так станут null: память = хранилище)', () => {
    const steps = fake_steps()
    steps[2].metrics.log.band_dB = NaN
    steps[3].metrics.current.gyro.band_dB = Infinity
    steps[3].metrics.log.lag_ms.pitch.P[30] = -Infinity
    steps[4].axes.roll.metrics.log.pm_deg = NaN
    steps[4].axes.roll.metrics.prediction.overshoot_pct = Infinity
    const pass = fake_pass({ steps: steps })
    assert.equal(pass.estimates[2].log.band_dB, null)
    assert.equal(pass.estimates[3].accepted.gyro_band_dB, null)
    assert.equal(pass.estimates[3].log.lag30_ms.pitch.P, null)
    assert.equal(pass.estimates[4].roll.log.pm_deg, null)
    assert.equal(pass.estimates[4].roll.prediction.overshoot_pct, null)
    assert.deepEqual(JSON.parse(JSON.stringify(pass)), pass)
})

test('passmem_record: info null — подпись null; нет метрик оси шага 4 — null вместо оси', () => {
    const steps = fake_steps()
    delete steps[4].axes.yaw
    const pass = passmem_record({ key: 'k', info: null, file_name: LOG_NAME, rows: [], steps: steps, saved_at: 5 })
    assert.equal(pass.board, null)
    assert.equal(pass.frame, null)
    assert.equal(pass.fw, null)
    assert.equal(pass.estimates[4].yaw, null)
    assert.notEqual(pass.estimates[4].roll, null)
})

test('passmem_record: устаревший шаг — без оценок: прогноз считался не для применяемой конфигурации', () => {
    const pass = fake_pass({ stale: { 2: false, 3: true, 4: false } })
    assert.equal(pass.estimates[3], null)
    assert.notEqual(pass.estimates[2], null)
    assert.notEqual(pass.estimates[4], null)
    // Изменённые пишутся как есть: «применено» на шаге 0 от устаревания не зависит
    assert.deepEqual(pass.changed, fake_pass().changed)
    assert.deepEqual(Object.values(fake_pass({ stale: { 2: true, 3: true, 4: true } }).estimates), [null, null, null])
})

test('passmem_record: значение шага перекрыто другим шагом (расхождение INS_GYRO_FILTER) — оценки этого шага null', () => {
    // Расхождение — как его даёт summary_rows: шаг 2 принял INS_GYRO_FILTER 40, шаг 3 — 42, в файл идёт шаг 3
    const steps = fake_steps()
    steps[2].accepted.INS_GYRO_FILTER = 40
    steps[3].accepted.INS_GYRO_FILTER = 42
    const { conflicts } = summary_rows({ params: fake_params({ INS_GYRO_FILTER: 40 }), steps: steps,
        names: { 2: ['INS_GYRO_FILTER'], 3: ['INS_GYRO_FILTER'], 4: [] }, filter_version: 2, bits: 8 })
    assert.deepEqual(conflicts, [{ name: 'INS_GYRO_FILTER', values: { 2: 40, 3: 42 }, used: 3 }])

    const pass = fake_pass({ steps: steps, conflicts: conflicts })
    assert.equal(pass.estimates[2], null)
    // Шаг 3 дал значение в файл — его оценки остаются
    assert.notEqual(pass.estimates[3], null)
    assert.notEqual(pass.estimates[4], null)
    // Расхождений нет — оценки всех шагов
    assert.notEqual(fake_pass({ steps: steps, conflicts: [] }).estimates[2], null)
})

test('passmem_estimate2/3/4_axis: одна оценка в форме памяти — те же поля, что у оценок прохода', () => {
    const steps = fake_steps()
    const pass = fake_pass({ steps: steps })
    // Запись прохода строится этими же функциями: log и accepted шагов 2–3, оси шага 4
    assert.deepEqual(passmem_estimate2(steps[2].metrics.log), pass.estimates[2].log)
    assert.deepEqual(passmem_estimate2(steps[2].metrics.current), pass.estimates[2].accepted)
    assert.deepEqual(passmem_estimate2(steps[2].metrics.log), { band_dB: -40.25, lag30_ms: 2.71 })
    assert.deepEqual(passmem_estimate3(steps[3].metrics.log), pass.estimates[3].log)
    assert.deepEqual(passmem_estimate3(steps[3].metrics.current), pass.estimates[3].accepted)
    for (const axis of ['roll', 'pitch', 'yaw']) {
        assert.deepEqual(passmem_estimate4_axis(steps[4].axes[axis].metrics), pass.estimates[4][axis], axis)
    }
    // Ось нового лога для строки сравнения — сводка без строки (prediction null)
    assert.deepEqual(passmem_estimate4_axis(step4_eval({ reliable: true, measured: [0.05, 9], log: [54, 12] })),
        { reliable: true, measured: { overshoot_pct: 9, rise_s: 0.05 }, log: { pm_deg: 54, crossover_hz: 12 }, prediction: null })
})

test('passmem_estimate2/3/4_axis: нет оценки или чисел — null на их месте; NaN и бесконечность — null', () => {
    assert.deepEqual(passmem_estimate2(null), { band_dB: null, lag30_ms: null })
    assert.deepEqual(passmem_estimate2({ band_dB: NaN, lag_ms: { 10: 1 } }), { band_dB: null, lag30_ms: null })
    assert.deepEqual(passmem_estimate3(undefined), {
        gyro_band_dB: null, dterm_dB: { roll: null, pitch: null },
        lag30_ms: { roll: { P: null, D: null }, pitch: { P: null, D: null } },
    })
    const e3 = step3_eval(Infinity, { roll: null, pitch: -30 }, { roll: [1, 3, 1.3, -Infinity], pitch: [1, 3.1, 1.3, 4.1] })
    assert.deepEqual(passmem_estimate3(e3), {
        gyro_band_dB: null, dterm_dB: { roll: null, pitch: -30 },
        lag30_ms: { roll: { P: 3, D: null }, pitch: { P: 3.1, D: 4.1 } },
    })
    assert.equal(passmem_estimate4_axis(null), null)
    assert.equal(passmem_estimate4_axis(undefined), null)
    assert.deepEqual(passmem_estimate4_axis(step4_eval({ reliable: false })),
        { reliable: false, measured: null, log: null, prediction: null })
    // Оценка нового лога в этой форме проходит в passmem_compare как now без изменений
    const { pass, applied } = pass_and_applied(APPLIED_LOG)
    const now2 = passmem_estimate2({ band_dB: -42, lag_ms: { 10: 0.9, 30: 2.5 } })
    assert.deepEqual(passmem_compare(pass, applied, 2, now2).now, { band_dB: -42, lag30_ms: 2.5 })
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

test('passmem_put: проход без даты сохранения — самый старый, вытесняется первым', () => {
    let passes = {}
    for (let i = 0; i < PASSMEM_MAX; i++) {
        passes = passmem_put(passes, pass_at('k' + i, 1000 + i))
    }
    const no_date = { ...passes.k5 }
    delete no_date.saved_at
    const next = passmem_put({ ...passes, k5: no_date }, pass_at('new', 5000))
    assert.equal(Object.keys(next).length, PASSMEM_MAX)
    assert.equal('k5' in next, false)
    assert.equal('k0' in next, true)
})

test('passmem_put: аппаратов больше PASSMEM_MAX + 1 — вытесняются несколько самых старых подряд', () => {
    // Память с 23 проходами (например, от версии с другим пределом): после добавления остаются 20 —
    // добавленный и 19 самых новых
    const passes = Object.fromEntries(Array.from({ length: 23 }, (_, i) => ['k' + i, pass_at('k' + i, 1000 + i)]))
    const next = passmem_put(passes, pass_at('new', 5000))
    assert.equal(Object.keys(next).length, PASSMEM_MAX)
    assert.deepEqual(['k0', 'k1', 'k2', 'k3'].filter((key) => key in next), [])
    assert.equal('k4' in next, true)
    assert.equal('new' in next, true)
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
    // Значение лога не float32 (0.135, а «было» — Math.fround(0.135)): сравнение как float32 — тоже «было»
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

// Оценки «в этом логе» для строки сравнения: шаг 2 и надёжная ось шага 4
const NOW2 = { band_dB: -42, lag30_ms: 2.5 }
const NOW4 = { reliable: true, measured: { rise_s: 0.05, overshoot_pct: 9 }, log: { pm_deg: 54, crossover_hz: 12 } }

test('passmem_step_status: шаг (ось) ничего не менял — "none"; параметры шагов 2–n применены не все — "partial"; все — "applied"', () => {
    // Шаг 3 ничего не менял
    const pass = fake_pass({ rows: ROWS.filter((row) => row.step !== 3) })
    const all = passmem_applied(pass, fake_params(APPLIED_LOG), 8)
    assert.equal(passmem_step_status(all, 2), 'applied')
    assert.equal(passmem_step_status(all, 3), 'none')
    assert.equal(passmem_step_status(all, 4), 'applied')
    assert.equal(passmem_step_status(all, 4, 'roll'), 'applied')
    assert.equal(passmem_step_status(all, 4, 'yaw'), 'none')

    // Шаг 2 применён не весь — "partial" и у шага 4: его прогноз считался от notch шага 2; шаг 3 — по-прежнему "none"
    const step2_not = passmem_applied(pass, fake_params({ ...APPLIED_LOG, INS_HNTCH_FREQ: 80 }), 8)
    assert.equal(passmem_step_status(step2_not, 2), 'partial')
    assert.equal(passmem_step_status(step2_not, 3), 'none')
    assert.equal(passmem_step_status(step2_not, 4), 'partial')
    assert.equal(passmem_step_status(step2_not, 4, 'roll'), 'partial')

    // Параметра шага 4 нет в логе — не применён; на шаг 2 и другую ось это не влияет
    const absent = { ...APPLIED_LOG }
    delete absent.ATC_RAT_PIT_D
    const pitch_absent = passmem_applied(pass, fake_params(absent), 8)
    assert.equal(passmem_step_status(pitch_absent, 2), 'applied')
    assert.equal(passmem_step_status(pitch_absent, 4), 'partial')
    assert.equal(passmem_step_status(pitch_absent, 4, 'roll'), 'applied')
    assert.equal(passmem_step_status(pitch_absent, 4, 'pitch'), 'partial')
})

test('passmem_compare: шаги 2–3 — всё применено → ok с was (лог прохода), predicted (принятое) и now', () => {
    const { pass, applied } = pass_and_applied(APPLIED_LOG)
    assert.deepEqual(passmem_compare(pass, applied, 2, NOW2), {
        status: 'ok', was: pass.estimates[2].log, predicted: pass.estimates[2].accepted, now: NOW2,
    })
    assert.deepEqual(passmem_compare(pass, applied, 2, NOW2).was, { band_dB: -40.25, lag30_ms: 2.71 })
    assert.deepEqual(passmem_compare(pass, applied, 2, NOW2).predicted, { band_dB: -42.5, lag30_ms: 2.43 })

    const now3 = { gyro_band_dB: -51, dterm_dB: { roll: -31, pitch: -30 }, lag30_ms: { roll: { P: 3.2, D: 4.1 }, pitch: { P: 3.3, D: 4.2 } } }
    assert.deepEqual(passmem_compare(pass, applied, 3, now3), {
        status: 'ok', was: pass.estimates[3].log, predicted: pass.estimates[3].accepted, now: now3,
    })
})

test('passmem_compare: «применено» накопительно — шаг 2 не применён, шаг 3 применён → шаг 3 partial; не применён шаг 3 — шаг 2 ok', () => {
    // Прогноз шага 3 считался от notch шага 2
    const step2_not = pass_and_applied({ ...APPLIED_LOG, INS_HNTCH_HMNCS: 3 })
    assert.deepEqual(passmem_compare(step2_not.pass, step2_not.applied, 2, NOW2), { status: 'partial' })
    assert.deepEqual(passmem_compare(step2_not.pass, step2_not.applied, 3, {}), { status: 'partial' })

    // Более поздний шаг на ранний не влияет
    const step3_not = pass_and_applied({ ...APPLIED_LOG, ATC_RAT_RLL_FLTD: 20 })
    assert.equal(passmem_compare(step3_not.pass, step3_not.applied, 2, NOW2).status, 'ok')
    assert.deepEqual(passmem_compare(step3_not.pass, step3_not.applied, 3, {}), { status: 'partial' })
})

test('passmem_compare: шаг ничего не менял, оценок шага нет или прохода нет — null', () => {
    // Шаг 3 принят с оценками, но ничего не изменил
    const pass = fake_pass({ rows: ROWS.filter((row) => row.step !== 3) })
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

test('passmem_compare: шаг 4 — ось надёжна, всё применено → ok с измерением и логом оси, прогнозом и now', () => {
    const { pass, applied } = pass_and_applied(APPLIED_LOG)
    assert.deepEqual(passmem_compare(pass, applied, 4, NOW4, 'roll'), {
        status: 'ok',
        was: { measured: { overshoot_pct: 12.5, rise_s: 0.055 }, log: { pm_deg: 48, crossover_hz: 11.2 } },
        predicted: { overshoot_pct: 8.5, rise_s: 0.05, pm_deg: 55, unstable: false },
        now: NOW4,
    })
})

test('passmem_compare: шаг 4 — ось ненадёжна в проходе или сейчас (в том числе надёжность сейчас неизвестна) — unreliable', () => {
    const { pass, applied } = pass_and_applied(APPLIED_LOG)
    // Тангаж ненадёжен в проходе (значение введено вручную), хотя сейчас надёжен
    assert.deepEqual(passmem_compare(pass, applied, 4, NOW4, 'pitch'), { status: 'unreliable' })
    // Крен надёжен в проходе, но ненадёжен сейчас
    assert.deepEqual(passmem_compare(pass, applied, 4, { reliable: false, measured: null, log: null }, 'roll'), { status: 'unreliable' })
    // Надёжность сейчас неизвестна (нет расчёта, нет поля) — тоже сравнивать нечем
    assert.deepEqual(passmem_compare(pass, applied, 4, null, 'roll'), { status: 'unreliable' })
    assert.deepEqual(passmem_compare(pass, applied, 4, { measured: null, log: null }, 'roll'), { status: 'unreliable' })
})

test('passmem_compare: шаг 4 — «применено» по шагам 2–3 и параметрам оси; изменения другой оси не влияют', () => {
    // Тангаж не применён — крен всё равно ok, тангаж partial
    const pitch_not = pass_and_applied({ ...APPLIED_LOG, ATC_RAT_PIT_D: Math.fround(0.0036) })
    assert.equal(passmem_compare(pitch_not.pass, pitch_not.applied, 4, NOW4, 'roll').status, 'ok')
    assert.deepEqual(passmem_compare(pitch_not.pass, pitch_not.applied, 4, NOW4, 'pitch'), { status: 'partial' })
    // Шаг 4 в целом применён не весь
    assert.equal(passmem_step_status(pitch_not.applied, 4), 'partial')

    // Не применён ATC_RAT_RLL_FLTD (шаг 3): прогноз шага 4 считался от фильтров шага 3 — крен partial
    const fltd_not = pass_and_applied({ ...APPLIED_LOG, ATC_RAT_RLL_FLTD: 20 })
    assert.deepEqual(passmem_compare(fltd_not.pass, fltd_not.applied, 4, NOW4, 'roll'), { status: 'partial' })
    // Не применён шаг 2 — тоже
    const step2_not = pass_and_applied({ ...APPLIED_LOG, INS_HNTCH_FREQ: 80 })
    assert.deepEqual(passmem_compare(step2_not.pass, step2_not.applied, 4, NOW4, 'roll'), { status: 'partial' })

    // Крен не применён — partial, даже если ось надёжна
    const roll_not = pass_and_applied({ ...APPLIED_LOG, ATC_RAT_RLL_P: Math.fround(0.135) })
    assert.deepEqual(passmem_compare(roll_not.pass, roll_not.applied, 4, NOW4, 'roll'), { status: 'partial' })

    // Рыскание шаг 4 не менял — строки нет, хотя ось надёжна, оценки есть, а шаг 3 не применён
    assert.equal(passmem_compare(fltd_not.pass, fltd_not.applied, 4, NOW4, 'yaw'), null)
})

test('passmem_compare: шаг 4 — строки шагов 2–3 с префиксом другой оси на ось не влияют, без префикса оси — влияют', () => {
    // Шаг 3 менял ещё FLTD тангажа, FLTE рыскания и INS_GYRO_FILTER
    const rows = [...ROWS,
        { name: 'ATC_RAT_PIT_FLTD', log: 20, value: 25, step: 3, changed: true, note: null },
        { name: 'ATC_RAT_YAW_FLTE', log: 2.5, value: 2, step: 3, changed: true, note: null },
        { name: 'INS_GYRO_FILTER', log: 40, value: 42, step: 3, changed: true, note: null }]
    const pass = fake_pass({ rows: rows })
    const log = { ...APPLIED_LOG, ATC_RAT_PIT_FLTD: 25, ATC_RAT_YAW_FLTE: 2, INS_GYRO_FILTER: 42 }
    const applied_with = (changes) => passmem_applied(pass, fake_params({ ...log, ...changes }), 8)

    // Не применён ATC_RAT_PIT_FLTD — крен ok, тангаж partial; шаг 3 и шаг 4 целиком — partial
    const pit_fltd = applied_with({ ATC_RAT_PIT_FLTD: 20 })
    assert.equal(passmem_compare(pass, pit_fltd, 4, NOW4, 'roll').status, 'ok')
    assert.deepEqual(passmem_compare(pass, pit_fltd, 4, NOW4, 'pitch'), { status: 'partial' })
    assert.equal(passmem_step_status(pit_fltd, 4, 'roll'), 'applied')
    assert.equal(passmem_step_status(pit_fltd, 4, 'pitch'), 'partial')
    assert.equal(passmem_step_status(pit_fltd, 3), 'partial')
    assert.equal(passmem_step_status(pit_fltd, 4), 'partial')

    // Не применён ATC_RAT_YAW_FLTE — крен ok
    assert.equal(passmem_compare(pass, applied_with({ ATC_RAT_YAW_FLTE: 2.5 }), 4, NOW4, 'roll').status, 'ok')

    // Не применён INS_GYRO_FILTER (без префикса оси) — крен partial
    assert.deepEqual(passmem_compare(pass, applied_with({ INS_GYRO_FILTER: 40 }), 4, NOW4, 'roll'), { status: 'partial' })

    // Всё применено — крен ok
    assert.equal(passmem_compare(pass, applied_with({}), 4, NOW4, 'roll').status, 'ok')
})

test('passmem_compare: шаг 4 — нет записи оси в оценках или ось не передана — null', () => {
    const { pass, applied } = pass_and_applied(APPLIED_LOG)
    assert.equal(passmem_compare(pass, applied, 4, NOW4), null)
    pass.estimates[4].roll = null
    assert.equal(passmem_compare(pass, applied, 4, NOW4, 'roll'), null)
})

// Проход формата v1, записанный руками (не через passmem_record): страховка совместимости — сохранённая в браузере
// память должна читаться и после правок кода, пока PASSMEM_VERSION не сменилась
const V1_TEXT = '{"version":1,"passes":{"fc:StellarH7V2 0034002E 35335104 39363630":{' +
    '"key":"fc:StellarH7V2 0034002E 35335104 39363630","board":"StellarH7V2 0034002E 35335104 39363630",' +
    '"frame":"QUAD/X_REV","fw":"ArduCopter V4.6.3 (3fc7011a)","file_name":"2026-06-18 18-54-42_anon.bin",' +
    '"saved_at":1761400000000,' +
    '"changed":[{"name":"INS_HNTCH_FREQ","log":80,"value":75,"step":2},' +
    '{"name":"INS_HNTCH_HMNCS","log":3,"value":128,"step":2},' +
    '{"name":"ATC_RAT_RLL_P","log":0.135,"value":0.7,"step":4}],' +
    '"estimates":{' +
    '"2":{"log":{"band_dB":-40.25,"lag30_ms":2.71},"accepted":{"band_dB":-42.5,"lag30_ms":2.43}},' +
    '"3":null,' +
    '"4":{"roll":{"reliable":true,"measured":{"overshoot_pct":12.5,"rise_s":0.055},"log":{"pm_deg":48,"crossover_hz":11.2},' +
    '"prediction":{"overshoot_pct":8.5,"rise_s":0.05,"pm_deg":55,"unstable":false}},' +
    '"pitch":{"reliable":false,"measured":null,"log":null,"prediction":null},"yaw":null}}}}}'

test('совместимость: записанная руками JSON-строка v1 → passmem_read → passmem_applied → passmem_compare', () => {
    const { passes, error } = passmem_read(fake_storage({ [PASSMEM_KEY]: V1_TEXT }))
    assert.equal(error, null)
    const pass = passes[passmem_aircraft_key(INFO, 'другой лог.bin')]
    assert.equal(pass.file_name, LOG_NAME)
    assert.deepEqual(passmem_list(passes).map((p) => p.key), ['fc:' + BOARD])

    // Новый лог: всё применено (float32 и маска со знаком)
    const applied = passmem_applied(pass, fake_params({ INS_HNTCH_FREQ: 75, INS_HNTCH_HMNCS: -128, ATC_RAT_RLL_P: 0.699999988 }), 8)
    assert.deepEqual([applied.applied, applied.total, applied.same_log], [3, 3, false])
    assert.deepEqual(passmem_compare(pass, applied, 2, NOW2),
        { status: 'ok', was: { band_dB: -40.25, lag30_ms: 2.71 }, predicted: { band_dB: -42.5, lag30_ms: 2.43 }, now: NOW2 })
    assert.equal(passmem_compare(pass, applied, 3, {}), null)
    assert.deepEqual(passmem_compare(pass, applied, 4, NOW4, 'roll'), {
        status: 'ok',
        was: { measured: { overshoot_pct: 12.5, rise_s: 0.055 }, log: { pm_deg: 48, crossover_hz: 11.2 } },
        predicted: { overshoot_pct: 8.5, rise_s: 0.05, pm_deg: 55, unstable: false },
        now: NOW4,
    })
    assert.equal(passmem_compare(pass, applied, 4, NOW4, 'pitch'), null)
    assert.equal(passmem_compare(pass, applied, 4, NOW4, 'yaw'), null)

    // Тот же лог, что в проходе — «лог прошлого прохода»
    assert.equal(passmem_applied(pass, fake_params({ INS_HNTCH_FREQ: 80, INS_HNTCH_HMNCS: 3, ATC_RAT_RLL_P: 0.135 }), 8).same_log, true)
})
