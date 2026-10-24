// Трекинг по бортовому FFT.
// Перенос из FilterReview/tracking/FFT.js. Замены: get_filter_version() → this.env.filter_version;
// TimeUS_to_seconds → us_to_s.
class FFTTarget extends NotchTarget {
    constructor(log, env) {
        super(log, env, "FTN1", "PkAvg", "FFT", 4)

        // Берём данные из лога
        const msg = "FTN2"
        if (!(msg in log.messageTypes) || !("instances" in log.messageTypes[msg])) {
            return
        }

        // FFT отслеживает до трёх пиков
        for (const inst of Object.keys(log.messageTypes[msg].instances)) {
            const i = parseFloat(inst)
            this.data[i] = {
                time: us_to_s(log.get_instance(msg, inst, "TimeUS")),
            }
            const len = this.data[i].time.length
            this.data[i].freq = new Array(len)

            // Взвешиваем по шуму между осями, чтобы получить одну частоту
            // То же, что функция get_weighted_freq_hz в AP_GyroFFT
            const energy_x = log.get_instance(msg, inst, "EnX")
            const energy_y = log.get_instance(msg, inst,"EnY")
            const freq_x = log.get_instance(msg, inst, "PkX")
            const freq_y = log.get_instance(msg, inst, "PkY")

            for (var j=0; j < len; j++) {
                if ((energy_x[j] > 0) && (energy_y[j] > 0)) {
                    // Взвешенно по относительной энергии
                    this.data[i].freq[j] = (freq_x[j]*energy_x[j] + freq_y[j]*energy_y[j]) / (energy_x[j] + energy_y[j])
                } else {
                    // Просто среднее
                    this.data[i].freq[j] = (freq_x[j] + freq_y[j]) * 0.5
                }
            }
        }
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
            this.data.interpolated[instance][j] = linear_interp(this.data[j].freq, this.data[j].time, time)
        }
        this.data.interpolated[instance].value = linear_interp(this.data.value, this.data.time, time)
    }

    get_interpolated_target_freq(instance, index, config) {
        if ((this.data.interpolated == null) || (this.data.interpolated[instance] == null) || (this.data.interpolated[instance].length == 0)) {
            return null
        }

        const dynamic = (config.options & (1<<1)) != 0
        if (dynamic) {
            const len = this.data.length
            let ret = new Array(len)
            for (var j=0; j < len; j++) {
                ret[j] = this.get_target(config, this.data.interpolated[instance][j][index])
            }
            return ret
        }

        return [this.get_target(config, this.data.interpolated[instance].value[index])]
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
        if (dynamic) {
            // Несколько пиков
            const len = this.data.length
            let freq = new Array(len)
            let time = new Array(len)

            for (let i = 0; i < len; i++) {
                const inst_len = this.data[i].freq.length
                let inst_freq = new Array(inst_len)
                for (let j = 0; j < inst_len; j++) {
                    inst_freq[j] = this.get_target(config, this.data[i].freq[j])
                }

                time[i] = this.data[i].time
                freq[i] = inst_freq
            }
            return { freq:freq, time:time }
        }

        // Только центральный пик
        const len = this.data.value.length
        let freq = new Array(len)
        for (let j = 0; j < len; j++) {
            freq[j] = this.get_target(config, this.data.value[j])
        }
        return { freq:freq, time:this.data.time }
    }
}
