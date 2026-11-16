// Шаг 6 задачи 1: ранний отклик КИХ (у крена [лог4] 0.11–0.16 уже на 5 мс — физически невозможно) — откуда он и
// насколько смещает нарастание 10–90 %.
//   А. REAL_NOISE (генератор теста как есть, пилот — ступеньки со сглаживанием 20 мс): отклик КИХ на 5 мс против
//      правды (0), ошибка нарастания, как часто t10 < 10 мс; разброс нарастания по суррогатам.
//   Б. Та же синтетика, но цель — как в Acro «Rate Loop Only» 4.7.2 (ArduCopter/mode_acro.cpp → input_rate_bf_roll_
//      pitch_yaw_2_rads → attitude_command_model, AC_AttitudeControl.cpp:1108): ступеньки стика через предел
//      ускорения ATC_ACC_R_MAX = 1100 °/с² и рывка 1100 / (10·dt) = 44000 °/с³ (ACRO_RP_RATE_TC = 0 → input_tc
//      = 10·dt), затем FLTT 20 Гц (цель Tar в PIDx — после FLTT). Упрощение: ускорение к (желаемая − цель)·k_v,
//      k_v = рывок / ускорение, с пределами ускорения и рывка.
//   В. [лог4]: отклик на 2.5–20 мс при гребне 1e-4…1e-1; КИХ с отрицательными задержками (−40…+399 отсчётов) — если
//      «факт» опережает «цель» в записи, у отрицательных задержек будет резкий отклик; доля энергии цели выше 10 Гц.
// Запуск: node step6_early.cjs <репозиторий> [лог] [части, «АБВ»]
'use strict'
const path = require('node:path')
const lib = require('./lib.cjs')
const repo = process.argv[2]
const log_path = process.argv[3] ?? path.join(repo, 'TuneWizard/logs/2 01.01.1970 2-00-00.bin')
const parts = process.argv[4] ?? 'АБВ'
const { fmt } = lib

// simulate из теста с готовой командой пилота req (рад/с): копия тела simulate, кроме строки pilot(...)
function simulate_req(S, g, o, req) {
    const n = req.length
    const pid = S.make_pid(g)
    let plant = S.make_plant(o.plant)
    const gd = S.gauss(S.lcg(o.seed * 13 + 5))
    const gt = S.gauss(S.lcg(o.seed * 19 + 1))
    const gn = S.gauss(S.lcg(o.seed * 17 + 11))
    const SUB = 4
    const ad = 1 - Math.exp(-2 * Math.PI * 2 * S.DT / SUB)
    const sd = (o.dist_dps2 ?? 30) / S.R2D * Math.sqrt((2 - ad) / ad)
    let lp = 0
    const dist = () => {
        lp += ad * (gd() * sd - lp)
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

// Цель Acro «Rate Loop Only»: ступеньки стика → предел ускорения и рывка → FLTT (первый порядок)
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

const BANDS = [[0, 4], [4, 10], [10, 1000]]
function target_shares(pieces, rate) {
    const N = 512
    const w = hanning(N)
    const fft = new FFTJS(N)
    const out = fft.createComplexArray()
    const psd = new Float64Array(N / 2 + 1)
    for (const p of pieces) {
        for (let s = 0; s + N <= p.tar.length; s += N / 2) {
            const buf = new Array(N)
            for (let i = 0; i < N; i++) buf[i] = p.tar[s + i] * w[i]
            fft.realTransform(out, buf)
            for (let k = 0; k <= N / 2; k++) psd[k] += out[2 * k] ** 2 + out[2 * k + 1] ** 2
        }
    }
    let total = 0
    for (let k = 1; k <= N / 2; k++) total += psd[k]
    return BANDS.map(([a, b]) => {
        let s = 0
        for (let k = 1; k <= N / 2; k++) {
            const fq = k * rate / N
            if (fq >= a && fq < b) s += psd[k]
        }
        return 100 * s / total
    })
}

// КИХ с отрицательными задержками: act[k] = Σ_{m=−neg}^{pos} h[m]·tar[k − m] (гребень ridge·c_rr(0), за краями нули)
function fir_noncausal(segments, rate, neg, pos, ridge = 1e-3) {
    const M = neg + pos + 1
    const crr = new Float64Array(M)
    const cry = new Float64Array(M)
    for (const s of segments) {
        const r = s.tar, y = s.act, n = r.length
        for (let lag = 0; lag < M && lag < n; lag++) {
            let a = 0
            for (let k = lag; k < n; k++) a += r[k] * r[k - lag]
            crr[lag] += a
        }
        for (let j = 0; j < M; j++) {
            const m = j - neg
            let b = 0
            if (m >= 0) {
                for (let k = m; k < n; k++) b += y[k] * r[k - m]
            } else {
                for (let k = 0; k + (-m) < n; k++) b += y[k] * r[k - m]
            }
            cry[j] += b
        }
    }
    const L = lib.chol_factor(crr, M, ridge * crr[0])
    const x = lib.chol_apply(L, M, cry)
    return { h: x, neg }
}

function early_stats(title, S, make_sim, seeds) {
    const truth = S.truth_step(S.G0, S.PLANT_NORMAL)
    const tm = pidtune_step_metrics(truth.time, truth.y)
    const t10_true = pidtune_crossing(truth.time, truth.y, truth.y.length, 0.1)
    const rows = []
    const e5 = [], erise = [], srise = [], res = [], early = []
    let shares = null
    for (const seed of seeds) {
        const sim = make_sim(seed)
        const { seg, fir, metrics } = S.measure(sim, S.G0)
        const n = lib.surrogates(seg.segments, seg.rate_hz, fir, 1, 32, 512)
        const t10 = pidtune_crossing(fir.time, fir.step, fir.step.length, 0.1)
        const er = (metrics.rise_s - tm.rise_s) * 1000
        e5.push(fir.step[2]); erise.push(er); srise.push(n.sigma.rise_s * 1000); res.push(lib.residual_pct(seg.segments, fir)); early.push(t10 < 0.010)
        if (shares == null) shares = target_shares(seg.segments, seg.rate_hz)
        rows.push('  зерно ' + String(seed).padStart(2) + ': остаток ' + fmt(res[res.length - 1], 1) + ' %, отклик на 2.5/5/10 мс ' + fmt(fir.step[1]) + '/' + fmt(fir.step[2]) + '/' + fmt(fir.step[4]) +
                  ', t10 ' + fmt(t10 * 1000, 1) + ' мс (правда ' + fmt(t10_true * 1000, 1) + '), нарастание ' + fmt(metrics.rise_s * 1000, 1) + ' мс (правда ' + fmt(tm.rise_s * 1000, 1) +
                  ', ошибка ' + fmt(er, 1) + ', ± по суррогатам ' + fmt(n.sigma.rise_s * 1000, 1) + '), σ отклика ' + fmt(n.sigma_step, 3) + ', пик ' + fmt(metrics.peak, 3) + ' (правда ' + fmt(tm.peak, 3) + ')')
    }
    console.log('\n## ' + title)
    console.log('  цель по полосам 0–4 / 4–10 / > 10 Гц: ' + shares.map((x) => fmt(x, 2)).join(' / ') + ' %')
    console.log(rows.join('\n'))
    console.log('  итог: отклик на 5 мс ' + lib.range_of(e5) + ' (правда 0), ошибка нарастания ' + lib.range_of(erise, 1) + ' мс (RMS ' + fmt(lib.rmsq(erise), 1) + '), ± нарастания по суррогатам (RMS) ' +
                fmt(lib.rmsq(srise), 1) + ' мс; t10 < 10 мс — ' + early.filter(Boolean).length + ' из ' + seeds.length)
}

async function main() {
    lib.load_core(repo, parts.includes('В'))
    const S = lib.load_synth()
    const RN = { dur_s: 80, turb_dps2: 3000, dist_dps2: 500 }
    const SEEDS = [3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97]
    if (parts.includes('А')) {
        // Проверка копии simulate: с командой pilot() — те же числа, что у simulate теста
        const a = S.simulate(S.G0, { ...RN, seed: 3, plant: S.PLANT_NORMAL })
        const b = simulate_req(S, S.G0, { ...RN, seed: 3, plant: S.PLANT_NORMAL }, S.pilot(Math.round(80 * 400), 3, 0.3))
        let d = 0
        for (let k = 0; k < a.Act.length; k++) d = Math.max(d, Math.abs(a.Act[k] - b.Act[k]), Math.abs(a.Tar[k] - b.Tar[k]))
        console.log('# копия simulate: наибольшая разница Tar/Act с simulate теста ' + d.toExponential(1))
        early_stats('А. REAL_NOISE ' + JSON.stringify(RN) + ', пилот генератора теста (24 зерна)', S, (seed) => S.simulate(S.G0, { ...RN, seed, plant: S.PLANT_NORMAL }), SEEDS)
    }
    if (parts.includes('Б')) {
        const n = Math.round(RN.dur_s * 400)
        early_stats('Б. Цель как в Acro «Rate Loop Only» 4.7.2 (ускорение 1100 °/с², рывок 44000 °/с³, FLTT 20 Гц), шум REAL_NOISE (8 зёрен)', S,
                    (seed) => simulate_req(S, S.G0, { ...RN, seed, plant: S.PLANT_NORMAL }, acro_target(S, n, seed)), SEEDS.slice(0, 8))
        early_stats('Б2. Та же цель, шум как в тестах (турбулентность 300, без низкочастотного возмущения 500) (8 зёрен)', S,
                    (seed) => simulate_req(S, S.G0, { dur_s: 80, seed, plant: S.PLANT_NORMAL }, acro_target(S, n, seed)), SEEDS.slice(0, 8))
    }
    if (parts.includes('В')) {
        const L = await lib.load_log(log_path)
        console.log('\n## В. ' + path.basename(log_path) + ', 289–370 с')
        for (const axis of ['roll', 'pitch', 'yaw']) {
            const A = lib.log_axis(L, axis, [289, 370])
            const sh = target_shares(A.seg.segments, A.rate)
            console.log('\n' + axis + ': цель по полосам 0–4 / 4–10 / > 10 Гц: ' + sh.map((x) => fmt(x, 3)).join(' / ') + ' %')
            for (const ridge of [1e-4, 1e-3, 1e-2, 1e-1]) {
                const f = pidtune_fir(A.seg.segments, A.rate, ridge)
                const m = pidtune_step_metrics(f.time, f.step)
                console.log('  гребень ' + ridge.toExponential(0) + ': отклик на 2.5/5/10/15/20 мс ' + [1, 2, 4, 6, 8].map((k) => fmt(f.step[k])).join('/') + ', t10 ' +
                            fmt(pidtune_crossing(f.time, f.step, f.step.length, 0.1) * 1000, 1) + ' мс, нарастание ' + fmt(m.rise_s * 1000, 1) + ' мс, пик ' + fmt(m.peak, 3))
            }
            const nc = fir_noncausal(A.seg.segments, A.rate, 40, 399)
            const at = (m) => nc.h[m + nc.neg]
            let neg_sum = 0
            for (let m = -40; m < 0; m++) neg_sum += at(m)
            let neg10 = 0
            for (let m = -4; m < 0; m++) neg10 += at(m)
            let pos_early = 0
            for (let m = 0; m <= 2; m++) pos_early += at(m)
            console.log('  КИХ с отрицательными задержками: h[−4…−1] ' + [-4, -3, -2, -1].map((m) => fmt(at(m), 4)).join(', ') + ', h[0…3] ' + [0, 1, 2, 3].map((m) => fmt(at(m), 4)).join(', ') +
                        '; сумма h[−40…−1] ' + fmt(neg_sum, 3) + ', h[−4…−1] ' + fmt(neg10, 3) + ', h[0…2] ' + fmt(pos_early, 3) + ' (у обычного КИХ h[1…2] ' + fmt(A.fir.h[1] + A.fir.h[2], 3) + ')')
        }
    }
}
main().catch((e) => {
    console.error(e)
    process.exit(1)
})
