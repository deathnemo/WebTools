# Мастер настройки (TuneWizard) — дизайн

Дата: 23.10.2026. Статус: утверждён в обсуждении, реализация не начата.

## 1. Цель и границы

Личный инструмент в форке `deathnemo/WebTools`, объединяющий FilterReview и PIDReview в **пошаговый мастер настройки Copter**: загрузил один `.bin` → мастер ведёт по шагам, на каждом считает и **предлагает** значения параметров, пользователь правит и подтверждает → на выходе сводка и файл `.param`.

Решения, принятые 23.10.2026:

- Только Copter в первой версии (оси Roll/Pitch/Yaw, сообщения `PIDR/P/Y`, запасной вариант `RATE`).
- Полуавтомат: инструмент предлагает значения, пользователь подтверждает. Полностью автоматического отчёта нет.
- Один лог за проход + память о прошлом проходе в `localStorage`.
- Инструмент не предназначен для PR в upstream: интерфейс на русском, оформление по общим правилам проектов (две темы, Archivo / IBM Plex). Графики — Plotly, оформленный под токены темы (исключение из правила «встроенный SVG», принято осознанно ради зума, ховера и спектрограмм).
- Архитектура «A»: новая папка `TuneWizard/` с DOM-независимым ядром, математика **переносится** из FilterReview/PIDReview; оригинальные страницы не меняются, `git pull upstream` сливается без конфликтов. Дублирование ~1500 строк математики принято сознательно.
- Ветка `tune-wizard`, `main` отслеживает `upstream/main`.

Отвергнутые варианты: обёртка над страницами через iframe (нет доступа к данным для предложений, чужой стиль и язык); переделка существующих страниц на месте (конфликты имён `load/reset/calculate/redraw/run_batch_fft`, потеря чистых обновлений из upstream).

## 2. Структура

```
TuneWizard/
  index.html        страница мастера: шаги, формы, контейнеры графиков, стили и переключатель темы
  wizard.js         навигация по шагам, объект state, рисование Plotly, формы «предложено → принято»
  core/             чистая математика без document, экспорт через typeof module (как AirspeedFit/airspeedfit_core.js)
    log.js          open_log(buffer) → парсер, тип аппарата, версия, плата, доступ к параметрам и истории их изменений
    gyro.js         load_gyro(log, params): batch (ISBH/ISBD) или raw (GYR), pre/post, частоты, первичный гироскоп;
                    gyro_fft(gyro, {window}) → спектры по окнам; mean_spectrum(fft, [t0, t1])
    filters.js      Biquad / Notch / MultiNotch / HarmonicNotch (версия фильтра — аргумент);
                    transfer(filters, fft, [t0, t1]) → H по окнам; estimate_post(fft, H); bode(H); phase_lag(bode, f)
    tracking.js     Static / Throttle / RPM / ESC / FFT / Logged; alert() заменён на возвращаемую {error}
    pid.js          load_pid(log, params): PIDR/P/Y или RATE, наборы параметров по времени, батчи;
                    pid_fft(axis, window); step_response(axis, fft, [t0, t1])
    metrics.js      пики спектра и превышение над шумом; шум D-терма; метрики отклика
    autofit.js      автоподбор первого notch (ESC → газ по моторам → средний газ), перенос PR ArduPilot/WebTools#363
    checks.js       проверки шага 0 → [{id, status: ok|warn|fail, text, fix}]
    params.js       реестр предложений {name, current, proposed, accepted, source}; текст .param
  Readme.md
  logs/             локальные логи для ручной проверки, в .gitignore
images/TuneWizard_Icon.png
index.html          ссылка на лендинге
tests/tunewizard.test.cjs
docs/plans/         этот документ и планы реализации
```

Переиспользуем без копирования: `modules/JsDataflashParser/parser.js`, Plotly, fft.js, tippy, `Libraries/` (Array_Math, fft, Param_Helpers, LogHelpers, DecodeDevID, FileSaver, LoadingOverlay).

Откуда переносим в `core/`:

| Модуль | Источник |
|---|---|
| `gyro.js` | `FilterReview/FilterReview.js`: `load_from_batch` (2051), `load_from_raw_log` (2232), `run_batch_fft` (277) |
| `filters.js` | `FilterReview/FilterReview.js`: строки 12–275, `calculate_transfer_function` (893), `get_phase` (1058), оценка post в `redraw_post_estimate_and_bode` (1289) |
| `tracking.js` | `FilterReview/tracking/*.js` (1116 строк); `get_filter_version()` и `Gyro_batch` заменяются аргументами |
| `pid.js` | `PIDReview/PIDReview.js`: `split_into_batches` (1378), `load` (1437), `redraw_step` (1031) |
| `autofit.js` | PR #363 `FilterReview/AutoFit.js`; `Gyro_batch`, `tracking_methods`, `find_start_index` → аргументы |

**Состояние.** Один объект `state` в `wizard.js`: распарсенный лог, параметры, общие настройки (интервал анализа, размер окна FFT), `steps[n]` с предложенными и принятыми значениями. В `localStorage` (ключ `tunewizard_v1`) — только принятые параметры последнего прохода, дата, имя лога.

**Оформление.** Токены двух тем, шрифты и элементы (`.lab`, `.stats`, `.verdict`, `.themebar`, печать) по общим правилам проектов. Plotly берёт цвета из токенов через `getComputedStyle` и перерисовывается при смене темы.

## 3. Шаги мастера

Полоса из шести шагов; переход вперёд только после того, как шаг принят или пропущен с пометкой. Интервал анализа и размер окна FFT общие для всех шагов.

**0 · Лог и проверки.** Загрузка `.bin`. Карточка: аппарат (не Copter → стоп), версия/плата, длительность, время с газом, `INS_GYRO_FILTER`, `SCHED_LOOP_RATE`. Проверки `ok / warn / fail` с подсказкой «как исправить»:

- бит PID в `LOG_BITMASK`: есть `PIDR/P/Y` → ok, только `RATE` → warn;
- данные гироскопа raw/batch: нет → шаги 1–3 недоступны;
- `INS_LOG_BAT_OPT`: 4 (pre + post) → ok, только post → warn (оценку «станет» не построить);
- источник трекинга: ESC-телеметрия / RPM / только газ;
- висение ≥ 30 с;
- VIBE < 30 ok, 30–60 warn, > 60 fail; clipping = 0;
- `MOT_THST_HOVER` против среднего газа висения.

Ниже — память прошлого прохода: «предлагалось → в логе сейчас», применено или нет. График полёта (roll / pitch / газ / высота) с ползунком интервала; автоподбор интервала как в FilterReview (газ > 0 с отступом 1 с).

**1 · Спектр до фильтров.** Средний спектр X/Y/Z первичного гироскопа и спектрограмма. Таблица пиков: частота, уровень, превышение над шумом, источник («моторы, гармоника N», если кратно частоте ESC/газа, иначе «рама/резонанс»). Вердикт: главный шум; есть ли шум выше `INS_GYRO_FILTER`. Предложений нет.

**2 · Гармонический notch.** Автоподбор предзаполняет `INS_HNTCH_ENABLE/MODE/REF/FREQ/BW/ATT/HMNCS/FM_RAT/OPTS` рядом с текущими значениями из лога. Графики: pre / оценка post / логированный post. Метрики: остаточный пик, ослабление, фазовая задержка на 10/20/50 Гц. Некратный остаточный пик ≥ 6 дБ → необязательное предложение статического `INS_HNTC2`. Кнопка «Принять».

**3 · Низкочастотные фильтры.** Выбор размера пропеллера → `INS_GYRO_FILTER`; `FLTD = FLTT = INS_GYRO_FILTER/2`; `ATC_RAT_YAW_FLTE = 2`; `ATC_ACC_*_MAX` по размеру. Бодэ суммарной задержки notch + LPF с предупреждением. «Принять».

**4 · PID по осям** (вкладки Roll / Pitch / Yaw). Текущие `ATC_RAT_*` по наборам (если менялись в полёте). Графики: Tar/Act во времени, спектр P/I/D/Out, step response (все окна + среднее). Метрики: нарастание 10–90 %, перерегулирование, установление ±5 %, остаточные колебания, шум D. Предложения по правилам раздела 5. Работает и на `RATE` без компонент.

**5 · Сводка.** Таблица «параметр · было · станет · шаг», вердикты, «что перелететь» (например, `INS_LOG_BAT_OPT = 2`, висение 30 с, повторить проход). Кнопки «Скачать .param», «Запомнить проход», печать.

## 4. Поток данных

файл → `log.js` → параллельно `gyro.js` и `pid.js` → шаги читают эти объекты, считают через `filters/tracking/metrics/autofit/checks` и пишут результаты в `state.steps[n]` → `params.js` собирает сводку и файл.

## 5. Правила предложений

Все числа — в одном блоке `rules` в начале модуля с комментарием-источником. Обозначения: **[wiki]** — ardupilot.org, **[код]** — исходники ArduPilot, **[PR363]** — метод автоподбора из PR ArduPilot/WebTools#363, **[наше]** — эвристика, которой у ArduPilot нет; такие пороги настраиваемые и в интерфейсе подписаны как ориентир.

**Шаг 0.** VIBE < 30 / 30–60 / > 60, clipping = 0 **[wiki, Measuring Vibration — сверить при реализации]**; висение ≥ 30 с без ввода **[wiki, Initial tuning flight]**; расхождение `MOT_THST_HOVER` и среднего газа висения > 0.05 → warn, совет `MOT_HOVER_LEARN = 2` **[wiki + порог наше]**.

**Шаг 2 (notch).** Гармоника notch'ится при пике ≥ 6 дБ над локальным шумом; `ATT` = выступ сильнейшего пика, 10–50 дБ; ESC: `MODE 3`, `REF 1`, `FREQ` = 80 % от 5-го процентиля моторной частоты; газ: `MODE 1`, `REF` = средний газ, `FREQ` подгоняется по пикам, `FM_RAT` понижается ради трекинга ниже REF; `OPTS` — multi-source, один notch на гармонику **[PR363]**. `BW = FREQ/2`, при multi-source `FREQ/4` **[wiki]**. В режиме ESC `FREQ` выше `INS_GYRO_FILTER` **[wiki]**. Некратный остаточный пик ≥ 6 дБ → статический `INS_HNTC2`, необязательно **[наше]**.

**Шаг 3 (LPF).** `INS_GYRO_FILTER` 80 / 40 / 20 Гц для 5″ / 10″ / 20″+; `INS_ACCEL_FILTER 10`; `ATC_RAT_RLL/PIT_FLTD = FLTT = INS_GYRO_FILTER/2`; `ATC_RAT_YAW_FLTT = INS_GYRO_FILTER/2`; `ATC_RAT_YAW_FLTE = 2`; `ATC_ACC_P/R_MAX` 1100 / 500 / 200 и `ATC_ACC_Y_MAX` 200 / 100 / 90 для 10″ / 20″ / 30″ **[wiki, Setting up for tuning]**. Порог предупреждения о суммарной фазовой задержке **[наше]**.

**Шаг 4 (PID).** Метрики по нормированному отклику (цель = 1). Правила: остаточные колебания на высокой частоте → `D −10 %`, на низкой → `P −10 %`; перерегулирование > 20 % → `P −10 %`; медленно и без перерегулирования → `P +10 %`; при каждом изменении P → `I = P` **[wiki, Manual tuning: шаги 10 % и I = P; пороги метрик — наше]**. Заметный шум D выше 50 Гц → предупреждение «горячие моторы», совет снизить D или `FLTD` **[наше]**. Пределы AutoTune: `D ≤ 0.2`, `P` 0.01–2.0, yaw `I = 0.1·P` **[код, `AC_AutoTune_Multi.cpp`]**. За один проход — не более одного изменения на коэффициент.

## 6. Ошибки

Ядро не вызывает `alert()`: возвращает `{error}` или бросает типизированную ошибку; `wizard.js` показывает её в строке-вердикте шага с действием. Не `.bin` или нет `PARM` → шаг 0 fail. Частичные данные деградируют, не ломают: нет гироскопа → шаги 1–3 закрыты с пояснением; нет бита PID → шаг 4 на `RATE`; нет ESC → трекинг по газу. Расчёт в главном потоке с `LoadingOverlay`; ядро без DOM, перенос в Web Worker возможен позже. `localStorage` в `try/catch`.

## 7. Тесты

- `npm run lint`; файлы `core/` добавить в `DUAL_SCRIPTS` в `eslint.config.mjs` (единственная правка общего файла).
- `tests/tunewizard.test.cjs` на синтетике: ослабление notch на центральной частоте; пик FFT синусоиды; отклик модельной системы с известными метриками; автоподбор на синтетическом спектре; проверки шага 0 на поддельных параметрах; текст `.param`.
- Регрессия переноса: спектры и step response мастера совпадают с FilterReview / PIDReview на одном и том же реальном логе (`TuneWizard/logs/`, в `.gitignore`).
- Нужен Node ≥ 22 (`winget install OpenJS.NodeJS.LTS`).

## 8. Этапы

1. Каркас страницы, темы, шаг 0 (лог, проверки, график полёта).
2. Перенос gyro / filters / tracking, шаги 1–2 с автоподбором.
3. Шаг 3 (LPF, бодэ).
4. Перенос pid / step response, метрики, шаг 4.
5. Сводка, `.param`, память прохода, печать.
6. Readme, иконка, ссылка на лендинге.

Каждый этап закрывается линтом, тестами и ручной проверкой на реальном логе; коммит на этап, push в `origin`.

## 9. Открытые вопросы

- Пороги VIBE / clipping сверить со страницей wiki «Measuring Vibration».
- Нужны 1–2 реальных `.bin` с batch/raw IMU и битом PID для регрессии.
- Пороги, помеченные **[наше]**, уточнить по результатам на реальных логах.

## 10. Источники

- README и ESLint-конфиг WebTools: https://github.com/ArduPilot/WebTools
- PR #363 «FilterReview: add auto fit for the first notch», PR #362 (до четырёх notch), PR #328 (FFT фильтров цели/ошибки PID)
- Notch: https://ardupilot.org/copter/docs/common-imu-notch-filtering.html, …/common-throttle-based-notch.html, …/common-esc-telem-based-notch.html, …/common-imu-fft.html
- Логирование: https://ardupilot.org/copter/docs/common-imu-batchsampling.html, …/common-raw-imu-logging.html
- Настройка: https://ardupilot.org/copter/docs/tuning-process-instructions.html, …/setting-up-for-tuning.html, …/initial-tuning-flight.html, …/ac_rollpitchtuning.html, …/evaluating-the-aircraft-tune.html
- Исходники ArduPilot (локально `C:\Users\taa03\Desktop\Repo\ardupilot`): `libraries/AC_AutoTune/AC_AutoTune_Multi.cpp`, `libraries/AC_AttitudeControl/AC_AttitudeControl.h`, `libraries/Filter`, `libraries/AP_InertialSensor`
