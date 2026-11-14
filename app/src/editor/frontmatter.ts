// A note's frontmatter as editable rows. Each row keeps the exact text after its `key:` (a quoted string, a plain
// value, or an indented list on the lines below), so writing the rows back gives the same bytes. Frontmatter that does
// not split cleanly into rows (a comment or blank line first, a nested block with no key) opens in the raw view.

export type Prop = { key: string; value: string };
const KEY = /^([A-Za-z0-9_][A-Za-z0-9_ .-]*):(.*)$/;

export function parseProps(raw: string): Prop[] | null {
  if (!raw) return [];
  const fm = raw.replace(/\r\n/g, '\n');
  const m = fm.match(/^---\n([\s\S]*?)\n?---\n?$/);
  if (!m) return null;
  if (!m[1]) return [];
  const rows: Prop[] = [];
  for (const line of m[1].split('\n')) {
    const kv = KEY.exec(line);
    if (kv) rows.push({ key: kv[1], value: kv[2] });
    else if (rows.length && (/^\s/.test(line) || line.startsWith('- '))) rows[rows.length - 1].value += `\n${line}`;
    else return null;
  }
  return rows;
}

// no rows left removes the frontmatter
export const writeProps = (rows: Prop[], eol = '\n'): string => (rows.length ? `---\n${rows.map((r) => `${r.key}:${r.value}`).join('\n')}\n---\n`.replace(/\n/g, eol) : '');
export const eolOf = (text: string) => (/\r\n/.test(text) ? '\r\n' : '\n');

// what is wrong with the rows, or null: every key named, once, YAML-safe (letters, digits, _ . - and inner spaces),
// and not title, which the title field above edits
export function propsProblem(rows: Prop[]): string | null {
  const seen = new Set<string>();
  for (const r of rows) {
    const k = r.key.trim();
    if (!k) return 'Every property needs a name.';
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*(?: [A-Za-z0-9_.-]+)*$/.test(k)) return `"${k}" can only use letters, numbers, spaces, _ . and -.`;
    if (seen.has(k)) return `"${k}" is used twice.`;
    seen.add(k);
  }
  return null;
}
export const titleProblem = (key: string) => (key.trim().toLowerCase() === 'title' ? 'The title is edited in the field above.' : null);

// a name for a new row that no other row uses: key, key2, key3, ...
export function uniqueKey(rows: Prop[], base = 'key'): string {
  const used = new Set(rows.map((r) => r.key));
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}

// what a row's field shows, and the stored text for what was typed: one space after the colon, as YAML writers do
// (an indented list keeps its leading line break)
export const shownValue = (v: string) => v.replace(/^ /, '');
export const storedValue = (typed: string) => (typed === '' || typed.startsWith('\n') ? typed : ` ${typed}`);

// the name a [[link]] writes: the shortest trailing part of the note's path (without .md) that names only that note
export function linkName(rel: string, all: string[]): string {
  const strip = (p: string) => p.replace(/\.md$/i, '');
  const parts = strip(rel).split('/');
  const others = all.map(strip).filter((p) => p !== strip(rel)).map((p) => p.toLowerCase());
  for (let n = 1; n <= parts.length; n++) {
    const tail = parts.slice(-n).join('/');
    const t = tail.toLowerCase();
    if (!others.some((o) => o === t || o.endsWith(`/${t}`))) return tail;
  }
  return strip(rel);
}

// the Properties panel's draft: rows (or raw text when the frontmatter does not split), and the value it was made from
export type Draft = { rows: Prop[] | null; raw: string; base: string };
export const draftOf = (value: string): Draft => ({ rows: parseProps(value), raw: value, base: value });
export const titleIndex = (rows: Prop[]) => rows.findIndex((r) => r.key === 'title');

// a new value from a save: an untouched draft follows it; an edited one keeps its edits and takes the new title row,
// which the title field changes underneath it
export function followSave(d: Draft, value: string): Draft {
  if (d.base === value) return d;
  const clean = d.rows ? writeProps(d.rows, eolOf(d.base)) === d.base : d.raw === d.base;
  if (clean || !d.rows) return draftOf(value);
  const next = parseProps(value);
  const title = next ? next[titleIndex(next)] : undefined;
  if (!title) return { ...d, base: value };
  const at = titleIndex(d.rows);
  const rows = at >= 0 ? d.rows.map((r, i) => (i === at ? title : r)) : [title, ...d.rows];
  return { ...d, rows, base: value };
}
