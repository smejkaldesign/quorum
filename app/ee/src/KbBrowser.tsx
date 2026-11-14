import { createContext, useCallback, useContext, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Kb, KbNote } from '../../src/quorum';
import { Markdown } from '../../src/Markdown';
import { matchesQuery } from '../../src/mainTabs';
import { IconBack, IconBrain, IconChevron, IconDoc, IconFolder, IconMore, IconPlus, IconStack } from '../../src/icons';
import { canArrange, descendantIds, findFolder, folderPath, moveCheck, moveTargets, notesIn, openPathTo, resolveKbLink, rowKey, treeKey, visibleRows, withFolder, withoutFolder, type TreeRow } from './kbTree';
import { KB_CHANGED, kbCall, KbConfirm, useLatest } from './kbUi';
import { DrivePanel, hasDrive } from './KbDrive';
import { hasKbSync, SyncPanel, type SyncSource } from './KbSync';
import { KbSuggestionBanner } from './KbSuggestion';
import { KB_OPEN, takeKbOpen, type KbOpenTarget } from '../../src/kbOpen';
import { KbHostedNote } from './KbHostedNote';

// The knowledge bases in the Knowledge tab: one left column with the team knowledge entry (and, for a folder or git
// source, that source's own file tree, which the team view portals into the slot below it) and one top-level row per
// KB the person can read with its folders inside; the selected folder's notes on the right. KB admins create, rename,
// move (drag, or Move to) and delete folders. With the team entry selected the right side shows `children`, the team
// knowledge view as it was; it stays mounted while a KB is open so its place is kept. An admin opening a synced note
// sees what Quorum changed in its copy, and a suggestion kept from before the source changed (KbSuggestion).

type Sel = { kbId: string; folderId: string | null };
type Edit = { mode: 'rename'; kbId: string; folderId: string | null; name: string } | { mode: 'new'; kbId: string; parentId: string | null; name: string };
type Doc = { title: string; body: string; note: KbNote };
// a note of a KB hosted by Quorum, open in the note editor; note null is a new note in folderId. open numbers each
// opening, so the view keeps its editor while a save gives a new note its id
type Hosted = { open: number; kbId: string; note: KbNote | null; folderId: string | null };
let opens = 0;
const onDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');

// the team view's way into the left column: where to render its file tree, and how to bring the team view forward
export const TeamSideSlot = createContext<{ slot: HTMLElement | null; showTeam: () => void } | null>(null);
export const useTeamSide = () => useContext(TeamSideSlot);

export function KbBrowser({ me, query, children }: { me: string | null; query: string; children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const [kbs, setKbs] = useState<Kb[] | null>(null);
  const [listError, setListError] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const [sel, setSel] = useState<Sel | null>(null);
  const [notes, setNotes] = useState<Record<string, KbNote[]>>({});
  const [error, setError] = useState('');
  const [doc, setDoc] = useState<Doc | null>(null);
  const [hosted, setHosted] = useState<Hosted | null>(null);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [moving, setMoving] = useState<{ kbId: string; folderId: string } | null>(null);
  const [deleting, setDeleting] = useState<{ kbId: string; folderId: string; name: string } | null>(null);
  const [drag, setDrag] = useState<{ kbId: string; folderId: string } | null>(null);
  const [driving, setDriving] = useState<{ kbId: string; folderId: string | null } | null>(null);
  const [syncing, setSyncing] = useState<{ kbId: string; folderId: string | null; source: SyncSource } | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);
  const refs = useRef(new Map<string, HTMLButtonElement>());

  // one read of the list at a time counts: a later read's answer replaces an earlier one's, never the other way
  const listSeq = useRef(0);
  const seen = useRef(new Set<string>());
  const loadList = useCallback(async () => {
    const seq = ++listSeq.current;
    const r = await kbCall(() => window.quorum.kbList(), 'The knowledge bases could not be read.');
    if (seq !== listSeq.current) return;
    if (r.error) { setListError(r.error); return; }
    setListError('');
    const list = r.kbs ?? [];
    setKbs(list);
    // a KB seen for the first time opens; one the person closed stays closed across refreshes
    const fresh = list.map((k) => rowKey(k.id, null)).filter((k) => !seen.current.has(k));
    for (const k of fresh) seen.current.add(k);
    if (fresh.length) setOpen((s) => new Set([...s, ...fresh]));
    setSel((s) => (s && !list.some((k) => k.id === s.kbId) ? null : s));
  }, []);

  // the notes of each KB, read once per KB until something asks for a refresh. A request per KB carries a number; an
  // answer that is not the latest for its KB is dropped, and a KB with a request on the way is not asked twice
  const noteSeq = useRef(new Map<string, number>());
  const inFlight = useRef(new Set<string>());
  const loadNotes = useCallback(async (kbId: string) => {
    const seq = (noteSeq.current.get(kbId) ?? 0) + 1;
    noteSeq.current.set(kbId, seq);
    inFlight.current.add(kbId);
    const r = await kbCall(() => window.quorum.kbNotes(kbId), 'The notes could not be read.');
    if (noteSeq.current.get(kbId) !== seq) return true;
    inFlight.current.delete(kbId);
    if (r.error) setError(r.error); else setNotes((n) => ({ ...n, [kbId]: r.notes ?? [] }));
    return !r.error;
  }, []);
  const selKbId = sel?.kbId ?? null;
  const haveNotes = selKbId ? !!notes[selKbId] : true;
  useEffect(() => { if (selKbId && !haveNotes && !inFlight.current.has(selKbId)) loadNotes(selKbId); }, [selKbId, haveNotes, loadNotes]);

  // read the list again, and the open KB's notes, when the window comes back, when it becomes visible, and when
  // Settings changes a KB (an import, a rename, new readers)
  const refresh = useLatest(() => { loadList(); if (selKbId) loadNotes(selKbId); });
  useEffect(() => {
    loadList();
    const again = () => refresh.current();
    const visible = () => { if (document.visibilityState === 'visible') refresh.current(); };
    window.addEventListener('focus', again);
    window.addEventListener(KB_CHANGED, again);
    document.addEventListener('visibilitychange', visible);
    return () => { window.removeEventListener('focus', again); window.removeEventListener(KB_CHANGED, again); document.removeEventListener('visibilitychange', visible); };
  }, [loadList, refresh]);

  useEffect(() => {
    if (!menuFor) return;
    const close = () => setMenuFor(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menuFor]);

  const rows = kbs ? visibleRows(kbs, open) : [];
  const kbOf = (id: string) => kbs?.find((k) => k.id === id) ?? null;
  const setKb = (kb: Kb) => setKbs((list) => (list ?? []).map((k) => (k.id === kb.id ? kb : k)));
  const setFolders = (kbId: string, f: (folders: Kb['folders']) => Kb['folders']) => setKbs((list) => (list ?? []).map((k) => (k.id === kbId ? { ...k, folders: f(k.folders) } : k)));
  const openKeys = (keys: string[]) => setOpen((s) => new Set([...s, ...keys]));
  const toggle = (key: string) => setOpen((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const focusRow = (key: string) => { setFocus(key); requestAnimationFrame(() => refs.current.get(key)?.focus()); };
  const select = (s: Sel | null) => { setSel(s); setDoc(null); setHosted(null); setError(''); };

  const rename = async (e: Extract<Edit, { mode: 'rename' }>) => {
    setEdit(null);
    const kb = kbOf(e.kbId);
    if (!kb) return;
    const before = e.folderId ? findFolder(kb.folders, e.folderId)?.name : kb.name;
    const name = e.name.trim();
    if (!name || name === before) { focusRow(rowKey(e.kbId, e.folderId)); return; }
    setError('');
    if (e.folderId) {
      const r = await kbCall(() => window.quorum.kbFolderRename(e.folderId!, name), 'The folder could not be renamed.');
      if (r.error || !r.folder) setError(r.error ?? 'The folder could not be renamed.'); else setFolders(e.kbId, (t) => withFolder(t, r.folder!));
    } else {
      const r = await kbCall(() => window.quorum.kbRename(e.kbId, name), 'The knowledge base could not be renamed.');
      if (r.error || !r.kb) setError(r.error ?? 'The knowledge base could not be renamed.'); else setKb(r.kb);
    }
    focusRow(rowKey(e.kbId, e.folderId));
  };
  const create = async (e: Extract<Edit, { mode: 'new' }>) => {
    setEdit(null);
    const name = e.name.trim();
    if (!name) { focusRow(rowKey(e.kbId, e.parentId)); return; }
    setError('');
    const r = await kbCall(() => window.quorum.kbFolderCreate({ kbId: e.kbId, parentId: e.parentId, name }),'The folder could not be created.');
    if (r.error || !r.folder) { setError(r.error ?? 'The folder could not be created.'); focusRow(rowKey(e.kbId, e.parentId)); return; }
    setFolders(e.kbId, (t) => withFolder(t, r.folder!));
    openKeys([rowKey(e.kbId, e.parentId)]);
    select({ kbId: e.kbId, folderId: r.folder.id });
    focusRow(rowKey(e.kbId, r.folder.id));
  };
  const move = async (kbId: string, folderId: string, parentId: string | null) => {
    const kb = kbOf(kbId);
    if (!kb) return;
    const check = moveCheck(kb.folders, folderId, parentId);
    if (!check.ok) { setError(check.reason); return; }
    setError('');
    const r = await kbCall(() => window.quorum.kbFolderMove({ folderId, parentId }), 'The folder could not be moved.');
    if (r.error || !r.folder) { setError(r.error ?? 'The folder could not be moved.'); return; }
    setFolders(kbId, (t) => withFolder(t, r.folder!));
    openKeys(parentId ? [...openPathTo(kb, parentId), rowKey(kbId, parentId)] : [rowKey(kbId, null)]);
    focusRow(rowKey(kbId, folderId));
  };
  const remove = async (d: { kbId: string; folderId: string }) => {
    setDeleting(null);
    const kb = kbOf(d.kbId);
    if (!kb) return;
    setError('');
    const r = await kbCall(() => window.quorum.kbFolderDelete(d.folderId), 'The folder could not be deleted.');
    if (r.error) { setError(r.error); return; }
    const gone = descendantIds(kb.folders, d.folderId).add(d.folderId);
    setFolders(d.kbId, (t) => withoutFolder(t, d.folderId));
    if (sel?.kbId === d.kbId && sel.folderId && gone.has(sel.folderId)) select({ kbId: d.kbId, folderId: null });
    // the deleted folders' notes moved to the KB's top level on the server
    loadNotes(d.kbId);
    focusRow(rowKey(d.kbId, null));
  };

  const openNote = async (n: KbNote, kbId: string | null = sel?.kbId ?? null) => {
    setError('');
    const inKb = kbId ? kbOf(kbId) : null;
    // a hosted KB's note opens from Supabase in the note editor, for its readers too, since it is in no vault
    if (inKb?.hosted) { setDoc(null); setHosted({ open: ++opens, kbId: inKb.id, note: n, folderId: n.folderId ?? null }); return; }
    setHosted(null);
    if (me && n.userId === me) {
      try {
        const v = await window.quorum.vaultNote(n.path);
        if (v) setDoc({ title: v.title || n.title, body: v.body, note: n }); else setError('That note is not in your vault on this Mac.');
      } catch { setError('That note could not be opened.'); }
      return;
    }
    const r = await kbCall(() => window.quorum.knowledgeRead(n.path), 'That note could not be opened.');
    if (r.error) setError(r.error); else if (r.doc) setDoc({ title: r.doc.title, body: r.doc.body, note: n }); else setError('That note has not synced to this Mac yet.');
  };
  // a [[link]] inside a KB note: resolveKbLink picks the note among the KBs whose notes are loaded, preferring the
  // linking note's folder, then its KB. A note in another folder or KB opens there
  // a note asked for from outside the tab (a chat source card, a quorum://kb link): once its KB's notes are here, the
  // KB opens to the note's folder and the note opens. A request that cannot be met (the list or the notes fail to
  // load, the KB or the note is gone) is dropped with the reason shown, so it never opens something later
  const [opening, setOpening] = useState<KbOpenTarget | null>(() => takeKbOpen());
  useEffect(() => {
    const take = () => { const t = takeKbOpen(); if (t) setOpening(t); };
    window.addEventListener(KB_OPEN, take);
    return () => window.removeEventListener(KB_OPEN, take);
  }, []);
  const openRequested = useLatest(() => {
    if (!opening) return;
    if (!kbs) { if (listError) { setOpening(null); setError(listError); } return; }
    const kb = kbOf(opening.kbId);
    if (!kb) { setOpening(null); setError('That knowledge base is not one you can read.'); return; }
    const list = notes[kb.id];
    if (!list) {
      if (!inFlight.current.has(kb.id)) loadNotes(kb.id).then((ok) => { if (!ok) setOpening(null); });
      return;
    }
    const note = list.find((n) => n.id === opening.noteId);
    setOpening(null);
    if (!note) { select({ kbId: kb.id, folderId: null }); setError('That note is no longer in this knowledge base.'); return; }
    openKeys(openPathTo(kb, note.folderId ?? null));
    setSel({ kbId: kb.id, folderId: note.folderId ?? null });
    openNote(note, kb.id);
  });
  useEffect(() => { openRequested.current(); }, [opening, kbs, notes, listError, openRequested]);

  const follow = (target: string) => {
    if (!sel) return;
    const hit = resolveKbLink(target, { kbId: sel.kbId, note: doc?.note ?? null }, notes);
    if (!hit) { setError(`No note named "${target}" in the knowledge bases loaded here.`); return; }
    if (hit.kbId !== sel.kbId || (hit.note.folderId ?? null) !== (sel.folderId ?? null)) {
      const kb = kbOf(hit.kbId);
      if (kb) openKeys(openPathTo(kb, hit.note.folderId ?? null));
      setSel({ kbId: hit.kbId, folderId: hit.note.folderId ?? null });
    }
    openNote(hit.note, hit.kbId);
  };

  const menuItems = (row: TreeRow): { label: string; run: () => void; danger?: boolean }[] => {
    const items: { label: string; run: () => void; danger?: boolean }[] = [
      { label: row.kind === 'kb' ? 'New folder' : 'New folder inside', run: () => { openKeys([row.key]); setEdit({ mode: 'new', kbId: row.kbId, parentId: row.folderId, name: '' }); } },
      { label: 'Rename', run: () => setEdit({ mode: 'rename', kbId: row.kbId, folderId: row.folderId, name: row.name }) },
    ];
    // a KB hosted by Quorum is written in Quorum, so it takes no connector content
    const hostedKb = !!kbOf(row.kbId)?.hosted;
    if (hasDrive() && !hostedKb) items.push({ label: 'Add from Google Drive', run: () => setDriving({ kbId: row.kbId, folderId: row.folderId }) });
    if (hasKbSync() && !hostedKb) {
      items.push({ label: 'Sync a Drive folder', run: () => setSyncing({ kbId: row.kbId, folderId: row.folderId, source: 'google-drive' }) });
      items.push({ label: 'Sync a GitHub repository', run: () => setSyncing({ kbId: row.kbId, folderId: row.folderId, source: 'github' }) });
    }
    if (row.kind === 'folder') {
      items.push({ label: 'Move to…', run: () => setMoving({ kbId: row.kbId, folderId: row.folderId! }) });
      items.push({ label: 'Delete', danger: true, run: () => setDeleting({ kbId: row.kbId, folderId: row.folderId!, name: row.name }) });
    }
    return items;
  };

  const onTreeKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    const row = rows.find((r) => r.key === focus);
    const rowKb = row ? kbOf(row.kbId) : null;
    const admin = rowKb ? canArrange(rowKb) : false;
    if (row && admin && e.key === 'F2') { e.preventDefault(); setEdit({ mode: 'rename', kbId: row.kbId, folderId: row.folderId, name: row.name }); return; }
    if (row && admin && row.kind === 'folder' && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); setDeleting({ kbId: row.kbId, folderId: row.folderId!, name: row.name }); return; }
    if (row && admin && (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) { e.preventDefault(); setMenuFor(row.key); return; }
    const m = treeKey(rows, focus, e.key);
    if (!m) return;
    e.preventDefault();
    if ('focus' in m) focusRow(m.focus);
    else if ('open' in m) openKeys([m.open]);
    else setOpen((s) => { const n = new Set(s); n.delete(m.close); return n; });
  };

  const canDrop = (row: TreeRow) => !!drag && drag.kbId === row.kbId && kbOf(row.kbId) !== null && moveCheck(kbOf(row.kbId)!.folders, drag.folderId, row.folderId).ok;
  const tabbable = focus && rows.some((r) => r.key === focus) ? focus : rows[0]?.key ?? null;
  const selKb = sel ? kbOf(sel.kbId) : null;
  const anyAdmin = (kbs ?? []).some(canArrange);

  const showTeam = useCallback(() => { setSel(null); setDoc(null); setHosted(null); setError(''); }, []);
  return (
    <TeamSideSlot.Provider value={{ slot, showTeam }}>
      <div className="kbt">
        <aside className="tk-side kbt-side">
          <div className="tk-tree">
            <button className={`tk-item ${sel ? '' : 'sel'}`} aria-current={sel ? undefined : 'page'} onClick={showTeam}>
              <IconBrain width={14} height={14} /><span className="tk-item-text"><span>Team knowledge</span></span>
            </button>
            <div ref={setSlot} className="kbt-slot" />
            <h4 className="kbt-head" id="kbt-label">Knowledge bases</h4>
            {listError && <p className="error kbt-note" role="alert">{listError}</p>}
            {kbs && !kbs.length && <p className="tk-empty kbt-note">No knowledge bases you can read yet.</p>}
            <div role="tree" aria-labelledby="kbt-label" onKeyDown={onTreeKey}>
              {rows.map((row) => {
                const kb = kbOf(row.kbId)!;
                const admin = canArrange(kb);
                const isSel = sel?.kbId === row.kbId && (sel.folderId ?? null) === row.folderId;
                const renaming = edit?.mode === 'rename' && edit.kbId === row.kbId && edit.folderId === row.folderId ? edit : null;
                const adding = edit?.mode === 'new' && edit.kbId === row.kbId && edit.parentId === row.folderId ? edit : null;
                return (
                  <div key={row.key} role="none">
                    <div role="none" className={`kbt-row ${dropKey === row.key ? 'drop' : ''}`}
                      onDragOver={(e) => { if (canDrop(row)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropKey(row.key); } }}
                      onDragLeave={() => setDropKey((k) => (k === row.key ? null : k))}
                      onDrop={(e) => { e.preventDefault(); setDropKey(null); if (drag && canDrop(row)) move(drag.kbId, drag.folderId, row.folderId); setDrag(null); }}>
                      {renaming ? (
                        <NameInput depth={row.depth} label={`New name for ${row.name}`} value={renaming.name} onChange={(name) => setEdit({ ...renaming, name })} onDone={(ok) => (ok ? rename(renaming) : (setEdit(null), focusRow(row.key)))} />
                      ) : (
                        <button role="treeitem" ref={(el) => { if (el) refs.current.set(row.key, el); else refs.current.delete(row.key); }}
                          aria-level={row.depth + 1} aria-expanded={row.hasChildren ? row.expanded : undefined} aria-selected={isSel}
                          tabIndex={tabbable === row.key ? 0 : -1} className={`tk-item ${isSel ? 'sel' : ''}`} style={{ paddingLeft: 8 + row.depth * 14 }}
                          draggable={admin && row.kind === 'folder'}
                          onDragStart={(e) => { if (row.folderId) { setDrag({ kbId: row.kbId, folderId: row.folderId }); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', row.name); } }}
                          onDragEnd={() => { setDrag(null); setDropKey(null); }}
                          onFocus={() => setFocus(row.key)}
                          onContextMenu={(e) => { if (admin) { e.preventDefault(); setMenuFor(row.key); } }}
                          onClick={() => { setFocus(row.key); if (row.hasChildren && (isSel || !row.expanded)) toggle(row.key); select({ kbId: row.kbId, folderId: row.folderId }); }}>
                          {row.hasChildren ? <IconChevron width={12} height={12} className={row.expanded ? '' : 'closed'} /> : <span className="kbt-spacer" />}
                          {row.kind === 'kb' ? <IconStack width={14} height={14} /> : <IconFolder width={14} height={14} />}
                          <span className="tk-item-text"><span>{row.name}</span></span>
                        </button>
                      )}
                      {admin && !renaming && (
                        <button className="kbt-more" tabIndex={-1} aria-label={`Actions for ${row.name}`} aria-haspopup="menu" aria-expanded={menuFor === row.key} onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === row.key ? null : row.key); }}><IconMore width={14} height={14} /></button>
                      )}
                      {menuFor === row.key && <RowMenu items={menuItems(row)} onClose={() => { setMenuFor(null); }} onEscape={() => { setMenuFor(null); focusRow(row.key); }} />}
                    </div>
                    {adding && <div role="none" className="kbt-row"><NameInput depth={row.depth + 1} label="New folder name" value={adding.name} onChange={(name) => setEdit({ ...adding, name })} onDone={(ok) => (ok ? create(adding) : (setEdit(null), focusRow(row.key)))} /></div>}
                  </div>
                );
              })}
            </div>
          </div>
          <p className="tk-side-foot muted">{anyAdmin ? 'Drag a folder to move it. F2 renames, Delete removes, Shift+F10 opens the menu.' : 'Read-only. Admins and editors arrange the folders.'}</p>
        </aside>
        <section className="kbt-main">
          <div className="kbt-team" hidden={!!(sel && selKb)}>{children}</div>
          {!sel || !selKb ? null : hosted && hosted.kbId === selKb.id ? (
            <KbHostedNote key={hosted.open} kb={selKb} note={hosted.note} folderId={hosted.folderId}
              onBack={() => setHosted(null)} onChanged={() => loadNotes(selKb.id)}
              onMoved={(folderId) => { openKeys(openPathTo(selKb, folderId)); setSel({ kbId: selKb.id, folderId }); }}
              onDeleted={() => { setHosted(null); loadNotes(selKb.id); }}
              onSaved={(n) => setHosted((h) => (h ? { ...h, note: n, folderId: n.folderId } : h))} />
          ) : doc ? (
            <>
              <div className="tk-subhead">
                <button className="tk-back" onClick={() => setDoc(null)}><IconBack width={16} height={16} />{sel.folderId ? findFolder(selKb.folders, sel.folderId)?.name ?? selKb.name : selKb.name}</button>
                <span className="tk-crumb">{doc.note.path}</span>
              </div>
              {error && <p className="error tk-error" role="alert">{error}</p>}
              <div className="tk-body"><article className="tk-doc">
                <h1>{doc.title}</h1>
                {selKb.role === 'admin' && <KbSuggestionBanner key={doc.note.id} noteId={doc.note.id} onApplied={(d) => setDoc({ ...doc, title: d.title || doc.title, body: d.body })} />}
                <Markdown text={doc.body} headings onWiki={follow} />
              </article></div>
            </>
          ) : (
            <FolderView kb={selKb} folderId={sel.folderId} notes={notes[selKb.id] ?? null} query={query} error={error}
              onFolder={(id) => { openKeys(openPathTo(selKb, id)); select({ kbId: selKb.id, folderId: id }); }} onNote={(n) => openNote(n, selKb.id)}
              onNew={selKb.writable ? () => setHosted({ open: ++opens, kbId: selKb.id, note: null, folderId: sel.folderId }) : undefined} />
          )}
        </section>
        {moving && kbOf(moving.kbId) && (
          <MoveDialog kb={kbOf(moving.kbId)!} folderId={moving.folderId} onDone={(target) => { const m = moving; setMoving(null); if (target !== undefined) move(m.kbId, m.folderId, target); else focusRow(rowKey(m.kbId, m.folderId)); }} />
        )}
        {driving && kbOf(driving.kbId) && (
          <DriveDialog kb={kbOf(driving.kbId)!} folderId={driving.folderId} onChanged={() => loadNotes(driving.kbId)}
            onDone={() => { const d = driving; setDriving(null); focusRow(rowKey(d.kbId, d.folderId)); }} />
        )}
        {syncing && kbOf(syncing.kbId) && (
          <SyncDialog kb={kbOf(syncing.kbId)!} folderId={syncing.folderId} source={syncing.source} onChanged={() => loadNotes(syncing.kbId)}
            onDone={() => { const d = syncing; setSyncing(null); focusRow(rowKey(d.kbId, d.folderId)); }} />
        )}
        {deleting && (
          <KbConfirm title={`Delete ${deleting.name}?`} body="The folders inside it are deleted too. Its notes stay in the knowledge base, at the top level." action="Delete folder"
            onDone={(ok) => { const d = deleting; if (ok) remove(d); else { setDeleting(null); focusRow(rowKey(d.kbId, d.folderId)); } }} />
        )}
      </div>
    </TeamSideSlot.Provider>
  );
}

function NameInput({ depth, label, value, onChange, onDone }: { depth: number; label: string; value: string; onChange: (v: string) => void; onDone: (ok: boolean) => void }) {
  const done = useRef(false);
  const finish = (ok: boolean) => { if (done.current) return; done.current = true; onDone(ok); };
  return (
    <span className="tk-item kbt-input" style={{ paddingLeft: 8 + depth * 14 }}>
      <IconFolder width={14} height={14} />
      <input autoFocus aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} onBlur={() => finish(value.trim() !== '')}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); } }} />
    </span>
  );
}

function RowMenu({ items, onClose, onEscape }: { items: { label: string; run: () => void; danger?: boolean }[]; onClose: () => void; onEscape: () => void }) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...e.currentTarget.querySelectorAll('button')];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onEscape(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); buttons[(i + 1) % buttons.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); buttons[(i - 1 + buttons.length) % buttons.length]?.focus(); }
    e.stopPropagation();
  };
  return (
    <div className="menu kbt-menu" role="menu" onKeyDown={onKey} onClick={(e) => e.stopPropagation()}>
      {items.map((it, i) => <button key={it.label} ref={i === 0 ? first : undefined} role="menuitem" className={it.danger ? 'danger-pill' : undefined} onClick={() => { onClose(); it.run(); }}>{it.label}</button>)}
    </div>
  );
}

// Add from Google Drive, from a folder's menu: the Drive panel for that folder in a dialog; Escape or Done closes it
function DriveDialog({ kb, folderId, onChanged, onDone }: { kb: Kb; folderId: string | null; onChanged: () => void; onDone: () => void }) {
  const done = useLatest(onDone);
  useEffect(() => {
    const esc = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('[role="alertdialog"]')) { e.stopPropagation(); done.current(); } };
    window.addEventListener('keydown', esc, true);
    return () => window.removeEventListener('keydown', esc, true);
  }, [done]);
  return (
    <div className="palette-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onDone(); }}>
      <div className="modal kb-drive-modal" role="dialog" aria-modal="true" aria-labelledby="kbt-drive-title">
        <h2 id="kbt-drive-title">Add from Google Drive</h2>
        <DrivePanel kb={kb} folderId={folderId} onChanged={onChanged} onDone={onDone} />
      </div>
    </div>
  );
}

// Sync a Drive folder or a GitHub repository, from a folder's menu: the synced-folders panel for that folder in a
// dialog; Escape or Done closes it
function SyncDialog({ kb, folderId, source, onChanged, onDone }: { kb: Kb; folderId: string | null; source: SyncSource; onChanged: () => void; onDone: () => void }) {
  const done = useLatest(onDone);
  useEffect(() => {
    const esc = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('[role="alertdialog"]')) { e.stopPropagation(); done.current(); } };
    window.addEventListener('keydown', esc, true);
    return () => window.removeEventListener('keydown', esc, true);
  }, [done]);
  return (
    <div className="palette-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onDone(); }}>
      <div className="modal kb-drive-modal" role="dialog" aria-modal="true" aria-labelledby="kbt-sync-title">
        <h2 id="kbt-sync-title">{source === 'github' ? 'Sync a GitHub repository' : 'Sync a Drive folder'}</h2>
        <SyncPanel kb={kb} folderId={folderId} source={source} onChanged={onChanged} onDone={onDone} />
      </div>
    </div>
  );
}

// Move to…: the places the folder can go, nested by depth; picking one moves it, Escape or Cancel keeps it
function MoveDialog({ kb, folderId, onDone }: { kb: Kb; folderId: string; onDone: (parentId: string | null | undefined) => void }) {
  const targets = moveTargets(kb.folders, folderId);
  const name = findFolder(kb.folders, folderId)?.name ?? 'the folder';
  const done = useLatest(onDone);
  useEffect(() => {
    const esc = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); done.current(undefined); } };
    window.addEventListener('keydown', esc, true);
    return () => window.removeEventListener('keydown', esc, true);
  }, [done]);
  return (
    <div className="palette-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onDone(undefined); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="kbt-move-title">
        <h2 id="kbt-move-title">Move {name}</h2>
        <p>Choose where it goes inside {kb.name}.</p>
        <div className="kbt-targets">
          {targets.map((t, i) => (
            <button key={t.id ?? 'top'} autoFocus={i === 0} className="tk-item" style={{ paddingLeft: 8 + t.depth * 14 }} onClick={() => onDone(t.id)}>
              {t.id ? <IconFolder width={14} height={14} /> : <IconStack width={14} height={14} />}<span className="tk-item-text"><span>{t.id ? t.label : `${kb.name} (top level)`}</span></span>
            </button>
          ))}
          {!targets.length && <p className="tk-empty">There is nowhere else to move it.</p>}
        </div>
        <div className="modal-actions"><span /><span className="modal-actions-end"><button className="pill" autoFocus={!targets.length} onClick={() => onDone(undefined)}>Cancel</button></span></div>
      </div>
    </div>
  );
}

function FolderView({ kb, folderId, notes, query, error, onFolder, onNote, onNew }: { kb: Kb; folderId: string | null; notes: KbNote[] | null; query: string; error: string; onFolder: (id: string) => void; onNote: (n: KbNote) => void; onNew?: () => void }) {
  const folder = folderId ? findFolder(kb.folders, folderId) : null;
  const subfolders = folderId ? folder?.children ?? [] : kb.folders;
  const shown = notes ? notesIn(notes, folderId).filter((n) => matchesQuery({ title: n.title, rel: n.path }, query)) : null;
  const crumb = [kb.name, ...(folderId ? folderPath(kb.folders, folderId) : [])].join(' / ');
  return (
    <>
      <div className="tk-subhead">
        <span className="tk-crumb"><IconStack width={14} height={14} /> {crumb}</span>
        {onNew && <button className="pill small with-icon" onClick={onNew}><IconPlus width={14} height={14} />New note</button>}
        {kb.hosted && !kb.writable && kb.role !== 'reader' && <span className="muted">Read-only until the workspace's plan is renewed</span>}
      </div>
      <div className="tk-body"><div className="tk-col">
        {error && <p className="error" role="alert">{error}</p>}
        <div className="set-card tk-list kbt-list">
          {subfolders.map((f) => (
            <button key={f.id} className="tk-row" onClick={() => onFolder(f.id)}>
              <IconFolder width={18} height={18} />
              <span className="tk-text"><strong>{f.name}</strong><em>Folder</em></span>
              <span className="tk-when" />
            </button>
          ))}
          {shown?.map((n) => (
            <button key={n.id} className="tk-row" onClick={() => onNote(n)}>
              <IconDoc width={18} height={18} />
              <span className="tk-text"><strong>{n.title}</strong><em>{n.path}</em></span>
              <span className="tk-when">{onDate(n.updatedAt)}</span>
            </button>
          ))}
          {notes === null && !error && <p className="tk-empty">Loading…</p>}
          {shown && !shown.length && !subfolders.length && <p className="tk-empty">{query.trim() && notesIn(notes ?? [], folderId).length ? `No note here matches "${query}".` : 'Nothing in this folder yet.'}</p>}
        </div>
      </div></div>
    </>
  );
}
