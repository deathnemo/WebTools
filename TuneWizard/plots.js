// Реестр графиков Plotly мастера: тема из токенов CSS применяется ко всем графикам разом.

// Значение токена темы из :root
function css_token(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

// Палитра линий из токенов: оси X/Y/Z, предупреждение; стили pre / оценка post / логированное post;
// прозрачность для второго и третьего гироскопа
function plot_palette() {
    return {
        series: [css_token("--accent"), css_token("--low"), css_token("--ok"), css_token("--high")],
        axis: { x: css_token("--accent"), y: css_token("--low"), z: css_token("--ok") },
        warn: css_token("--high"),
        ink: css_token("--ink-2"),
        line: css_token("--line"),
        dash: { pre: "solid", est: "dash", post: "dot" },
        gyro_opacity: [1, 0.65, 0.4],
    }
}

// Общая часть layout под текущую тему
function plot_layout_theme() {
    const font = { family: '"IBM Plex Mono", ui-monospace, monospace', size: 11, color: css_token("--ink-2") }
    // Шрифт осей, легенды и colorbar — без цвета: Plotly наследует его из layout.font, который обновляется
    // при каждой смене темы. Иначе цвет первой темы остался бы в подписях осей навсегда, а свой цвет оси
    // (как у осей графика полёта) нельзя было бы отличить от цвета темы
    const sub_font = { family: font.family, size: font.size }
    return {
        paper_bgcolor: css_token("--surface"),
        plot_bgcolor: css_token("--surface"),
        font,
        axis: {
            gridcolor: css_token("--line-soft"),
            linecolor: css_token("--line"),
            zerolinecolor: css_token("--line"),
        },
        axis_font: sub_font,
        // Ползунок диапазона: фон и рамка тоже из токенов, иначе в тёмной теме он остаётся светлым
        rangeslider: { bgcolor: css_token("--surface-2"), bordercolor: css_token("--line") },
        legend: { font: sub_font, bgcolor: "rgba(0,0,0,0)" },
        colorbar: { tickfont: sub_font, outlinecolor: css_token("--line") },
    }
}

// Подпись (title) со шрифтом темы: текст и свой цвет подписи сохраняются
function themed_title(title, font) {
    return { ...(title ?? {}), font: { ...(title?.font ?? {}), ...font } }
}

// Зарегистрированные графики: id контейнера → { data, layout, config, on_theme }
const plots = {}

// Зарегистрировать график. on_theme(palette, data, layout) — перекраска линий при смене темы (необязательно)
function register_plot(id, data, layout, options = {}) {
    plots[id] = { data, layout, config: { displaylogo: false, responsive: true }, on_theme: options.on_theme ?? null }
    apply_plot_theme(plots[id])
    const div = document.getElementById(id)
    Plotly.purge(div)
    Plotly.newPlot(div, data, layout, plots[id].config)
    return plots[id]
}

function plot(id) {
    return plots[id]
}

// Перерисовать график после изменения data/layout
function render_plot(id) {
    const p = plots[id]
    Plotly.react(id, p.data, p.layout, p.config)
}

// Применить тему к одному графику: фоны, шрифт, все оси, ползунок, легенда, colorbar; затем хук цветов
function apply_plot_theme(p) {
    const theme = plot_layout_theme()
    const layout = p.layout
    layout.paper_bgcolor = theme.paper_bgcolor
    layout.plot_bgcolor = theme.plot_bgcolor
    layout.font = theme.font
    for (const key of Object.keys(layout)) {
        if (/^[xy]axis\d*$/.test(key)) {
            const axis = layout[key]
            // Object.assign только дописывает поля темы: range, domain, side и прочие настройки оси сохраняются
            Object.assign(axis, theme.axis, {
                title: themed_title(axis.title, theme.axis_font),
                tickfont: { ...(axis.tickfont ?? {}), ...theme.axis_font },
            })
            if (axis.rangeslider) {
                Object.assign(axis.rangeslider, theme.rangeslider)
            }
        }
    }
    layout.legend = { ...(layout.legend ?? {}), ...theme.legend }
    for (const trace of p.data) {
        if (trace.colorbar) {
            Object.assign(trace.colorbar, theme.colorbar, { title: themed_title(trace.colorbar.title, theme.axis_font) })
        }
    }
    if (p.on_theme) {
        p.on_theme(plot_palette(), p.data, layout)
    }
}

// Перерисовать все графики под новую тему, данные сохраняются
function restyle_plots() {
    if (typeof Plotly === "undefined") {
        return
    }
    for (const [id, p] of Object.entries(plots)) {
        if (document.getElementById(id) == null) {
            continue
        }
        apply_plot_theme(p)
        render_plot(id)
    }
}
