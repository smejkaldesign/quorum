// How a synced file becomes a KB note, the same way the app writes one in app/ee/kbImport.js and app/ee/kbDrive.js:
// shared (visibility public), kb_source naming the file, the confidential rule the database applies (note_shared,
// 0024), file names a path can hold, and one source line under the frontmatter. The relay is its own package, so the
// few functions it needs are kept here; app/test/kb-sync-rules.test.js checks they give the app's results.
import { createHash } from 'node:crypto';

export const sha256 = (t) => createHash('sha256').update(t).digest('hex');
export const fmValue = (v) => { const s = String(v).replace(/[\r\n]+/g, ' ').trim(); return /^[\w./@~+-][\w ./:@~+%=-]*$/.test(s) && !/:\s/.test(s) ? s : `"${s.replace(/"/g, "'")}"`; };
export const safeSeg = (s) => String(s ?? '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Knowledge base';
export const keyOf = (segs) => segs.map((s) => s.trim().toLowerCase()).join('/');
export const noteFileName = (name) => `${safeSeg(String(name ?? '').replace(/\.(md|markdown|txt)$/i, '')).replace(/^Knowledge base$/, 'Untitled')}.md`;

const eolOf = (text) => (/\r\n/.test(String(text)) ? '\r\n' : '\n');

// one key set to a value already written as YAML, every other byte kept (app/frontmatter.js)
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

// the frontmatter keys as the app's pull and push read them (app/ee/sync.js parseFrontmatter)
export function parseFrontmatter(text) {
  const m = String(text).replace(/\r\n?/g, '\n').match(/^---\n([\s\S]*?)\n---/);
  const fm = {};
  if (!m) return fm;
  let list = null;
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) { list = kv[2] === '' ? (fm[kv[1]] = []) : null; if (!list) fm[kv[1]] = kv[2].replace(/^"(.*)"$/, "$1"); }
    else if (list && /^\s+-\s+/.test(line)) list.push(line.replace(/^\s+-\s+/, '').replace(/^"(.*)"$/, '$1'));
  }
  return fm;
}

export function sharedText(text, sourceLine) {
  const body = String(text).replace(/\r\n?/g, '\n');
  return setFrontmatterKey(setFrontmatterKey(body, 'visibility', 'public'), 'kb_source', fmValue(sourceLine));
}

const NOT_CONFIDENTIAL = /^(false|no|0|off)?$/i;
export const isConfidential = (fm) => { const v = fm?.confidential; return v !== undefined && v !== null && v !== false && !NOT_CONFIDENTIAL.test(String(v).trim()); };
export function dropFalseConfidential(text) {
  const m = String(text).match(/^---\n([\s\S]*?)\n---/);
  if (!m) return text;
  const lines = m[1].split('\n');
  const kept = lines.filter((l) => { const kv = l.match(/^confidential:\s*(.*?)\s*$/); return !kv || !NOT_CONFIDENTIAL.test(kv[1].replace(/^["']|["']$/g, '')); });
  return kept.length === lines.length ? text : `---\n${kept.join('\n')}\n---${text.slice(m[0].length)}`;
}

// the note's text for one synced file: shared, kb_source, the attachment it belongs to, a link to the file, the sync
// time and the provider's change marker, a title when the file has none, and the source line kbDrive writes
export function syncedNoteText({ text, source, attachmentId, name, url, syncedAt, modified, sha, where }) {
  let out = sharedText(text, source);
  out = setFrontmatterKey(out, 'kb_attachment', fmValue(attachmentId));
  if (url) out = setFrontmatterKey(out, 'kb_source_url', fmValue(url));
  out = setFrontmatterKey(out, 'kb_synced_at', fmValue(syncedAt));
  if (modified) out = setFrontmatterKey(out, 'kb_source_modified', fmValue(modified));
  if (sha) out = setFrontmatterKey(out, 'kb_source_sha', fmValue(sha));
  if (!parseFrontmatter(out).title) out = setFrontmatterKey(out, 'title', fmValue(String(name).replace(/\.(md|markdown|txt)$/i, '')));
  const m = out.match(/^---\n[\s\S]*?\n---\n?/);
  const head = m ? m[0].replace(/\n?$/, '\n') : '';
  const label = String(name).replace(/[[\]]/g, '');
  const line = url ? `> Source: [${label}](${url}) in ${where}.` : `> Source: ${label} in ${where}.`;
  return dropFalseConfidential(`${head}${line}\n\n${out.slice(m ? m[0].length : 0).replace(/^\n+/, '')}`);
}
