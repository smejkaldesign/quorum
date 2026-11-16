// Re-checks the Memory health fixes that already ran against the current rules (linkRules.js, linkElsewhere.js), and
// plans how each flagged fix can be undone. Plain Node with no Electron, so main, the tests and a read-only script
// against a real vault all use the same rules.
//
// A run kept before Sprint 1 has no finding, sources or undo record. Its action, the note it wrote and the note it
// pointed at are read back from its outcome and step lines, and its sources from the vault as it is now.
//
// A run is flagged when the rules now would not offer its fix:
//   generated-source      a note it edited is a generated report or log
//   few-sources           it wrote a note that fewer than two notes a person wrote link to (a generated report does
//                         not count)
//   no-create-folder      it wrote a note in a session log or eval folder
//   exists-elsewhere      it wrote a note whose name is a folder, script, skill, repo file or a note on another branch
//   confidential-dropped  it wrote a note without the confidential mark one of its sources has
//   onto-stub             it pointed links, or added an alias, at a note an earlier fix wrote
//   onto-generated        it pointed links, or added an alias, at a generated report
//   onto-self             it pointed a note's link at that same note
//   title-body            it matched the note it pointed at through a title that holds the note's body
//
// Undo, in order of preference: the run's undo record; the note versions Quorum saved during the fix; for a note the
// fix wrote, moving it to the Trash; for an alias or relink, a reversal computed from the run's outcome when it is
// exact. Every path refuses when a note changed after the fix.
import { readFileSync } from 'node:fs';
import { sha } from './fixUndo.js';
import { NO_CREATE_FOLDERS, TITLE_MAX, isGenerated } from './linkRules.js';
import { nameOf } from './linkElsewhere.js';
import { writeAtomic } from './relink.js';
import { vaultPath } from './vault.js';

export const FIX_RECHECK_RULE = 'fix.recheck';
// raise when a reason is added or changed, so cached results are computed again
export const FIX_RECHECK_VERSION = 1;
// how long after a fix ended a note's file time still counts as the fix's own write
const SLACK = 3000;
const STUB_MARK = 'Quorum made this note because';

const dirOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const noMd = (r) => String(r ?? '').replace(/\.md$/i, '');
const falsy = (v) => v == null || v === false || /^(false|no|)$/i.test(String(v).trim());
const q = (t) => `“${t}”`;

// what a run did, from its finding when it has one, else from its outcome and step lines
export function readRun(run) {
  const out = String(run.outcome ?? '');
  const labels = (run.steps ?? []).map((s) => String(s?.label ?? ''));
  const fix = run.finding?.proposedFix ?? null;
  const sources = run.finding?.sources ?? (run.rel ? [run.rel] : []);
  let m;
  if ((m = out.match(/^Wrote the note (.+\.md) from what the linking notes say$/))) return { action: 'create', made: m[1], sources: run.finding?.sources ?? null };
  if ((m = out.match(/^Added “([\s\S]+)” as an alias of ([\s\S]+), so (\d+) links? now works?$/))) return { action: 'alias', toName: m[2], to: fix?.to ?? null, links: Number(m[3]), sources };
  if ((m = out.match(/^Fixed (\d+) links? in (\d+) notes?$/))) {
    const step = labels.map((l) => l.match(/^Pointing the (?:link|\d+ links) at ([\s\S]+)$/)).find(Boolean);
    return { action: 'relink', toName: step ? step[1] : null, to: fix?.to ?? null, links: Number(m[1]), files: Number(m[2]), sources };
  }
  if ((m = out.match(/^Removed (\d+) dead links? and kept the words$/))) return { action: 'unlink', links: Number(m[1]), sources };
  return { action: fix?.action ?? null, sources };
}

// the note a relink or alias pointed at: its rel when the run kept it, else the note whose name, title or file name is
// the one in the run's step line
export function destOf(r, vault) {
  if (r.to && vault.rels().includes(r.to)) return r.to;
  if (!r.toName) return null;
  const want = r.toName.trim().toLowerCase();
  const short = want.split(/\\n|\n/)[0].trim();
  const rels = vault.rels();
  const by = (f) => rels.find((rel) => { const n = vault.note(rel); return n && f(rel, n); }) ?? null;
  return by((rel, n) => String(n.props?.name ?? '').toLowerCase() === want)
    ?? by((rel) => nameOf(rel) === want)
    ?? by((rel, n) => String(n.title ?? '').toLowerCase() === want)
    ?? by((rel, n) => short.length >= 8 && String(n.title ?? '').toLowerCase() === short);
}

// the notes a created note was made from: the notes its stub lists. Notes that linked to it later are not what the fix
// saw, so the notes that link to it now count only when the stub lists none
function createSources(made, vault) {
  const text = vault.read(made) ?? '';
  const listed = [...text.matchAll(/^- \[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]:/gm)].map((x) => x[1].trim());
  const resolve = (t) => vault.resolve?.(t, made) ?? (vault.rels().includes(`${t}.md`) ? `${t}.md` : null);
  const rels = listed.length ? listed.map((t) => resolve(t) ?? `${t}.md`) : (vault.backlinks?.(made) ?? []).map((b) => b.rel);
  return [...new Set(rels)].filter((r) => r !== made);
}

// Flags a run against the rules. runs: every run, so a fix onto a note an earlier fix wrote can be seen. find(name):
// what a name is outside the notes of this checkout (linkElsewhere.js), or null.
// Answers { flagged, action, reasons: [{ id, text }], evidence: [[label, value]], main: the note to open }
export function recheckRun(run, { vault, runs = [], find = () => null }) {
  const r = readRun(run);
  const reasons = [];
  const evidence = [];
  const say = (id, text) => reasons.push({ id, text });
  const gen = (rel) => isGenerated(rel, vault.note(rel)?.props ?? {});
  let main = run.rel ?? null;
  if (r.action === 'create') {
    main = r.made;
    if (!vault.rels().includes(r.made)) return { flagged: false, action: r.action, reasons, evidence, main, gone: true };
    const sources = r.sources ?? createSources(r.made, vault);
    const real = sources.filter((s) => !gen(s) && s !== r.made);
    const made = sources.filter(gen);
    evidence.push(['Note it wrote', r.made], ['Linking notes', sources.length ? sources.join(', ') : 'None']);
    // a generated source alone does not flag a note: it only leaves fewer real sources (few-sources)
    if (made.length) evidence.push(['Generated reports among them', made.join(', ')]);
    if (real.length < 2) say('few-sources', `${real.length === 0 ? 'No note' : 'Only one note'} a person wrote links to it. Writing a note now needs at least two.`);
    const folder = dirOf(r.made);
    if (NO_CREATE_FOLDERS.some((re) => re.test(folder))) say('no-create-folder', `It wrote the note in ${folder}, where Quorum no longer writes notes.`);
    const hit = find(nameOf(r.made));
    const self = hit && (hit.where === r.made || (hit.kind === 'branch' && noMd(hit.where).toLowerCase() === noMd(r.made).toLowerCase()));
    if (hit && !self) {
      say('exists-elsewhere', hit.kind === 'branch' ? `A note with that name is on the branch ${hit.branch}, at ${hit.where}.` : `A ${hit.kind} with that name is at ${hit.where}.`);
      evidence.push(['Same name', hit.kind === 'branch' ? `${hit.where} on ${hit.branch}` : `${hit.kind}: ${hit.where}`]);
    }
    const mark = real.map((s) => vault.note(s)?.props?.confidential).find((v) => !falsy(v));
    if (mark && falsy(vault.note(r.made)?.props?.confidential)) say('confidential-dropped', `A linking note is marked confidential: ${mark}, and the note it wrote has no mark.`);
  } else if (r.action === 'relink' || r.action === 'alias') {
    const dest = destOf(r, vault);
    if (dest) main = dest;
    evidence.push(['Pointed at', dest ?? r.toName?.split(/\\n|\n/)[0].slice(0, TITLE_MAX) ?? 'Unknown'], ['Linking note', (r.sources ?? []).join(', ') || 'Unknown']);
    for (const s of r.sources ?? []) if (gen(s)) say('generated-source', `It edited ${q(s)}, a generated report. Quorum no longer fixes links in generated reports.`);
    if (r.action === 'relink' && r.toName && (/\\n/.test(r.toName) || r.toName.length > TITLE_MAX)) say('title-body', 'It matched the note through a title that holds the whole note, so the match is not a real one.');
    if (dest && gen(dest)) say('onto-generated', `It pointed at ${q(dest)}, a generated report. A generated report is never the note a link points at.`);
    if (dest && r.action === 'relink' && (r.sources ?? []).includes(dest)) say('onto-self', `It pointed ${q(dest)} at itself.`);
    const earlier = dest && runs.find((o) => o !== run && o.status === 'success' && !o.undoneAt && readRun(o).made === dest && (o.endedAt ?? 0) <= (run.startedAt ?? run.queuedAt ?? Infinity));
    const stub = dest && !earlier && (vault.read(dest) ?? '').includes(STUB_MARK);
    if (earlier || stub) say('onto-stub', `It pointed at ${q(dest)}, a note ${earlier ? `an earlier fix wrote for ${q(earlier.target)}` : 'Quorum wrote from links alone'}.`);
  } else if (r.action === 'unlink') {
    evidence.push(['Linking note', (r.sources ?? []).join(', ') || 'Unknown']);
    for (const s of r.sources ?? []) if (gen(s)) say('generated-source', `It edited ${q(s)}, a generated report. Quorum no longer fixes links in generated reports.`);
  }
  return { flagged: reasons.length > 0, action: r.action, reasons, evidence, main };
}

// The alias addAlias wrote, taken back out, or null when the text before cannot be told for sure
export function removeAlias(text, alias) {
  const m = String(text).match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fm = m[1];
  const rest = text.slice(m[0].length);
  const put = (next) => `---\n${next}\n---${rest}`;
  const inline = fm.match(/^aliases:\s*\[(.*)\]\s*$/m);
  if (inline) {
    const raw = inline[1].trim();
    const prefix = raw === alias ? '' : raw.endsWith(`, ${alias}`) ? raw.slice(0, -(alias.length + 2)) : null;
    return prefix == null ? null : put(fm.replace(inline[0], `aliases: [${prefix}]`));
  }
  const lines = fm.split('\n');
  const at = lines.findIndex((l) => /^aliases:\s*$/.test(l));
  if (at < 0) return null;
  let end = at + 1;
  while (end < lines.length && /^\s+-\s/.test(lines[end])) end++;
  const items = end - at - 1;
  if (!items || lines[end - 1].replace(/^\s+-\s+/, '') !== alias) return null;
  // with one item and nothing after the list, Quorum may have added the whole key or only the item: unknown
  if (items === 1 && end === lines.length) return null;
  lines.splice(end - 1, 1);
  return put(lines.join('\n'));
}

// the relinked links put back at the old target: exact only when every link to the note is one the fix made
function relinkBack(run, r, dest, vault) {
  const hits = [];
  for (const rel of vault.rels()) {
    const n = vault.note(rel);
    for (const l of n?.links ?? []) if (l.kind === 'wiki' && vault.resolve?.(l.target, rel) === dest) hits.push({ rel, link: l });
  }
  const files = new Set(hits.map((h) => h.rel));
  if (hits.length !== r.links || files.size !== r.files) return null;
  const out = [];
  for (const rel of files) {
    const text = vault.read(rel);
    if (text == null) return null;
    const lines = text.split('\n');
    for (const { link } of hits.filter((h) => h.rel === rel)) {
      const back = `${link.embed ? '!' : ''}[[${run.target}${link.anchor ? `#${link.anchor}` : ''}${link.display !== null ? `|${link.display}` : ''}]]`;
      if (!lines[link.line]?.includes(link.raw)) return null;
      lines[link.line] = lines[link.line].replace(link.raw, back);
    }
    out.push({ rel, before: lines.join('\n') });
  }
  return out;
}

// The versions Quorum saved while this run wrote: a version whose reason names the run's outcome, saved while it ran
// files: memoryVersions files(vault), { [rel]: { versions } }
export function fixVersions(files, run) {
  const reason = `Memory health fix: ${run.outcome ?? run.error}`;
  const from = (run.startedAt ?? run.queuedAt ?? 0) - SLACK;
  const to = (run.endedAt ?? Infinity) + SLACK;
  const out = [];
  for (const [rel, rec] of Object.entries(files ?? {})) {
    const all = rec.versions ?? [];
    const v = all.find((x) => x.reason === reason && x.at >= from && x.at <= to);
    if (v) out.push({ rel, id: v.id, at: v.at, created: !!v.created, later: all.some((x) => x.at > v.at) });
  }
  return out;
}

// How this run can be undone. undoFiles: its undo record's files or null; versions: fixVersions(); readVersion(rel, id)
// the text of a version; mtime(rel) a note's file time or null.
// Answers { ok, kind: 'record' | 'versions' | 'trash' | 'exact' | 'none', why, files: [{ rel, before, expect }], open }
// expect is the hash of each note's text now, checked again before Undo writes
export function undoPlan(run, { vault, undoFiles = null, versions = [], readVersion = () => null, mtime = () => null }) {
  const r = readRun(run);
  const hash = (rel) => { const t = vault.read(rel); return t == null ? null : sha(t); };
  const no = (kind, why, open = null) => ({ ok: false, kind, why, files: [], open });
  const after = (rel) => { const t = mtime(rel); return t != null && t > (run.endedAt ?? 0) + SLACK; };
  if (run.undoneAt) return no('none', 'This fix was undone already.');
  if (undoFiles?.length) {
    for (const f of undoFiles) if (hash(f.rel) !== f.after) return no('record', `${q(f.rel)} changed after the fix, so undoing it would lose those edits.`, f.rel);
    return { ok: true, kind: 'record', why: 'Quorum puts back the notes from the copy it kept when the fix ran.', files: undoFiles.map((f) => ({ rel: f.rel, before: f.before ?? null, expect: f.after })), open: null };
  }
  if (versions.length) {
    const files = [];
    for (const v of versions) {
      if (v.later || after(v.rel)) return no('versions', `${q(v.rel)} changed after the fix, so undoing it would lose those edits.`, v.rel);
      const before = v.created ? null : readVersion(v.rel, v.id);
      if (!v.created && before == null) return no('versions', `Quorum no longer has the text of ${q(v.rel)} from before the fix.`, v.rel);
      files.push({ rel: v.rel, before, expect: hash(v.rel) });
    }
    return { ok: true, kind: 'versions', why: 'Quorum puts back the notes from the versions it saved when the fix ran.', files, open: null };
  }
  if (r.action === 'create') {
    if (!vault.rels().includes(r.made) && vault.read(r.made) == null) return no('none', 'The note this fix wrote is no longer in the vault.');
    if (after(r.made)) return no('trash', `${q(r.made)} changed after the fix, so Quorum leaves it as it is.`, r.made);
    return { ok: true, kind: 'trash', why: `Quorum moves ${q(r.made)} to the Trash, where you can put it back.`, files: [{ rel: r.made, before: null, expect: hash(r.made) }], open: null };
  }
  if (r.action === 'alias') {
    const dest = destOf(r, vault);
    if (!dest) return no('none', 'Quorum cannot find the note this fix added the alias to.');
    if (after(dest)) return no('exact', `${q(dest)} changed after the fix, so Quorum leaves it as it is.`, dest);
    const back = removeAlias(vault.read(dest) ?? '', run.target);
    if (back == null) return no('exact', `Quorum cannot tell exactly how ${q(dest)} read before the alias was added.`, dest);
    return { ok: true, kind: 'exact', why: `Quorum takes the alias ${q(run.target)} back out of ${q(dest)}.`, files: [{ rel: dest, before: back, expect: hash(dest) }], open: null };
  }
  if (r.action === 'relink') {
    const dest = destOf(r, vault);
    if (!dest) return no('none', 'Quorum cannot find the note this fix pointed the links at.');
    const back = relinkBack(run, r, dest, vault);
    if (!back) return no('exact', `Other links also point at ${q(dest)}, so Quorum cannot tell which ones this fix changed.`, dest);
    const moved = back.find((f) => after(f.rel));
    if (moved) return no('exact', `${q(moved.rel)} changed after the fix, so Quorum leaves it as it is.`, moved.rel);
    return { ok: true, kind: 'exact', why: `Quorum points the ${r.links === 1 ? 'link' : `${r.links} links`} back at ${q(run.target)}.`, files: back.map((f) => ({ ...f, expect: hash(f.rel) })), open: null };
  }
  return no('none', 'Quorum kept no copy of the note from before this fix, and a removed link cannot be put back exactly.', run.rel ?? null);
}

// Carries out a plan: each note is checked against the hash it had when the plan was made, then put back, or moved to
// the Trash when the fix wrote it. trash(abs) moves a file to the Trash. Answers the notes it changed
export async function applyPlan(vaultDir, plan, trash) {
  if (!plan?.ok) throw new Error(plan?.why ?? 'There is nothing to undo on that fix');
  const read = (rel) => { try { return readFileSync(vaultPath(vaultDir, rel), 'utf8'); } catch { return null; } };
  for (const f of plan.files) {
    const t = read(f.rel);
    if ((t == null ? null : sha(t)) !== f.expect) throw new Error(`${q(f.rel)} changed after the fix, so undoing it would lose those edits`);
  }
  for (const f of plan.files) {
    const abs = vaultPath(vaultDir, f.rel);
    if (f.before == null) await trash(abs);
    else writeAtomic(abs, f.before);
  }
  return plan.files.map((f) => f.rel);
}

// Re-checks every finished fix of a vault, reusing the cached result of a run checked under the same rule versions.
// cache: { version, results: { [run id]: result } }. Answers the new cache
export function recheckAll(runs, ctx, cache = null, version = '') {
  const keep = cache?.version === version ? cache.results ?? {} : {};
  const results = {};
  for (const run of runs) {
    if (run.status !== 'success') continue;
    results[run.id] = keep[run.id] ?? recheckRun(run, { ...ctx, runs });
  }
  return { version, results };
}
