// Общий модуль шагов мастера: помощники, которые одинаковы у шагов 2 и 3 (и нужны шагу 4) — подписи и плитки,
// вердикт, досчёт расчёта шага 1, запуск действий с перехватом ошибок (step_…) и куски графиков (plot_…).
// Состояние модуля — только глубина вложенности step_run (step_run_state).
//
// Нужны глобалы страницы: wizard.js (state, html_escape), steps/step1.js (step1, step1_ready, step1_prepare),
// core/spectrum.js (find_instance), plots.js (plot, render_plot), Libraries/LoadingOverlay.js (loading_call). Все
// они нужны только при вызове, поэтому модуль подключается перед steps/step1.js.

// ---------- Подписи ----------

// Число со знаком; округлённый ноль — без минуса
function step_signed(value, digits) {
    const rounded = Number(value.toFixed(digits))
    return ((rounded > 0) ? "+" : "") + ((rounded == 0) ? (0).toFixed(digits) : rounded.toFixed(digits))
}

// Плитка с пояснением третьей строкой (sub; пусто — без неё); mod — модификатор "bad" | "good" | null
function step_tile(key, value, sub, mod) {
    return '<div class="stat' + (mod ? " stat--" + mod : "") + '"><span class="stat__k">' + html_escape(key) + '</span><span class="stat__v">' +
        html_escape(value) + '</span>' + (sub ? '<span class="stat__s">' + html_escape(sub) + '</span>' : "") + '</div>'
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
