# Руководство по синхронизации Dolphin Tab Sync

## Назначение

С **главного ПК** (Chrome + расширение `extension/`) события мыши, клавиатуры, колеса, навигации и вкладок передаются на **сервер** (`sync-server/`), а **агент** (`agent/agent.js`) воспроизводит их в профилях **Dolphin Anty** через CDP (Puppeteer).

## Компоненты

| Компонент | Роль |
|-----------|------|
| **Расширение Chrome** | Снимает события со страницы, шлёт на сервер по WebSocket (`chrome.runtime.connect` + fallback). |
| **Сервер** | Транслирует события от `controller` ко всем `agent` с включённым sync. |
| **Агент Node** | Подключается к Dolphin API, CDP, повторяет действия **по каждому profileId**. |

## Буфер обмена — свой на каждое окно

- В конфиге: `"virtualClipboard": true` (по умолчанию в примерах).
- У каждого `profileId` свой объект `clipboardByProfile[profileId]`.
- Ctrl+C / Ctrl+X / Ctrl+V на агенте не используют общий системный буфер Windows между профилями.
- События **copy** с главного транслируются на агентов: текст попадает в буфер каждого профиля (и логируется на сервере).

## Только уже открытые окна Dolphin

- `target.openOnConnectMode: "onlyExisting"` — при подключении **не** вызывается `goto` на URL из конфига, если уже есть подходящая вкладка (по домену, `preferUrlIncludes`, `urlMatchMode`).
- Новая вкладка создаётся **только** если в браузере профиля **0** страниц.
- Список профилей: явный `profileIds` или `autoDiscoverRunningProfileIds` (при заданных id список **не** перезаписывается).

## Разные размеры экрана главного и агентов

- Главный шлёт координаты **в долях** viewport (`clientX / width`, `clientY / height`).
- Агент умножает на **layout / visual viewport** страницы (`Page.getLayoutMetrics`, `visualViewport`, кэш).
- Окна могут быть разного размера — попадание остаётся **относительным** в клиентской области страницы.

## Разные ссылки при нажатии кнопок

- По умолчанию `sync.urlMatchMode: "hostpath"` — совпадение **без query** (путь + домен).
- `sync.strictUrlMatch: false` (по умолчанию) — навигация не блокируется из‑за расхождения `fromHref` и текущего URL агента.
- Вкладка для кликов выбирается по **тому же** режиму; если точного совпадения нет — используется текущая сессия / `preferUrlIncludes`.

## Новые вкладки

- С главного: `tabs` + `navigate` (tab-select, url) — на агентах открывается/переключается вкладка; при отсутствии совпадения может быть `newPage` + `goto` (как в `applyTabSelect`).
- Кнопки «+» в Dolphin — опционально транслируются другим агентам (`agentForward`).

## Назад / вперёд в браузере

- События `navigate` с `kind: history` (из расширения `webNavigation`) вызывают `page.goBack` / `goForward` на активной странице агента **без** `strictUrlMatch`.

## Производительность при многих вкладках

- Кэш выбора вкладки по `href`: `tabPickCacheMs`.
- Кэш списка `browser.targets()`: `targetsListCacheMs`.
- Ограничение частоты **mousemove** на агенте: `mouseMoveThrottleMs` (down/up/wheel не режутся).
- На главном: реже отправляются `mousemove` (~50 ms в `content.js`).
- Режим мыши CDP: `mouseDispatchMode: "cdp"` — без лишнего `bringToFront`.

## Проверка

1. Запустить сервер: `npm run server` (или ваш хост Railway).
2. Указать `serverWsUrl` в `agent/config.json` и в расширении.
3. Запустить агент: `npm run agent`.
4. Открыть главный Chrome с расширением, профили Dolphin с теми же целевыми сайтами.
5. Проверить клик, ввод, вкладку, назад/вперёд, разные размеры окон.

## Файл конфигурации

См. актуальный `agent/config.json` и `agent/config.example.multi.json`. Ключевые поля: `target.openOnConnectMode`, `sync.urlMatchMode`, `sync.strictUrlMatch`, `sync.virtualClipboard`, `sync.mouseMoveThrottleMs`, `sync.targetsListCacheMs`.
