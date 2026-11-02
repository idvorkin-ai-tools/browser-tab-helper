import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { importsOf, moduleGraph, preloadDrift } from './support/module-graph.js';

const path = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const ROOT = path('../');

test('the list page preloads exactly its real module graph', () => {
  const drift = preloadDrift(path('../src/page/list.html'), path('../src/page/list.js'), { root: ROOT });
  assert.deepEqual(drift, { missing: [], stale: [] });
});

test('the graph is followed all the way down, not just the entry\'s imports', () => {
  const graph = moduleGraph(path('../src/page/list.js'));
  assert.ok(graph.has(path('../src/lib/normalize.js')), 'normalize.js is reached only through other modules');
});

// Proof that the guard can fail: a small page on an in-memory filesystem.
const FILES = {
  '/p/page.html': '<link rel="modulepreload" href="./a.js"><link rel="modulepreload" href="./b.js">',
  '/p/a.js': "import { b } from './b.js';\nimport {\n  c,\n} from './c.js';",
  '/p/b.js': '',
  '/p/c.js': "export { d } from './d.js';",
  '/p/d.js': "// import nothing from './commented-out.js';\n",
};
const read = (files) => (file) => {
  if (!(file in files)) throw new Error(`no ${file}`);
  return files[file];
};

test('the guard reports an import missing from the list', () => {
  const drift = preloadDrift('/p/page.html', '/p/a.js', { root: '/p', read: read(FILES) });
  assert.deepEqual(drift, { missing: ['c.js', 'd.js'], stale: [] });
});

test('the guard reports a preload nothing imports', () => {
  const files = {
    ...FILES,
    '/p/page.html': '<link rel="modulepreload" href="./a.js"><link rel="modulepreload" href="./b.js"><link rel="modulepreload" href="./c.js"><link rel="modulepreload" href="./d.js"><link rel="modulepreload" href="./gone.js">',
  };
  const drift = preloadDrift('/p/page.html', '/p/a.js', { root: '/p', read: read(files) });
  assert.deepEqual(drift, { missing: [], stale: ['gone.js'] });
});

test('importsOf reads every static form and refuses what it cannot follow', () => {
  assert.deepEqual(importsOf("import a from './a.js';\nimport './b.js';\nexport * from './c.js';\nexport { d } from \"./d.js\";"), ['./a.js', './b.js', './c.js', './d.js']);
  assert.deepEqual(importsOf('export const a = 1;\nexport function b() {}'), []);
  assert.throws(() => importsOf("const x = await import('./x.js');"), /dynamic import/);
});
