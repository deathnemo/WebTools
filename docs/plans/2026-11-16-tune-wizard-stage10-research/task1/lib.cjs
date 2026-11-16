// Общее для скриптов задачи 1 этапа 10 (калибровка шага 4 «Rate Loop Only»): загрузка ядра мастера и генератора
// синтетики из теста, разбор лога, суррогаты «модель КИХ + остатки блоками с возвращением» (раздел 3.1 дизайна),
// устойчивый разброс (половина размаха 16–84 процентилей), «ещё N с», решение правил с запасом (раздел 3.4).
// Скрипты — во временной папке сеанса, в git не идут. Запуск каждого: node <скрипт> "C:/Users/user/WebTools" [аргументы]
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { pathToFileURL } = require('node:url')

// Шум Node про тип модуля парсера (MODULE_TYPELESS_PACKAGE_JSON) — не наше, глушим только его
const emit = process.emitWarning
process.emitWarning = function (w, ...rest) {
    const text = String(w?.message ?? w)
    if (text.includes('MODULE_TYPELESS_PACKAGE_JSON') || text.includes('Reparsing as ES module') || (rest[0]?.code ?? rest[1]) === 'MODULE_TYPELESS_PACKAGE_JSON') {
        return
    }
    return emit.call(process, w, ...rest)
}

let repo = null
let synth = null

// Ядро мастера в глобальной области (как страница и тесты: vm.runInThisContext по порядку)
function load_core(repo_path, with_log = false) {
    repo = repo_path
    globalThis.FFTJS = require(path.join(repo, 'modules/fft.js/lib/fft.js'))
    const files = with_log
        ? ['Libraries/LogHelpers.js', 'Libraries/Array_Math.js', 'Libraries/fft.js', 'Libraries/DecodeDevID.js', 'Libraries/Param_Helpers.js',
           'TuneWizard/core/vehicle.js', 'TuneWizard/core/log.js', 'TuneWizard/core/checks.js', 'TuneWizard/core/gyro.js',
           'TuneWizard/core/tracking/Atmosphere_model.js', 'TuneWizard/core/tracking/BaseClass.js', 'TuneWizard/core/tracking/Static.js',
           'TuneWizard/core/tracking/Throttle.js', 'TuneWizard/core/tracking/RPM.js', 'TuneWizard/core/tracking/ESC.js',
           'TuneWizard/core/tracking/FFT.js', 'TuneWizard/core/tracking/Logged.js', 'TuneWizard/core/filters.js',
           'TuneWizard/core/spectrum.js', 'TuneWizard/core/metrics.js', 'TuneWizard/core/autofit.js', 'TuneWizard/core/candidates.js',
           'TuneWizard/core/lowpass.js', 'TuneWizard/core/pid.js', 'TuneWizard/core/pidtune.js']
        : ['Libraries/Array_Math.js', 'Libraries/fft.js', 'TuneWizard/core/log.js', 'TuneWizard/core/gyro.js',
           'TuneWizard/core/tracking/Atmosphere_model.js', 'TuneWizard/core/tracking/BaseClass.js', 'TuneWizard/core/tracking/Static.js',
           'TuneWizard/core/tracking/Throttle.js', 'TuneWizard/core/tracking/RPM.js', 'TuneWizard/core/tracking/ESC.js',
           'TuneWizard/core/tracking/FFT.js', 'TuneWizard/core/tracking/Logged.js', 'TuneWizard/core/filters.js', 'TuneWizard/core/spectrum.js',
           'TuneWizard/core/metrics.js', 'TuneWizard/core/autofit.js', 'TuneWizard/core/candidates.js', 'TuneWizard/core/lowpass.js',
           'TuneWizard/core/pid.js', 'TuneWizard/core/pidtune.js']
    for (const file of files) {
        const full = path.join(repo, file)
        vm.runInThisContext(fs.readFileSync(full, 'utf8'), { filename: full })
    }
}

// Генератор синтетики — как есть из tests/tunewizard-pidtune.test.cjs (от R2D до close_to): simulate, truth_step,
// measure, PLANT_NORMAL, G0 и т. д. Нужен загруженный load_core
function load_synth() {
    if (synth != null) {
        return synth
    }
    const src = fs.readFileSync(path.join(repo, 'tests/tunewizard-pidtune.test.cjs'), 'utf8')
    const from = src.indexOf('const R2D = 180 / Math.PI')
    const to = src.indexOf('function close_to(')
    vm.runInThisContext(src.slice(from, to), { filename: 'synthetic-from-test' })
    synth = {}
    for (const name of ['R2D', 'RATE_HZ', 'DT', 'simulate', 'truth_step', 'measure', 'sim_axis', 'pilot', 'make_plant', 'make_pid', 'lcg', 'gauss',
                        'PLANT_NORMAL', 'PLANT_FAST', 'PLANT_SLOW', 'G0']) {
        synth[name] = vm.runInThisContext(name)
    }
    return synth
}

// Разбор лога .bin парсером страницы
async function load_log(log_path) {
    globalThis.self = { addEventListener() {}, postMessage() {} }
    const DataflashParser = (await import(pathToFileURL(path.join(repo, 'modules/JsDataflashParser/parser.js')).href)).default
    const data = fs.readFileSync(log_path)
    const log = new DataflashParser()
    log.processData(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), [])
    const version = get_version_and_board(log)
    const params = log_params(log)
    const pid = load_pid(log, { build_type: version.build_type })
    return { log, version, params, pid, loop_rate: params.get('SCHED_LOOP_RATE') ?? 400 }
}

// Ось лога на интервале, как step4_compute_axis: набор — последний из наборов интервала с данными, отрезки, КИХ,
// режим лога, проверки (а)–(в) по-старому, метрики; регулятор лога для прогноза
function log_axis(L, axis, range) {
    const i = { roll: 0, pitch: 1, yaw: 2 }[axis]
    const source = L.pid.axes[i]
    const sets = []
    for (let k = 0; k < source.params.sets.length; k++) {
        const s = source.params.sets[k]
        if ((source.sets[k] == null) || (s.start_time >= range[1]) || (s.end_time <= range[0])) {
            continue
        }
        sets.push(k)
    }
    const set_index = sets[sets.length - 1]
    const set = source.params.sets[set_index]
    const seg = pidtune_segments(source, set_index, range)
    const rate = seg.rate_hz
    const fir = pidtune_fir(seg.segments, rate)
    const mode = pidtune_log_mode(L.log, L.params, L.version, range, axis, rate)
    const quality = pidtune_quality(seg.segments, rate, fir, { rate_only: mode.rate_only })
    const metrics = pidtune_step_metrics(fir.time, fir.step)
    const gains = { P: set.KP, I: set.KI, D: set.KD, FF: set.FF ?? 0, DFF: set.D_FF ?? 0 }
    const filters_log = { flte: set.Error_filter, fltd: set.D_filter }
    const grid = pidtune_predict_grid(rate)
    const c_log = pidtune_controller(gains, filters_log, L.loop_rate, grid.freq, mode.i_scale)
    return { axis, index: i, source, set_index, set, seg, rate, fir, mode, quality, metrics, gains, filters_log, c_log }
}

// Детерминированный генератор mulberry32 (как будет pidtune_rng): числа в [0, 1)
function mulberry32(seed) {
    let a = seed >>> 0
    return () => {
        a = (a + 0x6D2B79F5) >>> 0
        let t = a
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

// Половина размаха между 16-м и 84-м процентилями; процентиль — линейная интерполяция по позиции q·(n − 1)
// отсортированных конечных значений; меньше двух конечных — NaN (как pidtune_spread плана)
function percentile(sorted, q) {
    const pos = q * (sorted.length - 1)
    const i = Math.floor(pos)
    const f = pos - i
    return (i + 1 < sorted.length) ? sorted[i] + f * (sorted[i + 1] - sorted[i]) : sorted[i]
}
function spread(values) {
    const v = values.filter((x) => (typeof x === 'number') && Number.isFinite(x)).sort((a, b) => a - b)
    if (v.length < 2) {
        return NaN
    }
    return (percentile(v, 0.84) - percentile(v, 0.16)) / 2
}
function sd(values) {
    const v = values.filter((x) => (typeof x === 'number') && Number.isFinite(x))
    if (v.length < 2) {
        return NaN
    }
    const m = v.reduce((a, b) => a + b, 0) / v.length
    return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1))
}
function mean(values) {
    const v = values.filter((x) => (typeof x === 'number') && Number.isFinite(x))
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN
}
function rmsq(values) {
    const v = values.filter((x) => (typeof x === 'number') && Number.isFinite(x))
    return v.length ? Math.sqrt(v.reduce((a, b) => a + b * b, 0) / v.length) : NaN
}

// «Ещё N с» до σ goal: data_s·((σ / goal)² − 1), вверх до кратного 5; σ ≤ goal — 0
function need_s(sigma, data_s, goal = 0.05) {
    if (!(sigma > goal)) {
        return 0
    }
    return Math.ceil(data_s * ((sigma / goal) ** 2 - 1) / 5 - 1e-9) * 5
}

// ---------------------------------------------------------------- КИХ с разложением один раз

// Разложение Холецкого (col[|i − j|] + diag·[i = j]) = L·Lᵀ — то же, что внутри pidtune_toeplitz_solve
function chol_factor(col, n, diag) {
    const L = new Float64Array(n * n)
    for (let i = 0; i < n; i++) {
        const ri = i * n
        for (let j = 0; j <= i; j++) {
            const rj = j * n
            let s = col[i - j] + ((i == j) ? diag : 0)
            for (let k = 0; k < j; k++) {
                s -= L[ri + k] * L[rj + k]
            }
            if (i == j) {
                if (!(s > 0)) {
                    return null
                }
                L[ri + i] = Math.sqrt(s)
            } else {
                L[ri + j] = s / L[rj + j]
            }
        }
    }
    return L
}
function chol_apply(L, n, rhs) {
    const z = new Float64Array(n)
    for (let i = 0; i < n; i++) {
        let s = rhs[i]
        const ri = i * n
        for (let k = 0; k < i; k++) {
            s -= L[ri + k] * z[k]
        }
        z[i] = s / L[ri + i]
    }
    const x = new Float64Array(n)
    for (let i = n - 1; i >= 0; i--) {
        let s = z[i]
        for (let k = i + 1; k < n; k++) {
            s -= L[k * n + i] * x[k]
        }
        x[i] = s / L[i * n + i]
    }
    return x
}

// Только взаимная корреляция cry[m] = Σ y[k]·r[k − m] (как pidtune_correlations; автокорреляция цели у суррогатов та же)
function cry_of(pieces, taps, act_of = (p) => p.act) {
    const cry = new Float64Array(taps)
    for (const p of pieces) {
        const r = p.tar
        const y = act_of(p)
        const n = r.length
        for (let lag = 0; (lag < taps) && (lag < n); lag++) {
            let b = 0
            for (let k = lag; k < n; k++) {
                b += y[k] * r[k - lag]
            }
            cry[lag] += b
        }
    }
    return cry
}

// Подготовка КИХ набора отрезков: автокорреляция цели и разложение (гребень ridge·c_rr(0), h[0] = 0, как pidtune_fir_from)
function fir_prepare(pieces, rate, ridge = pidtune_rules.fir_ridge) {
    const taps = Math.round(pidtune_rules.fir_length_s * rate)
    const corr = pidtune_correlations(pieces, taps)
    const n = taps - 1
    const L = chol_factor(corr.crr, n, ridge * corr.crr[0])
    return { taps, n, L, n_out: Math.min(taps, Math.round(pidtune_rules.step_length_s * rate) + 1), rate }
}
// КИХ по подготовке и cry → { h, time, step } | null
function fir_solve(prep, cry) {
    if (prep.L == null) {
        return null
    }
    const x = chol_apply(prep.L, prep.n, cry.subarray(1))
    if (!x.every(Number.isFinite)) {
        return null
    }
    const h = new Float64Array(prep.taps)
    h.set(x, 1)
    const time = new Array(prep.n_out)
    const step = new Array(prep.n_out)
    let sum = 0
    for (let i = 0; i < prep.n_out; i++) {
        sum += h[i]
        time[i] = i / prep.rate
        step[i] = sum
    }
    return { h, time, step }
}

// Свёртка модели: y[k] = Σ h[m]·x[k − m], m ≥ 1, за краями — нули (как pidtune_correlations)
function conv(h, x) {
    const y = new Float64Array(x.length)
    for (let k = 0; k < x.length; k++) {
        let s = 0
        const mmax = Math.min(h.length - 1, k)
        for (let m = 1; m <= mmax; m++) {
            s += h[m] * x[k - m]
        }
        y[k] = s
    }
    return y
}

// Остаток модели «цель → факт» в % дисперсии факта (RMS остатка² / RMS факта²) по всем отрезкам
function residual_pct(segments, fir) {
    let se = 0
    let sa = 0
    for (const s of segments) {
        const y = conv(fir.h, s.tar)
        for (let k = 0; k < y.length; k++) {
            se += (s.act[k] - y[k]) ** 2
            sa += s.act[k] ** 2
        }
    }
    return 100 * se / sa
}

// Суррогаты (раздел 3.1 дизайна): модель — свёртка fir.h с целью отрезка, остаток e = факт − модель; пул — все полные
// блоки по block отсчётов из всех отрезков; суррогат — модель + блоки пула, выбранные случайно с возвращением
// (последний блок отрезка обрезается); по каждому — КИХ всех данных и двух половин (pidtune_halves) с тем же гребнем.
// Генератор — mulberry32(seed), порядок выборок: суррогат → отрезок → блок. Разложения — одно на набор данных.
// → { count, valid, pool, halves_null, halves, sigma_step, steps, metrics, sigma: { peak, rise_s, plateau }, sd: {…} } | null
function surrogates(segments, rate, fir, seed = 1, count = 32, block = 512, options = {}) {
    if (fir == null) {
        return null
    }
    const resid = segments.map((s) => {
        const y = conv(fir.h, s.tar)
        const e = new Float64Array(s.tar.length)
        for (let k = 0; k < e.length; k++) {
            e[k] = s.act[k] - y[k]
        }
        return { y, e }
    })
    const pool = []
    for (const r of resid) {
        for (let s = 0; s + block <= r.e.length; s += block) {
            pool.push(r.e.subarray(s, s + block))
        }
    }
    if (pool.length == 0) {
        return null
    }
    const prep_all = fir_prepare(segments, rate, fir.ridge)
    const halves0 = pidtune_halves(segments, pidtune_rules.window)
    const prep_h1 = fir_prepare(halves0[0], rate, fir.ridge)
    const prep_h2 = fir_prepare(halves0[1], rate, fir.ridge)
    const rand = mulberry32(seed)
    const halves = []
    const steps = []
    const metrics = []
    const diffs = []
    const firs = []
    let valid = 0
    for (let rep = 0; rep < count; rep++) {
        const sur = segments.map((s, k) => {
            const act = new Float64Array(s.tar.length)
            for (let p = 0; p < act.length; p += block) {
                const b = pool[Math.floor(rand() * pool.length)]
                for (let m = 0; (m < block) && (p + m < act.length); m++) {
                    act[p + m] = resid[k].y[p + m] + b[m]
                }
            }
            return { start_time: s.start_time, tar: s.tar, act: act, starts: s.starts }
        })
        const f_all = fir_solve(prep_all, cry_of(sur, prep_all.taps))
        const hs = pidtune_halves(sur, pidtune_rules.window)
        const f1 = fir_solve(prep_h1, cry_of(hs[0], prep_h1.taps))
        const f2 = fir_solve(prep_h2, cry_of(hs[1], prep_h2.taps))
        if ((f_all == null) || (f1 == null) || (f2 == null)) {
            continue
        }
        valid++
        halves.push(pidtune_rms_diff(f1.step, f2.step))
        steps.push(f_all.step)
        diffs.push(pidtune_rms_diff(f_all.step, fir.step))
        metrics.push(pidtune_step_metrics(f_all.time, f_all.step))
        if (options.keep_firs) {
            firs.push(f_all)
        }
    }
    if (valid < count / 2) {
        return null
    }
    const pick = (key) => metrics.map((m) => (m == null) ? NaN : (m[key] ?? NaN))
    return {
        count, valid, pool: pool.length,
        halves_null: mean(halves), halves,
        sigma_step: Math.sqrt(diffs.reduce((a, b) => a + b * b, 0) / diffs.length),
        steps, metrics, firs,
        sigma: { peak: spread(pick('peak')), rise_s: spread(pick('rise_s')), plateau: spread(pick('plateau')) },
        sd: { peak: sd(pick('peak')), rise_s: sd(pick('rise_s')), plateau: sd(pick('plateau')) },
    }
}

// Правило с запасом k·σ (раздел 3.4): перерегулирование без обрезки (пик − 1)·100, σ п. = σ пика × 100.
// Колебания (osc) — как сейчас, первым. → { decision, borderline }
function rule_decision(peak, sigma_peak, k = 1, osc = null) {
    const os = (peak - 1) * 100
    const s = k * sigma_peak * 100
    if (osc != null) {
        return { decision: 'колебания', borderline: null }
    }
    if (os > 20 + s) {
        return { decision: 'P −10 %', borderline: null }
    }
    if (os < 5 - s) {
        return { decision: 'P +10 %', borderline: null }
    }
    if ((os >= 5 + s) && (os <= 20 - s)) {
        return { decision: 'менять нечего', borderline: null }
    }
    const thr = (Math.abs(os - 20) <= Math.abs(os - 5)) ? 20 : 5
    return { decision: 'на границе ' + thr + ' %', borderline: thr }
}

// simulate из теста с готовой командой req (рад/с): копия тела simulate, кроме строки pilot(...) — проверено в
// step6_early.cjs (часть А): с req = pilot(n, seed, 0.3) разница Tar/Act с simulate теста 0
function simulate_req(S, g, o, req) {
    const n = req.length
    const pid = S.make_pid(g)
    let plant = S.make_plant(o.plant)
    const gd = S.gauss(S.lcg(o.seed * 13 + 5))
    const gt = S.gauss(S.lcg(o.seed * 19 + 1))
    const gn = S.gauss(S.lcg(o.seed * 17 + 11))
    const SUB = 4
    const ad = 1 - Math.exp(-2 * Math.PI * 2 * S.DT / SUB)
    const sdv = (o.dist_dps2 ?? 30) / S.R2D * Math.sqrt((2 - ad) / ad)
    let lp = 0
    const dist = () => {
        lp += ad * (gd() * sdv - lp)
        return lp + gt() * (o.turb_dps2 ?? 300) / S.R2D
    }
    const noise = () => gn() * (o.noise_dps ?? 0.5) / S.R2D
    const sim = { TimeUS: new Array(n), Tar: new Array(n), Act: new Array(n), Err: new Array(n), P: new Array(n), I: new Array(n), D: new Array(n), FF: new Array(n) }
    let meas = 0
    for (let k = 0; k < n; k++) {
        if ((o.plant2 != null) && (k == (n >> 1))) {
            plant = S.make_plant(o.plant2)
        }
        const r = pid(req[k], meas)
        sim.TimeUS[k] = Math.round(k * S.DT * 1e6)
        sim.Tar[k] = r.target
        sim.Act[k] = meas
        sim.Err[k] = r.error
        sim.P[k] = r.P
        sim.I[k] = r.I
        sim.D[k] = r.D
        sim.FF[k] = 0
        meas = plant(r.out, dist, noise).meas
    }
    return sim
}

// Цель как в Acro «Rate Loop Only» 4.7.2 (mode_acro.cpp → input_rate_bf_roll_pitch_yaw_2_rads → attitude_command_model):
// ступеньки стика генератора (pilot без сглаживания) → предел ускорения accel_dps2 (ATC_ACC_R_MAX) и рывка
// accel / input_tc (ACRO_RP_RATE_TC = 0 → 10·dt) → FLTT (первый порядок; Tar в PIDx — после FLTT). Упрощение
// shape_vel_accel: ускорение к (желаемая − цель)·k_v, k_v = рывок / ускорение, с пределами ускорения и рывка
function acro_target(S, n, seed, accel_dps2 = 1100, input_tc = 0.025, fltt_hz = 20) {
    const raw = S.pilot(n, seed, 0.3, 1e-9)
    const amax = accel_dps2 / S.R2D
    const jerk = amax / input_tc
    const kv = jerk / amax
    const dt = S.DT
    const out = new Float64Array(n)
    let vel = 0
    let acc = 0
    const af = (fltt_hz > 0) ? dt / (dt + 1 / (2 * Math.PI * fltt_hz)) : 1
    let f = 0
    for (let k = 0; k < n; k++) {
        const acc_target = Math.max(-amax, Math.min(amax, (raw[k] - vel) * kv))
        acc += Math.max(-jerk * dt, Math.min(jerk * dt, acc_target - acc))
        vel += acc * dt
        f += af * (vel - f)
        out[k] = f
    }
    return out
}

const fmt = (v, d = 3) => ((v == null) || !Number.isFinite(v)) ? '—' : v.toFixed(d)

// Минимум и максимум конечных
function range_of(values, d = 3) {
    const v = values.filter((x) => (typeof x === 'number') && Number.isFinite(x))
    if (v.length == 0) {
        return '—'
    }
    return fmt(Math.min(...v), d) + '–' + fmt(Math.max(...v), d)
}

module.exports = {
    load_core, load_synth, load_log, log_axis, mulberry32, spread, sd, mean, rmsq, percentile, need_s,
    chol_factor, chol_apply, cry_of, fir_prepare, fir_solve, conv, residual_pct, surrogates, rule_decision, fmt, range_of,
    simulate_req, acro_target,
}
