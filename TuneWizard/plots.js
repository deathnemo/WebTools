// Реестр графиков Plotly мастера: тема из токенов CSS применяется ко всем графикам разом.
//
// Политика скрытых графиков. Plotly не умеет корректно рисовать в контейнере внутри скрытой секции:
// вычисленная ширина «100%» читается как 100 px (высота — из CSS), и после показа график остаётся узким.
// Поэтому скрытый график не рисуется, а помечается dirty; при показе шага show_plots(section)
// дорисовывает такие графики с актуальной темой, а чистым подгоняет размер (Plots.resize): обработчик
// responsive у Plotly пересчитывает размер и у скрытых графиков, так что чистый график после изменения
// окна тоже становится 100 px. Смена темы (restyle_plots) перекрашивает все графики, но перерисовывает
// сразу только видимые.

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
        legend: { bgcolor: "rgba(0,0,0,0)" },
        colorbar: { outlinecolor: css_token("--line") },
    }
}

// Подпись (title) со шрифтом темы: текст и свои поля шрифта (цвет, размер) сохраняются, тема дополняет
// недостающее; строка — это текст подписи
function themed_title(title, font) {
    title = (typeof title === "string") ? { text: title } : (title ?? {})
    return { ...title, font: { ...font, ...(title.font ?? {}) } }
}

// Рисовать негде: контейнера нет, у него или у предка атрибут hidden, либо display:none (offsetParent нет)
function plot_hidden(div) {
    return div == null || div.closest("[hidden]") != null || div.offsetParent === null
}

// Зарегистрированные графики: id контейнера → { data, layout, config, on_theme, dirty }
const plots = {}

// Зарегистрировать график и нарисовать его. Контракт:
// - data и layout хранятся по ссылке: менять их на месте (trace.x = …, layout.xaxis.range = …) и звать
//   render_plot(id); новые объекты после регистрации не присваивать;
// - реестр красит фоны, шрифт, сетку и линии осей, ползунок, легенду и colorbar. Явный цвет в шрифте оси,
//   подписи или делений переживает смену темы, поэтому цвета, зависящие от темы, задаются в хуке
//   on_theme(palette, data, layout) или не задаются вовсе — тогда наследуется layout.font.color;
// - shapes, annotations, colorscale и marker.color реестр не красит: это тоже работа on_theme;
// - график, зарегистрированный в скрытом контейнере, дорисуется при показе шага (см. политику выше).
function register_plot(id, data, layout, options = {}) {
    plots[id] = { data, layout, config: { displaylogo: false, responsive: true }, on_theme: options.on_theme ?? null, dirty: false }
    apply_plot_theme(plots[id])
    const div = document.getElementById(id)
    Plotly.purge(div)
    Plotly.newPlot(div, data, layout, plots[id].config)
    plots[id].dirty = plot_hidden(div)
    return plots[id]
}

// Запись реестра по id контейнера: { data, layout, config, on_theme, dirty } или undefined
function plot(id) {
    return plots[id]
}

// Перерисовать график после изменения data/layout; скрытый — отложить до показа шага
function render_plot(id) {
    const p = plots[id]
    if (p == null) {
        throw new Error("График не зарегистрирован: " + id)
    }
    if (plot_hidden(document.getElementById(id))) {
        p.dirty = true
        return
    }
    p.dirty = false
    Plotly.react(id, p.data, p.layout, p.config)
}

// Применить тему к одному графику: фоны, шрифт, все оси, ползунок, легенда, colorbar; затем хук цветов.
// Шрифты дополняются семейством и размером темы, свои поля (размер, цвет) остаются: тема первой, своё поверх
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
                tickfont: { ...theme.axis_font, ...(axis.tickfont ?? {}) },
            })
            if (axis.rangeslider) {
                Object.assign(axis.rangeslider, theme.rangeslider)
            }
        }
    }
    layout.legend = { ...(layout.legend ?? {}), ...theme.legend, font: { ...theme.axis_font, ...(layout.legend?.font ?? {}) } }
    for (const trace of p.data) {
        if (trace.colorbar) {
            Object.assign(trace.colorbar, theme.colorbar, {
                title: themed_title(trace.colorbar.title, theme.axis_font),
                tickfont: { ...theme.axis_font, ...(trace.colorbar.tickfont ?? {}) },
            })
        }
    }
    if (p.on_theme) {
        p.on_theme(plot_palette(), p.data, layout)
    }
}

// Смена темы: перекрасить все графики; видимые перерисовать сразу, скрытые — при показе шага
function restyle_plots() {
    if (typeof Plotly === "undefined") {
        return
    }
    for (const id of Object.keys(plots)) {
        apply_plot_theme(plots[id])
        render_plot(id)
    }
}

// Показ шага: графики внутри root (секции шага) с изменениями (dirty) дорисовать с актуальной темой,
// остальным подогнать размер. Обработчик responsive у Plotly срабатывает и для графика в скрытой секции
// и даёт ему ширину 100 px, а сам показ секции ничего не пересчитывает; Plots.resize — отложенный
// пересчёт autosize, много дешевле react
function show_plots(root) {
    if (root == null) {
        return
    }
    for (const [id, p] of Object.entries(plots)) {
        const div = document.getElementById(id)
        if (div == null || !root.contains(div)) {
            continue
        }
        if (p.dirty) {
            apply_plot_theme(p)
            render_plot(id)
        } else {
            Plotly.Plots.resize(div)
        }
    }
}
