# Мастер настройки — этап 10: шаг 4 на настоящем логе «Rate Loop Only» (план)

> **Для исполнителей-агентов:** обязательный навык — superpowers:subagent-driven-development (так ведутся все этапы проекта: у задачи исполнитель, ревью на соответствие плану и ревью качества). Шаги — флажки `- [ ]`.

**Цель:** на участке Acro «Rate Loop Only» шаг 4 сравнивает проверку (б) с шумом самого лога, проверяет точность отклика (г), показывает погрешность «±», применяет правила с запасом 1σ и советует по оси то, чего не хватает, а не «слетайте тестовый полёт».

**Архитектура:** суррогаты «модель КИХ + перемешанные блоками остатки» считаются в ядре (`core/pidtune.js`) внутри `pidtune_quality` при `rate_only`; их итог (`quality.noise`) читают правила, достоверность и страница шага 4. На остальных интервалах путь прежний.

**Технологии:** браузерные скрипты с общей глобальной областью, ядро без DOM (тесты грузят его через `vm.runInThisContext`), `node:test`, Playwright + Chrome.

**Дизайн:** `docs/plans/2026-11-16-tune-wizard-stage10-design.md` (утверждён 16.11.2026) — читать вместе с планом; номера разделов ниже — его.

## Общие ограничения

- Рабочая копия `C:\Users\user\WebTools`, ветка `tune-wizard-next6`; в `main` не пушить и не сливать; PR — только `gh pr create --repo deathnemo/WebTools --base main`.
- Всё на русском: комментарии, тексты страницы, сообщения тестов и коммитов; имена параметров ArduPilot не переводятся.
- Стиль: 4 пробела, без `;`, объявления `function`, комментарий-контракт перед функцией, источники `[код]`, `[wiki]`, `[наше]`, `[синтетика]`, `[лог4]`.
- Новые глобальные имена — в ядре с префиксом `pidtune_`, на странице — `step4_`; перед новым именем — grep по `Libraries/` и `TuneWizard/`.
- Новый метод — только при `rate_only` (раздел 3, «Где применяется»); на остальных интервалах тексты, плитки, таблица и правила шага 4 прежние.
- Значения (раздел 10): `surrogate_count` 32, `surrogate_block` 512, разброс — половина размаха между 16-м и 84-м процентилями, `halves_ratio_max` 2.5 (нижняя граница — прежний `halves_rms_max` 0.035), `step_sigma_max` 0.08, `step_sigma_goal` 0.05, `rule_margin_sigma` 1, `osc_sigma_k` — из задачи 1 (предварительно 4). Если задача 1 сдвинет значения — берутся её (раздел 11 дизайна).
- Зерно суррогатов — номер оси + 1: крен 1, тангаж 2, рыскание 3.
- Бюджет: ≤ 1.5 с на ось при 400 Гц, ≤ 4 с при 1 кГц.
- Не менять: `core/pid.js`, шаги 0–3, `core/passmem.js` и формат памяти, QuadPlane (шаг 4 у него закрыт), FilterReview, PIDReview, `Libraries/`.
- Коммиты: `git add` только по именам (не `modules/ardupilot`, не `TuneWizard/logs/`, не `AGENTS.md`); сообщение — файлом без BOM, `git commit -F <файл>`; последняя строка — `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push в `origin tune-wizard-next6`.
- Python — `python` (не `python3`); Chrome — `CHROME_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe"`; порт 8000 не занимать (на нём мастер пользователя).
- После каждой задачи: `npm run lint`, `npm test` зелёные; браузерные — где сказано; координатор дописывает журнал (раздел 9 журнала).

## На что смотреть ревью

1. **Лог PID 800 Гц – 1 кГц** (КИХ 800–1000 отводов): суррогаты укладываются в ≤ 4 с на ось — замер задачи 2, шаг 6.
2. **Ось «Rate Loop Only» с данными чуть больше 10 с:** без исключений, без NaN и `undefined` в причинах; «ещё ≈ N с» — число, кратное 5 — тест задачи 2 «короткие данные».
3. **Суррогаты не посчитались** (пул остатков пуст, КИХ суррогатов не решился): отказ при сомнении — (б) и (г) не пройдены с причиной, исключения нет — тест задачи 2 «пул пуст».
4. **Источник оси — RATE** (нет PIDx) в «Rate Loop Only»: «±» у метрик есть, у запаса фазы нет (прогноза по RATE нет), исключений нет — тест задачи 3 «RATE».
5. **Интервал «по умолчанию → участок ACRO → по умолчанию»** на одном логе: каждый раз свои статусы и тексты, без остатков «±» и (г) — браузерный тест задачи 5.

---

### Task 1: исследование и калибровка

**Файлы:**
- Изменить: `docs/plans/2026-11-16-tune-wizard-stage10-design.md` — новый раздел «11. Итог задачи 1»; значения разделов 3.2–3.4 и 10, если сдвинутся.
- Скрипты — во временной папке сеанса (после задачи 1 их копия с выводами — в `docs/plans/2026-11-16-tune-wizard-stage10-research/`). Исходные (можно брать за основу): `C:\Users\user\AppData\Local\Temp\claude\0e56b5549dfffe84\423d6110-5641-4ec2-9f8d-8752cd42e1fa\scratchpad\tw\` — `research.cjs`, `synth.cjs` (генератор `simulate` берётся из `tests/tunewizard-pidtune.test.cjs` как есть), `precision.cjs`, `precision3.cjs`. Четвёртый лог — `TuneWizard/logs/2 01.01.1970 2-00-00.bin`.

**Интерфейсы:**
- Производит (в разделе 11 дизайна): `REAL_NOISE = { dur_s, turb_dps2, dist_dps2 }` — синтетика с остатком 5–9 % дисперсии факта (объект `PLANT_NORMAL`, регулятор `G0`); `TOO_NOISY = { dur_s, turb_dps2, dist_dps2 }` — синтетика, где σ отклика > 0.1; значения `halves_ratio_max`, `step_sigma_max`, `step_sigma_goal`, `osc_sigma_k`.

- [ ] **Шаг 1.** Подобрать `REAL_NOISE` (80 с, остаток 5–9 %) и `TOO_NOISY`; записать.
- [ ] **Шаг 2.** На `REAL_NOISE`, 8 зёрен: (б)/шум без смены объекта и со сменой K ×0.75 и ×1.25 (`plant2`). Порог 2.5 должен лежать между максимумом «без смены» и минимумом «со сменой»; иначе — предложить порог в просвете.
- [ ] **Шаг 3.** 32 суррогата: `sigma_step` и разброс пика по процентилям 16–84 против настоящей ошибки КИХ относительно `truth_step` по 8 зёрнам. Отношение «оценка / правда» — в пределах 0.67–1.5; иначе — что поправить (число суррогатов, длина блока).
- [ ] **Шаг 4.** (г): на [лог4] 289–370 с — 0.08 отделяет рыскание от крена и тангажа при пяти зёрнах (уже проверено: 0.113–0.122 против 0.045–0.053 и 0.030–0.034); `step_sigma_goal` 0.05 даёт перерегулирование ± ≤ 4 п.
- [ ] **Шаг 5.** `osc_sigma_k`: объект с колебаниями на плато (например, K 380 с `G0` — перерегулирование около 40 %) колебания находит, `REAL_NOISE` без колебаний — нет, 8 зёрен.
- [ ] **Шаг 6.** Ранний отклик: почему у крена [лог4] отклик 0.11–0.16 уже на 5 мс (артефакт метода, порядок записи `Tar`/`Act`, сглаженная цель); бывает ли так на `REAL_NOISE`; насколько смещает нарастание 10–90 %. Итог — нужна ли пометка у плитки «Нарастание» (если да — она добавляется в задаче 3).
- [ ] **Шаг 7.** Записать раздел 11 (числа, источники, пути скриптов, что поменялось), поправить значения разделов 3 и 10. Коммит `TuneWizard: дизайн этапа 10 — итог задачи 1 (калибровка)`.

### Task 2: ядро — суррогаты, (б) по шуму, (г), правила с запасом

**Файлы:**
- Изменить: `TuneWizard/core/pidtune.js` — `pidtune_rules` (стр. 44), `pidtune_toeplitz_solve` (252), `pidtune_quality` (479), `pidtune_rule` (940), `pidtune_validity` (1542).
- Тесты: `tests/tunewizard-pidtune.test.cjs`.

**Интерфейсы:**
- Потребляет: значения и `REAL_NOISE`, `TOO_NOISY` задачи 1.
- Производит:
  - `pidtune_rules`: `surrogate_count: 32`, `surrogate_block: 512`, `halves_ratio_max: 2.5`, `step_sigma_max: 0.08`, `step_sigma_goal: 0.05`, `rule_margin_sigma: 1`, `osc_sigma_k` (задача 1) — каждое с источником;
  - `pidtune_toeplitz_factor(col, diag_add) → Float64Array | null` и `pidtune_toeplitz_apply(factor, rhs) → Float64Array`; `pidtune_toeplitz_solve(col, rhs, diag_add)` — их композиция (сигнатура прежняя);
  - `pidtune_rng(seed) → () => число в [0, 1)` — mulberry32;
  - `pidtune_spread(values) → число` — (p84 − p16) / 2, процентиль — линейная интерполяция по позиции q·(n − 1) отсортированных конечных значений; меньше двух конечных — NaN;
  - `pidtune_need_s(sigma, data_s, rules) → число` — 0 при σ ≤ `step_sigma_goal`, иначе data_s·((σ / goal)² − 1), вверх до кратного 5;
  - `pidtune_noise(segments, rate_hz, fir, seed = 1, rules) → { count, valid, halves_null, sigma_step, sigma: { peak, rise_s, plateau }, firs } | null` — раздел 3.1 дизайна: пул — полные блоки `surrogate_block` из остатков всех отрезков; суррогат — модель + блоки с возвращением; по суррогату КИХ всех данных (гребень `fir.ridge`) и двух половин (`pidtune_halves`); `halves_null` — среднее (б) суррогатов, `sigma_step` — √(среднее `pidtune_rms_diff(шаг суррогата, fir.step)`²), `sigma.*` — `pidtune_spread` метрик `pidtune_step_metrics`; `firs` — КИХ суррогатов без `corr`; `valid` — суррогаты, у которых решились все три КИХ. null — `fir` null, пул пуст или `valid` < `count` / 2. Разложение Холецкого — одно на набор данных (все, половина 1, половина 2);
  - `pidtune_noise_margins(noise, c_log, rate_hz, rules) → { crossover_hz, pm_deg }` — `pidtune_spread` по `pidtune_predict(fir_суррогата, c_log, c_log, null, rate_hz)`;
  - `pidtune_osc_min_pp(quality, rules) → число` — max(`osc_min_pp`, `osc_sigma_k` × `quality.noise.sigma_step`); без `noise` — `osc_min_pp`;
  - `pidtune_quality(segments, rate_hz, fir, options = { rate_only, seed }, rules)` — к прежнему результату: `noise` (при `rate_only` и `fir` — `pidtune_noise(…, options.seed ?? 1)`, иначе null); `precise` (при `rate_only` — `checks.precision.ok`, иначе true); `checks.halves` + `noise`, `ratio`, `limit`; `checks.precision = { value, ok, applied, need_s, reason }`. При `rate_only`: `limit` = max(`halves_rms_max`, `halves_ratio_max` × `halves_null`); (г) — `value` = `sigma_step`, `ok` = `value` ≤ `step_sigma_max`, `need_s` = `pidtune_need_s(value, Σ длин отрезков / rate_hz)`; `noise` null — (б) и (г) не пройдены с причинами. Без `rate_only`: `limit` = `halves_rms_max`, `noise`/`ratio` null, `precision = { value: null, ok: null, applied: false, need_s: null, reason: null }`. `ok` — (а)–(в), как раньше; (г) в `ok` не входит;
  - `pidtune_rule(gains, axis, metrics, data_s, quality, rules)` — сигнатура прежняя; результат + `borderline: 5 | 20 | null`; после проверки `quality.ok` — `quality.precise === false` → без изменений; запас — раздел 3.4 по `quality.noise.sigma.peak`; без `noise` — поведение и тексты в точности прежние;
  - `pidtune_validity` — `quality.precise === false` → причина `quality.checks.precision.reason`.

Тексты ядра (точно):

```
(б), отказ при rate_only: "половины данных расходятся в " + pidtune_beyond(ratio, halves_ratio_max, 1) + " раза сильнее, чем даёт шум этого лога (RMS " + value.toFixed(3) + " при шуме " + halves_null.toFixed(3) + ", порог — " + halves_ratio_max + " × шум): режим или аппарат менялись по ходу полёта"
(б), шум не посчитался:    "шум лога не посчитался (суррогаты): проверка (б) не пройдена — отказ при сомнении"
(г), отказ:                 "точности не хватает: погрешность отклика " + value.toFixed(3) + " (порог " + step_sigma_max + ")"
(г), шум не посчитался:     "погрешность отклика не посчиталась (суррогаты) — отказ при сомнении"
правило, precise false:     "точности не хватает: погрешность отклика " + value.toFixed(3) + " (порог " + step_sigma_max + ") — правил нет"
перерегулирование с шумом:  пик ≥ 1 — "перерегулирование " + os.toFixed(1) + " ± " + σ.toFixed(1) + " %"; пик < 1 — "перерегулирования нет (пик " + peak.toFixed(3) + " ± " + σ_peak.toFixed(3) + ")"
на границе:                 <перерегулирование с шумом> + " — на границе " + порог + " %: по правилам решения нет, сравните варианты по прогнозу"
```

- [ ] **Шаг 1: тесты (сначала падают).** В `tests/tunewizard-pidtune.test.cjs`, константы `REAL_NOISE`, `TOO_NOISY` — значения задачи 1:

```js
test('pidtune_spread: половина размаха 16–84 процентилей, нечисловые пропускаются, меньше двух чисел — NaN', () => {
    close_to(pidtune_spread([1, 2, 3, 4, 5]), 1.36, 1e-12, '[1…5]')            // 1.64 и 4.36
    close_to(pidtune_spread([NaN, 2, null, 4, Infinity]), 0.68, 1e-12, '[2, 4]') // 2.32 и 3.68
    assert.ok(Number.isNaN(pidtune_spread([1])))
})
test('pidtune_need_s: до σ 0.05, вверх до 5 с; σ не больше цели — 0', () => {
    assert.equal(pidtune_need_s(0.124, 16.4), 85)
    assert.equal(pidtune_need_s(0.051, 10), 5)
    assert.equal(pidtune_need_s(0.05, 10), 0)
})
test('pidtune_toeplitz_factor и apply — то же, что pidtune_toeplitz_solve', () => { /* col [4, 1, 0.5, 0.2], diag 0.1, два rhs: разница ≤ 1e-12 */ })
test('pidtune_noise: одно зерно — одинаковые числа; другое зерно — другие: halves_null и sigma_step в пределах ×1.5, sigma.peak — ×2', () => {
    // measure(simulate(G0, { ...REAL_NOISE, seed: 3, plant: PLANT_NORMAL }), G0); deepEqual [halves_null, sigma_step, sigma.peak] двух расчётов с зерном 1;
    // зерно 2 — другие числа; допуск sigma.peak ×2: от зерна он меняется до 1.75 раза (раздел 11.3 дизайна)
})
test('pidtune_quality, Rate Loop Only, реальный шум без смены объекта: (б) пройдена при любом зерне, хотя прежний порог 0.035 — нет', () => {
    // зёрна полёта 3, 5, 7, 11, 13: checks.halves.ok true, ratio < halves_ratio_max; хотя бы у одного value > 0.035
})
test('pidtune_quality, Rate Loop Only, реальный шум, объект K ×0.6 и ×1.5 с середины: (б) не пройдена, причина «раза сильнее, чем даёт шум»', () => {
    // зёрна 3, 5, 7: checks.halves.ok false, ratio > halves_ratio_max, reasons — /раза сильнее, чем даёт шум этого лога/
    // (K ×0.75 и ×1.25 при реальном шуме (б) ловит не всегда — раздел 11.2 дизайна)
})
test('pidtune_quality, Rate Loop Only, малый шум (синтетика тестов, 150 с): нижняя граница — limit 0.035, (б) и (г) пройдены', () => {})
test('pidtune_quality без Rate Loop Only: прежний порог 0.035, noise null, precise true, (г) не применяется', () => {})
test('pidtune_quality, Rate Loop Only, TOO_NOISY, зерно полёта 3: (а) пройдена, precise false, (г) value > 0.08, need_s = pidtune_need_s(value, данных), кратно 5', () => {})
test('pidtune_quality, Rate Loop Only, короткие данные (12 с): без исключений, need_s — число, в причинах нет NaN и undefined', () => {})
test('pidtune_quality, Rate Loop Only, пул остатков пуст (один отрезок 300 отсчётов): noise null, (б) и (г) не пройдены с причинами', () => {})
test('pidtune_osc_min_pp: max(osc_min_pp, osc_sigma_k·σ); без шума — osc_min_pp', () => {})
test('pidtune_rule с шумом: выше 20 + σ — P −10 %, ниже 5 − σ — P +10 %, между — менять нечего, у порогов — на границе', () => {
    const q = (sp) => ({ ok: true, precise: true, checks: {}, reasons: [], noise: { sigma: { peak: sp } } })
    const b = pidtune_rule(ROLL, 'roll', metrics_of(20.8), 10, q(0.018))
    assert.deepEqual([b.change, b.borderline], [null, 20])
    assert.equal(b.reason, 'перерегулирование 20.8 ± 1.8 % — на границе 20 %: по правилам решения нет, сравните варианты по прогнозу')
    assert.equal(pidtune_rule(ROLL, 'roll', metrics_of(23), 10, q(0.018)).change, 'P-')
    assert.deepEqual([pidtune_rule(ROLL, 'roll', metrics_of(14.3), 10, q(0.018)).change, pidtune_rule(ROLL, 'roll', metrics_of(14.3), 10, q(0.018)).borderline], [null, null])
    assert.equal(pidtune_rule(ROLL, 'roll', metrics_of(6), 10, q(0.018)).borderline, 5)
    // пик 0.916 ± 0.086 (перерегулирования нет): P +10 %, причина начинается с «перерегулирования нет (пик 0.916 ± 0.086)»
})
test('pidtune_rule: precise false — «точности не хватает … — правил нет»; pidtune_validity — та же причина', () => {})
test('pidtune_noise_margins: разброс частоты среза и запаса фазы — конечные числа; одно зерно — одинаковые', () => {})
```

- [ ] **Шаг 2.** `npm test` — новые тесты падают (функций нет), прежние проходят.
- [ ] **Шаг 3.** Реализовать по «Интерфейсам»; прежние функции не меняют сигнатур.
- [ ] **Шаг 4.** `npm test` — все тесты зелёные; прежние тесты шага 4 (`-pidtune`, `-audit-d`, `-steps`) не правились.
- [ ] **Шаг 5.** `npm run lint`.
- [ ] **Шаг 6: замер (разово, во временной папке сеанса).** `pidtune_quality(…, { rate_only: true })` на 60 с отрезков при 400 Гц и при 1 кГц (цель — белый шум как `noise_segment`, факт — свёртка с первым порядком + шум): ≤ 1.5 с и ≤ 4 с под Node. Числа — в сообщение коммита.
- [ ] **Шаг 7.** Коммит `TuneWizard: шаг 4 — суррогаты, (б) по шуму, (г) и правила с запасом (ядро)`.

### Task 3: страница шага 4

**Файлы:**
- Изменить: `TuneWizard/steps/step4.js` — `step4_axis_names`, `step4_check_letters`, `step4_test_flight*` (стр. 66–87), `step4_compute_axis` (735), `step4_axis_state` (≈1195), `step4_render_summary` (≈1270), `step4_render_axis_verdict` (≈1415), `step4_unreliable_mark`, `step4_render_metrics`, `step4_render_quality` (≈1646–1735), `step4_failed_checks`.
- Тесты: `tests/tunewizard-audit-d.test.cjs` (харнесс шага 4 под заглушками; в шапке файла — «и этап 10»).

**Интерфейсы:**
- Потребляет: задача 2 — `pidtune_quality` с `options.seed`, `quality.noise`, `quality.precise`, `checks.precision`, `rule.borderline`, `pidtune_osc_min_pp`, `pidtune_noise_margins`.
- Производит: статус оси `"imprecise"`; `step4_axis_names[axis].dat` — «крену», «тангажу», «рысканию»; `step4_check_letters.precision = "(г)"`; поле расчёта `res.pred_sigma` (`pidtune_noise_margins` или null); `step4_axis_advice(axis) → строка | null` — совет оси без правил (используют сводка шага и задача 4).

Поведение и тексты (точно):
- `step4_compute_axis`: `pidtune_quality(…, { rate_only: res.mode.rate_only, seed: step4_pid_index[axis] + 1 })`; метрики — `pidtune_step_metrics(fir.time, fir.step, { ...pidtune_rules, osc_min_pp: pidtune_osc_min_pp(res.quality) })`; статус после `unreliable` — `imprecise`, если `res.quality.precise === false`; у `ok` с прогнозом и `noise` — `res.pred_sigma`.
- `step4_axis_state` для `imprecise`: `{ text: "мало точности (г)", cls: "warn", reason: "точности не хватает (не пройдена проверка (г))", all: "Точности не хватает на всех осях (не пройдена проверка (г))" }`.
- `step4_axis_advice(axis)`: `ok` — null; не `rate_only` — `step4_acro_hint() ?? step4_test_flight_short` (как сейчас); `rate_only`:
  - `imprecise` и `little` — `"ещё ≈ " + N + " с резких манёвров по " + dat + " в Acro «Rate Loop Only»"` + (рыскание ? `", полными отклонениями стика"` : `""`), N — `checks.precision.need_s`, у `little` без него — до кратного 5 вверх от `min_data_s − data_s`;
  - `unreliable` с непройденной (б) — `"отклик менялся по ходу полёта: сузьте интервал к однородному участку или слетайте ещё раз в тех же условиях (газ, батарея)"`;
  - `unreliable` без (б) — `"ещё резких манёвров по " + dat + " в Acro «Rate Loop Only»: отклик держится на регуляризации"`;
  - `nodata`, `low_rate`, `missing`, `noresp` — null (их вердикт сам говорит, что делать).
- Вердикт оси `imprecise`: `"Точности не хватает — правил и прогноза нет: погрешность отклика " + σ.toFixed(3) + " (порог " + step_sigma_max + ")."`, затем строка отклика + `" Отклик показан с пометкой: по нему не судят."`, затем совет оси с заглавной и точкой. У `unreliable`, `little` при `rate_only` — совет оси вместо `step4_test_flight`. У `ok` при `rate_only` — `"Лог тестового полёта Acro «Rate Loop Only»: угловой контур выключен устройством режима, погрешность «±» — по шуму этого лога."` вместо «измерение точное».
- Сводка шага: у оси `ok` с `rule.borderline` — `"на границе " + порог + " % (" + os + " ± " + σ + " %), сравните варианты по прогнозу"` (os = (пик − 1)·100, σ = `noise.sigma.peak`·100, по одной цифре); оси без правил при `rate_only` — советы `step4_axis_advice`, одинаковые объединяются («крен, рыскание — …»), вместо `step4_test_flight_short`: `" По осям без надёжного измерения: " + группы + "."`; если надёжных нет — `what + " — правил и прогноза нет; " + группы + " (подробности — во вкладках осей)."`. Без `rate_only` — как сейчас.
- Плитки при `quality.noise`: «50.7 ± 4.3 мс», «17.3 ± 4.0 %», «1.098 ± 0.040», «4.31 ± 0.46 Гц · 66.5 ± 8.5°» (последняя — при `res.pred_sigma`); «Измерение» у `ok` при `rate_only` — подпись «Rate Loop Only: (а), (б), (г)», у `imprecise` — `["мало точности", "(г): погрешность " + σ.toFixed(3) + " > " + step_sigma_max, "bad"]`; `step4_unreliable_mark` у `imprecise` — «точности не хватает».
- Таблица качества при `rate_only`: (б) — значение `v.toFixed(3) + " · шум " + null.toFixed(3) + " (×" + ratio.toFixed(1) + ")"`, порог `"≤ 2.5 × шум, не меньше 0.035"` (числа — из `pidtune_rules`); строка (г) — «(г) точность отклика», пояснение «погрешность отклика КИХ по суррогатам — RMS на 0–0.5 с», значение σ, порог «≤ 0.08»; без `rate_only` строки (г) нет.
- `step4_test_flight`: `"Слетайте тестовый лог: Acro с ACRO_OPTIONS бит 1 «Rate Loop Only» (значение 2, или 3 вместе с Air-mode) и ACRO_TRAINER = 0 — угловой контур выключен, цель — прямая команда пилота (тренер при ACRO_TRAINER ≠ 0 подмешивал бы в неё выравнивание по углу); около минуты резких отклонений стиков на каждую ось, рыскание — полными отклонениями стика; в LOG_BITMASK включены ATTITUDE_FAST и PID. По такому логу мастер измеряет сам контур скорости."`; `step4_test_flight_short`: `"нужен тестовый полёт: Acro с ACRO_OPTIONS «Rate Loop Only» (2, или 3 с Air-mode) и ACRO_TRAINER = 0, около минуты резких отклонений стиков на каждую ось, в LOG_BITMASK — ATTITUDE_FAST и PID"`.
- Пометка раннего отклика (раздел 11.6 дизайна): при `rate_only` и |`fir.step[Math.round(0.005 · rate_hz)]`| ≥ 0.05 подпись плитки «Нарастание» — `"начало отклика не определено: КИХ даёт " + v.toFixed(2) + " уже на 5 мс (цель сглажена пределом ускорения), нарастание 10–90 % смещено"` вместо подписи полосы; без `rate_only` пометки нет.

- [ ] **Шаг 1: тесты (сначала падают)** в `tests/tunewizard-audit-d.test.cjs` (лог харнесса — «Rate Loop Only», после `load` у осей `quality.noise` есть):
  - `'Этап 10: «Rate Loop Only» — зерно оси, «±» в плитках, строка (г); повторный расчёт даёт те же числа'` — `res.quality.checks.precision.applied` true у всех осей; `step4_compute()` дважды → одинаковые `halves_null`, `sigma_step`; `metrics4.innerHTML` содержит « ± »; tbody `quality4` содержит «(г) точность отклика»;
  - `'Этап 10: точности не хватает — вкладка «мало точности (г)», вердикт и сводка с советом по рысканию, без «Слетайте тестовый лог» и «нужен тестовый полёт»'` — у `step4.calc.yaw`: `status 'imprecise'`, `quality.precise false`, `checks.precision = { value: 0.124, ok: false, applied: true, need_s: 85, reason: … }`; вердикт оси содержит «Ещё ≈ 85 с резких манёвров по рысканию в Acro «Rate Loop Only», полными отклонениями стика.»; сводка — «рыскание — ещё ≈ 85 с …»;
  - `'Этап 10: «Rate Loop Only», (б) не пройдена — «Отклик менялся по ходу полёта: …»'`;
  - `'Этап 10: на границе — сводка «тангаж — на границе 20 % (20.8 ± 1.8 %), сравните варианты по прогнозу»'`;
  - `'Этап 10: не «Rate Loop Only» — без (г) и «±», совет тестового полёта с «около минуты резких отклонений стиков на каждую ось»'`;
  - `'Этап 10: источник RATE в «Rate Loop Only» — «±» у метрик, у запаса фазы «—», без исключений'`;
  - `'Этап 10: ранний отклик — у «Нарастания» пометка «начало отклика не определено: КИХ даёт 0.16 уже на 5 мс …» при |отклик на 5 мс| ≥ 0.05; меньше 0.05 и без «Rate Loop Only» — пометки нет'` (отклик КИХ на 5 мс задаётся в `res.fir.step`).
- [ ] **Шаг 2.** `npm test` — новые падают.
- [ ] **Шаг 3.** Реализовать по «Поведению и текстам».
- [ ] **Шаг 4.** `npm test`, `npm run lint` — зелёные. Прежние тесты `-audit-d` и `-steps`, где сверяется начало `step4_test_flight*`, проходят без правки (меняется только хвост текста).
- [ ] **Шаг 5.** Коммит `TuneWizard: шаг 4 — точность, погрешность и советы по оси на логе «Rate Loop Only» (страница)`.

### Task 4: сводка, шаг 5 и план полёта

**Файлы:**
- Изменить: `TuneWizard/core/summary.js` (`summary_refly`, стр. ≈300, пункт `test_flight`), `TuneWizard/steps/step5.js` (`step5_unreliable_text`, `step5_render_refly`), `TuneWizard/core/prep.js` (`prep_flight_plan`, стр. 840).
- Тесты: `tests/tunewizard-summary.test.cjs`, `tests/tunewizard-prep.test.cjs`, `tests/tunewizard-prep-browser.cjs` (стр. 227).

**Интерфейсы:**
- Потребляет: `step4_axis_advice(axis)` задачи 3.
- Производит: `summary_refly(ctx)` принимает `ctx.axis_advice` — `{ roll, pitch, yaw: строка | null }`; `step5_unreliable_text(axes, rate_only = false)`.

Поведение и тексты (точно):
- `summary_refly`: оси из `unreliable_axes` группируются по совету (`ctx.axis_advice?.[ось] ?? ctx.test_flight`) в порядке `pidtune_axes`; каждая группа — пункт `test_flight`: «Оси — совет.». Без `axis_advice` — прежний один пункт.
- `step5_render_refly`: `axis_advice` — `step4_axis_advice` по осям из `unreliable`, только при `step4_ready() && !step4_stale()`, иначе `{}`.
- `step5_unreliable_text(axes, rate_only)`: при `rate_only` хвост `" — см. советы по осям"` вместо `" — нужен тестовый полёт"`; `rate_only` — все оси из `axes` при актуальном расчёте шага 4 с `mode.rate_only`.
- План Copter (`step4` true), пункт Acro: `"Около минуты резких отклонений стиков с возвратом на каждую ось, по одной оси за раз — крен, тангаж, рыскание — с разной амплитудой, рыскание — полными отклонениями стика: мастеру нужно не меньше " + acro_data_s + " с участков с целью скорости от " + acro_target_dps + " °/с, а точность для уверенного вердикта набирается примерно за минуту"`. QuadPlane (`step4` false) — прежний текст «2–3 минуты …».

- [ ] **Шаг 1: тесты (сначала падают):**
  - `-summary`: `'summary_refly: советы по осям — одинаковые объединяются, разные — отдельными пунктами по порядку осей; без совета оси — общий test_flight'` — `axis_advice { roll: 'A', pitch: 'B', yaw: 'A' }` → пункты `['Крен, рыскание — A.', 'Тангаж — B.']`; `{ roll: null }` при `unreliable_axes ['roll']` → `['Крен — T.']`;
  - `-prep`: `'prep_flight_plan: Copter — «около минуты на каждую ось», QuadPlane — прежние «2–3 минуты»'` — пункт Copter целиком (текст выше, с точкой); тест QuadPlane (стр. ≈975) не меняется;
  - `tests/tunewizard-prep-browser.cjs:227` — `/^Около минуты резких отклонений стиков/`.
- [ ] **Шаг 2.** `npm test` — новые падают.
- [ ] **Шаг 3.** Реализовать.
- [ ] **Шаг 4.** `npm test`, `npm run lint`, `CHROME_PATH=… npm run test:tunewizard-prep` — зелёные.
- [ ] **Шаг 5.** Коммит `TuneWizard: советы по осям в сводке, план полёта — около минуты на ось`.

### Task 5: прогон четвёртого лога и браузерные тесты

**Файлы:**
- Создать: `tests/tunewizard-browser-log4.cjs` (по образцу `tests/tunewizard-browser-log2.cjs`; порт 8799; лог — `TUNEWIZARD_LOG4` или `TuneWizard/logs/2 01.01.1970 2-00-00.bin`; без лога — пропуск с сообщением).
- Изменить: `package.json` — `"test:tunewizard-log4": "node tests/tunewizard-browser-log4.cjs"`; `tests/tunewizard-browser.cjs` — подмена `pidtune_quality` (стр. ≈1267–1275) возвращает ещё `precise: true`, `noise: null`, `checks.precision = { value: null, ok: null, applied: false, need_s: null, reason: null }`: подмена проверяет варианты и прогноз без шума, как раньше.

**Интерфейсы:** потребляет задачи 2–4; производит `npm run test:tunewizard-log4`.

- [ ] **Шаг 1: тест `tests/tunewizard-browser-log4.cjs`.** Проверки:
  - шаг 0: плата `StellarH7V2 0045002A 33335108 33313637`, прошивка `/^ArduCopter V4\.7\.2/`, интервал по умолчанию [282, 370];
  - шаг 1, окно 2048: `step1_ready()` true, `step1.fft_key` `'raw:2048'`, пиков больше 0 (поток GYR не рвётся);
  - шаг 4, интервал по умолчанию: у всех осей `status 'unreliable'`, в непройденных — «(б)», кнопка «Интервал — участок ACRO» видна, `step4_acro_interval()` → `{ start: 289, end: 370 }`, `quality.noise` null, строки (г) нет;
  - кнопка → [289, 370]: крен — `ok`, `rule.change` null; тангаж — `ok`, `rule.borderline` 20; рыскание — `imprecise`, `need_s` от 50 до 110 и кратно 5; у всех осей `quality.noise` есть; в сводке шага нет «нужен тестовый полёт» и «Слетайте», есть «рыскание — ещё ≈ N с резких манёвров по рысканию в Acro «Rate Loop Only», полными отклонениями стика»; у тангажа плитки с « ± », в таблице — «(г) точность отклика»; время расчёта шага 4 печатается и не больше 10 с;
  - повторный расчёт (`step4.key = null; step4_show()`) — те же `need_s` и `halves_null`;
  - возврат интервала по умолчанию на шаге 0 (поля интервала, как кнопка) — снова `unreliable` у всех осей, без « ± » и (г);
  - шаг 5 на участке ACRO без «Принять»: в вердикте «см. советы по осям», в «что сделать перед следующим полётом» — «Рыскание — ещё ≈ N с резких манёвров по рысканию в Acro «Rate Loop Only», полными отклонениями стика.»;
  - ошибок консоли нет.
- [ ] **Шаг 2.** `package.json`, подмена в `tests/tunewizard-browser.cjs`.
- [ ] **Шаг 3.** Прогоны: `npm run test:tunewizard-log4`, `test:tunewizard` (тестовый лог: по шагу 4 прежние «ненадёжно (б)» у всех осей), `-log2`, `-log3`, `-prep`, `-compare`, `-pid-compare` — зелёные; где упало из-за новой длительности в совете — поправить ожидание в тесте, а не текст.
- [ ] **Шаг 4.** Коммит `TuneWizard: прогон четвёртого лога (test:tunewizard-log4)`.

### Task 6: документы и финальный прогон

**Файлы:**
- Изменить: `TuneWizard/Readme.md` (шаг 4 — абзац о проверках (≈стр. 121): (б) по шуму и (г) на логе «Rate Loop Only», «±», правила с запасом, советы по оси; план полёта (≈стр. 200): у Copter «около минуты на каждую ось»; «Проверки» — `test:tunewizard-log4`; «Готовность»), `tests/README.md` (новые тесты `-pidtune`, `-audit-d`, `-summary`, `-prep`, `-log4`), `docs/tunewizard-journal.md` (дизайн, раздел 4, задача 6: разделы 1, 3, 4, 5, 6, 8).

- [ ] **Шаг 1.** Документы по списку.
- [ ] **Шаг 2.** Финальный прогон: `npm run lint`, `npm test`, `test:tunewizard`, `-log2`, `-log3`, `-log4`, `-prep`, `-compare`, `-pid-compare`, `-serve` — числа и время — в журнал.
- [ ] **Шаг 3.** Коммит `TuneWizard: документы этапа 10`; push; PR `gh pr create --repo deathnemo/WebTools --base main --head tune-wizard-next6` с описанием по задачам; ссылка — пользователю, сливает он сам.
