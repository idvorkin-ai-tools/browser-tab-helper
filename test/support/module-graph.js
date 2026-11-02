// Reads a page's real module graph from source, so a test can hold the page's modulepreload list to it.
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Every relative specifier in static `import ... from`, bare `import '...'`, and `export ... from` statements. */
export function importsOf(source) {
  const code = stripComments(source);
  const specifiers = [];
  const statement = /^\s*(?:import|export)\s+(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;
  for (const [, specifier] of code.matchAll(statement)) specifiers.push(specifier);
  if (/\bimport\s*\(/.test(code)) throw new Error('dynamic import: this reader cannot follow it');
  return specifiers;
}

/** Absolute paths of the entry and everything it reaches. */
export function moduleGraph(entryPath, read = (path) => readFileSync(path, 'utf8')) {
  const seen = new Set();
  const visit = (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    for (const specifier of importsOf(read(path))) {
      if (!specifier.startsWith('.')) throw new Error(`${path} imports ${specifier}, not a relative module`);
      visit(resolve(dirname(path), specifier));
    }
  };
  visit(entryPath);
  return seen;
}

/** Absolute paths named by the HTML's modulepreload links. */
export function preloadsOf(html, htmlPath) {
  const paths = new Set();
  for (const [tag] of html.matchAll(/<link\b[^>]*>/g)) {
    if (!/rel=["']modulepreload["']/.test(tag)) continue;
    const [, href] = tag.match(/href=["']([^"']+)["']/);
    paths.add(resolve(dirname(htmlPath), href));
  }
  return paths;
}

/** What is wrong between the page's preload list and the real graph. Empty means in step. */
export function preloadDrift(htmlPath, entryPath, { root, read = (path) => readFileSync(path, 'utf8') }) {
  const graph = moduleGraph(entryPath, read);
  const preloads = preloadsOf(read(htmlPath), htmlPath);
  const name = (path) => relative(root, path);
  return {
    missing: [...graph].filter((path) => !preloads.has(path)).map(name).sort(),
    stale: [...preloads].filter((path) => !graph.has(path)).map(name).sort(),
  };
}
