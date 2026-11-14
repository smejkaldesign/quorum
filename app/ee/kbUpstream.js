// Quorum's edits to synced KB notes, kept as suggestions when the source changes (Cloud edition;
// docs/specs/workspace-knowledge.md, "Maintenance" and Decision 5; migration 0031). A note synced from GitHub, a zip or
// Google Drive (frontmatter kb_source) is Quorum's copy of a file in another tool. Quorum's maintenance and the agents
// working in the vault may change that copy; Quorum never writes back to the source tool.
//
// Every sync records the upstream base: the text Quorum last wrote from the source, with its hash, in kb_note_upstream
// (one row per note, read only by the KB's admins). The note counts as edited by Quorum while its text differs from that
// base, apart from the frontmatter keys sync itself moves (VOLATILE). On the next sync (resyncPlan):
//
//   not edited, source changed       the source's text is written, as before
//   edited, source unchanged         Quorum's copy stays as it is; nothing is written
//   edited, source changed           the source's text is written as the note, and Quorum's edit becomes a suggestion,
//                                    merged three ways (old base, Quorum's copy, new source): when every changed block
//                                    of Quorum's edit still applies to the new text, the suggestion is "ready" and holds
//                                    the merged text; otherwise it is "stale" and holds Quorum's text with the old base
//                                    it was made against
//   kept from an earlier sync        a suggestion is merged again against the newer source the same way
//
// IPC API (preload exposes each as window.quorum.<camelName>; registered with ee/knowledgeBases.js):
//
//   kb-suggestion         (noteId) -> { edited, suggestion: Suggestion | null }      admins only; readers get neither
//   kb-suggestion-apply   (noteId) -> { ok, title, body }                            Quorum's copy takes the suggestion
//   kb-suggestion-dismiss (noteId) -> { ok }
//
//   Suggestion  { state: 'ready' | 'stale', at, lines: DiffLine[] }
//   DiffLine    { op: ' ' | '+' | '-' | '~', text }   '~' stands for unchanged lines left out of the view, text counts them
//
// For a ready suggestion the lines go from the note as it is now to the text Apply writes; for a stale one, from the old
// base to Quorum's edit. Apply writes through kb_suggestion_apply, which checks the caller is an admin of the note's KB.
// A database without migration 0031 has no table and no functions: syncing then works as it did before, with no base
// recorded and no suggestion kept.
import { createHash } from 'node:crypto';
import { BOND_KEYS, parseFrontmatter } from './sync.js';

export const UPSTREAM = 'kb_note_upstream';
const PAGE = 1000;
const SAVE_ROWS = 50;
const SAVE_CHARS = 4 * 1024 * 1024;
// a diff with more edits than this is not merged; the suggestion is kept as stale instead
const MAX_EDITS = 2000;
const CONTEXT = 3;
// frontmatter keys a sync or a pull sets on its own; a change to one of them is no edit by Quorum
export const VOLATILE = new Set(['kb_synced_at', 'kb_checked_at', 'kb_source_modified', ...BOND_KEYS]);

const sha256 = (t) => createHash('sha256').update(String(t)).digest('hex');
const lf = (t) => String(t ?? '').replace(/\r\n?/g, '\n');

// the text without the frontmatter lines in VOLATILE
export function stripVolatile(text) {
  const t = lf(text);
  const m = t.match(/^---\n([\s\S]*?)\n---(\n|$)/);
  if (!m) return t;
  const kept = m[1].split('\n').filter((l) => !VOLATILE.has(l.match(/^([A-Za-z0-9_]+):/)?.[1] ?? ''));
  return `---\n${kept.join('\n')}\n---${m[2]}${t.slice(m[0].length)}`;
}
// two texts are the same note when they differ only in VOLATILE keys and trailing white space
export const sameNote = (a, b) => stripVolatile(a).replace(/\s+$/, '') === stripVolatile(b).replace(/\s+$/, '');
const linesOf = (t) => lf(t).replace(/\n$/, '').split('\n');

// the lines a and b share, as [i, j] pairs in order (Myers' diff). null when they differ in more than maxEdits lines
export function commonLines(a, b, maxEdits = MAX_EDITS) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const N = A.length, M = B.length;
  const limit = Math.min(N + M, maxEdits);
  const off = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= limit && found < 0; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= N && y >= M) { found = d; break; }
    }
  }
  if (found < 0) return null;
  const mid = [];
  let x = N, y = M;
  for (let d = found; d >= 0; d--) {
    const w = trace[d];
    const k = x - y;
    const pk = k === -d || (k !== d && w[off + k - 1] < w[off + k + 1]) ? k + 1 : k - 1;
    const px = w[off + pk];
    const py = px - pk;
    while (x > px && y > py) { mid.push([x - 1, y - 1]); x--; y--; }
    if (d > 0) { x = px; y = py; }
  }
  mid.reverse();
  const pairs = [];
  for (let i = 0; i < pre; i++) pairs.push([i, i]);
  for (const [i, j] of mid) pairs.push([i + pre, j + pre]);
  for (let i = 0; i < suf; i++) pairs.push([a.length - suf + i, b.length - suf + i]);
  return pairs;
}

// the changed blocks from a to b: each replaces a[start, end) with lines. null past the edit limit
export function hunks(a, b, maxEdits = MAX_EDITS) {
  const pairs = commonLines(a, b, maxEdits);
  if (!pairs) return null;
  const out = [];
  let i = 0, j = 0;
  for (const [pi, pj] of [...pairs, [a.length, b.length]]) {
    if (pi > i || pj > j) out.push({ start: i, end: pi, lines: b.slice(j, pj) });
    i = pi + 1; j = pj + 1;
  }
  return out;
}

// a three-way merge of lines: what changed from base to ours, put onto theirs. Clean when no block of ours overlaps a
// block of theirs and no two insertions land at the same line (the same change on both sides counts once); blocks that
// only meet at a boundary both apply. The text is then theirs with ours' blocks in it
export function merge3(base, ours, theirs) {
  const b = linesOf(base), o = linesOf(ours), t = linesOf(theirs);
  const ho = hunks(b, o), ht = hunks(b, t);
  if (!ho || !ht) return { clean: false };
  const same = (x, y) => x.start === y.start && x.end === y.end && x.lines.join('\n') === y.lines.join('\n');
  const all = [...ht];
  for (const x of ho) {
    if (ht.some((y) => same(x, y))) continue;
    const clash = (y) => (x.start < y.end && y.start < x.end) || (x.start === x.end && y.start === y.end && x.start === y.start);
    if (ht.some(clash)) return { clean: false };
    all.push(x);
  }
  all.sort((x, y) => x.start - y.start || x.end - y.end);
  const out = [];
  let at = 0;
  for (const h of all) {
    out.push(...b.slice(at, h.start), ...h.lines);
    at = h.end;
  }
  out.push(...b.slice(at));
  return { clean: true, text: `${out.join('\n')}\n` };
}

// what Quorum's edit becomes against a new source text: null when nothing of it is left to suggest
export function suggestionFor({ base, edited, upstream }) {
  const b = stripVolatile(base), e = stripVolatile(edited);
  if (sameNote(e, upstream)) return null;
  const m = merge3(b, e, upstream);
  if (m.clean) return sameNote(m.text, upstream) ? null : { state: 'ready', body: m.text, agent: edited, base };
  return { state: 'stale', body: edited, agent: edited, base };
}

// what a sync does with one note that is already in the KB. base is the upstream row (or null), current the note's text
// now, upstream the source's new text. write says whether the source's text goes into the note; suggestion is what the
// upstream row should hold after the sync (undefined: leave the row's suggestion as it is)
export function resyncPlan({ base, current, upstream }) {
  if (!base) return { write: true, edited: false, suggestion: null };
  const edited = !sameNote(current, base.base_body);
  const pending = base.suggestion_state ? { base: base.suggestion_base, agent: base.suggestion_agent } : null;
  if (sameNote(upstream, base.base_body)) return { write: !edited, edited, suggestion: undefined };
  if (edited) return { write: true, edited, suggestion: suggestionFor({ base: base.base_body, edited: current, upstream }) };
  if (pending?.base != null && pending.agent != null) return { write: true, edited, suggestion: suggestionFor({ base: pending.base, edited: pending.agent, upstream }) };
  return { write: true, edited, suggestion: null };
}

// the row for kb_upstream_save after a note was written from its source
export function upstreamRow(noteId, text, suggestion, kept = null) {
  const s = suggestion === undefined ? (kept?.suggestion_state ? { state: kept.suggestion_state, body: kept.suggestion_body, agent: kept.suggestion_agent, base: kept.suggestion_base } : null) : suggestion;
  return {
    note_id: noteId, base_hash: sha256(text), base_body: text,
    suggestion_state: s?.state ?? null, suggestion_body: s?.body ?? null, suggestion_agent: s?.agent ?? null, suggestion_base: s?.base ?? null,
  };
}

// a line diff for the page, with unchanged runs longer than the context folded into one '~' line
export function diffView(before, after, context = CONTEXT) {
  const a = linesOf(before), b = linesOf(after);
  const pairs = commonLines(a, b);
  const full = [];
  if (!pairs) {
    for (const l of a) full.push({ op: '-', text: l });
    for (const l of b) full.push({ op: '+', text: l });
    return full;
  }
  let i = 0, j = 0;
  for (const [pi, pj] of [...pairs, [a.length, b.length]]) {
    while (i < pi) full.push({ op: '-', text: a[i++] });
    while (j < pj) full.push({ op: '+', text: b[j++] });
    if (pi < a.length) full.push({ op: ' ', text: a[pi] });
    i = pi + 1; j = pj + 1;
  }
  const near = full.map(() => false);
  full.forEach((l, k) => { if (l.op !== ' ') for (let n = Math.max(0, k - context); n <= Math.min(full.length - 1, k + context); n++) near[n] = true; });
  const out = [];
  for (let k = 0; k < full.length;) {
    if (near[k]) { out.push(full[k++]); continue; }
    let n = 0;
    while (k < full.length && !near[k]) { n++; k++; }
    out.push({ op: '~', text: String(n) });
  }
  return out;
}

// a table or function the database does not have yet (migration 0031 not applied)
const missing = (err) => ['42P01', 'PGRST202', 'PGRST205'].includes(err?.code) || (/kb_note_upstream|kb_upstream_save|kb_suggestion_/i.test(String(err?.message)) && /does not exist|could not find/i.test(String(err?.message)));

// reading and writing the upstream rows of one KB during a sync. After one missing-table answer the store stays off
// for the rest of this sync, which then runs as it did before the table existed
export function upstreamStore({ client, ws, log = () => {}, tag = 'kb-upstream' }) {
  let off = false;
  const skip = (err, what) => { if (missing(err)) { off = true; log(tag, `${what}: kb_note_upstream is not in this database yet`); return true; } return false; };
  return {
    get off() { return off; },
    async load(kbId) {
      const out = new Map();
      if (off) return out;
      for (let offset = 0; ; offset += PAGE) {
        const { data, error } = await client().from(UPSTREAM).select('note_id, base_hash, base_body, suggestion_state, suggestion_body, suggestion_agent, suggestion_base')
          .eq('workspace_id', ws()).eq('kb_id', kbId).order('note_id').range(offset, offset + PAGE - 1);
        if (error) { if (skip(error, 'read')) return new Map(); throw error; }
        for (const r of data ?? []) out.set(r.note_id, r);
        if ((data ?? []).length < PAGE) return out;
      }
    },
    // the full text of notes whose hash moved away from their base
    async bodies(ids) {
      const out = new Map();
      for (let i = 0; i < ids.length; i += 100) {
        const { data, error } = await client().from('notes').select('id, body').eq('workspace_id', ws()).in('id', ids.slice(i, i + 100));
        if (error) throw error;
        for (const r of data ?? []) out.set(r.id, String(r.body ?? ''));
      }
      return out;
    },
    // rows go up in batches under a size cap; a failure is logged and the sync goes on, since the notes are written
    async save(kbId, rows) {
      if (off || !rows.length) return 0;
      let saved = 0;
      let batch = [];
      let chars = 0;
      const flush = async () => {
        if (!batch.length || off) return;
        const { data, error } = await client().rpc('kb_upstream_save', { kb_id: kbId, rows: batch });
        batch = []; chars = 0;
        if (error) { if (!skip(error, 'save')) log(tag, 'save', error.message); return; }
        saved += Number(data) || 0;
      };
      for (const r of rows) {
        const size = (r.base_body?.length ?? 0) + (r.suggestion_body?.length ?? 0) + (r.suggestion_agent?.length ?? 0) + (r.suggestion_base?.length ?? 0);
        if (batch.length && (batch.length >= SAVE_ROWS || chars + size > SAVE_CHARS)) await flush();
        batch.push(r); chars += size;
      }
      await flush();
      return saved;
    },
  };
}

// the edited flag and the suggestion for one note, as the page shows them. A note edited again after the suggestion was
// made gets the suggestion merged onto that edit, so Apply never drops it; when the two cannot merge Apply is refused
const NOT_THERE = 'That suggestion is no longer there. Open the note again.';
function effective(note, row) {
  if (row.suggestion_state !== 'ready') return null;
  if (sameNote(note.body, row.base_body)) return { text: row.suggestion_body };
  const m = merge3(stripVolatile(row.base_body), stripVolatile(note.body), row.suggestion_body);
  return m.clean ? { text: m.text } : { error: 'This note changed after the suggestion was made. Sync the source again to refresh the suggestion.' };
}
const shown = (text) => {
  const body = lf(text).replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  const h1 = body.match(/^#\s+(.+)$/m);
  return { title: h1 ? h1[1].trim() : null, body: h1 && body.startsWith(h1[0]) ? body.slice(h1[0].length).trim() : body };
};

export function createKbSuggestions({ account, ws, rpc, call }) {
  const read = async (noteId) => {
    if (!noteId || typeof noteId !== 'string') throw Object.assign(new Error('Pick the note first.'), { code: 'P0001' });
    const c = account.client();
    const [n, u] = await Promise.all([
      c.from('notes').select('id, kb_id, body, frontmatter').eq('workspace_id', ws()).eq('id', noteId).is('deleted_at', null).limit(1),
      c.from(UPSTREAM).select('note_id, base_body, suggestion_state, suggestion_body, suggestion_agent, suggestion_base, suggested_at').eq('note_id', noteId).limit(1),
    ]);
    if (n.error) throw n.error;
    // readers are not shown the table at all; an older database has no table
    if (u.error) { if (missing(u.error)) return { note: n.data?.[0] ?? null, row: null }; throw u.error; }
    return { note: n.data?.[0] ?? null, row: u.data?.[0] ?? null };
  };
  return {
    'kb-suggestion': call(false, 'The suggestion could not be read.', async (noteId) => {
      const { note, row } = await read(noteId);
      if (!note || !row || !note.kb_id) return { edited: false, suggestion: null };
      const edited = !sameNote(note.body, row.base_body);
      if (!row.suggestion_state) return { edited, suggestion: null };
      const eff = effective(note, row);
      const lines = row.suggestion_state === 'ready'
        ? (eff?.text != null ? diffView(stripVolatile(note.body), stripVolatile(eff.text)) : diffView(stripVolatile(row.base_body), stripVolatile(row.suggestion_body)))
        : diffView(stripVolatile(row.suggestion_base), stripVolatile(row.suggestion_agent));
      return { edited, suggestion: { state: row.suggestion_state, at: row.suggested_at ?? null, lines, ...(eff?.error ? { blocked: eff.error } : {}) } };
    }),
    'kb-suggestion-apply': call(false, 'The suggestion could not be applied.', async (noteId) => {
      const { note, row } = await read(noteId);
      if (!note || !row?.suggestion_state) return { error: NOT_THERE };
      if (row.suggestion_state !== 'ready') return { error: 'This suggestion was made against an older version of the note, so it cannot be applied. Dismiss it, or edit the note.' };
      const eff = effective(note, row);
      if (eff.error) return { error: eff.error };
      const text = eff.text;
      await rpc('kb_suggestion_apply', { note_id: note.id, body: text, frontmatter: parseFrontmatter(text), hash: sha256(text), mtime: new Date().toISOString(), suggested_at: row.suggested_at });
      return { ok: true, ...shown(text) };
    }),
    'kb-suggestion-dismiss': call(false, 'The suggestion could not be dismissed.', async (noteId) => {
      if (!noteId || typeof noteId !== 'string') return { error: 'Pick the note first.' };
      await rpc('kb_suggestion_dismiss', { note_id: noteId });
      return { ok: true };
    }),
  };
}
