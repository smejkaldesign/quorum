// A small stand-in for the memory graph (app/graph/), for the search eval only: the two calls hybrid.js reads, find and
// edgesOf, in the spec's shapes. It reads body links (links_to) and the frontmatter fields attendees (attended),
// people (mentions), project (about) and supersedes. The real graph replaces it once its store lands.
const FIELD_KIND = { attendees: 'attended', people: 'mentions', project: 'about', projects: 'about', supersedes: 'supersedes' };
const linksIn = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]).flatMap((x) => [...String(x).matchAll(/\[\[([^\]|#]+)/g)].map((m) => m[1].trim()));

export function miniGraph(snapshot, resolve) {
  const byNode = new Map();
  const names = new Map();
  const add = (src, dst, kind) => {
    if (!dst || src === dst) return;
    const e = { src, dst, kind, provenance: 'explicit', superseded_by: null, valid_to: null };
    for (const id of [src, dst]) (byNode.get(id) ?? byNode.set(id, []).get(id)).push(e);
  };
  const name = (n, node) => { const k = String(n).trim().toLowerCase(); if (k) (names.get(k) ?? names.set(k, []).get(k)).push(node); };
  for (const { rel, note } of snapshot) {
    const id = `note:${rel}`;
    const node = { id, kind: 'note', name: note.title, rel };
    name(note.title, node);
    for (const a of note.aliases ?? []) name(a, node);
    for (const l of note.links ?? []) { const to = resolve(l.target, rel); if (to) add(id, `note:${to}`, l.embed ? 'embeds' : 'links_to'); }
    for (const [field, kind] of Object.entries(FIELD_KIND)) for (const t of linksIn(note.props?.[field])) { const to = resolve(t, rel); if (to) add(id, `note:${to}`, kind); }
  }
  for (const list of names.values()) { const seen = new Set(); list.splice(0, list.length, ...list.filter((n) => !seen.has(n.id) && seen.add(n.id))); }
  return {
    find: (n) => names.get(String(n).trim().toLowerCase()) ?? [],
    edgesOf(id, { dir = 'both', kinds = null, current = true } = {}) {
      return (byNode.get(id) ?? []).filter((e) => (dir === 'both' || (dir === 'out' ? e.src === id : e.dst === id)) && (!kinds || kinds.includes(e.kind)) && (!current || e.superseded_by == null));
    },
  };
}
