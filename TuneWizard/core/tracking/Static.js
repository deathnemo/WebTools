// Статический notch.
// Перенос из FilterReview/tracking/Static.js. Замены: get_filter_version() → this.env.filter_version;
// глобал Gyro_batch (start_time/end_time) → аргумент конструктора gyro (результат load_gyro из core/gyro.js).
class StaticTarget extends NotchTarget {
    constructor(gyro, env) {
        super(null, env, null, null, "Static", 0)
        this.gyro = gyro
    }

    // Статическому интерполяция не нужна
    interpolate(instance, time) { }

    get_target(config) {
        if (this.env.filter_version >= 2) {
            return Math.abs(config.freq)
        }
        return config.freq
    }

    get_target_freq(config) {
        return { freq:[this.get_target(config), this.get_target(config)], time:[this.gyro.start_time, this.gyro.end_time] }
    }

    get_target_freq_time(config, time) {
        // Цель от времени не зависит
        return [this.get_target(config)]
    }

    get_interpolated_target_freq(instance, index, config) {
        return [this.get_target(config)]
    }

    have_data(config) {
        return true
    }
}
