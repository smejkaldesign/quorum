// Knowledge bases (Cloud edition; migrations 0024 and 0025, docs/specs/workspace-knowledge.md). A KB is a top-level
// folder of a workspace's knowledge with its own admins and readers, and folders that nest without limit. The server
// decides every right: row level security for reads and security definer RPCs for writes, each refusing with a
// sentence the app shows as is. This module only calls them and reshapes the answers for the renderer.
//
// IPC API (preload exposes each as window.quorum.<camelName>). Every handler resolves to { error: string } on a
// refusal, or to the result shown here. Ids are ULID strings; user ids are auth UUIDs.
//
//   kb-list          ()                                          -> { kbs: Kb[] }               readable KBs, default first
//   kb-create        ({ name, kind? })                           -> { kb: Kb }                  owners and admins only
//   kb-rename        (kbId, name)                                -> { kb: Kb }
//   kb-delete        (kbId)                                      -> { ok: true }                owners and admins only
//   kb-folder-create ({ kbId, parentId?, name, position? })      -> { folder: Folder }
//   kb-folder-rename (folderId, name)                            -> { folder: Folder }
//   kb-folder-move   ({ folderId, parentId?, position? })        -> { folder: Folder }         parentId left out: same
//                                                                                               parent; null: top level
//   kb-folder-delete (folderId)                                  -> { ok: true }                subfolders go too
//   kb-access-set    (kbId, access: AccessDraft[])               -> { access: Access[] }       replaces the whole list
//   kb-note-assign   ({ noteId? | path?, kbId, folderId? })       -> { placement: Placement }   kbId null takes it out;
//                                                                                               path finds the caller's own note
//   kb-notes         (kbId)                                      -> { notes: KbNote[] }         readable notes in a KB, all pages
//
//   Kb          { id, name, kind: 'general' | 'meetings', teamId, isDefault, source, role: 'admin' | 'reader',
//                 createdAt, updatedAt, folders: FolderNode[], access: Access[] | null }
//               folders is the tree; access is null unless role is admin. source is a Mac-side source attached to
//               the KB ({ kind: 'folder' | 'git', url, path }) or null; the default KB carries the 0020 team source.
//   Folder      { id, kbId, parentId, name, position }
//   FolderNode  { id, parentId, name, position, children: FolderNode[] }   siblings sorted by position, then name
//   Access      { principal: 'workspace' | 'team' | 'user', userId, teamId, role: 'admin' | 'reader', email, name }
//   AccessDraft { principal, userId?, teamId?, role? }   role defaults to reader; team principals are refused
//               until teams exist. Workspace owners and admins read and manage every KB without a row here.
//   Placement   { noteId, kbId, folderId, updatedAt }
//   KbNote      { id, path, title, folderId, userId, updatedAt }
//
// Rights: workspace owners and admins create and delete KBs and manage all of them; a KB admin (role admin in its
// access list) renames it, manages its folders and readers, and adds their own shared notes to it; moving another
// member's note takes a workspace owner or admin; readers read. Only a note shared with the workspace (visibility
// public, not confidential) sits in a KB: its author can always take it out, and a note that stops being shared, or
// whose contribution is declined, leaves. With a team switched on, the workspace's default KB receives every note the
// review queue includes. Pull sync (ee/sync.js) carries each note's kb_id and folder_id onto the local id map and
// into a shared note's bond.
import { plain } from './account.js';

export const KB_KINDS = ['general', 'meetings'];
const PAGE = 1000;
const ROLES = ['admin', 'reader'];
const PRINCIPALS = ['workspace', 'team', 'user'];

// a name the server will take: trimmed, 1 to 120 characters; folder names also have no slashes
export function checkName(name, { folder = false } = {}) {
  const n = String(name ?? '').trim();
  if (!n) return { error: folder ? 'A folder needs a name.' : 'A knowledge base needs a name.' };
  if (n.length > 120) return { error: 'That name is too long.' };
  if (folder && /[/\\]/.test(n)) return { error: 'A folder name cannot contain slashes.' };
  return { name: n };
}

const byPosition = (a, b) => (a.position ?? 0) - (b.position ?? 0) || String(a.name).localeCompare(String(b.name));

// the flat folder rows as a tree; a folder whose parent is missing (a race with a delete) shows at the top level
export function folderTree(rows = []) {
  const nodes = new Map(rows.map((f) => [f.id, { id: f.id, parentId: f.parent_id ?? f.parentId ?? null, name: f.name, position: f.position ?? 0, children: [] }]));
  const top = [];
  for (const n of nodes.values()) (n.parentId && nodes.has(n.parentId) ? nodes.get(n.parentId).children : top).push(n);
  const sort = (list) => { list.sort(byPosition); for (const n of list) sort(n.children); return list; };
  return sort(top);
}

export const shapeAccess = (a) => ({ principal: a.principal, userId: a.user_id ?? null, teamId: a.team_id ?? null, role: a.role, email: a.email ?? null, name: a.name ?? null });
export const shapeFolder = (f) => (f ? { id: f.id, kbId: f.kb_id, parentId: f.parent_id ?? null, name: f.name, position: f.position ?? 0 } : null);
export const shapeKb = (k) => ({
  id: k.id, name: k.name, kind: KB_KINDS.includes(k.kind) ? k.kind : 'general', teamId: k.team_id ?? null, isDefault: !!k.is_default,
  source: k.source && typeof k.source === 'object' && ['folder', 'git'].includes(k.source.kind) ? { kind: k.source.kind, url: k.source.url ?? null, path: k.source.path ?? null } : null,
  role: k.role === 'admin' ? 'admin' : 'reader', createdAt: k.created_at ?? null, updatedAt: k.updated_at ?? null,
  folders: folderTree(Array.isArray(k.folders) ? k.folders : []),
  access: Array.isArray(k.access) ? k.access.map(shapeAccess) : null,
});

// what the renderer sends, as the rows kb_set_access takes; an error names the first entry that is wrong
export function accessRows(list) {
  if (!Array.isArray(list)) return { error: 'Access is a list of readers and admins.' };
  const rows = [];
  for (const a of list) {
    const principal = a?.principal;
    const role = a?.role ?? 'reader';
    if (!PRINCIPALS.includes(principal)) return { error: 'A reader is the workspace, a team or a person.' };
    if (!ROLES.includes(role)) return { error: 'A role is admin or reader.' };
    if (principal === 'user' && !a.userId) return { error: 'Pick the person.' };
    if (principal === 'team' && !a.teamId) return { error: 'Pick the team.' };
    rows.push({ principal, role, ...(principal === 'user' ? { user_id: a.userId } : {}), ...(principal === 'team' ? { team_id: a.teamId } : {}) });
  }
  return { rows };
}

const titleOf = (n) => n.frontmatter?.title || String(n.path ?? '').replace(/^.*\//, '').replace(/\.md$/, '');

export function createKnowledgeBases({ account, log = () => {} }) {
  const fail = (err, fallback) => { log('kb', err?.message ?? err); return { error: plain(err, fallback) }; };
  const ready = (admin = false) => {
    if (!account.client()) return { error: 'Hosted accounts are not set up in this build.' };
    const s = account.state();
    if (!s.signedIn) return { error: 'Sign in first.' };
    if (!s.workspace) return { error: 'Pick a workspace first.' };
    if (admin && s.workspace.role === 'member') return { error: 'Only owners and admins can create or delete a knowledge base.' };
    return null;
  };
  const ws = () => account.state().workspace.id;
  const rpc = async (name, args) => {
    const { data, error } = await account.client().rpc(name, args);
    if (error) throw Object.assign(new Error(error.message), { code: error.code ?? '' });
    return data;
  };
  // one RPC behind a ready check; the RPC's own sentence passes through plain() and a failure names the fallback
  const call = (admin, fallback, fn) => async (...args) => {
    const no = ready(admin); if (no) return no;
    try { return await fn(...args); } catch (err) { return fail(err, fallback); }
  };
  const need = (v, what) => { if (!v || typeof v !== 'string') throw Object.assign(new Error(`Pick the ${what} first.`), { code: 'P0001' }); return v; };

  const handlers = {
    'kb-list': call(false, 'The knowledge bases could not be read.', async () => ({ kbs: ((await rpc('kb_list', { workspace_id: ws() })) ?? []).map(shapeKb) })),
    'kb-create': call(true, 'The knowledge base could not be created.', async (draft = {}) => {
      const n = checkName(draft.name); if (n.error) return n;
      const kind = draft.kind ?? 'general';
      if (!KB_KINDS.includes(kind)) return { error: 'A knowledge base is general or meetings.' };
      return { kb: shapeKb(await rpc('kb_create', { workspace_id: ws(), name: n.name, kind })) };
    }),
    'kb-rename': call(false, 'The knowledge base could not be renamed.', async (kbId, name) => {
      const n = checkName(name); if (n.error) return n;
      return { kb: shapeKb(await rpc('kb_rename', { kb_id: need(kbId, 'knowledge base'), name: n.name })) };
    }),
    'kb-delete': call(true, 'The knowledge base could not be deleted.', async (kbId) => { await rpc('kb_delete', { kb_id: need(kbId, 'knowledge base') }); return { ok: true }; }),
    'kb-folder-create': call(false, 'The folder could not be created.', async (draft = {}) => {
      const n = checkName(draft.name, { folder: true }); if (n.error) return n;
      return { folder: shapeFolder(await rpc('kb_folder_create', { kb_id: need(draft.kbId, 'knowledge base'), parent_id: draft.parentId ?? null, name: n.name, position: Number.isInteger(draft.position) ? draft.position : null })) };
    }),
    'kb-folder-rename': call(false, 'The folder could not be renamed.', async (folderId, name) => {
      const n = checkName(name, { folder: true }); if (n.error) return n;
      return { folder: shapeFolder(await rpc('kb_folder_rename', { folder_id: need(folderId, 'folder'), name: n.name })) };
    }),
    'kb-folder-move': call(false, 'The folder could not be moved.', async (draft = {}) => {
      if (draft.parentId && draft.parentId === draft.folderId) return { error: 'A folder cannot move inside itself.' };
      const reparent = Object.prototype.hasOwnProperty.call(draft, 'parentId') && draft.parentId !== undefined;
      return { folder: shapeFolder(await rpc('kb_folder_move', { folder_id: need(draft.folderId, 'folder'), parent_id: reparent ? draft.parentId : null, position: Number.isInteger(draft.position) ? draft.position : null, reparent })) };
    }),
    'kb-folder-delete': call(false, 'The folder could not be deleted.', async (folderId) => { await rpc('kb_folder_delete', { folder_id: need(folderId, 'folder') }); return { ok: true }; }),
    'kb-access-set': call(false, 'Access could not be saved.', async (kbId, list) => {
      const a = accessRows(list); if (a.error) return a;
      return { access: ((await rpc('kb_set_access', { kb_id: need(kbId, 'knowledge base'), access: a.rows })) ?? []).map(shapeAccess) };
    }),
    // a note by its server id, or by its vault path as the person's own note; kbId null takes it out of its KB
    'kb-note-assign': call(false, 'The note could not be moved.', async (draft = {}) => {
      let noteId = draft.noteId ?? null;
      if (!noteId && draft.path) {
        const { data, error } = await account.client().from('notes').select('id').eq('workspace_id', ws()).eq('user_id', account.state().userId).eq('path', String(draft.path)).is('deleted_at', null).limit(1);
        if (error) throw error;
        noteId = data?.[0]?.id ?? null;
        if (!noteId) return { error: 'That note has not synced yet. Turn on sync and try again.' };
      }
      const r = await rpc('kb_note_assign', { note_id: need(noteId, 'note'), kb_id: draft.kbId ?? null, folder_id: draft.kbId ? draft.folderId ?? null : null });
      return { placement: { noteId: r.note_id, kbId: r.kb_id ?? null, folderId: r.folder_id ?? null, updatedAt: r.updated_at ?? null } };
    }),
    // page by page, as pull sync walks a table, so a KB larger than one PostgREST page comes back whole
    'kb-notes': call(false, 'The notes could not be read.', async (kbId) => {
      const id = need(kbId, 'knowledge base');
      const rows = [];
      for (let offset = 0; ; offset += PAGE) {
        const { data, error } = await account.client().from('notes').select('id, path, frontmatter, folder_id, user_id, updated_at')
          .eq('workspace_id', ws()).eq('kb_id', id).is('deleted_at', null).order('path').order('id').range(offset, offset + PAGE - 1);
        if (error) throw error;
        rows.push(...(data ?? []));
        if ((data ?? []).length < PAGE) break;
      }
      return { notes: rows.map((n) => ({ id: n.id, path: n.path, title: titleOf(n), folderId: n.folder_id ?? null, userId: n.user_id, updatedAt: n.updated_at ?? null })) };
    }),
  };
  return { handlers };
}

export function registerKnowledgeBases({ ipcMain, account, log }) {
  const kb = createKnowledgeBases({ account, log });
  for (const [name, fn] of Object.entries(kb.handlers)) ipcMain.handle(name, (_e, ...a) => fn(...a));
  return kb;
}
