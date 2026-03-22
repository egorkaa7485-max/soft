import fs from 'fs';
import path from 'path';
import axios from 'axios';
import WebSocket from 'ws';
import puppeteer from 'puppeteer-core';

const CONFIG_PATH = process.env.AGENT_CONFIG
  ? path.resolve(process.env.AGENT_CONFIG)
  : path.resolve(process.cwd(), 'agent', 'config.json');

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  return JSON.parse(raw);
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clamp01(n) {
  if (Number.isNaN(n) || !Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function sanitizeFileName(input) {
  return String(input).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
}

/**
 * Встроенный Chromium Dolphin не всегда отдаёт lifecycle `commit` в CDP → Puppeteer падает с
 * "Unknown value for options.waitUntil: commit". Подменяем на `domcontentloaded`.
 */
function coercePuppeteerWaitUntil(w) {
  const s = String(w ?? 'domcontentloaded').trim();
  if (s === 'commit') return 'domcontentloaded';
  return s;
}

/** Кэш сессии Dolphin local API — меньше запросов (ниже риск 1500 RPM) */
let dolphinLoginExpiresAt = 0;
const DOLPHIN_LOGIN_TTL_MS = 25 * 60 * 1000;

function normalizeUrlForMatch(url, mode) {
  try {
    const u = new URL(url);
    if (mode === 'origin') return `${u.protocol}//${u.host}`;
    if (mode === 'hostpath') return `${u.protocol}//${u.host}${u.pathname}`;
    return `${u.protocol}//${u.host}${u.pathname}${u.search}`;
  } catch {
    return String(url || '');
  }
}

function urlsMatch(agentUrl, masterHref, mode) {
  if (!masterHref) return true;
  const a = normalizeUrlForMatch(agentUrl, mode);
  const b = normalizeUrlForMatch(masterHref, mode);
  return a === b;
}

/** Та же вкладка по полному URL (учёт канонического href), точнее чем только normalize. */
function urlsStrictEqual(a, b) {
  if (!a || !b) return false;
  try {
    return new URL(String(a).trim()).href === new URL(String(b).trim()).href;
  } catch {
    return String(a).trim() === String(b).trim();
  }
}

function isBlankPageUrl(u) {
  const s = String(u || '').trim();
  return (
    !s ||
    s === 'about:blank' ||
    /^chrome:\/\/new/i.test(s) ||
    /^chrome:\/\/newtab/i.test(s)
  );
}

/**
 * Уже открытая вкладка под target.openOnConnectUrl — не подменять её goto из конфига.
 */
async function pickExistingPageForOpenOnConnect(browser, openOnConnectUrl, preferUrlIncludes, urlMatchMode) {
  const mode = urlMatchMode || 'hostpath';
  const openUrl = String(openOnConnectUrl || '').trim();
  let targets = [];
  try {
    targets = browser.targets().filter((t) => t.type() === 'page');
  } catch {
    return null;
  }
  if (!targets.length) return null;

  const candidates = [];
  for (const t of targets) {
    let u = '';
    try {
      u = String(t.url() || '');
    } catch {
      continue;
    }
    if (isBlankPageUrl(u)) continue;
    candidates.push({ t, u });
  }
  if (!candidates.length) return null;

  if (openUrl) {
    for (const { t, u } of candidates) {
      if (urlsStrictEqual(u, openUrl)) {
        const p = await t.page();
        if (p && !p.isClosed?.()) return p;
      }
    }
    for (const { t, u } of candidates) {
      if (urlsMatch(u, openUrl, mode)) {
        const p = await t.page();
        if (p && !p.isClosed?.()) return p;
      }
    }
  }

  if (preferUrlIncludes) {
    const inc = String(preferUrlIncludes);
    for (const { t, u } of candidates) {
      if (u.includes(inc)) {
        const p = await t.page();
        if (p && !p.isClosed?.()) return p;
      }
    }
  }

  if (openUrl) {
    try {
      const origin = new URL(openUrl).origin;
      for (const { t, u } of candidates) {
        try {
          if (new URL(u).origin === origin) {
            const p = await t.page();
            if (p && !p.isClosed?.()) return p;
          }
        } catch {
          continue;
        }
      }
    } catch {
      /* ignore */
    }
  }

  return null;
}

/**
 * Тот же выбор, что pickExistingPageForOpenOnConnect, но по browser.pages() / page.url()
 * (иногда URL актуальнее, чем у Target во время загрузки).
 */
async function pickExistingPageFromOpenPages(browser, openOnConnectUrl, preferUrlIncludes, urlMatchMode) {
  const mode = urlMatchMode || 'hostpath';
  const openUrl = String(openOnConnectUrl || '').trim();
  let pages = [];
  try {
    pages = await browser.pages();
  } catch {
    return null;
  }
  const candidates = [];
  for (const p of pages) {
    let u = '';
    try {
      u = String(p.url() || '');
    } catch {
      continue;
    }
    if (isBlankPageUrl(u)) continue;
    candidates.push({ p, u });
  }
  if (!candidates.length) return null;

  if (openUrl) {
    for (const { p, u } of candidates) {
      if (urlsStrictEqual(u, openUrl)) return p;
    }
    for (const { p, u } of candidates) {
      if (urlsMatch(u, openUrl, mode)) return p;
    }
  }
  if (preferUrlIncludes) {
    const inc = String(preferUrlIncludes);
    for (const { p, u } of candidates) {
      if (u.includes(inc)) return p;
    }
  }
  if (openUrl) {
    try {
      const origin = new URL(openUrl).origin;
      for (const { p, u } of candidates) {
        try {
          if (new URL(u).origin === origin) return p;
        } catch {
          continue;
        }
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

function normalizeOpenOnConnectMode(raw) {
  const s = String(raw ?? 'onlyExisting')
    .trim()
    .toLowerCase()
    .replace(/[-_]/g, '');
  if (s === 'always' || s === 'force') return 'always';
  if (s === 'never' || s === 'skip') return 'never';
  if (s === 'preferexisting' || s === 'preferopened') return 'preferExisting';
  if (s === 'onlyexisting' || s === 'existingonly' || s === 'onlyopened' || s === 'useopened') return 'onlyExisting';
  return 'onlyExisting';
}

/**
 * Иногда в keydown/keyup приходит пустой key, но есть code (Chrome) — иначе Puppeteer: Unknown key "undefined"
 */
function keyFromSyncEvent(ev) {
  const raw = ev?.key;
  if (raw != null && raw !== '' && String(raw) !== 'undefined') {
    return String(raw);
  }
  const code = ev?.code;
  if (!code || typeof code !== 'string') return null;
  if (code.startsWith('Key')) {
    const letter = code.slice(3);
    return ev.shift ? letter : letter.toLowerCase();
  }
  if (code.startsWith('Digit')) return code.slice(5);
  if (code === 'Space') return ' ';
  if (code.startsWith('Numpad')) {
    const n = code.replace('Numpad', '');
    if (n === 'Decimal') return '.';
    if (n === 'Divide') return '/';
    if (n === 'Multiply') return '*';
    if (n === 'Subtract') return '-';
    if (n === 'Add') return '+';
    return n;
  }
  if (/^F([1-9]|1[0-2])$/.test(code)) return code;
  if (code.startsWith('Arrow')) return code;
  if (code === 'Enter' || code === 'Tab' || code === 'Backspace' || code === 'Delete' || code === 'Escape') {
    return code;
  }
  if (code === 'Minus') return ev.shift ? '_' : '-';
  if (code === 'Equal') return ev.shift ? '+' : '=';
  if (code === 'BracketLeft') return ev.shift ? '{' : '[';
  if (code === 'BracketRight') return ev.shift ? '}' : ']';
  if (code === 'Semicolon') return ev.shift ? ':' : ';';
  if (code === 'Quote') return ev.shift ? '"' : "'";
  if (code === 'Backquote') return ev.shift ? '~' : '`';
  if (code === 'Backslash') return ev.shift ? '|' : '\\';
  if (code === 'Comma') return ev.shift ? '<' : ',';
  if (code === 'Period') return ev.shift ? '>' : '.';
  if (code === 'Slash') return ev.shift ? '?' : '/';
  return code;
}

function isDolphinRateLimitError(e) {
  const st = e?.response?.status;
  const body = JSON.stringify(e?.response?.data ?? '');
  return st === 429 || /лимит|RPM|rate|blocked/i.test(body);
}

/** Код из тела ответа Dolphin (axios кладёт JSON в response.data, иногда строкой) */
function extractDolphinErrorCode(e) {
  const raw = e?.response?.data;
  if (raw != null) {
    let obj = raw;
    if (typeof raw === 'string') {
      try {
        obj = JSON.parse(raw);
      } catch {
        obj = null;
      }
    }
    if (obj && typeof obj === 'object') {
      const code = obj?.errorObject?.code;
      if (typeof code === 'string' && code.length) return code;
    }
  }
  const msg = String(e?.message ?? '');
  const m = msg.match(/"code"\s*:\s*"([^"]+)"/);
  if (m?.[1]) return m[1];
  if (/E_BROWSER_RUN_DUPLICATE/i.test(msg)) return 'E_BROWSER_RUN_DUPLICATE';
  const fail = msg.match(/Dolphin start failed:\s*(\{[\s\S]*\})\s*$/);
  if (fail) {
    try {
      const j = JSON.parse(fail[1]);
      const c = j?.errorObject?.code;
      return typeof c === 'string' && c.length ? c : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Ищет automation.port + wsEndpoint в ответе Dolphin (иногда при DUPLICATE всё равно отдаёт CDP). */
function dolphinPickAutomationDeep(data, depth = 0) {
  if (!data || typeof data !== 'object' || depth > 12) return null;
  const a = data.automation;
  if (a && typeof a === 'object') {
    const port = a.port;
    const wsEndpoint = a.wsEndpoint;
    if (port != null && port !== '' && wsEndpoint) {
      return { port: Number(port), wsEndpoint: String(wsEndpoint) };
    }
  }
  if (Array.isArray(data)) {
    for (const it of data) {
      const r = dolphinPickAutomationDeep(it, depth + 1);
      if (r) return r;
    }
    return null;
  }
  for (const v of Object.values(data)) {
    if (v && typeof v === 'object') {
      const r = dolphinPickAutomationDeep(v, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

/**
 * Ищет automation только в ветке, относящейся к profileId (не чужой ws из соседнего профиля).
 */
function dolphinPickAutomationUnderProfileId(data, profileId, depth = 0) {
  if (!data || typeof data !== 'object' || depth > 16) return null;
  const want = String(profileId);
  if (data[want] != null && typeof data[want] === 'object') {
    const a = dolphinPickAutomationDeep(data[want]);
    if (a) return a;
  }
  const id = String(
    data.id ?? data.browserProfileId ?? data.profile_id ?? data.profileId ?? ''
  );
  if (id === want) {
    const a = dolphinPickAutomationDeep(data);
    if (a) return a;
  }
  if (Array.isArray(data)) {
    for (const it of data) {
      const r = dolphinPickAutomationUnderProfileId(it, profileId, depth + 1);
      if (r) return r;
    }
    return null;
  }
  for (const v of Object.values(data)) {
    if (v && typeof v === 'object') {
      const r = dolphinPickAutomationUnderProfileId(v, profileId, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

/** Попытка получить CDP для уже запущенного профиля без stop/start. */
async function dolphinTryGetRunningAutomation(dolphinBaseUrl, profileId) {
  /** Без повторного /start — только данные профиля (часто там же port/ws для running). */
  const urls = [
    `${dolphinBaseUrl}/v1.0/browser_profiles/${encodeURIComponent(profileId)}`,
    `${dolphinBaseUrl}/v1.0/browser_profiles/${encodeURIComponent(profileId)}/automation`
  ];
  for (const url of urls) {
    try {
      const r = await axios.get(url, { timeout: 4000, validateStatus: (s) => s < 600 });
      const auto = dolphinPickAutomationDeep(r.data);
      if (auto) return auto;
    } catch {
      /* ignore */
    }
  }
  /** Список running иногда содержит ws для каждого id, когда одиночный GET ещё пустой. */
  const runningUrls = [
    `${dolphinBaseUrl}/v1.0/browser_profiles/running`,
    `${dolphinBaseUrl}/v1.0/browser_profiles?status=running&limit=1000&page=1`
  ];
  for (const url of runningUrls) {
    try {
      const r = await axios.get(url, { timeout: 3500, validateStatus: (s) => s < 600 });
      const scoped = dolphinPickAutomationUnderProfileId(r.data, profileId);
      if (scoped) return scoped;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Несколько быстрых опросов GET — Dolphin иногда отдаёт port/ws с задержкой после старта окна. */
async function dolphinPollAutomation(dolphinBaseUrl, profileId, gapsMs) {
  const gaps = gapsMs ?? [0, 60, 130, 210];
  for (let i = 0; i < gaps.length; i++) {
    if (gaps[i]) await sleep(gaps[i]);
    const a = await dolphinTryGetRunningAutomation(dolphinBaseUrl, profileId);
    if (a) return a;
  }
  return null;
}

/** Перед stop при DUPLICATE — дольше опрашиваем GET/running (часто CDP появляется через 0.5–2 с). */
async function dolphinPollAutomationBeforeStop(dolphinBaseUrl, profileId) {
  return dolphinPollAutomation(dolphinBaseUrl, profileId, [0, 120, 280, 550, 900, 1400, 2000]);
}

function dolphinAutomationFromAxiosError(e) {
  return dolphinPickAutomationDeep(e?.response?.data);
}

/** Перегруз Dolphin / внутренняя ошибка — нельзя долбить API в цикле с 2 с */
function isDolphinOverloadError(e) {
  if (extractDolphinErrorCode(e) === 'E_BROWSER_RUN_DUPLICATE') return false;
  /** HTTP 500 часто = заняты файлы профиля (SQLite), не «перегруз API» */
  if (isDolphinProfileDataFileError(e)) return false;
  const st = e?.response?.status;
  if (st === 500 || st === 502 || st === 503 || st === 504) return true;
  const body = String(JSON.stringify(e?.response?.data ?? '') + (e?.message ?? ''));
  return /overload|temporar|unavailable|502|503|504/i.test(body);
}

function formatDolphinConnectError(e) {
  const st = e?.response?.status;
  const data = e?.response?.data;
  const snippet = data != null ? JSON.stringify(data).slice(0, 400) : '';
  if (st) return `HTTP ${st}${snippet ? ` — ${snippet}` : ''}`;
  return String(e?.message ?? e);
}

/** CDP/Puppeteer при закрытии вкладки/браузера — не спамить в лог как ошибку */
function isBenignBrowserClosedError(e) {
  const m = String(e?.message ?? e ?? '');
  if (
    /target closed|session closed|detached|page has been closed|most likely the page has been closed/i.test(m) ||
    /execution context was destroyed|cannot find context with specified id|browser has been disconnected|connection closed/i.test(m)
  ) {
    return true;
  }
  /** Puppeteer: Protocol error (Input.dispatchMouseEvent): Session closed — скобки в тексте ломали узкий regex */
  if (/^protocol error/i.test(m) && /closed|detached|destroyed/i.test(m)) return true;
  if (
    /protocol error.*addscripttoevaluateonnewdocument|protocol error.*exposefunction|protocol error.*dispatchmouseevent|input\.dispatchmouseevent/i.test(
      m
    )
  ) {
    return true;
  }
  return false;
}

/** Dolphin HTTP 500: файлы профиля заняты другим процессом / блокировка SQLite (не «перегруз API») */
function isDolphinProfileDataFileError(e) {
  const raw = e?.response?.data;
  const body =
    typeof raw === 'string'
      ? raw
      : raw != null
        ? JSON.stringify(raw)
        : '';
  const msg = `${body} ${e?.message ?? ''}`;
  return (
    /EBUSY|resource busy or locked|unknown error, open '/i.test(msg) ||
    /dolphin_anty[\\/]+browser_profiles[\\/]/i.test(msg) ||
    /[\\/]Default[\\/](History|Cookies|Web Data|Favicons|Login Data)/i.test(msg)
  );
}

function connectBackoffMs(e) {
  const msg = String(e?.message ?? e?.code ?? '');
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET/i.test(msg)) return 10_000;
  if (isDolphinRateLimitError(e)) return 65_000;
  if (extractDolphinErrorCode(e) === 'E_BROWSER_RUN_DUPLICATE') return 2500;
  if (isDolphinProfileDataFileError(e)) return 6000 + Math.floor(Math.random() * 4000);
  if (isDolphinOverloadError(e)) return 12_000 + Math.floor(Math.random() * 8000);
  return 3500;
}

/** Ограничение параллельных `browser_profiles/.../start` (иначе 500 от API) */
function createStartLimiter(maxConcurrent) {
  let active = 0;
  const queue = [];
  const runNext = () => {
    while (active < maxConcurrent && queue.length) {
      const { fn, resolve, reject } = queue.shift();
      active++;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          active--;
          runNext();
        });
    }
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      runNext();
    });
}

async function dolphinLoginCached(dolphinBaseUrl, token) {
  if (Date.now() < dolphinLoginExpiresAt) return;
  await dolphinLogin(dolphinBaseUrl, token);
  dolphinLoginExpiresAt = Date.now() + DOLPHIN_LOGIN_TTL_MS;
}

function pickPage(pages, preferUrlIncludes) {
  if (!pages?.length) return null;
  if (preferUrlIncludes) {
    const p = pages.find((x) => (x.url?.() ?? '').includes(preferUrlIncludes));
    if (p) return p;
  }
  const nonBlank = pages.find((x) => (x.url?.() ?? '') && x.url() !== 'about:blank');
  return nonBlank ?? pages[0];
}

async function dolphinLogin(dolphinBaseUrl, token) {
  await axios.post(
    `${dolphinBaseUrl}/v1.0/auth/login-with-token`,
    { token },
    { headers: { 'Content-Type': 'application/json' }, timeout: 15_000 }
  );
}

async function dolphinStartProfile(dolphinBaseUrl, profileId, startTimeoutMs = 45_000) {
  const url = `${dolphinBaseUrl}/v1.0/browser_profiles/${encodeURIComponent(profileId)}/start?automation=1`;
  const r = await axios.get(url, {
    timeout: startTimeoutMs,
    validateStatus: (status) => status < 600
  });
  /** Если в теле уже есть port/wsEndpoint — подключаемся к CDP (часто при «профиль уже запущен»). */
  const autoFromBody = dolphinPickAutomationDeep(r.data);
  if (autoFromBody) return autoFromBody;

  if (r.status >= 400) {
    const err = new Error(`Dolphin start HTTP ${r.status}`);
    err.response = { status: r.status, data: r.data };
    throw err;
  }
  if (!r.data?.success) {
    /** DUPLICATE и др. иногда всё равно кладут automation в JSON — не уходим сразу в stop */
    const fromFail = dolphinPickAutomationDeep(r.data);
    if (fromFail) return fromFail;
    const err = new Error(`Dolphin start failed: ${JSON.stringify(r.data)}`);
    err.response = { status: r.status, data: r.data };
    throw err;
  }
  const port = r.data?.automation?.port;
  const wsEndpoint = r.data?.automation?.wsEndpoint;
  if (!port || !wsEndpoint) throw new Error(`Missing automation.port/wsEndpoint: ${JSON.stringify(r.data)}`);
  return { port, wsEndpoint };
}

async function dolphinStopProfile(dolphinBaseUrl, profileId, stopTimeoutMs = 12_000) {
  const url = `${dolphinBaseUrl}/v1.0/browser_profiles/${encodeURIComponent(profileId)}/stop`;
  await axios.get(url, { timeout: stopTimeoutMs });
}

/**
 * Несколько параллельных stop давали timeout 30s на каждый — очередь + короткий таймаут и повтор.
 */
async function dolphinStopProfileWithRetries(dolphinBaseUrl, profileId, stopTimeoutMs, retries) {
  const url = `${dolphinBaseUrl}/v1.0/browser_profiles/${encodeURIComponent(profileId)}/stop`;
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      await axios.get(url, { timeout: stopTimeoutMs });
      return;
    } catch (e) {
      lastErr = e;
      if (i < retries - 1) await sleep(350 + i * 150);
    }
  }
  throw lastErr;
}

async function dolphinListProfiles(dolphinBaseUrl) {
  const urls = [
    `${dolphinBaseUrl}/v1.0/browser_profiles?limit=1000&page=1`,
    `${dolphinBaseUrl}/v1.0/browser_profiles`,
    `${dolphinBaseUrl}/v1.0/browser_profiles/running`,
    `${dolphinBaseUrl}/v1.0/browser_profiles?status=running&limit=1000&page=1`
  ];
  for (const url of urls) {
    try {
      const r = await axios.get(url, { timeout: 30_000 });
      const d = r.data;
      const items = Array.isArray(d?.data)
        ? d.data
        : (Array.isArray(d?.browserProfiles)
          ? d.browserProfiles
          : (Array.isArray(d) ? d : []));
      if (items.length) {
        return items;
      }
    } catch {}
  }
  return [];
}

async function dolphinListRunningIds(dolphinBaseUrl) {
  const urls = [
    `${dolphinBaseUrl}/v1.0/browser_profiles/running`,
    `${dolphinBaseUrl}/v1.0/browser_profiles?status=running&limit=1000&page=1`
  ];
  for (const url of urls) {
    try {
      const r = await axios.get(url, { timeout: 30_000 });
      const d = r.data;
      if (d && typeof d === 'object' && !Array.isArray(d)) {
        const keys = Object.keys(d).filter((k) => /^\d+$/.test(k) || /^[a-z0-9-]{6,}$/i.test(k));
        if (keys.length) return keys;
      }
      if (Array.isArray(d?.data)) {
        const ids = d.data.map((p) => pickProfileId(p)).filter(Boolean);
        if (ids.length) return [...new Set(ids)];
      }
    } catch {}
  }
  return [];
}

function pickProfileId(profile) {
  return String(
    profile?.id ??
    profile?.browserProfileId ??
    profile?.profile_id ??
    profile?.profileId ??
    ''
  ).trim();
}

function isRunningProfile(profile) {
  return (
    profile?.running === true ||
    profile?.is_running === true ||
    profile?.isRunning === true ||
    profile?.status === 'running' ||
    profile?.state === 'running'
  );
}

async function connectCdp({ port, wsEndpoint }) {
  const browserWSEndpoint = `ws://127.0.0.1:${port}${wsEndpoint}`;
  const browser = await puppeteer.connect({ browserWSEndpoint, defaultViewport: null });
  return browser;
}

async function ensurePage(browser, preferUrlIncludes, forceViewport) {
  const pages = await browser.pages();
  let page = pickPage(pages, preferUrlIncludes);
  if (!page) page = await browser.newPage();

  if (forceViewport?.enabled) {
    await page.setViewport({ width: forceViewport.width, height: forceViewport.height });
  }
  return page;
}

/** Только уже открытые вкладки — не создаёт новую, если есть хотя бы одна страница. */
async function ensurePageNoNew(browser, preferUrlIncludes, forceViewport) {
  const pages = await browser.pages();
  if (!pages.length) return null;
  let page = pickPage(pages, preferUrlIncludes);
  if (!page) page = pages[0];
  if (forceViewport?.enabled && page) {
    await page.setViewport({ width: forceViewport.width, height: forceViewport.height });
  }
  return page;
}

async function main() {
  const cfg = loadConfig();
  const agentId = cfg.agentId;
  const serverWsUrl = cfg.serverWsUrl;
  const dolphinBaseUrl = cfg.dolphin.baseUrl;
  const dolphinToken = cfg.dolphin.token;
  const autoDiscover = !!cfg.dolphin.autoDiscoverRunningProfileIds;

  async function discoverProfileIdsOnce() {
    await dolphinLoginCached(dolphinBaseUrl, dolphinToken);
    const runningIds = await dolphinListRunningIds(dolphinBaseUrl);
    if (runningIds.length) {
      cfg.dolphin.profileIds = [...new Set(runningIds)];
      saveConfig(cfg);
      console.log(`[${agentId}] discovered running profileIds: ${cfg.dolphin.profileIds.length}`);
      return cfg.dolphin.profileIds;
    }

    const profiles = await dolphinListProfiles(dolphinBaseUrl);
    const discovered = profiles
      .filter((p) => isRunningProfile(p))
      .map((p) => pickProfileId(p))
      .filter(Boolean);

    if (discovered.length) {
      cfg.dolphin.profileIds = [...new Set(discovered)];
      saveConfig(cfg);
      console.log(`[${agentId}] discovered running profileIds: ${cfg.dolphin.profileIds.length}`);
      return cfg.dolphin.profileIds;
    }

    if (profiles.length) {
      const fallbackIds = profiles.map((p) => pickProfileId(p)).filter(Boolean);
      if (fallbackIds.length) {
        cfg.dolphin.profileIds = [...new Set(fallbackIds)];
        saveConfig(cfg);
        console.log(`[${agentId}] auto-discover fallback profileIds: ${cfg.dolphin.profileIds.length}`);
        return cfg.dolphin.profileIds;
      }
    }

    return [];
  }

  /** Явно заданные в config id — auto-discover не должен подменять список (иначе теряются выбранные профили). */
  const explicitProfileIdsFromConfig =
    (Array.isArray(cfg.dolphin.profileIds) && cfg.dolphin.profileIds.length > 0) ||
    !!cfg.dolphin.profileId;

  let profileIds = Array.isArray(cfg.dolphin.profileIds) && cfg.dolphin.profileIds.length
    ? cfg.dolphin.profileIds
    : (cfg.dolphin.profileId ? [cfg.dolphin.profileId] : []);

  if (!profileIds.length && autoDiscover) {
    console.log(`[${agentId}] profileIds empty, waiting for auto-discover...`);
    while (!profileIds.length) {
      try {
        profileIds = await discoverProfileIdsOnce();
      } catch (e) {
        console.log(`[${agentId}] auto-discover retry: ${e?.message ?? e}`);
      }
      if (!profileIds.length) await sleep(3000);
    }
  } else if (autoDiscover && !explicitProfileIdsFromConfig) {
    try {
      const discovered = await discoverProfileIdsOnce();
      if (discovered.length) profileIds = discovered;
    } catch (e) {
      console.log(`[${agentId}] auto-discover skipped: ${e?.message ?? e}`);
    }
  } else if (autoDiscover && explicitProfileIdsFromConfig) {
    console.log(
      `[${agentId}] auto-discover: в конфиге задан profileIds/profileId (${profileIds.length} шт.) — список не перезаписываем`
    );
  }

  if (!profileIds.length) throw new Error('No dolphin.profileIds or dolphin.profileId defined in config');
  const preferUrlIncludes = cfg.target?.preferUrlIncludes ?? '';
  const forceViewport = cfg.target?.forceViewport ?? { enabled: false };
  const openOnConnectUrl = String(cfg.target?.openOnConnectUrl ?? '').trim();
  const openOnConnectWaitUntil = coercePuppeteerWaitUntil(
    cfg.target?.openOnConnectWaitUntil || 'domcontentloaded'
  );
  const openOnConnectTimeout = Math.max(5000, Number(cfg.target?.openOnConnectTimeoutMs) || 25_000);
  /**
   * always = goto(openOnConnectUrl);
   * preferExisting = сначала подобрать открытую вкладку, иначе goto;
   * onlyExisting = только уже открытые вкладки, без goto и без лишнего newPage;
   * never = не goto.
   */
  const openOnConnectMode = normalizeOpenOnConnectMode(cfg.target?.openOnConnectMode);
  /** Пачки при старте: больше — быстрее «все окна», но выше пиковая нагрузка на Dolphin/диск. */
  const connectConcurrency = Math.max(1, Math.min(30, Number(cfg.dolphin?.connectConcurrency) || 3));
  const connectStaggerMs = Math.max(0, Number(cfg.dolphin?.connectStaggerMs) || 180);
  /**
   * Раздельные очереди: параллельные **stop** чаще ловили EBUSY/таймауты → stop по умолчанию 1.
   * Параллельные **start** по разным profileId обычно безопаснее — по умолчанию 2 (ускоряет старт).
   * Заданный `maxConcurrentApiCalls` — прежнее поведение: одно число на **оба** типа вызовов.
   */
  const clampApi = (v, def) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 1) return def;
    return Math.max(1, Math.min(4, Math.floor(n)));
  };
  const legacyRaw = cfg.dolphin?.maxConcurrentApiCalls;
  const useLegacy =
    legacyRaw !== undefined && legacyRaw !== null && legacyRaw !== '' && Number.isFinite(Number(legacyRaw));
  let maxConcurrentStarts;
  let maxConcurrentStops;
  if (useLegacy) {
    const v = clampApi(legacyRaw, 1);
    maxConcurrentStarts = v;
    maxConcurrentStops = v;
  } else {
    maxConcurrentStarts = clampApi(cfg.dolphin?.maxConcurrentStarts, 2);
    maxConcurrentStops = clampApi(cfg.dolphin?.maxConcurrentStops, 1);
  }
  const runDolphinStart = createStartLimiter(maxConcurrentStarts);
  const runDolphinStop = createStartLimiter(maxConcurrentStops);
  const dolphinStartTimeoutMs = Math.max(15_000, Number(cfg.dolphin?.startTimeoutMs) || 45_000);
  const dolphinStopTimeoutMs = Math.max(5000, Number(cfg.dolphin?.stopTimeoutMs) || 12_000);
  const dolphinStopRetries = Math.max(1, Math.min(5, Number(cfg.dolphin?.stopRetries) || 2));
  /**
   * strictUrlMatch — только для навигации (ссылки, смена вкладки, SPA):
   * агент переходит дальше только если был на той же странице, что и главный (fromHref).
   * Мышь / клавиатура / скролл / ввод повторяются всегда (координаты нормализованы).
   */
  const navigateWaitUntil = coercePuppeteerWaitUntil(
    cfg.sync?.navigateWaitUntil || cfg.target?.openOnConnectWaitUntil || 'domcontentloaded'
  );
  const navigateTimeoutMs = Math.max(5000, Number(cfg.sync?.navigateTimeoutMs) || 30_000);
  const clipboardLogDirResolved = path.resolve(
    process.cwd(),
    String(cfg.sync?.clipboardLogDir || 'agent/clipboard-logs').trim() || 'agent/clipboard-logs'
  );
  const clipboardLogMaxChars = Math.max(1000, Number(cfg.sync?.clipboardLogMaxChars) || 500_000);
  const syncCfg = {
    /**
     * false по умолчанию: ссылки с главного и с агентов могут отличаться (query, рефки) — навигация не блокируется.
     * true — навигация только если агент был на той же «отправной» странице (fromHref).
     */
    strictUrlMatch: cfg.sync?.strictUrlMatch === true,
    /** hostpath — совпадение без query (кнопки с разными ссылками на том же пути); full — полный URL */
    urlMatchMode: cfg.sync?.urlMatchMode || 'hostpath',
    /** устарело: при virtualClipboard вставка всегда из своего буфера профиля */
    replicatePaste: cfg.sync?.replicatePaste === true,
    navigateWaitUntil,
    navigateTimeoutMs,
    /**
     * Виртуальный буфер на профиль: Ctrl+C/X/V не трогают общий системный буфер Windows,
     * у каждого окна Dolphin свой текст (копирование с выделения этого окна, вставка в это окно).
     */
    virtualClipboard: cfg.sync?.virtualClipboard !== false,
    /** Писать в файлы всё скопированное/вырезанное (и с контекстного меню тоже) */
    clipboardLogToFile: cfg.sync?.clipboardLogToFile !== false,
    clipboardLogMaxChars,
    /**
     * false (по умолчанию): не подставлять с главного полный `value` полей — иначе на всех профилях
     * тот же текст, что на главном, и копирование «своего» фрагмента невозможно. Ввод идёт через клавиши.
     * true — старое поведение: полная заливка value с главного (как раньше).
     */
    replicateInputValue: cfg.sync?.replicateInputValue === true,
    /**
     * Поднимать окно Dolphin на передний план при повторе событий (клик, вкладка, новая вкладка, openOnConnect).
     * На одном ПК с главным браузером поставьте false — свёрнутые/фоновые агенты не будут открываться при каждом клике на главном.
     */
    bringAgentWindowToFront: cfg.sync?.bringAgentWindowToFront !== false,
    /**
     * Событие focus-address-bar: поднять окно Dolphin, чтобы был виден фокус в омнибаре
     * (независимо от bringAgentWindowToFront).
     */
    focusAddressBarForcesBringToFront: cfg.sync?.focusAddressBarForcesBringToFront !== false,
    /**
     * Клик в самом верху страницы (доли viewport) трактовать как «хочу строку URL» и слать Ctrl+L на агент.
     * Омнибар Chrome на главном не даёт событий в content.js — это обходной вариант.
     */
    translateTopStripClickToAddressBarHotkey: cfg.sync?.translateTopStripClickToAddressBarHotkey === true,
    topStripAddressBarZoneMaxY: Math.min(
      0.2,
      Math.max(0.005, Number(cfg.sync?.topStripAddressBarZoneMaxY) || 0.028)
    ),
    topStripAddressBarZoneXMin: clamp01(Number(cfg.sync?.topStripAddressBarZoneXMin) || 0.12),
    topStripAddressBarZoneXMax: clamp01(Number(cfg.sync?.topStripAddressBarZoneXMax) || 0.88),
    /**
     * mouse: `cdp` — Input.dispatchMouseEvent без обязательного bringToFront (фон/свёрнутое окно Dolphin).
     * `puppeteer` — классический page.mouse + bringToFront на mousedown (если включён).
     */
    mouseDispatchMode: cfg.sync?.mouseDispatchMode === 'puppeteer' ? 'puppeteer' : 'cdp',
    /** Сколько мс держать выбранную вкладку для одного и того же href (ускоряет sync при множестве вкладок). 0 — без кэша. */
    tabPickCacheMs: Math.max(0, Number(cfg.sync?.tabPickCacheMs) || 8000),
    /** Кэш списка targets() на сессию — меньше обходов при десятках вкладок. 0 — каждый раз заново. */
    targetsListCacheMs: Math.max(0, Number(cfg.sync?.targetsListCacheMs) || 50),
    /**
     * Пропуск лишних mousemove на агенте (мс). 0 — не ограничивать.
     * Клики/down/up/wheel не режутся — только move.
     */
    mouseMoveThrottleMs: Math.max(0, Number(cfg.sync?.mouseMoveThrottleMs) || 33)
  };

  /** Если bringAgentWindowToFront: false — не вызываем bringToFront (окна остаются свёрнутыми/под другими). */
  async function maybeBringPageToFront(page) {
    if (!page || !syncCfg.bringAgentWindowToFront) return;
    await page.bringToFront().catch(() => {});
  }

  let syncEnabled = true;
  let lastSyncDisabledWarnAt = 0;

  /** Виртуальный буфер обмена по profileId (Dolphin окно) */
  const clipboardByProfile = {};
  for (const pid of profileIds) clipboardByProfile[pid] = '';

  function appendClipboardLog(windowId, text, extra = {}) {
    if (!syncCfg.clipboardLogToFile) return;
    const raw = String(text ?? '');
    if (!raw) return;
    const chunk =
      raw.length > syncCfg.clipboardLogMaxChars
        ? `${raw.slice(0, syncCfg.clipboardLogMaxChars)}\n...[truncated ${raw.length - syncCfg.clipboardLogMaxChars} chars]`
        : raw;
    try {
      fs.mkdirSync(clipboardLogDirResolved, { recursive: true });
      const base = sanitizeFileName(String(windowId || 'unknown')) || 'unknown';
      const file = path.join(clipboardLogDirResolved, `${base}.log`);
      const iso = new Date().toISOString();
      const kind = extra.kind || 'copy';
      const header = `\n### ${iso} window=${windowId} kind=${kind} len=${raw.length} ###\n`;
      fs.appendFileSync(file, `${header}${chunk}\n`, 'utf8');
    } catch (e) {
      console.error(`[${agentId}] clipboard log:`, e?.message ?? e);
    }
  }

  /** @type {Record<string, { browser: import('puppeteer-core').Browser | null, page: import('puppeteer-core').Page | null, suppressTabBroadcastUntil?: number, lastPointer?: { x: number, y: number }, _connectLoopPromise?: Promise<void> | null, lastGoodViewport?: { width: number, height: number } | null, viewportCache?: { width: number, height: number, at: number } | null, _tabPickCache?: { href: string, page: import('puppeteer-core').Page, at: number } | null, _targetsListCache?: { at: number, list: import('puppeteer-core').Target[] } | null, _lastMouseMoveAt?: number }>} */
  const sessions = {};
  for (const pid of profileIds) {
    sessions[pid] = {
      browser: null,
      page: null,
      suppressTabBroadcastUntil: 0,
      lastPointer: { x: 0.5, y: 0.5 },
      /** Последние валидные размеры — когда окно свернуто/в фоне innerWidth может быть 0 */
      lastGoodViewport: null,
      viewportCache: null,
      /** Кэш выбора вкладки по href — не парсить targets на каждое событие мыши */
      _tabPickCache: null,
      /** Кэш browser.targets() для pickPage — много вкладок без лагов */
      _targetsListCache: null,
      _lastMouseMoveAt: 0,
      /** Один фоновый connectProfileLoop на профиль — не дублировать при старте + ensure одновременно */
      _connectLoopPromise: null
    };
  }

  let ws = null;
  let wsReconnectAttempt = 0;
  let wsReconnectTimer = null;
  let wsIntentionalClose = false;

  function sendAgentForwardedEvent(payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: 'agentForward', payload }));
    } catch {
      /* ignore */
    }
  }

  /** Новая вкладка «+» вручную в окне Dolphin → остальным агентам (не дублируем свои же newPage) */
  function installTabBroadcastForBrowser(browser, profileId) {
    browser.on('targetcreated', async (target) => {
      try {
        if (target.type() !== 'page') return;
        const s = sessions[profileId];
        if (!s?.browser) return;
        if (Date.now() < (s.suppressTabBroadcastUntil || 0)) return;
        await sleep(50);
        if (Date.now() < (s.suppressTabBroadcastUntil || 0)) return;
        sendAgentForwardedEvent({
          eventType: 'tabs',
          kind: 'new',
          ts: Date.now(),
          sourceProfileId: profileId,
          href: ''
        });
      } catch (e) {
        console.warn(`[${agentId}] tab forward:`, e?.message ?? e);
      }
    });
  }

  async function hookPageClipboardReporting(page, profileId) {
    try {
      await page.exposeFunction('__dolphinSyncReportClipboard', (payload) => {
        const text = String(payload?.text ?? '');
        const kind = String(payload?.kind ?? 'copy-dom');
        if (!text) return;
        clipboardByProfile[profileId] = text;
        appendClipboardLog(profileId, text, { kind });
      });
    } catch (e) {
      if (isBenignBrowserClosedError(e)) return;
      if (!/already been registered|already exists/i.test(String(e?.message || e))) {
        console.warn(`[${agentId}] expose clipboard hook:`, e?.message ?? e);
      }
    }

    const installInPage = () => {
      if (window.__dolphinSyncClipHookV2) return;
      window.__dolphinSyncClipHookV2 = true;
      try {
        function readCopyText(e) {
          let t = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
          if (!t) {
            const ae = document.activeElement;
            if (ae && (ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement)) {
              const v = ae.value;
              const s = typeof ae.selectionStart === 'number' ? ae.selectionStart : 0;
              const e2 = typeof ae.selectionEnd === 'number' ? ae.selectionEnd : 0;
              if (e2 > s) t = v.slice(s, e2);
            }
          }
          if (!t && window.getSelection) t = window.getSelection().toString() || '';
          return t;
        }
        document.addEventListener(
          'copy',
          (e) => {
            const t = readCopyText(e);
            if (t && window.__dolphinSyncReportClipboard) {
              void window.__dolphinSyncReportClipboard({ kind: 'copy-dom', text: String(t) });
            }
          },
          true
        );
        document.addEventListener(
          'cut',
          (e) => {
            const t = readCopyText(e);
            if (t && window.__dolphinSyncReportClipboard) {
              void window.__dolphinSyncReportClipboard({ kind: 'cut-dom', text: String(t) });
            }
          },
          true
        );
      } catch {
        /* ignore */
      }
    };

    try {
      await page.evaluateOnNewDocument(installInPage);
    } catch (e) {
      if (!isBenignBrowserClosedError(e)) {
        console.warn(`[${agentId}] evaluateOnNewDocument clipboard:`, e?.message ?? e);
      }
    }
    try {
      await page.evaluate(installInPage);
    } catch {
      /* ignore */
    }
  }

  async function installClipboardHooksForBrowser(browser, profileId) {
    const hook = async (p) => {
      try {
        if (p?.isClosed?.()) return;
        await hookPageClipboardReporting(p, profileId);
      } catch (e) {
        if (isBenignBrowserClosedError(e)) return;
        console.warn(`[${agentId}] hookPageClipboard ${profileId}:`, e?.message ?? e);
      }
    };

    try {
      for (const p of await browser.pages()) await hook(p);
    } catch {
      /* ignore */
    }

    browser.on('targetcreated', async (target) => {
      try {
        if (target.type() !== 'page') return;
        await sleep(120);
        const p = await target.page();
        if (!p || p.isClosed?.()) return;
        await hook(p);
      } catch (e) {
        if (!isBenignBrowserClosedError(e)) {
          console.warn(`[${agentId}] clipboard targetcreated:`, e?.message ?? e);
        }
      }
    });
  }

  async function applyVirtualCopy(page, profileId) {
    const ses = sessions[profileId];
    let text = '';
    try {
      const { width, height } = await getViewport(page, profileId);
      const lx = clamp01(ses?.lastPointer?.x ?? 0.5);
      const ly = clamp01(ses?.lastPointer?.y ?? 0.5);
      const cx = Math.round(lx * width);
      const cy = Math.round(ly * height);
      await page.mouse.move(cx, cy).catch(() => {});
      text = await page.evaluate(({ px, py }) => {
        try {
          const hit = document.elementFromPoint(px, py);
          if (hit && typeof hit.focus === 'function') hit.focus();
        } catch {
          /* ignore */
        }
        const ae = document.activeElement;
        if (ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement) {
          const v = ae.value;
          const s = typeof ae.selectionStart === 'number' ? ae.selectionStart : 0;
          const e = typeof ae.selectionEnd === 'number' ? ae.selectionEnd : 0;
          if (e > s) return v.slice(s, e);
        }
        if (ae && ae.isContentEditable) {
          const sel = window.getSelection();
          const str = sel ? sel.toString() : '';
          if (str) return str;
        }
        try {
          const sel = window.getSelection();
          return sel ? sel.toString() : '';
        } catch {
          return '';
        }
      }, { px: cx, py: cy });
    } catch {
      return;
    }
    clipboardByProfile[profileId] = text;
    if (text) appendClipboardLog(profileId, text, { kind: 'copy-shortcut' });
  }

  async function applyVirtualCut(page, profileId) {
    const ses = sessions[profileId];
    let text = '';
    try {
      const { width, height } = await getViewport(page, profileId);
      const lx = clamp01(ses?.lastPointer?.x ?? 0.5);
      const ly = clamp01(ses?.lastPointer?.y ?? 0.5);
      const cx = Math.round(lx * width);
      const cy = Math.round(ly * height);
      await page.mouse.move(cx, cy).catch(() => {});
      text = await page.evaluate(({ px, py }) => {
        try {
          const hit = document.elementFromPoint(px, py);
          if (hit && typeof hit.focus === 'function') hit.focus();
        } catch {
          /* ignore */
        }
        const ae = document.activeElement;
        if (ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement) {
          const s = typeof ae.selectionStart === 'number' ? ae.selectionStart : 0;
          const e = typeof ae.selectionEnd === 'number' ? ae.selectionEnd : 0;
          if (e > s) {
            const t = ae.value.slice(s, e);
            ae.value = ae.value.slice(0, s) + ae.value.slice(e);
            ae.selectionStart = ae.selectionEnd = s;
            ae.dispatchEvent(new Event('input', { bubbles: true }));
            ae.dispatchEvent(new Event('change', { bubbles: true }));
            return t;
          }
        }
        const sel = window.getSelection();
        const t = sel ? sel.toString() : '';
        if (sel && sel.rangeCount) {
          try {
            sel.deleteFromDocument();
          } catch {
            /* ignore */
          }
        }
        return t || '';
      }, { px: cx, py: cy });
    } catch {
      return;
    }
    clipboardByProfile[profileId] = text;
    if (text) appendClipboardLog(profileId, text, { kind: 'cut-shortcut' });
  }

  async function applyVirtualPaste(page, profileId) {
    const text = clipboardByProfile[profileId] ?? '';
    try {
      await page.evaluate((ins) => {
        const payload = String(ins ?? '');
        const el = document.activeElement;
        if (!el) return;
        if (el.isContentEditable) {
          document.execCommand('insertText', false, payload);
          return;
        }
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          const ta = el;
          const start = typeof ta.selectionStart === 'number' ? ta.selectionStart : ta.value.length;
          const end = typeof ta.selectionEnd === 'number' ? ta.selectionEnd : ta.value.length;
          ta.focus();
          ta.value = ta.value.slice(0, start) + payload + ta.value.slice(end);
          ta.selectionStart = ta.selectionEnd = start + payload.length;
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          ta.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, text);
    } catch {
      /* ignore */
    }
  }

  function isChordMod(ev) {
    return !!(ev.ctrl || ev.meta) && !ev.alt;
  }

  function isCopyChord(ev) {
    return isChordMod(ev) && !ev.shift && String(keyFromSyncEvent(ev) || '').toLowerCase() === 'c';
  }

  function isCutChord(ev) {
    return isChordMod(ev) && !ev.shift && String(keyFromSyncEvent(ev) || '').toLowerCase() === 'x';
  }

  function isPasteChord(ev) {
    return isChordMod(ev) && !ev.shift && String(keyFromSyncEvent(ev) || '').toLowerCase() === 'v';
  }

  async function applyKeyWithVirtualClipboard(ev, page, profileId) {
    if (syncCfg.virtualClipboard) {
      if (ev.kind === 'down') {
        if (isCopyChord(ev)) {
          await applyVirtualCopy(page, profileId);
          return;
        }
        if (isCutChord(ev)) {
          await applyVirtualCut(page, profileId);
          return;
        }
        if (isPasteChord(ev)) {
          await applyVirtualPaste(page, profileId);
          return;
        }
      }
      if (ev.kind === 'up' && (isCopyChord(ev) || isCutChord(ev) || isPasteChord(ev))) return;
    } else if (
      !syncCfg.replicatePaste &&
      (isPasteChord(ev) || (isChordMod(ev) && String(keyFromSyncEvent(ev) || '').toLowerCase() === 'v'))
    ) {
      return;
    }

    await applyKey(ev, page);
  }

  async function connectProfileLoop(profileId) {
    const s = sessions[profileId];
    if (s._connectLoopPromise) return s._connectLoopPromise;

    s._connectLoopPromise = (async () => {
      while (true) {
        try {
          await dolphinLoginCached(dolphinBaseUrl, dolphinToken);
        /** Сначала CDP без /start (быстрый poll); /start через очередь; DUPLICATE → парсинг тела + poll, stop только в крайнем случае. */
        const maxDuplicateAttempts = 10;
        let automation;
        const tryQuick = await dolphinPollAutomation(dolphinBaseUrl, profileId);
        if (tryQuick) {
          automation = tryQuick;
        } else {
          for (let dupAttempt = 0; dupAttempt < maxDuplicateAttempts; dupAttempt++) {
            try {
              automation = await runDolphinStart(() =>
                dolphinStartProfile(dolphinBaseUrl, profileId, dolphinStartTimeoutMs)
              );
              break;
            } catch (e) {
              const fromErr = dolphinAutomationFromAxiosError(e);
              if (fromErr) {
                automation = fromErr;
                break;
              }
              const code = extractDolphinErrorCode(e);
              if (code === 'E_BROWSER_RUN_DUPLICATE' && dupAttempt < maxDuplicateAttempts - 1) {
                /** Дольше poll + /running — часто CDP без stop; при AGENT_VERBOSE_DOLPHIN логируем перед stop */
                const attach = await dolphinPollAutomationBeforeStop(dolphinBaseUrl, profileId);
                if (attach) {
                  automation = attach;
                  break;
                }
                if (process.env.AGENT_VERBOSE_DOLPHIN) {
                  console.log(
                    `[${agentId}] profile ${profileId} DUPLICATE → stop+retry ${dupAttempt + 1}/${maxDuplicateAttempts}`
                  );
                }
                try {
                  await runDolphinStop(() =>
                    dolphinStopProfileWithRetries(
                      dolphinBaseUrl,
                      profileId,
                      dolphinStopTimeoutMs,
                      dolphinStopRetries
                    )
                  );
                } catch (stopErr) {
                  console.warn(`[${agentId}] profile ${profileId} stop:`, formatDolphinConnectError(stopErr));
                }
                await sleep(350 + dupAttempt * 200);
                continue;
              }
              throw e;
            }
          }
        }
        if (!automation) throw new Error(`[${agentId}] profile ${profileId}: start failed after duplicate retries`);
        const { port, wsEndpoint } = automation;
        const browser = await connectCdp({ port, wsEndpoint });
        s.browser = browser;
        browser.on('disconnected', () => {
          s.browser = null;
          s.page = null;
          s._tabPickCache = null;
          s._targetsListCache = null;
          s._connectLoopPromise = null;
        });
        {
          const hookedPages = new WeakSet();
          const hookViewportInvalidate = (p) => {
            if (!p || hookedPages.has(p)) return;
            hookedPages.add(p);
            p.on('framenavigated', () => {
              const sess = sessions[profileId];
              if (sess) {
                sess.viewportCache = null;
                sess._tabPickCache = null;
                sess._targetsListCache = null;
              }
            });
          };
          browser.on('targetcreated', async (target) => {
            try {
              invalidateTabPickCache(sessions[profileId]);
              if (target.type() !== 'page') return;
              const p = await target.page();
              hookViewportInvalidate(p);
            } catch {
              /* ignore */
            }
          });
          browser.on('targetdestroyed', (target) => {
            if (target.type() !== 'page') return;
            invalidateTabPickCache(sessions[profileId]);
          });
          try {
            for (const p of await browser.pages()) hookViewportInvalidate(p);
          } catch {
            /* ignore */
          }
        }
        let usedExistingOpenTab = false;
        const urlMatchForOpen = cfg.sync?.urlMatchMode || 'hostpath';
        if (openOnConnectUrl && (openOnConnectMode === 'preferExisting' || openOnConnectMode === 'onlyExisting')) {
          let ex = await pickExistingPageForOpenOnConnect(
            browser,
            openOnConnectUrl,
            preferUrlIncludes,
            urlMatchForOpen
          );
          if (!ex) {
            ex = await pickExistingPageFromOpenPages(
              browser,
              openOnConnectUrl,
              preferUrlIncludes,
              urlMatchForOpen
            );
          }
          if (ex) {
            s.page = ex;
            usedExistingOpenTab = true;
            if (forceViewport?.enabled) {
              await s.page.setViewport({ width: forceViewport.width, height: forceViewport.height }).catch(() => {});
            }
            await maybeBringPageToFront(s.page);
            try {
              console.log(`[${agentId}] profile ${profileId} → уже открытая вкладка: ${s.page.url()}`);
            } catch {
              console.log(`[${agentId}] profile ${profileId} → уже открытая вкладка`);
            }
          }
        }
        if (!s.page) {
          if (openOnConnectMode === 'onlyExisting') {
            s.page = await ensurePageNoNew(browser, preferUrlIncludes, forceViewport);
            if (!s.page) {
              try {
                s.page = await browser.newPage();
                console.warn(
                  `[${agentId}] profile ${profileId} → нет открытых вкладок, создана новая (только для пустого браузера)`
                );
              } catch {
                /* ignore */
              }
            }
          } else {
            s.page = await ensurePage(browser, preferUrlIncludes, forceViewport);
          }
        }
        if (
          openOnConnectUrl &&
          !usedExistingOpenTab &&
          openOnConnectMode !== 'never' &&
          openOnConnectMode !== 'onlyExisting'
        ) {
          try {
            await s.page.goto(openOnConnectUrl, {
              waitUntil: openOnConnectWaitUntil,
              timeout: openOnConnectTimeout
            });
            await maybeBringPageToFront(s.page);
            console.log(`[${agentId}] profile ${profileId} → ${openOnConnectUrl}`);
          } catch (e) {
            console.error(`[${agentId}] profile ${profileId} openOnConnectUrl failed:`, e?.message ?? e);
          }
        } else if (openOnConnectUrl && openOnConnectMode === 'never') {
          try {
            console.log(`[${agentId}] profile ${profileId} → openOnConnectUrl пропущен (mode=never): ${s.page.url()}`);
          } catch {
            console.log(`[${agentId}] profile ${profileId} → openOnConnectUrl пропущен (mode=never)`);
          }
        } else if (openOnConnectUrl && openOnConnectMode === 'onlyExisting' && !usedExistingOpenTab) {
          try {
            console.log(
              `[${agentId}] profile ${profileId} → onlyExisting: совпадения с openOnConnectUrl нет, goto не делаем — ${s.page?.url?.() ?? '?'}`
            );
          } catch {
            console.log(`[${agentId}] profile ${profileId} → onlyExisting: goto не делаем`);
          }
        }
        if (syncCfg.virtualClipboard || syncCfg.clipboardLogToFile) {
          await installClipboardHooksForBrowser(browser, profileId);
        }
        installTabBroadcastForBrowser(browser, profileId);
        console.log(`[${agentId}] profile ${profileId} connected`);
        flushPendingIfReady();
        return;
      } catch (e) {
        console.error(`[${agentId}] profile ${profileId} connect failed:`, formatDolphinConnectError(e));
        if (isDolphinRateLimitError(e)) {
          console.log(`[${agentId}] Dolphin API rate limit, backing off...`);
          dolphinLoginExpiresAt = 0;
        } else if (isDolphinProfileDataFileError(e)) {
          console.log(
            `[${agentId}] файлы профиля заняты (EBUSY/lock). Закройте окно этого профиля в Dolphin, подождите несколько секунд — не параллельте запуск с тем же профилем`
          );
        } else if (isDolphinOverloadError(e)) {
          console.log(`[${agentId}] Dolphin API overload (HTTP 5xx), backing off — не запускайте слишком много профилей одновременно`);
        }
        await sleep(connectBackoffMs(e));
      }
    }
    })();

    return s._connectLoopPromise;
  }

  const VIEWPORT_CACHE_MS = 350;

  /** Одна CDP-сессия на страницу — мышь/колесо без лишних attach/detach на каждое событие */
  const pageCdpSessions = new WeakMap();

  async function getPageCdpSession(page) {
    if (!page) throw new Error('getPageCdpSession: no page');
    let s = pageCdpSessions.get(page);
    if (s) return s;
    s = await page.target().createCDPSession();
    await s.send('Input.enable').catch(() => {});
    pageCdpSessions.set(page, s);
    page.once('close', () => {
      pageCdpSessions.delete(page);
      s.detach().catch(() => {});
    });
    return s;
  }

  /**
   * Размер области страницы для нормализованных координат.
   * В свёрнутом/фоновом окне window.innerWidth/innerHeight часто 0 — тогда клики «уезжают»;
   * Page.getLayoutMetrics даёт стабильные clientWidth/Height без подстановки 1280×720.
   */
  async function getViewport(page, profileId) {
    if (!page) return { width: 1280, height: 720 };
    const session = profileId ? sessions[profileId] : null;
    const now = Date.now();
    if (session?.viewportCache && now - session.viewportCache.at < VIEWPORT_CACHE_MS) {
      const { width: cw, height: ch } = session.viewportCache;
      if (cw >= 100 && ch >= 100) return { width: cw, height: ch };
    }

    const remember = (width, height) => {
      const out = { width, height };
      if (session && width >= 100 && height >= 100) {
        session.lastGoodViewport = out;
        session.viewportCache = { width, height, at: Date.now() };
      }
      return out;
    };

    const fallback = () => {
      if (session?.lastGoodViewport?.width >= 100 && session?.lastGoodViewport?.height >= 100) {
        return { ...session.lastGoodViewport };
      }
      return { width: 1280, height: 720 };
    };

    try {
      const client = await page.target().createCDPSession();
      const lm = await client.send('Page.getLayoutMetrics');
      await client.detach().catch(() => {});
      const lv = lm.layoutViewport;
      const cw = Math.round(Number(lv?.clientWidth) || 0);
      const ch = Math.round(Number(lv?.clientHeight) || 0);
      if (cw >= 100 && ch >= 100) return remember(cw, ch);
    } catch {
      /* next */
    }

    try {
      const v = page?.viewport?.();
      if (v?.width && v?.height && v.width >= 100 && v.height >= 100) {
        return remember(v.width, v.height);
      }
    } catch {
      /* next */
    }

    try {
      const dim = await page.evaluate(() => {
        const vv = window.visualViewport;
        const w =
          (vv && vv.width) ||
          window.innerWidth ||
          document.documentElement?.clientWidth ||
          0;
        const h =
          (vv && vv.height) ||
          window.innerHeight ||
          document.documentElement?.clientHeight ||
          0;
        return { w, h };
      });
      const w = Math.max(dim.w || 0, 1);
      const h = Math.max(dim.h || 0, 1);
      if (w >= 100 && h >= 100) return remember(w, h);
    } catch {
      /* next */
    }

    return fallback();
  }

  function invalidateTabPickCache(s) {
    if (s) {
      s._tabPickCache = null;
      s._targetsListCache = null;
    }
  }

  /** Быстрее, чем browser.pages(): список вкладок без лишних обёрток Page. */
  function listPageTargets(browser) {
    try {
      return browser.targets().filter((t) => t.type() === 'page');
    } catch {
      return [];
    }
  }

  /** Короткий кэш списка targets — при 20+ вкладках не дергать CDP на каждый move. */
  function listPageTargetsCached(browser, s) {
    const ttl = syncCfg.targetsListCacheMs;
    if (ttl === 0) return listPageTargets(browser);
    const c = s._targetsListCache;
    if (c?.list && Date.now() - c.at < ttl) return c.list;
    const list = listPageTargets(browser);
    s._targetsListCache = { at: Date.now(), list };
    return list;
  }

  function getTargetUrlString(t) {
    try {
      return String(t.url() || '');
    } catch {
      return '';
    }
  }

  async function targetToPage(t) {
    try {
      const p = await t.page();
      if (p && !p.isClosed?.()) return p;
    } catch {
      /* ignore */
    }
    return null;
  }

  /**
   * Вкладка с тем же URL, что у главного (ev.href).
   * Быстро: кэш по href (не сканировать вкладки на каждый mousemove) + targets() + один target.page().
   */
  async function pickPageForBrowserEvent(s, evHref) {
    const browser = s.browser;
    if (!browser) return null;
    const href = String(evHref ?? '').trim();
    const mode = syncCfg.urlMatchMode;
    const cacheMs = syncCfg.tabPickCacheMs;

    if (cacheMs > 0 && s._tabPickCache && s._tabPickCache.href === href) {
      const age = Date.now() - s._tabPickCache.at;
      if (age >= 0 && age < cacheMs) {
        const p = s._tabPickCache.page;
        try {
          if (p && !p.isClosed?.()) {
            const u = p.url();
            if (!href || urlsStrictEqual(u, href) || urlsMatch(u, href, mode)) {
              s.page = p;
              return p;
            }
          }
        } catch {
          invalidateTabPickCache(s);
        }
      }
    }

    const targets = listPageTargetsCached(browser, s);
    if (!targets.length) {
      /** Если targets() пуст (редко, но бывает), но вкладки есть — берём первую непустую через pages(). */
      try {
        const pages = await browser.pages();
        if (pages.length) {
          const p =
            pages.find((x) => {
              try {
                return !isBlankPageUrl(x.url());
              } catch {
                return false;
              }
            }) || pages[0];
          if (p && !p.isClosed?.()) {
            s.page = p;
            if (cacheMs > 0) s._tabPickCache = { href, page: p, at: Date.now() };
            return p;
          }
        }
      } catch {
        /* ignore */
      }
      return s.page && !s.page.isClosed?.() ? s.page : null;
    }

    const preferStickyTarget = (list) => {
      if (!list.length) return null;
      let st = null;
      try {
        st = s.page?.target?.() ?? null;
      } catch {
        st = null;
      }
      if (st && list.some((x) => x === st)) return st;
      return list[0];
    };

    if (href) {
      const exact = [];
      const fuzzy = [];
      for (const t of targets) {
        const u = getTargetUrlString(t);
        if (!u) continue;
        if (urlsStrictEqual(u, href)) exact.push(t);
        else if (urlsMatch(u, href, mode)) fuzzy.push(t);
      }
      const chosenT = preferStickyTarget(exact) || preferStickyTarget(fuzzy);
      if (chosenT) {
        const page = await targetToPage(chosenT);
        if (page) {
          s.page = page;
          if (cacheMs > 0) s._tabPickCache = { href, page, at: Date.now() };
          return page;
        }
      }
    }

    if (s.page) {
      try {
        if (s.page.isClosed?.()) {
          s.page = null;
        } else {
          let u = '';
          try {
            u = s.page.url();
          } catch {
            s.page = null;
          }
          if (s.page && (!href || urlsMatch(u, href, mode))) {
            if (cacheMs > 0) s._tabPickCache = { href, page: s.page, at: Date.now() };
            return s.page;
          }
        }
      } catch {
        s.page = null;
      }
    }

    if (preferUrlIncludes) {
      for (const t of targets) {
        try {
          const u = getTargetUrlString(t);
          if (u.includes(preferUrlIncludes)) {
            const page = await targetToPage(t);
            if (page) {
              s.page = page;
              if (cacheMs > 0) s._tabPickCache = { href, page, at: Date.now() };
              return page;
            }
          }
        } catch {
          continue;
        }
      }
    }

    if (s.page) {
      try {
        if (!s.page.isClosed?.()) {
          if (cacheMs > 0) s._tabPickCache = { href, page: s.page, at: Date.now() };
          return s.page;
        }
      } catch {
        s.page = null;
      }
    }

    const lastT = targets[targets.length - 1];
    const last = lastT ? await targetToPage(lastT) : null;
    if (last) {
      s.page = last;
      if (cacheMs > 0) s._tabPickCache = { href, page: last, at: Date.now() };
    }
    return last;
  }

  function mouseButtonFromEv(ev) {
    return ev.button === 2 ? 'right' : ev.button === 1 ? 'middle' : 'left';
  }

  /** Puppeteer хранит состояние кнопок; после навигации/потери фокуса бывает «left is not pressed» / «already pressed» */
  async function mouseDownSafe(page, button) {
    try {
      await page.mouse.down({ button });
    } catch (e) {
      const m = String(e?.message ?? e);
      if (/already pressed/i.test(m)) {
        await page.mouse.up({ button }).catch(() => {});
        await page.mouse.down({ button });
      } else {
        throw e;
      }
    }
  }

  async function mouseUpSafe(page, button) {
    try {
      await page.mouse.up({ button });
    } catch (e) {
      const m = String(e?.message ?? e);
      if (/not pressed/i.test(m)) {
        await page.mouse.down({ button }).catch(() => {});
        await page.mouse.up({ button });
      } else {
        throw e;
      }
    }
  }

  /** Омнибар Chrome не в DOM страницы — через CDP шлём стандартное сочетание «фокус строки URL». */
  async function applyFocusAddressBar(page) {
    try {
      if (syncCfg.focusAddressBarForcesBringToFront) {
        await page.bringToFront().catch(() => {});
      } else {
        await maybeBringPageToFront(page);
      }
      const isMac = process.platform === 'darwin';
      if (isMac) {
        await page.keyboard.down('Meta');
        await page.keyboard.press('KeyL');
        await page.keyboard.up('Meta');
      } else {
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyL');
        await page.keyboard.up('Control');
      }
    } catch (e) {
      const m = String(e?.message ?? e);
      if (/detached|context was destroyed|Navigation|Execution context/i.test(m)) return;
      throw e;
    }
  }

  async function applyMouseCdp(ev, page, profileId) {
    if (profileId && sessions[profileId] && typeof ev.x === 'number' && typeof ev.y === 'number') {
      sessions[profileId].lastPointer = { x: ev.x, y: ev.y };
    }
    const { width, height } = await getViewport(page, profileId);
    const x = Math.round(clamp01(ev.x) * width);
    const y = Math.round(clamp01(ev.y) * height);
    const btn = mouseButtonFromEv(ev);
    const btnStr = btn === 'right' ? 'right' : btn === 'middle' ? 'middle' : 'left';
    const buttonsBits = typeof ev.buttons === 'number' ? ev.buttons : 0;
    const client = await getPageCdpSession(page);

    if (ev.kind === 'move') {
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x,
        y,
        button: 'none',
        buttons: buttonsBits,
        pointerType: 'mouse'
      });
      return;
    }
    if (ev.kind === 'down') {
      if (syncCfg.translateTopStripClickToAddressBarHotkey && btn === 'left') {
        const nx = clamp01(ev.x);
        const ny = clamp01(ev.y);
        const xLo = Math.min(syncCfg.topStripAddressBarZoneXMin, syncCfg.topStripAddressBarZoneXMax);
        const xHi = Math.max(syncCfg.topStripAddressBarZoneXMin, syncCfg.topStripAddressBarZoneXMax);
        if (ny <= syncCfg.topStripAddressBarZoneMaxY && nx >= xLo && nx <= xHi) {
          await applyFocusAddressBar(page);
          return;
        }
      }
      await client.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: btnStr,
        buttons: buttonsBits,
        clickCount: 1,
        pointerType: 'mouse'
      });
      return;
    }
    if (ev.kind === 'up') {
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: btnStr,
        buttons: buttonsBits,
        clickCount: 1,
        pointerType: 'mouse'
      });
    }
  }

  async function applyMouse(ev, page, profileId) {
    const useCdp = syncCfg.mouseDispatchMode === 'cdp';
    if (useCdp) {
      try {
        await applyMouseCdp(ev, page, profileId);
      } catch (e) {
        if (isBenignBrowserClosedError(e)) return;
        const m = String(e?.message ?? e);
        if (/detached|context was destroyed|Navigation|Execution context/i.test(m)) return;
        throw e;
      }
      return;
    }

    if (profileId && sessions[profileId] && typeof ev.x === 'number' && typeof ev.y === 'number') {
      sessions[profileId].lastPointer = { x: ev.x, y: ev.y };
    }
    try {
      const { width, height } = await getViewport(page, profileId);
      const x = clamp01(ev.x) * width;
      const y = clamp01(ev.y) * height;
      const btn = mouseButtonFromEv(ev);

      if (ev.kind === 'move') {
        await page.mouse.move(x, y);
        return;
      }
      if (ev.kind === 'down') {
        if (syncCfg.translateTopStripClickToAddressBarHotkey && btn === 'left') {
          const nx = clamp01(ev.x);
          const ny = clamp01(ev.y);
          const xLo = Math.min(syncCfg.topStripAddressBarZoneXMin, syncCfg.topStripAddressBarZoneXMax);
          const xHi = Math.max(syncCfg.topStripAddressBarZoneXMin, syncCfg.topStripAddressBarZoneXMax);
          if (ny <= syncCfg.topStripAddressBarZoneMaxY && nx >= xLo && nx <= xHi) {
            await applyFocusAddressBar(page);
            return;
          }
        }
        await maybeBringPageToFront(page);
        await page.mouse.move(x, y);
        await mouseDownSafe(page, btn);
        return;
      }
      if (ev.kind === 'up') {
        await page.mouse.move(x, y);
        await mouseUpSafe(page, btn);
      }
    } catch (e) {
      if (isBenignBrowserClosedError(e)) return;
      const m = String(e?.message ?? e);
      if (/detached|context was destroyed|Navigation|Execution context/i.test(m)) return;
      if (/already pressed|not pressed/i.test(m)) return;
      throw e;
    }
  }

  async function applyWheel(ev, page, profileId) {
    if (profileId && sessions[profileId] && typeof ev.x === 'number' && typeof ev.y === 'number') {
      sessions[profileId].lastPointer = { x: ev.x, y: ev.y };
    }
    try {
      const { width, height } = await getViewport(page, profileId);
      const x = clamp01(ev.x) * width;
      const y = clamp01(ev.y) * height;
      const client = await getPageCdpSession(page);
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x,
        y,
        deltaX: ev.dx ?? 0,
        deltaY: ev.dy ?? 0
      });
    } catch (e) {
      if (isBenignBrowserClosedError(e)) return;
      const m = String(e?.message ?? e);
      if (/detached|context was destroyed|Navigation|Execution context/i.test(m)) return;
      throw e;
    }
  }

  async function applyKey(ev, page) {
    const k = keyFromSyncEvent(ev);
    if (!k) return;
    try {
      if (ev.kind === 'down') await page.keyboard.down(k);
      if (ev.kind === 'up') await page.keyboard.up(k);
    } catch (e) {
      const m = String(e?.message ?? e);
      if (/detached|context was destroyed|Unknown key/i.test(m)) return;
      throw e;
    }
  }

  async function applyInput(ev, page) {
    if (!ev.selector) return;
    await page.evaluate(({ selector, value }) => {
      const el = document.querySelector(selector);
      if (!el) return;
      if ('value' in el) {
        el.focus();
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, { selector: ev.selector, value: String(ev.value ?? '') });
  }

  async function applyTabSelect(ev, s) {
    const browser = s.browser;
    if (!browser) return;
    const mode = syncCfg.urlMatchMode;
    const targetUrl = String(ev.url ?? '').trim();
    if (!targetUrl) return;

    /**
     * Переключение вкладки с главного — всегда выполняем (без strictUrlMatch).
     * Список вкладок через targets() — быстрее, чем полный pages().
     */

    const isNewTabUrl = (u) =>
      /^chrome:\/\/new/i.test(u) || u === 'about:blank' || u === '';
    if (isNewTabUrl(targetUrl)) {
      for (const t of listPageTargetsCached(browser, s)) {
        const u = getTargetUrlString(t);
        if (isNewTabUrl(u)) {
          const pickEmpty = await targetToPage(t);
          if (pickEmpty) {
            s.page = pickEmpty;
            invalidateTabPickCache(s);
            await maybeBringPageToFront(pickEmpty);
            return;
          }
        }
      }
      s.suppressTabBroadcastUntil = Date.now() + 2000;
      const p = await browser.newPage();
      s.page = p;
      invalidateTabPickCache(s);
      await maybeBringPageToFront(p);
      return;
    }

    for (const t of listPageTargetsCached(browser, s)) {
      const u = getTargetUrlString(t);
      if (urlsMatch(u, targetUrl, mode) || u === targetUrl) {
        const p = await targetToPage(t);
        if (p) {
          s.page = p;
          invalidateTabPickCache(s);
          await maybeBringPageToFront(p);
          return;
        }
      }
    }

    s.suppressTabBroadcastUntil = Date.now() + 2000;
    const p = await browser.newPage();
    s.page = p;
    invalidateTabPickCache(s);
    const internalNew =
      /^chrome:\/\/new/i.test(targetUrl) ||
      targetUrl === 'about:blank';
    if (!internalNew) {
      await p.goto(targetUrl, {
        waitUntil: syncCfg.navigateWaitUntil,
        timeout: syncCfg.navigateTimeoutMs
      }).catch(() => {});
    }
    await maybeBringPageToFront(p);
  }

  async function applyNavigate(ev, s) {
    const browser = s.browser;
    if (!browser) return;
    const mode = syncCfg.urlMatchMode;
    const strict = syncCfg.strictUrlMatch;
    const waitNav = syncCfg.navigateWaitUntil;
    const timeoutMs = syncCfg.navigateTimeoutMs;

    if (ev.kind === 'tab-select') {
      await applyTabSelect(ev, s);
      return;
    }

    /** Кнопки «Назад»/«Вперёд» браузера — без strict, чтобы все профили повторили историю */
    if (ev.kind === 'history') {
      const page = s.page;
      if (!page) return;
      const dir = ev.direction === 'forward' ? 'forward' : 'back';
      if (dir === 'forward') {
        await page.goForward({ waitUntil: waitNav, timeout: timeoutMs }).catch(() => {});
      } else {
        await page.goBack({ waitUntil: waitNav, timeout: timeoutMs }).catch(() => {});
      }
      return;
    }

    if (ev.kind === 'back') {
      if (!s.page) return;
      await s.page.goBack({ waitUntil: waitNav, timeout: timeoutMs }).catch(() => {});
      return;
    }
    if (ev.kind === 'forward') {
      if (!s.page) return;
      await s.page.goForward({ waitUntil: waitNav, timeout: timeoutMs }).catch(() => {});
      return;
    }

    const page = s.page;
    if (!page) return;

    let agentUrl = '';
    try {
      agentUrl = page.url();
    } catch {
      return;
    }

    /**
     * strictUrlMatch сверяет «откуда» ушёл главный (fromHref) с текущим URL агента.
     * Если fromHref нет (первый переход, кэш вкладки пуст) — раньше мы делали `return` и
     * навигация на агентах **никогда** не выполнялась → рассинхрон и мышь «в пустоту».
     */
    if (strict) {
      const refRaw = ev.fromHref != null ? String(ev.fromHref).trim() : '';
      if (refRaw) {
        if (!urlsMatch(agentUrl, refRaw, mode)) return;
      }
    }

    const url = String(ev.url ?? ev.href ?? '').trim();
    if (!url) return;

    await page.goto(url, { waitUntil: waitNav, timeout: timeoutMs }).catch(() => {});
  }

  function sessionLooksConnected(s) {
    if (!s?.browser) return false;
    try {
      if (typeof s.browser.isConnected === 'function' && !s.browser.isConnected()) return false;
    } catch {
      return false;
    }
    if (!s.page) return false;
    try {
      if (s.page.isClosed?.()) return false;
    } catch {
      return false;
    }
    return true;
  }

  /**
   * Не ждём все профили — иначе пока один в retry (EBUSY / stop), синхронизация для всех стоит.
   * Подключение в фоне; события применяются к уже готовым профилям.
   */
  async function ensureAllConnected() {
    for (const pid of profileIds) {
      const s = sessions[pid];
      if (sessionLooksConnected(s)) continue;
      void connectProfileLoop(pid).catch((e) => {
        console.error(`[${agentId}] profile ${pid} connect (fatal):`, e?.message ?? e);
      });
    }
  }

  /** Пока ни один профиль не подключён — события с главного буферизуем (клики не теряются при старте). */
  const pendingEventMessages = [];
  const MAX_PENDING_EVENTS = 100;
  let pendingFlushTimer = null;

  function hasAnyBrowserConnected() {
    return profileIds.some((pid) => sessions[pid]?.browser);
  }

  function schedulePendingFlush() {
    if (pendingFlushTimer) return;
    pendingFlushTimer = setTimeout(() => {
      pendingFlushTimer = null;
      flushPendingIfReady();
    }, 120);
  }

  function flushPendingIfReady() {
    if (!pendingEventMessages.length) return;
    if (!hasAnyBrowserConnected()) {
      schedulePendingFlush();
      return;
    }
    const batch = pendingEventMessages.splice(0);
    for (const m of batch) {
      void applyIncomingEvent(m);
    }
  }

  async function applyIncomingEvent(msg) {
    const ev = msg.payload;
    try {
      await ensureAllConnected();
      await Promise.all(
        profileIds.map(async (pid) => {
          try {
            const s = sessions[pid];
            if (!s.browser) return;

            if (ev.eventType === 'copy') return;

            if (ev.eventType === 'tabs' && ev.kind === 'new') {
              s.suppressTabBroadcastUntil = Date.now() + 2000;
              const p = await s.browser.newPage();
              s.page = p;
              await maybeBringPageToFront(p);
              return;
            }

            if (ev.eventType === 'chrome-ui' && ev.kind === 'focus-address-bar') {
              const page = await pickPageForBrowserEvent(s, ev.href);
              if (!page) return;
              await applyFocusAddressBar(page);
              return;
            }

            if (ev.eventType === 'navigate') {
              await applyNavigate(ev, s);
              return;
            }

            if (
              ev.eventType === 'mouse' &&
              ev.kind === 'move' &&
              syncCfg.mouseMoveThrottleMs > 0
            ) {
              const now = Date.now();
              const gap = now - (s._lastMouseMoveAt || 0);
              if (gap < syncCfg.mouseMoveThrottleMs) return;
              s._lastMouseMoveAt = now;
            }

            const page = await pickPageForBrowserEvent(s, ev.href);
            if (!page) return;

            if (ev.eventType === 'mouse') await applyMouse(ev, page, pid);
            else if (ev.eventType === 'wheel') await applyWheel(ev, page, pid);
            else if (ev.eventType === 'key') await applyKeyWithVirtualClipboard(ev, page, pid);
            else if (ev.eventType === 'input' && syncCfg.replicateInputValue) await applyInput(ev, page);
          } catch (e) {
            if (isBenignBrowserClosedError(e)) return;
            console.error(`[${agentId}] profile ${pid} apply failed:`, e?.message ?? e);
          }
        })
      );
    } catch (e) {
      console.error(`[${agentId}] apply event failed:`, e?.message ?? e);
    }
  }

  async function onWsMessage(buf) {
    const msg = (() => {
      try { return JSON.parse(buf.toString('utf8')); } catch { return null; }
    })();
    if (!msg) return;

    if (msg.type === 'control' && msg.payload?.kind === 'sync') {
      syncEnabled = !!msg.payload.enabled;
      console.log(`[${agentId}] sync: ${syncEnabled ? 'ON' : 'OFF'}`);
      return;
    }

    if (msg.type !== 'event') return;
    if (!syncEnabled) {
      const now = Date.now();
      if (!lastSyncDisabledWarnAt || now - lastSyncDisabledWarnAt > 60_000) {
        lastSyncDisabledWarnAt = now;
        console.warn(
          `[${agentId}] sync is OFF — events ignored (turn sync ON in dashboard or via control message)`
        );
      }
      return;
    }

    if (!hasAnyBrowserConnected()) {
      if (pendingEventMessages.length >= MAX_PENDING_EVENTS) pendingEventMessages.shift();
      pendingEventMessages.push(msg);
      schedulePendingFlush();
      return;
    }
    await applyIncomingEvent(msg);
  }

  function attachServerHandlers(socket) {
    socket.on('open', () => {
      wsReconnectAttempt = 0;
      socket.send(JSON.stringify({
        type: 'register',
        role: 'agent',
        id: agentId,
        meta: {
          profileIds,
          forceViewport: forceViewport?.enabled ? { w: forceViewport.width, h: forceViewport.height } : null
        }
      }));
      console.log(`[${agentId}] connected to server (profiles may still be loading — sync works as they connect)`);
    });

    socket.on('close', () => {
      if (wsReconnectTimer) {
        clearTimeout(wsReconnectTimer);
        wsReconnectTimer = null;
      }
      if (wsIntentionalClose) return;
      wsReconnectAttempt += 1;
      const delay = Math.min(60_000, Math.round(2000 * 1.45 ** Math.min(wsReconnectAttempt, 12)));
      console.log(`[${agentId}] server disconnected — reconnect in ${Math.round(delay / 1000)}s (панель/обновление страницы не завершают агент)`);
      wsReconnectTimer = setTimeout(() => {
        wsReconnectTimer = null;
        connectWebSocket();
      }, delay);
    });

    socket.on('error', (err) => {
      console.warn(`[${agentId}] WebSocket error:`, err?.message ?? err);
    });

    socket.on('message', onWsMessage);
  }

  function connectWebSocket() {
    if (wsIntentionalClose) return;
    try {
      ws = new WebSocket(serverWsUrl);
    } catch (e) {
      console.error(`[${agentId}] WebSocket create failed:`, e?.message ?? e);
      wsReconnectTimer = setTimeout(connectWebSocket, 5000);
      return;
    }
    attachServerHandlers(ws);
  }

  connectWebSocket();

  void (async () => {
    console.log(
      `[${agentId}] connecting ${profileIds.length} profile(s), batchConcurrency=${connectConcurrency}, dolphinApi start=${maxConcurrentStarts} stop=${maxConcurrentStops}...`
    );
    for (let i = 0; i < profileIds.length; i += connectConcurrency) {
      const batch = profileIds.slice(i, i + connectConcurrency);
      await Promise.all(
        batch.map((pid, j) =>
          sleep(j * connectStaggerMs).then(() => connectProfileLoop(pid))
        )
      );
    }
    console.log(`[${agentId}] all profiles initial connect finished`);
  })();
}

main().catch((e) => {
  console.error('agent fatal:', e);
  process.exit(1);
});

