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

/** `group` is the tab's group as it stands, kept because moving a group's last tab out makes Chrome delete the group. */
export function moveRecord(tab, group = null) {
  return {
    tabId: tab.id,
    fromWindowId: tab.windowId,
    fromIndex: tab.index,
    groupId: tab.groupId ?? -1,
    group: group ? { title: group.title, color: group.color, collapsed: group.collapsed } : null,
  };
}

/**
 * The groups to put moved tabs back into, once they are back in place. `recreate` holds a group's properties when
 * Chrome deleted it, and is null when it still exists and the tabs only rejoin it.
 */
export function groupRestores(records, liveGroupIds) {
  const byGroup = new Map();
  for (const record of records) {
    if (record.groupId === -1) continue;
    if (!byGroup.has(record.groupId)) {
      byGroup.set(record.groupId, {
        groupId: record.groupId,
        tabIds: [],
        recreate: liveGroupIds.includes(record.groupId) ? null : (record.group ?? {}),
      });
    }
    byGroup.get(record.groupId).tabIds.push(record.tabId);
  }
  return [...byGroup.values()];
}

/**
 * The order to move tabs back in: per window, lowest original index first. Each then lands exactly where it was,
 * because everything to its left is already back in place.
 */
export function undoMoveOrder(records) {
  return [...records].sort((a, b) => a.fromWindowId - b.fromWindowId || a.fromIndex - b.fromIndex);
}

/**
 * The chrome.tabs.move calls, one tab at a time, that put `movingIds`, in that order, before the tab now at
 * `beforeIndex` in the target window (`strip`, its tab ids in order). null means the end of the window.
 *
 * Not one call with an array: Chrome moves the ids in turn to index, index + 1, and so on, and each tab that leaves from
 * the left shifts the rest, so A,B dragged to before D in A,B,C,D,E comes out A,C,B,D,E. Instead this works backwards,
 * inserting each tab just before the one placed after it, which holds wherever each tab started.
 */
export function moveSteps(strip, movingIds, beforeIndex) {
  const moving = new Set(movingIds);
  const current = [...strip];
  // A row that is itself moving cannot be the anchor, so the drop point is the next one staying put.
  let anchor = beforeIndex === null ? null : strip.slice(beforeIndex).find((id) => !moving.has(id)) ?? null;
  const steps = [];
  for (const id of [...movingIds].reverse()) {
    const from = current.indexOf(id);
    if (from >= 0) current.splice(from, 1);
    const index = anchor === null ? current.length : current.indexOf(anchor);
    current.splice(index, 0, id);
    steps.push({ id, index });
    anchor = id;
  }
  return steps;
}
