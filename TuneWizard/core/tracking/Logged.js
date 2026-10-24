// Трекинг по значениям, записанным в лог.
// Перенос из FilterReview/tracking/Logged.js. Замены: TimeUS_to_seconds → us_to_s; env не нужен (null).
class LoggedNotch extends NotchTarget {
    constructor(log, instance) {
        super(null, null, null, null, "Logged", null)

        this.harmonics = null

        // Сообщение одиночного notch
        const static_msg = "FTNS"
        if ((static_msg in log.messageTypes) && ("instances" in log.messageTypes[static_msg])) {
            for (const inst of Object.keys(log.messageTypes[static_msg].instances)) {
                if (parseFloat(inst) != instance) {
                    // Не выбранный экземпляр
                    continue
                }

                this.data.time = us_to_s(log.get_instance(static_msg, inst, "TimeUS"))
                this.data.freq = Array.from(log.get_instance(static_msg, inst, "NF"))
                // Если есть одиночный, динамического для этого экземпляра быть не должно
                return
            }
        }

        // Сообщение multi-notch
        const dynamic_msg = "FTN"
        if ((dynamic_msg in log.messageTypes) && ("instances" in log.messageTypes[dynamic_msg])) {
            for (const inst of Object.keys(log.messageTypes[dynamic_msg].instances)) {
                if (parseFloat(inst) != instance) {
                    // Не выбранный экземпляр
                    continue
                }

                const notch_number = log.get_instance(dynamic_msg, inst, "NDn")
                let num_notches = 0
                const len = notch_number.length
                for (let i = 0; i<len; i++) {
                    num_notches = Math.max(num_notches, notch_number[i])
                }

                this.data.time = us_to_s(log.get_instance(dynamic_msg, inst, "TimeUS"))

                this.data.freq = new Array(num_notches)
                for (let i = 0; i<num_notches; i++) {
                    const name = "NF" + (i + 1)
                    if (log.messageTypes[dynamic_msg].expressions.includes(name)) {
                        this.data.freq[i] = Array.from(log.get_instance(dynamic_msg, inst, name))
                    }
                }
                return
            }
        }
    }

    get_target_freq() {
        return { freq:this.data.freq, time:this.data.time }
    }

}
