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
// Эталон — PIDReview как есть: исправлений дефектов upstream в мастере пока нет. Когда задача 4 плана
// docs/plans/2026-10-25-tune-wizard-stage4.md внесёт их в core/pid.js, те же исправления подменяются в коде PIDReview
// до загрузки лога (patch_pidreview, по образцу patch_filterreview в tests/tunewizard-compare.cjs).
// Нужны те же лог, браузер и python, что для tests/tunewizard-compare.cjs: CHROME_PATH — путь к chrome.exe (без него
// Playwright берёт свой Chromium, если он установлен); без лога тест пропускается.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
// Допуски — общие со сравнением с FilterReview
const { tolerance, time_tolerance } = require('./tunewizard-compare.cjs')

const repo = path.resolve(__dirname, '..')
const logs_dir = path.join(repo, 'TuneWizard', 'logs')
const port = 8793
// Окно FFT: по умолчанию у PIDReview (поле FFTWindow_size)
const WINDOW_SIZE = 512
// Оси PID: id сообщения = суффикс радио type_<id> PIDReview = id[0] оси load_pid
const AXES = ['PIDR', 'PIDP', 'PIDY']

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

// Исправления дефектов upstream в PIDReview — до загрузки лога. Возвращает список применённых замен.
// Устройство — как patch_filterreview в tests/tunewizard-compare.cjs: каждая замена обязана найтись заданное число раз,
// иначе upstream изменился и тест надо пересмотреть
function patch_pidreview(page) {
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

        // [имя функции, номер дефекта, edits]. Пусто: эталон — PIDReview как есть. Задача 4 добавит сюда те же
        // исправления, что внесёт в core/pid.js
        const fixes = []
        for (const [name, defect, edits] of fixes) {
            patch(name, defect, edits)
        }
        return applied
    })
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

        // 2. PIDReview: исправления (пока нет), лог, интервал мастера, окно 512, «Calculate»
        const pr = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
        pr.on('pageerror', (e) => problems.push('PIDReview pageerror: ' + e.message))
        pr.on('dialog', (d) => { problems.push('PIDReview alert: ' + d.message()); d.dismiss() })
        await wait_for_server(pr, 'http://127.0.0.1:' + port + '/PIDReview/', server)
        const patches = await patch_pidreview(pr)
        await pr.setInputFiles('#fileItem', log_path)
        // readFile ставит заголовок после окончания load
        await pr.waitForFunction(() => document.title.startsWith('PID Review: '), null, { timeout: 180000 })
        await wait_overlay(pr)
        const pr_default = [await pr.inputValue('#TimeStart'), await pr.inputValue('#TimeEnd')]
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
        assert.deepEqual([await pr.inputValue('#TimeStart'), await pr.inputValue('#TimeEnd')], [interval.start, interval.end], 'интервал PIDReview равен интервалу мастера')
        await pr.click('#calculate')
        await wait_overlay(pr)
        // calculate() выключает кнопку: расчёт выполнен
        assert.equal(await pr.isDisabled('#calculate'), true, '«Calculate» выполнен')
        assert.equal(await pr.inputValue('#FFTWindow_size'), String(WINDOW_SIZE), 'окно FFT PIDReview')

        // 3. Оси: выбрать радио (смена оси — setup_axis с перерисовкой) и снять отклик
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
            assert.equal(reference[id].id, id, 'PIDReview показывает ось ' + id)
        }

        // 4. Поэлементное сравнение
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
        if (failed.length > 0) {
            console.error('tunewizard-pid-compare: расхождений с PIDReview ' + failed.length + ' из ' + all_results.length + ' массивов; первое: ' + failed[0].mismatch)
            for (const r of failed.slice(1, 6)) {
                console.error('  ' + r.mismatch)
            }
            process.exitCode = 1
            return
        }
        const rates = AXES.filter((id) => wizard.axes[id].have_data).map((id) => id + ' ' + wizard.axes[id].rate.toFixed(4))
        console.log('tunewizard-pid-compare: совпадение с PIDReview (допуск ' + tolerance + ', по времени ' + time_tolerance + ' с) — оси ' + AXES.join('/') +
            ': окон ' + summary.join(', ') + '; массивов ' + all_results.length + ', значений ' + count + ', наибольшее отклонение ' + max_rel.toExponential(2) +
            ', по времени ' + max_abs.toExponential(2) + ' с. Интервал ' + interval.start + '–' + interval.end + ' с (у PIDReview по умолчанию ' + pr_default.join('–') +
            ' с), окно ' + WINDOW_SIZE + ', средняя частота FFT ' + rates.join(', ') + ' Гц, исправления в эталоне: ' + (patches.length ? patches.join(', ') : 'нет'))
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
