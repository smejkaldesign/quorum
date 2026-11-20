// The bulk plan of Memory health: a set of review items (link fixes, corrective past fixes, finding fixes) turned into
// one ordered batch. Plain Node with no Electron, so main, the tests and a read-only script use the same planner.
//
// An item is all or nothing: { id, kind, title, target, autoFix, reviewOnly, hold, ops }. kind is 'link', 'pastfix' or
// 'finding'; hold is a reason known before planning that keeps it out (for example a past fix Quorum cannot undo).
// Each op is one change to the vault:
//   { op: 'trash', rel }                        move a note to the Trash
//   { op: 'restore', rel, before, expect }      put a note's whole text back
//   { op: 'unalias', rel, alias }               take an alias back out of a note
//   { op: 'alias', rel, alias }                 add an alias to a note; it points links at rel
//   { op: 'relink', target, to, sources, lines, links }   point the links to target at to; lines: { [rel]: [line] }
//   { op: 'unlink', target, sources, lines, links }       remove the links to target and keep their words
//   { op: 'create', rel, sources }              write a missing note
//   { op: 'tag', rel, value }                   set confidential: value in a note's frontmatter
//   { op: 'move', rel, to }                     move a note; the links that point at it follow
//   { op: 'link', rel, to }                     add a Related line that links rel to the note to
//   { op: 'setkey', rel, key, value }           set one frontmatter key (value written as YAML)
//   { op: 'addlink', rel, line, note }          add a link line to the end of an index note, linking note
//   { op: 'annotate', rel, line, text, add }    add text at the end of line (1-based), which must still read text
//   { op: 'trashdirs', dirs, ignore, gitignore }  move litter folders to the Trash, add ignore patterns to .gitignore
//   { op: 'compact', rel, copies }              back up a note, then cut each repeated block to its first and last copy
//   { op: 'commit', paths, message, branch }    stage and commit notes on the current branch
//   { op: 'mention', rel, name, to, target }    link the first plain mention of name in rel to the note to
//   { op: 'merge', rel, drop, alias }           merge drop into rel: its text under a heading, alias added, its links
//                                               pointed at rel, drop to the Trash
//   { op: 'split', rel, parts }                 move each part (heading, start, end, to) into a note of its own
//   { op: 'movefacts', rel, to }                move the learned facts block of rel into the facts file to
//   { op: 'summary', rel, folder, text, replace }  write a topic summary in the Quorum folder, over one Quorum wrote
//   { op: 'keep' }                              change nothing: Approve keeps the item as it is and marks it done
// An item the agent drafted (memoryDraft.js) carries draft; a merge is a restore of the kept note and a trash of the
// other, a rewrite is a restore.
//
// The planner checks each item against the items before it, in order: corrective past fixes first, then link fixes,
// then finding fixes, each kind in the order given. The conflicts it handles:
//   duplicate        the same item, or another item for the same target: the later one is skipped
//   same region      two items change the same line or frontmatter key of a note: merged when both edits apply in one
//                    pass (two links on one line, two aliases), held back otherwise
//   whole note       an item puts back a note's whole text that another item also changes: the later one is held back
//   onto removed     a relink or alias onto a note another item removes: skipped, the link is checked again after
//   onto new stub    a relink or alias onto a note another item writes in this batch: skipped
//   edit removed     an edit of a note another item removes or has yet to write: held back
//   move and edit    an edit of a note another item moves: merged, the edit runs before the move
// The steps that remain run in phases so each step's preconditions hold: put back, remove, edit, write, move.

const q = (t) => `“${t}”`;
const PHASE = { restore: 0, unalias: 0, trash: 1, tag: 2, setkey: 2, alias: 3, relink: 4, unlink: 5, link: 5, addlink: 5, annotate: 5, compact: 2, trashdirs: 1, create: 6, mention: 6.5, merge: 1.5, split: 2, move: 7, commit: 8, keep: 9 };
const KIND_ORDER = { pastfix: 0, link: 1, finding: 2 };
const norm = (t) => String(t ?? '').toLowerCase().replace(/\.md$/, '').replace(/\s+/g, ' ').trim();

// what an op does to the vault: the notes it changes, by region, the notes it removes or writes, the note it points at
export function effects(o) {
  const writes = [];
  const out = { writes, removes: [], creates: [], points: null };
  const lineRegions = (rel) => { const ls = o.lines?.[rel]; return ls?.length ? ls.map((n) => `line:${n}`) : [`links:${norm(o.target)}`]; };
  switch (o.op) {
    case 'trash': out.removes.push(o.rel); break;
    case 'restore': writes.push({ rel: o.rel, region: 'all' }); break;
    case 'unalias': case 'alias': writes.push({ rel: o.rel, region: 'fm:aliases' }); if (o.op === 'alias') out.points = o.rel; break;
    case 'relink': case 'unlink':
      for (const rel of o.sources ?? []) for (const region of lineRegions(rel)) writes.push({ rel, region });
      if (o.op === 'relink') out.points = o.to;
      break;
    case 'create': out.creates.push(o.rel); break;
    case 'tag': writes.push({ rel: o.rel, region: 'fm:confidential' }); break;
    case 'link': writes.push({ rel: o.rel, region: `related:${norm(o.to)}` }); out.points = o.to; break;
    case 'setkey': writes.push({ rel: o.rel, region: `fm:${o.key}` }); break;
    case 'addlink': writes.push({ rel: o.rel, region: 'end' }); out.points = o.note ?? null; break;
    case 'annotate': writes.push({ rel: o.rel, region: `line:${o.line}` }); break;
    case 'move': out.removes.push(o.rel); out.creates.push(o.to); break;
    case 'compact': writes.push({ rel: o.rel, region: 'all' }); break;
    case 'mention': writes.push({ rel: o.rel, region: `mention:${norm(o.name)}` }); out.points = o.to; break;
    case 'merge': writes.push({ rel: o.rel, region: 'all' }); out.removes.push(o.drop); break;
    case 'split': writes.push({ rel: o.rel, region: 'all' }); out.creates.push(...(o.parts ?? []).map((p) => p.to)); break;
    // each source adds its own lines to the facts file, read when the step runs, so two sources never conflict there
    case 'summary': if (o.replace) writes.push({ rel: o.rel, region: 'all' }); else out.creates.push(o.rel); break;
    case 'movefacts': writes.push({ rel: o.rel, region: 'learned' }, { rel: o.to, region: `learned:${norm(o.rel)}` }); break;
    default: break;
  }
  return out;
}

// two edits of the same region that apply one after the other with the result both want
function composes(a, b) {
  const links = (o) => o.op === 'relink' || o.op === 'unlink';
  if (links(a) && links(b)) return norm(a.target) !== norm(b.target);
  if (a.op === 'alias' && b.op === 'alias') return norm(a.alias) !== norm(b.alias);
  if (a.op === 'addlink' && b.op === 'addlink') return a.line !== b.line;
  if (a.op === 'merge' && b.op === 'merge') return a.rel === b.rel && a.drop !== b.drop;
  return false;
}
// the same change twice
const sameOp = (a, b) => a.op === b.op && JSON.stringify({ ...a, lines: undefined, links: undefined, expect: undefined }) === JSON.stringify({ ...b, lines: undefined, links: undefined, expect: undefined });

const GROUPS = {
  trash: { order: 0, label: (n, past) => (past ? `Remove ${n} ${n === 1 ? 'note an earlier fix' : 'notes earlier fixes'} created` : `Remove ${n} ${n === 1 ? 'note' : 'notes'}`) },
  restore: { order: 1, label: (n) => `Put back ${n} ${n === 1 ? 'note an earlier fix' : 'notes earlier fixes'} changed` },
  retro: { order: 1.5, label: (n) => `Make ${n} retroactive ${n === 1 ? 'improvement' : 'improvements'} to earlier fixes` },
  unalias: { order: 2, label: (n) => `Take back ${n} ${n === 1 ? 'alias an earlier fix' : 'aliases earlier fixes'} added` },
  relink: { order: 3, label: (n) => `Relink ${n} ${n === 1 ? 'link' : 'links'}` },
  alias: { order: 4, label: (n) => `Add ${n} ${n === 1 ? 'alias' : 'aliases'}` },
  unlink: { order: 5, label: (n) => `Remove ${n} dead ${n === 1 ? 'link' : 'links'}` },
  create: { order: 6, label: (n) => `Write ${n} missing ${n === 1 ? 'note' : 'notes'}` },
  tag: { order: 7, label: (n) => `Tag ${n} ${n === 1 ? 'note' : 'notes'} confidential` },
  'move-tag': { order: 8, label: (n) => `Move and tag ${n} ${n === 1 ? 'note' : 'notes'}` },
  move: { order: 9, label: (n) => `Move ${n} ${n === 1 ? 'note' : 'notes'}` },
  link: { order: 10, label: (n) => `Link ${n} ${n === 1 ? 'pair' : 'pairs'} of notes that repeat each other` },
  merge: { order: 11, label: (n) => `Merge ${n} ${n === 1 ? 'pair' : 'pairs'} of notes` },
  rewrite: { order: 12, label: (n) => `Rewrite ${n} ${n === 1 ? 'note' : 'notes'} that disagree with another` },
  setkey: { order: 13, label: (n) => `Update the frontmatter of ${n} ${n === 1 ? 'note' : 'notes'}` },
  addlink: { order: 14, label: (n) => `Link ${n} ${n === 1 ? 'note' : 'notes'} from ${n === 1 ? 'its folder index' : 'their folder indexes'}` },
  annotate: { order: 15, label: (n) => `Mark ${n} out of date ${n === 1 ? 'line' : 'lines'} that newer notes disagree with` },
  trashdirs: { order: 15.2, label: (n) => `Move the temp folders of ${n} ${n === 1 ? 'vault' : 'vaults'} to the Trash` },
  compact: { order: 15.4, label: (n) => `Remove repeated blocks from ${n} ${n === 1 ? 'note' : 'notes'}` },
  commit: { order: 15.6, label: (n) => `Commit the uncommitted notes of ${n} ${n === 1 ? 'vault' : 'vaults'}` },
  entity: { order: 15.7, label: (n) => `Write ${n} ${n === 1 ? 'note' : 'notes'} for people and projects the notes mention` },
  'merge-entity': { order: 15.75, label: (n) => `Merge ${n} ${n === 1 ? 'pair' : 'pairs'} of notes for one person or project` },
  'merge-copies': { order: 15.8, label: (n) => `Merge ${n} ${n === 1 ? 'set' : 'sets'} of duplicate notes` },
  mention: { order: 15.85, label: (n) => `Link the attendees of ${n} ${n === 1 ? 'meeting' : 'meetings'}` },
  'mark-instructions': { order: 15.88, label: (n) => `Mark ${n} out of date ${n === 1 ? 'line' : 'lines'} in instruction files` },
  split: { order: 15.9, label: (n) => `Split ${n} long ${n === 1 ? 'note' : 'notes'} into sections` },
  movefacts: { order: 15.95, label: (n) => `Move the learned facts out of ${n} ${n === 1 ? 'file' : 'files'} of yours into Quorum's facts file` },
  keep: { order: 16, label: (n) => `Keep ${n} ${n === 1 ? 'item' : 'items'} as ${n === 1 ? 'it is' : 'they are'}` },
};
// the group an item lists under: what its first change does, or move and tag for a move that also tags
export function groupOf(item) {
  if (item.group && GROUPS[item.group]) return item.group;
  const ops = item.ops ?? [];
  if (ops.some((o) => o.op === 'move') && ops.some((o) => o.op === 'tag')) return 'move-tag';
  return GROUPS[ops[0]?.op] ? ops[0].op : 'relink';
}
// Fixes a person should read before they run: a written missing note, a weak relink or alias, a move, a tag guessed
// from other notes, a link between notes that repeat each other, a fix the agent drafted below high confidence, and an
// item the agent fixes when the plan runs. A bulk plan leaves them unticked under Check these first, with this reason
// per group
const CHECK = {
  create: 'Quorum writes each note from the links to it alone, and those notes are often wrong.',
  relink: 'The note each one points at is a weak match by name.',
  alias: 'The note each alias goes on is a weak match by name.',
  move: 'A move changes the folder of the note and every link to it.',
  'move-tag': 'Quorum picked the folder and the tag from the notes each one links to.',
  tag: 'Quorum guessed each tag from the other notes in its folder or the notes it links to.',
  link: 'Quorum found these pairs from their shared text alone.',
  annotate: 'Quorum paired these lines from the claims two notes make. Read both quotes first.',
  draft: 'The agent drafted these fixes. Read its quotes and its confidence first.',
  trashdirs: 'Quorum picked these folders by their names and because no note links into them.',
  compact: 'Quorum removes text from each note. A backup copy goes to Quorum’s data folder first.',
  commit: 'Quorum commits on the branch you have checked out.',
  entity: 'Quorum found each name in your notes and writes a short note for it. Check the name and the folder.',
  'merge-entity': 'Quorum matched these notes by name alone.',
  'merge-copies': 'Quorum moves the other copies to the Trash.',
  split: 'Quorum moves sections out of each note into notes of their own.',
  'mark-instructions': 'The memory graph holds a newer fact for each line. Read the line first.',
  movefacts: 'Quorum takes its marked block out of each file, which may be one every agent session loads.',
};
// items the agent fixes when the plan runs (main.js agentNeed): one model call each, one at a time
const AGENT = {
  create: 'When the plan runs, the agent writes each note from the notes that link to it. Quorum writes nothing when a quote does not check.',
  point: 'When the plan runs, the agent checks each match against the notes with a close name. It removes the dead link when no note fits.',
};
// the reason an item starts unticked in a bulk plan, or null when it starts ticked
export function checkFirst(item) {
  if (!item?.ops?.length) return null;
  if (item.agent) return AGENT[item.agent.kind] ?? CHECK.draft;
  // the quality gate (qualityGate.js) sends an item it does not trust enough here
  if (item.gate?.bucket === 'check') return item.gate.why;
  if (item.kind === 'pastfix' && !item.draft) return null;
  // a drafted fix starts ticked only at high confidence with every quote checked against its note
  if (item.draft) return item.draft.confidence === 'high' && item.draft.verified && item.draft.quotes?.length && item.draft.quotes.every((x) => x.ok) ? null : CHECK.draft;
  const g = groupOf(item);
  if (item.kind === 'link') return item.reviewOnly || g === 'create' ? CHECK[g] ?? CHECK.relink : null;
  if (item.kind === 'finding') return g === 'move' || g === 'move-tag' || !item.autoFix ? CHECK[g] ?? null : null;
  return null;
}
// the ids a bulk plan leaves out: the ones the person unticked, and every check-first item they did not tick
export function planExclude(items, exclude = [], include = []) {
  const on = new Set(include.map(String));
  const off = new Set(exclude.map(String));
  for (const i of items) if (checkFirst(i) && !on.has(i.id)) off.add(i.id);
  return off;
}
// how much an item adds to its group's count: links for a relink or unlink, one note otherwise
const countOf = (item, group) => {
  if (group !== 'relink' && group !== 'unlink') return 1;
  const os = item.ops.filter((x) => x.op === group);
  return os.length ? os.reduce((n, o) => n + (o.links ?? (Object.values(o.lines ?? {}).reduce((s, l) => s + l.length, 0) || (o.sources ?? []).length || 1)), 0) : 1;
};
// a group's label for these items, in the words of the plan
export function groupLabel(group, items) {
  const id = GROUPS[group] ? group : 'relink';
  return GROUPS[id].label(items.reduce((n, i) => n + countOf(i, id), 0), items.length > 0 && items.every((i) => i.kind === 'pastfix'));
}
// the notes an item touches, for the checklist
export function notesOf(item) {
  const out = new Set();
  for (const o of item.ops ?? []) {
    const e = effects(o);
    for (const w of e.writes) out.add(w.rel);
    for (const r of [...e.removes, ...e.creates]) out.add(r);
  }
  return [...out];
}

// Builds the plan. items: the review items; exclude: ids the person unticked. Answers { steps, groups, merged, skipped,
// held, ok }: steps in the order they run, each { item, op }; groups for the checklist; merged, skipped and held
// back items with a plain reason; ok the ids of the items that run
export function buildPlan(items, { exclude = [] } = {}) {
  const off = new Set(exclude);
  const list = items.filter((i) => !off.has(i.id)).map((i, at) => ({ i, at })).sort((a, b) => (KIND_ORDER[a.i.kind] ?? 3) - (KIND_ORDER[b.i.kind] ?? 3) || a.at - b.at).map((x) => x.i);
  const skipped = [];
  const held = [];
  const merged = [];
  const ok = [];
  // what the items accepted so far do: rel -> item, and rel|region -> { item, op }
  const removed = new Map();
  const removedBy = new Map();
  const created = new Map();
  const moved = new Map();
  const whole = new Map();
  const touched = new Map();
  const regions = new Map();
  const ids = new Set();
  const targets = new Map();
  const title = (i) => q(i.title ?? i.target ?? i.id);
  const mergeNote = (a, b, reason) => { if (!merged.some((m) => m.items[0] === a.id && m.items[1] === b.id)) merged.push({ items: [a.id, b.id], title: b.title ?? b.target ?? b.id, reason }); };

  for (const item of list) {
    const skip = (reason) => skipped.push({ id: item.id, title: item.title ?? item.target ?? item.id, reason });
    const hold = (reason) => held.push({ id: item.id, title: item.title ?? item.target ?? item.id, reason });
    if (ids.has(item.id)) { skip('The same item is in the list twice.'); continue; }
    ids.add(item.id);
    if (item.hold) { hold(item.hold); continue; }
    if (!item.ops?.length) { hold('Quorum has no automatic fix for it.'); continue; }
    const tkey = item.target != null ? `${item.kind}:${norm(item.target)}` : null;
    if (tkey && targets.has(tkey)) { skip(`${title(targets.get(tkey))} already fixes ${q(item.target)}.`); continue; }

    let verdict = null;
    const notes = [];
    const dupOps = new Set();
    for (const o of item.ops) {
      const e = effects(o);
      if (e.points) {
        const by = removed.get(e.points);
        if (by && removedBy.get(e.points) === 'trash') { verdict = { skip: `It points at ${q(e.points)}, which ${title(by)} removes. Quorum checks the link again after this batch.` }; break; }
        const made = created.get(e.points);
        if (made && moved.has(made.id + e.points)) { verdict = { skip: `It points at ${q(e.points)}, where ${title(made)} moves a note in this batch. Quorum checks the link again after this batch.` }; break; }
        if (made) { verdict = { skip: `It points at ${q(e.points)}, the new note ${title(made)} writes. A link is never pointed at a note written from links alone.` }; break; }
      }
      for (const w of e.writes) {
        const gone = removed.get(w.rel);
        if (gone && removedBy.get(w.rel) === 'trash') { verdict = { hold: `${title(gone)} removes ${q(w.rel)}, the note this changes.` }; break; }
        if (gone && removedBy.get(w.rel) === 'move') { notes.push(() => mergeNote(gone, item, `Its change to ${q(w.rel)} runs before ${title(gone)} moves the note.`)); continue; }
        const made = created.get(w.rel);
        if (made) { verdict = { hold: `${q(w.rel)} is the new note ${title(made)} writes in this batch. Approve it after this batch.` }; break; }
        const all = whole.get(w.rel);
        if (all && all.id !== item.id) { verdict = { hold: `${title(all)} puts back the whole text of ${q(w.rel)}. Approve it after this batch.` }; break; }
        if (w.region === 'all') { const t = touched.get(w.rel); if (t && t.id !== item.id) { verdict = { hold: `${title(t)} also changes ${q(w.rel)}. Approve it after this batch.` }; break; } }
        const r = regions.get(`${w.rel}|${w.region}`);
        if (r && r.item.id !== item.id) {
          if (sameOp(r.op, o)) { dupOps.add(o); notes.push(() => mergeNote(r.item, item, `It makes the same change to ${q(w.rel)} as ${title(r.item)}, so it runs once.`)); continue; }
          if (composes(r.op, o)) { notes.push(() => mergeNote(r.item, item, `It changes ${w.region.startsWith('line:') ? `line ${Number(w.region.slice(5)) + 1} of` : 'the aliases of'} ${q(w.rel)} together with ${title(r.item)}, as one edit.`)); continue; }
          verdict = { hold: o.op === 'tag' ? `${title(r.item)} marks ${q(w.rel)} confidential: ${r.op.value}.` : `${title(r.item)} changes the same ${w.region.startsWith('fm:') ? 'frontmatter' : 'line'} of ${q(w.rel)}.` };
          break;
        }
      }
      if (verdict) break;
      for (const rel of e.removes) {
        const by = removed.get(rel);
        if (by) { verdict = sameOp(by.ops.find((x) => effects(x).removes.includes(rel)) ?? {}, o) ? { skip: `It makes the same change as ${title(by)}.` } : { hold: `${title(by)} already ${removedBy.get(rel) === 'move' ? 'moves' : 'removes'} ${q(rel)}.` }; break; }
        const t = touched.get(rel);
        if (t && t.id !== item.id) {
          if (o.op === 'move') { notes.push(() => mergeNote(t, item, `${title(t)} changes ${q(rel)} first, then this moves it.`)); continue; }
          verdict = { hold: `${title(t)} changes ${q(rel)}, the note this removes. Approve it after this batch.` }; break;
        }
      }
      if (verdict) break;
      for (const rel of e.creates) {
        const by = created.get(rel);
        if (by) { verdict = { skip: `${title(by)} already writes ${q(rel)}.` }; break; }
        if (removed.has(rel) && removed.get(rel).id !== item.id) { verdict = { hold: `${title(removed.get(rel))} removes ${q(rel)} in this batch. Approve it after this batch.` }; break; }
      }
      if (verdict) break;
    }
    if (!verdict && dupOps.size === item.ops.length) verdict = { skip: 'Every change it makes is already in the batch.' };
    if (verdict?.skip) { skip(verdict.skip); continue; }
    if (verdict?.hold) { hold(verdict.hold); continue; }
    for (const n of notes) n();
    ok.push(item);
    if (tkey) targets.set(tkey, item);
    for (const o of item.ops) {
      if (dupOps.has(o)) continue;
      const e = effects(o);
      for (const w of e.writes) {
        touched.set(w.rel, item);
        if (w.region === 'all') whole.set(w.rel, item);
        if (!regions.has(`${w.rel}|${w.region}`)) regions.set(`${w.rel}|${w.region}`, { item, op: o });
      }
      for (const rel of e.removes) { removed.set(rel, item); removedBy.set(rel, o.op === 'move' ? 'move' : 'trash'); }
      for (const rel of e.creates) { created.set(rel, item); if (o.op === 'move') moved.set(item.id + rel, true); }
    }
    item._dup = dupOps;
  }

  // the steps in phases; an item's own changes keep their order inside a phase
  const steps = [];
  ok.forEach((item, at) => item.ops.forEach((o, n) => { if (!item._dup?.has(o)) steps.push({ item: item.id, op: o, phase: PHASE[o.op] ?? 9, at, n }); }));
  steps.sort((a, b) => a.phase - b.phase || a.at - b.at || a.n - b.n);
  for (const item of ok) delete item._dup;

  const byGroup = new Map();
  for (const item of ok) {
    const g = groupOf(item);
    const e = byGroup.get(g) ?? byGroup.set(g, { id: g, count: 0, past: true, items: [] }).get(g);
    e.count += countOf(item, g);
    e.past &&= item.kind === 'pastfix';
    e.items.push({ id: item.id, title: item.title ?? item.target ?? item.id, kind: item.kind, notes: notesOf(item), autoFix: !!item.autoFix, reviewOnly: !!item.reviewOnly });
  }
  const groups = [...byGroup.values()].sort((a, b) => GROUPS[a.id].order - GROUPS[b.id].order).map(({ past, ...g }) => ({ ...g, label: GROUPS[g.id].label(g.count, past) }));
  return { steps: steps.map(({ item, op }) => ({ item, op })), groups, merged, skipped, held, ok: ok.map((i) => i.id) };
}

// Checks that each step's preconditions hold when the steps run in order, from the notes that exist before the batch.
// Answers null, or the first step that would fail and why. The planner's output always passes; main runs it again
// before a batch starts
export function checkOrder(steps, exists) {
  const have = new Set(exists);
  for (const [at, s] of steps.entries()) {
    const o = s.op;
    const e = effects(o);
    const fail = (why) => ({ at, item: s.item, why });
    for (const w of e.writes) if (!have.has(w.rel)) return fail(`${q(w.rel)} is not in the vault at that step`);
    if (e.points && !have.has(e.points)) return fail(`${q(e.points)} is not in the vault at that step`);
    for (const rel of e.removes) { if (!have.has(rel)) return fail(`${q(rel)} is not in the vault at that step`); have.delete(rel); }
    for (const rel of e.creates) { if (have.has(rel)) return fail(`${q(rel)} is already in the vault at that step`); have.add(rel); }
  }
  return null;
}

// a one-line summary of a plan, for a notification or a log line
export function planLine(plan) {
  const parts = plan.groups.map((g) => g.label);
  return parts.length ? parts.join(', ') : 'Nothing to change';
}
