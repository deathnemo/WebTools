// Исследование проверки (б) шага 4 на логе Acro «Rate Loop Only»: почему половины данных дают разный отклик.
// Запуск: node research.cjs <репозиторий> <лог> <начало, с> <конец, с> [число суррогатов]
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { pathToFileURL } = require('node:url')

const [repo, log_path, t0s, t1s, nsur] = process.argv.slice(2)
const range = [Number(t0s), Number(t1s)]
const N_SUR = Number(nsur ?? 20)

function load_scripts() {
    globalThis.FFTJS = require(path.join(repo, 'modules/fft.js/lib/fft.js'))
    for (const file of [
        'Libraries/LogHelpers.js', 'Libraries/Array_Math.js', 'Libraries/fft.js', 'Libraries/DecodeDevID.js', 'Libraries/Param_Helpers.js',
        'TuneWizard/core/vehicle.js', 'TuneWizard/core/log.js', 'TuneWizard/core/checks.js', 'TuneWizard/core/gyro.js',
        'TuneWizard/core/tracking/Atmosphere_model.js', 'TuneWizard/core/tracking/BaseClass.js', 'TuneWizard/core/tracking/Static.js',
        'TuneWizard/core/tracking/Throttle.js', 'TuneWizard/core/tracking/RPM.js', 'TuneWizard/core/tracking/ESC.js',
        'TuneWizard/core/tracking/FFT.js', 'TuneWizard/core/tracking/Logged.js', 'TuneWizard/core/filters.js',
        'TuneWizard/core/spectrum.js', 'TuneWizard/core/metrics.js', 'TuneWizard/core/autofit.js', 'TuneWizard/core/candidates.js',
        'TuneWizard/core/lowpass.js', 'TuneWizard/core/pid.js', 'TuneWizard/core/pidtune.js',
    ]) {
        const full = path.join(repo, file)
        vm.runInThisContext(fs.readFileSync(full, 'utf8'), { filename: full })
    }
}

// Детерминированный генератор случайных чисел (mulberry32)
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

const fmt = (v, d = 3) => (v == null || !Number.isFinite(v)) ? '—' : v.toFixed(d)

// Свёртка: y[k] = Σ h[m]·x[k − m] (за краями — нули, как в pidtune_correlations)
function conv(h, x) {
    const y = new Float64Array(x.length)
    for (let k = 0; k < x.length; k++) {
        let s = 0
        const mmax = Math.min(h.length - 1, k)
        for (let m = 1; m <= mmax; m++) s += h[m] * x[k - m]
        y[k] = s
    }
    return y
}

// Разбиение отрезков на блоки по B отсчётов, блоки — через один в A и B (окна starts не нужны КИХ)
function interleave(segments, B) {
    const A = [], C = []
    let flip = 0
    for (const seg of segments) {
        for (let s = 0; s < seg.tar.length; s += B) {
            const piece = { start_time: seg.start_time + s, tar: seg.tar.subarray(s, Math.min(s + B, seg.tar.length)), act: seg.act.subarray(s, Math.min(s + B, seg.tar.length)), starts: [] }
            if (piece.tar.length < 64) continue;
            (flip++ % 2 == 0 ? A : C).push(piece)
        }
    }
    return [A, C]
}

// Деление по числу отсчётов на k частей по порядку времени
function parts(segments, k) {
    const total = segments.reduce((s, x) => s + x.tar.length, 0)
    const out = Array.from({ length: k }, () => [])
    let acc = 0
    for (const seg of segments) {
        let s = 0
        while (s < seg.tar.length) {
            const part = Math.min(k - 1, Math.floor(acc * k / total))
            const part_end = Math.round((part + 1) * total / k)
            const take = Math.min(seg.tar.length - s, Math.max(1, part_end - acc))
            out[part].push({ start_time: seg.start_time, t0: seg.t0 + s / seg.rate, rate: seg.rate, tar: seg.tar.subarray(s, s + take), act: seg.act.subarray(s, s + take),
                             out: seg.out?.subarray(s, s + take), err: seg.err?.subarray(s, s + take), starts: [] })
            s += take
            acc += take
        }
    }
    return out
}

function rms(a) {
    let s = 0
    for (const v of a) s += v * v
    return Math.sqrt(s / a.length)
}

function rms_range(a, b, i0, i1) {
    let s = 0
    for (let i = i0; i < i1; i++) s += (a[i] - b[i]) ** 2
    return Math.sqrt(s / (i1 - i0))
}

async function main() {
    globalThis.self = { addEventListener() {}, postMessage() {} }
    const DataflashParser = (await import(pathToFileURL(path.join(repo, 'modules/JsDataflashParser/parser.js')).href)).default
    load_scripts()
    const data = fs.readFileSync(log_path)
    const log = new DataflashParser()
    log.processData(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), [])
    const version = get_version_and_board(log)
    const params = log_params(log)
    const pid = load_pid(log, { build_type: version.build_type })
    const loop_rate = params.get('SCHED_LOOP_RATE') ?? 400
    console.log('# ' + path.basename(log_path) + ', интервал ' + range.join('–') + ' с, ' + version.fw_string)

    // Газ и батарея на 400 Гц / как есть
    const rate_t = log.get('RATE', 'TimeUS').map((t) => t * 1e-6)
    const rate_aout = log.get('RATE', 'AOut')
    const bat_inst = Object.keys(log.messageTypes.BAT?.instances ?? {})[0]
    const bat_t = (bat_inst != null) ? log.get_instance('BAT', bat_inst, 'TimeUS').map((t) => t * 1e-6) : []
    const bat_v = (bat_inst != null) ? log.get_instance('BAT', bat_inst, 'Volt') : []
    const bat_c = (bat_inst != null) ? log.get_instance('BAT', bat_inst, 'Curr') : []

    function mean_in(times, values, spans) {
        let s = 0, n = 0
        for (let i = 0; i < times.length; i++) {
            const t = times[i]
            if (spans.some(([a, b]) => t >= a && t <= b)) { s += values[i]; n++ }
        }
        return n ? s / n : null
    }

    const axes = [['roll', 0], ['pitch', 1], ['yaw', 2]]
    for (const [axis, i] of axes) {
        const source = pid.axes[i]
        const sets = source.params.sets.map((s, k) => ({ k, s })).filter(({ k, s }) => source.sets[k] != null && s.start_time < range[1] && (s.end_time == null || s.end_time > range[0]))
        const set_index = sets[sets.length - 1].k
        const set = source.params.sets[set_index]
        const seg = pidtune_segments(source, set_index, range)
        const rate = seg.rate_hz
        // время начала каждого отрезка и выход/ошибка — из пакета
        for (const s of seg.segments) {
            const batch = source.sets[set_index][s.batch]
            s.t0 = batch.time[s.begin]
            s.rate = rate
            s.out = Float64Array.from(batch.Out.slice(s.begin, s.begin + s.tar.length))
            s.err = Float64Array.from(batch.Err.slice(s.begin, s.begin + s.tar.length))
        }
        const fir = pidtune_fir(seg.segments, rate)
        const mode = pidtune_log_mode(log, params, version, range, axis, rate)
        const q = pidtune_quality(seg.segments, rate, fir, { rate_only: mode.rate_only })
        console.log('\n=== ' + axis + ': окон ' + seg.windows + ', отрезков ' + seg.segments.length + ', данных ' + fmt(seg.data_s, 1) + ' с, rate_only ' + mode.rate_only + ', i_scale ' + mode.i_scale)
        console.log('    отрезки (с, длина с): ' + seg.segments.map((s) => fmt(s.t0, 1) + '+' + fmt(s.tar.length / rate, 1)).join(', '))
        console.log('    (а) ' + fmt(q.checks.ridge.value, 4) + '  (б) ' + fmt(q.checks.halves.value, 4) + '  (в) ' + fmt(q.checks.outer.value, 3) + ' на ' + fmt(q.checks.outer.freq_hz, 1) + ' Гц')

        const [h1, h2] = pidtune_halves(seg.segments, pidtune_rules.window)
        const f1 = pidtune_fir(h1, rate, fir.ridge)
        const f2 = pidtune_fir(h2, rate, fir.ridge)
        const n = fir.step.length
        const i100 = Math.round(0.1 * rate)
        console.log('    отклик на ступеньку (весь | 1-я половина | 2-я половина):')
        for (const t of [0.005, 0.01, 0.02, 0.03, 0.04, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5]) {
            const k = Math.min(n - 1, Math.round(t * rate))
            console.log('      ' + fmt(t, 3) + ' с: ' + fmt(fir.step[k]) + ' | ' + fmt(f1.step[k]) + ' | ' + fmt(f2.step[k]))
        }
        const m_all = pidtune_step_metrics(fir.time, fir.step), m1 = pidtune_step_metrics(f1.time, f1.step), m2 = pidtune_step_metrics(f2.time, f2.step)
        const mtext = (m) => m ? ('нарастание ' + fmt(m.rise_s * 1000, 1) + ' мс, перерегулирование ' + fmt(m.overshoot_pct, 1) + ' %, плато ' + fmt(m.plateau)) : '—'
        console.log('    метрики: весь — ' + mtext(m_all) + '; 1-я — ' + mtext(m1) + '; 2-я — ' + mtext(m2))
        console.log('    RMS половин: всего ' + fmt(pidtune_rms_diff(f1.step, f2.step), 4) + ', на 0–0.1 с ' + fmt(rms_range(f1.step, f2.step, 0, i100), 4) +
                    ', на 0.1–0.5 с ' + fmt(rms_range(f1.step, f2.step, i100, n), 4))

        // Через блок
        for (const B of [200, 400, 800, 1600]) {
            const [A, C] = interleave(seg.segments, B)
            const fa = pidtune_fir(A, rate, fir.ridge), fc = pidtune_fir(C, rate, fir.ridge)
            console.log('    через блок ' + fmt(B / rate, 1) + ' с: RMS ' + fmt(pidtune_rms_diff(fa.step, fc.step), 4) + ' (0–0.1 с ' + fmt(rms_range(fa.step, fc.step, 0, i100), 4) + ')')
        }

        // Четверти: отклики и условия
        const quarters = parts(seg.segments, 4)
        const fq = quarters.map((p) => pidtune_fir(p, rate, fir.ridge))
        console.log('    четверти — метрики и условия:')
        quarters.forEach((p, k) => {
            const spans = p.map((x) => [x.t0, x.t0 + x.tar.length / rate])
            const all_tar = Float64Array.from(p.flatMap((x) => Array.from(x.tar)))
            const all_out = Float64Array.from(p.flatMap((x) => Array.from(x.out)))
            const all_err = Float64Array.from(p.flatMap((x) => Array.from(x.err)))
            let maxtar = 0
            for (const v of all_tar) maxtar = Math.max(maxtar, Math.abs(v))
            let sat = 0
            for (const v of all_out) if (Math.abs(v) > 0.9) sat++
            console.log('      Q' + (k + 1) + ' ' + fmt(spans[0][0], 0) + '–' + fmt(spans[spans.length - 1][1], 0) + ' с: ' + mtext(pidtune_step_metrics(fq[k].time, fq[k].step)) +
                        '; RMS цели ' + fmt(rms(all_tar), 0) + ' °/с, max ' + fmt(maxtar, 0) + '; RMS ошибки ' + fmt(rms(all_err), 1) + '; RMS выхода ' + fmt(rms(all_out), 3) +
                        ', |выход| > 0.9: ' + fmt(100 * sat / all_out.length, 2) + ' %; газ ' + fmt(mean_in(rate_t, rate_aout, spans)) + '; батарея ' + fmt(mean_in(bat_t, bat_v, spans), 2) + ' В, ' + fmt(mean_in(bat_t, bat_c, spans), 1) + ' А')
        })
        const pair = []
        for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) pair.push('Q' + (a + 1) + '–Q' + (b + 1) + ' ' + fmt(pidtune_rms_diff(fq[a].step, fq[b].step), 3))
        console.log('    RMS четвертей попарно: ' + pair.join(', '))

        // Остатки модели по всему участку и суррогаты (модель + перемешанные блоками остатки)
        const resid = seg.segments.map((s) => {
            const y = conv(fir.h, s.tar)
            const e = new Float64Array(s.tar.length)
            for (let k = 0; k < e.length; k++) e[k] = s.act[k] - y[k]
            return { y, e }
        })
        const all_act = Float64Array.from(seg.segments.flatMap((s) => Array.from(s.act)))
        const all_e = Float64Array.from(resid.flatMap((r) => Array.from(r.e)))
        console.log('    остаток модели: RMS ' + fmt(rms(all_e), 2) + ' °/с при RMS факта ' + fmt(rms(all_act), 1) + ' °/с (' + fmt(100 * (rms(all_e) / rms(all_act)) ** 2, 2) + ' % дисперсии)')
        const BL = 512
        const pool = []
        for (const r of resid) for (let s = 0; s + BL <= r.e.length; s += BL) pool.push(r.e.subarray(s, s + BL))
        const rand = rng(12345 + i)
        const sur_b = [], sur_b_early = []
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
            const [s1, s2] = pidtune_halves(sur, pidtune_rules.window)
            const g1 = pidtune_fir(s1, rate, sf.ridge), g2 = pidtune_fir(s2, rate, sf.ridge)
            sur_b.push(pidtune_rms_diff(g1.step, g2.step))
            sur_b_early.push(rms_range(g1.step, g2.step, 0, i100))
        }
        sur_b.sort((a, b) => a - b)
        const mean = sur_b.reduce((a, b) => a + b, 0) / sur_b.length
        console.log('    суррогаты без изменений аппарата (' + N_SUR + '): (б) среднее ' + fmt(mean, 4) + ', медиана ' + fmt(sur_b[Math.floor(sur_b.length / 2)], 4) +
                    ', 90-й процентиль ' + fmt(sur_b[Math.floor(0.9 * (sur_b.length - 1))], 4) + ', макс ' + fmt(sur_b[sur_b.length - 1], 4) +
                    '; на 0–0.1 с — среднее ' + fmt(sur_b_early.reduce((a, b) => a + b, 0) / sur_b_early.length, 4))

        // Цепочка шага 4 как при пройденной (б)
        const gains = { P: set.KP, I: set.KI, D: set.KD, FF: set.FF ?? 0, DFF: set.D_FF ?? 0 }
        const filters_log = { flte: set.Error_filter, fltd: set.D_filter }
        const cc = pidtune_controller_check(source, set_index, range, gains, filters_log, loop_rate, mode.i_scale)
        const grid = pidtune_predict_grid(rate)
        const c_log = pidtune_controller(gains, filters_log, loop_rate, grid.freq, mode.i_scale)
        const pred_log = pidtune_predict(fir, c_log, c_log, null, rate)
        const coh = pidtune_coherence(seg.segments, rate, pred_log?.crossover_hz)
        const q_ok = { ...q, ok: true, reasons: [] }
        const validity = pidtune_validity(q_ok, cc, coh)
        const rule = pidtune_rule({ P: gains.P, I: gains.I, D: gains.D }, axis, m_all, seg.data_s, q_ok)
        const slim = (o) => JSON.stringify(o, (k, v) => (Array.isArray(v) || ArrayBuffer.isView(v)) && v.length > 8 ? '[' + v.length + ']' : (typeof v === 'number' ? +v.toPrecision(4) : v))
        console.log('    сверка регулятора: ' + slim(cc))
        console.log('    прогноз лога: ' + slim(pred_log && { crossover_hz: pred_log.crossover_hz, pm_deg: pred_log.pm_deg, pm_note: pred_log.pm_note, metrics: pred_log.metrics, noncausal: pred_log.noncausal, stable: pred_log.stable }))
        console.log('    когерентность на частоте среза: ' + fmt(coh) + '; достоверность (если бы (б) прошла): ' + slim(validity))
        console.log('    правило (если бы (б) прошла): ' + slim(rule))
    }
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
