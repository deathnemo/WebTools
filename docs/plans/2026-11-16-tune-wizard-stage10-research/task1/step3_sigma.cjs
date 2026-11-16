// Шаг 3 задачи 1: верна ли погрешность по суррогатам. На синтетике (объект PLANT_NORMAL, регулятор G0) по зёрнам
// полёта: настоящая ошибка КИХ относительно truth_step (RMS отклика на 0–0.5 с, пик, нарастание, плато; срез и запас
// фазы — pidtune_predict по КИХ против того же по «правде», импульсной характеристике truth_step на 1 с) против оценки
// по суррогатам: sigma_step и разброс метрик (половина размаха 16–84 процентилей; для сравнения — СКО суррогатов).
// «Правда» разброса — RMS ошибки по зёрнам (вместе со смещением) и СКО ошибки (без смещения); отношение
// «оценка / правда» — RMS оценки по зёрнам к RMS ошибки. Цель — 0.67–1.5.
// Запуск: node step3_sigma.cjs <репозиторий> <dur:turb:dist> [зёрна полёта, «8» или «24»] [число суррогатов] [блок] [зерно суррогатов]
'use strict'
const lib = require('./lib.cjs')
const repo = process.argv[2]
lib.load_core(repo)
const S = lib.load_synth()
const { fmt } = lib

const [dur_s, turb_dps2, dist_dps2] = (process.argv[3] ?? '80:3000:500').split(':').map(Number)
const nseeds = Number(process.argv[4] ?? 8)
const count = Number(process.argv[5] ?? 32)
const block = Number(process.argv[6] ?? 512)
const sur_seed = Number(process.argv[7] ?? 1)
const ALL = [3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97]
const SEEDS = ALL.slice(0, nseeds)
const plant = process.env.PLANT_K ? { ...S.PLANT_NORMAL, K: Number(process.env.PLANT_K) } : S.PLANT_NORMAL
// TARGET=acro — цель как в Acro «Rate Loop Only» 4.7.2 (lib.acro_target) вместо пилота генератора теста
const ACRO = process.env.TARGET === 'acro'
const sim_of = (o) => ACRO ? lib.simulate_req(S, S.G0, o, lib.acro_target(S, Math.round(o.dur_s * 400), o.seed)) : S.simulate(S.G0, o)

// «Правда»: отклик на 0–0.5 с, метрики, прогноз лога по импульсной характеристике truth_step на 1 с
const truth = S.truth_step(S.G0, plant)
const truth_m = pidtune_step_metrics(truth.time, truth.y)
const t1 = S.truth_step(S.G0, plant, 1.0)
// h_t[m] — отклик факта на импульс цели с задержкой m отсчётов (y[0] = 0: h[0] = 0, как у КИХ)
const h_t = new Float64Array(400)
for (let m = 1; m < 400; m++) h_t[m] = t1.y[m] - t1.y[m - 1]
const rate = 400
const grid = pidtune_predict_grid(rate)
const g = { P: S.G0.kp, I: S.G0.ki, D: S.G0.kd, FF: 0, DFF: 0 }
const c_log = pidtune_controller(g, { flte: 0, fltd: S.G0.fltd }, 400, grid.freq, 1)
const truth_p = pidtune_predict({ h: h_t }, c_log, c_log, null, rate)
console.log('# ' + JSON.stringify({ dur_s, turb_dps2, dist_dps2 }) + (process.env.PLANT_K ? ', K ' + plant.K : '') + (ACRO ? ', цель — как в Acro «Rate Loop Only» (acro_target)' : '') + '; зёрен полёта ' + SEEDS.length + ', суррогатов ' + count + ', блок ' + block + ', зерно суррогатов ' + sur_seed)
console.log('правда: пик ' + fmt(truth_m.peak, 4) + ', нарастание ' + fmt(truth_m.rise_s * 1000, 2) + ' мс, плато ' + fmt(truth_m.plateau, 4) + ', срез ' + fmt(truth_p.crossover_hz, 3) +
            ' Гц, запас фазы ' + fmt(truth_p.pm_deg, 2) + '°')

const err = { step: [], peak: [], rise: [], plat: [], fc: [], pm: [] }
const est = { step: [], peak: [], rise: [], plat: [], fc: [], pm: [] }
const est_sd = { peak: [], rise: [], plat: [] }
for (const seed of SEEDS) {
    const { seg, fir, metrics } = S.measure(sim_of({ dur_s, turb_dps2, dist_dps2, seed, plant }), S.G0)
    const p = pidtune_predict(fir, c_log, c_log, null, seg.rate_hz)
    const n = lib.surrogates(seg.segments, seg.rate_hz, fir, sur_seed, count, block, { keep_firs: true })
    const pm = n.firs.map((f) => pidtune_predict(f, c_log, c_log, null, seg.rate_hz))
    const e = {
        step: pidtune_rms_diff(fir.step, truth.y), peak: metrics.peak - truth_m.peak, rise: (metrics.rise_s - truth_m.rise_s) * 1000,
        plat: metrics.plateau - truth_m.plateau, fc: p.crossover_hz - truth_p.crossover_hz, pm: p.pm_deg - truth_p.pm_deg,
    }
    const s = {
        step: n.sigma_step, peak: n.sigma.peak, rise: n.sigma.rise_s * 1000, plat: n.sigma.plateau,
        fc: lib.spread(pm.map((x) => x?.crossover_hz ?? NaN)), pm: lib.spread(pm.map((x) => x?.pm_deg ?? NaN)),
    }
    for (const k of Object.keys(err)) {
        err[k].push(e[k])
        est[k].push(s[k])
    }
    est_sd.peak.push(n.sd.peak); est_sd.rise.push(n.sd.rise_s * 1000); est_sd.plat.push(n.sd.plateau)
    console.log('  зерно ' + String(seed).padStart(2) + ': ошибка отклика ' + fmt(e.step, 4) + ' (σ ' + fmt(s.step, 4) + '), пика ' + fmt(e.peak, 4) + ' (± ' + fmt(s.peak, 4) + ')' +
                ', нараст. ' + fmt(e.rise, 2) + ' мс (± ' + fmt(s.rise, 2) + '), плато ' + fmt(e.plat, 4) + ' (± ' + fmt(s.plat, 4) + '), срез ' + fmt(e.fc, 3) + ' (± ' + fmt(s.fc, 3) + ')' +
                ', запас ' + fmt(e.pm, 2) + '° (± ' + fmt(s.pm, 2) + ')')
}
const names = { step: 'отклик (RMS 0–0.5 с)', peak: 'пик', rise: 'нарастание, мс', plat: 'плато', fc: 'срез, Гц', pm: 'запас фазы, °' }
console.log('\nоценка / правда (RMS оценки по зёрнам / RMS ошибки; в скобках — к СКО ошибки, смещение — среднее ошибки):')
for (const k of Object.keys(err)) {
    const truth_rms = lib.rmsq(err[k])
    const truth_sd = (k == 'step') ? NaN : lib.sd(err[k])
    const bias = (k == 'step') ? NaN : lib.mean(err[k])
    const e_rms = lib.rmsq(est[k])
    const sd_txt = (k in est_sd) ? '; СКО суррогатов / правда ' + fmt(lib.rmsq(est_sd[k]) / truth_rms, 2) : ''
    console.log('  ' + names[k].padEnd(22) + ': оценка ' + fmt(e_rms, 4) + ', правда ' + fmt(truth_rms, 4) + (k == 'step' ? '' : ' (СКО ' + fmt(truth_sd, 4) + ', смещение ' + fmt(bias, 4) + ')') +
                ' → ' + fmt(e_rms / truth_rms, 2) + (k == 'step' ? '' : ' (' + fmt(e_rms / truth_sd, 2) + ')') + sd_txt)
}
