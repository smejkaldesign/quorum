import { useEffect, useState } from 'react';
import { RELAY_URL, api, host } from '../api';
import { type Overview as OverviewData, hours } from '../shape';

// the first screen: the counts that say how the beta is going, and whether the relay is up with everything on
export function Overview() {
  const [o, setO] = useState<OverviewData | null>(null);
  const [error, setError] = useState('');
  const [relay, setRelay] = useState<{ engine: string; billing: boolean; mail: boolean; notes: boolean; zoom: boolean } | null | 'down'>(null);
  useEffect(() => {
    api.overview().then((r) => (r.ok ? setO(r.value) : setError(r.error)));
    api.relayHealth().then((r) => setRelay(r.ok ? r.value : 'down'));
  }, []);
  // the period starts at midnight UTC; shown in UTC so the month never slips a day in a western time zone
  const month = o ? new Date(o.monthStart).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }) : '';
  return (
    <>
      <h1>Overview</h1>
      {error && <p className="error">{error}</p>}
      <div className="tiles">
        <Tile n={o?.requestsPending} label="Requests waiting" href="#/access" hot={!!o?.requestsPending} />
        <Tile n={o?.codesOpen} label="Codes open" href="#/access" />
        <Tile n={o?.users} label="Accounts" href="#/users" />
        <Tile n={o?.workspaces} label="Workspaces" sub={o ? `${o.paidWorkspaces} paying` : undefined} href="#/workspaces" />
        <Tile n={o?.members} label="Memberships" href="#/workspaces" />
        <Tile n={o ? hours(o.managedHoursMonth) : undefined} label="Managed hours" sub={month} href="#/workspaces" />
      </div>
      <h2>Services</h2>
      <div className="card">
        <div className="line"><span>Database</span><strong>{host}</strong></div>
        <div className="line"><span>Relay</span><strong>{relay === null ? 'Checking…' : relay === 'down' ? <em className="bad">Not answering</em> : <em className="good">Up</em>}<span className="muted"> · {RELAY_URL.replace(/^https?:\/\//, '')}</span></strong></div>
        {relay && relay !== 'down' && (
          <>
            <div className="line"><span>Transcription</span><strong>{relay.engine}</strong></div>
            <div className="line"><span>Notes on managed keys</span><strong>{relay.notes ? <em className="good">On</em> : <em className="bad">Off</em>}</strong></div>
            <div className="line"><span>Billing</span><strong>{relay.billing ? <em className="good">On</em> : <em className="bad">Off</em>}</strong></div>
            <div className="line"><span>Code email</span><strong>{relay.mail ? <em className="good">On</em> : <em className="bad">Off: set RESEND_API_KEY on the relay</em>}</strong></div>
            <div className="line"><span>Zoom connect</span><strong>{relay.zoom ? <em className="good">On</em> : <em className="bad">Off</em>}</strong></div>
          </>
        )}
      </div>
    </>
  );
}

function Tile({ n, label, sub, href, hot }: { n: number | string | undefined; label: string; sub?: string; href: string; hot?: boolean }) {
  return (
    <a className={`tile ${hot ? 'hot' : ''}`} href={href}>
      <strong>{n === undefined ? '…' : n}</strong>
      <span>{label}</span>
      {sub && <em>{sub}</em>}
    </a>
  );
}
