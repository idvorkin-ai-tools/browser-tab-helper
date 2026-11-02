import test from 'node:test';
import assert from 'node:assert/strict';
import { compileRules, decideCard, doorOf, duplicateGroups, liveMutes, redundantCount, MUTE_MS } from '../src/lib/duplicates.js';
import { boundShortcuts, buildCard } from '../src/lib/card.js';
import { ALIAS_RULES } from '../src/data/aliases.js';
import { normalizeUrl } from '../src/lib/normalize.js';

const tab = (id, url, extra = {}) => ({ id, url, windowId: 1, title: `t${id}`, ...extra });
const RULES = compileRules([{
  name: 'Mail',
  canonical: 'https://mail.example.com/inbox',
  canonicalPattern: '^https://mail\\.example\\.com/',
  otherDoors: ['^https://example\\.com/mail'],
}]);

test('a new tab on an open page asks, pointing at the older one', () => {
  const lander = tab(5, 'https://a.test/x?utm_source=y');
  const older = tab(2, 'https://www.a.test/x');
  const decision = decideCard(lander, [older, lander, tab(3, 'https://a.test/other')]);
  assert.equal(decision.kind, 'duplicate');
  assert.equal(decision.target.id, 2);
  assert.deepEqual(decision.copies.map((t) => t.id), [2]);
});

test('nothing to ask: unique page, no key, or a fragment-only difference', () => {
  const lander = tab(5, 'https://a.test/x#one');
  assert.equal(decideCard(lander, [lander, tab(1, 'https://a.test/x#two')]), null);
  const internal = tab(5, 'chrome://extensions/');
  assert.equal(decideCard(internal, [internal, tab(1, 'chrome://extensions/')]), null);
});

test('every older copy is a copy; the keeper is the oldest', () => {
  const lander = tab(9, 'https://a.test/');
  const decision = decideCard(lander, [tab(7, 'https://a.test/'), tab(3, 'https://a.test/'), lander]);
  assert.equal(decision.target.id, 3);
  assert.deepEqual(decision.copies.map((t) => t.id).sort(), [3, 7]);
});

test('keep both stops asking about this URL until the mute expires', () => {
  const lander = tab(5, 'https://a.test/');
  const tabs = [tab(1, 'https://a.test/'), lander];
  const muted = { [normalizeUrl(lander.url)]: 1000 + MUTE_MS };
  assert.equal(decideCard(lander, tabs, { muted, now: 1000 }), null);
  assert.ok(decideCard(lander, tabs, { muted, now: 1000 + MUTE_MS }));
  assert.deepEqual(liveMutes({ a: 10, b: 20 }, 15), { b: 20 });
});

test('alias: another door with a canonical tab open gets the normal card, canonical wins', () => {
  const door = tab(1, 'https://example.com/mail', { pinned: true });
  const canonical = tab(8, 'https://mail.example.com/inbox');
  const decision = decideCard(door, [door, canonical], { rules: RULES });
  assert.equal(decision.kind, 'duplicate');
  assert.equal(decision.target.id, 8, 'newer canonical tab wins over an older pinned other-door tab');
});

test('alias: another door with no canonical tab open offers to go there', () => {
  const door = tab(1, 'https://example.com/mail');
  const decision = decideCard(door, [door, tab(2, 'https://unrelated.test/')], { rules: RULES });
  assert.equal(decision.kind, 'offer');
  assert.equal(decision.rule.canonical, 'https://mail.example.com/inbox');
});

test('alias: Stay here silences the offer for that URL', () => {
  const door = tab(1, 'https://example.com/mail');
  const muted = { [normalizeUrl(door.url)]: 100 };
  assert.equal(decideCard(door, [door], { rules: RULES, muted, now: 50 }), null);
});

test('alias: landing on the canonical door itself does not ask about other doors', () => {
  const canonical = tab(8, 'https://mail.example.com/inbox');
  assert.equal(decideCard(canonical, [tab(1, 'https://example.com/mail'), canonical], { rules: RULES }), null);
});

test('duplicateGroups keys by normalized URL with the oldest first', () => {
  const groups = duplicateGroups([tab(4, 'https://a.test/?utm_id=1'), tab(2, 'https://a.test/'), tab(3, 'https://b.test/')]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, 'https://a.test/');
  assert.equal(groups[0].keeper.id, 2);
  assert.deepEqual(groups[0].extras.map((t) => t.id), [4]);
});

test('duplicateGroups: a pinned copy outranks an older one, canonical outranks pinned', () => {
  const [plain] = duplicateGroups([tab(1, 'https://a.test/'), tab(2, 'https://a.test/', { pinned: true })]);
  assert.equal(plain.keeper.id, 2);
  const [alias] = duplicateGroups([tab(1, 'https://example.com/mail', { pinned: true }), tab(9, 'https://mail.example.com/inbox')], RULES);
  assert.equal(alias.keeper.id, 9);
});

test('duplicateGroups does not merge canonical-door tabs on different pages', () => {
  const tabs = [tab(1, 'https://mail.example.com/inbox#a'), tab(2, 'https://mail.example.com/inbox#b')];
  assert.equal(duplicateGroups(tabs, RULES).length, 0);
});

test('redundantCount is what the badge shows', () => {
  const tabs = [tab(1, 'https://a.test/'), tab(2, 'https://a.test/'), tab(3, 'https://a.test/'), tab(4, 'https://b.test/'),
    tab(5, 'https://b.test/#x'), tab(6, 'chrome://newtab/'), tab(7, 'chrome://newtab/')];
  assert.equal(redundantCount(tabs), 2);
  assert.equal(redundantCount([]), 0);
});

test('the shipped alias rules are coherent', () => {
  const rules = compileRules(ALIAS_RULES);
  assert.ok(rules.length > 0);
  for (const rule of rules) {
    assert.ok(rule.canonicalRe.test(rule.canonical), `${rule.name}: canonical matches its own door`);
    assert.ok(!rule.otherRes.some((re) => re.test(rule.canonical)), `${rule.name}: canonical is not another door`);
    assert.equal(doorOf(rule.canonical, rules).door, 'canonical');
  }
});

const keysOf = (card) => Object.fromEntries(card.actions.map((a) => [a.id, a.keys]));

test('the card: each action has its letter, Enter takes Jump', () => {
  const lander = tab(5, 'https://a.test/');
  const card = buildCard(decideCard(lander, [tab(1, 'https://a.test/', { windowId: 2 }), lander]), lander);
  assert.deepEqual(keysOf(card), { jump: ['j'], bring: ['b'], 'close-other': ['x', 'c'], keep: ['k'] });
  assert.equal(card.actions.filter((a) => a.primary).map((a) => a.id).join(), 'jump');
});

test('the card: Bring here appears only when the existing tab is in another window', () => {
  const lander = tab(5, 'https://a.test/');
  const card = buildCard(decideCard(lander, [tab(1, 'https://a.test/'), lander]), lander);
  assert.ok(!card.actions.some((a) => a.id === 'bring'));
});

test('the card counts several copies', () => {
  const lander = tab(5, 'https://a.test/');
  const card = buildCard(decideCard(lander, [tab(1, 'https://a.test/'), tab(2, 'https://a.test/'), lander]), lander);
  assert.match(card.actions.find((a) => a.id === 'close-other').label, /other 2/);
});

test('the offer card: j goes, k stays', () => {
  const door = tab(1, 'https://example.com/mail');
  const card = buildCard(decideCard(door, [door], { rules: RULES }), door);
  assert.deepEqual(keysOf(card), { jump: ['j'], keep: ['k'] });
  assert.equal(card.actions.find((a) => a.id === 'keep').label, 'Stay here');
  assert.equal(card.detail, 'https://mail.example.com/inbox');
});

test('the card lists the keys actually bound', () => {
  const bound = boundShortcuts([
    { name: 'dup-jump', shortcut: '⌥⇧D' },
    { name: 'dup-bring', shortcut: '' },
    { name: '_execute_action', shortcut: '⌘E' },
  ]);
  assert.deepEqual(bound, { jump: '⌥⇧D' });
  const lander = tab(5, 'https://a.test/');
  const card = buildCard(decideCard(lander, [tab(1, 'https://a.test/', { windowId: 2 }), lander]), lander, bound);
  assert.equal(card.actions.find((a) => a.id === 'jump').shortcut, '⌥⇧D');
  assert.equal(card.actions.find((a) => a.id === 'bring').shortcut, null);
});

// ---- Review findings: alias rules must not call different pages one place ----

const SHIPPED = compileRules(ALIAS_RULES);
const door = (url) => doorOf(url, SHIPPED)?.door ?? null;

test('shipped rules: only the front door itself counts as another door', () => {
  assert.equal(door('https://gmail.com/'), 'other');
  assert.equal(door('https://www.gmail.com/'), 'other');
  assert.equal(door('https://gmail.com/?utm_source=x'), 'other');
  assert.equal(door('https://gmail.com/some/deep/page'), null);
  assert.equal(door('https://www.google.com/calendar'), 'other');
  assert.equal(door('https://www.google.com/calendar/'), 'other');
  assert.equal(door('https://www.google.com/calendarium-history'), null);
  assert.equal(door('https://www.google.com/calendar/about/help'), null);
});

test('shipped rules: another account is not the canonical door', () => {
  assert.equal(door('https://mail.google.com/mail/u/0/'), 'canonical');
  assert.equal(door('https://mail.google.com/mail/u/0/#inbox/abc'), 'canonical');
  assert.equal(door('https://mail.google.com/mail/u/1/'), null);
  assert.equal(door('https://mail.google.com/mail/u/10/'), null);
  assert.equal(door('https://calendar.google.com/calendar/u/0/r'), 'canonical');
  assert.equal(door('https://calendar.google.com/calendar/u/1/r'), null);
  assert.equal(door('https://www.google.com/calendar/u/1/'), null);
});

test('shipped rules: Close N duplicates cannot take a real page', () => {
  const canonical = tab(1, 'https://mail.google.com/mail/u/0/');
  assert.deepEqual(duplicateGroups([canonical, tab(2, 'https://gmail.com/some/deep/page')], SHIPPED), []);
  assert.deepEqual(duplicateGroups([tab(3, 'https://mail.google.com/mail/u/1/'), tab(4, 'https://gmail.com/')], SHIPPED), []);
  assert.deepEqual(duplicateGroups([tab(5, 'https://calendar.google.com/calendar/u/0/r'), tab(6, 'https://www.google.com/calendarium-history')], SHIPPED), []);
  const [real] = duplicateGroups([canonical, tab(7, 'https://gmail.com/')], SHIPPED);
  assert.deepEqual(real.extras.map((t) => t.id), [7], 'the true door still groups');
});

test('a tab is never listed twice in copies', () => {
  const rules = compileRules([{
    name: 'X',
    canonical: 'https://x.test/a?utm_id=canon',
    canonicalPattern: 'utm_id=canon',
    otherDoors: ['^https://x\\.test/a$'],
  }]);
  const lander = tab(9, 'https://x.test/a');
  const decision = decideCard(lander, [tab(5, 'https://x.test/a?utm_id=canon'), lander], { rules });
  assert.deepEqual(decision.copies.map((t) => t.id), [5]);
});

test('Close the other takes older copies only (R2)', () => {
  const lander = tab(5, 'https://a.test/');
  const decision = decideCard(lander, [tab(3, 'https://a.test/'), lander, tab(8, 'https://a.test/')]);
  assert.deepEqual(decision.copies.map((t) => t.id), [3]);
});

test('with no older copy the card has no Close the other, and Jump still has a target', () => {
  const older = tab(2, 'https://a.test/');
  const decision = decideCard(older, [older, tab(8, 'https://a.test/')]);
  assert.equal(decision.target.id, 8);
  assert.deepEqual(decision.copies, []);
  assert.ok(!buildCard(decision, older).actions.some((a) => a.id === 'close-other'));
});

test('alias: a newer canonical tab is the target but is not an older copy', () => {
  const door_ = tab(1, 'https://example.com/mail');
  const decision = decideCard(door_, [door_, tab(8, 'https://mail.example.com/inbox')], { rules: RULES });
  assert.equal(decision.target.id, 8);
  assert.deepEqual(decision.copies, []);
});
