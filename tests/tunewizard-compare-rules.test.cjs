// Правила сверки мастера с FilterReview как есть (upstream_plan и check_upstream из tests/tunewizard-compare.cjs)
// без браузера, на синтетических снимках: ρ < 1 (сетка бодэ короче), raw-лог из двух пакетов (время окон сдвигается
// неравномерно), batch-лог, кончающийся ровно на границе пакета (дефекты 1 и 5 вместе), и лог без действующих дефектов.
// Снимки «мастера» строит настоящая run_batch_fft из core/gyro.js; FilterReview как есть — она же на пакетах, у которых
// частота заменена частотой первого пакета (ровно это и усреднял upstream).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const repo = path.resolve(__dirname, '..')
globalThis.FFTJS = require('../modules/fft.js/lib/fft.js')
for (const file of ['Libraries/Array_Math.js', 'Libraries/fft.js', 'TuneWizard/core/log.js', 'TuneWizard/core/gyro.js']) {
    const full = path.join(repo, file)
    vm.runInThisContext(fs.readFileSync(full, 'utf8'), { filename: full })
}
const { upstream_plan, check_upstream, wizard_trace_name } = require('./tunewizard-compare.cjs')

// Пакеты: частоты rates, длина length отсчётов (нули — амплитуды здесь не важны), начало пакета b — start + b·gap_s
function batches(rates, length, gap_s = 1.024) {
    return rates.map((rate, b) => ({ sample_time: 10 + b * gap_s, sample_rate: rate, x: new Array(length).fill(0), y: new Array(length).fill(0), z: new Array(length).fill(0) }))
}

// Сведения о пакетах как у filterreview_gyro
function describe(data_set, FFT) {
    return {
        index: 0,
        rates: data_set.map((b) => b.sample_rate),
        lengths: data_set.map((b) => b.x.length),
        average_sample_rate: FFT.average_sample_rate,
        window_size: FFT.window_size,
        windows: FFT.time.length,
        max_bin: FFT.bins[FFT.bins.length - 1],
    }
}

// Синтетический контекст upstream_plan: один гироскоп, только «до фильтров».
// up_set — пакеты FilterReview как есть, fix_set — FilterReview с исправлениями и мастера (при дефекте 5 на пакет больше);
// filters_differ — отличаются ли оценка «после» и бодэ (notch в герцах при другой частоте дискретизации)
function context({ type, up_set, fix_set = up_set, window_size, filters_differ = true }) {
    const opts = { type, window_size, window_per_batch: 1 }
    const FFT_up = run_batch_fft(up_set.map((b) => ({ ...b, sample_rate: up_set[0].sample_rate })), opts)
    const FFT_fix = run_batch_fft(fix_set, opts)
    const level = (bins, shift) => bins.map((f, i) => -60 + 3 * Math.sin(i / 7) + shift)
    const est_shift = filters_differ ? -1.001 : -1
    const empty = { x: [], y: [] }
    const up_traces = [
        { x: FFT_up.bins, y: level(FFT_up.bins, 0) }, { x: FFT_up.bins, y: level(FFT_up.bins, 0) }, { x: FFT_up.bins, y: level(FFT_up.bins, 0) },
        empty, empty, empty,
        { x: FFT_up.bins, y: level(FFT_up.bins, -1) }, { x: FFT_up.bins, y: level(FFT_up.bins, -1) }, { x: FFT_up.bins, y: level(FFT_up.bins, -1) },
    ]
    const wz_traces = {}
    for (let a = 0; a < 3; a++) {
        wz_traces[wizard_trace_name(0, 0, a)] = { x: FFT_fix.bins, y: level(FFT_fix.bins, 0) }
        wz_traces[wizard_trace_name(0, 2, a)] = { x: FFT_fix.bins, y: level(FFT_fix.bins, est_shift) }
    }
    const rows = (n) => Array.from({ length: 5 }, (_, j) => new Array(n).fill(-50 - j))
    const bode = (FFT, wrap, amp_shift) => {
        const x = array_from_range(0, FFT.bins[FFT.bins.length - 1], 0.05)
        return { inst: 0, wrap, x, amp: x.map((f) => -f / 100 + amp_shift), phase: x.map((f) => -f / 10 + amp_shift) }
    }
    const amp_shift = filters_differ ? 0.01 : 0
    const est = [0, 1, 2].map(() => ({ x: FFT_fix.bins, y: level(FFT_fix.bins, est_shift) }))
    return {
        up: {
            gyro: { type, pre: describe(up_set, FFT_up), post: null, batches: [up_set.length] },
            snap: { traces: up_traces, heat: { x: FFT_up.time, y: FFT_up.bins, z: rows(FFT_up.bins.length), rows: FFT_up.time.length } },
            bode: bode(FFT_up, false, 0),
            bode_other: bode(FFT_up, true, 0),
        },
        fix: { gyro: { type, pre: describe(fix_set, FFT_fix), post: null, batches: [fix_set.length] } },
        sensor: 0,
        settings: { window_per_batch: '1' },
        wz_snap: { traces: wz_traces, heat: { x: FFT_fix.time, y: FFT_fix.bins, z: rows(FFT_fix.bins.length), rows: FFT_fix.time.length } },
        wz_step2: { ...bode(FFT_fix, false, amp_shift), est },
        wz_step2_other: { ...bode(FFT_fix, true, amp_shift), est },
        wz_rates: { pre: FFT_fix.average_sample_rate, post: null },
    }
}

// План и проверка всех массивов; возвращает { plan, checked, by_name }
function run(ctx) {
    const plan = upstream_plan(ctx)
    const checked = plan.items.map((item) => ({ item, ...check_upstream(item) }))
    const by_name = (fragment) => checked.find((c) => c.item.name.includes(fragment))
    return { plan, checked, by_name }
}

function assert_all_ok({ plan, checked }) {
    for (const c of plan.checks) {
        assert.ok(c.ok, c.line)
    }
    for (const c of checked) {
        assert.ok(c.ok, c.line)
    }
}

test('upstream_plan: ρ < 1 — сетка бодэ мастера короче, общее начало совпадает; частоты ×ρ, время +Δ', () => {
    // Первый пакет быстрее остальных: upstream брал 1001 Гц, исправленная средняя 1000.25 Гц
    const ctx = context({ type: 'batch', up_set: batches([1001, 1000, 1000, 1000], 1024), window_size: 1024 })
    const result = run(ctx)
    assert.deepEqual(result.plan.active, [1])
    assert_all_ok(result)
    const bode_x = result.by_name('фаза развёрнута · бодэ · x')
    assert.equal(bode_x.item.rule.kind, 'grow')
    assert.ok(bode_x.item.rule.n < 0, 'сетка короче: n = ' + bode_x.item.rule.n)
    assert.match(bode_x.line, /короче на \d+/)
    assert.equal(result.by_name('· до · X · x').item.rule.kind, 'scale')
    assert.ok(result.by_name('· до · X · x').item.rule.k < 1)
    assert.equal(result.by_name('спектрограмма · x').item.rule.kind, 'shift')
    assert.equal(result.by_name('· до · X · y').item.rule.kind, 'same')
    assert.ok(result.by_name('· до · X · y').same)
})

test('upstream_plan: raw-лог из двух пакетов — время спектрограммы и спектры «до» только в отчёте, частоты ×ρ', () => {
    // Два raw-пакета по 2048 отсчётов со своими частотами и окном 256: по 15 окон на пакет
    const ctx = context({ type: 'raw', up_set: batches([1000, 1003], 2048, 5), window_size: 256 })
    const result = run(ctx)
    assert.deepEqual(result.plan.active, [1])
    assert_all_ok(result)
    const time = result.by_name('спектрограмма · x')
    assert.equal(time.item.rule.kind, 'report')
    assert.match(time.item.reason, /raw/)
    // Сдвиг времени у окон действительно разный — правило «+Δ» здесь дало бы ложное расхождение
    const shifts = ctx.wz_snap.heat.x.map((t, j) => t - ctx.up.snap.heat.x[j])
    assert.ok(Math.max(...shifts) - Math.min(...shifts) > 1e-6, 'разброс сдвига ' + (Math.max(...shifts) - Math.min(...shifts)))
    assert.equal(result.by_name('· до · X · y').item.rule.kind, 'report')
    assert.equal(result.by_name('спектрограмма · z[0]').item.rule.kind, 'report')
    assert.equal(result.by_name('· до · X · x').item.rule.kind, 'scale')
    assert.equal(result.by_name('фаза развёрнута · бодэ · x').item.rule.kind, 'grow')
})

test('upstream_plan: batch-лог кончается на границе пакета (дефекты 1 и 5) — частоты сверяются с эталоном, без исключения', () => {
    // FilterReview как есть теряет последний полный пакет; у эталона и мастера он есть, и средняя частота по пяти пакетам
    // не равна пересчёту по четырём пакетам FilterReview как есть
    const up_set = batches([1000, 1002, 1001, 999], 1024)
    const fix_set = [...up_set, ...batches([1000, 1002, 1001, 999, 1003], 1024).slice(4)]
    const ctx = context({ type: 'batch', up_set, fix_set, window_size: 1024 })
    const result = run(ctx)
    assert.deepEqual(result.plan.active, [1, 5])
    assert_all_ok(result)
    assert.equal(result.plan.checks.length, 1, 'только мастер против эталона: пересчёт по пакетам FilterReview как есть не применим')
    assert.ok(result.checked.every((c) => c.item.rule.kind == 'report'), 'при двух дефектах — только отчёт')
    assert.match(result.by_name('спектрограмма · строк').line, /отличается/)
})

test('upstream_plan: без действующих дефектов всё совпадает с FilterReview как есть', () => {
    const ctx = context({ type: 'batch', up_set: batches([1000, 1000, 1000, 1000], 1024), window_size: 1024, filters_differ: false })
    const result = run(ctx)
    assert.deepEqual(result.plan.active, [])
    assert_all_ok(result)
    assert.ok(result.checked.every((c) => (c.item.rule.kind == 'same') && c.same))
})

test('check_upstream: «+Δ» по оси времени — абсолютный допуск 1e-9 с, относительный скрыл бы сдвиг в 86 мкс', () => {
    const up = [100, 200, 560]
    const wz = up.map((t) => t - 86e-6)
    const shifted = check_upstream({ name: 'время', up, wz, rule: { kind: 'shift', d: -86e-6 }, reason: 'r', abs: 1e-9 })
    assert.ok(shifted.ok, shifted.line)
    const unshifted = check_upstream({ name: 'время', up, wz, rule: { kind: 'same' }, reason: 'r', abs: 1e-9 })
    assert.equal(unshifted.ok, false, 'без сдвига 86 мкс — расхождение')
    // Относительный допуск 1e-6·560 с = 0.56 мс пропустил бы этот сдвиг
    assert.equal(check_upstream({ name: 'время', up, wz, rule: { kind: 'same' }, reason: 'r' }).ok, true)
})
