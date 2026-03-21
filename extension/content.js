(() => {
  const NS = '__dolphin_sync_content__';
  if (window[NS]?.started) return;

  const state = {
    started: true,
    lastMoveTs: 0
  };

  function nx(x) {
    return window.innerWidth ? x / window.innerWidth : 0;
  }

  function ny(y) {
    return window.innerHeight ? y / window.innerHeight : 0;
  }

  function send(payload) {
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
    if (t - state.lastMoveTs < 25) return;
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
    send({
      eventType: 'input',
      selector: getSelector(el),
      value: el.value,
      ts: Date.now(),
      href: location.href
    });
  }, true);

  window.addEventListener('copy', () => {
    const text = String(window.getSelection?.() ?? '').trim();
    if (!text) return;
    send({
      eventType: 'copy',
      text,
      ts: Date.now(),
      href: location.href
    });
  }, true);

  window.addEventListener('popstate', () => {
    send({ eventType: 'navigate', kind: 'url', url: location.href, ts: Date.now(), href: location.href });
  }, true);
  window.addEventListener('hashchange', () => {
    send({ eventType: 'navigate', kind: 'url', url: location.href, ts: Date.now(), href: location.href });
  }, true);

  window[NS] = state;
})();

