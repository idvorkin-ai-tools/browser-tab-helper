// Functions that run inside a page through chrome.scripting.executeScript({ func }). Chrome serializes the function
// text, so each one must stand alone: no imports, no outer variables.

/**
 * R7: the page's selected text, or null. A password field's selection is never read: when focus is in one, the
 * answer is null however much else is selected.
 */
export function readSelection(doc = document) {
  let active = doc.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  const tag = active?.tagName?.toLowerCase();
  if (tag === 'input' && (active.type ?? '').toLowerCase() === 'password') return null;

  // getSelection() does not report text selected inside a field.
  if (tag === 'textarea' || tag === 'input') {
    let start = null;
    let end = null;
    try {
      start = active.selectionStart;
      end = active.selectionEnd;
    } catch {
      // Input types without a text selection throw on some engines.
    }
    if (start !== null && end !== null && end > start) return active.value.slice(start, end);
  }
  const text = doc.getSelection?.()?.toString() ?? '';
  return text === '' ? null : text;
}

/**
 * R8: this frame's text and controls.
 *   pageControls('read')             { text, controls: [{ tag, label, href }] }
 *   pageControls('locate', n)        scrolls control n into view and returns its centre in top-frame coordinates
 *                                    as { x, y }, or clicks it and returns { clicked: true } when a cross-origin
 *                                    parent frame hides those coordinates.
 * ponytail: the DOM click in a cross-origin frame is untrusted, so a page checking isTrusted can ignore it. Mapping
 * frames to CDP targets would fix that if it ever matters.
 */
export function pageControls(mode, localIndex) {
  const SELECTOR = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[onclick],[contenteditable=true]';

  const isVisible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };

  const labelOf = (el) => {
    const type = (el.type ?? '').toLowerCase();
    // A field's value is what you typed, so it is no label. Only a button's value names it.
    const buttonValue = type === 'submit' || type === 'button' || type === 'reset' ? el.value : '';
    return (el.getAttribute('aria-label') || el.innerText || buttonValue || el.placeholder || el.title || el.name || '')
      .trim().replace(/\s+/g, ' ').slice(0, 200);
  };

  const controls = [...document.querySelectorAll(SELECTOR)].filter(isVisible);

  if (mode === 'read') {
    return {
      text: document.body?.innerText ?? '',
      controls: controls.map((el) => ({
        tag: el.tagName.toLowerCase(),
        label: labelOf(el),
        ...(el.href ? { href: el.href } : {}),
      })),
    };
  }

  const el = controls[localIndex];
  if (!el) return { error: 'the control is gone; read the page again' };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const rect = el.getBoundingClientRect();
  let x = rect.left + rect.width / 2;
  let y = rect.top + rect.height / 2;
  try {
    for (let frame = window; frame !== window.top; frame = frame.parent) {
      const outer = frame.frameElement;
      if (!outer) throw new Error('cross-origin');
      const box = outer.getBoundingClientRect();
      x += box.left + outer.clientLeft;
      y += box.top + outer.clientTop;
    }
  } catch {
    el.click();
    return { clicked: true };
  }
  return { x, y };
}
