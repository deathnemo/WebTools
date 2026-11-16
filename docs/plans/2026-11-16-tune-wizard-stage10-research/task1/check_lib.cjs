// Самопроверка lib.cjs: быстрый КИХ (разложение один раз) против pidtune_fir, половины против pidtune_quality,
// разброс и «ещё N с» против чисел плана задачи 2, время 32 суррогатов. Запуск: node check_lib.cjs <репозиторий>
'use strict'
const lib = require('./lib.cjs')
const repo = process.argv[2]
lib.load_core(repo)
const S = lib.load_synth()

console.log('spread [1…5] = ' + lib.spread([1, 2, 3, 4, 5]).toFixed(12) + ' (план: 1.36)')
console.log('spread [NaN, 2, null, 4, Inf] = ' + lib.spread([NaN, 2, null, 4, Infinity]).toFixed(12) + ' (план: 0.68)')
console.log('spread [1] = ' + lib.spread([1]))
console.log('need_s(0.124, 16.4) = ' + lib.need_s(0.124, 16.4) + ' (план 85); (0.051, 10) = ' + lib.need_s(0.051, 10) + ' (план 5); (0.05, 10) = ' + lib.need_s(0.05, 10) + ' (план 0)')

const sim = S.simulate(S.G0, { dur_s: 80, seed: 3, plant: S.PLANT_NORMAL, turb_dps2: 3000 })
const { seg, fir, quality } = S.measure(sim, S.G0)
const rate = seg.rate_hz
const prep = lib.fir_prepare(seg.segments, rate, fir.ridge)
const f = lib.fir_solve(prep, lib.cry_of(seg.segments, prep.taps))
let dmax = 0
for (let i = 0; i < fir.step.length; i++) dmax = Math.max(dmax, Math.abs(fir.step[i] - f.step[i]))
console.log('КИХ: разница шагов с pidtune_fir ' + dmax.toExponential(2))
const hs = pidtune_halves(seg.segments, pidtune_rules.window)
const p1 = lib.fir_prepare(hs[0], rate, fir.ridge), p2 = lib.fir_prepare(hs[1], rate, fir.ridge)
const b = pidtune_rms_diff(lib.fir_solve(p1, lib.cry_of(hs[0], p1.taps)).step, lib.fir_solve(p2, lib.cry_of(hs[1], p2.taps)).step)
console.log('(б): быстрый ' + b.toFixed(15) + ', pidtune_quality ' + quality.checks.halves.value.toFixed(15))
const t0 = Date.now()
const n = lib.surrogates(seg.segments, rate, fir, 1, 32, 512)
console.log('32 суррогата: ' + ((Date.now() - t0) / 1000).toFixed(2) + ' с; пул ' + n.pool + ' блоков, valid ' + n.valid + ', (б) шума ' + n.halves_null.toFixed(4) +
            ', σ отклика ' + n.sigma_step.toFixed(4) + ', σ пика ' + n.sigma.peak.toFixed(4) + ' (СКО ' + n.sd.peak.toFixed(4) + ')')
console.log('остаток ' + lib.residual_pct(seg.segments, fir).toFixed(2) + ' %, данных ' + seg.data_s.toFixed(1) + ' с, отрезков ' + seg.segments.length)
