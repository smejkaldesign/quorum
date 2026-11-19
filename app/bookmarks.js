// Bookmarks in Obsidian's own file, .obsidian/bookmarks.json: { items: [...] }, where an item is a file, folder, search,
// heading, block, graph, url or a group holding more items. Quorum reads and toggles file bookmarks only; every other
// item, and every field Quorum doesn't use, is written back as it was, so Obsidian keeps its bookmarks.

// the parsed file, an empty list when there is none, or null when it isn't a bookmarks file (never written over)
export function parseBookmarks(text) {
  if (text == null || !String(text).trim()) return { items: [] };
  try {
    const data = JSON.parse(String(text));
    return data && typeof data === 'object' && !Array.isArray(data) && (data.items === undefined || Array.isArray(data.items)) ? { ...data, items: data.items ?? [] } : null;
  } catch { return null; }
}

// the notes bookmarked, in the order Obsidian lists them, groups included, each once
export function bookmarkedFiles(data) {
  const out = [];
  const walk = (items) => { for (const it of items ?? []) { if (it?.type === 'file' && typeof it.path === 'string' && !out.includes(it.path)) out.push(it.path); if (it?.type === 'group') walk(it.items); } };
  walk(data?.items);
  return out;
}

// on adds the note at the end of the top level, as Obsidian's star does; off removes it wherever it is, groups included
export function setBookmark(data, rel, on, now = Date.now()) {
  const drop = (items) => items.filter((it) => !(it?.type === 'file' && it.path === rel)).map((it) => (it?.type === 'group' && Array.isArray(it.items) ? { ...it, items: drop(it.items) } : it));
  const has = bookmarkedFiles(data).includes(rel);
  if (!on) return has ? { ...data, items: drop(data.items) } : data;
  return has ? data : { ...data, items: [...data.items, { type: 'file', ctime: now, path: rel }] };
}

export const writeBookmarks = (data) => `${JSON.stringify(data, null, 2)}\n`;
