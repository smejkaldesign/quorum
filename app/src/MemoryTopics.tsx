import { useEffect, useState } from 'react';
import type { MemoryCommunity, MemoryHub, MemoryTopicsEstimate, MemoryTopicsStatus, Settings } from './quorum';
import { EmptyState, Row, Toggle } from './controls';
import { IconBrain, IconGraph } from './icons';

// Settings > Memory: the topics the memory graph found (graph/topics.js) and its most connected notes, each opening the
// note, and the switch that lets the person's own model name topics and draft their summaries. The switch turns on
// only once the cost of the calls it would make is shown
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const open = (rel: string | null) => { if (rel) window.dispatchEvent(new CustomEvent('quorum:note-link', { detail: { rel, anchor: null } })); };
const SHOWN = 12;
const KIND: Record<string, string> = { note: 'Note', person: 'Person', project: 'Project', company: 'Company', meeting: 'Meeting', decision: 'Decision', topic: 'Topic' };

function NodeButton({ n }: { n: { name: string; rel: string | null } }) {
  return n.rel
    ? <button className="link-btn inline mt-link" onClick={() => open(n.rel)} data-tip={n.rel}>{n.name}</button>
    : <span className="mt-link">{n.name}</span>;
}

// the cost line: unknown while loading, none before the graph is built, and only a real zero as nothing to do
function costLine(estimate: MemoryTopicsEstimate | null | undefined, on: boolean) {
  if (estimate === undefined) return 'Working out the cost.';
  if (estimate === null) return 'The cost shows once the memory graph is built.';
  if (!estimate.calls) return 'Nothing to name or draft right now.';
  const what = [estimate.names ? plural(estimate.names, 'name') : null, estimate.summaries ? plural(estimate.summaries, 'summary', 'summaries') : null].filter(Boolean).join(', ');
  const cost = estimate.costLabel ? `, ${estimate.costLabel.charAt(0).toLowerCase()}${estimate.costLabel.slice(1)}` : '';
  return `${on ? 'The next pass makes' : 'Turning this on makes'} ${plural(estimate.calls, 'model call')} (${what})${cost}. At most ${plural(estimate.left, 'call')} more today.`;
}

export function MemoryTopicsCard({ settings, onSettings }: { settings: Settings; onSettings: (s: Settings) => void }) {
  const [list, setList] = useState<MemoryCommunity[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [hubs, setHubs] = useState<MemoryHub[]>([]);
  const [status, setStatus] = useState<MemoryTopicsStatus | null>(null);
  // undefined while it loads, null before the graph is built, 'error' when it could not be worked out
  const [estimate, setEstimate] = useState<MemoryTopicsEstimate | null | undefined | 'error'>(undefined);
  const on = settings.memoryTopicModel === true;
  const load = () => {
    window.quorum.memoryGraphCommunities({ budget: 6000 })
      .then((r) => { setFailed(!!r && 'error' in r); setList(r && 'communities' in r ? r.communities : []); })
      .catch(() => { setFailed(true); setList([]); });
    window.quorum.memoryGraphHubs({ budget: 1500 }).then((r) => setHubs(r && 'hubs' in r ? r.hubs.slice(0, SHOWN) : [])).catch(() => setHubs([]));
    window.quorum.memoryTopicsStatus().then(setStatus).catch(() => setStatus(null));
  };
  useEffect(() => {
    load();
    return window.quorum.onMemoryTopics?.(load);
  }, []);
  useEffect(() => { window.quorum.memoryTopicsEstimate().then(setEstimate).catch(() => setEstimate('error')); }, [on, status?.at, status?.model.at]);
  const ready = status?.model.ready === true;
  const known = estimate !== undefined && estimate !== null && estimate !== 'error';
  const cost = estimate === 'error' ? 'Could not work out the cost.' : costLine(estimate, on);
  const busy = list === null || status?.phase === 'running';
  const error = failed || status?.phase === 'error';
  return (
    <>
      <h3>Topics</h3>
      <div className="set-card">
        <Row icon={<IconBrain width={18} height={18} />} title="Name topics and draft summaries with your model"
          desc={`Quorum finds and names topics on this Mac with no model. With this on, your model source gives them better names and drafts the topic summaries offered in Needs review. ${ready ? cost : 'Choose a model source in Settings, Connectors first.'}`}>
          <Toggle on={on} disabled={!on && (!ready || !known)} onChange={async (v) => onSettings(await window.quorum.setSettings({ memoryTopicModel: v }))} label="Name topics and draft summaries with your model" />
        </Row>
        {on && status?.model.running && <p className="set-hint" role="status">Naming topics with your model.</p>}
        {on && status?.model.error && <p className="set-hint">The last model pass stopped: {status.model.error}</p>}
      </div>
      <div role="status" aria-busy={busy}>
        {list && list.length ? (
          <div className="set-card form mt-topics">
            {list.slice(0, SHOWN).map((c) => (
              <div key={c.id} className="set-line mt-topic">
                <span className="mr-name">
                  <strong>{c.name}</strong>
                  <span className="muted">{plural(c.size, 'member')}{c.namedBy === 'model' ? ', named by your model' : ''}{c.tags.length ? `, ${c.tags.join(', ')}` : ''}{c.folder ? `, in ${c.folder}` : ''}</span>
                </span>
                <span className="mr-counts" aria-label={`Top notes in ${c.name}`}>
                  {c.top.slice(0, 4).map((m) => <span key={m.id} className="mr-count"><NodeButton n={m} /></span>)}
                </span>
              </div>
            ))}
            {list.length > SHOWN && <p className="set-note">{plural(list.length - SHOWN, 'more topic')}. AI tools connected to Quorum can list all of them.</p>}
          </div>
        ) : (
          <EmptyState icon={<IconGraph width={18} height={18} />} title={error ? 'Could not find topics' : busy ? 'Finding topics' : 'No topics yet'}>
            <p className="set-hint">{error && status?.error ? status.error : 'Quorum groups notes that link to each other into topics once the memory graph is built.'}</p>
          </EmptyState>
        )}
      </div>
      {hubs.length > 0 && (
        <>
          <h3>Most connected notes</h3>
          <div className="set-card form mt-hubs">
            {hubs.map((h) => (
              <div key={h.id} className="set-line mt-hub">
                <span className="mr-name"><NodeButton n={h} /><span className="muted">{KIND[h.kind] ?? h.kind}{h.communityName ? `, ${h.communityName}` : ''}</span></span>
                <span className="mr-counts" aria-label={`Links of ${h.name}`}><span className="mr-count">{plural(h.degree, 'linked note')}</span><span className="mr-count">{plural(h.edges, 'link')}</span></span>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
