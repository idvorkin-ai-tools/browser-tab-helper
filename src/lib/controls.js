// R8: choosing a control and building key events, with no browser.

/** A control from `read`, by its number or by label: exact match first, then the first label containing it. */
export function findControl(controls, target) {
  if (typeof target === 'number') return controls.find((control) => control.index === target) ?? null;
  const wanted = String(target).trim().toLowerCase();
  if (!wanted) return null;
  const label = (control) => (control.label ?? '').trim().toLowerCase();
  return controls.find((control) => label(control) === wanted)
    ?? controls.find((control) => label(control).includes(wanted))
    ?? null;
}

const NAMED_KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  ' ': { code: 'Space', keyCode: 32, text: ' ' },
};

/** The two Input.dispatchKeyEvent calls for a key name or a single character. No modifiers. */
export function keyEvents(key) {
  const named = NAMED_KEYS[key];
  let spec = named;
  if (!spec) {
    if ([...key].length !== 1) throw new Error(`unknown key: ${key}`);
    const upper = key.toUpperCase();
    spec = { code: '', keyCode: upper.charCodeAt(0), text: key };
  }
  const base = { key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode };
  return [
    { type: spec.text ? 'keyDown' : 'rawKeyDown', ...base, ...(spec.text ? { text: spec.text } : {}) },
    { type: 'keyUp', ...base },
  ];
}

/** Numbers every frame's controls into one list, top frame first. */
export function numberControls(frames) {
  const ordered = [...frames].sort((a, b) => a.frameId - b.frameId);
  const controls = [];
  for (const frame of ordered) {
    frame.controls.forEach((control, localIndex) => {
      controls.push({ ...control, index: controls.length, frameId: frame.frameId, localIndex });
    });
  }
  return controls;
}
