// R1. Two tabs are the same page when their normalized URLs match. Being conservative matters most:
// falsely calling two tabs duplicates is much worse than missing a pair.

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id', 'utm_name',
  'fbclid', 'gclid', 'dclid', 'msclkid', 'yclid', 'igshid', 'mc_cid', 'mc_eid', 'wbraid', 'gbraid',
  'ref_src', 'ref_url', '_hsenc', '_hsmi',
]);

const SCHEMES = new Set(['http:', 'https:', 'file:']);

function isTracking(rawKey) {
  let key = rawKey;
  try {
    key = decodeURIComponent(rawKey);
  } catch {
    // A malformed escape cannot be a tracking name, so the raw text is compared and the param stays.
  }
  return TRACKING_PARAMS.has(key.toLowerCase());
}

// Works on the raw query text, not URLSearchParams, which would decode `+` and `%20` to the same value
// and so call two different queries equal.
function normalizeQuery(search) {
  const kept = search
    .slice(1)
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const at = pair.indexOf('=');
      return at < 0 ? { key: pair, value: null, pair } : { key: pair.slice(0, at), value: pair.slice(at + 1), pair };
    })
    .filter(({ key }) => !isTracking(key));
  kept.sort((a, b) => compare(a.key, b.key) || compare(a.value ?? '', b.value ?? '') || compare(a.pair, b.pair));
  return kept.length ? `?${kept.map(({ pair }) => pair).join('&')}` : '';
}

// Code-unit order, not localeCompare: a key must not depend on the machine's locale.
function compare(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function stripWww(hostname) {
  // `www.com` is itself a site; only strip when a real domain remains.
  return hostname.startsWith('www.') && hostname.indexOf('.', 4) > 0 ? hostname.slice(4) : hostname;
}

/** The key two tabs must share to be the same page, or null when the URL does not take part. */
export function normalizeUrl(url) {
  if (typeof url !== 'string' || url === '') return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!SCHEMES.has(parsed.protocol)) return null;

  const auth = parsed.username ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ''}@` : '';
  const port = parsed.port ? `:${parsed.port}` : '';
  const path = parsed.pathname.replace(/\/+$/, '') || '/';
  // The whole fragment stays. Apps keep state there; keeping it can only miss a duplicate, dropping it invents one.
  return `${parsed.protocol}//${auth}${stripWww(parsed.hostname)}${port}${path}${normalizeQuery(parsed.search)}${parsed.hash}`;
}
