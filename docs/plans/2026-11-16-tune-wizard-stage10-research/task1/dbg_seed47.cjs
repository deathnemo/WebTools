// Отладка: зерно 47 REAL_NOISE — откуда ошибка нарастания +24.5 мс
'use strict'
const lib = require('./lib.cjs')
lib.load_core(process.argv[2])
const S = lib.load_synth()
const { fmt } = lib
const truth = S.truth_step(S.G0, S.PLANT_NORMAL)
for (const seed of [47, 3]) {
    const { fir, metrics } = S.measure(S.simulate(S.G0, { dur_s: 80, turb_dps2: 3000, dist_dps2: 500, seed, plant: S.PLANT_NORMAL }), S.G0)
    console.log('зерно ' + seed + ': нарастание ' + fmt(metrics.rise_s * 1000, 2) + ' мс, пик ' + fmt(metrics.peak, 4))
    const rows = []
    for (let k = 0; k <= 60; k += 2) rows.push(fmt(k * 2.5, 1) + ' мс ' + fmt(fir.step[k], 3) + '/' + fmt(truth.y[k], 3))
    console.log('  КИХ/правда: ' + rows.join('; '))
    console.log('  t10 ' + fmt(pidtune_crossing(fir.time, fir.step, fir.step.length, 0.1) * 1000, 2) + ' мс (правда ' + fmt(pidtune_crossing(truth.time, truth.y, truth.y.length, 0.1) * 1000, 2) +
                '), t90 ' + fmt(pidtune_crossing(fir.time, fir.step, fir.step.length, 0.9) * 1000, 2) + ' мс (правда ' + fmt(pidtune_crossing(truth.time, truth.y, truth.y.length, 0.9) * 1000, 2) + ')')
}
