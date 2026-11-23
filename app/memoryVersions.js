// Versions of the vault notes Quorum's agents change, and the updates the person reviews in the Memory tab.
//
// Each write by the keeper, by an agent run or through the quorum CLI keeps the text the file had before as a version,
// with the time, who changed it and a short reason. A change by an agent is also an update: its number of changed
// blocks, and whether it is approved. With "Auto-approve memory updates" on (the default) an update is approved when it
// is made. Everything lives in Quorum's data folder, one folder per vault, never inside the vault:
//
//   <dir>/<vault key>/index.json      { vault, files: { [rel]: { versions: Version[], updates: Update[], openedAt } } }
//   <dir>/<vault key>/v/<id>.md       the text of one version
//
// A file keeps its newest MAX_VERSIONS versions and updates, none older than MAX_AGE_DAYS (memoryReview.js). Restoring
// a version writes its text back and is a version of its own, so the text it replaced can be restored too. A renamed
// or moved file starts a new history under its new path.
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { writeAtomic } from './relink.js';
import { DOT_DAYS, MAX_AGE_DAYS, MAX_VERSIONS, fileDot, folderDots, lineDiff, prune, reviewGroup } from './memoryReview.js';

const ID_RE = /^[a-z0-9]+-[a-f0-9]{8}$/;
const posix = (rel) => String(rel).split(path.sep).join('/');
const read = (abs) => { try { return readFileSync(abs, 'utf8'); } catch { return null; } };

export function createVersionStore({ dir, now = () => Date.now(), maxVersions = MAX_VERSIONS, maxAgeDays = MAX_AGE_DAYS, autoApprove = () => true, dotDays = () => DOT_DAYS, onChange = () => {} }) {
  const cache = new Map();
  const home = (vault) => path.join(dir, createHash('sha1').update(path.resolve(vault)).digest('hex').slice(0, 16));
  const load = (vault) => {
    const h = home(vault);
    if (cache.has(h)) return cache.get(h);
    let idx;
    try { idx = JSON.parse(readFileSync(path.join(h, 'index.json'), 'utf8')); } catch { idx = null; }
    if (!idx || typeof idx.files !== 'object') idx = { vault: path.resolve(vault), files: {} };
    cache.set(h, idx);
    return idx;
  };
  const save = (vault) => { const h = home(vault); mkdirSync(h, { recursive: true }); writeAtomic(path.join(h, 'index.json'), JSON.stringify(load(vault))); };
  const textFile = (vault, id) => path.join(home(vault), 'v', `${id}.md`);
  // ids sort by time, and never repeat inside one millisecond
  let lastAt = 0;
  const stamp = () => { const t = Math.max(now(), lastAt + 1); lastAt = t; return t; };

  // the caps on one file; dropped versions lose their text file
  const tidy = (vault, rec) => {
    const t = now();
    const v = prune(rec.versions, { now: t, max: maxVersions, maxAgeDays });
    for (const d of v.drop) rmSync(textFile(vault, d.id), { force: true });
    rec.versions = v.keep;
    rec.updates = prune(rec.updates, { now: t, max: maxVersions, maxAgeDays }).keep;
  };

  // one change to a file: before is the text it had (null when the write made it), after the text it has now (null
  // when the change removed it). agent false keeps a version without an update to review. Returns null when nothing
  // changed
  function record({ vault, rel, before, after, who, reason = '', agent = true }) {
    if (before === after || (before == null && after == null)) return null;
    const r = posix(rel);
    const idx = load(vault);
    const rec = (idx.files[r] ??= { versions: [], updates: [] });
    const at = stamp();
    const id = `${at.toString(36)}-${randomUUID().slice(0, 8)}`;
    mkdirSync(path.dirname(textFile(vault, id)), { recursive: true });
    writeAtomic(textFile(vault, id), before ?? '');
    const version = { id, at, who, reason, created: before == null, removed: after == null, size: Buffer.byteLength(before ?? '') };
    rec.versions.push(version);
    let update = null;
    if (agent) {
      const auto = autoApprove() !== false;
      update = { id, at, who, reason, changes: Math.max(1, lineDiff(before, after).blocks), approved: auto, approvedAt: auto ? at : null, auto };
      rec.updates.push(update);
    }
    tidy(vault, rec);
    save(vault);
    onChange([r]);
    return { version, update };
  }

  // the versions of a file, newest first, without their text
  const list = (vault, rel) => [...(load(vault).files[posix(rel)]?.versions ?? [])].reverse();
  // the text of one version of a file, or null when it is not one of that file's versions
  const readVersion = (vault, rel, id) => {
    if (!ID_RE.test(String(id)) || !list(vault, rel).some((v) => v.id === id)) return null;
    return read(textFile(vault, id));
  };

  // a version written back to its file. The text it replaces is kept as a new version, so a restore can be restored
  // too. A version from before the file existed has no text to restore
  function restore(vault, rel, id) {
    const r = posix(rel);
    const v = list(vault, r).find((x) => x.id === id);
    const text = v && !v.created ? readVersion(vault, r, id) : null;
    const root = path.resolve(vault);
    const abs = path.resolve(root, r);
    if (text == null || !abs.startsWith(root + path.sep)) return null;
    const cur = read(abs);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeAtomic(abs, text);
    const when = new Date(v.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    record({ vault, rel: r, before: cur, after: text, who: 'you', reason: `Restored the version from ${when}`, agent: false });
    return text;
  }

  // a run's changes to one file taken back: the file gets the text it had before the oldest of the given versions (or
  // is removed when that write made it), and those versions and their updates are deleted. Used when a run is stopped
  function undo(vault, rel, ids) {
    const r = posix(rel);
    const rec = load(vault).files[r];
    const mine = (rec?.versions ?? []).filter((v) => ids.includes(v.id)).sort((a, b) => a.at - b.at);
    const root = path.resolve(vault);
    const abs = path.resolve(root, r);
    if (!mine.length || !abs.startsWith(root + path.sep)) return false;
    const first = mine[0];
    if (first.created) rmSync(abs, { force: true });
    else { const text = read(textFile(vault, first.id)); if (text == null) return false; mkdirSync(path.dirname(abs), { recursive: true }); writeAtomic(abs, text); }
    for (const v of mine) rmSync(textFile(vault, v.id), { force: true });
    rec.versions = rec.versions.filter((v) => !ids.includes(v.id));
    rec.updates = rec.updates.filter((u) => !ids.includes(u.id));
    if (!rec.versions.length && !rec.updates.length) delete load(vault).files[r];
    save(vault);
    onChange([r]);
    return true;
  }
  // the updates the banner shows are rejected: the file gets back the text from before the oldest of them, that text
  // is kept as a version by you, and every update since leaves the review. ids are the updates the open page shows.
  // Returns the restored text, or null when there is nothing to reject or the file was updated again since
  // remove takes away a note the updates made, which has no earlier text
  function reject(vault, rel, ids = null, remove = (abs) => rmSync(abs, { force: true })) {
    const r = posix(rel);
    const rec = load(vault).files[r];
    const g = rec ? reviewGroup(rec, { now: now(), days: dotDays(), ids: ids ?? [] }) : null;
    if (g && ids && g.ids.some((id) => !ids.includes(id))) return null;
    const root = path.resolve(vault);
    const abs = path.resolve(root, r);
    if (!g || !abs.startsWith(root + path.sep)) return null;
    const base = rec.versions.find((v) => v.id === g.first.id);
    const text = base && !base.created ? read(textFile(vault, base.id)) : null;
    const cur = read(abs);
    if (base?.created) remove(abs);
    else if (text != null) writeAtomic(abs, text);
    else return null;
    rec.updates = rec.updates.filter((u) => u.at < g.first.at);
    rec.openedAt = stamp();
    record({ vault, rel: r, before: cur, after: base?.created ? null : text, who: 'you', reason: 'Rejected the updates', agent: false });
    return text ?? '';
  }

  // every update of a file waiting for approval is approved now; the person has the file open, so it counts as opened
  function approve(vault, rel) {
    const rec = load(vault).files[posix(rel)];
    if (!rec) return false;
    const t = stamp();
    let n = 0;
    for (const u of rec.updates) if (!u.approved) { u.approved = true; u.approvedAt = t; n++; }
    rec.openedAt = stamp();
    save(vault);
    onChange([posix(rel)]);
    return n;
  }
  // the person opened the file in the Memory tab, which clears its blue dot. Files with no history keep no record
  function opened(vault, rel) {
    const rec = load(vault).files[posix(rel)];
    if (!rec) return;
    const had = fileDot(rec, { now: now(), days: dotDays() });
    rec.openedAt = stamp();
    save(vault);
    if (had) onChange([posix(rel)]);
  }

  // the dots for the Memory tree: one per file with a dot, one per folder holding such a file
  function dots(vault) {
    const t = now();
    const files = {};
    for (const [rel, rec] of Object.entries(load(vault).files)) { const d = fileDot(rec, { now: t, days: dotDays() }); if (d) files[rel] = d; }
    return { files, folders: folderDots(files) };
  }
  // what the banner of an open file shows: the dot, the updates and when the last was made, the number of changed
  // blocks, and the text before the oldest of them. ids are the updates the open page already shows. null when the file
  // has nothing to review
  function review(vault, rel, ids = []) {
    const rec = load(vault).files[posix(rel)];
    const g = rec ? reviewGroup(rec, { now: now(), days: dotDays(), ids }) : null;
    if (!g) return null;
    return { dot: g.dot, ids: g.ids, count: g.count, at: g.at, changes: g.changes, created: !!rec.versions.find((v) => v.id === g.first.id)?.created, before: read(textFile(vault, g.first.id)) ?? '' };
  }

  // a run that may write vault notes with its own tools: the notes are read before it and again after it, and every
  // note whose text changed is recorded. Notes in folders that start with a dot are left out
  async function watch(vault, { who, reason, skip = () => false }, fn) {
    const before = snapshot(vault, skip);
    try { return await fn(); } finally {
      const after = snapshot(vault, skip);
      for (const rel of new Set([...before.keys(), ...after.keys()])) {
        const a = before.get(rel) ?? null, b = after.get(rel) ?? null;
        if (a !== b) record({ vault, rel, before: a, after: b, who, reason });
      }
    }
  }

  // every file with a history, keyed by its path in the vault, for the Notifications view
  const files = (vault) => load(vault).files;

  return { record, list, read: readVersion, restore, undo, reject, approve, opened, dots, review, watch, home, files };
}

// the text of every markdown note in a vault, keyed by its path inside the vault. Notes over 2 MB are left out
const SNAP_MAX = 2 * 1024 * 1024;
export function snapshot(vault, skip = () => false) {
  const out = new Map();
  const walk = (d) => {
    let names;
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      if (n.startsWith('.') || n === 'node_modules') continue;
      const abs = path.join(d, n);
      let st;
      try { st = statSync(abs); } catch { continue; }
      const rel = posix(path.relative(vault, abs));
      if (skip(rel)) continue;
      if (st.isDirectory()) walk(abs);
      else if (n.endsWith('.md') && st.size <= SNAP_MAX) { const t = read(abs); if (t != null) out.set(rel, t); }
    }
  };
  walk(vault);
  return out;
}
