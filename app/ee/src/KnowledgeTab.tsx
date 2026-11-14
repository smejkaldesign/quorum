import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Billing, KnowledgeDoc, KnowledgeNote, QueueItem, TeamHit, TeamLocal, TeamSource, TeamSourceKind, TreeItem } from '../../src/quorum';
import type { GraphData } from '../../src/Graph';
import { Graph } from '../../src/Graph';
import { Markdown } from '../../src/Markdown';
import { describeSource, matchesQuery, teamEnabledOf, teamGate } from '../../src/mainTabs';
import { IconBack, IconChevron, IconDoc, IconFolder, IconGraph, IconReset, IconSearch, IconSliders } from '../../src/icons';
import { AccountCard, EE_MARKER, useAccount } from './Account';
import { billingApi, knowledgeApi, teamApi } from './accountMock';
import { BillingPage, hasService } from './Billing';
import { KbBrowser, useTeamSide } from './KbBrowser';

const api = knowledgeApi();
const team = teamApi();
const billing = billingApi();
const onDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');
const onTime = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '');

// The Knowledge tab, Cloud: the workspace's team knowledge. Admins pick where it comes from (the notes members share
// through Quorum, a folder every member has, or a git repository each Mac clones); members browse, search and read it;
// contributions still go through the review queue. The knowledge bases the person can read sit in a tree on the left
// (KbBrowser.tsx). The gates come first: sign in, a plan with Cloud service, and a team switched on in Settings › Admin
// › Teams.
export function KnowledgeTab() {
  const a = useAccount();
  // the plan decides whether team knowledge shows; unknown (loading, or the project did not answer) keeps the gate closed,
  // and a workspace change starts over so one workspace's answer never applies to another
  const [planFor, setPlanFor] = useState<{ ws: string; plan: Billing | 'error' } | null>(null);
  const [tries, setTries] = useState(0);
  const signedIn = a?.signedIn === true, workspaceId = a?.workspace?.id ?? null;
  useEffect(() => {
    if (!signedIn || !workspaceId) return;
    let live = true;
    billing.billingStatus().then((r) => { if (live) setPlanFor({ ws: workspaceId, plan: r.billing ?? 'error' }); }).catch(() => { if (live) setPlanFor({ ws: workspaceId, plan: 'error' }); });
    return () => { live = false; };
  }, [signedIn, workspaceId, tries]);
  const plan = planFor && planFor.ws === workspaceId ? planFor.plan : undefined;
  if (!a) return null;
  const gate = teamGate(a, plan === undefined || plan === 'error' ? null : hasService(plan.plan), teamEnabledOf(a));
  if (gate === 'account' || !a.workspace) return <div className="tk"><div className="tk-body"><div className="tk-gate" data-ee={EE_MARKER}><AccountCard account={a} /></div></div></div>;
  if (plan === undefined) return <div className="tk" data-ee={EE_MARKER} />;
  if (plan === 'error') {
    return (
      <div className="tk" data-ee={EE_MARKER}>
        <div className="tk-body"><div className="tk-gate">
          <h2 className="tk-title">The workspace did not answer</h2>
          <p className="muted">Quorum could not read the plan for {a.workspace.name}, so team knowledge stays closed for now.</p>
          <p><button className="pill" onClick={() => setTries((n) => n + 1)}>Try again</button></p>
        </div></div>
      </div>
    );
  }
  if (gate === 'plan') {
    return (
      <div className="tk" data-ee={EE_MARKER}>
        <div className="tk-body"><div className="tk-gate">
          <h2 className="tk-title">Knowledge is part of Quorum Cloud</h2>
          <p className="muted">Team knowledge reaches every member of {a.workspace.name} once the workspace has a subscription.</p>
          <BillingPage />
        </div></div>
      </div>
    );
  }
  if (gate === 'team') {
    return (
      <div className="tk" data-ee={EE_MARKER}>
        <div className="tk-body"><div className="tk-gate">
          <h2 className="tk-title">Team knowledge starts with a team</h2>
          <p className="muted">{a.workspace.role === 'member' ? `An owner or admin of ${a.workspace.name} switches the team on under Settings › Admin › Teams. Once it is on, the knowledge the team keeps shows here.` : `Switch the team on under Settings › Admin › Teams, then come back here to pick where ${a.workspace.name} keeps its knowledge.`}</p>
        </div></div>
      </div>
    );
  }
  return <TeamKnowledge workspace={a.workspace.name} admin={a.workspace.role !== 'member'} me={a.userId} />;
}

type SourceState = { source: TeamSource; local: TeamLocal };

// the source and its state on this Mac, loaded once per open and after every change
function TeamKnowledge({ workspace, admin, me }: { workspace: string; admin: boolean; me: string | null }) {
  const [state, setState] = useState<SourceState | null>(null);
  const [error, setError] = useState('');
  // the source card opens on its own for an admin whose source is not on this Mac yet, and closes when asked
  const [setup, setSetup] = useState<boolean | null>(null);
  const [query, setQuery] = useState('');
  const load = useCallback(() => team.teamSource().then((r) => { if (r.error) setError(r.error); else if (r.source && r.local) { setError(''); setState({ source: r.source, local: r.local }); } }), []);
  useEffect(() => { load(); }, [load]);
  const pull = async () => {
    setError('');
    const r = await team.teamPull();
    if (r.error) setError(r.error); else if (r.local) setState((s) => (s ? { ...s, local: r.local! } : s));
  };
  // the knowledge bases do not wait for the team source: while it loads, or when it failed, the KB tree still shows
  const kind = state?.source.kind ?? null;
  const showSetup = !!state && (setup ?? (admin && kind !== 'sync' && !state.local.exists && !state.local.pulling));
  return (
    <div className="tk" data-ee={EE_MARKER}>
      <div className="tk-head">
        <h2>{workspace}</h2>
        {state && <span className="tk-source muted" title={state.local.root ?? undefined}>{describeSource(state.source)}</span>}
        <label className="kb-search"><IconSearch width={14} height={14} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={kind === 'sync' ? 'Search shared notes' : 'Search team knowledge'} aria-label="Search team knowledge" /></label>
        <span className="tk-count muted">{!state || kind === 'sync' ? '' : `${state.local.notes} ${state.local.notes === 1 ? 'note' : 'notes'}`}</span>
        {state && kind !== 'sync' && <button className="tk-tool" onClick={pull} disabled={state.local.pulling} aria-label="Refresh team knowledge" data-tip="Refresh"><IconReset width={15} height={15} /></button>}
        {state && admin && <button className={`tk-tool ${showSetup ? 'on' : ''}`} onClick={() => setSetup(!showSetup)} aria-label="Knowledge source" data-tip="Knowledge source"><IconSliders width={15} height={15} /></button>}
      </div>
      {error && <p className="error tk-error">{error}</p>}
      {state && showSetup && admin && <SourceCard state={state} onChange={(s) => { setState(s); setSetup(false); }} onClose={() => setSetup(false)} />}
      <KbBrowser me={me} query={query}>
        {!state ? (error ? <div className="tk-body"><p className="tk-empty">Team knowledge did not load. The knowledge bases on the left still work.</p></div> : null) : (
          <>
            {!showSetup && kind !== 'sync' && !state.local.exists && <MissingFolder state={state} admin={admin} onChange={(s) => setState(s)} />}
            {kind === 'sync' ? <Shared admin={admin} query={query} /> : state.local.exists && <Browser admin={admin} query={query} state={state} />}
          </>
        )}
      </KbBrowser>
    </div>
  );
}

const KIND_COPY: Record<TeamSourceKind, { title: string; desc: string }> = {
  sync: { title: 'Quorum sync', desc: 'Notes members mark public and an admin includes. Nothing to set up; it is what the tab showed before.' },
  folder: { title: 'A folder on each Mac', desc: 'A shared drive, a checkout everyone keeps, or a folder a tool exports. Each member chooses it once on their Mac.' },
  git: { title: 'A git repository', desc: 'Every Mac clones it and pulls on refresh. Private repositories need git access on each Mac (SSH keys or a credential helper).' },
};

// Settings for the default KB's source, inside the tab: three choices, one address or folder, and what happened on
// this Mac
function SourceCard({ state, onChange, onClose }: { state: SourceState; onChange: (s: SourceState) => void; onClose: () => void }) {
  const [kind, setKind] = useState<TeamSourceKind>(state.source.kind);
  const [url, setUrl] = useState(state.source.url ?? '');
  const [path, setPath] = useState(state.source.path ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async (draft: { kind: TeamSourceKind; url?: string; path?: string }) => {
    setBusy(true); setError('');
    const r = await team.teamSourceSet(draft);
    setBusy(false);
    if (r.error) setError(r.error); else if (r.source && r.local) onChange({ source: r.source, local: r.local });
  };
  const pick = async () => {
    setError('');
    const r = await team.teamSourcePick();
    if (r.error) setError(r.error); else if (r.path) setPath(r.path);
  };
  const changed = kind !== state.source.kind || (kind === 'git' && url.trim() !== (state.source.url ?? '')) || (kind === 'folder' && path !== (state.source.path ?? ''));
  // an imported default KB keeps its import source; the card names it and where it changes
  if (state.source.imported) {
    return (
      <div className="tk-setup">
        <div className="set-card tk-setup-card">
          <h3 className="tk-setup-title">Where the team keeps its knowledge</h3>
          <p className="muted">{describeSource(state.source)}. The workspace's default knowledge base keeps this import source, and its admins change it under Settings › Admin › Knowledge.</p>
          <div className="tk-setup-actions"><button className="pill ghost" onClick={onClose}>Close</button></div>
        </div>
      </div>
    );
  }
  return (
    <div className="tk-setup">
      <div className="set-card tk-setup-card">
        <h3 className="tk-setup-title">Where the team keeps its knowledge</h3>
        <p className="muted">This is the source of the workspace's default knowledge base, marked Default under Settings › Admin › Knowledge.</p>
        {(Object.keys(KIND_COPY) as TeamSourceKind[]).map((k) => (
          <label key={k} className={`tk-kind ${kind === k ? 'on' : ''}`}>
            <input type="radio" name="tk-kind" checked={kind === k} onChange={() => setKind(k)} />
            <span className="tk-kind-text"><strong>{KIND_COPY[k].title}</strong><span>{KIND_COPY[k].desc}</span></span>
          </label>
        ))}
        {kind === 'git' && (
          <div className="tk-setup-row">
            <span className="set-field tk-field"><input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/your-team/knowledge" spellCheck={false} aria-label="Repository address" /></span>
            {!state.local.gitAvailable && state.source.kind === 'git' && <span className="muted">git is not installed on this Mac.</span>}
          </div>
        )}
        {kind === 'folder' && (
          <div className="tk-setup-row">
            <button className="pill" onClick={pick}><IconFolder width={15} height={15} /> {path ? 'Change folder' : 'Choose folder'}</button>
            {path && <span className="tk-path muted">{path}</span>}
          </div>
        )}
        <div className="tk-setup-actions">
          <button className="pill primary" disabled={busy || !changed} onClick={() => save({ kind, url, path })}>{busy ? 'Saving…' : kind === 'git' ? 'Connect repository' : kind === 'folder' ? 'Use this folder' : 'Use Quorum sync'}</button>
          <button className="pill ghost" onClick={onClose}>Close</button>
          {error && <span className="error">{error}</span>}
        </div>
        {state.source.kind !== 'sync' && (
          <p className="tk-setup-status muted">
            {state.local.pulling ? 'Pulling…' : state.local.lastError ? state.local.lastError : state.local.exists ? `On this Mac at ${state.local.root}${state.local.lastPullAt ? `, refreshed ${onDate(state.local.lastPullAt)} ${onTime(state.local.lastPullAt)}` : ''}.` : 'Not on this Mac yet.'}
          </p>
        )}
      </div>
    </div>
  );
}

// a member whose Mac does not have the folder (or the clone failed): the fix that is theirs to make
function MissingFolder({ state, admin, onChange }: { state: SourceState; admin: boolean; onChange: (s: SourceState) => void }) {
  const [error, setError] = useState('');
  const pick = async () => {
    setError('');
    const r = await team.teamSourcePick();
    if (r.error) setError(r.error); else if (r.local) onChange({ ...state, local: r.local });
  };
  const pull = async () => {
    setError('');
    const r = await team.teamPull();
    if (r.error) setError(r.error); else if (r.local) onChange({ ...state, local: r.local });
  };
  return (
    <div className="tk-body"><div className="tk-gate">
      <h2 className="tk-title">{state.source.kind === 'git' ? 'The repository is not on this Mac yet' : 'The folder is not on this Mac'}</h2>
      <p className="muted">{state.local.pulling ? 'Pulling…' : state.local.lastError ?? (state.source.kind === 'git' ? `Quorum clones ${state.source.url} into its own folder.` : `${admin ? 'You' : 'An admin'} set the team knowledge to ${state.source.path}. Choose where that folder is on this Mac.`)}</p>
      <p>
        {state.source.kind === 'git' ? <button className="pill primary" disabled={state.local.pulling} onClick={pull}>{state.local.lastPullAt ? 'Try again' : 'Clone now'}</button> : <button className="pill primary" onClick={pick}><IconFolder width={15} height={15} /> Choose the folder</button>}
        {error && <span className="error"> {error}</span>}
      </p>
    </div></div>
  );
}

// the admin queue of notes members shared, shown above either view
function Queue({ admin, onChanged }: { admin: boolean; onChanged?: () => void }) {
  const [queue, setQueue] = useState<QueueItem[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => { if (admin) api.knowledgeQueue().then((r) => { if (r.error) setError(r.error); else setQueue(r.queue ?? []); }); }, [admin]);
  useEffect(() => { load(); }, [load]);
  const review = async (id: string, decision: 'include' | 'decline') => {
    setBusy(id); setError('');
    const r = await api.knowledgeReview(id, decision);
    setBusy(null);
    if (r.error) setError(r.error); else { load(); onChanged?.(); }
  };
  if (!admin || !queue || !queue.length) return error ? <p className="error">{error}</p> : null;
  return (
    <>
      <h3 className="tk-section">Waiting for review · {queue.length}</h3>
      <div className="set-card">
        {queue.map((q) => (
          <div key={q.id} className="queue-row">
            <IconDoc width={18} height={18} />
            <div className="set-text"><strong>{q.title}</strong><span>{q.path} · {q.authorName || q.authorEmail || 'a member'} · {onDate(q.createdAt)}</span></div>
            <span className="queue-actions">
              <button className="pill" disabled={busy === q.id} onClick={() => review(q.id, 'decline')}>Decline</button>
              <button className="pill primary" disabled={busy === q.id} onClick={() => review(q.id, 'include')}>Include</button>
            </span>
          </div>
        ))}
        {error && <p className="error">{error}</p>}
      </div>
    </>
  );
}

// Quorum sync as the source: the shared notes as they sit in the workspace vault on this Mac, one opening to read
function Shared({ admin, query }: { admin: boolean; query: string }) {
  const [notes, setNotes] = useState<KnowledgeNote[] | null>(null);
  const [root, setRoot] = useState<string | null>(null);
  const [open, setOpen] = useState<KnowledgeDoc | null>(null);
  const [teamText, setTeamText] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(() => { api.knowledgeList().then((r) => { if (r.error) setError(r.error); else { setNotes(r.notes ?? []); setRoot(r.root ?? null); } }); }, []);
  useEffect(() => { load(); }, [load]);
  const read = async (rel: string) => {
    setError('');
    const r = await api.knowledgeRead(rel);
    if (r.error) setError(r.error); else if (r.doc) { setOpen(r.doc); setTeamText(false); }
  };
  // a note link inside a shared note: another shared note opens here; anything else goes to the person's notes app
  const follow = (target: string) => {
    const want = target.replace(/\.md$/, '').toLowerCase();
    const hit = (notes ?? []).find((n) => n.rel.toLowerCase() === `${want}.md` || n.rel.toLowerCase().endsWith(`/${want}.md`) || n.title.toLowerCase() === want);
    if (hit) read(hit.rel);
    else if (root) window.quorum.openNote(`${root}/${target.endsWith('.md') ? target : `${target}.md`}`);
  };
  const shown = (notes ?? []).filter((n) => matchesQuery(n, query));
  if (open) return <Reader doc={open} teamText={teamText} onTeamText={() => setTeamText((v) => !v)} root={root} onBack={() => setOpen(null)} onWiki={follow} />;
  return (
    <div className="tk-body"><div className="tk-col">
      {error && <p className="error">{error}</p>}
      <Queue admin={admin} onChanged={load} />
      <h3 className="tk-section">Shared notes</h3>
      <div className="set-card tk-list">
        {shown.map((n) => (
          <button key={n.rel} className="tk-row" onClick={() => read(n.rel)}>
            <IconDoc width={18} height={18} />
            <span className="tk-text"><strong>{n.title}</strong><em>{n.rel}</em></span>
            <span className="tk-when">{n.behind ? <i className="tk-behind">newer version waiting</i> : onDate(n.pulledAt)}</span>
          </button>
        ))}
        {notes && !notes.length && <p className="tk-empty">Nothing shared yet. {admin ? 'Notes members mark public land here once included.' : 'Mark a note public to share it; an admin includes it.'}{root ? ` The folder on this Mac is ${root}.` : ''}</p>}
        {notes && notes.length > 0 && !shown.length && <p className="tk-empty">No shared note matches "{query}".</p>}
      </div>
    </div></div>
  );
}

function Reader({ doc, teamText, onTeamText, root, onBack, onWiki }: { doc: KnowledgeDoc; teamText: boolean; onTeamText: () => void; root: string | null; onBack: () => void; onWiki: (t: string) => void }) {
  return (
    <>
      <div className="tk-subhead">
        <button className="tk-back" onClick={onBack} aria-label="Back to the list"><IconBack width={16} height={16} />Knowledge</button>
        <span className="tk-crumb">{doc.rel}</span>
      </div>
      <div className="tk-body"><article className="tk-doc">
        <h1>{doc.title}</h1>
        <p className="tk-meta">
          {doc.pulledAt ? `Shared ${onDate(doc.pulledAt)}` : 'Team knowledge'}
          {doc.behind && doc.update !== null && <> · your copy has edits · <button className="link-btn" onClick={onTeamText}>{teamText ? 'Show your copy' : "Show the team's version"}</button></>}
          {doc.behind && doc.update === null && ' · your copy has edits'}
        </p>
        <Markdown text={teamText && doc.update !== null ? doc.update : doc.body} headings root={root ?? undefined} onWiki={onWiki} />
      </article></div>
    </>
  );
}

// a folder or a repository as the source: the folder tree on the left, the graph or one note on the right, the same
// shape as the Memory view over the person's own Agent OS, read-only
function Browser({ admin, query, state }: { admin: boolean; query: string; state: SourceState }) {
  const [tree, setTree] = useState<TreeItem[]>([]);
  const [graph, setGraph] = useState<GraphData | null>(null);
  // the last results stay up while the next query runs; a cleared box shows the tree again at once
  const [found, setFound] = useState<TeamHit[] | null>(null);
  const hits = query.trim() ? found : null;
  const [openSet, setOpenSet] = useState<Set<string>>(new Set());
  const [doc, setDoc] = useState<KnowledgeDoc | null>(null);
  const [error, setError] = useState('');
  const root = state.local.root;
  const load = useCallback(() => {
    team.teamTree().then((r) => { if (r.error) setError(r.error); else setTree(r.tree ?? []); });
    team.teamGraph().then((r) => { if (!r.error) setGraph(r.graph ?? null); });
  }, []);
  useEffect(() => { load(); }, [load, state.local.lastPullAt]);
  useEffect(() => team.onTeamChanged(() => load()), [load]);
  useEffect(() => {
    if (!query.trim()) return;
    let live = true;
    team.teamSearch(query, 60).then((r) => { if (live && !r.error) setFound(r.hits ?? []); });
    return () => { live = false; };
  }, [query]);
  const read = useCallback(async (rel: string) => {
    setError('');
    const r = await team.teamNote(rel);
    if (r.error) setError(r.error); else if (r.doc) setDoc(r.doc);
  }, []);
  // a wikilink inside a team note goes through the index, the same resolution the graph uses
  const follow = async (target: string) => {
    const r = await team.teamResolve(target, doc?.rel ?? '');
    if (r.error) setError(r.error); else if (r.rel) read(r.rel);
  };
  const toggle = (p: string) => setOpenSet((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  // inside the KB browser the file tree goes into the left column under "Team knowledge", so the tab keeps one column
  // of trees; a file picked there brings the team view forward
  const side = useTeamSide();
  const pick = (rel: string) => { side?.showTeam(); read(rel); };
  const files = hits ? (
    <div className="tk-tree">
      {hits.map((h) => (
        <button key={h.rel} className={`tk-item ${doc?.rel === h.rel ? 'sel' : ''}`} onClick={() => pick(h.rel)}>
          <IconDoc width={14} height={14} /><span className="tk-item-text"><span>{h.title}</span>{h.snippet && <em>{h.snippet}</em>}</span>
        </button>
      ))}
      {!hits.length && <p className="tk-empty">No note matches "{query}".</p>}
    </div>
  ) : (
    <div className="tk-tree" role="tree" aria-label="Team knowledge files">
      <Tree items={tree} depth={side?.slot ? 1 : 0} open={openSet} selected={doc?.rel ?? ''} onToggle={toggle} onOpen={pick} />
      {!tree.length && <p className="tk-empty">No notes in this folder yet.</p>}
    </div>
  );
  return (
    <div className={`tk-browser ${side?.slot ? 'solo' : ''}`}>
      {side?.slot ? createPortal(files, side.slot) : (
        <aside className="tk-side">
          {files}
          <p className="tk-side-foot muted">{admin ? 'Read-only here. Edits go through the source itself.' : 'Read-only. An admin sets the source.'}</p>
        </aside>
      )}
      <section className="tk-main">
        {doc ? (
          <Reader doc={doc} teamText={false} onTeamText={() => {}} root={root} onBack={() => setDoc(null)} onWiki={follow} />
        ) : (
          <>
            <div className="tk-subhead"><span className="tk-crumb"><IconGraph width={14} height={14} /> Graph · {state.local.notes} {state.local.notes === 1 ? 'note' : 'notes'}</span></div>
            {error && <p className="error tk-error">{error}</p>}
            <Queue admin={admin} />
            <div className="tk-graph">
              {graph && graph.nodes.length > 0 ? <Graph data={graph} view={graph.settings} query={query} timelapse={0} onOpen={(id) => { if (!id.startsWith('?')) read(id); }} onTimelapseEnd={() => {}} /> : <p className="tk-empty">{graph ? 'No links between notes yet. Open a note from the list.' : ''}</p>}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function Tree({ items, depth, open, selected, onToggle, onOpen }: { items: TreeItem[]; depth: number; open: Set<string>; selected: string; onToggle: (p: string) => void; onOpen: (p: string) => void }) {
  return (
    <>
      {items.map((it) => {
        const isOpen = open.has(it.path);
        return (
          <div key={it.path}>
            <button role="treeitem" aria-expanded={it.dir ? isOpen : undefined} className={`tk-item ${selected === it.path ? 'sel' : ''} ${it.dir ? 'dir' : ''}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => (it.dir ? onToggle(it.path) : onOpen(it.path))}>
              {it.dir ? <IconChevron width={12} height={12} className={isOpen ? '' : 'closed'} /> : <IconDoc width={14} height={14} />}
              <span className="tk-item-text"><span>{it.name}</span></span>
            </button>
            {it.dir && isOpen && <Tree items={it.children ?? []} depth={depth + 1} open={open} selected={selected} onToggle={onToggle} onOpen={onOpen} />}
          </div>
        );
      })}
    </>
  );
}
