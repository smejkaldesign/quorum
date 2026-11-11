import { useEffect, useState } from 'react';
import { api } from '../api';
import { type AuditRow, auditLine } from '../shape';

// what the owner did, newest first: every plan change, code and request decision writes a row (migrations 0008, 0009, 0016)
export function Audit() {
  const [list, setList] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api.audit(200).then((r) => (r.ok ? setList(r.value) : setError(r.error))); }, []);
  return (
    <>
      <h1>Audit</h1>
      <p className="muted lede">Every change made from here, newest first. The rows are written by the database functions themselves, so nothing can be changed without a line.</p>
      {error && <p className="error">{error}</p>}
      <div className="card list">
        {list?.map((a) => (
          <div key={a.id} className="audit-row">
            <span className="muted when">{new Date(a.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
            <span>{auditLine(a)}</span>
          </div>
        ))}
        {list && !list.length && <p className="muted pad">Nothing yet.</p>}
      </div>
    </>
  );
}
