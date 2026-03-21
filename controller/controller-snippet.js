// Вставьте этот код в DevTools Console на "главной" вкладке,
// либо подключите как userscript/расширение.
//
// Он шлёт события на центральный сервер, агенты воспроизводят их через CDP.

(() => {
  const SERVER_WS = 'wss://soft-production-e391.up.railway.app/ws';
  const CONTROLLER_ID = 'controller-main';

  const ws = new WebSocket(SERVER_WS);
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({
      type: 'register',
      role: 'controller',
      id: CONTROLLER_ID,
      meta: { ua: navigator.userAgent }
    }));
    console.log('[sync] connected');
  });
  ws.addEventListener('close', () => console.log('[sync] disconnected'));

  const send = (payload) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'controllerEvent', payload }));
  };

  const nx = (x) => (window.innerWidth ? x / window.innerWidth : 0);
  const ny = (y) => (window.innerHeight ? y / window.innerHeight : 0);

  // Мышь: move/throttle
  let lastMoveTs = 0;
  window.addEventListener('mousemove', (e) => {
    const t = performance.now();
    if (t - lastMoveTs < 20) return; // ~50fps
    lastMoveTs = t;
    send({
      eventType: 'mouse',
      kind: 'move',
      x: nx(e.clientX),
      y: ny(e.clientY),
      buttons: e.buttons,
      ts: Date.now()
    });
  }, true);

  // Клики
  ['mousedown', 'mouseup'].forEach((name) => {
    window.addEventListener(name, (e) => {
      send({
        eventType: 'mouse',
        kind: name === 'mousedown' ? 'down' : 'up',
        x: nx(e.clientX),
        y: ny(e.clientY),
        button: e.button,
        buttons: e.buttons,
        ts: Date.now()
      });
    }, true);
  });

  // Колесо: чтобы не зависеть от абсолютного scrollY на разных размерах
  window.addEventListener('wheel', (e) => {
    send({
      eventType: 'wheel',
      dx: e.deltaX,
      dy: e.deltaY,
      dz: e.deltaZ,
      mode: e.deltaMode,
      x: nx(e.clientX),
      y: ny(e.clientY),
      ts: Date.now()
    });
  }, { capture: true, passive: true });

  // Клавиатура (простая)
  window.addEventListener('keydown', (e) => {
    // чтобы не отправлять комбинации, которые ломают управление локально
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
      ts: Date.now()
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
      ts: Date.now()
    });
  }, true);
})();

