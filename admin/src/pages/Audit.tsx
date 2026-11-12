import { useEffect, useState } from 'react';
import { api } from '../api';
import { type AuditRow, auditLine } from '../shape';
import { Card, Empty, PageHeader, SkeletonRows, Table, TableRow } from '../ui';

// what the owner did, newest first: every plan change, code and request decision writes a row (migrations 0008, 0009, 0016)
export function Audit() {
  const [list, setList] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api.audit(200).then((r) => (r.ok ? setList(r.value) : setError(r.error))); }, []);
  return (
    <>
      <PageHeader title="Audit" />
      {error && <p className="error">{error}</p>}
      <Card list>
        <Table columns="150px minmax(0, 1fr)" className="stack">
          {list === null && <SkeletonRows />}
          {list?.map((a) => (
            <TableRow key={a.id}>
              <span className="audit-when">{new Date(a.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
              <strong style={{ fontWeight: 400, whiteSpace: 'normal' }}>{auditLine(a)}</strong>
            </TableRow>
          ))}
          {list && !list.length && <Empty>Nothing yet.</Empty>}
        </Table>
      </Card>
    </>
  );
}
