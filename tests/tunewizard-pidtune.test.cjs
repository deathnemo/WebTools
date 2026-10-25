// Тесты шага 4 мастера настройки (TuneWizard/core/pidtune.js): метрики отклика на известных системах, КИХ МНК
// на синтетическом замкнутом контуре против правды, проверки качества измерения (и их отказ с угловым контуром и при
// смене объекта), шум D, режим лога и правила PID.
// Скрипты ядра — классические (общая глобальная область), поэтому загружаются как на странице:
// по порядку через vm.runInThisContext (как в tests/tunewizard-pid.test.cjs).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const repo = path.resolve(__dirname, '..')

// FFTJS на странице — глобал из modules/fft.js/dist/fft.js; под Node берём ту же библиотеку через require
globalThis.FFTJS = require('../modules/fft.js/lib/fft.js')

// Загрузить скрипты страницы в глобальную область, в том порядке, что и index.html
function load_page_scripts(files) {
    for (const file of files) {
        const full = path.join(repo, file)
        vm.runInThisContext(fs.readFileSync(full, 'utf8'), { filename: full })
    }
}

// Скрипты ядра до core/pidtune.js в порядке страницы (core/checks.js и часть библиотек страницы не нужны)
load_page_scripts([
    'Libraries/Array_Math.js',
    'Libraries/fft.js',
    'TuneWizard/core/log.js',
    'TuneWizard/core/gyro.js',
    'TuneWizard/core/tracking/Atmosphere_model.js',
    'TuneWizard/core/tracking/BaseClass.js',
    'TuneWizard/core/tracking/Static.js',
    'TuneWizard/core/tracking/Throttle.js',
    'TuneWizard/core/tracking/RPM.js',
    'TuneWizard/core/tracking/ESC.js',
    'TuneWizard/core/tracking/FFT.js',
    'TuneWizard/core/tracking/Logged.js',
    'TuneWizard/core/filters.js',
    'TuneWizard/core/spectrum.js',
    'TuneWizard/core/metrics.js',
    'TuneWizard/core/autofit.js',
    'TuneWizard/core/candidates.js',
    'TuneWizard/core/lowpass.js',
    'TuneWizard/core/pid.js',
    'TuneWizard/core/pidtune.js',
])

const R2D = 180 / Math.PI
const RATE_HZ = 400
const DT = 1 / RATE_HZ

// ---------------------------------------------------------------- поддельный лог

// Поддельный лог с интерфейсом парсера: messages = { ИМЯ: { поле: массив } } (без экземпляров),
// params = [[имя, значение, время с], ...] — сообщения PARM (Name, Value, TimeUS)
function fake_log({ messages = {}, params = [] } = {}) {
    const types = { ...messages }
    if (params.length > 0) {
        types.PARM = {
            TimeUS: params.map((p) => Math.round((p[2] ?? 0) * 1e6)),
            Name: params.map((p) => p[0]),
            Value: params.map((p) => p[1])
        }
    }
    return {
        messageTypes: Object.fromEntries(Object.keys(types).map((name) => [name, {}])),
        get(name, field) {
            const msg = types[name]
            if (msg == null) return undefined
            return field ? msg[field] : msg
        }
    }
}

// Параметры регулятора крена в начале лога (0.5 с)
function roll_params(g) {
    return [['ATC_RAT_RLL_P', g.kp, 0.5], ['ATC_RAT_RLL_I', g.ki, 0.5], ['ATC_RAT_RLL_D', g.kd, 0.5], ['ATC_RAT_RLL_FF', 0, 0.5],
            ['ATC_RAT_RLL_FLTD', g.fltd, 0.5], ['ATC_RAT_RLL_FLTE', 0, 0.5], ['ATC_RAT_RLL_FLTT', 0, 0.5]]
}

// Ось крена (load_pid, PIDR) из полёта sim: Tar, Act в рад/с, компоненты регулятора
function sim_axis(sim, g) {
    const log = fake_log({
        messages: { PIDR: { TimeUS: sim.TimeUS, Tar: sim.Tar, Act: sim.Act, Err: sim.Err, P: sim.P, I: sim.I, D: sim.D, FF: sim.FF } },
        params: roll_params(g)
    })
    return load_pid(log, { build_type: 2 }).axes[0]
}

// ---------------------------------------------------------------- синтетический замкнутый контур

// Детерминированный генератор (LCG), значения (0, 1)
function lcg(seed) {
    let s = seed >>> 0
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0
        return (s + 0.5) / 4294967296
    }
}

// Нормальный шум по Боксу — Мюллеру
function gauss(rnd) {
    return () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd())
}

// Регулятор — AC_PID::update_all (libraries/AC_PID/AC_PID.cpp) без notch, slew и PDMX: фильтры первого порядка цели
// (FLTT), ошибки (FLTE) и производной ошибки (FLTD), интегратор с IMAX и множителем i_scale. Всё в рад/с
function make_pid(g) {
    const alpha = (fc) => (fc > 0) ? DT / (DT + 1 / (2 * Math.PI * fc)) : 1
    let reset = true
    let target = 0
    let error = 0
    let derivative = 0
    let integrator = 0
    return (tar, meas) => {
        if (reset) {
            reset = false
            target = tar
            error = target - meas
            derivative = 0
        } else {
            target += alpha(g.fltt ?? 0) * (tar - target)
            const error_last = error
            error += alpha(g.flte ?? 0) * (target - meas - error)
            derivative += alpha(g.fltd ?? 0) * ((error - error_last) / DT - derivative)
        }
        integrator = Math.max(-g.imax, Math.min(g.imax, integrator + error * g.ki * (g.i_scale ?? 1) * DT))
        const P = error * g.kp
        const D = derivative * g.kd
        return { target, error, P, I: integrator, D, out: P + integrator + D }
    }
}

// LowPassFilter2p ArduPilot (DigitalBiquadFilter::compute_params) — фильтр гироскопа
function make_biquad(sample_hz, cutoff_hz) {
    const ohm = Math.tan(Math.PI * cutoff_hz / sample_hz)
    const c = 1 + 2 * Math.cos(Math.PI / 4) * ohm + ohm * ohm
    const b0 = ohm * ohm / c
    const a1 = 2 * (ohm * ohm - 1) / c
    const a2 = (1 - 2 * Math.cos(Math.PI / 4) * ohm + ohm * ohm) / c
    let d1 = 0
    let d2 = 0
    return (x) => {
        const d0 = x - d1 * a1 - d2 * a2
        const y = b0 * (d0 + 2 * d1 + d2)
        d2 = d1
        d1 = d0
        return y
    }
}

// Объект «выход регулятора → факт» на SUB подшагах периода контура: транспортная задержка, мотор первого порядка,
// момент K·m (рад/с² на единицу выхода) с возмущением, интегратор со слабым демпфированием (скорость), шум датчика,
// фильтр гироскопа 40 Гц
const SUB = 4
function make_plant(p) {
    const h = DT / SUB
    const am = 1 - Math.exp(-h / p.tau)
    const delay = new Float64Array(Math.round(p.delay_s / h) + 1)
    let di = 0
    let m = 0
    let w = 0
    let meas = 0
    const gyro = make_biquad(RATE_HZ * SUB, 40)
    // step(u, dist, noise) → { meas, w }: dist() — возмущение рад/с², noise() — шум датчика рад/с
    return (u, dist, noise) => {
        for (let s = 0; s < SUB; s++) {
            delay[di] = u
            di = (di + 1) % delay.length
            m += am * (delay[di] - m)
            w += (p.K * m - w / 0.5 + dist()) * h
            meas = gyro(w + noise())
        }
        return { meas, w }
    }
}

// Объекты: «норма» (перерегулирование правды ≈ 10 % при регуляторе G0), «быстрый» и «вялый»
const PLANT_NORMAL = { K: 190, tau: 0.05, delay_s: 0.012 }
const PLANT_FAST = { K: 290, tau: 0.05, delay_s: 0.012 }
const PLANT_SLOW = { K: 125, tau: 0.05, delay_s: 0.012 }
// Регулятор как у крена лога пользователя (AutoTune: P = I), FLTD 30 Гц
const G0 = { kp: 0.1163, ki: 0.1163, kd: 0.00293, fltd: 30, imax: 0.5 }

// Команда пилота, рад/с: резкие отклонения стика 30–200 °/с на 0.15–0.6 с вперемешку с паузами (доля pause),
// сглаживание первым порядком rate_tc (как ACRO_RP_RATE_TC)
function pilot(n, seed, pause = 0.3, rate_tc = 0.02) {
    const rnd = lcg(seed)
    const req = new Float64Array(n)
    let k = 0
    while (k < n) {
        const dur = Math.round((0.15 + 0.45 * rnd()) * RATE_HZ)
        const amp = ((rnd() < 0.5) ? -1 : 1) * (30 + 170 * rnd()) / R2D
        const value = (rnd() < pause) ? 0 : amp
        for (let i = 0; (i < dur) && (k < n); i++, k++) {
            req[k] = value
        }
    }
    const a = 1 - Math.exp(-DT / rate_tc)
    let y = 0
    for (let i = 0; i < n; i++) {
        y += a * (req[i] - y)
        req[i] = y
    }
    return req
}

// Полёт: o = { dur_s, seed, plant, plant2 (объект второй половины полёта), outer (угловой контур формирует цель из
// факта, как в Acro без Rate Loop Only при ATC_RATE_FF_ENAB = 0), ang_p, pause, dist_dps2 (низкочастотное возмущение,
// СКО °/с²), turb_dps2 (широкополосное, °/с²), noise_dps (шум датчика, °/с) }. → поля PIDR (рад/с) и TimeUS
function simulate(g, o) {
    const n = Math.round(o.dur_s * RATE_HZ)
    const req = pilot(n, o.seed, o.pause ?? 0.3)
    const pid = make_pid(g)
    let plant = make_plant(o.plant)
    const gd = gauss(lcg(o.seed * 13 + 5))
    const gt = gauss(lcg(o.seed * 19 + 1))
    const gn = gauss(lcg(o.seed * 17 + 11))
    const ad = 1 - Math.exp(-2 * Math.PI * 2 * DT / SUB)
    const sd = (o.dist_dps2 ?? 30) / R2D * Math.sqrt((2 - ad) / ad)
    let lp = 0
    const dist = () => {
        lp += ad * (gd() * sd - lp)
        return lp + gt() * (o.turb_dps2 ?? 300) / R2D
    }
    const noise = () => gn() * (o.noise_dps ?? 0.5) / R2D
    const sim = { TimeUS: new Array(n), Tar: new Array(n), Act: new Array(n), Err: new Array(n), P: new Array(n), I: new Array(n), D: new Array(n), FF: new Array(n) }
    let meas = 0
    let angle = 0
    let angle_target = 0
    for (let k = 0; k < n; k++) {
        if ((o.plant2 != null) && (k == (n >> 1))) {
            plant = make_plant(o.plant2)
        }
        angle_target += req[k] * DT
        const tar = o.outer ? (o.ang_p ?? 7.5) * (angle_target - angle) : req[k]
        const r = pid(tar, meas)
        sim.TimeUS[k] = Math.round(k * DT * 1e6)
        sim.Tar[k] = r.target
        sim.Act[k] = meas
        sim.Err[k] = r.error
        sim.P[k] = r.P
        sim.I[k] = r.I
        sim.D[k] = r.D
        sim.FF[k] = 0
        const st = plant(r.out, dist, noise)
        meas = st.meas
        angle += st.w * DT
    }
    return sim
}

// «Правда»: факт на единичную ступеньку цели без шума и возмущений (линейный контур, IMAX не мешает), 0…len_s
function truth_step(g, p, len_s = 0.5) {
    const n = Math.round(len_s * RATE_HZ) + 1
    const pid = make_pid({ ...g, imax: 1e9 })
    const plant = make_plant(p)
    pid(0, 0)
    const time = new Array(n)
    const y = new Array(n)
    let meas = 0
    for (let k = 0; k < n; k++) {
        const r = pid(1, meas)
        time[k] = k * DT
        y[k] = meas
        meas = plant(r.out, () => 0, () => 0).meas
    }
    return { time, y }
}

// Отклик КИХ и проверки качества полёта sim на всём интервале
function measure(sim, g) {
    const axis = sim_axis(sim, g)
    const seg = pidtune_segments(axis, 0, [0, 1e9])
    const fir = pidtune_fir(seg.segments, seg.rate_hz)
    const quality = pidtune_quality(seg.segments, seg.rate_hz, fir)
    return { axis, seg, fir, quality, metrics: pidtune_step_metrics(fir.time, fir.step) }
}

function close_to(actual, expected, tol, what) {
    assert.ok(Math.abs(actual - expected) <= tol, what + ': ' + actual + ' против ' + expected + ' (допуск ' + tol + ')')
}

// ---------------------------------------------------------------- правила

test('pidtune_rules: порог частоты лога — тот же, что у отклика PIDReview и шага 0 (PID_STEP_MIN_RATE с запасом, 99 Гц)', () => {
    assert.equal(pidtune_rules.min_log_rate_hz, PID_STEP_MIN_RATE * PID_STEP_RATE_MARGIN)
    assert.equal(pidtune_rules.min_log_rate_hz, 99)
})

// ---------------------------------------------------------------- метрики

// Ступенька системы второго порядка: 1 − e^(−ζωt)·(cos ω_d t + ζ/√(1−ζ²)·sin ω_d t)
function second_order(zeta, wn) {
    const wd = wn * Math.sqrt(1 - zeta * zeta)
    return (t) => 1 - Math.exp(-zeta * wn * t) * (Math.cos(wd * t) + zeta / Math.sqrt(1 - zeta * zeta) * Math.sin(wd * t))
}

// Время первого достижения уровня функцией f (мелкий шаг + бисекция)
function first_reach(f, level) {
    let t = 0
    while (f(t) < level) {
        t += 1e-4
    }
    let a = t - 1e-4
    let b = t
    for (let i = 0; i < 60; i++) {
        const m = (a + b) / 2
        if (f(m) < level) {
            a = m
        } else {
            b = m
        }
    }
    return (a + b) / 2
}

function sampled(f, len_s = 0.5) {
    const n = Math.round(len_s * RATE_HZ) + 1
    const time = Array.from({ length: n }, (_, i) => i * DT)
    return { time, y: time.map(f) }
}

test('pidtune_step_metrics: второй порядок — перерегулирование exp(−πζ/√(1−ζ²)), нарастание 10–90 %, установление от плато', () => {
    for (const [zeta, fn] of [[0.5, 8], [0.7, 6], [0.4, 10]]) {
        const wn = 2 * Math.PI * fn
        const f = second_order(zeta, wn)
        const { time, y } = sampled(f)
        const m = pidtune_step_metrics(time, y)
        const what = 'ζ ' + zeta + ', ' + fn + ' Гц'
        close_to(m.overshoot_pct, 100 * Math.exp(-Math.PI * zeta / Math.sqrt(1 - zeta * zeta)), 0.2, what + ': перерегулирование')
        const rise = first_reach(f, 0.9) - first_reach(f, 0.1)
        close_to(m.rise_s, rise, 0.0005, what + ': нарастание')
        close_to(m.bandwidth_hz, 0.35 / m.rise_s, 1e-12, what + ': полоса')
        // Плато — среднее на 0.3–0.5 с; установление — после последнего выхода из ±5 % от плато (с точностью до отсчёта)
        let sum = 0
        let count = 0
        for (let i = 0; i < time.length; i++) {
            if (time[i] >= 0.3 - 1e-9) {
                sum += y[i]
                count++
            }
        }
        close_to(m.plateau, sum / count, 1e-12, what + ': плато')
        let settle = 0
        for (let t = 0; t <= 0.5; t += 1e-5) {
            if (Math.abs(f(t) - m.plateau) > 0.05 * m.plateau) settle = t
        }
        assert.ok((m.settle_s >= settle) && (m.settle_s <= settle + DT + 1e-9), what + ': установление ' + m.settle_s + ', выход из полосы в ' + settle)
        assert.equal(m.osc, null, what + ': затухающий переходный процесс — не остаточные колебания')
    }
})

test('pidtune_step_metrics: апериодический отклик — без перерегулирования, нарастание τ·ln 9, установление 3τ', () => {
    const tau = 0.03
    const { time, y } = sampled((t) => 1 - Math.exp(-t / tau))
    const m = pidtune_step_metrics(time, y)
    assert.equal(m.overshoot_pct, 0)
    close_to(m.rise_s, tau * Math.log(9), 0.0005, 'нарастание')
    close_to(m.plateau, 1, 1e-4, 'плато')
    // 1 − e^(−t/τ) входит в ±5 % от плато ≈ 1 при t = τ·ln 20 ≈ 3τ
    close_to(m.settle_s, tau * Math.log(20), DT, 'установление')
    assert.equal(m.osc, null)
})

test('pidtune_step_metrics: колебания на плато — размах 0.1 выше порога 0.08 (частота и размах), 0.06 ниже — нет', () => {
    for (const [a, expect_osc] of [[0.05, true], [0.03, false]]) {
        const f = (t) => 1 - Math.exp(-t / 0.02) + ((t >= 0.15) ? a * Math.sin(2 * Math.PI * 30 * (t - 0.15)) : 0)
        const { time, y } = sampled(f)
        const m = pidtune_step_metrics(time, y)
        if (expect_osc) {
            assert.ok(m.osc != null, 'размах ' + 2 * a + ': колебания должны найтись')
            close_to(m.osc.freq_hz, 30, 0.5, 'частота колебаний')
            close_to(m.osc.amplitude_pp, 2 * a, 0.005, 'размах колебаний')
        } else {
            assert.equal(m.osc, null, 'размах ' + 2 * a + ' ниже порога')
        }
    }
    // Колебания, не дающие установиться (размах больше полосы ±5 %), видны на плато
    const { time, y } = sampled((t) => 1 - Math.exp(-t / 0.02) + 0.08 * Math.sin(2 * Math.PI * 20 * t))
    const m = pidtune_step_metrics(time, y)
    assert.ok(m.osc != null, 'колебания размахом 0.16 без установления')
    close_to(m.osc.freq_hz, 20, 0.5, 'частота')
    close_to(m.osc.amplitude_pp, 0.16, 0.01, 'размах')
})

test('pidtune_step_metrics: не дошёл до 0.9 — нарастания и полосы нет; не установился — установления нет; нечисловое — null', () => {
    const slow = sampled((t) => 0.8 * (1 - Math.exp(-t / 0.03)))
    const m = pidtune_step_metrics(slow.time, slow.y)
    assert.equal(m.rise_s, null)
    assert.equal(m.bandwidth_hz, null)
    assert.equal(m.overshoot_pct, 0)
    close_to(m.plateau, 0.8, 1e-4, 'плато')
    // Линейный рост до 1 к 0.5 с: плато 0.8, в конце 1.0 — вне ±5 % от плато
    const ramp = sampled((t) => 2 * t)
    const r = pidtune_step_metrics(ramp.time, ramp.y)
    close_to(r.plateau, 0.8, 1e-9, 'плато')
    assert.equal(r.settle_s, null)
    assert.equal(r.osc, null, 'дрейф — не колебания')
    // NaN и Infinity в отклике — метрик нет, правило — «нет отклика»
    for (const bad of [NaN, Infinity]) {
        const y = slow.y.slice()
        y[50] = bad
        assert.equal(pidtune_step_metrics(slow.time, y), null, String(bad))
    }
    assert.equal(pidtune_step_metrics([], []), null)
    assert.equal(pidtune_rule({ P: 0.1, I: 0.1, D: 0.003 }, 'roll', null, 100, { ok: true, checks: {}, reasons: [] }).reason, 'нет отклика')
})

// ---------------------------------------------------------------- КИХ МНК и проверки качества

test('pidtune_fir: rate-only контур (угловой контур выключен) — отклик КИХ совпадает с правдой, проверки (а)–(в) проходят', () => {
    for (const plant of [PLANT_NORMAL, PLANT_FAST, PLANT_SLOW]) {
        const sim = simulate(G0, { dur_s: 150, seed: 3, plant })
        const { seg, fir, quality, metrics } = measure(sim, G0)
        const truth = pidtune_step_metrics(...Object.values(truth_step(G0, plant)))
        const what = 'K ' + plant.K
        assert.ok(seg.data_s >= pidtune_rules.min_data_s, what + ': данных ' + seg.data_s + ' с')
        assert.ok(seg.windows > 0)
        assert.equal(fir.h.length, RATE_HZ * pidtune_rules.fir_length_s, what + ': длина КИХ 1 с')
        assert.equal(fir.step.length, RATE_HZ * pidtune_rules.step_length_s + 1, what + ': отклик 0…0.5 с')
        close_to(metrics.overshoot_pct, truth.overshoot_pct, 2, what + ': перерегулирование, %')
        close_to(metrics.rise_s, truth.rise_s, 0.005, what + ': нарастание, с')
        assert.equal(quality.ok, true, what + ': ' + quality.reasons.join('; '))
        assert.deepEqual(quality.reasons, [])
    }
})

test('pidtune_quality: угловой контур формирует цель из факта (Acro без Rate Loop Only) — проверка (в) не проходит', () => {
    const sim = simulate(G0, { dur_s: 150, seed: 5, plant: PLANT_NORMAL, outer: true, pause: 0.9, turb_dps2: 2000 })
    const { quality } = measure(sim, G0)
    assert.equal(quality.checks.outer.ok, false, 'наибольшее |T| ' + quality.checks.outer.value)
    assert.ok(quality.checks.outer.value > pidtune_rules.quality.outer_t_max)
    assert.equal(quality.ok, false)
    assert.ok(quality.reasons.some((r) => r.includes('углового контура')), quality.reasons.join('; '))
})

test('pidtune_quality: объект сменился в середине данных — проверка (б) не проходит', () => {
    const sim = simulate(G0, { dur_s: 150, seed: 7, plant: PLANT_SLOW, plant2: PLANT_FAST })
    const { quality } = measure(sim, G0)
    assert.equal(quality.checks.halves.ok, false, 'RMS половин ' + quality.checks.halves.value)
    assert.ok(quality.checks.halves.value > pidtune_rules.quality.halves_rms_max)
    assert.equal(quality.ok, false)
    assert.ok(quality.reasons.some((r) => r.includes('половины данных')), quality.reasons.join('; '))
})

// Отрезок из белого шума цели (°/с) длиной n и факт act(tar, k)
function noise_segment(n, seed, act) {
    const g = gauss(lcg(seed))
    const tar = Float64Array.from({ length: n }, () => 50 * g())
    return { start_time: 0, tar, act: Float64Array.from({ length: n }, (_, k) => act(tar, k)), starts: [0] }
}

test('pidtune_fir: h[0] = 0 — факт = цель со сдвигом на отсчёт даёт h[1] ≈ 1, как и решение без ограничения; без сдвига h[0] остаётся 0', () => {
    const segs = [noise_segment(3000, 11, (tar, k) => (k > 0) ? tar[k - 1] : 0), noise_segment(3000, 12, (tar, k) => (k > 0) ? tar[k - 1] : 0)]
    const fir = pidtune_fir(segs, RATE_HZ)
    assert.equal(fir.h[0], 0)
    close_to(fir.h[1], 1, 0.005, 'h[1]')
    let rest = 0
    for (let i = 2; i < fir.h.length; i++) rest = Math.max(rest, Math.abs(fir.h[i]))
    assert.ok(rest < 0.01, 'остальные отводы ' + rest)
    // Решение той же системы без ограничения (все отводы свободны) — то же: ограничение ничего не искажает, если прямой
    // связи в данных нет
    const corr = fir.corr
    const free = pidtune_toeplitz_solve(corr.crr, corr.cry, pidtune_rules.fir_ridge * corr.crr[0])
    assert.ok(Math.abs(free[0]) < 0.01, 'h[0] без ограничения ' + free[0])
    for (let i = 1; i < fir.h.length; i++) {
        assert.ok(Math.abs(free[i] - fir.h[i]) < 0.01, 'отвод ' + i + ': ' + free[i] + ' против ' + fir.h[i])
    }
    // Факт = цель без сдвига: без ограничения h[0] ≈ 1, с ограничением h[0] = 0
    const same = pidtune_fir([noise_segment(3000, 13, (tar, k) => tar[k])], RATE_HZ)
    assert.equal(same.h[0], 0)
    const same_free = pidtune_toeplitz_solve(same.corr.crr, same.corr.cry, pidtune_rules.fir_ridge * same.corr.crr[0])
    close_to(same_free[0], 1, 0.005, 'h[0] без ограничения')
})

test('pidtune_quality: Rate Loop Only — подпись углового контура не применяется: перерегулирование 40 % — качество есть, P −10 %', () => {
    const plant = { K: 380, tau: 0.05, delay_s: 0.012 }
    const truth = pidtune_step_metrics(...Object.values(truth_step(G0, plant)))
    assert.ok((truth.overshoot_pct > 35) && (truth.overshoot_pct < 45), 'правда ' + truth.overshoot_pct)
    const { seg, fir, metrics } = measure(simulate(G0, { dur_s: 150, seed: 3, plant }), G0)
    close_to(metrics.overshoot_pct, truth.overshoot_pct, 2, 'перерегулирование КИХ')
    // Резонансный пик |T| плохо задемпфированного контура выше 1.5 — без режима проверка (в) приняла бы его за угловой контур
    const plain = pidtune_quality(seg.segments, seg.rate_hz, fir)
    assert.equal(plain.checks.outer.ok, false)
    assert.ok(plain.checks.outer.value > pidtune_rules.quality.outer_t_max)
    assert.equal(plain.checks.ridge.ok && plain.checks.halves.ok, true)
    // В Rate Loop Only — не применяется, в итог не входит
    const quality = pidtune_quality(seg.segments, seg.rate_hz, fir, { rate_only: true })
    assert.equal(quality.ok, true, quality.reasons.join('; '))
    assert.deepEqual(quality.reasons, [])
    assert.equal(quality.checks.outer.applied, false)
    assert.equal(quality.checks.outer.ok, null)
    assert.ok(quality.checks.outer.note.includes('Rate Loop Only'))
    close_to(quality.checks.outer.value, plain.checks.outer.value, 1e-12, 'значение (в) всё равно считается')
    const rule = pidtune_rule({ P: G0.kp, I: G0.ki, D: G0.kd }, 'roll', metrics, seg.data_s, quality)
    assert.equal(rule.change, 'P-', rule.reason)
    // Тот же объект в Acro без Rate Loop Only (угловой контур формирует цель) — по-прежнему ненадёжно
    const outer = measure(simulate(G0, { dur_s: 150, seed: 5, plant, outer: true, pause: 0.9, turb_dps2: 2000 }), G0)
    assert.equal(outer.quality.ok, false)
    assert.equal(outer.quality.checks.outer.applied, true)
    assert.equal(outer.quality.checks.outer.ok, false)
})

test('pidtune_quality: не пройдена только (а) — измерение ненадёжно, причина одна', () => {
    const { seg, fir } = measure(simulate(G0, { dur_s: 150, seed: 3, plant: PLANT_NORMAL }), G0)
    const strict = { ...pidtune_rules, quality: { ...pidtune_rules.quality, ridge_rms_max: 1e-5 } }
    const quality = pidtune_quality(seg.segments, seg.rate_hz, fir, {}, strict)
    assert.deepEqual([quality.checks.ridge.ok, quality.checks.halves.ok, quality.checks.outer.ok], [false, true, true])
    assert.equal(quality.ok, false)
    assert.equal(quality.reasons.length, 1)
    assert.ok(quality.reasons[0].includes('регуляризации'), quality.reasons[0])
    assert.ok(pidtune_rule({ P: G0.kp, I: G0.ki, D: G0.kd }, 'roll', null, seg.data_s, quality).reason.startsWith('измерение ненадёжно'))
})

test('pidtune_rule: короткий полёт (6 с) — «мало манёвров», а не причина качества', () => {
    const { seg, quality, metrics } = measure(simulate(G0, { dur_s: 6, seed: 3, plant: PLANT_NORMAL }), G0)
    assert.ok(seg.windows > 10, 'окон ' + seg.windows + ' — по старому порогу в окнах данных хватило бы')
    assert.ok(seg.data_s < pidtune_rules.min_data_s, 'данных ' + seg.data_s + ' с')
    const rule = pidtune_rule({ P: G0.kp, I: G0.ki, D: G0.kd }, 'roll', metrics, seg.data_s, quality)
    assert.equal(rule.change, null)
    assert.ok(rule.reason.startsWith('мало манёвров'), rule.reason)
})

test('pidtune_halves: пополам по отсчётам — отрезок на середине режется, окна — только целиком в своей части', () => {
    const seg = (n, starts) => ({ start_time: 0, tar: Float64Array.from({ length: n }, (_, k) => k), act: new Float64Array(n), starts })
    // 1000 + 600 + 400: середина ровно на границе
    const [a1, a2] = pidtune_halves([seg(1000, [0, 500]), seg(600, [0]), seg(400, [0])], 100)
    assert.deepEqual(a1.map((s) => s.tar.length), [1000])
    assert.deepEqual(a2.map((s) => s.tar.length), [600, 400])
    // 700 + 700 + 600: второй отрезок режется на 300 + 400
    const [b1, b2] = pidtune_halves([seg(700, [0]), seg(700, [0, 150, 250, 300, 500]), seg(600, [0])], 100)
    assert.deepEqual(b1.map((s) => s.tar.length), [700, 300])
    assert.deepEqual(b2.map((s) => s.tar.length), [400, 600])
    assert.deepEqual(b1[1].starts, [0, 150], 'окна [s, s + 100) до разреза')
    assert.deepEqual(b2[0].starts, [0, 200], 'окна после разреза, сдвинутые к началу части')
    assert.equal(b2[0].tar[0], 300, 'вторая часть начинается с отсчёта разреза')
    // Пусто — две пустые половины
    assert.deepEqual(pidtune_halves([], 100), [[], []])
})

test('pidtune_outer_peak: факт = g·цель — наибольшее |T| = g в полосе 4–12 Гц; без окон и с пустой полосой — null', () => {
    for (const g of [2, 1.2]) {
        const seg = noise_segment(4000, 21, (tar, k) => g * tar[k])
        seg.starts = [0, 512, 1024, 2000, 3000]
        const peak = pidtune_outer_peak([seg], RATE_HZ)
        close_to(peak.value, g, 1e-9, '|T|')
        assert.ok((peak.freq_hz >= 4) && (peak.freq_hz <= 12), 'частота ' + peak.freq_hz)
    }
    const seg = noise_segment(1000, 22, (tar, k) => tar[k])
    assert.equal(pidtune_outer_peak([{ ...seg, starts: [] }], RATE_HZ), null, 'нет окон')
    const empty = { ...pidtune_rules, quality: { ...pidtune_rules.quality, outer_band_hz: [300, 400] } }
    assert.equal(pidtune_outer_peak([seg], RATE_HZ, empty), null, 'полоса выше Найквиста')
})

test('pidtune_fir: нет отрезков, частота лога ниже 99 Гц или цель нулевая — null', () => {
    const seg = { tar: Float64Array.from({ length: 1000 }, (_, k) => 50 * Math.sin(k / 30)), act: new Float64Array(1000), starts: [0] }
    assert.equal(pidtune_fir([], RATE_HZ), null)
    assert.equal(pidtune_fir(null, RATE_HZ), null)
    assert.equal(pidtune_fir([seg], 98.9), null, 'ниже PID_STEP_MIN_RATE·PID_STEP_RATE_MARGIN отклик не считается')
    assert.ok(pidtune_fir([seg], 99) != null, 'ровно на пороге — считается')
    assert.equal(pidtune_fir([{ ...seg, tar: new Float64Array(1000) }], RATE_HZ), null, 'нет энергии цели')
    // Нечисловое в факте или цели — null, а не NaN в отклике
    for (const [key, bad] of [['act', NaN], ['act', Infinity], ['tar', NaN], ['tar', -Infinity]]) {
        const broken = { ...seg, [key]: Float64Array.from(seg[key]) }
        broken[key][500] = bad
        assert.equal(pidtune_fir([seg, broken], RATE_HZ), null, key + ' = ' + bad)
    }
    // Без отклика проверки не проходят, причина названа
    const quality = pidtune_quality([], RATE_HZ, null)
    assert.equal(quality.ok, false)
    assert.deepEqual([quality.checks.ridge.value, quality.checks.halves.value, quality.checks.outer.value], [null, null, null])
    assert.equal(quality.reasons.length, 1)
})

test('pidtune_segments: окна 512 с шагом 32, |цель·Ханн| ≥ 20 °/с и центр в интервале; перекрывающиеся сливаются', () => {
    // Цель 0…5 с — 10 °/с, 5…10 с — 60 °/с, 10…15 с — 10 °/с: окна только у средней части
    const n = 15 * RATE_HZ
    const amp = (k) => ((k >= 5 * RATE_HZ) && (k < 10 * RATE_HZ)) ? 60 : 10
    const tar = Array.from({ length: n }, (_, k) => amp(k) * Math.sin(2 * Math.PI * 2 * k * DT) / R2D)
    const zero = tar.map(() => 0)
    const sim = { TimeUS: tar.map((_, k) => Math.round(k * DT * 1e6)), Tar: tar, Act: tar, Err: zero, P: zero, I: zero, D: zero, FF: zero }
    const axis = sim_axis(sim, G0)
    const batch = axis.sets[0][0]
    // Независимый подсчёт окон
    const w = hanning(512)
    const count = (range) => {
        let c = 0
        for (let s = 0; s + 512 <= batch.Tar.length; s += 32) {
            const center = batch.time[s + 256]
            if ((center < range[0]) || (center > range[1])) continue
            let max = 0
            for (let i = 0; i < 512; i++) max = Math.max(max, Math.abs(batch.Tar[s + i] * w[i]))
            if (max >= 20) c++
        }
        return c
    }
    const all = pidtune_segments(axis, 0, [0, 100])
    assert.equal(all.windows, count([0, 100]))
    assert.ok(all.windows > 0)
    assert.equal(all.segments.length, 1, 'перекрывающиеся окна — один отрезок')
    assert.equal(all.segments[0].starts.length, all.windows)
    close_to(all.rate_hz, RATE_HZ, 1e-6, 'частота')
    // Отрезок покрывает окна целиком и лежит у средней части (с захватом краёв окон)
    const seg = all.segments[0]
    assert.equal(seg.tar.length, seg.starts[seg.starts.length - 1] + 512)
    assert.ok((seg.start_time > 3) && (seg.start_time < 6), 'начало отрезка ' + seg.start_time)
    // Интервал отсекает окна по центру
    const part = pidtune_segments(axis, 0, [7, 100])
    assert.equal(part.windows, count([7, 100]))
    assert.ok(part.windows < all.windows)
    // Секунды отобранных данных — время отрезка без повторов перекрытий
    close_to(all.data_s, seg.tar.length / RATE_HZ, 1e-9, 'секунды данных')
    const outside = pidtune_segments(axis, 0, [20, 30])
    assert.equal(outside.windows, 0, 'вне данных — окон нет, но данные и частота есть')
    assert.equal(outside.data_s, 0)
    assert.deepEqual(outside.segments, [])
    // Нет данных — null
    assert.equal(pidtune_segments(axis, 5, [0, 100]), null)
    assert.equal(pidtune_segments({ have_data: false }, 0, [0, 100]), null)
    assert.equal(pidtune_segments(null, 0, [0, 100]), null)
})

// ---------------------------------------------------------------- шум D

// Лог PIDR 10…30 с с D-составляющей d(k); FFT окном 512
function d_axis(d) {
    const n = 20 * RATE_HZ
    const TimeUS = Array.from({ length: n }, (_, k) => Math.round((10 + k * DT) * 1e6))
    const zero = TimeUS.map(() => 0)
    const tar = TimeUS.map((_, k) => Math.sin(k / 40))
    const D = TimeUS.map((_, k) => d(k))
    const log = fake_log({ messages: { PIDR: { TimeUS, Tar: tar, Act: tar, Err: zero, P: zero, I: zero, D, FF: zero } }, params: roll_params(G0) })
    const axis = load_pid(log, { build_type: 2 }).axes[0]
    pid_run_batch_fft(axis.sets, 512)
    return axis
}

// Лог RATE 10…30 с — без компонент регулятора
function rate_axis() {
    const n = 20 * RATE_HZ
    const TimeUS = Array.from({ length: n }, (_, k) => Math.round((10 + k * DT) * 1e6))
    const v = TimeUS.map((_, k) => Math.sin(k / 40))
    const RATE = { TimeUS, R: v, RDes: v, ROut: v, P: v, PDes: v, POut: v, Y: v, YDes: v, YOut: v }
    return load_pid(fake_log({ messages: { RATE }, params: roll_params(G0) }), { build_type: 2 }).axes[3]
}

test('pidtune_d_noise: СКО D выше 50 Гц по спектру D — синусоида 80 Гц учитывается, 10 Гц нет; порог −40 дБ', () => {
    for (const [a, over] of [[0.01, false], [0.03, true]]) {
        const axis = d_axis((k) => a * Math.sin(2 * Math.PI * 80 * k * DT) + 0.05 * Math.sin(2 * Math.PI * 10 * k * DT))
        const noise = pidtune_d_noise(axis, 0, [12, 28])
        close_to(noise.rms, a / Math.SQRT2, a / Math.SQRT2 * 0.02, 'СКО D выше 50 Гц, амплитуда ' + a)
        close_to(noise.dB, 20 * Math.log10(a / Math.SQRT2), 0.2, 'дБ, амплитуда ' + a)
        assert.equal(noise.over, over, 'выше порога ' + pidtune_rules.d_noise_threshold + ' дБ: ' + noise.dB)
        assert.ok(noise.windows > 0)
    }
    // D выключен (вся D-составляющая нулевая) — off, дБ нет, порог не превышен
    const off = pidtune_d_noise(d_axis(() => 0), 0, [12, 28])
    assert.deepEqual({ dB: off.dB, rms: off.rms, off: off.off, over: off.over }, { dB: null, rms: 0, off: true, over: false })
    // D только на низких частотах — не выключен, но мощности выше 50 Гц нет: дБ нет, порог не превышен
    const low = pidtune_d_noise(d_axis(() => 0.01), 0, [12, 28])
    assert.equal(low.off, false)
    assert.equal(low.over, false)
    assert.ok((low.dB == null) || (low.dB < -120), 'постоянная D (выше 50 Гц — только погрешность округления): ' + low.dB)
    // Интервал целиком вне данных — одно окно, ближайшее (как спектр PIDReview)
    const outside = pidtune_d_noise(d_axis((k) => 0.01 * Math.sin(2 * Math.PI * 80 * k * DT)), 0, [100, 120])
    assert.equal(outside.windows, 1)
})

test('pidtune_d_noise: нет FFT, набора или D (ось RATE) — null', () => {
    assert.equal(pidtune_d_noise(d_axis(() => 0), 3, [12, 28]), null)
    assert.equal(pidtune_d_noise(null, 0, [12, 28]), null)
    const rate = rate_axis()
    assert.equal(rate.have_data, true)
    assert.equal(pidtune_d_noise(rate, 0, [12, 28]), null, 'без pid_run_batch_fft')
    pid_run_batch_fft(rate.sets, 512)
    assert.equal(pidtune_d_noise(rate, 0, [12, 28]), null, 'у RATE нет D')
})

// ---------------------------------------------------------------- режим лога

// Лог с режимами modes = [[время с, номер], ...], параметрами params и (необязательно) VER [Maj, Min, Pat]
function mode_log(modes, params, ver = null) {
    const messages = { MODE: { TimeUS: modes.map((m) => Math.round(m[0] * 1e6)), Mode: modes.map((m) => m[1]) } }
    if (ver != null) {
        messages.VER = { Maj: [ver[0]], Min: [ver[1]], Pat: [ver[2]] }
    }
    return fake_log({ messages, params })
}
const ANG = [['ATC_ANG_RLL_P', 4.5, 1], ['ATC_ANG_PIT_P', 5.5, 1], ['ATC_ANG_YAW_P', 3, 1]]
const V47 = { fw_string: 'ArduCopter V4.7.0 (abcdef12)' }
const V46 = { fw_string: 'ArduCopter V4.6.3 (92b0cd78)' }

test('pidtune_log_mode: ACRO_OPTIONS 2 и весь интервал в ACRO — Rate Loop Only; 3 (вместе с Air-mode) — тоже; 1 и 0 — нет', () => {
    for (const [options, expected] of [[2, true], [3, true], [1, false], [0, false]]) {
        const log = mode_log([[5, 0], [10, 1]], [['ACRO_OPTIONS', options, 1], ...ANG])
        const mode = pidtune_log_mode(log, log_params(log), V46, [20, 80], 'roll', RATE_HZ)
        assert.equal(mode.rate_only, expected, 'ACRO_OPTIONS ' + options)
        assert.deepEqual(mode.modes, ['ACRO'])
        assert.deepEqual(mode.mixed_modes, [])
        assert.equal(mode.low_rate, false)
    }
    // Без ACRO_OPTIONS в логе или без MODE — не Rate Loop Only
    const no_option = mode_log([[10, 1]], ANG)
    assert.equal(pidtune_log_mode(no_option, log_params(no_option), V46, [20, 80], 'roll', RATE_HZ).rate_only, false)
    const no_mode = fake_log({ params: [['ACRO_OPTIONS', 2, 1]] })
    const mode = pidtune_log_mode(no_mode, log_params(no_mode), V46, [20, 80], 'roll', RATE_HZ)
    assert.equal(mode.rate_only, false)
    assert.deepEqual(mode.modes, [])
    // ACRO_OPTIONS выключили посреди интервала — Rate Loop Only только до смены
    const changed = mode_log([[10, 1]], [['ACRO_OPTIONS', 2, 1], ['ACRO_OPTIONS', 0, 50], ...ANG])
    assert.equal(pidtune_log_mode(changed, log_params(changed), V46, [20, 80], 'roll', RATE_HZ).rate_only, false)
    assert.equal(pidtune_log_mode(changed, log_params(changed), V46, [20, 45], 'roll', RATE_HZ).rate_only, true)
})

test('pidtune_log_mode: масштаб I в Rate Loop Only — ATC_ANG_*_P оси с Copter 4.7, в 4.6 — 1', () => {
    const log = mode_log([[10, 1]], [['ACRO_OPTIONS', 2, 1], ...ANG])
    const params = log_params(log)
    assert.equal(pidtune_log_mode(log, params, V47, [20, 80], 'roll', RATE_HZ).i_scale, 4.5)
    assert.equal(pidtune_log_mode(log, params, V47, [20, 80], 'pitch', RATE_HZ).i_scale, 5.5)
    assert.equal(pidtune_log_mode(log, params, V47, [20, 80], 'yaw', RATE_HZ).i_scale, 3)
    assert.equal(pidtune_log_mode(log, params, { fw_string: 'ArduCopter V4.8.0-dev (1)' }, [20, 80], 'roll', RATE_HZ).i_scale, 4.5)
    assert.equal(pidtune_log_mode(log, params, { fw_string: 'ArduCopter V5.0.0 (1)' }, [20, 80], 'roll', RATE_HZ).i_scale, 4.5)
    const m46 = pidtune_log_mode(log, params, V46, [20, 80], 'roll', RATE_HZ)
    assert.equal(m46.rate_only, true)
    assert.equal(m46.i_scale, 1)
    assert.deepEqual(m46.firmware, { major: 4, minor: 6, patch: 3 })
    assert.deepEqual(m46.warnings, [])
    // VER.Maj/Min из лога важнее строки версии
    const ver_log = mode_log([[10, 1]], [['ACRO_OPTIONS', 2, 1], ...ANG], [4, 7, 1])
    assert.equal(pidtune_log_mode(ver_log, log_params(ver_log), V46, [20, 80], 'roll', RATE_HZ).i_scale, 4.5)
    // Не Rate Loop Only — масштаба нет и в 4.7
    const plain = mode_log([[10, 1]], [['ACRO_OPTIONS', 1, 1], ...ANG])
    assert.equal(pidtune_log_mode(plain, log_params(plain), V47, [20, 80], 'roll', RATE_HZ).i_scale, 1)
    // Версия неизвестна — масштаб 1 и предупреждение
    const unknown = pidtune_log_mode(log, params, {}, [20, 80], 'roll', RATE_HZ)
    assert.equal(unknown.i_scale, 1)
    assert.equal(unknown.firmware, null)
    assert.equal(unknown.warnings.length, 1)
    // 4.7, Rate Loop Only, но ATC_ANG_*_P нет в логе — масштаб 1 и предупреждение с именем параметра
    const no_ang = mode_log([[10, 1]], [['ACRO_OPTIONS', 2, 1], ['ATC_ANG_RLL_P', 4.5, 1]])
    const pitch = pidtune_log_mode(no_ang, log_params(no_ang), V47, [20, 80], 'pitch', RATE_HZ)
    assert.equal(pitch.i_scale, 1)
    assert.equal(pitch.warnings.length, 1)
    assert.ok(pitch.warnings[0].includes('ATC_ANG_PIT_P'), pitch.warnings[0])
    assert.deepEqual(pidtune_log_mode(no_ang, log_params(no_ang), V47, [20, 80], 'roll', RATE_HZ).warnings, [])
})

test('pidtune_log_mode: смешение режимов в интервале; режим на начало интервала — последний до него', () => {
    const log = mode_log([[5, 16], [10, 1], [40, 1], [60, 16], [70, 0]], [['ACRO_OPTIONS', 2, 1], ...ANG])
    const params = log_params(log)
    const mixed = pidtune_log_mode(log, params, V47, [20, 80], 'roll', RATE_HZ)
    assert.deepEqual(mixed.modes, ['ACRO', 'POSHOLD', 'STABILIZE'])
    assert.deepEqual(mixed.mixed_modes, ['ACRO', 'POSHOLD', 'STABILIZE'])
    assert.equal(mixed.rate_only, false, 'PosHold в интервале — угловой контур включён')
    assert.equal(mixed.i_scale, 1)
    // Только Acro-часть того же лога (повторная запись ACRO — не смешение)
    const acro = pidtune_log_mode(log, params, V47, [12, 58], 'roll', RATE_HZ)
    assert.deepEqual(acro.mixed_modes, [])
    assert.equal(acro.rate_only, true)
    // Начало интервала в PosHold, затем Acro
    assert.deepEqual(pidtune_log_mode(log, params, V47, [6, 30], 'roll', RATE_HZ).modes, ['POSHOLD', 'ACRO'])
    // Неизвестный номер режима
    const odd = mode_log([[10, 99]], ANG)
    assert.deepEqual(pidtune_log_mode(odd, log_params(odd), V47, [20, 80], 'roll', RATE_HZ).modes, ['режим 99'])
})

test('pidtune_log_mode: частота лога PID ниже 99 Гц (без ATTITUDE_FAST — 10 Гц) — low_rate', () => {
    const log = mode_log([[10, 1]], ANG)
    const params = log_params(log)
    assert.equal(pidtune_log_mode(log, params, V46, [20, 80], 'roll', 10).low_rate, true)
    assert.equal(pidtune_log_mode(log, params, V46, [20, 80], 'roll', 98.9).low_rate, true)
    assert.equal(pidtune_log_mode(log, params, V46, [20, 80], 'roll', 99).low_rate, false)
    assert.equal(pidtune_log_mode(log, params, V46, [20, 80], 'roll', RATE_HZ).low_rate, false)
    assert.equal(pidtune_log_mode(log, params, V46, [20, 80], 'roll', null).low_rate, false, 'частота неизвестна — нет данных, а не редкий лог')
})

// ---------------------------------------------------------------- правила

const QUALITY_OK = { ok: true, checks: {}, reasons: [] }
const ROLL = { P: 0.1, I: 0.1, D: 0.003 }
const YAW = { P: 0.2, I: 0.02, D: 0 }
// Метрики для правил: перерегулирование os, колебания osc, нарастание rise_s (50 мс — полоса 7 Гц, 3 полосы — 21 Гц)
function metrics_of(os, osc = null, rise_s = 0.05) {
    return { rise_s, overshoot_pct: os, peak: 1 + os / 100, plateau: 1, settle_s: 0.1, osc, bandwidth_hz: (rise_s != null) ? 0.35 / rise_s : null }
}

test('pidtune_rule: перерегулирование ровно 20 % — менять нечего, больше — P −10 % и I = P (крен, тангаж)', () => {
    const at = pidtune_rule(ROLL, 'roll', metrics_of(20), 10, QUALITY_OK)
    assert.equal(at.change, null)
    assert.deepEqual(at.values, ROLL)
    assert.ok(at.reason.includes('менять нечего'), at.reason)
    for (const axis of ['roll', 'pitch']) {
        const over = pidtune_rule(ROLL, axis, metrics_of(20.01), 10, QUALITY_OK)
        assert.equal(over.change, 'P-')
        close_to(over.values.P, 0.09, 1e-12, 'P')
        assert.equal(over.values.I, over.values.P, 'I = P [wiki]')
        assert.equal(over.values.D, ROLL.D)
        assert.equal(over.limited, false)
    }
})

test('pidtune_rule: перерегулирование ровно 5 % — менять нечего, меньше и без колебаний — P +10 %', () => {
    assert.equal(pidtune_rule(ROLL, 'roll', metrics_of(5), 10, QUALITY_OK).change, null)
    const under = pidtune_rule(ROLL, 'roll', metrics_of(4.99), 10, QUALITY_OK)
    assert.equal(under.change, 'P+')
    close_to(under.values.P, 0.11, 1e-12, 'P')
    assert.equal(under.values.I, under.values.P)
    // Перерегулирование меньше 5 %, но колебания «низкие» — правило колебаний первое
    assert.equal(pidtune_rule(ROLL, 'roll', metrics_of(2, { freq_hz: 10, amplitude_pp: 0.1 }), 10, QUALITY_OK).change, 'P-')
})

test('pidtune_rule: колебания ровно на 3 полосах отклика — «низкие» → P −10 %, выше — «высокие» → D −10 %', () => {
    // Ровно на пороге — то же выражение, что в правиле: osc_band_ratio · полоса
    const limit = pidtune_rules.osc_band_ratio * metrics_of(10).bandwidth_hz
    close_to(limit, 21, 1e-9, '3 полосы при нарастании 50 мс')
    const low = pidtune_rule(ROLL, 'roll', metrics_of(10, { freq_hz: limit, amplitude_pp: 0.1 }), 10, QUALITY_OK)
    assert.equal(low.change, 'P-')
    assert.ok(low.reason.includes('низкие'), low.reason)
    const high = pidtune_rule(ROLL, 'roll', metrics_of(10, { freq_hz: limit * 1.0001, amplitude_pp: 0.1 }), 10, QUALITY_OK)
    assert.equal(high.change, 'D-')
    close_to(high.values.D, 0.0027, 1e-12, 'D')
    assert.equal(high.values.P, ROLL.P)
    assert.equal(high.values.I, ROLL.I)
    // Колебания при неизвестном нарастании — частоту не с чем сравнить
    assert.equal(pidtune_rule(ROLL, 'roll', metrics_of(10, { freq_hz: 30, amplitude_pp: 0.1 }, null), 10, QUALITY_OK).change, null)
})

test('pidtune_rule: рыскание — I = 0.1·P при изменении P', () => {
    for (const [os, sign] of [[25, -1], [2, 1]]) {
        const r = pidtune_rule(YAW, 'yaw', metrics_of(os), 10, QUALITY_OK)
        close_to(r.values.P, 0.2 * (1 + 0.1 * sign), 1e-12, 'P')
        close_to(r.values.I, 0.1 * r.values.P, 1e-15, 'I = 0.1·P [код]')
    }
})

test('pidtune_rule: пределы AutoTune — P 0.01…2.0, D ≤ 0.2', () => {
    const up = pidtune_rule({ P: 1.9, I: 1.9, D: 0.01 }, 'roll', metrics_of(2), 10, QUALITY_OK)
    assert.equal(up.change, 'P+')
    assert.equal(up.values.P, 2.0)
    assert.equal(up.values.I, 2.0)
    assert.equal(up.limited, true)
    const at_max = pidtune_rule({ P: 2.0, I: 2.0, D: 0.01 }, 'roll', metrics_of(2), 10, QUALITY_OK)
    assert.equal(at_max.change, null, 'P уже на пределе')
    assert.equal(at_max.limited, true)
    assert.deepEqual(at_max.values, { P: 2.0, I: 2.0, D: 0.01 })
    const down = pidtune_rule({ P: 0.0105, I: 0.0105, D: 0.001 }, 'roll', metrics_of(30), 10, QUALITY_OK)
    assert.equal(down.values.P, 0.01)
    assert.equal(down.limited, true)
    const d = pidtune_rule({ P: 0.1, I: 0.1, D: 0.3 }, 'roll', metrics_of(10, { freq_hz: 40, amplitude_pp: 0.1 }), 10, QUALITY_OK)
    assert.equal(d.change, 'D-')
    assert.equal(d.values.D, 0.2)
    assert.equal(d.limited, true)
    // P вне пределов, и предел развернул бы изменение: P 2.5 и «P +10 %» → 2.0, P 0.005 и «P −10 %» → 0.01 — без изменений
    for (const [P, os, word] of [[2.5, 2, 'уменьшило'], [0.005, 30, 'увеличило']]) {
        const r = pidtune_rule({ P, I: P, D: 0.001 }, 'roll', metrics_of(os), 10, QUALITY_OK)
        assert.equal(r.change, null, 'P ' + P)
        assert.equal(r.limited, true)
        assert.deepEqual(r.values, { P, I: P, D: 0.001 })
        assert.ok(r.reason.includes('вне пределов') && r.reason.includes(word), r.reason)
    }
    // P вне пределов, но в ту же сторону — изменение с пределом: P 2.5 и «P −10 %» → 2.0
    const back = pidtune_rule({ P: 2.5, I: 2.5, D: 0.001 }, 'roll', metrics_of(30), 10, QUALITY_OK)
    assert.equal(back.change, 'P-')
    assert.equal(back.values.P, 2.0)
    assert.equal(back.limited, true)
})

test('pidtune_rule: коэффициента нет в логе (не число) — без изменений', () => {
    for (const [gains, axis, name] of [[{ P: null, I: 0.1, D: 0.003 }, 'roll', 'ATC_RAT_RLL_P'], [{ P: 0.2, I: NaN, D: 0 }, 'yaw', 'ATC_RAT_YAW_I'],
                                       [{ P: undefined, I: 0.1, D: 0 }, 'pitch', 'ATC_RAT_PIT_P']]) {
        const r = pidtune_rule(gains, axis, metrics_of(30), 100, QUALITY_OK)
        assert.equal(r.change, null)
        assert.ok(r.reason.startsWith('нет коэффициента в логе') && r.reason.includes(name), r.reason)
    }
})

test('pidtune_rule: D = 0 — правило для D не применяется: дальше по правилам или без изменений', () => {
    const high = { freq_hz: 40, amplitude_pp: 0.1 }
    const none = pidtune_rule(YAW, 'yaw', metrics_of(10, high), 10, QUALITY_OK)
    assert.equal(none.change, null)
    assert.ok(none.reason.includes('D = 0'), none.reason)
    assert.deepEqual(none.values, YAW)
    // Перерегулирование больше 20 % — P −10 %
    assert.equal(pidtune_rule(YAW, 'yaw', metrics_of(25, high), 10, QUALITY_OK).change, 'P-')
    // D нет в логе — так же
    assert.equal(pidtune_rule({ P: 0.1, I: 0.1, D: null }, 'roll', metrics_of(10, high), 10, QUALITY_OK).change, null)
})

test('pidtune_rule: ненадёжное измерение и мало данных — change null с причиной; сначала данные, потом качество', () => {
    const bad = { ok: false, checks: {}, reasons: ['подпись углового контура: …'] }
    const r = pidtune_rule(ROLL, 'roll', metrics_of(30), 100, bad)
    assert.equal(r.change, null)
    assert.ok(r.reason.startsWith('измерение ненадёжно'), r.reason)
    assert.ok(r.reason.includes('подпись углового контура'), r.reason)
    assert.deepEqual(r.values, ROLL)
    assert.equal(pidtune_rule(ROLL, 'roll', metrics_of(30), 100, null).change, null)
    const few = pidtune_rule(ROLL, 'roll', metrics_of(30), 9.99, QUALITY_OK)
    assert.equal(few.change, null)
    assert.ok(few.reason.startsWith('мало манёвров'), few.reason)
    assert.equal(pidtune_rule(ROLL, 'roll', metrics_of(30), 10, QUALITY_OK).change, 'P-', 'ровно 10 с данных — достаточно')
    assert.ok(pidtune_rule(ROLL, 'roll', metrics_of(30), 5, bad).reason.startsWith('мало манёвров'), 'мало данных важнее качества')
    assert.ok(pidtune_rule(ROLL, 'roll', metrics_of(30), null, bad).reason.startsWith('мало манёвров'))
    assert.equal(pidtune_rule(ROLL, 'roll', null, 100, QUALITY_OK).change, null)
})
