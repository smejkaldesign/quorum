import { useEffect, useState } from 'react';
import { api } from '../api';
import { type User, activityLabel, onDate } from '../shape';
import { Badge, Card, Empty, Input, PageHeader, SkeletonRows, Table, TableHead, TableRow } from '../ui';

// every account on this Quorum, newest first: when it signed up, when it was last seen, how many workspaces it is in
export function Users() {
  const [list, setList] = useState<User[] | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => { api.users().then((r) => (r.ok ? setList(r.value) : setError(r.error))); }, []);
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
    </>
  );
}
