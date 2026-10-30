# Мастер настройки — этап 9: QuadPlane (VTOL) (план реализации)

**Исполнение:** координатор отдаёт каждую задачу исполнителю-субагенту, затем — ревью на соответствие плану и ревью качества (журнал, раздел 7); замечания исправляет исполнитель той же задачи.

**Цель:** шаги 0–3, сводка (шаг 5) и подготовка к полёту для логов и `.param` QuadPlane (VTOL-часть ArduPlane); шаг 4 для QuadPlane — закрыт с объяснением. Copter — без изменений поведения.

**Архитектура:** по `docs/plans/2026-10-30-tune-wizard-stage9-design.md` (утверждён 30.10.2026) — разделы указаны в задачах. Профиль аппарата — одна таблица `TuneWizard/core/vehicle.js` (префикс `vehicle_`); код получает профиль, а не проверяет вид в россыпи условий.

**Соглашения:** как на этапах 7–8 (`docs/plans/2026-10-30-tune-wizard-stage7.md`, «Соглашения»): русский язык, стиль соседнего кода, источники правил (`[код] файл:строка`, `[наше]`, `[решение пользователя 30.10.2026]`), коммит на задачу с трейлером `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, сообщение — файлом без BOM (инструмент записи файлов) и `git commit -F`, `git add` по именам, ветка `tune-wizard-next5`, после задачи `git push origin tune-wizard-next5`, в `main` не пушить, журнал ведёт координатор. Перед новым глобальным именем — `grep` по `Libraries/` и `TuneWizard/`.

**Логи (не в git):** тестовый Copter `TuneWizard/logs/2026-06-18 18-54-42_anon.bin`, второй Copter `1 01.01.1970 2-00-00.bin`, третий — QuadPlane tailsitter `1 01.01.1980 2-00-00.bin` (журнал, раздел 8; ожидаемые значения — разделы 4, 6, 9 дизайна, пометки [лог]).

**Проверки (везде):** `npm run lint`; `npm test`; `CHROME_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe"` для `npm run test:tunewizard` (тестовый лог, ≈100–130 с), `test:tunewizard-log2`, `test:tunewizard-prep`; Copter — с прежними результатами. С задачи 2 — `npm run test:tunewizard-log3`.

---

### Задача 1: профиль аппарата и ядро шага 0 (Node)

**Файлы:** создать `TuneWizard/core/vehicle.js`, `tests/tunewizard-vehicle.test.cjs`; изменить `TuneWizard/core/log.js`, `TuneWizard/core/checks.js`, `TuneWizard/index.html` (подключить `core/vehicle.js` первым из `core/`), `eslint.config.mjs` (`DUAL_SCRIPTS`), `tests/tunewizard.test.cjs`; места, где `log_info`/`run_checks` вызываются (страница — только передать профиль; полностью страница — задача 2).

- `vehicle.js` — дизайн, разделы 3 и 10: `vehicle_profiles` (copter, quadplane), `vehicle_kind(build_type, params)`, `vehicle_kind_of_params(params)`, `vehicle_profile(kind)`, `vehicle_atc`, `vehicle_mot`, `vehicle_gyro_axes(profile, params)` (tailsitter: крен Z, тангаж Y, рыскание −X), `vehicle_accel_defaults(profile, params)`; источники — у каждого значения. Двойной скрипт (`module.exports` при `typeof module`), как `core/log.js`.
- `log.js` — раздел 4 и 10: `log_info(log, version, profile)`; газ — по профилю (`QTUN.ThO` → `RATE.AOut` у QuadPlane); участки режимов `log_mode_segments` (перенос из `pidtune_mode_segments`, в `pidtune.js` — обёртка, поведение Copter то же); окно QuadPlane — VTOL-режимы 17–23, склейка соседних, самый длинный, список остальных в `info.flight.segments`; нет `MODE` — окно по газу с пометкой; `log_frame` — префикс профиля («QuadPlane Frame: …»); `pid_log_rates` и `log_messages.pid` — сообщения профиля; в `info` — `kind`, `profile`, `tailsitter`.
- `checks.js` — раздел 4, таблица: `vehicle` (Copter, QuadPlane — OK; Plane без `Q_ENABLE` — СТОП с текстом из дизайна), `pid_log` (у QuadPlane — PIQx, ниже 99 Гц — ВНИМ с советом бита 20, без совета бита 12), `flight` (VTOL-участок и остальные), `hover_throttle` (`Q_M_*`, текст о режимах обучения). Биты Plane — в `check_rules` с источниками.
- Тесты: `tunewizard-vehicle.test.cjs` (раздел 11 дизайна); поддельные логи QuadPlane в `tunewizard.test.cjs` (раздел 11: `VER.BU = 3`, `Q_ENABLE`, `CTUN.ThO` нули, `QTUN`, `RATE.AOut`, PIDR и PIQx, `MODE` 17 → 5 → 18 → 20, MSG «QuadPlane Frame: QUAD/X»): окно, склейка, самый длинный, проверки. Copter-тесты — по поведению без изменений.
- Проверка на третьем логе под Node (скрипт во временной папке): `log_info` и `run_checks` дают ожидаемое раздела 4 ([лог]: окно ≈317–382 с, газ 0.47, проверки).

**Коммит:** `TuneWizard: профиль аппарата и шаг 0 для QuadPlane (ядро)`, push.

---

### Задача 2: страница шага 0, шаги 1–2, закрытие шага 4, браузерный прогон третьего лога

**Файлы:** `TuneWizard/wizard.js`, `TuneWizard/index.html`, `TuneWizard/steps/step1.js` (и `step2.js` при необходимости), `TuneWizard/steps/common.js` (если нужен доступ к профилю), создать `tests/tunewizard-browser-log3.cjs`, `package.json` (`test:tunewizard-log3`).

- Раздел 2 (шаг 0), 5, 7 дизайна: вид аппарата после `log_params` (`state.profile`, `state.kind`), плитки («QuadPlane · tailsitter», «Висение VTOL», «Средний газ VTOL»), ряд газа графика полёта по профилю, интервал по умолчанию — VTOL-окно, подпись под полями для QuadPlane; `step_available` по `profile.steps`, подсказка кнопки шага 4 (текст из раздела 7); шаг 1 — заметка об осях tailsitter, умолчание `SCHED_LOOP_RATE` из профиля.
- Шаг 1 на третьем логе — сверка правила «бит 0 с битом 2» (раздел 5): сравнить средние спектры «до» и «после» в интервале — итог в отчёт (координатор запишет в журнал); если правило не подтвердилось — сказать, что именно видно.
- `tests/tunewizard-browser-log3.cjs` (по образцу `tunewizard-browser-log2.cjs`, лог — `TUNEWIZARD_LOG3` или `1 01.01.1980 2-00-00.bin`, без лога — пропуск): шаги 0–2 и выключенный шаг 4 (шаг 3 и 5 добавят задачи 3–4), интервал, плитки, проверки шага 0 (ожидаемое раздела 4), спектр шага 1 и notch шага 2 считаются, ошибок консоли нет.

**Коммит:** `TuneWizard: QuadPlane на шагах 0–2, шаг 4 закрыт, прогон третьего лога`, push.

---

### Задача 3: шаг 3 для QuadPlane

**Файлы:** `TuneWizard/core/lowpass.js`, `TuneWizard/steps/step3.js`, `TuneWizard/steps/common.js` (`step_find_metadata`: `Q_A_<X>` → `ATC_<X>`), тесты `tests/tunewizard-lowpass.test.cjs`, `tests/tunewizard-step3.test.cjs`, вставка в `tests/tunewizard-browser-log3.cjs`.

- Раздел 6 дизайна: ≈25 сборок `"ATC_RAT_" + …` — через префикс профиля; заводские и оси — из профиля (`vehicle_accel_defaults`, `vehicle_gyro_axes`); пределы `Q_A_ACCEL_*_MAX` (сантиградусы/с²) / `Q_A_ACC_*_MAX` (°/с²); у QuadPlane — без поля размера винта и варианта «По размеру винта», варианты «Как в логе», «Лог + правило /2», «Свой», без рекомендации; шум D крена tailsitter — ось Z, подпись и цвет; предупреждения NEF; Copter — без изменений.
- Третий лог: «Как в логе» — `Q_A_RAT_*_FLTD` 25.5, `INS_GYRO_FILTER` 40, пределы 70000/70000/28800; «Лог + правило /2» — FLTT и FLTD 20.

**Коммит:** `TuneWizard: шаг 3 для QuadPlane`, push.

---

### Задача 4: шаг 5 и память прохода

**Файлы:** `TuneWizard/core/summary.js`, `TuneWizard/core/passmem.js`, `TuneWizard/steps/step5.js`, `TuneWizard/steps/memory.js`, тесты `tests/tunewizard-summary.test.cjs`, `tests/tunewizard-passmem.test.cjs`, вставка в `tests/tunewizard-browser-log3.cjs`.

- Раздел 8 дизайна: имена шага 3 с префиксом профиля, строка шага 4 «для QuadPlane пока недоступен», `repeat` без шага 4, «менять нечего» для неподдержанного вида; метаданные `Q_A_<X>` для перезагрузки; память — вид в ключе (`quadplane·…`, ключ Copter прежний — старые проходы находятся), поле `kind`, список проходов того же вида, рама запасного ключа из «QuadPlane Frame». Версия формата прежняя.
- Третий лог: шаг 3 принят → сводка с `Q_A_*`, `_tune.param`, «Запомнить проход», шаг 0 повторной загрузки показывает прошлый проход.

**Коммит:** `TuneWizard: сводка и память прохода для QuadPlane`, push.

---

### Задача 5: подготовка к полёту для QuadPlane

**Файлы:** `TuneWizard/core/prep.js`, `TuneWizard/steps/prep.js`, `tests/tunewizard-prep.test.cjs`, создать `tests/fixtures/prep_quadplane.param`, `tests/tunewizard-prep-browser.cjs` (сценарий QuadPlane), вставка в `tests/tunewizard-browser-log3.cjs`.

- Раздел 9 дизайна: правила по профилю (`ctx.profile`); у QuadPlane — `log_fast` = бит 20, `acro_slot` = QACRO 23, `acro_exit` = 17/18/19, `acro_rate_only` = `ACRO_LOCKING = 0`, `hover_learn` = `Q_M_HOVER_LEARN`; без `log_pid`, `acro_trainer`, `fstrate`; общие правила записи и фильтров; таблица положений — режимы Plane; тексты целей и плана (tailsitter: крен VTOL — руль направления, рыскание — элероны; последний пункт — «сохраните лог: шаг 4 для QuadPlane — следующим этапом»); вид источника — `vehicle_kind_of_params`, файл и лог разных видов — отказ; `hover_check` — только того же вида.
- Фикстура синтетическая; сценарий в `tunewizard-prep-browser.cjs`: вид по файлу, правила и план QuadPlane, отказ для файла Plane без `Q_A_RAT_RLL_P` и для файла QuadPlane при логе Copter (если в тесте без лога — только первые два).
- Третий лог: цель «Фильтры и PID» — СТОП `log_fast`, `acro_slot` (предложено 6, выход 1), ВНИМ `gyro_prepost`, `hover_learn`, OK `acro_rate_only`; файл — `LOG_BITMASK` 1114111, `FLTMODE6 = 23`, `INS_LOG_BAT_OPT = 4`, `Q_M_HOVER_LEARN = 2`.

**Коммит:** `TuneWizard: подготовка к полёту для QuadPlane`, push.

---

### Задача 6: документы и финальный прогон

**Файлы:** `TuneWizard/Readme.md`, `tests/README.md` (раздел 12 дизайна).

**Проверки:** все Copter-прогоны (`test:tunewizard`, `-log2`, `-prep`, `-compare`, `-pid-compare`, `-serve`) — прежние результаты; `test:tunewizard-log3` — шаги 0–3 и 5; сборка переносной папки и `node tests/tunewizard-serve.cjs <папка>` (в папку попал `core/vehicle.js`, ссылки на месте).

**Коммит:** `TuneWizard: документы этапа 9`, push. Журнал и PR (`gh pr create --repo deathnemo/WebTools --base main`) — координатор.
