// Правила сверки мастера с PIDReview как есть (upstream_plan и check_upstream из tests/tunewizard-pid-compare.cjs)
// без браузера, на синтетических сведениях: действует только дефект 2 (пакет перед разрывом и пакет до конца лога),
// дефект 2 сменил длину отклика и бин шумовой оценки, действуют дефекты 1, 3 и 5. Пакеты «PIDReview как есть» режет
// настоящая split_into_batches из PIDReview/PIDReview.js, «с исправлениями» — pid_split_into_batches из core/pid.js;
// отклики (окна, среднее, время) — синтетические.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const repo = path.resolve(__dirname, '..')
const pid_js = path.join(repo, 'TuneWizard/core/pid.js')
vm.runInThisContext(fs.readFileSync(pid_js, 'utf8'), { filename: pid_js })
// split_into_batches upstream — текст функции из PIDReview, без остального файла (он требует DOM)
const pidreview = fs.readFileSync(path.join(repo, 'PIDReview/PIDReview.js'), 'utf8')
const upstream_split = vm.runInThisContext('(' + pidreview.match(/function split_into_batches\([\s\S]*?\r?\n\}\r?\n/)[0] + ')')
const { upstream_plan, check_upstream } = require('./tunewizard-pid-compare.cjs')

const WINDOW = 512

// Время отсчётов: участки [начало, конец) в секундах с частотой rate
function sample_times(segments, rate) {
    const out = []
    for (const [t0, t1] of segments) {
        const n = Math.round((t1 - t0) * rate)
        for (let k = 0; k < n; k++) {
            out.push(Math.round((t0 + k / rate) * 1e6) * 1e-6)
        }
    }
    return out
}

// Сведения оси как у pidreview_info: пакеты — как режет split (upstream или мастер), средняя частота FFT — по пакетам
// не короче окна (сумма частот / их число, как pid_run_batch_fft), бин шумовой оценки — lpf_index
function axis_info(split, time, sets, lpf_index = 32) {
    const batches = split([{ params: { sets } }], 0, time)
    const by_set = []
    for (const b of batches) {
        (by_set[b.param_set] ??= []).push({ length: b.batch_end - b.batch_start, rate: b.sample_rate, t0: time[b.batch_start],
                                             t_prev: time[b.batch_end - 2], t1: time[b.batch_end - 1] })
    }
    const long = batches.filter((b) => (b.batch_end - b.batch_start) >= WINDOW)
    return {
        have_data: true,
        end_time: time.at(-1),
        sets: sets.map((s) => ({ start: s.start_time, end: s.end_time })),
        batches: Array.from(by_set, (set) => set ?? null),
        rate: 1 / (long.length / long.reduce((sum, b) => sum + b.sample_rate, 0)),
        window_size: WINDOW,
        lpf_index,
    }
}

// Отклик: windows окон длины len (значения — от номеров окна и отсчёта), среднее — их среднее, время — j·(1/частота)
function response(rate, windows, len) {
    const time = Array.from({ length: len }, (_, j) => j * (1 / rate))
    const list = Array.from({ length: windows }, (_, k) => Array.from({ length: len }, (_, j) => (k + 1) * j / len))
    const mean = time.map((_, j) => list.reduce((sum, w) => sum + w[j], 0) / windows)
    return { time, windows: list, mean }
}

// Контекст upstream_plan для одной оси PIDR (PIDP и PIDY без данных) по времени отсчётов и наборам параметров.
// Каждый набор — windows окон; длина отклика и бин шумовой оценки PIDReview как есть — up_len и up_lpf
// (по умолчанию как у эталона и мастера)
function context({ time, sets = [{ start_time: 0, end_time: Infinity }], interval = [0, 1e9], windows = 5, len = 201, up_len = len, lpf = 32, up_lpf = lpf }) {
    const up_info = axis_info(upstream_split, time, sets, up_lpf)
    const fix_info = axis_info(pid_split_into_batches, time, sets, lpf)
    const pr_set = (r) => ({ windows: r.windows, windows_x: [r.time], separators_ok: true, mean_x: r.time, mean_y: r.mean })
    const up_r = response(up_info.rate, windows, up_len)
    const fix_r = response(fix_info.rate, windows, len)
    const none = { have_data: false }
    return {
        up: { info: { PIDR: up_info, PIDP: none, PIDY: none }, reference: { PIDR: { sets: sets.map(() => pr_set(up_r)) }, PIDP: null, PIDY: null } },
        fix: { info: { PIDR: fix_info, PIDP: none, PIDY: none }, reference: { PIDR: { sets: sets.map(() => pr_set(fix_r)) }, PIDP: null, PIDY: null } },
        wizard: { axes: { PIDR: { have_data: true, rate: fix_info.rate, window_size: WINDOW, sets: sets.map(() => fix_r) }, PIDP: none, PIDY: none } },
        interval,
    }
}

// Проверить план: все массивы и проверки механизма подтверждаются → { plan, checked }
function run(ctx) {
    const plan = upstream_plan(ctx)
    const checked = plan.items.map(check_upstream)
    return { plan, checked, failed: [...plan.checks.filter((c) => !c.ok), ...checked.filter((c) => !c.ok)].map((c) => c.line) }
}

test('upstream_plan PIDReview: только дефект 2 — пакеты на отсчёт длиннее (до конца лога — на два), окна и среднее те же, время ×k', () => {
    // Два пакета: 0–30 с и 31–61 с (пропуск 1 с). Upstream: 11999 и 11998 отсчётов, мастер — по 12000
    const ctx = context({ time: sample_times([[0, 30], [31, 61]], 400) })
    const { plan, checked, failed } = run(ctx)
    assert.deepEqual(plan.active, [{ defect: 2, axes: ['PIDR'] }])
    assert.deepEqual(plan.inactive.map((d) => d.defect), [1, 3, 5, 6])
    assert.equal(plan.inactive[0].why, 'один набор параметров')
    assert.deepEqual(ctx.up.info.PIDR.batches[0].map((b) => b.length), [11999, 11998])
    assert.equal(plan.checks.length, 1)
    assert.match(plan.checks[0].line, /11999 → 12000 отсчётов, 11998 → 12000 отсчётов \(\+2, до конца лога\)/)
    assert.deepEqual(failed, [])
    assert.deepEqual(plan.items.map((i) => i.rule.kind), ['scale', 'same', 'scale', 'same', 'same'])
    assert.deepEqual(checked.map((c) => c.same), [false, true, false, true, true], 'частота и время отличаются, окна и среднее — нет')
    assert.match(checked[2].line, /время — отличается .*дефект 2/)

    // Мастер, у которого ось времени как у PIDReview как есть, или окном меньше — не подтверждается
    const unscaled = context({ time: sample_times([[0, 30], [31, 61]], 400) })
    unscaled.wizard.axes.PIDR.sets[0].time = unscaled.up.reference.PIDR.sets[0].mean_x
    assert.equal(run(unscaled).failed.length, 1)
    const fewer = context({ time: sample_times([[0, 30], [31, 61]], 400) })
    fewer.wizard.axes.PIDR.sets[0] = response(fewer.fix.info.PIDR.rate, 4, 201)
    assert.ok(run(fewer).failed.some((line) => line.includes('окон')))
    // Частота пакета PIDReview как есть, не равная формуле upstream, — проверка механизма не проходит
    const odd = context({ time: sample_times([[0, 30], [31, 61]], 400) })
    odd.up.info.PIDR.batches[0][0].rate *= 1.001
    assert.equal(run(odd).plan.checks[0].ok, false)
})

test('upstream_plan PIDReview: дефект 2 сменил длину отклика и бин шумовой оценки — только отчёт с причиной', () => {
    // Как у RATE лога пользователя: исправленная частота 399.99999999999994 Гц — бин 33 вместо 32, длина 200 вместо 201
    const ctx = context({ time: sample_times([[0, 30]], 400), len: 200, up_len: 201, lpf: 33, up_lpf: 32 })
    const { plan, checked, failed } = run(ctx)
    assert.deepEqual(plan.active.map((a) => a.defect), [2])
    assert.deepEqual(failed, [])
    assert.ok(plan.items.every((i) => i.rule.kind == 'report'))
    assert.match(plan.items[0].reason, /бин шумовой оценки \(32 → 33\), длину отклика набора 1 \(201 → 200\)/)
    assert.ok(checked.find((c) => c.line.startsWith('PIDR · набор 1 · время')).line.includes('длина 201 → 200'))
})

test('upstream_plan PIDReview: дефекты 1, 3, 5 — по данным PIDReview как есть, правила — только отчёт', () => {
    // Дефект 1: смены 10 с и 10.9 с — у upstream пакет набора 2 начинается в 10.0025 с, раньше набора
    const sets = [{ start_time: 0, end_time: 10 }, { start_time: 10.9, end_time: Infinity }]
    const d1 = run(context({ time: sample_times([[0, 20]], 400), sets }))
    assert.deepEqual(d1.plan.active.map((a) => a.defect), [1, 2])
    assert.deepEqual(d1.plan.checks, [])
    assert.ok(d1.plan.items.every((i) => (i.rule.kind == 'report') && (i.reason.startsWith('дефекты 1, 2'))))
    assert.deepEqual(d1.failed, [])

    // Дефект 3: интервал 40–55 с, пакет 0–30 с целиком до него
    const d3 = run(context({ time: sample_times([[0, 30], [31, 61]], 400), interval: [40, 55] }))
    assert.deepEqual(d3.plan.active.map((a) => a.defect), [2, 3])
    assert.ok(d3.plan.items.every((i) => i.rule.kind == 'report'))
    // Интервал задевает оба пакета — дефект 3 не действует
    assert.deepEqual(run(context({ time: sample_times([[0, 30], [31, 61]], 400), interval: [20, 40] })).plan.active.map((a) => a.defect), [2])

    // Дефект 5: PID с частотой 10 Гц (LOG_BITMASK без ATTITUDE_FAST)
    const d5 = run(context({ time: sample_times([[0, 600]], 10), windows: 0 }))
    assert.deepEqual(d5.plan.active.map((a) => a.defect), [2, 5])
    assert.deepEqual(d5.failed, [])
})
