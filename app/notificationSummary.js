// The words of a Notifications row: a one or two line summary of what happened, the question and suggested answer
// when a row needs a decision, and the full details the row folds open to. Each kind of event has its own wording,
// built from what the feed knows about it (activityFeed.js). No file is read here, so every rule is tested on its own
// (test/notification-summary.test.js).

// a note's name as the person gave it: its title, else its first heading, else its file name without the date in
// front and the short id Quorum adds at the end ("2026-11-15-standup-f55bd1f8" reads "Standup")
export function titleOf({ title, h1, rel }) {
  const given = String(title || h1 || '').trim();
  if (given) return given;
  const base = String(rel ?? '').split('/').pop().replace(/\.md$/i, '');
  if (base === 'index') return 'Index';
  if (/^\d{4}-\d{2}-\d{2}$/.test(base)) return `Daily note ${base}`;
  const words = base.replace(/^\d{4}-\d{2}-\d{2}(?:[T_ -]\d{2}[-:.]?\d{2}(?:[-:.]?\d{2})?)?[-_ ]*/, '').replace(/(?:^|[-_ ]+)(?=[0-9a-f]*\d)[0-9a-f]{6,12}$/i, '').replace(/[-_]+/g, ' ').trim();
  if (!words) return /^\d{4}-\d{2}-\d{2}/.test(base) ? `Note from ${base.slice(0, 10)}` : 'Untitled note';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const q = (t) => `“${t}”`;
const sentence = (t) => { const s = String(t ?? '').trim(); if (!s) return ''; const c = s.charAt(0).toUpperCase() + s.slice(1); return /[.!?]$/.test(c) ? c : `${c}.`; };
const names = (files, max = 3) => {
  const t = files.map((f) => f.title ?? f.label);
  if (t.length <= max) return t.length > 1 ? `${t.slice(0, -1).join(', ')} and ${t[t.length - 1]}` : t[0] ?? '';
  return `${t.slice(0, max).join(', ')} and ${t.length - max} more`;
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const home = (p) => String(p ?? '').replace(/^\/Users\/[^/]+/, '~');
const base = (p) => String(p ?? '').split('/').filter(Boolean).pop() ?? '';
const quoted = (text, word) => String(text ?? '').match(new RegExp(`${word} "([^"]*)"`))?.[1] ?? null;

// what a guard stopped, in the words of the tool it stopped
const verbOf = (tool) => {
  const t = String(tool ?? '').toLowerCase();
  if (['read', 'glob', 'grep', 'ls', 'notebookread'].includes(t)) return 'reading';
  if (['write', 'edit', 'multiedit', 'notebookedit'].includes(t)) return 'changing';
  if (t === 'bash') return 'running a command on';
  if (t === 'webfetch' || t === 'websearch') return 'sending';
  return t ? `using ${tool} on` : 'reaching';
};

// the suggested answer for a decision, and why. A note Quorum wrote from the person's own recording or from a
// connected app keeps its source, so approving it is the usual answer. Memory updates are judged by their size: a few
// changed blocks are routine upkeep; a large rewrite is worth opening before it is kept
const BIG_CHANGE = 20;
// A junk note (noteJunk.js) has no recording and almost no real words, so moving it to the Trash is the usual answer;
// the Trash keeps it recoverable
function askOf(row) {
  const t = row.target.title;
  const d = row.detail ?? {};
  // a Memory health issue: the issue is the question, its recommended fix the recommendation (memoryHealth.js)
  // a review rule's finding (rules/index.js): no automatic fix, so the suggestion is to act on the note and archive it
  // an item the agent drafted recommends the draft (memoryDraft.js)
  const drafted = d.draft?.wrong ? d.draft.line : d.draft?.line ? `The agent drafted a fix: ${d.draft.line}.` : null;
  if (row.review.kind === 'finding') return { question: d.title ?? `Check ${q(t)}`, suggest: row.review.fix ? 'approve' : 'dismiss', problem: d.problem ?? '', solution: drafted ?? d.solution ?? '', value: '', recommendation: drafted ?? d.recommend ?? '', why: d.rule ?? '' };
  if (row.review.kind === 'link') return { question: d.title ?? `Links to ${q(t)} open nothing`, suggest: 'approve', problem: d.problem ?? '', solution: drafted ?? d.solution ?? '', value: d.value ?? '', recommendation: drafted ?? d.recommend ?? '', why: d.recommend ?? '' };
  // an ignore rule Quorum proposes (ruleRecords.js)
  if (row.review.kind === 'ignore') {
    const shared = d.field === 'folder' ? `the folder ${q(d.value)}` : d.field === 'key' ? `the frontmatter key ${q(d.value)}` : `the target ${q(d.value)}`;
    return {
      question: `${d.title ?? 'Stop flagging these findings'}?`, suggest: 'approve',
      problem: `You archived findings of the check ${q(d.rule ?? '')} ${d.count ?? 0} times, and they share ${shared}.`,
      solution: 'Quorum keeps an ignore rule in its own settings, never in the vault. Findings of this check that match it stop showing. You can remove the rule in Settings > Memory.',
      value: 'Needs review stops asking about what you already decided to leave.', recommendation: 'Stop flagging them.', why: d.title ?? '',
    };
  }
  // a fix that ran and that the current rules would not make (fixRecheck.js): its corrective fix undoes the wrong change
  // and sends the link back to review, where the current rules give it a fix; when Quorum cannot undo it, open the note
  if (row.review.kind === 'past-fix') {
    const a = d.approve ?? null;
    const problem = `${sentence(d.outcome)} The current rules would not make this fix. ${(d.reasons ?? []).join(' ')}`.trim();
    const value = 'The vault keeps only the fixes the current rules would make, so the agent reads fewer wrong links and notes.';
    const back = 'Then the link goes back to Needs review, or Quorum points it at the note the current rules pick when that fix needs no review of its own.';
    // Quorum cannot undo it exactly: Approve does the first of git, remove and draft that applies, else keeps it
    if (a?.kind === 'keep') return { question: `Keep the fix on ${q(t)}?`, suggest: 'approve', problem, solution: sentence(a.why), value, recommendation: 'Keep as is.', why: (d.reasons ?? [])[0] ?? '' };
    if (a) {
      const rec = a.kind === 'git' ? 'Restore the note from git history.' : a.kind === 'remove' ? 'Remove what the fix left.' : 'Run the drafted fix.';
      return { question: `Correct the fix on ${q(t)}?`, suggest: 'approve', problem, solution: `${sentence(a.why)} ${back}`, value, recommendation: rec, why: (d.reasons ?? [])[0] ?? '' };
    }
    const undo = !!row.review.undo;
    return {
      question: undo ? `Correct the fix on ${q(t)}?` : `Check the fix on ${q(t)}`, suggest: 'approve', problem,
      solution: undo ? `${sentence(d.undo)} ${back}` : `Quorum cannot undo it here. ${sentence(d.undo)} Open the note to check it.`,
      value, recommendation: undo ? 'Approve the corrective fix.' : 'Open the note and check it.', why: (d.reasons ?? [])[0] ?? '',
    };
  }
  if (row.review.kind === 'junk-note') {
    return { question: `Remove ${q(t)}?`, suggest: 'approve', problem: sentence(d.reason) || 'It has no recording and almost no real words.', solution: 'Quorum moves the note to the Trash, where you can put it back.', value: 'Empty notes stop showing up in search and in the agent\'s answers.', recommendation: 'Move it to the Trash.', why: 'It looks empty.' };
  }
  if (row.review.kind === 'note') {
    const why = d.editedAfter ? 'You already edited it after Quorum wrote it, so it has your changes in it.'
      : d.writtenFrom === 'recording' ? 'Quorum wrote it from your own recording, and the transcript stays with it to check against.'
        : d.writtenFrom === 'import' ? 'An agent imported it from a connected app and kept the source text.'
          : 'Quorum wrote it and nothing has changed it since.';
    return { question: `Keep ${q(t)} as Quorum wrote it?`, suggest: 'approve', problem: `Quorum wrote this note and nobody has checked it yet. ${why}`, solution: 'Quorum marks the note reviewed and keeps its text.', value: 'The note stops waiting for a check, and the agent can rely on it as checked memory.', recommendation: 'Keep it as Quorum wrote it.', why };
  }
  const n = row.review.count ?? 1;
  const blocks = d.changes ?? 0;
  const reason = d.reason ? ` when it ${String(d.reason).replace(/^./, (c) => c.toLowerCase()).replace(/\.$/, '')}` : '';
  const question = `Keep the agent's ${plural(n, 'update')} to ${q(t)}?`;
  if (blocks > BIG_CHANGE) {
    const why = `It rewrites a large part of the page (${plural(blocks, 'changed block')}).`;
    return { question, suggest: 'reject', problem: `The agent changed ${q(t)} and the change waits for a check. ${why}`, solution: 'Quorum puts back the text from before these updates. The updates stay in the page\'s history.', value: 'A large rewrite stays out of memory until you have checked it.', recommendation: 'Put back the text from before these updates.', why };
  }
  const why = `A small change (${plural(blocks, 'changed block')}) the agent made${reason}.`;
  return { question, suggest: 'approve', problem: `The agent changed ${q(t)} and the change waits for a check. ${why}`, solution: 'Quorum keeps the updated text as the current version.', value: 'The page stays current with what the agent filed.', recommendation: `Keep the agent's ${plural(n, 'update')}.`, why };
}

// the summary of one row: line is the first line, sub an optional second; ask is set when the row needs a decision
// a meeting's date in words ("Thu, Nov 12"); a full timestamp or a bare day both read the same, and anything unreadable
// is shown as given
const DAY = { weekday: 'short', month: 'short', day: 'numeric' };
export function meetingDay(raw) {
  const s = String(raw);
  const bare = /^\d{4}-\d{2}-\d{2}$/.test(s);
  const d = new Date(bare ? `${s}T12:00:00` : s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString('en-US', DAY);
}

export function summaryOf(row) {
  const t = row.target?.title ?? 'a note';
  const d = row.detail ?? {};
  if (row.review) {
    const ask = askOf(row);
    // the decision part of a review: what is wrong and what Quorum recommends. Approve takes the recommendation;
    // Dismiss marks it reviewed and changes nothing
    return { line: ask.question, sub: null, ask, problem: ask.problem, solution: ask.solution, value: ask.value, recommendation: ask.recommendation };
  }
  if (row.event === 'fix' && row.run?.kind === 'batch') {
    const r = row.run;
    const n = r.items?.length ?? 0;
    const what = `${n} memory ${n === 1 ? 'fix' : 'fixes'}`;
    if (r.status === 'queued') return { line: `Waiting to apply ${what}`, sub: null };
    if (r.status === 'running') return { line: `Applying ${what}`, sub: null };
    if (r.status === 'error') return { line: `Could not apply ${what}`, sub: sentence(r.error) || null };
    return { line: r.auto ? `Quorum applied ${what} on its own` : `Applied ${what}`, sub: sentence(r.outcome) || null };
  }
  if (row.event === 'fix' && row.run) {
    const r = row.run;
    const name = q(r.target);
    if (r.status === 'queued') return { line: `Waiting to fix ${name}`, sub: null };
    if (r.status === 'running') return { line: `Fixing ${name}`, sub: null };
    if (r.status === 'error') return { line: `Could not fix ${name}`, sub: sentence(r.error) || null };
    return { line: `Fixed ${name}`, sub: sentence(r.outcome) || null };
  }
  if (row.kind === 'guardrail') {
    const who = d.surface === 'keeper' ? 'Upkeep' : 'The agent';
    const what = base(d.path) || (String(d.tool ?? '').toLowerCase() === 'bash' ? 'a command' : 'a request');
    const verb = verbOf(d.tool);
    return { line: `Blocked ${who === 'Upkeep' ? 'upkeep' : 'the agent'} from ${verb === 'running a command on' && !d.path ? 'running a command' : `${verb} ${what}`}`, sub: sentence([d.guardLabel && `${d.guardLabel} rule`, d.reason].filter(Boolean).join(': ')) || null };
  }
  if (row.kind === 'imported' && row.event === 'imported-note') {
    return { line: `Imported ${q(t)} from ${d.sourceName ?? 'a connected app'}`, sub: d.date ? `Meeting on ${meetingDay(d.date)}.` : null };
  }
  if (row.target?.kind === 'memory' || row.event === 'version') {
    if (row.who === 'you') {
      if (/^Restored/.test(d.reason ?? '')) return { line: `You restored an earlier version of ${q(t)}`, sub: sentence(d.reason) };
      if (/^Rejected/.test(d.reason ?? '')) return { line: `You rejected the agent's updates to ${q(t)}`, sub: 'The page went back to its earlier text.' };
      return { line: `You ${d.created ? 'created' : d.removed ? 'deleted' : 'edited'} ${q(t)}`, sub: sentence(d.reason) || null };
    }
    if (row.kind === 'imported') return { line: `Imported ${q(t)}`, sub: sentence(d.reason) || null };
    const size = d.changes ? `${plural(d.changes, 'changed block')}.` : '';
    const sub = [sentence(d.reason), size].filter(Boolean).join(' ') || null;
    if (d.created) return { line: `Created the memory ${q(t)}`, sub };
    if (d.removed) return { line: `Removed the memory ${q(t)}`, sub };
    return { line: `Updated the memory ${q(t)}`, sub };
  }
  // a note's own log and its upkeep runs
  const files = row.files ?? [];
  switch (row.event) {
    case 'filed':
      if (files.length) return { line: `Filed ${q(t)} into your memory`, sub: `Linked it to ${names(files)}.` };
      if (d.skipped) return { line: `Left ${q(t)} as it is`, sub: sentence(d.skipped) };
      return { line: `Checked ${q(t)} against your memory`, sub: 'Nothing needed a new link or an update.' };
    case 'referenced': {
      const asked = quoted(d.text, 'answer');
      return { line: `Used ${q(t)} to answer a question`, sub: asked ? `You asked ${q(asked)}.` : null };
    }
    case 'agent-edit': return { line: `Updated ${q(t)} with the change you approved`, sub: null };
    case 'named': return { line: `Named a new note ${q(quoted(d.text, 'named it') ?? t)}`, sub: null };
    case 'saved': return row.who === 'you' ? { line: `You saved ${q(t)}`, sub: null } : { line: `Wrote the summary of ${q(t)}`, sub: 'Saved it with your recording.' };
    case 'edited': return { line: `You edited ${q(t)}`, sub: null };
    case 'reviewed': return { line: `You approved ${q(t)}`, sub: null };
    case 'rejected': return { line: `You declined ${q(t)}`, sub: null };
    default: return { line: row.who === 'you' ? `You changed ${q(t)}` : `Updated ${q(t)}`, sub: sentence(d.text) || null };
  }
}

const KIND_LABEL = {
  'note-written': 'Wrote a note', 'note-updated': 'Updated a note', filed: 'Filed and linked', referenced: 'Referenced',
  'memory-created': 'Created a memory', 'memory-updated': 'Updated a memory', imported: 'Imported', guardrail: 'Guardrail blocked', 'memory-health': 'Memory health', you: 'Your change',
};
const WHO = { keeper: 'Upkeep', agent: 'Quorum agent', import: 'An import', cli: 'The quorum command', you: 'You', human: 'You' };

// everything the feed knows about a row, as label and value pairs for the folded-open details
export function detailsOf(row, { locale } = {}) {
  const d = row.detail ?? {};
  const out = [['What', row.review?.kind === 'junk-note' ? 'Looks empty' : row.review?.kind === 'past-fix' ? 'Past fix to check' : KIND_LABEL[row.kind] ?? row.kind], ['When', new Date(row.at).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })]];
  const add = (label, value) => { if (value != null && value !== '') out.push([label, String(value)]); };
  if (row.kind === 'guardrail') {
    add('Rule', d.guardLabel || d.guard);
    add('Tool', d.tool);
    add('Where', d.surface === 'keeper' ? 'Upkeep, filing your notes' : d.surface === 'agent' ? 'The agent, answering in chat' : d.surface);
    add('Path', home(d.path));
    add('Reason', d.reason);
  } else if (row.review?.kind === 'link' || row.review?.kind === 'finding') {
    for (const [k, v] of d.meta ?? []) add(k, v);
  } else if (row.review?.kind === 'ignore') {
    add('Check', d.rule);
    add('Archived', d.count);
  } else if (row.review?.kind === 'past-fix') {
    add('Fix', sentence(d.outcome));
    if (d.ranAt) add('Ran', new Date(d.ranAt).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }));
    for (const [k, v] of d.evidence ?? []) add(k, v);
    add('Undo', sentence(d.undo));
  } else {
    add(row.target.kind === 'memory' ? 'Memory' : 'Note', row.target.rel);
    add('By', row.who === 'you' ? 'You' : WHO[d.who] ?? 'Quorum agent');
    add('Reason', d.reason);
    add('Source', d.sourceName);
    if (d.changes) add('Changes', plural(d.changes, 'changed block'));
    if (d.approved != null && !row.review) add('Approval', d.auto ? 'Approved automatically' : d.approved ? 'Approved' : 'Waiting for approval');
    if (row.review?.kind === 'memory') add('Updates waiting', row.review.count);
    if (d.skipped) add('Left as it is', d.skipped);
    if (d.text && row.event !== 'version') add('Logged as', d.text);
  }
  if (row.backfill) add('History', 'From before Notifications kept a log, so it starts out read');
  return out;
}
