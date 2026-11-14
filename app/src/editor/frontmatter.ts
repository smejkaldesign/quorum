// A note's frontmatter as editable rows. Each row keeps the exact text after its `key:` (a quoted string, a plain
// value, or an indented list on the lines below), so writing the rows back gives the same bytes. Frontmatter that does
// not split cleanly into rows (a comment or blank line first, a nested block with no key) opens in the raw view.

export type Prop = { key: string; value: string };
const KEY = /^([A-Za-z0-9_][A-Za-z0-9_ .-]*):(.*)$/;

export function parseProps(fm: string): Prop[] | null {
  if (!fm) return [];
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
export const writeProps = (rows: Prop[]): string => (rows.length ? `---\n${rows.map((r) => `${r.key}:${r.value}`).join('\n')}\n---\n` : '');

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
