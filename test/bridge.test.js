// R8: the bridge server for real, over loopback HTTP. The extension's side is played by fetch with its Origin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridge, DEFAULT_PORT, defaultLogPath } from '../tools/bridge.js';
import { DEFAULT_SETTINGS } from '../src/lib/settings.js';
import { parseArgs } from '../tools/ask.js';
import { findControl, keyEvents, numberControls } from '../src/lib/controls.js';
import { readSelection } from '../src/lib/page-scripts.js';

const ASK = fileURLToPath(new URL('../tools/ask.js', import.meta.url));

async function start(t, options = {}) {
  const logPath = join(mkdtempSync(join(tmpdir(), 'bth-bridge-')), 'logs', 'events.jsonl');
  const bridge = createBridge({ logPath, ...options });
  const port = await bridge.listen(0);
  t.after(() => bridge.close());
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  return { port, logPath, url };
}

// Node's fetch forbids setting Origin in some versions and Host in all, so raw requests go through http.request.
function raw(port, method, path, { headers = {}, body } = {}) {
  return new Promise((done, fail) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => done({ status: res.statusCode, text, json: text ? JSON.parse(text) : null }));
    });
    req.on('error', fail);
    if (body) req.write(body);
    req.end();
  });
}

const EXT = { 'x-browser-tab-helper': '1' };
const ask = (port, command) => raw(port, 'POST', '/ask', { body: JSON.stringify(command) });
const next = (port) => raw(port, 'GET', '/next', { headers: EXT });
const result = (port, body) => raw(port, 'POST', '/result', { headers: EXT, body: JSON.stringify(body) });

test('the default port is 8787', () => {
  assert.equal(DEFAULT_PORT, 8787);
});

test('it listens on loopback only', async (t) => {
  const bridge = createBridge({ logPath: '/dev/null' });
  await bridge.listen(0);
  t.after(() => bridge.close());
  assert.equal(bridge.server.address().address, '127.0.0.1');
});

test('a command waits for a later poll, and the answer returns to the asker', async (t) => {
  const { port } = await start(t);
  const answer = ask(port, { cmd: 'tabs' });
  const command = await next(port);
  assert.equal(command.status, 200);
  assert.equal(command.json.cmd, 'tabs');
  await result(port, { id: command.json.id, result: [{ id: 1 }] });
  assert.deepEqual((await answer).json, { result: [{ id: 1 }] });
});

test('a poll held open receives a command as soon as it lands', async (t) => {
  const { port } = await start(t);
  const poll = next(port);
  await new Promise((later) => setTimeout(later, 20));
  const answer = ask(port, { cmd: 'diag', x: 1 });
  const command = await poll;
  assert.equal(command.json.x, 1);
  await result(port, { id: command.json.id, result: 'ok' });
  assert.equal((await answer).json.result, 'ok');
});

test('an empty poll answers 204 once its hold ends', async (t) => {
  const { port } = await start(t, { pollHoldMs: 20 });
  assert.equal((await next(port)).status, 204);
});

test('a command landing between polls is not lost', async (t) => {
  const { port } = await start(t, { pollHoldMs: 10 });
  assert.equal((await next(port)).status, 204);
  const answer = ask(port, { cmd: 'between' });
  await new Promise((later) => setTimeout(later, 30));
  const command = await next(port);
  assert.equal(command.json.cmd, 'between');
  await result(port, { id: command.json.id, result: 1 });
  assert.equal((await answer).status, 200);
});

test('a command is not handed to a poller that hung up', async (t) => {
  const { port } = await start(t);
  await new Promise((done) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/next', headers: EXT });
    req.on('error', () => {});
    req.end(() => setTimeout(() => {
      req.destroy();
      setTimeout(done, 30);
    }, 30));
  });
  const answer = ask(port, { cmd: 'kept' });
  const command = await next(port);
  assert.equal(command.json.cmd, 'kept');
  await result(port, { id: command.json.id, result: 1 });
  await answer;
});

test('nobody answering gets a clear error, and the command is withdrawn', async (t) => {
  const { port } = await start(t, { answerTimeoutMs: 20, pollHoldMs: 10 });
  const answer = await ask(port, { cmd: 'tabs' });
  assert.equal(answer.status, 504);
  assert.match(answer.json.error, /switched on/);
  assert.equal((await next(port)).status, 204);
});

test('the default answer wait is about 95 s', () => {
  const source = readFileSync(new URL('../tools/bridge.js', import.meta.url), 'utf8');
  assert.match(source, /ANSWER_TIMEOUT_MS = 95_000/);
});

test('an extension error reaches the asker', async (t) => {
  const { port } = await start(t);
  const answer = ask(port, { cmd: 'nope' });
  const command = await next(port);
  await result(port, { id: command.json.id, error: 'unknown command' });
  const reply = await answer;
  assert.equal(reply.status, 500);
  assert.equal(reply.json.error, 'unknown command');
});

test('a web page cannot send commands, even with a simple request', async (t) => {
  const { port } = await start(t);
  const reply = await raw(port, 'POST', '/ask', {
    headers: { origin: 'https://evil.test', 'content-type': 'text/plain' },
    body: '{"cmd":"close"}',
  });
  assert.equal(reply.status, 403);
});

test('a web page cannot poll for commands or post results or events', async (t) => {
  const { port } = await start(t);
  const headers = { origin: 'https://evil.test' };
  assert.equal((await raw(port, 'GET', '/next', { headers })).status, 403);
  assert.equal((await raw(port, 'POST', '/result', { headers, body: '{}' })).status, 403);
  assert.equal((await raw(port, 'POST', '/event', { headers, body: '{}' })).status, 403);
  assert.equal((await raw(port, 'GET', '/next')).status, 403, 'a page\'s <img> GET has no origin and must not take a command');
  assert.equal((await raw(port, 'GET', '/next', { headers: { origin: 'https://evil.test', ...EXT } })).status, 403, 'a page origin is refused even with the header');
  assert.equal((await raw(port, 'OPTIONS', '/next', { headers: { origin: 'https://evil.test', 'access-control-request-headers': 'x-browser-tab-helper' } })).status, 403, 'the preflight that would let a page add the header is refused');
});

test('the extension is accepted with or without an Origin header', async (t) => {
  const { port } = await start(t, { pollHoldMs: 5 });
  assert.equal((await raw(port, 'GET', '/next', { headers: EXT })).status, 204);
  assert.equal((await raw(port, 'GET', '/next', { headers: { ...EXT, origin: 'chrome-extension://abc' } })).status, 204);
});

test('DNS rebinding is refused by the Host check', async (t) => {
  const { port } = await start(t);
  const reply = await raw(port, 'POST', '/ask', { headers: { host: `evil.test:${port}` }, body: '{"cmd":"tabs"}' });
  assert.equal(reply.status, 403);
  assert.equal(reply.json.error, 'bad host');
});

test('malformed commands are refused', async (t) => {
  const { port } = await start(t);
  assert.equal((await raw(port, 'POST', '/ask', { body: 'not json' })).status, 400);
  assert.equal((await raw(port, 'POST', '/ask', { body: '{"nocmd":1}' })).status, 400);
  assert.equal((await raw(port, 'GET', '/nope')).status, 403);
});

test('extension events append to a local JSONL log the user alone can read', async (t) => {
  const { port, logPath } = await start(t);
  const post = (body) => raw(port, 'POST', '/event', { headers: EXT, body: JSON.stringify(body) });
  await post({ event: 'first' });
  await post({ event: 'second', tab: 3 });
  const lines = readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => line.event), ['first', 'second']);
  assert.equal(lines[1].tab, 3);
  assert.ok(lines[0].at);
  assert.equal(statSync(logPath).mode & 0o777, 0o600);
});

test('ask.js sends a command end to end and prints the result', async (t) => {
  const { port } = await start(t);
  const child = spawn(process.execPath, [ASK, 'tabs', '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  const exited = new Promise((done) => child.on('exit', done));
  const command = await next(port);
  await result(port, { id: command.json.id, result: [{ id: 7 }] });
  assert.equal(await exited, 0);
  assert.deepEqual(JSON.parse(out), [{ id: 7 }]);
});

test('ask.js fails clearly with no server', async () => {
  const child = spawn(process.execPath, [ASK, 'tabs', '--port', '1'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', (chunk) => { err += chunk; });
  assert.equal(await new Promise((done) => child.on('exit', done)), 1);
  assert.match(err, /No bridge/);
});

test('ask.js knows every command the issue names', () => {
  const command = (...argv) => parseArgs(argv, { readFile: () => '{"version":1,"windows":[]}' }).command;
  assert.deepEqual(command('diag'), { cmd: 'diag' });
  assert.deepEqual(command('tabs'), { cmd: 'tabs' });
  assert.deepEqual(command('duplicates'), { cmd: 'duplicates' });
  assert.deepEqual(command('activate', '4'), { cmd: 'activate', tab: 4 });
  assert.deepEqual(command('close', '4'), { cmd: 'close', tab: 4 });
  assert.deepEqual(command('open', 'https://a.test/'), { cmd: 'open', url: 'https://a.test/' });
  assert.deepEqual(command('navigate', 'https://a.test/', '--tab', '4'), { cmd: 'navigate', url: 'https://a.test/', tab: 4 });
  assert.deepEqual(command('reload'), { cmd: 'reload' });
  assert.deepEqual(command('layout'), { cmd: 'layout' });
  assert.deepEqual(command('restore-layout', 'f.json'), { cmd: 'restore-layout', layout: { version: 1, windows: [] } });
  assert.deepEqual(command('read'), { cmd: 'read' });
  assert.deepEqual(command('click', '3'), { cmd: 'click', target: 3 });
  assert.deepEqual(command('click', 'Sign', 'in'), { cmd: 'click', target: 'Sign in' });
  assert.deepEqual(command('type', 'hello', 'there'), { cmd: 'type', text: 'hello there' });
  assert.deepEqual(command('key', 'Enter'), { cmd: 'key', key: 'Enter' });
  assert.deepEqual(command('screenshot'), { cmd: 'screenshot' });
  assert.equal(parseArgs(['screenshot', '--out', 'a.png']).out, 'a.png');
});

test('anything else can be sent as raw JSON', () => {
  assert.deepEqual(parseArgs(['{"cmd":"whatever","x":[1]}']).command, { cmd: 'whatever', x: [1] });
  assert.throws(() => parseArgs(['nonsense']), /unknown command/);
  assert.throws(() => parseArgs([]), /usage/);
  assert.throws(() => parseArgs(['click']), /needs/);
});

test('findControl: by index, exact label, then containing label', () => {
  const controls = [
    { index: 0, label: 'Sign in to continue' },
    { index: 1, label: 'Sign in' },
    { index: 2, label: '' },
  ];
  assert.equal(findControl(controls, 2).index, 2);
  assert.equal(findControl(controls, 'sign in').index, 1);
  assert.equal(findControl(controls, 'continue').index, 0);
  assert.equal(findControl(controls, 'absent'), null);
  assert.equal(findControl(controls, 9), null);
  assert.equal(findControl(controls, ' '), null);
});

test('numberControls numbers every frame, top frame first', () => {
  const controls = numberControls([
    { frameId: 7, controls: [{ label: 'in frame' }] },
    { frameId: 0, controls: [{ label: 'a' }, { label: 'b' }] },
  ]);
  assert.deepEqual(controls.map((c) => [c.index, c.frameId, c.localIndex, c.label]), [
    [0, 0, 0, 'a'], [1, 0, 1, 'b'], [2, 7, 0, 'in frame'],
  ]);
});

test('keyEvents', () => {
  const [down, up] = keyEvents('Enter');
  assert.equal(down.type, 'keyDown');
  assert.equal(down.text, '\r');
  assert.equal(down.windowsVirtualKeyCode, 13);
  assert.equal(up.type, 'keyUp');
  assert.equal(keyEvents('Escape')[0].type, 'rawKeyDown');
  assert.equal(keyEvents('a')[0].text, 'a');
  assert.throws(() => keyEvents('Hyper'), /unknown key/);
});

const fakeDoc = ({ active = null, selected = '' } = {}) => ({ activeElement: active, getSelection: () => ({ toString: () => selected }) });

test('selection: the page selection, or null when empty', () => {
  assert.equal(readSelection(fakeDoc({ selected: 'hello' })), 'hello');
  assert.equal(readSelection(fakeDoc()), null);
});

test('selection: text picked inside a field', () => {
  const active = { tagName: 'TEXTAREA', value: 'hello world', selectionStart: 6, selectionEnd: 11 };
  assert.equal(readSelection(fakeDoc({ active })), 'world');
  const input = { tagName: 'INPUT', type: 'text', value: 'abc', selectionStart: 0, selectionEnd: 2 };
  assert.equal(readSelection(fakeDoc({ active: input })), 'ab');
});

test('selection: a password field is never read', () => {
  const password = { tagName: 'INPUT', type: 'password', value: 'secret', selectionStart: 0, selectionEnd: 6 };
  assert.equal(readSelection(fakeDoc({ active: password })), null);
  assert.equal(readSelection(fakeDoc({ active: password, selected: 'also elsewhere' })), null);
  const upper = { ...password, type: 'PASSWORD' };
  assert.equal(readSelection(fakeDoc({ active: upper })), null);
});

test('selection: a password field inside a shadow root is never read', () => {
  const password = { tagName: 'INPUT', type: 'password', value: 'secret', selectionStart: 0, selectionEnd: 6 };
  const host = { tagName: 'X-LOGIN', shadowRoot: { activeElement: password } };
  assert.equal(readSelection(fakeDoc({ active: host, selected: 'x' })), null);
});

test('selection: the injected function stands alone', () => {
  // Chrome serializes it, so it may name nothing from this module.
  const source = readSelection.toString();
  assert.doesNotMatch(source, /\b(import|require)\b/);
  const rebuilt = new Function(`return (${source})`)();
  assert.equal(rebuilt(fakeDoc({ selected: 'ok' })), 'ok');
});

const masked = (extra) => ({ tagName: 'INPUT', type: 'text', value: 'secret', selectionStart: 0, selectionEnd: 6, ...extra });
const styledDoc = (active, security, selected = 'page text') => ({
  ...fakeDoc({ active, selected }),
  defaultView: { getComputedStyle: () => ({ getPropertyValue: (name) => (name === '-webkit-text-security' ? security : '') }) },
});

test('selection: a field marked as a password by autocomplete is never read', () => {
  for (const autocomplete of ['current-password', 'new-password', 'section-login current-password', 'CURRENT-PASSWORD']) {
    const active = masked({ getAttribute: (name) => (name === 'autocomplete' ? autocomplete : null) });
    assert.equal(readSelection(styledDoc(active, 'none')), null, autocomplete);
  }
  const plain = masked({ getAttribute: (name) => (name === 'autocomplete' ? 'username' : null) });
  assert.equal(readSelection(styledDoc(plain, 'none')), 'secret');
});

test('selection: a field masked with CSS is never read', () => {
  for (const security of ['disc', 'circle', 'square']) {
    assert.equal(readSelection(styledDoc(masked(), security)), null, security);
  }
  assert.equal(readSelection(styledDoc(masked(), 'none')), 'secret');
  assert.equal(readSelection(styledDoc(masked(), '')), 'secret', 'an engine without the property');
});

test('the 504 says whether the extension ever took the command', async (t) => {
  const quiet = await start(t, { answerTimeoutMs: 20, pollHoldMs: 5 });
  const nobody = await ask(quiet.port, { cmd: 'tabs' });
  assert.equal(nobody.status, 504);
  assert.match(nobody.json.error, /switched on/);

  const busy = await start(t, { answerTimeoutMs: 60 });
  const answer = ask(busy.port, { cmd: 'tabs' });
  assert.equal((await next(busy.port)).status, 200);
  const taken = await answer;
  assert.equal(taken.status, 504);
  assert.doesNotMatch(taken.json.error, /switched on/);
  assert.match(taken.json.error, /took the command/);
});

test('a queued command is dropped when its asker hangs up', async (t) => {
  const { port } = await start(t, { pollHoldMs: 10 });
  await new Promise((done) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/ask' });
    req.on('error', () => {});
    req.end('{"cmd":"close"}', () => setTimeout(() => {
      req.destroy();
      setTimeout(done, 40);
    }, 40));
  });
  assert.equal((await next(port)).status, 204, 'nothing left to run');
});

test('off macOS, the default log path fails clearly', () => {
  assert.throws(() => defaultLogPath('linux'), /macOS/);
  assert.match(defaultLogPath('darwin'), /Library\/Caches/);
});

test('a slow click is not a dead one: the command limit leaves room for it and sits inside the asker\'s wait', () => {
  const source = readFileSync(new URL('../tools/bridge.js', import.meta.url), 'utf8');
  const asker = Number(source.match(/ANSWER_TIMEOUT_MS = ([\d_]+)/)[1].replaceAll('_', ''));
  assert.ok(DEFAULT_SETTINGS.bridgeCommandTimeoutMs > 5000);
  assert.ok(DEFAULT_SETTINGS.bridgeCommandTimeoutMs < asker);
});
