// R4: the By kind lens and the kind chips.

/** { kind, known }. `known` means a rule named it; otherwise `kind` is the hostname (or Browser / Files). */
export function kindOf(url, rules) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'Browser', known: false };
  }
  if (parsed.protocol === 'file:') return { kind: 'Files', known: false };
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { kind: 'Browser', known: false };
  const host = parsed.hostname.replace(/^www\./, '');
  for (const rule of rules) {
    if (rule.hosts.some((h) => host === h || host.endsWith(`.${h}`))) return { kind: rule.name, known: true };
  }
  return { kind: host, known: false };
}

export const OTHER_KIND = 'Other';

/** The chip row: a count per rule-named kind, in rule order, then everything else as Other. */
export function kindCounts(tabs, rules) {
  const counts = new Map(rules.map((rule) => [rule.name, 0]));
  let other = 0;
  for (const tab of tabs) {
    const { kind, known } = kindOf(tab.url, rules);
    if (known) counts.set(kind, counts.get(kind) + 1);
    else other += 1;
  }
  const chips = [...counts].filter(([, count]) => count > 0).map(([kind, count]) => ({ kind, count }));
  if (other) chips.push({ kind: OTHER_KIND, count: other });
  return chips;
}

export function matchesKindChip(tab, chip, rules) {
  const { kind, known } = kindOf(tab.url, rules);
  return chip === OTHER_KIND ? !known : known && kind === chip;
}

/** Rule-named kinds first in rule order, then everything else by hostname. */
export function groupByKind(tabs, rules) {
  const groups = new Map();
  for (const tab of tabs) {
    const { kind, known } = kindOf(tab.url, rules);
    if (!groups.has(kind)) groups.set(kind, { name: kind, known, tabs: [] });
    groups.get(kind).tabs.push(tab);
  }
  const known = rules.map((rule) => groups.get(rule.name)).filter(Boolean);
  const rest = [...groups.values()].filter((group) => !group.known).sort((a, b) => (a.name < b.name ? -1 : 1));
  return [...known, ...rest];
}
