// Связь целей осей на интервале: коэффициент корреляции и доля времени, когда цели двух осей одновременно больше 20 °/с
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const [repo, log_path, a, b] = process.argv.slice(2)
globalThis.self = { addEventListener() {}, postMessage() {} }
const DataflashParser = (await import(pathToFileURL(path.join(repo, 'modules/JsDataflashParser/parser.js')).href)).default
const data = fs.readFileSync(log_path)
const log = new DataflashParser()
log.processData(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), [])
const R2D = 180 / Math.PI
const t = log.get('PIDR', 'TimeUS'), tp = log.get('PIDP', 'TimeUS'), ty = log.get('PIDY', 'TimeUS')
console.log('метки времени совпадают:', t.every((v, i) => v === tp[i] && v === ty[i]))
const tar = { roll: log.get('PIDR', 'Tar'), pitch: log.get('PIDP', 'Tar'), yaw: log.get('PIDY', 'Tar') }
const idx = []
for (let i = 0; i < t.length; i++) { const s = t[i] * 1e-6; if (s >= Number(a) && s <= Number(b)) idx.push(i) }
const pairs = [['roll', 'pitch'], ['roll', 'yaw'], ['pitch', 'yaw']]
for (const [x, y] of pairs) {
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, both = 0, any = 0
    for (const i of idx) {
        const u = tar[x][i] * R2D, v = tar[y][i] * R2D
        sx += u; sy += v; sxx += u * u; syy += v * v; sxy += u * v
        const bu = Math.abs(u) > 20, bv = Math.abs(v) > 20
        if (bu && bv) both++
        if (bu || bv) any++
    }
    const n = idx.length
    const r = (sxy / n - sx / n * sy / n) / Math.sqrt((sxx / n - (sx / n) ** 2) * (syy / n - (sy / n) ** 2))
    console.log(x + '–' + y + ': корреляция целей ' + r.toFixed(3) + ', обе цели > 20 °/с одновременно — ' + (100 * both / n).toFixed(1) + ' % времени (' + (100 * both / any).toFixed(1) + ' % от времени манёвров)')
}
