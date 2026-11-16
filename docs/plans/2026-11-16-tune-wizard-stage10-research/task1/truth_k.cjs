// Правда отклика PLANT_NORMAL с регулятором G0 при разных K: перерегулирование, плато, колебания на плато 0.3–0.5 с
// (pidtune_step_metrics, osc_min_pp 0.08) и размах на плато без порога. Запуск: node truth_k.cjs <репозиторий>
'use strict'
const lib = require('./lib.cjs')
lib.load_core(process.argv[2])
const S = lib.load_synth()
const { fmt } = lib
for (const K of [190, 250, 300, 340, 360, 380, 400, 420, 450]) {
    const t = S.truth_step(S.G0, { ...S.PLANT_NORMAL, K })
    const m = pidtune_step_metrics(t.time, t.y)
    let i0 = 0
    while (t.time[i0] < 0.3 - 1e-9) i0++
    const o = pidtune_oscillation(t.time, t.y, i0, t.y.length, 0.001)
    console.log('K ' + K + ': пик ' + fmt(m.peak, 3) + ' (перерегулирование ' + fmt(m.overshoot_pct, 1) + ' %), нарастание ' + fmt(m.rise_s * 1000, 1) + ' мс, плато ' + fmt(m.plateau, 3) +
                ', колебания (0.08): ' + (m.osc ? fmt(m.osc.freq_hz, 1) + ' Гц, размах ' + fmt(m.osc.amplitude_pp, 3) : 'нет') + '; без порога: ' + (o ? fmt(o.freq_hz, 1) + ' Гц, размах ' + fmt(o.amplitude_pp, 3) : 'нет') +
                ', полоса ' + fmt(m.bandwidth_hz, 1) + ' Гц')
}
