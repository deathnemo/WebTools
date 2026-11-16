// Шаг 4 задачи 1 и «ожидаемо» раздела 3.4: исходы шага 4 на четвёртом логе по методу этапа 10 — 32 суррогата, блоки
// 512 с возвращением, mulberry32, разброс — половина размаха 16–84 процентилей. Боевое зерно — номер оси + 1 (крен 1,
// тангаж 2, рыскание 3), для устойчивости — ещё зёрна из списка. По оси и зерну: (б), шум, (б)/шум, (г) σ отклика и
// «ещё N с» до 0.05, пик и перерегулирование ± σ (σ пика × 100), решение правила с запасом 1σ, ± у нарастания, плато,
// среза и запаса фазы лога (pidtune_predict по КИХ суррогатов), отношение σ перерегулирования (п.) к σ отклика.
// Запуск: node step4_log4.cjs <репозиторий> [лог] [интервалы через запятую, «289-370,300-370»] [зёрна, «1-10»]
'use strict'
const path = require('node:path')
const lib = require('./lib.cjs')
const repo = process.argv[2]
const log_path = process.argv[3] ?? path.join(repo, 'TuneWizard/logs/2 01.01.1970 2-00-00.bin')
const ranges = (process.argv[4] ?? '289-370,300-370').split(',').map((r) => r.split('-').map(Number))
const seeds_arg = process.argv[5] ?? '1-10'
const seeds = seeds_arg.includes('-') ? (() => { const [a, b] = seeds_arg.split('-').map(Number); return Array.from({ length: b - a + 1 }, (_, i) => a + i) })()
    : seeds_arg.split(',').map(Number)
const { fmt } = lib
const RATIO = 2.5, SIGMA_MAX = 0.08, GOAL = 0.05

async function main() {
    lib.load_core(repo, true)
    const L = await lib.load_log(log_path)
    console.log('# ' + path.basename(log_path) + ', ' + L.version.fw_string + '; 32 суррогата, блоки 512, зёрна ' + seeds.join(', ') + ' (боевое — номер оси + 1)')
    for (const range of ranges) {
        console.log('\n# интервал ' + range.join('–') + ' с')
        for (const axis of ['roll', 'pitch', 'yaw']) {
            const A = lib.log_axis(L, axis, range)
            const b = A.quality.checks.halves.value
            const m = A.metrics
            const pred = pidtune_predict(A.fir, A.c_log, A.c_log, null, A.rate)
            const prod = A.index + 1
            console.log('\n' + axis + ': данных ' + fmt(A.seg.data_s, 1) + ' с, (а) ' + fmt(A.quality.checks.ridge.value, 4) + ', (б) ' + fmt(b, 4) + ', rate_only ' + A.mode.rate_only +
                        '; пик ' + fmt(m.peak, 4) + ' (перерегулирование ' + fmt((m.peak - 1) * 100, 1) + ' %), нарастание ' + fmt(m.rise_s * 1000, 1) + ' мс, плато ' + fmt(m.plateau, 3) +
                        ', колебания ' + (m.osc ? fmt(m.osc.freq_hz, 1) + ' Гц, размах ' + fmt(m.osc.amplitude_pp, 3) : 'нет') + '; срез ' + fmt(pred?.crossover_hz, 2) + ' Гц, запас фазы ' + fmt(pred?.pm_deg, 1) + '°')
            const acc = { ratio: [], sig: [], sos: [], need: [], dec: [], k: [], b_ok: [], g_ok: [] }
            for (const seed of seeds) {
                const n = lib.surrogates(A.seg.segments, A.rate, A.fir, seed, 32, 512, { keep_firs: true })
                const ratio = b / n.halves_null
                const limit = Math.max(pidtune_rules.quality.halves_rms_max, RATIO * n.halves_null)
                const b_ok = b <= limit
                const g_ok = n.sigma_step <= SIGMA_MAX
                const need = lib.need_s(n.sigma_step, A.seg.data_s, GOAL)
                const sos = n.sigma.peak * 100
                const margins = n.firs.map((f) => pidtune_predict(f, A.c_log, A.c_log, null, A.rate))
                const s_fc = lib.spread(margins.map((p) => p?.crossover_hz ?? NaN))
                const s_pm = lib.spread(margins.map((p) => p?.pm_deg ?? NaN))
                const dec = lib.rule_decision(m.peak, n.sigma.peak, 1, m.osc)
                const status = !A.quality.checks.ridge.ok ? 'unreliable (а)' : (!b_ok ? 'unreliable (б)' : (!g_ok ? 'imprecise, ещё ≈ ' + need + ' с' : 'ok — ' + dec.decision))
                acc.ratio.push(ratio); acc.sig.push(n.sigma_step); acc.sos.push(sos); acc.need.push(need); acc.dec.push(status); acc.k.push(sos / n.sigma_step)
                acc.b_ok.push(b_ok); acc.g_ok.push(g_ok)
                console.log('  зерно ' + String(seed).padStart(2) + (seed == prod ? '*' : ' ') + ': шум ' + fmt(n.halves_null, 3) + ' (б)/шум ' + fmt(ratio, 2) + ' (предел ' + fmt(limit, 3) + ')' +
                            ', σ отклика ' + fmt(n.sigma_step, 3) + ', перерег. ' + fmt((m.peak - 1) * 100, 1) + ' ± ' + fmt(sos, 2) + ' п. (СКО ' + fmt(n.sd.peak * 100, 2) + ')' +
                            ', нараст. ± ' + fmt(n.sigma.rise_s * 1000, 1) + ' мс, плато ± ' + fmt(n.sigma.plateau, 3) + ', срез ± ' + fmt(s_fc, 2) + ' Гц, запас ± ' + fmt(s_pm, 1) + '°' +
                            ', σп/σ ' + fmt(sos / n.sigma_step, 0) + ' → ' + status)
            }
            const uniq = [...new Set(acc.dec.map((d) => d.replace(/ещё ≈ \d+ с/, 'ещё ≈ N с')))]
            console.log('  по зёрнам: (б)/шум ' + lib.range_of(acc.ratio, 2) + ', σ отклика ' + lib.range_of(acc.sig, 3) + ', σ перерег. ' + lib.range_of(acc.sos, 2) + ' п., «ещё» ' +
                        lib.range_of(acc.need, 0) + ' с, σп/σ ' + lib.range_of(acc.k, 0) + '; исходы: ' + uniq.join(' | '))
        }
    }
}
main().catch((e) => {
    console.error(e)
    process.exit(1)
})
