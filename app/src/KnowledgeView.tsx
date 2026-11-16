import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { HeadingLinks, slugsOf } from './HeadingLinks';
import { MemoryBell, MemoryNotifications } from './MemoryNotifications';
import { FolderApp } from './FolderApp';
import { NoteMeta, type NoteMetaInfo } from './NoteMeta';
import type { TreeSort, Brain, TreeItem, NoteViews, MemoryDots, MemoryReview, MemoryVersion, LiveRun, LiveState, MissingLink } from './quorum';
import { LiveBanner, ReviewBanner, VersionBar, VersionList, when, type ReviewMode } from './MemoryUpdates';
import { ConfirmModal } from './ConfirmModal';
import { changeBlocks } from '../memoryReview.js';
import { fileIssues, healthMarks, issueOf, type Issue } from '../memoryHealth.js';
import { Graph, type GraphData, type GraphView } from './Graph';
import { NotePanel, Palette, type PaletteItem, type PaletteMode } from './NoteTools';
import { reportMemoryNote } from './navHistory';
import { IssueDrawer, LinkHealth, acceptIssue, dismissIssue, leftOf, migrateLeft, waitFix } from './LinkHealth';
import { Markdown } from './Markdown';
import { useSession } from './session';
import { IconChevron, IconClose, IconCollapse, IconExpand, IconFolder, IconGraph, IconNewFolder, IconNewNote, IconHistory, IconLink, IconMore, IconReset, IconSearch, IconSidebar, IconSliders, IconSort } from './icons';

type Creating = { kind: 'note' | 'folder'; parent: string } | null;
type Preview = { rel: string; title: string; body: string; abs: string; app: string; views?: NoteViews; meta?: NoteMetaInfo | null } | null;

export type KbCommand = { kind: 'switcher' | 'search' | 'palette'; n: number } | { kind: 'health'; key: string; n: number } | { kind: 'open' | 'graph'; rel: string; anchor?: string | null; n: number } | { kind: 'missing'; id: string; n: number } | null;

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
  // review of agent changes (memoryVersions.js): the tree's dots, the open note's banner and Before or After, and a
  // version opened read-only from the side panel. stamp refreshes the versions list after a change
  const [dots, setDots] = useState<MemoryDots>({ files: {}, folders: {} });
  const [review, setReview] = useState<MemoryReview | null>(null);
  const [mode, setMode] = useState<ReviewMode>('after');
  const [version, setVersion] = useState<{ v: MemoryVersion; body: string } | null>(null);
  const [stamp, setStamp] = useState(0);
  const [restoring, setRestoring] = useState(false);
  // highlight starts from Settings > Memory on each open; the banner's button changes it for this view only
  const [highlight, setHighlight] = useState(true);
  // Memory health review of one note: its issues in line order. cursor is the item the arrows are on, in whichever
  // banner shows
  const [issueReview, setIssueReview] = useState<{ line: number; issue: Issue }[] | null>(null);
  const [cursor, setCursor] = useState(-1);
  // the drawer for the issue under the cursor: the arrows, a click on an issue line, and View from Notifications open it
  const [issueOpen, setIssueOpen] = useState(false);
  const [deciding, setDeciding] = useState(false);
  // runs writing notes right now (liveRuns.js): shimmer in the tree and the graph, and a lock with Stop on an open note
  const [live, setLive] = useState<LiveState>({ runs: [], files: {}, folders: [], vault: [] });
  const [confirmStop, setConfirmStop] = useState<LiveRun | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  // the open memory's Notifications, in place of its text while open; its headings' links
  const [notifsOpen, setNotifsOpen] = useState(false);
  // a link to a note that is not on this Mac or shared with this person
  const [missing, setMissing] = useState<string | null>(null);
  // a link's heading: the note's headings numbered the way links number them, then the one that matches
  const scrollToAnchor = (anchor: string) => {
    const tryIt = (left: number) => {
      const hs = [...document.querySelectorAll<HTMLElement>('.kb-preview .mu-text h1, .kb-preview .mu-text h2, .kb-preview .mu-text h3, .kb-preview .mu-text h4')];
      if (!hs.length && left > 0) { window.setTimeout(() => tryIt(left - 1), 120); return; }
      const slugs = slugsOf(hs.map((h) => h.textContent ?? ''));
      const i = slugs.indexOf(anchor) >= 0 ? slugs.indexOf(anchor) : slugs.findIndex((x) => x === anchor.replace(/-\d+$/, ''));
      if (i >= 0) { hs[i].scrollIntoView({ behavior: 'smooth', block: 'start' }); hs[i].classList.add('h-target'); window.setTimeout(() => hs[i].classList.remove('h-target'), 1600); }
    };
    tryIt(15);
  };
  const memRoot = useRef<HTMLDivElement>(null);
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
  // Memory health is a takeover laid over the graph: the graph fades back as it fades in, and the reverse on close
  const [healthShown, setHealthShown] = useState<{ focus: string | null } | null>(null);
  useEffect(() => {
    if (health) { setHealthShown(health); return; }
    const t = setTimeout(() => setHealthShown(null), 240);
    return () => clearTimeout(t);
  }, [health]);
  // missing links nobody has reviewed yet; the button goes red while there are any
  const [issues, setIssues] = useState(0);
  // the open issues on the tree: a red dot on each note that links to a missing note, and on each folder the number of
  // open issues with a linking note inside it
  const [issueMarks, setIssueMarks] = useState<{ files: Record<string, number>; folders: Record<string, number> }>({ files: {}, folders: {} });
  const migrated = useRef<Promise<void> | null>(null);
  const countIssues = useCallback(async () => {
    migrated.current ??= migrateLeft().catch(() => {});
    await migrated.current;
    const h = await window.quorum.vaultLinkHealth();
    const left = leftOf(h);
    setIssues(h.length - left.size);
    setIssueMarks(healthMarks(h, left));
  }, []);
  useEffect(() => { countIssues(); }, [graph, countIssues]);
  // an issue decided anywhere else (Notifications) moves the counts here too
  useEffect(() => { const go = () => { countIssues(); }; window.addEventListener('quorum:activity-changed', go); return () => window.removeEventListener('quorum:activity-changed', go); }, [countIssues]);
  useEffect(() => { if (command?.kind === 'open') { setMissing(null); openNote(command.rel).then(() => { if (command.anchor) scrollToAnchor(command.anchor); }); } else if (command?.kind === 'missing') { setPreview(null); setMissing(command.id); } else if (command?.kind === 'health') { reviewKey(command.key); } else if (command?.kind === 'graph') { setPreview(null); setSelected(command.rel); setFocus(command.rel); } else if (command) { setScope({}); setPalette(command.kind); } }, [command]);

  const load = useCallback(async () => {
    const [t, g] = await Promise.all([window.quorum.vaultTree(), window.quorum.vaultGraph()]);
    setTree(t);
    window.quorum.memoryDots().then(setDots).catch(() => {});
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
  // the note you came from when a link opened this one; its row in the side panel goes back to it
  const [prev, setPrev] = useState<{ rel: string; title: string } | null>(null);
  const viaLink = useRef(false);
  const here = useRef<{ rel: string; title: string } | null>(null);
  here.current = preview ? { rel: preview.rel, title: preview.title } : null;
  // Back from a page opened here reopens this note (navHistory.ts)
  useEffect(() => { reportMemoryNote(preview?.rel ?? null); }, [preview?.rel]);
  useEffect(() => () => reportMemoryNote(null), []);
  // a burst of writes (a sync pull, the keeper filing a meeting) reloads the tree and graph once, after it settles
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const touched = new Set<string>();
    const off = window.quorum.onVaultChanged((rels) => {
      for (const r of rels) touched.add(r);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        load();
        const open = previewRel.current;
        const openChanged = !!open && touched.has(open);
        touched.clear();
        if (openChanged) Promise.all([window.quorum.vaultNote(open), window.quorum.memoryReview(open)]).then(([n, r]) => {
          if (!n) { setPreview(null); return; }
          if (previewRel.current !== open) return;
          setPreview({ rel: open, ...n });
          setReview(r);
          if (r) window.quorum.memoryOpened(open);
        });
      }, 400);
    });
    return () => { off(); if (timer) clearTimeout(timer); };
  }, [load]);
  useEffect(() => { window.quorum.liveRuns().then(setLive).catch(() => {}); return window.quorum.onLiveRuns(setLive); }, []);
  // a note's versions or updates changed: new dots, and a fresh versions list for the open note
  useEffect(() => window.quorum.onMemoryUpdates((rels) => {
    window.quorum.memoryDots().then(setDots).catch(() => {});
    if (rels.includes(previewRel.current)) setStamp((n) => n + 1);
  }), []);
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

  const flash = (msg: string) => { setNotice(msg); setTimeout(() => setNotice(''), 4000); };
  const linksMsg = (r: { files: number; links: number }) => `Updated ${r.links} ${r.links === 1 ? 'link' : 'links'} in ${r.files} ${r.files === 1 ? 'note' : 'notes'}`;
  const errText = (e: unknown) => String(e).replace(/^.*Error:\s*/, '');
  // the arrows: the item becomes current and scrolls into view
  const jump = (at: number, line: number) => {
    setCursor(at);
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    requestAnimationFrame(() => document.querySelector(`.mu-text [data-line="${line}"]`)?.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' }));
  };
  // the review is read before the note counts as opened, so a blue banner shows on the open that clears its dot
  // counts note opens, so the issues of a note opened earlier never land on the one open now
  const opening = useRef(0);
  const openNote = useCallback(async (rel: string) => {
    setMissing(null);
    setSelected(rel);
    const [n, r, s] = await Promise.all([window.quorum.vaultNote(rel), window.quorum.memoryReview(rel).catch(() => null), window.quorum.getSettings().catch(() => null)]);
    const lit = s?.memoryHighlight !== false;
    if (!n) return;
    const from = here.current;
    setPrev(viaLink.current && from && from.rel !== rel ? from : null);
    viaLink.current = false;
    setPreview({ rel, ...n });
    setReview(r);
    setMode('after');
    setVersion(null);
    setIssueReview(null);
    setIssueOpen(false);
    setCursor(-1);
    setHighlight(lit);
    window.quorum.memoryOpened(rel);
    // a note with open Memory health issues (a red dot in the tree) opens with the red banner on its first issue
    const token = ++opening.current;
    const [lines, items] = await Promise.all([window.quorum.vaultFileIssues(rel), window.quorum.vaultLinkHealth()]).catch((): [{ target: string; line: number }[], MissingLink[]] => [[], []]);
    const found = fileIssues(lines, items, leftOf(items));
    if (token !== opening.current || !found.length) return;
    setIssueReview(found);
    setCursor(0);
  }, []);
  const reloadOpen = async (rel: string) => {
    const [n, r] = await Promise.all([window.quorum.vaultNote(rel), window.quorum.memoryReview(rel).catch(() => null)]);
    if (n) setPreview({ rel, ...n });
    setReview(r);
    setStamp((x) => x + 1);
  };
  const accept = async () => {
    if (!preview) return;
    await window.quorum.memoryAccept(preview.rel);
    setReview(null);
    setCursor(-1);
  };
  // Reject puts back the text from before the updates
  const reject = async () => {
    if (!preview) return;
    try {
      await window.quorum.memoryReject(preview.rel);
      await reloadOpen(preview.rel);
      setCursor(-1);
      flash('Rejected. The earlier text is back, and the text it replaced is kept as a version.');
    } catch (e) { flash(errText(e)); }
  };
  // the open note's issues, from Memory health
  const loadIssues = async (rel: string) => {
    const [lines, items] = await Promise.all([window.quorum.vaultFileIssues(rel), window.quorum.vaultLinkHealth()]);
    return fileIssues(lines, items, leftOf(items));
  };
  // Review from a Memory health card: the note opens with its issues marked, on the one the card is about
  const reviewIssue = async (issue: Issue) => {
    setHealth(null);
    await openNote(issue.path);
    const items = await loadIssues(issue.path);
    setIssueReview(items);
    const at = Math.max(0, items.findIndex((x) => x.issue.key === issue.key));
    if (items.length) { jump(at, items[at].line); setIssueOpen(true); }
  };
  // View from a Memory health row in Notifications: the same review, found by the issue's key
  const reviewKey = async (key: string) => {
    const m = (await window.quorum.vaultLinkHealth()).find((x) => x.target.toLowerCase() === key.toLowerCase());
    if (m) await reviewIssue(issueOf(m));
  };
  const decideIssue = async (approve: boolean) => {
    if (!preview || !issueReview || deciding) return;
    const item = issueReview[cursor] ?? issueReview[0];
    if (!item) return;
    setDeciding(true);
    try {
      if (approve) {
        const done = waitFix(item.issue.key);
        flash(await acceptIssue(item.issue));
        const run = await done;
        flash(run.status === 'success' ? run.outcome ?? 'Fixed' : run.error ?? 'Could not fix it');
      } else flash(await dismissIssue(item.issue));
      countIssues();
      await reloadOpen(preview.rel);
      const items = await loadIssues(preview.rel);
      countIssues();
      if (!items.length) { setIssueReview(null); setIssueOpen(false); setCursor(-1); return; }
      setIssueReview(items);
      const at = Math.min(Math.max(cursor, 0), items.length - 1);
      jump(at, items[at].line);
    } catch (e) { flash(errText(e)); } finally { setDeciding(false); }
  };
  // a click on an issue line opens its drawer; a link on that line to a note that exists still opens the note
  const clickIssue = (e: React.MouseEvent) => {
    if (!issueReview || mode !== 'after' || version) return;
    const block = (e.target as HTMLElement).closest<HTMLElement>('.md-issue[data-line]');
    if (!block) return;
    const line = Number(block.dataset.line);
    const here = issueReview.map((x, i) => ({ ...x, i })).filter((x) => x.line === line);
    if (!here.length) return;
    const link = (e.target as HTMLElement).closest('.md-link, a');
    const text = link?.textContent?.trim().toLowerCase();
    const hit = link ? here.find((x) => x.issue.target.toLowerCase() === text || x.issue.target.toLowerCase().split('/').pop() === text) : here[0];
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    setCursor(hit.i);
    setIssueOpen(true);
  };
  const stopRun = async (run: LiveRun) => {
    try {
      const restored = await window.quorum.liveStop(run.id);
      flash(`Stopped. ${restored.length} ${restored.length === 1 ? 'note is' : 'notes are'} back as they were before the run.`);
      if (preview) await reloadOpen(preview.rel);
    } catch (e) { flash(errText(e)); }
  };
  const viewVersion = async (v: MemoryVersion) => {
    if (!preview) return;
    if (version?.v.id === v.id) { setVersion(null); return; }
    const r = await window.quorum.memoryVersion(preview.rel, v.id);
    if (r) setVersion({ v, body: r.body });
  };
  const restore = async () => {
    if (!preview || !version) return;
    setRestoring(true);
    try {
      await window.quorum.memoryRestore(preview.rel, version.v.id);
      const n = await window.quorum.vaultNote(preview.rel);
      if (n) setPreview({ rel: preview.rel, ...n });
      setVersion(null);
      setStamp((x) => x + 1);
      flash('Restored. The text it replaced is kept as a version.');
    } catch (e) { flash(errText(e)); } finally { setRestoring(false); }
  };

  // clicking a note in the graph zooms to it and its links; the title in the header opens it
  // a ghost node is a link to a missing note: open Memory health on it instead
  const openGraphNode = useCallback((id: string) => {
    if (id.startsWith('?')) { setPanel(false); setHealth({ focus: id.slice(1) }); } else setFocus(id);
  }, []);
  // a cluster renamed from the graph badge: saved in main, which answers with every note's cluster name; the graph
  // applies them in place
  const renameCluster = useCallback((key: string, name: string) => window.quorum.vaultClusterName(key, name), []);

  // [[links]] in an open note resolve the way the graph does, then open inside Quorum
  const openLink = useCallback(async (target: string) => {
    const rel = await window.quorum.vaultResolve(target, previewRel.current || '');
    if (rel) { viaLink.current = true; openNote(rel); }
    else flash(`No note named "${target}" yet`);
  }, [openNote]);

  // where a note made from here goes: the inbox when the vault has one
  const inboxFolder = () => (tree.some((t) => t.dir && t.path === '00-inbox') ? '00-inbox' : '');
  async function quickCreate(name: string) {
    const rel = await window.quorum.vaultNewNote(inboxFolder(), name);
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
    { id: 'link-health', label: 'Memory health: fix missing links', run: () => { setPreview(null); setPanel(false); setHealth({ focus: null }); } },
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

  // the open note's run, items for the arrows, and the class of each marked line. After marks the changed lines
  // (while highlight is on) and the issues; Before shows the earlier text with nothing marked
  const openRun = preview ? live.runs.find((r) => r.id === live.files[preview.rel]) ?? null : null;
  const locked = !!openRun;
  const openBody = preview?.body ?? null;
  const blocks = useMemo(() => (review ? changeBlocks(review.changed, openBody) : []), [review, openBody]);
  const marks = useMemo(() => {
    const m = new Map<number, string>();
    if (version || mode !== 'after') return m;
    if (review && highlight) for (const l of review.changed) m.set(l, 'md-chg');
    if (issueReview) issueReview.forEach((it, i) => m.set(it.line, `${m.get(it.line) ?? ''} md-issue${i === cursor ? ' md-cur' : ''}`.trim()));
    else if (cursor >= 0) for (const l of blocks[cursor] ?? []) m.set(l, `${m.get(l) ?? ''} md-cur`.trim());
    return m;
  }, [version, mode, review, highlight, issueReview, cursor, blocks]);
  const navOver = (lines: number[]) => ({
    at: cursor, total: lines.length,
    onPrev: () => { const i = cursor <= 0 ? lines.length - 1 : cursor - 1; jump(i, lines[i]); },
    onNext: () => { const i = cursor < 0 || cursor >= lines.length - 1 ? 0 : cursor + 1; jump(i, lines[i]); },
  });
  const liveFiles = useMemo(() => new Set(Object.keys(live.files)), [live]);
  const liveFolders = useMemo(() => new Set(live.folders), [live]);
  const vaultRun = live.runs.find((r) => r.wholeVault) ?? null;

  const ops: TreeOps = {
    open: null, selected, creating, renaming, dropTarget, dots, marks: issueMarks, liveFiles, liveFolders,
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
        <p className={`kb-soon ${!notice && vaultRun ? 'kb-live-note' : ''}`} role="status">{notice || (vaultRun ? `${vaultRun.label} is working in your vault. The notes it changes show when it finishes.` : 'Right-click to rename or delete · Drag to move')}</p>
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
                <button className="icon-btn" aria-label="View in graph" data-tip="View in graph" onClick={() => { setFocus(preview.rel); setPreview(null); }}><IconGraph /></button>
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
                  <button className="icon-btn kb-expand" data-tip="Back to the full graph" aria-label="Back to the full graph" onClick={() => setFocus(null)}><IconExpand width={15} height={15} /></button>
                </span>
              ) : (
                <span className="kb-title"><IconGraph width={16} height={16} /> Graph</span>
              )}
              <div className="kb-actions">
                <button className={`icon-btn lh-btn ${health ? 'active' : ''} ${issues ? 'alert' : ''}`} aria-label={issues ? `Memory health, ${issues} to review` : 'Memory health'} aria-pressed={!!health}
                  data-tip={issues ? `Memory health · ${issues} to review` : 'Memory health'} onClick={() => { setPanel(false); setLapse(0); setHealth((h) => (h ? null : { focus: null })); }}>
                  <IconLink />{issues > 0 && <span className="lh-count">{issues}</span>}
                </button>
                <button className={`icon-btn ${panel ? 'active' : ''}`} aria-label="Graph settings" aria-expanded={panel} data-tip="Graph settings" onClick={() => { setHealth(null); setPanel((o) => !o); }}><IconSliders /></button>
                <button className={`icon-btn ${lapse ? 'active' : ''}`} aria-label={lapse ? 'Stop timelapse' : 'Start timelapse animation'} aria-pressed={!!lapse}
                  data-tip={lapse ? 'Stop timelapse' : 'Start timelapse animation'} onClick={() => setLapse((l) => (l ? 0 : Date.now()))}><IconHistory /></button>
              </div>
            </>
          )}
        </div>
        {missing !== null ? (
          // a link to a note that is not on this Mac, or not shared with this person yet
          <div className="kb-missing">
            <h2>This note isn't shared with you yet</h2>
            <p>The link points to a note that is not on this Mac or not public. Ask its owner to share it with you.</p>
            <button className="act-pill" onClick={() => setMissing(null)}>Back to Memory</button>
          </div>
        ) : preview ? (
          <>
            {/* one review banner at a time, docked under the header row so it stays in view and the issue drawer opens below it: a version opened read-only, else the issues from Memory health in red (with
                the updates' Before and After when there are updates), else the updates in green or blue */}
            {(() => {
              const banner = version
              ? <VersionBar version={version.v} busy={restoring} locked={locked} onRestore={restore} onClose={() => setVersion(null)} />
              : issueReview
                ? <ReviewBanner tone="orange" locked={locked}
                    label={`${issueReview.length} ${issueReview.length === 1 ? 'item needs' : 'items need'} review`}
                    mode={review ? mode : undefined} onMode={review ? setMode : undefined}
                    highlight={review ? highlight : undefined} onHighlight={review ? () => setHighlight((h) => !h) : undefined}
                    nav={mode === 'after' ? (() => { const n = navOver(issueReview.map((x) => x.line)); return { ...n, onPrev: () => { n.onPrev(); setIssueOpen(true); }, onNext: () => { n.onNext(); setIssueOpen(true); } }; })() : undefined}
                    onAccept={() => decideIssue(true)} onReject={() => decideIssue(false)} words acceptTip="Take the recommended fix" rejectTip="Mark it reviewed and change nothing" />
                : review && <ReviewBanner tone={review.dot} locked={locked}
                    label={`${review.count} ${review.count === 1 ? 'update' : 'updates'} on ${when(review.at)}`}
                    mode={mode} onMode={(m) => { setMode(m); setCursor(-1); }} highlight={highlight} onHighlight={() => setHighlight((h) => !h)}
                    nav={mode === 'after' ? navOver(blocks.map((b) => b[0])) : undefined}
                    onAccept={review.dot === 'green' ? accept : undefined} acceptTip="Accept updates"
                    onReject={reject} rejectTip="Reject updates and restore the earlier text" />;
              if (!banner) return null;
              return <div className="mu-dock">{banner}</div>;
            })()}
          <div className={`kb-preview ${side ? "side-open" : ""}`}>
            <article className="doc">
              {openRun && <LiveBanner run={openRun} onStop={() => setConfirmStop(openRun)} />}
              <h1>{preview.title}</h1>
              {/* the full path under the title; a long one loses its start, so the file name stays readable */}
              {/* the details row: date, apps, people, then the file in its folder (the path is in the tooltip) */}
              <NoteMeta meta={{ ...(preview.meta ?? {}), title: preview.title }}>
                <button className="meta-pill meta-icon" aria-label="Open in your editor" disabled={locked} data-tip={locked ? 'Locked until the update finishes' : `Open in your editor: ${preview.rel}`} onClick={() => window.quorum.openNote(preview.abs)}><IconFolder width={17} height={17} /></button>
                <MemoryBell rel={preview.rel} open={notifsOpen} onToggle={() => setNotifsOpen((o) => !o)} />
              </NoteMeta>
              {notifsOpen && <MemoryNotifications key={preview.rel} rel={preview.rel} abs={preview.abs} />}
              {/* After marks the lines the updates changed, green while they wait and blue once approved; Before and an
                  opened version show their saved text, dimmed */}
              <div ref={memRoot} hidden={notifsOpen} onClickCapture={clickIssue} className={`mu-text ${version || (review && mode === 'before') ? 'mu-old' : review?.dot ?? ''} ${locked ? 'locked' : ''}`}>
                <HeadingLinks root={memRoot} base={`quorum://note/${encodeURIComponent(preview.rel)}`} />
                <Markdown text={version ? version.body : review && mode === 'before' ? review.before : preview.body} headings root={brain?.root} onWiki={openLink} marks={marks} />
              </div>
            </article>
            {issueReview && issueOpen && issueReview[cursor] && (
              <IssueDrawer issue={issueReview[cursor].issue} at={cursor} total={issueReview.length} locked={locked} busy={deciding}
                onOpen={(rel) => openNote(rel)} onDecide={decideIssue} onClose={() => setIssueOpen(false)} />
            )}
            <NotePanel rel={preview.rel} body={preview.body} views={preview.views ?? null} previous={prev} onOpen={(rel) => { viaLink.current = true; openNote(rel); }} onResolve={openLink}>
              <VersionList rel={preview.rel} stamp={stamp} viewing={version?.v.id ?? null} onView={viewVersion} />
            </NotePanel>
          </div>
          </>
        ) : graph ? (
          <>
            <div className={`kb-stage ${health ? 'taken-over' : ''}`}>
              {view && <Graph data={graph} view={view} query={query} focus={focus} timelapse={lapse} onOpen={openGraphNode} onTimelapseEnd={endLapse} onRenameCluster={renameCluster} live={liveFiles} />}
              {healthShown && (
                <div className={`kb-takeover ${health ? 'in' : 'out'}`}>
                  <LinkHealth focus={healthShown.focus} isLive={(rel) => !!live.files[rel]} onReview={reviewIssue} onClose={() => setHealth(null)} onChanged={() => { load(); countIssues(); }} />
                </div>
              )}
            </div>
            {panel && view && <GraphPanel view={view} groups={graph.groups} onChange={tweak} onReset={resetView} onClose={() => setPanel(false)} />}
          </>
        ) : <div className="end-loading"><span className="spinner big" /><p>Building graph…</p></div>}
      </section>
      {confirmStop && (
        <ConfirmModal title={`Stop ${confirmStop.label}?`} action="Stop and delete updates"
          body="The updates from this run will be deleted and cannot be recovered. The notes it changed go back to how they were before the run."
          onDone={(ok) => { const run = confirmStop; setConfirmStop(null); if (ok) stopRun(run); }} />
      )}
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
  open: Set<string> | null; selected: string; creating: Creating; renaming: string | null; dropTarget: string | null; dots: MemoryDots; marks: { files: Record<string, number>; folders: Record<string, number> }; liveFiles: Set<string>; liveFolders: Set<string>;
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
        const dot = it.dir ? ops.dots.folders[it.path] : ops.dots.files[it.path];
        const busy = it.dir ? ops.liveFolders.has(it.path) : ops.liveFiles.has(it.path);
        const issues = (it.dir ? ops.marks.folders[it.path] : ops.marks.files[it.path]) ?? 0;
        const issueTip = `${issues} Memory health ${issues === 1 ? 'issue' : 'issues'}${it.dir ? ' in this folder' : ''}`;
        return (
          <div key={it.path}>
            {ops.renaming === it.path ? (
              <RenameRow item={it} depth={depth} onDone={(name) => ops.onRename(it, name)} />
            ) : (
              <div className={`kb-row ${dot || issues ? 'has-dot' : ''}${issues && it.dir ? ' has-count' : ''}`}>
              <button role="treeitem" aria-expanded={it.dir ? isOpen : undefined} draggable
                className={`kb-item ${ops.selected === it.path ? 'sel' : ''} ${it.dir ? 'dir' : ''} ${it.dir && ops.dropTarget === it.path ? 'drop' : ''} ${busy ? 'live' : ''}`}
                aria-busy={busy || undefined}
                style={{ paddingLeft: 10 + depth * 16 }}
                onClick={() => (it.dir ? ops.onToggle(it.path) : ops.onOpen(it.path))}
                onContextMenu={(e) => { e.preventDefault(); ops.onMenu(it); }}
                onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; ops.onDragStart(it.path); }}
                onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); ops.onDragOver(target); }}
                onDrop={(e) => { e.preventDefault(); e.stopPropagation(); ops.onDrop(target); }}>
                {it.dir ? <IconChevron className={isOpen ? '' : 'closed'} /> : <span className="kb-spacer" />}
                <span>{it.name}</span>
                {it.dir && <FolderApp rel={it.path} />}
              </button>
              <button className="kb-more" aria-label={`More options for ${it.name}`} data-tip="More options"
                onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); ops.onMenu(it, { x: r.left, y: r.bottom + 4 }); }}>
                <IconMore width={16} height={16} />
              </button>
              {/* the issue mark sits at the far right of the row: a count on a folder, a red dot on a note */}
              {issues > 0 && (it.dir
                ? <span className="kb-issues" role="img" aria-label={issueTip} data-tip={issueTip}>{issues}</span>
                : <span className="kb-dot red" role="img" aria-label={issueTip} data-tip={issueTip} />)}
              {dot && !issues && <span className={`kb-dot ${dot}`} role="img" aria-label={dot === 'green' ? 'Updates to review' : 'Updated since you last opened it'} data-tip={dot === 'green' ? 'Updates to review' : 'Updated since you last opened it'} />}
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
