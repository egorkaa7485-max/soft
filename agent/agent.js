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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clamp01(n) {
  if (Number.isNaN(n) || !Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
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
  const profileIds = Array.isArray(cfg.dolphin.profileIds) && cfg.dolphin.profileIds.length
    ? cfg.dolphin.profileIds
    : (cfg.dolphin.profileId ? [cfg.dolphin.profileId] : []);
  if (!profileIds.length) {
    throw new Error('No dolphin.profileIds or dolphin.profileId defined in config');
  }
  const preferUrlIncludes = cfg.target?.preferUrlIncludes ?? '';
  const forceViewport = cfg.target?.forceViewport ?? { enabled: false };

  let syncEnabled = true;

  /** @type {Record<string, { browser: import('puppeteer-core').Browser | null, page: import('puppeteer-core').Page | null }>} */
  const sessions = {};
  for (const pid of profileIds) {
    sessions[pid] = { browser: null, page: null };
  }

  async function connectProfileLoop(profileId) {
    const s = sessions[profileId];
    while (true) {
      try {
        await dolphinLogin(dolphinBaseUrl, dolphinToken);
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
        console.log(`[${agentId}] profile ${profileId} connected`);
        return;
      } catch (e) {
        console.error(`[${agentId}] profile ${profileId} connect failed:`, e?.message ?? e);
        await sleep(2000);
      }
    }
  }

  // соединяем все профили параллельно
  await Promise.all(profileIds.map((pid) => connectProfileLoop(pid)));

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
    console.log(`[${agentId}] connected to server`);
  });

  ws.on('close', async () => {
    console.log(`[${agentId}] server disconnected, exiting`);
    process.exit(1);
  });

  async function getViewport(page) {
    const v = page?.viewport?.();
    if (v?.width && v?.height) return { width: v.width, height: v.height };
    const dim = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    return { width: dim.w, height: dim.h };
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
        const page = s.page;
        if (!page) return;
        if (ev.eventType === 'mouse') await applyMouse(ev, page);
        else if (ev.eventType === 'wheel') await applyWheel(ev, page);
        else if (ev.eventType === 'key') await applyKey(ev, page);
      }));
    } catch (e) {
      console.error(`[${agentId}] apply event failed:`, e?.message ?? e);
      for (const pid of profileIds) {
        sessions[pid].browser = null;
        sessions[pid].page = null;
      }
    }
  });
}

main().catch((e) => {
  console.error('agent fatal:', e);
  process.exit(1);
});

