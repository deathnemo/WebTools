// Шаг 6 (дополнение): ранний отклик КИХ [лог4] на интервалах 289–370 и 300–370 с: отклик на 2.5/5/10/15 мс, t10,
// нарастание; разброс отклика на 5 мс по 32 суррогатам (боевое зерно). Запуск: node step6b_log_early.cjs <репозиторий> [лог]
'use strict'
const path = require('node:path')
const lib = require('./lib.cjs')
const repo = process.argv[2]
const log_path = process.argv[3] ?? path.join(repo, 'TuneWizard/logs/2 01.01.1970 2-00-00.bin')
const { fmt } = lib
async function main() {
    lib.load_core(repo, true)
    const L = await lib.load_log(log_path)
    for (const range of [[289, 370], [300, 370]]) {
        for (const axis of ['roll', 'pitch', 'yaw']) {
            const A = lib.log_axis(L, axis, range)
            const f = A.fir
            const n = lib.surrogates(A.seg.segments, A.rate, f, A.index + 1, 32, 512)
            const y5 = n.steps.map((s) => s[2])
            console.log(range.join('–') + ' с, ' + axis.padEnd(5) + ': отклик на 2.5/5/10/15 мс ' + [1, 2, 4, 6].map((k) => fmt(f.step[k])).join('/') + ', t10 ' +
                        fmt(pidtune_crossing(f.time, f.step, f.step.length, 0.1) * 1000, 1) + ' мс, t90 ' + fmt(pidtune_crossing(f.time, f.step, f.step.length, 0.9) * 1000, 1) +
                        ' мс, нарастание ' + fmt(A.metrics.rise_s * 1000, 1) + ' мс; отклик на 5 мс по суррогатам ' + fmt(lib.mean(y5)) + ' ± ' + fmt(lib.spread(y5)))
        }
    }
}
main().catch((e) => { console.error(e); process.exit(1) })
