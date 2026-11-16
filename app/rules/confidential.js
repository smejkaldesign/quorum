// Confidential tag versus folder, driven by the values the vault uses. For each confidential value with five or more
// notes, its home folders are the folders where three or more notes carry it and they make up 60% or more of the
// folder. A note with the value outside every home is flagged, and so is a note with no tag in a folder where 80% or
// more of the notes carry one value. An explicit off value (false, none, no) is the person's choice and never flagged.
// No folder name is built in. These findings never offer an automatic fix: a person decides where the note belongs.
import { ancestors, finding, isOff, plural, quote } from './common.js';

export const rule = { id: 'note.confidential-folder', version: 1, label: 'Confidential tags that do not fit their folder' };
const MIN_VALUE = 5;
const HOME_MIN = 3;
const HOME_SHARE = 0.6;
const STRICT_SHARE = 0.7;

// tags: every note in the vault as { rel, value }, including notes the index leaves out; only the path and the value
export function run({ notes, tags }) {
  const list = tags ?? notes.map((n) => ({ rel: n.rel, value: n.note?.props?.confidential ?? null }));
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
  const out = [];
  const main = (v) => [...homes.get(v)].sort((a, b) => b.count - a.count || b.folder.length - a.folder.length)[0];
  for (const t of list) {
    const v = valueOf(t);
    const up = ancestors(t.rel);
    if (v && homes.has(v)) {
      if (homes.get(v).some((h) => up.includes(h.folder))) continue;
      const m = main(v);
      out.push(finding(rule, {
        key: `outside:${t.rel}`, target: t.rel, notes: [t.rel],
        title: `${quote(t.rel)} is marked ${quote(v)} outside the folders that hold those notes`,
        problem: `Notes marked ${quote(v)} live in ${quote(m.folder)}. This one sits elsewhere, so either the mark or the place is wrong, and rules that follow the folder treat it differently from its tag.`,
        proposal: `Check whether it belongs in ${quote(m.folder)}, or whether it needs a different mark. Quorum does not change it for you.`,
        evidence: [`Marked confidential: ${v}`, `${plural(m.count, 'note')} with that mark are in ${m.folder} (${Math.round(m.share * 100)}% of that folder)`],
        facts: [`v:${v}`], meta: [['Note', t.rel], ['Mark', v]],
      }));
      continue;
    }
    if (v !== null) continue;
    let hit = null;
    for (const [hv, hs] of homes) for (const h of hs) if (h.share >= STRICT_SHARE && up.includes(h.folder) && (!hit || h.folder.length > hit.folder.length)) hit = { ...h, value: hv };
    if (!hit) continue;
    out.push(finding(rule, {
      key: `untagged:${t.rel}`, target: t.rel, notes: [t.rel],
      title: `${quote(t.rel)} has no confidential mark in a folder where most notes are ${quote(hit.value)}`,
      problem: `${Math.round(hit.share * 100)}% of the notes in ${quote(hit.folder)} are marked ${quote(hit.value)}. This one has no mark, so tools that keep those notes private read it as open.`,
      proposal: `Add confidential: ${hit.value} if it holds the same kind of material, or move it out of ${quote(hit.folder)}. Quorum does not change it for you.`,
      evidence: [`No confidential mark`, `${plural(hit.count, 'note')} in ${hit.folder} are marked ${hit.value}`],
      facts: [`home:${hit.value}`], meta: [['Note', t.rel], ['Folder', hit.folder]],
    }));
  }
  return out;
}
