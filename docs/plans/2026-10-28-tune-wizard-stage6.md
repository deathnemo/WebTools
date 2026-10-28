# Мастер настройки — этап 6: иконка и ссылка на главной (план реализации)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Цель:** иконка мастера `images/TuneWizard_Icon.png` и строка «Мастер настройки» на главной странице WebTools после PID Review.

**Архитектура:** по `docs/plans/2026-10-28-tune-wizard-stage6-design.md`. Иконку делает отдельный скрипт в Chrome; главная меняется одной строкой таблицы.

**Стек:** как на этапах 2–5 (Playwright + Chrome через `CHROME_PATH`, `node --test`, ESLint).

**Соглашения:** русский язык; коммит на задачу с трейлером `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`; `git add` по именам файлов (`modules/ardupilot`, `TuneWizard/logs/` не коммитить); ветка `tune-wizard-stage6`, после задачи — `git push origin tune-wizard-stage6`; в upstream ничего не отправлять; журнал ведёт координатор; окончания строк — как в файле (`git diff --check`).

**Проверки:** `npm run lint`; `npm test`; `CHROME_PATH="C:/Users/taa03/AppData/Local/Google/Chrome/Application/chrome.exe" npm run test:tunewizard`. Node — `export PATH="/c/Program Files/nodejs:$PATH"`.

---

### Задача 1: скрипт иконки и `images/TuneWizard_Icon.png`

**Файлы:** создать `tests/tunewizard-icon.cjs`, `images/TuneWizard_Icon.png`; изменить `package.json` (скрипт `tunewizard:icon`).

- Chrome, локальный сервер и поиск тестового лога — как в `tests/tunewizard-browser.cjs` (переиспользовать подход; если общий код удобно вынести в небольшой помощник — можно, без смены поведения браузерного теста).
- Загрузить лог, открыть шаг 2, дождаться графика `Spectrum2` с данными; снять область от верха `#wizbar` до низа `#Spectrum2` по ширине страницы (`page.screenshot({ clip })`).
- Уменьшить до ширины 400 px с сохранением пропорций: в странице через `createImageBitmap` и canvas (`imageSmoothingQuality = "high"`), `toDataURL("image/png")` → записать `images/TuneWizard_Icon.png`. Вывести размер получившейся картинки.
- Посмотреть картинку (полоса шагов читается, спектр виден) и при необходимости поправить область.

**Проверки:** скрипт отрабатывает, PNG 400 px по ширине; lint.

**Коммит:** `TuneWizard: иконка для главной и скрипт её обновления`, push.

---

### Задача 2: строка на главной, проверка, документы

**Файлы:** изменить `index.html` (корень), `tests/tunewizard-browser.cjs`, `TuneWizard/Readme.md`, `tests/README.md`.

- `index.html`: строка таблицы из раздела 3 дизайна сразу после строки PID Review; остальное не трогать.
- Браузерный тест: открыть главную (`/index.html` того же сервера), ссылка `a[href="./TuneWizard"]` есть, картинка `images/TuneWizard_Icon.png` загрузилась (`naturalWidth > 0`), переход по ссылке — `document.title === "Мастер настройки"`. Поставить в начало или конец теста так, чтобы не мешать остальным проверкам.
- Readme мастера: в «Запуске» — ссылка на главной; как обновить иконку (`npm run tunewizard:icon`). `tests/README.md`: скрипт иконки, проверка главной. В Readme «Готовность» — этап 6 готов.

**Проверки:** lint, `npm test`, `npm run test:tunewizard`.

**Коммит:** `TuneWizard: строка на главной WebTools, проверка и документы`, push.
