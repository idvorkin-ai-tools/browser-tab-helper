import test from 'node:test';
import assert from 'node:assert/strict';
import { closeRecord, groupRestores, moveRecord, moveSteps, nextRestoreStep, undoMoveOrder } from '../src/lib/undo.js';

// A stand-in for Chrome's tab strip and its sessions stack, so the ordering rule is tested as behaviour:
// closing pushes an entry with the index the tab left from, restoring puts it back at that index.
class FakeStrip {
  constructor(urls) {
    this.tabs = urls.map((url, id) => ({ id, url, windowId: 1 }));
    this.stack = [];
    this.nextSession = 1;
  }
  get urls() {
    return this.tabs.map((tab) => tab.url);
  }
  close(url) {
    const index = this.tabs.findIndex((tab) => tab.url === url);
    const [tab] = this.tabs.splice(index, 1);
    this.stack.unshift({ tab: { url, sessionId: String(this.nextSession++) }, index });
    return closeRecord({ ...tab, index });
  }
  recentlyClosed(max = 25) {
    return this.stack.slice(0, max);
  }
  restore(sessionId) {
    const at = this.stack.findIndex((entry) => entry.tab.sessionId === sessionId);
    const [entry] = this.stack.splice(at, 1);
    this.tabs.splice(entry.index, 0, { id: 1000 + at, url: entry.tab.url, windowId: 1 });
  }
}

function undo(strip, records) {
  const remaining = [...records];
  while (remaining.length) {
    const step = nextRestoreStep(strip.recentlyClosed(), remaining);
    assert.ok(step.sessionId, `no entry for ${step.missing?.url}`);
    strip.restore(step.sessionId);
    for (const record of step.covers) remaining.splice(remaining.indexOf(record), 1);
  }
}

test('undoing several closes brings them back in their original places', () => {
  const strip = new FakeStrip(['a', 'b', 'c', 'd', 'e']);
  const records = ['b', 'c', 'e'].map((url) => strip.close(url));
  assert.deepEqual(strip.urls, ['a', 'd']);
  undo(strip, records);
  assert.deepEqual(strip.urls, ['a', 'b', 'c', 'd', 'e']);
});

test('the order holds whichever order the tabs closed in', () => {
  const strip = new FakeStrip(['a', 'b', 'c', 'd']);
  const records = ['c', 'a', 'd'].map((url) => strip.close(url));
  undo(strip, records);
  assert.deepEqual(strip.urls, ['a', 'b', 'c', 'd']);
});

test('the first restore is the most recently closed', () => {
  const strip = new FakeStrip(['a', 'b']);
  const records = ['a', 'b'].map((url) => strip.close(url));
  const step = nextRestoreStep(strip.recentlyClosed(), records);
  assert.equal(strip.stack.find((entry) => entry.tab.sessionId === step.sessionId).tab.url, 'b');
});

test('a tab you closed yourself since is left alone', () => {
  const strip = new FakeStrip(['a', 'b', 'c']);
  const records = [strip.close('b')];
  strip.close('c');
  undo(strip, records);
  assert.deepEqual(strip.urls, ['a', 'b']);
  assert.equal(strip.stack[0].tab.url, 'c');
});

test('more than the 25 entries Chrome shows at once still all come back', () => {
  const urls = Array.from({ length: 40 }, (_, i) => `u${i}`);
  const strip = new FakeStrip(urls);
  const records = urls.map((url) => strip.close(url));
  undo(strip, records);
  assert.deepEqual(strip.urls, urls);
});

test('a whole-window entry restores once and covers its tabs', () => {
  const records = [{ url: 'a' }, { url: 'b' }, { url: 'c' }];
  const entries = [{ window: { sessionId: 'w', tabs: [{ url: 'b' }, { url: 'c' }] } }, { tab: { sessionId: 't', url: 'a' } }];
  const step = nextRestoreStep(entries, records);
  assert.equal(step.sessionId, 'w');
  assert.deepEqual(step.covers.map((r) => r.url), ['b', 'c']);
});

test('a tab Chrome did not keep is reported missing, not guessed', () => {
  const records = [{ url: 'chrome://newtab/' }];
  assert.deepEqual(nextRestoreStep([{ tab: { sessionId: 't', url: 'other' } }], records), { missing: records[0], covers: records });
  assert.equal(nextRestoreStep([], []), null);
});

test('undoing moves puts every tab back, whatever moved', () => {
  const move = (strip, id, index) => {
    const from = strip.findIndex((tab) => tab.id === id);
    const [tab] = strip.splice(from, 1);
    strip.splice(index, 0, tab);
  };
  const original = ['a', 'b', 'c', 'd', 'e', 'f'].map((url, id) => ({ id, url, windowId: 1, index: id }));
  const strip = [...original];
  const moved = [original[1], original[2], original[4]];
  const records = moved.map((tab) => moveRecord(tab));
  moved.forEach((tab, i) => move(strip, tab.id, 3 + i));
  assert.notDeepEqual(strip.map((t) => t.url), ['a', 'b', 'c', 'd', 'e', 'f']);
  for (const record of undoMoveOrder([...records].reverse())) move(strip, record.tabId, record.fromIndex);
  assert.deepEqual(strip.map((t) => t.url), ['a', 'b', 'c', 'd', 'e', 'f']);
});

// Chrome's semantics for one tab: it ends up at `index`, measured after it has left. -1 is the end.
function applySteps(strip, steps) {
  const out = [...strip];
  for (const { id, index } of steps) {
    const from = out.indexOf(id);
    if (from >= 0) out.splice(from, 1);
    out.splice(index < 0 ? out.length : index, 0, id);
  }
  return out;
}

test('moveSteps: several rows dragged rightward keep their order', () => {
  const strip = ['A', 'B', 'C', 'D', 'E'];
  assert.deepEqual(applySteps(strip, moveSteps(strip, ['A', 'B'], 3)), ['C', 'A', 'B', 'D', 'E']);
  assert.deepEqual(applySteps(strip, moveSteps(strip, ['A', 'C'], 4)), ['B', 'D', 'A', 'C', 'E']);
});

test('moveSteps: leftward, to the end, and across the drop point', () => {
  const strip = ['A', 'B', 'C', 'D', 'E'];
  assert.deepEqual(applySteps(strip, moveSteps(strip, ['D', 'E'], 1)), ['A', 'D', 'E', 'B', 'C']);
  assert.deepEqual(applySteps(strip, moveSteps(strip, ['B', 'D'], null)), ['A', 'C', 'E', 'B', 'D']);
  assert.deepEqual(applySteps(strip, moveSteps(strip, ['A', 'E'], 2)), ['B', 'A', 'E', 'C', 'D']);
  assert.deepEqual(applySteps(strip, moveSteps(strip, ['E', 'A'], 2)), ['B', 'E', 'A', 'C', 'D'], 'selection order wins');
});

test('moveSteps: dropping on a row that is itself moving lands before the next one that is not', () => {
  const strip = ['A', 'B', 'C', 'D'];
  assert.deepEqual(applySteps(strip, moveSteps(strip, ['A', 'B'], 1)), ['A', 'B', 'C', 'D']);
  assert.deepEqual(applySteps(strip, moveSteps(strip, ['D', 'B'], 1)), ['A', 'D', 'B', 'C']);
});

test('moveSteps: tabs from another window come in at the drop point, in order', () => {
  const strip = ['A', 'B'];
  assert.deepEqual(applySteps(strip, moveSteps(strip, ['X', 'Y'], 1)), ['A', 'X', 'Y', 'B']);
  assert.deepEqual(applySteps(strip, moveSteps(strip, ['X', 'A'], 2)), ['B', 'X', 'A']);
  assert.deepEqual(applySteps(strip, moveSteps(strip, ['X', 'Y'], null)), ['A', 'B', 'X', 'Y']);
});

test('moveSteps holds for every subset and drop point of a strip', () => {
  const strip = ['A', 'B', 'C', 'D', 'E'];
  for (let mask = 1; mask < 32; mask++) {
    const moving = strip.filter((_, i) => mask & (1 << i));
    for (let before = 0; before <= strip.length; before++) {
      const at = before === strip.length ? null : before;
      const result = applySteps(strip, moveSteps(strip, moving, at));
      const rest = strip.filter((id) => !moving.includes(id));
      const anchor = strip.slice(before).find((id) => !moving.includes(id));
      const place = anchor ? rest.indexOf(anchor) : rest.length;
      assert.deepEqual(result, [...rest.slice(0, place), ...moving, ...rest.slice(place)], `${moving} before ${at}`);
    }
  }
});

test('moveRecord remembers what is needed to bring a group back', () => {
  const group = { id: 7, title: 'Reading', color: 'red', collapsed: true, windowId: 1 };
  const record = moveRecord({ id: 1, windowId: 2, index: 3, groupId: 7 }, group);
  assert.deepEqual(record.group, { title: 'Reading', color: 'red', collapsed: true });
  assert.equal(moveRecord({ id: 1, windowId: 2, index: 3, groupId: -1 }).group, null);
});

test('groupRestores: a live group is rejoined, an emptied one is rebuilt once with all its tabs', () => {
  const group = { title: 'T', color: 'blue', collapsed: false };
  const records = [
    { tabId: 1, groupId: 7, group },
    { tabId: 2, groupId: 7, group },
    { tabId: 3, groupId: 8, group: { title: 'Live', color: 'red', collapsed: false } },
    { tabId: 4, groupId: -1, group: null },
  ];
  assert.deepEqual(groupRestores(records, [8]), [
    { groupId: 7, tabIds: [1, 2], recreate: group },
    { groupId: 8, tabIds: [3], recreate: null },
  ]);
});
