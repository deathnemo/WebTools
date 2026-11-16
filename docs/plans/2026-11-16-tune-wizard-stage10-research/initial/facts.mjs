// Разбор лога ядром мастера настройки под Node: аппарат, режимы, частоты записи, параметры, проверки шага 0.
// Запуск: node facts.mjs <репозиторий> <лог> [<лог для сравнения параметров> ...]
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const [repo, log_path, ...compare_paths] = process.argv.slice(2)
const require = createRequire(path.join(repo, 'package.json'))

// parser.js — ES-модуль с обработчиком сообщений воркера: под Node подставляем пустой self
globalThis.self = { addEventListener() {}, postMessage() {} }
const DataflashParser = (await import(pathToFileURL(path.join(repo, 'modules/JsDataflashParser/parser.js')).href)).default
globalThis.FFTJS = require(path.join(repo, 'modules/fft.js/lib/fft.js'))

for (const file of [
    'Libraries/LogHelpers.js',
    'Libraries/Array_Math.js',
    'Libraries/fft.js',
    'Libraries/DecodeDevID.js',
    'Libraries/Param_Helpers.js',
    'TuneWizard/core/vehicle.js',
    'TuneWizard/core/log.js',
    'TuneWizard/core/checks.js',
]) {
    const full = path.join(repo, file)
    vm.runInThisContext(fs.readFileSync(full, 'utf8'), { filename: full })
}

function parse(file) {
    const data = fs.readFileSync(file)
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    const log = new DataflashParser()
    log.processData(buffer, [])
    return log
}

function params_map(log) {
    const PARM = log.get('PARM')
    const map = new Map()
    for (let i = 0; i < PARM.Name.length; i++) map.set(PARM.Name[i], PARM.Value[i])
    return map
}

function rate_hz(log, name) {
    if (!(name in log.messageTypes)) return null
    let t
    try { t = log.get(name, 'TimeUS') } catch (e) { return 'экземпляры' }
    if (t == null || t.length < 2) return null
    const span = (t[t.length - 1] - t[0]) * 1e-6
    return { n: t.length, hz: +(t.length / span).toFixed(1), from: +(t[0] * 1e-6).toFixed(1), to: +(t[t.length - 1] * 1e-6).toFixed(1) }
}

const t0 = Date.now()
const log = parse(log_path)
console.log('# Лог:', log_path, '—', ((Date.now() - t0) / 1000).toFixed(1), 'с на разбор')

const version = get_version_and_board(log)
console.log('version:', JSON.stringify(version))
const msgs = log.get('MSG', 'Message') ?? []
console.log('MSG (первые 25):')
for (const m of msgs.slice(0, 25)) console.log('   ', m)

const params = log_params(log)
const kind = vehicle_kind(version.build_type, params)
const profile = vehicle_profile(kind)
console.log('kind:', kind)
const info = log_info(log, version, profile)
const vibe = vibe_summary(log)
const checks = run_checks(info, params, vibe)
console.log('info:', JSON.stringify(info, (k, v) => (Array.isArray(v) && v.length > 20) ? `[${v.length}]` : v, 1).slice(0, 4000))
console.log('Проверки шага 0:')
for (const c of checks) console.log(`   [${c.status}] ${c.title ?? c.id}: ${c.text ?? ''}`.slice(0, 600))

// Режимы
const mode_names = (kind === 'copter') ? { 0: 'STABILIZE', 1: 'ACRO', 2: 'ALT_HOLD', 3: 'AUTO', 4: 'GUIDED', 5: 'LOITER', 6: 'RTL', 9: 'LAND', 16: 'POSHOLD', 17: 'BRAKE', 22: 'FLOWHOLD' }
    : { 0: 'MANUAL', 2: 'STABILIZE', 5: 'FBWA', 10: 'AUTO', 11: 'RTL', 12: 'LOITER', 17: 'QSTABILIZE', 18: 'QHOVER', 19: 'QLOITER', 20: 'QLAND', 21: 'QRTL', 22: 'QAUTOTUNE', 23: 'QACRO' }
if ('MODE' in log.messageTypes) {
    const mt = log.get('MODE', 'TimeUS'), mm = log.get('MODE', 'Mode')
    const tend = log.get('ATT', 'TimeUS')
    const last = tend[tend.length - 1] * 1e-6
    console.log('Режимы:')
    for (let i = 0; i < mt.length; i++) {
        const a = mt[i] * 1e-6, b = (i + 1 < mt.length) ? mt[i + 1] * 1e-6 : last
        console.log(`    ${a.toFixed(1)}–${b.toFixed(1)} с (${(b - a).toFixed(1)} с): ${mm[i]} ${mode_names[mm[i]] ?? ''}`)
    }
}

console.log('Частоты сообщений:')
for (const name of ['PIDR', 'PIDP', 'PIDY', 'PIQR', 'PIQP', 'PIQY', 'RATE', 'ATT', 'ANG', 'CTUN', 'QTUN', 'RCIN', 'GYR', 'IMU', 'ISBH', 'ESC', 'RPM', 'VIBE', 'BAT', 'GPS']) {
    const r = rate_hz(log, name)
    if (r != null) console.log(`    ${name}: ${JSON.stringify(r)}`)
}

// Параметры, важные для шага 4 и подготовки
const P = params_map(log)
const want = /^(ACRO_|ATC_RAT_|ATC_ANG_|ATC_INPUT_TC|ATC_RATE_FF_ENAB|ATC_ACC|Q_A_RAT_|Q_A_ANG|Q_A_ACC|Q_A_INPUT|Q_A_RATE_FF|Q_ACRO|Q_ENABLE|Q_TAILSIT_ENABLE|Q_FRAME|Q_M_THST_HOVER|Q_M_HOVER_LEARN|MOT_THST_HOVER|MOT_HOVER_LEARN|LOG_BITMASK|LOG_FILE_BUFSIZE|LOG_BACKEND|INS_LOG_BAT|INS_RAW_LOG|INS_GYRO_FILTER|INS_HNTCH_(ENABLE|MODE|OPTS|FREQ|BW|REF|HMNCS)|INS_HNTC2_(ENABLE|MODE|FREQ)|FLTMODE|SCHED_LOOP_RATE|FSTRATE|AUTOTUNE_AXES|QWIK_ENABLE|FRAME_CLASS|FRAME_TYPE)/
console.log('Параметры:')
for (const [k, v] of [...P].filter(([k]) => want.test(k)).sort()) console.log(`    ${k} = ${+v.toFixed(6)}`)

// Сравнение параметров с другими логами / файлами .param
for (const other of compare_paths) {
    let Q
    if (other.endsWith('.param')) {
        Q = new Map()
        for (const line of fs.readFileSync(other, 'utf8').split(/\r?\n/)) {
            const m = line.trim().match(/^([A-Z0-9_]+)[,\s]+(-?[0-9.eE+-]+)/)
            if (m) Q.set(m[1], parseFloat(m[2]))
        }
    } else {
        Q = params_map(parse(other))
    }
    const diff = []
    for (const [k, v] of P) if (Q.has(k) && Math.abs(Q.get(k) - v) > 1e-6 * Math.max(1, Math.abs(v))) diff.push(`${k}: ${+Q.get(k).toFixed(6)} → ${+v.toFixed(6)}`)
    console.log(`Отличия от ${path.basename(other)} (было → в новом логе), ${diff.length}:`)
    for (const d of diff.sort()) console.log('    ' + d)
    const only_new = [...P.keys()].filter((k) => !Q.has(k)).length
    console.log(`    (только в новом логе — ${only_new} имён, только в сравниваемом — ${[...Q.keys()].filter((k) => !P.has(k)).length})`)
}
