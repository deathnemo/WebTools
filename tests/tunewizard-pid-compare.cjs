// Регрессия отклика на ступеньку мастера настройки против PIDReview в настоящем браузере (Playwright + Chrome).
// Запуск: npm run test:tunewizard-pid-compare
// Один лог открывается в мастере (шаг 0) и в PIDReview. Интервал анализа — тот, что мастер берёт по умолчанию
// (окно газа шага 0, state.settings.start/end), окно FFT — 512 (по умолчанию у PIDReview). В PIDReview интервал
// вписывается в поля TimeStart/TimeEnd, «Calculate» пересчитывает FFT, затем для осей PIDR, PIDP, PIDY (радио type_PIDx;
// смена оси перестраивает графики через setup_axis) читается step_plot.data: у набора j трасса j·2 — «все» окна
// (x/y подряд, окна разделены NaN), j·2+1 — среднее. В мастере через page.evaluate: load_pid(state.log, state.env),
// pid_run_batch_fft(axis.sets, 512) и pid_step_response(axis, j, [start, end]) для каждого набора параметров оси.
// Сравниваются поэлементно: число окон, каждое окно, среднее, ось времени (x среднего и x окон против time мастера),
// средняя частота FFT оси; при расхождении — первая позиция и значения, код выхода 1.
//
// Допуск. Отклик безразмерный, порядка 1 (плато 0.6–0.75, PIDReview рисует 0…2), а в начале окна близок к нулю —
// относительное сравнение там бессмысленно. Поэтому, как в tests/tunewizard-compare.cjs, |a − b| ≤ 1e-6·max(1, |a|):
// при |a| < 1 это абсолютный допуск 1e-6 единичной ступеньки (на три порядка ниже того, что различают метрики
// и график), при |a| ≥ 1 — относительный. Ось времени (0…0.5 с) — абсолютный допуск 1e-9 с, как оси времени там же.
// Перенос построчный, порядок операций тот же, браузер тот же — ожидается точное совпадение (отклонение 0).
//
// Дефект upstream 7 (шапка TuneWizard/core/pid.js): redraw_step не очищает трассу среднего, и после «Calculate» набор
// без годных окон показывает прежнее среднее. Поэтому окна PIDReview определяются по трассе «все»: окон нет — мастер
// обязан вернуть null, а среднее PIDReview не сравнивается (если в нём остались данные, это печатается).
//
// Эталон точного сравнения — PIDReview с теми же исправлениями дефектов upstream, что внесены в мастер (задача 4 плана
// docs/plans/2026-10-25-tune-wizard-stage4.md, шапка core/pid.js, раздел 2 дизайна этапа 4): до загрузки лога в исходном
// тексте функций PIDReview заменяются строки дефектов 1 и 2 (split_into_batches), 3 и 5 (redraw_step) и 6 (load) —
// patch_pidreview, по образцу patch_filterreview в tests/tunewizard-compare.cjs; каждая замена обязана сработать заданное
// число раз, иначе upstream изменился и тест надо пересмотреть. Дефект 6 на логах, которые PIDReview открывает без ошибок,
// не срабатывает: без PARM PIDReview как есть падает, и тест останавливается раньше сравнения. Дефект 4 не исправляется
// (раздел 3 дизайна), дефект 7 — только интерфейс.
//
// Кроме того, мастер сравнивается с PIDReview как есть (upstream): печатается, какие массивы совпадают, какие отличаются,
// насколько и почему. Какие исправления действуют на логе, определяется по данным самих PIDReview (наборы параметров,
// пакеты, частота). Дефект 2 действует всегда: каждый пакет теряет последний отсчёт (пакет до конца лога — два), частота
// завышена. Если действует только он, проверяется точно. Доказательство механизма — проверки plan.checks: пакеты
// PIDReview с исправлениями на отсчёт длиннее (на два — пакет до конца лога; последний пакет лога ровно 64 отсчёта
// у PIDReview как есть отсутствует) с тем же началом, а частота пакета PIDReview как есть равна формуле upstream
// count / (time[j − 1] − time[batch_start]), посчитанной по отсчётам пакета с исправлениями. Правила массивов
// к доказательству почти ничего не добавляют: окна и среднее при тех же числе окон, длине отклика и бине шумовой оценки
// совпадают (отсчёты окон те же), а «время ×k, средняя частота ×1/k» почти тавтологично — k берётся из средних частот
// тех же двух PIDReview, а частота мастера равна частоте эталона по точному сравнению; эти правила лишь показывают
// величину отличия. Длина отклика (ceil(0.5·частота)) и бин шумовой оценки (первый выше 25 Гц) могут смениться, если
// частота у порога: при 400 Гц и окне 512 бин 32 — ровно 25 Гц. Тогда, как и при действующих дефектах 1, 3 или 5, —
// только отчёт (точность обеспечивает сравнение с эталоном). Логика правил (upstream_plan, check_upstream) без браузера
// проверяется в tests/tunewizard-pid-compare-rules.test.cjs.
// Нужны те же лог, браузер и python, что для tests/tunewizard-compare.cjs: CHROME_PATH — путь к chrome.exe (без него
// Playwright берёт свой Chromium, если он установлен); без лога тест пропускается.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { spawn } = require('node:child_process')
// Допуски и отклонение по общему началу — общие со сравнением с FilterReview
const { tolerance, time_tolerance, deviation } = require('./tunewizard-compare.cjs')

const repo = path.resolve(__dirname, '..')
const logs_dir = path.join(repo, 'TuneWizard', 'logs')
const port = 8793
// Окно FFT: по умолчанию у PIDReview (поле FFTWindow_size)
const WINDOW_SIZE = 512
// Оси PID: id сообщения = суффикс радио type_<id> PIDReview = id[0] оси load_pid
const AXES = ['PIDR', 'PIDP', 'PIDY']
// Шаг окон отклика — 1/16 окна (redraw_step)
const STEP_SPACING_DIVISOR = 16
// Ниже этой частоты отклик не считается (дефект 5) — тот же порог, что у мастера: PID_STEP_MIN_RATE с запасом
// PID_STEP_RATE_MARGIN из core/pid.js (константы читаются из файла, а не повторяются здесь)
const MIN_RATE = (() => {
    const context = vm.createContext({})
    vm.runInContext(fs.readFileSync(path.join(repo, 'TuneWizard', 'core', 'pid.js'), 'utf8'), context)
    return vm.runInContext('PID_STEP_MIN_RATE * PID_STEP_RATE_MARGIN', context)
})()
// Последний пакет лога ровно такой длины upstream отбрасывал (count = длина − 1 < 64), а мастер оставляет — следствие
// дефекта 2 (порог «не меньше 64 отсчётов», split_into_batches 1410)
const MIN_BATCH = 64

function find_log() {
    if (process.env.TUNEWIZARD_LOG) {
        return process.env.TUNEWIZARD_LOG
    }
    if (!fs.existsSync(logs_dir)) {
        return null
    }
    // В TuneWizard/logs/ рядом с тестовым логом лежит второй (другой аппарат), по алфавиту он первый — тестовый предпочтительнее
    const names = fs.readdirSync(logs_dir).filter((name) => name.toLowerCase().endsWith('.bin'))
    const bin = names.includes('2026-06-18 18-54-42_anon.bin') ? '2026-06-18 18-54-42_anon.bin' : names[0]
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

// Исправления дефектов upstream в PIDReview — до загрузки лога. Возвращает список применённых замен.
// Устройство — как patch_filterreview в tests/tunewizard-compare.cjs: каждая замена обязана найтись заданное число раз,
// иначе upstream изменился и тест надо пересмотреть
function patch_pidreview(page) {
    return page.evaluate((min_rate) => {
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

        // Дефект 3: сквозное время окон всех пакетов набора — вставка в цикл по наборам redraw_step, как в core/pid.js
        const window_time_block = [
            '',
            '        var window_time = []',
            '        var batch_offset = new Array(num_batch)',
            '        for (let i=0;i<num_batch;i++) {',
            '            batch_offset[i] = window_time.length',
            '            const num_points = PID.sets[j][i].Tar.length',
            '            if (num_points < window_size) {',
            '                continue',
            '            }',
            '            const num_windows = Math.floor((num_points-window_size)/window_spacing) + 1',
            '            for (let k=0;k<num_windows;k++) {',
            '                window_time.push((k * window_spacing + window_size * 0.5) * sample_time + PID.sets[j][i].time[0])',
            '            }',
            '        }',
        ].join('\n')

        // [имя функции, номер дефекта, edits] — те же исправления, что в core/pid.js (места помечены там
        // «исправление дефекта upstream N»)
        const fixes = [
            // Дефект 1 (PIDReview 1401–1403, 1427): отсчёты до начала набора в пакет не входят
            ['split_into_batches', 1, [
                [/(if \(time\[j\] < set_start\) \{\s*continue\s*\})/, '$1\n        if (time[batch_start] < set_start) {\n            batch_start = j\n            continue\n        }', 1],
            ]],
            // Дефект 2 (PIDReview 1412, 1417): batch_end — конец среза не включая (в конце лога — и последний отсчёт),
            // частота — по числу интервалов
            ['split_into_batches', 2, [
                [/if \(\(\(time\[j\] - time\[j-1\]\)\*count\) > \(\(time\[j\] - time\[batch_start\]\) \* 5\) \|\| \(j == \(len - 1\)\) \|\| past_set_end\) \{/,
                 'const gap = ((time[j] - time[j-1])*count) > ((time[j] - time[batch_start]) * 5)\n        if (gap || (j == (len - 1)) || past_set_end) {\n' +
                 '            const batch_end = ((j == (len - 1)) && !gap && !past_set_end) ? len : j', 1],
                [/if \(count >= 64\)/, 'if ((batch_end - batch_start) >= 64)', 1],
                [/1 \/ \(\(time\[j-1\] - time\[batch_start\]\) \/ count\)/, '1 / ((time[batch_end-1] - time[batch_start]) / (batch_end - batch_start - 1))', 1],
                [/batch_end: j-1\}/, 'batch_end: batch_end}', 1],
            ]],
            // Дефект 3 (PIDReview 1129–1130): индексы окон — по сквозному времени окон набора
            ['redraw_step', 3, [
                [/(const plot_index = j\*2)/, '$1' + window_time_block, 1],
                [/find_start_index\(fft_time\)/, 'Math.max(find_start_index(window_time) - batch_offset[i], 0)', 1],
                [/find_end_index\(fft_time\)\+1/, 'Math.min(find_end_index(window_time)+1 - batch_offset[i], FFT_res.center.length)', 1],
            ]],
            // Дефект 5 (PIDReview 1082–1100): при частоте ниже порога мастера (min_rate — MIN_RATE) отклик не считается
            ['redraw_step', 5, [
                [/(if \(valid_sets == 0\) \{\s*Plotly\.redraw\("step_plot"\)\s*return\s*\})/,
                 '$1\n    if (PID.sets.FFT.average_sample_rate < ' + min_rate + ') {\n        Plotly.redraw("step_plot")\n        return\n    }', 1],
            ]],
            // Дефект 6 (PIDReview 1511, 1525): без PARM — сообщение вместо TypeError
            ['load', 6, [
                [/(const PARM = log\.get\('PARM'\))/, '$1\n    if (PARM == null) {\n        alert("No PARM messages in log")\n        return\n    }', 1],
            ]],
        ]
        for (const [name, defect, edits] of fixes) {
            patch(name, defect, edits)
        }
        return applied
    }, MIN_RATE)
}

// Сведения PIDReview об осях AXES для отчёта о расхождениях с PIDReview как есть: наборы параметров (границы),
// пакеты по наборам (длина, частота, время первого, предпоследнего и последнего отсчёта), конец данных оси, средняя
// частота и окно FFT, бин шумовой оценки отклика (первый выше 25 Гц, redraw_step). Строкой JSON, как wizard_step
function pidreview_info(page) {
    return page.evaluate((axes) => {
        const out = {}
        for (const id of axes) {
            const PID = PID_log_messages.find((p) => (p.id.length == 1) && (p.id[0] === id))
            if ((PID == null) || !PID.have_data) {
                out[id] = { have_data: false }
                continue
            }
            const batch = (b) => ({ length: b.time.length, rate: b.sample_rate, t0: b.time[0], t_prev: b.time[b.time.length - 2], t1: b.time[b.time.length - 1] })
            out[id] = {
                have_data: true,
                end_time: PID.end_time,
                sets: PID.params.sets.map((s) => ({ start: s.start_time, end: s.end_time })),
                batches: Array.from(PID.sets, (set) => (set == null) ? null : set.map(batch)),
                rate: PID.sets.FFT?.average_sample_rate ?? null,
                window_size: PID.sets.FFT?.window_size ?? null,
                lpf_index: PID.sets.FFT?.bins.findIndex((x) => x > 25) ?? null,
            }
        }
        return JSON.stringify(out, (key, v) => ((typeof v === 'number') && !Number.isFinite(v)) ? String(v) : v)
    }, AXES)
}

// Мастер: интервал по умолчанию и отклик на ступеньку осей AXES по всем наборам параметров. Результат — строкой JSON
// (сотни тысяч чисел уходят из браузера одной строкой, а не структурой поэлементно); нечисловые значения — строками,
// чтобы сравниваться как есть
function wizard_step(page, window_size) {
    return page.evaluate(({ axes, window_size }) => {
        const start = state.settings.start
        const end = state.settings.end
        const pid = load_pid(state.log, state.env)
        const out = { start, end, warnings: pid.warnings, axes: {} }
        for (const id of axes) {
            const axis = pid.axes.find((a) => (a.id.length == 1) && (a.id[0] === id))
            if ((axis == null) || !axis.have_data) {
                out.axes[id] = { have_data: false }
                continue
            }
            pid_run_batch_fft(axis.sets, window_size)
            const sets = []
            for (let j = 0; j < axis.params.sets.length; j++) {
                sets.push(pid_step_response(axis, j, [start, end]))
            }
            out.axes[id] = {
                have_data: true,
                rate: axis.sets.FFT?.average_sample_rate ?? null,
                window_size: axis.sets.FFT?.window_size ?? null,
                sets,
            }
        }
        return JSON.stringify(out, (key, v) => ((typeof v === 'number') && !Number.isFinite(v)) ? String(v) : v)
    }, { axes: AXES, window_size })
}

// Снимок отклика выбранной оси PIDReview: для каждого набора — окна из трассы «все» (разбиты по NaN в x: время конечно,
// а NaN в отклике возможен), различные x окон (ожидается одна ось времени), среднее. Строкой JSON, как wizard_step
function snapshot_pidreview(page) {
    return page.evaluate(() => {
        const PID = PID_log_messages[get_axis_index()]
        const sets = []
        for (let j = 0; 2 * j < step_plot.data.length; j++) {
            const all = step_plot.data[2 * j]
            const mean = step_plot.data[2 * j + 1]
            const x = all.x ?? []
            const y = all.y ?? []
            const windows = []
            const windows_x = new Map()
            let separators_ok = (x.length == y.length)
            let begin = 0
            for (let i = 0; i < x.length; i++) {
                if (!Number.isNaN(x[i])) {
                    continue
                }
                // Разделитель: NaN и в x, и в y
                separators_ok &&= Number.isNaN(y[i])
                windows.push(y.slice(begin, i))
                const wx = x.slice(begin, i)
                windows_x.set(JSON.stringify(wx), wx)
                begin = i + 1
            }
            // После последнего окна тоже NaN: хвоста без разделителя быть не должно
            separators_ok &&= (begin == x.length)
            sets.push({ windows, windows_x: [...windows_x.values()], separators_ok, mean_x: mean.x ?? null, mean_y: mean.y ?? null })
        }
        const out = {
            id: PID.id.join('_'),
            rate: PID.sets.FFT?.average_sample_rate ?? null,
            window_size: PID.sets.FFT?.window_size ?? null,
            sets,
        }
        return JSON.stringify(out, (key, v) => ((typeof v === 'number') && !Number.isFinite(v)) ? String(v) : v)
    })
}

// Отклонение пары чисел: абсолютное, если задан abs (с), иначе относительное |a−b|/max(1,|a|)
function difference(a, b, abs) {
    return (abs != null) ? Math.abs(a - b) : Math.abs(a - b) / Math.max(1, Math.abs(a))
}

// Сравнение массива PIDReview a и массива мастера b — как compare_arrays в tests/tunewizard-compare.cjs (там подписи
// FilterReview); abs — абсолютный допуск (оси времени), иначе относительный tolerance.
// Возвращает { ok, count, max_rel, max_abs, mismatch }: отклонение в max_abs, если задан abs, иначе в max_rel
function compare_arrays(label, a, b, abs = null) {
    if ((a == null) || (b == null)) {
        return { ok: false, count: 0, max_rel: 0, max_abs: 0, mismatch: label + ': нет данных (PIDReview ' + (a == null ? 'null' : a.length) + ', мастер ' + (b == null ? 'null' : b.length) + ')' }
    }
    if (a.length !== b.length) {
        return { ok: false, count: 0, max_rel: 0, max_abs: 0, mismatch: label + ': длина PIDReview ' + a.length + ', мастер ' + b.length }
    }
    const limit = abs ?? tolerance
    let max = 0
    const result = (ok, count, mismatch) => ({ ok, count, max_rel: (abs == null) ? max : 0, max_abs: (abs == null) ? 0 : max, mismatch })
    for (let i = 0; i < a.length; i++) {
        if ((typeof a[i] === 'string') || (typeof b[i] === 'string')) {
            if (a[i] !== b[i]) {
                return result(false, i, label + '[' + i + ']: PIDReview ' + a[i] + ', мастер ' + b[i])
            }
            continue
        }
        const d = difference(a[i], b[i], abs)
        max = Math.max(max, d)
        if (d > limit) {
            return result(false, i, label + '[' + i + ']: PIDReview ' + a[i] + ', мастер ' + b[i] + ((abs == null) ? ', |a−b|/max(1,|a|) = ' : ', |a−b| = ') + d.toExponential(3) + ((abs == null) ? '' : ' с'))
        }
    }
    return result(true, a.length, null)
}

// Несовпадение без поэлементного сравнения (число окон, наличие данных)
function failure(mismatch) {
    return { ok: false, count: 0, max_rel: 0, max_abs: 0, mismatch }
}

// Поэлементное сравнение оси id: снимок PIDReview pr и результат мастера wz (элемент wizard_step().axes).
// notes — сюда пишутся наблюдения без ошибки (устаревшее среднее PIDReview, дефект 7). → { results, windows }
function compare_axis(id, pr, wz, notes) {
    const results = []
    if ((wz.rate !== pr.rate) || (wz.window_size !== pr.window_size)) {
        results.push(failure(id + ': FFT PIDReview — частота ' + pr.rate + ' Гц, окно ' + pr.window_size + '; мастер — ' + wz.rate + ' Гц, окно ' + wz.window_size))
    }
    if (wz.sets.length !== pr.sets.length) {
        results.push(failure(id + ': наборов параметров PIDReview ' + pr.sets.length + ', мастер ' + wz.sets.length))
    }
    const windows = []
    for (let j = 0; j < Math.min(pr.sets.length, wz.sets.length); j++) {
        const label = id + ' · набор ' + (j + 1)
        const p = pr.sets[j]
        const w = wz.sets[j]
        windows.push(p.windows.length)
        if (!p.separators_ok) {
            results.push(failure(label + ': трасса «все» PIDReview — окна разделены не парой NaN в x и y'))
        }
        if (p.windows.length == 0) {
            // Окон нет: мастер возвращает null; среднее PIDReview могло остаться от прежнего расчёта (дефект 7)
            if (w != null) {
                results.push(failure(label + ': у PIDReview окон нет, у мастера ' + w.windows.length))
            }
            if ((p.mean_y != null) && (p.mean_y.length > 0)) {
                notes.push(label + ': окон нет, PIDReview показывает прежнее среднее (дефект upstream 7) — не сравнивается')
            }
            continue
        }
        if (w == null) {
            results.push(failure(label + ': у PIDReview окон ' + p.windows.length + ', мастер вернул null'))
            continue
        }
        if (w.windows.length !== p.windows.length) {
            results.push(failure(label + ': окон PIDReview ' + p.windows.length + ', мастер ' + w.windows.length))
            continue
        }
        results.push(compare_arrays(label + ' · время (x среднего)', p.mean_x, w.time, time_tolerance))
        p.windows_x.forEach((x, k) => results.push(compare_arrays(label + ' · время окон (вариант ' + (k + 1) + ' из ' + p.windows_x.length + ')', x, w.time, time_tolerance)))
        results.push(compare_arrays(label + ' · среднее', p.mean_y, w.mean))
        p.windows.forEach((y, k) => results.push(compare_arrays(label + ' · окно ' + (k + 1), y, w.windows[k])))
    }
    return { results, windows }
}

// PIDReview: открыть, при patched — применить исправления, загрузить лог, задать окно WINDOW_SIZE и интервал
// interval = { start, end } (строки полей), «Calculate», снять отклик осей AXES и сведения о пакетах; страница
// закрывается, чтобы разобранные логи не копились в памяти. → { patches, own_interval, reference, info }
async function run_pidreview(browser, server, log_path, problems, patched, interval) {
    const name = patched ? 'PIDReview с исправлениями' : 'PIDReview'
    const pr = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
    pr.on('pageerror', (e) => problems.push(name + ' pageerror: ' + e.message))
    pr.on('dialog', (d) => { problems.push(name + ' alert: ' + d.message()); d.dismiss() })
    await wait_for_server(pr, 'http://127.0.0.1:' + port + '/PIDReview/', server)
    const patches = patched ? await patch_pidreview(pr) : []
    await pr.setInputFiles('#fileItem', log_path)
    // readFile ставит заголовок после окончания load
    await pr.waitForFunction(() => document.title.startsWith('PID Review: '), null, { timeout: 180000 })
    await wait_overlay(pr)
    const own_interval = [await pr.inputValue('#TimeStart'), await pr.inputValue('#TimeEnd')]
    // Окно — по умолчанию 512; другое значение задаётся напрямую (onchange поля шагает к соседней степени двойки)
    await pr.evaluate((size) => {
        const input = document.getElementById('FFTWindow_size')
        if (input.value !== size) {
            input.value = size
            clear_calculation()
        }
    }, String(WINDOW_SIZE))
    // Интервал: find_start_index/find_end_index читают поля при расчёте; change включает кнопку «Calculate»
    await pr.fill('#TimeStart', interval.start)
    await pr.fill('#TimeEnd', interval.end)
    await pr.dispatchEvent('#TimeStart', 'change')
    await pr.dispatchEvent('#TimeEnd', 'change')
    assert.deepEqual([await pr.inputValue('#TimeStart'), await pr.inputValue('#TimeEnd')], [interval.start, interval.end], 'интервал ' + name + ' равен интервалу мастера')
    await pr.click('#calculate')
    await wait_overlay(pr)
    // calculate() выключает кнопку: расчёт выполнен
    assert.equal(await pr.isDisabled('#calculate'), true, name + ': «Calculate» выполнен')
    assert.equal(await pr.inputValue('#FFTWindow_size'), String(WINDOW_SIZE), 'окно FFT ' + name)

    // Оси: выбрать радио (смена оси — setup_axis с перерисовкой) и снять отклик
    const reference = {}
    for (const id of AXES) {
        if (await pr.isDisabled('#type_' + id)) {
            reference[id] = null
            continue
        }
        if (!(await pr.isChecked('#type_' + id))) {
            await pr.check('#type_' + id)
            await wait_overlay(pr)
        }
        reference[id] = JSON.parse(await snapshot_pidreview(pr))
        assert.equal(reference[id].id, id, name + ' показывает ось ' + id)
    }
    const info = JSON.parse(await pidreview_info(pr))
    await pr.close()
    return { patches, own_interval, reference, info }
}

// Пакеты набора, у которых все окна отклика (шаг окно/16, центр — середина окна) вне интервала [t0, t1]: у них
// PIDReview как есть брал одно окно (дефект 3). info — элемент pidreview_info. → [{ set, batch }]
function outside_batches(info, interval) {
    const out = []
    const W = info.window_size
    const spacing = Math.round(W / STEP_SPACING_DIVISOR)
    info.batches.forEach((set, j) => {
        (set ?? []).forEach((b, i) => {
            if (b.length < W) {
                return
            }
            const num = Math.floor((b.length - W) / spacing) + 1
            const first = b.t0 + (W / 2) / info.rate
            const last = b.t0 + ((num - 1) * spacing + W / 2) / info.rate
            if ((last < interval[0]) || (first > interval[1])) {
                out.push({ set: j, batch: i })
            }
        })
    })
    return out
}

// Частота пакета PIDReview как есть по отсчётам пакета с исправлениями (fb): count / (time[j − 1] − time[batch_start]),
// где j — отсчёт, на котором upstream резал пакет. Пакет на отсчёт длиннее — j − 1 = последний отсчёт fb, count = длина fb;
// на два (пакет до конца лога) — j = последний отсчёт лога, j − 1 = предпоследний fb, count = длина fb − 1
function upstream_batch_rate(fb, grow) {
    return (grow == 1) ? 1 / ((fb.t1 - fb.t0) / fb.length) : 1 / ((fb.t_prev - fb.t0) / (fb.length - 1))
}

// План сверки с PIDReview как есть — без браузера (его проверяет tests/tunewizard-pid-compare-rules.test.cjs).
// ctx = { up, fix, wizard, interval: [t0, t1] }: up / fix — результаты run_pidreview для PIDReview как есть и с исправлениями
// (нужны reference и info), wizard — результат wizard_step.
// Возвращает { active, inactive, checks, items }: действующие исправления [{ defect, axes }], недействующие [{ defect, why }],
// проверки механизма дефекта 2 ({ ok, line }) и массивы с правилами для check_upstream
function upstream_plan(ctx) {
    const { up, fix, wizard, interval } = ctx
    const axes = AXES.filter((id) => (up.info[id]?.have_data === true) && (fix.info[id]?.have_data === true) && wizard.axes[id].have_data)

    // Какие исправления действуют — по данным самих PIDReview
    const found = {
        // пакет набора начинается раньше набора: отсчёты разрыва между наборами
        1: axes.filter((id) => up.info[id].batches.some((set, j) => (set ?? []).some((b) => b.t0 < up.info[id].sets[j].start))),
        // каждый пакет теряет последний отсчёт
        2: axes,
        3: axes.filter((id) => outside_batches(up.info[id], interval).length > 0),
        5: axes.filter((id) => (up.info[id].rate != null) && (up.info[id].rate < MIN_RATE)),
    }
    const active = Object.entries(found).filter(([, list]) => list.length > 0).map(([defect, list]) => ({ defect: Number(defect), axes: list }))
    const why_not = {
        1: axes.every((id) => up.info[id].sets.length == 1) ? 'один набор параметров' : 'пакеты наборов начинаются в своих границах',
        3: 'пакетов целиком вне интервала нет',
        5: 'частота PID не ниже ' + MIN_RATE + ' Гц',
    }
    const inactive = [...Object.entries(why_not).filter(([defect]) => found[defect].length == 0).map(([defect, why]) => ({ defect: Number(defect), why })),
                      { defect: 6, why: 'PARM в логе есть (без него PIDReview как есть падает раньше сравнения)' }]
    const only2 = (active.length == 1) && (active[0].defect == 2)

    // Механизм дефекта 2 — при нём одном: пакеты те же с тем же началом, на отсчёт длиннее (до конца лога — на два),
    // частота пакета как есть — по формуле upstream из отсчётов пакета с исправлениями. Заодно — что ещё сменилось у оси
    const checks = []
    const changed = {}
    for (const id of axes) {
        const u = up.info[id]
        const f = fix.info[id]
        changed[id] = []
        if (!only2) {
            continue
        }
        const lengths = []
        const rates = []
        // Последний пакет лога ровно MIN_BATCH отсчётов: upstream его отбрасывал (count = длина − 1), мастер оставляет —
        // тоже дефект 2. Такой «лишний» пакет (последний у последнего набора, до конца лога) из сверки пар убирается
        const fix_sets = f.batches.map((set) => (set == null) ? null : set.slice())
        const last = fix_sets.length - 1
        let extra = null
        if ((last >= 0) && (fix_sets[last] != null) && (fix_sets[last].length > 0)) {
            const tail = fix_sets[last]
            const fb = tail[tail.length - 1]
            if ((fb.length == MIN_BATCH) && (fb.t1 === f.end_time) && (tail.length == (u.batches[last]?.length ?? 0) + 1)) {
                extra = tail.pop()
            }
        }
        const sets_count = Math.max(u.batches.length, fix_sets.length)
        let ok = true
        for (let j = 0; j < sets_count; j++) {
            const set = u.batches[j] ?? []
            const fset = fix_sets[j] ?? []
            if (set.length != fset.length) {
                ok = false
                continue
            }
            set.forEach((ub, i) => {
                const fb = fset[i]
                const grow = fb.length - ub.length
                const expected = (fb.t1 === f.end_time) ? 2 : 1
                const rate = upstream_batch_rate(fb, grow)
                ok &&= (grow == expected) && (fb.t0 === ub.t0) && (Math.abs(rate - ub.rate) <= 1e-12 * ub.rate)
                lengths.push(ub.length + ' → ' + fb.length + ' отсчётов' + ((expected == 2) ? ' (+2, до конца лога)' : ''))
                rates.push(ub.rate.toFixed(7) + ' → ' + fb.rate.toFixed(7) + ' Гц')
            })
        }
        if (extra != null) {
            lengths.push('плюс пакет ' + MIN_BATCH + ' отсчётов в конце лога (upstream отбрасывал: count = ' + (MIN_BATCH - 1) + ')')
        }
        checks.push({ ok, line: id + ': пакеты ' + lengths.join(', ') + ', частота пакета ' + rates.join(', ') +
            (ok ? ' — частота PIDReview как есть равна формуле upstream по отсчётам пакета с исправлениями (дефект 2)' : ' — не объясняется дефектом 2') })
        if (!ok) {
            changed[id].push('пакеты')
        }
        if (u.lpf_index !== f.lpf_index) {
            changed[id].push('бин шумовой оценки (' + u.lpf_index + ' → ' + f.lpf_index + ')')
        }
        const pr_up = up.reference[id]
        const pr_fix = fix.reference[id]
        for (let j = 0; j < Math.min(pr_up.sets.length, pr_fix.sets.length); j++) {
            if (pr_up.sets[j].windows.length !== pr_fix.sets[j].windows.length) {
                changed[id].push('число окон набора ' + (j + 1) + ' (' + pr_up.sets[j].windows.length + ' → ' + pr_fix.sets[j].windows.length + ')')
            }
            const len_up = pr_up.sets[j].mean_x?.length ?? 0
            const len_fix = pr_fix.sets[j].mean_x?.length ?? 0
            if ((pr_up.sets[j].windows.length > 0) && (pr_fix.sets[j].windows.length > 0) && (len_up !== len_fix)) {
                changed[id].push('длину отклика набора ' + (j + 1) + ' (' + len_up + ' → ' + len_fix + ')')
            }
        }
    }

    // Правило массива: дефект 2 один и у оси ничего, кроме частоты, не сменилось — окна и среднее совпадают, время ×k,
    // средняя частота ×1/k; иначе — отчёт. «×k» и «×1/k» почти тавтологичны (k — из частот тех же PIDReview, частота
    // мастера = частоте эталона) и показывают величину отличия; механизм дефекта 2 доказывают checks выше
    const why = {
        rate: 'дефект 2 — частота пакета по числу интервалов',
        time: 'дефект 2 — шаг времени отклика 1/частота',
        other: 'дефекты ' + active.map((a) => a.defect).join(', ') + ' — проверено точным сравнением с PIDReview с исправлениями',
    }
    // what — rate или time (причина правила scale), k — его множитель
    const rule = (id, what = null, k = null) => {
        if (!only2) {
            return { rule: { kind: 'report' }, reason: why.other }
        }
        if (changed[id].length > 0) {
            return { rule: { kind: 'report' }, reason: 'дефект 2 сменил ' + changed[id].join(', ') + ' — проверено точным сравнением с PIDReview с исправлениями' }
        }
        return (what == null) ? { rule: { kind: 'same' }, reason: '' } : { rule: { kind: 'scale', k }, reason: why[what] }
    }

    const items = []
    for (const id of axes) {
        const u = up.info[id]
        const f = fix.info[id]
        const w = wizard.axes[id]
        items.push({ name: id + ' · средняя частота FFT', up: [u.rate], wz: [w.rate], ...rule(id, 'rate', f.rate / u.rate) })
        const pr_up = up.reference[id]
        for (let j = 0; j < Math.min(pr_up.sets.length, w.sets.length); j++) {
            const p = pr_up.sets[j]
            const s = w.sets[j]
            const label = id + ' · набор ' + (j + 1)
            items.push({ name: label + ' · окон', up: [p.windows.length], wz: [(s == null) ? 0 : s.windows.length], ...rule(id) })
            if ((p.windows.length == 0) || (s == null)) {
                continue
            }
            items.push({ name: label + ' · время', up: p.mean_x, wz: s.time, abs: time_tolerance, ...rule(id, 'time', u.rate / f.rate) })
            items.push({ name: label + ' · среднее', up: p.mean_y, wz: s.mean, ...rule(id) })
            items.push({ name: label + ' · окна (' + p.windows.length + ')', up: p.windows.flat(), wz: s.windows.flat(), ...rule(id) })
        }
    }
    return { active, inactive, checks, items }
}

// Проверка массива мастера против PIDReview как есть по правилу item.rule:
//   same — совпадает; scale — PIDReview × k (отличие сверх допуска печатается, без него — «совпадает в пределах допуска»);
//   report — только отчёт. item.abs — абсолютный допуск (ось времени). Возвращает { ok, same, line } — строку для вывода
function check_upstream(item) {
    const { name, up, wz, rule, reason, abs = null } = item
    if ((up == null) || (wz == null)) {
        return { ok: false, same: false, line: name + ': нет данных (PIDReview ' + (up == null ? 'null' : up.length) + ', мастер ' + (wz == null ? 'null' : wz.length) + ')' }
    }
    if (rule.kind == 'same') {
        const r = compare_arrays(name, up, wz, abs)
        return { ok: r.ok, same: r.ok, line: r.ok ? name : r.mismatch }
    }
    const dev = deviation(up, wz, abs)
    if (rule.kind == 'scale') {
        const r = compare_arrays(name + ' (PIDReview × ' + rule.k + ')', up.map((v) => (typeof v === 'number') ? v * rule.k : v), wz, abs)
        if (!r.ok) {
            return { ok: false, same: false, line: r.mismatch }
        }
        if ((dev.differ == 0) && (up.length == wz.length)) {
            return { ok: true, same: true, line: name + ' — совпадает в пределах допуска (×' + rule.k + ')' }
        }
        return { ok: true, same: false, line: name + ' — отличается (до ' + dev.text + ', ×' + rule.k + '): ' + reason }
    }
    if ((dev.differ == 0) && (up.length == wz.length)) {
        return { ok: true, same: true, line: name + ' — совпадает' }
    }
    const length = (up.length == wz.length) ? '' : 'длина ' + up.length + ' → ' + wz.length + ', '
    return { ok: true, same: false, line: name + ' — отличается (' + length + 'позиций ' + dev.differ + ' из ' + dev.len + ', до ' + dev.text + '): ' + reason }
}

async function main() {
    const { chromium } = require('playwright')
    const log_path = find_log()
    if (log_path == null) {
        console.log('tunewizard-pid-compare: лог не найден (TUNEWIZARD_LOG или TuneWizard/logs/*.bin) — пропуск')
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

        // 1. Мастер: лог шагом 0, интервал по умолчанию, отклик на ступеньку по осям
        const wz = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
        wz.on('console', (m) => { if (m.type() === 'error') problems.push('мастер console: ' + m.text()) })
        wz.on('pageerror', (e) => problems.push('мастер pageerror: ' + e.message))
        wz.on('dialog', (d) => { problems.push('мастер alert: ' + d.message()); d.dismiss() })
        await wait_for_server(wz, 'http://127.0.0.1:' + port + '/TuneWizard/', server)
        await wz.setInputFiles('#fileItem', log_path)
        await wz.locator('#log_verdict').waitFor({ state: 'visible', timeout: 180000 })
        await wait_overlay(wz)
        const wizard = JSON.parse(await wizard_step(wz, WINDOW_SIZE))
        // Лог мастера больше не нужен: страницу закрыть, чтобы два разобранных лога не держать в памяти
        await wz.close()
        assert.ok(wizard.end > wizard.start, 'интервал мастера по умолчанию: ' + wizard.start + '–' + wizard.end + ' с')
        const interval = { start: String(wizard.start), end: String(wizard.end) }

        // 2. PIDReview с исправлениями — эталон точного сравнения; затем PIDReview как есть. Интервал мастера, окно 512
        const fix = await run_pidreview(browser, server, log_path, problems, true, interval)
        const up = await run_pidreview(browser, server, log_path, problems, false, interval)
        const reference = fix.reference

        // 3. Поэлементное сравнение с PIDReview с исправлениями
        assert.deepEqual(problems, [], 'ошибки страниц')
        const notes = []
        const summary = []
        const all_results = []
        for (const id of AXES) {
            const p = reference[id]
            const w = wizard.axes[id]
            if ((p == null) || !w.have_data) {
                // Ось без данных у обоих — сравнивать нечего; у одного из двух — расхождение
                if ((p == null) !== !w.have_data) {
                    all_results.push(failure(id + ': данные есть ' + (p == null ? 'только у мастера' : 'только у PIDReview')))
                }
                summary.push(id + ' — нет данных')
                continue
            }
            const { results, windows } = compare_axis(id, p, w, notes)
            all_results.push(...results)
            summary.push(id + ' ' + windows.join('/'))
        }
        for (const note of notes) {
            console.log('tunewizard-pid-compare: ' + note)
        }
        if (wizard.warnings.length > 0) {
            console.log('tunewizard-pid-compare: предупреждения load_pid — ' + wizard.warnings.join('; '))
        }
        // Сравнение без единого числа ничего не доказывает
        assert.ok(all_results.some((r) => r.count > 0), 'нет ни одного сравненного значения')

        const failed = all_results.filter((r) => !r.ok)
        const count = all_results.reduce((sum, r) => sum + r.count, 0)
        const max_rel = all_results.reduce((max, r) => Math.max(max, r.max_rel), 0)
        const max_abs = all_results.reduce((max, r) => Math.max(max, r.max_abs), 0)
        let failed_total = 0
        if (failed.length > 0) {
            console.error('tunewizard-pid-compare: расхождений с PIDReview с исправлениями ' + failed.length + ' из ' + all_results.length + ' массивов; первое: ' + failed[0].mismatch)
            for (const r of failed.slice(1, 6)) {
                console.error('  ' + r.mismatch)
            }
            failed_total += failed.length
        }

        // 4. Отчёт о расхождениях с PIDReview как есть и точная проверка ожидаемых
        const plan = upstream_plan({ up, fix, wizard, interval: [wizard.start, wizard.end] })
        const checked = plan.items.map(check_upstream)
        const same = checked.filter((c) => c.ok && c.same)
        const differ = checked.filter((c) => c.ok && !c.same)
        const upstream_failed = [...plan.checks.filter((c) => !c.ok), ...checked.filter((c) => !c.ok)]
        const rate_change = (id) => id + ' ' + up.info[id].rate.toFixed(7) + ' → ' + fix.info[id].rate.toFixed(7) + ' Гц'
        const active = plan.active.map((a) => a.defect + ' (' + ((a.defect == 2) ? 'средняя частота ' + a.axes.map(rate_change).join(', ') : a.axes.join(', ')) + ')')
        console.log('tunewizard-pid-compare: PIDReview как есть — действующие исправления: ' + (active.length ? active.join('; ') : 'нет') +
            '; не действуют: ' + plan.inactive.map((d) => d.defect + ' — ' + d.why).join(', ') + '; исправления в эталоне: ' + fix.patches.join(', '))
        for (const c of plan.checks.filter((c) => c.ok)) {
            console.log('  ' + c.line)
        }
        console.log('  совпадают ' + same.length + ' из ' + checked.length + ' массивов: ' + same.map((c) => c.line.replace(/ — совпадает$/, '')).join('; '))
        for (const c of differ) {
            console.log('  ' + c.line)
        }
        if (upstream_failed.length > 0) {
            console.error('tunewizard-pid-compare: ожидаемые расхождения с PIDReview как есть не подтвердились — ' + upstream_failed.length + ':')
            for (const c of upstream_failed.slice(0, 6)) {
                console.error('  ' + c.line)
            }
            failed_total += upstream_failed.length
        }

        if (failed_total > 0) {
            process.exitCode = 1
            return
        }
        const rates = AXES.filter((id) => wizard.axes[id].have_data).map((id) => id + ' ' + wizard.axes[id].rate.toFixed(4))
        console.log('tunewizard-pid-compare: совпадение с PIDReview с исправлениями (допуск ' + tolerance + ', по времени ' + time_tolerance + ' с) — оси ' + AXES.join('/') +
            ': окон ' + summary.join(', ') + '; массивов ' + all_results.length + ', значений ' + count + ', наибольшее отклонение ' + max_rel.toExponential(2) +
            ', по времени ' + max_abs.toExponential(2) + ' с. Интервал ' + interval.start + '–' + interval.end + ' с (у PIDReview по умолчанию ' + fix.own_interval.join('–') +
            ' с), окно ' + WINDOW_SIZE + ', средняя частота FFT ' + rates.join(', ') + ' Гц, исправления в эталоне: ' + (fix.patches.length ? fix.patches.join(', ') : 'нет'))
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
    // Для tests/tunewizard-pid-compare-rules.test.cjs: правила сверки без браузера
    module.exports = { upstream_plan, check_upstream, upstream_batch_rate, outside_batches, AXES, time_tolerance, tolerance }
}
