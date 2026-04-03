import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'node:os';
import { WebSocketServer } from 'ws';
import crypto from 'crypto';

const PORT = Number.parseInt(process.env.PORT ?? process.env.SYNC_SERVER_PORT ?? '8787', 10);
const CLIPBOARD_LOG_DIR = process.env.CLIPBOARD_LOG_DIR
  ? path.resolve(process.env.CLIPBOARD_LOG_DIR)
  : path.resolve(process.cwd(), 'clipboard-logs');

function safeClipboardFileId(id) {
  return String(id || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

/** Не loopback IPv4 — подсказка, какой URL дать агентам в LAN (у ПК может быть несколько интерфейсов). */
function listLanIPv4() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      const fam = info.family;
      if (fam !== 'IPv4' && fam !== 4) continue;
      if (info.internal) continue;
      out.push({ name, address: info.address });
    }
  }
  return out;
}

function appendClipboardLogFile(windowId, text, kind = 'copy') {
  const t = String(text ?? '');
  if (!t) return;
  try {
    fs.mkdirSync(CLIPBOARD_LOG_DIR, { recursive: true });
    const file = path.join(CLIPBOARD_LOG_DIR, `${safeClipboardFileId(windowId)}.log`);
    const iso = new Date().toISOString();
    const header = `\n### ${iso} window=${windowId} kind=${kind} len=${t.length} ###\n`;
    fs.appendFileSync(file, `${header}${t}\n`, 'utf8');
  } catch (e) {
    console.error('[clipboard-log]', e?.message ?? e);
  }
}

const app = express();
app.use(express.json());

/**
 * clients: id -> { id, role, ws, lastSeen, meta, syncEnabled }
 * role: 'controller' | 'agent' | 'dashboard'
 */
const clients = new Map();

function now() {
  return Date.now();
}

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function publicClient(c) {
  return {
    id: c.id,
    role: c.role,
    lastSeen: c.lastSeen,
    meta: c.meta ?? null,
    syncEnabled: c.syncEnabled ?? false
  };
}

function listAgents() {
  const agents = [];
  for (const [, c] of clients) {
    if (c.role === 'agent') agents.push(publicClient(c));
  }
  agents.sort((a, b) => a.id.localeCompare(b.id));
  return agents;
}

function send(ws, obj) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function broadcastToDashboards(obj) {
  for (const [, c] of clients) {
    if (c.role === 'dashboard') send(c.ws, obj);
  }
}

function broadcastToAgents(event, filter) {
  for (const [, c] of clients) {
    if (c.role !== 'agent') continue;
    if (!c.syncEnabled) continue;
    if (filter?.excludeAgentId && c.id === filter.excludeAgentId) continue;
    if (filter?.agentIds?.length && !filter.agentIds.includes(c.id)) continue;
    send(c.ws, { type: 'event', payload: event });
  }
}

app.get('/api/agents', (_req, res) => {
  res.json({ ok: true, agents: listAgents() });
});

app.post('/api/agents/:id/sync', (req, res) => {
  const agentId = req.params.id;
  const enabled = !!req.body?.enabled;
  const c = clients.get(agentId);
  if (!c || c.role !== 'agent') return res.status(404).json({ ok: false, error: 'agent_not_found' });
  c.syncEnabled = enabled;
  send(c.ws, { type: 'control', payload: { kind: 'sync', enabled } });
  broadcastToDashboards({ type: 'agents', payload: { agents: listAgents() } });
  return res.json({ ok: true });
});

app.post('/api/agents/sync', (req, res) => {
  const enabled = !!req.body?.enabled;
  for (const [, c] of clients) {
    if (c.role !== 'agent') continue;
    c.syncEnabled = enabled;
    send(c.ws, { type: 'control', payload: { kind: 'sync', enabled } });
  }
  broadcastToDashboards({ type: 'agents', payload: { agents: listAgents() } });
  return res.json({ ok: true });
});

app.get('/', (_req, res) => {
  res.type('html').send(`
<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Dolphin Sync Server</title>
    <style>
      :root { --bg:#0b0e14; --panel:#111827; --text:#e5e7eb; --muted:#94a3b8; --accent:#22c55e; --warn:#f59e0b; --danger:#ef4444; }
      body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; background:var(--bg); color:var(--text); }
      header { padding:16px 20px; border-bottom:1px solid #1f2937; display:flex; align-items:center; justify-content:space-between; }
      h1 { font-size:16px; margin:0; letter-spacing:.2px; }
      .muted { color:var(--muted); }
      main { padding:20px; max-width:1100px; margin:0 auto; }
      .row { display:flex; gap:12px; flex-wrap:wrap; align-items:center; margin-bottom:16px; }
      button { background:#1f2937; color:var(--text); border:1px solid #334155; padding:8px 12px; border-radius:10px; cursor:pointer; }
      button:hover { border-color:#64748b; }
      button.primary { background:#064e3b; border-color:#065f46; }
      button.danger { background:#450a0a; border-color:#7f1d1d; }
      table { width:100%; border-collapse:collapse; background:var(--panel); border:1px solid #1f2937; border-radius:14px; overflow:hidden; }
      th, td { padding:10px 12px; border-bottom:1px solid #1f2937; font-size:13px; }
      th { text-align:left; color:var(--muted); font-weight:600; }
      tr:last-child td { border-bottom:none; }
      .pill { display:inline-flex; align-items:center; gap:8px; }
      .dot { width:8px; height:8px; border-radius:99px; background:var(--danger); box-shadow:0 0 0 3px rgba(239,68,68,.15); }
      .dot.on { background:var(--accent); box-shadow:0 0 0 3px rgba(34,197,94,.12); }
      code { background:#0f172a; border:1px solid #1f2937; padding:2px 6px; border-radius:8px; }
      .right { margin-left:auto; }
      .small { font-size:12px; }
    </style>
  </head>
  <body>
    <header>
      <div>
        <h1>Dolphin Sync Server</h1>
        <div class="muted small">WS + панель управления sync/pause</div>
      </div>
      <div class="muted small">Порт: <code>${PORT}</code></div>
    </header>
    <main>
      <div class="row">
        <button class="primary" id="syncAllOn">Sync всем: ON</button>
        <button class="danger" id="syncAllOff">Sync всем: OFF</button>
        <span class="muted right small" id="status">Подключение...</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Agent ID</th>
            <th>Online</th>
            <th>Sync</th>
            <th>Meta</th>
            <th>Last seen</th>
          </tr>
        </thead>
        <tbody id="tbody"></tbody>
      </table>
      <p class="muted small">Подсказка: агенты регистрируются по WebSocket, панель живьём обновляет статус.</p>
    </main>
    <script>
      const statusEl = document.getElementById('status');
      const tbody = document.getElementById('tbody');
      const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(\`\${wsProto}://\${location.host}/ws\`);

      function fmtAgo(ts) {
        if (!ts) return '-';
        const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
        if (s < 5) return 'now';
        if (s < 60) return s + 's';
        const m = Math.floor(s / 60);
        if (m < 60) return m + 'm';
        const h = Math.floor(m / 60);
        return h + 'h';
      }

      function render(agents) {
        tbody.innerHTML = '';
        for (const a of agents) {
          const online = (Date.now() - a.lastSeen) < 15000;
          const tr = document.createElement('tr');
          tr.innerHTML = \`
            <td><code>\${a.id}</code></td>
            <td><span class="pill"><span class="dot \${online ? 'on' : ''}"></span> \${online ? 'online' : 'offline'}</span></td>
            <td>
              <label class="pill">
                <input type="checkbox" \${a.syncEnabled ? 'checked' : ''} data-id="\${a.id}">
                \${a.syncEnabled ? 'ON' : 'OFF'}
              </label>
            </td>
            <td class="muted small">\${a.meta ? JSON.stringify(a.meta) : '-'}</td>
            <td class="muted small">\${fmtAgo(a.lastSeen)}</td>
          \`;
          tbody.appendChild(tr);
        }
        tbody.querySelectorAll('input[type=checkbox][data-id]').forEach(cb => {
          cb.addEventListener('change', async () => {
            const id = cb.getAttribute('data-id');
            await fetch(\`/api/agents/\${encodeURIComponent(id)}/sync\`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ enabled: cb.checked })
            });
          });
        });
      }

      async function refresh() {
        const r = await fetch('/api/agents');
        const j = await r.json();
        render(j.agents || []);
      }

      ws.addEventListener('open', () => {
        statusEl.textContent = 'WS connected';
        ws.send(JSON.stringify({ type: 'register', role: 'dashboard', id: 'dashboard-' + Math.random().toString(16).slice(2) }));
        refresh();
      });
      ws.addEventListener('close', () => statusEl.textContent = 'WS disconnected');
      ws.addEventListener('message', (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.type === 'agents') render(msg.payload.agents || []);
      });

      document.getElementById('syncAllOn').addEventListener('click', async () => {
        await fetch('/api/agents/sync', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ enabled:true }) });
      });
      document.getElementById('syncAllOff').addEventListener('click', async () => {
        await fetch('/api/agents/sync', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ enabled:false }) });
      });

      setInterval(refresh, 5000);
    </script>
  </body>
</html>
  `);
});

const server = http.createServer(app);

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  const ephemeralId = crypto.randomBytes(8).toString('hex');
  let id = null;

  const heartbeat = setInterval(() => {
    if (id && clients.has(id)) clients.get(id).lastSeen = now();
  }, 5000);

  ws.on('message', (buf) => {
    const msg = safeJsonParse(buf.toString('utf8'));
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'register') {
      id = String(msg.id || ephemeralId);
      const role = String(msg.role || 'agent');
      const meta = msg.meta && typeof msg.meta === 'object' ? msg.meta : null;

      const existing = clients.get(id);
      if (existing?.ws && existing.ws !== ws) {
        try { existing.ws.close(); } catch {}
      }

      clients.set(id, {
        id,
        role,
        ws,
        lastSeen: now(),
        meta,
        syncEnabled: role === 'agent' ? true : false
      });

      send(ws, { type: 'registered', payload: { id, role } });
      broadcastToDashboards({ type: 'agents', payload: { agents: listAgents() } });
      return;
    }

    if (!id) return;
    const c = clients.get(id);
    if (!c) return;
    c.lastSeen = now();

    if (c.role === 'controller' && msg.type === 'controllerEvent') {
      const p = msg.payload;
      /** Копирование с главного окна — только в файл, агентам не шлём (у каждого свой буфер). */
      if (p && p.eventType === 'copy') {
        const wid = `controller-${c.id}`;
        appendClipboardLogFile(wid, p.text, p.kind || 'copy');
        return;
      }
      broadcastToAgents(msg.payload);
      return;
    }

    /**
     * Ретрансляция событий между агентами (например вкладка «+» в Dolphin).
     * ВАЖНО: `tabs:new` от агентов НЕ ретранслируем — иначе петля: sync → newPage →
     * targetcreated → agentForward → другие агенты → снова newPage → лавина about:blank.
     * Новые вкладки с главного идут только через controller → controllerEvent.
     */
    if (c.role === 'agent' && msg.type === 'agentForward') {
      const p = msg.payload;
      if (p && p.eventType === 'tabs' && p.kind === 'new') return;
      broadcastToAgents(msg.payload, { excludeAgentId: c.id });
      return;
    }
  });

  ws.on('close', () => {
    clearInterval(heartbeat);
    if (id && clients.get(id)?.ws === ws) {
      clients.delete(id);
      broadcastToDashboards({ type: 'agents', payload: { agents: listAgents() } });
    }
  });
});

if (!process.env.VERCEL) {
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[sync-server] Порт ${PORT} уже занят (другой экземпляр сервера или программа).`);
      console.error(`  Windows: netstat -ano | findstr :${PORT}  →  taskkill /PID <pid> /F`);
      console.error(`  Или другой порт (bash): SYNC_SERVER_PORT=8788 npm run server`);
      console.error(`  (cmd.exe): set SYNC_SERVER_PORT=8788 && npm run server`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(PORT, () => {
    console.log(`Sync server listening: http://0.0.0.0:${PORT}`);
    console.log(`WebSocket endpoint: ws://0.0.0.0:${PORT}/ws`);
    const lan = listLanIPv4();
    if (lan.length) {
      console.log('С этой машины по LAN (выберите адрес той же подсети, что и у агента):');
      for (const { name, address } of lan) {
        console.log(`  http://${address}:${PORT}/  |  ws://${address}:${PORT}/ws  (${name})`);
      }
    }
    console.log(`Clipboard logs (главное окно): ${CLIPBOARD_LOG_DIR}/*.log`);
  });
}

export default app;

