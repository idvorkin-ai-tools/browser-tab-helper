import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { COLORS, buildLayout, groupLayout, matchOpenTabs, planRestore, validateLayout } from '../src/lib/layouts.js';

const LAYOUTS = new URL('../layouts/', import.meta.url);
const good = (items) => ({ version: 1, name: 'x', windows: [{ items }] });

test('every file in layouts/ is valid', () => {
  const files = readdirSync(LAYOUTS).filter((name) => name.endsWith('.json'));
  assert.ok(files.length > 0);
  for (const name of files) {
    const layout = JSON.parse(readFileSync(new URL(name, LAYOUTS), 'utf8'));
    assert.deepEqual(validateLayout(layout), [], name);
  }
});

test('validate accepts the issue format', () => {
  assert.deepEqual(validateLayout(good([
    { title: 'Some page', url: 'https://a.test/', pinned: true },
    { group: 'Reading', color: 'blue', collapsed: false, tabs: [{ title: 'b', url: 'http://b.test/' }] },
    { title: 'Not found yet', url: null, todo: 'why' },
  ])), []);
});

test('the colours are Chrome\'s', () => {
  assert.deepEqual(COLORS, ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']);
  for (const color of COLORS) assert.deepEqual(validateLayout(good([{ group: 'g', color, tabs: [] }])), []);
});

test('validate reports each kind of error', () => {
  const cases = [
    [good([{ group: 'g', color: 'magenta', tabs: [] }]), /unknown colour: magenta/],
    [good([{ title: 't', url: 'file:///etc/hosts' }]), /not an http\(s\) URL/],
    [good([{ title: 't', url: 'chrome://settings/' }]), /not an http\(s\) URL/],
    [good([{ title: 't', url: 'nonsense' }]), /not an http\(s\) URL/],
    [good([{ title: 't' }]), /no url/],
    [good([{ group: 'g', tabs: [{ title: 't', url: 'javascript:alert(1)' }] }]), /not an http\(s\) URL/],
    [good([{ group: 'g' }]), /tabs is not a list/],
    [good([{ group: 'g', tabs: [{ url: 'https://a.test/', pinned: true }] }]), /pinned tab cannot be in a group/],
    [good([{ url: 'https://a.test/', pinned: 'yes' }]), /pinned/],
    [{ version: 2, windows: [] }, /unknown version/],
    [{ version: 1 }, /windows is not a list/],
    [{ version: 1, windows: [{}] }, /items is not a list/],
    [null, /not an object/],
    [[], /not an object/],
  ];
  for (const [layout, pattern] of cases) {
    assert.match(validateLayout(layout).join('\n'), pattern);
  }
});

test('every error is reported, not just the first', () => {
  const errors = validateLayout(good([
    { group: 'g', color: 'magenta', tabs: [] },
    { title: 't', url: 'ftp://a.test/' },
  ]));
  assert.equal(errors.length, 2);
});

const WINDOWS = [{ id: 1, type: 'normal' }, { id: 2, type: 'popup' }, { id: 3, type: 'normal' }];
const GROUPS = [{ id: 7, title: 'Reading', color: 'blue', collapsed: true }];

test('save keeps item order, with loose tabs before, between and after groups', () => {
  const tabs = [
    { windowId: 1, index: 3, url: 'https://d.test/', title: 'd', groupId: 7 },
    { windowId: 1, index: 0, url: 'https://a.test/', title: 'a', groupId: -1, pinned: true },
    { windowId: 1, index: 1, url: 'https://b.test/', title: 'b', groupId: 7 },
    { windowId: 1, index: 2, url: 'https://c.test/', title: 'c - Google Docs', groupId: -1 },
    { windowId: 1, index: 4, url: 'https://e.test/', title: 'e', groupId: -1 },
  ];
  const layout = buildLayout({ name: 'home', windows: WINDOWS, tabs, groups: GROUPS });
  assert.deepEqual(layout.windows[0].items, [
    { title: 'a', url: 'https://a.test/', pinned: true },
    { group: 'Reading', color: 'blue', collapsed: true, tabs: [{ title: 'b', url: 'https://b.test/' }] },
    { title: 'c', url: 'https://c.test/' },
    { group: 'Reading', color: 'blue', collapsed: true, tabs: [{ title: 'd', url: 'https://d.test/' }] },
    { title: 'e', url: 'https://e.test/' },
  ]);
  assert.equal(layout.version, 1);
  assert.equal(layout.name, 'home');
});

test('save skips browser pages and non-normal windows, and always validates', () => {
  const tabs = ['chrome://settings/', 'chrome-extension://abc/x.html', 'about:blank', 'devtools://devtools/x', 'file:///tmp/a', 'view-source:https://a.test/']
    .map((url, index) => ({ windowId: 1, index, url, title: url, groupId: -1 }));
  tabs.push({ windowId: 1, index: 9, url: 'https://kept.test/', title: 'kept', groupId: -1 });
  tabs.push({ windowId: 2, index: 0, url: 'https://popup.test/', title: 'popup', groupId: -1 });
  tabs.push({ windowId: 3, index: 0, url: 'chrome://newtab/', title: 'only internal', groupId: -1 });
  const layout = buildLayout({ windows: WINDOWS, tabs });
  assert.deepEqual(layout.windows, [{ items: [{ title: 'kept', url: 'https://kept.test/' }] }]);
  assert.deepEqual(validateLayout(layout), []);
});

test('save stores the real URL as it stands, tracking params and all', () => {
  const url = 'https://a.test/x?utm_source=y#frag';
  const layout = buildLayout({ windows: WINDOWS, tabs: [{ windowId: 1, index: 0, url, title: 't', groupId: -1 }] });
  assert.equal(layout.windows[0].items[0].url, url);
});

test('a one-group layout restores on its own', () => {
  const layout = groupLayout({ id: 7, title: 'Reading', color: 'red', collapsed: false }, [
    { index: 1, url: 'https://b.test/', title: 'b' },
    { index: 0, url: 'https://a.test/', title: 'a' },
    { index: 2, url: 'chrome://settings/', title: 'no' },
  ]);
  assert.deepEqual(validateLayout(layout), []);
  assert.equal(layout.name, 'Reading');
  assert.deepEqual(layout.windows[0].items[0].tabs.map((t) => t.title), ['a', 'b']);
  assert.equal(planRestore(layout, []).windows[0].items[0].title, 'Reading');
});

test('restore matches open tabs by normalized URL, never by title', () => {
  const layout = good([
    { title: 'Stale title', url: 'https://a.test/x?utm_source=y' },
    { title: 'Same title as an open tab', url: 'https://other.test/' },
  ]);
  const open = [
    { id: 11, url: 'https://www.a.test/x/', title: 'New title' },
    { id: 12, url: 'https://elsewhere.test/', title: 'Same title as an open tab' },
  ];
  const { windows } = planRestore(layout, open);
  assert.equal(windows[0].items[0].tabId, 11);
  assert.equal(windows[0].items[1].tabId, null);
});

test('a fragment-only difference is not the same tab on restore either', () => {
  const { windows } = planRestore(good([{ url: 'https://a.test/#one' }]), [{ id: 1, url: 'https://a.test/#two' }]);
  assert.equal(windows[0].items[0].tabId, null);
});

test('each open tab is used once', () => {
  assert.deepEqual(matchOpenTabs(['https://a.test/', 'https://a.test/'], [{ id: 1, url: 'https://a.test/' }]).map((t) => t?.id ?? null), [1, null]);
});

test('placeholders are skipped; a group of only placeholders is not created', () => {
  const { windows, skipped } = planRestore(good([
    { title: 'p1', url: null, todo: 'why' },
    { group: 'empty', tabs: [{ title: 'p2', url: null }] },
    { group: 'mixed', tabs: [{ title: 'p3', url: null }, { title: 'real', url: 'https://a.test/' }] },
  ]), []);
  assert.deepEqual(skipped.map((s) => s.title), ['p1', 'p2', 'p3']);
  assert.equal(skipped[0].todo, 'why');
  assert.equal(windows[0].items.length, 1);
  assert.equal(windows[0].items[0].title, 'mixed');
  assert.equal(windows[0].items[0].tabs.length, 1);
});

test('a window of only placeholders opens no window', () => {
  assert.deepEqual(planRestore(good([{ url: null }]), []).windows, []);
});

test('restore keeps items in order, with their matches in the right places', () => {
  const layout = good([
    { url: 'https://a.test/' },
    { group: 'g', color: 'cyan', collapsed: true, tabs: [{ url: null }, { url: 'https://b.test/' }] },
    { url: 'https://c.test/', pinned: true },
  ]);
  const { windows } = planRestore(layout, [{ id: 3, url: 'https://c.test/' }, { id: 2, url: 'https://b.test/' }]);
  assert.deepEqual(windows[0].items, [
    { kind: 'tab', url: 'https://a.test/', pinned: false, tabId: null },
    { kind: 'group', title: 'g', color: 'cyan', collapsed: true, tabs: [{ url: 'https://b.test/', pinned: false, tabId: 2 }] },
    { kind: 'tab', url: 'https://c.test/', pinned: true, tabId: 3 },
  ]);
});

test('a URL must be a string: an array that stringifies to a good URL is refused', () => {
  assert.match(validateLayout(good([{ url: ['https://a.test/'] }])).join(), /not an http\(s\) URL/);
  assert.match(validateLayout(good([{ group: 'g', tabs: [{ url: ['https://a.test/'] }] }])).join(), /not an http\(s\) URL/);
  assert.match(validateLayout(good([{ url: { toString: 'x' } }])).join(), /not an http\(s\) URL/);
  assert.match(validateLayout(good([{ url: 5 }])).join(), /not an http\(s\) URL/);
});
