// R2, R3: the card, dead centre over a dimmed page. Injected fresh each time it is shown, so this is a classic script
// that runs top to bottom; background.js puts the card's content in globalThis.browserTabHelperCard first.
(() => {
  const HOST_ID = 'browser-tab-helper-card';
  const card = globalThis.browserTabHelperCard;
  if (!card) return;

  document.getElementById(HOST_ID)?.remove();
  const previousFocus = document.activeElement;

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647;';
  // An open root on purpose: Vimium-style extensions follow shadowRoot.activeElement to see the text field below.
  // In a closed root they would see only this host and take the letters for themselves.
  const root = host.attachShadow({ mode: 'open' });

  // A constructed sheet, so a page's strict style-src CSP cannot strip the card's styling.
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    .backdrop { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.55); color-scheme: light dark;
      font: 15px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .card { position: relative; box-sizing: border-box; width: min(460px, calc(100vw - 32px)); padding: 22px 24px;
      border-radius: 14px; background: #fff; color: #1c1c1e; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45); }
    h1 { margin: 0 28px 4px 0; font-size: 18px; font-weight: 600; }
    .detail { margin: 0 0 16px; color: #636366; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .actions { display: flex; flex-direction: column; gap: 8px; }
    button.action { position: relative; display: flex; align-items: baseline; gap: 10px; width: 100%; padding: 10px 40px 10px 12px;
      border: 1px solid #d1d1d6; border-radius: 9px; background: #f7f7f8; color: inherit; font: inherit;
      text-align: left; cursor: pointer; }
    button.action:hover { background: #ececef; }
    button.action.primary { background: #0a66d8; border-color: #0a66d8; color: #fff; }
    button.action.primary:hover { background: #0857ba; }
    .shortcut { margin-left: auto; font-size: 12px; opacity: 0.65; white-space: nowrap; }
    .letter { position: absolute; top: 50%; right: 10px; transform: translateY(-50%); min-width: 18px; padding: 1px 4px;
      border: 1px solid currentColor; border-radius: 5px; font-size: 12px; text-align: center; opacity: 0.75; }
    .close { position: absolute; top: 12px; right: 12px; width: 28px; height: 28px; border: 0; border-radius: 7px;
      background: transparent; color: #636366; font-size: 18px; line-height: 1; cursor: pointer; }
    .close:hover { background: #ececef; }
    .keys { position: absolute; width: 1px; height: 1px; padding: 0; border: 0; opacity: 0; }
    @media (prefers-color-scheme: dark) {
      .card { background: #2c2c2e; color: #f2f2f7; }
      .detail, .close { color: #aeaeb2; }
      button.action { background: #3a3a3c; border-color: #48484a; }
      button.action:hover, .close:hover { background: #48484a; }
      button.action.primary { background: #0a66d8; border-color: #0a66d8; }
    }
  `);
  root.adoptedStyleSheets = [sheet];

  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const dismiss = () => {
    host.remove();
    previousFocus?.focus?.({ preventScroll: true });
  };

  const run = (action) => {
    dismiss();
    try {
      chrome.runtime.sendMessage({ type: 'card-action', action: action.id }).catch(() => {});
    } catch {
      // The extension reloaded while this card sat up, which leaves chrome.runtime behind. Dismissing is all that is left.
    }
  };

  const backdrop = make('div', 'backdrop');
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) dismiss();
  });

  const box = make('div', 'card');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', card.heading);

  const close = make('button', 'close', '×');
  close.setAttribute('aria-label', 'Dismiss');
  close.addEventListener('click', dismiss);

  const actions = make('div', 'actions');
  for (const action of card.actions) {
    const button = make('button', `action${action.primary ? ' primary' : ''}`);
    button.dataset.action = action.id;
    button.append(make('span', 'label', action.label));
    if (action.shortcut) button.append(make('span', 'shortcut', action.shortcut));
    button.append(make('span', 'letter', action.keys.join(' ')));
    // The root is open, so the page can reach these. Only a real press may close tabs.
    button.addEventListener('click', (event) => {
      if (event.isTrusted) run(action);
    });
    actions.append(button);
  }

  // While the card is up, focus sits here. Vimium-style extensions see a text field and let the letters through;
  // read-only means no letter ever lands in it.
  const keys = make('input', 'keys');
  keys.type = 'text';
  keys.readOnly = true;
  keys.tabIndex = -1;
  keys.setAttribute('aria-label', 'Card keys');

  const primary = card.actions.find((action) => action.primary);
  keys.addEventListener('keydown', (event) => {
    if (!event.isTrusted) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return; // Cmd+W and friends stay the browser's.
    const key = event.key.toLowerCase();
    let handled = true;
    if (key === 'escape') dismiss();
    else if (key === 'enter') run(primary);
    else {
      const action = card.actions.find((candidate) => candidate.keys.includes(key));
      if (action) run(action);
      else handled = false;
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  });
  // A click on the card must not leave the letters with nowhere to go.
  keys.addEventListener('blur', () => {
    if (host.isConnected) setTimeout(() => host.isConnected && keys.focus({ preventScroll: true }));
  });

  box.append(close, make('h1', '', card.heading), make('p', 'detail', card.detail), actions, keys);
  backdrop.append(box);
  root.append(backdrop);
  document.documentElement.append(host);
  keys.focus({ preventScroll: true });
})();
