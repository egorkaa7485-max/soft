const DEFAULT_SERVER_WS = 'wss://soft-sage.vercel.app/ws';
const DEFAULT_CONTROLLER_ID = 'controller-main';

/** URL активной вкладки до переключения на другую вкладку */
let lastActiveTabUrl = null;
/** Последний известный URL по tabId (для fromHref при навигации в той же вкладке) */
const tabIdToUrl = new Map();
/** Чтобы не дублировать navigate «url» при history back/forward */
const tabLastTransition = new Map();

function isSyncableTabUrl(url) {
  if (!url) return false;
  if (url.startsWith('chrome-extension://')) return false;
  if (url.startsWith('chrome://')) {
    return /newtab|new-tab-page|new_tab/i.test(url);
  }
  return true;
}

let ws = null;
let reconnectTimer = null;
let isManualClose = false;
let serverWsUrl = DEFAULT_SERVER_WS;
let controllerId = DEFAULT_CONTROLLER_ID;

/** Пока WebSocket не OPEN, события не теряем — сбрасываем после register при open. */
const MAX_PENDING_OUT = 500;
const pendingOut = [];

function flushPendingOut() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  while (pendingOut.length) {
    const payload = pendingOut.shift();
    try {
      ws.send(
        JSON.stringify({
          type: 'controllerEvent',
          payload
        })
      );
    } catch (e) {
      log('flush pending failed', e?.message || e);
      pendingOut.unshift(payload);
      break;
    }
  }
}

function log(...args) {
  console.log('[sync-bg]', ...args);
}

async function loadSettings() {
  const data = await chrome.storage.local.get(['serverWsUrl', 'controllerId']);
  serverWsUrl = data.serverWsUrl || DEFAULT_SERVER_WS;
  controllerId = data.controllerId || DEFAULT_CONTROLLER_ID;
}

async function initActiveTabTracking() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id && tab.url && isSyncableTabUrl(tab.url)) {
      lastActiveTabUrl = tab.url;
      tabIdToUrl.set(tab.id, tab.url);
    }
  } catch {}
}

function clearReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect() {
  clearReconnect();
  reconnectTimer = setTimeout(() => {
    connect();
  }, 1500);
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  isManualClose = false;
  ws = new WebSocket(serverWsUrl);

  ws.addEventListener('open', () => {
    log('connected', serverWsUrl);
    ws.send(JSON.stringify({
      type: 'register',
      role: 'controller',
      id: controllerId,
      meta: { source: 'chrome-extension' }
    }));
    flushPendingOut();
  });

  ws.addEventListener('close', () => {
    log('disconnected');
    if (!isManualClose) scheduleReconnect();
  });

  ws.addEventListener('error', (e) => {
    log('ws error', e?.message || e);
  });
}

function sendEventToServer(payload) {
  if (!payload) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    if (pendingOut.length < MAX_PENDING_OUT) pendingOut.push(payload);
    else log('pending queue full, drop event');
    return;
  }
  try {
    ws.send(
      JSON.stringify({
        type: 'controllerEvent',
        payload
      })
    );
  } catch (e) {
    log('send failed', e?.message || e);
    if (pendingOut.length < MAX_PENDING_OUT) pendingOut.push(payload);
  }
}

function emitTabSelect(tabId, url) {
  if (!isSyncableTabUrl(url)) return;
  sendEventToServer({
    eventType: 'navigate',
    kind: 'tab-select',
    url,
    fromHref: lastActiveTabUrl,
    ts: Date.now(),
    href: url
  });
  lastActiveTabUrl = url;
  tabIdToUrl.set(tabId, url);
}

chrome.runtime.onInstalled.addListener(async () => {
  await loadSettings();
  await initActiveTabTracking();
  connect();
});

chrome.runtime.onStartup.addListener(async () => {
  await loadSettings();
  await initActiveTabTracking();
  connect();
});

/** Долгоживущий канал content ↔ service worker (MV3): события не теряются при «сон» SW. */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'dolphin-sync') return;
  port.onMessage.addListener((message) => {
    if (message && message.type === 'sync_event' && message.payload) {
      sendEventToServer(message.payload);
    }
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') return;

  if (message.type === 'sync_event') {
    sendEventToServer(message.payload);
    sendResponse({ ok: true });
    return;
  }

  if (message.type === 'sync_set_config') {
    const nextWs = String(message.serverWsUrl || '').trim();
    const nextId = String(message.controllerId || '').trim();
    if (nextWs) serverWsUrl = nextWs;
    if (nextId) controllerId = nextId;
    chrome.storage.local.set({ serverWsUrl, controllerId }).then(() => {
      if (ws) {
        isManualClose = true;
        try { ws.close(); } catch {}
      }
      connect();
      sendResponse({ ok: true, serverWsUrl, controllerId });
    });
    return true;
  }

  if (message.type === 'sync_status') {
    sendResponse({
      ok: true,
      serverWsUrl,
      controllerId,
      wsReadyState: ws ? ws.readyState : -1
    });
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.url) emitTabSelect(tabId, tab.url);
  } catch {}
});

/** Переключили окно Chrome — синхронизируем активную вкладку с агентами */
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab?.id && tab.url) emitTabSelect(tab.id, tab.url);
  } catch {}
});

/** Новая вкладка (+) в любом окне Chrome с этим расширением (не только сфокусированном) */
chrome.tabs.onCreated.addListener(async (tab) => {
  try {
    /** Чтобы при первом переходе был fromHref (иначе strict на агенте раньше блокировал goto). */
    if (tab?.id != null) {
      const initial = tab.pendingUrl || tab.url || '';
      if (initial) tabIdToUrl.set(tab.id, initial);
    }
    sendEventToServer({
      eventType: 'tabs',
      kind: 'new',
      ts: Date.now(),
      href: tab.pendingUrl || tab.url || ''
    });
  } catch {}
});

/** Назад/вперёд в истории (кнопки браузера) */
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  tabLastTransition.set(details.tabId, { type: details.transitionType, ts: Date.now() });
  if (details.transitionType !== 'back_forward') return;
  const u = details.url || '';
  if (!isSyncableTabUrl(u)) return;
  const quals = details.transitionQualifiers || [];
  const isForward = quals.includes('forward_list');
  sendEventToServer({
    eventType: 'navigate',
    kind: 'history',
    direction: isForward ? 'forward' : 'back',
    url: u,
    ts: Date.now(),
    href: u
  });
});

/** Смена URL в вкладке (в т.ч. клик по ссылке с полной перезагрузкой) */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url || !tab?.active) return;
  const u = changeInfo.url;
  if (!isSyncableTabUrl(u)) return;
  const tr = tabLastTransition.get(tabId);
  if (tr?.type === 'back_forward' && Date.now() - tr.ts < 600) {
    tabIdToUrl.set(tabId, u);
    lastActiveTabUrl = u;
    return;
  }
  const oldUrl = tabIdToUrl.get(tabId) ?? '';
  if (oldUrl === u) return;
  sendEventToServer({
    eventType: 'navigate',
    kind: 'url',
    url: u,
    fromHref: oldUrl || null,
    ts: Date.now(),
    href: u
  });
  tabIdToUrl.set(tabId, u);
  lastActiveTabUrl = u;
});

/** Клик по иконке расширения — на агентах Ctrl+L / Cmd+L (омнибар не в content script). */
chrome.action.onClicked.addListener(() => {
  sendEventToServer({
    eventType: 'chrome-ui',
    kind: 'focus-address-bar',
    ts: Date.now(),
    href: ''
  });
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'focus-agents-address-bar') {
    sendEventToServer({
      eventType: 'chrome-ui',
      kind: 'focus-address-bar',
      ts: Date.now(),
      href: ''
    });
  }
});

loadSettings().then(async () => {
  await initActiveTabTracking();
  connect();
});

