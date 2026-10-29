// Цель по газу.
// Перенос из FilterReview/tracking/Throttle.js построчно. Замены: get_version_and_board(log).build_type →
// env.build_type; get_param_value(PARM, name) → this.env.params.get(name) (строка const PARM = log.get("PARM")
// поэтому не нужна); get_filter_version() → this.env.filter_version; alert → this.warnings.push;
// no_data_error возвращает текст; TimeUS_to_seconds → us_to_s.
// Исправлен дефект upstream 4 (задача 8): без RATE и CTUN источник остаётся режимом 1 без данных.
// Отличие от upstream (аудит, I2): выход мотора в отсутствующем сообщении (RCO2/RCO3) — «нет данных по моторам»,
// а не исключение.
class ThrottleTarget extends NotchTarget {
    constructor(log, env) {
        const build_type = env.build_type

        // Для газа предпочитаем RATE.AOut, но на ArduCopter без RATE берём CTUN.ThO
        if ("RATE" in log.messageTypes) {
            super(log, env, "RATE", "AOut", "Throttle", 1)
        } else if ("CTUN" in log.messageTypes && build_type === 2) {
            // build_type 2 == ArduCopter (см. Libraries/LogHelpers.js)
            super(log, env, "CTUN", "ThO", "Throttle", 1)
        } else {
            // Конструктор базового класса вызывается всегда.
            // исправление дефекта upstream 4 (tracking/Throttle.js:14): режим остаётся 1. В upstream mode_value = null,
            // источник с режимом 1 в списке трекинга не находился, и HarmonicNotchFilter сообщал «неподдерживаемый
            // режим» вместо «нет данных газа»
            super(null, env, null, null, "Throttle", 1)
        }

        // Для notch по отдельным моторам нужны выходы RC
        if (!("RCOU" in log.messageTypes)) {
            return
        }

        // Функции выходов RC
        const functions = new Array(32)
        for (let i = 0; i<functions.length; i++) {
            functions[i] = this.env.params.get("SERVO" + (i+1) + "_FUNCTION")
        }

        const k_motor1 = 33
        const k_motor8 = 40
        const k_motor9 = 82
        const k_motor12 = 85

        // true, если функция — мотор мультикоптера
        function is_motor(val) {
            if (val == null) {
                return false
            }

            return (val >= k_motor1 && val <= k_motor8) ||
                   (val >= k_motor9 && val <= k_motor12)
        }

        // по номеру канала мотора (с нуля) вернуть функцию k_motor этого канала
        function get_motor_function(channel) {
            if (channel < 8) {
                return k_motor1+channel
            }
            return k_motor9 + channel - 8
        }

        // Считаем функции моторов
        let motor_count = 0
        for (let i = 0; i<functions.length; i++) {
            if (is_motor(functions[i])) {
                motor_count += 1
            }
        }

        // Пробуем понять, сколько моторов должно быть
        let frame_class = this.env.params.get("FRAME_CLASS")
        if (frame_class == null) {
            frame_class = this.env.params.get("Q_FRAME_CLASS")
        }

        const motor_frame_class = {
            QUAD: { value: 1, count: 4 },
            HEXA: { value: 2, count: 6 },
            OCTA: { value: 3, count: 8 },
            OCTAQUAD: { value: 4, count: 8 },
            Y6: { value: 5, count: 6 },
            TRI: { value: 7, count: 4 }, // Не все из них моторы
            SINGLE: { value: 8, count: 6 }, // Не все из них моторы
            COAX: { value: 9, count: 6 }, // Не все из них моторы
            //TAILSITTER: { value: 10, count: 4 },
            DODECAHEXA: { value: 12, count: 12 },
            DECA: { value: 14, count: 10 },
            SCRIPTING_MATRIX: { value: 15, count: motor_count },
            _6DOF_SCRIPTING: { value: 16, count: motor_count },
            DYNAMIC_SCRIPTING_MATRIX: { value: 17, count: motor_count },
        }

        let motors = []
        for (const [name, value] of Object.entries(motor_frame_class)) {
            if (value.value != frame_class) {
                continue
            }
            if (motor_count != value.count) {
                console.log("Expected " + value.count + " motors for frame class: " + name)
                return
            }
            for (let i = 0; i<value.count; i++) {
                motors.push(get_motor_function(i))
            }
            break
        }

        // Эти классы рамы используют под моторы не все выходы
        if (frame_class == motor_frame_class.TRI.value) {
            motors = [ get_motor_function(0),
                       get_motor_function(1),
                       get_motor_function(3) ]

        } else if ((frame_class == motor_frame_class.SINGLE.value) || (frame_class == motor_frame_class.COAX.value)) {
            motors = [ get_motor_function(5),
                       get_motor_function(6) ]

        } else if (frame_class == 10) {
            // Tailsitter выходы моторов не использует вовсе
            motors = [ 73, // газ левый
                       74 ] // газ правый
        }

        if (motors.length == 0) {
            console.log("Unknown frame class: " + frame_class)
            return
        }

        for (const motor of motors) {
            if (!functions.includes(motor)) {
                console.log("Could not find servo assigned to function: " + motor)
                return
            }
        }

        // Параметры моторов
        // OPTIONS по умолчанию 0, чтобы его отсутствие не было ошибкой
        const mot_params = { OPTIONS: 0 }
        for (const name of ["THST_EXPO", "SPIN_MAX", "SPIN_MIN", "PWM_MIN", "PWM_MAX", "BAT_VOLT_MIN", "BAT_VOLT_MAX", "BAT_IDX", "OPTIONS"]) {
            const has_default = mot_params[name] != null
            for (const prefix of ["MOT_", "Q_M_"]) {
                const param_name = prefix + name
                const param_value = this.env.params.get(param_name)
                if (param_value != null) {
                    if (!has_default && (name in mot_params)) {
                        this.warnings.push("Неожиданный параметр мотора: " + param_name)
                    }
                    mot_params[name] = param_value
                }
            }
            if (mot_params[name] == null) {
                // Для извлечения газа нужны все параметры
                console.log("Missing motor param: " + name)
                return
            }
        }

        // Экспонента тяги должна быть в пределах ±1.0
        mot_params.THST_EXPO = Math.min(Math.max(mot_params.THST_EXPO, -1.0), 1.0)

        // Компенсация по батарее
        const skip_battery_comp = (mot_params.BAT_VOLT_MAX <= 0) || (mot_params.BAT_VOLT_MIN >= mot_params.BAT_VOLT_MAX)
        let batt_time = null
        let batt_voltage = 1.0
        let lift_max = 1.0
        if (!skip_battery_comp) {
            // Проверяем лог батареи
            if (!("BAT" in log.messageTypes) || !("instances" in log.messageTypes.BAT) || !(mot_params.BAT_IDX in log.messageTypes.BAT.instances)) {
                console.log("No battery logging for multi throttle notch")
                return
            }

            const use_raw_voltage = (mot_params.OPTIONS & 1) != 0
            batt_time = log.get_instance("BAT", mot_params.BAT_IDX, "TimeUS")
            const raw_voltage = log.get_instance("BAT", mot_params.BAT_IDX, "Volt")
            const resting_voltage = log.get_instance("BAT", mot_params.BAT_IDX, "VoltR")

            // Считаем lift max и нормированное напряжение батареи
            const len = raw_voltage.length
            batt_voltage = new Array(len)
            lift_max = new Array(len)
            const min_volt_threshold = 0.25 * mot_params.BAT_VOLT_MIN
            for (let i = 0; i<len; i++) {

                let voltage
                if (use_raw_voltage) {
                    voltage = raw_voltage[i]
                } else {
                    // Напряжение покоя ограничено снизу сырым напряжением в:
                    // AP_BattMonitor_Backend::voltage_resting_estimate()
                    voltage = Math.max(raw_voltage[i], resting_voltage[i])
                }

                if (voltage < min_volt_threshold) {
                    batt_voltage[i] = 1.0
                    lift_max[i] = 1.0
                    continue
                }

                // Ограничиваем диапазоном и нормируем
                let constrained = Math.min(Math.max(voltage, mot_params.BAT_VOLT_MIN), mot_params.BAT_VOLT_MAX)
                batt_voltage[i] = constrained / mot_params.BAT_VOLT_MAX

                // Считаем lift max
                lift_max[i] = batt_voltage[i] *  (1 - mot_params.THST_EXPO) + mot_params.THST_EXPO * batt_voltage[i] * batt_voltage[i]
            }
        }

        // Поправка на плотность воздуха
        const primary_baro = this.env.params.get("BARO_PRIMARY")
        if (!("BARO" in log.messageTypes) || !("instances" in log.messageTypes.BARO) || !(primary_baro in log.messageTypes.BARO.instances)) {
            console.log("No barometer logging for multi throttle notch")
            return

        }

        const baro_time = log.get_instance("BARO", primary_baro, "TimeUS")
        const baro_alt = log.get_instance("BARO", primary_baro, "Alt")

        const air_density_model = get_air_density_model()
        const baro_len = baro_time.length
        const air_density_correction = new Array(baro_len)
        for (let i = 0; i<baro_len; i++) {
            const air_density_ratio = 1.0 / Math.pow(air_density_model.get_EAS2TAS(baro_alt[i]), 2.0)
            if (air_density_ratio > 0.3 && air_density_ratio < 1.5) {
                air_density_correction[i] = 1.0 / Math.min(Math.max(air_density_ratio, 0.5), 1.25)
            } else {
                air_density_correction[i] = 1.0
            }
        }

        // Читаем PWM

        // Имя сообщения лога, в котором искать данный канал
        function get_log_msg_name(channel) {
            if (channel < 14) {
                return "RCOU"
            }
            if (channel < 18) {
                return "RCO2"
            }
            return "RCO3"
        }

        // Ищем каждую функцию мотора в логе
        var instances = 0
        for (const motor of motors) {
            const channel = functions.findIndex(f => f === motor)
            if (channel == -1) {
                // Если мы дошли сюда, такого быть не должно
                console.log("Could not find servo assigned to function: " + motor)
                return
            }
            const log_name = get_log_msg_name(channel)
            const field_name = "C" + (channel + 1)
            const PWM = log.get(log_name, field_name)
            const time = log.get(log_name, "TimeUS")
            if ((PWM == null) || (time == null)) {
                // Выход мотора в сообщении, которого в логе нет (моторы на каналах 15–18 без RCO2, 19–32 без RCO3) или
                // без строк: parser.get возвращает undefined, и upstream падал на PWM.length — исключение рушило
                // всю подготовку трекинга (аудит, I2). Газ по моторам нужен для всех моторов сразу, поэтому уже
                // собранные ряды убираются: источник остаётся без данных по моторам
                console.log("No " + log_name + "." + field_name + " logging for motor function " + motor)
                this.data.length = 0
                return
            }
            const len = PWM.length

            // Интерполируем поправки батареи и барометра ко времени PWM
            const density_correction = linear_interp(air_density_correction, baro_time, time)

            let batt_correction
            let lift_correction
            if (!skip_battery_comp) {
                batt_correction = linear_interp(batt_voltage, batt_time, time)
                lift_correction = linear_interp(lift_max, batt_time, time)
            }

            const thrust = new Array(len)
            for (let i = 0; i<len; i++) {
                // Выход привода по PWM min и max
                let throttle = (PWM[i] - mot_params.PWM_MIN) / (mot_params.PWM_MAX - mot_params.PWM_MIN)

                // Убираем spin min и max
                throttle = (throttle - mot_params.SPIN_MIN) / (mot_params.SPIN_MAX - mot_params.SPIN_MIN)

                // Ограничиваем 0..1
                throttle = Math.min(Math.max(throttle, 0.0), 1.0)

                function remove_thrust_curve_and_volt_scaling(throttle, batt_voltage_filt, lift_max) {
                    let battery_scale = 1.0
                    if (batt_voltage_filt > 0) {
                        battery_scale = 1.0 / batt_voltage_filt
                    }
                    // применяем кривую тяги — область -1.0..1.0, значения -1.0..1.0
                    const thrust_curve_expo = mot_params.THST_EXPO
                    if (thrust_curve_expo == 0) {
                        // нулевая экспонента — линейно; избегаем деления на малые величины
                        return  throttle / (lift_max * battery_scale)
                    }
                    let thrust = ((throttle / battery_scale) * (2.0 * thrust_curve_expo)) - (thrust_curve_expo - 1.0)
                    thrust = (thrust * thrust) - ((1.0 - thrust_curve_expo) * (1.0 - thrust_curve_expo))
                    thrust /=  4.0 * thrust_curve_expo * lift_max
                    return Math.min(Math.max(thrust, 0.0), 1.0)
                }

                const lift_max = skip_battery_comp ? 1.0 : lift_correction[i]

                thrust[i] = remove_thrust_curve_and_volt_scaling(throttle, skip_battery_comp ? 1.0 : batt_correction[i], lift_max)

                function get_compensation_gain(lift_max, air_density_ratio) {
                    if (lift_max <= 0) {
                        return 1.0
                    }
                    return (1.0 / lift_max) * air_density_ratio
                 }

                thrust[i] /= get_compensation_gain(lift_max, density_correction[i])
            }

            this.data[instances] = { time: us_to_s(time), thrust }
            instances++
        }

    }

    no_data_error(config) {
        const dynamic = (config.options & (1<<1)) != 0
        if (dynamic) {
            if (this.data.length == 0) {
                return "Нет данных трекинга для notch по газу отдельных моторов"
            }
            if (this.env.filter_version < 2) {
                return "Notch по газу отдельных моторов доступен только с версии фильтра 2"
            }
        }
        if (!("value" in this.data)) {
            // Источник без среднего газа (исправление дефекта upstream 4)
            return "Нет данных газа для notch по газу: в логе нет RATE.AOut (и CTUN.ThO на Copter)"
        }
        return super.no_data_error()
    }

    have_data(config) {
        const dynamic = (config?.options & (1<<1)) != 0
        if (dynamic) {
            if (this.data.length == 0) {
                return false
            }
            if (this.env.filter_version < 2) {
                return false
            }
        }
        return "value" in this.data
    }

    get_target(config, thrust) {
        if (config.ref == 0) {
            return config.freq
        }
        const motors_throttle = Math.max(0, thrust)
        const throttle_norm = Math.sqrt(motors_throttle / config.ref)
        if (this.env.filter_version >= 2) {
            return Math.abs(config.freq * throttle_norm)
        }
        return config.freq * Math.max(config.min_ratio, throttle_norm)
    }

    get_target_freq_index(config, index) {
        return this.get_target(config, this.data.value[index])
    }

    interpolate(instance, time) {
        if (!("value" in this.data)) {
            return
        }
        if (this.data.interpolated == null) {
            this.data.interpolated = []
        }
        this.data.interpolated[instance] = {}
        this.data.interpolated[instance].value = linear_interp(this.data.value, this.data.time, time)

        for (let i = 0; i<this.data.length; i++) {
            this.data.interpolated[instance][i] = linear_interp(this.data[i].thrust, this.data[i].time, time)
        }
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
                const inst_len = this.data[i].thrust.length
                let inst_freq = new Array(inst_len)
                for (let j = 0; j < inst_len; j++) {
                    inst_freq[j] = this.get_target(config, this.data[i].thrust[j])
                }
                time[i] = this.data[i].time
                freq[i] = inst_freq
            }
            return { freq:freq, time:time }
        }

        // Просто среднее
        const len = this.data.value.length
        let freq = new Array(len)
        for (let i = 0; i < len; i++) {
            freq[i] = this.get_target(config, this.data.value[i])
        }
        return { freq:freq, time:this.data.time }
    }
}
