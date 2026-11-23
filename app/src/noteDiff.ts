// What an update changed in a note, line by line and word by word, for the Memory tab's After view (Markdown.tsx diff).
// A line edited in place is one row with its removed and added words; a line with no earlier wording close to it is an
// added row, and one that is gone is a removed row.
import { seqOps } from '../memoryReview.js';
import { inlineRe, mdLine } from './mdLine';

export type DiffSeg = { kind: 'same' | 'add' | 'del'; text: string };
// line: the markdown line the row is drawn from. segs: the text of the row in order; a row with nothing changed has none
export type DiffRow = { line: string; segs: DiffSeg[] | null };
// hunks: the rows of each change, in order, for the arrows. Rows next to each other, or with only blank lines between, are one
export type NoteDiff = { rows: DiffRow[]; hunks: number[][] };

const ALIKE = 0.4;
const MAX_PAIRS = 2500;
const MAX_WORD_CELLS = 250000;

const words = (text: string) => text.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
// words, spaces and single marks; a bold run, code, link or wiki link is one piece
export function tokens(text: string): string[] {
  const out: string[] = [];
  let last = 0;
  for (const m of text.matchAll(inlineRe())) {
    out.push(...words(text.slice(last, m.index)), m[0]);
    last = m.index + m[0].length;
  }
  return [...out, ...words(text.slice(last))];
}

// the changed words of a line: what went, then what came. A space between two changed words goes with them
export function wordDiff(a: string, b: string): DiffSeg[] {
  const x = tokens(a), y = tokens(b);
  const ops = seqOps(x, y, MAX_WORD_CELLS);
  const out: DiffSeg[] = [];
  const push = (kind: DiffSeg['kind'], text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last?.kind === kind) last.text += text; else out.push({ kind, text });
  };
  let del = '', add = '';
  const flush = () => {
    if (del.trim() && !add.trim()) { push('del', del); push('same', add); }
    else if (add.trim() && !del.trim()) push('add', add);
    else if (!del.trim() && !add.trim()) push('same', add);
    else { push('del', del); push('add', add); }
    del = ''; add = '';
  };
  ops.forEach((o, k) => {
    if (o.op === '-') { del += x[o.i]; return; }
    if (o.op === '+') { add += y[o.j]; return; }
    const open = !!(del || add);
    if (open && !y[o.j].trim() && ops[k + 1] && ops[k + 1].op !== ' ') { del += x[o.i]; add += y[o.j]; return; }
    flush();
    push('same', y[o.j]);
  });
  flush();
  return out;
}

// how much of two lines is the same, 0 to 1, by the length of the words they share
export function alike(a: string, b: string): number {
  const x = tokens(a).filter((t) => t.trim()), y = tokens(b).filter((t) => t.trim());
  const size = (l: string[]) => l.reduce((n, t) => n + t.length, 0);
  const most = Math.max(size(x), size(y));
  if (!most) return 1;
  return seqOps(x, y, MAX_WORD_CELLS).reduce((n, o) => n + (o.op === ' ' ? x[o.i].length : 0), 0) / most;
}

const blank = (l: string) => !l.trim();
const tidy = (l: string) => { const m = mdLine(l); return { key: `${m.kind}${m.level}`, text: m.text.trimEnd() }; };

// the rows of one run of removed and added lines. Each added line is matched with the next removed line that reads
// much the same; between two matches the removed lines come first
function hunkRows(dels: string[], adds: string[]): DiffRow[] {
  const d = dels.filter((l) => !blank(l));
  const pairs: [number, number][] = [];
  if (d.length * adds.length <= MAX_PAIRS) {
    let from = 0;
    adds.forEach((line, j) => {
      if (blank(line)) return;
      const b = tidy(line);
      for (let i = from; i < d.length; i++) {
        const a = tidy(d[i]);
        if (a.key === b.key && alike(a.text, b.text) >= ALIKE) { pairs.push([i, j]); from = i + 1; return; }
      }
    });
  }
  const rows: DiffRow[] = [];
  let i = 0, j = 0;
  const until = (di: number, aj: number) => {
    for (; i < di; i++) rows.push({ line: d[i], segs: [{ kind: 'del', text: tidy(d[i]).text }] });
    for (; j < aj; j++) rows.push({ line: adds[j], segs: blank(adds[j]) ? null : [{ kind: 'add', text: tidy(adds[j]).text }] });
  };
  for (const [pi, pj] of pairs) {
    until(pi, pj);
    const a = tidy(d[pi]).text, b = tidy(adds[pj]).text;
    // only spaces at the end changed, which nothing shows
    rows.push({ line: adds[pj], segs: a === b ? null : wordDiff(a, b) });
    i++; j++;
  }
  until(d.length, adds.length);
  return rows;
}

export function noteDiff(before: string, after: string): NoteDiff {
  const x = before.split('\n'), y = after.split('\n');
  const rows: DiffRow[] = [];
  let dels: string[] = [], adds: string[] = [];
  const flush = () => { if (dels.length || adds.length) rows.push(...hunkRows(dels, adds)); dels = []; adds = []; };
  for (const o of seqOps(x, y)) {
    if (o.op === '-') dels.push(x[o.i]);
    else if (o.op === '+') adds.push(y[o.j]);
    else { flush(); rows.push({ line: y[o.j], segs: null }); }
  }
  flush();
  const hunks: number[][] = [];
  let open = false;
  rows.forEach((r, k) => {
    if (r.segs) { if (open) hunks[hunks.length - 1].push(k); else hunks.push([k]); open = true; }
    else if (!blank(r.line)) open = false;
  });
  return { rows, hunks };
}
