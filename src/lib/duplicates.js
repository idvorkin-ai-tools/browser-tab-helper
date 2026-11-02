// R2, R3, R4: which tabs are the same page, and what to ask when one lands.
import { normalizeUrl } from './normalize.js';

export function compileRules(rules) {
  return rules.map((rule) => ({
    ...rule,
    canonicalRe: new RegExp(rule.canonicalPattern),
    otherRes: rule.otherDoors.map((source) => new RegExp(source)),
  }));
}

/** Which door of which rule this URL is, or null. The canonical door is checked first. */
export function doorOf(url, compiled) {
  for (const rule of compiled) {
    if (rule.canonicalRe.test(url)) return { rule, door: 'canonical' };
    if (rule.otherRes.some((re) => re.test(url))) return { rule, door: 'other' };
  }
  return null;
}

// Tab ids only grow within a session, so the lowest id is the oldest tab Chrome can tell us about.
function byKeeper(compiled) {
  const isCanonical = (tab) => doorOf(tab.url, compiled)?.door === 'canonical';
  return (a, b) => Number(isCanonical(b)) - Number(isCanonical(a))
    || Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))
    || a.id - b.id;
}

/** What Close the other closes: the tabs older than this one, each once. A tab can be both target and same-key. */
function olderCopies(tab, candidates) {
  const byId = new Map(candidates.filter((other) => other.id < tab.id).map((other) => [other.id, other]));
  return [...byId.values()];
}

/**
 * What to ask when `tab` lands.
 * - { kind: 'duplicate', target, copies }: another tab is this page. `target` is where Jump goes, `copies` the older
 *   tabs Close the other closes, which may be none.
 * - { kind: 'offer', rule }: another door with no canonical tab open.
 * - null: nothing to ask.
 */
export function decideCard(tab, tabs, { rules = [], muted = {}, now = 0 } = {}) {
  const key = normalizeUrl(tab.url);
  if (!key) return null;
  if (muted[key] > now) return null;

  const others = tabs.filter((other) => other.id !== tab.id);
  const sameKey = others.filter((other) => normalizeUrl(other.url) === key);
  const door = doorOf(tab.url, rules);

  if (door?.door === 'other') {
    const canonicalTabs = others.filter((other) => door.rule.canonicalRe.test(other.url ?? ''));
    if (canonicalTabs.length) {
      // The canonical tab wins even when it is the newer one, and even when this other-door tab is pinned.
      const [target] = [...canonicalTabs].sort(byKeeper(rules));
      return { kind: 'duplicate', target, copies: olderCopies(tab, [target, ...sameKey]), rule: door.rule };
    }
    if (!sameKey.length) return { kind: 'offer', rule: door.rule };
  }

  if (!sameKey.length) return null;
  const [target] = [...sameKey].sort(byKeeper(rules));
  return { kind: 'duplicate', target, copies: olderCopies(tab, sameKey) };
}

/**
 * Groups of tabs that are the same page: { key, keeper, extras, tabs }, tabs[0] being the keeper.
 * An other-door tab joins the group of the canonical tab it points at. Two canonical-door tabs on different
 * normalized URLs stay apart: a rule's pattern can match many pages, and R1's conservatism still applies.
 */
export function duplicateGroups(tabs, rules = []) {
  const groups = new Map();
  const canonicalByRule = new Map();
  for (const tab of tabs) {
    const door = tab.url ? doorOf(tab.url, rules) : null;
    if (door?.door !== 'canonical' || !normalizeUrl(tab.url)) continue;
    const held = canonicalByRule.get(door.rule);
    if (!held || byKeeper(rules)(tab, held) < 0) canonicalByRule.set(door.rule, tab);
  }
  for (const tab of tabs) {
    let key = normalizeUrl(tab.url);
    if (!key) continue;
    const door = doorOf(tab.url, rules);
    if (door?.door === 'other' && canonicalByRule.has(door.rule)) key = normalizeUrl(canonicalByRule.get(door.rule).url);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(tab);
  }
  return [...groups.entries()]
    .filter(([, members]) => members.length > 1)
    .map(([key, members]) => {
      const sorted = [...members].sort(byKeeper(rules));
      return { key, keeper: sorted[0], extras: sorted.slice(1), tabs: sorted };
    });
}

/** The badge number: how many open tabs could close with nothing lost. */
export function redundantCount(tabs, rules = []) {
  return duplicateGroups(tabs, rules).reduce((sum, group) => sum + group.extras.length, 0);
}

export const MUTE_MS = 60 * 60 * 1000;

/** The mutes still in force, dropping the expired. */
export function liveMutes(muted = {}, now = 0) {
  return Object.fromEntries(Object.entries(muted).filter(([, until]) => until > now));
}
