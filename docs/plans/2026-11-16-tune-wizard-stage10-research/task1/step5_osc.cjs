// Шаг 5 задачи 1: osc_sigma_k — порог размаха колебаний на плато max(osc_min_pp, k·σ отклика). По сценариям и зёрнам:
// найдены ли колебания (pidtune_oscillation на 0.3–0.5 с, как в pidtune_step_metrics) при k из списка. Нужно: у
// объекта без колебаний (PLANT_NORMAL, G0) при реальном шуме — ни одного ложного; у плохо задемпфированного (правда
// с колебаниями на плато) — все найдены. σ отклика — по 32 суррогатам (зерно 1, блоки 512).
// Запуск: node step5_osc.cjs <репозиторий> [лог]
'use strict'
const path = require('node:path')
const lib = require('./lib.cjs')
const repo = process.argv[2]
const log_path = process.argv[3] ?? path.join(repo, 'TuneWizard/logs/2 01.01.1970 2-00-00.bin')
const { fmt } = lib
const KS = [0, 2, 3, 4, 5, 6, 8]
const RN = { dur_s: 80, turb_dps2: 3000, dist_dps2: 500 }
const SEEDS = [3, 5, 7, 11, 13, 17, 19, 23]

function osc_at(fir, min_pp) {
    let n = 0
    while ((n < fir.time.length) && (fir.time[n] <= pidtune_rules.step_length_s + 1e-9)) n++
    let i0 = 0
    while ((i0 < n) && (fir.time[i0] < pidtune_rules.plateau_s[0] - 1e-9)) i0++
    return pidtune_oscillation(fir.time, fir.step, i0, n, min_pp)
}

function scenario(S, title, make_sim, truth_g, truth_p) {
    const t = S.truth_step(truth_g, truth_p)
    const tm = pidtune_step_metrics(t.time, t.y)
    const counts = KS.map(() => 0)
    const rows = []
    for (const seed of SEEDS) {
        const { seg, fir } = S.measure(make_sim(seed), S.G0)
        const n = lib.surrogates(seg.segments, seg.rate_hz, fir, 1, 32, 512)
        const free = osc_at(fir, 0.001)
        const found = KS.map((k, i) => {
            const o = osc_at(fir, Math.max(pidtune_rules.osc_min_pp, k * n.sigma_step))
            if (o != null) counts[i]++
            return o != null
        })
        rows.push('  зерно ' + String(seed).padStart(2) + ': σ отклика ' + fmt(n.sigma_step, 3) + ', без порога ' + (free ? fmt(free.freq_hz, 1) + ' Гц, размах ' + fmt(free.amplitude_pp, 3) +
                  ' (' + fmt(free.amplitude_pp / n.sigma_step, 1) + ' σ)' : 'нет') + '; найдены при k ' + KS.map((k, i) => k + ':' + (found[i] ? 'да' : 'нет')).join(' '))
    }
    console.log('\n## ' + title + ' — правда: пик ' + fmt(tm.peak, 3) + ', колебания ' + (tm.osc ? fmt(tm.osc.freq_hz, 1) + ' Гц, размах ' + fmt(tm.osc.amplitude_pp, 3) : 'нет'))
    console.log(rows.join('\n'))
    console.log('  найдено из ' + SEEDS.length + ': ' + KS.map((k, i) => 'k ' + k + ' — ' + counts[i]).join(', '))
}

async function main() {
    lib.load_core(repo, true)
    const S = lib.load_synth()
    const P = S.PLANT_NORMAL
    const acro = (o) => lib.simulate_req(S, S.G0, o, lib.acro_target(S, Math.round(o.dur_s * 400), o.seed))
    // Регулятор лога в синтетике — G0; у «D ×7» правда и полёт — с kd ×7, КИХ меряет контур как есть
    const G_D7 = { ...S.G0, kd: S.G0.kd * 7 }
    scenario(S, 'REAL_NOISE, K 190 (без колебаний)', (seed) => S.simulate(S.G0, { ...RN, seed, plant: P }), S.G0, P)
    scenario(S, 'REAL_NOISE, цель как в Acro, K 190 (без колебаний)', (seed) => acro({ ...RN, seed, plant: P }), S.G0, P)
    scenario(S, 'REAL_NOISE, K 380 (перерегулирование 41 %, на плато колебания затухли)', (seed) => S.simulate(S.G0, { ...RN, seed, plant: { ...P, K: 380 } }), S.G0, { ...P, K: 380 })
    scenario(S, 'REAL_NOISE, K 550', (seed) => S.simulate(S.G0, { ...RN, seed, plant: { ...P, K: 550 } }), S.G0, { ...P, K: 550 })
    scenario(S, 'REAL_NOISE, K 600', (seed) => S.simulate(S.G0, { ...RN, seed, plant: { ...P, K: 600 } }), S.G0, { ...P, K: 600 })
    scenario(S, 'REAL_NOISE, цель как в Acro, K 600', (seed) => acro({ ...RN, seed, plant: { ...P, K: 600 } }), S.G0, { ...P, K: 600 })
    scenario(S, 'REAL_NOISE, D ×7', (seed) => S.simulate(G_D7, { ...RN, seed, plant: P }), G_D7, P)

    const L = await lib.load_log(log_path)
    console.log('\n## [лог4] — колебания при k (σ отклика — боевое зерно оси)')
    for (const range of [[289, 370], [300, 370]]) {
        for (const axis of ['roll', 'pitch', 'yaw']) {
            const A = lib.log_axis(L, axis, range)
            const n = lib.surrogates(A.seg.segments, A.rate, A.fir, A.index + 1, 32, 512)
            const free = osc_at(A.fir, 0.001)
            console.log('  ' + range.join('–') + ' с, ' + axis + ': σ ' + fmt(n.sigma_step, 3) + ', без порога ' + (free ? fmt(free.freq_hz, 1) + ' Гц, размах ' + fmt(free.amplitude_pp, 3) + ' (' + fmt(free.amplitude_pp / n.sigma_step, 1) + ' σ)' : 'нет') +
                        '; найдены при k ' + KS.map((k) => k + ':' + (osc_at(A.fir, Math.max(pidtune_rules.osc_min_pp, k * n.sigma_step)) ? 'да' : 'нет')).join(' '))
        }
    }
}
main().catch((e) => {
    console.error(e)
    process.exit(1)
})
