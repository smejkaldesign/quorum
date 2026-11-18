// Live index of the vault: every note parsed once, then kept current by a file watcher, so the graph, backlinks,
// search and renames all read the same picture and edits Claude makes show up in Quorum within a beat.
// Files stay the source of truth; this is a cache that rebuilds from disk.
import { closeSync, openSync, readFileSync, readSync, statSync, watch } from 'node:fs';
import path from 'node:path';
import { createResolver, parseNote } from './linkparse.js';
import { SKIP, graphConfig, noteDate, walk } from './vault.js';
import { clusterAssign, clusterLabels, groupInfo, wrapperFolders } from './clusters.js';
import { isGenerated, linkReport, reportLine } from './linkRules.js';

// the folders walk() skips, as a test on a watcher path (the same list, so the two can never disagree)
const IGNORED = new RegExp(`(^|/)(${[...SKIP].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(/|$)`);
const BATCH = 200;
// the only characters at or above U+0080 whose lowercase holds ASCII: U+0130 (to i plus a combining dot) and the Kelvin
// sign U+212A (to k). The search test checks this list against every code point
export const EXOTIC = /[\u0130\u212a]/;
const NON_ASCII = /[^\x00-\x7f]/;
const escapeRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// how often w occurs in s without overlaps (as s.split(w).length - 1 counts), stopping at max, and where it first is
function countOf(s, w, max) {
  let n = 0, first = -1, at = s.indexOf(w);
  while (at >= 0 && n < max) { if (!n) first = at; n++; at = s.indexOf(w, at + w.length); }
  return [n, first];
}
// the same count with a case-insensitive RegExp of the word on the original text
function countRe(s, re, max) {
  re.lastIndex = 0;
  let n = 0, first = -1, m;
  while (n < max && (m = re.exec(s))) { if (!n) first = m.index; n++; }
  return [n, first];
}
// line n of a text (0-based, split on \n), without splitting the whole text
function nthLine(text, n) {
  let start = 0;
  for (let i = 0; i < n; i++) { const nl = text.indexOf('\n', start); if (nl < 0) return ''; start = nl + 1; }
  const end = text.indexOf('\n', start);
  return text.slice(start, end < 0 ? text.length : end);
}
// how many \n come before position at
function lineAt(text, at) {
  let n = 0;
  for (let i = text.indexOf('\n'); i >= 0 && i < at; i = text.indexOf('\n', i + 1)) n++;
  return n;
}
// a note larger than this is indexed by its first INDEX_MAX bytes, cut at a line end: its title, frontmatter, links and
// search text come from that head. A session log that grows to 100 MB was read, parsed and lowercased whole on every
// save, which held the main process for seconds and kept 400 MB of copies of it in the index
export const INDEX_MAX = 2 * 1024 * 1024;
export function readHead(abs, max = INDEX_MAX) {
  const fd = openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(max);
    const n = readSync(fd, buf, 0, max, 0);
    // a newline byte never sits inside a UTF-8 character, so the cut keeps every character whole
    const end = buf.lastIndexOf(0x0a, n - 1);
    return buf.toString('utf8', 0, end > 0 ? end : n);
  } finally { closeSync(fd); }
}

// isExcludedPath keeps a file out by its path; isDeniedText keeps a note out by what its frontmatter says (a denied
// key); isExcludedText flags and redacts opted-out lines but keeps the note. onPaths hears each batch the watcher
// names before onChange. renamed() gives the person's own names for
// graph clusters, by cluster key; forget(keys) is told which of them no longer match a cluster
export function createVaultIndex({ vault, isExcludedPath, isDeniedText = () => false, isExcludedText, redact, onChange, onPaths = () => {}, renamed = () => ({}), forget = () => {}, log = () => {} }) {
  const files = new Map(); // rel -> { mtime, size, note, text, flagged, t }
  // linkHealth's answer: the missing links scored against every note, worked out again only after the index changed,
  // since Notifications and Memory health ask for it on every refresh. Callers read it and never change it
  let health = null;
  let resolve = () => null;
  let forward = new Map(); // rel -> [{ to, link }]
  let backward = new Map(); // rel -> [{ from, link }]
  let unresolved = new Map(); // rel -> [link]
  let dirs = new Set(); // every folder rel that holds an indexed note, so a vanished path can be told from a file
  let watcher = null;
  let timer = null;
  let stopped = false;
  let built = false; // the whole vault has been read once, so a cluster that is missing is gone

  const remember = (rel) => { let i = rel.indexOf('/'); while (i > 0) { dirs.add(rel.slice(0, i)); i = rel.indexOf('/', i + 1); } };
  const rememberAll = () => { dirs = new Set(); for (const rel of files.keys()) remember(rel); };

  // opted-out text never enters the index: lines that name one are replaced before parsing,
  // and the note is flagged so the redaction queue can find it
  function load(rel, st) {
    health = null;
    let raw;
    const cut = st.size > INDEX_MAX;
    try { raw = cut ? readHead(path.join(vault, rel)) : readFileSync(path.join(vault, rel), 'utf8'); } catch { files.delete(rel); return; }
    if (isDeniedText(raw)) { files.delete(rel); return; }
    // a large note that grew only past its head (a session log gets a line at its end on every save) keeps its entry:
    // the same head text and parse, so a save makes no new copy of 2 MB to index and then collect
    const prev = files.get(rel);
    if (cut && prev?.cut && !prev.flagged && prev.text === raw) { prev.mtime = st.mtimeMs; prev.size = st.size; return; }
    const flagged = isExcludedText(raw);
    const text = flagged ? redact(raw) : raw;
    // exotic: the note holds a character whose lowercase is ASCII, so search lowercases it (see search)
    files.set(rel, { mtime: st.mtimeMs, size: st.size, note: parseNote(rel, text), text, flagged, t: noteDate(vault, rel, text), ...(cut ? { cut } : {}), ...(EXOTIC.test(text) ? { exotic: true } : {}) });
  }

  // a frontmatter name: counts as an alias, since auto-memory notes link to each other by that slug
  function aliasesOf(rel) {
    const n = files.get(rel)?.note;
    if (!n) return [];
    return typeof n.props.name === 'string' && n.props.name ? [...n.aliases, n.props.name] : n.aliases;
  }

  function relink() {
    health = null;
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
    if (changed.length) { relink(); rememberAll(); }
    built = true;
    return changed;
  }

  // the paths the watcher named: each file is re-read or dropped on its own, and only a folder appearing or going
  // falls back to the full walk. A dot folder or an ignored one never costs anything (walk skips them too)
  const skipped = (rel) => rel.split('/').some((seg) => seg.startsWith('.') || SKIP.has(seg));
  function syncPaths(rels) {
    const changed = [];
    let everything = false;
    for (const rel of rels) {
      if (!rel || skipped(rel)) continue;
      let st = null;
      try { st = statSync(path.join(vault, rel)); } catch {}
      if (st?.isDirectory()) { everything = true; break; }
      if (!st) {
        if (rel.endsWith('.md')) { if (files.delete(rel)) { health = null; changed.push(rel); } }
        else if (dirs.has(rel)) { everything = true; break; }
        continue;
      }
      if (!rel.endsWith('.md')) continue;
      if (isExcludedPath(rel)) { if (files.delete(rel)) { health = null; changed.push(rel); } continue; }
      const f = files.get(rel);
      if (!f || f.mtime !== st.mtimeMs || f.size !== st.size) { load(rel, st); changed.push(rel); }
    }
    // a folder moved: the walk finds the rest and relinks, so the files read above are reported with it
    if (everything) return [...new Set([...changed, ...sync()])];
    if (changed.length) { relink(); rememberAll(); }
    return changed;
  }

  // the first read of the vault, in batches that let IPC through between them, so a large vault never holds the
  // window's first questions. Answers during the build see what is loaded so far; the watcher starts once it is done
  async function start() {
    const t0 = Date.now();
    const rels = walk(vault, '', isExcludedPath, []);
    for (let i = 0; i < rels.length; i += BATCH) {
      for (const rel of rels.slice(i, i + BATCH)) {
        let st;
        try { st = statSync(path.join(vault, rel)); } catch { continue; }
        load(rel, st);
      }
      if (i + BATCH < rels.length) await new Promise((r) => setImmediate(r));
      if (stopped) return;
    }
    relink();
    rememberAll();
    built = true;
    log(`indexed ${files.size} notes in ${Date.now() - t0}ms`);
    if (files.size) onChange([...files.keys()]);
    try {
      const pending = new Set();
      let everything = false;
      watcher = watch(vault, { recursive: true }, (_ev, name) => {
        if (name && IGNORED.test(String(name))) return;
        if (name) pending.add(String(name).split(path.sep).join('/')); else everything = true;
        clearTimeout(timer);
        timer = setTimeout(() => {
          const rels = [...pending];
          pending.clear();
          // every path the watcher named, before the index filters them (main's tree cache reads these), or null for all
          try { onPaths(everything ? null : rels); } catch (err) { log('vault paths', String(err)); }
          const changed = everything ? sync() : syncPaths(rels);
          everything = false;
          if (changed.length) onChange(changed);
        }, 250);
      });
    } catch (err) { log('vault watch failed', String(err)); }
  }

  function stop() { stopped = true; watcher?.close(); clearTimeout(timer); }

  const titleOf = (rel) => files.get(rel)?.note.title ?? path.basename(rel, '.md');
  const lineOf = (rel, n) => { const t = files.get(rel)?.text; return t === undefined ? '' : nthLine(t, n).trim(); };

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
    const { colors: auto, cluster } = clusterAssign([...rels, ...ghostNames.map((g) => `?${g}`)], links, (i) => i >= rels.length);
    // `cluster` names whichever colored the note, with the person's own name for it over the generated one;
    // clusterKey is what a rename is kept against and clusterPath the folder the name stands for
    const own = renamed() ?? {};
    const autoLabels = clusterLabels(rels, cluster.slice(0, rels.length), deg, rels.map((rel) => path.basename(rel, '.md')), own);
    // first matching group wins, same as Obsidian; otherwise the cluster color
    const groupOf = rels.map((rel) => groups.find((g) => g.match(rel)) ?? null);
    const members = new Map(groups.map((g) => [g, []]));
    groupOf.forEach((g, i) => { if (g) members.get(g).push(rels[i]); });
    const wrapper = wrapperFolders(rels);
    const groupLabels = new Map(groups.map((g) => [g, groupInfo(g.query, members.get(g), wrapper, own)]));
    const labelFor = (i) => (groupOf[i] ? groupLabels.get(groupOf[i]) : auto[i] ? autoLabels[i] : null);
    const labels = rels.map((_, i) => labelFor(i));
    // a kept name whose cluster is gone (its folder moved, its group was removed) is dropped, once the vault is read
    if (built) {
      const live = new Set(labels.filter(Boolean).map((l) => l.key));
      const stale = Object.keys(own).filter((k) => !live.has(k));
      if (stale.length) forget(stale);
    }
    return {
      nodes: [
        ...rels.map((rel, i) => {
          const l = labels[i];
          return { id: rel, name: path.basename(rel, '.md'), deg: deg[i], t: files.get(rel).t, color: groupOf[i]?.color ?? auto[i], cluster: l?.name ?? null, clusterKey: l?.key ?? null, clusterPath: l?.folder ?? null };
        }),
        ...ghostNames.map((name, j) => ({ id: `?${name}`, name, deg: deg[rels.length + j], t: 0, color: null, ghost: true })),
      ],
      links,
      settings,
      groups: groups.map(({ query, color }) => ({ query, color })),
    };
  }

  // every missing link target, with who links to it, the closest real notes as fix suggestions, and the text around
  // each link. Memory health (memoryHealth.js) picks a fix from these: point the link at a note that is clearly the one
  // meant, write the missing note when the linking notes say enough about it, or take the dead link out
  function linkHealth() {
    health ??= scoreLinks();
    return health;
  }
  function scoreLinks() {
    const byName = new Map();
    // a generated report or log restates links found elsewhere: it is never a source (linkRules.js GENERATED_RULES)
    const generated = (rel) => isGenerated(rel, files.get(rel)?.note.props);
    // a note or a line that reports on links (a drift report, a lint log) shows link names as examples or findings
    // about other notes: those are never sources either (linkRules.js linkReport, reportLine)
    const reports = new Map();
    const split = new Map();
    const linesOf = (rel) => split.get(rel) ?? split.set(rel, (files.get(rel)?.text ?? '').split('\n')).get(rel);
    const reportNote = (rel) => reports.get(rel) ?? reports.set(rel, linkReport(files.get(rel)?.text ?? '', files.get(rel)?.note.title)).get(rel);
    for (const [rel, missing] of unresolved) for (const link of missing) {
      if (generated(rel) || reportNote(rel) || reportLine(linesOf(rel)[link.line], link.raw)) continue;
      const name = link.target.replace(/\.md$/i, '').trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const e = byName.get(key) ?? byName.set(key, { target: name, sources: new Set(), links: 0, at: [] }).get(key);
      e.sources.add(rel);
      e.links++;
      e.at.push({ rel, line: link.line });
    }
    // compare names loosely: no date prefix, no Claude memory type prefix (feedback_, reference_...), no punctuation
    const norm = (x) => x.toLowerCase().replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/^(feedback|reference|project|user)[_-]/, '').replace(/[^a-z0-9]+/g, '');
    // the words of a name, without dates, numbers and filler words, for matching names that differ in a date or a word
    const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'with', 'md', 'note', 'notes', 'feedback', 'reference', 'project', 'user']);
    const words = (x) => [...new Set(String(x).toLowerCase().replace(/\.md$/, '').split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w)))];
    // words that name a kind of document: two notes that share only these are different documents, and a PRD is not the
    // code review of the same feature
    const KIND = new Set(['prd', 'spec', 'review', 'code', 'report', 'retro', 'retrospective', 'plan', 'brief', 'research', 'analysis', 'summary', 'notes', 'doc', 'docs', 'page', 'deep', 'dive', 'kickoff', 'recap', 'audit', 'proposal', 'requirements', 'presentation', 'deck', 'draft', 'v1', 'v2', 'v3', 'synthesis', 'findings', 'teardown', 'guide', 'playbook', 'index']);
    const kinds = (ws) => new Set([...ws].filter((w) => KIND.has(w)));
    const dirOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
    const index = [...files.keys()].filter((rel) => !generated(rel)).map((rel) => ({ rel, key: norm(path.basename(rel)), alias: aliasesOf(rel).map(norm), title: norm(files.get(rel).note.title), words: new Set([...words(path.basename(rel)), ...words(files.get(rel).note.title)]) }));
    // a link's line as plain words: the link itself becomes its text, list marks and markup go
    const plain = (t) => t.replace(/!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_, a, b) => b ?? a.split('/').pop()).replace(/^\s*(?:[-*+]|\d+\.)\s+/, '').replace(/[*`>#]+/g, '').replace(/\s+/g, ' ').trim();
    return [...byName.values()].map(({ target, sources, links, at }) => {
      const last = target.split('/').pop();
      const k = norm(last);
      const tw = words(last);
      const srcDirs = new Set([...sources].map(dirOf));
      // the notes the linking notes already link to or from: a candidate among them sits in the same part of the graph
      const near = new Set();
      for (const s of sources) {
        for (const o of forward.get(s) ?? []) near.add(o.to);
        for (const b of backward.get(s) ?? []) near.add(b.from);
      }
      const scored = k.length < 3 && tw.length === 0 ? [] : index.map((n) => {
        // a linking note is never the fix for its own link
        if (sources.has(n.rel)) return null;
        if (n.key === k || n.alias.includes(k) || n.title === k) return { n, exact: true, score: 1, shared: tw };
        const shared = tw.filter((w) => n.words.has(w));
        if (shared.length < 2 && !(shared.length === 1 && tw.length === 1 && n.words.size === 1)) return null;
        const union = new Set([...tw, ...n.words]).size;
        // the topic words (not kind words) the names share, and how much of the link's topic they cover
        const topic = tw.filter((w) => !KIND.has(w));
        const sharedTopic = shared.filter((w) => !KIND.has(w));
        const tk = kinds(tw);
        const nk = kinds(n.words);
        const kindClash = tk.size > 0 && nk.size > 0 && ![...tk].some((w) => nk.has(w));
        if (sharedTopic.length < 2 && !(sharedTopic.length === 1 && topic.length === 1)) return null;
        return { n, exact: false, score: shared.length / union, shared: sharedTopic, cover: topic.length ? sharedTopic.length / topic.length : 0, kindClash };
      }).filter(Boolean);
      const candidates = scored
        .map((c) => ({ ...c, neighbor: near.has(c.n.rel), sameFolder: srcDirs.has(dirOf(c.n.rel)) }))
        .sort((a, b) => Number(b.exact) - Number(a.exact) || Number(a.kindClash) - Number(b.kindClash) || (b.cover ?? 0) - (a.cover ?? 0) || (b.score + (b.neighbor ? 0.2 : 0) + (b.sameFolder ? 0.1 : 0)) - (a.score + (a.neighbor ? 0.2 : 0) + (a.sameFolder ? 0.1 : 0)) || a.n.rel.length - b.n.rel.length)
        .slice(0, 3)
        .map((c) => ({ rel: c.n.rel, title: titleOf(c.n.rel), name: typeof files.get(c.n.rel).note.props.name === 'string' ? files.get(c.n.rel).note.props.name : null, exact: c.exact, score: Math.round(c.score * 100) / 100, cover: c.exact ? 1 : Math.round((c.cover ?? 0) * 100) / 100, kindClash: !!c.kindClash, shared: c.shared, neighbor: c.neighbor, sameFolder: c.sameFolder }));
      const contexts = at.slice(0, 6).map(({ rel, line }) => ({ rel, title: titleOf(rel), text: plain(lineOf(rel, line)).slice(0, 280) })).filter((c) => c.text);
      const lastAt = Math.max(0, ...[...sources].map((r) => files.get(r)?.mtime ?? 0)) || null;
      // each linking note's confidential mark, so a note written from them stays as private as they are
      const confidential = [...sources].map((r) => files.get(r)?.note.props.confidential).filter((v) => v != null && !(Array.isArray(v) && !v.length));
      return { target, sources: [...sources], count: sources.size, links, lastAt, candidates, contexts, confidential };
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

  // words must all appear; title and path hits rank above body hits; snippets come from redacted text. The index keeps
  // no lowercased copy of the notes: an ASCII word is matched with a case-insensitive RegExp on the text, which finds
  // the same places as the lowercased text does unless the note is exotic; an exotic note, or a query with a word
  // outside ASCII, lowercases the note for that query. The score counts at most 20 matches, where its cap of 5 is
  function search(q, limit = 30) {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const ascii = !words.some((w) => NON_ASCII.test(w));
    const res = ascii ? words.map((w) => new RegExp(escapeRe(w), 'gi')) : null;
    const hits = [];
    for (const [rel, f] of files) {
      const title = f.note.title.toLowerCase();
      const relLow = rel.toLowerCase();
      const low = ascii && !f.exotic ? null : f.text.toLowerCase();
      let score = 0, total = 0, first = -1, ok = true;
      for (let i = 0; i < words.length; i++) {
        const w = words[i];
        const [inRel] = countOf(relLow, w, Math.max(1, 20 - total));
        total += inRel;
        const [inText, at] = low !== null ? countOf(low, w, Math.max(1, 20 - total)) : countRe(f.text, res[i], Math.max(1, 20 - total));
        total += inText;
        if (!inRel && !inText && !title.includes(w)) { ok = false; break; }
        if (at >= 0 && (first < 0 || at < first)) first = at;
        if (title.includes(w)) score += 10;
        if (inRel) score += 4;
      }
      if (!ok) continue;
      score += Math.min(5, total / 4);
      const n = first < 0 ? -1 : lineAt(low ?? f.text, first);
      hits.push({ rel, title: f.note.title, score, line: n, snippet: n >= 0 ? nthLine(f.text, n).trim().slice(0, 200) : '' });
    }
    return hits.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel)).slice(0, limit);
  }

  // after a rule change: forget everything and read the folder again, so a note that is now denied drops out
  function rebuild() { health = null; files.clear(); forward = new Map(); backward = new Map(); unresolved = new Map(); const changed = sync(); if (changed.length) onChange?.(changed); return changed; }

  return {
    start, stop, sync, syncPaths, rebuild, graph, backlinks, outgoing, search, resolve: (target, from) => resolve(target, from),
    note: (rel) => files.get(rel)?.note ?? null,
    linkHealth,
    aliasesOf,
    flagged: () => [...files].filter(([, f]) => f.flagged).map(([rel]) => rel),
    unresolved: (rel) => (unresolved.get(rel) ?? []).map((l) => l.target),
    // the missing links of one note with the line each is on (0-based), for the Memory health review
    missingIn: (rel) => (unresolved.get(rel) ?? []).map((l) => ({ target: l.target.replace(/\.md$/i, '').trim(), line: l.line })),
    size: () => files.size,
    rels: () => [...files.keys()],
    // the notes indexed by their head only (INDEX_MAX): a link past the head is in none of the backlinks
    cutRels: () => [...files].filter(([, f]) => f.cut).map(([rel]) => rel),
    // every note as the review rules read it (rules/index.js): its path, text, parsed note, file time, and how many
    // notes link to it and how many links it has to other notes
    // cut: the note is larger than INDEX_MAX and text is its head only
    snapshot: () => [...files].map(([rel, f]) => ({ rel, text: f.text, note: f.note, mtime: f.mtime, size: f.size, ...(f.cut ? { cut: true } : {}), inbound: new Set((backward.get(rel) ?? []).map((b) => b.from)).size, outbound: (forward.get(rel) ?? []).length })),
  };
}
