// Загрузка сообщений PID (PIDR/PIDP/PIDY или RATE), FFT компонент и отклик на ступеньку. Без DOM: работает
// в браузере и под Node (тесты). Перенос из PIDReview/PIDReview.js (upstream 05d6177) построчно, чтобы будущие
// изменения PIDReview переносились диффом. Источники: fft_keys (7), run_batch_fft (9–92), clear_calculation (505–523),
// redraw_step (1031–1209), get_PID_param_names (1310–1373), split_into_batches (1378–1434), части load (1437–1710):
// 1453–1476, 1497–1637, 1662–1684. Только Copter (build_type 2).
//
// Замены относительно upstream (слева — PIDReview, справа — здесь):
//   fft_keys                                        → PID_FFT_KEYS
//   run_batch_fft(data_set), окно из поля FFTWindow_size → pid_run_batch_fft(data_set, window_size);
//                                                     alert + throw при окне не степени двойки → throw new Error(текст)
//   clear_calculation() при смене окна (onchange поля) → сброс FFT наборов в начале pid_run_batch_fft: окно приходит
//                                                     аргументом, и расчёт с прежним окном не должен остаться у наборов,
//                                                     где окон нового размера нет
//   get_PID_param_names(prefix)                     → pid_param_names(prefix)
//   split_into_batches(PID_log_messages, index, time) → pid_split_into_batches(pids, index, time); накопители
//                                                     sample_rate_sum/sample_rate_count (1393–1394, 1413–1414) не
//                                                     использовались и убраны: у мастера их ловит no-unused-vars
//   load(log_file) — парсинг, DOM, alert            → load_pid(log, env) → { axes, start_time, end_time, have_data, warnings }:
//                                                     лог уже разобран (объект парсера, как у load_gyro); import_done,
//                                                     DataflashParser, reset(), open_in_update(log), график полёта
//                                                     (flight_data), поля TimeStart/TimeEnd, setup_axis() и замер времени
//                                                     убраны; axes — массив как PID_log_messages (PIDR/P/Y, затем RATE R/P/Y)
//                                                     с полями have_data, start_time, end_time; start_time/end_time — границы
//                                                     данных без округления (upstream округлял их для полей TimeStart/TimeEnd)
//   get_version_and_board(log).build_type           → env.build_type; ветви Rover (1) и Plane (3) убраны — мастер только для Copter
//   const US2S и TimeUS_to_seconds внутри load     → глобал US2S и us_to_s из core/log.js (как на этапе 2)
//   calculate() в конце load (FFT всех осей)        → не вызывается: FFT считает вызывающий — pid_run_batch_fft(axis.sets, window_size)
//                                                     по осям с have_data (как calculate, 526–537)
//   find_start_index(time) / find_end_index(time)   → find_start_index(time, range) / find_end_index(time, range) из core/gyro.js,
//                                                     range = [t0, t1]: логика та же (PIDReview 557–582 построчно совпадает
//                                                     с FilterReview 1031–1056, отличие только в источнике границ)
//   redraw_step() — расчёт и запись в step_plot.data → pid_step_response(axis, set_index, range) → { time, windows, mean } | null:
//                                                     ось — аргумент вместо get_axis_index(), один набор set_index вместо
//                                                     цикла по наборам, окна — массивы шага вместо трассы «все» с NaN между
//                                                     окнами, mean — трасса «среднее»; null, если окон нет (нет данных оси,
//                                                     FFT, набора или годных окон) — upstream в этих случаях не рисовал
//                                                     новое среднее (и мог оставить прежнее, см. дефект 7)
//   PID_log_messages.have_data в redraw_step        → axis.have_data
//   alert(msg)                                      → warnings.push(msg)
//
// Дефекты upstream — найдены при переносе, НЕ исправлены (перенос воспроизводит PIDReview для теста сравнения);
// исправляет задача 4 плана docs/plans/2026-10-25-tune-wizard-stage4.md:
//   1. split_into_batches (1401–1403, 1427): отсчёты до начала набора (time < set_start) пропускаются без сдвига
//      batch_start. Когда параметры меняются повторно быстрее чем за 1 с после первой смены (load, 1545–1549), начало
//      нового набора переносится на последнюю смену, и между наборами остаётся разрыв «без набора». Отсчёты этого
//      разрыва (до 1 с данных при промежуточных значениях параметров) всё равно попадают в первый пакет нового набора,
//      а его частота занижена в (длина пакета)/(длина − разрыв) раз: count не считает пропущенные отсчёты, а время
//      от batch_start их включает (смены в 10 и 10.9 с при 400 Гц: пакет набора 1 начинается в 10.0025 с, частота
//      364 Гц); порог разрыва в этом пакете тоже завышен. Проявится только при быстрой повторной смене PID в полёте.
//   2. split_into_batches + load (1412, 1417, 1597–1614): batch_end = j − 1, а slice(batch_start, batch_end) не включает
//      конец — последний отсчёт перед разрывом теряется (в конце лога — два). Частота пакета count / (time[j−1] −
//      time[batch_start]) — count отсчётов на count − 1 интервалов, завышена в count / (count − 1) раз: на 64 отсчётах
//      на 1.6 %, на пакетах не короче окна 512 — не больше 0.2 %. Значения частот бинов FFT завышены (ось частот
//      растянута), а ось времени отклика сжата в те же count / (count − 1) раз.
//   3. redraw_step (1129–1130): find_start_index/find_end_index применяются к времени окон каждого пакета отдельно.
//      Пакет целиком вне интервала всё равно даёт одно окно (до интервала — последнее, после — первое), если цель в нём
//      больше 20 °/с; у FilterReview время окон сквозное, и так выходит только на краях всех данных. Сам PIDReview
//      непоследователен: его спектр (redraw, 893–894) применяет find_* к сквозному set.FFT.time. Проявится, если
//      у набора есть пакеты вне интервала (разрывы лога, несколько полётов).
//   4. redraw_step (1082–1106, 1157): шумовая добавка винеровской оценки 0.1 (до ~25 Гц) … 1e8 взята из PID-Analyzer,
//      где спектры ненормированные (np.fft.fft), а run_fft нормирует их на 1/N. Относительно спектров добавка в N² раз
//      сильнее (при окне 512 — в 262 144 раза) и зависит от амплитуды цели в °/с и от окна: при плавных манёврах средний
//      отклик занижен и замедлен, при смене размера окна меняется не только разрешение. Синтетика «первый порядок
//      τ 50 мс + задержка 20 мс»: t63 при окне 512 — 79 мс при амплитуде ×0.3, 68 мс при ×1, 65 мс при ×10; при окне
//      256 и ×10 — 48 мс. Простое «как в PID-Analyzer» (добавка × 1/N²) не годится: на логе пользователя среднее
//      уходит к 3.4 у крена (пик 4.06), 3.4 у тангажа (пик 4.05), 2.2 у рыскания (пик 2.45).
//   5. redraw_step (1083–1100): при частоте данных ниже 100 Гц (25 Гц выше четверти частоты) len_lpf больше real_len —
//      шумовая оценка выходит за массив, отражение для отрицательных частот сдвигается, H несимметрична (берётся
//      действительная часть обратного FFT); при частоте не выше 50 Гц findIndex даёт −1, добавка 1e8 на всех частотах
//      и отклик нулевой (синтетика 40 Гц — 0.000). Касается и PIDR/PIDP/PIDY, и RATE: без бита ATTITUDE_FAST
//      в LOG_BITMASK Copter пишет их с частотой 10 Гц (ArduCopter/Copter.cpp, ten_hz_logging_loop), а заводская маска —
//      без ATTITUDE_FAST (ArduCopter/config.h, DEFAULT_LOG_BITMASK: ATTITUDE_MED и PID). На логе с заводскими
//      настройками основной путь PIDR даёт нулевой отклик.
//   6. load (1511, 1525): без сообщений PARM в логе log.get('PARM') не определён и загрузка падает с TypeError вместо
//      сообщения «нет данных».
//   7. Только интерфейс upstream, в переносе не воспроизводится: redraw_step очищает лишь трассы «все» (1046–1049),
//      трассу среднего — нет, а «Calculate» (re_calc, 492–498) не вызывает setup_FFT_data. При пересчёте с другим
//      интервалом или окном набор без годных окон (и случай valid_sets == 0, 1051–1053) продолжает показывать прежнее
//      среднее.
//
// Свойство метода (не дефект переноса, так же в PID-Analyzer): H сглажена шумовой добавкой ядром с нулевой фазой,
// а отклик интегрируется с момента 0, поэтому доля ядра «до нуля» теряется. При Act = Tar среднее выходит на
// 0.5 + h[0]/2, где h[0] ≈ доля спектра ниже 25 Гц (2·25 Гц / частота) — ≈0.56 при 400 Гц; у первого порядка без
// задержки (τ 50 мс) — на ≈0.85 и медленнее; с задержкой 20 мс — на 0.86–0.88 при верном t63. На логе пользователя
// (окно 512, 49–540 с) плато среднего — 0.73 у крена и тангажа, 0.61 у рыскания (максимум 0.63): метрикам
// «относительно 1» (перерегулирование, установление; задача 5) это нужно учитывать.
//
// Нужны глобалы страницы: FFTJS (modules/fft.js), Libraries/Array_Math.js, Libraries/fft.js, US2S и us_to_s
// (core/log.js), find_start_index и find_end_index (core/gyro.js).

// Ключи данных пакета, по которым считается FFT
const PID_FFT_KEYS = ["Tar", "Act", "Err", "P", "I", "D", "FF", "DFF", "Out"]

// FFT по всем пакетам всех наборов оси. data_set — axis.sets (массив наборов параметров, у набора — массив пакетов).
// Пишет FFT каждого набора (set.FFT = { time, Tar, Act, …: комплексные спектры окон }) и общее
// data_set.FFT = { bins, average_sample_rate, window_size, correction }; если нет ни одного пакета длиной не меньше
// окна, data_set.FFT остаётся null. Перекрытие окон — 50 %.
function pid_run_batch_fft(data_set, window_size) {

    // Сброс прежнего расчёта (в upstream — clear_calculation при смене окна)
    for (const set of data_set) {
        if (set != null) {
            set.FFT = null
        }
    }
    data_set.FFT = null

    // Размер окна — аргументом (в upstream — из поля формы)
    window_size = parseInt(window_size)
    if (!Number.isInteger(Math.log2(window_size))) {
        throw new Error("Размер окна FFT должен быть степенью двойки")
    }

    const num_sets = data_set.length

    // Перекрытие окон жёстко 50 %
    const window_overlap = 0.5
    const window_spacing = Math.round(window_size * (1 - window_overlap))

    // Оконная функция и поправочные коэффициенты — пригодятся при построении графиков
    const windowing_function = hanning(window_size)
    const window_correction = window_correction_factors(windowing_function)

    // Библиотека FFT
    const fft = new FFTJS(window_size)

    // Средний период дискретизации
    var sample_rate_sum = 0
    var sample_rate_count = 0
    for (let j=0; j<num_sets; j++) {
        if (data_set[j] == null) {
            continue
        }
        const num_batch = data_set[j].length
        for (let i=0;i<num_batch;i++) {
            if (data_set[j][i][PID_FFT_KEYS[0]].length < window_size) {
                // Участок лога слишком короткий, пропускаем
                continue
            }
            sample_rate_count++
            sample_rate_sum += data_set[j][i].sample_rate
        }
    }

    if (sample_rate_sum == 0) {
        // Данных не хватает ни на одно окно
        return
    }

    const sample_time = sample_rate_count / sample_rate_sum

    for (let j=0; j<num_sets; j++) {
        if (data_set[j] == null) {
            continue
        }
        let have_data = false
        const num_batch = data_set[j].length
        for (let i=0;i<num_batch;i++) {
            if (data_set[j][i].Tar.length < window_size) {
                // Участок лога слишком короткий, пропускаем
                continue
            }
            const valid_keys = PID_FFT_KEYS.filter(key => data_set[j][i][key] != null)
            var ret = run_fft(data_set[j][i], valid_keys, window_size, window_spacing, windowing_function, fft)

            // Заводим массивы
            if (!have_data) {
                have_data = true
                data_set[j].FFT = { time: [] }
                for (const key of PID_FFT_KEYS) {
                    data_set[j].FFT[key] = []
                }
            }

            data_set[j].FFT.time.push(...array_offset(array_scale(ret.center, sample_time), data_set[j][i].time[0]))
            for (const key of valid_keys) {
                data_set[j].FFT[key].push(...ret[key])
            }
        }
    }

    // Бины и прочее полезное
    data_set.FFT = { bins: rfft_freq(window_size, sample_time),
                     average_sample_rate: 1/sample_time,
                     window_size: window_size,
                     correction: window_correction }

}

// Отклик на ступеньку набора set_index оси axis (элемент load_pid().axes) за интервал range = [t0, t1], с.
// Перед вызовом нужен pid_run_batch_fft(axis.sets, window_size): размер окна и частота берутся из axis.sets.FFT
// (как в upstream — из PID.sets.FFT), без FFT ни у одного набора результат null.
// Метод PID-Analyzer: окна размером FFT с шагом 1/16 окна; в окне, где цель (с оконной функцией) не меньше 20 °/с, —
// винеровская оценка H = S_yx / (S_xx + шум), шум — гауссиана с частотой 25 Гц; обратное FFT и интегрирование;
// первые 0.5 с. → { time: [с], windows: [[отклик окна]], mean: [средний отклик] }; null, если окон нет.
function pid_step_response(PID, set_index, range) {
    if ((PID == null) || !PID.have_data) {
        return null
    }

    // FFT пересчитывается заново, но с тем же окном — исходный FFT годится для проверки, есть ли данные
    const num_sets = PID.sets.length
    var valid_sets = 0
    for (let i = 0; i < num_sets; i++) {
        if ((PID.sets[i] != null) && (PID.sets[i].FFT != null)) {
            valid_sets += 1
        }
    }
    if (valid_sets == 0) {
        return null
    }

    // Библиотека FFT; размер окна и частота — из исходного FFT
    const window_size = PID.sets.FFT.window_size
    const real_len = real_length(window_size)
    const fft = new FFTJS(window_size)
    var transfer_function = fft.createComplexArray()
    var impulse_response = fft.createComplexArray()

    // Оконная функция
    const windowing_function = hanning(window_size)

    // Большое перекрытие, чтобы использовать данные полнее. Для верной амплитуды по набору нужно 50 %,
    // но амплитуда здесь не используется, поэтому перекрытие больше допустимо
    const window_spacing = Math.round(window_size / 16)

    // Только первые 0.5 с отклика
    const sample_time = 1 / PID.sets.FFT.average_sample_rate
    const step_end_index = Math.min(Math.ceil(0.5 / sample_time), window_size)

    // Массив времени
    var time = new Array(step_end_index)
    for (let j=0;j<step_end_index;j++) {
        time[j] = j * sample_time
    }

    // Оценка шума
    // Размер гауссианы — по частоте среза 25 Гц
    const cutfreq = 25
    var len_lpf = PID.sets.FFT.bins.findIndex((x) => x > cutfreq)
    len_lpf += len_lpf - 2 // с учётом двустороннего спектра: DC и Найквист не копируются
    const radius = Math.ceil(len_lpf * 0.5)
    const sigma = len_lpf / 6.0

    // Свёртка гауссианы с единичной ступенькой — её интеграл
    var sn = (new Array(real_len)).fill(1.0)
    var last_sn = 0
    for (let j=0;j<len_lpf;j++) {
        sn[j] = last_sn + Math.exp((-0.5/sigma**2) * (j-radius)**2)
        last_sn = sn[j]
    }
    // Нормируем к 1
    for (let j=0;j<len_lpf;j++) {
        sn[j] /= last_sn
    }
    // Отражаем на весь спектр
    sn = [...sn, ...sn.slice(1,real_len-1).reverse()]

    // Масштаб
    sn = array_scale(array_offset(array_scale(sn, -1.0), 1+1e-9), 10.0)

    // Обратная величина — заранее
    sn = array_inverse(sn)

    // Запрошенный набор (в upstream — цикл по всем наборам)
    const j = set_index
    if (PID.sets[j] == null) {
        return null
    }
    const num_batch = PID.sets[j].length

    var windows = []
    var mean = null
    var Step_mean = (new Array(step_end_index)).fill(0)
    var mean_count = 0
    for (let i=0;i<num_batch;i++) {
        if (PID.sets[j][i].Tar.length < window_size) {
            // Участок лога слишком короткий, пропускаем
            continue
        }

        // FFT цели и факта
        const FFT_res = run_fft(PID.sets[j][i], ["Tar", "Act"], window_size, window_spacing, windowing_function, fft, true)
        const fft_time = array_offset(array_scale(FFT_res.center, sample_time), PID.sets[j][i].time[0])

        // Начальный и конечный индексы
        const start_index = find_start_index(fft_time, range)
        const end_index = find_end_index(fft_time, range)+1

        for (let k=start_index;k<end_index;k++) {

            // Пропускаем окна с малой амплитудой цели
            // Порог 20 °/с
            if (FFT_res.TarMax[k] < 20.0) {
                continue
            }

            // Расчёт отклика на ступеньку взят из PID-Analyzer/PIDtoolbox
            // https://github.com/Plasmatree/PID-Analyzer
            // https://github.com/bw1129/PIDtoolbox
            // Другие ссылки, которые могут пригодиться:
            // https://en.wikipedia.org/wiki/Wiener_filter
            // https://en.wikipedia.org/wiki/Ridge_regression#Relation_to_singular-value_decomposition_and_Wiener_filter
            // Numerical Recipes, Linear Regularization Methods, http://numerical.recipes/
            // Impact force reconstruction using the regularized Wiener filter method, https://www.tandfonline.com/doi/full/10.1080/17415977.2015.1101760

            const X = to_double_sided(FFT_res.Tar[k])
            const Y = to_double_sided(FFT_res.Act[k])

            const Xcon = complex_conj(X)
            const Pyx = complex_mul(Y, Xcon)
            var Pxx = complex_mul(X, Xcon)

            // Добавляем оценку шума
            Pxx[0] = array_add(Pxx[0], sn)

            const H = complex_div(Pyx, Pxx)

            // Передаточная функция в формате fft.js (чередование действительной и мнимой частей)
            to_fft_format(transfer_function, H)

            // Обратное FFT
            fft.inverseTransform(impulse_response, transfer_function)

            // Интегрируем импульсную характеристику — получаем отклик на ступеньку
            var step = new Array(step_end_index)
            step[0] = impulse_response[0]
            for (let l=1;l<step_end_index;l++) {
                // Только действительная часть
                step[l] = step[l - 1] + impulse_response[l*2]
            }

            // В среднее
            mean_count += 1
            Step_mean = array_add(Step_mean, step)

            // В окна (в upstream — в трассу «все», окна через NaN)
            windows.push(step)
        }

        if (mean_count <= 0) {
            // Годных окон пока нет, следующий пакет
            continue
        }

        // Среднее (как в upstream — пересчитывается после каждого пакета, итог — среднее по всем окнам набора)
        mean = array_scale(Step_mean, 1 / mean_count)
    }

    if (mean == null) {
        // Годных окон нет — upstream ничего не рисовал
        return null
    }

    return { time: time, windows: windows, mean: mean }
}

// Имена параметров регулятора по префиксу (например, "ATC_RAT_RLL_")
function pid_param_names(prefix) {
    return {
        KP: {
            title: "KP",
            name: prefix + "P",
            decimalPlaces: 4,
        },
        KI: {
            title: "KI",
            name: prefix + "I",
            decimalPlaces: 4,
        },
        KD: {
            title: "KD",
            name: prefix + "D",
            decimalPlaces: 4,
        },
        FF: {
            title: "KFF",
            name: prefix + "FF",
            decimalPlaces: 4,
        },
        D_FF: {
            title: "KDFF",
            name: prefix + "D_FF",
            decimalPlaces: 4,
        },
        I_max: {
            title: "I Max",
            name: prefix + "IMAX",
            decimalPlaces: 4,
        },
        Target_filter: {
            title: "Target Filter (Hz)",
            name: prefix + "FLTT",
            decimalPlaces: 4,
        },
        Notch_target: {
            title: "Target Notch Index",
            name: prefix + "NTF",
            decimalPlaces: 0,
        },
        Error_filter: {
            title: "Error Filter (Hz)",
            name: prefix + "FLTE",
            decimalPlaces: 4,
        },
        Notch_error: {
            title: "Error Notch Index",
            name: prefix + "NEF",
            decimalPlaces: 0,
        },
        D_filter: {
            title: "D Filter (Hz)",
            name: prefix + "FLTD",
            decimalPlaces: 4,
        },
        Slew_max: {
            title: "Slew Max",
            name: prefix + "SMAX",
            decimalPlaces: 4,
        }
    }
}

// По массиву времени вернуть точки разреза данных лога:
// разрез при любой смене параметров и при любом пропуске данных.
// → [{ param_set, sample_rate, batch_start, batch_end }]; пишет start_time/end_time оси pids[index] и общие pids.start_time/end_time
function pid_split_into_batches(pids, index, time) {

    let ret = []
    const len = time.length

    // Начало и конец данных
    pids[index].start_time = time[0]
    pids[index].end_time = time[len - 1]
    if ((pids.start_time == null) || (pids[index].start_time < pids.start_time)) {
        pids.start_time = pids[index].start_time
    }
    if ((pids.end_time == null) || (pids[index].end_time > pids.end_time)) {
        pids.end_time = pids[index].end_time
    }

    // sample_rate_sum/sample_rate_count upstream копил, но не использовал — убраны (no-unused-vars)
    let batch_start = 0
    let count = 0
    let param_set = 0
    let set_start = pids[index].params.sets[0].start_time
    let set_end = pids[index].params.sets[0].end_time
    for (let j = 1; j < len; j++) {
        if (time[j] < set_start) {
            continue
        }
        // Скользящее среднее периода; режем на пакеты по разрывам.
        // Порог — 5 средних интервалов, накопленных к этому моменту:
        // новый пакет начнётся после двух пропущенных сообщений
        count++
        const past_set_end = time[j] > set_end
        if (((time[j] - time[j-1])*count) > ((time[j] - time[batch_start]) * 5) || (j == (len - 1)) || past_set_end) {
            if (count >= 64) {
                // В пакете должно быть не меньше 64 отсчётов
                const sample_rate = 1 / ((time[j-1] - time[batch_start]) / count)

                // В пакеты
                ret.push({param_set: param_set, sample_rate: sample_rate, batch_start: batch_start, batch_end: j-1})
            }
            if (past_set_end) {
                // Переходим к следующему набору
                param_set++
                set_start = pids[index].params.sets[param_set].start_time
                set_end = pids[index].params.sets[param_set].end_time
            }

            // Следующий пакет начинается отсюда
            batch_start = j
            count = 0
        }

    }

    return ret
}

// Загрузка сообщений PID из разобранного лога (объект парсера: messageTypes, get(name, field)) — часть load()
// из PIDReview без DOM. env = { build_type } (тип сборки из VER.BU; поддерживается только Copter, 2).
// → { axes, start_time, end_time, have_data, warnings }. axes — массив как PID_log_messages: PIDR, PIDP, PIDY, затем
// RATE R/P/Y; у оси — id, prefixes, unitScale, units, have_data, params = { prefix, sets: [{ start_time, end_time,
// KP, KI, KD, FF, D_FF, I_max, … }] } (наборы параметров: новый — при смене любого параметра оси, смены в пределах
// 1 с после первой сливаются), start_time/end_time и sets — пакеты по наборам: sets[номер набора] = [{ time (с),
// sample_rate, Tar, Act (°/с), Out, у PID ещё Err (°/с), P, I, D, FF, DFF (null без поля DFF) }] или пусто.
// Выход у PID — P + I + D + FF + DFF, у RATE — ROut. FFT не считается: pid_run_batch_fft(axis.sets, window_size).
function load_pid(log, env) {
    const warnings = []

    // Тип аппарата (в upstream — get_version_and_board(log))
    const build_type = env.build_type

    // Набор сообщений PID для типа аппарата
    const rad2deg = 180.0 / Math.PI
    const degUnits = "deg /s"
    var PID_log_messages
    switch (build_type) {
        // Rover (1) и Plane (3) в upstream есть; мастер — только для Copter

        case 2: // Copter
            PID_log_messages = [
                {id: ["PIDR"],      prefixes: ["ATC_RAT_RLL_"], unitScale: rad2deg, units: degUnits },
                {id: ["PIDP"],      prefixes: ["ATC_RAT_PIT_"], unitScale: rad2deg, units: degUnits },
                {id: ["PIDY"],      prefixes: ["ATC_RAT_YAW_"], unitScale: rad2deg, units: degUnits },
                {id: ["RATE", "R"], prefixes: ["ATC_RAT_RLL_"], unitScale: rad2deg, units: degUnits },
                {id: ["RATE", "P"], prefixes: ["ATC_RAT_PIT_"], unitScale: rad2deg, units: degUnits },
                {id: ["RATE", "Y"], prefixes: ["ATC_RAT_YAW_"], unitScale: rad2deg, units: degUnits }
            ]
            break

        default:
            warnings.push("Тип аппарата не поддерживается: разбор PID — только для Copter")
            return { axes: [], start_time: null, end_time: null, have_data: false, warnings: warnings }
    }


    // Флаги «нет данных»
    PID_log_messages.have_data = false
    for (let i = 0; i < PID_log_messages.length; i++) {
        PID_log_messages[i].have_data = false
    }

    // Параметры; разрез при любой их смене
    const PARM = log.get('PARM')
    for (let i = 0; i < PID_log_messages.length; i++) {
        PID_log_messages[i].params = { prefix: null, sets: [] }
        for (const prefix of PID_log_messages[i].prefixes) {

            const names = pid_param_names(prefix)

            let param_values = { start_time: 0 }
            for (const name in names) {
                param_values[name] = null
            }

            let found_param = false
            let last_set_end
            for (let j = 0; j < PARM.Name.length; j++) {
                const param_name = PARM.Name[j]
                for (const [key, param] of Object.entries(names)) {
                    if (param_name !== param.name) {
                        continue
                    }
                    const time = PARM.TimeUS[j] * US2S
                    const value = PARM.Value[j]
                    found_param = true
                    if (param_values[key] != null  && (param_values[key] != value)) {
                        if ((last_set_end == null) || (time - last_set_end > 1.0)) {
                            // Первая смена параметра за секунду
                            last_set_end = time

                            // Смена параметра: всё до этого момента — один набор
                            PID_log_messages[i].params.sets.push(Object.assign({}, param_values, {end_time: last_set_end}))

                            // Начало нового набора
                            param_values.start_time = time

                        } else {
                            // Совсем недавняя смена: сливаем с последним набором, между наборами остаётся разрыв
                            param_values[key] = value
                            param_values.start_time = time

                        }
                    }
                    param_values[key] = value
                    break
                }
            }
            if (found_param) {
                // Последний набор
                PID_log_messages[i].params.sets.push(Object.assign({}, param_values, {end_time: Infinity}))
                PID_log_messages[i].params.prefix = prefix
                // можно было бы закрепить префиксы за типом аппарата и ускорить поиск
                break
            }
        }
    }

    // Загружаем каждый тип сообщений
    PID_log_messages.start_time = null
    PID_log_messages.end_time = null
    for (let i = 0; i < PID_log_messages.length; i++) {
        if (PID_log_messages[i].params.prefix == null) {
            // Без параметров не загружаем
            continue
        }
        const id = PID_log_messages[i].id[0]
        if (!(id in log.messageTypes)) {
            // Сообщения нет в логе
            continue
        }
        const log_msg = log.get(id)

        const is_RATE_msg = id === "RATE"

        const time = us_to_s(log_msg.TimeUS)

        const batches = pid_split_into_batches(PID_log_messages, i, time)

        if (batches.length > 0) {
            // Загрузка по пакетам
            PID_log_messages[i].sets = []
            for (const batch of batches) {
                if (PID_log_messages[i].sets[batch.param_set] == null) {
                    PID_log_messages[i].sets[batch.param_set] = []
                }
                if (is_RATE_msg) {
                    const axis_prefix = PID_log_messages[i].id[1]
                    // Не совсем то же: PID пишет отфильтрованную цель, а RATE — исходную
                    PID_log_messages[i].sets[batch.param_set].push({ time: time.slice(batch.batch_start, batch.batch_end),
                                                                     sample_rate: batch.sample_rate,
                                                                     Tar: Array.from(log_msg[axis_prefix + "Des"].slice(batch.batch_start, batch.batch_end)),
                                                                     Act: Array.from(log_msg[axis_prefix        ].slice(batch.batch_start, batch.batch_end)),
                                                                     Out: Array.from(log_msg[axis_prefix + "Out"].slice(batch.batch_start, batch.batch_end))})

                } else {
                    // Читаем и переводим единицы
                    PID_log_messages[i].sets[batch.param_set].push({ time: time.slice(batch.batch_start, batch.batch_end),
                                                                     sample_rate: batch.sample_rate,
                                                                     Tar: array_scale(Array.from(log_msg.Tar.slice(batch.batch_start, batch.batch_end)), PID_log_messages[i].unitScale),
                                                                     Act: array_scale(Array.from(log_msg.Act.slice(batch.batch_start, batch.batch_end)), PID_log_messages[i].unitScale),
                                                                     Err: array_scale(Array.from(log_msg.Err.slice(batch.batch_start, batch.batch_end)), PID_log_messages[i].unitScale),
                                                                     P:   Array.from(log_msg.P.slice(batch.batch_start, batch.batch_end)),
                                                                     I:   Array.from(log_msg.I.slice(batch.batch_start, batch.batch_end)),
                                                                     D:   Array.from(log_msg.D.slice(batch.batch_start, batch.batch_end)),
                                                                     FF:  Array.from(log_msg.FF.slice(batch.batch_start, batch.batch_end)),
                                                                     DFF: ("DFF" in log_msg) ? Array.from(log_msg.DFF.slice(batch.batch_start, batch.batch_end)) : null,
                    })
                }
            }

            // Флаги «есть данные» (в upstream здесь включались переключатели осей)
            PID_log_messages[i].have_data = true
            PID_log_messages.have_data = true
        }
    }

    if (!PID_log_messages.have_data) {
        warnings.push("В логе не найдено сообщений PID или RATE")
        return { axes: PID_log_messages, start_time: PID_log_messages.start_time, end_time: PID_log_messages.end_time, have_data: false, warnings: warnings }
    }

    // Считаем выход
    for (var PID of PID_log_messages) {
        if (!PID.have_data) {
            continue
        }
        for (var set of PID.sets) {
            if (set == null) {
                // Для этого набора данных нет
                continue
            }
            for (var batch of set) {
                if ("Out" in batch) {
                    // У сообщения RATE выход есть в логе
                    continue
                }
                const len = batch.P.length
                batch.Out = new Array(len)
                for (let i = 0; i<len; i++) {
                    batch.Out[i] = batch.P[i] + batch.I[i] + batch.D[i] + batch.FF[i] + (batch.DFF != null ? batch.DFF[i] : 0)
                }
            }
        }
    }

    return { axes: PID_log_messages, start_time: PID_log_messages.start_time, end_time: PID_log_messages.end_time, have_data: true, warnings: warnings }
}
