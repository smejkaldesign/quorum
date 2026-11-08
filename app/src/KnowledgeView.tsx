import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import type { TreeSort, Brain, TreeItem } from './quorum';
import { Graph, type GraphData, type GraphView } from './Graph';
import { NotePanel, Palette, type PaletteItem, type PaletteMode } from './NoteTools';
import { LinkHealth, leftAsIs } from './LinkHealth';
import { Markdown } from './Markdown';
import { useSession } from './session';
import { IconChevron, IconClose, IconCollapse, IconFolder, IconGraph, IconNewFolder, IconNewNote, IconHistory, IconLink, IconMore, IconReset, IconSearch, IconSidebar, IconSliders, IconSort } from './icons';

type Creating = { kind: 'note' | 'folder'; parent: string } | null;
type Preview = { rel: string; title: string; body: string; abs: string; app: string } | null;

export type KbCommand = { kind: 'switcher' | 'search' | 'palette'; n: number } | { kind: 'open'; rel: string; n: number } | null;

export function KnowledgeView({ brain, command, extraCommands }: { brain: Brain | null; command?: KbCommand; extraCommands?: PaletteItem[] }) {
  const [tree, setTree] = useState<TreeItem[]>([]);
  const [sort, setSort] = useState<TreeSort>(() => { try { return (localStorage.getItem('quorum.treeSort') as TreeSort) || 'name-asc'; } catch { return 'name-asc'; } });
  const pickSort = async (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    const next = await window.quorum.vaultSortMenu(sort, { x: r.left, y: r.bottom + 4 });
    if (!next) return;
    setSort(next);
    try { localStorage.setItem('quorum.treeSort', next); } catch {}
  };
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string>('');
  const beforeCollapse = useRef<Set<string> | null>(null);
  const [userCollapsed, setUserCollapsed] = useState(false);
  // only a collapse you asked for shows as active, not the closed tree on first load
  const collapsed = userCollapsed && open.size === 0;
  useEffect(() => { if (open.size) setUserCollapsed(false); }, [open]);
  const toggleCollapse = () => {
    if (!collapsed) { beforeCollapse.current = open; setOpen(new Set()); setUserCollapsed(true); return; }
    setUserCollapsed(false);
    const focus = preview?.rel ?? selected;
    setOpen(new Set([...(beforeCollapse.current ?? []), ...(focus ? ancestors(focus) : [])]));
    beforeCollapse.current = null;
    if (focus) requestAnimationFrame(() => document.querySelector('.kb-item.sel')?.scrollIntoView({ block: 'nearest' }));
  };
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState<Creating>(null);
  const [preview, setPreview] = useState<Preview>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [openRel, setOpenRel] = useSession<string>('note', '');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const dragging = useRef<string | null>(null);
  const [view, setView] = useState<GraphView | null>(null);
  const [panel, setPanel] = useState(false);
  // the links and outline panel starts closed; the choice sticks on this Mac
  const [side, setSide] = useState(false);
  const toggleSide = () => setSide((o) => !o);
  const [lapse, setLapse] = useState(0);
  const endLapse = useCallback(() => setLapse(0), []);
  const [palette, setPalette] = useState<PaletteMode | null>(null);
  const [scope, setScope] = useState<{ search?: string; moving?: string }>({});
  const [health, setHealth] = useState<{ focus: string | null } | null>(null);
  // Link health is a takeover laid over the graph: the graph fades back as it fades in, and the reverse on close
  const [healthShown, setHealthShown] = useState<{ focus: string | null } | null>(null);
  useEffect(() => {
    if (health) { setHealthShown(health); return; }
    const t = setTimeout(() => setHealthShown(null), 240);
    return () => clearTimeout(t);
  }, [health]);
  // missing links nobody has reviewed yet; the button goes red while there are any
  const [issues, setIssues] = useState(0);
  const countIssues = useCallback(() => {
    window.quorum.vaultLinkHealth().then((h) => { const left = leftAsIs(); setIssues(h.filter((m) => !left.has(m.target.toLowerCase())).length); });
  }, []);
  useEffect(() => { countIssues(); }, [graph, countIssues]);
  useEffect(() => { if (command?.kind === 'open') openNote(command.rel); else if (command) { setScope({}); setPalette(command.kind); } }, [command]);

  const load = useCallback(async () => {
    const [t, g] = await Promise.all([window.quorum.vaultTree(), window.quorum.vaultGraph()]);
    setTree(t);
    setGraph(g);
    // your own tweaks win over the vault's graph.json until you reset them
    let saved: Partial<GraphView> = {};
    try { saved = JSON.parse(localStorage.getItem('quorum.graphView') ?? '{}'); } catch {}
    if (g) setView((v) => v ?? { ...g.settings, ...saved });
  }, []);

  const tweak = (patch: Partial<GraphView>) => setView((v) => {
    if (!v) return v;
    const next = { ...v, ...patch };
    try {
      const diff = Object.fromEntries(Object.entries(next).filter(([k, val]) => graph?.settings[k as keyof GraphView] !== val));
      localStorage.setItem('quorum.graphView', JSON.stringify(diff));
    } catch {}
    return next;
  });
  const resetView = () => { try { localStorage.removeItem('quorum.graphView'); } catch {} if (graph) setView(graph.settings); };
  useEffect(() => { load(); }, [load, brain]);
  // Claude (or anything else) edited the vault: refresh the tree and graph in place, and the open note if it changed
  const previewRel = useRef('');
  previewRel.current = preview?.rel ?? '';
  useEffect(() => window.quorum.onVaultChanged((rels) => {
    load();
    const open = previewRel.current;
    if (open && rels.includes(open)) {
      window.quorum.vaultNote(open).then((n) => { if (n) setPreview((pv) => (pv?.rel === open ? { rel: open, ...n } : pv)); else setPreview(null); });
    }
  }), [load]);
  // reopen the note that was showing before a reload, then keep tracking whichever one is open
  useEffect(() => { if (openRel) openNote(openRel); }, []);
  useEffect(() => { setOpenRel(preview?.rel ?? ''); }, [preview?.rel, setOpenRel]);
  // the open page shows selected in the tree, with its folders expanded and the row scrolled as high as it goes
  useEffect(() => {
    const rel = preview?.rel;
    if (!rel) return;
    setOpen((o) => new Set([...o, ...ancestors(rel)]));
    const t = setTimeout(() => document.querySelector('.kb-item.sel')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 60);
    return () => clearTimeout(t);
  }, [preview?.rel]);

  const openNote = useCallback(async (rel: string) => {
    setSelected(rel);
    const n = await window.quorum.vaultNote(rel);
    if (n) setPreview({ rel, ...n });
  }, []);

  // clicking a note in the graph zooms to it and its links; the title in the header opens it
  // a ghost node is a link to a missing note: open Link health on it instead
  const openGraphNode = useCallback((id: string) => {
    if (id.startsWith('?')) { setPanel(false); setHealth({ focus: id.slice(1) }); } else setFocus(id);
  }, []);

  // [[links]] in an open note resolve the way the graph does, then open inside Quorum
  const openLink = useCallback(async (target: string) => {
    const rel = await window.quorum.vaultResolve(target, previewRel.current || '');
    if (rel) openNote(rel);
    else flash(`No note named "${target}" yet`);
  }, [openNote]);

  async function quickCreate(name: string) {
    const folder = tree.some((t) => t.dir && t.path === '00-inbox') ? '00-inbox' : '';
    const rel = await window.quorum.vaultNewNote(folder, name);
    await load();
    openNote(rel);
  }

  const noteRels = useMemo(() => graph?.nodes.map((n) => n.id) ?? [], [graph]);
  const commands: PaletteItem[] = [
    { id: 'new-note', label: 'New note', hint: '⌘N', run: () => startCreate('note') },
    { id: 'new-folder', label: 'New folder', run: () => startCreate('folder') },
    { id: 'switcher', label: 'Open a note', hint: '⌘O', run: () => setTimeout(() => setPalette('switcher'), 0) },
    { id: 'search', label: 'Search inside notes', hint: '⌘⇧F', run: () => setTimeout(() => setPalette('search'), 0) },
    { id: 'graph', label: 'Show graph view', run: () => setPreview(null) },
    { id: 'graph-settings', label: 'Graph settings', run: () => { setPreview(null); setPanel(true); } },
    { id: 'link-health', label: 'Link health: fix missing links', run: () => { setPreview(null); setPanel(false); setHealth({ focus: null }); } },
    { id: 'timelapse', label: 'Start timelapse animation', run: () => { setPreview(null); setLapse(Date.now()); } },
    { id: 'collapse', label: 'Collapse all folders', run: () => { if (!collapsed) toggleCollapse(); } },
    ...(preview ? [
      { id: 'rename', label: 'Rename this note', hint: 'F2', run: () => setRenaming(preview.rel) },
      { id: 'reveal', label: `Show this note in ${preview.app}`, run: () => window.quorum.vaultReveal(preview.rel) },
    ] : []),
    ...(extraCommands ?? []),
  ];

  // the folder new things land in: the selected folder, or the selected note's folder
  const targetFolder = () => {
    if (!selected) return '';
    const isDir = findItem(tree, selected)?.dir;
    return isDir ? selected : selected.split('/').slice(0, -1).join('/');
  };

  async function create(name: string) {
    if (!creating) return;
    const c = creating;
    setCreating(null);
    if (!name.trim()) return;
    const rel = c.kind === 'note' ? await window.quorum.vaultNewNote(c.parent, name) : await window.quorum.vaultNewFolder(c.parent, name);
    await load();
    setOpen((o) => new Set([...o, ...ancestors(rel), ...(c.kind === 'folder' ? [rel] : [])]));
    if (c.kind === 'note') openNote(rel);
    else setSelected(rel);
  }

  const startCreate = (kind: 'note' | 'folder') => {
    const parent = targetFolder();
    setOpen((o) => new Set([...o, ...(parent ? [parent, ...ancestors(parent)] : [])]));
    setCreating({ kind, parent });
  };

  const flash = (msg: string) => { setNotice(msg); setTimeout(() => setNotice(''), 4000); };
  const linksMsg = (r: { files: number; links: number }) => `Updated ${r.links} ${r.links === 1 ? 'link' : 'links'} in ${r.files} ${r.files === 1 ? 'note' : 'notes'}`;
  const errText = (e: unknown) => String(e).replace(/^.*Error:\s*/, '');

  // keep open folders, the selection and the open preview pointing at the same things after a rename or move
  const followMove = (from: string, to: string) => {
    const swap = (p: string) => (p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : p);
    setOpen((o) => new Set([...o].map(swap)));
    setSelected((sel) => swap(sel));
    setPreview((pv) => (pv ? { ...pv, rel: swap(pv.rel) } : pv));
  };

  async function rename(it: TreeItem, name: string) {
    setRenaming(null);
    if (!name.trim() || name.trim() === it.name) return;
    try { const r = await window.quorum.vaultRename(it.path, name); followMove(it.path, r.rel); await load(); if (r.links) flash(linksMsg(r)); } catch (e) { flash(errText(e)); }
  }

  async function trash(rel: string) {
    if (!(await window.quorum.vaultTrash(rel))) return;
    setPreview((pv) => (pv && (pv.rel === rel || pv.rel.startsWith(`${rel}/`)) ? null : pv));
    setSelected('');
    await load();
  }

  async function menu(it: TreeItem, at?: { x: number; y: number }) {
    setSelected(it.path);
    const pick = await window.quorum.vaultMenu(it.path, it.dir, at);
    if (pick === 'rename') setRenaming(it.path);
    if (pick === 'reveal') window.quorum.vaultReveal(it.path);
    if (pick === 'trash') trash(it.path);
    if (pick === 'new-note') { setOpen((o) => new Set([...o, it.path, ...ancestors(it.path)])); setCreating({ kind: 'note', parent: it.path }); }
    if (pick === 'duplicate') { try { const rel = await window.quorum.vaultDuplicate(it.path); await load(); setSelected(rel); flash(`Duplicated as ${rel.split('/').pop()!.replace(/\.md$/, '')}`); } catch (e) { flash(errText(e)); } }
    if (pick === 'move') { setScope({ moving: it.path }); setPalette('move'); }
    if (pick === 'search') { setScope({ search: it.path }); setPalette('search'); }
  }

  async function moveTo(folder: string) {
    const rel = scope.moving;
    if (!rel) return;
    dragging.current = rel;
    await drop(folder);
  }

  async function drop(folder: string) {
    const rel = dragging.current;
    dragging.current = null;
    setDropTarget(null);
    if (!rel || rel.split('/').slice(0, -1).join('/') === folder) return;
    try {
      const r = await window.quorum.vaultMove(rel, folder);
      followMove(rel, r.rel);
      if (folder) setOpen((o) => new Set([...o, folder]));
      await load();
      if (r.links) flash(linksMsg(r));
    } catch (e) { flash(errText(e)); }
  }

  const onTreeKey = (e: ReactKeyboardEvent) => {
    if (renaming || !selected || (e.target as HTMLElement).tagName === 'INPUT') return;
    if (e.key === 'F2') { e.preventDefault(); setRenaming(selected); }
    if (e.key === 'Backspace' && e.metaKey) { e.preventDefault(); trash(selected); }
  };

  const ops: TreeOps = {
    open: null, selected, creating, renaming, dropTarget,
    onToggle: (p) => { setSelected(p); setOpen((o) => { const n = new Set(o); if (n.has(p)) n.delete(p); else n.add(p); return n; }); },
    onOpen: openNote, onCreate: create, onRename: rename, onMenu: menu,
    onDragStart: (p) => { dragging.current = p; }, onDragOver: setDropTarget, onDrop: drop,
  };

  const focusName = focus ? graph?.nodes.find((n) => n.id === focus)?.name ?? null : null;
  const q = query.trim().toLowerCase();
  const sorted = useMemo(() => sortTree(tree, sort), [tree, sort]);
  const filtered = useMemo(() => (q ? filterTree(sorted, q) : sorted), [sorted, q]);

  return (
    <div className="knowledge">
      <aside className="kb-side">
        <div className="kb-tools">
          <button className="icon-btn" data-tip="New note" aria-label="New note" onClick={() => startCreate('note')}><IconNewNote /></button>
          <button className="icon-btn" data-tip="New folder" aria-label="New folder" onClick={() => startCreate('folder')}><IconNewFolder /></button>
          <button className="icon-btn" data-tip="Change sort order" aria-label="Change sort order" aria-haspopup="menu" onClick={pickSort}><IconSort /></button>
          <button className={`icon-btn ${collapsed ? 'active' : ''}`} aria-pressed={collapsed} data-tip={collapsed ? 'Expand back' : 'Collapse all'} aria-label={collapsed ? 'Expand back' : 'Collapse all'} onClick={toggleCollapse}><IconCollapse /></button>
        </div>
        <label className="kb-search">
          <IconSearch width={15} height={15} />
          <input value={query} placeholder="Search notes" onChange={(e) => setQuery(e.target.value)} />
        </label>
        <div className={`kb-tree ${dropTarget === '' ? 'drop' : ''}`} role="tree" onKeyDown={onTreeKey}
          onDragOver={(e) => { if (dragging.current) { e.preventDefault(); setDropTarget(''); } }}
          onDragLeave={(e) => { if (e.currentTarget === e.target) setDropTarget(null); }}
          onDrop={(e) => { e.preventDefault(); drop(''); }}>
          {creating && creating.parent === '' && <NewItemRow kind={creating.kind} depth={0} onDone={create} />}
          <TreeLevel items={filtered} depth={0} ops={{ ...ops, open: q ? null : open }} />
        </div>
        <p className="kb-soon" role="status">{notice || 'Right-click to rename or delete · Drag to move'}</p>
      </aside>

      <section className="kb-main">
        <div className="kb-head">
          {preview ? (
            <>
              <span className="kb-title"><IconGraph width={16} height={16} />
                <button className="kb-crumb" onClick={() => { setFocus(null); setPreview(null); }}>Graph</button>
                <span className="kb-sep">/</span>
                <span className="kb-here">{preview.title}</span>
              </span>
              <div className="kb-actions">
                <button className="pill ghost" onClick={() => { setFocus(preview.rel); setPreview(null); }}><IconGraph width={16} height={16} /> View in graph</button>
                <button className="pill ghost" onClick={() => window.quorum.openNote(preview.abs)}><IconFolder width={16} height={16} /> Open</button>
                <button className={`icon-btn ${side ? 'active' : ''}`} aria-label={side ? 'Hide links and outline' : 'Show links and outline'} aria-expanded={side}
                  data-tip={side ? 'Hide links and outline' : 'Show links and outline'} onClick={toggleSide}><IconSidebar /></button>
              </div>
            </>
          ) : (
            <>
              {focusName ? (
                <span className="kb-title"><IconGraph width={16} height={16} />
                  <button className="kb-crumb" onClick={() => setFocus(null)}>Graph</button>
                  <span className="kb-sep">/</span>
                  <button className="kb-focus" onClick={() => focus && openNote(focus)}>{focusName}</button>
                </span>
              ) : (
                <span className="kb-title"><IconGraph width={16} height={16} /> Graph</span>
              )}
              <div className="kb-actions">
                <button className={`icon-btn lh-btn ${health ? 'active' : ''} ${issues ? 'alert' : ''}`} aria-label={issues ? `Link health, ${issues} to review` : 'Link health'} aria-pressed={!!health}
                  data-tip={issues ? `Link health · ${issues} to review` : 'Link health'} onClick={() => { setPanel(false); setLapse(0); setHealth((h) => (h ? null : { focus: null })); }}>
                  <IconLink />{issues > 0 && <span className="lh-count">{issues}</span>}
                </button>
                <button className={`icon-btn ${panel ? 'active' : ''}`} aria-label="Graph settings" aria-expanded={panel} data-tip="Graph settings" onClick={() => { setHealth(null); setPanel((o) => !o); }}><IconSliders /></button>
                <button className={`icon-btn ${lapse ? 'active' : ''}`} aria-label={lapse ? 'Stop timelapse' : 'Start timelapse animation'} aria-pressed={!!lapse}
                  data-tip={lapse ? 'Stop timelapse' : 'Start timelapse animation'} onClick={() => setLapse((l) => (l ? 0 : Date.now()))}><IconHistory /></button>
              </div>
            </>
          )}
        </div>
        {preview ? (
          <div className={`kb-preview ${side ? "side-open" : ""}`}>
            <article className="doc">
              <p className="kb-path">{preview.rel}</p>
              <h1>{preview.title}</h1>
              <Markdown text={preview.body} headings root={brain?.root} onWiki={openLink} />
            </article>
            <NotePanel rel={preview.rel} body={preview.body} onOpen={openNote} onResolve={openLink} />
          </div>
        ) : graph ? (
          <>
            <div className={`kb-stage ${health ? 'taken-over' : ''}`}>
              {view && <Graph data={graph} view={view} query={query} focus={focus} timelapse={lapse} onOpen={openGraphNode} onTimelapseEnd={endLapse} />}
              {healthShown && (
                <div className={`kb-takeover ${health ? 'in' : 'out'}`}>
                  <LinkHealth focus={healthShown.focus} onOpen={openNote} onCreate={(name) => { quickCreate(name); }} onClose={() => setHealth(null)} onChanged={() => { load(); countIssues(); }} />
                </div>
              )}
            </div>
            {panel && view && <GraphPanel view={view} groups={graph.groups} onChange={tweak} onReset={resetView} onClose={() => setPanel(false)} />}
          </>
        ) : <div className="end-loading"><span className="spinner big" /><p>Building graph…</p></div>}
      </section>
      {palette && <Palette mode={palette} notes={noteRels} commands={commands} onOpen={openNote} onCreate={quickCreate} onClose={() => { setPalette(null); setScope({}); }}
        scope={palette === 'search' ? scope.search : undefined} folders={folderRels(tree).filter((f) => f !== scope.moving && !f.startsWith(`${scope.moving}/`))} onMove={moveTo} />}
    </div>
  );
}

const SLIDERS: Record<string, { key: keyof GraphView; label: string; min: number; max: number; step: number }[]> = {
  Display: [
    { key: 'textFadeMultiplier', label: 'Text fade threshold', min: -3, max: 3, step: 0.1 },
    { key: 'nodeSizeMultiplier', label: 'Node size', min: 0.1, max: 5, step: 0.05 },
    { key: 'lineSizeMultiplier', label: 'Link thickness', min: 0.1, max: 5, step: 0.05 },
  ],
  Forces: [
    { key: 'centerStrength', label: 'Center force', min: 0, max: 1, step: 0.01 },
    { key: 'repelStrength', label: 'Repel force', min: 0, max: 20, step: 0.01 },
    { key: 'linkStrength', label: 'Link force', min: 0, max: 1, step: 0.01 },
    { key: 'linkDistance', label: 'Link distance', min: 30, max: 500, step: 1 },
  ],
};

// Obsidian's graph settings, same four sections; changes apply live
function GraphPanel({ view, groups, onChange, onReset, onClose }: {
  view: GraphView; groups: GraphData['groups']; onChange: (p: Partial<GraphView>) => void; onReset: () => void; onClose: () => void;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set(['Forces']));
  const toggle = (name: string) => setOpen((o) => { const n = new Set(o); if (n.has(name)) n.delete(name); else n.add(name); return n; });
  const section = (name: string, body: ReactNode, actions?: ReactNode) => (
    <section className="gp-section">
      <div className="gp-head">
        <button className="gp-toggle" aria-expanded={open.has(name)} onClick={() => toggle(name)}>
          <IconChevron className={open.has(name) ? '' : 'closed'} />{name}
        </button>
        {actions}
      </div>
      {open.has(name) && <div className="gp-body">{body}</div>}
    </section>
  );
  const sliders = (name: string) => SLIDERS[name].map((sl) => {
    const val = view[sl.key] as number;
    const pct = ((val - sl.min) / (sl.max - sl.min)) * 100;
    return (
      <label key={sl.key} className="gp-slider">
        <span>{sl.label}</span>
        <div className="gp-range">
          <em>{sl.step >= 1 ? Math.round(val) : val.toFixed(2)}</em>
          <input type="range" min={sl.min} max={sl.max} step={sl.step} value={val} style={{ '--pct': `${pct}%` } as CSSProperties}
            onChange={(e) => onChange({ [sl.key]: Number(e.target.value) })} />
        </div>
      </label>
    );
  });
  return (
    <div className="graph-panel" role="dialog" aria-label="Graph settings">
      {section('Filters', (
        <>
        <label className="gp-check">
          <span>Orphans</span>
          <span className="switch"><input type="checkbox" checked={view.showOrphans} onChange={(e) => onChange({ showOrphans: e.target.checked })} /><span className="track"><span className="thumb" /></span></span>
        </label>
        <label className="gp-check">
          <span>Missing notes</span>
          <span className="switch"><input type="checkbox" checked={view.showUnresolved} onChange={(e) => onChange({ showUnresolved: e.target.checked })} /><span className="track"><span className="thumb" /></span></span>
        </label>
        </>
      ), (
        <div className="gp-actions">
          <button className="icon-btn" aria-label="Restore defaults" data-tip="Restore defaults" onClick={onReset}><IconReset width={16} height={16} /></button>
          <button className="icon-btn" aria-label="Close" data-tip="Close" onClick={onClose}><IconClose width={16} height={16} /></button>
        </div>
      ))}
      {section('Groups', groups.length ? (
        <ul className="gp-groups">
          {groups.map((g) => <li key={g.query}><span className="gp-swatch" style={{ background: g.color }} /><code>{g.query}</code></li>)}
        </ul>
      ) : <p className="gp-note">No color groups yet.</p>)}
      {section('Display', sliders('Display'))}
      {section('Forces', sliders('Forces'))}
    </div>
  );
}

type TreeOps = {
  open: Set<string> | null; selected: string; creating: Creating; renaming: string | null; dropTarget: string | null;
  onToggle: (p: string) => void; onOpen: (p: string) => void; onCreate: (name: string) => void;
  onRename: (it: TreeItem, name: string) => void; onMenu: (it: TreeItem, at?: { x: number; y: number }) => void;
  onDragStart: (p: string) => void; onDragOver: (p: string | null) => void; onDrop: (folder: string) => void;
};

function TreeLevel({ items, depth, ops }: { items: TreeItem[]; depth: number; ops: TreeOps }) {
  return (
    <>
      {items.map((it) => {
        const isOpen = ops.open === null || ops.open.has(it.path);
        // drops onto a note land in that note's folder
        const target = it.dir ? it.path : it.path.split('/').slice(0, -1).join('/');
        return (
          <div key={it.path}>
            {ops.renaming === it.path ? (
              <RenameRow item={it} depth={depth} onDone={(name) => ops.onRename(it, name)} />
            ) : (
              <div className="kb-row">
              <button role="treeitem" aria-expanded={it.dir ? isOpen : undefined} draggable
                className={`kb-item ${ops.selected === it.path ? 'sel' : ''} ${it.dir ? 'dir' : ''} ${it.dir && ops.dropTarget === it.path ? 'drop' : ''}`}
                style={{ paddingLeft: 10 + depth * 16 }}
                onClick={() => (it.dir ? ops.onToggle(it.path) : ops.onOpen(it.path))}
                onContextMenu={(e) => { e.preventDefault(); ops.onMenu(it); }}
                onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; ops.onDragStart(it.path); }}
                onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); ops.onDragOver(target); }}
                onDrop={(e) => { e.preventDefault(); e.stopPropagation(); ops.onDrop(target); }}>
                {it.dir ? <IconChevron className={isOpen ? '' : 'closed'} /> : <span className="kb-spacer" />}
                <span>{it.name}</span>
              </button>
              <button className="kb-more" aria-label={`More options for ${it.name}`} data-tip="More options"
                onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); ops.onMenu(it, { x: r.left, y: r.bottom + 4 }); }}>
                <IconMore width={16} height={16} />
              </button>
              </div>
            )}
            {it.dir && isOpen && (
              <>
                {ops.creating && ops.creating.parent === it.path && <NewItemRow kind={ops.creating.kind} depth={depth + 1} onDone={ops.onCreate} />}
                <TreeLevel items={it.children ?? []} depth={depth + 1} ops={ops} />
              </>
            )}
          </div>
        );
      })}
    </>
  );
}

function RenameRow({ item, depth, onDone }: { item: TreeItem; depth: number; onDone: (name: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const finish = (name: string) => { if (!done.current) { done.current = true; onDone(name); } };
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  return (
    <div className="kb-item new" style={{ paddingLeft: 10 + depth * 16 }}>
      {item.dir ? <IconChevron className="closed" /> : <span className="kb-spacer" />}
      <input ref={ref} defaultValue={item.name} aria-label={`Rename ${item.name}`}
        onKeyDown={(e) => { if (e.key === 'Enter') finish(e.currentTarget.value); if (e.key === 'Escape') finish(''); }}
        onBlur={(e) => finish(e.target.value)} />
    </div>
  );
}

function NewItemRow({ kind, depth, onDone }: { kind: 'note' | 'folder'; depth: number; onDone: (name: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div className="kb-item new" style={{ paddingLeft: 10 + depth * 16 }}>
      {kind === 'folder' ? <IconNewFolder width={15} height={15} /> : <IconNewNote width={15} height={15} />}
      <input ref={ref} placeholder={kind === 'note' ? 'Untitled' : 'New folder'}
        onKeyDown={(e) => { if (e.key === 'Enter') onDone((e.target as HTMLInputElement).value || (kind === 'note' ? 'Untitled' : 'New folder')); if (e.key === 'Escape') onDone(''); }}
        onBlur={(e) => onDone(e.target.value)} />
    </div>
  );
}

function folderRels(items: TreeItem[]): string[] {
  return items.flatMap((it) => (it.dir ? [it.path, ...folderRels(it.children ?? [])] : []));
}

function findItem(items: TreeItem[], p: string): TreeItem | undefined {
  for (const it of items) {
    if (it.path === p) return it;
    if (it.children) { const f = findItem(it.children, p); if (f) return f; }
  }
}

// folders stay A to Z on top like Obsidian; the chosen order applies to notes inside each folder
function sortTree(items: TreeItem[], sort: TreeSort): TreeItem[] {
  const byName = (a: TreeItem, b: TreeItem) => a.name.localeCompare(b.name, undefined, { numeric: true });
  const [key, dir] = sort.split('-') as ['name' | 'mtime' | 'ctime', 'asc' | 'desc'];
  const notes = (a: TreeItem, b: TreeItem) => {
    const d = key === 'name' ? byName(a, b) : (a[key] ?? 0) - (b[key] ?? 0) || byName(a, b);
    return dir === 'asc' ? d : -d;
  };
  const dirs = items.filter((i) => i.dir).map((i) => ({ ...i, children: sortTree(i.children ?? [], sort) }));
  dirs.sort((a, b) => (key === 'name' && dir === 'desc' ? -byName(a, b) : byName(a, b)));
  return [...dirs, ...items.filter((i) => !i.dir).sort(notes)];
}

function ancestors(rel: string) {
  const parts = rel.split('/');
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
}

function filterTree(items: TreeItem[], q: string): TreeItem[] {
  const out: TreeItem[] = [];
  for (const it of items) {
    if (it.dir) {
      const kids = filterTree(it.children ?? [], q);
      if (kids.length || it.name.toLowerCase().includes(q)) out.push({ ...it, children: kids });
    } else if (it.name.toLowerCase().includes(q)) out.push(it);
  }
  return out;
}
