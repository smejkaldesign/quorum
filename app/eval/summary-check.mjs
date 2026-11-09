#!/usr/bin/env node
// Faithfulness stub for notes. A note is { sections: [{ bullets: [{ text, refs: [turnId] }] }] }; turns are
// [{ id, text }]. A bullet is "linked" when every ref names an existing turn, and "grounded" when each key number and
// each capitalized name in the bullet appears in the text of its referenced turns. Both come back as fractions.
// Usage: node summary-check.mjs <note.json> <turns.json>
import { readFileSync } from 'node:fs';
import { normalize } from './normalize.mjs';

const STOP = new Set(['the', 'a', 'an', 'we', 'they', 'he', 'she', 'it', 'i', 'and', 'or', 'but', 'on', 'in', 'at', 'to', 'for', 'of', 'by', 'with', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'q1', 'q2', 'q3', 'q4']);

// numbers as the normalizer writes them (digits, money, percent), and names as capitalized words past the first token
export function keyFacts(text) {
  const numbers = normalize(text).split(' ').filter((t) => /^\d[\d.]*$/.test(t));
  const names = text.split(/\s+/).slice(1).map((w) => w.replace(/[^A-Za-z'-]/g, '')).filter((w) => /^[A-Z][a-z]/.test(w) && !STOP.has(w.toLowerCase()));
  return { numbers: [...new Set(numbers)], names: [...new Set(names.map((n) => normalize(n)))] };
}

export function check(note, turns) {
  const byId = new Map(turns.map((t) => [t.id, t]));
  const bullets = (note.sections ?? []).flatMap((s) => s.bullets ?? []);
  let linked = 0, grounded = 0;
  const problems = [];
  for (const b of bullets) {
    const refs = b.refs ?? [];
    const missing = refs.filter((id) => !byId.has(id));
    if (refs.length && !missing.length) linked++;
    const source = ` ${normalize(refs.map((id) => byId.get(id)?.text ?? '').join(' '))} `;
    const facts = keyFacts(b.text);
    const lost = [...facts.numbers, ...facts.names].filter((f) => !source.includes(` ${f} `));
    if (refs.length && !missing.length && !lost.length) grounded++;
    if (missing.length || lost.length) problems.push({ text: b.text, missingRefs: missing, unsupported: lost });
  }
  const n = bullets.length || 1;
  return { bullets: bullets.length, linked: linked / n, grounded: grounded / n, problems };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const [noteFile, turnsFile] = process.argv.slice(2);
  if (!noteFile || !turnsFile) { console.error('usage: summary-check.mjs <note.json> <turns.json>'); process.exit(2); }
  const result = check(JSON.parse(readFileSync(noteFile, 'utf8')), JSON.parse(readFileSync(turnsFile, 'utf8')));
  console.log(JSON.stringify(result, null, 2));
}
