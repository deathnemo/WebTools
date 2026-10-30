// Тесты подготовки к следующему полёту (TuneWizard/core/prep.js): константы против core/checks.js и core/pidtune.js,
// цели, правила prep_check — ok / warn / fail на своей цели и отсутствие на чужой, нет параметра — warn; источник записи
// гироскопа после исправления (batch из файла, raw важнее batch, до и после фильтров, буфер), обороты для notch,
// положения переключателя (предложение ACRO, выбор положения и пересчёт выхода), обучение газа висения, значения файла
// исправлений (сложение масок, равные текущему не пишутся, текст .param), перезагрузка, план полёта, имя файла;
// параметры — и из parse_param_file (обёртка get), и из log_params (core/log.js).
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

// Нужное ядру подготовки в порядке страницы: param_to_string и get_param_download_text (Param_Helpers.js), log_params
// (log.js), check_rules (checks.js), notch_param_names (filters.js), pidtune_rules и pidtune_mode_names (pidtune.js; ему —
// константы pid.js), param_file_text и parse_param_file (params.js), summary_period и summary_lower_first (summary.js)
load_page_scripts([
    'Libraries/Param_Helpers.js',
    'TuneWizard/core/log.js',
    'TuneWizard/core/checks.js',
    'TuneWizard/core/filters.js',
    'TuneWizard/core/pid.js',
    'TuneWizard/core/pidtune.js',
    'TuneWizard/core/params.js',
    'TuneWizard/core/summary.js',
    'TuneWizard/core/prep.js',
])

// ---------------------------------------------------------------- поддельные данные

// Параметры с интерфейсом log_params: get(name) — значение или null, has(name)
function fake_params(values) {
    return {
        get: (name) => (name in values) ? values[name] : null,
        has: (name) => name in values,
    }
}

// Параметры, при которых все правила — ok: файл на карту, PID и ATTITUDE_FAST в LOG_BITMASK (145401 — биты 0, 3–10,
// 12, 13, 17), raw основного гироскопа до и после фильтров с буфером 64 КиБ, notch по ESC с двунаправленным DShot,
// ACRO в положении 6, выход — STABILIZE и ALT_HOLD, Rate Loop Only, тренер выключен, обучение газа висения
const GOOD = {
    LOG_BACKEND_TYPE: 1, LOG_BITMASK: 145401, LOG_FILE_BUFSIZE: 64,
    INS_RAW_LOG_OPT: 9, INS_LOG_BAT_MASK: 0, INS_LOG_BAT_OPT: 0,
    INS_HNTCH_ENABLE: 1, INS_HNTCH_MODE: 3, INS_HNTC2_ENABLE: 0, SERVO_BLH_BDMASK: 15,
    FLTMODE1: 0, FLTMODE2: 0, FLTMODE3: 2, FLTMODE4: 2, FLTMODE5: 5, FLTMODE6: 1,
    ACRO_OPTIONS: 2, ACRO_TRAINER: 0, FSTRATE_ENABLE: 0, MOT_HOVER_LEARN: 2,
}

// GOOD с изменениями: значение undefined — параметра нет
function with_values(changes, base = GOOD) {
    const values = { ...base }
    for (const [name, value] of Object.entries(changes)) {
        if (value === undefined) {
            delete values[name]
        } else {
            values[name] = value
        }
    }
    return values
}

// Как синтетическая фикстура задачи 4: ACRO нет (1–3 STABILIZE, 4–6 ALT_HOLD), тренер заводской, записи гироскопа нет,
// LOG_BITMASK без PID и ATTITUDE_FAST (176126 — заводская маска Copter без бита 0), буфер 8 КиБ
const NO_ACRO = {
    FLTMODE1: 0, FLTMODE2: 0, FLTMODE3: 0, FLTMODE4: 2, FLTMODE5: 2, FLTMODE6: 2,
    ACRO_OPTIONS: 0, ACRO_TRAINER: 2, INS_RAW_LOG_OPT: 0, INS_LOG_BAT_MASK: 0, INS_LOG_BAT_OPT: 0,
    LOG_BITMASK: 176126, LOG_BACKEND_TYPE: 1, LOG_FILE_BUFSIZE: 8,
    INS_HNTCH_ENABLE: 1, INS_HNTCH_MODE: 3, SERVO_BLH_BDMASK: 15, FSTRATE_ENABLE: 0, MOT_HOVER_LEARN: 2,
}

const ALL_IDS = ['log_backend', 'log_pid', 'log_fast', 'gyro_data', 'gyro_prepost', 'log_buffer', 'notch_source',
    'acro_slot', 'acro_exit', 'acro_rate_only', 'acro_trainer', 'fstrate', 'hover_learn']
const FILTER_IDS = ['log_backend', 'gyro_data', 'gyro_prepost', 'log_buffer', 'notch_source', 'hover_learn']
const PID_IDS = ['log_backend', 'log_pid', 'log_fast', 'acro_slot', 'acro_exit', 'acro_rate_only', 'acro_trainer', 'fstrate']

function check(values, goal = 'both', ctx = {}) {
    return prep_check(fake_params(values), goal, ctx)
}

function item_of(items, id) {
    return items.find((item) => item.id === id)
}

// ---------------------------------------------------------------- константы и цели

test('константы: биты LOG_BITMASK — как check_rules шага 0, ACRO и Rate Loop Only — из pidtune_rules', () => {
    assert.equal(prep_rules.log_bitmask_pid, check_rules.log_bitmask_pid)
    assert.equal(prep_rules.log_bitmask_imu_raw, check_rules.log_bitmask_imu_raw)
    assert.equal(prep_rules.log_bitmask_attitude_fast, check_rules.log_bitmask_attitude_fast)
    assert.equal(prep_rules.acro_mode, pidtune_rules.acro_mode)
    assert.equal(prep_rules.acro_rate_only_bit, pidtune_rules.acro_rate_only_bit)
    assert.equal(pidtune_mode_names[prep_rules.acro_mode], 'ACRO')
    assert.equal(prep_rules.acro_rate_only_bit, 2)
    assert.deepEqual(prep_rules.level_modes.map((m) => pidtune_mode_names[m]), ['STABILIZE', 'ALT_HOLD', 'LOITER', 'POSHOLD'])
    assert.equal(prep_rules.hover_min_s, check_rules.hover_min_s)
    assert.equal(prep_rules.hover_learn_s, check_rules.hover_learn_s)
    assert.equal(prep_rules.acro_data_s, pidtune_rules.min_data_s)
    assert.equal(prep_rules.acro_target_dps, pidtune_rules.target_min_dps)
    // Порядок целей правил — порядок таблицы дизайна
    assert.deepEqual(Object.keys(prep_rules.check_goals), ALL_IDS)
})

test('prep_goals: подписи и части целей; неизвестная цель — ошибка', () => {
    assert.equal(prep_goals.filters.title, 'Фильтры')
    assert.equal(prep_goals.pid.title, 'PID')
    assert.equal(prep_goals.both.title, 'Фильтры и PID')
    assert.deepEqual(prep_goal_parts('both'), ['filters', 'pid'])
    assert.throws(() => prep_goal_parts('acro'), /Неизвестная цель/)
    assert.throws(() => prep_check(fake_params(GOOD), 'toString', {}), /Неизвестная цель/)
    assert.throws(() => prep_flight_plan(undefined, {}), /Неизвестная цель/)
})

// ---------------------------------------------------------------- prep_check: правила по целям

test('prep_check: всё ok, порядок таблицы; по цели — только её правила', () => {
    const both = check(GOOD, 'both')
    assert.deepEqual(both.map((i) => i.id), ALL_IDS)
    for (const item of both) {
        assert.equal(item.status, 'ok', item.id + ': ' + item.text)
        assert.equal(item.fix, null)
        assert.deepEqual(item.changes, [])
    }
    assert.deepEqual(check(GOOD, 'filters').map((i) => i.id), FILTER_IDS)
    assert.deepEqual(check(GOOD, 'pid').map((i) => i.id), PID_IDS)
    // Без ctx — то же
    assert.deepEqual(prep_check(fake_params(GOOD), 'both').map((i) => i.status), both.map((i) => i.status))
})

// Для каждого правила: изменения GOOD, статус на своей цели (и в «both»); на чужой цели пункта нет
const RULE_CASES = [
    { id: 'log_backend', values: { LOG_BACKEND_TYPE: 4 }, status: 'fail', goals: ['filters', 'pid'] },
    { id: 'log_pid', values: { LOG_BITMASK: 145401 & ~(1 << 12) }, status: 'fail', goals: ['pid'] },
    { id: 'log_fast', values: { LOG_BITMASK: 145400 }, status: 'fail', goals: ['pid'] },
    { id: 'gyro_data', values: { INS_RAW_LOG_OPT: 0 }, status: 'fail', goals: ['filters'] },
    { id: 'gyro_prepost', values: { INS_RAW_LOG_OPT: 5 }, status: 'warn', goals: ['filters'] },
    { id: 'log_buffer', values: { LOG_FILE_BUFSIZE: 8 }, status: 'warn', goals: ['filters'] },
    { id: 'notch_source', values: { SERVO_BLH_BDMASK: 0 }, status: 'warn', goals: ['filters'] },
    { id: 'acro_slot', values: { FLTMODE6: 2 }, status: 'fail', goals: ['pid'] },
    { id: 'acro_exit', values: { FLTMODE1: 3, FLTMODE2: 3, FLTMODE3: 4, FLTMODE4: 6, FLTMODE5: 9 }, status: 'fail', goals: ['pid'] },
    { id: 'acro_rate_only', values: { ACRO_OPTIONS: 1 }, status: 'fail', goals: ['pid'] },
    { id: 'acro_trainer', values: { ACRO_TRAINER: 2 }, status: 'fail', goals: ['pid'] },
    { id: 'fstrate', values: { FSTRATE_ENABLE: 1 }, status: 'warn', goals: ['pid'] },
    { id: 'hover_learn', values: { MOT_HOVER_LEARN: 0 }, ctx: { hover_check: { id: 'hover_throttle', status: 'warn' } }, status: 'warn', goals: ['filters'] },
]

test('prep_check: каждое правило — свой статус на своей цели, на чужой пункта нет', () => {
    assert.deepEqual(RULE_CASES.map((c) => c.id), ALL_IDS)
    for (const c of RULE_CASES) {
        const values = with_values(c.values)
        for (const goal of ['filters', 'pid', 'both']) {
            const items = check(values, goal, c.ctx ?? {})
            const item = item_of(items, c.id)
            const own = prep_goals[goal].goals.some((part) => c.goals.includes(part))
            if (!own) {
                assert.equal(item, undefined, c.id + ' на цели ' + goal)
                continue
            }
            assert.equal(item.status, c.status, c.id + ' на цели ' + goal + ': ' + item.text)
            assert.ok(item.fix != null && item.fix !== '', c.id + ': у ' + c.status + ' есть «что сделать»')
            // Остальные правила цели не тронуты
            for (const other of items.filter((i) => i.id !== c.id)) {
                assert.equal(other.status, 'ok', c.id + ' задел ' + other.id + ': ' + other.text)
            }
        }
    }
})

test('prep_check: тексты называют параметр и значение, fix — что сделать', () => {
    const fast = item_of(check(with_values({ LOG_BITMASK: 145400 })), 'log_fast')
    assert.match(fast.text, /^LOG_BITMASK = 145400: бит 0 \(ATTITUDE_FAST\) выключен/)
    assert.match(fast.fix, /Включите бит ATTITUDE_FAST \(0\) в LOG_BITMASK/)
    assert.equal(item_of(check(GOOD), 'log_pid').text, 'LOG_BITMASK = 145401: бит 12 (PID) включён — PIDR/PIDP/PIDY будут в логе')
    assert.deepEqual(item_of(check(with_values({ LOG_BACKEND_TYPE: 4 })), 'log_backend').changes,
        [{ name: 'LOG_BACKEND_TYPE', set: 1, clear: 0 }])
    assert.deepEqual(item_of(check(with_values({ ACRO_OPTIONS: 1 })), 'acro_rate_only').changes,
        [{ name: 'ACRO_OPTIONS', set: 2, clear: 0 }])
    assert.deepEqual(item_of(check(with_values({ ACRO_TRAINER: 2 })), 'acro_trainer').changes, [{ name: 'ACRO_TRAINER', value: 0 }])
    // fstrate и notch_source — без записи в файл
    assert.deepEqual(item_of(check(with_values({ FSTRATE_ENABLE: 1 })), 'fstrate').changes, [])
    assert.deepEqual(item_of(check(with_values({ SERVO_BLH_BDMASK: 0 })), 'notch_source').changes, [])
})

// Нет параметра, нужного правилу, — warn «параметра X нет — проверьте версию прошивки», changes []
const MISSING_CASES = [
    { id: 'log_backend', values: { LOG_BACKEND_TYPE: undefined }, names: ['LOG_BACKEND_TYPE'] },
    { id: 'log_pid', values: { LOG_BITMASK: undefined }, names: ['LOG_BITMASK'] },
    { id: 'log_fast', values: { LOG_BITMASK: undefined }, names: ['LOG_BITMASK'] },
    { id: 'gyro_data', values: { INS_RAW_LOG_OPT: 0, INS_LOG_BAT_MASK: undefined }, names: ['INS_LOG_BAT_MASK'] },
    // Raw по биту IMU_RAW (19), а INS_RAW_LOG_OPT нет — до/после фильтров не определить
    { id: 'gyro_prepost', values: { INS_RAW_LOG_OPT: undefined, LOG_BITMASK: 145401 | (1 << 19) }, names: ['INS_RAW_LOG_OPT'] },
    { id: 'gyro_prepost', values: { INS_RAW_LOG_OPT: 0, INS_LOG_BAT_MASK: 1, INS_LOG_BAT_OPT: undefined }, names: ['INS_LOG_BAT_OPT'] },
    { id: 'log_buffer', values: { LOG_FILE_BUFSIZE: undefined }, names: ['LOG_FILE_BUFSIZE'] },
    { id: 'notch_source', values: { INS_HNTCH_ENABLE: undefined }, names: ['INS_HNTCH_ENABLE'] },
    { id: 'notch_source', values: { INS_HNTCH_MODE: undefined }, names: ['INS_HNTCH_MODE'] },
    { id: 'acro_slot', values: { FLTMODE6: 2, FLTMODE3: undefined }, names: ['FLTMODE3'] },
    { id: 'acro_exit', values: { FLTMODE1: undefined, FLTMODE2: 3, FLTMODE3: 3, FLTMODE4: 3, FLTMODE5: 3 }, names: ['FLTMODE1'] },
    { id: 'acro_rate_only', values: { ACRO_OPTIONS: undefined }, names: ['ACRO_OPTIONS'] },
    { id: 'acro_trainer', values: { ACRO_TRAINER: undefined }, names: ['ACRO_TRAINER'] },
    { id: 'hover_learn', values: { MOT_HOVER_LEARN: undefined }, names: ['MOT_HOVER_LEARN'] },
]

test('prep_check: нет параметра — warn «параметра X нет — проверьте версию прошивки», без changes', () => {
    for (const c of MISSING_CASES) {
        const item = item_of(check(with_values(c.values)), c.id)
        assert.equal(item.status, 'warn', c.id + ': ' + item.text)
        assert.equal(item.text, prep_missing_text(c.names))
        assert.deepEqual(item.changes, [])
    }
    assert.equal(prep_missing_text(['FLTMODE3']), 'Параметра FLTMODE3 нет — проверьте версию прошивки')
    assert.equal(prep_missing_text(['FLTMODE1', 'FLTMODE2']), 'Параметров FLTMODE1, FLTMODE2 нет — проверьте версию прошивки')
    // ACRO найден среди имеющихся положений — ok, хотя FLTMODE1 нет
    assert.equal(item_of(check(with_values({ FLTMODE1: undefined })), 'acro_slot').status, 'ok')
    // FSTRATE_ENABLE нет — прошивка без быстрого потока: ok, а не предупреждение о версии
    const fstrate = item_of(check(with_values({ FSTRATE_ENABLE: undefined })), 'fstrate')
    assert.equal(fstrate.status, 'ok')
    assert.match(fstrate.text, /FSTRATE_ENABLE нет/)
})

// ---------------------------------------------------------------- запись гироскопа

test('gyro_data: нет записи — fail и batch в файл; gyro_prepost ok, log_buffer не применяется', () => {
    const items = check(with_values({ INS_RAW_LOG_OPT: 0, INS_LOG_BAT_MASK: 0, LOG_FILE_BUFSIZE: 8 }), 'filters')
    const data = item_of(items, 'gyro_data')
    assert.equal(data.status, 'fail')
    assert.deepEqual(data.changes, [{ name: 'INS_LOG_BAT_MASK', value: 1 }, { name: 'INS_LOG_BAT_OPT', value: 4 }])
    assert.match(data.fix, /INS_LOG_BAT_MASK = 1, INS_LOG_BAT_OPT = 4/)
    assert.match(data.fix, /H7.*INS_RAW_LOG_OPT = 9/)
    const prepost = item_of(items, 'gyro_prepost')
    assert.equal(prepost.status, 'ok')
    assert.deepEqual(prepost.changes, [])
    assert.equal(item_of(items, 'log_buffer'), undefined)
    // Batch есть — log_buffer тоже не применяется
    assert.equal(item_of(check(with_values({ INS_RAW_LOG_OPT: 0, INS_LOG_BAT_MASK: 1, INS_LOG_BAT_OPT: 4, LOG_FILE_BUFSIZE: 8 })), 'log_buffer'), undefined)
    // Нет параметров для вывода (gyro_data — warn) — пунктов до/после и буфера нет
    const unknown = check(with_values({ INS_RAW_LOG_OPT: 0, INS_LOG_BAT_MASK: undefined }), 'filters')
    assert.equal(item_of(unknown, 'gyro_prepost'), undefined)
    assert.equal(item_of(unknown, 'log_buffer'), undefined)
    // Значения файла: batch из правила
    assert.deepEqual(prep_changes(fake_params(with_values({ INS_RAW_LOG_OPT: 0 })), items), { INS_LOG_BAT_MASK: 1, INS_LOG_BAT_OPT: 4 })
})

test('gyro_data: raw — по битам 0 и 1 INS_RAW_LOG_OPT или биту IMU_RAW; raw и batch вместе — оценивается raw', () => {
    for (const values of [{ INS_RAW_LOG_OPT: 9 }, { INS_RAW_LOG_OPT: 10 }, { INS_RAW_LOG_OPT: 8, LOG_BITMASK: 145401 | (1 << 19) }]) {
        const items = check(with_values(values), 'filters')
        assert.equal(item_of(items, 'gyro_data').status, 'ok')
        assert.match(item_of(items, 'gyro_data').text, /^Raw \(GYR\)/)
        assert.notEqual(item_of(items, 'log_buffer'), undefined, 'при raw буфер проверяется')
    }
    // Биты 2 и 3 без бита 0 или 1 raw не включают
    assert.equal(item_of(check(with_values({ INS_RAW_LOG_OPT: 8 })), 'gyro_data').status, 'fail')
    // Raw и batch: batch только после фильтров, raw до и после — пункт до/после по raw, ok; буфер — по raw
    const both = check(with_values({ INS_RAW_LOG_OPT: 9, INS_LOG_BAT_MASK: 1, INS_LOG_BAT_OPT: 2, LOG_FILE_BUFSIZE: 8 }), 'filters')
    assert.match(item_of(both, 'gyro_data').text, /batch гироскопа не пишется/)
    assert.equal(item_of(both, 'gyro_prepost').status, 'ok')
    assert.match(item_of(both, 'gyro_prepost').text, /INS_RAW_LOG_OPT = 9/)
    assert.equal(item_of(both, 'log_buffer').status, 'warn')
})

test('gyro_prepost: raw и batch — только после или только до фильтров → warn и исправление маски', () => {
    const cases = [
        // raw только после фильтров (биты 0 и 2): (opt | 8) & ~4
        { values: { INS_RAW_LOG_OPT: 5 }, name: 'INS_RAW_LOG_OPT', expect: 9, text: /только после фильтров/ },
        // raw только до фильтров (бит 0)
        { values: { INS_RAW_LOG_OPT: 1 }, name: 'INS_RAW_LOG_OPT', expect: 9, text: /только до фильтров/ },
        // raw всех гироскопов только после фильтров (биты 1 и 2)
        { values: { INS_RAW_LOG_OPT: 6 }, name: 'INS_RAW_LOG_OPT', expect: 10, text: /только после фильтров/ },
        // batch только после фильтров (бит 1): (opt | 4) & ~2; бит 0 (Sensor-Rate) сохраняется
        { values: { INS_RAW_LOG_OPT: 0, INS_LOG_BAT_MASK: 1, INS_LOG_BAT_OPT: 2 }, name: 'INS_LOG_BAT_OPT', expect: 4, text: /только после фильтров/ },
        { values: { INS_RAW_LOG_OPT: 0, INS_LOG_BAT_MASK: 1, INS_LOG_BAT_OPT: 3 }, name: 'INS_LOG_BAT_OPT', expect: 5, text: /только после фильтров/ },
        // batch только до фильтров
        { values: { INS_RAW_LOG_OPT: 0, INS_LOG_BAT_MASK: 1, INS_LOG_BAT_OPT: 0 }, name: 'INS_LOG_BAT_OPT', expect: 4, text: /только до фильтров/ },
    ]
    for (const c of cases) {
        const values = with_values(c.values)
        const items = check(values, 'filters')
        const item = item_of(items, 'gyro_prepost')
        assert.equal(item.status, 'warn', JSON.stringify(c.values))
        assert.match(item.text, c.text)
        assert.deepEqual(prep_changes(fake_params(values), [item]), { [c.name]: c.expect })
    }
    // batch до и после — ok
    assert.equal(item_of(check(with_values({ INS_RAW_LOG_OPT: 0, INS_LOG_BAT_MASK: 1, INS_LOG_BAT_OPT: 4 })), 'gyro_prepost').status, 'ok')
})

test('log_buffer: raw и буфер 8 КиБ — warn, в файл 64; 50 и больше — ok', () => {
    const values = with_values({ LOG_FILE_BUFSIZE: 8 })
    const item = item_of(check(values, 'filters'), 'log_buffer')
    assert.equal(item.status, 'warn')
    assert.match(item.text, /^LOG_FILE_BUFSIZE = 8 КиБ/)
    assert.deepEqual(item.changes, [{ name: 'LOG_FILE_BUFSIZE', value: 64 }])
    assert.deepEqual(prep_changes(fake_params(values), [item]), { LOG_FILE_BUFSIZE: 64 })
    assert.equal(item_of(check(with_values({ LOG_FILE_BUFSIZE: 49 })), 'log_buffer').status, 'warn')
    assert.equal(item_of(check(with_values({ LOG_FILE_BUFSIZE: 50 })), 'log_buffer').status, 'ok')
})

// ---------------------------------------------------------------- обороты для notch

test('notch_source: ESC без SERVO_BLH_BDMASK и без SERIALn_PROTOCOL = 16 — warn; с любым из них — ok; notch выключен — ok', () => {
    const esc = { INS_HNTCH_ENABLE: 1, INS_HNTCH_MODE: 3 }
    const status = (values) => item_of(check(with_values({ ...esc, ...values }), 'filters'), 'notch_source').status
    assert.equal(status({ SERVO_BLH_BDMASK: undefined }), 'warn')
    assert.equal(status({ SERVO_BLH_BDMASK: 0 }), 'warn')
    assert.equal(status({ SERVO_BLH_BDMASK: 0, SERIAL4_PROTOCOL: 2 }), 'warn')
    assert.equal(status({ SERVO_BLH_BDMASK: 15 }), 'ok')
    assert.equal(status({ SERVO_BLH_BDMASK: undefined, SERIAL4_PROTOCOL: 16 }), 'ok')
    assert.equal(status({ SERVO_BLH_BDMASK: 0, SERIAL9_PROTOCOL: 16 }), 'ok')
    assert.match(item_of(check(with_values({ ...esc, SERVO_BLH_BDMASK: 0, SERIAL4_PROTOCOL: 16 })), 'notch_source').text, /SERIAL4_PROTOCOL = 16/)
    // Notch выключен (поля скрыты прошивкой) или не по ESC — ok
    assert.equal(status({ INS_HNTCH_ENABLE: 0, INS_HNTCH_MODE: undefined, SERVO_BLH_BDMASK: 0 }), 'ok')
    assert.equal(status({ INS_HNTCH_MODE: 1, SERVO_BLH_BDMASK: 0 }), 'ok')
    // Второй notch по ESC при выключенном первом — тоже нужен источник оборотов; INS_HNTC2_ENABLE нет — выключен
    assert.equal(status({ INS_HNTCH_ENABLE: 0, INS_HNTC2_ENABLE: 1, INS_HNTC2_MODE: 3, SERVO_BLH_BDMASK: 0 }), 'warn')
    assert.equal(status({ INS_HNTCH_MODE: 1, INS_HNTC2_ENABLE: undefined, SERVO_BLH_BDMASK: 0 }), 'ok')
})

// ---------------------------------------------------------------- положения переключателя и ACRO

test('prep_mode_slots: имена, режимы, диапазоны PWM; нет параметра — null; acro_slot — режим заменён на ACRO', () => {
    const slots = prep_mode_slots(fake_params(with_values({ FLTMODE2: 99, FLTMODE3: undefined })))
    assert.deepEqual(slots.map((s) => s.name), ['FLTMODE1', 'FLTMODE2', 'FLTMODE3', 'FLTMODE4', 'FLTMODE5', 'FLTMODE6'])
    assert.deepEqual(slots.map((s) => s.slot), [1, 2, 3, 4, 5, 6])
    assert.deepEqual(slots.map((s) => s.pwm), ['до 1230', '1231–1360', '1361–1490', '1491–1620', '1621–1749', 'от 1750'])
    assert.deepEqual(slots.map((s) => s.mode), [0, 99, null, 2, 5, 1])
    assert.deepEqual(slots.map((s) => s.mode_name), ['STABILIZE', 'режим 99', null, 'ALT_HOLD', 'LOITER', 'ACRO'])
    const after = prep_mode_slots(fake_params(NO_ACRO), 6)
    assert.equal(after[5].mode, 1)
    assert.equal(after[5].mode_name, 'ACRO')
    assert.equal(prep_mode_slots(fake_params(NO_ACRO), '6')[5].mode, 1)
    assert.equal(prep_mode_slots(fake_params(NO_ACRO), 7)[5].mode, 2)
})

test('prep_acro_suggestion: нет ACRO — 6; единственный выход в FLTMODE6 — нет предложения; ACRO есть — нет', () => {
    assert.equal(prep_acro_suggestion(fake_params(NO_ACRO)), 6)
    const only_exit6 = { ...NO_ACRO, FLTMODE1: 3, FLTMODE2: 3, FLTMODE3: 4, FLTMODE4: 6, FLTMODE5: 9, FLTMODE6: 0 }
    assert.equal(prep_acro_suggestion(fake_params(only_exit6)), null)
    assert.equal(prep_acro_suggestion(fake_params(GOOD)), null)
    assert.equal(prep_acro_suggestion(fake_params({ ...NO_ACRO, FLTMODE3: 1 })), null)
    assert.equal(prep_acro_suggestion(fake_params(with_values({ FLTMODE6: undefined }, NO_ACRO))), null)
})

test('acro_slot и acro_exit: без выбора — fail без changes; выбор положения — FLTMODE<n> = 1 и пересчёт выхода', () => {
    const params = fake_params(NO_ACRO)
    const none = prep_check(params, 'pid', { acro_slot: null })
    assert.equal(item_of(none, 'acro_slot').status, 'fail')
    assert.deepEqual(item_of(none, 'acro_slot').changes, [])
    assert.match(item_of(none, 'acro_slot').fix, /^Выберите положение для ACRO в таблице положений/)
    assert.equal(item_of(none, 'acro_exit').status, 'ok')

    const six = prep_check(params, 'pid', { acro_slot: 6 })
    assert.equal(item_of(six, 'acro_slot').status, 'fail')
    assert.deepEqual(item_of(six, 'acro_slot').changes, [{ name: 'FLTMODE6', value: 1 }])
    assert.match(item_of(six, 'acro_slot').fix, /FLTMODE6 = 1/)
    const exit = item_of(six, 'acro_exit')
    assert.equal(exit.status, 'ok')
    assert.match(exit.text, /положения 1 \(STABILIZE, PWM до 1230\), 2 .*5 \(ALT_HOLD, PWM 1621–1749\)/)
    assert.doesNotMatch(exit.text, /6 \(/)
    assert.match(exit.text, /проверьте, что тумблер достаёт/)
    // Положение из поля страницы — строкой; неверное положение — как не выбрано
    assert.deepEqual(item_of(prep_check(params, 'pid', { acro_slot: '3' }), 'acro_slot').changes, [{ name: 'FLTMODE3', value: 1 }])
    assert.deepEqual(item_of(prep_check(params, 'pid', { acro_slot: 7 }), 'acro_slot').changes, [])

    // Единственный выход — в FLTMODE6: ACRO на его место — выхода нет, fail без changes; ACRO в 1 — выход 6
    const only_exit6 = fake_params({ ...NO_ACRO, FLTMODE1: 3, FLTMODE2: 3, FLTMODE3: 4, FLTMODE4: 6, FLTMODE5: 9, FLTMODE6: 0 })
    const lost = item_of(prep_check(only_exit6, 'pid', { acro_slot: 6 }), 'acro_exit')
    assert.equal(lost.status, 'fail')
    assert.deepEqual(lost.changes, [])
    const kept = item_of(prep_check(only_exit6, 'pid', { acro_slot: 1 }), 'acro_exit')
    assert.equal(kept.status, 'ok')
    assert.match(kept.text, /положение 6 \(STABILIZE, PWM от 1750\): проверьте, что тумблер достаёт до этого положения/)

    // ACRO уже есть — выбор не учитывается: ни changes, ни замены режима в выходе
    const has = prep_check(fake_params(GOOD), 'pid', { acro_slot: 1 })
    assert.equal(item_of(has, 'acro_slot').status, 'ok')
    assert.match(item_of(has, 'acro_slot').text, /положение 6 \(PWM от 1750\)/)
    assert.deepEqual(item_of(has, 'acro_slot').changes, [])
    assert.match(item_of(has, 'acro_exit').text, /положения 1 \(STABILIZE/)
})

test('prep_plan_slots: найденное или выбранное ACRO и первое положение выхода', () => {
    assert.deepEqual(prep_plan_slots(fake_params(NO_ACRO), 6), { acro: 6, exit: 1 })
    assert.deepEqual(prep_plan_slots(fake_params(NO_ACRO), null), { acro: null, exit: 1 })
    assert.deepEqual(prep_plan_slots(fake_params(GOOD), 2), { acro: 6, exit: 1 })
    const only_exit6 = fake_params({ ...NO_ACRO, FLTMODE1: 3, FLTMODE2: 3, FLTMODE3: 4, FLTMODE4: 6, FLTMODE5: 9, FLTMODE6: 0 })
    assert.deepEqual(prep_plan_slots(only_exit6, 6), { acro: 6, exit: null })
})

// ---------------------------------------------------------------- обучение газа висения

test('hover_learn: проверка шага 0 warn — warn и 2 в файл; ok или нет лога — ok с советом; MOT_HOVER_LEARN = 2 — ok', () => {
    const values = with_values({ MOT_HOVER_LEARN: 0 })
    const warn = item_of(check(values, 'filters', { hover_check: { id: 'hover_throttle', status: 'warn' } }), 'hover_learn')
    assert.equal(warn.status, 'warn')
    assert.deepEqual(warn.changes, [{ name: 'MOT_HOVER_LEARN', value: 2 }])
    assert.match(warn.fix, /MOT_HOVER_LEARN = 2/)
    for (const hover_check of [{ id: 'hover_throttle', status: 'ok' }, null]) {
        const item = item_of(check(values, 'filters', { hover_check: hover_check }), 'hover_learn')
        assert.equal(item.status, 'ok')
        assert.deepEqual(item.changes, [])
        assert.match(item.text, /Совет: MOT_HOVER_LEARN = 2/)
        assert.match(item.text, (hover_check == null) ? /по логу не проверено/ : /по логу газ висения сходится/)
    }
    assert.match(item_of(check(with_values({ MOT_HOVER_LEARN: 1 }), 'filters'), 'hover_learn').text, /обучается, но не сохраняется/)
    // Обучение включено — ok и при расхождении по логу (значит, мало висения в ALT_HOLD — это уже говорит шаг 0)
    const learning = item_of(check(GOOD, 'filters', { hover_check: { id: 'hover_throttle', status: 'warn' } }), 'hover_learn')
    assert.equal(learning.status, 'ok')
})

// ---------------------------------------------------------------- значения файла исправлений

test('prep_changes: log_pid и log_fast складываются в один LOG_BITMASK; файл .param — ожидаемые строки', () => {
    const params = fake_params(NO_ACRO)
    const items = prep_check(params, 'both', { acro_slot: prep_acro_suggestion(params) })
    const values = prep_changes(params, items)
    assert.equal(values.LOG_BITMASK, 176126 | (1 << 12) | 1)
    assert.deepEqual(values, {
        LOG_BITMASK: 180223, INS_LOG_BAT_MASK: 1, INS_LOG_BAT_OPT: 4, FLTMODE6: 1, ACRO_OPTIONS: 2, ACRO_TRAINER: 0,
    })
    const text = param_file_text(values)
    for (const line of ['ACRO_OPTIONS,2', 'ACRO_TRAINER,0', 'FLTMODE6,1', 'INS_LOG_BAT_MASK,1', 'INS_LOG_BAT_OPT,4', 'LOG_BITMASK,180223']) {
        assert.ok(text.split('\n').includes(line), 'нет строки ' + line + ' в\n' + text)
    }
    // Файл читается обратно тем же разбором
    assert.deepEqual(parse_param_file(text), values)
})

test('prep_changes: значение, равное текущему (как float32), не попадает; маска — от уже набранного значения', () => {
    const params = fake_params({ LOG_BITMASK: 4097, X_FLOAT: 0.699999988, X_INT: 5 })
    const items = [
        { changes: [{ name: 'LOG_BITMASK', set: 1, clear: 0 }] },
        { changes: [{ name: 'LOG_BITMASK', set: 4096, clear: 0 }] },
        { changes: [{ name: 'X_FLOAT', value: 0.7 }, { name: 'X_INT', value: 5 }] },
        { changes: [] },
        {},
    ]
    assert.deepEqual(prep_changes(params, items), {})
    // set и clear по очереди: второй пункт снимает бит, поставленный первым
    const masks = [{ changes: [{ name: 'M', set: 8, clear: 0 }] }, { changes: [{ name: 'M', set: 2, clear: 8 }] }]
    assert.deepEqual(prep_changes(fake_params({ M: 1 }), masks), { M: 3 })
    // Маски нет в параметрах — от 0
    assert.deepEqual(prep_changes(fake_params({}), masks), { M: 2 })
    // Изменение только части: бит уже стоит — не пишется, другое значение — пишется
    assert.deepEqual(prep_changes(fake_params({ LOG_BITMASK: 4097, X_INT: 5 }),
        [{ changes: [{ name: 'LOG_BITMASK', set: 1, clear: 0 }, { name: 'X_INT', value: 6 }] }]), { X_INT: 6 })
})

test('prep_reboot_names: только имена, которым нужна перезагрузка, в порядке names', () => {
    assert.deepEqual(prep_reboot_names(['LOG_FILE_BUFSIZE', 'ACRO_TRAINER', 'INS_LOG_BAT_MASK', 'LOG_BITMASK', 'INS_LOG_BAT_OPT', 'LOG_BACKEND_TYPE']),
        ['LOG_FILE_BUFSIZE', 'INS_LOG_BAT_MASK', 'INS_LOG_BAT_OPT', 'LOG_BACKEND_TYPE'])
    assert.deepEqual(prep_reboot_names(['FLTMODE6', 'ACRO_OPTIONS']), [])
    assert.deepEqual(prep_reboot_names([]), [])
})

// ---------------------------------------------------------------- план полёта

test('prep_flight_plan: фильтры — висение, без Acro; PID — Acro с положениями; оба — сначала висение', () => {
    const ctx = { acro_slot: 6, exit_slot: 1, checks: null }
    const filters = prep_flight_plan('filters', ctx)
    assert.equal(filters.length, 2)
    assert.match(filters[0], /висение не меньше 30 с \(лучше 60\) без движений стиками/)
    assert.equal(filters[1], 'Посадка; загрузите лог в мастер.')
    assert.ok(!filters.some((t) => /ACRO/.test(t)))

    const pid = prep_flight_plan('pid', ctx)
    assert.equal(pid.length, 4)
    assert.match(pid[0], /^Наберите безопасную высоту и включите ACRO положением 6 \(PWM от 1750\)\.$/)
    assert.match(pid[1], /крен, тангаж, рыскание/)
    assert.match(pid[1], /не меньше 10 с участков с целью скорости от 20 °\/с/)
    assert.match(pid[2], /^Выход из ACRO — положением 1 \(PWM до 1230\): в Acro аппарат сам не выравнивается\.$/)
    assert.match(pid[3], /«Интервал — участок ACRO»\.$/)
    assert.ok(!pid.some((t) => /висение/.test(t)))

    const both = prep_flight_plan('both', ctx)
    assert.equal(both.length, 5)
    assert.match(both[0], /висение/)
    assert.match(both[1], /^После висения наберите безопасную высоту/)
    assert.match(both[4], /«Интервал — участок ACRO»/)
    for (const text of [...filters, ...pid, ...both]) {
        assert.match(text, /[.!?]$/)
    }
})

test('prep_flight_plan: положения не выбраны — подсказка и предупреждение; без ctx — тоже работает', () => {
    const plan = prep_flight_plan('pid', { acro_slot: null, exit_slot: null, checks: [] })
    assert.match(plan[0], /положение для ACRO не выбрано/)
    assert.match(plan[2], /Положения с самовыравниванием на переключателе нет/)
    assert.deepEqual(prep_flight_plan('pid'), plan)
})

test('prep_flight_plan: «До полёта» — вибрации, clipping, обороты шага 0 со статусом warn или fail и fix', () => {
    const checks = [
        { id: 'pid_log', status: 'fail', title: 'Сообщения PID', fix: 'Включите бит PID' },
        { id: 'vibe', status: 'fail', title: 'Вибрации', fix: 'Проверьте крепление автопилота, балансировку пропеллеров и моторов' },
        { id: 'clipping', status: 'ok', title: 'Clipping', fix: null },
        { id: 'tracking', status: 'warn', title: 'Источник трекинга notch', fix: 'Если регуляторы умеют телеметрию — включите, это точнее' },
        { id: 'flight', status: 'warn', title: 'Полёт', fix: 'Висение не меньше 30 с без ввода' },
    ]
    const plan = prep_flight_plan('filters', { acro_slot: null, exit_slot: null, checks: checks })
    assert.deepEqual(plan.slice(0, 2), [
        'До полёта: Вибрации — проверьте крепление автопилота, балансировку пропеллеров и моторов.',
        'До полёта: Источник трекинга notch — если регуляторы умеют телеметрию — включите, это точнее.',
    ])
    assert.equal(plan.length, 4)
    // Предупреждение без fix (нет VIBE) — не пункт плана
    const no_fix = prep_flight_plan('filters', { checks: [{ id: 'vibe', status: 'warn', title: 'Вибрации', fix: null }] })
    assert.equal(no_fix.length, 2)
})

// ---------------------------------------------------------------- источник параметров и имя файла

test('параметры из parse_param_file (обёртка get) и из log_params дают одно и то же', () => {
    const text = '# синтетический файл\n' + Object.entries(NO_ACRO).map(([name, value]) => name + ',' + value).join('\r\n') + '\n'
    const parsed = parse_param_file(text)
    const from_file = { get: (name) => (name in parsed) ? parsed[name] : null }

    // Лог: PARM с повтором имени — log_params берёт последнее значение
    const names = [...Object.keys(NO_ACRO), 'ACRO_TRAINER']
    const values = [...Object.values(NO_ACRO), 0]
    const log = {
        messageTypes: { PARM: {} },
        get: (name) => ({ Name: names, Value: values, TimeUS: names.map((n, i) => i * 1000) }),
    }
    const from_log = log_params(log)
    assert.equal(from_log.get('ACRO_TRAINER'), 0)

    for (const goal of ['filters', 'pid', 'both']) {
        const ctx = { acro_slot: 6, hover_check: null }
        const file_items = prep_check(from_file, goal, ctx)
        const obj_items = prep_check(fake_params(NO_ACRO), goal, ctx)
        assert.deepEqual(file_items, obj_items)
        // Лог отличается только тренером (последнее значение 0)
        const log_items = prep_check(from_log, goal, ctx)
        assert.deepEqual(log_items.filter((i) => i.id !== 'acro_trainer'), obj_items.filter((i) => i.id !== 'acro_trainer'))
        if (prep_goals[goal].goals.includes('pid')) {
            assert.equal(item_of(log_items, 'acro_trainer').status, 'ok')
            assert.equal(item_of(obj_items, 'acro_trainer').status, 'fail')
        }
    }
    assert.deepEqual(prep_changes(from_file, prep_check(from_file, 'both', { acro_slot: 6 })),
        prep_changes(fake_params(NO_ACRO), prep_check(fake_params(NO_ACRO), 'both', { acro_slot: 6 })))
})

test('prep_file_name: имя без расширения + «_prep.param»; имени нет — «prep.param»', () => {
    assert.equal(prep_file_name('1.param'), '1_prep.param')
    assert.equal(prep_file_name('1 01.01.1970 2-00-00.bin'), '1 01.01.1970 2-00-00_prep.param')
    assert.equal(prep_file_name('copter'), 'copter_prep.param')
    assert.equal(prep_file_name(''), 'prep.param')
    assert.equal(prep_file_name(null), 'prep.param')
})
