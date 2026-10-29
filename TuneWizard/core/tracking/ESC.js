// Трекинг по ESC.
// Перенос из FilterReview/tracking/ESC.js. Замены: get_filter_version() → this.env.filter_version;
// TimeUS_to_seconds → us_to_s; get_mean(range) принимает диапазон.
// Отличие от upstream (аудит, C1): отсчёты с нечисловыми оборотами отбрасываются при чтении (см. конструктор); экземпляр
// без единого числового отсчёта не регистрируется, а без таких экземпляров источник остаётся без данных.
class ESCTarget extends NotchTarget {
    constructor(log, env) {
        super(null, env, null, null, "ESC", 3)

        const msg = "ESC"
        if (!(msg in log.messageTypes) || !("instances" in log.messageTypes[msg])) {
            // Данных в логе нет
            return
        }

        // RPM по отдельности.
        // Прошивка пишет в ESC.RPM quiet_nanf(), когда оборотов нет (AP_ESC_Telem.cpp): такой отсчёт — «нет данных»,
        // а не ноль. В upstream NaN проходил в цель notch, и окно FFT рядом с ним давало NaN в передаточной функции,
        // откуда NaN расходился по оценке «после» и метрикам. Отсчёт (время и частота вместе) отбрасывается, как и
        // в прошивке, где недействительные обороты в цель не попадают; соседние отсчёты интерполируются через него
        for (const inst of Object.keys(log.messageTypes[msg].instances)) {
            const time_us = log.get_instance(msg, inst, "TimeUS")
            const rpm = log.get_instance(msg, inst, "RPM")
            if ((time_us == null) || (rpm == null)) {
                // Экземпляр без строк или без поля оборотов — данных нет
                continue
            }
            const time = []
            const freq = []
            // Множитель как в array_scale(RPM, 1 / 60) upstream — те же числа до последнего бита
            const scale = 1 / 60
            const len = Math.min(time_us.length, rpm.length)
            for (let j = 0; j < len; j++) {
                if (!Number.isFinite(rpm[j])) {
                    continue
                }
                time.push(time_us[j] * US2S)
                freq.push(rpm[j] * scale)
            }
            if (time.length == 0) {
                // Ни одного числового отсчёта (мотор без оборотов весь лог) — как экземпляр без строк: остальной код
                // обходит this.data[i] == null, а пустой ряд давал бы в linear_interp цель NaN во всех окнах
                continue
            }
            this.data[inst] = { time, freq }
        }
        if (this.data.length == 0) {
            // Оборотов нет ни у одного мотора — источник без данных (have_data false): load_filters выключит notch
            // с предупреждением вместо пустой цели
            return
        }

        // Общий массив отсчётов всех моторов, отсортированный по времени — для расчёта среднего на лету
        let all = []
        const len = this.data.length
        for (let i=0;i<len;i++) {
            if (this.data[i] == null) {
                continue
            }
            for (let j=0; j<this.data[i].time.length; j++) {
                all.push({time: this.data[i].time[j], freq: this.data[i].freq[j], inst: i})
            }
        }
        all.sort((a, b) => { return a.time - b.time })
        this.data.all = all
    }

    compute_avg(esc_mask) {
        const num_instances = this.data.length
        const all = this.data.all

        let avg_freq = []
        let avg_time = []
        let inst = []
        for (let i=0;i<num_instances;i++) {
            inst[i] = { freq:null, time:null }
        }

        const len = all.length
        for (let i=0;i<len;i++) {
            const instance = all[i].inst

            if (esc_mask != 0 && !(esc_mask & (1 << instance))) {
                continue
            }

            inst[instance].freq = all[i].freq
            inst[instance].time = all[i].time

            // Сбрасываем экземпляры, вышедшие по тайм-ауту
            for (let j=0;j<num_instances;j++) {
                if (esc_mask != 0 && !(esc_mask & (1 << j))) {
                    continue
                }
                if ((j != instance) && (inst[j].time != null) && ((all[i].time - inst[j].time) > 1)) {
                    inst[j].time = null
                    inst[j].freq = null
                }
            }

            // Если набрался полный набор действительных экземпляров по маске — берём среднее
            var expected_count = 0
            var count = 0
            var sum = 0
            for (let j=0;j<num_instances;j++) {
                if (esc_mask != 0 && !(esc_mask & (1 << j))) {
                    continue
                }
                if (inst[j].freq != null) {
                    count++
                    sum += inst[j].freq
                }
                if (inst[j].time != null) {
                    expected_count++
                }
            }

            if ((count > 0) && (count == expected_count)) {
                avg_freq.push(sum / count)
                avg_time.push(all[i].time)

                // Сбрасываем использованные значения
                for (let j=0;j<num_instances;j++) {
                    if (esc_mask != 0 && !(esc_mask & (1 << j))) {
                        continue
                    }
                    inst[j].freq = null
                }
            }
        }

        return { avg_freq, avg_time }
    }

    interpolate(instance, time) {
        if (!this.have_data()) {
            return
        }
        if (this.data.interpolated == null) {
            this.data.interpolated = []
        }
        this.data.interpolated[instance] = []
        for (var j=0; j < this.data.length; j++) {
            if (this.data[j] == null) {
                continue
            }
            this.data.interpolated[instance][j] = linear_interp(this.data[j].freq, this.data[j].time, time)
        }
    }

    get_interpolated_target_freq(instance, index, config) {
        if ((this.data.interpolated == null) || (this.data.interpolated[instance] == null) || (this.data.interpolated[instance].length == 0)) {
            return null
        }

        const dynamic = (config.options & (1<<1)) != 0
        const esc_mask = config.esc_mask || 0
        const len = this.data.length

        if (dynamic) {
            let ret = []
            for (var j=0; j < len; j++) {
                if (this.data.interpolated[instance][j] == null) {
                    continue
                }
                if (esc_mask != 0 && !(esc_mask & (1 << j))) {
                    continue
                }
                ret.push(this.get_target(config, this.data.interpolated[instance][j][index]))
            }
            return ret
        }

        // Среднее по моторам из маски по интерполированным данным каждого мотора (esc_mask == 0 — все)
        let sum = 0
        let count = 0
        for (let j = 0; j < len; j++) {
            if (this.data.interpolated[instance][j] == null) {
                continue
            }
            if (esc_mask == 0 || (esc_mask & (1 << j))) {
                sum += this.data.interpolated[instance][j][index]
                count++
            }
        }
        if (count == 0) {
            return
        }
        return [this.get_target(config, sum / count)]
    }

    get_target(config, freq) {
        if (config.ref == 0) {
            return config.freq
        }
        if (this.env.filter_version >= 2) {
            return Math.abs(freq)
        }
        return Math.max(freq, config.freq)
    }

    get_target_freq(config) {
        if (!this.have_data(config)) {
            return
        }

        const dynamic = (config.options & (1<<1)) != 0
        const esc_mask = config.esc_mask || 0
        if (dynamic) {
            // RPM каждого мотора отдельно
            const len = this.data.length
            let freq = []
            let time = []

            for (let i = 0; i < len; i++) {
                if (this.data[i] == null) {
                    continue
                }
                if (esc_mask != 0 && !(esc_mask & (1 << i))) {
                    continue
                }
                const inst_len = this.data[i].freq.length
                let inst_freq = new Array(inst_len)
                for (let j = 0; j < inst_len; j++) {
                    inst_freq[j] = this.get_target(config, this.data[i].freq[j])
                }

                time.push(this.data[i].time)
                freq.push(inst_freq)
            }
            return { freq:freq, time:time }

        }

        // Средний RPM моторов
        const avg = this.compute_avg(esc_mask)
        const len = avg.avg_freq.length
        let freq = new Array(len)
        for (let j = 0; j < len; j++) {
            freq[j] = this.get_target(config, avg.avg_freq[j])
        }

        return { freq:freq, time:avg.avg_time }
    }

    get_mean(range) {
        if (!this.have_data()) {
            return
        }
        const avg = this.compute_avg(0)
        const mean_freq = this.get_mean_value(avg.avg_time, avg.avg_freq, range)
        if (mean_freq != undefined) {
            return mean_freq * 60
        }
    }

    get_num_motors() {
        if (!this.have_data()) {
            return
        }
        let count = 0
        const len = this.data.length
        for (let i = 0; i < len; i++) {
            if (this.data[i] != null) {
                count++
            }
        }
        return count

    }

}
