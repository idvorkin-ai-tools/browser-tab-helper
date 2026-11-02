// R4: closes and moves made from the page, and how to take them back.

export function closeRecord(tab) {
  return { url: tab.url, title: tab.title, windowId: tab.windowId, index: tab.index };
}

function entryTabs(entry) {
  if (entry.tab) return [entry.tab];
  return entry.window?.tabs ?? entry.group?.tabs ?? [];
}

function entrySessionId(entry) {
  return (entry.tab ?? entry.window ?? entry.group).sessionId;
}

/**
 * The next restore to undo a close. `remaining` holds the records still to restore, in the order the tabs closed.
 *
 * chrome.sessions keeps a stack, so undo works from the most recently closed down: each tab then goes back at the
 * index it left from, and the order comes out right. Restoring by the entry's sessionId rather than popping the
 * top means a tab you closed yourself in the meantime is left alone, and it reaches past the 25 entries
 * getRecentlyClosed shows, since each restore shifts the deeper ones up.
 *
 * Closing a window's last tab can leave a whole-window entry, which brings back all its tabs at once; those are
 * returned in `covers`. `missing` is a record with no entry at all (Chrome does not keep a blank New Tab).
 */
export function nextRestoreStep(entries, remaining) {
  const latest = remaining.at(-1);
  if (!latest) return null;
  const entry = entries.find((candidate) => entryTabs(candidate).some((tab) => tab.url === latest.url));
  if (!entry) return { missing: latest, covers: [latest] };
  if (entry.tab) return { sessionId: entrySessionId(entry), covers: [latest] };
  const urls = entryTabs(entry).map((tab) => tab.url);
  const covers = remaining.filter((record) => {
    const at = urls.indexOf(record.url);
    if (at < 0) return false;
    urls.splice(at, 1);
    return true;
  });
  return { sessionId: entrySessionId(entry), covers };
}

export function moveRecord(tab) {
  return { tabId: tab.id, fromWindowId: tab.windowId, fromIndex: tab.index, groupId: tab.groupId ?? -1 };
}

/**
 * The order to move tabs back in: per window, lowest original index first. Each then lands exactly where it was,
 * because everything to its left is already back in place.
 */
export function undoMoveOrder(records) {
  return [...records].sort((a, b) => a.fromWindowId - b.fromWindowId || a.fromIndex - b.fromIndex);
}

/**
 * The index for chrome.tabs.move when dropping tabs so they land before the tab now at `beforeIndex` in the target
 * window. Chrome's index is where the tab ends up, after the moved tabs have left, so each moved tab already left
 * of the drop point shifts it one to the left. null means the end of the window.
 */
export function dropIndex(moving, targetWindowId, beforeIndex) {
  if (beforeIndex === null) return -1;
  const leaving = moving.filter((tab) => tab.windowId === targetWindowId && tab.index < beforeIndex).length;
  return beforeIndex - leaving;
}
