// Quorum's edits to synced KB notes, kept as suggestions when the source changes (Cloud edition;
// docs/specs/workspace-knowledge.md, "Maintenance" and Decision 5; migration 0031). A note synced from GitHub, a zip or
// Google Drive (frontmatter kb_source) is Quorum's copy of a file in another tool. Quorum's maintenance, the agents
// working in the vault and the person may change that copy; Quorum never writes back to the source tool.
//
// Every sync records the upstream base: the text Quorum last wrote from the source, with its hash and the hash of its
// text without the frontmatter keys sync and pull set on their own (VOLATILE), in kb_note_upstream (one row per note,
// read only by the admins of the KB the note is in now). The note counts as edited while its text differs from that
// base outside those keys. On the next sync (planNote):
//
//   not edited, source changed       the source's text is written, as before
//   edited, source unchanged         Quorum's copy stays as it is; nothing is written (counted in kept)
//   edited, source changed           the source's text is written as the note, and the edit becomes a suggestion,
//                                    merged three ways (old base, Quorum's copy, new source) with the VOLATILE keys left
//                                    out: when every changed block of the edit still applies to the new text, the
//                                    suggestion is "ready" and holds the merged text; otherwise it is "stale" and holds
//                                    the edited text with the old base it was made against
//   suggestions from earlier syncs   each is merged again against the newer source and kept beside a new one; one is
//                                    dropped only when the source already holds its change
//
// The note and its base are written in one database call (kb_synced_notes_write), so a sync that fails half way never
// leaves a base that does not match the note. Reading the table is optional: when it fails or the database has no
// migration 0031, the sync runs as it did before for that run.
//
// IPC API (preload exposes each as window.quorum.<camelName>; registered with ee/knowledgeBases.js):
//
//   kb-suggestion         (noteId)                         -> { edited, noteHash, suggestions: Suggestion[] }  admins
//   kb-suggestion-apply   (noteId, suggestionId, noteHash) -> { ok, title, body } | { error, changed? }
//   kb-suggestion-dismiss (noteId, suggestionId)           -> { ok }
//
//   Suggestion  { id, state: 'ready' | 'stale', at, lines: DiffLine[], blocked? }
//   DiffLine    { op: ' ' | '+' | '-' | '~', text }   '~' stands for unchanged lines left out of the view, text counts them
//
// A reader of the KB gets { edited: false, suggestions: [] }. For a ready suggestion the lines go from the note as it is
// now to the text Apply writes; for a stale one, from the old base to the edit. Apply sends the note's hash as the page
// saw it; when the note changed since, the database refuses and the page reads the suggestions again (changed: true).
import { createHash, randomBytes } from 'node:crypto';
import { BOND_KEYS, parseFrontmatter } from './sync.js';

export const UPSTREAM = 'kb_note_upstream';
const IDS = 100;
const SAVE_ROWS = 50;
const SAVE_CHARS = 4 * 1024 * 1024;
// a diff with more edits than this is not merged; the suggestion is kept as stale instead
const MAX_EDITS = 2000;
const CONTEXT = 3;
// frontmatter keys a sync or a pull sets on its own; a change to one of them is no edit
export const VOLATILE = new Set(['kb_synced_at', 'kb_checked_at', 'kb_source_modified', ...BOND_KEYS]);
export const CHANGED = 'This note changed since you opened it. The suggestions were read again against the new text.';

export const sha256 = (t) => createHash('sha256').update(String(t)).digest('hex');
const lf = (t) => String(t ?? '').replace(/\r\n?/g, '\n');
const FM = /^---\n([\s\S]*?)\n---(\n|$)/;
const keyOf = (line) => line.match(/^([A-Za-z0-9_]+):/)?.[1] ?? '';
const suggestionId = () => randomBytes(8).toString('hex');

// the text without the frontmatter lines in VOLATILE
export function stripVolatile(text) {
  const t = lf(text);
  const m = t.match(FM);
  if (!m) return t;
  const kept = m[1].split('\n').filter((l) => !VOLATILE.has(keyOf(l)));
  return `---\n${kept.join('\n')}\n---${m[2]}${t.slice(m[0].length)}`;
}
// text with from's VOLATILE lines in place of its own, at the end of its frontmatter
export function withVolatileOf(text, from) {
  const vol = (lf(from).match(FM)?.[1] ?? '').split('\n').filter((l) => VOLATILE.has(keyOf(l)));
  const t = stripVolatile(text);
  if (!vol.length) return t;
  const m = t.match(FM);
  if (!m) return `---\n${vol.join('\n')}\n---\n${t}`;
  return `---\n${m[1]}\n${vol.join('\n')}\n---${m[2]}${t.slice(m[0].length)}`;
}
const norm = (t) => stripVolatile(t).replace(/\s+$/, '');
// two texts are the same note when they differ only in VOLATILE keys and trailing white space
export const sameNote = (a, b) => norm(a) === norm(b);
export const normHash = (t) => sha256(norm(t));
const linesOf = (t) => lf(t).replace(/\n$/, '').split('\n');

// the lines a and b share, as [i, j] pairs in order (Myers' diff). Backtracking keeps only the frontier each step
// reached (2d + 1 values at step d). null when they differ in more than maxEdits lines
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
  // fronts[d] holds the furthest x on diagonal k after step d, for k in [-d, d], at index k + d
  const fronts = [];
  let found = -1;
  for (let d = 0; d <= limit && found < 0; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= N && y >= M) { found = d; break; }
    }
    fronts.push(v.slice(off - d, off + d + 1));
  }
  if (found < 0) return null;
  const at = (d, k) => fronts[d][k + d];
  const mid = [];
  let x = N, y = M;
  for (let d = found; d >= 0; d--) {
    const k = x - y;
    let startX = 0, px = 0, py = 0;
    if (d > 0) {
      const down = k === -d || (k !== d && at(d - 1, k - 1) < at(d - 1, k + 1));
      const pk = down ? k + 1 : k - 1;
      px = at(d - 1, pk);
      py = px - pk;
      startX = down ? px : px + 1;
    }
    // the run of shared lines step d ended with
    while (x > startX) { mid.push([x - 1, y - 1]); x--; y--; }
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

// an edit merged onto text with the VOLATILE keys left out of all three, then the text's own VOLATILE keys put back
export function mergeOnto(base, edited, onto) {
  const m = merge3(stripVolatile(base), stripVolatile(edited), stripVolatile(onto));
  return m.clean ? withVolatileOf(m.text, onto) : null;
}

// what an edit becomes against a new source text: null when the source already holds it
export function suggestionFor({ base, edited, upstream }) {
  if (sameNote(edited, upstream)) return null;
  const text = mergeOnto(base, edited, upstream);
  if (text != null) return sameNote(text, upstream) ? null : { state: 'ready', body: text, agent: edited, base };
  return { state: 'stale', body: edited, agent: edited, base };
}

// what a sync does with one note already in the KB. row is its upstream row (null: none recorded), current the note's
// text now, upstream the source's new text. write says whether the source's text goes into the note; suggestions is the
// list the row holds after the sync, and fresh counts the new ones
export function planNote({ row, current, upstream, now = () => new Date().toISOString() }) {
  if (!row) return { write: true, edited: false, suggestions: [], fresh: 0 };
  const edited = !sameNote(current, row.base_body);
  const pending = Array.isArray(row.suggestions) ? row.suggestions : [];
  if ((row.base_norm && normHash(upstream) === row.base_norm) || sameNote(upstream, row.base_body)) return { write: !edited, edited, suggestions: pending, fresh: 0 };
  const next = [];
  for (const s of pending) {
    const again = suggestionFor({ base: s.base, edited: s.agent, upstream });
    if (again) next.push({ ...again, id: s.id, at: s.at });
  }
  let fresh = 0;
  if (edited) {
    const s = suggestionFor({ base: row.base_body, edited: current, upstream });
    if (s && !next.some((x) => sameNote(x.agent, s.agent))) { next.push({ ...s, id: suggestionId(), at: now() }); fresh = 1; }
  }
  return { write: true, edited, suggestions: next, fresh };
}

// the upstream row a write carries: the text written becomes the base
export const baseRow = (noteId, text, suggestions = []) => ({ note_id: noteId, base_hash: sha256(text), base_norm: normHash(text), base_body: text, suggestions });

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
const missing = (err) => ['42P01', 'PGRST202', 'PGRST205'].includes(err?.code) || (/kb_note_upstream|kb_upstream_save|kb_synced_notes_write|kb_suggestion_/i.test(String(err?.message)) && /does not exist|could not find/i.test(String(err?.message)));
const textSize = (s) => (s.body?.length ?? 0) + (s.agent?.length ?? 0) + (s.base?.length ?? 0);
const sizeOf = (r) => (r.body?.length ?? 0) + (r.upstream?.base_body?.length ?? 0) + (r.upstream?.suggestions ?? []).reduce((n, s) => n + textSize(s), 0);

// the upstream side of one sync, shared by ee/kbImport.js and ee/kbDrive.js. prepare reads the rows of the notes being
// synced (hashes and suggestions first, then the full texts only of notes whose hash moved from their base, or that
// have no base when withoutBase is set); plan decides for one note; write puts notes and their bases up together;
// saveBases records the base of notes written another way (new notes, a Drive note found unedited). Once the table or
// a function is missing, or a read fails, the store is off for the rest of the run and the caller syncs as before
export function syncUpstream({ client, ws, log = () => {}, tag = 'kb-upstream', now }) {
  let off = false;
  const rows = new Map();
  const current = new Map();
  const quit = (what, err) => {
    off = true;
    rows.clear(); current.clear();
    log(tag, missing(err) ? `${what}: kb_note_upstream is not in this database yet` : `${what} failed, syncing without suggestions this time: ${err?.message ?? err}`);
  };
  const inIds = async (table, columns, key, ids) => {
    const out = [];
    for (let i = 0; i < ids.length; i += IDS) {
      let q = client().from(table).select(columns);
      if (table === 'notes') q = q.eq('workspace_id', ws());
      const { data, error } = await q.in(key, ids.slice(i, i + IDS));
      if (error) throw error;
      out.push(...(data ?? []));
    }
    return out;
  };
  return {
    get off() { return off; },
    row: (id) => rows.get(id) ?? null,
    current: (id) => current.get(id) ?? null,
    async prepare(notes, { withoutBase = false } = {}) {
      if (off || !notes.length) return;
      try {
        for (const r of await inIds(UPSTREAM, 'note_id, base_hash, base_norm, suggestions', 'note_id', notes.map((n) => n.id))) rows.set(r.note_id, r);
        const moved = notes.filter((n) => (rows.has(n.id) ? rows.get(n.id).base_hash !== n.hash : withoutBase)).map((n) => n.id);
        if (!moved.length) return;
        for (const r of await inIds('notes', 'id, body', 'id', moved)) current.set(r.id, String(r.body ?? ''));
        const based = moved.filter((id) => rows.has(id));
        if (based.length) for (const r of await inIds(UPSTREAM, 'note_id, base_body', 'note_id', based)) rows.get(r.note_id).base_body = r.base_body;
      } catch (err) { quit('read', err); }
    },
    // the plan for a note. A note whose hash has not moved is its base, so only the source's hash is compared then
    plan(note, upstream) {
      const row = rows.get(note.id) ?? null;
      if (!row) return planNote({ row: null, current: '', upstream, now });
      const body = current.get(note.id);
      const base = row.base_body ?? body;
      return planNote({ row: { ...row, base_body: base ?? '' }, current: body ?? base ?? '', upstream, now });
    },
    // notes with their upstream rows, in batches under a size cap. Resolves to { written, failed } with failed mapping a
    // note id to its error, or to null when the database has no kb_synced_notes_write (nothing was written)
    async write(kbId, items) {
      if (off) return null;
      const written = new Set();
      const failed = new Map();
      const send = async (batch) => {
        const { data, error } = await client().rpc('kb_synced_notes_write', { kb_id: kbId, rows: batch });
        if (error) throw Object.assign(new Error(error.message), { code: error.code ?? '' });
        for (const id of data ?? []) written.add(String(id));
      };
      const run = async (batch) => {
        if (!batch.length || off) return;
        try { await send(batch); } catch (err) {
          if (missing(err)) { quit('write', err); return; }
          if (batch.length === 1) { failed.set(batch[0].note_id, err); return; }
          // one refused note fails its whole batch; one at a time finds which
          for (const r of batch) { try { await send([r]); } catch (e) { failed.set(r.note_id, e); } }
        }
      };
      let batch = [], chars = 0;
      for (const r of items) {
        const size = sizeOf(r);
        if (batch.length && (batch.length >= SAVE_ROWS || chars + size > SAVE_CHARS)) { await run(batch); batch = []; chars = 0; }
        batch.push(r); chars += size;
      }
      await run(batch);
      if (off && !written.size && !failed.size) return null;
      return { written, failed };
    },
    // bases for notes already written; a row whose hash no longer matches its note is passed over by the database
    async saveBases(kbId, list) {
      if (off || !list.length) return 0;
      let saved = 0;
      for (let i = 0; i < list.length && !off; i += SAVE_ROWS) {
        const batch = list.slice(i, i + SAVE_ROWS).map((r) => ({ note_id: r.note_id, base_hash: r.base_hash, base_norm: r.base_norm, base_body: r.base_body }));
        const { data, error } = await client().rpc('kb_upstream_save', { kb_id: kbId, rows: batch });
        if (error) { if (missing(error)) quit('save', error); else log(tag, 'bases not stored', error.message); continue; }
        saved += Number(data) || 0;
      }
      return saved;
    },
  };
}

// the text Apply writes for one suggestion: its own text when the note is still the base, else the suggestion merged
// onto the note as it is now (an edit made after the suggestion is kept). Refused when the two cannot merge
const NOT_THERE = 'That suggestion is no longer there. Open the note again.';
function effective(note, row, s) {
  if (s.state !== 'ready') return null;
  if (sameNote(note.body, row.base_body)) return { text: withVolatileOf(s.body, note.body) };
  const text = mergeOnto(row.base_body, note.body, s.body);
  return text != null ? { text: withVolatileOf(text, note.body) } : { error: 'This note changed after the suggestion was made, and the two cannot be merged. Sync the source again to refresh the suggestion.' };
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
      c.from('notes').select('id, kb_id, body, hash').eq('workspace_id', ws()).eq('id', noteId).is('deleted_at', null).limit(1),
      c.from(UPSTREAM).select('note_id, base_body, suggestions').eq('note_id', noteId).limit(1),
    ]);
    if (n.error) throw n.error;
    // readers are shown no row at all; an older database has no table
    if (u.error) { if (missing(u.error)) return { note: n.data?.[0] ?? null, row: null }; throw u.error; }
    return { note: n.data?.[0] ?? null, row: u.data?.[0] ?? null };
  };
  const listOf = (row) => (Array.isArray(row?.suggestions) ? row.suggestions : []);
  return {
    'kb-suggestion': call(false, 'The suggestions could not be read.', async (noteId) => {
      const { note, row } = await read(noteId);
      if (!note || !row || !note.kb_id) return { edited: false, noteHash: note?.hash ?? null, suggestions: [] };
      const edited = !sameNote(note.body, row.base_body);
      const suggestions = listOf(row).map((s) => {
        const eff = effective(note, row, s);
        const lines = s.state === 'ready'
          ? diffView(stripVolatile(note.body), stripVolatile(eff?.text ?? s.body))
          : diffView(stripVolatile(s.base), stripVolatile(s.agent));
        return { id: s.id, state: s.state, at: s.at ?? null, lines, ...(eff?.error ? { blocked: eff.error } : {}) };
      });
      return { edited, noteHash: note.hash ?? null, suggestions };
    }),
    'kb-suggestion-apply': call(false, 'The suggestion could not be applied.', async (noteId, suggestionId, noteHash) => {
      const { note, row } = await read(noteId);
      const s = listOf(row).find((x) => x.id === suggestionId);
      if (!note || !s) return { error: NOT_THERE, changed: true };
      if (typeof noteHash === 'string' && note.hash !== noteHash) return { error: CHANGED, changed: true };
      if (s.state !== 'ready') return { error: 'This suggestion was made against an older version of the note, so it cannot be applied. Dismiss it, or edit the note.' };
      const eff = effective(note, row, s);
      if (eff.error) return { error: eff.error };
      try {
        await rpc('kb_suggestion_apply', { note_id: note.id, suggestion_id: s.id, body: eff.text, frontmatter: parseFrontmatter(eff.text), hash: sha256(eff.text), mtime: new Date().toISOString(), expected_hash: note.hash ?? '' });
      } catch (err) {
        if (/changed since/i.test(String(err?.message))) return { error: CHANGED, changed: true };
        throw err;
      }
      return { ok: true, ...shown(eff.text) };
    }),
    'kb-suggestion-dismiss': call(false, 'The suggestion could not be dismissed.', async (noteId, suggestionId) => {
      if (!noteId || typeof noteId !== 'string' || !suggestionId || typeof suggestionId !== 'string') return { error: 'Pick the suggestion first.' };
      await rpc('kb_suggestion_dismiss', { note_id: noteId, suggestion_id: suggestionId });
      return { ok: true };
    }),
  };
}
