// Rules about the repo itself: the manifest, what may touch chrome.*, what the self-reload watches.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMAND_ACTIONS } from '../src/lib/card.js';
import { WATCHED_FILES } from '../src/lib/watched-files.js';
import { pageControls, readSelection } from '../src/lib/page-scripts.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const package_ = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

test('manifest V3 with the permissions the issue lists', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual([...manifest.permissions].sort(), [
    'alarms', 'clipboardRead', 'debugger', 'nativeMessaging', 'scripting', 'sessions', 'storage', 'tabGroups', 'tabs',
  ]);
  assert.deepEqual(manifest.host_permissions, ['<all_urls>']);
  assert.equal(manifest.background.type, 'module');
});

test('no runtime dependencies and no build step', () => {
  assert.equal(package_.dependencies, undefined);
  assert.equal(package_.devDependencies, undefined);
  assert.equal(package_.scripts.build, undefined);
  assert.match(package_.scripts.test, /^node --test/);
});

test('every file the manifest names exists', () => {
  const paths = [
    manifest.background.service_worker,
    manifest.options_ui.page,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
    ...manifest.content_scripts.flatMap((script) => script.js),
  ];
  for (const path of paths) assert.ok(existsSync(join(ROOT, path)), path);
});

test('the commands have the default keys, and each maps to a card action', () => {
  const keys = Object.fromEntries(Object.entries(manifest.commands).map(([name, command]) => [COMMAND_ACTIONS[name], command.suggested_key.default]));
  assert.deepEqual(keys, { jump: 'Alt+Shift+D', bring: 'Alt+Shift+B', 'close-other': 'Alt+Shift+X', keep: 'Alt+Shift+K' });
});

test('pure logic stays pure: nothing in src/lib or src/data touches chrome.*', () => {
  for (const dir of ['src/lib', 'src/data']) {
    for (const file of walk(join(ROOT, dir))) {
      const code = readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      assert.doesNotMatch(code, /\bchrome\s*\./, relative(ROOT, file));
    }
  }
});

test('the self-reload watches every extension file, the manifest included', () => {
  const onDisk = [
    'manifest.json',
    'background.js',
    ...walk(join(ROOT, 'src')).map((file) => relative(ROOT, file)).filter((file) => !file.endsWith('.png')),
  ].sort();
  assert.deepEqual([...WATCHED_FILES].sort(), onDisk);
});

test('functions injected into pages name nothing from their module', () => {
  for (const fn of [readSelection, pageControls]) {
    assert.doesNotThrow(() => new Function(`return (${fn.toString()})`));
  }
});

test('the repo holds nothing but neutral public URLs in layouts/', () => {
  const allowed = /^https:\/\/(example\.com|en\.wikipedia\.org|developer\.chrome\.com)\//;
  for (const file of walk(join(ROOT, 'layouts'))) {
    const urls = readFileSync(file, 'utf8').match(/https?:\/\/[^"\s]+/g) ?? [];
    for (const url of urls) assert.match(url, allowed, `${relative(ROOT, file)}: ${url}`);
  }
});

test('no tool depends on import.meta.main, which is silently undefined on older Node', () => {
  for (const file of [...walk(join(ROOT, 'tools')), ...walk(join(ROOT, 'test/e2e'))]) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /import\.meta\.main/, relative(ROOT, file));
  }
  assert.ok(package_.engines?.node, 'package.json says which Node it needs');
});

test('a page capture cannot be committed by accident', () => {
  assert.match(readFileSync(join(ROOT, '.gitignore'), 'utf8'), /^screenshot\.png$/m);
});

test('the public docs link only to what a reader can open', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /github\.com\/idvorkin\/(?!browser-tab-helper)/);
  assert.match(readme, /docs\/requirements\.md/);
  assert.ok(existsSync(join(ROOT, 'docs/requirements.md')));
});

test('the requirements cover R1 to R9', () => {
  const text = readFileSync(join(ROOT, 'docs/requirements.md'), 'utf8');
  for (let n = 1; n <= 9; n++) assert.match(text, new RegExp(`^## R${n}\\b`, 'm'));
});
