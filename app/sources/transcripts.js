// Transcripts are an extra a source can provide beyond its notes. They are long, so each lives in a transcripts/
// subfolder next to the notes (History lists only a folder's top level) and the note links its own with a
// `transcript:` frontmatter line. When the source says for good that a meeting has no transcript, the note gets
// `transcript: none` so the next sync does not ask again.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const SUBFOLDER = 'transcripts';
const ID_LINE = /^(?:granola_id|source_id):\s*"?([^"\n]+)"?\s*$/m;
const head = (text) => text.slice(0, 4000);
const field = (text, key) => { const m = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(head(text)); if (!m) return null; const v = m[1].trim(); try { return JSON.parse(v); } catch { return v.replace(/^"|"$/g, ''); } };

// notes in a source folder whose frontmatter has an id and no transcript line yet
export function notesWithout(dir) {
  let names;
  try { names = readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { return []; }
  const out = [];
  for (const f of names) {
    const file = path.join(dir, f);
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    if (!text.startsWith('---')) continue;
    const id = ID_LINE.exec(head(text))?.[1];
    if (!id || /^transcript:\s*\S/m.test(head(text))) continue;
    out.push({ id, file, text });
  }
  return out;
}

export const countTranscripts = (dir) => { try { return readdirSync(path.join(dir, SUBFOLDER)).filter((f) => f.endsWith('.md')).length; } catch { return 0; } };

export function transcriptMarkdown({ id, title, date, source, recorder }, text) {
  return [
    '---',
    `type: transcript`,
    `transcript_of: ${id}`,
    `title: ${JSON.stringify(`${title || 'Untitled meeting'} (transcript)`)}`,
    ...(date ? [`date: ${date}`] : []),
    `source: ${source}`,
    ...(recorder ? [`recorder: ${JSON.stringify(recorder)}`] : []),
    'visibility: private',
    '---',
    '',
    `# ${title || 'Untitled meeting'} · Transcript`,
    '',
    text.trim(),
    '',
  ].join('\n');
}

// adds `transcript: <value>` to a note's frontmatter
export function linkNote(file, text, value) {
  const end = text.indexOf('\n---', 3);
  if (end < 0) return false;
  writeFileSync(file, `${text.slice(0, end)}\ntranscript: ${value}${text.slice(end)}`);
  return true;
}

export async function syncTranscripts({ adapter, mcp, dir, source, progress = () => {}, afterWrite = () => {} }) {
  const todo = notesWithout(dir);
  const failed = [];
  let done = 0, saved = 0;
  progress({ phase: 'transcripts', phaseStartedAt: Date.now(), total: todo.length, done: 0, message: todo.length ? `Fetching ${todo.length} ${todo.length === 1 ? 'transcript' : 'transcripts'}` : 'Transcripts are up to date' });
  for (const n of todo) {
    const title = field(n.text, 'title');
    try {
      const r = await adapter.transcript(mcp, n.id);
      if (r.text) {
        const name = path.basename(n.file);
        mkdirSync(path.join(dir, SUBFOLDER), { recursive: true });
        const out = path.join(dir, SUBFOLDER, name);
        writeFileSync(out, transcriptMarkdown({ id: n.id, title, date: field(n.text, 'date'), source, recorder: r.recorder }, r.text));
        afterWrite(out);
        linkNote(n.file, n.text, `${SUBFOLDER}/${name}`);
        afterWrite(n.file);
        saved += 1;
      } else if (r.unavailable === 'final') {
        linkNote(n.file, n.text, 'none');
        afterWrite(n.file);
      }
    } catch (err) { failed.push({ id: n.id, title: title ?? '', error: err.message }); }
    done += 1;
    progress({ done, message: `Saved ${saved} of ${todo.length} ${todo.length === 1 ? 'transcript' : 'transcripts'}` });
  }
  return { checked: todo.length, saved, failed };
}
