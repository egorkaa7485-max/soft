(() => {
  const NS = '__dolphin_sync_content__';
  if (window[NS]?.started) return;

  const state = {
    started: true,
    lastMoveTs: 0,
    /** URL страницы до SPA-перехода (для sync только при совпадении с агентом) */
    lastCommittedHref: typeof location !== 'undefined' ? location.href : ''
  };

  function viewportSize() {
    const vv = window.visualViewport;
    const w =
      (document.documentElement && document.documentElement.clientWidth) ||
      window.innerWidth ||
      (vv && vv.width) ||
      1;
    const h =
      (document.documentElement && document.documentElement.clientHeight) ||
      window.innerHeight ||
      (vv && vv.height) ||
      1;
    return { w: Math.max(w, 1), h: Math.max(h, 1) };
  }

  function nx(x) {
    const { w } = viewportSize();
    return w ? x / w : 0;
  }

  function ny(y) {
    const { h } = viewportSize();
    return h ? y / h : 0;
  }

  let syncPort = null;

  function connectSyncPort() {
    try {
      if (syncPort) return;
      syncPort = chrome.runtime.connect({ name: 'dolphin-sync' });
      syncPort.onDisconnect.addListener(() => {
        syncPort = null;
        setTimeout(connectSyncPort, 300);
      });
    } catch {
      syncPort = null;
      setTimeout(connectSyncPort, 500);
    }
  }

  connectSyncPort();

  function send(payload) {
    try {
      if (syncPort) {
        syncPort.postMessage({ type: 'sync_event', payload });
        return;
      }
    } catch {
      syncPort = null;
    }
    try {
      chrome.runtime.sendMessage({ type: 'sync_event', payload });
    } catch {}
  }

  function getSelector(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return `#${CSS.escape(el.id)}`;
    const name = el.getAttribute('name');
    if (name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
    let node = el;
    const parts = [];
    while (node && node.nodeType === 1 && parts.length < 5) {
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
      const idx = same.indexOf(node) + 1;
      parts.unshift(`${tag}:nth-of-type(${idx})`);
      node = parent;
    }
    return parts.join(' > ');
  }

  window.addEventListener('mousemove', (e) => {
    const t = performance.now();
    /** ~20 fps — меньше нагрузки на WS при многих агентах */
    if (t - state.lastMoveTs < 50) return;
    state.lastMoveTs = t;
    send({
      eventType: 'mouse',
      kind: 'move',
      x: nx(e.clientX),
      y: ny(e.clientY),
      buttons: e.buttons,
      ts: Date.now(),
      href: location.href
    });
  }, true);

  window.addEventListener('mousedown', (e) => {
    send({
      eventType: 'mouse',
      kind: 'down',
      x: nx(e.clientX),
      y: ny(e.clientY),
      button: e.button,
      buttons: e.buttons,
      ts: Date.now(),
      href: location.href
    });
  }, true);

  window.addEventListener('mouseup', (e) => {
    send({
      eventType: 'mouse',
      kind: 'up',
      x: nx(e.clientX),
      y: ny(e.clientY),
      button: e.button,
      buttons: e.buttons,
      ts: Date.now(),
      href: location.href
    });
  }, true);

  window.addEventListener('wheel', (e) => {
    send({
      eventType: 'wheel',
      dx: e.deltaX,
      dy: e.deltaY,
      dz: e.deltaZ,
      mode: e.deltaMode,
      x: nx(e.clientX),
      y: ny(e.clientY),
      ts: Date.now(),
      href: location.href
    });
  }, { capture: true, passive: true });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'F12' || e.key === 'Escape') return;
    send({
      eventType: 'key',
      kind: 'down',
      key: e.key,
      code: e.code,
      ctrl: e.ctrlKey,
      alt: e.altKey,
      shift: e.shiftKey,
      meta: e.metaKey,
      ts: Date.now(),
      href: location.href
    });
  }, true);

  window.addEventListener('keyup', (e) => {
    send({
      eventType: 'key',
      kind: 'up',
      key: e.key,
      code: e.code,
      ctrl: e.ctrlKey,
      alt: e.altKey,
      shift: e.shiftKey,
      meta: e.metaKey,
      ts: Date.now(),
      href: location.href
    });
  }, true);

  window.addEventListener('input', (e) => {
    const el = e.target;
    if (!el) return;
    const isEditable = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
    if (!isEditable) return;
    const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
    const cx = rect ? rect.left + rect.width / 2 : 0;
    const cy = rect ? rect.top + Math.min(Math.max(rect.height / 2, 1), 24) : 0;
    send({
      eventType: 'input',
      selector: getSelector(el),
      value: el.value,
      inputType: e.inputType || '',
      selectionStart: typeof el.selectionStart === 'number' ? el.selectionStart : null,
      selectionEnd: typeof el.selectionEnd === 'number' ? el.selectionEnd : null,
      x: nx(cx),
      y: ny(cy),
      ts: Date.now(),
      href: location.href
    });
  }, true);

  /**
   * Копирование/вырезание: шлём только для лога на сервере (файл по id главного окна).
   * Текст не транслируется на агентов — у каждого профиля свой виртуальный буфер.
   */
  function sendClipboard(kind, text) {
    const t = String(text ?? '');
    if (!t) return;
    send({
      eventType: 'copy',
      kind,
      text: t,
      ts: Date.now(),
      href: location.href
    });
  }

  document.addEventListener(
    'copy',
    (e) => {
      const t =
        (e.clipboardData && e.clipboardData.getData('text/plain')) ||
        (window.getSelection() && window.getSelection().toString()) ||
        '';
      sendClipboard('copy-dom', t);
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
      sendClipboard('cut-dom', t);
    },
    true
  );

  window.addEventListener('popstate', () => {
    const fromHref = state.lastCommittedHref;
    const url = location.href;
    state.lastCommittedHref = url;
    send({
      eventType: 'navigate',
      kind: 'url',
      url,
      fromHref,
      ts: Date.now(),
      href: url
    });
  }, true);
  window.addEventListener('hashchange', () => {
    const fromHref = state.lastCommittedHref;
    const url = location.href;
    state.lastCommittedHref = url;
    send({
      eventType: 'navigate',
      kind: 'url',
      url,
      fromHref,
      ts: Date.now(),
      href: url
    });
  }, true);

  window[NS] = state;
})();

