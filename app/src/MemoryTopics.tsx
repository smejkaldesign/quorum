import { useEffect, useState } from 'react';
import type { MemoryCommunity, MemoryHub, MemoryTopicsEstimate, MemoryTopicsStatus, Settings } from './quorum';
import { EmptyState, Row, Toggle } from './controls';
import { IconBrain, IconGraph } from './icons';

// Settings > Memory: the topics the memory graph found (graph/topics.js) and its most connected notes, each opening the
// note, and the switch that lets the person's own model name topics and draft their summaries, with its estimate shown
// before it is turned on
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const open = (rel: string | null) => { if (rel) window.dispatchEvent(new CustomEvent('quorum:note-link', { detail: { rel, anchor: null } })); };
const SHOWN = 12;

function NodeButton({ n }: { n: { name: string; rel: string | null; kind: string } }) {
  return n.rel
    ? <button className="link-btn" onClick={() => open(n.rel)} data-tip={n.rel}>{n.name}</button>
    : <span className="muted">{n.name}</span>;
}

export function MemoryTopicsCard({ settings, onSettings }: { settings: Settings; onSettings: (s: Settings) => void }) {
  const [list, setList] = useState<MemoryCommunity[] | null>(null);
  const [hubs, setHubs] = useState<MemoryHub[]>([]);
  const [status, setStatus] = useState<MemoryTopicsStatus | null>(null);
  const [estimate, setEstimate] = useState<MemoryTopicsEstimate | null>(null);
  const on = settings.memoryTopicModel === true;
  const load = () => {
    window.quorum.memoryGraphCommunities({ budget: 6000 }).then((r) => setList(r && 'communities' in r ? r.communities : [])).catch(() => setList([]));
    window.quorum.memoryGraphHubs({ budget: 1500 }).then((r) => setHubs(r && 'hubs' in r ? r.hubs.slice(0, SHOWN) : [])).catch(() => setHubs([]));
    window.quorum.memoryTopicsStatus().then(setStatus).catch(() => setStatus(null));
  };
  useEffect(() => {
    load();
    return window.quorum.onMemoryTopics?.(load);
  }, []);
  // the estimate shows before the switch is turned on, and again while it is on for what the next pass would cost
  useEffect(() => { window.quorum.memoryTopicsEstimate().then(setEstimate).catch(() => setEstimate(null)); }, [on, status?.at]);
  const cost = estimate && estimate.calls
    ? `${plural(estimate.calls, 'call')} now (${[estimate.names ? plural(estimate.names, 'name') : null, estimate.summaries ? plural(estimate.summaries, 'summary', 'summaries') : null].filter(Boolean).join(', ')}). ${estimate.costLabel ?? ''}`.trim()
    : 'Nothing to name or draft right now.';
  return (
    <>
      <h3>Topics</h3>
      <div className="set-card">
        <Row icon={<IconBrain width={18} height={18} />} title="Name topics and draft summaries with your model"
          desc={`Quorum finds and names topics on this Mac with no model. With this on, your model source gives them better names and drafts the topic summaries offered in Needs review. ${cost}`}>
          <Toggle on={on} onChange={async (v) => onSettings(await window.quorum.setSettings({ memoryTopicModel: v }))} label="Name topics and draft summaries with your model" />
        </Row>
        {status?.model.error && on && <p className="set-hint">The last model pass stopped: {status.model.error}</p>}
      </div>
      {list && list.length ? (
        <div className="set-card mt-topics">
          {list.slice(0, SHOWN).map((c) => (
            <div key={c.id} className="set-line mt-topic">
              <span className="mr-name">
                <strong>{c.name}</strong>
                <span className="muted">{plural(c.size, 'member')}{c.namedBy === 'model' ? ', named by your model' : ''}{c.tags.length ? `, ${c.tags.join(', ')}` : ''}{c.folder ? `, in ${c.folder}` : ''}</span>
              </span>
              <span className="mr-counts">
                {c.top.slice(0, 4).map((m) => <span key={m.id} className="mr-count"><NodeButton n={m} /></span>)}
              </span>
            </div>
          ))}
          {list.length > SHOWN && <p className="set-note">{plural(list.length - SHOWN, 'more topic')}. AI tools list them all with the communities tool.</p>}
        </div>
      ) : (
        <EmptyState icon={<IconGraph width={18} height={18} />} title={list === null || status?.phase === 'running' ? 'Finding topics' : 'No topics yet'}>
          <p className="set-hint">Quorum groups notes that link to each other into topics once the memory graph is built.</p>
        </EmptyState>
      )}
      {hubs.length > 0 && (
        <>
          <h3>Most connected</h3>
          <div className="set-card">
            {hubs.map((h) => (
              <div key={h.id} className="set-line mt-hub">
                <span className="mr-name"><NodeButton n={h} /><span className="muted">{h.kind}{h.communityName ? `, ${h.communityName}` : ''}</span></span>
                <span className="mr-counts"><span className="mr-count">{plural(h.degree, 'neighbor')}</span><span className="mr-count">{plural(h.edges, 'edge')}</span></span>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
