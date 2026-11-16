// Confidential tag versus folder, driven by the values the vault uses. For each confidential value with five or more
// notes, its home folders are the folders where three or more notes carry it and they make up 60% or more of the
// folder. A note with the value outside every home is flagged, and so is a note with no tag in a folder where 80% or
// more of the notes carry one value. An explicit off value (false, none, no) is the person's choice and never flagged.
// No folder name is built in.
//
// A person can also mark a folder confidential (Quorum keeps the mark in its own settings, never in the vault). Every
// note inside a marked folder counts as confidential for the read guard, the guardrails and this rule, and the folder
// is a home for its value.
//
// The fixes each finding offers, all review items the batch planner runs:
//   tag       a note with no tag inside a marked folder: add the tag. autoFix: the mark says what the tag is. An
//             untagged note in a folder where most notes carry a value gets the same fix, approved by a person
//   move      a note with a value outside every home of that value: move it to the value's main home
//   move-tag  a note with no tag outside the homes whose links mostly go to notes with one value (three or more links
//             and 60% or more of the notes it links or embeds): move it to the value's main home and tag it
// Moving a note updates the links that point at it. Nothing moves until a person approves it.
import { ancestors, baseOf, ENTRY_NAME, finding, isOff, plural, quote, skipped } from './common.js';

export const rule = { id: 'note.confidential-folder', version: 2, label: 'Confidential tags that do not fit their folder' };
const QUOTE_MIN = 3;
const QUOTE_SHARE = 0.6;
// the mark of the nearest marked folder above a note, or null. folders: { [folder rel]: value }
export function folderMarkOf(rel, folders = {}) {
  for (const d of ancestors(rel)) if (folders[d] != null && !isOff(folders[d])) return { folder: d, value: String(folders[d]).trim().toLowerCase() };
  return null;
}
const MIN_VALUE = 5;
const HOME_MIN = 3;
const HOME_SHARE = 0.6;
const STRICT_SHARE = 0.7;

// tags: every note in the vault as { rel, value }, including notes the index leaves out; only the path and the value
export function run({ notes = [], tags, folders = {}, resolve = null }) {
  const list = tags ?? notes.map((n) => ({ rel: n.rel, value: n.note?.props?.confidential ?? null }));
  const all = new Set(list.map((t) => t.rel));
  const valueOf = (t) => (t.value == null ? null : isOff(t.value) ? false : String(Array.isArray(t.value) ? t.value[0] : t.value).trim().toLowerCase());
  const total = new Map();
  const byValue = new Map();
  for (const t of list) {
    const v = valueOf(t);
    for (const d of ancestors(t.rel)) {
      total.set(d, (total.get(d) ?? 0) + 1);
      if (v) { const m = byValue.get(v) ?? byValue.set(v, new Map()).get(v); m.set(d, (m.get(d) ?? 0) + 1); }
    }
  }
  const counts = new Map();
  for (const t of list) { const v = valueOf(t); if (v) counts.set(v, (counts.get(v) ?? 0) + 1); }
  const homes = new Map();
  for (const [v, n] of counts) {
    if (n < MIN_VALUE) continue;
    const h = [];
    for (const [d, c] of byValue.get(v) ?? []) if (c >= HOME_MIN && c / total.get(d) >= HOME_SHARE) h.push({ folder: d, count: c, share: c / total.get(d) });
    if (h.length) homes.set(v, h);
  }
  // a marked folder is a home of its value, whatever its notes say
  for (const [d, raw] of Object.entries(folders ?? {})) {
    if (raw == null || isOff(raw)) continue;
    const v = String(raw).trim().toLowerCase();
    const h = homes.get(v) ?? homes.set(v, []).get(v);
    if (!h.some((x) => x.folder === d)) h.push({ folder: d, count: byValue.get(v)?.get(d) ?? 0, share: 1, marked: true });
  }
  const out = [];
  const main = (v) => [...homes.get(v)].sort((a, b) => (b.marked ? 1 : 0) - (a.marked ? 1 : 0) || b.count - a.count || b.folder.length - a.folder.length)[0];
  // the path a note moves to in a folder, or null when a note already has that path
  const into = (rel, folder) => { const to = `${folder}/${rel.split('/').pop()}`; return all.has(to) ? null : to; };
  const byRel = new Map(notes.map((n) => [n.rel, n]));
  const tagOf = new Map(list.map((t) => [t.rel, valueOf(t)]));
  for (const t of list) {
    const v = valueOf(t);
    const up = ancestors(t.rel);
    const mark = folderMarkOf(t.rel, folders);
    if (mark && v === null) {
      out.push(finding(rule, {
        key: `folder:${t.rel}`, target: t.rel, notes: [t.rel],
        title: `${quote(t.rel)} has no confidential tag in a folder marked ${quote(mark.value)}`,
        problem: `You marked ${quote(mark.folder)} confidential: ${mark.value}. Quorum keeps every note in it private, but tools outside Quorum read only the tag in the note, so they treat this one as open.`,
        proposal: `Add the confidential tag: confidential: ${mark.value}.`,
        evidence: [`No confidential tag`, `${mark.folder} is marked confidential: ${mark.value}`],
        facts: [`mark:${mark.folder}:${mark.value}`], meta: [['Note', t.rel], ['Folder', mark.folder]],
        fix: { kind: 'tag', value: mark.value }, autoFix: true,
      }));
      continue;
    }
    if (mark) continue;
    if (v && homes.has(v)) {
      if (homes.get(v).some((h) => up.includes(h.folder))) continue;
      const m = main(v);
      const to = into(t.rel, m.folder);
      out.push(finding(rule, {
        key: `outside:${t.rel}`, target: t.rel, notes: [t.rel],
        title: `${quote(t.rel)} is marked ${quote(v)} outside the folders that hold those notes`,
        problem: `Notes marked ${quote(v)} live in ${quote(m.folder)}. This one sits elsewhere, so either the mark or the place is wrong, and rules that follow the folder treat it differently from its tag.`,
        proposal: to ? `Move it to ${quote(m.folder)}. Links to it are updated. If the mark is wrong instead, change the mark and archive this.` : `Check whether it belongs in ${quote(m.folder)}. A note with the same name is already there, so Quorum offers no move.`,
        evidence: [`Marked confidential: ${v}`, m.marked ? `${m.folder} is marked confidential: ${v}` : `${plural(m.count, 'note')} with that mark are in ${m.folder} (${Math.round(m.share * 100)}% of that folder)`],
        facts: [`v:${v}`], meta: [['Note', t.rel], ['Mark', v]],
        ...(to ? { fix: { kind: 'move', to } } : {}),
      }));
      continue;
    }
    if (v === null && resolve && homes.size) {
      const n = byRel.get(t.rel);
      if (n && !skipped(n) && !ENTRY_NAME.test(baseOf(t.rel))) {
        const linked = new Set();
        for (const l of n.note?.links ?? []) { const r = resolve(l.target, t.rel); if (r && r !== t.rel) linked.add(r); }
        const counts = new Map();
        for (const r of linked) { const lv = tagOf.get(r) ?? folderMarkOf(r, folders)?.value ?? null; if (lv) counts.set(lv, (counts.get(lv) ?? 0) + 1); }
        const top = [...counts].filter(([lv]) => homes.has(lv)).sort((a, b) => b[1] - a[1])[0];
        if (top && top[1] >= QUOTE_MIN && top[1] / linked.size >= QUOTE_SHARE) {
          const [lv, c] = top;
          const m = main(lv);
          const to = into(t.rel, m.folder);
          out.push(finding(rule, {
            key: `quotes:${t.rel}`, target: t.rel, notes: [t.rel],
            title: `${quote(t.rel)} draws on notes marked ${quote(lv)} from outside their folder`,
            problem: `${plural(c, 'note')} it links to or embeds ${c === 1 ? 'is' : 'are'} marked ${quote(lv)}, out of ${linked.size}. It has no mark and sits outside ${quote(m.folder)}, so tools that keep those notes private read what it repeats from them.`,
            proposal: to ? `Move it to ${quote(m.folder)} and tag it confidential: ${lv}. Links to it are updated.` : `Tag it confidential: ${lv}. A note with the same name is already in ${quote(m.folder)}, so Quorum offers no move.`,
            evidence: [`No confidential tag`, `${plural(c, 'linked note')} of ${linked.size} are marked ${lv}`],
            facts: [`quotes:${lv}:${c}`], meta: [['Note', t.rel], ['Mark', lv]],
            fix: to ? { kind: 'move-tag', to, value: lv } : { kind: 'tag', value: lv },
          }));
          continue;
        }
      }
    }
    if (v !== null) continue;
    let hit = null;
    for (const [hv, hs] of homes) for (const h of hs) if (h.share >= STRICT_SHARE && up.includes(h.folder) && (!hit || h.folder.length > hit.folder.length)) hit = { ...h, value: hv };
    if (!hit) continue;
    out.push(finding(rule, {
      key: `untagged:${t.rel}`, target: t.rel, notes: [t.rel],
      title: `${quote(t.rel)} has no confidential mark in a folder where most notes are ${quote(hit.value)}`,
      problem: `${Math.round(hit.share * 100)}% of the notes in ${quote(hit.folder)} are marked ${quote(hit.value)}. This one has no mark, so tools that keep those notes private read it as open.`,
      proposal: `Add the confidential tag: confidential: ${hit.value}. If it is not that kind of material, move it out of ${quote(hit.folder)} and archive this.`,
      evidence: [`No confidential mark`, `${plural(hit.count, 'note')} in ${hit.folder} are marked ${hit.value}`],
      facts: [`home:${hit.value}`], meta: [['Note', t.rel], ['Folder', hit.folder]],
      fix: { kind: 'tag', value: hit.value },
    }));
  }
  return out;
}
