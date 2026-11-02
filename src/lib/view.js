// R4: what the list page shows, separated from drawing it.
import { matchesKindChip } from './kinds.js';
import { rowTitle } from './titles.js';

/** Yours first, the rest in the order Chrome gives them, normal windows only. */
export function orderWindows(windows, currentWindowId) {
  const normal = windows.filter((win) => win.type === undefined || win.type === 'normal');
  return [...normal.filter((win) => win.id === currentWindowId), ...normal.filter((win) => win.id !== currentWindowId)];
}

export function visibleTabs(tabs, { filter = '', kindChip = null, onlyWindow = null, rules = [], docTabs = {} } = {}) {
  const needle = filter.trim().toLowerCase();
  return tabs.filter((tab) => {
    if (onlyWindow !== null && tab.windowId !== onlyWindow) return false;
    if (kindChip && !matchesKindChip(tab, kindChip, rules)) return false;
    if (!needle) return true;
    return rowTitle(tab, docTabs).toLowerCase().includes(needle) || (tab.url ?? '').toLowerCase().includes(needle);
  });
}

/** Each tab group, in strip order, then what is in no group. */
export function groupSections(tabs, groups) {
  const byId = new Map(groups.map((group) => [group.id, { group, tabs: [] }]));
  const loose = [];
  for (const tab of [...tabs].sort((a, b) => a.windowId - b.windowId || a.index - b.index)) {
    const entry = byId.get(tab.groupId);
    if (entry) entry.tabs.push(tab);
    else loose.push(tab);
  }
  return { groups: [...byId.values()].filter((entry) => entry.tabs.length), loose };
}

/** Row selection: Cmd toggles one, Shift takes the range from the anchor through this row in visible order. */
export function nextSelection(selected, visibleIds, anchor, id, { range = false } = {}) {
  const next = new Set(selected);
  if (range && anchor !== null && visibleIds.includes(anchor)) {
    const [from, to] = [visibleIds.indexOf(anchor), visibleIds.indexOf(id)].sort((a, b) => a - b);
    for (const rowId of visibleIds.slice(from, to + 1)) next.add(rowId);
    return { selected: next, anchor };
  }
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return { selected: next, anchor: id };
}
