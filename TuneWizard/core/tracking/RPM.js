// Трекинг по RPM.
// Перенос из FilterReview/tracking/RPM.js. Замены: get_filter_version() → this.env.filter_version;
// TimeUS_to_seconds → us_to_s.
class RPMTarget extends NotchTarget {
    constructor(log, env, instance, mode_value) {
        super(null, env, null, null, "RPM" + instance, mode_value)

        const msg_name = "RPM"
        if (!(msg_name in log.messageTypes)) {
            // Сообщения нет в логе
            return
        }

        if ("instances" in log.messageTypes.RPM) {
            // Новое сообщение RPM с экземплярами
            const inst = instance - 1
            if (inst in log.messageTypes.RPM.instances) {
                this.data.time = us_to_s(log.get_instance(msg_name, inst, "TimeUS"))
                this.data.value = log.get_instance(msg_name, inst, "RPM")

                // При нездоровом датчике RPM = -1 — так сохраняется поведение старого логирования
                const health = log.get_instance(msg_name, inst, "H")
                const len = health.length
                for (let i = 0; i < len; i++) {
                    if (health[i] == 0) {
                        this.data.value[i] = -1
                    }
                }
            }

        } else {
            // Старое сообщение, в котором и rpm 1, и rpm 2
            this.data.time = us_to_s(log.get(msg_name, "TimeUS"))
            this.data.value = log.get(msg_name, "rpm" + instance)

        }
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
