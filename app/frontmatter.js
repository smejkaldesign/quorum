// A note's frontmatter, read and written the same way everywhere (the vault store, the note view, imports). Notes
// with Windows line endings keep them. A double-quoted value is a JSON string (that is how Quorum writes them), a
// single-quoted one is YAML's, anything else is taken as written.

export const eolOf = (text) => (/\r\n/.test(String(text)) ? '\r\n' : '\n');

export function yamlValue(raw) {
  const v = String(raw ?? '').trim();
  if (v.startsWith('"')) { try { return String(JSON.parse(v)); } catch { return v.replace(/^"|"$/g, ''); } }
  if (v.startsWith("'") && v.endsWith("'") && v.length > 1) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

// the frontmatter block at the top of a note, with its closing line, or '' when there is none
export const FRONT = /^---\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/;
export const frontBlock = (text) => String(text ?? '').match(FRONT)?.[0] ?? '';

// the keys a note's frontmatter sets, with participants as a list
export function readFrontmatter(text) {
  const m = String(text ?? '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fm = { participants: [] };
  if (!m) return fm;
  let inList = false;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) {
      inList = kv[1] === 'participants' && !kv[2];
      if (!inList) fm[kv[1]] = yamlValue(kv[2]);
    } else if (inList && /^\s+-\s+/.test(line)) {
      fm.participants.push(line.replace(/^\s+-\s+/, ''));
    }
  }
  return fm;
}

// one key set to a value already written as YAML, every other byte kept; a note without frontmatter gets a block
export function setFrontmatterKey(text, key, value) {
  const src = String(text ?? '');
  const eol = eolOf(src);
  const line = `${key}: ${value}`;
  const m = src.match(/^---\r?\n(?:([\s\S]*?)\r?\n)??---(?=[ \t]*(?:\r?\n|$))/);
  if (!m) return `---${eol}${line}${eol}---${eol}${src}`;
  const block = m[1] ?? '';
  const re = new RegExp(`^${key}:.*?(?=\\r?$)`, 'm');
  const fm = re.test(block) ? block.replace(re, () => line) : block ? `${block}${eol}${line}` : line;
  return `---${eol}${fm}${eol}---${src.slice(m[0].length)}`;
}
