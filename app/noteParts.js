// A saved note in two parts for the reader: what you wrote (Note) and what Quorum or a notetaker wrote (Summary). A
// recorded note keeps yours under "## Private notes" and the rest under "## Summary"; a hand note is all yours; an
// imported note is all summary. Read from the body before the reader drops those headings. Pure.
export function noteParts(body, hand) {
  const b = String(body ?? '').trim();
  const head = b.match(/^## Private notes[ \t]*\n/);
  if (head) {
    const rest = b.slice(head[0].length);
    const sum = rest.match(/^## Summary[ \t]*$/m);
    const mine = (sum ? rest.slice(0, sum.index) : rest).trim();
    return { note: mine === 'None' ? '' : mine, summary: sum ? rest.slice(sum.index + sum[0].length).trim() : '', split: true };
  }
  return hand ? { note: b, summary: '', split: false } : { note: '', summary: b, split: false };
}

// the two parts written back the way they were read: split notes keep both headings; a single part stays bare
export function joinParts(note, summary, was) {
  const n = String(note ?? '').trim(), s = String(summary ?? '').trim();
  if (was.split || (n && s)) return `## Private notes\n${n || 'None'}\n\n## Summary\n${s}`;
  return n || s;
}
