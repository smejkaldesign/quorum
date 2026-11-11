import { useEffect, useState } from 'react';
import { api } from '../api';
import { type User, activityLabel, onDate } from '../shape';

// every account on this Quorum, newest first: when it signed up, when it was last seen, how many workspaces it is in
export function Users() {
  const [list, setList] = useState<User[] | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => { api.users().then((r) => (r.ok ? setList(r.value) : setError(r.error))); }, []);
  const shown = (list ?? []).filter((u) => !q.trim() || u.email.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <>
      <div className="head-row">
        <h1>{list ? `${list.length} ${list.length === 1 ? 'account' : 'accounts'}` : 'Accounts'}</h1>
        <input className="search" placeholder="Find by email" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {error && <p className="error">{error}</p>}
      <div className="card list">
        <div className="user-row user-head"><span>Email</span><span>Signed up</span><span>Last seen</span><span>Workspaces</span></div>
        {shown.map((u) => (
          <div key={u.userId} className="user-row">
            <strong>{u.email}{u.owner && <em className="state good">Owner</em>}</strong>
            <span>{onDate(u.createdAt)}</span>
            <span>{u.lastSignInAt ? activityLabel(u.lastSignInAt) : 'Never signed in'}</span>
            <span>{u.workspaces}</span>
          </div>
        ))}
        {list && !shown.length && <p className="muted pad">No accounts match.</p>}
      </div>
    </>
  );
}
