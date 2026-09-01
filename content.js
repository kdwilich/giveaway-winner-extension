// In-page progress pill.
//
// Two jobs. The obvious one: during a long collection the user is usually looking at
// this tab, not at luckypick.win, so progress belongs here too. The less obvious one:
// this port is a content-script port, which is the more dependable of the two MV3
// keepalive anchors — onConnectExternal is the one with known flakiness — so holding
// it open helps the worker survive the run.
//
// The pill is a read-only overlay. It appends one element to document.body, outside
// the site's own React root (anything inside it gets wiped on the next re-render) and
// behind a closed shadow boundary, so the host's CSS can't reach in and ours can't
// leak out. Nothing here reads or modifies the page's data.

(() => {
  if (window.__commentCollectorPill) return;
  window.__commentCollectorPill = true;

  const STYLE = `
    :host { all: initial; }
    .pill {
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      border-radius: 10px;
      background: #12211F;
      color: #E7EDEA;
      font: 500 13px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      box-shadow: 0 6px 24px rgba(0, 0, 0, .28);
      max-width: 300px;
      transition: opacity .18s ease;
    }
    .pill[hidden] { display: none; }
    .dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: #55C4B2; flex: none;
      animation: pulse 1.6s ease-in-out infinite;
    }
    .dot.blocked, .dot.error { background: #E68B78; animation: none; }
    .dot.paused { background: #DCB759; animation: none; }
    .dot.done { background: #55C4B2; animation: none; }
    @keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: .35 } }
    @media (prefers-reduced-motion: reduce) { .dot { animation: none } }
    .body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .count { font-weight: 600; font-variant-numeric: tabular-nums; }
    .meta { font-size: 11.5px; color: #AFBCB7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .close {
      all: unset; cursor: pointer; color: #7F8D88; font-size: 16px;
      line-height: 1; padding: 2px 4px; border-radius: 4px; flex: none;
    }
    .close:hover, .close:focus-visible { color: #E7EDEA; background: rgba(255,255,255,.08); }
    .close:focus-visible { outline: 2px solid #55C4B2; outline-offset: 1px; }
  `;

  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'closed' });

  const sheet = new CSSStyleSheet();
  sheet.replaceSync(STYLE);
  shadow.adoptedStyleSheets = [sheet];

  const pill = document.createElement('div');
  pill.className = 'pill';
  pill.hidden = true;
  pill.innerHTML = `
    <span class="dot"></span>
    <span class="body">
      <span class="count"></span>
      <span class="meta"></span>
    </span>
    <button class="close" title="Hide" aria-label="Hide">&times;</button>
  `;
  shadow.appendChild(pill);

  const dot = shadow.querySelector('.dot');
  const count = shadow.querySelector('.count');
  const meta = shadow.querySelector('.meta');

  let dismissed = false;
  shadow.querySelector('.close').addEventListener('click', () => {
    dismissed = true;
    pill.hidden = true;
  });

  function mount() {
    if (host.isConnected) return;
    (document.body || document.documentElement).appendChild(host);
  }

  function render(run) {
    if (!run || run.status === 'idle' || dismissed) {
      pill.hidden = true;
      return;
    }
    mount();
    pill.hidden = false;
    dot.className = `dot ${run.status}`;

    const collected = (run.collected || 0).toLocaleString();
    const total = run.total ? ` / ${run.total.toLocaleString()}` : '';
    count.textContent = `${collected}${total} comments`;

    if (run.status === 'running') {
      const parts = [`${run.requests || 0} requests`];
      if (run.retries) parts.push(`${run.retries} retries`);
      meta.textContent = parts.join(' · ');
    } else if (run.status === 'done') {
      meta.textContent = 'Complete — open luckypick.win';
    } else {
      meta.textContent = run.error || run.status;
    }
  }

  // Reconnects on its own if the worker cycles, which also re-arms the keepalive.
  let port = null;
  let retry = null;

  function connect() {
    clearTimeout(retry);
    retry = null;
    if (port) return;

    let opened;
    try {
      opened = chrome.runtime.connect({ name: 'pill' });
    } catch {
      return; // Extension reloading or disabled.
    }
    port = opened;

    opened.onMessage.addListener(message => {
      if (message.type === 'state' || message.type === 'done') render(message.run);
    });

    opened.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (port === opened) port = null;
      retry = setTimeout(connect, 2000);
    });

    try {
      opened.postMessage({ type: 'hello' });
    } catch {
      // Closed on arrival; the disconnect listener above schedules the retry.
    }
  }

  // Since Chrome 123, a page moved into the back/forward cache has its extension
  // channel closed — and it is the service worker, not this frozen page, that gets
  // told. So there is no onDisconnect here to retry from: on the way back in, the
  // port we are still holding is already dead, and the reconnect has to be explicit
  // or the pill goes quiet and the worker loses its sturdiest keepalive anchor.
  // https://developer.chrome.com/blog/bfcache-extension-messaging-changes
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    port = null;
    connect();
  });

  connect();
})();
