// R2, R3: what the card says. The banner only draws this, so the rules live here where they can be tested.
import { cleanTitle } from './titles.js';

export const COMMAND_ACTIONS = {
  'dup-jump': 'jump',
  'dup-bring': 'bring',
  'dup-close-other': 'close-other',
  'dup-keep': 'keep',
};

/** chrome.commands.getAll() as { action: 'the keys bound' }. An unbound command has no entry. */
export function boundShortcuts(commands) {
  const bound = {};
  for (const { name, shortcut } of commands) {
    if (COMMAND_ACTIONS[name] && shortcut) bound[COMMAND_ACTIONS[name]] = shortcut;
  }
  return bound;
}

export function buildCard(decision, tab, shortcuts = {}) {
  const action = (id, keys, label, primary = false) => ({ id, keys, label, primary, shortcut: shortcuts[id] ?? null });

  if (decision.kind === 'offer') {
    return {
      heading: `This is another door to ${decision.rule.name}`,
      detail: decision.rule.canonical,
      actions: [
        action('jump', ['j'], `Go to ${decision.rule.name}`, true),
        action('keep', ['k'], 'Stay here'),
      ],
    };
  }

  const { target, copies } = decision;
  const otherWindow = target.windowId !== tab.windowId;
  const closeLabel = copies.length > 1 ? `Close the other ${copies.length}` : 'Close the other';
  const actions = [action('jump', ['j'], 'Jump to it', true)];
  if (otherWindow) actions.push(action('bring', ['b'], 'Bring here'));
  if (copies.length) actions.push(action('close-other', ['x', 'c'], closeLabel));
  actions.push(action('keep', ['k'], 'Keep both'));
  return {
    heading: decision.rule
      ? `${decision.rule.name} is already open`
      : `Already open${otherWindow ? ' in another window' : ''}`,
    detail: cleanTitle(target.title) || target.url,
    actions,
  };
}
