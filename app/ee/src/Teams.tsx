import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { Member, Team, TeamRole } from '../../src/quorum';
import { Row, Toggle, useMenu } from '../../src/controls';
import { IconMore, IconPeople, IconPlus } from '../../src/icons';
import { AccountCard, EE_MARKER, useAccount } from './Account';
import { accountApi } from './accountMock';
import { kbCall, KbConfirm } from './kbUi';
import { addableMembers, sortTeams, teamSummary } from './teamList';

const api = accountApi();

// Settings › Admin › Teams: one switch. Off, the workspace is one person's and the team-level pages stay out of the
// nav. On, members, organization connectors and voice, organization guardrails, knowledge review and the Knowledge
// tab's team content appear, the teams inside the workspace are listed (migration 0035), and the company card below
// is where the team describes itself
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
      {on && <TeamList wsAdmin={canManage} me={a.userId} />}
      {on && company}
      {!on && <p className="set-note">Until a team is on, this workspace is yours alone: no members, no shared knowledge, and nothing team-level in Settings.</p>}
    </div>
  );
}

type Open = { kind: 'people' | 'rename'; teamId: string } | null;

// the teams inside the workspace, each with its people and leads. Owners and admins create, rename and delete teams;
// they and a team's leads rename it and change its people. Each team gets a meetings knowledge base readable by the
// team; its leads grant other teams read access in Admin › Knowledge
function TeamList({ wsAdmin, me }: { wsAdmin: boolean; me: string | null }) {
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<Open>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Team | null>(null);
  const load = useCallback(async () => {
    const r = await kbCall(() => window.quorum.teamList(), 'The teams could not be read.');
    if (r.error) setError(r.error); else { setError(''); setTeams(r.teams ?? []); }
  }, []);
  useEffect(() => {
    load();
    api.membersList().then((r) => { if (!('error' in r)) setMembers(r.members); }).catch(() => {});
  }, [load]);
  const replace = (t: Team) => setTeams((list) => (list ?? []).map((x) => (x.id === t.id ? t : x)));
  const remove = async (t: Team) => {
    setDeleting(null);
    const r = await kbCall(() => window.quorum.teamDelete(t.id), 'The team could not be deleted.');
    if (r.error) setError(r.error); else { setError(''); setTeams((list) => (list ?? []).filter((x) => x.id !== t.id)); }
  };
  const isOpen = (kind: 'people' | 'rename', id: string) => open?.kind === kind && open.teamId === id;
  return (
    <>
      <h3>Teams</h3>
      <div className="set-card">
        {teams === null && !error && <p className="set-hint">Loading…</p>}
        {teams?.map((t) => (
          <div key={t.id} className="kb-admin-item">
            <Row icon={<IconPeople width={18} height={18} />} title={t.name} desc={teamSummary(t)}>
              <button className="pill small" aria-expanded={isOpen('people', t.id)} onClick={() => setOpen(isOpen('people', t.id) ? null : { kind: 'people', teamId: t.id })}>People</button>
              {t.canManage && <TeamMenu team={t} wsAdmin={wsAdmin} onPick={(kind) => (kind === 'delete' ? setDeleting(t) : setOpen({ kind, teamId: t.id }))} />}
            </Row>
            {isOpen('rename', t.id) && <TeamName team={t} onDone={(next) => { if (next) replace(next); setOpen(null); }} />}
            {isOpen('people', t.id) && <TeamPeople team={t} members={members} me={me} onChange={replace} />}
          </div>
        ))}
        {teams && !teams.length && <p className="set-hint">{wsAdmin ? 'No teams yet. Create one to give a group its own meetings and knowledge.' : 'No teams yet. An owner or admin can create one.'}</p>}
      </div>
      {error && <p className="set-error" role="alert">{error}</p>}
      {wsAdmin && (creating
        ? <TeamName team={null} onDone={(next) => { setCreating(false); if (next) { setTeams((list) => sortTeams([...(list ?? []), next])); setOpen({ kind: 'people', teamId: next.id }); } }} />
        : <p><button className="pill with-icon" onClick={() => { setCreating(true); setOpen(null); }}><IconPlus width={15} height={15} />New team</button></p>)}
      {deleting && <KbConfirm title={`Delete ${deleting.name}?`} body="Its people stay in the workspace. Its knowledge bases, its meetings one included, become workspace knowledge bases that owners, admins and any team already granted read access can read. This cannot be undone." action="Delete" onDone={(ok) => (ok ? remove(deleting) : setDeleting(null))} />}
    </>
  );
}

function TeamMenu({ team, wsAdmin, onPick }: { team: Team; wsAdmin: boolean; onPick: (kind: 'rename' | 'delete') => void }) {
  const [open, setOpen] = useMenu();
  return (
    <span className="menu-wrap">
      <button className="icon-btn" aria-label={`More for ${team.name}`} aria-haspopup="menu" aria-expanded={open} onClick={(e) => { e.stopPropagation(); setOpen(!open); }}><IconMore width={16} height={16} /></button>
      {open && (
        <div className="menu" role="menu">
          <button role="menuitem" onClick={() => onPick('rename')}>Rename</button>
          {wsAdmin && <button role="menuitem" className="danger-pill" onClick={() => onPick('delete')}>Delete</button>}
        </div>
      )}
    </span>
  );
}

// a new team's name (team null), or a new name for a team
function TeamName({ team, onDone }: { team: Team | null; onDone: (team: Team | null) => void }) {
  const [name, setName] = useState(team?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    const next = name.trim();
    if (busy || !next) return;
    if (team && next === team.name) { onDone(null); return; }
    setBusy(true); setError('');
    const fallback = team ? 'The team could not be renamed.' : 'The team could not be created.';
    const r = await kbCall(() => (team ? window.quorum.teamRename(team.id, next) : window.quorum.teamCreate(next)), fallback);
    setBusy(false);
    if (r.error || !r.team) setError(r.error ?? fallback); else onDone(r.team);
  };
  return (
    <div className={team ? 'kb-panel' : 'set-card kb-create'}>
      {!team && <h3 className="kb-create-title">New team</h3>}
      <div className="kb-form-row">
        <span className="set-field wide"><input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={team ? undefined : 'Name, for example Design'} aria-label="Team name" onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') onDone(null); }} /></span>
        <button className="pill primary" disabled={busy || !name.trim()} onClick={save}>{busy ? 'Saving…' : team ? 'Save' : 'Create'}</button>
        <button className="pill ghost" onClick={() => onDone(null)}>Cancel</button>
      </div>
      {!team && <p className="kb-hint muted">A team gets its own meetings knowledge base, readable by the team.</p>}
      {error && <p className="set-error" role="alert">{error}</p>}
    </div>
  );
}

// a team's people with their roles, and adding a workspace member; people who do not manage the team see the list and
// can leave it themselves
function TeamPeople({ team, members, me, onChange }: { team: Team; members: Member[]; me: string | null; onChange: (team: Team) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState('');
  const run = async (fn: () => Promise<{ error?: string; team?: Team }>) => {
    setBusy(true); setError('');
    const r = await kbCall(fn, 'The team could not be changed.');
    setBusy(false);
    if (r.error || !r.team) setError(r.error ?? 'The team could not be changed.'); else onChange(r.team);
  };
  const others = addableMembers(team, members);
  const label = (m: { name: string | null; email: string | null }) => m.name || m.email || 'Someone';
  return (
    <div className="kb-panel">
      {!team.members.length && <p className="set-hint">Nobody is in this team yet.</p>}
      {team.members.map((m) => (
        <div key={m.userId} className="kb-form-row">
          <span className="wide">{label(m)}</span>
          {team.canManage ? (
            <>
              <select className="set-select" value={m.role} disabled={busy} aria-label={`Role of ${label(m)}`} onChange={(e) => run(() => window.quorum.teamMemberSet({ teamId: team.id, userId: m.userId, role: e.target.value as TeamRole }))}>
                <option value="member">Member</option><option value="lead">Lead</option>
              </select>
              <button className="pill ghost small" disabled={busy} onClick={() => run(() => window.quorum.teamMemberRemove({ teamId: team.id, userId: m.userId }))}>Remove</button>
            </>
          ) : <em className="muted">{m.role === 'lead' ? 'Lead' : 'Member'}</em>}
        </div>
      ))}
      {team.canManage && others.length > 0 && (
        <div className="kb-form-row">
          <select className="set-select" value={adding} disabled={busy} aria-label={`Add someone to ${team.name}`} onChange={(e) => setAdding(e.target.value)}>
            <option value="">Add someone…</option>
            {others.map((m) => <option key={m.userId} value={m.userId}>{label(m)}</option>)}
          </select>
          <button className="pill primary small" disabled={busy || !adding} onClick={() => { const id = adding; setAdding(''); run(() => window.quorum.teamMemberSet({ teamId: team.id, userId: id })); }}>Add</button>
        </div>
      )}
      {me && team.myRole && !team.canManage && <p><button className="pill ghost small" disabled={busy} onClick={() => run(() => window.quorum.teamMemberRemove({ teamId: team.id, userId: me }))}>Leave team</button></p>}
      {error && <p className="set-error" role="alert">{error}</p>}
    </div>
  );
}
