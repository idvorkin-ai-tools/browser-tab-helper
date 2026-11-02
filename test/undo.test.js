import test from 'node:test';
import assert from 'node:assert/strict';
import { closeRecord, dropIndex, moveRecord, nextRestoreStep, undoMoveOrder } from '../src/lib/undo.js';

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
  const records = moved.map(moveRecord);
  moved.forEach((tab, i) => move(strip, tab.id, 3 + i));
  assert.notDeepEqual(strip.map((t) => t.url), ['a', 'b', 'c', 'd', 'e', 'f']);
  for (const record of undoMoveOrder([...records].reverse())) move(strip, record.tabId, record.fromIndex);
  assert.deepEqual(strip.map((t) => t.url), ['a', 'b', 'c', 'd', 'e', 'f']);
});

test('dropIndex accounts for moved tabs that leave from the left of the drop point', () => {
  const tabs = [{ windowId: 1, index: 0 }, { windowId: 1, index: 5 }, { windowId: 2, index: 1 }];
  assert.equal(dropIndex(tabs, 1, 3), 2, 'one target-window tab sits left of index 3');
  assert.equal(dropIndex(tabs, 2, 1), 1, 'a tab at the drop point does not shift it');
  assert.equal(dropIndex(tabs, 3, 4), 4, 'all from other windows');
  assert.equal(dropIndex(tabs, 1, null), -1, 'null is the end');
});
