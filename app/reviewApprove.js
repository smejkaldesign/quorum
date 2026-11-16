// Approve for the review items that have no exact fix of their own. Plain Node with no Electron, so main, the tests and
// the read-only eval script (scripts/fix-recheck-eval.mjs) use the same rules.
//
// A flagged past fix Quorum cannot undo exactly (fixRecheck.js undoPlan refused) gets the first of these that applies:
//   git      the vault is a git repo, and each note's committed text from before the fix differs from the note now only
//            by the fix's change: Quorum puts that text back
//   remove   a note the fix wrote still holds only what the fix wrote: Quorum moves it to the Trash. Or a relink pointed
//            the links at a note that is gone: Quorum removes the links it left that open nothing and keeps their words
//   draft    a fix an agent drafted for it (Sprint 3B), when drafting is on: Quorum runs the drafted fix
//   keep     none of these: Approve keeps the fix as it is and marks the item done
//
// A review rule's finding with no fix of its own (rules/*.js) gets the change its rule allows, or keep:
//   note.frontmatter  add each missing key, with the value Quorum can tell from the note or an empty one
//   note.stale        set last_verified to today when the folder checks notes on an interval, else status: archived
//   note.orphan       link the note from its folder's index note, when the folder has one
//   anything else     keep
// Every change is a batch step (batchPlan.js), so it runs through the fix journal, saves versions and has Undo.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { sha } from './fixUndo.js';
import { destOf, readRun } from './fixRecheck.js';
import { parseNote } from './linkparse.js';

const q = (t) => `“${t}”`;
const noExt = (t) => String(t ?? '').replace(/\.md$/i, '');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const baseOf = (rel) => path.posix.basename(noExt(rel));
const dirOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
export const STUB_MARK = 'Quorum made this note because';

// Reads a note's committed text from before a time, from the git repo the vault sits in. Answers (rel, beforeMs) =>
// text or null; null when the vault is not in a repo, the note has no commit before then, or git fails. Results are
// kept, since history before a time does not change. exec: execFileSync, or a stand-in for tests
export function gitReader(vaultDir, exec = execFileSync) {
  let prefix;
  const seen = new Map();
  const git = (args) => exec('git', ['-C', vaultDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 });
  return (rel, beforeMs) => {
    if (prefix === undefined) { try { prefix = git(['rev-parse', '--show-prefix']).trim(); } catch { prefix = null; } }
    if (prefix == null || !rel || !Number.isFinite(beforeMs)) return null;
    // git log takes the path from the vault folder; git show takes it from the top of the repo
    const file = `${prefix}${rel}`;
    const key = `${file}\0${beforeMs}`;
    if (seen.has(key)) return seen.get(key);
    let text = null;
    try {
      const commit = git(['log', '-1', '--format=%H', `--before=${new Date(beforeMs).toISOString()}`, '--', rel]).trim();
      if (/^[0-9a-f]{7,64}$/.test(commit)) text = git(['show', `${commit}:${file}`]);
    } catch { text = null; }
    seen.set(key, text);
    return text;
  };
}

// the texts a note could have had before addAlias (relink.js) added this alias, one per way it writes it
export function aliasBacks(now, alias) {
  const text = String(now ?? '');
  const out = [];
  const bare = `---\naliases:\n  - ${alias}\n---\n`;
  if (text.startsWith(bare)) out.push(text.slice(bare.length));
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return out;
  const fm = m[1];
  const put = (next) => `---\n${next}\n---${text.slice(m[0].length)}`;
  const inline = fm.match(/^aliases:\s*\[(.*)\]\s*$/m);
  if (inline) {
    const raw = inline[1].trim();
    if (raw === alias) out.push(put(fm.replace(inline[0], 'aliases: []')));
    if (raw.endsWith(`, ${alias}`)) out.push(put(fm.replace(inline[0], `aliases: [${raw.slice(0, -(alias.length + 2))}]`)));
  }
  const lines = fm.split('\n');
  const at = lines.findIndex((l) => /^aliases:\s*$/.test(l));
  if (at >= 0) {
    let end = at + 1;
    while (end < lines.length && /^\s+-\s/.test(lines[end])) end++;
    if (end > at + 1 && lines[end - 1] === `  - ${alias}`) {
      out.push(put([...lines.slice(0, end - 1), ...lines.slice(end)].join('\n')));
      if (end === at + 2 && end === lines.length) out.push(put(lines.slice(0, at).join('\n')));
    }
  }
  return out;
}

// one line as the fix left it: each link to target on the line before became a link to another note (relink) or its
// words (unlink); every other character is the same
function lineFixed(was, now, target, action) {
  const want = noExt(target).toLowerCase();
  const links = parseNote('line.md', was).links.filter((l) => l.kind === 'wiki' && noExt(l.target).toLowerCase() === want);
  if (!links.length) return false;
  let re = '';
  let at = 0;
  for (const l of links) {
    const i = was.indexOf(l.raw, at);
    if (i < 0) return false;
    const relinked = `${l.embed ? '!' : ''}\\[\\[[^\\]|#\\n]+${l.anchor ? esc(`#${l.anchor}`) : ''}${l.display !== null ? esc(`|${l.display}`) : ''}\\]\\]`;
    const words = esc(l.display !== null && l.display !== '' ? l.display : path.posix.basename(noExt(l.target)));
    re += esc(was.slice(at, i)) + (action === 'relink' ? relinked : action === 'unlink' ? words : `(?:${relinked}|${words})`);
    at = i + l.raw.length;
  }
  re += esc(was.slice(at));
  return new RegExp(`^${re}$`).test(now);
}

// whether a note's text before a fix and its text now differ only by that fix's change. fix: { action, target }, where
// target is the missing link the fix acted on; an alias fix compares the note the alias went on
export function onlyFixChange(before, now, { action, target }) {
  if (before == null || now == null || before === now) return false;
  if (action === 'alias') return aliasBacks(now, target).includes(before);
  if (action === 'create') return false;
  const a = before.split('\n');
  const b = now.split('\n');
  if (a.length !== b.length) return false;
  let changed = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    changed++;
    if (!lineFixed(a[i], b[i], target, action)) return false;
  }
  return changed > 0;
}

// a note that still holds only what a fix wrote for a missing link (linkRules.js contextNote): a heading, the stub
// line, the linking notes it quotes, and at most a confidential mark in its frontmatter
export function onlyStub(text) {
  const t = String(text ?? '');
  const fm = t.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm && fm[1].split('\n').some((l) => l.trim() && !/^confidential:/.test(l))) return false;
  const lines = t.slice(fm ? fm[0].length : 0).split('\n').filter((l) => l.trim());
  if (!lines.some((l) => l.startsWith(STUB_MARK))) return false;
  return lines.every((l, i) => (i === 0 && /^# /.test(l)) || l.startsWith(STUB_MARK) || /^- \[\[[^\]]+\]\]: /.test(l));
}

// The Approve of a flagged past fix whose undo plan refused. run: the fix run; plan: its undoPlan(); ctx: { vault (the
// fixRecheck vault reader), gitShow: gitReader() or null, undoFiles: the rels of its undo record or null, draft: the
// agent drafting hook or null }. Answers { kind: 'git' | 'remove' | 'draft' | 'keep', why, ops }
export function approvePastFix(run, plan, { vault, gitShow = null, undoFiles = null, draft = null }) {
  const r = readRun(run);
  const at = run.startedAt ?? run.queuedAt ?? run.endedAt;
  const dest = r.action === 'alias' || r.action === 'relink' ? destOf(r, vault) : null;
  // (a) git history: every note the fix changed, read back from the last commit before it ran
  if (gitShow && r.action !== 'create' && Number.isFinite(at)) {
    const rels = r.action === 'alias' ? (dest ? [dest] : []) : [...new Set(undoFiles?.length ? undoFiles : r.sources ?? [])];
    const ops = [];
    for (const rel of rels) {
      const now = vault.read(rel);
      const before = gitShow(rel, at);
      if (!onlyFixChange(before, now, { action: r.action, target: run.target })) { ops.length = 0; break; }
      ops.push({ op: 'restore', rel, before, expect: sha(now) });
    }
    if (ops.length) {
      const names = ops.map((o) => q(o.rel)).join(', ');
      return { kind: 'git', why: `Quorum puts back ${names} as ${ops.length === 1 ? 'it reads' : 'they read'} in git history before the fix. The fix's change is the only difference.`, ops };
    }
  }
  // (b) what the fix left behind: a note it wrote that holds nothing else, or links it pointed at a note that is gone
  const made = r.action === 'create' && r.made ? vault.read(r.made) : null;
  if (made != null && onlyStub(made)) {
    return { kind: 'remove', why: `Quorum moves ${q(r.made)} to the Trash, where you can put it back. It still holds only what the fix wrote.`, ops: [{ op: 'trash', rel: r.made, expect: sha(made) }] };
  }
  if (r.action === 'relink' && !dest && r.toName) {
    const name = r.toName.split(/\\n|\n/)[0].trim().toLowerCase();
    const hits = new Map();
    for (const rel of r.sources ?? []) {
      for (const l of vault.note(rel)?.links ?? []) {
        if (l.kind !== 'wiki' || vault.resolve?.(l.target, rel)) continue;
        const t = noExt(l.target).toLowerCase();
        if (t !== name && path.posix.basename(t) !== name) continue;
        const e = hits.get(t) ?? hits.set(t, { target: l.target, lines: {} }).get(t);
        (e.lines[rel] ??= []).push(l.line);
      }
    }
    if (hits.size === 1) {
      const [{ target, lines }] = hits.values();
      const links = Object.values(lines).reduce((n, ls) => n + ls.length, 0);
      return { kind: 'remove', why: `The note the fix pointed the links at is gone. Quorum removes the ${links === 1 ? 'link' : `${links} links`} to ${q(target)} it left and keeps the words.`, ops: [{ op: 'unlink', target, sources: Object.keys(lines), lines, links }] };
    }
  }
  // (c) DRAFTED FIX SLOT: a fix an agent drafted, when drafting is on. draft(run, r) answers { ops, why } or null. main
  // passes null until past fixes have a draft type in memoryDraft.js; then it wraps draftFix(item) from main.js here
  const drafted = typeof draft === 'function' ? draft(run, r) : null;
  if (drafted?.ops?.length) return { kind: 'draft', why: drafted.why ?? 'Quorum runs the fix an agent drafted for it.', ops: drafted.ops };
  return { kind: 'keep', why: `${plan?.why ?? 'Quorum cannot undo it exactly.'} Approve keeps the fix as it is and marks the item done.`, ops: [{ op: 'keep' }] };
}

// the day on this computer's clock: last_verified is the day the person approved, in their time zone
const today = (now) => { const d = new Date(now); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const INDEX_NAMES = ['index', '_index', 'readme'];
// the index note of a note's folder: index, _index or README in it, or the folder note named like the folder
export function folderIndex(rel, rels) {
  const dir = dirOf(rel);
  const own = baseOf(dir).toLowerCase();
  const inDir = rels.filter((r) => dirOf(r) === dir && r !== rel);
  return inDir.find((r) => INDEX_NAMES.includes(baseOf(r).toLowerCase())) ?? (dir ? inDir.find((r) => baseOf(r).toLowerCase() === own) : null) ?? null;
}
// the wiki name a link to rel needs: its file name, or its path when another note shares the name
const wikiName = (rel, rels) => (rels.filter((r) => baseOf(r).toLowerCase() === baseOf(rel).toLowerCase()).length > 1 ? noExt(rel) : baseOf(rel));

// The Approve of a review rule's finding that has no fix of its own. f: the finding (rules/common.js); ctx: { rels: the
// vault's notes, title(rel), now }. Answers { kind, says, ops }; says is the one line the row shows for Approve
export function approveFinding(f, { rels = [], title = () => null, now = Date.now() } = {}) {
  const keep = (why) => ({ kind: 'keep', says: `${why} Approve keeps the note as it is and marks the item done.`, ops: [{ op: 'keep' }] });
  if (f.ruleId === 'note.frontmatter') {
    const missing = (f.facts ?? []).filter((x) => x.startsWith('missing:')).map((x) => x.slice(8));
    if (!missing.length) return keep('Quorum cannot tell the right values for these keys.');
    const named = baseOf(f.rel).match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
    const value = (key) => {
      if (key === 'title' && title(f.rel)) return JSON.stringify(title(f.rel));
      if ((key === 'date' || key === 'created') && named) return named;
      return '""';
    };
    const ops = missing.map((key) => ({ op: 'setkey', rel: f.rel, key, value: value(key) }));
    const filled = ops.filter((o) => o.value !== '""').map((o) => `${q(o.key)} (${o.value})`);
    const empty = ops.filter((o) => o.value === '""').map((o) => q(o.key));
    return { kind: 'setkey', says: `Add ${[...filled, ...(empty.length ? [`${empty.join(', ')} with an empty value`] : [])].join(' and ')}.`, ops };
  }
  if (f.ruleId === 'note.stale') {
    if ((f.facts ?? []).includes('verify')) return { kind: 'setkey', says: `Set last_verified to ${today(now)}.`, ops: [{ op: 'setkey', rel: f.rel, key: 'last_verified', value: today(now) }] };
    return { kind: 'setkey', says: 'Set its status to archived.', ops: [{ op: 'setkey', rel: f.rel, key: 'status', value: 'archived' }] };
  }
  if (f.ruleId === 'note.orphan') {
    const index = folderIndex(f.rel, rels);
    if (!index) return keep('Its folder has no index note to link it from.');
    return { kind: 'addlink', says: `Link it from ${q(index)}.`, ops: [{ op: 'addlink', rel: index, line: `- [[${wikiName(f.rel, rels)}]]`, note: f.rel }] };
  }
  return keep('Quorum has no change to make for this check.');
}

// the text after an addlink step: the line added at the end, once
export function withLinkLine(text, line) {
  const t = String(text ?? '');
  if (t.split('\n').some((l) => l.trim() === line.trim())) return t;
  return `${t.replace(/\n*$/, '')}\n${line}\n`;
}
