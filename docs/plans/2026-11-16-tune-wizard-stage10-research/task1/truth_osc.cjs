// Поиск плохо задемпфированного контура с колебаниями на плато 0.3–0.5 с (правда без шума): объект PLANT_NORMAL
// с другой задержкой или K, регулятор G0 с другим P или D. Запуск: node truth_osc.cjs <репозиторий>
'use strict'
const lib = require('./lib.cjs')
lib.load_core(process.argv[2])
const S = lib.load_synth()
const { fmt } = lib
const show = (title, g, p) => {
    const t = S.truth_step(g, p)
    const m = pidtune_step_metrics(t.time, t.y)
    let i0 = 0
    while (t.time[i0] < 0.3 - 1e-9) i0++
    const o = pidtune_oscillation(t.time, t.y, i0, t.y.length, 0.001)
    const stable = t.y.every(Number.isFinite) && Math.abs(t.y[t.y.length - 1]) < 5
    console.log(title.padEnd(34) + ': пик ' + fmt(m?.peak, 3) + ', нараст. ' + fmt((m?.rise_s ?? NaN) * 1000, 1) + ' мс, плато ' + fmt(m?.plateau, 3) + ', колебания (0.08): ' +
                (m?.osc ? fmt(m.osc.freq_hz, 1) + ' Гц, размах ' + fmt(m.osc.amplitude_pp, 3) : 'нет') + '; без порога: ' + (o ? fmt(o.freq_hz, 1) + ' Гц, ' + fmt(o.amplitude_pp, 3) : 'нет') +
                ', полоса ' + fmt(m?.bandwidth_hz, 1) + ' Гц' + (stable ? '' : ' НЕУСТОЙЧИВ'))
}
for (const K of [500, 550, 600, 650]) show('K ' + K, S.G0, { ...S.PLANT_NORMAL, K })
for (const d of [0.02, 0.025, 0.03, 0.035]) show('задержка ' + d * 1000 + ' мс', S.G0, { ...S.PLANT_NORMAL, delay_s: d })
for (const d of [0.02, 0.025, 0.03]) show('K 250, задержка ' + d * 1000 + ' мс', S.G0, { ...S.PLANT_NORMAL, K: 250, delay_s: d })
for (const x of [3, 5, 7, 9]) show('D ×' + x, { ...S.G0, kd: S.G0.kd * x }, S.PLANT_NORMAL)
for (const x of [2, 2.5, 3]) show('P ×' + x, { ...S.G0, kp: S.G0.kp * x }, S.PLANT_NORMAL)
