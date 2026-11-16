// Четвёртый лог: параметры, от которых зависят цель и отклик (сглаживание входа, FLTT, быстрый поток), остаток модели
// «цель → факт» в % дисперсии факта и его спектр по полосам; спектр цели по полосам (насколько гладкая цель).
// Запуск: node log_spectra.cjs <репозиторий> [лог] [начало-конец]
'use strict'
const path = require('node:path')
const lib = require('./lib.cjs')
const repo = process.argv[2]
const log_path = process.argv[3] ?? path.join(repo, 'TuneWizard/logs/2 01.01.1970 2-00-00.bin')
const range = (process.argv[4] ?? '289-370').split('-').map(Number)
const { fmt } = lib

// Доли дисперсии сигналов по полосам (Уэлч, окно Ханна 512 с шагом 256 внутри отрезков)
const BANDS = [[0, 1.5], [1.5, 4], [4, 10], [10, 25], [25, 1000]]
function band_shares(pieces, key, rate) {
    const N = 512
    const w = hanning(N)
    const fft = new FFTJS(N)
    const out = fft.createComplexArray()
    const psd = new Float64Array(N / 2 + 1)
    let count = 0
    for (const p of pieces) {
        const x = p[key]
        for (let s = 0; s + N <= x.length; s += N / 2) {
            const buf = new Array(N)
            for (let i = 0; i < N; i++) buf[i] = x[s + i] * w[i]
            fft.realTransform(out, buf)
            for (let k = 0; k <= N / 2; k++) psd[k] += out[2 * k] ** 2 + out[2 * k + 1] ** 2
            count++
        }
    }
    let total = 0
    for (let k = 1; k <= N / 2; k++) total += psd[k]
    return BANDS.map(([a, b]) => {
        let s = 0
        for (let k = 1; k <= N / 2; k++) {
            const f = k * rate / N
            if (f >= a && f < b) s += psd[k]
        }
        return 100 * s / total
    })
}

async function main() {
    lib.load_core(repo, true)
    const L = await lib.load_log(log_path)
    console.log('# ' + path.basename(log_path) + ', ' + L.version.fw_string + ', интервал ' + range.join('–') + ' с')
    const names = ['SCHED_LOOP_RATE', 'FSTRATE_ENABLE', 'FSTRATE_DIV', 'ACRO_OPTIONS', 'ACRO_RP_RATE', 'ACRO_Y_RATE', 'ACRO_RP_RATE_TC', 'ACRO_Y_RATE_TC', 'ACRO_RP_EXPO',
                   'ACRO_Y_EXPO', 'ATC_INPUT_TC', 'ATC_RATE_FF_ENAB', 'ATC_ACC_R_MAX', 'ATC_ACC_P_MAX', 'ATC_ACC_Y_MAX', 'ATC_RATE_R_MAX', 'ATC_RATE_P_MAX', 'ATC_RATE_Y_MAX',
                   'ATC_RAT_RLL_P', 'ATC_RAT_RLL_I', 'ATC_RAT_RLL_D', 'ATC_RAT_RLL_FF', 'ATC_RAT_RLL_FLTT', 'ATC_RAT_RLL_FLTE', 'ATC_RAT_RLL_FLTD', 'ATC_RAT_RLL_SMAX', 'ATC_RAT_RLL_D_FF',
                   'ATC_RAT_PIT_P', 'ATC_RAT_PIT_I', 'ATC_RAT_PIT_D', 'ATC_RAT_PIT_FLTT', 'ATC_RAT_PIT_FLTE', 'ATC_RAT_PIT_FLTD', 'ATC_RAT_PIT_SMAX',
                   'ATC_RAT_YAW_P', 'ATC_RAT_YAW_I', 'ATC_RAT_YAW_D', 'ATC_RAT_YAW_FLTT', 'ATC_RAT_YAW_FLTE', 'ATC_RAT_YAW_FLTD', 'ATC_RAT_YAW_SMAX',
                   'ATC_ANG_RLL_P', 'INS_GYRO_FILTER', 'INS_GYRO_RATE', 'INS_HNTCH_ENABLE', 'INS_HNTCH_FREQ', 'INS_HNTCH_MODE', 'INS_HNTCH_OPTS', 'INS_RAW_LOG_OPT', 'LOG_BITMASK',
                   'MOT_PWM_TYPE', 'MOT_SPIN_MIN', 'MOT_THST_EXPO', 'MOT_THST_HOVER', 'ATC_THR_MIX_MAN']
    console.log('параметры: ' + names.map((n) => n + ' ' + L.params.get(n)).join(', '))

    for (const axis of ['roll', 'pitch', 'yaw']) {
        const A = lib.log_axis(L, axis, range)
        const segs = A.seg.segments.map((s) => {
            const y = lib.conv(A.fir.h, s.tar)
            const e = new Float64Array(s.tar.length)
            for (let k = 0; k < e.length; k++) e[k] = s.act[k] - y[k]
            return { tar: s.tar, act: s.act, e }
        })
        const res = lib.residual_pct(A.seg.segments, A.fir)
        const shares_e = band_shares(segs, 'e', A.rate)
        const shares_t = band_shares(segs, 'tar', A.rate)
        console.log('\n' + axis + ': частота ' + fmt(A.rate, 2) + ' Гц, данных ' + fmt(A.seg.data_s, 1) + ' с, отрезков ' + A.seg.segments.length +
                    ', остаток ' + fmt(res, 2) + ' %, FLTT набора ' + A.set.Target_filter + ', SMAX ' + A.set.Slew_max)
        console.log('  остаток по полосам ' + BANDS.map((b) => b[0] + '–' + b[1] + ' Гц').join(', ') + ': ' + shares_e.map((v) => fmt(v, 1) + ' %').join(', '))
        console.log('  цель по полосам: ' + shares_t.map((v) => fmt(v, 2) + ' %').join(', '))
        console.log('  отклик на 2.5 / 5 / 7.5 / 10 / 15 / 20 мс: ' + [1, 2, 3, 4, 6, 8].map((k) => fmt(A.fir.step[k])).join(' / ') +
                    '; h[1…6] = ' + [1, 2, 3, 4, 5, 6].map((k) => fmt(A.fir.h[k], 4)).join(', '))
    }
}
main().catch((e) => {
    console.error(e)
    process.exit(1)
})
