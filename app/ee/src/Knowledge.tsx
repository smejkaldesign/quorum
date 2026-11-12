import { useEffect, useState } from 'react';
import type { ContributionMine, QueueItem } from '../../src/quorum';
import { Row, Toggle } from '../../src/controls';
import { IconCheck, IconDoc, IconStack } from '../../src/icons';
import { AccountCard, EE_MARKER, useAccount } from './Account';
import { knowledgeApi } from './accountMock';

const api = knowledgeApi();
const STATUS: Record<string, string> = { pending: 'Waiting for review', included: 'Included', declined: 'Declined' };

// Settings › Knowledge, Cloud: the auto-include switch, how many notes wait in the Knowledge tab's review queue, and
// every member's list of what they shared and where it stands
export function KnowledgePage() {
  const a = useAccount();
  if (!a) return null;
  if (!a.signedIn || !a.workspace) return <AccountCard account={a} />;
  return <Knowledge admin={a.workspace.role !== 'member'} />;
}

function Knowledge({ admin }: { admin: boolean }) {
  const [auto, setAuto] = useState(false);
  const [mine, setMine] = useState<ContributionMine[]>([]);
  const [queue, setQueue] = useState<QueueItem[] | null>(null);
  const [error, setError] = useState('');
  const load = () => {
    api.knowledgeStatus().then((r) => { if (r.error) setError(r.error); else { setAuto(!!r.autoInclude); setMine(r.mine ?? []); } });
    if (admin) api.knowledgeQueue().then((r) => { if (r.error) setError(r.error); else setQueue(r.queue ?? []); });
  };
  useEffect(() => { load(); }, [admin]);
  const toggle = async (on: boolean) => { setAuto(on); const r = await api.knowledgeAutoIncludeSet(on); if (r.error) { setError(r.error); setAuto(!on); } };
  return (
    <div data-ee={EE_MARKER}>
      {admin && (
        <>
          <h3>Review</h3>
          <div className="set-card">
            <Row icon={<IconStack width={18} height={18} />} title="Include public notes without review" desc={auto ? 'On: a note a member marks public is company knowledge at once.' : 'Off: a note a member marks public waits until an admin includes it.'}>
              <Toggle on={auto} onChange={toggle} />
            </Row>
            <Row icon={<IconDoc width={18} height={18} />} title="Waiting for review" desc={queue === null ? 'Loading…' : queue.length ? `${queue.length} ${queue.length === 1 ? 'note waits' : 'notes wait'} in the Knowledge tab, where admins include or decline each one.` : 'Nothing waiting. Notes members mark public appear in the Knowledge tab.'} />
          </div>
        </>
      )}
      <h3>Your shared notes</h3>
      <div className="set-card">
        {mine.map((m) => (
          <Row key={m.noteId} icon={m.status === 'included' ? <IconCheck width={18} height={18} className="ok" /> : <IconDoc width={18} height={18} />} title={m.path.replace(/^.*\//, '').replace(/\.md$/, '')} desc={m.path}>
            <span className={`muted ${m.status === 'included' ? 'ok' : ''}`}>{STATUS[m.status] ?? m.status}</span>
          </Row>
        ))}
        {!mine.length && <p className="set-hint">Mark a note public to share it with the workspace. {admin || auto ? 'It is included at once.' : 'An admin reviews it first.'}</p>}
      </div>
      {error && <p className="set-error">{error}</p>}
    </div>
  );
}
