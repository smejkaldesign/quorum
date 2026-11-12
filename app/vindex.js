// Live index of the vault: every note parsed once, then kept current by a file watcher, so the graph, backlinks,
// search and renames all read the same picture and edits Claude makes show up in Quorum within a beat.
// Files stay the source of truth; this is a cache that rebuilds from disk.
import { readFileSync, statSync, watch } from 'node:fs';
import path from 'node:path';
import { createResolver, parseNote } from './linkparse.js';
import { graphConfig, noteDate, walk } from './vault.js';
import { clusterColors } from './clusters.js';

const IGNORED = /(^|\/)(\.git|\.obsidian|\.trash|\.claude|node_modules)(\/|$)/;

// isExcludedPath keeps a file out by its path; isDeniedText keeps a note out by what its frontmatter says (a denied
// key); isExcludedText flags and redacts opted-out lines but keeps the note
export function createVaultIndex({ vault, isExcludedPath, isDeniedText = () => false, isExcludedText, redact, onChange, log = () => {} }) {
  const files = new Map(); // rel -> { mtime, size, note, text, flagged, t }
  let resolve = () => null;
  let forward = new Map(); // rel -> [{ to, link }]
  let backward = new Map(); // rel -> [{ from, link }]
  let unresolved = new Map(); // rel -> [link]
  let watcher = null;
  let timer = null;

  // opted-out text never enters the index: lines that name one are replaced before parsing,
  // and the note is flagged so the redaction queue can find it
  function load(rel, st) {
    let raw;
    try { raw = readFileSync(path.join(vault, rel), 'utf8'); } catch { files.delete(rel); return; }
    if (isDeniedText(raw)) { files.delete(rel); return; }
    const flagged = isExcludedText(raw);
    const text = flagged ? redact(raw) : raw;
    files.set(rel, { mtime: st.mtimeMs, size: st.size, note: parseNote(rel, text), text, flagged, t: noteDate(vault, rel, text) });
  }

  // a frontmatter name: counts as an alias, since auto-memory notes link to each other by that slug
  function aliasesOf(rel) {
    const n = files.get(rel)?.note;
    if (!n) return [];
    return typeof n.props.name === 'string' && n.props.name ? [...n.aliases, n.props.name] : n.aliases;
  }

  function relink() {
    const rels = [...files.keys()];
    resolve = createResolver(rels, aliasesOf);
    forward = new Map();
    backward = new Map();
    unresolved = new Map();
    for (const rel of rels) {
      const out = [];
      const missing = [];
      for (const link of files.get(rel).note.links) {
        const to = resolve(link.target, rel);
        if (to && to !== rel) { out.push({ to, link }); (backward.get(to) ?? backward.set(to, []).get(to)).push({ from: rel, link }); }
        else if (!to) missing.push(link);
      }
      forward.set(rel, out);
      if (missing.length) unresolved.set(rel, missing);
    }
  }

  // compare what's on disk with what's indexed; cheap enough (stat only) to run after every burst of changes
  function sync() {
    const seen = new Set();
    const changed = [];
    for (const rel of walk(vault, '', isExcludedPath, [])) {
      seen.add(rel);
      let st;
      try { st = statSync(path.join(vault, rel)); } catch { continue; }
      const f = files.get(rel);
      if (!f || f.mtime !== st.mtimeMs || f.size !== st.size) { load(rel, st); changed.push(rel); }
    }
    for (const rel of [...files.keys()]) if (!seen.has(rel)) { files.delete(rel); changed.push(rel); }
    if (changed.length) relink();
    return changed;
  }

  function start() {
    const t0 = Date.now();
    sync();
    log(`indexed ${files.size} notes in ${Date.now() - t0}ms`);
    try {
      watcher = watch(vault, { recursive: true }, (_ev, name) => {
        if (name && IGNORED.test(String(name))) return;
        clearTimeout(timer);
        timer = setTimeout(() => { const changed = sync(); if (changed.length) onChange(changed); }, 250);
      });
    } catch (err) { log('vault watch failed', String(err)); }
  }

  function stop() { watcher?.close(); clearTimeout(timer); }

  const titleOf = (rel) => files.get(rel)?.note.title ?? path.basename(rel, '.md');
  const lineOf = (rel, n) => (files.get(rel)?.text.split('\n')[n] ?? '').trim();

  // unresolved links become ghost nodes, one per missing name, like Obsidian: a link to nothing is information
  function graph() {
    const { settings, groups } = graphConfig(vault);
    const rels = [...files.keys()];
    const at = new Map(rels.map((r, i) => [r, i]));
    const ghosts = new Map(); // lowercased name -> index
    const ghostNames = [];
    const pairs = new Set();
    const add = (a, b) => { if (a !== b) pairs.add(a < b ? `${a}:${b}` : `${b}:${a}`); };
    for (const [rel, out] of forward) for (const { to } of out) {
      const a = at.get(rel), b = at.get(to);
      if (a !== undefined && b !== undefined) add(a, b);
    }
    for (const [rel, missing] of unresolved) for (const link of missing) {
      const name = link.target.replace(/\.md$/i, '').split('/').pop().trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (!ghosts.has(key)) { ghosts.set(key, rels.length + ghostNames.length); ghostNames.push(name); }
      add(at.get(rel), ghosts.get(key));
    }
    const links = [...pairs].map((k) => k.split(':').map(Number));
    const deg = new Array(rels.length + ghostNames.length).fill(0);
    for (const [a, b] of links) { deg[a]++; deg[b]++; }
    // notes that link among themselves share a color, so a vault reads as clusters the moment it connects
    const auto = clusterColors([...rels, ...ghostNames.map((g) => `?${g}`)], links, (i) => i >= rels.length);
    return {
      nodes: [
        ...rels.map((rel, i) => ({
          id: rel, name: path.basename(rel, '.md'), deg: deg[i], t: files.get(rel).t,
          // first matching group wins, same as Obsidian; otherwise the cluster color
          color: groups.find((g) => g.match(rel))?.color ?? auto[i],
        })),
        ...ghostNames.map((name, j) => ({ id: `?${name}`, name, deg: deg[rels.length + j], t: 0, color: null, ghost: true })),
      ],
      links,
      settings,
      groups: groups.map(({ query, color }) => ({ query, color })),
    };
  }

  // every missing link target, with who links to it, plus the closest real notes as fix suggestions
  function linkHealth() {
    const byName = new Map();
    for (const [rel, missing] of unresolved) for (const link of missing) {
      const name = link.target.replace(/\.md$/i, '').trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const e = byName.get(key) ?? byName.set(key, { target: name, sources: new Set() }).get(key);
      e.sources.add(rel);
    }
    // compare names loosely: no date prefix, no Claude memory type prefix (feedback_, reference_...), no punctuation
    const norm = (x) => x.toLowerCase().replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/^(feedback|reference|project|user)_/, '').replace(/[^a-z0-9]+/g, '');
    const index = [...files.keys()].map((rel) => ({ rel, key: norm(path.basename(rel)), alias: aliasesOf(rel).map(norm), title: norm(files.get(rel).note.title) }));
    return [...byName.values()].map(({ target, sources }) => {
      const k = norm(target.split('/').pop());
      const candidates = k.length < 3 ? [] : index
        .map((n) => ({ rel: n.rel, score: n.key === k || n.alias.includes(k) || n.title === k ? 3 : n.key.includes(k) || k.includes(n.key) ? (Math.min(k.length, n.key.length) / Math.max(k.length, n.key.length) > 0.6 ? 2 : 0) : 0 }))
        .filter((c) => c.score > 0).sort((a, b) => b.score - a.score || a.rel.length - b.rel.length).slice(0, 3)
        .map((c) => ({ rel: c.rel, title: titleOf(c.rel), name: typeof files.get(c.rel).note.props.name === 'string' ? files.get(c.rel).note.props.name : null, exact: c.score === 3 }));
      return { target, sources: [...sources], count: sources.size, candidates };
    }).sort((a, b) => b.count - a.count || a.target.localeCompare(b.target));
  }

  function backlinks(rel) {
    return (backward.get(rel) ?? []).map(({ from, link }) => ({ rel: from, title: titleOf(from), line: link.line, context: lineOf(from, link.line) }));
  }

  function outgoing(rel) {
    const f = files.get(rel);
    if (!f) return [];
    return f.note.links.map((link) => {
      const to = resolve(link.target, rel);
      return { target: link.target, rel: to, title: to ? titleOf(to) : link.target, anchor: link.anchor, embed: link.embed };
    });
  }

  // words must all appear; title and path hits rank above body hits; snippets come from redacted text
  function search(q, limit = 30) {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const hits = [];
    for (const [rel, f] of files) {
      const title = f.note.title.toLowerCase();
      const hay = `${rel.toLowerCase()}\n${f.text.toLowerCase()}`;
      if (!words.every((w) => hay.includes(w) || title.includes(w))) continue;
      let score = 0;
      for (const w of words) { if (title.includes(w)) score += 10; if (rel.toLowerCase().includes(w)) score += 4; }
      const lines = f.text.split('\n');
      const n = lines.findIndex((l) => words.some((w) => l.toLowerCase().includes(w)));
      score += Math.min(5, words.reduce((s, w) => s + (hay.split(w).length - 1), 0) / 4);
      hits.push({ rel, title: f.note.title, score, line: n, snippet: n >= 0 ? lines[n].trim().slice(0, 200) : '' });
    }
    return hits.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel)).slice(0, limit);
  }

  // after a rule change: forget everything and read the folder again, so a note that is now denied drops out
  function rebuild() { files.clear(); forward = new Map(); backward = new Map(); unresolved = new Map(); const changed = sync(); if (changed.length) onChange?.(changed); return changed; }

  return {
    start, stop, sync, rebuild, graph, backlinks, outgoing, search, resolve: (target, from) => resolve(target, from),
    note: (rel) => files.get(rel)?.note ?? null,
    linkHealth,
    aliasesOf,
    flagged: () => [...files].filter(([, f]) => f.flagged).map(([rel]) => rel),
    unresolved: (rel) => (unresolved.get(rel) ?? []).map((l) => l.target),
    size: () => files.size,
    rels: () => [...files.keys()],
  };
}
