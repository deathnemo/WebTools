// Тесты реестра графиков мастера настройки (TuneWizard/plots.js): смена темы, скрытые графики, ошибки.
// plots.js — браузерный скрипт с глобальными функциями, поэтому document, getComputedStyle и Plotly
// подменяются стабами, а файл выполняется через vm.runInThisContext.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// Токены двух тем: подменяются целиком, как при переключении темы страницы
const LIGHT = {
    '--surface': '#fcfcfb', '--surface-2': '#f6f7f4', '--line': '#dbded8', '--line-soft': '#e4e7e1', '--ink-2': '#4b514a',
    '--accent': '#b45309', '--low': '#0d9488', '--ok': '#4d7c0f', '--high': '#b91c1c'
}
const DARK = {
    '--surface': '#2e3234', '--surface-2': '#262a2c', '--line': '#3b4043', '--line-soft': '#353a3d', '--ink-2': '#b8bdb7',
    '--accent': '#e0a64a', '--low': '#4fc3d1', '--ok': '#a9d166', '--high': '#f08a7a'
}
let tokens = LIGHT

// Стаб DOM: контейнер с id на каждый запрос; id из hidden_ids считаются скрытыми
// (closest('[hidden]') находит предка, offsetParent нет)
const hidden_ids = new Set()
globalThis.document = {
    documentElement: {},
    getElementById: (id) => (hidden_ids.has(id)
        ? { id, closest: () => ({}), offsetParent: null }
        : { id, closest: () => null, offsetParent: {} })
}
globalThis.getComputedStyle = () => ({ getPropertyValue: (name) => tokens[name] ?? '' })

// Стаб Plotly: запоминаем id перерисованных (react) и подогнанных по размеру (Plots.resize) графиков
const react_ids = []
const resize_ids = []
globalThis.Plotly = { purge() {}, newPlot() {}, react(id) { react_ids.push(id) }, Plots: { resize(div) { resize_ids.push(div.id) } } }
function reacts(id) {
    return react_ids.filter((x) => x === id).length
}
function resizes(id) {
    return resize_ids.filter((x) => x === id).length
}

const plots_js = path.join(__dirname, '..', 'TuneWizard', 'plots.js')
vm.runInThisContext(fs.readFileSync(plots_js, 'utf8'), { filename: plots_js })

// Layout в духе графика полёта: диапазон и ползунок по X, вторая ось Y поверх первой со своим цветом подписи
function flight_like_layout() {
    return {
        xaxis: { title: { text: 'Время, с' }, range: [1, 2], domain: [0.07, 0.93], rangeslider: {} },
        yaxis: { title: { text: 'Крен' } },
        yaxis2: { overlaying: 'y', title: { text: 'Газ', font: { color: 'red' } }, tickfont: { color: 'red' } },
        showlegend: false
    }
}

function assert_themed(layout, theme) {
    assert.equal(layout.paper_bgcolor, theme['--surface'])
    assert.equal(layout.plot_bgcolor, theme['--surface'])
    assert.equal(layout.font.color, theme['--ink-2'])
    assert.equal(layout.xaxis.title.text, 'Время, с')
    assert.equal(layout.xaxis.title.font.color, undefined, 'подпись оси X без своего цвета: наследует layout.font')
    assert.equal(layout.xaxis.tickfont.color, undefined)
    assert.equal(layout.xaxis.title.font.family, layout.font.family)
    assert.equal(layout.xaxis.gridcolor, theme['--line-soft'])
    assert.equal(layout.xaxis.linecolor, theme['--line'])
    assert.equal(layout.xaxis.rangeslider.bgcolor, theme['--surface-2'])
    assert.deepEqual(layout.xaxis.range, [1, 2], 'диапазон оси X не тронут')
    assert.deepEqual(layout.xaxis.domain, [0.07, 0.93])
    assert.equal(layout.yaxis2.overlaying, 'y')
    assert.equal(layout.yaxis2.title.text, 'Газ')
    assert.equal(layout.yaxis2.title.font.color, 'red', 'свой цвет подписи оси переживает смену темы')
    assert.equal(layout.yaxis2.tickfont.color, 'red')
    assert.equal(layout.yaxis2.title.font.family, layout.font.family)
    assert.equal(layout.legend.bgcolor, 'rgba(0,0,0,0)')
}

test('register_plot и restyle_plots: тема светлая → тёмная → светлая, свои поля layout сохраняются', () => {
    tokens = LIGHT
    const data = [{ x: [], y: [], line: { color: 'серый' } }, { x: [], y: [], line: {}, yaxis: 'y2' }]
    const layout = flight_like_layout()
    const palettes = []
    const p = register_plot('p', data, layout, {
        on_theme: (palette, d, l) => {
            palettes.push(palette)
            d[0].line.color = palette.series[0]
            l.yaxis.color = palette.series[0]
        }
    })
    assert.equal(p.layout, layout, 'layout хранится по ссылке')
    assert.equal(p.data, data, 'data хранится по ссылке')
    assert.equal(p.dirty, false)
    assert.equal(reacts('p'), 0, 'регистрация рисует через newPlot, не react')
    assert_themed(layout, LIGHT)
    assert.equal(data[0].line.color, LIGHT['--accent'], 'хук on_theme перекрасил ряд')

    for (const theme of [DARK, LIGHT]) {
        tokens = theme
        restyle_plots()
        assert_themed(layout, theme)
        assert.equal(data[0].line.color, theme['--accent'])
        assert.equal(layout.yaxis.color, theme['--accent'])
    }
    assert.equal(palettes.length, 3, 'хук вызван при регистрации и при каждой смене темы')
    assert.deepEqual(palettes[1].series, [DARK['--accent'], DARK['--low'], DARK['--ok'], DARK['--high']])
    assert.equal(reacts('p'), 2, 'видимый график перерисован при каждой смене темы')
})

test('apply_plot_theme: шрифты легенды и colorbar дополняются темой, свой размер и текст остаются', () => {
    tokens = LIGHT
    const data = [{ type: 'heatmap', z: [[1]], colorbar: { title: { text: 'дБ' }, tickfont: { size: 8 } } }]
    const layout = { legend: { font: { size: 9 }, orientation: 'h' } }
    register_plot('q', data, layout)
    assert.equal(layout.legend.font.size, 9, 'свой размер шрифта легенды')
    assert.match(layout.legend.font.family, /IBM Plex Mono/)
    assert.equal(layout.legend.font.color, undefined, 'цвет легенды наследуется из layout.font')
    assert.equal(layout.legend.orientation, 'h')
    const colorbar = data[0].colorbar
    assert.equal(colorbar.title.text, 'дБ', 'текст подписи colorbar сохранён')
    assert.match(colorbar.title.font.family, /IBM Plex Mono/)
    assert.equal(colorbar.tickfont.size, 8, 'свой размер делений colorbar')
    assert.match(colorbar.tickfont.family, /IBM Plex Mono/)
    assert.equal(colorbar.outlinecolor, LIGHT['--line'])
    assert.notEqual(layout.legend.font, colorbar.tickfont, 'шрифты легенды и colorbar — разные объекты')
    assert.notEqual(colorbar.title.font, colorbar.tickfont)

    // Строковый заголовок (старый API Plotly) становится объектом с текстом; размер шрифта темы — у всех
    colorbar.title = 'м/с²'
    tokens = DARK
    restyle_plots()
    assert.deepEqual(colorbar.title, { text: 'м/с²', font: { family: layout.font.family, size: 11 } })
    assert.equal(colorbar.outlinecolor, DARK['--line'])
    assert.equal(layout.legend.font.size, 9)
})

test('скрытый график: restyle_plots и render_plot откладывают рисование (dirty), show_plots дорисовывает и подгоняет размер', () => {
    tokens = LIGHT
    const p = register_plot('h', [{ x: [], y: [] }], { xaxis: {} })
    assert.equal(p.dirty, false)

    hidden_ids.add('h')
    tokens = DARK
    restyle_plots()
    assert.equal(p.dirty, true, 'скрытый график помечен')
    assert.equal(reacts('h'), 0, 'Plotly.react для скрытого не вызывается')
    assert.equal(p.layout.paper_bgcolor, DARK['--surface'], 'тема в layout всё же обновлена')
    render_plot('h')
    assert.equal(reacts('h'), 0, 'render_plot скрытого тоже откладывается')
    assert.equal(p.dirty, true)

    // Показали другую секцию — не рисуем
    hidden_ids.delete('h')
    show_plots({ contains: () => false })
    assert.equal(p.dirty, true)
    assert.equal(reacts('h'), 0)

    tokens = LIGHT
    show_plots({ contains: (div) => div.id === 'h' })
    assert.equal(p.dirty, false)
    assert.equal(reacts('h'), 1, 'показ шага дорисовал график')
    assert.equal(resizes('h'), 0, 'dirty-графику размер отдельно не подгоняется: его даёт react')
    assert.equal(p.layout.paper_bgcolor, LIGHT['--surface'], 'с актуальной темой')

    // Повторный показ чистого графика: не перерисовывает, а подгоняет размер — обработчик responsive
    // у Plotly ужимает графики в скрытой секции до 100 px, и сам показ секции этого не чинит
    show_plots({ contains: (div) => div.id === 'h' })
    assert.equal(reacts('h'), 1)
    assert.equal(resizes('h'), 1, 'чистому графику — Plots.resize')

    // Зарегистрированный в скрытом контейнере — дорисуется при показе
    hidden_ids.add('late')
    const late = register_plot('late', [], {})
    assert.equal(late.dirty, true)
    hidden_ids.delete('late')
    show_plots({ contains: (div) => div.id === 'late' })
    assert.equal(late.dirty, false)
    assert.equal(reacts('late'), 1)
    assert.equal(resizes('h'), 1, 'график вне показанной секции не трогается')

    // Секции нет — ничего не делаем
    const calls = [react_ids.length, resize_ids.length]
    show_plots(null)
    assert.deepEqual([react_ids.length, resize_ids.length], calls)
})

test('render_plot: незарегистрированный график — ошибка', () => {
    assert.throws(() => render_plot('nope'), /не зарегистрирован/)
    assert.equal(plot('nope'), undefined)
})
