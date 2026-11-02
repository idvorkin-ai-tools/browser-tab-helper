// R4: Google Docs rows. Chrome's title is the same for every tab of a doc, and the icon already names the app.

const APP_SUFFIX = /\s*[-–—]\s*Google (Docs|Sheets|Slides)\s*$/;

export function cleanTitle(title) {
  return (title ?? '').replace(APP_SUFFIX, '');
}

/** The cache key for a Google Doc's document tab: doc id plus the `tab` param, or null if not a doc. */
export function docKey(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== 'docs.google.com') return null;
  const match = parsed.pathname.match(/^\/document\/(?:u\/\d+\/)?d\/([^/]+)/);
  if (!match) return null;
  const tab = parsed.searchParams.get('tab') ?? new URLSearchParams(parsed.hash.slice(1)).get('tab') ?? '';
  return `${match[1]}:${tab}`;
}

/** The cache after a content-script report. A doc with one tab has no name, so it holds no entry. */
export function updateDocTabs(cache, url, name) {
  const key = docKey(url);
  if (!key) return cache;
  const next = { ...cache };
  if (name) next[key] = name;
  else delete next[key];
  return next;
}

/** What a row shows for a tab. Reads only the cache. */
export function rowTitle(tab, docTabs = {}) {
  const title = cleanTitle(tab.title) || tab.url || '';
  const name = docTabs[docKey(tab.url)];
  return name ? `${title} › ${name}` : title;
}
