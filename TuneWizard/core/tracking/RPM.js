// Трекинг по RPM.
// Перенос из FilterReview/tracking/RPM.js. Замены: get_filter_version() → this.env.filter_version;
// TimeUS_to_seconds → us_to_s.
// Отличие от upstream (аудит, C1): отсчёты с нечисловыми оборотами отбрасываются при чтении (см. конструктор);
// массив оборотов копируется, и отметка нездорового датчика (−1) больше не пишется в данные парсера; без единого
// числового отсчёта источник остаётся без данных.
class RPMTarget extends NotchTarget {
    constructor(log, env, instance, mode_value) {
        super(null, env, null, null, "RPM" + instance, mode_value)

        const msg_name = "RPM"
        if (!(msg_name in log.messageTypes)) {
            // Сообщения нет в логе
            return
        }

        let time_us
        let rpm
        if ("instances" in log.messageTypes.RPM) {
            // Новое сообщение RPM с экземплярами
            const inst = instance - 1
            if (inst in log.messageTypes.RPM.instances) {
                time_us = log.get_instance(msg_name, inst, "TimeUS")
                rpm = log.get_instance(msg_name, inst, "RPM")

                // При нездоровом датчике RPM = -1 — так сохраняется поведение старого логирования
                const health = log.get_instance(msg_name, inst, "H")
                if ((rpm != null) && (health != null)) {
                    rpm = Array.from(rpm)
                    const len = Math.min(health.length, rpm.length)
                    for (let i = 0; i < len; i++) {
                        if (health[i] == 0) {
                            rpm[i] = -1
                        }
                    }
                }
            }

        } else {
            // Старое сообщение, в котором и rpm 1, и rpm 2
            time_us = log.get(msg_name, "TimeUS")
            rpm = log.get(msg_name, "rpm" + instance)

        }
        if ((time_us == null) || (rpm == null)) {
            // Сообщение объявлено без строк или нужного экземпляра нет
            return
        }

        // Нечисловые обороты (датчик без данных пишет NaN, как и ESC) — не отсчёт: время и значение отбрасываются вместе,
        // иначе NaN уходил в цель notch и в передаточную функцию окна (аудит, C1). Ни одного числового отсчёта — данные
        // не присваиваются: have_data() false, и load_filters выключит notch с предупреждением, а не с целью NaN
        const time = []
        const value = []
        const len = Math.min(time_us.length, rpm.length)
        for (let i = 0; i < len; i++) {
            if (!Number.isFinite(rpm[i])) {
                continue
            }
            time.push(time_us[i] * US2S)
            value.push(rpm[i])
        }
        if (time.length == 0) {
            return
        }
        this.data.time = time
        this.data.value = value
    }

    get_target(config, rpm) {
        if (config.ref == 0) {
            return config.freq
        }
        const rpm_valid = rpm > 0
        const freq = rpm * config.ref * (1.0/60.0)
        if (this.env.filter_version >= 2) {
            if (rpm_valid) {
                return Math.abs(freq)
            }
            return 0.0
        }
        if (rpm_valid) {
            return Math.max(config.freq, freq)
        }
        return config.freq
    }

    get_target_freq_index(config, index) {
        return this.get_target(config, this.data.value[index])
    }

}
