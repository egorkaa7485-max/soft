const DEFAULT_SERVER_WS = 'wss://soft-production-e391.up.railway.app/ws';
const DEFAULT_CONTROLLER_ID = 'controller-main';

let ws = null;
let reconnectTimer = null;
let isManualClose = false;
let serverWsUrl = DEFAULT_SERVER_WS;
let controllerId = DEFAULT_CONTROLLER_ID;

function log(...args) {
  console.log('[sync-bg]', ...args);
}

async function loadSettings() {
  const data = await chrome.storage.local.get(['serverWsUrl', 'controllerId']);
  serverWsUrl = data.serverWsUrl || DEFAULT_SERVER_WS;
  controllerId = data.controllerId || DEFAULT_CONTROLLER_ID;
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
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    type: 'controllerEvent',
    payload
  }));
}

function emitNavigate(kind, url) {
  sendEventToServer({
    eventType: 'navigate',
    kind,
    url,
    ts: Date.now(),
    href: url
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  await loadSettings();
  connect();
});

chrome.runtime.onStartup.addListener(async () => {
  await loadSettings();
  connect();
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
    if (tab?.url) emitNavigate('tab-select', tab.url);
  } catch {}
});

chrome.webNavigation?.onHistoryStateUpdated?.addListener((details) => {
  if (details?.url) emitNavigate('url', details.url);
});

loadSettings().then(connect);

