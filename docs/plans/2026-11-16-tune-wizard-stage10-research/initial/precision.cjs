// Точность метрик шага 4 на реальном логе: разброс перерегулирования, нарастания, плато, частоты среза и запаса фазы
// по суррогатам «модель КИХ + перемешанные блоками остатки»; (б) против среднего суррогатов на нескольких интервалах;
// флаги регулятора PIDx. Запуск: node precision.cjs <репозиторий> <лог> <число суррогатов> <интервал>…  (интервал — «289-370»)
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { pathToFileURL } = require('node:url')

const [repo, log_path, nsur, ...ranges_txt] = process.argv.slice(2)
const N_SUR = Number(nsur)
const ranges = ranges_txt.map((r) => r.split('-').map(Number))

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
const fmt = (v, d = 3) => (v == null || !Number.isFinite(v)) ? '—' : v.toFixed(d)
function stats(a) {
    const v = a.filter(Number.isFinite)
    if (v.length == 0) return { mean: NaN, sd: NaN }
    const mean = v.reduce((x, y) => x + y, 0) / v.length
    return { mean, sd: Math.sqrt(v.reduce((x, y) => x + (y - mean) ** 2, 0) / Math.max(1, v.length - 1)) }
}

async function main() {
    globalThis.self = { addEventListener() {}, postMessage() {} }
    const DataflashParser = (await import(pathToFileURL(path.join(repo, 'modules/JsDataflashParser/parser.js')).href)).default
    globalThis.FFTJS = require(path.join(repo, 'modules/fft.js/lib/fft.js'))
    for (const file of ['Libraries/LogHelpers.js', 'Libraries/Array_Math.js', 'Libraries/fft.js', 'Libraries/DecodeDevID.js', 'Libraries/Param_Helpers.js',
        'TuneWizard/core/vehicle.js', 'TuneWizard/core/log.js', 'TuneWizard/core/gyro.js', 'TuneWizard/core/filters.js', 'TuneWizard/core/candidates.js',
        'TuneWizard/core/lowpass.js', 'TuneWizard/core/pid.js', 'TuneWizard/core/pidtune.js']) {
        const full = path.join(repo, file)
        vm.runInThisContext(fs.readFileSync(full, 'utf8'), { filename: full })
    }
    const data = fs.readFileSync(log_path)
    const log = new DataflashParser()
    log.processData(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), [])
    const version = get_version_and_board(log)
    const params = log_params(log)
    const pid = load_pid(log, { build_type: version.build_type })
    const loop_rate = params.get('SCHED_LOOP_RATE') ?? 400

    // Флаги регулятора (AC_PID: бит 0 — limit, бит 1 — PD_sum_limit, бит 2 — reset, бит 3 — I_term_set)
    for (const name of ['PIDR', 'PIDP', 'PIDY']) {
        const t = log.get(name, 'TimeUS'), f = log.get(name, 'Flags')
        if (f == null) { console.log(name + ': поля Flags нет'); continue }
        const r = ranges[0]
        const counts = {}
        let n = 0
        for (let i = 0; i < t.length; i++) {
            const s = t[i] * 1e-6
            if (s < r[0] || s > r[1]) continue
            n++
            counts[f[i]] = (counts[f[i]] ?? 0) + 1
        }
        console.log(name + ' флаги на ' + r.join('–') + ' с: ' + Object.entries(counts).map(([k, c]) => k + ' — ' + fmt(100 * c / n, 2) + ' %').join(', '))
    }

    for (const range of ranges) {
        console.log('\n# интервал ' + range.join('–') + ' с')
        for (const [axis, i] of [['roll', 0], ['pitch', 1], ['yaw', 2]]) {
            const source = pid.axes[i]
            const set_index = source.params.sets.map((s, k) => k).filter((k) => source.sets[k] != null).pop()
            const set = source.params.sets[set_index]
            const seg = pidtune_segments(source, set_index, range)
            const rate = seg.rate_hz
            const fir = pidtune_fir(seg.segments, rate)
            const mode = pidtune_log_mode(log, params, version, range, axis, rate)
            const q = pidtune_quality(seg.segments, rate, fir, { rate_only: mode.rate_only })
            const gains = { P: set.KP, I: set.KI, D: set.KD, FF: set.FF ?? 0, DFF: set.D_FF ?? 0 }
            const filters_log = { flte: set.Error_filter, fltd: set.D_filter }
            const grid = pidtune_predict_grid(rate)
            const c_log = pidtune_controller(gains, filters_log, loop_rate, grid.freq, mode.i_scale)
            const metr = (f) => {
                const m = pidtune_step_metrics(f.time, f.step)
                const p = pidtune_predict(f, c_log, c_log, null, rate)
                return { os: m?.overshoot_pct, rise: (m?.rise_s ?? NaN) * 1000, plat: m?.plateau, fc: p?.crossover_hz, pm: p?.pm_deg }
            }
            const base = metr(fir)

            // Суррогаты: модель + остатки блоками по 512
            const resid = seg.segments.map((s) => {
                const y = conv(fir.h, s.tar)
                const e = new Float64Array(s.tar.length)
                for (let k = 0; k < e.length; k++) e[k] = s.act[k] - y[k]
                return { y, e }
            })
            const BL = 512
            const pool = []
            for (const r of resid) for (let s = 0; s + BL <= r.e.length; s += BL) pool.push(r.e.subarray(s, s + BL))
            const rand = rng(1000 + i)
            const sm = [], sb = []
            for (let rep = 0; rep < N_SUR; rep++) {
                const sur = seg.segments.map((s, k) => {
                    const act = new Float64Array(s.tar.length)
                    for (let p = 0; p < act.length; p += BL) {
                        const block = pool[Math.floor(rand() * pool.length)]
                        for (let m = 0; m < BL && p + m < act.length; m++) act[p + m] = resid[k].y[p + m] + block[m]
                    }
                    return { start_time: s.start_time, tar: s.tar, act: act, starts: s.starts }
                })
                const sf = pidtune_fir(sur, rate)
                sm.push(metr(sf))
                const [s1, s2] = pidtune_halves(sur, pidtune_rules.window)
                sb.push(pidtune_rms_diff(pidtune_fir(s1, rate, sf.ridge).step, pidtune_fir(s2, rate, sf.ridge).step))
            }
            const st = (k) => stats(sm.map((x) => x[k]))
            const b_null = stats(sb).mean
            const need_s = seg.data_s * (b_null / pidtune_rules.quality.halves_rms_max) ** 2
            console.log(axis.padEnd(6) + ' данных ' + fmt(seg.data_s, 1) + ' с | (б) ' + fmt(q.checks.halves.value) + ', суррогаты ' + fmt(b_null) + ' (отношение ' + fmt(q.checks.halves.value / b_null, 2) + ')' +
                        ' | перерег. ' + fmt(base.os, 1) + ' ± ' + fmt(st('os').sd, 1) + ' п., нараст. ' + fmt(base.rise, 1) + ' ± ' + fmt(st('rise').sd, 1) + ' мс, плато ' + fmt(base.plat, 2) + ' ± ' + fmt(st('plat').sd, 2) +
                        ', срез ' + fmt(base.fc, 2) + ' ± ' + fmt(st('fc').sd, 2) + ' Гц, запас фазы ' + fmt(base.pm, 1) + ' ± ' + fmt(st('pm').sd, 1) + '°' +
                        ' | для (б) ≤ 0.035 нужно ≈ ' + fmt(need_s, 0) + ' с данных')
        }
    }
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
