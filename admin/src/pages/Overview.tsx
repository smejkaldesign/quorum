import { useEffect, useState } from 'react';
import { RELAY_URL, api, host } from '../api';
import { type Overview as OverviewData, hours } from '../shape';
import { Card, CardLine, MetricCard, MetricGrid, PageHeader, SectionTitle } from '../ui';

// the first screen: the counts that say how the beta is going, and whether the relay is up with everything on
export function Overview() {
  const [o, setO] = useState<OverviewData | null>(null);
  const [error, setError] = useState('');
  const [relay, setRelay] = useState<{ engine: string; billing: boolean; mail: boolean; notes: boolean; zoom: boolean; flags: boolean } | null | 'down'>(null);
  useEffect(() => {
    api.overview().then((r) => (r.ok ? setO(r.value) : setError(r.error)));
    api.relayHealth().then((r) => setRelay(r.ok ? r.value : 'down'));
  }, []);
  // the period starts at midnight UTC; shown in UTC so the month never slips a day in a western time zone
  const month = o ? new Date(o.monthStart).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }) : '';
  const on = (v: boolean, off = 'Off') => (v ? <em className="good">On</em> : <em className="bad">{off}</em>);
  return (
    <>
      <PageHeader title="Overview" />
      {error && <p className="error">{error}</p>}
      <MetricGrid>
        <MetricCard value={o?.requestsPending} label="Requests waiting" href="#/access" hot={!!o?.requestsPending} />
        <MetricCard value={o?.codesOpen} label="Codes open" href="#/access" />
        <MetricCard value={o?.users} label="Accounts" href="#/users" />
        <MetricCard value={o?.workspaces} label="Workspaces" sub={o ? `${o.paidWorkspaces} paying` : undefined} href="#/workspaces" />
        <MetricCard value={o?.members} label="Memberships" href="#/workspaces" />
        <MetricCard value={o ? hours(o.managedHoursMonth) : undefined} label="Managed hours" sub={month} href="#/workspaces" />
      </MetricGrid>
      <SectionTitle>Services</SectionTitle>
      <Card>
        <CardLine label="Database"><span className="muted">{host}</span></CardLine>
        <CardLine label="Relay">{relay === null ? 'Checking…' : relay === 'down' ? <em className="bad">Not answering</em> : <em className="good">Up</em>}<span className="muted"> · {RELAY_URL.replace(/^https?:\/\//, '')}</span></CardLine>
        {relay && relay !== 'down' && (
          <>
            <CardLine label="Transcription">{relay.engine}</CardLine>
            <CardLine label="Notes on managed keys">{on(relay.notes)}</CardLine>
            <CardLine label="Billing">{on(relay.billing)}</CardLine>
            <CardLine label="Code email">{on(relay.mail, 'Off: set RESEND_API_KEY on the relay')}</CardLine>
            <CardLine label="Zoom connect">{on(relay.zoom)}</CardLine>
            <CardLine label="Feature flags">{on(relay.flags, 'Off: the relay predates GET /v1/flags')}</CardLine>
          </>
        )}
      </Card>
    </>
  );
}
