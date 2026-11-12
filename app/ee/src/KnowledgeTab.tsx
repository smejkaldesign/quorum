import { useEffect, useState } from 'react';
import type { Billing, KnowledgeDoc, KnowledgeNote, QueueItem } from '../../src/quorum';
import { Markdown } from '../../src/Markdown';
import { matchesQuery } from '../../src/mainTabs';
import { IconBack, IconDoc, IconSearch } from '../../src/icons';
import { AccountCard, EE_MARKER, useAccount } from './Account';
import { billingApi, knowledgeApi } from './accountMock';
import { BillingPage, hasService } from './Billing';

const api = knowledgeApi();
const billing = billingApi();
const onDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');

// The Knowledge tab, Cloud: the workspace's shared notes as they sit in the workspace vault on this Mac, searchable,
// one opening to read. Admins see the review queue of notes waiting to become company knowledge above the list. A
// workspace on the free plan sees the plan card instead, the same one Settings › Admin › General shows.
export function KnowledgeTab() {
  const a = useAccount();
  const [plan, setPlan] = useState<Billing | null | undefined>(undefined);
  useEffect(() => {
    if (!a?.signedIn || !a.workspace) return;
    let live = true;
    billing.billingStatus().then((r) => { if (live) setPlan(r.billing ?? null); });
    return () => { live = false; };
  }, [a?.signedIn, a?.workspace?.id]);
  if (!a) return null;
  if (!a.signedIn || !a.workspace) return <div className="tk"><div className="tk-body"><div className="tk-gate" data-ee={EE_MARKER}><AccountCard account={a} /></div></div></div>;
  if (plan === undefined) return <div className="tk" data-ee={EE_MARKER} />;
  if (plan && !hasService(plan.plan)) {
    return (
      <div className="tk" data-ee={EE_MARKER}>
        <div className="tk-body"><div className="tk-gate">
          <h2 className="tk-title">Knowledge is part of Quorum Cloud</h2>
          <p className="muted">Shared notes reach every member of {a.workspace.name} once the workspace has a subscription.</p>
          <BillingPage />
        </div></div>
      </div>
    );
  }
  return <Shared workspace={a.workspace.name} admin={a.workspace.role !== 'member'} />;
}

function Shared({ workspace, admin }: { workspace: string; admin: boolean }) {
  const [notes, setNotes] = useState<KnowledgeNote[] | null>(null);
  const [root, setRoot] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueItem[] | null>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<KnowledgeDoc | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const load = () => {
    api.knowledgeList().then((r) => { if (r.error) setError(r.error); else { setNotes(r.notes ?? []); setRoot(r.root ?? null); } });
    if (admin) api.knowledgeQueue().then((r) => { if (r.error) setError(r.error); else setQueue(r.queue ?? []); });
  };
  useEffect(() => { load(); }, [admin]);
  const review = async (id: string, decision: 'include' | 'decline') => {
    setBusy(id); setError('');
    const r = await api.knowledgeReview(id, decision);
    setBusy(null);
    if (r.error) setError(r.error); else load();
  };
  const read = async (rel: string) => {
    setError('');
    const r = await api.knowledgeRead(rel);
    if (r.error) setError(r.error); else if (r.doc) setOpen(r.doc);
  };
  const shown = (notes ?? []).filter((n) => matchesQuery(n, query));

  if (open) {
    return (
      <div className="tk" data-ee={EE_MARKER}>
        <div className="tk-head">
          <button className="tk-back" onClick={() => setOpen(null)} aria-label="Back to shared notes"><IconBack width={16} height={16} />Knowledge</button>
          <span className="tk-crumb">{open.rel}</span>
        </div>
        <div className="tk-body"><article className="tk-doc">
          <h1>{open.title}</h1>
          <p className="tk-meta">{open.pulledAt ? `Shared ${onDate(open.pulledAt)}` : 'Shared with the workspace'}{open.behind ? ' · your copy has edits; the team has a newer version' : ''}</p>
          <Markdown text={open.body} headings />
        </article></div>
      </div>
    );
  }

  return (
    <div className="tk" data-ee={EE_MARKER}>
      <div className="tk-head">
        <h2>{workspace}</h2>
        <label className="kb-search"><IconSearch width={14} height={14} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search shared notes" aria-label="Search shared notes" /></label>
        <span className="tk-count muted">{notes ? `${notes.length} ${notes.length === 1 ? 'note' : 'notes'}` : ''}</span>
      </div>
      <div className="tk-body"><div className="tk-col">
        {error && <p className="error">{error}</p>}
        {admin && queue && queue.length > 0 && (
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
            </div>
          </>
        )}
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
    </div>
  );
}
