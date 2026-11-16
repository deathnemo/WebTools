// Шаг 5 (уточнение): osc_sigma_k с шагом 0.5 на 16 зёрнах полёта — ложные колебания (K 190: пилот теста и цель как в
// Acro) и найденные (K 550, K 600, D ×7) при min_pp = max(osc_min_pp, k·σ отклика). Запуск: node step5b_osc_fine.cjs <репозиторий>
'use strict'
const lib = require('./lib.cjs')
lib.load_core(process.argv[2])
const S = lib.load_synth()
const KS = [0, 3, 3.5, 4, 4.5, 5]
const RN = { dur_s: 80, turb_dps2: 3000, dist_dps2: 500 }
const SEEDS = [3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59]
function osc_at(fir, min_pp) {
    let n = 0
    while ((n < fir.time.length) && (fir.time[n] <= pidtune_rules.step_length_s + 1e-9)) n++
    let i0 = 0
    while ((i0 < n) && (fir.time[i0] < pidtune_rules.plateau_s[0] - 1e-9)) i0++
    return pidtune_oscillation(fir.time, fir.step, i0, n, min_pp)
}
const P = S.PLANT_NORMAL
const acro = (g, o) => lib.simulate_req(S, g, o, lib.acro_target(S, Math.round(o.dur_s * 400), o.seed))
const G_D7 = { ...S.G0, kd: S.G0.kd * 7 }
const cases = [
    ['K 190, пилот теста (ложные)', (seed) => S.simulate(S.G0, { ...RN, seed, plant: P })],
    ['K 190, цель как в Acro (ложные)', (seed) => acro(S.G0, { ...RN, seed, plant: P })],
    ['K 550 (правда 7.8 Гц, 0.147)', (seed) => S.simulate(S.G0, { ...RN, seed, plant: { ...P, K: 550 } })],
    ['K 600 (правда 7.0 Гц, 0.287)', (seed) => S.simulate(S.G0, { ...RN, seed, plant: { ...P, K: 600 } })],
    ['D ×7 (правда 11.6 Гц, 1.317)', (seed) => S.simulate(G_D7, { ...RN, seed, plant: P })],
    ['D ×7, цель как в Acro', (seed) => acro(G_D7, { ...RN, seed, plant: P })],
]
for (const [title, make] of cases) {
    const counts = KS.map(() => 0)
    const sig = []
    for (const seed of SEEDS) {
        const { seg, fir } = S.measure(make(seed), S.G0)
        const n = lib.surrogates(seg.segments, seg.rate_hz, fir, 1, 32, 512)
        sig.push(n.sigma_step)
        KS.forEach((k, i) => { if (osc_at(fir, Math.max(pidtune_rules.osc_min_pp, k * n.sigma_step)) != null) counts[i]++ })
    }
    console.log(title.padEnd(34) + ': σ отклика ' + lib.range_of(sig) + '; найдено из ' + SEEDS.length + ': ' + KS.map((k, i) => 'k ' + k + ' — ' + counts[i]).join(', '))
}
