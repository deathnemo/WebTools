// Шаг 1 задачи 1: подбор REAL_NOISE (80 с, остаток модели 5–9 % дисперсии факта, объект PLANT_NORMAL, регулятор G0)
// и TOO_NOISY (σ отклика > 0.1). По каждому варианту { dur_s, turb_dps2, dist_dps2 } и 8 зёрнам полёта: остаток, доли
// остатка по полосам (как log_spectra.cjs у лога), (а), (б), шум (б) и σ отклика по 32 суррогатам (зерно 1, блоки 512).
// Запуск: node step1_noise.cjs <репозиторий> [вариант …] — вариант «dur:turb:dist», без вариантов — набор по умолчанию
'use strict'
const lib = require('./lib.cjs')
const repo = process.argv[2]
lib.load_core(repo)
const S = lib.load_synth()
const { fmt } = lib

const BANDS = [[0, 1.5], [1.5, 4], [4, 10], [10, 25], [25, 1000]]
function band_shares(pieces, key, rate) {
    const N = 512
    const w = hanning(N)
    const fft = new FFTJS(N)
    const out = fft.createComplexArray()
    const psd = new Float64Array(N / 2 + 1)
    for (const p of pieces) {
        const x = p[key]
        for (let s = 0; s + N <= x.length; s += N / 2) {
            const buf = new Array(N)
            for (let i = 0; i < N; i++) buf[i] = x[s + i] * w[i]
            fft.realTransform(out, buf)
            for (let k = 0; k <= N / 2; k++) psd[k] += out[2 * k] ** 2 + out[2 * k + 1] ** 2
        }
    }
    let total = 0
    for (let k = 1; k <= N / 2; k++) total += psd[k]
    return BANDS.map(([a, b]) => {
        let s = 0
        for (let k = 1; k <= N / 2; k++) {
            const f = k * rate / N
            if (f >= a && f < b) s += psd[k]
        }
        return 100 * s / total
    })
}

const SEEDS = [3, 5, 7, 11, 13, 17, 19, 23]
const args = process.argv.slice(3)
const variants = (args.length > 0 ? args : [
    '80:3000:30', '80:5000:30', '80:300:300', '80:300:600', '80:300:1000', '80:3000:300', '80:3000:500', '80:4000:400',
]).map((t) => {
    const [dur_s, turb_dps2, dist_dps2] = t.split(':').map(Number)
    return { dur_s, turb_dps2, dist_dps2 }
})

for (const v of variants) {
    const rows = []
    const acc = { res: [], b: [], null: [], ratio: [], sig: [], a: [], shares: [], sig_peak: [], data: [] }
    for (const seed of SEEDS) {
        const sim = S.simulate(S.G0, { ...v, seed, plant: S.PLANT_NORMAL })
        const { seg, fir, quality } = S.measure(sim, S.G0)
        const rate = seg.rate_hz
        const res = lib.residual_pct(seg.segments, fir)
        const pieces = seg.segments.map((s) => {
            const y = lib.conv(fir.h, s.tar)
            const e = new Float64Array(s.tar.length)
            for (let k = 0; k < e.length; k++) e[k] = s.act[k] - y[k]
            return { e }
        })
        const sh = band_shares(pieces, 'e', rate)
        const n = lib.surrogates(seg.segments, rate, fir, 1, 32, 512)
        const b = quality.checks.halves.value
        acc.res.push(res); acc.b.push(b); acc.null.push(n.halves_null); acc.ratio.push(b / n.halves_null); acc.sig.push(n.sigma_step)
        acc.a.push(quality.checks.ridge.value); acc.shares.push(sh); acc.sig_peak.push(n.sigma.peak); acc.data.push(seg.data_s)
        rows.push('  зерно ' + String(seed).padStart(2) + ': данных ' + fmt(seg.data_s, 1) + ' с, остаток ' + fmt(res, 2) + ' %, (а) ' + fmt(quality.checks.ridge.value, 3) +
                  ', (б) ' + fmt(b, 3) + ', шум ' + fmt(n.halves_null, 3) + ' (×' + fmt(b / n.halves_null, 2) + '), σ отклика ' + fmt(n.sigma_step, 3) +
                  ', σ пика ' + fmt(n.sigma.peak, 3) + '; полосы ' + sh.map((x) => fmt(x, 0)).join('/') + ' %')
    }
    const avg_sh = BANDS.map((_, i) => lib.mean(acc.shares.map((s) => s[i])))
    console.log('\n## dur_s ' + v.dur_s + ', turb_dps2 ' + v.turb_dps2 + ', dist_dps2 ' + v.dist_dps2)
    console.log(rows.join('\n'))
    console.log('  итог: остаток ' + lib.range_of(acc.res, 2) + ' %, (а) ' + lib.range_of(acc.a) + ', (б) ' + lib.range_of(acc.b) + ', шум (б) ' + lib.range_of(acc.null) +
                ', (б)/шум ' + lib.range_of(acc.ratio, 2) + ', σ отклика ' + lib.range_of(acc.sig) + ', σ пика ' + lib.range_of(acc.sig_peak) +
                '; полосы остатка (средние) ' + avg_sh.map((x) => fmt(x, 1)).join(' / ') + ' %')
}
