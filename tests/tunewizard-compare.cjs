// Регрессия мастера настройки против FilterReview в настоящем браузере (Playwright + Chrome).
// Запуск: npm run test:tunewizard-compare
// Один лог открывается в FilterReview и в мастере с одинаковыми интервалом анализа, типом лога, числом окон
// на пакет, версией фильтра (как выбрана в FilterReview) и шкалой частоты (Гц, линейная ось); данные графиков
// сравниваются поэлементно: средний спектр гироскопа, который FilterReview показывает по умолчанию (первичный
// или первый с данными; мастер обязан выбрать тот же), — до / после / оценка «после» по X, Y, Z — и спектрограмма
// (оси и первые 5 строк матрицы) в двух конфигурациях: дБ без алиасинга и PSD со свёрнутым алиасингом. Шаг 2
// с параметрами из лога в обоих инструментах: бодэ (частоты, средняя амплитуда в дБ, средняя фаза) для гироскопа,
// выбранного в FilterReview, с его выбором фазы (развёрнутая или ±180°) и с противоположным, и оценка «после»
// по X, Y, Z. Допуск |a − b| ≤ 1e-6·max(1, |a|); при расхождении — первая позиция и значения, код выхода 1.
//
// Эталон точного сравнения — FilterReview с теми же исправлениями дефектов upstream, что внесены в мастер
// (задача 8, docs/plans/2026-10-24-tune-wizard-stage2-design.md, раздел 2): до загрузки лога в исходном тексте
// функций FilterReview заменяются строки дефектов 1 (run_batch_fft), 2 (load_from_raw_log) и 5 (load_from_batch);
// каждая замена обязана сработать заданное число раз, иначе upstream изменился и тест надо пересмотреть.
// Дефекты 3, 4, 6, 7 на логах, которые FilterReview открывает без ошибок, не срабатывают: при них он прерывает
// загрузку, выдаёт alert или падает, и тест останавливается раньше сравнения.
// Кроме того, мастер сравнивается с FilterReview как есть (upstream): печатается, какие массивы совпадают, какие
// отличаются, насколько и почему. Если на логе действует только дефект 1 (частота дискретизации пакетов batch-лога
// непостоянна, и upstream брал частоту первого пакета), расхождения проверяются точно: оси частот — ровно ×ρ,
// где ρ — отношение средних частот, пересчитанное по пакетам самого FilterReview; записанные спектры в дБ и строки
// спектрограммы — без изменений; время спектрограммы сдвинуто на Δ = (окно/2)·(новый период − старый) (при одном
// окне на пакет); сетка бодэ длиннее на k точек с тем же началом. Без действующих дефектов всё должно совпадать
// с upstream; при других сочетаниях — только отчёт (точность обеспечивает сравнение с эталоном).
// Нужны те же лог, браузер и python, что для tests/tunewizard-browser.cjs; без лога тест пропускается.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { chromium } = require('playwright')

const repo = path.resolve(__dirname, '..')
const logs_dir = path.join(repo, 'TuneWizard', 'logs')
const port = 8792
const tolerance = 1e-6

// Типы и оси трасс FilterReview: индекс трассы — get_FFT_data_index(сенсор, type, axis)
const FR_TYPES = ['Pre-filter', 'Post-filter', 'Estimated post']
const WIZARD_TYPES = ['до', 'после', 'оценка']
const AXES = ['X', 'Y', 'Z']

// Шаг сетки бодэ (FR 863, core/gyro.js gyro_fft)
const BODE_FREQ_STEP = 0.05

function find_log() {
    if (process.env.TUNEWIZARD_LOG) {
        return process.env.TUNEWIZARD_LOG
    }
    if (!fs.existsSync(logs_dir)) {
        return null
    }
    const bin = fs.readdirSync(logs_dir).find((name) => name.toLowerCase().endsWith('.bin'))
    return bin ? path.join(logs_dir, bin) : null
}

async function wait_for_server(page, url, server) {
    for (let i = 0; i < 40; i++) {
        if (server.exitCode != null) {
            throw new Error('http.server завершился с кодом ' + server.exitCode + ' (занят порт ' + port + ' или нет python?)')
        }
        try {
            await page.goto(url, { waitUntil: 'networkidle' })
            return
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 250))
        }
    }
    throw new Error('http.server не поднялся на ' + url)
}

function wait_overlay(page) {
    return page.waitForFunction(() => document.getElementById('loading').style.visibility === 'hidden', null, { timeout: 180000 })
}

// Исправления дефектов upstream в FilterReview — до загрузки лога. Возвращает список применённых замен
function patch_filterreview(page) {
    return page.evaluate(() => {
        const applied = []
        // Заменить в исходном тексте глобальной функции name; edits = [[шаблон, замена, сколько раз должен найтись]]
        const patch = (name, defect, edits) => {
            let src = window[name].toString()
            for (const [pattern, replacement, count] of edits) {
                const found = (src.match(new RegExp(pattern.source, 'g')) ?? []).length
                if (found !== count) {
                    throw new Error('исправление дефекта ' + defect + ' в ' + name + ': шаблон ' + pattern + ' найден ' + found + ' раз вместо ' + count)
                }
                src = src.replace(new RegExp(pattern.source, 'g'), replacement)
            }
            // Непрямой eval — в глобальной области, как исходный скрипт страницы
            window[name] = (0, eval)('(' + src + ')')
            applied.push(name + ' (дефект ' + defect + ')')
        }

        // Дефект 1 (FR 284, 289): блок определения размера окна — от «Hard code 50% overlap» до проверки степени
        // двойки — переносится перед усреднением частоты; частота каждого пакета вместо первого
        const window_block = /\r?\n[ \t]*\/\/ Hard code 50% overlap[\s\S]*?throw new Error\(\)\s*\}/
        const block = run_batch_fft.toString().match(window_block)
        patch('run_batch_fft', 1, [
            [window_block, '', 1],
            // Строка целиком, без перевода строки: с \r?\n шаблон нулевой ширины нашёлся бы и между \r и \n
            [/[ \t]*var sample_rate_sum = 0/, (line) => block[0].replace(/^\r?\n/, '') + '\n\n' + line, 1],
            [/data_set\[0\]\.sample_rate/, 'data_set[i].sample_rate', 1],
        ])
        // Дефект 2 (FR 2295–2297): срез до j для всех экземпляров GYR
        patch('load_from_raw_log', 2, [[/slice\(batch_start, j-i\)/, 'slice(batch_start, j)', 3]])
        // Дефект 5 (FR 2118–2122): пакет, дочитанный целиком на последнем сообщении ISBD, — полный
        patch('load_from_batch', 5, [[/if \(data_index >= ISBD\.N\.length\) \{(?=\s*console\.log\("Sequence incomplete)/,
                                      'if ((data_index >= ISBD.N.length) && (j + 1 < num_data_msg)) {', 1]])
        return applied
    })
}

// Снимок графиков FilterReview: трассы сенсора sensor (по 3 типа × 3 оси, в порядке type·3 + axis)
// и спектрограмма. Внутри страницы массивы (и типизированные) переводятся в обычные, нечисловые значения
// (±Infinity, NaN, дыры разрывов спектрограммы) — в строки, чтобы пережить передачу из браузера и сравниваться как есть
function snapshot_filterreview(page, sensor) {
    return page.evaluate((sensor) => {
        const snap = (a) => (a == null) ? null : Array.from(a, (v) => Number.isFinite(v) ? v : String(v))
        const traces = []
        for (let type = 0; type < 3; type++) {
            for (let axis = 0; axis < 3; axis++) {
                const index = get_FFT_data_index(sensor, type, axis)
                const t = fft_plot.data[index]
                traces.push({ index, name: t.name, x: snap(t.x), y: snap(t.y) })
            }
        }
        const heat = Spectrogram.data[0]
        return { traces, heat: { x: snap(heat.x), y: snap(heat.y), z: (heat.z ?? []).slice(0, 5).map(snap), rows: (heat.z ?? []).length } }
    }, sensor)
}

// Пакеты и FFT FilterReview для сенсора sensor: экземпляры до и после фильтров (частоты и длины пакетов,
// средняя частота, окно, число окон, верхний бин) и число пакетов каждого экземпляра
function filterreview_gyro(page, sensor) {
    return page.evaluate((sensor) => {
        const describe = (post) => {
            const i = Gyro_batch.findIndex((b) => (b != null) && (b.sensor_num == sensor) && (b.post_filter == post))
            if (i < 0) {
                return null
            }
            const FFT = Gyro_batch[i].FFT
            return {
                index: i,
                rates: Gyro_batch[i].map((b) => b.sample_rate),
                lengths: Gyro_batch[i].map((b) => b.x.length),
                average_sample_rate: FFT.average_sample_rate,
                window_size: FFT.window_size,
                windows: FFT.time.length,
                max_bin: FFT.bins[FFT.bins.length - 1],
            }
        }
        return { type: Gyro_batch.type, pre: describe(false), post: describe(true), batches: Gyro_batch.map((b) => (b == null) ? null : b.length) }
    }, sensor)
}

// Снимок графиков мастера: трассы по именам «Гироскоп N · тип · ось» и спектрограмма (данные — как у FilterReview)
function snapshot_wizard(page) {
    return page.evaluate(() => {
        const snap = (a) => (a == null) ? null : Array.from(a, (v) => Number.isFinite(v) ? v : String(v))
        const traces = {}
        for (const t of document.getElementById('Spectrum1').data) {
            traces[t.name] = { x: snap(t.x), y: snap(t.y) }
        }
        const heat = document.getElementById('Spectrogram1').data[0]
        return { traces, heat: { x: snap(heat.x), y: snap(heat.y), z: heat.z.slice(0, 5).map(snap), rows: heat.z.length } }
    })
}

// Бодэ FilterReview: выбранный гироскоп и шкала фазы, частоты, средняя амплитуда и фаза (Bode.data[2], [3])
function snapshot_filterreview_bode(page) {
    return page.evaluate(() => {
        const snap = (a) => (a == null) ? null : Array.from(a, (v) => Number.isFinite(v) ? v : String(v))
        return {
            inst: [0, 1, 2].find((i) => document.getElementById('BodeGyroInst' + i).checked),
            wrap: document.getElementById('ScaleWrap').checked,
            x: snap(Bode.data[2].x),
            amp: snap(Bode.data[2].y),
            phase: snap(Bode.data[3].y),
        }
    })
}

// Шаг 2 мастера: бодэ (Bode2.data[2], [3]) и оценка «после» по осям (Spectrum2.data[3..5])
function snapshot_wizard_step2(page) {
    return page.evaluate(() => {
        const snap = (a) => (a == null) ? null : Array.from(a, (v) => Number.isFinite(v) ? v : String(v))
        const bode = document.getElementById('Bode2').data
        const spectrum = document.getElementById('Spectrum2').data
        return {
            inst: [0, 1, 2].find((i) => document.getElementById('bode2_inst' + i).checked),
            wrap: document.getElementById('bode2_wrap').checked,
            x: snap(bode[2].x),
            amp: snap(bode[2].y),
            phase: snap(bode[3].y),
            est: [3, 4, 5].map((i) => ({ x: snap(spectrum[i].x), y: snap(spectrum[i].y) })),
        }
    })
}

// Сравнение бодэ одной шкалы фазы; label — подпись конфигурации
function compare_bode(label, fr_bode, wz_bode) {
    assert.equal(wz_bode.inst, fr_bode.inst, label + ': тот же гироскоп бодэ')
    assert.equal(wz_bode.wrap, fr_bode.wrap, label + ': та же шкала фазы')
    return [
        compare_arrays(label + ' · бодэ · x (частота)', fr_bode.x, wz_bode.x),
        compare_arrays(label + ' · бодэ · амплитуда', fr_bode.amp, wz_bode.amp),
        compare_arrays(label + ' · бодэ · фаза', fr_bode.phase, wz_bode.phase),
    ]
}

// Сравнение двух массивов; возвращает { ok, count, max_rel, mismatch }
function compare_arrays(label, a, b) {
    if ((a == null) || (b == null)) {
        return { ok: false, count: 0, max_rel: 0, mismatch: label + ': нет данных (FilterReview ' + (a == null ? 'null' : a.length) + ', мастер ' + (b == null ? 'null' : b.length) + ')' }
    }
    if (a.length !== b.length) {
        return { ok: false, count: 0, max_rel: 0, mismatch: label + ': длина FilterReview ' + a.length + ', мастер ' + b.length }
    }
    let max_rel = 0
    for (let i = 0; i < a.length; i++) {
        if ((typeof a[i] === 'string') || (typeof b[i] === 'string')) {
            if (a[i] !== b[i]) {
                return { ok: false, count: i, max_rel, mismatch: label + '[' + i + ']: FilterReview ' + a[i] + ', мастер ' + b[i] }
            }
            continue
        }
        const scale = Math.max(1, Math.abs(a[i]))
        const rel = Math.abs(a[i] - b[i]) / scale
        max_rel = Math.max(max_rel, rel)
        if (rel > tolerance) {
            return { ok: false, count: i, max_rel, mismatch: label + '[' + i + ']: FilterReview ' + a[i] + ', мастер ' + b[i] + ', |a−b|/max(1,|a|) = ' + rel.toExponential(3) }
        }
    }
    return { ok: true, count: a.length, max_rel, mismatch: null }
}

// Имя трассы мастера для сенсора sensor (с нуля), типа и оси
function wizard_trace_name(sensor, type, axis) {
    return 'Гироскоп ' + (sensor + 1) + ' · ' + WIZARD_TYPES[type] + ' · ' + AXES[axis]
}

// Поэлементное сравнение снимков FilterReview и мастера одной конфигурации; label — подпись конфигурации
function compare_snapshots(label, fr_snap, wz_snap, sensor) {
    const results = []
    for (let t = 0; t < 3; t++) {
        for (let a = 0; a < 3; a++) {
            const fr_trace = fr_snap.traces[t * 3 + a]
            const name = wizard_trace_name(sensor, t, a)
            if ((fr_trace.y == null) || (fr_trace.y.length == 0)) {
                console.log('  ' + label + ': пропуск ' + name + ' — в FilterReview нет данных (' + FR_TYPES[t] + ' ' + AXES[a] + ')')
                continue
            }
            const wz_trace = wz_snap.traces[name]
            results.push(compare_arrays(label + ' · ' + name + ' · x', fr_trace.x, wz_trace?.x))
            results.push(compare_arrays(label + ' · ' + name + ' · y', fr_trace.y, wz_trace?.y))
        }
    }
    results.push(compare_arrays(label + ' · спектрограмма · x (время)', fr_snap.heat.x, wz_snap.heat.x))
    results.push(compare_arrays(label + ' · спектрограмма · y (частота)', fr_snap.heat.y, wz_snap.heat.y))
    if (fr_snap.heat.rows !== wz_snap.heat.rows) {
        results.push({ ok: false, count: 0, max_rel: 0, mismatch: label + ' · спектрограмма: строк FilterReview ' + fr_snap.heat.rows + ', мастер ' + wz_snap.heat.rows })
    }
    for (let j = 0; j < fr_snap.heat.z.length; j++) {
        results.push(compare_arrays(label + ' · спектрограмма · z[' + j + ']', fr_snap.heat.z[j], wz_snap.heat.z[j]))
    }
    // Сравнение без единого числа ничего не доказывает
    assert.ok(results.some((r) => r.count > 0), label + ': нет ни одного сравненного значения')
    return results
}

// FilterReview: открыть, при patched — применить исправления, загрузить лог, снять настройки, выбранный гироскоп,
// пакеты и снимки графиков в конфигурациях «дБ, без алиасинга», «PSD, свёрнутый алиасинг» и бодэ для шага 2
async function run_filterreview(browser, server, log_path, problems, patched) {
    const name = patched ? 'FilterReview с исправлениями' : 'FilterReview'
    const fr = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
    fr.on('pageerror', (e) => problems.push(name + ' pageerror: ' + e.message))
    fr.on('dialog', (d) => { problems.push(name + ' alert: ' + d.message()); d.dismiss() })
    await wait_for_server(fr, 'http://127.0.0.1:' + port + '/FilterReview/', server)
    const patches = patched ? await patch_filterreview(fr) : []
    await fr.setInputFiles('#fileItem', log_path)
    // readFile ставит заголовок после окончания load
    await fr.waitForFunction(() => document.title.startsWith('Filter Review: '), null, { timeout: 180000 })
    await wait_overlay(fr)
    const settings = await fr.evaluate(() => ({
        start: document.getElementById('TimeStart').value,
        end: document.getElementById('TimeEnd').value,
        window_per_batch: document.getElementById('FFTWindow_per_batch').value,
        window_size: document.getElementById('FFTWindow_size').value,
        batch: document.getElementById('log_type_batch').checked,
        filter_version: [1, 2, 3, 4].find((v) => document.getElementById('filter_version_' + v).checked),
    }))
    // Гироскоп по умолчанию — выбор спектрограммы после загрузки: первичный, а без его данных — первый с данными (FR 2674–2677)
    const sensor = await fr.evaluate(() => [0, 1, 2].find((i) => document.getElementById('SpecGyroInst' + i).checked))
    const gyro = await filterreview_gyro(fr, sensor)
    for (const id of ['#ScaleLog', '#freq_ScaleLinear', '#freq_Scale_Hz', '#Aliasing_none']) {
        await fr.check(id)
    }
    await fr.evaluate(() => re_calc())
    const snap = await snapshot_filterreview(fr, sensor)
    // Вторая конфигурация: PSD и свёрнутый алиасинг (Aliasing_on) — проверка PSD и alias_obj на настоящих данных
    await fr.check('#ScalePSD')
    await fr.check('#Aliasing_on')
    await fr.evaluate(() => re_calc())
    const snap_psd = await snapshot_filterreview(fr, sensor)
    // Для шага 2: снова дБ без алиасинга; бодэ гироскопа, выбранного FilterReview, с его шкалой фазы и с противоположной
    await fr.check('#ScaleLog')
    await fr.check('#Aliasing_none')
    await fr.evaluate(() => re_calc())
    const bode = await snapshot_filterreview_bode(fr)
    await fr.check(bode.wrap ? '#ScaleUnWrap' : '#ScaleWrap')
    await fr.evaluate(() => redraw_post_estimate_and_bode())
    const bode_other = await snapshot_filterreview_bode(fr)
    return { settings, sensor, gyro, snap, snap_psd, bode, bode_other, patches }
}

// Исправленная средняя частота (дефект 1) по пакетам FilterReview: среднее по пакетам не короче окна, а если таких
// нет — по всем; тем же порядком сложения, что run_batch_fft. Возвращает период, частоту и верхний бин rfft_freq
function fixed_rate(info) {
    let sum = 0
    let count = 0
    info.rates.forEach((rate, j) => {
        if (info.lengths[j] >= info.window_size) {
            sum += rate
            count++
        }
    })
    if (count == 0) {
        for (const rate of info.rates) {
            sum += rate
            count++
        }
    }
    const sample_time = count / sum
    const half = Math.floor(info.window_size / 2)
    return { sample_time, rate: 1 / sample_time, max_bin: half / (info.window_size * sample_time) }
}

// Число точек сетки бодэ 0…max шагом BODE_FREQ_STEP (array_from_range)
function bode_points(max) {
    return Math.floor(max / BODE_FREQ_STEP) + 1
}

// Наибольшее относительное отклонение по общему началу массивов и число отличающихся позиций
function deviation(a, b) {
    const len = Math.min(a.length, b.length)
    let max_rel = 0
    let differ = 0
    for (let i = 0; i < len; i++) {
        if ((typeof a[i] === 'string') || (typeof b[i] === 'string')) {
            if (a[i] !== b[i]) {
                differ++
            }
            continue
        }
        const rel = Math.abs(a[i] - b[i]) / Math.max(1, Math.abs(a[i]))
        if (rel > tolerance) {
            differ++
        }
        max_rel = Math.max(max_rel, rel)
    }
    return { max_rel, differ, len }
}

// Проверка массива мастера против FilterReview как есть по правилу:
//   same — совпадает (допуск tolerance); scale — FilterReview × k; shift — FilterReview + d;
//   grow — мастер длиннее на n с тем же началом; report — только отчёт.
// Возвращает { ok, line } — строку для вывода
function check_upstream(item) {
    const { name, up, wz, rule, reason } = item
    if ((up == null) || (wz == null)) {
        return { ok: false, line: name + ': нет данных (FilterReview ' + (up == null ? 'null' : up.length) + ', мастер ' + (wz == null ? 'null' : wz.length) + ')' }
    }
    const map = (f) => up.map((v) => (typeof v === 'number') ? f(v) : v)
    let r
    if (rule.kind == 'same') {
        r = compare_arrays(name, up, wz)
        return { ok: r.ok, same: r.ok, line: r.ok ? name : r.mismatch }
    }
    if (rule.kind == 'scale') {
        r = compare_arrays(name + ' (FilterReview × ' + rule.k + ')', map((v) => v * rule.k), wz)
    } else if (rule.kind == 'shift') {
        r = compare_arrays(name + ' (FilterReview + ' + rule.d + ' с)', map((v) => v + rule.d), wz)
    } else if (rule.kind == 'grow') {
        if ((up == null) || (wz == null) || (wz.length !== up.length + rule.n)) {
            return { ok: false, line: name + ': ожидалась длина FilterReview + ' + rule.n + ' = ' + (up?.length + rule.n) + ', мастер ' + wz?.length }
        }
        r = compare_arrays(name + ' (общее начало)', up, wz.slice(0, up.length))
    }
    if (r != null) {
        const dev = deviation(up, wz)
        const detail = (up.length == wz.length) ? 'до ' + dev.max_rel.toExponential(2) : 'длина ' + up.length + ' → ' + wz.length + ', в общем начале до ' + dev.max_rel.toExponential(2)
        return { ok: r.ok, line: r.ok ? name + ' — отличается (' + detail + '): ' + reason : r.mismatch }
    }
    const dev = deviation(up, wz)
    const length = (up.length == wz.length) ? '' : 'длина ' + up.length + ' → ' + wz.length + ', '
    const line = (dev.differ == 0) && (up.length == wz.length)
        ? name + ' — совпадает'
        : name + ' — отличается (' + length + 'позиций ' + dev.differ + ' из ' + dev.len + ', до ' + dev.max_rel.toExponential(2) + '): ' + reason
    return { ok: true, same: line.endsWith('совпадает'), line }
}

async function main() {
    const log_path = find_log()
    if (log_path == null) {
        console.log('tunewizard-compare: лог не найден (TUNEWIZARD_LOG или TuneWizard/logs/*.bin) — пропуск')
        return
    }
    const python = process.platform === 'win32' ? 'python' : 'python3'
    const problems = []
    let server = null
    let browser = null
    try {
        server = spawn(python, ['-m', 'http.server', '--bind', '127.0.0.1', String(port)], { cwd: repo, stdio: 'ignore' })
        server.on('error', (e) => problems.push('http.server: ' + e.message))
        browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined })

        // 1. FilterReview как есть и FilterReview с исправлениями — эталон точного сравнения
        const up = await run_filterreview(browser, server, log_path, problems, false)
        const fix = await run_filterreview(browser, server, log_path, problems, true)
        assert.deepEqual(fix.settings, up.settings, 'FilterReview с исправлениями: те же интервал, тип лога, окна и версия фильтра')
        assert.equal(fix.sensor, up.sensor, 'FilterReview с исправлениями показывает тот же гироскоп')
        const fr_settings = fix.settings
        const sensor = fix.sensor
        const fr_bode = fix.bode
        const fr_bode_other = fix.bode_other

        // 2. Мастер: тот же лог, интервал FilterReview, тот же тип лога, окна на пакет и версия фильтра, дБ / Гц / без алиасинга
        const wz = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
        wz.on('console', (m) => { if (m.type() === 'error') problems.push('мастер console: ' + m.text()) })
        wz.on('pageerror', (e) => problems.push('мастер pageerror: ' + e.message))
        wz.on('dialog', (d) => { problems.push('мастер alert: ' + d.message()); d.dismiss() })
        await wz.goto('http://127.0.0.1:' + port + '/TuneWizard/', { waitUntil: 'networkidle' })
        await wz.setInputFiles('#fileItem', log_path)
        await wz.locator('#log_verdict').waitFor({ state: 'visible', timeout: 180000 })
        await wait_overlay(wz)
        // Интервал по умолчанию у мастера свой (окно газа из core/log.js) — для справки в выводе
        const wz_default = [await wz.inputValue('#TimeStart'), await wz.inputValue('#TimeEnd')]
        await wz.fill('#TimeStart', fr_settings.start)
        await wz.fill('#TimeEnd', fr_settings.end)
        await wz.dispatchEvent('#TimeStart', 'change')
        await wz.dispatchEvent('#TimeEnd', 'change')
        assert.deepEqual([await wz.inputValue('#TimeStart'), await wz.inputValue('#TimeEnd')], [fr_settings.start, fr_settings.end], 'интервал мастера равен интервалу FilterReview')

        await wz.click('#wizbar button:nth-child(2)')
        await wait_overlay(wz)
        assert.equal(await wz.isChecked('#spec_log_batch'), fr_settings.batch, 'тот же тип лога (batch)')
        await wz.fill('#spec_window_per_batch', fr_settings.window_per_batch)
        await wz.dispatchEvent('#spec_window_per_batch', 'change')
        await wz.check('#spec_fv_' + fr_settings.filter_version)
        for (const id of ['#spec_amp_dB', '#spec_freq_Hz', '#spec_alias_none']) {
            if (!(await wz.isChecked(id))) {
                await wz.check(id)
                await wait_overlay(wz)
            }
        }
        if (await wz.isChecked('#spec_freq_log')) {
            await wz.uncheck('#spec_freq_log')
            await wait_overlay(wz)
        }
        await wz.click('#spec_recalc')
        await wait_overlay(wz)
        const wz_fv = await wz.evaluate(() => [1, 2, 3, 4].find((v) => document.getElementById('spec_fv_' + v).checked))
        assert.equal(wz_fv, fr_settings.filter_version, 'версия фильтра мастера равна версии FilterReview')
        // Гироскоп — тот же, что показывает FilterReview: первичный, а без его данных — первый с данными
        const wz_sensor = await wz.evaluate(() => state.gyro.primary ?? state.gyro.first_gyro)
        assert.equal(wz_sensor, sensor, 'мастер выбрал гироскоп ' + (wz_sensor + 1) + ', FilterReview — ' + (sensor + 1))
        // Выбор спектрограммы по умолчанию — как в FilterReview: этот гироскоп, до фильтров, ось X
        assert.deepEqual(await wz.evaluate((s) => ['spec_sg_inst' + s, 'spec_sg_pre', 'spec_sg_x'].map((id) => document.getElementById(id).checked), sensor),
            [true, true, true], 'спектрограмма: гироскоп ' + (sensor + 1) + ', до, X')
        const wz_window = await wz.inputValue('#FFTWindow_size')
        assert.equal(wz_window, fr_settings.window_size, 'окно FFT, вычисленное из числа окон на пакет, совпадает с FilterReview')
        // Средние частоты экземпляров до и после фильтров этого гироскопа — для проверки дефекта 1
        const wz_rates = await wz.evaluate((s) => {
            const rate = (post) => state.gyro.find((b) => (b != null) && (b.sensor_num == s) && (b.post_filter == post))?.FFT?.average_sample_rate ?? null
            return { pre: rate(false), post: rate(true) }
        }, sensor)
        const wz_snap = await snapshot_wizard(wz)
        await wz.check('#spec_amp_PSD')
        await wait_overlay(wz)
        await wz.check('#spec_alias_fold')
        await wait_overlay(wz)
        const wz_snap_psd = await snapshot_wizard(wz)

        // Шаг 2 мастера: шкалы шага 1 обратно в дБ без алиасинга, параметры формы — из лога; гироскоп бодэ и шкала фазы как в FilterReview
        await wz.check('#spec_amp_dB')
        await wait_overlay(wz)
        await wz.check('#spec_alias_none')
        await wait_overlay(wz)
        await wz.click('#wizbar button:nth-child(3)')
        await wait_overlay(wz)
        assert.equal(await wz.evaluate(() => candidate_key(values_from_form()) === candidate_key(values_from_log())), true, 'форма шага 2 — значения лога')
        const set_bode = async (inst, wrap) => {
            if (!(await wz.isChecked('#bode2_inst' + inst))) {
                await wz.check('#bode2_inst' + inst)
                await wait_overlay(wz)
            }
            if ((await wz.isChecked('#bode2_wrap')) !== wrap) {
                await wz.setChecked('#bode2_wrap', wrap)
                await wait_overlay(wz)
            }
        }
        await set_bode(fr_bode.inst, fr_bode.wrap)
        const wz_step2 = await snapshot_wizard_step2(wz)
        await set_bode(fr_bode_other.inst, fr_bode_other.wrap)
        const wz_step2_other = await snapshot_wizard_step2(wz)

        // 3. Точное сравнение с FilterReview с исправлениями: обе конфигурации шага 1 и шаг 2
        assert.deepEqual(problems, [], 'ошибки страниц')
        const configs = [['дБ, без алиасинга', fix.snap, wz_snap], ['PSD, свёрнутый алиасинг', fix.snap_psd, wz_snap_psd]]
        let failed_total = 0
        const summary = []
        // Шаг 2: оценка «после» для значений формы (= лога) против Estimated post FilterReview (дБ, без алиасинга) и бодэ
        const step2_label = 'шаг 2 (параметры лога)'
        const phase_name = (b) => b.wrap ? 'фаза ±180°' : 'фаза развёрнута'
        const step2_results = () => {
            const results = []
            for (let a = 0; a < 3; a++) {
                const fr_trace = fix.snap.traces[2 * 3 + a]
                if ((fr_trace.y == null) || (fr_trace.y.length == 0)) {
                    continue
                }
                results.push(compare_arrays(step2_label + ' · оценка «после» · ' + AXES[a] + ' · x', fr_trace.x, wz_step2.est[a].x))
                results.push(compare_arrays(step2_label + ' · оценка «после» · ' + AXES[a] + ' · y', fr_trace.y, wz_step2.est[a].y))
            }
            results.push(...compare_bode(step2_label + ', ' + phase_name(fr_bode), fr_bode, wz_step2))
            results.push(...compare_bode(step2_label + ', ' + phase_name(fr_bode_other), fr_bode_other, wz_step2_other))
            assert.ok(results.some((r) => r.count > 0), step2_label + ': нет ни одного сравненного значения')
            return results
        }
        configs.push([step2_label, null, null])
        for (const [label, fr_s, wz_s] of configs) {
            const results = (fr_s == null) ? step2_results() : compare_snapshots(label, fr_s, wz_s, sensor)
            const failed = results.filter((r) => !r.ok)
            const count = results.reduce((sum, r) => sum + r.count, 0)
            const max_rel = results.reduce((max, r) => Math.max(max, r.max_rel), 0)
            if (failed.length > 0) {
                console.error('tunewizard-compare: ' + label + ' — расхождений с FilterReview с исправлениями ' + failed.length + ' из ' + results.length + ' массивов; первое: ' + failed[0].mismatch)
                for (const r of failed.slice(1, 6)) {
                    console.error('  ' + r.mismatch)
                }
                failed_total += failed.length
            }
            summary.push(label + ': ' + results.length + ' массивов, ' + count + ' значений, наибольшее относительное отклонение ' + max_rel.toExponential(2))
        }

        // 4. Отчёт о расхождениях с FilterReview как есть («дБ, без алиасинга» и шаг 2) и точная проверка ожидаемых
        // Какие исправления действуют на этом логе — по данным самого FilterReview
        const fixed = { pre: (up.gyro.pre != null) ? fixed_rate(up.gyro.pre) : null, post: (up.gyro.post != null) ? fixed_rate(up.gyro.post) : null }
        const defect1 = ['pre', 'post'].some((k) => (fixed[k] != null) && (fixed[k].rate !== up.gyro[k].average_sample_rate))
        const defect5 = JSON.stringify(fix.gyro.batches) !== JSON.stringify(up.gyro.batches)
        const defect2 = (up.gyro.type == 'raw') && up.gyro.batches.some((b, i) => (i > 0) && (b != null))
        const active = [defect1 && 1, defect2 && 2, defect5 && 5].filter(Boolean)
        const reasons = []
        if (defect1) {
            for (const k of ['pre', 'post']) {
                if (fixed[k] == null) {
                    continue
                }
                // Мастер считает ту же исправленную среднюю частоту, что получена здесь по пакетам FilterReview
                assert.ok(Math.abs(wz_rates[k] - fixed[k].rate) <= 1e-12 * fixed[k].rate, 'средняя частота мастера (' + k + ') ' + wz_rates[k] + ', по пакетам FilterReview ' + fixed[k].rate)
                reasons.push(WIZARD_TYPES[k == 'pre' ? 0 : 1] + ': ' + up.gyro[k].average_sample_rate + ' → ' + fixed[k].rate + ' Гц (×' + (fixed[k].rate / up.gyro[k].average_sample_rate) + ')')
            }
        }
        const only1 = defect1 && !defect2 && !defect5
        const why = {
            scale: 'дефект 1 — бины по средней частоте всех пакетов, ровно ×ρ',
            same: 'не зависит от частоты дискретизации',
            shift: 'дефект 1 — центр окна (окно/2)·период сдвинут на Δ',
            grow: 'дефект 1 — сетка бодэ 0…Найквист шагом 0.05 Гц, с тем же началом',
            filters: 'дефект 1 — notch и ФНЧ заданы в герцах, их доля частоты дискретизации другая',
            other: 'дефекты ' + active.join(', ') + ' — проверено точным сравнением с FilterReview с исправлениями',
        }
        // Правило массива: без действующих дефектов всё совпадает; только дефект 1 — по виду массива; иначе — отчёт
        const rule = (kind, k) => {
            if (active.length == 0) {
                return { rule: { kind: 'same' }, reason: '' }
            }
            if (!only1) {
                return { rule: { kind: 'report' }, reason: why.other }
            }
            if (kind == 'scale') return { rule: { kind: 'scale', k }, reason: why.scale }
            if (kind == 'shift') return (k == null) ? { rule: { kind: 'report' }, reason: why.shift + ' (окон на пакет больше одного — сдвиг у окон разный)' } : { rule: { kind: 'shift', d: k }, reason: why.shift }
            if (kind == 'grow') return { rule: { kind: 'grow', n: k }, reason: why.grow }
            if (kind == 'filters') return { rule: { kind: 'report' }, reason: why.filters }
            return { rule: { kind: 'same' }, reason: why.same }
        }
        const rho = (k) => (fixed[k] != null) ? fixed[k].rate / up.gyro[k].average_sample_rate : 1
        const shift = (fixed.pre != null) && (fr_settings.window_per_batch == 1)
            ? (up.gyro.pre.window_size / 2) * (fixed.pre.sample_time - 1 / up.gyro.pre.average_sample_rate)
            : null
        const items = []
        const label = 'дБ, без алиасинга'
        for (let t = 0; t < 3; t++) {
            for (let a = 0; a < 3; a++) {
                const fr_trace = up.snap.traces[t * 3 + a]
                if ((fr_trace.y == null) || (fr_trace.y.length == 0)) {
                    continue
                }
                const name = label + ' · ' + wizard_trace_name(sensor, t, a)
                const wz_trace = wz_snap.traces[wizard_trace_name(sensor, t, a)]
                items.push({ name: name + ' · x', up: fr_trace.x, wz: wz_trace.x, ...rule('scale', rho(t == 1 ? 'post' : 'pre')) })
                items.push({ name: name + ' · y', up: fr_trace.y, wz: wz_trace.y, ...rule(t == 2 ? 'filters' : 'same') })
            }
        }
        items.push({ name: label + ' · спектрограмма · x (время)', up: up.snap.heat.x, wz: wz_snap.heat.x, ...rule('shift', shift) })
        items.push({ name: label + ' · спектрограмма · y (частота)', up: up.snap.heat.y, wz: wz_snap.heat.y, ...rule('scale', rho('pre')) })
        items.push({ name: label + ' · спектрограмма · строк', up: [up.snap.heat.rows], wz: [wz_snap.heat.rows], ...rule('same') })
        for (let j = 0; j < up.snap.heat.z.length; j++) {
            items.push({ name: label + ' · спектрограмма · z[' + j + ']', up: up.snap.heat.z[j], wz: wz_snap.heat.z[j], ...rule('same') })
        }
        for (let a = 0; a < 3; a++) {
            const fr_trace = up.snap.traces[2 * 3 + a]
            if ((fr_trace.y == null) || (fr_trace.y.length == 0)) {
                continue
            }
            items.push({ name: step2_label + ' · оценка «после» · ' + AXES[a] + ' · x', up: fr_trace.x, wz: wz_step2.est[a].x, ...rule('scale', rho('pre')) })
            items.push({ name: step2_label + ' · оценка «после» · ' + AXES[a] + ' · y', up: fr_trace.y, wz: wz_step2.est[a].y, ...rule('filters') })
        }
        const bode_grow = (fixed.pre != null) ? bode_points(fixed.pre.max_bin) - bode_points(up.gyro.pre.max_bin) : 0
        for (const [b_up, b_wz] of [[up.bode, wz_step2], [up.bode_other, wz_step2_other]]) {
            const name = step2_label + ', ' + phase_name(b_up) + ' · бодэ'
            items.push({ name: name + ' · x (частота)', up: b_up.x, wz: b_wz.x, ...rule('grow', bode_grow) })
            items.push({ name: name + ' · амплитуда', up: b_up.amp, wz: b_wz.amp, ...rule('filters') })
            items.push({ name: name + ' · фаза', up: b_up.phase, wz: b_wz.phase, ...rule('filters') })
        }
        const checked = items.map(check_upstream)
        const same = checked.filter((c) => c.ok && c.same)
        const differ = checked.filter((c) => c.ok && !c.same)
        const upstream_failed = checked.filter((c) => !c.ok)
        console.log('tunewizard-compare: FilterReview как есть — действующие исправления: ' + (active.length ? active.join(', ') : 'нет') +
            (reasons.length ? ' (средняя частота ' + reasons.join('; ') + ')' : '') + '; исправления в эталоне: ' + fix.patches.join(', '))
        console.log('  совпадают ' + same.length + ' из ' + checked.length + ' массивов: ' + same.map((c) => c.line.replace(/ — совпадает$/, '')).join('; '))
        for (const c of differ) {
            console.log('  ' + c.line)
        }
        if (upstream_failed.length > 0) {
            console.error('tunewizard-compare: ожидаемые расхождения с FilterReview как есть не подтвердились — ' + upstream_failed.length + ' из ' + checked.length + ' массивов:')
            for (const c of upstream_failed.slice(0, 6)) {
                console.error('  ' + c.line)
            }
            failed_total += upstream_failed.length
        }

        if (failed_total > 0) {
            process.exitCode = 1
            return
        }
        console.log('tunewizard-compare: совпадение с FilterReview с исправлениями (допуск ' + tolerance + ') — ' + summary.join('; ') + '. Интервал ' + fr_settings.start + '–' +
            fr_settings.end + ' с (у мастера по умолчанию ' + wz_default.join('–') + ' с), окон на пакет ' + fr_settings.window_per_batch + ', окно ' + wz_window +
            ', версия фильтра ' + wz_fv + ', гироскоп ' + (sensor + 1) + ', строк спектрограммы ' + wz_snap.heat.rows + ', гироскоп бодэ ' + (fr_bode.inst + 1) +
            ', фаза FilterReview по умолчанию ' + (fr_bode.wrap ? '±180°' : 'развёрнута'))
    } catch (e) {
        if (problems.length) {
            console.error('Сообщения страниц:', problems)
        }
        throw e
    } finally {
        if (browser) {
            await browser.close()
        }
        if (server) {
            server.kill()
        }
    }
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
