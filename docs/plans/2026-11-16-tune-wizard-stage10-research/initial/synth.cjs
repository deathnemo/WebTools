// Проверка нулевой гипотезы для проверки (б) на синтетике тестов шага 4 (tests/tunewizard-pidtune.test.cjs):
// без смены объекта — укладывается ли (б) в распределение суррогатов «модель + перемешанные блоками остатки»
// и проходит ли порог 0.035 при шуме как в реальном полёте; со сменой объекта — выходит ли (б) за суррогаты.
// Запуск: node synth.cjs <репозиторий>
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const repo = process.argv[2]
globalThis.FFTJS = require(path.join(repo, 'modules/fft.js/lib/fft.js'))
for (const file of [
    'Libraries/Array_Math.js', 'Libraries/fft.js', 'TuneWizard/core/log.js', 'TuneWizard/core/gyro.js',
    'TuneWizard/core/tracking/Atmosphere_model.js', 'TuneWizard/core/tracking/BaseClass.js', 'TuneWizard/core/tracking/Static.js',
    'TuneWizard/core/tracking/Throttle.js', 'TuneWizard/core/tracking/RPM.js', 'TuneWizard/core/tracking/ESC.js',
    'TuneWizard/core/tracking/FFT.js', 'TuneWizard/core/tracking/Logged.js', 'TuneWizard/core/filters.js', 'TuneWizard/core/spectrum.js',
    'TuneWizard/core/metrics.js', 'TuneWizard/core/autofit.js', 'TuneWizard/core/candidates.js', 'TuneWizard/core/lowpass.js',
    'TuneWizard/core/pid.js', 'TuneWizard/core/pidtune.js',
]) {
    const full = path.join(repo, file)
    vm.runInThisContext(fs.readFileSync(full, 'utf8'), { filename: full })
}
// Генератор синтетики — как есть из теста (от R2D до close_to)
const test_src = fs.readFileSync(path.join(repo, 'tests/tunewizard-pidtune.test.cjs'), 'utf8')
const from = test_src.indexOf('const R2D = 180 / Math.PI')
const to = test_src.indexOf('function close_to(')
vm.runInThisContext(test_src.slice(from, to), { filename: 'synthetic-from-test' })
const G0 = vm.runInThisContext('G0')
const PLANT_NORMAL = vm.runInThisContext('PLANT_NORMAL')

function rng(seed) {
    let a = seed >>> 0
    return () => {
        a = (a + 0x6D2B79F5) >>> 0
        let t = a
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}
function conv(h, x) {
    const y = new Float64Array(x.length)
    for (let k = 0; k < x.length; k++) {
        let s = 0
        for (let m = 1, mmax = Math.min(h.length - 1, k); m <= mmax; m++) s += h[m] * x[k - m]
        y[k] = s
    }
    return y
}
function rms(a) {
    let s = 0
    for (const v of a) s += v * v
    return Math.sqrt(s / a.length)
}

// (б) и суррогаты: модель КИХ по всем данным + остатки, перемешанные блоками BL
function halves_null(segments, rate, fir, count, seed, BL = 512) {
    const resid = segments.map((s) => {
        const y = conv(fir.h, s.tar)
        const e = new Float64Array(s.tar.length)
        for (let k = 0; k < e.length; k++) e[k] = s.act[k] - y[k]
        return { y, e }
    })
    const pool = []
    for (const r of resid) for (let s = 0; s + BL <= r.e.length; s += BL) pool.push(r.e.subarray(s, s + BL))
    const rand = rng(seed)
    const out = []
    for (let rep = 0; rep < count; rep++) {
        const sur = segments.map((s, k) => {
            const act = new Float64Array(s.tar.length)
            for (let p = 0; p < act.length; p += BL) {
                const block = pool[Math.floor(rand() * pool.length)]
                for (let m = 0; m < BL && p + m < act.length; m++) act[p + m] = resid[k].y[p + m] + block[m]
            }
            return { start_time: s.start_time, tar: s.tar, act: act, starts: s.starts }
        })
        const [s1, s2] = pidtune_halves(sur, pidtune_rules.window)
        const g1 = pidtune_fir(s1, rate, fir.ridge), g2 = pidtune_fir(s2, rate, fir.ridge)
        out.push(pidtune_rms_diff(g1.step, g2.step))
    }
    out.sort((a, b) => a - b)
    const all_e = Float64Array.from(resid.flatMap((r) => Array.from(r.e)))
    const all_a = Float64Array.from(segments.flatMap((s) => Array.from(s.act)))
    return { mean: out.reduce((a, b) => a + b, 0) / out.length, p90: out[Math.floor(0.9 * (out.length - 1))], max: out[out.length - 1],
             resid_pct: 100 * (rms(all_e) / rms(all_a)) ** 2 }
}

const fmt = (v, d = 3) => (v == null || !Number.isFinite(v)) ? '—' : v.toFixed(d)

function scenario(title, o, seeds, plant_truth) {
    console.log('\n## ' + title)
    let pass_old = 0, above_p90 = 0
    const rows = []
    for (const seed of seeds) {
        const sim = simulate(G0, { ...o, seed })
        const { seg, fir, quality, metrics } = measure(sim, G0)
        const nul = halves_null(seg.segments, seg.rate_hz, fir, 12, seed * 7 + 1)
        const b = quality.checks.halves.value
        if (b <= pidtune_rules.quality.halves_rms_max) pass_old++
        if (b > nul.p90) above_p90++
        let truth_txt = ''
        if (plant_truth != null) {
            const truth = truth_step(G0, plant_truth)
            const tm = pidtune_step_metrics(truth.time, truth.y)
            truth_txt = ', ошибка КИХ: RMS ' + fmt(pidtune_rms_diff(fir.step, truth.y), 3) + ', перерег. ' + fmt(metrics.overshoot_pct - tm.overshoot_pct, 1) + ' п., нараст. ' + fmt((metrics.rise_s - tm.rise_s) * 1000, 1) + ' мс'
        }
        rows.push('  зерно ' + seed + ': данных ' + fmt(seg.data_s, 0) + ' с, остаток ' + fmt(nul.resid_pct, 1) + ' %, (а) ' + fmt(quality.checks.ridge.value, 3) +
                  ', (б) ' + fmt(b, 3) + ' | суррогаты: среднее ' + fmt(nul.mean, 3) + ', 90 % ' + fmt(nul.p90, 3) + ', макс ' + fmt(nul.max, 3) + truth_txt)
    }
    console.log(rows.join('\n'))
    console.log('  итог: (б) ≤ 0.035 — ' + pass_old + ' из ' + seeds.length + '; (б) выше 90 % суррогатов — ' + above_p90 + ' из ' + seeds.length)
}

const seeds = [3, 5, 7, 11, 13, 17, 19, 23]
const t0 = Date.now()
scenario('Как в тестах: 150 с, турбулентность 300 °/с²', { dur_s: 150, plant: PLANT_NORMAL }, seeds.slice(0, 4), PLANT_NORMAL)
scenario('Как ваш полёт по длине: 80 с, турбулентность 300', { dur_s: 80, plant: PLANT_NORMAL }, seeds, PLANT_NORMAL)
scenario('80 с, турбулентность 1500', { dur_s: 80, plant: PLANT_NORMAL, turb_dps2: 1500 }, seeds, PLANT_NORMAL)
scenario('80 с, турбулентность 3000', { dur_s: 80, plant: PLANT_NORMAL, turb_dps2: 3000 }, seeds, PLANT_NORMAL)
scenario('80 с, турбулентность 3000, на середине K −25 %', { dur_s: 80, plant: PLANT_NORMAL, plant2: { ...PLANT_NORMAL, K: PLANT_NORMAL.K * 0.75 }, turb_dps2: 3000 }, seeds, null)
scenario('80 с, турбулентность 3000, на середине K +25 %', { dur_s: 80, plant: PLANT_NORMAL, plant2: { ...PLANT_NORMAL, K: PLANT_NORMAL.K * 1.25 }, turb_dps2: 3000 }, seeds, null)
scenario('80 с, турбулентность 300, на середине K −25 %', { dur_s: 80, plant: PLANT_NORMAL, plant2: { ...PLANT_NORMAL, K: PLANT_NORMAL.K * 0.75 } }, seeds, null)
console.log('\nвремя ' + ((Date.now() - t0) / 1000).toFixed(0) + ' с')
