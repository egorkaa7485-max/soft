# Dolphin{anty} multi-PC tab sync (Node.js)

Полное описание поведения (буфер по окнам, только открытые вкладки, разные URL, назад/вперёд, производительность): **[SYNC_GUIDE.md](./SYNC_GUIDE.md)**.

Это минимальный софт для управления вкладкой на **других компьютерах** из “главной” вкладки, когда встроенная синхронизация Dolphin не подходит (разные ПК, разные размеры окон, перекрытие окон, нужно pause/resume).

Идея: **Controller (ваша вкладка)** шлёт события мыши/клавиатуры на **Sync Server**, а на каждом удалённом ПК **Agent** подключается к профилю Dolphin через CDP (DevTools) и воспроизводит события.

## Готовые инструменты (OSS), которые могут помочь

Полного аналога «один Chrome → зеркало в N Dolphin-профилей» в открытом доступе почти нет; полезны смежные кирпичи:

| Инструмент | Зачем в контексте проекта |
|------------|---------------------------|
| **[Puppeteer](https://pptr.dev/) / [puppeteer-core](https://www.npmjs.com/package/puppeteer-core)** | Уже основа агента: CDP, вкладки, ввод. |
| **[Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)** | То же низкоуровнево без Puppeteer (например пакет `chrome-remote-interface`). |
| **[Playwright](https://playwright.dev/)** | Альтернатива Puppeteer для автоматизации браузера (переписывать агент — большой объём). |
| **[Input Leap](https://github.com/input-leap/input-leap) / [Barrier](https://github.com/debauchee/barrier)** | Общая мышь/клавиатура между ПК (не синхронизирует вкладки и URL). |
| **[RustDesk](https://github.com/rustdesk/rustdesk)** | Удалённый стол, если нужен один экран вместо зеркала координат. |

Имеет смысл смотреть обновления **Dolphin API** (автоматизация, running) — ваш агент уже опирается на них.

## Что нужно

- Windows 10 на каждом агентском ПК
- Dolphin{anty} запущен и авторизован
- API token Dolphin (в личном кабинете)
- Node.js 18+ на сервере и на каждом ПК-агенте

## 1) Установка зависимостей

В корне проекта:

```bash
npm i
```

## 2) Запуск сервера синхронизации

На центральном компьютере/сервере:

```bash
npm run server
```

Панель будет доступна по `http://SERVER_IP:8787/`.

### Сервер в облаке (Vercel, Railway и т.п.) — ПК не в одной подсети

Если главный компьютер и агенты в **разных сетях** (дом/офис/разные провайдеры), поднимайте sync-сервер **в интернете**. Тогда не нужны VPN и проброс портов на роутере для синхронизации.

- **WebSocket** в `agent/config.json` и в настройках расширения: **`wss://soft-sage.vercel.app/ws`** (именно **`wss://`**, не `ws://`; хост без `https://`).
- **Панель** в браузере: **`https://soft-sage.vercel.app/`** (порт в URL не пишут — его задаёт хостинг).
- На хостинге приложение должно слушать **`process.env.PORT`** (в этом проекте уже учтено).
- **Dolphin API** (`dolphin.baseUrl`, обычно `http://127.0.0.1:3001`) по-прежнему **локально на каждом ПК с агентом** — в облако его выносить не нужно.

Все участники (расширение + все агенты) должны указывать **один и тот же** `serverWsUrl`.

## Стартовая страница для всех профилей

В `agent/config.json` в блоке `target` можно задать:

```json
"openOnConnectUrl": "https://example.com/path",
"openOnConnectMode": "onlyExisting",
"openOnConnectWaitUntil": "domcontentloaded",
"openOnConnectTimeoutMs": 25000
```

- **`openOnConnectMode`** (по умолчанию **`onlyExisting`**): управление только **уже открытыми** вкладками, без принудительного открытия URL из конфига:
  - **`onlyExisting`** — подбирается вкладка по `openOnConnectUrl` / `preferUrlIncludes` / домену (два прохода: `targets` и `pages`). **`page.goto(openOnConnectUrl)` не вызывается**; новая вкладка **не создаётся**, если в окне уже есть хотя бы одна страница (`ensurePageNoNew`).
  - **`preferExisting`** — то же подбор открытой вкладки; если **ни одна** не подошла — как раньше делается `goto` на `openOnConnectUrl`.
  - **`always`** — всегда `goto(openOnConnectUrl)` после подключения.
  - **`never`** — не делать `goto`, только `ensurePage` / `preferUrlIncludes`.
- **`waitUntil`**: в Chromium Dolphin через CDP часто **нет** режима `commit` (ошибка `Unknown value for options.waitUntil: commit`). По умолчанию агент подставляет **`domcontentloaded`**. Для обычного Chrome можно пробовать `load` / `networkidle2`.
- Параллельный старт профилей (быстрее, но выше нагрузка на Dolphin API):

```json
"dolphin": {
  "connectConcurrency": 3,
  "connectStaggerMs": 180,
  "maxConcurrentStarts": 2,
  "maxConcurrentStops": 1,
  "startTimeoutMs": 45000,
  "stopTimeoutMs": 12000,
  "stopRetries": 2
}
```

- **`connectConcurrency`** (по умолчанию **3**, макс. **120**): размер **пула** — столько профилей подключаются **параллельно**; освободившийся воркер сразу берёт следующий id (не ждёт остальных). Раньше при **1** всё шло строго по одному — очень долго при 10+ окнах.
- **`connectStaggerMs`** (по умолчанию **180**): лёгкий сдвиг старта внутри «волны» пула: `(index % connectConcurrency) * connectStaggerMs` (мс), чтобы не бить Dolphin одним пиком.
- **`maxConcurrentStarts`** (по умолчанию **2**, макс. **32**) и **`maxConcurrentStops`** (по умолчанию **1**, макс. **8**): раздельные очереди на Dolphin **`/start`** и **`/stop`**. Параллельные **stop** чаще давали **EBUSY**; **start** можно поднимать при сотнях уже открытых окон.
- **`maxConcurrentApiCalls`**: если задан — **старое** поведение: **одно** число ограничивает **и** start, **и** stop (например оба **1** при частых EBUSY). Для ускорения уберите этот ключ и используйте `maxConcurrentStarts` / `maxConcurrentStops`.
- **`startTimeoutMs`** / **`stopTimeoutMs`** / **`stopRetries`**: таймауты и повторы для `stop` (короткий stop + 2 попытки вместо одного долгого).
- Если в логе **HTTP 500** с текстом **`EBUSY`**, **`locked`**, **`Cookies` / `History` / `Login Data`** — это не «перегруз», а **файлы профиля заняты**: тот же профиль уже открыт в Dolphin, идёт перезапуск или антивирус держит файлы. Закройте окно профиля, подождите несколько секунд, не запускайте один `profileId` с двух агентов сразу.
- **`autoDiscoverRunningProfileIds: true`** и заданный **`profileIds`**: по умолчанию список **объединяется** с **всеми запущенными** профилями из Dolphin API (`конфиг ∪ running`), чтобы подключались сотни окон, а не только id из файла. Отключить объединение: **`"autoDiscoverMergeRunningProfileIds": false`** (тогда используются только id из конфига). Пустой `profileIds` + auto-discover по-прежнему подставляет все running и может сохранить их в конфиг.
- **Пагинация API**: запросы `status=running` и списка профилей идут **по страницам** (`listRunningPageLimit` по умолчанию 500, `listRunningMaxPages` до 200), иначе Dolphin отдаёт только первую порцию (~до 1000) и остальные окна «не видны» агенту.
- **`connectConcurrency`**: см. блок выше (по умолчанию **3**).
- Если профиль **уже открыт** в Dolphin, API может ответить `E_BROWSER_RUN_DUPLICATE`. Агент сначала пытается взять **port/wsEndpoint** из ответа или из `GET .../browser_profiles/{id}` и подключиться к CDP **без** `stop`; если не вышло — как раньше `stop` + повтор.

После подключения: при **`always`** — переход на `openOnConnectUrl`. При **`onlyExisting`** / **`preferExisting`** сначала используются только открытые вкладки; **`goto`** — только у **`preferExisting`**, если совпадения нет, и всегда у **`always`**.

**Обновление страницы панели** (`http://…:8787`) раньше рвало WebSocket и агент завершался — теперь агент **переподключается** сам, окна Dolphin не должны сбрасываться из‑за этого.

### Клики «не туда» / другая вкладка

События с главного несут **`href` активной страницы**. Агент выбирает вкладку: сначала **точное совпадение URL**, затем режим `urlMatchMode`; если подходит несколько вкладок — приоритет у **текущей выбранной** на агенте, чтобы реже промахиваться.

**Свёрнутое окно / фон:** раньше размер области страницы брался из `innerWidth`/`innerHeight` — в фоне они часто **0**, подставлялось **1280×720** и координаты ломались. Теперь размеры берутся через **CDP `Page.getLayoutMetrics`**, кэшируются и при сбое используется **последний удачный** размер профиля.

**Разные разрешения** главного и агента дают смещение кликов — включите **`target.forceViewport`** с **одинаковыми** `width`/`height` на всех ПК или подгоните размер окна Dolphin под главный браузер.

Если Dolphin API не запущен (`ECONNREFUSED 127.0.0.1:3001`), сначала поднимите **Dolphin{anty}** и проверьте `dolphin.baseUrl` в `agent/config.json`.

### Главный и агент на одном ПК (окна не всплывают)

По умолчанию агент вызывает **`bringToFront`** при клике и смене вкладки — окна Dolphin выходят на передний план. Если главный браузер и агент на **одном компьютере**, а окна Dolphin должны оставаться **свёрнутыми/под другими окнами**, в `agent/config.json` добавьте:

```json
"sync": {
  "bringAgentWindowToFront": false
}
```

Синхронизация кликов/клавиш продолжит работать в фоне; при необходимости снова поднимать окна — верните `true` или удалите ключ.

### Адресная строка Chrome (омнибар) и фокус

Расширение получает клавиши **только когда фокус внутри страницы** (content script). **Клик и ввод в адресной строке главного Chrome не синхронизируются** — события туда не приходят из страницы.

**Что сделать на агентах:**

1. **Клик по иконке расширения** на панели Chrome (закрепите «Dolphin Sync») — на всех агентах выполняется **Ctrl+L** / **Cmd+L** (фокус строки URL через CDP).
2. Или горячая клавиша по умолчанию **Ctrl+Shift+U** (mac: **Cmd+Shift+U**). Свою можно задать в `chrome://extensions/shortcuts`.
3. Опционально в `agent/config.json`: `"translateTopStripClickToAddressBarHotkey": true` — клик в **самом верху области страницы** (по умолчанию ~2.8% высоты, по X ~12–88%) на главном трактуется как запрос фокуса URL на агентах (может мешать кликам по верхней панели сайта).

Параметры зоны: `topStripAddressBarZoneMaxY`, `topStripAddressBarZoneXMin`, `topStripAddressBarZoneXMax`. Для поиска **на сайте** по-прежнему удобнее поле в шапке страницы.

По умолчанию при фокусе URL на агентах окно **поднимается на передний план** (`focusAddressBarForcesBringToFront`), даже если `bringAgentWindowToFront: false` — иначе не видно, что сработало. Отключить: `"focusAddressBarForcesBringToFront": false`.

**Быстрый старт многих окон + сразу в трей/свёрнуто:** в `sync` задайте `"bringAgentWindowToFront": false`, `"focusAddressBarForcesBringToFront": false`, `"mouseDispatchMode": "cdp"`, **`"minimizeAgentWindowAfterConnect": true`** — после подключения CDP агент попытается **свернуть окно** Chromium (если ваша сборка Dolphin отдаёт CDP `Browser.setWindowBounds`). В `dolphin` для скорости можно поднять `connectConcurrency`, `maxConcurrentStarts` и снизить `connectStaggerMs` (осторожно: выше риск EBUSY у Dolphin).

**Почему «3 минуты на 2 профиля»:** часто в конфиге стоят **`connectConcurrency: 1`** и **`maxConcurrentApiCalls: 1`** (всё строго по очереди), плюс Dolphin **`/browser_profiles/running`** на сотнях окон — огромный JSON; раньше он **качался заново на каждый poll каждого профиля**. Сейчас список **кэшируется ~2.5 с** (переменная `AGENT_RUNNING_CACHE_MS`). Уберите `maxConcurrentApiCalls`, поднимите `connectConcurrency` и `maxConcurrentStarts`.

**Много окон за короткое время (например ~500 за ~5 мин):** агент подключает профили **пулом параллельных воркеров** (как только один профиль подключился, освободившийся воркер берёт следующий — не ждёт «пачку» целиком). Пример агрессивного `dolphin` (подбирайте под ПК и стабильность API):

```json
"dolphin": {
  "connectConcurrency": 50,
  "connectStaggerMs": 30,
  "maxConcurrentStarts": 16,
  "maxConcurrentStops": 1
}
```

Если окна **уже запущены**, упираетесь в CDP/диск/CPU — тогда можно поднять `connectConcurrency` до **60–100**. При **EBUSY** или 500 от Dolphin — уменьшайте `maxConcurrentStarts` и `connectConcurrency`. Лимит RPM у Dolphin не превышайте (не запускайте много отдельных процессов агента).

В `sync` для массового коннекта: **`clipboardDeferredInstall: true`** (по умолчанию) — не ждать установки clipboard-хуков на всех вкладках перед следующим профилем; **`clipboardHookAllPagesOnConnect: false`** (по умолчанию) — хуки только на **активной** вкладке и на **новых** (через `targetcreated`). Для копирования на **каждой** старой вкладке сразу — поставьте **`clipboardHookAllPagesOnConnect: true`** (будет дольше).

### Не повторяет / долго грузится — чеклист

1. В логе агента **сразу** должно быть `connected to server` (WebSocket к Railway/серверу). События с главного обрабатываются **сразу** для уже подключённых профилей; профили, которые ещё в очереди Dolphin (EBUSY, stop+retry), **не блокируют** остальные.
2. На **панели сервера** (`/`) у этого `agentId` включён **Sync** — иначе сервер не шлёт события агенту.
3. На главном ПК расширение: в service worker есть `[sync-bg] connected`.
4. `preferUrlIncludes` — домен той вкладки, с которой ведёте главный контроль (или пусто).

## 3) Настройка и запуск агента на удалённом ПК

Скопируйте `agent/config.example.json` (один профиль) или `agent/config.example.multi.json` (несколько) в `agent/config.json` и заполните:

- `agentId` уникальный (например `pc-001`)
- `serverWsUrl` адрес сервера: `ws://SERVER_IP:8787/ws`
- `dolphin.token` ваш API token
- `dolphin.profileId` ID профиля, который нужно контролировать на этом ПК

Запуск:

```bash
npm run agent
```

## 4) Подключение “главной” вкладки (Controller)

Откройте в Dolphin на вашем ПК “главную” вкладку, откройте DevTools Console и вставьте код из:

- `controller/controller-snippet.js`

Внутри файла замените:

- `SERVER_WS` на `ws://SERVER_IP:8787/ws`

## Pause/Resume конкретных ПК

Откройте панель `http://SERVER_IP:8787/` и выключайте sync чекбоксом у нужного `agentId`, либо кнопками **Sync всем: ON/OFF**.

## Примечания (важно)

- События привязываются к **нормализованным координатам** (0..1), поэтому размер окна агента может отличаться от вашей вкладки.
- “Wheel” воспроизводится через CDP `Input.dispatchMouseEvent`, обычно работает стабильнее, чем попытка копировать `scrollY`.
- На бесплатных планах Dolphin есть ограничения на некоторые API функции, но старт профиля с `automation=1` — базовая автоматика.

## Расширение Chrome (все сайты, CSP)

Для сайтов с жёстким CSP используйте папку `extension/` (см. `extension/README.md`).  
Там же: **копирование с главного на агентов не транслируется** — у каждого профиля свой контекст.

## Условная синхронизация по URL + буфер

В `agent/config.json` можно задать блок `sync`:

```json
"sync": {
  "strictUrlMatch": false,
  "urlMatchMode": "hostpath",
  "replicatePaste": false,
  "navigateWaitUntil": "domcontentloaded",
  "navigateTimeoutMs": 30000,
  "virtualClipboard": true,
  "mouseDispatchMode": "cdp",
  "tabPickCacheMs": 8000,
  "targetsListCacheMs": 50,
  "mouseMoveThrottleMs": 33,
  "clipboardLogToFile": true,
  "clipboardLogDir": "agent/clipboard-logs",
  "clipboardLogMaxChars": 500000,
  "replicateInputValue": false
}
```

- **`replicateInputValue: false`** (по умолчанию): **не** подставлять с главного полный текст полей (`input` событие). Иначе на всех профилях в полях тот же текст, что на главном, и копируется везде одно и то же. При `false` ввод идёт **клавишами** с главного — у каждого окна свой DOM; Ctrl+C берёт **локальное** выделение. Если нужна старая полная заливка value — поставьте **`true`**.
- **`virtualClipboard: true`** (по умолчанию): у **каждого профиля Dolphin** свой буфер (`clipboardByProfile` по `profileId`). Ctrl+C/Ctrl+X читают **текст этого окна**: позиция последнего клика/колеса, фокус через `elementFromPoint`, выделение из `<input>`/`<textarea>` (не только `window.getSelection`). Копирование из **контекстного меню** на агенте учитывает то же. Ctrl+V вставляет **из буфера этого профиля**.
- **`clipboardLogToFile`**: писать в файлы всё скопированное/вырезанное по окнам (по умолчанию `true`). Каталог по умолчанию: `agent/clipboard-logs` (от корня проекта / cwd агента).
- **Главное окно (расширение)**: копирование/вырезание уходит на сервер **только в лог**, агентам не транслируется. Файлы: `clipboard-logs/controller-<controllerId>.log` (рядом с сервером) или путь из переменной окружения **`CLIPBOARD_LOG_DIR`**.
- **`strictUrlMatch: false`** (по умолчанию): навигация **не** блокируется из‑за расхождения `fromHref` и URL агента — удобно, когда **ссылки с кнопок отличаются** (query, рефки). Установите **`true`**, если нужна строгая синхронизация только после совпадения «отправной» страницы.
- **`mouseDispatchMode`**: по умолчанию **`"cdp"`** — клики идут через CDP `Input.dispatchMouseEvent` **без** обязательного `bringToFront`, чтобы события доходили до **фоновой/свёрнутой** вкладки Dolphin (если Chromium позволяет). **`"puppeteer"`** — старый путь `page.mouse` + поднятие окна на mousedown (если включён `bringAgentWindowToFront`).
- **Разные размеры окон**: главный шлёт координаты в **долях** окна (`clientX / width`); на агенте умножаем на **layout/visual viewport** страницы (`Page.getLayoutMetrics`, `visualViewport`, кэш). Окна могут быть разного размера — точка остаётся в той же **относительной** позиции.
- **Очередь при старте**: пока ни один профиль Dolphin не подключился, события с главного **буферизуются** (до 100 шт.) и сбрасываются после первого успешного `connect`.
- **Вкладки (быстро)**: список берётся через **`browser.targets()`**; кэш **`tabPickCacheMs`** + кэш списка **`targetsListCacheMs`** при большом числе вкладок; **`mouseMoveThrottleMs`** — прореживание только **`mousemove`** на агентах. Кэши сбрасываются при навигации/смене вкладок.
- **Расширение Chrome**: content script держит **`chrome.runtime.connect({ name: 'dolphin-sync' })`** — надёжнее, чем один `sendMessage` при «засыпании» service worker (MV3).
- **Вкладки и история**: **+** в **любом** окне Chrome с расширением → у всех агентов новая вкладка. **+** вручную в окне **Dolphin** (профиль) → остальные агенты тоже получают новую вкладку (отправитель не дублирует сам себе). Переключение вкладки на главном → агенты переключаются на вкладку с тем же URL. Кнопки **Назад** / **Вперёд** на главном → `goBack` / `goForward` на агентах **без** `strictUrlMatch`.
- **`navigateWaitUntil` / `navigateTimeoutMs`**: параметры для `page.goto` и истории (по умолчанию как `openOnConnectWaitUntil` / 30 с).
- **`urlMatchMode`**: по умолчанию **`hostpath`** (без query) — кнопки с разными GET-параметрами на том же пути считаются «той же страницей» для выбора вкладки. **`full`** / **`origin`** — см. `SYNC_GUIDE.md`.
- **`replicatePaste`**: используется только если **`virtualClipboard: false`**. При **`virtualClipboard: true`** (по умолчанию) вставка на агентах всегда из **своего** файла буфера профиля, а не из ОС.

## Лимит запросов Dolphin (1500 RPM)

Агент кэширует `login-with-token` (~25 мин). См. **`connectStaggerMs`** выше. При ответе «лимит» делается пауза ~65 с. Не запускайте десятки отдельных процессов агента, каждый из которых долбит API.
