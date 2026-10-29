// Загрузка данных гироскопа и FFT. Без DOM: работает в браузере и под Node (тесты).
// Перенос из FilterReview/FilterReview.js (upstream 05d6177) построчно, чтобы будущие изменения
// FilterReview переносились диффом. Источники: run_batch_fft (277–352), clear_calculation и calculate
// (779–891), find_start_index/find_end_index (1031–1056), load_from_batch и load_from_raw_log
// (2051–2344), части load (2375–2443, 2546–2572, 2619–2652).
//
// Замены относительно upstream (слева — FilterReview, справа — здесь):
//   глобал Gyro_batch                               → аргумент gyro (массив по экземплярам с полями сводки)
//   find_start_index(time) / find_end_index(time)   → find_start_index(time, range) / find_end_index(time, range), range = [t0, t1]
//   document.getElementById("FFTWindow_size"/"FFTWindow_per_batch") → opts.window_size / opts.window_per_batch
//   alert(msg)                                      → warnings.push(msg) или возвращаемое поле error
//   get_param_value(PARM, name, allow_change)       → params.get(name). Upstream брал первое значение параметра
//                                                     и предупреждал о смене в полёте; здесь берётся последнее,
//                                                     а смена INS_LOG_BAT_OPT / INS_RAW_LOG_OPT даёт предупреждение
//   decode_devid(ID, DEVICE_TYPE_IMU)               → без замены: оба — глобалы страницы из Libraries/DecodeDevID.js,
//                                                     вызов под охраной typeof decode_devid
// Дефекты upstream 1, 2, 3, 5 исправлены в задаче 8 (docs/plans/2026-10-24-tune-wizard-stage2.md) после регрессионной
// сверки с FilterReview; места помечены комментариями «исправление дефекта upstream N (FR …)». Ожидаемые расхождения
// с FilterReview — в docs/plans/2026-10-24-tune-wizard-stage2-design.md, раздел 2.
//
// Нужны глобалы страницы: FFTJS (modules/fft.js), Libraries/Array_Math.js, Libraries/fft.js,
// decode_devid и DEVICE_TYPE_IMU (Libraries/DecodeDevID.js) и US2S (core/log.js).

// Пройти по массиву времени и вернуть последний индекс до начала диапазона
function find_start_index(time, range) {
    const start_time = range[0]

    var start_index = 0
    for (let j = 0; j<time.length; j++) {
        // Двигаем начальный индекс вперёд, пока время меньше начала диапазона
        if (time[j] < start_time) {
            start_index = j
        }
    }
    return start_index
}

// Пройти по массиву времени и вернуть первый индекс после конца диапазона
function find_end_index(time, range) {
    const end_time = range[1]

    var end_index = 0
    for (let j = 0; j<time.length-1; j++) {
        // Двигаем конечный индекс вперёд, пока время не больше конца диапазона
        if (time[j] <= end_time) {
            end_index = j + 1
        }
    }
    return end_index
}

// FFT по всем пакетам одного экземпляра гироскопа.
// opts = { type: "batch" | "raw", window_per_batch, window_size }
function run_batch_fft(data_set, opts) {
    const num_batch = data_set.length
    const num_points = data_set[0].x.length

    // исправление дефекта upstream 1 (FR 284, 296–315): размер окна определяется до усреднения частоты.
    // В upstream window_size объявлен ниже через var, при усреднении он ещё undefined, и пакеты короче окна
    // в среднюю частоту попадали

    // Перекрытие окон жёстко 50 %
    const window_overlap = 0.5

    var window_size
    if (opts.type == "batch") {
        // Хотя бы одно окно
        const window_per_batch = Math.max(parseInt(opts.window_per_batch), 1)

        // Размер окна по числу окон на пакет и перекрытию
        window_size = Math.floor(num_points / (1 + (window_per_batch - 1)*(1-window_overlap)))

    } else {
        window_size = parseInt(opts.window_size)

    }

    if (!Number.isInteger(Math.log2(window_size))) {
        throw new Error("Размер окна FFT должен быть степенью двойки")
    }

    var sample_rate_sum = 0
    var sample_rate_count = 0
    for (let i=0;i<num_batch;i++) {
        if (data_set[i].x.length < window_size) {
            // Участок лога слишком короткий, пропускаем
            continue
        }
        sample_rate_count++
        // исправление дефекта upstream 1 (FR 289): частота каждого пакета, а не первого (data_set[0])
        sample_rate_sum += data_set[i].sample_rate
    }
    if (sample_rate_count == 0) {
        // Все пакеты короче окна: окон не будет, но бины и сетка бодэ должны остаться числами, поэтому средняя —
        // по всем пакетам (в upstream такого случая не было: при усреднении пакеты не пропускались)
        for (let i=0;i<num_batch;i++) {
            sample_rate_count++
            sample_rate_sum += data_set[i].sample_rate
        }
    }

    // Средний период дискретизации
    const sample_time = sample_rate_count / sample_rate_sum

    const window_spacing = Math.round(window_size * (1 - window_overlap))
    const windowing_function = hanning(window_size)

    // Поправочные коэффициенты окна — пригодятся при построении графиков
    const window_correction = window_correction_factors(windowing_function)

    // Частотные бины
    var bins = rfft_freq(window_size, sample_time)

    const fft = new FFTJS(window_size)

    var x = []
    var y = []
    var z = []

    var time = []

    for (let i=0;i<num_batch;i++) {
        if (data_set[i].x.length < window_size) {
            // Участок лога слишком короткий, пропускаем
            continue
        }
        var ret = run_fft(data_set[i], ["x", "y", "z"], window_size, window_spacing, windowing_function, fft)

        time.push(...array_offset(array_scale(ret.center, sample_time), data_set[i].sample_time))

        for (let j=0; j<ret.x.length; j++) {
            x.push(complex_abs(ret.x[j]))
            y.push(complex_abs(ret.y[j]))
            z.push(complex_abs(ret.z[j]))
        }

    }

    return { bins: bins, time: time, average_sample_rate: 1/sample_time, window_size: window_size, correction: window_correction, x: x, y: y, z: z}
}

// Сбросить FFT, чтобы следующий gyro_fft пересчитал всё (при смене размера окна)
function clear_gyro_fft(gyro) {
    if (gyro == null) {
        return
    }

    for (let i = 0; i < gyro.length; i++) {
        if (gyro[i] == null) {
            continue
        }
        gyro[i].FFT = null
    }
}

// Пересчитать все FFT. opts = { window_size, window_per_batch }.
// Возвращает { changed, warnings }. Интерполяцию трекинга по окнам FFT (в upstream здесь вызывался
// tracking_methods[j].interpolate) делает interpolate_tracking из core/filters.js, а подпись «частота/разрешение» — fft_info.
function gyro_fft(gyro, opts) {
    const warnings = []

    let changed = false
    let valid_count = 0
    for (let i = 0; i < gyro.length; i++) {
        if (gyro[i] == null) {
            continue
        }
        if (gyro[i].FFT == null) {
            gyro[i].FFT = run_batch_fft(gyro[i], { type: gyro.type, window_size: opts.window_size, window_per_batch: opts.window_per_batch })
            changed = true
            valid_count += gyro[i].FFT.x.length
        }
    }
    if (!changed) {
        return { changed: changed, warnings: warnings }
    }
    if (valid_count == 0) {
        warnings.push("Недостаточно непрерывных данных IMU")
    }

    // Предрасчёт для фильтров: ускоряет смену их параметров
    for (let i = 0; i < gyro.length; i++) {
        if ((gyro[i] == null) || (gyro[i].FFT == null)) {
            continue
        }

        if (!gyro[i].post_filter) {
            // Z для передаточной функции
            // Z = e^jw
            const Z = exp_jw(gyro[i].FFT.bins, gyro[i].FFT.average_sample_rate)

            // Z^-1
            gyro[i].FFT.Z1 = complex_inverse(Z)

            // Z^-2
            gyro[i].FFT.Z2 = complex_inverse(complex_square(Z))
        }

        if (!gyro[i].post_filter || !gyro.have_post) {
            // Ещё одна, более частая сетка частот — для красивого бодэ
            // Шаг нужен мелкий, чтобы развёртка фазы вышла верной
            const freq_step = 0.05
            const max_freq = gyro[i].FFT.bins[gyro[i].FFT.bins.length  - 1]

            gyro[i].FFT.bode = []
            gyro[i].FFT.bode.freq = array_from_range(0, max_freq, freq_step)

            // Z для передаточной функции
            // Z = e^jw
            const bode_Z = exp_jw(gyro[i].FFT.bode.freq, gyro[i].FFT.average_sample_rate)

            // Z^-1
            gyro[i].FFT.bode.Z1 = complex_inverse(bode_Z)

            // Z^-2
            gyro[i].FFT.bode.Z2 = complex_inverse(complex_square(bode_Z))
        }
    }

    return { changed: changed, warnings: warnings }
}

// Сведения о FFT по номеру сенсора: { sample_rate, resolution, window_size } (средние по экземплярам pre/post).
// Upstream писал их в подписи Gyro*_FFT_infoA/B и подставлял размер окна в поле FFTWindow_size.
function fft_info(gyro) {
    const info = {}
    for (let i = 0; i < 3; i++) {
        let sample_rate = 0
        let window_size = 0
        let count = 0
        for (let j = 0; j < gyro.length; j++) {
            if ((gyro[j] == null) || (gyro[j].sensor_num != i) || (gyro[j].FFT == null)) {
                continue
            }
            sample_rate += gyro[j].FFT.average_sample_rate
            window_size += gyro[j].FFT.window_size
            count++
        }
        if (count == 0) {
            continue
        }
        sample_rate /= count
        window_size /= count

        info[i] = { sample_rate: sample_rate, resolution: sample_rate/window_size, window_size: window_size }
    }
    return info
}

// Загрузка из сообщений batch-логирования (ISBH/ISBD). Результат пишется в переданный пустой массив gyro
function load_from_batch(log, gyro, num_gyro, gyro_rate, params, warnings) {
    gyro.type = "batch"

    // Модель шума квантования как белого шума
    // https://en.wikipedia.org/wiki/Quantization_(signal_processing)#Quantization_noise_model
    // См. также Analog Devices:
    // "Taking the Mystery out of the Infamous Formula, "SNR = 6.02N + 1.76dB," and Why You Should Care"
    // 16 здесь — разрядность batch-лога
    gyro.quantization_noise = 1 / (Math.sqrt(3) * 2**(16-0.5))

    // Раскладываем пакеты по сенсорам
    // Интересует только гироскоп
    const IMU_SENSOR_TYPE_GYRO = 1
    let data_index = 0
    let max_instance = 0

    const ISBH = log.get("ISBH")
    const ISBD = log.get("ISBD")

    // Пропущенные повреждённые пакеты (исправление дефекта upstream 3). missing_batches — заголовки подряд, для которых
    // нет ни одного сообщения ISBD: они засчитываются в пропущенные, только если данные дальше продолжаются, — заголовки
    // без данных в самом конце лога (лог оборвался после заголовка) ожидаемы и предупреждения не дают
    let skipped_batches = 0
    let missing_batches = 0

    for (let i = 0; i < ISBH.N.length; i++) {
        // Разбор заголовков
        if (ISBH.type[i] != IMU_SENSOR_TYPE_GYRO) {
            continue
        }

        const instance = ISBH.instance[i]
        if (gyro[instance] == null) {
            gyro[instance] = []
            max_instance = Math.max(max_instance, instance)
        }

        let decode_complete = false

        // Сдвигаем индекс данных до совпадения номера последовательности
        const seq_num = ISBH.N[i]
        const search_start = data_index
        let not_found = false
        while (ISBD.N[data_index] != seq_num) {
            data_index++
            if (data_index >= ISBD.N.length) {
                // Ожидаемо в конце лога: сообщений больше нет (в upstream без скобок — строка минус число давала NaN)
                console.log("Could not find next sequence " + i + " of " + (ISBH.N.length-1))
                // исправление дефекта upstream 3 (FR 2087–2095): upstream здесь прекращал разбор, и если сообщений ISBD
                // этого пакета нет вовсе, а дальше лог продолжается, все следующие пакеты молча терялись. Поиск
                // возвращается к своему началу, заголовок пропускается
                data_index = search_start
                not_found = true
                break
            }
        }
        if (not_found) {
            missing_batches++
            continue
        }
        // Данные продолжаются: заголовки без сообщений перед этим пакетом — повреждение посреди лога
        skipped_batches += missing_batches
        missing_batches = 0

        let x = []
        let y = []
        let z = []
        const num_samples = ISBH.smp_cnt[i]
        const num_data_msg = num_samples / 32
        let bad_batch = false
        for (let j = 0; j < num_data_msg; j++) {
            // Читаем ожидаемое число отсчётов
            if ((ISBD.N[data_index] != seq_num) || (ISBD.seqno[data_index] != j)) {
                console.log("Missing or extra data msg")
                // исправление дефекта upstream 3 (FR 2109): ранний return оставлял gyro недостроенным — без pre/post,
                // частот и времени. Пакет пропускается; несовпавшее сообщение не съедено, и поиск следующего пакета
                // начнётся с него
                bad_batch = true
                break
            }

            // Копим данные этого пакета
            x.push(...ISBD.x[data_index])
            y.push(...ISBD.y[data_index])
            z.push(...ISBD.z[data_index])

            data_index++
            if (data_index >= ISBD.N.length) {
                // исправление дефекта upstream 5 (FR 2118–2122): пакет, дочитанный целиком на последнем сообщении
                // лога (j+1 == num_data_msg), полный и сохраняется; неполным считается только оборванный
                if (j + 1 < num_data_msg) {
                    console.log("Sequence incomplete " + i + " of " + (ISBH.N.length-1) + ", Got " + (j+1) + " batches out of " + num_data_msg)
                    decode_complete = true
                }
                break
            }
        }
        if (decode_complete) {
            break
        }
        if (bad_batch) {
            skipped_batches++
            continue
        }

        if ((x.length != num_samples) || (y.length != num_samples) || (z.length != num_samples)) {
            console.log("sample length wrong")
            // исправление дефекта upstream 3 (FR 2130): вместо раннего return пакет пропускается
            skipped_batches++
            continue
        }

        // Снимаем масштаб логирования
        const mul = 1 / ISBH.mul[i]
        x = array_scale(x, mul)
        y = array_scale(y, mul)
        z = array_scale(z, mul)

        // Добавляем к пакетам этого экземпляра
        gyro[instance].push({ sample_time: ISBH.SampleUS[i] * US2S,
                              sample_rate: ISBH.smp_rate[i],
                              x: x,
                              y: y,
                              z: z })
    }
    if (skipped_batches > 0) {
        warnings.push("Batch-лог: пропущено повреждённых пакетов (недостающие или лишние сообщения ISBD, неверное число отсчётов) — " + skipped_batches)
    }

    // Убираем экземпляры без данных
    for (let i = 0; i < gyro.length; i++) {
        if (gyro[i]?.length === 0) {
            gyro[i] = null
        }
    }

    // Определяем по параметру, логирование до или после фильтров
    if (params.changed("INS_LOG_BAT_OPT")) {
        warnings.push("Параметр INS_LOG_BAT_OPT менялся в полёте: взято последнее значение")
    }
    const INS_LOG_BAT_OPT = params.get("INS_LOG_BAT_OPT")
    const _doing_sensor_rate_logging = (INS_LOG_BAT_OPT & (1 << 0)) != 0
    const _doing_post_filter_logging = (INS_LOG_BAT_OPT & (1 << 1)) != 0
    const _doing_pre_post_filter_logging = (INS_LOG_BAT_OPT & (1 << 2)) != 0
    let use_instance_offset = _doing_pre_post_filter_logging || (_doing_post_filter_logging && _doing_sensor_rate_logging)

    if (!use_instance_offset && (max_instance >= num_gyro)) {
        warnings.push("В логе есть экземпляры pre/post, а INS_LOG_BAT_OPT это не задаёт: считаем pre/post")
        use_instance_offset = true
    }

    for (let i = 0; i < gyro.length; i++) {
        if (gyro[i] == null) {
            continue
        }
        if (use_instance_offset && (i >= num_gyro)) {
            gyro[i].sensor_num = i - num_gyro
            gyro[i].post_filter = true
        } else {
            gyro[i].sensor_num = i
            gyro[i].post_filter = _doing_post_filter_logging && !_doing_pre_post_filter_logging
        }

        // Пока поддерживаем только 3 IMU
        if (gyro[i].sensor_num >= 3) {
            gyro[i] = null
        }
    }

    // Считаем, что частота дискретизации всегда выше частоты логирования
    var max_logging_rate = []
    for (let i = 0; i < gyro.length; i++) {
        if (gyro[i] == null) {
            continue
        }
        for (let j = 0; j < gyro[i].length; j++) {
            if ((max_logging_rate[gyro[i].sensor_num] == null) || (gyro[i][j].sample_rate > max_logging_rate[gyro[i].sensor_num])) {
                max_logging_rate[gyro[i].sensor_num] = gyro[i][j].sample_rate
            }
        }
    }
    for (let i = 0; i < gyro.length; i++) {
        if (gyro[i] == null) {
            continue
        }
        gyro[i].gyro_rate = max_logging_rate[gyro[i].sensor_num]
        if (gyro_rate[gyro[i].sensor_num] != null) {
            // Частота не ниже заявленной частоты дискретизации
            gyro[i].gyro_rate = Math.max(gyro_rate[gyro[i].sensor_num], gyro[i].gyro_rate)
        }
    }

    // Полный диапазон времени пакетов
    var start_time
    var end_time
    for (let i = 0; i < gyro.length; i++) {
        if (gyro[i] == null) {
            continue
        }

        const batch_start = gyro[i][0].sample_time
        if ((start_time == null) || (batch_start < start_time)) {
            start_time = batch_start
        }

        const batch_end = gyro[i][gyro[i].length - 1].sample_time
        if ((end_time == null) || (batch_end > end_time)) {
            end_time = batch_end
        }
    }
    if ((start_time != null) && (end_time != null)) {
        gyro.start_time = start_time
        gyro.end_time = end_time
    }
}

// Загрузка из raw-логирования сенсора (GYR). Результат пишется в переданный пустой массив gyro
function load_from_raw_log(log, gyro, num_gyro, gyro_rate, params, warnings) {
    gyro.type = "raw"

    // Шум квантования 32-битного float такой же, как у 24-битного целого (длина мантиссы),
    // но он относителен уровню сигнала.
    // Уровень сигнала неизвестен, поэтому оценить шум нельзя.
    // Можно было бы пройти по всем данным и взять максимум, но пока считаем шум нулевым.
    gyro.quantization_noise = 0.0

    // Определяем по параметру, логирование до или после фильтров
    if (params.changed("INS_RAW_LOG_OPT")) {
        warnings.push("Параметр INS_RAW_LOG_OPT менялся в полёте: взято последнее значение")
    }
    const INS_RAW_LOG_OPT = params.get("INS_RAW_LOG_OPT")
    let post_filter = (INS_RAW_LOG_OPT != null) && ((INS_RAW_LOG_OPT & (1 << 2)) != 0)
    const pre_post_filter = (INS_RAW_LOG_OPT != null) && ((INS_RAW_LOG_OPT & (1 << 3)) != 0)
    if (post_filter && pre_post_filter) {
        warnings.push("В INS_RAW_LOG_OPT заданы одновременно логирование post и pre+post")
        post_filter = false
    }

    if (!("instances" in log.messageTypes.GYR)) {
        // Старый формат GYR без поля экземпляра I: upstream падал на Object.keys(undefined) (аудит, M1)
        gyro.error = "Raw-лог: в сообщении GYR нет номера экземпляра (I) — такой формат не поддерживается"
        return
    }

    // Грузим одним большим пакетом, разрезая на больших разрывах лога
    for (const inst of Object.keys(log.messageTypes.GYR.instances)) {
        const i = parseFloat(inst)

        gyro[i] = []

        if (pre_post_filter && (i >= num_gyro)) {
            gyro[i].sensor_num = i - num_gyro
            gyro[i].post_filter = true
        } else {
            gyro[i].sensor_num = i
            gyro[i].post_filter = post_filter
        }

        // Пока поддерживаем только 3 IMU
        if (gyro[i].sensor_num >= 3) {
            gyro[i] = null
            continue
        }

        const time = log.get_instance("GYR", inst, "SampleUS")
        const GyrX = log.get_instance("GYR", inst, "GyrX")
        const GyrY = log.get_instance("GYR", inst, "GyrY")
        const GyrZ = log.get_instance("GYR", inst, "GyrZ")

        let sample_rate_sum = 0
        let sample_rate_count = 0
        let batch_start = 0
        let count = 0
        const len = time.length
        for (let j = 1; j < len; j++) {
            // Скользящее среднее периода; режем на пакеты по разрывам.
            // Порог — 5 средних интервалов, накопленных к этому моменту:
            // новый пакет начнётся после двух пропущенных сообщений
            count++
            if (((time[j] - time[j-1])*count) > ((time[j] - time[batch_start]) * 5) || (j == (len - 1))) {
                if (count >= 64) {
                    // В пакете должно быть не меньше 64 отсчётов
                    const sample_rate = 1000000 / ((time[j-1] - time[batch_start]) / count)
                    sample_rate_sum += sample_rate
                    sample_rate_count++

                    // исправление дефекта upstream 2 (FR 2295–2297): срез до j для всех экземпляров. В upstream
                    // slice(batch_start, j-i), где i — номер экземпляра гироскопа; для экземпляра 0 это то же, что здесь
                    gyro[i].push({ sample_time: time[batch_start] * US2S,
                                   sample_rate: sample_rate,
                                   x: GyrX.slice(batch_start, j),
                                   y: GyrY.slice(batch_start, j),
                                   z: GyrZ.slice(batch_start, j) })
                }

                // Следующий пакет начинается отсюда
                batch_start = j
                count = 0
            }

        }

        if (gyro[i].length == 0) {
            // Пригодных пакетов нет, убираем
            delete gyro[i]
            continue
        }

        // Для FFT считаем частоту дискретизации постоянной
        const sample_rate = sample_rate_sum / sample_rate_count
        gyro[i].gyro_rate = sample_rate
        if (gyro_rate[i] != null) {
            // Частота не ниже заявленной частоты дискретизации
            gyro[i].gyro_rate = Math.max(gyro_rate[i], gyro[i].gyro_rate)
        }

    }

    var start_time
    var end_time
    for (let i = 0; i < gyro.length; i++) {
        if (gyro[i] == null) {
            continue
        }
        const batch_start = gyro[i][0].sample_time
        if ((start_time == null) || (batch_start < start_time)) {
            start_time = batch_start
        }

        const last_batch = gyro[i].length - 1
        const batch_end = gyro[i][last_batch].sample_time + (gyro[i][last_batch].x.length / gyro[i][last_batch].sample_rate)
        if ((end_time == null) || (batch_end > end_time)) {
            end_time = batch_end
        }
    }
    if ((start_time != null) && (end_time != null)) {
        gyro.start_time = start_time
        gyro.end_time = end_time
    }
}

// Загрузка гироскопа из лога: часть load() из FilterReview без DOM.
// env = { params (log_params), filter_version, build_type }, opts = { log_type: "batch" | "raw" | null }.
// Возвращает массив gyro по экземплярам (как Gyro_batch в upstream) с полями:
// type, quantization_noise, start_time, end_time, have_pre, have_post, num_gyro, gyro_rate[],
// gyro_info[] ({ name, bus_type, rate }), warnings[], error (строка или null);
// primary — номер первичного сенсора по AHRS_EKF_TYPE/EK3_PRIMARY, если для него есть данные, иначе null (FR 2546–2572);
// first_gyro — первый сенсор с данными. Сенсор по умолчанию для спектрограммы и бодэ — primary ?? first_gyro (FR 2674–2677).
function load_gyro(log, env, opts = {}) {
    const params = env.params
    const warnings = []

    // Пробуем раскодировать ID устройств и частоты
    var num_gyro = 0
    var gyro_rate = []
    var gyro_info = []
    for (let i = 0; i < 3; i++) {
        const ID_param = i == 0 ? "INS_GYR_ID" : "INS_GYR" + (i + 1) + "_ID"
        const ID = params.get(ID_param)
        if ((ID != null) && (ID > 0)) {
            const decoded = (typeof decode_devid === "function") ? decode_devid(ID, DEVICE_TYPE_IMU) : null

            if (("IMU" in log.messageTypes) && ("instances" in log.messageTypes.IMU) && (i in log.messageTypes.IMU.instances)) {
                // Считаем частоту постоянной: на деле это не так, но переменная частота ломает усреднение FFT
                gyro_rate[i] = array_mean(log.get_instance("IMU", i, "GHz"))
            }

            if (decoded != null) {
                gyro_info[i] = { name: decoded.name, bus_type: decoded.bus_type, rate: gyro_rate[i] ?? null }
            } else {
                gyro_info[i] = { name: "IMU", bus_type: null, rate: gyro_rate[i] ?? null }
            }
            num_gyro++
        }
    }

    // Результат: массив по экземплярам с полями сводки; загрузчики заполняют его как Gyro_batch в upstream
    const gyro = []
    gyro.type = null
    gyro.have_pre = false
    gyro.have_post = false
    gyro.primary = null
    gyro.first_gyro = null
    gyro.num_gyro = num_gyro
    gyro.gyro_rate = gyro_rate
    gyro.gyro_info = gyro_info
    gyro.warnings = warnings
    gyro.error = null

    // Проверяем, есть ли данные, с которыми можно работать
    const have_batch_log = ("ISBH" in log.messageTypes) && ("ISBD" in log.messageTypes)
    const have_raw_log = ("GYR" in log.messageTypes)

    if (!have_batch_log && !have_raw_log) {
        gyro.error = "В логе нет ни raw (GYR), ни batch (ISBH/ISBD) данных гироскопа"
        return gyro
    }

    // Выбираем тип лога
    var use_batch
    if (have_batch_log && !have_raw_log) {
        // Есть только batch-лог
        use_batch = true

    } else if (have_raw_log && !have_batch_log) {
        // Есть только raw-лог
        use_batch = false

    } else {
        // Есть оба: по выбору; без выбора — raw, как умолчание переключателя FilterReview
        use_batch = opts.log_type == "batch"
    }

    if (use_batch) {
        load_from_batch(log, gyro, num_gyro, gyro_rate, params, warnings)

    } else {
        load_from_raw_log(log, gyro, num_gyro, gyro_rate, params, warnings)

    }

    // Загрузчик мог отказаться от формата (GYR без экземпляров)
    if (gyro.error != null) {
        return gyro
    }

    // Сообщения в логе могут быть, а данных в них — нет
    if (gyro.start_time == undefined || gyro.end_time == undefined) {
        gyro.error = "В логе нет пригодных данных гироскопа"
        return gyro
    }

    // Пробуем определить первичный сенсор
    let primary_gyro = 0
    const AHRS_EKF_TYPE = params.get("AHRS_EKF_TYPE")
    const EK3_PRIMARY = params.get("EK3_PRIMARY")
    if ((AHRS_EKF_TYPE == 3) && (EK3_PRIMARY != null) && (EK3_PRIMARY >= 0) && (EK3_PRIMARY <= 2)) {
        primary_gyro = EK3_PRIMARY
    }

    // Убеждаемся, что для первичного сенсора есть данные
    let have_primary = false
    for (let i = 0; i < gyro.length; i++) {
        if (gyro[i] == null) {
            continue
        }
        if (gyro[i].sensor_num == primary_gyro) {
            have_primary = true
            break
        }
    }
    if (!have_primary) {
        primary_gyro = null
    }

    // Какие данные есть: до фильтров, после, первый сенсор с данными (upstream включал здесь флажки сенсоров)
    var first_gyro
    gyro.have_pre = false
    gyro.have_post = false
    for (let i = 0; i < gyro.length; i++) {
        if (gyro[i] == null) {
            continue
        }

        // Какие сенсоры есть — для спектрограммы
        if (first_gyro == null || (gyro[i].sensor_num < first_gyro)) {
            first_gyro = gyro[i].sensor_num
        }
        if (gyro[i].post_filter == false) {
            gyro.have_pre = true
        } else {
            gyro.have_post = true
        }
    }

    gyro.primary = primary_gyro
    gyro.first_gyro = first_gyro ?? null

    return gyro
}
