import { useEffect, useState } from 'react';
import { api } from '../api';
import { CODE_PLAN_LABEL, type Install, type User, activityLabel, installActive, onDate } from '../shape';
import { Badge, Card, Empty, Input, PageHeader, SectionTitle, SkeletonRows, Table, TableHead, TableRow } from '../ui';

// every account on this Quorum, newest first: when it signed up, when it was last seen, how many workspaces it is in.
// Below it, every install that checked in with an access code during the beta, both editions, newest heartbeat first
export function Users() {
  const [list, setList] = useState<User[] | null>(null);
  const [installs, setInstalls] = useState<Install[] | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => { api.users().then((r) => (r.ok ? setList(r.value) : setError(r.error))); api.installs().then((r) => (r.ok ? setInstalls(r.value) : setError(r.error))); }, []);
  const shownInstalls = (installs ?? []).filter((i) => !q.trim() || (i.email ?? '').toLowerCase().includes(q.trim().toLowerCase()));
  const shown = (list ?? []).filter((u) => !q.trim() || u.email.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <>
      <PageHeader title={list ? `${list.length} ${list.length === 1 ? 'account' : 'accounts'}` : 'Accounts'} actions={<Input className="search" placeholder="Find by email" value={q} onChange={(e) => setQ(e.target.value)} />} />
      {error && <p className="error">{error}</p>}
      <Card list>
        <Table columns="minmax(220px, 2fr) 120px 150px 90px">
          <TableHead><span>Email</span><span>Signed up</span><span>Last seen</span><span>Workspaces</span></TableHead>
          {list === null && <SkeletonRows />}
          {shown.map((u) => (
            <TableRow key={u.userId}>
              <span className="who inline"><strong>{u.email}</strong>{u.owner && <Badge tone="good">Owner</Badge>}</span>
              <span className="hide">{onDate(u.createdAt)}</span>
              <span>{u.lastSignInAt ? activityLabel(u.lastSignInAt) : 'Never signed in'}</span>
              <span className="hide">{u.workspaces}</span>
            </TableRow>
          ))}
          {list && !shown.length && <Empty>No accounts match.</Empty>}
        </Table>
      </Card>
      <SectionTitle>{installs ? `${installs.length} ${installs.length === 1 ? 'install' : 'installs'}` : 'Installs'}</SectionTitle>
      <Card list>
        <Table columns="minmax(200px, 2fr) 90px 90px 90px 120px 150px">
          <TableHead><span>Who</span><span>Edition</span><span>Version</span><span>Plan</span><span>First seen</span><span>Last seen</span></TableHead>
          {installs === null && <SkeletonRows />}
          {shownInstalls.map((i) => (
            <TableRow key={i.id}>
              <span className="who inline"><strong>{i.email ?? 'no email'}</strong>{installActive(i.lastSeen) && <Badge tone="good">Active</Badge>}</span>
              <span>{i.edition === 'cloud' ? 'Cloud' : 'Open source'}</span>
              <span className="hide">{i.appVersion ?? '?'}</span>
              <span><Badge tone={i.plan === 'cloud' ? 'good' : 'off'}>{CODE_PLAN_LABEL[i.plan]}</Badge></span>
              <span className="hide">{onDate(i.firstSeen)}</span>
              <span>{activityLabel(i.lastSeen)}</span>
            </TableRow>
          ))}
          {installs && !shownInstalls.length && <Empty>{installs.length ? 'No installs match.' : 'No install has checked in yet.'}</Empty>}
        </Table>
      </Card>
    </>
  );
}
