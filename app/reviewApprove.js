// Approve for the review items that have no exact fix of their own. Plain Node with no Electron, so main, the tests and
// the read-only eval script (scripts/fix-recheck-eval.mjs) use the same rules.
//
// A flagged past fix Quorum cannot undo exactly (fixRecheck.js undoPlan refused) gets the first of these that applies:
//   git      the vault is a git repo, and each note's committed text from before the fix differs from the note now only
//            by the fix's change: Quorum puts that text back
//   remove   a note the fix wrote still holds only what the fix wrote: Quorum moves it to the Trash. Or a relink pointed
//            the links at a note that is gone: Quorum removes the links it left that open nothing and keeps their words
//   draft    a Retroactive improvement an agent drafted for it, when drafting is on: Quorum runs the drafted fix
//   keep     none of these: Approve keeps the fix as it is and marks the item done
// A Retroactive improvement (retroOf) is what an agent can still do for a fix Quorum cannot undo: point the links a
// relink or alias moved at the right note, or remove them; rewrite a note the fix wrote into a real one from its
// sources, or remove it. An unlink leaves nothing to improve.
//
// A review rule's finding with no fix of its own (rules/*.js) gets the change its rule allows, or keep:
//   note.frontmatter  add each missing key, with the value Quorum can tell from the note or an empty one
//   note.stale        status: archived when the open note is both untouched for 90 days and past its due date (two
//                     signals); else Mark it current: last_verified set to today, so the rule waits a folder interval
//   note.orphan       link the note from its folder's index note, when the folder has one
//   anything else     keep
// Every change is a batch step (batchPlan.js), so it runs through the fix journal, saves versions and has Undo.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { sha } from './fixUndo.js';
import { destOf, readRun, removeAlias } from './fixRecheck.js';
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

// a note that still holds only what a fix wrote for a missing link (linkRules.js contextNote): its heading, one stub
// line, the linking notes it quotes, and at most a confidential mark in its frontmatter. name: the missing link's name,
// which the heading must be; sources: the linking notes, the only ones a quote line may link to
export function onlyStub(text, { name = null, sources = null } = {}) {
  const t = String(text ?? '');
  const fm = t.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm && fm[1].split('\n').some((l) => l.trim() && !/^confidential:/.test(l))) return false;
  const lines = t.slice(fm ? fm[0].length : 0).split('\n').filter((l) => l.trim());
  if (lines.filter((l) => l.startsWith(STUB_MARK)).length !== 1) return false;
  const from = sources?.length ? new Set(sources.map((r) => noExt(r).toLowerCase())) : null;
  const quote = (l) => { const m = l.match(/^- \[\[([^\]]+)\]\]: /); return !!m && (!from || from.has(noExt(m[1]).toLowerCase())); };
  return lines.every((l, i) => (i === 0 && (name ? l === `# ${name}` : /^# /.test(l))) || l.startsWith(STUB_MARK) || quote(l));
}

// the improvements an agent may draft for each kind of earlier fix
export const RETRO_ACTIONS = { relink: ['relink', 'unlink'], alias: ['relink', 'unlink'], create: ['rewrite', 'remove'] };
const tokens = (t) => noExt(t).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
// the notes a link name could mean, best first: the share of the name's words in the note's file name, half or more,
// then the note with fewer other words
export function retroCandidates(target, rels, { exclude = [], limit = 5 } = {}) {
  const want = [...new Set(tokens(path.posix.basename(noExt(target))))];
  if (!want.length) return [];
  const off = new Set(exclude);
  return rels
    .filter((r) => !off.has(r))
    .map((r) => { const have = new Set(tokens(baseOf(r))); const hit = want.filter((w) => have.has(w)).length; return { r, score: hit / want.length, extra: have.size - hit }; })
    .filter((x) => x.score >= 0.5)
    .sort((a, b) => b.score - a.score || a.extra - b.extra || a.r.localeCompare(b.r))
    .slice(0, limit)
    .map((x) => x.r);
}
// the Retroactive improvement of an earlier fix, or null when there is nothing to improve. r: readRun(run); dest: the
// note a relink or alias pointed at. candidates: the notes the links could mean instead
export function retroOf(run, r, { vault, dest = null }) {
  const reasons = Array.isArray(run.reasons) ? run.reasons : [];
  if (r.action === 'create') {
    if (!r.made || vault.read(r.made) == null) return null;
    return { action: 'create', target: String(run.target ?? ''), made: r.made, sources: (r.sources ?? []).filter((s) => s !== r.made), reasons };
  }
  if ((r.action === 'relink' || r.action === 'alias') && dest) {
    const sources = (r.sources ?? []).filter((s) => s !== dest && vault.read(s) != null);
    if (!sources.length) return null;
    const names = r.action === 'alias' ? [String(run.target)] : [...new Set([baseOf(dest), String(r.toName ?? '').split(/\\n|\n/)[0].trim()].filter(Boolean))];
    const candidates = retroCandidates(run.target, vault.rels(), { exclude: [dest, ...sources] });
    return { action: r.action, target: String(run.target ?? ''), wrong: dest, names, sources, candidates, reasons };
  }
  return null;
}
// every wiki link in a text whose name is one of names, pointed at name instead: its anchor and words stay
export function retargetText(text, names, name) {
  const want = new Set(names.map((n) => noExt(n).toLowerCase()));
  const t = String(text ?? '');
  const links = parseNote('note.md', t).links.filter((l) => l.kind === 'wiki' && (want.has(noExt(l.target).toLowerCase()) || want.has(path.posix.basename(noExt(l.target)).toLowerCase())));
  let out = '';
  let at = 0;
  for (const l of links) {
    const i = t.indexOf(l.raw, at);
    if (i < 0) continue;
    out += t.slice(at, i) + `${l.embed ? '!' : ''}[[${name}${l.anchor ? `#${l.anchor}` : ''}${l.display !== null ? `|${l.display}` : ''}]]`;
    at = i + l.raw.length;
  }
  return out + t.slice(at);
}
// The steps of a drafted Retroactive improvement. pick: { action, to, text }; text is the whole note text a rewrite
// writes. textOf(rel) answers a note's text now. Answers { ops } or { why } when the steps cannot be made
export function retroOps(retro, pick, textOf) {
  const restore = (rel, before) => { const now = textOf(rel); return now == null ? null : { op: 'restore', rel, before, expect: sha(now) }; };
  if (retro.action === 'create') {
    const now = textOf(retro.made);
    if (now == null) return { why: `${q(retro.made)} is gone.` };
    if (pick.action === 'remove') return { ops: [{ op: 'trash', rel: retro.made, expect: sha(now) }] };
    if (pick.action === 'rewrite' && pick.text) return { ops: [restore(retro.made, pick.text)] };
    return { why: 'The draft has no change for this note.' };
  }
  const ops = [];
  // an alias goes back off the note it was added to, so the links no longer open it
  if (retro.action === 'alias') {
    const now = textOf(retro.wrong);
    // exactness is not needed here: any text without the alias will do, and the person reviews the draft
    const back = now == null ? null : removeAlias(now, retro.target) ?? aliasBacks(now, retro.target)[0] ?? null;
    if (back == null) return { why: `Quorum cannot find the alias in ${q(retro.wrong)}.` };
    ops.push({ op: 'restore', rel: retro.wrong, before: back, expect: sha(now) });
  }
  if (pick.action === 'relink') {
    if (!pick.to) return { why: 'The draft names no note.' };
    const name = baseOf(pick.to);
    for (const rel of retro.sources) {
      const now = textOf(rel);
      if (now == null) continue;
      const next = retargetText(now, retro.names, name);
      if (next !== now) ops.push({ op: 'restore', rel, before: next, expect: sha(now) });
    }
    return ops.some((o) => o.rel !== retro.wrong) ? { ops } : { why: 'No link in the notes points at the note the earlier fix picked.' };
  }
  if (pick.action === 'unlink') {
    const sources = retro.sources.filter((rel) => { const now = textOf(rel); return now != null && retargetText(now, retro.names, '\u0000') !== now; });
    if (!sources.length) return { why: 'No link in the notes points at the note the earlier fix picked.' };
    // a relink's links still open the wrong note, so each is pointed at its own name first, which opens nothing
    if (retro.action === 'relink') {
      for (const rel of sources) ops.push({ op: 'restore', rel, before: unlinkText(textOf(rel), retro.names), expect: sha(textOf(rel)) });
      return { ops };
    }
    ops.push({ op: 'unlink', target: retro.target, sources });
    return { ops };
  }
  return { why: 'The draft has no change for these links.' };
}
// every wiki link in a text whose name is one of names, replaced by its words
export function unlinkText(text, names) {
  const want = new Set(names.map((n) => noExt(n).toLowerCase()));
  const t = String(text ?? '');
  const links = parseNote('note.md', t).links.filter((l) => l.kind === 'wiki' && (want.has(noExt(l.target).toLowerCase()) || want.has(path.posix.basename(noExt(l.target)).toLowerCase())));
  let out = '';
  let at = 0;
  for (const l of links) {
    const i = t.indexOf(l.raw, at);
    if (i < 0) continue;
    out += t.slice(at, i) + (l.display !== null && l.display !== '' ? l.display : path.posix.basename(noExt(l.target)));
    at = i + l.raw.length;
  }
  return out + t.slice(at);
}

// The Approve of a flagged past fix whose undo plan refused. run: the fix run; plan: its undoPlan(); ctx: { vault (the
// fixRecheck vault reader), gitShow: gitReader() or null, undoFiles: the rels of its undo record or null, draft: the
// agent drafting hook or null, drafting: whether Let the agent draft fixes is on, reasons: why the re-check flagged it
// as plain lines }. Answers { kind: 'git' | 'remove' |
// 'draft' | 'keep', why, ops, retro }; retro is the Retroactive improvement an agent can draft, or null
export function approvePastFix(run, plan, { vault, gitShow = null, undoFiles = null, draft = null, drafting = false, reasons = [] }) {
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
  if (made != null && onlyStub(made, { name: String(run.target ?? '').split('/').pop() || null, sources: r.sources ?? null })) {
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
  // (c) DRAFTED FIX SLOT: a Retroactive improvement an agent drafted (memoryDraft.js retro), when drafting is on.
  // draft(run, r, retro) answers { ops, why, draft } or null
  const retro = retroOf({ ...run, reasons }, r, { vault, dest });
  const drafted = retro && typeof draft === 'function' ? draft(run, r, retro) : null;
  if (drafted?.ops?.length) return { kind: 'draft', why: drafted.why ?? 'Quorum runs the improvement an agent drafted for it.', ops: drafted.ops, retro, draft: drafted.draft ?? null };
  const cannot = plan?.why ?? 'Quorum cannot undo it exactly.';
  const why = !retro ? `${cannot} Approve keeps the fix as it is and marks the item done.`
    : drafting ? `${cannot} The agent drafts an improvement for it soon. Until then, Approve keeps the fix as it is and marks the item done.`
      : `${cannot} Turn on Let the agent draft fixes in Settings > Memory and the agent drafts an improvement for it. Approve keeps the fix as it is and marks the item done.`;
  return { kind: 'keep', why, ops: [{ op: 'keep' }], retro };
}

// the day on this computer's clock: last_verified is the day the person approved, in their time zone
const today = (now) => { const d = new Date(now); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const INDEX_NAMES = ['index', '_index', 'readme'];
// the index note of a note's folder: index, _index or README in it, or the folder note named like the folder. skip(rel)
// answers true for a note Quorum never writes into (a generated report or a template)
export function folderIndex(rel, rels, skip = () => false) {
  const dir = dirOf(rel);
  const own = baseOf(dir).toLowerCase();
  const inDir = rels.filter((r) => dirOf(r) === dir && r !== rel && !skip(r));
  return inDir.find((r) => INDEX_NAMES.includes(baseOf(r).toLowerCase())) ?? (dir ? inDir.find((r) => baseOf(r).toLowerCase() === own) : null) ?? null;
}
// the wiki name a link to rel needs: its file name, or its path when another note shares the name
const wikiName = (rel, rels) => (rels.filter((r) => baseOf(r).toLowerCase() === baseOf(rel).toLowerCase()).length > 1 ? noExt(rel) : baseOf(rel));

// The Approve of a review rule's finding that has no fix of its own. f: the finding (rules/common.js); ctx: { rels: the
// vault's notes, title(rel), skip(rel) for generated reports and templates, now }. Answers { kind, says, ops }; says is
// the one line the row shows for Approve
export function approveFinding(f, { rels = [], title = () => null, skip = () => false, now = Date.now() } = {}) {
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
    // archiving takes a note out of what the agent reads, so it needs two signals: no update in 90 days and a due date
    // passed. One signal alone can be a note the person still uses: Approve marks it current, and the rule stops
    // flagging it until the folder's interval passes
    const facts = f.facts ?? [];
    if (facts.includes('open') && facts.includes('due')) return { kind: 'setkey', says: 'Set its status to archived.', ops: [{ op: 'setkey', rel: f.rel, key: 'status', value: 'archived' }] };
    return { kind: 'setkey', says: `Mark it current: set last_verified to ${today(now)}.`, ops: [{ op: 'setkey', rel: f.rel, key: 'last_verified', value: today(now) }] };
  }
  if (f.ruleId === 'note.orphan') {
    const index = folderIndex(f.rel, rels, skip);
    if (!index) return keep('Its folder has no index note to link it from.');
    return { kind: 'addlink', says: `Link it from ${q(index)}.`, ops: [{ op: 'addlink', rel: index, line: `- [[${wikiName(f.rel, rels)}]]`, note: f.rel }] };
  }
  // the hygiene rule writes its Approve line as its proposal when it has nothing to change (rules/hygiene.js)
  if (f.ruleId === 'note.hygiene') return { kind: 'keep', says: f.proposal, ops: [{ op: 'keep' }] };
  return keep('Quorum has no change to make for this check.');
}

// the text after an addlink step: the line added at the end, once
export function withLinkLine(text, line) {
  const t = String(text ?? '');
  if (t.split('\n').some((l) => l.trim() === line.trim())) return t;
  return `${t.replace(/\n*$/, '')}\n${line}\n`;
}
