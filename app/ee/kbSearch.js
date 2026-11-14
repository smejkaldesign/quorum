// Knowledge base search (Cloud edition; migration 0027, docs/specs/workspace-knowledge.md "Use"). Quorum chat, the
// quorum CLI and the Quorum MCP server answer from every KB the asker can read. Every read goes through the signed-in
// person's own Supabase session: kb_search runs as security invoker, so row level security (notes_select,
// knowledge_bases_select, kb_folders_select) decides what comes back. The app holds no service key.
//
// What this module gives main.js:
//   search({ query, kb?, limit?, mode? })  -> { results: Hit[] }           kb is a KB id or name; mode 'all' (every
//                                                                            word) falls back to 'any' when nothing matches
//   read({ id? | path? })                  -> { note: Note }               id: the note's id; path: "KB/folder/.../title",
//                                                                            or the note's own path
//   list()                                 -> { kbs: KbBrief[] }
//   forChat(question)                      -> { block, hits } | null        the chat's context; never throws
//   sources(labels, hits)                  -> source cards for the labels the answer cited
//   available()                            -> boolean                      signed in with a workspace
// Every method except forChat, sources and available resolves to { error: string } on a refusal.
//
//   Hit     { label?, noteId, kbId, kbName, folderId, folderPath: string[], path, title, snippet, rank, updatedAt, link, citation }
//   Note    { id, kbId, kbName, folderId, folderPath, path, title, body, updatedAt, link, citation }
//   KbBrief { id, name, kind, role, isDefault, folders: string[] }   folders as "Parent/Child" paths
import { plain } from './account.js';
import { shapeKb } from './knowledgeBases.js';

// what one chat question may take from the knowledge bases: as many results as the Agent OS search hints (main.js
// searchHints asks for six), each excerpt and the whole block capped in characters, and the same six seconds a search
// gets before Quorum answers without it
export const KB_CHAT = { results: 6, excerpt: 700, total: 6000, timeoutMs: 6000 };
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

const fileTitle = (p) => String(p ?? '').replace(/^.*\//, '').replace(/\.md$/, '');
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

export function shapeHit(r, redact = (s) => s) {
  const h = {
    noteId: r.note_id, kbId: r.kb_id, kbName: r.kb_name ?? null, folderId: r.folder_id ?? null,
    folderPath: Array.isArray(r.folder_path) ? r.folder_path.map(String) : [],
    path: r.path ?? '', title: oneLine(redact(oneLine(r.title) || fileTitle(r.path))), snippet: oneLine(redact(String(r.snippet ?? ''))),
    rank: Number(r.rank) || 0, updatedAt: r.updated_at ?? null,
  };
  return { ...h, link: kbLink(h.kbId, h.noteId), citation: citation(h) };
}

// the results as the block the agent reads, each under a label it cites (K1, K2, ...). Excerpts are cut to fit and a
// result that would run past the total is left out, so the block never grows past what one question may take
export function chatContext(hits, { excerpt = KB_CHAT.excerpt, total = KB_CHAT.total } = {}) {
  const used = [];
  const parts = [];
  let size = 0;
  for (const h of hits) {
    const label = `K${used.length + 1}`;
    const text = h.snippet.length > excerpt ? `${h.snippet.slice(0, excerpt - 1).trimEnd()}…` : h.snippet;
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
// Names compare without case. Returns { kb, folderId, name } or { error }
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
    if (!f) return { error: `No folder "${seg}" in ${kbPlace(kb.name, folderNames(kb.folders, folderId))}.` };
    folderId = f.id;
    level = f.children;
  }
  return { kb, folderId, name: segs.at(-1).replace(/\.md$/i, '') };
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((resolve) => { setTimeout(() => resolve(null), ms).unref?.(); })]);

export function createKbSearch({ account, redact = (s) => s, log = () => {} }) {
  const fail = (err, fallback) => { log('kb search', err?.message ?? err); return { error: plain(err, fallback) }; };
  const ready = () => {
    if (!account.client?.()) return { error: 'Knowledge bases need a Quorum Cloud account, and hosted accounts are not set up in this build.' };
    const s = account.state();
    if (!s.signedIn) return { error: 'Sign in to Quorum first.' };
    if (!s.workspace) return { error: 'Pick a workspace in Quorum first.' };
    return null;
  };
  const ws = () => account.state().workspace.id;
  const guarded = (fallback, fn) => async (...args) => {
    const no = ready(); if (no) return no;
    try { return await fn(...args); } catch (err) { return fail(err, fallback); }
  };
  const loadKbs = async () => {
    const { data, error } = await account.client().rpc('kb_list', { workspace_id: ws() });
    if (error) throw Object.assign(new Error(error.message), { code: error.code ?? '' });
    return (data ?? []).map(shapeKb);
  };
  const rpcSearch = async ({ query, onlyKb, limit, mode }) => {
    const { data, error } = await account.client().rpc('kb_search', { workspace_id: ws(), query, only_kb: onlyKb, max_results: limit, mode });
    if (error) throw Object.assign(new Error(error.message), { code: error.code ?? '' });
    return (data ?? []).map((r) => shapeHit(r, redact));
  };
  const runSearch = async ({ query, kb = null, limit = 8, mode = null } = {}) => {
    const q = String(query ?? '').trim().slice(0, 1000);
    if (!q) return { error: 'Search for at least one word.' };
    const n = Math.max(1, Math.min(MAX_RESULTS, Number.parseInt(limit, 10) || 8));
    let onlyKb = null;
    if (kb) {
      if (ULID.test(String(kb))) onlyKb = String(kb);
      else {
        const hit = (await loadKbs()).find((k) => k.name.toLowerCase() === String(kb).trim().toLowerCase());
        if (!hit) return { error: `No knowledge base named "${kb}" that you can read.` };
        onlyKb = hit.id;
      }
    }
    if (mode && mode !== 'all' && mode !== 'any') return { error: 'mode is all or any.' };
    let results = await rpcSearch({ query: q, onlyKb, limit: n, mode: mode ?? 'all' });
    // a question in plain words rarely has every word in one note; with no mode asked for, any word will do
    if (!results.length && !mode) results = await rpcSearch({ query: q, onlyKb, limit: n, mode: 'any' });
    return { results };
  };

  const NOTE_COLUMNS = 'id, kb_id, folder_id, path, frontmatter, body, updated_at';
  const shapeNote = (row, kbs) => {
    const kb = kbs.find((k) => k.id === row.kb_id);
    const n = {
      id: row.id, kbId: row.kb_id, kbName: kb?.name ?? null, folderId: row.folder_id ?? null,
      folderPath: kb ? folderNames(kb.folders, row.folder_id) : [], path: row.path,
      title: oneLine(redact(oneLine(row.frontmatter?.title) || fileTitle(row.path))), body: redact(String(row.body ?? '')), updatedAt: row.updated_at ?? null,
    };
    return { ...n, link: kbLink(n.kbId, n.id), citation: citation(n) };
  };
  const notes = () => account.client().from('notes').select(NOTE_COLUMNS).eq('workspace_id', ws()).not('kb_id', 'is', null).is('deleted_at', null);
  const first = async (query) => { const { data, error } = await query.limit(1); if (error) throw error; return data?.[0] ?? null; };

  const api = {
    available: () => !ready(),
    search: guarded('The knowledge bases could not be searched.', runSearch),
    read: guarded('That note could not be read.', async ({ id = null, path = null } = {}) => {
      const kbs = await loadKbs();
      // a note outside every readable KB looks the same as one that does not exist
      const missing = { error: 'No knowledge base note there that you can read.' };
      if (id) {
        if (!ULID.test(String(id))) return { error: 'A note id is 26 letters and digits, as kb_search returns it.' };
        const row = await first(notes().eq('id', String(id)));
        return row && kbs.some((k) => k.id === row.kb_id) ? { note: shapeNote(row, kbs) } : missing;
      }
      if (!path) return { error: 'Give a note id or a knowledge base path.' };
      const exact = await first(notes().eq('path', String(path)));
      if (exact && kbs.some((k) => k.id === exact.kb_id)) return { note: shapeNote(exact, kbs) };
      const at = resolvePath(kbs, path);
      if (at.error) return at;
      const rows = [];
      for (let offset = 0; ; offset += PAGE) {
        let q = account.client().from('notes').select('id, path, frontmatter').eq('workspace_id', ws()).eq('kb_id', at.kb.id).is('deleted_at', null);
        q = at.folderId ? q.eq('folder_id', at.folderId) : q.is('folder_id', null);
        const { data, error } = await q.order('path').order('id').range(offset, offset + PAGE - 1);
        if (error) throw error;
        rows.push(...(data ?? []));
        if ((data ?? []).length < PAGE) break;
      }
      const want = at.name.toLowerCase();
      const hit = rows.find((r) => oneLine(r.frontmatter?.title).toLowerCase() === want) ?? rows.find((r) => fileTitle(r.path).toLowerCase() === want);
      if (!hit) return missing;
      const row = await first(notes().eq('id', hit.id));
      return row ? { note: shapeNote(row, kbs) } : missing;
    }),
    list: guarded('The knowledge bases could not be read.', async () => ({
      kbs: (await loadKbs()).map((k) => ({ id: k.id, name: k.name, kind: k.kind, role: k.role, isDefault: k.isDefault, folders: folderPaths(k.folders) })),
    })),
    // the chat's knowledge base context: the best few results for the question, in any-word mode, within the
    // question's budget. Signed out, slow or failing, the chat answers from the Agent OS alone
    forChat: async (question) => {
      if (ready()) return null;
      try {
        const results = await withTimeout(rpcSearch({ query: String(question ?? '').slice(0, 1000), onlyKb: null, limit: KB_CHAT.results, mode: 'any' }), KB_CHAT.timeoutMs);
        return results?.length ? chatContext(results) : null;
      } catch (err) { log('kb search', err?.message ?? err); return null; }
    },
    sources: kbSources,
    parseLink: parseKbLink,
  };
  return api;
}

// the MCP tools and CLI commands reach this through the running app's control socket (main.js control()): the app
// holds the session, so `quorum kb ...` reads as the signed-in person
export const KB_COMMANDS = ['kb_search', 'kb_read', 'kb_list'];
export function runKbCommand(kb, cmd, args = {}) {
  if (cmd === 'kb_search') return kb.search({ query: args.query, kb: args.kb ?? null, limit: args.limit ?? 8, mode: args.mode ?? null });
  if (cmd === 'kb_read') return kb.read({ id: args.id ?? null, path: args.path ?? null });
  if (cmd === 'kb_list') return kb.list();
  return Promise.resolve({ error: `Unknown command ${cmd}` });
}
