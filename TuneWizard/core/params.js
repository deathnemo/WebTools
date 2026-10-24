// Файл параметров ArduPilot (.param): текст для сохранения и разбор загруженного. Без DOM: работает в браузере
// и под Node (тесты).
// Формат записи — как у FilterReview и Mission Planner: «ИМЯ,ЗНАЧЕНИЕ» по строке, имена в натуральном порядке,
// число — кратчайшая запись, которая возвращает то же float32 (get_param_download_text и param_to_string
// из Libraries/Param_Helpers.js). Разбор — как load_parameters FilterReview: разделители запятая, пробелы,
// табуляция и «=», так что читаются и файлы Mission Planner («ИМЯ,ЗНАЧЕНИЕ»), и MAVProxy («ИМЯ ЗНАЧЕНИЕ»).
//
// Нужны глобалы страницы: Libraries/Param_Helpers.js (get_param_download_text).

// Текст файла параметров: values — объект имя → число
function param_file_text(values) {
    return get_param_download_text(values)
}

// Разбор текста файла параметров в объект имя → число. Строки — по \n (и \r\n), поля — по запятой, пробелам,
// табуляции и «=»; пустые строки, комментарии «#» (целой строкой или после значения) и строки без числового
// значения пропускаются (FilterReview отдал бы такое значение полю как есть); при повторе имени остаётся последнее значение (как при загрузке в FilterReview,
// где каждая строка заново ставит значение поля)
function parse_param_file(text) {
    const values = {}
    for (const raw of String(text).split("\n")) {
        // Комментарий до конца строки, затем пробелы по краям
        const line = raw.split("#")[0].trim()
        if (line === "") {
            continue
        }
        const fields = line.split(/[\s,=\t]+/)
        if (fields.length < 2) {
            continue
        }
        // Number("") = 0: пустое значение («ИМЯ,») числом не считаем
        const value = Number(fields[1])
        if ((fields[0] === "") || (fields[1] === "") || !Number.isFinite(value)) {
            continue
        }
        values[fields[0]] = value
    }
    return values
}
