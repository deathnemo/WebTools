// Тесты шага 4 мастера настройки (TuneWizard/core/pidtune.js): метрики отклика на известных системах, КИХ МНК
// на синтетическом замкнутом контуре против правды, проверки качества измерения (и их отказ с угловым контуром и при
// смене объекта), шум D, режим лога и правила PID; модель регулятора AC_PID против разностных уравнений, прогноз
// вариантов против прямой симуляции, сверка регулятора, поправка фильтров, достоверность, варианты и отметки.
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

// Notch ArduPilot (NotchFilter в core/filters.js: полоса → Q, ослабление → A) на частоте sample_hz — фильтр гироскопа
function make_notch(sample_hz, center_hz, bandwidth_hz, attenuation_dB) {
    const A = 10 ** (-attenuation_dB / 40)
    const octaves = Math.log2(center_hz / (center_hz - bandwidth_hz / 2)) * 2
    const Q = Math.sqrt(2 ** octaves) / (2 ** octaves - 1)
    const omega = 2 * Math.PI * center_hz / sample_hz
    const alpha = Math.sin(omega) / (2 * Q)
    const b0 = 1 + alpha * A * A
    const b1 = -2 * Math.cos(omega)
    const b2 = 1 - alpha * A * A
    const a0 = 1 + alpha
    const a2 = 1 - alpha
    let x1 = 0
    let x2 = 0
    let y1 = 0
    let y2 = 0
    return (x) => {
        const y = (b0 * x + b1 * x1 + b2 * x2 - b1 * y1 - a2 * y2) / a0
        x2 = x1
        x1 = x
        y2 = y1
        y1 = y
        return y
    }
}

// Объект «выход регулятора → факт» на SUB подшагах периода контура: транспортная задержка, мотор первого порядка,
// момент K·m (рад/с² на единицу выхода) с возмущением, интегратор со слабым демпфированием (скорость), шум датчика,
// фильтры гироскопа на частоте подшагов: p.gyro_chain — [{ lpf: Гц } | { notch: Гц, bw, att }], по умолчанию ФНЧ 40 Гц
const SUB = 4
function make_plant(p) {
    const h = DT / SUB
    const am = 1 - Math.exp(-h / p.tau)
    const delay = new Float64Array(Math.round(p.delay_s / h) + 1)
    let di = 0
    let m = 0
    let w = 0
    let meas = 0
    const chain = (p.gyro_chain ?? [{ lpf: 40 }]).map((f) => (f.lpf != null) ? make_biquad(RATE_HZ * SUB, f.lpf)
        : make_notch(RATE_HZ * SUB, f.notch, f.bw, f.att))
    const gyro = (x) => chain.reduce((y, filter) => filter(y), x)
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

// Участки режимов с временем, округлённым до микросекунды (TimeUS·US2S)
function segments_of(log, range) {
    return pidtune_mode_segments(log, range).map((s) => ({ mode: s.mode, start: Math.round(s.start * 1e6) / 1e6, end: Math.round(s.end * 1e6) / 1e6 }))
}

test('pidtune_mode_segments и rate_only_segment: лог тестового полёта с взлётом и посадкой — участок ACRO для сужения интервала (аудит области D)', () => {
    // STAB@0 → ACRO@20 → LAND@300, ACRO_OPTIONS 2: интервал по умолчанию 10–310 — режимы смешаны, участок ACRO 20–300
    const log = mode_log([[0, 0], [20, 1], [300, 9]], [['ACRO_OPTIONS', 2, 0.3], ...ANG])
    const params = log_params(log)
    assert.deepEqual(segments_of(log, [10, 310]), [{ mode: 0, start: 10, end: 20 }, { mode: 1, start: 20, end: 300 }, { mode: 9, start: 300, end: 310 }])
    const wide = pidtune_log_mode(log, params, V46, [10, 310], 'roll', RATE_HZ)
    assert.equal(wide.rate_only, false)
    assert.deepEqual(wide.mixed_modes, ['STABILIZE', 'ACRO', 'LAND'])
    assert.deepEqual(wide.rate_only_segment, { start: 20, end: 300 })
    // Участок — в границах интервала: 10–100 → 20–100
    assert.deepEqual(pidtune_log_mode(log, params, V46, [10, 100], 'roll', RATE_HZ).rate_only_segment, { start: 20, end: 100 })
    // Суженный до участка интервал — Rate Loop Only; MODE ровно на конце интервала (LAND@300 при 20–300) в него не входит
    const narrow = pidtune_log_mode(log, params, V46, [20, 300], 'roll', RATE_HZ)
    assert.equal(narrow.rate_only, true)
    assert.deepEqual(narrow.modes, ['ACRO'])
    assert.equal(narrow.rate_only_segment, null, 'в Rate Loop Only подсказки нет')
    // Самый длинный участок ACRO из нескольких; повторная запись ACRO (40 и 45 с) — один участок
    const two = mode_log([[0, 0], [20, 1], [30, 0], [40, 1], [45, 1], [100, 9]], [['ACRO_OPTIONS', 2, 0.3], ...ANG])
    assert.deepEqual(segments_of(two, [0, 120]).map((s) => [s.mode, s.start, s.end]), [[0, 0, 20], [1, 20, 30], [0, 30, 40], [1, 40, 100], [9, 100, 120]])
    assert.deepEqual(pidtune_log_mode(two, log_params(two), V46, [0, 120], 'roll', RATE_HZ).rate_only_segment, { start: 40, end: 100 })
    // Бит выставлен, а ACRO не было вовсе (весь полёт STABILIZE, как второй лог пользователя) — подсказки нет
    const stab = mode_log([[0, 0], [0.2, 0]], [['ACRO_OPTIONS', 3, 0.3], ...ANG])
    const s = pidtune_log_mode(stab, log_params(stab), V46, [10, 310], 'roll', RATE_HZ)
    assert.deepEqual([s.rate_only, s.rate_only_segment, s.mixed_modes, s.modes], [false, null, [], ['STABILIZE']])
    // Бит включили во время участка ACRO (ACRO_OPTIONS 0 → 2 на 50 с) — сужение не даст Rate Loop Only, подсказки нет;
    // включили до участка (на 15 с, в STABILIZE) — есть
    const late = mode_log([[0, 0], [20, 1], [300, 9]], [['ACRO_OPTIONS', 0, 0.3], ['ACRO_OPTIONS', 2, 50], ...ANG])
    assert.equal(pidtune_log_mode(late, log_params(late), V46, [10, 310], 'roll', RATE_HZ).rate_only_segment, null)
    const early = mode_log([[0, 0], [20, 1], [300, 9]], [['ACRO_OPTIONS', 0, 0.3], ['ACRO_OPTIONS', 2, 15], ...ANG])
    assert.deepEqual(pidtune_log_mode(early, log_params(early), V46, [10, 310], 'roll', RATE_HZ).rate_only_segment, { start: 20, end: 300 })
    // Без бита — ни Rate Loop Only, ни участка
    const plain = mode_log([[0, 0], [20, 1], [300, 9]], [['ACRO_OPTIONS', 1, 0.3], ...ANG])
    assert.equal(pidtune_log_mode(plain, log_params(plain), V46, [10, 310], 'roll', RATE_HZ).rate_only_segment, null)
    // Режим до первого MODE неизвестен: MODE@20, интервал 5–15 — участков и режимов нет; без MODE — тоже
    assert.deepEqual(segments_of(mode_log([[20, 1]], ANG), [5, 15]), [])
    assert.deepEqual(pidtune_modes_in(mode_log([[20, 1]], ANG), [5, 15]), [])
    assert.deepEqual(pidtune_mode_segments(fake_log({ params: ANG }), [5, 15]), [])
})

test('pidtune_log_mode: ACRO_TRAINER ≠ 0 в Rate Loop Only — предупреждение (тренер подмешивает выравнивание по углу в цель)', () => {
    const trained = mode_log([[10, 1]], [['ACRO_OPTIONS', 2, 1], ['ACRO_TRAINER', 2, 1], ...ANG])
    const mode = pidtune_log_mode(trained, log_params(trained), V46, [20, 80], 'roll', RATE_HZ)
    assert.equal(mode.rate_only, true, 'режим лога остаётся Rate Loop Only')
    assert.equal(mode.warnings.length, 1)
    assert.match(mode.warnings[0], /^ACRO_TRAINER = 2 \(не 0\): .*ставьте ACRO_TRAINER = 0$/)
    // Тренер выключен — без предупреждения; не Rate Loop Only — тоже (там цель и так не команда пилота)
    const off = mode_log([[10, 1]], [['ACRO_OPTIONS', 2, 1], ['ACRO_TRAINER', 0, 1], ...ANG])
    assert.deepEqual(pidtune_log_mode(off, log_params(off), V46, [20, 80], 'roll', RATE_HZ).warnings, [])
    const plain = mode_log([[10, 1]], [['ACRO_OPTIONS', 0, 1], ['ACRO_TRAINER', 2, 1], ...ANG])
    assert.deepEqual(pidtune_log_mode(plain, log_params(plain), V46, [20, 80], 'roll', RATE_HZ).warnings, [])
    // Тренер выключили посреди интервала (2 → 0 на 50 с) — предупреждение: часть интервала с тренером
    const switched = mode_log([[10, 1]], [['ACRO_OPTIONS', 2, 1], ['ACRO_TRAINER', 2, 1], ['ACRO_TRAINER', 0, 50], ...ANG])
    assert.equal(pidtune_log_mode(switched, log_params(switched), V46, [20, 80], 'roll', RATE_HZ).warnings.length, 1)
    // ACRO_TRAINER в логе нет — предупреждения нет (значение неизвестно)
    const none = mode_log([[10, 1]], [['ACRO_OPTIONS', 2, 1], ...ANG])
    assert.deepEqual(pidtune_log_mode(none, log_params(none), V46, [20, 80], 'roll', RATE_HZ).warnings, [])
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
    // Ограниченное правило называет фактический процент (аудит области D, M-9); без ограничения — нет
    assert.ok(up.reason.endsWith('(ограничено: предел AutoTune P 0.01…2 — фактически P +5.3 %)'), up.reason)
    assert.ok(!pidtune_rule({ P: 0.1, I: 0.1, D: 0.01 }, 'roll', metrics_of(2), 10, QUALITY_OK).reason.includes('фактически'))
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
    assert.ok(d.reason.endsWith('(ограничено: предел AutoTune D ≤ 0.2 — фактически D −33.3 %)'), d.reason)
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
    assert.ok(back.reason.endsWith('(ограничено: предел AutoTune P 0.01…2 — фактически P −20.0 %)'), back.reason)
})

test('pidtune_rule: предлагаемые значения — 4 значащие цифры, I — от округлённого P (0.1163·1.1 → 0.1279, а не 0.12793000000000002)', () => {
    assert.equal(pidtune_round(0.12793000000000002), 0.1279)
    assert.equal(pidtune_round(0.002637), 0.002637)
    assert.equal(pidtune_round(0.0026374), 0.002637)
    assert.equal(pidtune_round(2.00004), 2)
    assert.equal(pidtune_round(0), 0)
    assert.ok(Number.isNaN(pidtune_round(NaN)))
    // Крен и тангаж: I = P — то же округлённое число
    const roll = pidtune_rule({ P: 0.1163, I: 0.1163, D: 0.00293 }, 'roll', metrics_of(2), 10, QUALITY_OK)
    assert.equal(roll.change, 'P+')
    assert.equal(roll.values.P, 0.1279)
    assert.equal(roll.values.I, 0.1279)
    assert.equal(pidtune_rule({ P: 0.1163, I: 0.1163, D: 0.00293 }, 'roll', metrics_of(30), 10, QUALITY_OK).values.P, 0.1047, '0.10467')
    // Рыскание: I = 0.1·P от округлённого P и тоже округлено (0.1·0.2528 = 0.025280000000000004)
    const yaw = pidtune_rule({ P: 0.2298, I: 0.02298, D: 0 }, 'yaw', metrics_of(2), 10, QUALITY_OK)
    assert.equal(yaw.values.P, 0.2528)
    assert.equal(yaw.values.I, 0.02528)
    // D −10 %: 0.00293·0.9 = 0.002637 (без хвоста двоичного округления)
    const d = pidtune_rule({ P: 0.1163, I: 0.1163, D: 0.00293 }, 'roll', metrics_of(10, { freq_hz: 40, amplitude_pp: 0.1 }), 10, QUALITY_OK)
    assert.equal(d.change, 'D-')
    assert.equal(d.values.D, 0.002637)
    // Без изменений — значения лога как есть, не округляются
    assert.deepEqual(pidtune_rule({ P: 0.116286, I: 0.116286, D: 0.0029292 }, 'roll', metrics_of(10), 10, QUALITY_OK).values,
                     { P: 0.116286, I: 0.116286, D: 0.0029292 })
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

// ---------------------------------------------------------------- модель регулятора и прогноз (задача 6)

// Фильтры регулятора синтетики (как у крена лога пользователя): FLTE 0, FLTD 30 Гц
const FILTERS0 = { flte: 0, fltd: 30 }
const LOG_GAINS = { P: G0.kp, I: G0.ki, D: G0.kd }

// Комплексные помощники для массивов [re[], im[]]
function cmul(a, b) {
    return [a[0].map((v, k) => v * b[0][k] - a[1][k] * b[1][k]), a[0].map((v, k) => v * b[1][k] + a[1][k] * b[0][k])]
}

// Импульсная характеристика объекта «выход → факт» синтетики: выход 1 на один такт, факт после каждого такта (как
// в simulate: факт такта k + 1 — после выхода такта k) → g[1…n]
function plant_pulse(p, n = 16 * RATE_HZ) {
    const plant = make_plant(p)
    const g = new Float64Array(n + 1)
    for (let k = 1; k <= n; k++) {
        g[k] = plant((k == 1) ? 1 : 0, () => 0, () => 0).meas
    }
    return g
}

// G(f) = Σ g[n]·e^(−j·2π·f·n / RATE_HZ) на частотах freq → [re[], im[]]
function plant_response(g, freq) {
    const re = []
    const im = []
    for (const f of freq) {
        const w = 2 * Math.PI * f / RATE_HZ
        let a = 0
        let b = 0
        for (let n = 1; n < g.length; n++) {
            a += g[n] * Math.cos(w * n)
            b -= g[n] * Math.sin(w * n)
        }
        re.push(a)
        im.push(b)
    }
    return [re, im]
}

// Полёт rate-only с регулятором G0 и его измерение (качество — с { rate_only: true }) — один раз на объект
const flights = new Map()
function rate_only_flight(plant) {
    if (!flights.has(plant)) {
        const m = measure(simulate(G0, { dur_s: 150, seed: 3, plant }), G0)
        m.quality = pidtune_quality(m.seg.segments, m.seg.rate_hz, m.fir, { rate_only: true })
        flights.set(plant, m)
    }
    return flights.get(plant)
}

test('pidtune_controller: только P — C = Kp, с FLTE — Kp·H_FLTE; фаза I на низкой частоте −90° + 180°·f / loop_rate', () => {
    const freq = [0.5, 3, 20, 150]
    const p = pidtune_controller({ P: 0.2, I: 0, D: 0 }, { flte: 0, fltd: 30 }, RATE_HZ, freq)
    for (let k = 0; k < freq.length; k++) {
        close_to(p.C[0][k], 0.2, 1e-15, 'Re C на ' + freq[k] + ' Гц')
        close_to(p.C[1][k], 0, 1e-15, 'Im C на ' + freq[k] + ' Гц')
    }
    const e = pidtune_controller({ P: 0.2, I: 0, D: 0 }, { flte: 10, fltd: 0 }, RATE_HZ, freq)
    for (let k = 0; k < freq.length; k++) {
        const h = pid_lowpass_response(10, RATE_HZ, freq[k])
        close_to(e.C[0][k], 0.2 * h[0], 1e-15, 'P·H_FLTE, Re')
        close_to(e.C[1][k], 0.2 * h[1], 1e-15, 'P·H_FLTE, Im')
    }
    // Интегратор ki·dt / (1 − z⁻¹) = ki·dt·e^(jω/2) / (2j·sin(ω/2)): фаза −90° + ω/2, модуль ki·dt / (2·sin(ω/2))
    const i = pidtune_controller({ P: 0, I: 0.3, D: 0 }, { flte: 0, fltd: 0 }, RATE_HZ, [0.1, 1])
    for (const [k, f] of [[0, 0.1], [1, 1]]) {
        close_to(Math.atan2(i.C[1][k], i.C[0][k]) * R2D, -90 + 180 * f / RATE_HZ, 1e-9, 'фаза I на ' + f + ' Гц')
        close_to(Math.hypot(i.C[0][k], i.C[1][k]), 0.3 * DT / (2 * Math.sin(Math.PI * f / RATE_HZ)), 1e-9, 'модуль I на ' + f + ' Гц')
    }
    // На 0 Гц: с интегратором — бесконечность (предел берёт pidtune_predict), без него — Kp; ki = Ki·i_scale
    const dc = pidtune_controller({ P: 0.2, I: 0.3, D: 0.004 }, FILTERS0, RATE_HZ, [0], 2.5)
    assert.deepEqual([dc.C[0][0], dc.C[1][0], dc.ki], [Infinity, 0, 0.75])
    assert.deepEqual([pidtune_controller({ P: 0.2, I: 0, D: 0.004 }, FILTERS0, RATE_HZ, [0]).C[0][0]], [0.2])
    // Нечисловые коэффициенты и фильтры — NaN (отказ при сомнении дальше по цепочке)
    assert.ok(Number.isNaN(pidtune_controller({ P: null, I: 0.1, D: 0 }, FILTERS0, RATE_HZ, [5]).C[0][0]), 'P null')
    assert.ok(Number.isNaN(pidtune_controller({ P: 0.1, I: 0.1, D: 0.003 }, { flte: 0, fltd: NaN }, RATE_HZ, [5]).C[0][0]), 'FLTD NaN')
    // Нечисловой i_scale (в том числе null) — NaN (отказ при сомнении), а не регулятор без I; на 0 Гц — тоже NaN
    for (const bad of [null, NaN, '4.5']) {
        const c = pidtune_controller({ P: 0.1, I: 0.1, D: 0.003 }, FILTERS0, RATE_HZ, [0, 5], bad)
        assert.ok(Number.isNaN(c.C[0][0]) && Number.isNaN(c.C[0][1]) && Number.isNaN(c.ki), 'i_scale ' + bad)
    }
    assert.ok(Number.isNaN(pidtune_controller({ P: NaN, I: 0.1, D: 0.003 }, FILTERS0, RATE_HZ, [0]).C[0][0]), 'P NaN на 0 Гц')
})

test('pidtune_controller: совпадает с разностными уравнениями update_all (первая разность импульсной характеристики), i_scale множит Ki, FF и DFF — отдельно', () => {
    // Регулятор во времени (make_pid — AC_PID::update_all) на импульс цели при факте 0: c[n]. Интегратор не затухает,
    // поэтому сравнивается первая разность: Σ (c[n] − c[n − 1])·z⁻ⁿ = (1 − z⁻¹)·C(z)
    for (const g of [{ kp: 0.12, ki: 0.3, kd: 0.004, fltd: 25, flte: 12, i_scale: 2.5 }, { kp: 0.2298, ki: 0.02298, kd: 0.0017, fltd: 0, flte: 1, i_scale: 1 }]) {
        const pid = make_pid({ ...g, imax: 1e9 })
        pid(0, 0)
        const n = 4000
        const d = new Float64Array(n)
        let last = 0
        for (let k = 0; k < n; k++) {
            const c = pid((k == 0) ? 1 : 0, 0).out
            d[k] = c - last
            last = c
        }
        const freq = [0.3, 2, 7.5, 31, 120, 199]
        const model = pidtune_controller({ P: g.kp, I: g.ki, D: g.kd }, { flte: g.flte, fltd: g.fltd }, RATE_HZ, freq, g.i_scale)
        for (let j = 0; j < freq.length; j++) {
            const w = 2 * Math.PI * freq[j] / RATE_HZ
            let re = 0
            let im = 0
            for (let k = 0; k < n; k++) {
                re += d[k] * Math.cos(w * k)
                im -= d[k] * Math.sin(w * k)
            }
            // (1 − e^(−jω))·C
            const ar = 1 - Math.cos(w)
            const ai = Math.sin(w)
            const er = ar * model.C[0][j] - ai * model.C[1][j]
            const ei = ar * model.C[1][j] + ai * model.C[0][j]
            const scale = Math.hypot(er, ei)
            assert.ok(Math.hypot(re - er, im - ei) <= 1e-9 * scale, 'FLTE ' + g.flte + ', ' + freq[j] + ' Гц: ' + [re, im] + ' против ' + [er, ei])
        }
        // i_scale — то же, что Ki·i_scale
        const scaled = pidtune_controller({ P: g.kp, I: g.ki * g.i_scale, D: g.kd }, { flte: g.flte, fltd: g.fltd }, RATE_HZ, freq)
        for (let j = 0; j < freq.length; j++) {
            close_to(scaled.C[0][j], model.C[0][j], 1e-12 * Math.abs(model.C[0][j]) + 1e-15, 'i_scale, Re')
            close_to(scaled.C[1][j], model.C[1][j], 1e-12 * Math.abs(model.C[1][j]) + 1e-15, 'i_scale, Im')
        }
    }
    // FF = Kff + Kdff·(1 − z⁻¹)/dt — не входит в C
    const f = 10
    const w = 2 * Math.PI * f / RATE_HZ
    const with_ff = pidtune_controller({ P: 0.1, I: 0.1, D: 0.002, FF: 0.05, DFF: 0.001 }, FILTERS0, RATE_HZ, [f])
    const without = pidtune_controller({ P: 0.1, I: 0.1, D: 0.002 }, FILTERS0, RATE_HZ, [f])
    assert.deepEqual(with_ff.C, without.C)
    close_to(with_ff.FF[0][0], 0.05 + 0.001 * RATE_HZ * (1 - Math.cos(w)), 1e-12, 'Re FF')
    close_to(with_ff.FF[1][0], 0.001 * RATE_HZ * Math.sin(w), 1e-12, 'Im FF')
    assert.deepEqual([without.FF[0][0], without.FF[1][0]], [0, 0], 'FF и DFF нет — 0')
})

test('pidtune_margins: L = (fc/f)·e^(−j(90° + 360°·f·τ)) — срез fc, запас 90° − 360°·fc·τ, по амплитуде 20·log10(f₁₈₀/fc); нет среза — null', () => {
    const freq = Array.from({ length: 2001 }, (_, k) => k * 0.1)
    const loop = (fc, tau) => [freq.map((f) => (f > 0) ? fc / f * Math.cos(-Math.PI / 2 - 2 * Math.PI * f * tau) : Infinity),
                               freq.map((f) => (f > 0) ? fc / f * Math.sin(-Math.PI / 2 - 2 * Math.PI * f * tau) : 0)]
    const m = pidtune_margins(freq, loop(5.03, 0.021))
    close_to(m.crossover_hz, 5.03, 1e-3, 'частота среза')
    close_to(m.pm_deg, 90 - 360 * 5.03 * 0.021, 0.05, 'запас фазы')
    // −180° при 90° + 360°·f·τ = 180°: f₁₈₀ = 0.25/τ
    close_to(m.gm_db, 20 * Math.log10(0.25 / 0.021 / 5.03), 0.01, 'запас по амплитуде')
    // Фаза среза ниже −180° — запас отрицательный (неустойчив), запаса по амплитуде нет
    const unstable = pidtune_margins(freq, loop(5.03, 0.06))
    close_to(unstable.pm_deg, 90 - 360 * 5.03 * 0.06, 0.1, 'отрицательный запас')
    assert.equal(unstable.gm_db, null)
    assert.equal(m.multiple_crossings, false)
    assert.equal(m.crossings.length, 1)
    // Фаза первого пересечения развёрнута от низких частот: при τ 0.3 с она ниже −360° — запас 90° − 360°·fc·τ ≈ −453°
    // (главное значение дало бы −93°); по модулю больше 180° — развёртка признаётся недостоверной (аудит области D):
    // pm_deg null с причиной, посчитанный запас остаётся в crossings[0], частота среза — есть, запаса по амплитуде нет
    const far = pidtune_margins(freq, loop(5.03, 0.3))
    assert.equal(far.pm_deg, null)
    close_to(far.crossings[0].pm_deg, 90 - 360 * 5.03 * 0.3, 0.1, 'запас первого пересечения при фазе ниже −360°')
    assert.match(far.pm_note, /^развёртка фазы недостоверна: запас первого пересечения -453° по модулю больше 180°$/)
    assert.equal(far.gm_db, null)
    close_to(far.crossover_hz, 5.03, 1e-3, 'частота среза остаётся')
    assert.equal(m.pm_note, null, 'достоверный запас — без причины')
    // Срез ниже crossover_min_hz (0.5 Гц) и |L| меньше 1 везде — частоты среза нет
    const none = { crossover_hz: null, pm_deg: null, gm_db: null, multiple_crossings: false, crossings: [], pm_note: null }
    assert.deepEqual(pidtune_margins(freq, loop(0.3, 0.02)), none)
    // Нечисловое L — нет
    const bad = loop(5.03, 0.021)
    bad[0] = bad[0].map(() => NaN)
    assert.deepEqual(pidtune_margins(freq, bad), none)
})

test('pidtune_margins: резонанс даёт второе пересечение — запас и частота среза первого, второе — справка (главное значение фазы); наименьший — опцией', () => {
    // L = (fc/f)·e^(−j(90° + 360°·f·τ))·P(f), P — резонанс 30 Гц, ζ 0.03 (пик |P| ≈ 16.7): |L| поднимается выше 1 у 30 Гц.
    // τ 5 мс — у второго пересечения запас отрицательный (наименьший); τ 12 мс — фаза второго ниже −360°, берётся
    // главное значение (развёрнутая дала бы запас около −206° вместо 154°)
    const fc = 5.03
    const resonance = (f) => {
        const r = f / 30
        return { mag: 1 / Math.hypot(1 - r * r, 2 * 0.03 * r), deg: Math.atan2(-2 * 0.03 * r, 1 - r * r) * R2D }
    }
    const mag = (f) => fc / f * resonance(f).mag
    const freq = Array.from({ length: 2001 }, (_, k) => k * 0.1)
    // Пересечения сверху вниз — бисекцией по аналитическому |L|
    const down = (a, b) => {
        for (let i = 0; i < 60; i++) {
            const c = (a + b) / 2
            if (mag(c) >= 1) a = c
            else b = c
        }
        return (a + b) / 2
    }
    const f1 = down(4, 7)
    const f2 = down(31, 40)
    for (const tau of [0.005, 0.012]) {
        // Фаза непрерывная: аргумент резонанса — от 0° до −180°
        const deg = (f) => -90 - 360 * f * tau + resonance(f).deg
        const L = [freq.map((f) => (f > 0) ? mag(f) * Math.cos(deg(f) / R2D) : Infinity), freq.map((f) => (f > 0) ? mag(f) * Math.sin(deg(f) / R2D) : 0)]
        const m = pidtune_margins(freq, L)
        const what = 'τ ' + tau
        assert.equal(m.multiple_crossings, true, what)
        assert.equal(m.crossings.length, 2, what)
        close_to(m.crossings[0].freq_hz, f1, 2e-3, what + ': первое пересечение')
        close_to(m.crossings[1].freq_hz, f2, 2e-3, what + ': второе пересечение')
        close_to(m.crossover_hz, f1, 2e-3, what + ': частота среза — первого пересечения')
        close_to(m.crossings[0].pm_deg, 180 + deg(f1), 0.1, what + ': запас первого — развёрнутая фаза')
        const principal = deg(f2) - 360 * Math.ceil(deg(f2) / 360)
        close_to(m.crossings[1].pm_deg, 180 + principal, 0.5, what + ': запас второго — главное значение')
        // Запас — первого пересечения (поздние по измеренной T недостоверны); наименьший по всем — опцией (точная L)
        assert.equal(m.pm_deg, m.crossings[0].pm_deg, what)
        assert.ok(Number.isFinite(m.gm_db), what + ': запас по амплитуде ' + m.gm_db)
        const all = pidtune_margins(freq, L, pidtune_rules, { min_over_crossings: true })
        assert.equal(all.pm_deg, Math.min(m.crossings[0].pm_deg, m.crossings[1].pm_deg), what)
        assert.equal(all.crossover_hz, m.crossover_hz)
        if (tau == 0.005) {
            assert.ok(m.crossings[1].pm_deg < 0, 'второе пересечение неустойчиво: ' + m.crossings[1].pm_deg)
            assert.equal(all.pm_deg, m.crossings[1].pm_deg)
            assert.equal(all.gm_db, null, 'наименьший запас не больше 0 — запаса по амплитуде нет')
            assert.ok(m.gm_db < 0, 'фаза переходит −180° в резонансе, где |L| > 1: ' + m.gm_db)
        } else {
            assert.ok(deg(f2) < -360, 'фаза второго ниже −360°: ' + deg(f2))
            assert.ok(m.crossings[1].pm_deg > 90, 'запас второго ' + m.crossings[1].pm_deg)
            assert.equal(all.pm_deg, m.crossings[0].pm_deg)
            assert.ok(m.gm_db > 0, 'запас по амплитуде ' + m.gm_db)
        }
    }
})

test('pidtune_margins: слегка положительная фаза L на 0.5 Гц — точка отсчёта в (−270°, 90°], запас верный; шум около 0° ветвь не переворачивает (аудит области D)', () => {
    // |L| = 5/f (срез 5 Гц), фаза p0 − 25°·(f − 0.5): правда — запас 180° + p0 − 112.5° = 67.5° + p0. Сетка — как у
    // прогноза при 400 Гц (4096 точек): первый бин не ниже 0.5 Гц — 0.586 Гц, там фаза p0 − 2.1°
    const freq = Array.from({ length: 2049 }, (_, k) => k * 400 / 4096)
    const loop = (p0) => [freq.map((f) => (f > 0) ? 5 / f * Math.cos((p0 - 25 * (f - 0.5)) / R2D) : Infinity),
                          freq.map((f) => (f > 0) ? 5 / f * Math.sin((p0 - 25 * (f - 0.5)) / R2D) : 0)]
    for (const p0 of [-100, -10, -1, -0.1, 0, 0.1, 1, 10, 30, 89]) {
        const m = pidtune_margins(freq, loop(p0))
        close_to(m.crossover_hz, 5, 0.02, 'срез при фазе ' + p0 + '° на 0.5 Гц')
        close_to(m.pm_deg, 67.5 + p0, 0.5, 'запас при фазе ' + p0 + '° на 0.5 Гц (раньше +10° давало −282.5°)')
        assert.equal(m.pm_note, null, 'фаза ' + p0 + '°: запас достоверен')
        assert.ok((67.5 + p0 <= 0) || (m.gm_db != null), 'фаза ' + p0 + '°: запас по амплитуде ' + m.gm_db)
    }
    // Шумная фаза на первом бине: +2° вместо −2° только на нём — запас тот же (шаг между бинами в (−180°, 180°]), без 360°
    const base = pidtune_margins(freq, loop(-2))
    const noisy = loop(-2)
    const k0 = freq.findIndex((f) => f >= pidtune_rules.crossover_min_hz)
    const mag0 = Math.hypot(noisy[0][k0], noisy[1][k0])
    noisy[0][k0] = mag0 * Math.cos(2 / R2D)
    noisy[1][k0] = mag0 * Math.sin(2 / R2D)
    close_to(pidtune_margins(freq, noisy).pm_deg, base.pm_deg, 1e-6, 'шум ±2° на первом бине')
    // Фаза +100° на 0.5 Гц — вне окна (−270°, 90°]: точка отсчёта −260°, запас 180° − 260° − 112.5° = −192.5° — по
    // модулю больше 180°, запас не определён
    const far = pidtune_margins(freq, loop(100))
    assert.equal(far.pm_deg, null)
    assert.match(far.pm_note, /по модулю больше 180°/)
    // Отметки такого прогноза: не «неустойчив», а «неполный: запас фазы не определён (…)»
    const log = { pm_deg: 50, metrics: { overshoot_pct: 10 } }
    const flags = pidtune_flags({ pm_deg: null, pm_note: far.pm_note, crossover_hz: far.crossover_hz, metrics: { overshoot_pct: 12 }, unstable: false }, log)
    assert.equal(flags.unstable, false)
    assert.equal(flags.incomplete, true)
    assert.equal(flags.reasons[0], 'прогноз неполный: запас фазы не определён (' + far.pm_note + ')')
    assert.ok(!flags.reasons.some((r) => r.includes('неустойчив')), flags.reasons.join('; '))
})

test('pidtune_predict: на известном контуре — T_new = G·g·(C_new + FF) / (1 + G·g·C_new) точно, с FF ≠ 0 и поправкой фильтров', () => {
    const grid = pidtune_predict_grid(RATE_HZ)
    assert.equal(grid.n, 4096)
    assert.equal(grid.freq.length, 2049)
    close_to(grid.freq[1], 400 / 4096, 1e-15, 'шаг сетки')
    const Gp = plant_response(plant_pulse(PLANT_NORMAL), grid.freq)
    // T замкнутого контура: G·g·(C + FF) / (1 + G·g·C); на 0 Гц с интегратором — 1
    const closed = (c, g) => {
        const Gg = (g != null) ? cmul(Gp, g) : Gp
        const T = [[], []]
        for (let k = 0; k < grid.freq.length; k++) {
            if (c.C[0][k] === Infinity) {
                T[0].push(1)
                T[1].push(0)
                continue
            }
            const lr = Gg[0][k] * c.C[0][k] - Gg[1][k] * c.C[1][k]
            const li = Gg[0][k] * c.C[1][k] + Gg[1][k] * c.C[0][k]
            const sr = c.C[0][k] + c.FF[0][k]
            const si = c.C[1][k] + c.FF[1][k]
            const nr = Gg[0][k] * sr - Gg[1][k] * si
            const ni = Gg[0][k] * si + Gg[1][k] * sr
            const dr = 1 + lr
            const di = li
            const d = dr * dr + di * di
            T[0].push((nr * dr + ni * di) / d)
            T[1].push((ni * dr - nr * di) / d)
        }
        return T
    }
    // КИХ — обратное FFT T на сетке (импульсная характеристика, свёрнутая по периоду, FFT которой — ровно T на сетке)
    const as_fir = (T) => {
        const n = grid.n
        const fft = new FFTJS(n)
        const full = fft.createComplexArray()
        for (let k = 0; k <= n / 2; k++) {
            full[2 * k] = T[0][k]
            full[2 * k + 1] = ((k == 0) || (k == n / 2)) ? 0 : T[1][k]
            if ((k > 0) && (k < n / 2)) {
                full[2 * (n - k)] = T[0][k]
                full[2 * (n - k) + 1] = -T[1][k]
            }
        }
        const out = fft.createComplexArray()
        fft.inverseTransform(out, full)
        return { h: Float64Array.from({ length: n }, (_, i) => out[2 * i]) }
    }
    // Поправка фильтров — отношение двух фильтров первого порядка (60 Гц вместо 90 Гц)
    const ratio = [[], []]
    for (const f of grid.freq) {
        const a = pid_lowpass_response(60, RATE_HZ, f)
        const b = pid_lowpass_response(90, RATE_HZ, f)
        const d = b[0] * b[0] + b[1] * b[1]
        ratio[0].push((a[0] * b[0] + a[1] * b[1]) / d)
        ratio[1].push((a[1] * b[0] - a[0] * b[1]) / d)
    }
    // Точная формула — без сглаживания поправки фильтров (gyro_ratio_full_x: Infinity); со сглаживанием — ниже
    const exact = { ...pidtune_rules, gyro_ratio_full_x: Infinity }
    const check = (log_gains, new_gains, g, skip_dc) => {
        const c_log = pidtune_controller(log_gains, FILTERS0, RATE_HZ, grid.freq)
        const c_new = pidtune_controller(new_gains, FILTERS0, RATE_HZ, grid.freq)
        const pred = pidtune_predict(as_fir(closed(c_log, null)), c_log, c_new, g, RATE_HZ, exact)
        const expected = closed(c_new, g)
        const L_expected = cmul((g != null) ? cmul(Gp, g) : Gp, c_new.C)
        const what = JSON.stringify(new_gains) + ((g != null) ? ' с поправкой' : '')
        for (let k = skip_dc ? 1 : 0; k < grid.freq.length; k++) {
            const err = Math.hypot(pred.T[0][k] - expected[0][k], pred.T[1][k] - expected[1][k])
            assert.ok(err <= 1e-9, what + ': T_new на ' + grid.freq[k] + ' Гц, ошибка ' + err)
            if (k > 0) {
                const l_err = Math.hypot(pred.L[0][k] - L_expected[0][k], pred.L[1][k] - L_expected[1][k])
                assert.ok(l_err <= 1e-9 * Math.hypot(L_expected[0][k], L_expected[1][k]), what + ': L_new на ' + grid.freq[k] + ' Гц, ошибка ' + l_err)
            }
        }
        return pred
    }
    const base = { P: 0.1163, I: 0.1163, D: 0.00293, FF: 0.05, DFF: 0.0005 }
    check(base, { ...base, P: 0.15, I: 0.15 }, null)
    check(base, { ...base, D: 0.0035 }, ratio)
    check(base, { ...base, FF: 0.1 }, null)
    // I только у варианта — на 0 Гц T_new = 1, как у контура с интегратором
    const p = check({ ...base, I: 0 }, base, ratio)
    assert.equal(p.T[0][0], 1)
    // I только у лога — предел на 0 Гц по данным не определить: T_new(0) по непрерывности (Re на 0.1 Гц), остальное точно
    const q = check(base, { ...base, I: 0 }, null, true)
    assert.equal(q.T[0][0], q.T[0][1], 'T_new(0) = Re T_new(0.1 Гц)')
    // Со сглаживанием (по умолчанию): до 5× частоты среза лога — та же точная T_new, на частоте Найквиста поправки нет
    const c_log = pidtune_controller(base, FILTERS0, RATE_HZ, grid.freq)
    const c_new = pidtune_controller({ ...base, D: 0.0035 }, FILTERS0, RATE_HZ, grid.freq)
    const fir = as_fir(closed(c_log, null))
    const smooth = pidtune_predict(fir, c_log, c_new, ratio, RATE_HZ)
    const full = pidtune_predict(fir, c_log, c_new, ratio, RATE_HZ, exact)
    const fc_log = pidtune_predict(fir, c_log, c_log, null, RATE_HZ).crossover_hz
    close_to(smooth.ratio_full_hz, 5 * fc_log, 1e-9, 'полная поправка до 5× частоты среза лога')
    assert.equal(full.ratio_full_hz, Infinity)
    for (let k = 0; grid.freq[k] <= smooth.ratio_full_hz; k++) {
        assert.equal(smooth.T[0][k], full.T[0][k], 'Re на ' + grid.freq[k] + ' Гц')
        assert.equal(smooth.T[1][k], full.T[1][k], 'Im на ' + grid.freq[k] + ' Гц')
    }
    const top = grid.freq.length - 1
    const no_ratio = pidtune_predict(fir, c_log, c_new, null, RATE_HZ)
    close_to(smooth.T[0][top], no_ratio.T[0][top], 1e-12, 'на частоте Найквиста — как без поправки')
    assert.equal(no_ratio.ratio_full_hz, null)
})

test('pidtune_predict: rate-only синтетика — прогноз P ±10 %, D ±10 %, P +30 % против прямой симуляции: перерегулирование ±3 пункта, запас фазы ±5°', () => {
    const grid = pidtune_predict_grid(RATE_HZ)
    const c_log = pidtune_controller(LOG_GAINS, FILTERS0, RATE_HZ, grid.freq)
    const p30 = pidtune_round(G0.kp * 1.3)
    for (const plant of [PLANT_NORMAL, PLANT_FAST, PLANT_SLOW]) {
        const { seg, fir, quality } = rate_only_flight(plant)
        assert.equal(quality.ok, true, 'K ' + plant.K + ': ' + quality.reasons.join('; '))
        const Gp = plant_response(plant_pulse(plant), grid.freq)
        const variants = pidtune_candidates(LOG_GAINS, null, 'roll').map((c) => [c.title, c.values])
        assert.deepEqual(variants.map((v) => v[0]), ['Как в логе', 'P −10 %', 'P +10 %', 'D −10 %', 'D +10 %'])
        variants.push(['P +30 %', { P: p30, I: p30, D: G0.kd }])
        for (const [title, v] of variants) {
            const c_new = pidtune_controller(v, FILTERS0, RATE_HZ, grid.freq)
            const pred = pidtune_predict(fir, c_log, c_new, null, seg.rate_hz)
            // Правда: прямая симуляция новых коэффициентов (ступенька без шума) и запас фазы по L = C·G объекта
            const truth = pidtune_step_metrics(...Object.values(truth_step({ kp: v.P, ki: v.I, kd: v.D, fltd: FILTERS0.fltd }, plant)))
            const truth_pm = pidtune_margins(grid.freq, cmul(c_new.C, Gp), pidtune_rules, { min_over_crossings: true }).pm_deg
            const what = 'K ' + plant.K + ', ' + title
            assert.equal(pred.unstable, false, what)
            assert.ok(pred.noncausal < 1e-6, what + ': доля энергии до нуля времени ' + pred.noncausal)
            close_to(pred.metrics.overshoot_pct, truth.overshoot_pct, 3, what + ': перерегулирование, %')
            close_to(pred.pm_deg, truth_pm, 5, what + ': запас фазы, °')
        }
    }
})

test('pidtune_predict: для коэффициентов лога прогноз равен измеренному; другая сетка — исключение; нечисловые коэффициенты — метрик и запасов нет', () => {
    const { seg, fir, metrics } = rate_only_flight(PLANT_NORMAL)
    const grid = pidtune_predict_grid(seg.rate_hz)
    const c_log = pidtune_controller(LOG_GAINS, FILTERS0, RATE_HZ, grid.freq)
    const pred = pidtune_predict(fir, c_log, c_log, null, seg.rate_hz)
    assert.equal(pred.step.y.length, fir.step.length)
    for (let i = 0; i < fir.step.length; i++) {
        close_to(pred.step.time[i], fir.time[i], 1e-12, 'время ' + i)
        close_to(pred.step.y[i], fir.step[i], 1e-9, 'отклик ' + i)
    }
    close_to(pred.metrics.overshoot_pct, metrics.overshoot_pct, 1e-6, 'перерегулирование')
    close_to(pred.metrics.rise_s, metrics.rise_s, 1e-9, 'нарастание')
    // То же с поправкой фильтров «одинаковые фильтры» (ровно 1) и FF лога
    const ones = pidtune_gyro_ratio({ INS_GYRO_FILTER: 40 }, { INS_GYRO_FILTER: 40 }, null, grid.freq)
    const c_ff = pidtune_controller({ ...LOG_GAINS, FF: 0.05 }, FILTERS0, RATE_HZ, grid.freq)
    const with_ff = pidtune_predict(fir, c_ff, c_ff, ones, seg.rate_hz)
    for (let i = 0; i < fir.step.length; i++) {
        close_to(with_ff.step.y[i], fir.step[i], 1e-9, 'отклик с FF и поправкой 1, ' + i)
    }
    assert.equal(pidtune_predict(null, c_log, c_log, null, seg.rate_hz), null)
    const short = pidtune_controller(LOG_GAINS, FILTERS0, RATE_HZ, grid.freq.slice(0, 100))
    assert.throws(() => pidtune_predict(fir, c_log, short, null, seg.rate_hz), /сетке/)
    // Та же длина, другой шаг (сетка частоты 300 Гц: тоже 2049 частот) — тоже исключение
    const other = pidtune_controller(LOG_GAINS, FILTERS0, RATE_HZ, pidtune_predict_grid(300).freq)
    assert.equal(other.C[0].length, grid.freq.length)
    assert.throws(() => pidtune_predict(fir, c_log, other, null, seg.rate_hz), /шаг/)
    assert.throws(() => pidtune_predict(fir, c_log, c_log, [new Array(5).fill(1), new Array(5).fill(0)], seg.rate_hz), /сетке/)
    // Пустое поле формы (NaN) — прогноз есть, но без метрик и запасов: отметки — «неполный»
    const broken = pidtune_predict(fir, c_log, pidtune_controller({ ...LOG_GAINS, D: NaN }, FILTERS0, RATE_HZ, grid.freq), null, seg.rate_hz)
    assert.equal(broken.metrics, null)
    assert.equal(broken.pm_deg, null)
    const flags = pidtune_flags(broken, pred)
    assert.equal(flags.incomplete, true)
    assert.equal(flags.flagged, true)
})

test('pidtune_controller_check: верная модель на синтетике проходит, Kd ×2 — нет; i_scale учитывается; без окон — ok false', () => {
    const { axis } = rate_only_flight(PLANT_NORMAL)
    const right = pidtune_controller_check(axis, 0, [0, 1e9], LOG_GAINS, FILTERS0, RATE_HZ, 1)
    assert.equal(right.ok, true, JSON.stringify(right))
    assert.ok(right.max_mag_err < 0.03, 'модуль ' + right.max_mag_err)
    assert.ok(right.max_phase_err_deg < 2, 'фаза ' + right.max_phase_err_deg)
    assert.ok(right.min_coherence > 0.95, 'γ² ' + right.min_coherence)
    assert.ok(right.windows > 0)
    const wrong_d = pidtune_controller_check(axis, 0, [0, 1e9], { ...LOG_GAINS, D: 2 * LOG_GAINS.D }, FILTERS0, RATE_HZ, 1)
    assert.equal(wrong_d.ok, false)
    assert.ok(wrong_d.max_mag_err > pidtune_rules.controller_check.mag_err_max, 'Kd ×2: модуль ' + wrong_d.max_mag_err)
    assert.ok((wrong_d.worst_hz >= 2) && (wrong_d.worst_hz <= 20), 'худшая частота ' + wrong_d.worst_hz)
    // Масштаб I (Rate Loop Only в 4.7: × ATC_ANG_*_P, например 4.5): модель с масштабом при данных без него не сходится
    // по фазе на низких частотах; Ki / 4.5 × 4.5 — та же модель
    const scaled = pidtune_controller_check(axis, 0, [0, 1e9], LOG_GAINS, FILTERS0, RATE_HZ, 4.5)
    assert.equal(scaled.ok, false, 'i_scale 4.5 при данных с 1')
    assert.ok(scaled.max_phase_err_deg > pidtune_rules.controller_check.phase_err_max_deg, 'фаза ' + scaled.max_phase_err_deg)
    assert.equal(pidtune_controller_check(axis, 0, [0, 1e9], { ...LOG_GAINS, I: LOG_GAINS.I / 4.5 }, FILTERS0, RATE_HZ, 4.5).ok, true, 'Ki / 4.5 × i_scale 4.5')
    // Интервал вне данных — окон нет; нечисловые коэффициенты — не проходит
    assert.deepEqual(pidtune_controller_check(axis, 0, [500, 600], LOG_GAINS, FILTERS0, RATE_HZ, 1),
                     { ok: false, max_mag_err: null, max_phase_err_deg: null, worst_hz: null, min_coherence: null, windows: 0, skipped: null })
    assert.equal(right.skipped, null)
    assert.equal(pidtune_controller_check(axis, 0, [0, 1e9], { ...LOG_GAINS, P: NaN }, FILTERS0, RATE_HZ, 1).ok, false)
})

test('pidtune_coherence: факт = g·цель — γ² = 1; цель + независимый шум той же мощности — около 0.5; без окон — null', () => {
    const exact = noise_segment(40000, 31, (tar, k) => 1.7 * tar[k])
    exact.starts = Array.from({ length: 155 }, (_, i) => i * 256)
    close_to(pidtune_coherence([exact], RATE_HZ, 4.6), 1, 1e-9, 'γ² без шума')
    const g = gauss(lcg(77))
    const noisy = noise_segment(40000, 32, (tar, k) => tar[k] + 50 * g())
    noisy.starts = exact.starts
    const coh = pidtune_coherence([noisy], RATE_HZ, 4.6)
    assert.ok((coh > 0.35) && (coh < 0.65), 'γ² с шумом ' + coh)
    assert.equal(pidtune_coherence([{ ...exact, starts: [] }], RATE_HZ, 4.6), null, 'нет окон')
    assert.equal(pidtune_coherence([exact], RATE_HZ, null), null, 'частоты среза нет')
    assert.equal(pidtune_coherence([exact], RATE_HZ, 300), null, 'выше Найквиста')
})

test('pidtune_gyro_ratio: одинаковые фильтры — ровно 1; INS_GYRO_FILTER 40 → 80 — H₈₀/H₄₀; статический notch — ослабление на центре; нет гироскопа — null', () => {
    const freq = [0, 2, 5, 37, 100, 199]
    // Одинаковые наборы — ровно 1 и без данных гироскопа
    assert.deepEqual(pidtune_gyro_ratio({ INS_GYRO_FILTER: 40, INS_HNTCH_ENABLE: 0 }, { INS_HNTCH_ENABLE: 0, INS_GYRO_FILTER: 40 }, null, freq),
                     [freq.map(() => 1), freq.map(() => 0)])
    // Поддельный гироскоп 1000 Гц: окна FFT в 1…5 с
    const gyro = [{ FFT: { time: [1, 2, 3, 4, 5], average_sample_rate: 1000, x: [[0], [0], [0], [0], [0]] } }]
    gyro.start_time = 0
    gyro.end_time = 6
    const env = { filter_version: 2 }
    const ctx = { gyro, env, tracking: [new StaticTarget(gyro, env)], range: [2, 4], sensor: 0 }
    // Наборы различаются, но фильтры те же (лишний ключ) — считается, отношение 1 с точностью округления
    const same = pidtune_gyro_ratio({ INS_GYRO_FILTER: 40 }, { INS_GYRO_FILTER: 40, ATC_RAT_RLL_P: 0.1 }, ctx, freq)
    for (let k = 0; k < freq.length; k++) {
        close_to(same[0][k], 1, 1e-12, 'Re на ' + freq[k] + ' Гц')
        close_to(same[1][k], 0, 1e-12, 'Im на ' + freq[k] + ' Гц')
    }
    // LowPassFilter2p (DigitalBiquadFilter::compute_params) на 1000 Гц — своя формула
    const biquad = (fc, f) => {
        const ohm = Math.tan(Math.PI * fc / 1000)
        const c = 1 + 2 * Math.cos(Math.PI / 4) * ohm + ohm * ohm
        const b0 = ohm * ohm / c
        const a1 = 2 * (ohm * ohm - 1) / c
        const a2 = (1 - 2 * Math.cos(Math.PI / 4) * ohm + ohm * ohm) / c
        const w = 2 * Math.PI * f / 1000
        const nr = b0 * (1 + 2 * Math.cos(w) + Math.cos(2 * w))
        const ni = -b0 * (2 * Math.sin(w) + Math.sin(2 * w))
        const dr = 1 + a1 * Math.cos(w) + a2 * Math.cos(2 * w)
        const di = -(a1 * Math.sin(w) + a2 * Math.sin(2 * w))
        const d = dr * dr + di * di
        return [(nr * dr + ni * di) / d, (ni * dr - nr * di) / d]
    }
    const lpf = pidtune_gyro_ratio({ INS_GYRO_FILTER: 40 }, { INS_GYRO_FILTER: 80 }, ctx, freq)
    for (let k = 0; k < freq.length; k++) {
        const a = biquad(80, freq[k])
        const b = biquad(40, freq[k])
        const d = b[0] * b[0] + b[1] * b[1]
        close_to(lpf[0][k], (a[0] * b[0] + a[1] * b[1]) / d, 1e-9, 'Re H80/H40 на ' + freq[k] + ' Гц')
        close_to(lpf[1][k], (a[1] * b[0] - a[0] * b[1]) / d, 1e-9, 'Im H80/H40 на ' + freq[k] + ' Гц')
    }
    // Статический notch 100 Гц, ослабление 30 дБ: на центре |H| = 10^(−30/20), далеко внизу — около 1
    const notch = { INS_HNTCH_ENABLE: 1, INS_HNTCH_MODE: 0, INS_HNTCH_FREQ: 100, INS_HNTCH_BW: 20, INS_HNTCH_ATT: 30, INS_HNTCH_HMNCS: 1 }
    const with_notch = pidtune_gyro_ratio({ INS_GYRO_FILTER: 40 }, { INS_GYRO_FILTER: 40, ...notch }, ctx, freq)
    close_to(Math.hypot(with_notch[0][4], with_notch[1][4]), 10 ** (-30 / 20), 1e-9, '|notch| на 100 Гц')
    close_to(Math.hypot(with_notch[0][1], with_notch[1][1]), 1, 1e-3, '|notch| на 2 Гц')
    // Нет гироскопа, экземпляра или окон — без поправки
    assert.equal(pidtune_gyro_ratio({ INS_GYRO_FILTER: 40 }, { INS_GYRO_FILTER: 80 }, null, freq), null)
    assert.equal(pidtune_gyro_ratio({ INS_GYRO_FILTER: 40 }, { INS_GYRO_FILTER: 80 }, { ...ctx, sensor: 3 }, freq), null)
    assert.equal(pidtune_gyro_ratio({ INS_GYRO_FILTER: 40 }, { INS_GYRO_FILTER: 80 }, { ...ctx, gyro: [{ FFT: { time: [], average_sample_rate: 1000 } }] }, freq), null)
})

test('pidtune_validity: всё пройдено — достоверен; каждая причина отказа по отдельности', () => {
    const q_ok = { ok: true, checks: {}, reasons: [] }
    const q_bad = { ok: false, checks: {}, reasons: ['половины данных дают разный отклик: RMS 0.073'] }
    const cc_ok = { ok: true, max_mag_err: 0.03, max_phase_err_deg: 1.2, worst_hz: 2.3, min_coherence: 0.99, windows: 500 }
    const cc_bad = { ok: false, max_mag_err: 0.43, max_phase_err_deg: 4, worst_hz: 18.4, min_coherence: 0.99, windows: 500 }
    const cc_none = { ok: false, max_mag_err: null, max_phase_err_deg: null, worst_hz: null, min_coherence: null, windows: 0 }
    assert.deepEqual(pidtune_validity(q_ok, cc_ok, 0.9), { valid: true, reasons: [] })
    // Ровно на пороге когерентности — достоверен
    assert.equal(pidtune_validity(q_ok, cc_ok, pidtune_rules.coherence_min).valid, true)
    const cases = [
        [q_bad, cc_ok, 0.9, 'измерение ненадёжно: половины данных'],
        [null, cc_ok, 0.9, 'нет проверки качества'],
        [q_ok, cc_bad, 0.9, 'модель регулятора не сходится с данными: модуль C_изм / C_мод отличается от 1 до 43.0 %'],
        [q_ok, cc_none, 0.9, 'сверка модели регулятора с данными не посчиталась'],
        [q_ok, null, 0.9, 'сверка модели регулятора с данными не посчиталась'],
        [q_ok, { ...cc_none, skipped: 'rate' }, 0.9, 'по RATE прогноз не считается: цель записана до фильтра FLTT, выход — с FF; включите бит PID в LOG_BITMASK'],
        [q_ok, cc_ok, 0.49, 'когерентность «цель → факт» на частоте среза γ² = 0.49 ниже 0.5'],
        [q_ok, cc_ok, 0.4999, 'когерентность «цель → факт» на частоте среза γ² = 0.49 ниже 0.5'],
        [q_ok, cc_ok, null, 'когерентность «цель → факт» на частоте среза не посчиталась'],
        [q_ok, cc_ok, NaN, 'когерентность «цель → факт» на частоте среза не посчиталась'],
    ]
    for (const [q, cc, coh, text] of cases) {
        const v = pidtune_validity(q, cc, coh)
        assert.equal(v.valid, false, text)
        assert.equal(v.reasons.length, 1, text + ': ' + v.reasons.join('; '))
        assert.ok(v.reasons[0].startsWith(text), v.reasons[0])
    }
    assert.equal(pidtune_validity(q_bad, cc_bad, 0.2).reasons.length, 3, 'все три')
    // Синтетика rate-only: прогноз достоверен
    const { axis, seg, fir, quality } = rate_only_flight(PLANT_NORMAL)
    const grid = pidtune_predict_grid(seg.rate_hz)
    const c_log = pidtune_controller(LOG_GAINS, FILTERS0, RATE_HZ, grid.freq)
    const pred_log = pidtune_predict(fir, c_log, c_log, null, seg.rate_hz)
    const coh = pidtune_coherence(seg.segments, seg.rate_hz, pred_log.crossover_hz)
    const cc = pidtune_controller_check(axis, 0, [0, 1e9], LOG_GAINS, FILTERS0, RATE_HZ, 1)
    assert.deepEqual(pidtune_validity(quality, cc, coh), { valid: true, reasons: [] }, 'γ² ' + coh)
})

test('pidtune_candidates: порядок, округление, I по правилу, дедупликация (same_as); D = 0 — без D ±10 %; пределы', () => {
    const log = { P: 0.1163, I: 0.1163, D: 0.00293 }
    // Правило «P +10 %» совпадает с вариантом P +10 % — остаётся «По правилам» с same_as
    const up = pidtune_rule(log, 'roll', metrics_of(2), 10, QUALITY_OK)
    const list = pidtune_candidates(log, up, 'roll')
    assert.deepEqual(list.map((c) => c.id), ['log', 'rule', 'p_minus', 'd_minus', 'd_plus'])
    assert.deepEqual(list.map((c) => c.title), ['Как в логе', 'По правилам', 'P −10 %', 'D −10 %', 'D +10 %'])
    assert.deepEqual(list[1].same_as, ['p_plus'])
    assert.deepEqual(list[0].same_as, [])
    assert.deepEqual(list.map((c) => c.values), [log, { P: 0.1279, I: 0.1279, D: 0.00293 }, { P: 0.1047, I: 0.1047, D: 0.00293 },
                                                 { P: 0.1163, I: 0.1163, D: 0.002637 }, { P: 0.1163, I: 0.1163, D: 0.003223 }])
    // Правило «менять нечего» — это «Как в логе»
    const keep = pidtune_rule(log, 'roll', metrics_of(10), 10, QUALITY_OK)
    const same = pidtune_candidates(log, keep, 'roll')
    assert.deepEqual(same.map((c) => c.id), ['log', 'p_minus', 'p_plus', 'd_minus', 'd_plus'])
    assert.deepEqual(same[0].same_as, ['rule'])
    // Без правила — без «По правилам»
    assert.deepEqual(pidtune_candidates(log, null, 'roll').map((c) => c.id), ['log', 'p_minus', 'p_plus', 'd_minus', 'd_plus'])
    // Рыскание с D = 0: без D ±10 %, I = 0.1·P от округлённого P
    const yaw = pidtune_candidates({ P: 0.2298, I: 0.02298, D: 0 }, null, 'yaw')
    assert.deepEqual(yaw.map((c) => c.id), ['log', 'p_minus', 'p_plus'])
    assert.deepEqual(yaw.map((c) => c.values), [{ P: 0.2298, I: 0.02298, D: 0 }, { P: 0.2068, I: 0.02068, D: 0 }, { P: 0.2528, I: 0.02528, D: 0 }])
    // D нет в логе — тоже без D ±10 %; P или I не числа — только «Как в логе»
    assert.deepEqual(pidtune_candidates({ P: 0.1, I: 0.1, D: null }, null, 'roll').map((c) => c.id), ['log', 'p_minus', 'p_plus'])
    assert.deepEqual(pidtune_candidates({ P: NaN, I: 0.1, D: 0.003 }, null, 'roll').map((c) => c.id), ['log', 'd_minus', 'd_plus'])
    // Пределы AutoTune: P на p_max — без P +10 %; D на d_max — без D +10 %; D 0.19 → D +10 % ограничен 0.2
    assert.deepEqual(pidtune_candidates({ P: 2.0, I: 2.0, D: 0.2 }, null, 'pitch').map((c) => c.id), ['log', 'p_minus', 'd_minus'])
    const near = pidtune_candidates({ P: 1.9, I: 1.9, D: 0.19 }, null, 'pitch')
    assert.deepEqual(near.find((c) => c.id == 'p_plus').values, { P: 2, I: 2, D: 0.19 })
    assert.deepEqual(near.find((c) => c.id == 'd_plus').values, { P: 1.9, I: 1.9, D: 0.2 })
})

test('pidtune_flags: отметки на порогах — запас фазы 30°, ухудшение на 5°, перерегулирование 20 %; неполный прогноз — отметка', () => {
    const pred = (pm, os) => ({ pm_deg: pm, metrics: (os == null) ? null : { overshoot_pct: os } })
    const log = pred(50, 10)
    // Ровно на порогах — без отметок
    const at = pidtune_flags(pred(45, 20), log)
    assert.deepEqual([at.low_pm, at.pm_drop, at.overshoot, at.incomplete, at.flagged], [false, false, false, false, false])
    assert.deepEqual(at.reasons, [])
    assert.equal(pidtune_flags(pred(30, 5), pred(35, 5)).flagged, false, 'запас ровно 30° и ухудшение ровно 5°')
    // Чуть за порогом — по одной отметке
    const low = pidtune_flags(pred(29.99, 5), pred(33, 5))
    assert.deepEqual([low.low_pm, low.pm_drop, low.overshoot, low.flagged], [true, false, false, true])
    assert.equal(low.reasons[0], 'запас фазы 29.9° ниже 30°', 'у порога — с округлением от него, а не «30.0° ниже 30°»')
    const drop = pidtune_flags(pred(44.99, 10), log)
    assert.deepEqual([drop.low_pm, drop.pm_drop, drop.overshoot], [false, true, false])
    assert.equal(drop.reasons[0], 'запас фазы хуже лога на 5.1° (больше 5°)')
    const os = pidtune_flags(pred(50, 20.01), log)
    assert.deepEqual([os.low_pm, os.pm_drop, os.overshoot], [false, false, true])
    assert.equal(os.reasons[0], 'перерегулирование в прогнозе 20.1 % выше 20 %')
    // Лучше лога — без отметки ухудшения
    assert.equal(pidtune_flags(pred(60, 5), log).flagged, false)
    // Неполный прогноз: нет прогноза, частоты среза, метрик или запаса у лога — отметка (отказ при сомнении)
    for (const [p, l, text] of [[null, log, 'нет прогноза'], [pred(null, 10), log, 'частота среза не найдена'],
                                [pred(50, null), log, 'нет метрик отклика'], [pred(50, 10), pred(null, 10), 'у прогноза лога нет запаса фазы'],
                                [pred(NaN, 10), log, 'частота среза не найдена']]) {
        const f = pidtune_flags(p, l)
        assert.equal(f.incomplete, true, text)
        assert.equal(f.flagged, true, text)
        assert.ok(f.reasons[0].startsWith('прогноз неполный') && f.reasons[0].includes(text), f.reasons[0])
    }
    // Каждая отметка по отдельности отказывает при сомнении: нет запаса — low_pm и pm_drop, нет метрик — overshoot
    const no_pm = pidtune_flags(pred(null, 10), log)
    assert.deepEqual([no_pm.low_pm, no_pm.pm_drop, no_pm.overshoot], [true, true, false])
    const no_os = pidtune_flags(pred(50, null), log)
    assert.deepEqual([no_os.low_pm, no_os.pm_drop, no_os.overshoot], [false, false, true])
    const no_log = pidtune_flags(pred(50, 10), null)
    assert.deepEqual([no_log.low_pm, no_log.pm_drop, no_log.overshoot, no_log.incomplete], [false, true, false, true])
    // Неустойчивый прогноз: отметка unstable с запасом фазы, метрик нет, но «неполным» он не считается
    const unstable = pidtune_flags({ pm_deg: -6.74, metrics: null, unstable: true }, log)
    assert.deepEqual([unstable.unstable, unstable.low_pm, unstable.pm_drop, unstable.overshoot, unstable.incomplete, unstable.flagged],
                     [true, true, true, true, false, true])
    assert.deepEqual(unstable.reasons, ['контур неустойчив (запас фазы -6.7°)', 'запас фазы -6.7° ниже 30°', 'запас фазы хуже лога на 56.7° (больше 5°)'])
    // Неустойчив при положительном запасе (непричинный отклик)
    const noncausal = pidtune_flags({ pm_deg: 12, metrics: null, unstable: true }, log)
    assert.equal(noncausal.unstable, true)
    assert.equal(noncausal.reasons[0], 'прогноз неустойчив — вариант на грани устойчивости или прогноз ненадёжен (большое изменение D или ' +
                 'фильтров гироскопа, мало возбуждения на высоких частотах)')
    // Запас такого прогноза недостоверен: без отметок запаса с числом — одна причина
    assert.deepEqual([noncausal.low_pm, noncausal.pm_drop, noncausal.overshoot, noncausal.incomplete, noncausal.flagged], [false, false, true, false, true])
    assert.equal(noncausal.reasons.length, 1, noncausal.reasons.join('; '))
    // Без запаса вовсе (частота среза не найдена) — так же одна причина
    const unstable_no_pm = pidtune_flags({ pm_deg: null, metrics: null, unstable: true }, log)
    assert.deepEqual([unstable_no_pm.low_pm, unstable_no_pm.pm_drop, unstable_no_pm.incomplete, unstable_no_pm.reasons.length], [false, false, false, 1])
    // При запасе не больше 0 — «контур неустойчив» и отметки запаса с числом, как раньше
    const zero = pidtune_flags({ pm_deg: 0, metrics: null, unstable: true }, log)
    assert.equal(zero.reasons[0], 'контур неустойчив (запас фазы 0.0°)')
    assert.deepEqual([zero.low_pm, zero.pm_drop], [true, true])
    assert.equal(pidtune_flags(pred(50, 10), log).unstable, false)
})

test('pidtune_beyond: число у порога — с округлением от порога, вдали от порога — обычное округление', () => {
    assert.equal(pidtune_beyond(29.99, 30, 1), '29.9')
    assert.equal(pidtune_beyond(20.01, 20, 1), '20.1')
    assert.equal(pidtune_beyond(0.4999, 0.5, 2), '0.49')
    assert.equal(pidtune_beyond(5.04, 5, 1), '5.1', '«5.0 больше 5» нельзя')
    // Вдали от порога — как toFixed
    assert.equal(pidtune_beyond(0.0731, 0.035, 3), '0.073')
    assert.equal(pidtune_beyond(-6.74, 0, 1), '-6.7')
    assert.equal(pidtune_beyond(0.43 * 100, 10, 1), '43.0', '43.00000000000001')
    assert.equal(pidtune_beyond(30, 30, 1), '30.0', 'ровно на пороге')
    assert.equal(pidtune_beyond(29.96, 30, 1), '29.9', 'toFixed дал бы 30.0')
})

test('pidtune_predict: 0 Гц — I у обоих: R = ki_new / ki_log; I только у варианта — 1; только у лога — по непрерывности', () => {
    // КИХ «чистая задержка на отсчёт с усилением 0.9»: T = 0.9·e^(−jω), T(0) = 0.9 (у настоящего КИХ сумма h не ровно 1)
    const grid = pidtune_predict_grid(RATE_HZ)
    const fir = { h: Float64Array.from([0, 0.9]) }
    const ctrl = (I) => pidtune_controller({ P: 0.1, I: I, D: 0.002 }, FILTERS0, RATE_HZ, grid.freq)
    // R(0) = 0.2 / 0.1 = 2: T_new(0) = 2·0.9 / (1 − 0.9 + 2·0.9)
    close_to(pidtune_predict(fir, ctrl(0.1), ctrl(0.2), null, RATE_HZ).T[0][0], 1.8 / 1.9, 1e-12, 'I у обоих')
    assert.equal(pidtune_predict(fir, ctrl(0), ctrl(0.2), null, RATE_HZ).T[0][0], 1, 'I только у варианта')
    const only_log = pidtune_predict(fir, ctrl(0.1), ctrl(0), null, RATE_HZ)
    assert.equal(only_log.T[0][0], only_log.T[0][1], 'I только у лога — Re T_new на 0.1 Гц')
    assert.equal(only_log.T[1][0], 0)
    // Без интеграторов — обычная формула: R(0) = Kp_new / Kp_log
    const p = (P) => pidtune_controller({ P: P, I: 0, D: 0.002 }, FILTERS0, RATE_HZ, grid.freq)
    close_to(pidtune_predict(fir, p(0.1), p(0.3), null, RATE_HZ).T[0][0], 3 * 0.9 / (0.1 + 3 * 0.9), 1e-12, 'без I')
})

test('pidtune_predict: неустойчивый вариант (K 290, P ×3) — unstable, отклика и метрик нет, отметка «контур неустойчив»', () => {
    // Обратное FFT T_new неустойчивого контура — периодический непричинный ряд: без проверки прогноз показал бы 0 %
    // при правде 316 % (ревью задачи 6)
    const { seg, fir } = rate_only_flight(PLANT_FAST)
    const grid = pidtune_predict_grid(seg.rate_hz)
    const c_log = pidtune_controller(LOG_GAINS, FILTERS0, RATE_HZ, grid.freq)
    const pred_log = pidtune_predict(fir, c_log, c_log, null, seg.rate_hz)
    const p3 = { P: 3 * G0.kp, I: 3 * G0.ki, D: G0.kd }
    const truth = pidtune_step_metrics(...Object.values(truth_step({ kp: p3.P, ki: p3.I, kd: p3.D, fltd: FILTERS0.fltd }, PLANT_FAST)))
    assert.ok(truth.overshoot_pct > 100, 'правда: ' + truth.overshoot_pct)
    const pred = pidtune_predict(fir, c_log, pidtune_controller(p3, FILTERS0, RATE_HZ, grid.freq), null, seg.rate_hz)
    assert.equal(pred.unstable, true)
    assert.ok(pred.pm_deg < 0, 'запас фазы ' + pred.pm_deg)
    assert.ok(pred.noncausal > pidtune_rules.noncausal_max, 'доля энергии до нуля времени ' + pred.noncausal)
    assert.equal(pred.step, null)
    assert.equal(pred.metrics, null)
    assert.ok(pred.crossover_hz > 0, 'частота среза и L остаются для бодэ')
    const flags = pidtune_flags(pred, pred_log)
    assert.equal(flags.unstable, true)
    assert.equal(flags.incomplete, false)
    assert.ok(flags.reasons[0].startsWith('контур неустойчив (запас фазы -'), flags.reasons[0])
    // Неустойчивость по причинности при положительном запасе: порог доли энергии до нуля — по правилам
    const strict = { ...pidtune_rules, noncausal_max: 1e-40 }
    const stable = pidtune_predict(fir, c_log, c_log, null, seg.rate_hz, strict)
    assert.ok(stable.pm_deg > 0)
    assert.equal(stable.unstable, true, 'доля ' + stable.noncausal + ' больше порога 1e-40')
    assert.equal(stable.metrics, null)
    assert.equal(pred_log.unstable, false)
})

test('pidtune_controller_check и pidtune_validity: ось RATE — сверка не запускается, причина «по RATE прогноз не считается»', () => {
    const rate = rate_axis()
    assert.equal(pidtune_has_components(rate, 0), false)
    assert.equal(pidtune_has_components(rate_only_flight(PLANT_NORMAL).axis, 0), true)
    const cc = pidtune_controller_check(rate, 0, [12, 28], LOG_GAINS, FILTERS0, RATE_HZ, 1)
    assert.deepEqual(cc, { ok: false, max_mag_err: null, max_phase_err_deg: null, worst_hz: null, min_coherence: null, windows: 0, skipped: 'rate' })
    const v = pidtune_validity({ ok: true, checks: {}, reasons: [] }, cc, 0.9)
    assert.equal(v.valid, false)
    assert.equal(v.reasons.length, 1, v.reasons.join('; '))
    assert.ok(v.reasons[0].startsWith('по RATE прогноз не считается'), v.reasons[0])
    assert.ok(!v.reasons[0].includes('не сходится'), 'не ложная причина «модель не сходится»')
})

test('pidtune_gyro_ratio: H меняется по окнам (движущийся notch) — отношение средних, а не среднее отношений', () => {
    // Источник трекинга-заглушка: частота notch по окнам 80…120 Гц
    const centers = [80, 90, 100, 110, 120]
    const moving = { mode_value: 1, warnings: [], have_data: () => true, no_data_error: () => null,
                     get_interpolated_target_freq: (instance, index) => [centers[index]] }
    const gyro = [{ FFT: { time: [1, 2, 3, 4, 5], average_sample_rate: 1000, x: [[0], [0], [0], [0], [0]] } }]
    const env = { filter_version: 2 }
    const ctx = { gyro, env, tracking: [moving], range: [0, 10], sensor: 0 }
    const notch = (att) => ({ INS_GYRO_FILTER: 40, INS_HNTCH_ENABLE: 1, INS_HNTCH_MODE: 1, INS_HNTCH_FREQ: 100, INS_HNTCH_BW: 20,
                              INS_HNTCH_ATT: att, INS_HNTCH_HMNCS: 1 })
    const freq = [5, 30, 85, 100, 115]
    const ratio = pidtune_gyro_ratio(notch(30), notch(15), ctx, freq)
    // Ожидаемое — по тем же filter_transfer, усреднение — своё
    const Z = exp_jw(freq, 1000)
    const H = (values) => filter_transfer(load_filters(values, env, ctx.tracking), 0, gyro[0].FFT.time, 1000, complex_inverse(Z), complex_inverse(complex_square(Z)))
    const H_old = H(notch(30))
    const H_new = H(notch(15))
    const start = find_start_index(gyro[0].FFT.time, ctx.range)
    const end = find_end_index(gyro[0].FFT.time, ctx.range) + 1
    assert.equal(end - start, 5, 'все пять окон')
    const div = (a, b) => [(a[0] * b[0] + a[1] * b[1]) / (b[0] ** 2 + b[1] ** 2), (a[1] * b[0] - a[0] * b[1]) / (b[0] ** 2 + b[1] ** 2)]
    let differs = 0
    for (let k = 0; k < freq.length; k++) {
        const mean = (Hs) => [0, 1].map((c) => Hs.slice(start, end).reduce((sum, h) => sum + h[c][k], 0) / (end - start))
        const expected = div(mean(H_new), mean(H_old))
        close_to(ratio[0][k], expected[0], 1e-12, 'Re на ' + freq[k] + ' Гц')
        close_to(ratio[1][k], expected[1], 1e-12, 'Im на ' + freq[k] + ' Гц')
        const each = [0, 1].map((c) => H_old.slice(start, end).reduce((sum, h, j) => sum + div(H_new[start + j].map((a) => a[k]), h.map((b) => b[k]))[c], 0) / (end - start))
        differs = Math.max(differs, Math.hypot(each[0] - expected[0], each[1] - expected[1]))
    }
    assert.ok(differs > 0.05, 'отношение средних отличается от среднего отношений: ' + differs)
    // Вдали от notch — почти 1
    close_to(Math.hypot(ratio[0][0], ratio[1][0]), 1, 1e-3, '|отношение| на 5 Гц')
})

test('pidtune_predict: поздние пересечения от шума КИХ на достоверной оси не делают вариант неустойчивым (D ×3 — запас первого пересечения)', () => {
    // Редкие манёвры, сильная турбулентность: ось достоверна, но шум КИХ на 20–40 Гц, умноженный большим D через R, даёт
    // поздние пересечения |L| = 1 с бессмысленной фазой (ревью задачи 6: «Свой» D ×3 — «неустойчив, −164°» при правде 59°)
    for (const [plant, low_pm] of [[PLANT_NORMAL, false], [PLANT_FAST, true]]) {
        const m = measure(simulate(G0, { dur_s: 150, seed: 3, plant, pause: 0.9, turb_dps2: 2000 }), G0)
        const quality = pidtune_quality(m.seg.segments, m.seg.rate_hz, m.fir, { rate_only: true })
        const grid = pidtune_predict_grid(m.seg.rate_hz)
        const c_log = pidtune_controller(LOG_GAINS, FILTERS0, RATE_HZ, grid.freq)
        const pred_log = pidtune_predict(m.fir, c_log, c_log, null, m.seg.rate_hz)
        const cc = pidtune_controller_check(m.axis, 0, [0, 1e9], LOG_GAINS, FILTERS0, RATE_HZ, 1)
        const validity = pidtune_validity(quality, cc, pidtune_coherence(m.seg.segments, m.seg.rate_hz, pred_log.crossover_hz))
        const what = 'K ' + plant.K
        assert.equal(validity.valid, true, what + ': ' + validity.reasons.join('; '))
        const d3 = { ...LOG_GAINS, D: pidtune_round(3 * G0.kd) }
        const c_new = pidtune_controller(d3, FILTERS0, RATE_HZ, grid.freq)
        const pred = pidtune_predict(m.fir, c_log, c_new, null, m.seg.rate_hz)
        const truth_pm = pidtune_margins(grid.freq, cmul(c_new.C, plant_response(plant_pulse(plant), grid.freq)), pidtune_rules,
                                         { min_over_crossings: true }).pm_deg
        assert.equal(pred.unstable, false, what + ': ' + JSON.stringify(pred.crossings))
        assert.ok(pred.metrics != null, what + ': метрики есть')
        assert.equal(pred.pm_deg, pred.crossings[0].pm_deg, what + ': запас — первого пересечения')
        close_to(pred.pm_deg, truth_pm, 6, what + ': запас фазы против правды')
        if (plant === PLANT_NORMAL) {
            // Поздние пересечения есть, и по главному значению их «запас» отрицательный — это справка, не неустойчивость
            assert.equal(pred.multiple_crossings, true)
            assert.ok(pred.crossings.slice(1).some((c) => c.pm_deg < 0), JSON.stringify(pred.crossings))
        }
        const flags = pidtune_flags(pred, pred_log)
        assert.equal(flags.unstable, false, what)
        assert.equal(flags.low_pm, low_pm, what + ': запас ' + pred.pm_deg + ', правда ' + truth_pm)
        if (!low_pm) {
            assert.equal(flags.overshoot || flags.low_pm || flags.incomplete, false, what + ': ' + flags.reasons.join('; '))
        }
    }
})

test('pidtune_predict: рыскание с I = 0 (I только у лога) — T_new(0) по непрерывности, не «неустойчив», перерегулирование как у правды', () => {
    // Рыскание: I = 0.1·P, FLTE 1 Гц, D без FLTD; объект медленнее крена. Скачок на бине 0 Гц дал бы постоянную добавку
    // ко всей импульсной характеристике и ложную долю энергии «до нуля»
    const yaw = { kp: 0.2298, ki: 0.02298, kd: 0.0017, fltd: 0, flte: 1, imax: 0.5 }
    const plant = { K: 40, tau: 0.05, delay_s: 0.012 }
    const filters = { flte: 1, fltd: 0 }
    const m = measure(simulate(yaw, { dur_s: 150, seed: 3, plant }), yaw)
    const grid = pidtune_predict_grid(m.seg.rate_hz)
    const log = { P: yaw.kp, I: yaw.ki, D: yaw.kd }
    const c_log = pidtune_controller(log, filters, RATE_HZ, grid.freq)
    const pred = pidtune_predict(m.fir, c_log, pidtune_controller({ ...log, I: 0 }, filters, RATE_HZ, grid.freq), null, m.seg.rate_hz)
    assert.equal(pred.T[0][0], pred.T[0][1], 'T_new(0) = Re T_new(0.1 Гц)')
    assert.equal(pred.unstable, false)
    assert.ok(pred.noncausal < 1e-4, 'доля энергии до нуля времени ' + pred.noncausal)
    const truth = pidtune_step_metrics(...Object.values(truth_step({ ...yaw, ki: 0 }, plant)))
    close_to(pred.metrics.overshoot_pct, truth.overshoot_pct, 3, 'перерегулирование, %')
})

// Гироскоп-заглушка для pidtune_gyro_ratio: окна FFT в 1…5 с на частоте подшагов объекта (фильтры — как в make_plant)
// и источник трекинга «notch на каждом моторе»: статический (режим 0), частота f1 у motors моторов
function motors_gyro_ctx(f1, motors) {
    const gyro = [{ FFT: { time: [1, 2, 3, 4, 5], average_sample_rate: RATE_HZ * SUB, x: [[0], [0], [0], [0], [0]] } }]
    const tracking = [{ mode_value: 0, warnings: [], have_data: () => true, no_data_error: () => null,
                        get_interpolated_target_freq: () => new Array(motors).fill(f1) }]
    return { gyro, env: { filter_version: 2 }, tracking, range: [0, 10], sensor: 0 }
}

test('pidtune_predict: снятие notch третьей гармоники выше частоты Найквиста контура — без ложной непричинности, запас и перерегулирование как у прямой симуляции', () => {
    // Как на логе пользователя (задача 8): notch на каждом из 4 моторов, гармоники 1 и 3 (75 и 225 Гц, полоса 18·n, 15 дБ);
    // шаг 2 снимает третью (HMNCS 5 → 1). Третья гармоника — выше частоты Найквиста контура (200 Гц), отношение фильтров
    // там большое и комплексное (≈ 3.5∠137°), и при редких манёврах с турбулентностью (T у 200 Гц — шум ≈ 0.02) прогноз
    // всех вариантов выходил непричинным. Ещё — INS_GYRO_FILTER 40 → 20 (заметный сдвиг фазы у частоты среза)
    const f1 = 75
    const motors = 4
    const notch1 = new Array(motors).fill({ notch: f1, bw: 18, att: 15 })
    const notch3 = new Array(motors).fill({ notch: 3 * f1, bw: 54, att: 15 })
    const plant_log = { ...PLANT_NORMAL, gyro_chain: [{ lpf: 40 }, ...notch1, ...notch3] }
    const values_log = { INS_GYRO_FILTER: 40, INS_HNTCH_ENABLE: 1, INS_HNTCH_MODE: 0, INS_HNTCH_FREQ: f1, INS_HNTCH_BW: 18, INS_HNTCH_ATT: 15,
                         INS_HNTCH_HMNCS: 5 }
    const m = measure(simulate(G0, { dur_s: 150, seed: 3, plant: plant_log, pause: 0.9, turb_dps2: 2000, noise_dps: 3 }), G0)
    const quality = pidtune_quality(m.seg.segments, m.seg.rate_hz, m.fir, { rate_only: true })
    assert.equal(quality.ok, true, quality.reasons.join('; '))
    const grid = pidtune_predict_grid(m.seg.rate_hz)
    const c_log = pidtune_controller(LOG_GAINS, FILTERS0, RATE_HZ, grid.freq)
    const pred_log = pidtune_predict(m.fir, c_log, c_log, null, m.seg.rate_hz)
    const ctx = motors_gyro_ctx(f1, motors)
    // Отклик объекта — один раз на объект (прямое ДПФ импульсной характеристики)
    const responses = new Map()
    const response = (plant) => {
        if (!responses.has(plant)) {
            responses.set(plant, plant_response(plant_pulse(plant), grid.freq))
        }
        return responses.get(plant)
    }
    const truth_pm = (c, plant) => pidtune_margins(grid.freq, cmul(c.C, response(plant)), pidtune_rules, { min_over_crossings: true }).pm_deg
    const truth_log_pm = truth_pm(c_log, plant_log)
    const changes = [
        ['HMNCS 5 → 1', { ...values_log, INS_HNTCH_HMNCS: 1 }, [{ lpf: 40 }, ...notch1]],
        ['INS_GYRO_FILTER 40 → 20', { ...values_log, INS_GYRO_FILTER: 20 }, [{ lpf: 20 }, ...notch1, ...notch3]],
    ]
    const p10 = pidtune_round(G0.kp * 1.1)
    for (const [title, values_new, chain_new] of changes) {
        const ratio = pidtune_gyro_ratio(values_log, values_new, ctx, grid.freq)
        const plant_new = { ...PLANT_NORMAL, gyro_chain: chain_new }
        if (title.startsWith('HMNCS')) {
            // Без сглаживания — ложная непричинность (так было до исправления)
            const raw = pidtune_predict(m.fir, c_log, c_log, ratio, m.seg.rate_hz, { ...pidtune_rules, gyro_ratio_full_x: Infinity })
            assert.ok(raw.noncausal > pidtune_rules.noncausal_max, title + ': без сглаживания доля ' + raw.noncausal)
        }
        for (const [vn, v] of [['как в логе', LOG_GAINS], ['P +10 %', { P: p10, I: p10, D: G0.kd }]]) {
            const c_new = pidtune_controller(v, FILTERS0, RATE_HZ, grid.freq)
            const pred = pidtune_predict(m.fir, c_log, c_new, ratio, m.seg.rate_hz)
            const what = title + ', ' + vn
            assert.equal(pred.unstable, false, what + ': доля ' + pred.noncausal)
            assert.ok(pred.noncausal < 1e-4, what + ': доля энергии до нуля времени ' + pred.noncausal)
            // Правда — прямая симуляция контура с новыми фильтрами гироскопа и коэффициентами
            const truth = pidtune_step_metrics(...Object.values(truth_step({ kp: v.P, ki: v.I, kd: v.D, fltd: FILTERS0.fltd }, plant_new)))
            close_to(pred.metrics.overshoot_pct, truth.overshoot_pct, 3, what + ': перерегулирование, %')
            close_to(pred.pm_deg, truth_pm(c_new, plant_new), 5, what + ': запас фазы, °')
            if (vn == 'как в логе') {
                // Изменение запаса фазы от фильтров — как у правды
                close_to(pred.pm_deg - pred_log.pm_deg, truth_pm(c_new, plant_new) - truth_log_pm, 1.5, what + ': изменение запаса фазы')
            }
        }
    }
})
