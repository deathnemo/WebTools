// Общий модуль шагов мастера: помощники, которые одинаковы у шагов 2 и 3 (и нужны шагу 4) — подписи и плитки,
// вердикт, досчёт расчёта шага 1, запуск действий с перехватом ошибок (step_…) и куски графиков (plot_…).
// Своего состояния у модуля нет.
//
// Нужны глобалы страницы: wizard.js (state, html_escape), steps/step1.js (step1, step1_ready, step1_prepare),
// core/gyro.js (find_instance), plots.js (plot, render_plot), Libraries/LoadingOverlay.js (loading_call). Все они
// нужны только при вызове, поэтому модуль подключается перед steps/step1.js.

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

// Выполнить fn под оверлеем загрузки (step_try: ошибка не оставляет оверлей висеть)
function step_run(fn, verdict_id, label) {
    loading_call(async () => step_try(fn, verdict_id, label))
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
// (visible = false; видимость с данными вернёт plot_trace_visibility) и фигуры layout.shapes. Графика ещё нет
// (не зарегистрирован) — ничего
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
