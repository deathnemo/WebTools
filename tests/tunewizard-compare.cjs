// Регрессия мастера настройки против FilterReview в настоящем браузере (Playwright + Chrome).
// Запуск: npm run test:tunewizard-compare
// Один лог открывается в FilterReview и в мастере с одинаковыми интервалом анализа, типом лога, числом окон
// на пакет, версией фильтра (как выбрана в FilterReview) и шкалой частоты (Гц, линейная ось); данные графиков
// сравниваются поэлементно: средний спектр гироскопа, который FilterReview показывает по умолчанию (первичный
// или первый с данными; мастер обязан выбрать тот же), — до / после / оценка «после» по X, Y, Z — и спектрограмма
// (оси и первые 5 строк матрицы) в двух конфигурациях: дБ без алиасинга и PSD со свёрнутым алиасингом. Шаг 2
// с параметрами из лога в обоих инструментах: бодэ (частоты, средняя амплитуда в дБ, средняя фаза) для гироскопа,
// выбранного в FilterReview, с его выбором фазы (развёрнутая или ±180°) и с противоположным, и оценка «после»
// по X, Y, Z. Допуск |a − b| ≤ 1e-6·max(1, |a|), для осей времени — |a − b| ≤ 1e-9 с (относительный допуск
// на 560 с — это 0.56 мс и скрыл бы сдвиги в десятки микросекунд); при расхождении — первая позиция и значения,
// код выхода 1.
//
// Эталон точного сравнения — FilterReview с теми же исправлениями дефектов upstream, что внесены в мастер
// (задача 8, docs/plans/2026-10-24-tune-wizard-stage2-design.md, раздел 2): до загрузки лога в исходном тексте
// функций FilterReview заменяются строки дефектов 1 (run_batch_fft), 2 (load_from_raw_log), 3 — заголовок пакета
// без сообщений ISBD посреди лога (load_from_batch, FR 2087–2095) — и 5 (load_from_batch); каждая замена обязана
// сработать заданное число раз, иначе upstream изменился и тест надо пересмотреть. Остальные ветви дефекта 3 и
// дефекты 4, 6, 7 на логах, которые FilterReview открывает без ошибок, не срабатывают: при них он прерывает
// загрузку, выдаёт alert или падает, и тест останавливается раньше сравнения. Если интервал анализа у FilterReview
// с исправлениями другой (дефект 5 сдвигает конец данных), это печатается, и тот же интервал задаётся обоим.
//
// Кроме того, мастер сравнивается с FilterReview как есть (upstream): печатается, какие массивы совпадают, какие
// отличаются, насколько и почему. Какие исправления действуют на логе, определяется по данным самого FilterReview.
// Если действует только дефект 1 (частоты пакетов разные: у batch-лога — непостоянная ISBH.smp_rate, у raw-лога из
// двух и больше пакетов — своя частота у каждого; upstream брал частоту первого пакета и не исключал из средней
// пакеты короче окна), расхождения проверяются точно: оси частот — ровно ×ρ, где ρ — отношение средних частот,
// пересчитанное по пакетам самого FilterReview; сетка бодэ длиннее или короче на k точек с тем же началом. Для
// batch-лога ещё: записанные спектры в дБ и строки спектрограммы — без изменений, время спектрограммы сдвинуто на
// Δ = (окно/2)·(новый период − старый) (при одном окне на пакет). У raw-лога окон в пакете много и сдвиг времени
// у них разный — эти массивы только в отчёте. Без действующих дефектов всё должно совпадать с upstream; при других
// сочетаниях — только отчёт (точность обеспечивает сравнение с эталоном).
// Нужны те же лог, браузер и python, что для tests/tunewizard-browser.cjs; без лога тест пропускается.
// Логика правил (upstream_plan, check_upstream) без браузера проверяется в tests/tunewizard-compare-rules.test.cjs.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const repo = path.resolve(__dirname, '..')
const logs_dir = path.join(repo, 'TuneWizard', 'logs')
const port = 8792
const tolerance = 1e-6
// Допуск для осей времени, с
const time_tolerance = 1e-9

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
        // Дефект 3, заголовок без сообщений ISBD (FR 2087–2095): поиск возвращается к началу, заголовок пропускается.
        // Без этого FilterReview такой лог открывает без ошибок, но теряет все пакеты после повреждения
        patch('load_from_batch', 3, [
            [/const seq_num = ISBH\.N\[i\]/, 'const seq_num = ISBH.N[i]; const search_start = data_index; let not_found = false', 1],
            [/(console\.log\("Could not find next sequence[^\r\n]*\r?\n\s*)decode_complete = true/, '$1data_index = search_start; not_found = true', 1],
            [/(\}\s*)if \(decode_complete\) \{(\s*break\s*\}\s*let x = \[\])/, '$1if (not_found) { continue }\n        if (decode_complete) {$2', 1],
        ])
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

// Отклонение пары чисел: абсолютное, если задан abs (с), иначе относительное |a−b|/max(1,|a|)
function difference(a, b, abs) {
    return (abs != null) ? Math.abs(a - b) : Math.abs(a - b) / Math.max(1, Math.abs(a))
}

// Сравнение двух массивов; abs — абсолютный допуск (для осей времени), иначе относительный tolerance.
// Возвращает { ok, count, max_rel, max_abs, mismatch }: отклонение в max_abs, если задан abs, иначе в max_rel
function compare_arrays(label, a, b, abs = null) {
    if ((a == null) || (b == null)) {
        return { ok: false, count: 0, max_rel: 0, max_abs: 0, mismatch: label + ': нет данных (FilterReview ' + (a == null ? 'null' : a.length) + ', мастер ' + (b == null ? 'null' : b.length) + ')' }
    }
    if (a.length !== b.length) {
        return { ok: false, count: 0, max_rel: 0, max_abs: 0, mismatch: label + ': длина FilterReview ' + a.length + ', мастер ' + b.length }
    }
    const limit = abs ?? tolerance
    let max = 0
    const result = (ok, count, mismatch) => ({ ok, count, max_rel: (abs == null) ? max : 0, max_abs: (abs == null) ? 0 : max, mismatch })
    for (let i = 0; i < a.length; i++) {
        if ((typeof a[i] === 'string') || (typeof b[i] === 'string')) {
            if (a[i] !== b[i]) {
                return result(false, i, label + '[' + i + ']: FilterReview ' + a[i] + ', мастер ' + b[i])
            }
            continue
        }
        const d = difference(a[i], b[i], abs)
        max = Math.max(max, d)
        if (d > limit) {
            return result(false, i, label + '[' + i + ']: FilterReview ' + a[i] + ', мастер ' + b[i] + ((abs == null) ? ', |a−b|/max(1,|a|) = ' : ', |a−b| = ') + d.toExponential(3) + ((abs == null) ? '' : ' с'))
        }
    }
    return result(true, a.length, null)
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
    results.push(compare_arrays(label + ' · спектрограмма · x (время)', fr_snap.heat.x, wz_snap.heat.x, time_tolerance))
    results.push(compare_arrays(label + ' · спектрограмма · y (частота)', fr_snap.heat.y, wz_snap.heat.y))
    if (fr_snap.heat.rows !== wz_snap.heat.rows) {
        results.push({ ok: false, count: 0, max_rel: 0, max_abs: 0, mismatch: label + ' · спектрограмма: строк FilterReview ' + fr_snap.heat.rows + ', мастер ' + wz_snap.heat.rows })
    }
    for (let j = 0; j < fr_snap.heat.z.length; j++) {
        results.push(compare_arrays(label + ' · спектрограмма · z[' + j + ']', fr_snap.heat.z[j], wz_snap.heat.z[j]))
    }
    // Сравнение без единого числа ничего не доказывает
    assert.ok(results.some((r) => r.count > 0), label + ': нет ни одного сравненного значения')
    return results
}

// FilterReview: открыть, при patched — применить исправления, загрузить лог, снять настройки, выбранный гироскоп,
// пакеты и снимки графиков в конфигурациях «дБ, без алиасинга», «PSD, свёрнутый алиасинг» и бодэ для шага 2.
// interval = { start, end } (строки полей) — задать этот интервал анализа, если свой у FilterReview другой
async function run_filterreview(browser, server, log_path, problems, patched, interval = null) {
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
    // Свой интервал FilterReview меняется на заданный: find_start_index/find_end_index читают поля при расчёте (re_calc ниже)
    let own_interval = null
    if ((interval != null) && ((interval.start !== settings.start) || (interval.end !== settings.end))) {
        own_interval = { start: settings.start, end: settings.end }
        await fr.evaluate((iv) => {
            document.getElementById('TimeStart').value = iv.start
            document.getElementById('TimeEnd').value = iv.end
        }, interval)
        settings.start = interval.start
        settings.end = interval.end
    }
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
    return { settings, own_interval, sensor, gyro, snap, snap_psd, bode, bode_other, patches }
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

// Наибольшее отклонение по общему началу массивов (абсолютное при abs, иначе относительное) и число позиций сверх допуска
function deviation(a, b, abs = null) {
    const len = Math.min(a.length, b.length)
    let max = 0
    let differ = 0
    for (let i = 0; i < len; i++) {
        if ((typeof a[i] === 'string') || (typeof b[i] === 'string')) {
            if (a[i] !== b[i]) {
                differ++
            }
            continue
        }
        const d = difference(a[i], b[i], abs)
        if (d > (abs ?? tolerance)) {
            differ++
        }
        max = Math.max(max, d)
    }
    return { max, differ, len, text: max.toExponential(2) + ((abs == null) ? '' : ' с') }
}

// Проверка массива мастера против FilterReview как есть по правилу item.rule:
//   same — совпадает; scale — FilterReview × k; shift — FilterReview + d;
//   grow — длина мастера = длина FilterReview + n (n любого знака), общее начало совпадает; report — только отчёт.
// item.abs — абсолютный допуск (оси времени). Возвращает { ok, same, line } — строку для вывода
function check_upstream(item) {
    const { name, up, wz, rule, reason, abs = null } = item
    if ((up == null) || (wz == null)) {
        return { ok: false, same: false, line: name + ': нет данных (FilterReview ' + (up == null ? 'null' : up.length) + ', мастер ' + (wz == null ? 'null' : wz.length) + ')' }
    }
    const map = (f) => up.map((v) => (typeof v === 'number') ? f(v) : v)
    let r = null
    if (rule.kind == 'same') {
        r = compare_arrays(name, up, wz, abs)
        return { ok: r.ok, same: r.ok, line: r.ok ? name : r.mismatch }
    }
    if (rule.kind == 'scale') {
        r = compare_arrays(name + ' (FilterReview × ' + rule.k + ')', map((v) => v * rule.k), wz, abs)
    } else if (rule.kind == 'shift') {
        r = compare_arrays(name + ' (FilterReview + ' + rule.d + ' с)', map((v) => v + rule.d), wz, abs)
    } else if (rule.kind == 'grow') {
        if (wz.length !== up.length + rule.n) {
            return { ok: false, same: false, line: name + ': ожидалась длина FilterReview ' + (rule.n < 0 ? '− ' : '+ ') + Math.abs(rule.n) + ' = ' + (up.length + rule.n) + ', мастер ' + wz.length }
        }
        // Общее начало — по более короткому массиву: при ρ < 1 сетка мастера короче
        const common = Math.min(up.length, wz.length)
        r = compare_arrays(name + ' (общее начало)', up.slice(0, common), wz.slice(0, common), abs)
    }
    const dev = deviation(up, wz, abs)
    const length = (up.length == wz.length) ? '' : ((wz.length > up.length) ? 'длиннее' : 'короче') + ' на ' + Math.abs(wz.length - up.length) + ' (' + up.length + ' → ' + wz.length + '), '
    if (r != null) {
        const detail = (up.length == wz.length) ? 'до ' + dev.text : length + 'в общем начале до ' + dev.text
        return { ok: r.ok, same: false, line: r.ok ? name + ' — отличается (' + detail + '): ' + reason : r.mismatch }
    }
    if ((dev.differ == 0) && (up.length == wz.length)) {
        return { ok: true, same: true, line: name + ' — совпадает' }
    }
    return { ok: true, same: false, line: name + ' — отличается (' + length + 'позиций ' + dev.differ + ' из ' + dev.len + ', до ' + dev.text + '): ' + reason }
}

// План сверки с FilterReview как есть — без браузера (его проверяет tests/tunewizard-compare-rules.test.cjs).
// ctx = { up, fix, sensor, settings, wz_snap, wz_step2, wz_step2_other, wz_rates }:
//   up / fix — результаты run_filterreview для FilterReview как есть и с исправлениями (нужны gyro, snap, bode,
//   bode_other); settings — настройки, с которыми считали оба инструмента; wz_* — снимки мастера и средние частоты
//   его экземпляров до/после фильтров этого сенсора.
// Возвращает { active, reasons, checks, items }: действующие исправления, их описание, проверки средних частот
// ({ ok, line }) и массивы с правилами для check_upstream
function upstream_plan(ctx) {
    const { up, fix, sensor, settings, wz_snap, wz_step2, wz_step2_other, wz_rates } = ctx
    // Какие исправления действуют на этом логе — по данным самого FilterReview
    const fixed = { pre: (up.gyro.pre != null) ? fixed_rate(up.gyro.pre) : null, post: (up.gyro.post != null) ? fixed_rate(up.gyro.post) : null }
    const defect1 = ['pre', 'post'].some((k) => (fixed[k] != null) && (fixed[k].rate !== up.gyro[k].average_sample_rate))
    const defect5 = JSON.stringify(fix.gyro.batches) !== JSON.stringify(up.gyro.batches)
    const defect2 = (up.gyro.type == 'raw') && up.gyro.batches.some((b, i) => (i > 0) && (b != null))
    const active = [defect1 && 1, defect2 && 2, defect5 && 5].filter(Boolean)

    // Средние частоты: мастер — как у FilterReview с исправлениями (его пакеты те же, что у мастера, и при дефекте 5);
    // пересчёт по пакетам FilterReview как есть совпадает с ними, только если набор пакетов не менялся
    const checks = []
    const reasons = []
    for (const k of ['pre', 'post']) {
        if (fix.gyro[k] == null) {
            continue
        }
        const name = WIZARD_TYPES[k == 'pre' ? 0 : 1]
        const reference = fix.gyro[k].average_sample_rate
        const ok = Math.abs(wz_rates[k] - reference) <= 1e-12 * reference
        checks.push({ ok, line: 'средняя частота мастера (' + name + ') ' + wz_rates[k] + (ok ? ' = ' : ' ≠ ') + reference + ' у FilterReview с исправлениями' })
        if (!defect5 && (fixed[k] != null)) {
            const same = Math.abs(fixed[k].rate - reference) <= 1e-12 * reference
            checks.push({ ok: same, line: 'исправленная средняя частота (' + name + ') по пакетам FilterReview ' + fixed[k].rate + (same ? ' = ' : ' ≠ ') + reference + ' у FilterReview с исправлениями' })
        }
        if (defect1 && (fixed[k] != null) && (up.gyro[k] != null)) {
            reasons.push(name + ': ' + up.gyro[k].average_sample_rate + ' → ' + fixed[k].rate + ' Гц (×' + (fixed[k].rate / up.gyro[k].average_sample_rate) + ')')
        }
    }

    const only1 = defect1 && !defect2 && !defect5
    const batch = (up.gyro.type == 'batch')
    const why = {
        scale: 'дефект 1 — бины по средней частоте всех пакетов, ровно ×ρ',
        same: 'не зависит от частоты дискретизации',
        shift: 'дефект 1 — центр окна (окно/2)·период сдвинут на Δ',
        shift_many: 'дефект 1 — окон на пакет больше одного, сдвиг времени у окон разный',
        raw: 'дефект 1 — у raw-пакетов своя частота и много окон: время окон сдвигается неравномерно, окна на границах ' +
             'интервала и разрывы спектрограммы могут смениться',
        grow: 'дефект 1 — сетка бодэ 0…Найквист шагом 0.05 Гц, с тем же началом',
        filters: 'дефект 1 — notch и ФНЧ заданы в герцах, их доля частоты дискретизации другая',
        other: 'дефекты ' + active.join(', ') + ' — проверено точным сравнением с FilterReview с исправлениями',
    }
    // Правило массива: без действующих дефектов всё совпадает; только дефект 1 — по виду массива; иначе — отчёт.
    // Сдвиг и «без изменений» — только у batch-лога (у raw-лога время окон сдвигается неравномерно)
    const rule = (kind, k) => {
        if (active.length == 0) {
            return { rule: { kind: 'same' }, reason: '' }
        }
        if (!only1) {
            return { rule: { kind: 'report' }, reason: why.other }
        }
        if (kind == 'scale') {
            return { rule: { kind: 'scale', k }, reason: why.scale }
        }
        if (kind == 'grow') {
            return { rule: { kind: 'grow', n: k }, reason: why.grow }
        }
        if (kind == 'filters') {
            return { rule: { kind: 'report' }, reason: why.filters }
        }
        if (!batch) {
            return { rule: { kind: 'report' }, reason: why.raw }
        }
        if (kind == 'shift') {
            return (k == null) ? { rule: { kind: 'report' }, reason: why.shift_many } : { rule: { kind: 'shift', d: k }, reason: why.shift }
        }
        return { rule: { kind: 'same' }, reason: why.same }
    }
    const rho = (k) => ((fixed[k] != null) && (up.gyro[k] != null)) ? fixed[k].rate / up.gyro[k].average_sample_rate : 1
    const shift = (fixed.pre != null) && (settings.window_per_batch == 1)
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
            const wz_trace = wz_snap.traces[wizard_trace_name(sensor, t, a)] ?? {}
            items.push({ name: name + ' · x', up: fr_trace.x, wz: wz_trace.x, ...rule('scale', rho(t == 1 ? 'post' : 'pre')) })
            items.push({ name: name + ' · y', up: fr_trace.y, wz: wz_trace.y, ...rule(t == 2 ? 'filters' : 'same') })
        }
    }
    items.push({ name: label + ' · спектрограмма · x (время)', up: up.snap.heat.x, wz: wz_snap.heat.x, abs: time_tolerance, ...rule('shift', shift) })
    items.push({ name: label + ' · спектрограмма · y (частота)', up: up.snap.heat.y, wz: wz_snap.heat.y, ...rule('scale', rho('pre')) })
    items.push({ name: label + ' · спектрограмма · строк', up: [up.snap.heat.rows], wz: [wz_snap.heat.rows], ...rule('same') })
    for (let j = 0; j < up.snap.heat.z.length; j++) {
        items.push({ name: label + ' · спектрограмма · z[' + j + ']', up: up.snap.heat.z[j], wz: wz_snap.heat.z[j], ...rule('same') })
    }
    const step2_label = 'шаг 2 (параметры лога)'
    for (let a = 0; a < 3; a++) {
        const fr_trace = up.snap.traces[2 * 3 + a]
        if ((fr_trace.y == null) || (fr_trace.y.length == 0)) {
            continue
        }
        items.push({ name: step2_label + ' · оценка «после» · ' + AXES[a] + ' · x', up: fr_trace.x, wz: wz_step2.est[a].x, ...rule('scale', rho('pre')) })
        items.push({ name: step2_label + ' · оценка «после» · ' + AXES[a] + ' · y', up: fr_trace.y, wz: wz_step2.est[a].y, ...rule('filters') })
    }
    const bode_grow = ((fixed.pre != null) && (up.gyro.pre != null)) ? bode_points(fixed.pre.max_bin) - bode_points(up.gyro.pre.max_bin) : 0
    const phase_name = (b) => b.wrap ? 'фаза ±180°' : 'фаза развёрнута'
    for (const [b_up, b_wz] of [[up.bode, wz_step2], [up.bode_other, wz_step2_other]]) {
        const name = step2_label + ', ' + phase_name(b_up) + ' · бодэ'
        items.push({ name: name + ' · x (частота)', up: b_up.x, wz: b_wz.x, ...rule('grow', bode_grow) })
        items.push({ name: name + ' · амплитуда', up: b_up.amp, wz: b_wz.amp, ...rule('filters') })
        items.push({ name: name + ' · фаза', up: b_up.phase, wz: b_wz.phase, ...rule('filters') })
    }
    return { active, reasons, checks, items }
}

async function main() {
    const { chromium } = require('playwright')
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

        // 1. FilterReview с исправлениями — эталон точного сравнения; затем FilterReview как есть с тем же интервалом
        const fix = await run_filterreview(browser, server, log_path, problems, true)
        const up = await run_filterreview(browser, server, log_path, problems, false, fix.settings)
        const fr_settings = fix.settings
        const sensor = fix.sensor
        const fr_bode = fix.bode
        const fr_bode_other = fix.bode_other
        // Отличия настроек FilterReview как есть — в отчёт (интервал ему задан тот же, остальное должно совпадать)
        const settings_notes = []
        if (up.own_interval != null) {
            settings_notes.push('свой интервал ' + up.own_interval.start + '–' + up.own_interval.end + ' с заменён интервалом FilterReview с исправлениями ' + fr_settings.start + '–' + fr_settings.end + ' с')
        }
        for (const key of ['window_per_batch', 'window_size', 'batch', 'filter_version']) {
            if (up.settings[key] !== fr_settings[key]) {
                settings_notes.push(key + ': ' + up.settings[key] + ' против ' + fr_settings[key] + ' у FilterReview с исправлениями')
            }
        }

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
            const max_abs = results.reduce((max, r) => Math.max(max, r.max_abs), 0)
            if (failed.length > 0) {
                console.error('tunewizard-compare: ' + label + ' — расхождений с FilterReview с исправлениями ' + failed.length + ' из ' + results.length + ' массивов; первое: ' + failed[0].mismatch)
                for (const r of failed.slice(1, 6)) {
                    console.error('  ' + r.mismatch)
                }
                failed_total += failed.length
            }
            summary.push(label + ': ' + results.length + ' массивов, ' + count + ' значений, наибольшее относительное отклонение ' + max_rel.toExponential(2) +
                ((fr_s == null) ? '' : ', по времени ' + max_abs.toExponential(2) + ' с'))
        }

        // 4. Отчёт о расхождениях с FilterReview как есть («дБ, без алиасинга» и шаг 2) и точная проверка ожидаемых
        if (settings_notes.length > 0) {
            console.log('tunewizard-compare: настройки FilterReview как есть — ' + settings_notes.join('; '))
        }
        if (up.sensor !== sensor) {
            // Без своего экземпляра у FilterReview как есть сравнивать нечего: снимки сняты для другого гироскопа
            console.log('tunewizard-compare: FilterReview как есть показывает гироскоп ' + (up.sensor + 1) + ', с исправлениями — ' + (sensor + 1) + '; отчёт о расхождениях с upstream пропущен')
        } else {
            const plan = upstream_plan({ up, fix, sensor, settings: fr_settings, wz_snap, wz_step2, wz_step2_other, wz_rates })
            const checked = plan.items.map(check_upstream)
            const same = checked.filter((c) => c.ok && c.same)
            const differ = checked.filter((c) => c.ok && !c.same)
            const upstream_failed = [...plan.checks.filter((c) => !c.ok), ...checked.filter((c) => !c.ok)]
            console.log('tunewizard-compare: FilterReview как есть — действующие исправления: ' + (plan.active.length ? plan.active.join(', ') : 'нет') +
                (plan.reasons.length ? ' (средняя частота ' + plan.reasons.join('; ') + ')' : '') + '; исправления в эталоне: ' + fix.patches.join(', '))
            for (const c of plan.checks.filter((c) => c.ok)) {
                console.log('  ' + c.line)
            }
            console.log('  совпадают ' + same.length + ' из ' + checked.length + ' массивов: ' + same.map((c) => c.line.replace(/ — совпадает$/, '')).join('; '))
            for (const c of differ) {
                console.log('  ' + c.line)
            }
            if (upstream_failed.length > 0) {
                console.error('tunewizard-compare: ожидаемые расхождения с FilterReview как есть не подтвердились — ' + upstream_failed.length + ':')
                for (const c of upstream_failed.slice(0, 6)) {
                    console.error('  ' + c.line)
                }
                failed_total += upstream_failed.length
            }
        }

        if (failed_total > 0) {
            process.exitCode = 1
            return
        }
        console.log('tunewizard-compare: совпадение с FilterReview с исправлениями (допуск ' + tolerance + ', по времени ' + time_tolerance + ' с) — ' + summary.join('; ') + '. Интервал ' + fr_settings.start + '–' +
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

if (require.main === module) {
    main().catch((e) => {
        console.error(e)
        process.exit(1)
    })
} else {
    // Для tests/tunewizard-compare-rules.test.cjs: правила сверки без браузера
    module.exports = { upstream_plan, check_upstream, compare_arrays, fixed_rate, bode_points, wizard_trace_name, time_tolerance, tolerance }
}
