// Общий модуль шагов мастера: помощники, которые одинаковы у нескольких шагов — подписи, плитки и ячейки таблиц,
// вердикт, досчёт расчёта шага 1, контекст итога, отпечаток входов принятого шага и «устарело», запуск действий
// с перехватом ошибок, «Открыть в …», описания параметров из метаданных, флаг нажатой кнопки мыши и каркас механизма
// правок полей шагов 3–4 (step_…), куски графиков (plot_…).
// Состояние модуля — глубина вложенности step_run (step_run_state), загрузка метаданных и её сбой
// (step_metadata_state) и флаг указателя с подписчиками (step_pointer).
//
// Нужны глобалы страницы: wizard.js (state, html_escape), steps/step1.js (step1, step1_ready, step1_prepare),
// steps/step2.js (step2_param_names), steps/step4.js (step4_param_names), core/spectrum.js (find_instance),
// core/summary.js (summary_inputs_key, summary_stale), core/passmem.js (passmem_depends4_names), core/lowpass.js
// (lowpass_param_names), core/params.js (hmncs_bits), plots.js (plot, render_plot), Libraries/LoadingOverlay.js
// (loading_call), Libraries/Param_Helpers.js (param_to_string). Все они нужны только при вызове, поэтому модуль
// подключается перед steps/step1.js. Обработчики указателя ставятся при первой подписке
// (step_on_pointer_release), а не при загрузке этого модуля; шаги 3 и 4 подписываются при загрузке своих скриптов
// (step3_edits, step4_edits), поэтому на странице обработчики фактически стоят с её загрузки, а тест модуля под Node
// обходится без них.

// ---------- Подписи ----------

// Число со знаком; округлённый ноль — без минуса
function step_signed(value, digits) {
    const rounded = Number(value.toFixed(digits))
    return ((rounded > 0) ? "+" : "") + ((rounded == 0) ? (0).toFixed(digits) : rounded.toFixed(digits))
}

// Число со словом в нужной форме: forms — для 1, 2–4 и 5+ («1 окно», «553 окна», «811 окон»; 11–14 — как 5+:
// «12 параметров»)
function step_plural(n, forms) {
    const last = n % 10
    const teen = (n % 100 >= 11) && (n % 100 <= 14)
    const form = teen ? forms[2] : ((last == 1) ? forms[0] : (((last >= 2) && (last <= 4)) ? forms[1] : forms[2]))
    return n + " " + form
}

// Значение параметра кратчайшей записью float32 (param_to_string); нечисловое — «—» (param_to_string(NaN) бросает)
function step_value_text(value) {
    return Number.isFinite(value) ? param_to_string(value) : "—"
}

// Плитка с пояснением третьей строкой (sub; пусто — без неё); mod — модификатор "bad" | "good" | "accent" | null
function step_tile(key, value, sub, mod) {
    return '<div class="stat' + (mod ? " stat--" + mod : "") + '"><span class="stat__k">' + html_escape(key) + '</span><span class="stat__v">' +
        html_escape(value) + '</span>' + (sub ? '<span class="stat__s">' + html_escape(sub) + '</span>' : "") + '</div>'
}

// Числовая ячейка таблицы вариантов: text — основное значение, sub — мелкая строка, cls — "better" | "worse" | "",
// title — подсказка
function step_cell(text, sub, cls, title) {
    return '<td class="num' + (cls ? " " + cls : "") + '"' + (title ? ' title="' + html_escape(title) + '"' : "") + '>' + html_escape(text) +
        (sub ? '<small>' + html_escape(sub) + '</small>' : "") + '</td>'
}

// Вердикт шага в блоке id: status — "ok" | "warn" | "fail", text — обычный текст
function step_verdict(id, status, text) {
    const verdict = document.getElementById(id)
    verdict.className = "verdict verdict--" + status
    verdict.textContent = text
    verdict.hidden = false
}

// ---------- Расчёт ----------

// Экземпляр gyro до фильтров первичного гироскопа — по нему оцениваются варианты; null без данных «до»
function step_gyro_sensor() {
    const gyro = state.gyro
    if (!gyro.have_pre) {
        return null
    }
    return find_instance(gyro, gyro.primary ?? gyro.first_gyro, false) ?? null
}

// Расчёт шага 1 актуален или досчитан (step1_prepare): null; иначе текст ошибки — шаг кладёт результат в своё error
function step_ensure_step1() {
    if (step1_ready() || step1_prepare()) {
        return null
    }
    return step1.error ?? "Расчёт спектра шага 1 не готов"
}

// ---------- Контекст итога и отпечаток входов принятого ----------
// Дизайн — docs/plans/2026-10-25-tune-wizard-stage5-design.md, разделы 2.2 и 2.4. Устаревшее принятое
// предупреждается, не блокирует [решение пользователя 25.10.2026]

// Размер маски HMNCS лога (hmncs_bits) по версии фильтра шага 1 (нет версии — 1, как в step2_save_param): один для
// итога и отпечатка (step_summary_context) и для «применено» блока «Прошлый проход» (memory_show_pass). Нужен
// загруженный лог
function step_hmncs_bits() {
    return hmncs_bits(state.params, state.spectrum.filter_version ?? 1)
}

// Имена, от которых зависит прогноз шага 4, — depends[4] контекста итога: в отпечаток шага 4 входят изменения только
// этих имён. Список один на страницу и память прохода — passmem_depends4_names (core/passmem.js: поля notch и
// INS_GYRO_FILTER — поправка фильтров гироскопа, step4_gyro_new; FLTE и FLTD осей — регуляторы вариантов,
// step4_new_filters), то же входит в собственный ключ расчёта шага 4 (step4_calc_key). Пределы ускорения, FLTT и
// INS_ACCEL_FILTER шага 3 прогноз шага 4 не меняют, SCHED_LOOP_RATE шага 2 — тоже: модель регулятора считается на
// частоте контура лога. Иначе новое «Принять» шага 3 с другим FLTT делало бы шаг 4 устаревшим в сводке, а сам шаг 4 —
// нет. Шагам 2–3 списка нет: в их отпечаток входят все изменения шагов до них. core/passmem.js подключён до этого
// модуля, а вызов — во время работы
function step_depends4_names() {
    return passmem_depends4_names()
}

// Контекст итога и отпечатка из состояния страницы: вход summary_rows (параметры лога, принятое шагов, имена
// параметров шагов, версия фильтра и размер маски HMNCS) плюс интервал анализа, ключ FFT шага 1 и имена, от которых
// зависит шаг 4 (step_depends4_names), — для summary_inputs_key и summary_stale. Один построитель на сводку шага 5
// (step5_render, memory_save) и отпечаток (помощники ниже) — чтобы ключ при «Принять», проверка «устарело» и
// «изменён» в сводке не разошлись: версия фильтра одна — state.spectrum.filter_version, и в ключе шагов 2–3, и для
// правила ESCMSK и размера маски в summary_rows.
// Нужен загруженный лог (state.params): без него бросает. Функции имён и hmncs_bits — из core/lowpass.js,
// core/params.js, core/filters.js, core/pidtune.js, steps/step2.js и steps/step4.js: все они загружены к любому вызову.
// Известное ограничение: step1.fft_key — ключ последнего расчёта шага 1, поэтому смена окна FFT на шаге 0 без
// пересчёта шага 1 не делает принятое устаревшим, пока шаг 1 не пересчитан
function step_summary_context() {
    return {
        start: state.settings.start,
        end: state.settings.end,
        fft_key: step1.fft_key,
        filter_version: state.spectrum.filter_version,
        steps: state.steps,
        params: state.params,
        names: { 2: step2_param_names(), 3: lowpass_param_names(state.params), 4: step4_param_names() },
        depends: { 4: step_depends4_names() },
        bits: step_hmncs_bits(),
    }
}

// Отпечаток входов шага n (2–4) по текущему состоянию — «Принять» шагов 2–4 кладёт его в state.steps[n].inputs.
// Порядок не важен: ключ шага n — от шагов < n; берётся до записи state.steps[n] для ясности
function step_inputs_key(n) {
    return summary_inputs_key(n, step_summary_context())
}

// Устарело ли принятое шага n (2–4): отпечаток, сохранённый при «Принять», не совпал с текущим (summary_stale).
// Не принят — false сразу, без контекста: без лога (после reset) построитель контекста бросает
function step_accepted_stale(n) {
    if (state.steps[n] == null) {
        return false
    }
    return summary_stale(n, step_summary_context())
}

// ---------- Действия ----------

// Выполнить fn; неожиданная ошибка — в консоль и в вердикт verdict_id: «Ошибка <label>: …», label — «шага 2» и т. п.
function step_try(fn, verdict_id, label) {
    try {
        fn()
    } catch (e) {
        console.error(e)
        step_verdict(verdict_id, "fail", "Ошибка " + label + ": " + e.message)
    }
}

// Сколько функций step_run выполняется сейчас (вложенные вызовы — внутри внешней)
const step_run_state = { depth: 0 }

// Выполнить fn под оверлеем загрузки (step_try: ошибка не оставляет оверлей висеть). Вызов изнутри функции другого
// step_run (например, «Принять» шага 2 → set_step(3) → step3_show) выполняет fn сразу, синхронно, внутри внешней
// функции — под её оверлеем. Через loading_call вложенный вызов показал бы оверлей, внешний тут же скрыл бы его,
// и fn шла бы через два кадра уже без оверлея и после того, как внешнее действие закончилось
function step_run(fn, verdict_id, label) {
    if (step_run_state.depth > 0) {
        step_try(fn, verdict_id, label)
        return
    }
    loading_call(async () => {
        step_run_state.depth++
        try {
            step_try(fn, verdict_id, label)
        } finally {
            step_run_state.depth--
        }
    })
}

// Тот же файл лога в другом инструменте WebTools (path — "../FilterReview/", "../PIDReview/") — как кнопка «Open In»
// (Libraries/OpenIn.js, hook_load): страница того же источника после загрузки получает File сообщением и подставляет
// его в поле выбора лога. Без файла — ничего; браузер не открыл вкладку (всплывающие окна запрещены) — on_blocked()
function step_open_in(path, on_blocked) {
    if (state.file == null) {
        return
    }
    const file = state.file
    const w = window.open(path)
    if (w == null) {
        on_blocked()
        return
    }
    w.addEventListener("load", () => w.postMessage({ type: "file", data: file }, location.origin))
}

// ---------- Описания параметров ----------
// Формы шагов 3 и 4 строятся своим кодом (не Libraries/ParameterMetadata.js) и берут описания из одной загрузки
// ../FilterReview/params.json. Шаг 2 грузит метаданные сам, через load_param_inputs

// Загрузка метаданных: промис (один запрос на страницу), пришедший объект (null — ещё нет или не загрузились) и сбой
// загрузки (failed: true — не загрузились; data null при failed false — ещё грузятся или загрузка не начата)
const step_metadata_state = { promise: null, data: null, failed: false }

// Описание параметра name в метаданных obj — тем же префиксным обходом, что recursive_search в
// Libraries/ParameterMetadata.js; null — описания нет
function step_find_metadata(obj, name) {
    for (const [key, value] of Object.entries(obj)) {
        if (!name.startsWith(key)) {
            continue
        }
        if (name === key) {
            return value
        }
        const found = step_find_metadata(value, name)
        if (found != null) {
            return found
        }
    }
    return null
}

// Метаданные, если уже пришли (иначе null) — для разметки, построенной после загрузки
function step_metadata() {
    return step_metadata_state.data
}

// Не загрузились ли метаданные: step_metadata() даёт null и пока они грузятся, и после сбоя — сводке шага 5 это
// разные случаи («что перелететь»: пока грузятся, пункта о перезагрузке нет; после сбоя — общий пункт)
function step_metadata_failed() {
    return step_metadata_state.failed
}

// Загрузить метаданные один раз на страницу → промис с объектом или null (не загрузились: флаг сбоя
// step_metadata_failed, предупреждение в консоль, в формах остаются имена полей). Повторный вызов возвращает тот же
// промис
function step_load_metadata() {
    if (step_metadata_state.promise == null) {
        step_metadata_state.promise = fetch("../FilterReview/params.json")
            .then((res) => {
                if (!res.ok) {
                    throw new Error("HTTP " + res.status + (res.statusText ? " " + res.statusText : "") + " для " + res.url)
                }
                return res.json()
            })
            .then((data) => {
                step_metadata_state.data = data
                return data
            })
            .catch((e) => {
                step_metadata_state.failed = true
                console.warn("Описания параметров (FilterReview/params.json) не загрузились, в формах шагов 3 и 4 только имена полей — " + e.message)
                return null
            })
    }
    return step_metadata_state.promise
}

// ---------- Указатель и правки полей ----------
// Щелчок по кнопке сразу после набора в поле не должен теряться (шаги 3 и 4): нажатие уводит фокус из поля, поле даёт
// change, и перерисовка в этот момент сдвинула бы кнопку до отпускания мыши. Поэтому change при нажатой кнопке мыши
// ждёт её отпускания (флаг step_pointer), а набор пересчитывается после паузы (step_edit_controller)

// Нажата ли основная кнопка мыши (касание) — один флаг на страницу; listeners — подписчики на отпускание
const step_pointer = { down: false, listeners: [], installed: false }

// Кнопка отпущена (или её отпускания уже не будет): флаг снят, подписчикам — сообщить
function step_pointer_release() {
    step_pointer.down = false
    for (const listener of step_pointer.listeners) {
        listener()
    }
}

// Обработчики указателя — один раз. Полоса прокрутки и контекстное меню pointerup не присылают, поэтому флаг снимают
// ещё contextmenu, уход из окна и движение мыши без нажатых кнопок; фаза перехвата — раньше обработчиков страницы
function step_pointer_init() {
    if (step_pointer.installed) {
        return
    }
    step_pointer.installed = true
    document.addEventListener("pointerdown", (e) => {
        if (e.button === 0) {
            step_pointer.down = true
        }
    }, true)
    for (const type of ["pointerup", "pointercancel", "contextmenu"]) {
        document.addEventListener(type, step_pointer_release, true)
    }
    document.addEventListener("pointermove", (e) => {
        if (step_pointer.down && (e.buttons === 0)) {
            step_pointer_release()
        }
    }, true)
    window.addEventListener("blur", step_pointer_release)
}

// Подписаться на отпускание кнопки мыши (ставит обработчики при первой подписке)
function step_on_pointer_release(listener) {
    step_pointer_init()
    step_pointer.listeners.push(listener)
}

// Каркас механизма правок полей шага. owner — состояние шага: поля edit_timer (отложенный пересчёт после набора; его
// ждут тесты) и edit_postponed (пересчёт отложен до отпускания мыши); options = { delay_ms — пауза в наборе, flush() —
// пересчёт правок шага без force }. Возвращает:
//   input() — набор в поле: пересчёт после паузы;
//   change() — change поля: следующей задачей, а при нажатой кнопке мыши — после её отпускания (сразу после щелчка);
//   begin(force) — начало пересчёта правок: снять отложенный таймер; при нажатой кнопке мыши (и без force) — отложить
//   до отпускания и вернуть false (пересчитывать сейчас нельзя), иначе true. force — кнопки шага: к click кнопка мыши
//   уже отпущена, а с клавиатуры флаг не нужен
function step_edit_controller(owner, options) {
    step_on_pointer_release(() => {
        if (owner.edit_postponed) {
            owner.edit_postponed = false
            setTimeout(options.flush, 0)
        }
    })
    return {
        input() {
            clearTimeout(owner.edit_timer)
            owner.edit_timer = setTimeout(options.flush, options.delay_ms)
        },
        change() {
            if (step_pointer.down) {
                owner.edit_postponed = true
                return
            }
            setTimeout(options.flush, 0)
        },
        begin(force) {
            clearTimeout(owner.edit_timer)
            owner.edit_timer = null
            if (!force && step_pointer.down) {
                owner.edit_postponed = true
                return false
            }
            return true
        },
    }
}

// ---------- Графики ----------

// Ось графика шага: подпись title (null — без подписи), шкала type ("linear" | "log"), рамка без нулевой линии
function plot_axis(title, type = "linear") {
    const axis = (title != null) ? { title: { text: title } } : {}
    return { ...axis, type: type, zeroline: false, showline: true, mirror: true }
}

// Видимость трассы после смены данных: без данных — вне легенды; с данными — выбранная пользователем в легенде,
// а после очистки — по умолчанию shown (true или "legendonly")
function plot_trace_visibility(trace, shown) {
    if (trace.x.length == 0) {
        trace.visible = false
    } else if (trace.visible === false) {
        trace.visible = shown
    }
}

// Пустой график id реестра plots.js: у трасс — пустые x и y, и перерисовать. hide — ещё и скрыть трассы
// (visible = false; видимость с данными вернёт plot_trace_visibility) и фигуры layout.shapes. z тепловых карт
// не очищается — спектрограммы чистятся своим кодом. Графика ещё нет (не зарегистрирован) — ничего
function plot_clear(id, hide = true) {
    const p = plot(id)
    if (p == null) {
        return
    }
    for (const trace of p.data) {
        trace.x = []
        trace.y = []
        if (hide) {
            trace.visible = false
        }
    }
    if (hide) {
        for (const shape of p.layout.shapes ?? []) {
            shape.visible = false
        }
    }
    render_plot(id)
}
