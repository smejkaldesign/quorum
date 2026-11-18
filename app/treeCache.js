// The Memory tab's notes tree (vault.js vaultTree), walked once and kept while the index's watcher runs (main.js). The
// watcher's paths keep it current: a change to a note the tree lists updates its times in place, a file that is not a
// note changes nothing, and a new or gone note or a folder change drops it, so the next read walks again.
// statOf(vault, rel) answers fs Stats or null; skip(rel) is true for a path the walk never enters
export function createTreeCache({ walk, statOf, skip }) {
  let kept = null; // { vault, tree, byRel }

  function get(vault, keep) {
    if (kept?.vault === vault) return kept.tree;
    const tree = walk(vault);
    if (keep) {
      const byRel = new Map();
      const index = (items) => { for (const it of items) { byRel.set(it.path, it); if (it.children) index(it.children); } };
      index(tree);
      kept = { vault, tree, byRel };
    } else kept = null;
    return tree;
  }

  // rels: the paths one watcher batch named, or null when it could not name them
  function paths(rels) {
    if (!kept) return;
    if (!rels) { kept = null; return; }
    for (const rel of rels) {
      if (skip(rel)) continue;
      const item = kept.byRel.get(rel);
      const st = statOf(kept.vault, rel);
      if (item && !item.dir && st?.isFile()) { item.mtime = st.mtimeMs; item.ctime = st.birthtimeMs; continue; }
      if (item?.dir && st?.isDirectory()) continue;
      if (!item && !rel.endsWith('.md') && (!st || st.isFile())) continue;
      kept = null;
      return;
    }
  }

  return { get, paths, drop: () => { kept = null; } };
}
