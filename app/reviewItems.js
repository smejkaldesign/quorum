// The review items of Needs review as the batch planner reads them (batchPlan.js): a missing link's fix, a corrective
// past fix, and a review rule's fix. Plain Node with no Electron, so main and the read-only plan script build the same
// items. An item's id is its row id in Notifications.
export const ROW = { link: 'r:link:', pastfix: 'r:pastfix:', finding: 'r:find:' };
// the title of a past fix an agent can improve (reviewApprove.js retroOf)
export const RETRO_TITLE = 'Retroactive improvement';
const q = (t) => `“${t}”`;

// the line of every link to target in each source note. noteOf(rel) answers the parsed note (linkparse.js)
export function linkLines(noteOf, sources, target) {
  const want = String(target).toLowerCase();
  const out = {};
  for (const rel of sources ?? []) {
    const lines = (noteOf(rel)?.links ?? []).filter((l) => String(l.target).toLowerCase() === want).map((l) => l.line);
    if (lines.length) out[rel] = [...new Set(lines)];
  }
  return out;
}

// a missing link's fix (memoryHealth.js issueOf). A fix that leaves the link has nothing to run
export function linkItem(issue, { noteOf = () => null } = {}) {
  const c = issue.candidate;
  // how well the name matched the note Quorum picked, for the quality gate (qualityGate.js weakLink)
  const match = c ? { exact: !!c.exact, score: Number(c.score ?? 0) } : null;
  const base = { id: `${ROW.link}${issue.key}`, kind: 'link', key: issue.key, target: issue.target, title: issue.target, sources: issue.sources ?? [], autoFix: !issue.reviewOnly && issue.action !== 'leave', reviewOnly: !!issue.reviewOnly, match };
  const lines = () => linkLines(noteOf, issue.sources, issue.target);
  if (issue.action === 'alias' && c) return { ...base, ops: [{ op: 'alias', rel: c.rel, alias: issue.target }] };
  if (issue.action === 'relink' && c) return { ...base, ops: [{ op: 'relink', target: issue.target, to: c.rel, sources: issue.sources, lines: lines(), links: issue.links }] };
  if (issue.action === 'unlink') return { ...base, ops: [{ op: 'unlink', target: issue.target, sources: issue.sources, lines: lines(), links: issue.links }] };
  if (issue.action === 'create') {
    const name = String(issue.target).split('/').pop();
    return { ...base, ops: [{ op: 'create', rel: `${issue.createIn ? `${issue.createIn}/` : ''}${name}.md`, sources: issue.sources }] };
  }
  return { ...base, autoFix: false, hold: 'Its fix leaves the link as it is. Archive it instead.', ops: [] };
}

// a past fix the current rules flag (fixRecheck.js), as the fix that corrects it: undo the wrong change, then the link
// goes back to review, where the current rules give it a fix. plan: undoPlan(), with plan.approve (reviewApprove.js
// approvePastFix) when the undo refused; res: recheckRun()
export function pastFixItem({ run, res, plan }) {
  const base = { id: `${ROW.pastfix}${run.id}`, kind: 'pastfix', key: run.id, target: `pastfix:${run.id}`, title: run.target, link: run.key, autoFix: false, reviewOnly: false };
  if (!plan?.ok) {
    const a = plan?.approve;
    if (!a?.ops?.length) return { ...base, hold: plan?.why ?? 'Quorum cannot undo this fix.', ops: [] };
    // keep changes nothing, so the fix stays and its link stays as it is; the other paths undo the change like an undo.
    // A Retroactive improvement carries what the agent may draft for it, and its draft once there is one
    const group = a.kind === 'draft' ? 'retro' : a.kind === 'keep' ? 'keep' : a.ops[0].op === 'trash' ? 'trash' : a.ops[0].op === 'unlink' ? 'unlink' : 'restore';
    return { ...base, group, via: a.kind, keep: a.kind === 'keep', ops: a.ops, ...(a.retro ? { retro: a.retro } : {}), ...(a.draft ? { draft: a.draft } : {}) };
  }
  const ops = plan.files.map((f) => (f.before == null ? { op: 'trash', rel: f.rel } : { op: 'restore', rel: f.rel, before: f.before, expect: f.expect }));
  const group = res?.action === 'create' ? 'trash' : res?.action === 'alias' ? 'unalias' : 'restore';
  // an exact reversal is computed from the vault as it is now, so it can run without a person reading it
  return { ...base, group, autoFix: plan.kind === 'record' || plan.kind === 'versions' || plan.kind === 'trash' || plan.kind === 'exact', ops };
}

// a review rule's finding: its own fix (rules/confidential.js: tag, move, or move and tag; rules/nearDuplicates.js:
// link two notes; rules/contradictions.js: add a marker to one line; rules/hygiene.js: trash litter folders, compact a
// note, commit notes), else the change Approve makes for its rule (reviewApprove.js approveFinding, kept on the finding as
// approve), else keep as is
export function findingItem(f) {
  // a finding on the vault as a whole (rules/hygiene.js litter and uncommitted notes) has no note and goes by its title
  const base = { id: `${ROW.finding}${f.key}`, kind: 'finding', key: f.key, target: f.key, title: f.rel ?? f.title, ruleId: f.ruleId, notes: f.notes, autoFix: !!f.autoFix, reviewOnly: false };
  const x = f.fix;
  if (!x) {
    const a = f.approve ?? { kind: 'keep', ops: [{ op: 'keep' }] };
    return { ...base, autoFix: false, group: a.kind === 'keep' ? 'keep' : undefined, keep: a.kind === 'keep', ops: a.ops };
  }
  const ops = [];
  if (x.kind === 'link') ops.push({ op: 'link', rel: f.rel, to: x.to });
  if (x.kind === 'annotate') ops.push({ op: 'annotate', rel: f.rel, line: x.line, text: x.text, add: x.add });
  if (x.kind === 'tag' || x.kind === 'move-tag') ops.push({ op: 'tag', rel: f.rel, value: x.value });
  if (x.kind === 'move' || x.kind === 'move-tag') ops.push({ op: 'move', rel: f.rel, to: x.to });
  if (x.kind === 'trashdirs') ops.push({ op: 'trashdirs', dirs: x.dirs, ignore: x.ignore ?? [], gitignore: x.gitignore ?? null, bytes: x.bytes ?? 0, line: x.line });
  if (x.kind === 'compact') ops.push({ op: 'compact', rel: f.rel, copies: x.copies, hash: x.hash });
  if (x.kind === 'commit') ops.push({ op: 'commit', paths: x.paths, message: x.message, branch: x.branch });
  return { ...base, ops };
}

// what an item does, in one line for the checklist
export function itemLine(item) {
  // an item the agent fixes when Approve runs (main.js agentNeed), and the fallback after the agent could not fix it
  if (item.agent?.line) return item.agent.line;
  if (item.fallback) return `Remove the dead links to ${q(item.target)} and keep their words`;
  const o = item.ops?.[0];
  if (!o) return item.hold ?? '';
  if (item.group === 'merge') return `Merge ${q(item.ops[1]?.rel)} into ${q(o.rel)}`;
  if (item.group === 'rewrite') return `Rewrite ${q(o.rel)} as the agent drafted it`;
  if (o.op === 'keep') return item.kind === 'pastfix' ? `Keep the earlier fix on ${q(item.title)} as it is` : `Keep ${q(item.title)} as it is`;
  if (item.kind === 'pastfix' && item.group === 'retro' && item.retro) {
    const r = item.retro;
    const a = item.draft?.action;
    if (a === 'relink') return `Point the links an earlier fix moved to ${q(r.wrong)} at ${q(item.draft.to)}`;
    if (a === 'unlink') return `Remove the links an earlier fix pointed at ${q(r.wrong)}, and keep their words`;
    if (a === 'rewrite') return `Rewrite ${q(r.made)} from its linking notes, as the agent drafted it`;
    if (a === 'remove') return `Remove ${q(r.made)}, which an earlier fix wrote`;
  }
  if (item.kind === 'pastfix') {
    if (item.group === 'trash') return `Remove ${q(o.rel)}, which an earlier fix wrote for ${q(item.title)}`;
    if (o.op === 'unlink') return `Remove the links to ${q(o.target)} an earlier fix left, and keep their words`;
    return item.via === 'git' ? `Put back the notes the earlier fix on ${q(item.title)} changed, from git history` : `Undo the earlier fix on ${q(item.title)}`;
  }
  if (o.op === 'alias') return `Add ${q(o.alias)} as an alias of ${q(o.rel)}`;
  if (o.op === 'relink') return `Point the links to ${q(o.target)} at ${q(o.to)}`;
  if (o.op === 'unlink') return `Remove the dead links to ${q(o.target)}`;
  if (o.op === 'create') return `Write ${q(o.rel)}${o.text ? ' as the agent drafted it' : ''}`;
  if (o.op === 'link') return `Link ${q(o.rel)} to ${q(o.to)}`;
  if (o.op === 'annotate') return `Add ${q(o.add.trim())} to line ${o.line} of ${q(o.rel)}`;
  if (o.op === 'tag' && item.ops[1]?.op === 'move') return `Tag ${q(o.rel)} confidential: ${o.value} and move it to ${q(item.ops[1].to)}`;
  if (o.op === 'tag') return `Tag ${q(o.rel)} confidential: ${o.value}`;
  if (o.op === 'move') return `Move ${q(o.rel)} to ${q(o.to)}`;
  if (o.op === 'setkey') return `Set ${item.ops.map((x) => `${x.key}: ${x.value}`).join(', ')} in ${q(o.rel)}`;
  if (o.op === 'addlink') return `Link ${q(o.note)} from ${q(o.rel)}`;
  if (o.op === 'trashdirs') return o.line;
  if (o.op === 'compact') return `Back up ${q(o.rel)} to Quorum’s data folder, then remove ${o.copies} word-for-word repeated ${o.copies === 1 ? 'copy' : 'copies'} from it`;
  if (o.op === 'commit') return `Commit ${o.paths.length} ${o.paths.length === 1 ? 'note' : 'notes'} on ${o.branch} with the message ${q(o.message)}`;
  return item.title;
}
