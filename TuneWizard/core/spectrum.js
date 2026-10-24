// Средний спектр, сворачивание алиасинга, матрица спектрограммы и линии трекинга notch. Без DOM:
// работает в браузере и под Node (тесты).
// Перенос из FilterReview/FilterReview.js (upstream 05d6177) построчно, чтобы будущие изменения FilterReview
// переносились диффом. Источники: get_amplitude_scale и get_frequency_scale (957–971), get_alias_obj (973–1028),
// среднее по окнам внутри redraw (1131–1182), find_instance (1466–1475), данные спектрограммы внутри
// redraw_Spectrogram (1517–1577) и линии трекинга там же (1581–1671, включая внутренний build_plot_array).
//
// Замены относительно upstream (слева — FilterReview, справа — здесь):
//   глобал Gyro_batch                                     → аргумент gyro
//   глобалы filters, logged_tracking                      → аргументы filters, logged
//   глобалы amplitude_scale, frequency_scale              → аргумент amplitude_scale; масштаб частоты (frequency_scale.fun)
//                                                           накладывает вызывающая сторона: bins и freq здесь всегда в герцах
//   радио ScaleLog/ScalePSD, freq_Scale_RPM/freq_ScaleLog → spectrum_amplitude_scale(mode), spectrum_frequency_scale(unit, log_axis)
//   радио Aliasing_none / Aliasing_on / Aliasing_only     → opts.mode: "none" | "fold" | "only"
//   поле SCHED_LOOP_RATE                                  → opts.loop_rate
//   радио SpecGyroInst*/SpecGyroPost/SpecGyroEstPost/SpecGyroAxis* → аргументы batch_instance (из find_instance), estimated, axis
//   флажки SpecNotch…Show, SpecNotchShowLogged            → убраны: видимость линий решает вызывающая сторона
//   get_alias_obj(FFT) внутри циклов                      → аргумент alias (результат alias_obj)
//   find_start_index(time) / find_end_index(time)         → (time, range), range = [t0, t1] (core/gyro.js)
//   записи в Plotly (fft_plot.data[…], Spectrogram.data[…]) → возвращаемые объекты
//   max_num_harmonics                                     → MAX_NUM_HARMONICS (core/filters.js)
//
// Нужны глобалы страницы: Libraries/Array_Math.js, Libraries/fft.js (fft_amplitude_scale, fft_frequency_scale),
// core/gyro.js (find_start_index, find_end_index) и core/filters.js (MAX_NUM_HARMONICS).

// Шкала амплитуды по режиму "linear" | "dB" | "PSD": объект fft_amplitude_scale из Libraries/fft.js
// (fun, scale, hover, window_correction, quantization_correction) с русской подписью оси
function spectrum_amplitude_scale(mode) {
    const ret = fft_amplitude_scale(mode === "dB", mode === "PSD")
    if (mode === "PSD") {
        ret.label = "PSD, дБ/Гц"
    } else if (mode === "dB") {
        ret.label = "Амплитуда, дБ"
    } else {
        ret.label = "Амплитуда"
    }
    return ret
}

// Шкала частоты по единице "Hz" | "RPM" и признаку логарифмической оси: объект fft_frequency_scale
// из Libraries/fft.js (fun, hover, type) с русской подписью оси
function spectrum_frequency_scale(unit, log_axis) {
    const ret = fft_frequency_scale(unit === "RPM", log_axis)
    ret.label = (unit === "RPM") ? "Обороты, RPM" : "Частота, Гц"
    return ret
}

// Помощник сворачивания алиасинга к частоте контура (get_alias_obj в upstream).
// opts = { mode: "none" | "fold" | "only", loop_rate } — loop_rate это SCHED_LOOP_RATE, Гц.
// Возвращает { len, bins, apply_amp(amp) }: bins — частоты результата в герцах, apply_amp переводит амплитуды
// по бинам FFT к bins: "none" — как есть, "fold" — спектр до частоты Найквиста контура плюс отражённый в него
// остаток, "only" — только отражённый остаток. Объект привязан к этому FFT (в none bins — это FFT.bins, в fold/only
// интерполяция — к его частоте и окну), поэтому mean_spectrum и spectrogram_matrix получают alias от того же FFT.
// null, если FFT нет или окон нет
function alias_obj(FFT, opts) {
    // Без FFT или без окон строить нечего: redraw и redraw_Spectrogram в upstream пропускали такие экземпляры до вызова
    if ((FFT == null) || (FFT.x.length == 0)) {
        return null
    }

    let obj = {}
    if (opts.mode == "none") {
        // Без алиасинга: возвращаем переданные значения как есть
        obj.len = FFT.x[0].length
        obj.bins = FFT.bins
        obj.apply_amp = function(x) { return x }
        return obj
    }

    const nyquist = opts.loop_rate * 0.5

    // Пересчитываем частоты на новую сетку, чтобы сворачивать было просто
    // Массив от 0 до частоты Найквиста контура, последняя точка — ровно на ней
    // Шаг мельче, чтобы интерполяция не теряла амплитуду
    obj.len = Math.ceil(nyquist / (0.1*(FFT.average_sample_rate/FFT.window_size))) + 1
    const re_sample_dt = (nyquist / (obj.len-1))
    obj.bins = new Array(obj.len)
    for (let i = 0; i<obj.len; i++) {
        obj.bins[i] = i * re_sample_dt
    }

    // Заранее считаем индексы и коэффициенты линейной интерполяции
    const total_bins = Math.floor(FFT.bins[FFT.bins.length-1]/re_sample_dt)
    let interp = {index: new Array(total_bins), scale: new Array(total_bins)}
    let index = 0
    for (let i = 0; i<total_bins; i++) {
        const bin = i * re_sample_dt
        if (bin > FFT.bins[index+1]) {
            index += 1
        }
        interp.index[i] = index
        interp.scale[i] = (bin - FFT.bins[index]) / (FFT.bins[index+1] - FFT.bins[index])
    }

    // Интерполируем на новые бины и сворачиваем вниз
    const start = (opts.mode == "only") ? obj.len : 0
    obj.apply_amp = function (amp) {
        let ret = new Array(obj.len).fill(0)
        const reflect_len = (obj.len-1) * 2
        for (let i = start; i<total_bins; i++) {
            // Интерполяция амплитуды на новые бины
            const pre_amp = amp[interp.index[i]]
            const post_amp = amp[interp.index[i]+1]
            const lerp_amp = pre_amp + (post_amp - pre_amp) * interp.scale[i]

            // Сворачиваем вниз
            const index = Math.abs(i - reflect_len * Math.round(i/reflect_len))
            ret[index] += lerp_amp
        }
        return ret
    }

    return obj
}

// Средний спектр экземпляра по окнам FFT в диапазоне range = [t0, t1] (часть redraw в upstream).
// alias строится alias_obj(FFT, …) от того же FFT: в режиме none bins — это FFT.bins, а в fold/only интерполяция
// привязана к частоте и окну этого FFT.
// Возвращает { bins: alias.bins, x, y, z } — амплитуды по осям уже с поправкой окна, после alias.apply_amp
// и amplitude_scale.scale; null, если FFT нет или окон нет. Частоты bins в герцах
function mean_spectrum(FFT, amplitude_scale, range, alias) {
    if ((FFT == null) || (FFT.x.length == 0)) {
        return null
    }

    // Начальный и конечный индексы
    const start_index = find_start_index(FFT.time, range)
    const end_index = find_end_index(FFT.time, range)+1

    // Среднее от начала до конца
    const fft_len = FFT.x[0].length
    var fft_mean_x = (new Array(fft_len)).fill(0)
    var fft_mean_y = (new Array(fft_len)).fill(0)
    var fft_mean_z = (new Array(fft_len)).fill(0)
    for (let j=start_index;j<end_index;j++) {
        // Добавляем к сумме для среднего
        fft_mean_x = array_add(fft_mean_x, amplitude_scale.fun(FFT.x[j]))
        fft_mean_y = array_add(fft_mean_y, amplitude_scale.fun(FFT.y[j]))
        fft_mean_z = array_add(fft_mean_z, amplitude_scale.fun(FFT.z[j]))
    }

    // Число усреднённых окон
    const mean_length = end_index - start_index

    // Поправка амплитуды окна зависит от выбранного спектра и разрешения
    const FFT_resolution = FFT.average_sample_rate/FFT.window_size
    const window_correction = amplitude_scale.window_correction(FFT.correction, FFT_resolution)

    // Применяем поправку окна и делим на число окон — среднее
    const corrected_x = array_scale(fft_mean_x, window_correction / mean_length)
    const corrected_y = array_scale(fft_mean_y, window_correction / mean_length)
    const corrected_z = array_scale(fft_mean_z, window_correction / mean_length)

    // Сворачиваем алиасинг и применяем выбранный масштаб
    return { bins: alias.bins,
             x: amplitude_scale.scale(alias.apply_amp(corrected_x)),
             y: amplitude_scale.scale(alias.apply_amp(corrected_y)),
             z: amplitude_scale.scale(alias.apply_amp(corrected_z)) }
}

// Индекс экземпляра gyro с посчитанным FFT по номеру сенсора и признаку post_filter;
// undefined, если такого нет (как в upstream: вызывающая сторона проверяет == null)
function find_instance(gyro, sensor_num, post_filter) {
    for (let i = 0; i < gyro.length; i++) {
        if ((gyro[i] == null) || (gyro[i].FFT == null) || (gyro[i].FFT.x.length == 0)) {
            continue
        }
        if ((gyro[i].post_filter == post_filter) && (gyro[i].sensor_num == sensor_num)) {
            return i
        }
    }
}

// Матрица спектрограммы экземпляра batch_instance по оси axis ("x" | "y" | "z") — данные Spectrogram.data[0]
// из redraw_Spectrogram в upstream. estimated — оценка «после» по данным «до» через FFT.H.
// alias строится alias_obj(gyro[batch_instance].FFT, …) от того же FFT: в режиме none bins — это FFT.bins,
// а в fold/only интерполяция привязана к частоте и окну этого FFT.
// Возвращает { x, bins, z }: x — время окон в секундах с двумя дополнительными точками на каждый разрыв
// (шаг больше 2.5 среднего), bins = alias.bins в герцах, z[j] — строка амплитуд окна j после поправки окна,
// alias.apply_amp, amplitude_scale.fun и amplitude_scale.scale; строки разрывов — массивы undefined,
// Plotly рисует их пустыми. null, если экземпляра или FFT нет либо для оценки нет FFT.H.
// Контракт графика (как в upstream, FR 689): heatmap с transpose: true, x = spec.x, y = frequency_scale.fun(spec.bins),
// z = spec.z — строка z[j] соответствует времени x[j]
function spectrogram_matrix(gyro, batch_instance, axis, estimated, amplitude_scale, alias) {
    if ((batch_instance == null) || (gyro[batch_instance] == null) || (gyro[batch_instance].FFT == null) || (gyro[batch_instance].FFT.x.length == 0)) {
        return null
    }
    if (estimated && (gyro[batch_instance].FFT.H == null)) {
        return null
    }

    // Частоты и время (в upstream x и y поменяны местами флагом transpose)
    const bins = alias.bins
    const x = []

    // Ищем разрывы и добавляем пустые точки
    const time_len = gyro[batch_instance].FFT.time.length
    let count = 0
    let last_time = gyro[batch_instance].FFT.time[0]
    let section_start = gyro[batch_instance].FFT.time[0]
    let skip_flag = []
    for (let j = 0; j < time_len; j++) {
        count++
        const this_time = gyro[batch_instance].FFT.time[j]
        const this_dt = this_time - last_time
        // upstream: в среднем шаге участок считается вместе с первым окном (count включает его, а интервалов на один
        // меньше) и вместе с самим разрывом — поэтому точки разрыва отступают от соседних окон на завышенный шаг
        const average_dt = (this_time - section_start) / count

        if (this_dt > average_dt * 2.5) {
            // Добавляем разрыв
            count = 0
            // Разрыв начинается там, где ожидалось следующее окно
            x.push(last_time + average_dt)
            skip_flag.push(true)

            // Разрыв кончается там, где ожидалось предыдущее окно
            x.push(this_time - average_dt)
            skip_flag.push(true)

            section_start = this_time
        }

        x.push(this_time)
        skip_flag.push(false)
        last_time = this_time
    }

    // Поправка амплитуды окна зависит от выбранного спектра
    const FFT_resolution = gyro[batch_instance].FFT.average_sample_rate/gyro[batch_instance].FFT.window_size
    const window_correction = amplitude_scale.window_correction(gyro[batch_instance].FFT.correction, FFT_resolution)

    // Матрица z
    const len = x.length
    const num_bins = bins.length
    const z = new Array(len)
    let index = 0
    for (let j = 0; j<len; j++) {
        if (skip_flag[j] == true) {
            // Пустые значения z дают пустой участок на графике
            z[j] = new Array(num_bins)
            continue
        }

        // upstream: поправка окна наложена до amplitude_scale.fun, а в mean_spectrum и estimate_post (core/filters.js) —
        // после. Для linear и dB это одно и то же выражение (и с вычитанием шума квантования тоже), а для PSD fun
        // возводит в квадрат, и строка спектрограммы ровно на 10·log10(window_correction) выше среднего спектра
        var amplitude = array_scale(gyro[batch_instance].FFT[axis][index], window_correction)
        if (estimated) {
            const attenuation = complex_abs(gyro[batch_instance].FFT.H[index])
            amplitude = array_offset(array_mul(array_offset(amplitude, -gyro.quantization_noise), attenuation), gyro.quantization_noise)
        }
        z[j] = amplitude_scale.scale(amplitude_scale.fun(alias.apply_amp(amplitude)))
        index++
    }

    return { x: x, bins: bins, z: z }
}

// Линии трекинга notch для спектрограммы (данные линий из redraw_Spectrogram в upstream): для каждого notch
// { enabled, name, harmonics: [{ harmonic, time, freq }], logged: [{ harmonic, time, freq }] }.
// name — имя источника трекинга (upstream подписывал группу "Notch N: имя"); у выключенного notch name null,
// списки пусты. time — секунды, freq — герцы по гармоникам: у notch не ниже get_min_freq(harmonic), у логированных
// без ограничения (как в upstream). При трекинге нескольких пиков линии склеены через NaN, чтобы не рисовать
// возврат к началу. logged[i].harmonics задаёт вызывающая сторона из filters.notch[i].harmonics() (upstream FR 2586),
// иначе логированных линий нет. range принят для симметрии с notch_line_stats: upstream не ограничивает линии
// диапазоном, и здесь они тоже строятся по всему логу
function tracking_lines(filters, logged, range) {
    const lines = []
    for (let i=0;i<filters.notch.length;i++) {

        // Фильтр не настроен
        if (!filters.notch[i].enabled()) {
            lines.push({ enabled: false, name: null, harmonics: [], logged: [] })
            continue
        }

        function build_plot_array(fundamental) {
            let time
            let freq
            const time_array = Array.isArray(fundamental.time[0])
            if (!Array.isArray(fundamental.freq[0])) {
                // Один пик
                time = fundamental.time
                freq = fundamental.freq

            } else {
                // Трекинг нескольких пиков
                time = []
                freq = []

                for (let j=0;j<fundamental.freq.length;j++) {
                    time = time.concat(time_array ? fundamental.time[j] : fundamental.time)
                    freq = freq.concat(fundamental.freq[j])

                    // NaN разрывает линию, чтобы она не возвращалась с конца к началу
                    time.push(NaN)
                    freq.push(NaN)
                }

            }
            return { time, freq }
        }

        let fundamental = filters.notch[i].get_target_freq()
        let plot_data = build_plot_array(fundamental)

        // Каждая гармоника
        const harmonics = []
        for (let j=0;j<MAX_NUM_HARMONICS;j++) {
            if ((filters.notch[i].harmonics() & (1<<j)) == 0) {
                continue
            }
            const harmonic = j + 1
            const harmonic_freq = array_scale(plot_data.freq, harmonic)

            const min_freq = filters.notch[i].get_min_freq(harmonic)
            for (let n=0;n<harmonic_freq.length;n++) {
                harmonic_freq[n] = Math.max(harmonic_freq[n], min_freq)
            }

            harmonics.push({ harmonic: harmonic, time: plot_data.time, freq: harmonic_freq })
        }

        // Логированный notch
        const logged_lines = []
        if (logged[i].have_data()) {
            fundamental = logged[i].get_target_freq()
            plot_data = build_plot_array(fundamental)

            for (let j=0;j<MAX_NUM_HARMONICS;j++) {
                if ((logged[i].harmonics & (1<<j)) == 0) {
                    continue
                }
                const harmonic_freq = array_scale(plot_data.freq, j+1)

                logged_lines.push({ harmonic: j+1, time: plot_data.time, freq: harmonic_freq })
            }
        }

        lines.push({ enabled: true, name: filters.notch[i].name(), harmonics: harmonics, logged: logged_lines })
    }

    return lines
}
