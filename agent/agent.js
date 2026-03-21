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

function isDolphinRateLimitError(e) {
  const st = e?.response?.status;
  const body = JSON.stringify(e?.response?.data ?? '');
  return st === 429 || /лимит|RPM|rate|blocked/i.test(body);
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

async function dolphinStartProfile(dolphinBaseUrl, profileId) {
  const url = `${dolphinBaseUrl}/v1.0/browser_profiles/${encodeURIComponent(profileId)}/start?automation=1`;
  const r = await axios.get(url, { timeout: 30_000 });
  if (!r.data?.success) throw new Error(`Dolphin start failed: ${JSON.stringify(r.data)}`);
  const port = r.data?.automation?.port;
  const wsEndpoint = r.data?.automation?.wsEndpoint;
  if (!port || !wsEndpoint) throw new Error(`Missing automation.port/wsEndpoint: ${JSON.stringify(r.data)}`);
  return { port, wsEndpoint };
}

async function dolphinStopProfile(dolphinBaseUrl, profileId) {
  const url = `${dolphinBaseUrl}/v1.0/browser_profiles/${encodeURIComponent(profileId)}/stop`;
  await axios.get(url, { timeout: 30_000 });
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
  } else if (autoDiscover) {
    try {
      const discovered = await discoverProfileIdsOnce();
      if (discovered.length) profileIds = discovered;
    } catch (e) {
      console.log(`[${agentId}] auto-discover skipped: ${e?.message ?? e}`);
    }
  }

  if (!profileIds.length) throw new Error('No dolphin.profileIds or dolphin.profileId defined in config');
  const preferUrlIncludes = cfg.target?.preferUrlIncludes ?? '';
  const forceViewport = cfg.target?.forceViewport ?? { enabled: false };
  const openOnConnectUrl = String(cfg.target?.openOnConnectUrl ?? '').trim();
  const openOnConnectWaitUntil = coercePuppeteerWaitUntil(
    cfg.target?.openOnConnectWaitUntil || 'domcontentloaded'
  );
  const openOnConnectTimeout = Math.max(5000, Number(cfg.target?.openOnConnectTimeoutMs) || 25_000);
  const connectConcurrency = Math.max(1, Math.min(30, Number(cfg.dolphin?.connectConcurrency) || 4));
  const connectStaggerMs = Math.max(0, Number(cfg.dolphin?.connectStaggerMs) || 80);
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
    strictUrlMatch: cfg.sync?.strictUrlMatch !== false,
    urlMatchMode: cfg.sync?.urlMatchMode || 'full',
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
    clipboardLogMaxChars
  };

  let syncEnabled = true;

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

  /** @type {Record<string, { browser: import('puppeteer-core').Browser | null, page: import('puppeteer-core').Page | null }>} */
  const sessions = {};
  for (const pid of profileIds) {
    sessions[pid] = { browser: null, page: null };
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
      if (!/already been registered|already exists/i.test(String(e?.message || e))) {
        console.warn(`[${agentId}] expose clipboard hook:`, e?.message ?? e);
      }
    }

    const installInPage = () => {
      if (window.__dolphinSyncClipHookV2) return;
      window.__dolphinSyncClipHookV2 = true;
      try {
        document.addEventListener(
          'copy',
          (e) => {
            const t =
              (e.clipboardData && e.clipboardData.getData('text/plain')) ||
              (window.getSelection() && window.getSelection().toString()) ||
              '';
            if (t && window.__dolphinSyncReportClipboard) {
              void window.__dolphinSyncReportClipboard({ kind: 'copy-dom', text: String(t) });
            }
          },
          true
        );
        document.addEventListener(
          'cut',
          (e) => {
            const t =
              (e.clipboardData && e.clipboardData.getData('text/plain')) ||
              (window.getSelection() && window.getSelection().toString()) ||
              '';
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
      console.warn(`[${agentId}] evaluateOnNewDocument clipboard:`, e?.message ?? e);
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
        await hookPageClipboardReporting(p, profileId);
      } catch (e) {
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
        const p = await target.page();
        if (p) await hook(p);
      } catch {
        /* ignore */
      }
    });
  }

  async function applyVirtualCopy(page, profileId) {
    let text = '';
    try {
      text = await page.evaluate(() => {
        try {
          return (window.getSelection() && window.getSelection().toString()) || '';
        } catch {
          return '';
        }
      });
    } catch {
      return;
    }
    clipboardByProfile[profileId] = text;
    if (text) appendClipboardLog(profileId, text, { kind: 'copy-shortcut' });
  }

  async function applyVirtualCut(page, profileId) {
    let text = '';
    try {
      text = await page.evaluate(() => {
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
      });
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
    return isChordMod(ev) && !ev.shift && String(ev.key || '').toLowerCase() === 'c';
  }

  function isCutChord(ev) {
    return isChordMod(ev) && !ev.shift && String(ev.key || '').toLowerCase() === 'x';
  }

  function isPasteChord(ev) {
    return isChordMod(ev) && !ev.shift && String(ev.key || '').toLowerCase() === 'v';
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
    } else if (!syncCfg.replicatePaste && (isPasteChord(ev) || (ev.key === 'v' || ev.key === 'V') && isChordMod(ev))) {
      return;
    }

    await applyKey(ev, page);
  }

  async function connectProfileLoop(profileId) {
    const s = sessions[profileId];
    while (true) {
      try {
        await dolphinLoginCached(dolphinBaseUrl, dolphinToken);
        let automation;
        try {
          automation = await dolphinStartProfile(dolphinBaseUrl, profileId);
        } catch (e) {
          const code = e?.response?.data?.errorObject?.code;
          if (code === 'E_BROWSER_RUN_DUPLICATE') {
            console.log(`[${agentId}] profile ${profileId} already running, restarting for automation...`);
            await dolphinStopProfile(dolphinBaseUrl, profileId);
            await sleep(1200);
            automation = await dolphinStartProfile(dolphinBaseUrl, profileId);
          } else {
            throw e;
          }
        }
        const { port, wsEndpoint } = automation;
        const browser = await connectCdp({ port, wsEndpoint });
        s.browser = browser;
        browser.on('disconnected', () => {
          s.browser = null;
          s.page = null;
        });
        s.page = await ensurePage(browser, preferUrlIncludes, forceViewport);
        if (openOnConnectUrl) {
          try {
            await s.page.goto(openOnConnectUrl, {
              waitUntil: openOnConnectWaitUntil,
              timeout: openOnConnectTimeout
            });
            await s.page.bringToFront().catch(() => {});
            console.log(`[${agentId}] profile ${profileId} → ${openOnConnectUrl}`);
          } catch (e) {
            console.error(`[${agentId}] profile ${profileId} openOnConnectUrl failed:`, e?.message ?? e);
          }
        }
        if (syncCfg.virtualClipboard || syncCfg.clipboardLogToFile) {
          await installClipboardHooksForBrowser(browser, profileId);
        }
        console.log(`[${agentId}] profile ${profileId} connected`);
        return;
      } catch (e) {
        console.error(`[${agentId}] profile ${profileId} connect failed:`, e?.message ?? e);
        if (isDolphinRateLimitError(e)) {
          console.log(`[${agentId}] Dolphin API rate limit, waiting 65s...`);
          await sleep(65_000);
          dolphinLoginExpiresAt = 0;
        } else {
          await sleep(2000);
        }
      }
    }
  }

  const ws = new WebSocket(serverWsUrl);
  ws.on('open', () => {
    ws.send(JSON.stringify({
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

  ws.on('close', async () => {
    console.log(`[${agentId}] server disconnected, exiting`);
    process.exit(1);
  });

  async function getViewport(page) {
    const v = page?.viewport?.();
    if (v?.width && v?.height) return { width: v.width, height: v.height };
    const dim = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    const w = Math.max(dim.w || 0, 1);
    const h = Math.max(dim.h || 0, 1);
    if (w < 100 || h < 100) return { width: 1280, height: 720 };
    return { width: w, height: h };
  }

  async function applyMouse(ev, page) {
    const { width, height } = await getViewport(page);
    const x = clamp01(ev.x) * width;
    const y = clamp01(ev.y) * height;

    if (ev.kind === 'move') {
      await page.mouse.move(x, y);
      return;
    }
    if (ev.kind === 'down') {
      await page.bringToFront().catch(() => {});
      await page.mouse.move(x, y);
      await page.mouse.down({ button: ev.button === 2 ? 'right' : ev.button === 1 ? 'middle' : 'left' });
      return;
    }
    if (ev.kind === 'up') {
      await page.mouse.move(x, y);
      await page.mouse.up({ button: ev.button === 2 ? 'right' : ev.button === 1 ? 'middle' : 'left' });
      return;
    }
  }

  async function applyWheel(ev, page) {
    const { width, height } = await getViewport(page);
    const x = clamp01(ev.x) * width;
    const y = clamp01(ev.y) * height;
    const client = await page.target().createCDPSession();
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX: ev.dx ?? 0,
      deltaY: ev.dy ?? 0
    });
    await client.detach();
  }

  async function applyKey(ev, page) {
    if (ev.kind === 'down') await page.keyboard.down(ev.key);
    if (ev.kind === 'up') await page.keyboard.up(ev.key);
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
    const strict = syncCfg.strictUrlMatch;
    const targetUrl = String(ev.url ?? '').trim();
    if (!targetUrl) return;

    if (strict) {
      const ref = ev.fromHref != null && String(ev.fromHref).trim() !== ''
        ? String(ev.fromHref).trim()
        : null;
      if (ref) {
        let agentUrl = '';
        try {
          agentUrl = s.page?.url() || '';
        } catch {
          agentUrl = '';
        }
        if (!urlsMatch(agentUrl, ref, mode)) return;
      }
    }

    const isNewTabUrl = (u) =>
      /^chrome:\/\/new/i.test(u) || u === 'about:blank' || u === '';
    if (isNewTabUrl(targetUrl)) {
      const pages = await browser.pages();
      const pickEmpty = pages.find((p) => {
        try {
          return isNewTabUrl(p.url());
        } catch {
          return false;
        }
      });
      if (pickEmpty) {
        s.page = pickEmpty;
        await pickEmpty.bringToFront().catch(() => {});
        return;
      }
      const p = await browser.newPage();
      s.page = p;
      await p.bringToFront().catch(() => {});
      return;
    }

    const pages = await browser.pages();
    for (const p of pages) {
      let u = '';
      try {
        u = p.url();
      } catch {
        continue;
      }
      if (urlsMatch(u, targetUrl, mode) || u === targetUrl) {
        s.page = p;
        await p.bringToFront().catch(() => {});
        return;
      }
    }

    const p = await browser.newPage();
    s.page = p;
    const internalNew =
      /^chrome:\/\/new/i.test(targetUrl) ||
      targetUrl === 'about:blank';
    if (!internalNew) {
      await p.goto(targetUrl, {
        waitUntil: syncCfg.navigateWaitUntil,
        timeout: syncCfg.navigateTimeoutMs
      }).catch(() => {});
    }
    await p.bringToFront().catch(() => {});
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

    if (strict) {
      const ref = ev.fromHref != null && String(ev.fromHref).trim() !== ''
        ? String(ev.fromHref).trim()
        : null;
      if (!ref) return;
      if (!urlsMatch(agentUrl, ref, mode)) return;
    }

    const url = String(ev.url ?? ev.href ?? '').trim();
    if (!url) return;

    await page.goto(url, { waitUntil: waitNav, timeout: timeoutMs }).catch(() => {});
  }

  async function ensureAllConnected() {
    await Promise.all(profileIds.map(async (pid) => {
      const s = sessions[pid];
      if (s.browser && s.page) return;
      await connectProfileLoop(pid);
    }));
  }

  ws.on('message', async (buf) => {
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
    if (!syncEnabled) return;

    const ev = msg.payload;
    try {
      await ensureAllConnected();
      await Promise.all(profileIds.map(async (pid) => {
        const s = sessions[pid];
        if (!s.browser) return;

        if (ev.eventType === 'copy') return;

        if (ev.eventType === 'tabs' && ev.kind === 'new') {
          const p = await s.browser.newPage();
          s.page = p;
          await p.bringToFront().catch(() => {});
          return;
        }

        const page = s.page;
        if (!page) return;

        if (ev.eventType === 'navigate') {
          await applyNavigate(ev, s);
          return;
        }

        if (ev.eventType === 'mouse') await applyMouse(ev, page);
        else if (ev.eventType === 'wheel') await applyWheel(ev, page);
        else if (ev.eventType === 'key') await applyKeyWithVirtualClipboard(ev, page, pid);
        else if (ev.eventType === 'input') await applyInput(ev, page);
      }));
    } catch (e) {
      console.error(`[${agentId}] apply event failed:`, e?.message ?? e);
      for (const pid of profileIds) {
        sessions[pid].browser = null;
        sessions[pid].page = null;
      }
    }
  });

  void (async () => {
    console.log(`[${agentId}] connecting ${profileIds.length} profile(s), concurrency=${connectConcurrency}...`);
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

