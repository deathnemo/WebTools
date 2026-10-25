// Тесты переноса PIDReview в мастер настройки (TuneWizard/core/pid.js): загрузка PIDR и RATE, наборы параметров,
// пакеты по разрывам, FFT компонент и отклик на ступеньку на синтетике; исправления дефектов upstream 1, 2, 3, 5 и 6
// (шапка core/pid.js) — тесты с пометкой «дефект upstream N».
// Скрипты ядра — классические (общая глобальная область), поэтому загружаются как на странице:
// по порядку через vm.runInThisContext (как в tests/tunewizard-steps.test.cjs).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const repo = path.resolve(__dirname, '..')

// FFTJS на странице — глобал из modules/fft.js/dist/fft.js; под Node берём ту же библиотеку через require
globalThis.FFTJS = require('../modules/fft.js/lib/fft.js')

// Загрузить скрипты страницы в глобальную область, в том порядке, что и index.html
function load_page_scripts(files) {
    for (const file of files) {
        const full = path.join(repo, file)
        vm.runInThisContext(fs.readFileSync(full, 'utf8'), { filename: full })
    }
}

// Скрипты ядра до core/pid.js в порядке страницы. Повторное глобальное const/let/class упадёт здесь же; повтор
// function молча перезапишет прежнюю. core/checks.js и часть библиотек страницы не грузятся
load_page_scripts([
    'Libraries/Array_Math.js',
    'Libraries/fft.js',
    'TuneWizard/core/log.js',
    'TuneWizard/core/gyro.js',
    'TuneWizard/core/tracking/Atmosphere_model.js',
    'TuneWizard/core/tracking/BaseClass.js',
    'TuneWizard/core/tracking/Static.js',
    'TuneWizard/core/tracking/Throttle.js',
    'TuneWizard/core/tracking/RPM.js',
    'TuneWizard/core/tracking/ESC.js',
    'TuneWizard/core/tracking/FFT.js',
    'TuneWizard/core/tracking/Logged.js',
    'TuneWizard/core/filters.js',
    'TuneWizard/core/spectrum.js',
    'TuneWizard/core/metrics.js',
    'TuneWizard/core/autofit.js',
    'TuneWizard/core/candidates.js',
    'TuneWizard/core/lowpass.js',
    'TuneWizard/core/pid.js',
])

const R2D = 180 / Math.PI
const env = { build_type: 2 }
const RATE_HZ = 400

// Поддельный лог с интерфейсом парсера: messages = { ИМЯ: { поле: массив } } (без экземпляров),
// params = [[имя, значение, время с], ...] — сообщения PARM (Name, Value, TimeUS)
function fake_log({ messages = {}, params = [] } = {}) {
    const types = { ...messages }
    if (params.length > 0) {
        types.PARM = {
            TimeUS: params.map((p) => Math.round((p[2] ?? 0) * 1e6)),
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
        }
    }
}

// Параметры трёх осей в начале лога (время 0.5 с), как запись PARM при загрузке
function base_params() {
    const out = []
    for (const [axis, P, I, D] of [["RLL", 0.1, 0.1, 0.003], ["PIT", 0.09, 0.09, 0.0025], ["YAW", 0.2, 0.02, 0]]) {
        out.push(["ATC_RAT_" + axis + "_P", P, 0.5], ["ATC_RAT_" + axis + "_I", I, 0.5], ["ATC_RAT_" + axis + "_D", D, 0.5],
                 ["ATC_RAT_" + axis + "_FF", 0, 0.5], ["ATC_RAT_" + axis + "_FLTD", 30, 0.5])
    }
    return out
}

// Время отсчётов: участки [начало, конец) в секундах с частотой RATE_HZ → TimeUS
function time_us(segments) {
    const out = []
    for (const [t0, t1] of segments) {
        const n = Math.round((t1 - t0) * RATE_HZ)
        for (let k = 0; k < n; k++) {
            out.push(Math.round((t0 + k / RATE_HZ) * 1e6))
        }
    }
    return out
}

// Сообщение PIDx по массиву TimeUS: поля — функции номера отсчёта
function pid_msg(TimeUS, fields) {
    const msg = { TimeUS }
    for (const [name, fn] of Object.entries(fields)) {
        msg[name] = TimeUS.map((_, k) => fn(k))
    }
    return msg
}

// Детерминированный генератор (LCG), значения [0, 1)
function lcg(seed) {
    let s = seed >>> 0
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0
        return s / 4294967296
    }
}

// Цель — случайные ступеньки (°/с): уровень ±[amin, amax], держится 0.3–1.0 с
function step_target(n, seed, amin, amax) {
    const rnd = lcg(seed)
    const tar = new Array(n)
    let level = 0
    let next = 0
    for (let k = 0; k < n; k++) {
        if (k >= next) {
            const sign = (rnd() < 0.5) ? -1 : 1
            level = sign * (amin + (amax - amin) * rnd())
            next = k + Math.round((0.3 + 0.7 * rnd()) * RATE_HZ)
        }
        tar[k] = level
    }
    return tar
}

// Факт — фильтр первого порядка с постоянной времени tau (с) от цели, задержанной на delay отсчётов
function first_order(tar, tau, delay) {
    const alpha = 1 - Math.exp(-1 / (RATE_HZ * tau))
    const act = new Array(tar.length)
    let y = 0
    for (let k = 0; k < tar.length; k++) {
        y += alpha * (tar[Math.max(0, k - delay)] - y)
        act[k] = y
    }
    return act
}

// Лог PIDR из цели и факта в °/с (в логе — рад/с) длительностью по массивам, с начала времени 0;
// gap_s — время, после которого в логе пропуск 1 с (два пакета)
function closed_loop_log(tar, act, gap_s = Infinity) {
    const TimeUS = tar.map((_, k) => Math.round((k / RATE_HZ + ((k / RATE_HZ >= gap_s) ? 1 : 0)) * 1e6))
    const zero = () => 0
    return fake_log({
        messages: { PIDR: pid_msg(TimeUS, { Tar: (k) => tar[k] / R2D, Act: (k) => act[k] / R2D, Err: (k) => (tar[k] - act[k]) / R2D,
                                            P: zero, I: zero, D: zero, FF: zero }) },
        params: base_params()
    })
}

// Число окон отклика, посчитанное независимо: окна размером window с шагом round(window/16) по пакету,
// максимум |Tar · окно Ханна| не меньше 20 °/с, номера окон [k0, k1)
function windows_over_threshold(batch, window, k0 = 0, k1 = Infinity) {
    const spacing = Math.round(window / 16)
    const w = hanning(window)
    const num = Math.floor((batch.Tar.length - window) / spacing) + 1
    let count = 0
    for (let k = Math.max(k0, 0); k < Math.min(k1, num); k++) {
        let max = 0
        for (let i = 0; i < window; i++) {
            max = Math.max(max, Math.abs(batch.Tar[k * spacing + i] * w[i]))
        }
        if (max >= 20) {
            count++
        }
    }
    return count
}

// Время первого достижения уровня (линейная интерполяция), NaN — не достиг
function crossing_time(time, y, level) {
    for (let i = 1; i < y.length; i++) {
        if ((y[i - 1] < level) && (y[i] >= level)) {
            return time[i - 1] + (level - y[i - 1]) / (y[i] - y[i - 1]) * (time[i] - time[i - 1])
        }
    }
    return NaN
}

test('load_pid: PIDR — Tar/Act/Err из рад/с в °/с, P/I/D/FF без масштаба, выход — сумма P+I+D+FF+DFF', () => {
    const TimeUS = time_us([[10, 15]])
    const fields = {
        Tar: (k) => 0.5 * Math.sin(k / 50), Act: (k) => 0.4 * Math.sin(k / 50 - 0.2), Err: (k) => 0.1 * Math.cos(k / 30),
        P: (k) => 0.01 * Math.sin(k / 7), I: (k) => 0.002 * k / 2000, D: (k) => 0.001 * Math.cos(k / 3), FF: (k) => 0.003 * Math.sin(k / 11),
        DFF: (k) => 0.0005 * Math.cos(k / 13)
    }
    const msg = pid_msg(TimeUS, fields)
    const res = load_pid(fake_log({ messages: { PIDR: msg }, params: base_params() }), env)

    assert.equal(res.have_data, true)
    assert.deepEqual(res.warnings, [])
    assert.deepEqual(res.axes.map((a) => a.id.join(" ")), ["PIDR", "PIDP", "PIDY", "RATE R", "RATE P", "RATE Y"])
    assert.deepEqual(res.axes.map((a) => a.have_data), [true, false, false, false, false, false])
    assert.equal(res.start_time, 10)
    assert.ok(Math.abs(res.end_time - (15 - 1 / RATE_HZ)) < 1e-9, 'конец данных ' + res.end_time)

    const axis = res.axes[0]
    assert.equal(axis.params.prefix, "ATC_RAT_RLL_")
    assert.equal(axis.sets.length, 1)
    assert.equal(axis.sets[0].length, 1, 'без разрывов — один пакет')
    const batch = axis.sets[0][0]
    assert.equal(batch.Tar.length, TimeUS.length, 'без разрывов — все отсчёты лога (дефект upstream 2)')
    assert.ok(Math.abs(batch.sample_rate - RATE_HZ) / RATE_HZ < 1e-3, 'частота ' + batch.sample_rate)
    for (let k = 0; k < batch.Tar.length; k++) {
        assert.equal(batch.time[k], TimeUS[k] * US2S)
        for (const key of ["Tar", "Act", "Err"]) {
            assert.ok(Math.abs(batch[key][k] - msg[key][k] * R2D) < 1e-12, key + '[' + k + '] в °/с')
        }
        for (const key of ["P", "I", "D", "FF", "DFF"]) {
            assert.equal(batch[key][k], msg[key][k], key + '[' + k + '] без масштаба')
        }
        const sum = msg.P[k] + msg.I[k] + msg.D[k] + msg.FF[k] + msg.DFF[k]
        assert.ok(Math.abs(batch.Out[k] - sum) < 1e-15, 'Out[' + k + '] = P+I+D+FF+DFF')
    }

    // Без поля DFF: DFF = null, выход — P+I+D+FF
    const { DFF: _unused, ...fields_no_dff } = fields
    const no_dff = pid_msg(TimeUS, fields_no_dff)
    const batch2 = load_pid(fake_log({ messages: { PIDR: no_dff }, params: base_params() }), env).axes[0].sets[0][0]
    assert.equal(batch2.DFF, null)
    for (let k = 0; k < batch2.Out.length; k++) {
        assert.ok(Math.abs(batch2.Out[k] - (no_dff.P[k] + no_dff.I[k] + no_dff.D[k] + no_dff.FF[k])) < 1e-15, 'Out[' + k + '] без DFF')
    }
})

test('load_pid: только RATE — Tar = xDes, Act = x, Out = xOut без масштабирования, без компонент; ось без параметров не грузится', () => {
    const TimeUS = time_us([[0, 3]])
    const fields = {}
    for (const [i, a] of ["R", "P", "Y"].entries()) {
        fields[a + "Des"] = (k) => 30 * Math.sin(k / 40 + i)
        fields[a] = (k) => 25 * Math.sin(k / 40 + i - 0.3)
        fields[a + "Out"] = (k) => 0.05 * Math.cos(k / 40 + i)
    }
    const msg = pid_msg(TimeUS, fields)
    // Параметров рыскания нет — ось RATE Y не грузится (в upstream так же: без параметров данных оси нет)
    const params = base_params().filter((p) => !p[0].startsWith("ATC_RAT_YAW_"))
    const res = load_pid(fake_log({ messages: { RATE: msg }, params }), env)

    assert.equal(res.have_data, true)
    assert.deepEqual(res.axes.map((a) => a.have_data), [false, false, false, true, true, false])
    assert.equal(res.axes[5].params.prefix, null)
    for (const [index, a] of [[3, "R"], [4, "P"]]) {
        const batch = res.axes[index].sets[0][0]
        assert.deepEqual(Object.keys(batch).sort(), ["Act", "Out", "Tar", "sample_rate", "time"], 'у RATE нет Err и компонент')
        for (let k = 0; k < batch.Tar.length; k++) {
            assert.equal(batch.Tar[k], msg[a + "Des"][k])
            assert.equal(batch.Act[k], msg[a][k])
            assert.equal(batch.Out[k], msg[a + "Out"][k])
        }
    }
})

test('load_pid: нет PID и RATE, не Copter — have_data ложно и предупреждение', () => {
    const empty = load_pid(fake_log({ messages: { ATT: { TimeUS: [0, 1] } }, params: base_params() }), env)
    assert.equal(empty.have_data, false)
    assert.deepEqual(empty.warnings, ["В логе не найдено сообщений PID или RATE"])

    const plane = load_pid(fake_log({ messages: { PIDR: pid_msg(time_us([[0, 1]]), {}) }, params: base_params() }), { build_type: 3 })
    assert.equal(plane.have_data, false)
    assert.deepEqual(plane.axes, [])
    assert.equal(plane.warnings.length, 1)
})

test('load_pid: лог без PARM — сообщение в warnings вместо TypeError (дефект upstream 6)', () => {
    // В upstream log.get('PARM') без сообщений PARM не определён, и разбор падал на PARM.Name
    const zero = () => 0
    const msg = pid_msg(time_us([[0, 5]]), { Tar: zero, Act: zero, Err: zero, P: zero, I: zero, D: zero, FF: zero })
    const res = load_pid(fake_log({ messages: { PIDR: msg } }), env)
    assert.equal(res.have_data, false)
    assert.equal(res.warnings.length, 1)
    assert.match(res.warnings[0], /PARM/)
    assert.deepEqual(res.axes.map((a) => a.have_data), [false, false, false, false, false, false])
})

// Лог PIDR и PIDP 0–20 с; изменения параметров: [[имя, значение, время с], ...]
function changes_log(changes) {
    const TimeUS = time_us([[0, 20]])
    const fields = { Tar: (k) => Math.sin(k / 30), Act: (k) => Math.sin(k / 30 - 0.1), Err: () => 0, P: () => 0, I: () => 0, D: () => 0, FF: () => 0 }
    return fake_log({ messages: { PIDR: pid_msg(TimeUS, fields), PIDP: pid_msg(TimeUS, fields) }, params: [...base_params(), ...changes] })
}

test('load_pid: смена ATC_RAT_RLL_P посреди лога — два набора параметров, пакеты разрезаны по смене', () => {
    const res = load_pid(changes_log([["ATC_RAT_RLL_P", 0.12, 10]]), env)
    const roll = res.axes[0]
    assert.equal(roll.params.sets.length, 2)
    const [s0, s1] = roll.params.sets
    assert.equal(s0.start_time, 0)
    assert.equal(s0.end_time, 10)
    assert.equal(s0.KP, 0.1)
    assert.equal(s1.start_time, 10)
    assert.equal(s1.end_time, Infinity)
    assert.equal(s1.KP, 0.12)
    assert.equal(s1.KI, 0.1, 'остальные значения переходят в новый набор')
    assert.equal(s1.KD, 0.003)

    assert.equal(roll.sets.length, 2)
    for (const batch of roll.sets[0]) {
        assert.ok(batch.time[batch.time.length - 1] <= 10, 'набор 0 — до смены')
    }
    for (const batch of roll.sets[1]) {
        assert.ok(batch.time[0] > 10, 'набор 1 — после смены')
    }
    assert.ok(roll.sets[1][roll.sets[1].length - 1].time.at(-1) > 19.9, 'набор 1 — до конца лога')

    // Тангаж не менялся — один набор
    assert.equal(res.axes[1].params.sets.length, 1)
    assert.equal(res.axes[1].sets.length, 1)

    // Повторная запись того же значения — не смена
    assert.equal(load_pid(changes_log([["ATC_RAT_RLL_P", 0.1, 10]]), env).axes[0].params.sets.length, 1)
})

test('load_pid: повторная смена в пределах 1 с после первой сливается с новым набором, позже 1 с — ещё набор', () => {
    // Как в upstream (load, 1534–1550): окно 1 с отсчитывается от первой смены, начало нового набора переносится
    // на последнюю смену в этом окне, между наборами остаётся разрыв
    const merged = load_pid(changes_log([["ATC_RAT_RLL_P", 0.12, 10], ["ATC_RAT_RLL_D", 0.004, 10.5], ["ATC_RAT_RLL_P", 0.13, 10.9]]), env).axes[0]
    assert.equal(merged.params.sets.length, 2)
    assert.equal(merged.params.sets[0].end_time, 10)
    assert.equal(merged.params.sets[1].start_time, 10.9)
    assert.equal(merged.params.sets[1].KP, 0.13)
    assert.equal(merged.params.sets[1].KD, 0.004)

    const three = load_pid(changes_log([["ATC_RAT_RLL_P", 0.12, 10], ["ATC_RAT_RLL_P", 0.13, 11.5]]), env).axes[0]
    assert.deepEqual(three.params.sets.map((s) => [s.start_time, s.end_time, s.KP]), [[0, 10, 0.1], [10, 11.5, 0.12], [11.5, Infinity, 0.13]])
    assert.equal(three.sets.length, 3)
    for (const [index, [t0, t1]] of [[10, 11.5], [11.5, 20]].entries()) {
        for (const batch of three.sets[index + 1]) {
            assert.ok(batch.time[0] > t0 && batch.time.at(-1) <= t1, 'пакет набора ' + (index + 1) + ' в его границах')
        }
    }
})

test('pid_split_into_batches: отсчёты разрыва между наборами не входят в пакет нового набора, частота не занижена (дефект upstream 1)', () => {
    // Смены 10 с и 10.9 с: набор 1 начинается в 10.9 с, отсчёты 10.0025…10.8975 с — разрыв «без набора».
    // В upstream первый пакет набора 1 начинался в 10.0025 с, а частота пакета занижалась до 364 Гц
    const roll = load_pid(changes_log([["ATC_RAT_RLL_P", 0.12, 10], ["ATC_RAT_RLL_P", 0.13, 10.9]]), env).axes[0]
    assert.deepEqual(roll.params.sets.map((s) => [s.start_time, s.end_time]), [[0, 10], [10.9, Infinity]])
    assert.equal(roll.sets.length, 2)
    assert.equal(roll.sets[1].length, 1)
    const batch = roll.sets[1][0]
    assert.equal(batch.time[0], roll.params.sets[1].start_time, 'пакет набора 1 начинается с первого отсчёта набора')
    // Данные пакета — с того же отсчёта, что и время (Tar = sin(k/30) в рад/с)
    assert.ok(Math.abs(batch.Tar[0] / R2D - Math.sin(Math.round(10.9 * RATE_HZ) / 30)) < 1e-12, 'Tar[0] — отсчёт 10.9 с')
    for (const [j, set] of roll.sets.entries()) {
        for (const b of set) {
            assert.ok(Math.abs(b.sample_rate - RATE_HZ) < 1e-6, 'набор ' + j + ': частота пакета ' + b.sample_rate)
        }
    }
})

test('pid_split_into_batches: пропуск отсчётов — новый пакет; кусок короче 64 отсчётов отбрасывается', () => {
    // Участки: 0–5 с, 6–10 с, 11–11.1 с (40 отсчётов), 12–15 с
    const TimeUS = time_us([[0, 5], [6, 10], [11, 11.1], [12, 15]])
    const fields = { Tar: (k) => k, Act: () => 0, Err: () => 0, P: () => 0, I: () => 0, D: () => 0, FF: () => 0 }
    const axis = load_pid(fake_log({ messages: { PIDR: pid_msg(TimeUS, fields) }, params: base_params() }), env).axes[0]
    const batches = axis.sets[0]
    assert.equal(batches.length, 3)
    for (const [batch, [t0, t1]] of batches.map((b, i) => [b, [[0, 5], [6, 10], [12, 15]][i]])) {
        assert.ok(Math.abs(batch.time[0] - t0) < 1e-9, 'начало пакета ' + batch.time[0])
        assert.ok(batch.time.at(-1) < t1 && batch.time.at(-1) > t1 - 0.01, 'конец пакета ' + batch.time.at(-1))
        assert.ok(Math.abs(batch.sample_rate - RATE_HZ) / RATE_HZ < 1e-3, 'частота пакета ' + batch.sample_rate)
        // Данные пакета — те же отсчёты, что и время
        assert.equal(batch.Tar[0] / R2D, TimeUS.findIndex((t) => Math.abs(t * US2S - batch.time[0]) < 1e-9))
    }
})

test('pid_split_into_batches: последний отсчёт пакета не теряется, частота — по числу интервалов (дефект upstream 2)', () => {
    // Участки 0–5 с и 6–10 с: пакеты ровно по 2000 и 1600 отсчётов с частотой 400 Гц. В upstream срез кончался
    // на отсчёте перед разрывом (1999), в конце лога терялись два (1598), а частота — n отсчётов на n − 1 интервалов
    const fields = { Tar: (k) => k, Act: () => 0, Err: () => 0, P: () => 0, I: () => 0, D: () => 0, FF: () => 0 }
    const axis_of = (TimeUS, params = base_params()) => load_pid(fake_log({ messages: { PIDR: pid_msg(TimeUS, fields) }, params }), env).axes[0]
    const TimeUS = time_us([[0, 5], [6, 10]])
    const axis = axis_of(TimeUS)
    assert.deepEqual(axis.sets[0].map((b) => b.Tar.length), [2000, 1600])
    for (const batch of axis.sets[0]) {
        assert.equal(batch.time.length, batch.Tar.length)
        // Отсчёты пакета подряд: Tar = номер отсчёта лога
        assert.equal(batch.Tar.at(-1) / R2D - batch.Tar[0] / R2D, batch.Tar.length - 1)
        assert.ok(Math.abs(batch.sample_rate - RATE_HZ) < 1e-9, 'частота пакета ' + batch.sample_rate)
    }
    assert.equal(axis.sets[0][1].time.at(-1), TimeUS.at(-1) * US2S, 'последний пакет — до последнего отсчёта лога')
    // Средняя частота FFT и шаг времени отклика — 400 Гц ровно (в upstream ось времени сжата в n/(n − 1) раз)
    pid_run_batch_fft(axis.sets, 512)
    assert.ok(Math.abs(axis.sets.FFT.average_sample_rate - RATE_HZ) < 1e-9, 'средняя частота ' + axis.sets.FFT.average_sample_rate)

    // Одиночный последний отсчёт за разрывом в пакет не входит
    assert.deepEqual(axis_of([...time_us([[0, 5]]), 6e6]).sets[0].map((b) => b.Tar.length), [2000])
    // Последний отсчёт лога уже в следующем наборе (смена в 19.996 с): пакет набора 0 — до предпоследнего отсчёта
    const last = axis_of(time_us([[0, 20]]), [...base_params(), ["ATC_RAT_RLL_P", 0.12, 19.996]])
    assert.equal(last.sets.length, 1, 'у набора 1 один отсчёт — пакета нет')
    assert.equal(last.sets[0][0].Tar.length, 7999)
})

test('pid_run_batch_fft: синусоида в Tar — пик в своём бине; бины, частота и время окон — общие по набору', () => {
    // 12.5 Гц при 400 Гц и окне 512 — ровно бин 16
    const TimeUS = time_us([[2, 22]])
    const amp = 100
    const fields = { Tar: (k) => amp / R2D * Math.sin(2 * Math.PI * 12.5 * k / RATE_HZ), Act: () => 0, Err: () => 0,
                     P: () => 0, I: () => 0, D: () => 0, FF: () => 0 }
    const axis = load_pid(fake_log({ messages: { PIDR: pid_msg(TimeUS, fields) }, params: base_params() }), env).axes[0]
    pid_run_batch_fft(axis.sets, 512)

    const FFT = axis.sets.FFT
    assert.equal(FFT.window_size, 512)
    assert.equal(FFT.bins.length, 257)
    assert.ok(Math.abs(FFT.average_sample_rate - RATE_HZ) < 0.1, 'частота ' + FFT.average_sample_rate)
    assert.ok(Math.abs(FFT.bins[16] - 12.5) < 0.01, 'бин 16 = ' + FFT.bins[16])

    const batch = axis.sets[0][0]
    const set_fft = axis.sets[0].FFT
    const num_windows = Math.floor((batch.Tar.length - 512) / 256) + 1
    assert.equal(set_fft.time.length, num_windows)
    assert.equal(set_fft.Tar.length, num_windows)
    assert.equal(set_fft.Out.length, num_windows, 'FFT выхода тоже считается')
    assert.equal(set_fft.DFF.length, 0, 'нет DFF — пустой массив')
    for (let w = 0; w < num_windows; w++) {
        // Время окна — центр окна от начала пакета
        assert.ok(Math.abs(set_fft.time[w] - (batch.time[0] + (w * 256 + 256) / FFT.average_sample_rate)) < 1e-9)
        const mag = complex_abs(set_fft.Tar[w])
        const peak = mag.indexOf(Math.max(...mag))
        assert.equal(peak, 16, 'окно ' + w + ': пик в бине ' + peak)
        // Амплитуда с линейной поправкой окна
        assert.ok(Math.abs(mag[16] * FFT.correction.linear - amp) / amp < 0.02, 'амплитуда ' + mag[16] * FFT.correction.linear)
    }

    assert.throws(() => pid_run_batch_fft(axis.sets, 500), /степенью двойки/)

    // Окно длиннее данных: прежний расчёт сброшен, окон нет
    pid_run_batch_fft(axis.sets, 16384)
    assert.equal(axis.sets.FFT, null)
    assert.equal(axis.sets[0].FFT, null)
})

// Синтетический контур, общий для тестов отклика: 60 с, цель ±[50, 200] °/с, факт — первый порядок τ = 50 мс
// с задержкой 20 мс (8 отсчётов)
const TAU = 0.05
const DELAY = 8
function synthetic_axis(amin, amax, seed = 1, gap_s = Infinity) {
    const tar = step_target(60 * RATE_HZ, seed, amin, amax)
    const axis = load_pid(closed_loop_log(tar, first_order(tar, TAU, DELAY), gap_s), env).axes[0]
    pid_run_batch_fft(axis.sets, 512)
    return axis
}

test('pid_step_response: первый порядок с задержкой — средний отклик достигает 0.63 за d + τ', () => {
    // Задержка нужна потому, что винеровская оценка с шумовой добавкой 1e8 выше ~25–50 Гц сглаживает H ядром с нулевой
    // фазой, а отклик интегрируется с момента 0: у системы без задержки теряется доля ядра «до нуля» (так же
    // в PID-Analyzer). Без задержки при τ = 50 мс 0.63 достигается за ≈1.15·τ и среднее выходит на ≈0.85, при Act = Tar —
    // на ≈0.56. С задержкой 20 мс (как у настоящего аппарата: моторы и фильтры) на восьми зёрнах генератора
    // (t63 − d)/τ ≈ 0.95…0.98, при окнах 256 и 1024 — ≈0.98 и ≈0.98. Допуск ±15 % τ
    // (±7.5 мс, 3 отсчёта) покрывает это смещение и разброс, но ловит ошибку времени окна, частоты или задержки
    // на несколько отсчётов.
    const axis = synthetic_axis(50, 200)
    const res = pid_step_response(axis, 0, [0, 100])
    assert.notEqual(res, null)

    const rate = axis.sets.FFT.average_sample_rate
    assert.equal(res.time.length, Math.min(Math.ceil(0.5 * rate), 512), 'первые 0.5 с')
    assert.equal(res.time[0], 0)
    assert.ok(Math.abs(res.time[1] - 1 / rate) < 1e-12, 'шаг времени — период дискретизации')
    assert.equal(res.mean.length, res.time.length)

    // Среднее — поэлементное среднее окон
    for (let i = 0; i < res.time.length; i++) {
        const avg = res.windows.reduce((sum, w) => sum + w[i], 0) / res.windows.length
        assert.ok(Math.abs(res.mean[i] - avg) < 1e-12, 'среднее в точке ' + i)
    }

    const d = DELAY / RATE_HZ
    const t63 = crossing_time(res.time, res.mean, 0.632)
    assert.ok(Math.abs(t63 - (d + TAU)) <= 0.15 * TAU, 't63 = ' + (t63 * 1000).toFixed(1) + ' мс при d + τ = ' + ((d + TAU) * 1000).toFixed(1) + ' мс')
    // До задержки факт не меняется
    assert.ok(Math.abs(res.mean[0]) < 0.02, 'отклик в 0: ' + res.mean[0])

    // Зёрна генератора: та же точность
    for (const seed of [2, 3]) {
        const r = pid_step_response(synthetic_axis(50, 200, seed), 0, [0, 100])
        const t = crossing_time(r.time, r.mean, 0.632)
        assert.ok(Math.abs(t - (d + TAU)) <= 0.15 * TAU, 'зерно ' + seed + ': t63 = ' + (t * 1000).toFixed(1) + ' мс')
    }
})

test('pid_step_response: окна — с шагом 1/16 окна и целью не меньше 20 °/с; при снижении амплитуды окон меньше', () => {
    const strong = synthetic_axis(50, 200)
    const batch = strong.sets[0][0]
    const all = Math.floor((batch.Tar.length - 512) / 32) + 1
    const n_strong = pid_step_response(strong, 0, [0, 100]).windows.length
    assert.equal(n_strong, windows_over_threshold(batch, 512))
    assert.equal(n_strong, all, 'цель не меньше 50 °/с — годны все окна')

    // Уровни ±[5, 40] °/с: часть окон ниже порога
    const weak = synthetic_axis(5, 40)
    const n_weak = pid_step_response(weak, 0, [0, 100]).windows.length
    assert.equal(n_weak, windows_over_threshold(weak.sets[0][0], 512))
    assert.ok(n_weak > 0 && n_weak < all * 0.9, 'окон ' + n_weak + ' из ' + all)

    // Цель не больше 15 °/с — ни одного окна
    assert.equal(pid_step_response(synthetic_axis(5, 15), 0, [0, 100]), null)

    // Два пакета (пропуск 1 с после 30 с): окна обоих, среднее — по всем окнам набора
    const split = synthetic_axis(5, 40, 1, 30)
    assert.equal(split.sets[0].length, 2)
    const res = pid_step_response(split, 0, [0, 100])
    assert.equal(res.windows.length, windows_over_threshold(split.sets[0][0], 512) + windows_over_threshold(split.sets[0][1], 512))
    for (let i = 0; i < res.time.length; i++) {
        const avg = res.windows.reduce((sum, w) => sum + w[i], 0) / res.windows.length
        assert.ok(Math.abs(res.mean[i] - avg) < 1e-12, 'среднее двух пакетов в точке ' + i)
    }
})

test('pid_step_response: только окна интервала, как в upstream — плюс по окну за каждой границей', () => {
    const axis = synthetic_axis(50, 200)
    const batch = axis.sets[0][0]
    // Центры окон отклика (шаг 32 отсчёта при окне 512) — независимо от кода переноса
    const spacing = 32
    const sample_time = 1 / axis.sets.FFT.average_sample_rate
    const num = Math.floor((batch.Tar.length - 512) / spacing) + 1
    const center = (k) => batch.time[0] + (k * spacing + 256) * sample_time
    let first = -1
    let last = -1
    for (let k = 0; k < num; k++) {
        if ((center(k) >= 20) && (center(k) <= 40)) {
            if (first < 0) first = k
            last = k
        }
    }
    const res = pid_step_response(axis, 0, [20, 40])
    assert.equal(res.windows.length, windows_over_threshold(batch, 512, first - 1, last + 2))
    assert.equal(res.windows.length, last - first + 3)
})

test('pid_step_response: границы интервала — по сквозному времени окон набора, пакет целиком вне интервала окон не даёт (дефект upstream 3)', () => {
    // Два пакета: 0–30 с и 31–61 с (пропуск 1 с). В upstream индексы искались по окнам каждого пакета отдельно, и пакет
    // целиком до интервала давал своё последнее окно, а целиком после — первое
    const axis = synthetic_axis(50, 200, 1, 30)
    const [b0, b1] = axis.sets[0]
    assert.equal(axis.sets[0].length, 2)
    const sample_time = 1 / axis.sets.FFT.average_sample_rate
    // Число окон пакета и номера первого и последнего окна с центром в [t0, t1] (-1, если таких нет) — независимо от кода переноса
    const windows_in = (batch, t0, t1) => {
        const num = Math.floor((batch.Tar.length - 512) / 32) + 1
        let first = -1
        let last = -1
        for (let k = 0; k < num; k++) {
            const center = batch.time[0] + (k * 32 + 256) * sample_time
            if ((center >= t0) && (center <= t1)) {
                if (first < 0) first = k
                last = k
            }
        }
        return { num, first, last }
    }
    // Интервал внутри второго пакета: его окна с краевыми (последним до 40 с и первым после 55 с), первый пакет — ни одного
    const inner = windows_in(b1, 40, 55)
    assert.ok(inner.first > 0 && inner.last < inner.num - 1)
    assert.equal(pid_step_response(axis, 0, [40, 55]).windows.length, inner.last - inner.first + 3)
    // Интервал внутри первого пакета: второй пакет (целиком после) окон не даёт
    const early = windows_in(b0, 5, 20)
    assert.equal(pid_step_response(axis, 0, [5, 20]).windows.length, early.last - early.first + 3)
    // Начало интервала в пропуске: окно до начала — последнее окно первого пакета, дальше — окна второго до первого после 55 с
    const across = windows_in(b1, 30.5, 55)
    assert.equal(across.first, 0)
    assert.equal(pid_step_response(axis, 0, [30.5, 55]).windows.length, 1 + across.last + 2)
    // Окна — те же, что у каждого пакета: у всех цель не меньше 20 °/с
    assert.equal(windows_over_threshold(b1, 512, inner.first - 1, inner.last + 2), inner.last - inner.first + 3)
})

test('pid_step_response: null без FFT, без данных оси и для несуществующего набора', () => {
    const tar = step_target(10 * RATE_HZ, 1, 50, 200)
    const res = load_pid(closed_loop_log(tar, first_order(tar, TAU, DELAY)), env)
    const axis = res.axes[0]
    assert.equal(pid_step_response(axis, 0, [0, 100]), null, 'FFT не посчитан')
    pid_run_batch_fft(axis.sets, 512)
    assert.notEqual(pid_step_response(axis, 0, [0, 100]), null)
    assert.equal(pid_step_response(axis, 1, [0, 100]), null, 'набора 1 нет')
    assert.equal(pid_step_response(res.axes[1], 0, [0, 100]), null, 'у PIDP нет данных')
})

test('pid_step_response: частота лога ниже 100 Гц — null и причина в warnings вместо нулевого отклика (дефект upstream 5)', () => {
    // LOG_BITMASK без ATTITUDE_FAST: Copter пишет PIDx и RATE с частотой 10 Гц. В upstream шумовая оценка «до 25 Гц»
    // при частоте не выше 50 Гц накрывала весь спектр (отклик нулевой), при 50–100 Гц выходила за массив спектра.
    // Порог — 100 Гц с запасом 1 %: 98.97 Гц не считается (в тексте «98.9», без округления вверх), а лог около 100 Гц
    // (99.95 и 100.05 — дрожание меток) считается всегда
    assert.equal(PID_STEP_MIN_RATE * PID_STEP_RATE_MARGIN, 99)
    for (const hz of [10, 40, 80, 98.97, 99.95, 100.05, 125]) {
        const n = 300 * hz
        const tar = step_target(n, 1, 50, 200)
        const act = first_order(tar, TAU, 2)
        const zero = () => 0
        const TimeUS = tar.map((_, k) => Math.round(k / hz * 1e6))
        const msg = pid_msg(TimeUS, { Tar: (k) => tar[k] / R2D, Act: (k) => act[k] / R2D, Err: zero, P: zero, I: zero, D: zero, FF: zero })
        const axis = load_pid(fake_log({ messages: { PIDR: msg }, params: base_params() }), env).axes[0]
        pid_run_batch_fft(axis.sets, 512)
        assert.ok(Math.abs(axis.sets.FFT.average_sample_rate - hz) / hz < 1e-3, 'частота ' + axis.sets.FFT.average_sample_rate)
        const warnings = []
        const res = pid_step_response(axis, 0, [0, 1e9], warnings)
        if (hz < 99) {
            assert.equal(res, null, hz + ' Гц: отклик не считается')
            assert.equal(warnings.length, 1, hz + ' Гц: причина')
            assert.match(warnings[0], /ATTITUDE_FAST/)
            assert.match(warnings[0], new RegExp('PIDR: частота лога ' + String(Math.floor(hz * 10) / 10).replace('.', '\\.') + ' Гц ниже 100 Гц'))
            // Без массива предупреждений — тот же null
            assert.equal(pid_step_response(axis, 0, [0, 1e9]), null)
        } else {
            assert.notEqual(res, null, hz + ' Гц: отклик есть')
            assert.ok(res.windows.length > 0)
            assert.deepEqual(warnings, [])
        }
    }
})

test('порог частоты отклика: core/checks.js (шаг 0) повторяет PID_STEP_MIN_RATE и PID_STEP_RATE_MARGIN из core/pid.js', () => {
    // checks.js грузится раньше pid.js и под Node без него, поэтому числа повторены — здесь их связь
    const { check_rules } = require('../TuneWizard/core/checks.js')
    assert.equal(check_rules.pid_log_min_rate_hz, PID_STEP_MIN_RATE)
    assert.equal(check_rules.pid_log_rate_margin, PID_STEP_RATE_MARGIN)
})
