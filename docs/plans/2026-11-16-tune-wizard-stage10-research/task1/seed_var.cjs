// Разброс итогов суррогатов от зерна (для теста задачи 2 «другое зерно — в пределах ×1.5»): REAL_NOISE, зерно полёта 3
// (как в плане), зёрна суррогатов 1–10: halves_null, sigma_step, sigma.peak (16–84) и СКО пика; отношение max/min и
// отношение к зерну 1. Запуск: node seed_var.cjs <репозиторий> [зерно полёта]
'use strict'
const lib = require('./lib.cjs')
lib.load_core(process.argv[2])
const S = lib.load_synth()
const { fmt } = lib
const fseed = Number(process.argv[3] ?? 3)
const { seg, fir } = S.measure(S.simulate(S.G0, { dur_s: 80, turb_dps2: 3000, dist_dps2: 500, seed: fseed, plant: S.PLANT_NORMAL }), S.G0)
const rows = { halves_null: [], sigma_step: [], peak: [], peak_sd: [] }
for (let s = 1; s <= 10; s++) {
    const n = lib.surrogates(seg.segments, seg.rate_hz, fir, s, 32, 512)
    rows.halves_null.push(n.halves_null); rows.sigma_step.push(n.sigma_step); rows.peak.push(n.sigma.peak); rows.peak_sd.push(n.sd.peak)
    console.log('зерно ' + String(s).padStart(2) + ': шум (б) ' + fmt(n.halves_null, 4) + ', σ отклика ' + fmt(n.sigma_step, 4) + ', σ пика (16–84) ' + fmt(n.sigma.peak, 4) + ', СКО пика ' + fmt(n.sd.peak, 4))
}
for (const [k, v] of Object.entries(rows)) {
    const r = v.map((x) => x / v[0])
    console.log(k.padEnd(12) + ': max/min ' + fmt(Math.max(...v) / Math.min(...v), 2) + ', к зерну 1 — ' + fmt(Math.min(...r), 2) + '…' + fmt(Math.max(...r), 2))
}
