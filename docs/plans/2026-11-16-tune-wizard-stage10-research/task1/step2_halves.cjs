// Шаг 2 задачи 1: (б) / шум на синтетике с реальным шумом, 8 зёрен полёта: без смены объекта и со сменой K ×0.75 и
// ×1.25 с середины полёта (plant2). Шум — среднее (б) 32 суррогатов (блоки 512 с возвращением), зёрна суррогатов —
// список (боевое у крена — 1). Порог halves_ratio_max должен лежать между максимумом «без смены» и минимумом «со сменой».
// Запуск: node step2_halves.cjs <репозиторий> <dur:turb:dist> [зёрна суррогатов через запятую, по умолчанию 1] [K через запятую]
// TARGET=acro — цель как в Acro «Rate Loop Only» 4.7.2 (lib.acro_target) вместо пилота генератора теста
'use strict'
const lib = require('./lib.cjs')
const repo = process.argv[2]
lib.load_core(repo)
const S = lib.load_synth()
const { fmt } = lib
const ACRO = process.env.TARGET === 'acro'
const sim_of = (o) => ACRO ? lib.simulate_req(S, S.G0, o, lib.acro_target(S, Math.round(o.dur_s * 400), o.seed)) : S.simulate(S.G0, o)

const [dur_s, turb_dps2, dist_dps2] = (process.argv[3] ?? '80:300:600').split(':').map(Number)
const v = { dur_s, turb_dps2, dist_dps2 }
const sur_seeds = (process.argv[4] ?? '1').split(',').map(Number)
const ks = (process.argv[5] ?? '1,0.75,1.25').split(',').map(Number)
const SEEDS = [3, 5, 7, 11, 13, 17, 19, 23]

console.log('# REAL_NOISE-кандидат ' + JSON.stringify(v) + ', зёрна суррогатов ' + sur_seeds.join(', ') + (ACRO ? ', цель — как в Acro «Rate Loop Only» (acro_target)' : ''))
const summary = []
for (const k of ks) {
    const ratios = []
    const lines = []
    for (const seed of SEEDS) {
        const o = { ...v, seed, plant: S.PLANT_NORMAL }
        if (k != 1) {
            o.plant2 = { ...S.PLANT_NORMAL, K: S.PLANT_NORMAL.K * k }
        }
        const { seg, fir, quality } = S.measure(sim_of(o), S.G0)
        const b = quality.checks.halves.value
        const per = []
        for (const ss of sur_seeds) {
            const n = lib.surrogates(seg.segments, seg.rate_hz, fir, ss, 32, 512)
            const r = b / n.halves_null
            per.push(r)
            ratios.push(r)
        }
        const n1 = lib.surrogates(seg.segments, seg.rate_hz, fir, sur_seeds[0], 32, 512)
        lines.push('  зерно ' + String(seed).padStart(2) + ': остаток ' + fmt(lib.residual_pct(seg.segments, fir), 2) + ' %, (а) ' + fmt(quality.checks.ridge.value) + ', (б) ' + fmt(b) +
                   ', шум (зерно ' + sur_seeds[0] + ') ' + fmt(n1.halves_null) + ', σ отклика ' + fmt(n1.sigma_step) + '; (б)/шум ' + per.map((x) => fmt(x, 2)).join(' ') +
                   '; предел max(0.035, 2.5·шум) ' + fmt(Math.max(0.035, 2.5 * n1.halves_null)) + ' → ' + ((b <= Math.max(0.035, 2.5 * n1.halves_null)) ? 'пройдена' : 'не пройдена'))
    }
    const title = (k == 1) ? 'без смены объекта' : 'K ×' + k + ' с середины'
    console.log('\n## ' + title)
    console.log(lines.join('\n'))
    console.log('  (б)/шум: ' + lib.range_of(ratios, 2))
    summary.push({ k, min: Math.min(...ratios), max: Math.max(...ratios) })
}
const base = summary.find((s) => s.k == 1)
const change_min = Math.min(...summary.filter((s) => s.k != 1).map((s) => s.min))
if (base != null) {
    console.log('\nпросвет: без смены ≤ ' + fmt(base.max, 2) + ', со сменой ≥ ' + fmt(change_min, 2) + ' — ' + ((base.max < change_min) ? 'есть, середина (геом.) ' + fmt(Math.sqrt(base.max * change_min), 2) : 'нет'))
}
