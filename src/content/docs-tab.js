// R4: Chrome's title is the same for every tab of a Google Doc, so this reads the selected document tab and tells the
// worker, which caches it. The list page reads only the cache.
//
// ponytail: these class names are Google's and undocumented, and were not checked against a live doc when written. If
// rows stop naming document tabs, they are the first thing to look at. Reading the outline's accessibility tree would
// be sturdier, at much more cost.
(() => {
  const ITEM = '.chapter-item-label-and-buttons-container';
  const LABEL = '.chapter-label-content';
  const POLL_MS = 3000;

  if (!location.pathname.includes('/document/')) return;

  let lastSent = null;

  const selectedTabName = () => {
    const items = document.querySelectorAll(ITEM);
    if (items.length < 2) return null; // A doc with one tab shows no tab name.
    const selected = [...items].find((item) => item.getAttribute('aria-selected') === 'true');
    return (selected?.querySelector(LABEL) ?? selected)?.textContent?.trim() || null;
  };

  const report = () => {
    if (document.hidden) return;
    const name = selectedTabName();
    const summary = `${location.href}\n${name}`;
    if (summary === lastSent) return;
    lastSent = summary;
    try {
      chrome.runtime.sendMessage({ type: 'doc-tab', url: location.href, name }).catch(() => {});
    } catch {
      clearInterval(timer); // The extension reloaded; this copy of the script is orphaned.
    }
  };

  const timer = setInterval(report, POLL_MS);
  report();
})();
