// Базовый класс источника цели notch.
// Перенос из FilterReview/tracking/BaseClass.js построчно. Замены (общие для всех core/tracking/*):
//   конструктор получает env = { filter_version, params, build_type } и хранит его в this.env;
//   this.warnings = [] — сюда вместо alert() складываются предупреждения;
//   no_data_error() возвращает текст сообщения, а не показывает его;
//   TimeUS_to_seconds → us_to_s (core/log.js);
//   find_start_index(time) / find_end_index(time) → (time, range): get_mean_value и get_mean принимают диапазон.
class NotchTarget {
    constructor(log, env, msg_name, key_name, name, mode_value) {
        this.name = name
        this.mode_value = mode_value
        this.data = []
        this.env = env
        this.warnings = []

        // Данные лога нужны не всегда (статический notch)
        if (log == null) {
            return
        }

        if (!(msg_name in log.messageTypes)) {
            // Сообщения нет в логе
            return
        }

        // Берём данные из лога
        this.data.time = us_to_s(log.get(msg_name, "TimeUS"))
        this.data.value = log.get(msg_name, key_name)
    }

    interpolate(instance, time) {
        if (!this.have_data()) {
            return
        }
        if (this.data.interpolated == null) {
            this.data.interpolated = []
        }
        this.data.interpolated[instance] = linear_interp(this.data.value, this.data.time, time)
    }

    get_target_freq(config) {
        if (!this.have_data(config) || (this.data.time == null)) {
            return
        }
        if (config.ref == 0) {
            return { freq:[config.freq, config.freq], time:[this.data.time[0], this.data.time[this.data.time.length-1]] }
        }
        const len = this.data.value.length
        var freq = new Array(len)
        for (let j=0;j<len;j++) {
            freq[j] = this.get_target_freq_index(config, j)
        }
        return { freq:freq, time:this.data.time }
    }

    get_interpolated_target_freq(instance, index, config) {
        if ((this.data.interpolated == null) || (this.data.interpolated[instance] == null) || (this.data.interpolated[instance].length == 0)) {
            return null
        }

        return [this.get_target(config, this.data.interpolated[instance][index])]
    }

    have_data(config) {
        return Object.keys(this.data).length > 0
    }

    no_data_error() {
        return "Нет данных трекинга для notch " + this.name
    }

    get_mean_value(time, value, range) {
        // Начальный и конечный индексы
        const start_index = find_start_index(time, range)
        const end_index = find_end_index(time, range)

        // Среднее от начала до конца
        var mean = 0
        for (let j=start_index;j<end_index;j++) {
            mean += value[j]
        }
        mean /= (end_index - start_index)

        return mean
    }

    get_mean(range) {
        if (this.have_data()) {
            return this.get_mean_value(this.data.time, this.data.value, range)
        }
    }

}
