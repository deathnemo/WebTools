// Копия https://github.com/ArduPilot/ardupilot/blob/master/libraries/AP_Baro/AP_Baro_atmosphere.cpp
// Нужна, чтобы перевести PWM мотора обратно в газ для трекинга notch по отдельным моторам.
// Перенос из FilterReview/tracking/Atmosphere_model.js построчно. Единственная замена: upstream вешал
// get_EAS2TAS на this (при вызове без new это глобальный объект страницы), здесь — локальный объект model.

function get_air_density_model() {

    /*
    Параметры — как в модели 1976 года.
    Они немного отличаются от определённых в definitions.h
    */
    const radius_earth = 6356.766E3      // радиус Земли (м)
    const R_specific = 287.053072        // удельная газовая постоянная воздуха (Дж⋅кг−1⋅К−1) в модели 1976, R_universal / M_air

    // ускорение свободного падения, м/с/с
    const GRAVITY_MSS = 9.80665

    const SSL_AIR_DENSITY = 1.225 // кг/м^3

    function get_struct(amsl_m, temp_K, pressure_Pa, density, temp_lapse) {
        return {
            amsl_m,       // геопотенциальная высота над уровнем моря (км')
            temp_K,       // температура (К)
            pressure_Pa,  // давление (Па)
            density,      // плотность (Па/кг)
            temp_lapse,   // градиент температуры (К/м'), см. стр. 3
        }
    }

    const atmospheric_1976_consts = [
        get_struct( -5000,    320.650,     177687,      1.930467,    -6.5E-3 ),
        get_struct( 11000,    216.650,    22632.1,      0.363918,          0 ),
        get_struct( 20000,    216.650,    5474.89,    8.80349E-2,       1E-3 ),
        get_struct( 32000,    228.650,    868.019,    1.32250E-2,     2.8E-3 ),
        get_struct( 47000,    270.650,    110.906,    1.42753E-3,          0 ),
        get_struct( 51000,    270.650,    66.9389,    8.61606E-4,    -2.8E-3 ),
        get_struct( 71000,    214.650,    3.95642,    6.42110E-5,    -2.0E-3 ),
        get_struct( 84852,    186.946,    0.37338,    6.95788E-6,          0 ),
    ]

    /*
    найти строку таблицы по геопотенциальной высоте в метрах. Возвращает не меньше 1
    */
    function find_atmosphere_layer_by_altitude(alt_m) {
        for (let idx = 1; idx < atmospheric_1976_consts.length; idx++) {
            if(alt_m < atmospheric_1976_consts[idx].amsl_m) {
                return idx - 1
            }
        }

        // Выше наибольшей высоты — последний индекс
        return atmospheric_1976_consts.length - 1
    }

    function geometric_alt_to_geopotential(alt)
    {
        return (radius_earth * alt) / (radius_earth + alt)
    }

    /*
    Ожидаемая температура для данной геопотенциальной высоты и слоя атмосферы.
    */
    function get_temperature_by_altitude_layer(alt, idx)
    {
        if (atmospheric_1976_consts[idx].temp_lapse == 0) {
            return atmospheric_1976_consts[idx].temp_K
        }
        return atmospheric_1976_consts[idx].temp_K + atmospheric_1976_consts[idx].temp_lapse * (alt - atmospheric_1976_consts[idx].amsl_m)
    }

    /*
    плотность воздуха (кг/м^3) по геометрической высоте (м)
    */
    function get_air_density_for_alt_amsl(alt_amsl)
    {
        alt_amsl = geometric_alt_to_geopotential(alt_amsl)

        const idx = find_atmosphere_layer_by_altitude(alt_amsl)
        const temp_slope = atmospheric_1976_consts[idx].temp_lapse
        const temp =  get_temperature_by_altitude_layer(alt_amsl, idx)

        let rho
        if (temp_slope == 0.0) {    // Изотермический слой
            const fac = Math.exp(-GRAVITY_MSS / (temp * R_specific) * (alt_amsl - atmospheric_1976_consts[idx].amsl_m))
            rho      = atmospheric_1976_consts[idx].density     * fac
        } else {            // Слой с градиентом температуры
            const fac =  GRAVITY_MSS / (temp_slope * R_specific)
            const temp_ratio = temp / atmospheric_1976_consts[idx].temp_K // отношение температур [безразмерное]
            rho      = atmospheric_1976_consts[idx].density     * Math.pow(temp_ratio, -(fac + 1))
        }

        return rho
    }

    /*
    текущий коэффициент перевода приборной скорости в истинную
    */
    function get_EAS2TAS_extended(altitude)
    {
        let density = get_air_density_for_alt_amsl(altitude)
        if (density <= 0) {
            // выше этой высоты мы уже ближе к космосу...
            const table_size = atmospheric_1976_consts.length
            density = atmospheric_1976_consts[table_size-1].density
        }
        return Math.sqrt(SSL_AIR_DENSITY / density)
    }

    const model = {}
    model.get_EAS2TAS = (altitude) => { return get_EAS2TAS_extended(altitude) }
    return model
}
