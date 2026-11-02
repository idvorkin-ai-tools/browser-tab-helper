import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl } from '../src/lib/normalize.js';

const same = (a, b) => assert.equal(normalizeUrl(a), normalizeUrl(b), `${a} should equal ${b}`);
const different = (a, b) => assert.notEqual(normalizeUrl(a), normalizeUrl(b), `${a} should differ from ${b}`);

test('only http, https and file take part', () => {
  assert.ok(normalizeUrl('http://example.com/'));
  assert.ok(normalizeUrl('https://example.com/'));
  assert.ok(normalizeUrl('file:///tmp/a.html'));
  for (const url of ['chrome://extensions/', 'about:blank', 'chrome-extension://abc/x.html', 'ftp://example.com/a',
    'data:text/plain,hi', 'devtools://devtools/x', 'view-source:https://example.com/', 'not a url', '', null, undefined]) {
    assert.equal(normalizeUrl(url), null, String(url));
  }
});

test('a leading www. is stripped, other subdomains are not', () => {
  same('https://www.example.com/a', 'https://example.com/a');
  different('https://docs.example.com/a', 'https://example.com/a');
  different('https://www2.example.com/a', 'https://example.com/a');
  assert.equal(normalizeUrl('https://www.com/'), 'https://www.com/');
});

test('trailing slashes on the path are stripped, the root stays', () => {
  same('https://example.com/a/', 'https://example.com/a');
  same('https://example.com/a///', 'https://example.com/a');
  assert.equal(normalizeUrl('https://example.com'), 'https://example.com/');
  assert.equal(normalizeUrl('https://example.com/'), 'https://example.com/');
  assert.equal(normalizeUrl('https://example.com//'), 'https://example.com/');
  same('https://example.com/a/?x=1', 'https://example.com/a?x=1');
  same('file:///tmp/dir/', 'file:///tmp/dir');
});

test('every listed tracking param is dropped, case-insensitively', () => {
  const params = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id', 'utm_name',
    'fbclid', 'gclid', 'dclid', 'msclkid', 'yclid', 'igshid', 'mc_cid', 'mc_eid', 'wbraid', 'gbraid',
    'ref_src', 'ref_url', '_hsenc', '_hsmi'];
  assert.equal(params.length, 21);
  for (const param of params) {
    same(`https://example.com/a?${param}=x`, 'https://example.com/a');
    same(`https://example.com/a?${param.toUpperCase()}=x&keep=1`, 'https://example.com/a?keep=1');
  }
  same('https://example.com/a?utm_source', 'https://example.com/a');
});

test('remaining params are sorted by key then value, so order does not matter', () => {
  same('https://example.com/?b=2&a=1', 'https://example.com/?a=1&b=2');
  same('https://example.com/?a=2&a=1', 'https://example.com/?a=1&a=2');
  assert.equal(normalizeUrl('https://example.com/?b=1&a=2&a=1'), 'https://example.com/?a=1&a=2&b=1');
});

test('every other param counts', () => {
  different('https://example.com/?a=1', 'https://example.com/?a=2');
  different('https://example.com/?a=1', 'https://example.com/');
  different('https://example.com/?ref=home', 'https://example.com/');
  different('https://example.com/?utm_sourcex=1', 'https://example.com/');
  different('https://example.com/?a', 'https://example.com/?a=');
  different('https://example.com/?a=b+c', 'https://example.com/?a=b%20c');
});

test('the whole fragment is kept', () => {
  different('https://example.com/a#one', 'https://example.com/a#two');
  different('https://example.com/a#t=1&panel=transcript', 'https://example.com/a#t=1');
  different('https://example.com/a#x', 'https://example.com/a');
  assert.equal(normalizeUrl('https://www.example.com/a/?utm_id=1&z=1#b=2&a=1'), 'https://example.com/a?z=1#b=2&a=1');
});

test('conservative: scheme, port, path case and user stay significant', () => {
  different('http://example.com/', 'https://example.com/');
  different('https://example.com:8443/', 'https://example.com/');
  different('https://example.com/A', 'https://example.com/a');
  different('https://me@example.com/', 'https://example.com/');
  same('https://EXAMPLE.com/a', 'https://example.com/a');
  same('https://example.com:443/a', 'https://example.com/a');
});
