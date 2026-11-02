import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSection, parseSection } from '../src/lib/sections.js';

const urls = (text) => parseSection(text).links.map((link) => link.url);

test('Copy writes the issue format', () => {
  const text = formatSection('Reading', [
    { title: 'Page title', url: 'https://a.test/' },
    { title: 'Another page - Google Docs', url: 'https://b.test/' },
  ]);
  assert.equal(text, '📂 Reading\n• Page title — https://a.test/\n• Another page — https://b.test/');
});

test('a copied section parses back to the same thing', () => {
  const parsed = parseSection(formatSection('Reading', [
    { title: 'Page title', url: 'https://a.test/' },
    { title: 'Another page', url: 'https://b.test/x?y=1#z' },
  ]));
  assert.equal(parsed.name, 'Reading');
  assert.deepEqual(parsed.links, [
    { title: 'Page title', url: 'https://a.test/' },
    { title: 'Another page', url: 'https://b.test/x?y=1#z' },
  ]);
});

test('a numbered list', () => {
  const parsed = parseSection('Things to read\n1. One https://a.test/\n2) Two - https://b.test/');
  assert.equal(parsed.name, 'Things to read');
  assert.deepEqual(parsed.links.map((l) => l.title), ['One', 'Two']);
  assert.deepEqual(parsed.links.map((l) => l.url), ['https://a.test/', 'https://b.test/']);
});

test('a bulleted list', () => {
  assert.deepEqual(urls('Links:\n- https://a.test/\n* https://b.test/\n• https://c.test/'), ['https://a.test/', 'https://b.test/', 'https://c.test/']);
});

test('Markdown links', () => {
  const parsed = parseSection('# Heading\n- [Tab](https://en.wikipedia.org/wiki/Tab_(interface)) and [B](https://b.test/)');
  assert.equal(parsed.name, 'Heading');
  assert.deepEqual(parsed.links, [
    { title: 'Tab', url: 'https://en.wikipedia.org/wiki/Tab_(interface)' },
    { title: 'B', url: 'https://b.test/' },
  ]);
});

test('a bare URL', () => {
  const parsed = parseSection('https://www.example.com/x');
  assert.deepEqual(parsed.links, [{ title: '', url: 'https://www.example.com/x' }]);
  assert.equal(parsed.name, 'example.com');
});

test('a first line that is a titled link names the group by that title', () => {
  assert.equal(parseSection('• First — https://a.test/\n• Second — https://b.test/').name, 'First');
});

test('trailing punctuation and unopened brackets are not part of a URL', () => {
  assert.deepEqual(urls('see https://a.test/x. and (https://b.test/y), also https://c.test/z_(1)'), [
    'https://a.test/x', 'https://b.test/y', 'https://c.test/z_(1)',
  ]);
});

test('the same page twice opens once; different fragments are different pages', () => {
  assert.deepEqual(urls('https://a.test/?utm_id=1\nhttps://www.a.test/'), ['https://a.test/?utm_id=1']);
  assert.deepEqual(urls('https://a.test/#1\nhttps://a.test/#2'), ['https://a.test/#1', 'https://a.test/#2']);
});

test('text with no links has none, and non-web links do not count', () => {
  assert.deepEqual(parseSection('just words'), { name: '', links: [] });
  assert.deepEqual(parseSection(''), { name: '', links: [] });
  assert.deepEqual(parseSection(null), { name: '', links: [] });
  assert.deepEqual(urls('javascript:alert(1)\nfile:///etc/hosts'), []);
});

test('Windows line ends', () => {
  const parsed = parseSection('Name\r\nhttps://a.test/\r\n');
  assert.equal(parsed.name, 'Name');
  assert.deepEqual(parsed.links.map((l) => l.url), ['https://a.test/']);
});
