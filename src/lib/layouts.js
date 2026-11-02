// R5: tab layouts. Save, validate, and plan a restore, all with no browser.
import { normalizeUrl } from './normalize.js';
import { cleanTitle } from './titles.js';

export const COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

function isWebUrl(url) {
  // new URL() stringifies its argument, so ['https://a.test/'] would otherwise pass here and fail in chrome.tabs.
  if (typeof url !== 'string') return false;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function checkTab(tab, where, errors, { inGroup }) {
  if (typeof tab !== 'object' || tab === null || Array.isArray(tab)) {
    errors.push(`${where}: not a tab`);
    return;
  }
  if (tab.url === undefined) errors.push(`${where}: no url (use null for a placeholder)`);
  else if (tab.url !== null && !isWebUrl(tab.url)) errors.push(`${where}: not an http(s) URL: ${JSON.stringify(tab.url)}`);
  if (tab.title !== undefined && typeof tab.title !== 'string') errors.push(`${where}: title is not a string`);
  if (tab.pinned !== undefined && typeof tab.pinned !== 'boolean') errors.push(`${where}: pinned is not true or false`);
  if (inGroup && tab.pinned) errors.push(`${where}: a pinned tab cannot be in a group`);
}

/** Every error in a layout. Restore opens nothing unless this is empty. */
export function validateLayout(layout) {
  const errors = [];
  if (typeof layout !== 'object' || layout === null || Array.isArray(layout)) return ['the layout is not an object'];
  if (layout.version !== 1) errors.push(`unknown version: ${layout.version}`);
  if (layout.name !== undefined && typeof layout.name !== 'string') errors.push('name is not a string');
  if (!Array.isArray(layout.windows)) return [...errors, 'windows is not a list'];

  layout.windows.forEach((win, w) => {
    if (!Array.isArray(win?.items)) {
      errors.push(`window ${w + 1}: items is not a list`);
      return;
    }
    win.items.forEach((item, i) => {
      const where = `window ${w + 1}, item ${i + 1}`;
      if (item?.group === undefined) {
        checkTab(item, where, errors, { inGroup: false });
        return;
      }
      if (typeof item.group !== 'string') errors.push(`${where}: group name is not a string`);
      if (item.color !== undefined && !COLORS.includes(item.color)) errors.push(`${where}: unknown colour: ${item.color}`);
      if (item.collapsed !== undefined && typeof item.collapsed !== 'boolean') errors.push(`${where}: collapsed is not true or false`);
      if (!Array.isArray(item.tabs)) {
        errors.push(`${where}: tabs is not a list`);
        return;
      }
      item.tabs.forEach((tab, t) => checkTab(tab, `${where}, tab ${t + 1}`, errors, { inGroup: true }));
    });
  });
  return errors;
}

function savedTab(tab) {
  return {
    title: cleanTitle(tab.title),
    url: tab.url,
    ...(tab.pinned ? { pinned: true } : {}),
  };
}

function savedGroup(group, tabs) {
  return {
    group: group?.title ?? '',
    color: group?.color ?? 'grey',
    collapsed: Boolean(group?.collapsed),
    tabs: tabs.map(savedTab),
  };
}

/**
 * The layout of what is open.
 *
 * Save is stricter than "skip chrome:, chrome-extension:, about:, devtools:": it keeps http(s) only, because
 * anything else (file:, view-source:) would make the whole file fail validation on restore.
 */
export function buildLayout({ name = 'layout', windows, tabs, groups = [] }) {
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const saved = [];
  for (const win of windows) {
    if (win.type !== undefined && win.type !== 'normal') continue;
    const items = [];
    let open = null;
    const strip = tabs.filter((tab) => tab.windowId === win.id && isWebUrl(tab.url)).sort((a, b) => a.index - b.index);
    for (const tab of strip) {
      const grouped = tab.groupId !== undefined && tab.groupId !== -1;
      if (!grouped) {
        open = null;
        items.push(savedTab(tab));
      } else if (open?.id === tab.groupId) {
        open.item.tabs.push(savedTab(tab));
      } else {
        const item = savedGroup(groupById.get(tab.groupId), [tab]);
        open = { id: tab.groupId, item };
        items.push(item);
      }
    }
    if (items.length) saved.push({ items });
  }
  return { version: 1, name, windows: saved };
}

/** One tab group as a one-group layout (R6 Save). */
export function groupLayout(group, tabs) {
  const strip = [...tabs].filter((tab) => isWebUrl(tab.url)).sort((a, b) => a.index - b.index);
  return {
    version: 1,
    name: group.title || 'group',
    windows: [{ items: [savedGroup(group, strip)] }],
  };
}

/**
 * Pair each URL with an open tab on that page, by normalized URL and never by title. Each open tab is used once,
 * so a second entry for the same page opens a second copy. Returns the tab or null for each URL.
 */
export function matchOpenTabs(urls, openTabs) {
  const pool = new Map();
  for (const tab of openTabs) {
    const key = normalizeUrl(tab.url);
    if (!key) continue;
    if (!pool.has(key)) pool.set(key, []);
    pool.get(key).push(tab);
  }
  return urls.map((url) => pool.get(normalizeUrl(url))?.shift() ?? null);
}

/**
 * What restore will do: per window, items in order, each tab carrying `tabId` when an open tab moves into place.
 * Placeholders go to `skipped`, never guessed at. A group of only placeholders is not created.
 */
export function planRestore(layout, openTabs) {
  const skipped = [];
  const urls = [];
  const collect = (tab) => {
    if (tab.url === null) skipped.push({ title: tab.title ?? '', todo: tab.todo ?? '' });
    else urls.push(tab.url);
    return tab.url !== null;
  };

  const shape = layout.windows.map((win) => win.items.map((item) => (item.group === undefined
    ? (collect(item) ? { kind: 'tab', tab: item } : null)
    : { kind: 'group', item, tabs: item.tabs.filter(collect) })));

  const matches = matchOpenTabs(urls, openTabs);
  let next = 0;
  const planned = (tab) => ({ url: tab.url, pinned: Boolean(tab.pinned), tabId: matches[next++]?.id ?? null });

  const windows = shape.map((items) => ({
    items: items
      .filter((item) => item && (item.kind === 'tab' || item.tabs.length))
      .map((item) => (item.kind === 'tab'
        ? { kind: 'tab', ...planned(item.tab) }
        : {
          kind: 'group',
          title: item.item.group,
          color: item.item.color ?? 'grey',
          collapsed: Boolean(item.item.collapsed),
          tabs: item.tabs.map(planned),
        })),
  })).filter((win) => win.items.length);

  return { windows, skipped };
}
