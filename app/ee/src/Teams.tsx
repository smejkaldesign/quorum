import { useState, type ReactNode } from 'react';
import { Row, Toggle } from '../../src/controls';
import { IconPeople } from '../../src/icons';
import { AccountCard, EE_MARKER, useAccount } from './Account';
import { accountApi } from './accountMock';

const api = accountApi();

// Settings › Admin › Teams: one switch. Off, the workspace is one person's and the team-level pages stay out of the
// nav. On, members, organization connectors and voice, organization guardrails, knowledge review and the Knowledge
// tab's team content appear, and the company card below is where the team describes itself
export function TeamsPage({ company }: { company: ReactNode }) {
  const a = useAccount();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!a) return null;
  if (!a.signedIn || !a.workspace) return <AccountCard account={a} />;
  const ws = a.workspace;
  const canManage = ws.role !== 'member';
  const on = ws.teamEnabled === true;
  const flip = async (v: boolean) => {
    setBusy(true); setError('');
    const r = await api.teamEnabledSet(v);
    setBusy(false);
    if (r.error) setError(r.error);
  };
  return (
    <div data-ee={EE_MARKER}>
      <h3>Team</h3>
      <div className="set-card">
        <Row icon={<IconPeople width={18} height={18} className={on ? 'ok' : undefined} />} title="Enable a team"
          desc={on ? `${ws.name} is a team. Members, organization settings and team knowledge are on for everyone in it.` : canManage ? 'Turn this on to invite members, set organization connectors, voice and guardrails, and build team knowledge together.' : 'An owner or admin can turn the team on.'}>
          <Toggle on={on} disabled={!canManage || busy} onChange={flip} />
        </Row>
        {error && <p className="set-error">{error}</p>}
      </div>
      {on && company}
      {!on && <p className="set-note">Until a team is on, this workspace is yours alone: no members, no shared knowledge, and nothing team-level in Settings.</p>}
    </div>
  );
}
