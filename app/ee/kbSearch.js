// Knowledge base search (Cloud edition; migration 0027, docs/specs/workspace-knowledge.md "Use"). Quorum chat, the
// quorum CLI and the Quorum MCP server answer from every KB the asker can read. Every read goes through the signed-in
// person's own Supabase session: kb_search runs as security invoker and the notes are read under notes_select, so
// row level security decides what comes back. The app holds no service key.
//
// What this module gives main.js:
//   search({ query, kb?, limit?, mode? })  -> { results: Hit[] }           kb is a KB id or name; mode 'all' (every
//                                                                            word) falls back to 'any' when nothing matches
//   read({ id? | path? })                  -> { note: Note }               id: the note's id; path: the note's own path,
//                                                                            or "KB/folder/.../title"
//   list()                                 -> { kbs: KbBrief[] }
//   forChat(question)                      -> { block, hits } | null        the chat's context; never throws
//   sources(labels, hits)                  -> source cards for the labels the answer cited
//   available()                            -> boolean                      signed in with a workspace
//   parseLink(url)                         -> { kbId, noteId } | null       a quorum://kb link
// Every method except forChat, sources, available and parseLink resolves to { error: string } on a refusal.
//
//   Hit     { label?, body?, noteId, kbId, kbName, folderId, folderPath: string[], path, title, snippet, rank, updatedAt, link, citation }
//   Note    { id, kbId, kbName, folderId, folderPath, path, title, body, updatedAt, link, citation }
//   KbBrief { id, name, kind, role, isDefault, folders: string[] }   folders as "Parent/Child" paths
// Every name a person reads (KB, folders, path, title, snippet, body) goes through the opt-out redactor first, and
// citations are built from the redacted parts.
import { kbSession, titleOf } from './knowledgeBases.js';

// what one chat question may take from the knowledge bases: as many results as the Agent OS search hints (main.js
// searchHints asks for six), each excerpt and the whole block capped in characters, and the same six seconds a search
// gets before Quorum answers without it. When the passages are short, the top notes' bodies are read instead
export const KB_CHAT = { results: 6, excerpt: 700, total: 6000, timeoutMs: 6000, shortSnippets: 300, bodies: 2, bodyExcerpt: 2500 };
const MAX_RESULTS = 50;
const PAGE = 1000;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const kbLink = (kbId, noteId) => `quorum://kb/${encodeURIComponent(kbId)}/${encodeURIComponent(noteId)}`;
export function parseKbLink(url) {
  const m = /^quorum:\/\/kb\/([^/?#]+)\/([^/?#]+)\/?$/.exec(String(url ?? ''));
  if (!m) return null;
  const kbId = decodeURIComponent(m[1]);
  const noteId = decodeURIComponent(m[2]);
  return ULID.test(kbId) && ULID.test(noteId) ? { kbId, noteId } : null;
}

// where a note sits, as people read it: "Handbook / Policies / Travel"
export const kbPlace = (kbName, folderPath = []) => [kbName || 'Knowledge base', ...(folderPath ?? [])].join(' / ');
export const citation = (h) => `${kbPlace(h.kbName, h.folderPath)} / ${h.title}`;

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const fileTitle = (p) => titleOf({ path: p });

// the parts of a note's place a person reads, each through the redactor
function named(r, redact) {
  const red = (s) => oneLine(redact(oneLine(s)));
  const n = {
    kbName: r.kbName == null ? null : red(r.kbName),
    folderPath: (r.folderPath ?? []).map((f) => red(f)),
    path: r.path == null ? '' : red(r.path),
    title: red(oneLine(r.title) || fileTitle(r.path)),
  };
  return { ...n, citation: citation(n) };
}

export function shapeHit(r, redact = (s) => s) {
  const place = named({ kbName: r.kb_name ?? null, folderPath: Array.isArray(r.folder_path) ? r.folder_path.map(String) : [], path: r.path, title: r.title }, redact);
  return {
    noteId: r.note_id, kbId: r.kb_id, folderId: r.folder_id ?? null, ...place,
    snippet: oneLine(redact(String(r.snippet ?? ''))), rank: Number(r.rank) || 0, updatedAt: r.updated_at ?? null,
    link: kbLink(r.kb_id, r.note_id),
  };
}

const cut = (s, max) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

// the results as the block the agent reads, each under a label it cites (K1, K2, ...). A result with a body (read
// because the passages were short) shows the body; excerpts are cut to fit and a result that would run past the
// total is left out, so the block never grows past what one question may take
export function chatContext(hits, { excerpt = KB_CHAT.excerpt, bodyExcerpt = KB_CHAT.bodyExcerpt, total = KB_CHAT.total } = {}) {
  const used = [];
  const parts = [];
  let size = 0;
  for (const h of hits) {
    const label = `K${used.length + 1}`;
    const text = h.body ? cut(h.body.trim(), bodyExcerpt) : cut(h.snippet, excerpt);
    const part = `[${label}] ${h.citation}${h.updatedAt ? ` (updated ${String(h.updatedAt).slice(0, 10)})` : ''}\n${text || '(no matching passage)'}`;
    if (size + part.length > total) break;
    size += part.length + 2;
    parts.push(part);
    used.push({ ...h, label });
  }
  return used.length ? { block: parts.join('\n\n'), hits: used } : null;
}

// the cited labels as source cards, in the order the answer cited them; labels it never saw are dropped
export function kbSources(labels = [], hits = []) {
  const byLabel = new Map(hits.map((h) => [h.label, h]));
  const out = [];
  for (const l of new Set(labels.map((x) => String(x).toUpperCase()))) {
    const h = byLabel.get(l);
    if (h) out.push({ title: h.title, rel: kbPlace(h.kbName, h.folderPath), abs: null, app: 'Knowledge', url: h.link, kb: { kbId: h.kbId, noteId: h.noteId } });
  }
  return out;
}

// the folders of a KB tree as "Parent/Child" paths, and one folder's names from the top down
export function folderPaths(tree = [], prefix = []) {
  return tree.flatMap((n) => [[...prefix, n.name].join('/'), ...folderPaths(n.children, [...prefix, n.name])]);
}
export function folderNames(tree = [], folderId) {
  if (!folderId) return [];
  for (const n of tree) {
    if (n.id === folderId) return [n.name];
    const below = folderNames(n.children, folderId);
    if (below.length) return [n.name, ...below];
  }
  return [];
}

// "Handbook/Policies/Travel/Travel policy": the KB by name, folders by name, then a note by title or file name.
// Names compare without case. Returns { kb, folderId, name } or { error }; an error names only what was typed
export function resolvePath(kbs, path) {
  const segs = String(path ?? '').split('/').map((s) => s.trim()).filter(Boolean);
  if (segs.length < 2) return { error: 'A knowledge base path is "KB/folder/note title", with at least the KB and the note.' };
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const kb = kbs.find((k) => same(k.name, segs[0]));
  if (!kb) return { error: `No knowledge base named "${segs[0]}" that you can read.` };
  let level = kb.folders;
  let folderId = null;
  for (const seg of segs.slice(1, -1)) {
    const f = level.find((n) => same(n.name, seg));
    if (!f) return { error: `No folder "${seg}" on that path.` };
    folderId = f.id;
    level = f.children;
  }
  return { kb, folderId, name: segs.at(-1).replace(/\.md$/i, '') };
}

// the best candidate among a folder's notes for a typed name: an exact title first, then an exact file name. The rows
// come ordered by path, then id, so the same name always picks the same note
export function pickByName(rows, name) {
  const want = String(name ?? '').toLowerCase();
  return rows.find((r) => oneLine(r.frontmatter?.title).toLowerCase() === want) ?? rows.find((r) => fileTitle(r.path).toLowerCase() === want) ?? null;
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((resolve) => { setTimeout(() => resolve(null), ms).unref?.(); })]);

export function createKbSearch({ account, redact = (s) => s, log = () => {} }) {
  const { fail, ready, ws, rpc, call, listKbs } = kbSession({ account, log, tag: 'kb search' });
  const NOTE_COLUMNS = 'id, kb_id, folder_id, path, frontmatter, body, updated_at';
  // live notes in the KBs the caller can read; row level security reads under the same rule
  const notes = (cols, kbIds) => account.client().from('notes').select(cols).eq('workspace_id', ws()).in('kb_id', kbIds).is('deleted_at', null);
  const rows = async (query) => {
    const out = [];
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await query().order('path').order('id').range(offset, offset + PAGE - 1);
      if (error) throw error;
      out.push(...(data ?? []));
      if ((data ?? []).length < PAGE) break;
    }
    return out;
  };
  const shapeNote = (row, kbs) => {
    const kb = kbs.find((k) => k.id === row.kb_id);
    const place = named({ kbName: kb?.name ?? null, folderPath: kb ? folderNames(kb.folders, row.folder_id) : [], path: row.path, title: row.frontmatter?.title }, redact);
    return { id: row.id, kbId: row.kb_id, folderId: row.folder_id ?? null, ...place, body: redact(String(row.body ?? '')), updatedAt: row.updated_at ?? null, link: kbLink(row.kb_id, row.id) };
  };
  const match = async ({ query, onlyKb, limit, mode }) => ((await rpc('kb_search', { workspace_id: ws(), query, only_kb: onlyKb, max_results: limit, mode })) ?? []).map((r) => shapeHit(r, redact));

  const search = async ({ query, kb = null, limit = 8, mode = null } = {}) => {
    const q = String(query ?? '').trim().slice(0, 1000);
    if (!q) return { error: 'Search for at least one word.' };
    if (mode && mode !== 'all' && mode !== 'any') return { error: 'mode is all or any.' };
    const n = Math.max(1, Math.min(MAX_RESULTS, Number.parseInt(limit, 10) || 8));
    let onlyKb = null;
    if (kb) {
      if (ULID.test(String(kb))) onlyKb = String(kb);
      else {
        const hit = (await listKbs()).find((k) => k.name.toLowerCase() === String(kb).trim().toLowerCase());
        if (!hit) return { error: `No knowledge base named "${kb}" that you can read.` };
        onlyKb = hit.id;
      }
    }
    let results = await match({ query: q, onlyKb, limit: n, mode: mode ?? 'all' });
    // a question in plain words rarely has every word in one note; with no mode asked for, any word will do
    if (!results.length && !mode) results = await match({ query: q, onlyKb, limit: n, mode: 'any' });
    return { results };
  };

  // a note by its id, by its own path, or by "KB/folder/title". Every lookup is limited to the KBs the caller can
  // read; a path tries the note's own path first, then the KB path by title, then by file name
  const read = async ({ id = null, path = null } = {}) => {
    const missing = { error: 'No knowledge base note there that you can read.' };
    if (id && !ULID.test(String(id))) return { error: 'A note id is 26 letters and digits, as kb_search returns it.' };
    if (!id && !path) return { error: 'Give a note id or a knowledge base path.' };
    const kbs = await listKbs();
    const ids = kbs.map((k) => k.id);
    if (!ids.length) return missing;
    const one = async (q) => { const { data, error } = await q.order('updated_at', { ascending: false }).order('id').limit(1); if (error) throw error; return data?.[0] ?? null; };
    if (id) {
      const row = await one(notes(NOTE_COLUMNS, ids).eq('id', String(id)));
      return row ? { note: shapeNote(row, kbs) } : missing;
    }
    const exact = await one(notes(NOTE_COLUMNS, ids).eq('path', String(path)));
    if (exact) return { note: shapeNote(exact, kbs) };
    const at = resolvePath(kbs, path);
    if (at.error) return at;
    const inFolder = await rows(() => {
      const q = notes('id, path, frontmatter', [at.kb.id]);
      return at.folderId ? q.eq('folder_id', at.folderId) : q.is('folder_id', null);
    });
    const hit = pickByName(inFolder, at.name);
    if (!hit) return missing;
    const row = await one(notes(NOTE_COLUMNS, [at.kb.id]).eq('id', hit.id));
    return row ? { note: shapeNote(row, kbs) } : missing;
  };

  // short passages tell the agent little; the top notes' bodies (redacted) go in their place, within the same cap
  const withBodies = async (hits) => {
    const short = hits.reduce((n, h) => n + h.snippet.length, 0) < KB_CHAT.shortSnippets;
    if (!short) return hits;
    const top = hits.slice(0, KB_CHAT.bodies);
    const { data, error } = await notes('id, body', [...new Set(top.map((h) => h.kbId))]).in('id', top.map((h) => h.noteId));
    if (error) throw error;
    const body = new Map((data ?? []).map((r) => [r.id, redact(String(r.body ?? ''))]));
    return hits.map((h) => (body.get(h.noteId) ? { ...h, body: body.get(h.noteId) } : h));
  };

  return {
    available: () => !ready(),
    search: call(false, 'The knowledge bases could not be searched.', search),
    read: call(false, 'That note could not be read.', read),
    list: call(false, 'The knowledge bases could not be read.', async () => ({
      kbs: (await listKbs()).map((k) => ({ id: k.id, name: oneLine(redact(k.name)), kind: k.kind, role: k.role, isDefault: k.isDefault, folders: folderPaths(k.folders).map((f) => f.split('/').map((s) => oneLine(redact(s))).join('/')) })),
    })),
    // the chat's knowledge base context: the best few results for the question, in any-word mode, within the
    // question's budget. Signed out, slow or failing, the chat answers from the Agent OS alone
    forChat: async (question) => {
      if (ready()) return null;
      try {
        const run = async () => {
          const hits = await match({ query: String(question ?? '').slice(0, 1000), onlyKb: null, limit: KB_CHAT.results, mode: 'any' });
          return hits.length ? withBodies(hits) : hits;
        };
        const hits = await withTimeout(run(), KB_CHAT.timeoutMs);
        return hits?.length ? chatContext(hits) : null;
      } catch (err) { fail(err, ''); return null; }
    },
    sources: kbSources,
    parseLink: parseKbLink,
  };
}

// the MCP tools and CLI commands reach this through the running app's control socket (main.js control()): the app
// holds the session, so `quorum kb ...` reads as the signed-in person
export function runKbCommand(kb, cmd, args = {}) {
  if (cmd === 'kb_search') return kb.search({ query: args.query, kb: args.kb ?? null, limit: args.limit ?? 8, mode: args.mode ?? null });
  if (cmd === 'kb_read') return kb.read({ id: args.id ?? null, path: args.path ?? null });
  if (cmd === 'kb_list') return kb.list();
  return Promise.resolve({ error: `Unknown command ${cmd}` });
}
