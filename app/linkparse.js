// One parser for every view: graph, backlinks, search, rename. Follows Obsidian's link rules so links resolve
// the same way here as they did there.
import path from 'node:path';

const LINK_RE = /(!?)\[\[([^\]|#\n]*)(#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]|(!?)\[([^\]\n]*)\]\(([^)\s]+?)(#[^)\s]*)?\)/g;
const TAG_RE = /(^|[\s(])#([A-Za-z][\w/-]*)/g;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE_RE = /^(```|~~~)/;

// frontmatter as flat key -> string | string[]; enough for title, aliases, tags, date and the properties panel
export function parseFrontmatter(text) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return { props: {}, end: 0 };
  const close = text.indexOf('\n---', 3);
  if (close < 0) return { props: {}, end: 0 };
  const props = {};
  let key = null;
  for (const line of text.slice(4, close).split('\n')) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && key) { props[key] = [...(Array.isArray(props[key]) ? props[key] : []), unquote(item[1])]; continue; }
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    key = kv[1];
    const v = kv[2].trim();
    props[key] = v.startsWith('[') && v.endsWith(']') ? v.slice(1, -1).split(',').map((x) => unquote(x.trim())).filter(Boolean) : v === '' ? [] : unquote(v);
  }
  const after = text.indexOf('\n', close + 1);
  return { props, end: after < 0 ? text.length : after + 1 };
}

const unquote = (v) => v.replace(/^["']|["']$/g, '');
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);

export function parseNote(rel, text) {
  const { props, end } = parseFrontmatter(text);
  const links = [];
  const tags = new Set(list(props.tags).map((t) => String(t).replace(/^#/, '').toLowerCase()));
  const headings = [];
  const lines = text.slice(end).split('\n');
  const offset = text.slice(0, end).split('\n').length - 1;
  let fenced = false;
  lines.forEach((line, i) => {
    if (FENCE_RE.test(line.trim())) { fenced = !fenced; return; }
    if (fenced) return;
    const h = line.match(HEADING_RE);
    if (h) headings.push({ level: h[1].length, text: h[2], line: i + offset });
    // `[[example]]` inside inline code is syntax being shown, not a link
    const prose = line.replace(/`[^`]*`/g, (c) => ' '.repeat(c.length));
    for (const m of prose.matchAll(LINK_RE)) {
      if (m[2] !== undefined) {
        links.push({ embed: m[1] === '!', target: m[2].trim(), anchor: (m[3] ?? '').slice(1), display: m[4] ?? null, kind: 'wiki', line: i + offset, raw: m[0] });
      } else {
        const href = m[7];
        if (/^[a-z][\w+.-]*:/i.test(href)) continue; // urls, obsidian://, mailto
        let target;
        try { target = decodeURIComponent(href); } catch { target = href; }
        if (!/\.md$/i.test(target)) continue;
        links.push({ embed: m[5] === '!', target, anchor: (m[8] ?? '').slice(1), display: m[6], kind: 'md', line: i + offset, raw: m[0] });
      }
    }
    for (const m of prose.matchAll(TAG_RE)) tags.add(m[2].toLowerCase());
  });
  const title = (typeof props.title === 'string' && props.title) || headings.find((h) => h.level === 1)?.text || path.basename(rel, '.md');
  return { title, props, aliases: list(props.aliases).map(String), tags: [...tags], headings, links, bodyStart: end };
}

// Obsidian's resolution: relative to the linking note, then the exact vault path, then basename (shortest path wins
// when several share it), then aliases. Case-insensitive, .md optional.
export function createResolver(rels, aliasesOf) {
  const byPath = new Map();
  const byBase = new Map();
  const byAlias = new Map();
  for (const rel of rels) {
    const key = rel.replace(/\.md$/i, '').toLowerCase();
    byPath.set(key, rel);
    const base = path.basename(key);
    (byBase.get(base) ?? byBase.set(base, []).get(base)).push(rel);
    for (const a of aliasesOf(rel)) if (!byAlias.has(a.toLowerCase())) byAlias.set(a.toLowerCase(), rel);
  }
  for (const v of byBase.values()) v.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  return (target, fromRel) => {
    const t = target.replace(/\.md$/i, '').replace(/^\.?\//, '').toLowerCase();
    if (!t) return fromRel;
    const rel = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), t));
    if (byPath.has(rel)) return byPath.get(rel);
    if (byPath.has(t)) return byPath.get(t);
    if (t.includes('/')) {
      const hit = [...byPath.entries()].find(([k]) => k.endsWith(`/${t}`));
      if (hit) return hit[1];
    }
    const base = byBase.get(path.posix.basename(t));
    if (base) return base[0];
    return byAlias.get(t) ?? null;
  };
}
