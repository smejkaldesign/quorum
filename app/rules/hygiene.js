// Vault hygiene: what tools and agents leave in a vault that a person never wrote and nobody reads.
//   1. Litter: temp folders from test runs (name-XXXXXX, TemporaryDirectory.*), lock folders and build output that hold
//      no note another note links to. Approve moves them to the Trash and, in a git vault with a .gitignore, ignores
//      their pattern.
//   2. Runaway notes: a note over the size limit or that grew more than five times in a week, and a note that holds the
//      same block word for word 20 or more times (blocks start at the note's entry heading level). Approve keeps the
//      first and last copy of each repeated block and everything else, after a backup copy goes to Quorum's data folder.
//   3. Uncommitted notes in a git vault: notes untracked or changed for more than 7 days, as one item. Approve stages and
//      commits them on the current branch. A branch behind its upstream or a merge in progress stops it.
// The folder walk and git status run once per full sweep in the memory engine (vaultHygiene.js scanHygiene) and reach
// this rule as ctx.hygiene. This module reads no files, so the tests and the planner use the same functions.
import { finding, plural, quote } from './common.js';
import { secretKind } from './secrets.js';

export const rule = { id: 'note.hygiene', version: 1, label: 'Vault upkeep: temp folders, runaway notes and uncommitted notes' };
export const SIZE_LIMIT = 1024 * 1024;
export const GROWTH = 5;
// a note smaller than this that grew fivefold is still a short note
export const GROWTH_FLOOR = 64 * 1024;
export const REPEATS = 20;
export const STALE_DAYS = 7;

const HEADING = /^(#{1,6})\s+\S/;
const FENCE = /^\s*(```|~~~)/;
const n = (x) => Number(x).toLocaleString('en-US');
export const mb = (bytes) => (bytes >= 1024 * 1024 ? `${n(Math.round(bytes / (1024 * 1024)))} MB` : bytes >= 1024 ? `${n(Math.round(bytes / 1024))} KB` : `${n(bytes)} bytes`);

// the level a note's entries sit at: the smallest heading level that two or more headings outside fenced code use, so a
// single title heading above the entries does not count. null when no level repeats
function entryLevel(lines) {
  const n = new Map();
  let fenced = false;
  for (const line of lines) {
    if (FENCE.test(line)) { fenced = !fenced; continue; }
    const h = !fenced && line.match(HEADING);
    if (h) n.set(h[1].length, (n.get(h[1].length) ?? 0) + 1);
  }
  const levels = [...n].filter(([, c]) => c >= 2).map(([l]) => l);
  return levels.length ? Math.min(...levels) : null;
}

// the note split into blocks at its entry level only: the text before the first entry, then one block per entry heading
// up to the next one, sub-headings and fenced code included. Each block keeps its own line breaks, so joining them gives
// the text back
function blocksOf(text) {
  const lines = String(text ?? '').split('\n');
  const level = entryLevel(lines);
  const out = [];
  let cur = [];
  let fenced = false;
  for (const line of lines) {
    if (FENCE.test(line)) fenced = !fenced;
    const h = !fenced && level != null && line.match(HEADING);
    const entry = h && h[1].length === level;
    if (entry && cur.length) { out.push({ text: cur.join('\n'), entry: cur.isEntry }); cur = []; }
    if (entry) cur.isEntry = true;
    cur.push(line);
  }
  out.push({ text: cur.join('\n'), entry: !!cur.isEntry });
  return out;
}
// two copies of a block match only when their text is the same once runs of whitespace are one space: a date, a count
// or a word that differs makes them different blocks
const blockKey = (b) => b.replace(/\s+/g, ' ').trim();

// the blocks a note holds REPEATS or more times, word for word: [{ heading, count }], most copies first
export function repeatedBlocks(text, min = REPEATS) {
  const counts = new Map();
  for (const b of blocksOf(text)) {
    if (!b.entry) continue;
    const k = blockKey(b.text);
    const e = counts.get(k) ?? counts.set(k, { heading: b.text.split('\n')[0].replace(/^#+\s+/, '').trim(), count: 0 }).get(k);
    e.count++;
  }
  return [...counts.values()].filter((e) => e.count >= min).sort((a, b) => b.count - a.count);
}

// the note with each block repeated word for word cut to its first and last copy; every other block stays where it was.
// Answers { text, removed: copies taken out, blocks: how many repeated blocks }
export function compactText(text, min = REPEATS) {
  const blocks = blocksOf(text);
  const keys = blocks.map((b) => (b.entry ? blockKey(b.text) : null));
  const total = new Map();
  for (const k of keys) if (k) total.set(k, (total.get(k) ?? 0) + 1);
  const seen = new Map();
  const kept = [];
  let removed = 0;
  blocks.forEach((b, i) => {
    const k = keys[i];
    const all = k ? total.get(k) : 0;
    if (!k || all < min) { kept.push(b.text); return; }
    const at = (seen.get(k) ?? 0) + 1;
    seen.set(k, at);
    if (at === 1 || at === all) kept.push(b.text);
    else removed++;
  });
  return { text: kept.join('\n'), removed, blocks: [...total.values()].filter((c) => c >= min).length };
}

// the words for what made the litter: [singular noun, plural noun, where it came from]
function litterWhat(kinds) {
  const k = new Set(kinds);
  if (k.size === 1 && k.has('temp')) return ['temp folder', 'temp folders', 'from test runs'];
  if (k.size === 1 && k.has('lock')) return ['lock folder', 'lock folders', 'that tools left'];
  if (k.size === 1 && k.has('build')) return ['build output folder', 'build output folders', 'from builds'];
  return ['temp folder', 'temp, lock and build folders', 'that tools and test runs left'];
}

function litterFinding(h) {
  const dirs = h.litter ?? [];
  if (!dirs.length) return null;
  const bytes = dirs.reduce((s, d) => s + (d.bytes ?? 0), 0);
  const [one, many, from] = litterWhat(dirs.map((d) => d.kind));
  const ignore = h.git?.gitignore ? [...new Set(dirs.map((d) => d.ignore).filter(Boolean))] : [];
  const count = `${n(dirs.length)} ${dirs.length === 1 ? one : many}`;
  const where = new Map();
  for (const d of dirs) { const top = d.rel.includes('/') ? d.rel.slice(0, d.rel.indexOf('/')) : 'the vault folder'; where.set(top, (where.get(top) ?? 0) + 1); }
  return finding(rule, {
    key: 'litter', target: 'litter', notes: [],
    title: `${count} ${from} take ${mb(bytes)} of the vault`,
    problem: 'No note links to anything in them. They slow every folder walk, show up in search and the file tree, and clutter git status.',
    proposal: `Move ${count} (${mb(bytes)}) ${from} to the Trash${ignore.length ? ' and ignore them in git' : ''}.`,
    evidence: [
      ...[...where].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([top, c]) => `${plural(c, 'folder')} in ${top}`),
      ...dirs.slice(0, 3).map((d) => `${d.rel} (${mb(d.bytes ?? 0)})`),
      ...(ignore.length ? [`Patterns to ignore: ${ignore.slice(0, 6).join(', ')}`] : []),
    ],
    // the fingerprint holds the kinds and the order of magnitude of the count, so a few more test runs do not bring a
    // dismissed item back
    facts: [`kinds:${[...new Set(dirs.map((d) => d.kind))].sort().join(',')}`, `count:${String(dirs.length).length}`],
    meta: [['Folders', n(dirs.length)], ['Size', mb(bytes)]],
    fix: { kind: 'trashdirs', dirs: dirs.map((d) => d.rel), ignore, gitignore: h.git?.gitignore ?? null, bytes, line: `Move ${count} (${mb(bytes)}) ${from} to the Trash${ignore.length ? ' and ignore them in git' : ''}` },
  });
}

function runawayFindings(notes, h) {
  const out = [];
  const past = h?.history ?? {};
  for (const x of notes) {
    const size = x.size ?? x.chars ?? x.text.length;
    const before = past[x.rel];
    const grew = before > 0 && size >= GROWTH_FLOOR && size > GROWTH * before;
    const big = size > (h?.limit ?? SIZE_LIMIT);
    // the cheap test first: a note needs REPEATS headings with one text before its blocks are compared
    const heads = new Map();
    for (const hd of x.note?.headings ?? []) { const k = `${hd.level}:${hd.text}`; heads.set(k, (heads.get(k) ?? 0) + 1); }
    const maybe = [...heads.values()].some((c) => c >= REPEATS);
    const reps = maybe ? repeatedBlocks(x.text) : [];
    if (!big && !grew && !reps.length) continue;
    const name = quote(x.note?.title ?? x.rel);
    const copies = reps.reduce((s, r) => s + r.count - 2, 0);
    const why = [big ? `is ${mb(size)}` : null, grew ? `grew from ${mb(before)} to ${mb(size)} in a week` : null].filter(Boolean).join(' and ');
    const fix = reps.length ? { kind: 'compact', copies, blocks: reps.length } : null;
    out.push(finding(rule, {
      key: `runaway:${x.rel}`, target: x.rel, notes: [x.rel],
      title: reps.length ? `${name} repeats ${reps.length === 1 ? `one block ${n(reps[0].count)} times` : `${reps.length} blocks ${n(reps.reduce((s, r) => s + r.count, 0))} times`}` : `${name} ${why}`,
      problem: reps.length ? 'A script or an agent appends the same block, word for word, on every run. The copies say nothing new, and the agent reads all of them.' : 'A note this size takes a large part of the agent’s context, and at this rate it keeps growing.',
      proposal: fix
        ? `Save a backup copy in the hygiene-backups folder of Quorum’s data folder, then remove ${plural(copies, 'copy', 'copies')} of ${reps.length === 1 ? 'a block' : 'blocks'} repeated word for word in ${quote(x.rel)}, keeping the first and last copy and the rest of the note. Undo in the activity history puts the note back.`
        : 'Quorum finds no repeated blocks to remove. Approve keeps the note as it is and marks the item done; split it by hand or stop the script that writes to it.',
      evidence: [
        `${n(size)} bytes${before > 0 ? `, ${n(before)} bytes a week ago` : ''}`,
        ...reps.slice(0, 4).map((r) => `${quote(r.heading)} appears ${n(r.count)} times`),
      ],
      facts: [`size:${Math.round(Math.log2(Math.max(1, size)))}`, ...(reps.length ? [`repeats:${reps.length}`] : [])],
      meta: [['Note', x.rel], ['Size', mb(size)]],
      ...(fix ? { fix } : {}),
    }));
  }
  return out;
}

// the commit message Approve writes
export const commitMessage = (count, folders) => `Commit ${plural(count, 'note')} in ${plural(folders, 'folder')} left uncommitted for over ${STALE_DAYS} days`;

// a file name that reads as a key or a credential: .env files, keys, certificates, credentials
export const SECRET_NAME = /(^|\/)(\.env[^/]*|[^/]*\.(pem|key|p12|pfx)|credentials[^/]*|secrets?\.[^/]*)$/i;
// a path in a dot folder (.claude, .obsidian, .trash) at any depth
export const DOT_PATH = /(^|\/)\.[^/]+\//;
// the notes a commit may take: notes the vault index holds (so excluded folders and what the index skips stay out),
// outside dot folders, with no secret-looking name and no line the secrets rule reads as a secret
export function committable(rel, byRel) {
  const x = byRel.get(rel);
  if (!x || DOT_PATH.test(rel) || SECRET_NAME.test(rel)) return false;
  return !String(x.text ?? '').split('\n').some((line) => secretKind(line));
}

function gitFinding(h, notes, now) {
  const g = h.git;
  if (!g?.repo) return null;
  const byRel = new Map(notes.map((x) => [x.rel, x]));
  const stale = (g.dirty ?? []).filter((d) => now - d.mtime > STALE_DAYS * 86400000 && committable(d.rel, byRel));
  if (!stale.length) return null;
  const byFolder = new Map();
  for (const d of stale) { const f = d.rel.includes('/') ? d.rel.slice(0, d.rel.lastIndexOf('/')) : 'the vault folder'; byFolder.set(f, (byFolder.get(f) ?? 0) + 1); }
  const untracked = stale.filter((d) => d.untracked).length;
  const branch = g.branch ?? 'the current branch';
  const blocked = !g.branch ? 'the repository has no branch checked out (a detached HEAD)'
    : g.merging ? `a ${g.merging} is in progress on ${branch}`
      : g.behind > 0 ? `the branch ${branch} is ${plural(g.behind, 'commit')} behind ${g.upstream ?? 'its upstream'}`
        : null;
  const message = commitMessage(stale.length, byFolder.size);
  return finding(rule, {
    key: 'uncommitted', target: 'uncommitted', notes: [],
    title: `${plural(stale.length, 'note')} in ${plural(byFolder.size, 'folder')} ${stale.length === 1 ? 'has' : 'have'} gone uncommitted for over ${STALE_DAYS} days`,
    problem: `${untracked ? `${n(untracked)} ${untracked === 1 ? 'is' : 'are'} not in git at all, and ` : ''}${stale.length - untracked ? `${n(stale.length - untracked)} ${stale.length - untracked === 1 ? 'has' : 'have'} changes git does not hold` : 'nothing in git holds them'}. A lost disk or a bad sync loses them, and other checkouts never see them.`,
    proposal: blocked
      ? `Quorum does not commit while ${blocked}. Approve keeps the notes as they are and marks the item done.`
      : `Stage and commit ${plural(stale.length, 'note')} on ${branch} with the message ${quote(message)}.`,
    evidence: [...[...byFolder].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([f, c]) => `${plural(c, 'note')} in ${f}`), ...(blocked ? [`Not committed: ${blocked}`] : [])],
    facts: [`folders:${[...byFolder.keys()].sort().join(',')}`, ...(blocked ? ['blocked'] : [])],
    meta: [['Branch', branch], ['Notes', n(stale.length)]],
    ...(blocked ? {} : { fix: { kind: 'commit', paths: stale.map((d) => d.rel), message, branch } }),
  });
}

export function run({ notes, hygiene = null, now = Date.now() }) {
  const out = [];
  if (hygiene) { const l = litterFinding(hygiene); if (l) out.push(l); }
  out.push(...runawayFindings(notes, hygiene));
  if (hygiene) { const g = gitFinding(hygiene, notes, now); if (g) out.push(g); }
  return out;
}
