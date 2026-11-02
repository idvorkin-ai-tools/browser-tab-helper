// R4, R5, R6: the full list page. The rules are in src/lib; this reads Chrome and draws.
import { ALIAS_RULES } from '../data/aliases.js';
import { KIND_RULES } from '../data/kinds.js';
import { compileRules, duplicateGroups, liveMutes } from '../lib/duplicates.js';
import { groupByKind, kindCounts } from '../lib/kinds.js';
import { buildLayout, groupLayout, matchOpenTabs } from '../lib/layouts.js';
import { formatSection, parseSection } from '../lib/sections.js';
import { withDefaults } from '../lib/settings.js';
import { rowTitle } from '../lib/titles.js';
import { closeRecord, groupRestores, moveRecord, moveSteps, nextRestoreStep, undoMoveOrder } from '../lib/undo.js';
import { groupSections, nextSelection, orderWindows, visibleTabs } from '../lib/view.js';
import { windowName } from '../lib/window-names.js';

const scriptStart = performance.now();
const ALIASES = compileRules(ALIAS_RULES);
const LIST_URL = location.href.split(/[?#]/)[0];
const TOAST_MS = 20_000;

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  const { dataset, ...rest } = props;
  Object.assign(node, rest);
  if (dataset) Object.assign(node.dataset, dataset);
  node.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
  return node;
}

const state = {
  windows: [],
  tabs: [],
  groups: [],
  lens: 'window',
  kindChip: null,
  onlyWindow: null,
  hoverWindow: null,
  selected: new Set(),
  anchor: null,
  visibleIds: [],
  settings: withDefaults(),
  muted: {},
  docTabs: {},
  thisTabId: null,
  thisWindowId: null,
  dragging: null,
  dirty: false,
};

const tabById = (id) => state.tabs.find((tab) => tab.id === id);
const titleOf = (tab) => rowTitle(tab, state.docTabs);
const tabsIn = (windowId) => state.tabs.filter((tab) => tab.windowId === windowId).sort((a, b) => a.index - b.index);
const nameOfWindow = (windowId) => windowName(tabsIn(windowId), { rules: KIND_RULES, listUrl: LIST_URL, titleOf });
const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

// ---- Reading ----

const timings = { readMs: 0, renderMs: 0 };

async function refresh() {
  const started = performance.now();
  const [windows, tabs, groups, stored, current] = await Promise.all([
    chrome.windows.getAll(),
    chrome.tabs.query({}),
    chrome.tabGroups.query({}),
    chrome.storage.local.get(['settings', 'muted', 'docTabs']),
    chrome.tabs.getCurrent(),
  ]);
  Object.assign(state, {
    windows,
    tabs,
    groups,
    settings: withDefaults(stored.settings),
    muted: liveMutes(stored.muted, Date.now()),
    docTabs: stored.docTabs ?? {},
    thisTabId: current?.id ?? null,
    thisWindowId: current?.windowId ?? null,
  });
  for (const id of [...state.selected]) if (!tabById(id)) state.selected.delete(id);
  if (state.onlyWindow !== null && !windows.some((win) => win.id === state.onlyWindow)) state.onlyWindow = null;
  timings.readMs = performance.now() - started;
  render();
}

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    // Redrawing mid-drag would remove the row being dragged and cancel the drag.
    if (state.dragging) state.dirty = true;
    else refresh();
  }, 80);
}

for (const event of [
  chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onMoved, chrome.tabs.onAttached, chrome.tabs.onDetached,
  chrome.tabs.onUpdated, chrome.tabs.onActivated, chrome.tabs.onReplaced,
  chrome.windows.onCreated, chrome.windows.onRemoved,
  chrome.tabGroups.onCreated, chrome.tabGroups.onUpdated, chrome.tabGroups.onRemoved, chrome.tabGroups.onMoved,
  chrome.storage.onChanged,
]) event.addListener(scheduleRefresh);

// ---- Toasts and undo ----

function toast(message, undo = null) {
  const node = el('div', { className: 'toast' }, el('span', { textContent: message }));
  if (undo) {
    node.append(el('button', {
      textContent: 'Undo',
      onclick: async () => {
        node.remove();
        try {
          await undo();
          await chrome.tabs.update(state.thisTabId, { active: true });
          await chrome.windows.update(state.thisWindowId, { focused: true });
        } catch (error) {
          toast(`Undo failed: ${error.message}`);
        }
      },
    }));
  }
  $('toasts').append(node);
  setTimeout(() => node.remove(), TOAST_MS);
}

async function report(what, action) {
  try {
    return await action();
  } catch (error) {
    toast(`${what} failed: ${error.message}`);
    return undefined;
  }
}

async function undoCloses(records) {
  const remaining = [...records];
  while (remaining.length) {
    // Restoring pops an entry, so ask again each time: the next one may be new to the 25 Chrome shows.
    const entries = await chrome.sessions.getRecentlyClosed();
    const step = nextRestoreStep(entries, remaining);
    if (step.sessionId) {
      await chrome.sessions.restore(step.sessionId);
    } else {
      const { url, windowId, index } = step.missing;
      await chrome.tabs.create({ url, windowId, index, active: false })
        .catch(() => chrome.tabs.create({ url, active: false }));
    }
    for (const record of step.covers) remaining.splice(remaining.indexOf(record), 1);
  }
}

async function closeTabs(ids) {
  const tabs = ids.map(tabById).filter((tab) => tab && tab.id !== state.thisTabId);
  if (!tabs.length) return;
  const records = [];
  const failures = [];
  // One at a time, in order, so Chrome's recently-closed stack holds them the way undo expects. One that fails (it may
  // have closed already) must not stop the rest or lose the undo for those that did close.
  for (const tab of tabs) {
    try {
      await chrome.tabs.remove(tab.id);
      records.push(closeRecord(tab));
    } catch (error) {
      failures.push(error.message);
    }
  }
  state.selected.clear();
  if (records.length) toast(`Closed ${plural(records.length, 'tab')}`, () => undoCloses(records));
  if (failures.length) toast(`Could not close ${plural(failures.length, 'tab')}: ${failures[0]}`);
}

const recordMove = (tab) => moveRecord(tab, state.groups.find((group) => group.id === tab.groupId));

async function undoMoves(records) {
  const windowIds = new Map();
  for (const record of undoMoveOrder(records)) {
    let windowId = windowIds.get(record.fromWindowId) ?? record.fromWindowId;
    const alive = await chrome.windows.get(windowId).then(() => true, () => false);
    if (alive) {
      await chrome.tabs.move(record.tabId, { windowId, index: record.fromIndex });
    } else {
      // Moving a window's last tab out closed that window.
      ({ id: windowId } = await chrome.windows.create({ tabId: record.tabId, focused: false }));
      windowIds.set(record.fromWindowId, windowId);
    }
  }
  const live = (await chrome.tabGroups.query({})).map((group) => group.id);
  for (const { groupId, tabIds, recreate } of groupRestores(records, live)) {
    if (recreate) {
      // Moving a group's last tab out deleted it.
      const { windowId } = await chrome.tabs.get(tabIds[0]);
      const rebuilt = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
      await chrome.tabGroups.update(rebuilt, recreate);
    } else {
      await chrome.tabs.group({ groupId, tabIds });
    }
  }
}

async function moveTabs(ids, windowId, beforeIndex = null) {
  const tabs = ids.map(tabById).filter(Boolean);
  if (!tabs.length) return;
  const strip = (await chrome.tabs.query({ windowId })).sort((a, b) => a.index - b.index).map((tab) => tab.id);
  const records = new Map(tabs.map((tab) => [tab.id, recordMove(tab)]));
  const moved = [];
  let failure = null;
  for (const { id, index } of moveSteps(strip, tabs.map((tab) => tab.id), beforeIndex)) {
    try {
      await chrome.tabs.move(id, { windowId, index });
      moved.push(records.get(id));
    } catch (error) {
      failure = error;
      break;
    }
  }
  state.selected.clear();
  if (moved.length) toast(`Moved ${plural(moved.length, 'tab')}`, () => undoMoves(moved));
  if (failure) toast(`Could not move every tab: ${failure.message}`);
}

async function goToTab(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

async function goToWindow(windowId) {
  await chrome.windows.update(windowId, { focused: true });
}

// ---- Selection ----

function clickRow(event, tab) {
  if (event.shiftKey || event.metaKey || event.ctrlKey) {
    const { selected, anchor } = nextSelection(state.selected, state.visibleIds, state.anchor, tab.id, { range: event.shiftKey });
    state.selected = selected;
    state.anchor = anchor;
    render();
    return;
  }
  report('Going there', () => goToTab(tab));
}

/** The rows a drag or bulk action takes, in visible order so they keep their order. */
function selectionOrder(ids = [...state.selected]) {
  const wanted = new Set(ids);
  return state.visibleIds.filter((id) => wanted.has(id));
}

// ---- Drawing ----

function renderRow(tab, { showWindow = false, realUrlAgainst = null, keeper = false } = {}) {
  const url = realUrlAgainst === null || tab.url !== realUrlAgainst ? tab.url : null;
  const group = state.groups.find((candidate) => candidate.id === tab.groupId);
  const hasIcon = /^(https?|data):/.test(tab.favIconUrl ?? '');
  const row = el('div', {
    className: `row${state.selected.has(tab.id) ? ' selected' : ''}${keeper ? ' keeper' : ''}`,
    draggable: true,
    onclick: (event) => clickRow(event, tab),
    dataset: { tab: tab.id, window: tab.windowId, index: tab.index },
  },
  hasIcon ? el('img', { src: tab.favIconUrl, alt: '', loading: 'lazy' }) : el('span', { className: 'no-icon' }),
  el('div', { className: 'row-text' },
    el('div', { className: 'row-title', textContent: titleOf(tab), title: titleOf(tab) }),
    url && state.lens !== 'window' ? el('div', { className: 'row-url', textContent: url, title: url }) : null),
  tab.pinned ? el('span', { className: 'pill', textContent: 'pinned' }) : null,
  group ? el('span', { className: 'pill', textContent: group.title || 'group' }) : null,
  showWindow ? el('span', { className: 'pill', textContent: nameOfWindow(tab.windowId) }) : null,
  el('div', { className: 'row-actions' },
    tab.windowId !== state.thisWindowId
      ? el('button', {
        textContent: 'Move here',
        onclick: (event) => {
          event.stopPropagation();
          report('Move', () => moveTabs([tab.id], state.thisWindowId));
        },
      })
      : null,
    tab.id !== state.thisTabId
      ? el('button', {
        textContent: 'Close',
        onclick: (event) => {
          event.stopPropagation();
          report('Close', () => closeTabs([tab.id]));
        },
      })
      : null));
  return row;
}

function section(headChildren, rows, dataset = {}) {
  return el('section', { className: 'section', dataset }, el('div', { className: 'section-head' }, ...headChildren), ...rows);
}

function renderByWindow(visible) {
  return orderWindows(state.windows, state.thisWindowId).flatMap((win) => {
    const tabs = visible.filter((tab) => tab.windowId === win.id).sort((a, b) => a.index - b.index);
    if (!tabs.length) return [];
    const mine = win.id === state.thisWindowId;
    const others = tabsIn(win.id).map((tab) => tab.id);
    return [section([
      el('h2', { textContent: nameOfWindow(win.id) }),
      mine ? el('span', { className: 'pill', textContent: 'here' }) : null,
      el('span', { className: 'muted', textContent: plural(tabsIn(win.id).length, 'tab') }),
      el('button', { textContent: 'Go there', onclick: () => report('Going there', () => goToWindow(win.id)) }),
      mine ? null : el('button', {
        textContent: 'Move all here',
        onclick: () => report('Move', () => moveTabs(others, state.thisWindowId)),
      }),
    ], tabs.map((tab) => renderRow(tab)), { dropWindow: win.id })];
  });
}

function renderByKind(visible) {
  return groupByKind(visible, KIND_RULES).map((group) => section([
    el('h2', { textContent: group.name }),
    el('span', { className: 'muted', textContent: plural(group.tabs.length, 'tab') }),
  ], group.tabs.map((tab) => renderRow(tab, { showWindow: true }))));
}

function downloadJson(name, value) {
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' }));
  const link = el('a', { href: url, download: `${name.replace(/[^\w.-]+/g, '-')}.json` });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function renderByGroup(visible) {
  const { groups, loose } = groupSections(visible, state.groups);
  const sections = groups.map(({ group, tabs }) => {
    const whole = state.tabs.filter((tab) => tab.groupId === group.id).sort((a, b) => a.index - b.index);
    const name = group.title || 'Untitled group';
    return section([
      el('h2', { textContent: name }),
      el('span', { className: 'pill', textContent: group.color }),
      el('span', { className: 'muted', textContent: plural(whole.length, 'tab') }),
      el('button', {
        textContent: 'Copy',
        onclick: () => report('Copy', async () => {
          await navigator.clipboard.writeText(formatSection(name, whole));
          toast(`Copied ${name}`);
        }),
      }),
      el('button', { textContent: 'Save', onclick: () => downloadJson(name, groupLayout(group, whole)) }),
    ], tabs.map((tab) => renderRow(tab, { showWindow: true })));
  });
  if (loose.length) {
    sections.push(section([
      el('h2', { textContent: 'In no group' }),
      el('span', { className: 'muted', textContent: plural(loose.length, 'tab') }),
    ], loose.map((tab) => renderRow(tab, { showWindow: true }))));
  }
  return sections;
}

function renderDuplicates(visible) {
  const shown = new Set(visible.map((tab) => tab.id));
  const groups = duplicateGroups(state.tabs, ALIASES).filter((group) => group.tabs.some((tab) => shown.has(tab.id)));
  if (!groups.length) return [el('div', { className: 'empty', textContent: 'No duplicates.' })];
  const allExtras = groups.flatMap((group) => group.extras.map((tab) => tab.id));
  return [
    el('div', { className: 'selection-bar' },
      el('button', {
        textContent: `Close ${plural(allExtras.length, 'duplicate')}`,
        onclick: () => report('Close', () => closeTabs(allExtras)),
      })),
    ...groups.map((group) => section([
      el('h2', { textContent: titleOf(group.keeper) }),
      el('button', {
        textContent: `Close ${group.extras.length} ${group.extras.length === 1 ? 'extra' : 'extras'}, keep the original`,
        onclick: () => report('Close', () => closeTabs(group.extras.map((tab) => tab.id))),
      }),
    ], group.tabs.map((tab) => renderRow(tab, { showWindow: true, realUrlAgainst: group.key, keeper: tab === group.keeper })))),
  ];
}

const LENSES = { window: renderByWindow, kind: renderByKind, group: renderByGroup, duplicates: renderDuplicates };

function windowChip(win, { marked = true } = {}) {
  const mine = win.id === state.thisWindowId;
  return el('button', {
    className: `chip${state.onlyWindow === win.id ? ' on' : ''}`,
    title: nameOfWindow(win.id),
    dataset: { chipWindow: win.id, dropChip: win.id },
  }, `${nameOfWindow(win.id)} (${tabsIn(win.id).length})`, marked && mine ? el('span', { className: 'here', textContent: 'here' }) : null);
}

function renderStrip() {
  $('strip').replaceChildren(...orderWindows(state.windows, state.thisWindowId).map((win) => windowChip(win)));
}

function renderKinds() {
  $('kinds').replaceChildren(...kindCounts(state.tabs, KIND_RULES).map(({ kind, count }) => el('button', {
    className: `chip${state.kindChip === kind ? ' on' : ''}`,
    textContent: `${kind} ${count}`,
    onclick: () => {
      state.kindChip = state.kindChip === kind ? null : kind;
      render();
    },
  })));
}

function renderMuted() {
  const urls = Object.keys(state.muted);
  $('muted').replaceChildren(...urls.map((url) => el('div', { className: 'muted-url' },
    el('span', { textContent: `Muted: ${url}`, title: url }),
    el('button', {
      textContent: 'Resume',
      onclick: async () => {
        const { [url]: dropped, ...rest } = state.muted;
        await chrome.storage.local.set({ muted: rest });
      },
    }))));
}

function renderSelectionBar() {
  const bar = $('selection-bar');
  const ids = selectionOrder();
  bar.hidden = ids.length === 0;
  if (bar.hidden) return;
  bar.replaceChildren(
    el('span', { textContent: `${ids.length} selected` }),
    el('button', { textContent: 'Move here', onclick: () => report('Move', () => moveTabs(selectionOrder(), state.thisWindowId)) }),
    el('button', { textContent: 'Close', onclick: () => report('Close', () => closeTabs(selectionOrder())) }),
    el('button', {
      textContent: 'Clear',
      onclick: () => {
        state.selected.clear();
        render();
      },
    }),
  );
}

function render() {
  const started = performance.now();
  const visible = visibleTabs(state.tabs, {
    filter: $('filter').value,
    kindChip: state.kindChip,
    onlyWindow: state.onlyWindow,
    rules: KIND_RULES,
    docTabs: state.docTabs,
  });

  $('total').textContent = `${state.tabs.length} in ${plural(state.windows.length, 'window')}`;
  $('ask-enabled').checked = state.settings.askEnabled;
  $('auto-reload').checked = state.settings.autoReload;
  $('bridge-enabled').checked = state.settings.bridgeEnabled;
  for (const button of $('lenses').children) button.classList.toggle('on', button.dataset.lens === state.lens);

  renderStrip();
  renderKinds();
  renderMuted();
  const sections = LENSES[state.lens](visible);
  $('sections').replaceChildren(...(sections.length ? sections : [el('div', { className: 'empty', textContent: 'Nothing matches.' })]));
  state.visibleIds = [...$('sections').querySelectorAll('.row')].map((row) => Number(row.dataset.tab));
  renderSelectionBar();
  applyHighlight(); // A live update redraws the rows, and the pointer may still be on a chip.
  timings.renderMs = performance.now() - started;
}

// ---- Window strip ----

function applyHighlight() {
  for (const row of document.querySelectorAll('#sections .row')) {
    row.classList.toggle('highlight', state.hoverWindow !== null && Number(row.dataset.window) === state.hoverWindow);
  }
}

function highlightWindow(windowId) {
  state.hoverWindow = windowId;
  applyHighlight();
}

// Delegated, since a click redraws the chips and a double-click's second click lands on a new element.
$('strip').addEventListener('click', (event) => {
  const chip = event.target.closest('[data-chip-window]');
  if (!chip) return;
  const windowId = Number(chip.dataset.chipWindow);
  state.onlyWindow = state.onlyWindow === windowId ? null : windowId;
  render();
});
$('strip').addEventListener('dblclick', (event) => {
  const chip = event.target.closest('[data-chip-window]');
  if (chip) report('Going there', () => goToWindow(Number(chip.dataset.chipWindow)));
});
$('strip').addEventListener('mouseover', (event) => {
  const chip = event.target.closest('[data-chip-window]');
  highlightWindow(chip ? Number(chip.dataset.chipWindow) : null);
});
$('strip').addEventListener('mouseleave', () => highlightWindow(null));

// ---- Drag and drop ----

function clearDropMarks() {
  $('drop-line').hidden = true;
  for (const node of document.querySelectorAll('.drop-target')) node.classList.remove('drop-target');
}

function showTray() {
  const tray = $('tray');
  tray.replaceChildren(...orderWindows(state.windows, state.thisWindowId).map((win) => windowChip(win)));
  tray.hidden = false;
}

function endDrag() {
  state.dragging = null;
  document.body.classList.remove('dragging');
  $('tray').hidden = true;
  clearDropMarks();
  if (state.dirty) {
    state.dirty = false;
    refresh();
  }
}

document.addEventListener('dragstart', (event) => {
  const row = event.target.closest?.('.row');
  if (!row) return;
  const id = Number(row.dataset.tab);
  state.dragging = state.selected.has(id) ? selectionOrder() : [id];
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', String(id));
  document.body.classList.add('dragging');
  showTray();
});

document.addEventListener('dragend', endDrag);

/** Where a drop at this pointer lands: a chip means the end of that window, a section means before a row. */
function dropTargetAt(event) {
  const chip = event.target.closest?.('[data-drop-chip]');
  if (chip) return { chip, windowId: Number(chip.dataset.dropChip), beforeIndex: null };
  const sectionNode = event.target.closest?.('[data-drop-window]');
  if (!sectionNode) return null;
  const rows = [...sectionNode.querySelectorAll('.row')];
  const before = rows.find((row) => {
    const box = row.getBoundingClientRect();
    return event.clientY < box.top + box.height / 2;
  });
  const last = rows.at(-1);
  return {
    sectionNode,
    rows,
    before,
    windowId: Number(sectionNode.dataset.dropWindow),
    beforeIndex: before ? Number(before.dataset.index) : Number(last.dataset.index) + 1,
  };
}

document.addEventListener('dragover', (event) => {
  if (!state.dragging) return;
  const target = dropTargetAt(event);
  clearDropMarks();
  if (!target) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  if (target.chip) {
    target.chip.classList.add('drop-target');
    return;
  }
  const anchor = target.before ?? target.rows.at(-1);
  const box = anchor.getBoundingClientRect();
  const line = $('drop-line');
  line.hidden = false;
  line.style.left = `${box.left}px`;
  line.style.width = `${box.width}px`;
  line.style.top = `${(target.before ? box.top : box.bottom) - 1}px`;
});

document.addEventListener('drop', (event) => {
  if (!state.dragging) return;
  const target = dropTargetAt(event);
  const ids = state.dragging;
  if (!target) return;
  event.preventDefault();
  report('Move', () => moveTabs(ids, target.windowId, target.beforeIndex));
});

// ---- The top of the page ----

$('lenses').addEventListener('click', (event) => {
  const lens = event.target.dataset?.lens;
  if (!lens) return;
  state.lens = lens;
  render();
});

async function saveSetting(name, value) {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...withDefaults(settings), [name]: value } });
}

$('ask-enabled').addEventListener('change', (event) => saveSetting('askEnabled', event.target.checked));
$('auto-reload').addEventListener('change', (event) => saveSetting('autoReload', event.target.checked));
$('bridge-enabled').addEventListener('change', (event) => saveSetting('bridgeEnabled', event.target.checked));

$('refresh').addEventListener('click', () => refresh());
$('filter').addEventListener('input', () => render());

$('save-layout').addEventListener('click', async () => {
  const name = `layout-${new Date().toISOString().slice(0, 10)}`;
  downloadJson(name, buildLayout({ name, windows: state.windows, tabs: state.tabs, groups: state.groups }));
});

$('restore-layout').addEventListener('click', () => $('layout-file').click());
$('layout-file').addEventListener('change', (event) => report('Restore', async () => {
  const [file] = event.target.files;
  event.target.value = '';
  if (!file) return;
  let layout;
  try {
    layout = JSON.parse(await file.text());
  } catch {
    toast(`${file.name} is not JSON. Nothing opened.`);
    return;
  }
  const outcome = await chrome.runtime.sendMessage({ type: 'restore-layout', layout });
  if (outcome.error) throw new Error(outcome.error);
  if (outcome.errors.length) {
    toast(`Nothing opened. ${file.name}: ${outcome.errors.join('; ')}`);
    return;
  }
  const skipped = outcome.skipped.length
    ? ` Skipped ${outcome.skipped.map((tab) => tab.title || 'a placeholder').join(', ')}.`
    : '';
  toast(`Restored ${plural(outcome.windows, 'window')}: ${outcome.opened} opened, ${outcome.moved} moved.${skipped}`);
}));

$('open-section').addEventListener('click', () => report('Open section', async () => {
  const { name, links } = parseSection(await navigator.clipboard.readText());
  if (!links.length) {
    toast('No links on the clipboard.');
    return;
  }
  const windowId = state.thisWindowId;
  const openTabs = (await chrome.tabs.query({})).filter((tab) => tab.id !== state.thisTabId);
  const matches = matchOpenTabs(links.map((link) => link.url), openTabs);
  const moved = matches.filter(Boolean);
  const records = moved.map(recordMove);
  const tabIds = [];
  const created = [];
  for (const [i, link] of links.entries()) {
    const open = matches[i];
    if (open) {
      await chrome.tabs.move(open.id, { windowId, index: -1 });
      if (open.pinned) await chrome.tabs.update(open.id, { pinned: false });
      tabIds.push(open.id);
    } else {
      const { id } = await chrome.tabs.create({ windowId, url: link.url, active: false });
      created.push(id);
      tabIds.push(id);
    }
  }
  const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
  await chrome.tabGroups.update(groupId, { title: name });
  toast(`Opened ${name}: ${created.length} new, ${moved.length} moved in`, async () => {
    // Tolerant of a new tab already closed by hand: that must not stop the moved ones going back.
    for (const id of created) await chrome.tabs.remove(id).catch(() => {});
    // Chrome rejects an empty list, which is what an all-new section has.
    if (moved.length) await chrome.tabs.ungroup(moved.map((tab) => tab.id));
    await undoMoves(records);
    for (const tab of moved) if (tab.pinned) await chrome.tabs.update(tab.id, { pinned: true });
  });
}));

// ---- Keys ----

document.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const inFilter = event.target === $('filter');
  if (event.key === 'Escape') {
    if ($('filter').value) {
      $('filter').value = '';
      $('filter').blur();
      render();
    } else if (state.selected.size) {
      state.selected.clear();
      render();
    } else if (inFilter) {
      $('filter').blur();
    }
    return;
  }
  if (inFilter) return;
  if (event.key === '/') {
    event.preventDefault();
    $('filter').focus();
    return;
  }
  if (/^[1-9]$/.test(event.key)) {
    const win = orderWindows(state.windows, state.thisWindowId)[Number(event.key) - 1];
    if (win) {
      state.onlyWindow = win.id;
      render();
    }
  }
});

// ---- Load time ----

await refresh();

const loaded = performance.now();
const load = $('load-time');
load.textContent = `Loaded in ${Math.round(loaded)} ms`;
const [nav] = performance.getEntriesByType('navigation');
load.title = [
  nav ? `HTML parsed: ${Math.round(nav.domInteractive)} ms` : null,
  `Modules ready: ${Math.round(scriptStart)} ms`,
  `Read tabs: ${Math.round(timings.readMs)} ms`,
  `Drew: ${Math.round(timings.renderMs)} ms`,
].filter(Boolean).join('\n');
