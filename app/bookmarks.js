// Bookmarks in Obsidian's own file, .obsidian/bookmarks.json: { items: [...] }, where an item is a file, folder, search,
// heading, block, graph, url or a group holding more items. Obsidian stores a heading or block bookmark as a file item
// with a subpath (#Heading, #^block). Quorum reads and toggles a note's own bookmark only (a file item with no subpath);
// every other item, and every field Quorum doesn't use, is written back as it was, so Obsidian keeps its bookmarks.

// the parsed file, an empty list when there is none, or null when it isn't a bookmarks file (never written over)
export function parseBookmarks(text) {
  if (text == null || !String(text).trim()) return { items: [] };
  try {
    const data = JSON.parse(String(text));
    return data && typeof data === 'object' && !Array.isArray(data) && (data.items === undefined || Array.isArray(data.items)) ? { ...data, items: data.items ?? [] } : null;
  } catch { return null; }
}

// a bookmark of the note itself; one with a subpath points at a heading or block in it
const own = (it) => it?.type === 'file' && typeof it.path === 'string' && !it.subpath;

// the notes bookmarked, in the order Obsidian lists them, groups included, each once
export function bookmarkedFiles(data) {
  const out = [];
  const walk = (items) => { for (const it of items ?? []) { if (own(it) && !out.includes(it.path)) out.push(it.path); if (it?.type === 'group') walk(it.items); } };
  walk(data?.items);
  return out;
}

// on adds the note at the end of the top level, as Obsidian's star does; off removes it wherever it is, groups included
export function setBookmark(data, rel, on, now = Date.now()) {
  const drop = (items) => items.filter((it) => !(own(it) && it.path === rel)).map((it) => (it?.type === 'group' && Array.isArray(it.items) ? { ...it, items: drop(it.items) } : it));
  const has = bookmarkedFiles(data).includes(rel);
  if (!on) return has ? { ...data, items: drop(data.items) } : data;
  return has ? data : { ...data, items: [...data.items, { type: 'file', ctime: now, path: rel }] };
}

// the bookmarks after a note or folder moves from one path to another: file bookmarks (headings and blocks included)
// and folder bookmarks at that path or inside that folder take the new path; the same data when none do
export function renameBookmarks(data, from, to) {
  const moved = (p) => (p === from ? to : typeof p === 'string' && p.startsWith(`${from}/`) ? `${to}${p.slice(from.length)}` : p);
  let changed = false;
  const walk = (items) => items.map((it) => {
    if (it?.type === 'group' && Array.isArray(it.items)) return { ...it, items: walk(it.items) };
    if ((it?.type === 'file' || it?.type === 'folder') && moved(it.path) !== it.path) { changed = true; return { ...it, path: moved(it.path) }; }
    return it;
  });
  const items = walk(data.items);
  return changed ? { ...data, items } : data;
}

export const writeBookmarks = (data) => `${JSON.stringify(data, null, 2)}\n`;
