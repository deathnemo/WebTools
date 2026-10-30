# Мастер настройки — этап 9: QuadPlane (VTOL) (дизайн)

Дата: 30.10.2026. Статус: утверждён пользователем 30.10.2026 (вместе с предложениями раздела 14). Основа — общий дизайн `2026-10-23-tune-wizard-design.md`, шаг 3 — `2026-10-24-tune-wizard-stage3-design.md`, подготовка к полёту — `2026-10-30-tune-wizard-stage7-design.md`.

Факты ArduPlane — исследование 30.10.2026 по `modules/ardupilot` (ArduPlane 4.8.0-dev, `f3836cfae7`): ссылка `[код] файл:строка` без пометки — эта версия, `[4.6.3]` — тег `Plane-4.6.3` (версия пользователя). [лог] — проверено на третьем логе `TuneWizard/logs/1 01.01.1980 2-00-00.bin` (журнал, раздел 8). Ещё пометки: [наше], [решение пользователя 30.10.2026], «не проверено». Отчёты исследования — во временной папке сеанса, главное перенесено сюда.

Повод: решение пользователя 30.10.2026 — мастер для Copter и QuadPlane. На третьем логе (ArduPlane 4.6.3, tailsitter `QUAD/X`, весь полёт в QSTABILIZE) мастер сейчас отказывает на шаге 0 («только Copter»), а без отказа ошибся бы молча: газ полёта из `CTUN.ThO` — нули («полёта нет»), шаг 3 подставил бы заводские Copter вместо `Q_A_RAT_*` лога, проверка `pid_log` оценила бы самолётные `PIDR`, а совет «бит 12» у Plane включает CAMERA.

## 1. Решения пользователя (30.10.2026)

- Поддерживаются Copter и QuadPlane — VTOL-часть ArduPlane; самолётная часть (крыло, `RLL_RATE_*`/`PTCH_RATE_*`) — нет: лог Plane без `Q_ENABLE` — отказ, как сейчас.
- Этап 9: для QuadPlane — шаги 0–3, сводка (шаг 5) и подготовка к полёту. Шаг 4 (PID) — «пока недоступно»: по логу пользователя контур скорости не измерить (PIQx 24 Гц, полёт в QSTABILIZE); шаг 4 — следующим этапом, когда будет лог QACRO.
- Подготовка к полёту подсказывает, как записать лог для будущего шага 4: бит 20 ATTITUDE_FULLRATE в `LOG_BITMASK`, QACRO на переключателе, `ACRO_LOCKING = 0`.
- Интервал анализа по умолчанию — только VTOL-режимы; при нескольких VTOL-участках — самый длинный, остальные шаг 0 называет.
- Шаг 3 для QuadPlane — без формулы по размеру винта (источника для `Q_A_RAT_*` нет): варианты «Как в логе», «Лог + правило /2», «Свой» с теми же метриками; пределы ускорения — из лога (`Q_A_ACCEL_*_MAX` в 4.6, сантиградусы/с²; `Q_A_ACC_*_MAX` в 4.7+, °/с²).

## 2. Что видит пользователь

Copter — без изменений. Лог QuadPlane:

- **Шаг 0.** Плитка «Аппарат» — «QuadPlane» (у tailsitter — «QuadPlane · tailsitter»), подсвечена как поддержанная; плитки «Висение VTOL» и «Средний газ VTOL»; на графике полёта — газ VTOL-моторов. Интервал по умолчанию — самый длинный VTOL-участок; подпись под полями — «у QuadPlane — только VTOL-режимы (Q-режимы)». Проверки — раздел 4. Лог Plane без QuadPlane — СТОП «Аппарат».
- **Шаги 1–2** — как у Copter, по VTOL-интервалу. У tailsitter под спектром шага 1 — заметка: «ось Z гироскопа — крен VTOL, Y — тангаж, X — рыскание (со знаком минус)».
- **Шаг 3** — без поля размера винта; варианты «Как в логе», «Лог + правило /2», «Свой»; форма и таблица — с именами `Q_A_RAT_*` и пределами ускорения лога; у tailsitter шум D крена — по оси Z (подпись графика D «Крен VTOL (Z)»).
- **Шаг 4** — кнопка в полосе шагов выключена, подсказка — раздел 7.
- **Шаг 5** — как у Copter; строка шага 4 — «для QuadPlane пока недоступен»; `_tune.param` с именами `Q_A_*`.
- **Подготовка к полёту** — те же три цели; у QuadPlane цель «PID» — «лог QACRO для будущего шага 4»; таблица положений — с режимами Plane и каналом `FLTMODE_CH`; правила — раздел 9. Только файл `.param` QuadPlane без лога — блок, как у Copter.

## 3. Распознавание и профиль аппарата

**Вид лога:** `VER.BU = 2` — Copter; `VER.BU = 3` и `Q_ENABLE ≥ 1` — QuadPlane (`0:Disable, 1:Enable, 2:Enable VTOL AUTO`; QuadPlane поднимается при любом ненулевом — [код] `quadplane.cpp:8–14, 680`); иначе — не поддержан. Tailsitter — `Q_TAILSIT_ENABLE > 0` ([код] `tailsitter.cpp:26–33`). **Вид файла `.param`:** есть `ATC_RAT_RLL_P` — Copter, `Q_A_RAT_RLL_P` — QuadPlane (`Q_*` скрыты при `Q_ENABLE = 0` — флаг ENABLE, [код] `quadplane.cpp:14`), ни того ни другого — отказ.

Профиль — одна таблица на вид (код — раздел 10). Различия:

| Что | Copter | QuadPlane | Источник (QuadPlane) |
|---|---|---|---|
| Шаги | 0–5 | 0–3, 5 | [решение пользователя 30.10.2026] |
| Регулятор, моторы | `ATC_`, `MOT_` | `Q_A_` (тот же `AC_AttitudeControl_Multi`, суффиксы те же), `Q_M_` (тот же `AP_MotorsMulticopter`) | [код] `Parameters.cpp:817–821`, `quadplane.cpp:17–19, 768`, `AC_PID.cpp:13–96` |
| Сообщения PID | PIDR/PIDP/PIDY | PIQR/PIQP/PIQY; PIDR/PIDP/PIDY у Plane — самолётные регуляторы | [код] `Log.cpp:30–39, 46–51` |
| PID с частотой цикла | бит 0 ATTITUDE_FAST (и бит 12 PID) | бит 20 ATTITUDE_FULLRATE; бит 0 — 25 Гц, бит 1 — 10 Гц; бита PID нет, бит 12 — CAMERA; заводская маска 65535 — без бита 20 | [код] `defines.h:102–121`, `Plane.cpp:269–330`, `Log.cpp:58–65`, `config.h:179` ([4.6.3] `config.h:176`) |
| IMU_RAW, batch | бит 19 | бит 19; batch и raw — общий код | [код] `system.cpp:13`, `defines.h:117`, `BatchSampler.cpp:23–30` |
| Газ полёта | `CTUN.ThO` → `RATE.AOut` | `QTUN.ThO` → `RATE.AOut` (газ VTOL-моторов 0…1); `CTUN.ThO` Plane — самолётный мотор, в VTOL ≈ 0 | [код] `quadplane.cpp:3751, 1801–1808`, `AC_AttitudeControl_Logging.cpp:50`, `Log.cpp:105` |
| Окно полёта | весь полёт с газом | участки VTOL-режимов 17–23 по `MODE` (`is_vtol_mode`) | [код] `mode.h:735, 769, 802, 832, 853, 889, 912` |
| Режимы | номера Copter | Plane: 0 MANUAL … 17 QSTABILIZE, 18 QHOVER, 19 QLOITER, 20 QLAND, 21 QRTL, 22 QAUTOTUNE, 23 QACRO … 26 AUTOLAND | [код] `mode.h:38–75` |
| Рама в MSG | «Frame: …» | «QuadPlane Frame: …» | [код] `Log.cpp:573–574` |
| Газ висения | `MOT_THST_HOVER`, `MOT_HOVER_LEARN`; учится в AltHold (текст шага 0) | `Q_M_THST_HOVER`, `Q_M_HOVER_LEARN` (0/1/2, заводское 2); учится только при работающем регуляторе высоты — QHOVER, QLOITER, QLAND, QRTL, VTOL в AUTO/GUIDED; не в QSTABILIZE и QACRO | [код] `AP_MotorsMulticopter.cpp:136–150`, `quadplane.cpp:1918–1960` (регулятор Z — 1941–1944), `quadplane.cpp:1101–1116`, `mode_qloiter.cpp:177`, `mode_qland.cpp:27–32`, `mode_qrtl.cpp:120` |
| Заводские фильтры | FLTT, FLTD 20; FLTE 0 / 0 / 2.5 | FLTD крена и тангажа 10, остальное как у Copter | [код] `quadplane.cpp:581–590` ([4.6.3] 564–590), `AC_AttitudeControl_Multi.h:10–38` |
| Заводские пределы ускорения | 1100 / 1100 / 270 °/с² | 400 / 400 / 100 °/с² (4.6: 40000 / 40000 / 10000 сантиградусов/с²); при `Q_FRAME_CLASS = 10` крен и тангаж 300 | [код] `quadplane.cpp:604–606`, [4.6.3] `quadplane.cpp:587–589`, `tailsitter.cpp:186–187, 231–234` |
| Имена пределов | `ATC_ACCEL_*_MAX` (4.6, сантиградусы/с²) / `ATC_ACC_*_MAX` (°/с²) | `Q_A_ACCEL_{R,P,Y}_MAX` (4.6) / `Q_A_ACC_{R,P,Y}_MAX` (4.7+); перевод — `convert_parameters`, ×0.01 | [код] [4.6.3] `AC_AttitudeControl.cpp:38–73`; `AC_AttitudeControl.cpp:175–203, 1156–1191` |
| `SCHED_LOOP_RATE` по умолчанию | 400 (умолчание FilterReview) | 300 при `Q_ENABLE` (без — 50); арминг QuadPlane требует ≥ 100 | [код] `AP_Scheduler.cpp:43–47`, `Parameters.cpp:1365–1370`, `AP_Arming_Plane.cpp:166–169` |
| Оси гироскопа (крен, тангаж) | X, Y | X, Y; tailsitter — Z, Y (рыскание — −X): регулятор VTOL работает в виде, повёрнутом на 90° по тангажу | [код] `quadplane.cpp:763`, `AP_AHRS_View.cpp:24–88`; [лог] корреляция `RATE` с `IMU[0]`: R↔Z +1.00, P↔Y +1.00, Y↔X −1.00 |
| Acro «только контур скорости» | ACRO 1, `ACRO_OPTIONS` бит 1, `ACRO_TRAINER = 0` | QACRO 23, `ACRO_LOCKING = 0` (`input_rate_bf_roll_pitch_yaw_2` — как Rate Loop Only); тренера нет | [код] `mode_qacro.cpp:64–69`, `Parameters.cpp:573–578`; grep `trainer` по `ArduPlane/` — пусто |
| Выход из Acro | STABILIZE 0, ALT_HOLD 2, LOITER 5, POSHOLD 16 | QSTABILIZE 17, QHOVER 18, QLOITER 19 | [код] `mode_qstabilize.cpp:12–40`, `quadplane.cpp:1101–1116`; [решение пользователя 30.10.2026] |
| Быстрый поток `FSTRATE_*` | есть (4.7) | нет | grep `FSTRATE` по `ArduPlane/` — пусто (карта исследования) |

## 4. Шаг 0

**Интервал по умолчанию** [решение пользователя 30.10.2026; склейка и запасной путь — наше]:

1. Участки режимов по `MODE` (`Mode` = `ModeNum`, [код] `LogFile.cpp:477–478`) — функция переносится из `pidtune_mode_segments` в `core/log.js`.
2. VTOL-участки — режимы 17–23; соседние VTOL-режимы (QHOVER → QLOITER → QLAND) склеиваются в один.
3. Внутри участка — окно газа VTOL, как `throttle_window`: от первого до последнего ненулевого газа, 1 с внутрь.
4. Берётся самый длинный, остальные называет проверка «Полёт». Нет `MODE` — окно по газу, как у Copter, с предупреждением.

- **Почему не по газу:** у tailsitter с `Q_TAILSIT_ENABLE = 2` и при Q-assist `RATE` и `QTUN` пишутся и в самолётных режимах ([код] `quadplane.cpp:1767–1776, 1812–1826`, `tailsitter.cpp:237–238`).
- **Ограничение:** VTOL-участки внутри AUTO и GUIDED (VTOL-взлёт, посадка, удержание) по `MODE` не видны ([код] `quadplane.cpp:2084–2113, 2122–2148`) — в интервал по умолчанию не входят, его можно задать вручную. Пишется в Readme и в плане подготовки.
- **Источник газа** — `QTUN.ThO`, запасной `RATE.AOut`: оба — газ VTOL-моторов, оба пишутся без `LOG_BITMASK`; `QTUN` — 25 Гц, как `CTUN` у Copter, и не прерывается на SystemID, в отличие от `RATE` ([код] `quadplane.cpp:1815–1826, 1834–1838`). [лог] оба дают окно 317–382 с и средний газ 0.47.

**Проверки.** `gyro_log`, `pre_post`, `tracking`, `clipping` — общие, без изменений. Меняются:

| id | QuadPlane | Источник |
|---|---|---|
| `vehicle` | OK «QuadPlane (tailsitter), ArduPlane V…, плата»; Plane без `Q_ENABLE` — СТОП «мастер поддерживает Copter и QuadPlane», что сделать — «Загрузите лог ArduCopter или ArduPlane с Q_ENABLE ≥ 1» | раздел 3 |
| `pid_log` | «Сообщения PID VTOL» — PIQR/PIQP/PIQY и частота PIQR: от 99 Гц — OK, ниже — ВНИМ «включите бит 20 ATTITUDE_FULLRATE в `LOG_BITMASK` — для будущего шага 4»; PIQ нет — ВНИМ; в тексте — «шаг 4 для QuadPlane пока недоступен»; совета «бит 12» нет | [код] `Log.cpp:30–39, 58–65`, `defines.h:102–121`; [лог] PIQR 24.2 Гц |
| `flight` | «Висение VTOL N с (от–до, режим), средний газ …»; другие VTOL-участки — «ещё: от–до (режим) …»; газа нет — «нет QTUN и RATE»; VTOL-участков с газом нет — СТОП «VTOL-полёта в логе нет»; порог 30 с — как сейчас | этот раздел |
| `vibe` | как сейчас, по всему логу: в него попадает и самолётный полёт — ограничение, в Readme | раздел 14, д |
| `hover_throttle` | `Q_M_THST_HOVER` против среднего газа VTOL-окна, допуск 0.05 [наше]; что сделать — `Q_M_HOVER_LEARN = 2`, а при включённом — «повисите не меньше 30 с в QHOVER или QLOITER: в QSTABILIZE и QACRO газ висения не учится». Ещё условие обучения — оценка воздушной скорости ниже 0.3·`AIRSPEED_MIN`; есть ли она без датчика скорости — не проверено (на третьем логе ARSP есть) | [код] `quadplane.cpp:1918–1960`, 1951–1953 |

[лог] ожидается: `vehicle` OK, `pid_log` ВНИМ (24 Гц), `pre_post` ВНИМ (`INS_LOG_BAT_OPT = 5`), `flight` OK (≈65 с), `vibe` СТОП (уровень мастера 71.6 м/с²), `clipping` ВНИМ, `hover_throttle` ВНИМ (0.35 против 0.47, `Q_M_HOVER_LEARN = 0`).

## 5. Шаги 1–2

- Ядро шагов 1–2 на третьем логе работает без правок при интервале 317–382 с: batch двух IMU ≈3190 Гц, трекинг по газу через `Q_M_*` и `Q_FRAME_CLASS`, ESC, автоподбор notch по ESC — 160 Гц [лог]. Notch по газу у Plane — от газа VTOL-моторов, как у Copter ([код] `AP_Vehicle.cpp:801–842`); `core/tracking/Throttle.js` уже берёт `RATE.AOut` и `Q_M_*`. «Открыть в FilterReview» — upstream понимает Plane (`FilterReview/tracking/Throttle.js:133`).
- Умолчание `SCHED_LOOP_RATE`, если его нет в логе (`step1.js`, `values_from_log`), — из профиля: 300 вместо 400.
- **Batch с битами 0 и 2** (`INS_LOG_BAT_OPT = 5`, выборка на частоте датчика): по правилу этапа 7 обе половины — до фильтров ([код] `BatchSampler.cpp:103–115`, `AP_InertialSensor_Backend.cpp:503–508, 727–738`). На третьем логе — проверить на шаге 1: средние спектры «до» (экземпляр 0) и «после» (экземпляр 2) в интервале совпадают и провалов notch у «после» нет — правило подтверждено; провалы есть — поправить правило шага 0 и подготовки. Итог — в журнал, раздел 8.
- У tailsitter — заметка об осях под спектром (раздел 2); пики и их происхождение — без изменений.

## 6. Шаг 3

- **Варианты:** «Как в логе»; «Лог + правило /2» — `INS_GYRO_FILTER` лога, FLTT и FLTD крена и тангажа и FLTT рыскания = max(10, `INS_GYRO_FILTER` / 2): правило Copter [MP, wiki Copter], для QuadPlane своего источника нет, применяется к тому же классу регулятора [решение пользователя 30.10.2026]; «Свой». Поля размера винта и варианта «По размеру винта» нет: формулы для QuadPlane в `modules/ardupilot` нет (только примеры `.param` — `Tools/Frame_params/QuadPlanes/`), в Mission Planner и wiki Plane — не проверено.
- **Рекомендации нет**, как у Copter без размера винта: вердикт сравнивает «Лог + правило /2» с логом, выбирает пользователь (раздел 14, е).
- **Имена** — префикс профиля: `Q_A_RAT_{RLL,PIT,YAW}_{FLTT,FLTE,FLTD}`, `Q_A_RAT_*_D`, `Q_A_RAT_*_NEF`, пределы `Q_A_ACCEL_*_MAX` (сантиградусы/с²) или `Q_A_ACC_*_MAX` (°/с²) — та же логика «есть `<префикс>ACCEL_R_MAX` → сантиградусы». `INS_GYRO_FILTER`, `INS_ACCEL_FILTER` — общие.
- **Значения** — из лога; нет в логе — заводские профиля (раздел 3). [лог] «Как в логе»: `Q_A_RAT_*_FLTD` 25.5, `INS_GYRO_FILTER` 40, пределы 70000 / 70000 / 28800 (700 / 700 / 288 °/с²); «Лог + правило /2» — FLTT и FLTD 20. Сейчас мастер подставил бы заводские Copter (FLTD 20, 1100 / 1100 / 270) — главный риск этапа.
- **Пределы ускорения** — только из лога, правятся в форме («Свой»). Условие «формула — только при заводских» у QuadPlane не нужно; заводские профиля — только для отсутствующих в логе.
- **Метрики** — те же: шум гироскопа, шум D крена и тангажа, задержка путей P и D на частоте `SCHED_LOOP_RATE` (регулятор VTOL — в основном цикле; [лог] RATE 383 Гц при 400). Ось гироскопа для D — из профиля: у tailsitter крен — Z; цвет графика D крена — цвет оси Z.
- **Описания параметров:** у `Q_A_<X>` — описание `ATC_<X>` из `FilterReview/params.json` (тот же класс); у `Q_A_ACCEL_*` — описание `ATC_ACC_*` с заметкой о сантиградусах, как сейчас у `ATC_ACCEL_*`. `@RebootRequired` в группе `Q_A_` нет ([код] grep по `AC_AttitudeControl*.cpp`, `AC_PID.cpp`).
- **Предупреждения модели:** `Q_A_RAT_RLL/PIT_NEF` ≠ 0 — как у Copter; `FSTRATE_ENABLE` у Plane нет — ветка не сработает. `Q_TRIM_PITCH` ≠ 0 слегка смешивает оси R и Y tailsitter ([код] `quadplane.cpp:312–320`) — модель считает трим нулевым (раздел 13).

## 7. Шаг 4 — закрыт для QuadPlane

- Одна точка: `step_available(4)` — по `profile.steps`. `step4_show` и `load_pid` не вызываются, `step4_ready()` ложно — сводка, память и строки сравнения шага 4 молчат сами. `core/pid.js`, `core/pidtune.js`, `steps/step4.js` не меняются.
- Текст — подсказка кнопки шага 4 (`title`) и строка шага 5: «Шаг 4 (PID) для QuadPlane пока недоступен: по логу с PIQR/PIQP/PIQY 25 Гц и полётом в QSTABILIZE контур скорости не измерить. Нужен лог QACRO — подготовьте его в «Подготовке к следующему полёту» (цель «PID»); шаг 4 появится следующим этапом».
- На будущий этап (на логе не проверено): тестовый полёт — QACRO при `ACRO_LOCKING = 0`; масштаба I на `Q_A_ANG_*_P` в QACRO нет — `scale_I_to_angle_P()` ([код] `AC_AttitudeControl.cpp:1145–1153`) зовёт только `ArduCopter/mode_acro.cpp:57`; образец разбора — upstream `PIDReview.js:1478–1489`.

## 8. Шаг 5 и память

- **Сводка:** имена шага 3 приходят с префиксом профиля; строка шага 4 — раздел 7; пункт «повторить проход» — «шаги 2–3 покажут, сбылся ли прогноз»; «менять нечего» — для неподдержанного вида (было — «не Copter»); `summary_reboot_names` ищет метаданные `Q_A_<X>` по `ATC_<X>` — одно место с шагом 3 (`step_find_metadata`).
- Пары повторов «что сделать» прежние: `pid_log` ↔ `log_pid`, `log_fast`; `hover_throttle` ↔ `hover_learn` (у QuadPlane `log_fast` — правило бита 20, раздел 9).
- **Память прохода:** вид аппарата — в ключе. У Copter ключ прежний (`fc:<строка>` / `log:…` — старые проходы находятся), у QuadPlane — `quadplane·` + тот же ключ: одна плата на Copter и на QuadPlane — разные аппараты, «применено» не сравнит `ATC_*` с `Q_A_*`. В записи — поле `kind` (нет — Copter), версия формата прежняя. Список проходов для выбора (лог без строки контроллера) — только того же вида. Рама запасного ключа — из «QuadPlane Frame: …».

## 9. Подготовка к полёту

Цели — те же три; тексты у QuadPlane: «Фильтры» — «шаги 1–3: висение в Q-режиме», «PID» — «лог QACRO для будущего шага 4», «Фильтры и PID» — «висение и QACRO в одном полёте». Номера и имена режимов в таблице положений — Plane; канал — `FLTMODE_CH` (у Plane по умолчанию 8; положения и PWM — тот же `read_6pos_switch`: [код] `Parameters.cpp:468–473`, `RC_Channel.cpp:589–624`, `control_modes.cpp:106–123`).

| id | Цель | QuadPlane | В файл | Источник |
|---|---|---|---|---|
| `log_backend`, `gyro_data`, `gyro_prepost`, `log_buffer`, `notch_source` | как у Copter | как у Copter: общий код AP_Logger, AP_InertialSensor, AP_BLHeli; IMU_RAW — бит 19 | как у Copter | [код] `system.cpp:13`, `defines.h:117`, `BatchSampler.cpp:23–30`, `AP_Vehicle.cpp:878–893` |
| `log_pid` | P | нет правила: PIQx пишутся вместе с ATT без своего бита, бит 12 — CAMERA | — | [код] `Log.cpp:30–39`, `defines.h:102–121` |
| `log_fast` | P | бит 20 ATTITUDE_FULLRATE в `LOG_BITMASK`: без него PIQx — 25 Гц; нет — СТОП | бит 20 (+1048576: 65535 → 1114111) | [код] `Plane.cpp:269–330`, `Log.cpp:58–65`; нужен ли вместе с ним бит 0 — не проверено |
| `acro_slot` | P | QACRO (23) в одном из `FLTMODE1–6`; нет — СТОП; предложение положения 6 — как у Copter | `FLTMODE<N> = 23` | [код] `mode.h:38–75` |
| `acro_exit` | P | кроме QACRO — QSTABILIZE 17, QHOVER 18 или QLOITER 19; нет — СТОП | — | [код] `mode_qstabilize.cpp:12–40`; [решение пользователя 30.10.2026] |
| `acro_rate_only` | P | `ACRO_LOCKING = 0`; иначе — СТОП: 1 и 2 в QACRO удерживают угол (поправка углового контура), но не выравнивают | `ACRO_LOCKING = 0` | [код] `mode_qacro.cpp:64–69`, `AC_AttitudeControl.cpp:650–737`, `Parameters.cpp:573–578` |
| `acro_trainer`, `fstrate` | P | нет правил: аналогов в Plane нет | — | grep `trainer`, `FSTRATE` по `ArduPlane/` — пусто |
| `hover_learn` | Ф | `Q_M_HOVER_LEARN = 2`; логика как у Copter (с проверкой шага 0 `hover_throttle`); совет — висение в QHOVER или QLOITER | `Q_M_HOVER_LEARN = 2` | [код] `AP_MotorsMulticopter.cpp:143–150`, `quadplane.cpp:1918–1960` |

- **Перезагрузка** — прежний список (`INS_LOG_BAT_*`, `LOG_BACKEND_TYPE`, `LOG_FILE_BUFSIZE`): у `LOG_BITMASK`, `FLTMODE1–6`, `ACRO_LOCKING` в Plane `@RebootRequired` нет ([код] `Parameters.cpp:475–510, 573–578, 628–633`, сверено при дизайне).
- **План:** фильтры — «взлёт в QSTABILIZE или QHOVER, висение не меньше 30 с (лучше 60) без стиков в Q-режиме: VTOL-участки AUTO и GUIDED шаги 1–3 не берут»; PID — QACRO положением N, 2–3 минуты резких отклонений по одной оси, выход — положением QSTABILIZE/QHOVER/QLOITER, «в QACRO аппарат сам не выравнивается»; у tailsitter — «крен VTOL — стиком руля направления, рыскание — элеронами» ([код] `mode_qacro.cpp:53–57`); последний пункт — «сохраните лог: шаг 4 для QuadPlane появится следующим этапом» вместо «Интервал — участок ACRO».
- **Источник:** вид файла — по признаку (раздел 3). Файл и лог разных видов — отказ: «Файл «…» — <вид>, лог — <вид>: выберите файл этого аппарата или уберите файл»; без лога — любой поддержанный вид. `hover_check` из лога — только при том же виде.
- [лог] третий лог, цель «Фильтры и PID»: СТОП `log_fast` и `acro_slot` (предложено положение 6: FBWA → QACRO, выход — положение 1, QSTABILIZE); ВНИМ `gyro_prepost` (`INS_LOG_BAT_OPT = 4`) и `hover_learn` (`Q_M_HOVER_LEARN = 2`); OK `acro_rate_only`.

## 10. Код

- **`TuneWizard/core/vehicle.js`** — новый, первым из `core/` в `index.html`; префикс `vehicle_` свободен (grep по `Libraries/` и `TuneWizard/`). `vehicle_profiles` (copter, quadplane; поля по разделу 3: `steps`, `atc`, `mot`, `pid_messages`, `throttle`, `frame_prefix`, `vtol_modes`, `modes`, `acro_mode`, `level_modes`, `fullrate_bit`, `param_marker`, заводские фильтры и пределы, `loop_rate_default`, тексты режимов), `vehicle_kind(build_type, params)`, `vehicle_kind_of_params(params)`, `vehicle_profile(kind)`, `vehicle_atc`, `vehicle_mot`, `vehicle_gyro_axes(profile, params)` (tailsitter), `vehicle_accel_defaults(profile, params)` (`Q_FRAME_CLASS = 10`). Двойной скрипт (`module.exports`) — в `DUAL_SCRIPTS` `eslint.config.mjs` (файл ArduPilot — раздел 6 журнала).
- **`core/log.js`:** `log_info(log, version, profile)` — профиль аргументом (тесты грузят файл через `require`, глобалов страницы там нет); в `info` — `kind`, `profile`, `tailsitter`, `flight.segments`; `throttle_series` и `log_messages.pid` — по профилю; `log_mode_segments` (из `pidtune_mode_segments`, там остаётся обёртка) и окно VTOL; `log_frame` — префикс профиля; `pid_log_rates` — первое сообщение PID профиля.
- **`core/checks.js`:** `run_checks` читает `info.profile` (раздел 4); биты Plane — в `check_rules` с источниками.
- **`wizard.js`:** вид — после `log_params`, до `log_info`; `step_available` по `profile.steps`, подсказка кнопки шага 4, плитки, ряд газа графика, интервал по умолчанию.
- **`core/lowpass.js`, `steps/step3.js`:** ≈25 строковых сборок `"ATC_RAT_" + …` — через префикс профиля; заводские и оси — из профиля; без формулы — нет поля и варианта «По размеру винта».
- **`steps/common.js`:** `step_find_metadata` — `Q_A_<X>` → `ATC_<X>`.
- **`core/prep.js`, `steps/prep.js`:** правила по профилю (`ctx.profile`), `prep_mode_slots` — имена из профиля, вид источника и отказы, тексты целей и плана; номера ACRO Copter остаются в `pidtune_rules`.
- **`core/summary.js`, `core/passmem.js`, `steps/step5.js`, `steps/step1.js`, `index.html`** — места разделов 2, 5, 8.
- **Не меняются:** `core/pid.js`, `core/pidtune.js` (кроме обёртки), `steps/step4.js`, `core/tracking/*`, ядро шагов 1–2, `Libraries/`, FilterReview, PIDReview. Переносная папка берёт `TuneWizard/` целиком — `vehicle.js` попадёт в неё сам.

## 11. Проверки

- `npm run lint`, `npm test`. Copter-тесты по поведению не меняются: меняются только вызовы `log_info`/`run_checks` (профиль) и списки загрузки скриптов в тестах (`vm.runInThisContext`).
- `tests/tunewizard.test.cjs` — поддельные логи QuadPlane: `VER.BU = 3`; PARM с `Q_ENABLE`, `Q_A_*`, `Q_M_*`, `Q_TAILSIT_ENABLE`; `CTUN.ThO` из нулей; `QTUN.ThO` и `RATE.AOut`; PIDR и PIQx; `MODE` 17 → 5 → 18 → 20 (интервал без FBWA, склейка 18 → 20, самый длинный участок и список остальных); MSG «QuadPlane Frame: QUAD/X». `run_checks` QuadPlane: `vehicle`, Plane без `Q_ENABLE` — fail, `pid_log` без бита 12 и с советом бита 20, `flight`, `hover_throttle` по `Q_M_*`.
- `tests/tunewizard-vehicle.test.cjs` (новый): `vehicle_kind` (BU 2; 3 с `Q_ENABLE` 1 и 2; 3 с 0 и без параметра; другие BU), `vehicle_kind_of_params`, оси tailsitter, пределы при `Q_FRAME_CLASS = 10`.
- `-lowpass`, `-step3`: имена `Q_A_*`, `Q_A_ACCEL_*` и `Q_A_ACC_*`, заводские QuadPlane, нет варианта по винту, ось Z у tailsitter, NEF. `-prep`: правила QuadPlane по целям (раздел 9), `FLTMODE<N> = 23`, план. `-summary`, `-passmem`: строки с `Q_A_*`, строка шага 4, `repeat`, ключ и `kind`.
- Фикстура `tests/fixtures/prep_quadplane.param` (синтетическая; новый файл в папке upstream — раздел 6 журнала) и сценарий в `tunewizard-prep-browser.cjs`: вид по файлу, правила и план QuadPlane, отказ для Plane без `Q_A_RAT_RLL_P`.
- `tests/tunewizard-browser-log3.cjs`, `npm run test:tunewizard-log3` (`package.json` — раздел 6 журнала; лог — `TUNEWIZARD_LOG3` или `1 01.01.1980 2-00-00.bin`, без лога — пропуск): шаги 0–3 и 5 по образцу `-log2`, шаг 4 выключен, интервал 317–382 с, плитка «QuadPlane · tailsitter», проверки и подготовка — строки [лог] разделов 4 и 9, шаг 1 — сверка «до/после» (раздел 5), шаг 3 — имена и значения лога.
- Прогоны Copter — `test:tunewizard` (тестовый лог), `test:tunewizard-log2`, `test:tunewizard-prep`, `test:tunewizard-compare`, `test:tunewizard-pid-compare` — с прежними результатами.

## 12. Документы

- `TuneWizard/Readme.md`: первая строка — «Copter и QuadPlane (VTOL-часть ArduPlane)»; что работает у QuadPlane и ограничения (шаг 4, VTOL в AUTO/GUIDED, вибрации по всему логу); шаг 3 у QuadPlane; подготовка QuadPlane; «Структура» (`core/vehicle.js`), «Проверки» (`test:tunewizard-log3`), «Готовность».
- `tests/README.md` — новые тесты и фикстура.
- Журнал: раздел 1 — третий лог в «перенести вручную»; 2 — «Copter и QuadPlane»; 3 — решения раздела 1 и утверждённого раздела 14; 4–5 — этап 9; 6 — `core/vehicle.js`, `eslint.config.mjs`, `package.json`, `tests/fixtures/prep_quadplane.param`; 8 — итог сверки batch (бит 0 с битом 2).

## 13. Чего не делаем

- Самолётную часть ArduPlane (крыло, `RLL_RATE_*`, `PTCH_RATE_*`) и шаг 4 для QuadPlane (следующий этап).
- VTOL-участки внутри AUTO и GUIDED: признаки по `ANG` и навигационным командам неоднозначны и на логе не проверены.
- Вибрации и clipping по VTOL-окну; запасной ряд «Высота» без `POS` (`QTUN.BAlt`) — у Copter без GPS так же.
- Формулу по размеру винта для QuadPlane; модель с `Q_TRIM_PITCH` ≠ 0; notch в самолётном полёте (`INS_HNTCH_OPTS` бит 5).
- QAUTOTUNE и SystemID Plane (на платах SystemID — только в пользовательской сборке, [код] `systemid.h:5–8`).

## 14. Предложенное по умолчанию — утверждено 30.10.2026

- а) **Профиль** — `TuneWizard/core/vehicle.js`, префикс `vehicle_`, двойной скрипт в `DUAL_SCRIPTS`; `log.js` и `checks.js` получают профиль аргументом.
- б) **Распознавание** — `VER.BU = 3` и `Q_ENABLE ≥ 1`; tailsitter — `Q_TAILSIT_ENABLE > 0`.
- в) **Газ и окно** — `QTUN.ThO`, запасной `RATE.AOut`; режимы 17–23 по `MODE`, соседние VTOL-режимы склеиваются, берётся самый длинный; VTOL в AUTO/GUIDED — ограничение в документах.
- г) **Оси tailsitter** — крен Z, тангаж Y, рыскание −X: подписи шагов 1 и 3, шум D шага 3.
- д) **Шаг 0** — `pid_log` по PIQx и частоте, ниже 99 Гц — ВНИМ с советом бита 20; `hover_throttle` по `Q_M_*` с текстом о режимах обучения; рама — «QuadPlane Frame: …»; вибрации — по всему логу.
- е) **Шаг 3 без рекомендации** — вердикт сравнивает «Лог + правило /2» с логом, выбор — пользователя.
- ж) **Подготовка** — общие правила, кроме имён и битов Plane; `hover_learn` — `Q_M_HOVER_LEARN`; цель PID — бит 20, QACRO (23), выход 17/18/19, `ACRO_LOCKING = 0`; без `log_pid`, `acro_trainer`, `fstrate`.
- з) **Размер винта** — у QuadPlane поля нет (решение пользователя, раздел 1), поэтому `tunewizard_prop_in` остаётся ключом Copter; отдельный ключ QuadPlane — когда появится формула.
- и) **Память** — вид в ключе (`quadplane·…`, ключ Copter прежний) и поле `kind`, без новой версии формата.
- к) **`.param` другого вида, чем лог**, — отказ с объяснением.
- л) **Третий лог** — сверка на шаге 1 правила этапа 7 «бит 0 с битом 2 — обе половины до фильтров».
- м) **Тесты** — раздел 11. **Ветка** — `tune-wizard-next5`, PR внутри форка (`gh pr create --repo deathnemo/WebTools --base main`).
