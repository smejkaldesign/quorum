import { useEffect, useState } from 'react';
import type { MeetingSource, MeetingSources } from './quorum';
import { Row } from './controls';
import { IconNotes } from './icons';

// The meeting-notes source accounts a team workspace has seen (Quorum Cloud with a team; ee/meetingsKb.js). A
// connector account can hold another organization's meetings, so each one is asked once whether its meetings go to the
// workspace's meetings knowledge base; until the person answers, its notes stay private.

export function useMeetingSources(): [MeetingSources | null, () => void] {
  const [data, setData] = useState<MeetingSources | null>(null);
  const load = () => { window.quorum.meetingsSources().then(setData).catch(() => {}); };
  useEffect(() => { load(); return window.quorum.onMeetingsSources(load); }, []);
  return [data, load];
}

const question = (s: Pick<MeetingSource, 'label'>, data: MeetingSources | null) =>
  `Share meetings from ${s.label} with ${data?.workspaceName ? `${data.workspaceName}'s` : 'your workspace\'s'} ${data?.kbName ?? 'Meetings'} knowledge base?`;

// one source's question with Share and Keep private; onDone runs after the choice is saved
export function SourceAsk({ source, data, onDone }: { source: Pick<MeetingSource, 'key' | 'label'>; data: MeetingSources | null; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pick = async (choice: 'share' | 'private') => {
    setBusy(true);
    setError(null);
    const r = await window.quorum.meetingsSourceSet(source.key, choice).catch((err) => ({ error: String(err) }));
    setBusy(false);
    if ('error' in r) setError(r.error); else onDone();
  };
  return (
    <div className="source-ask" role="group" aria-label={`Meetings from ${source.label}`}>
      <p>{question(source, data)} Until you choose, they stay private.</p>
      <div className="source-ask-actions">
        <button className="pill primary small-pill" disabled={busy} onClick={() => pick('share')}>Share</button>
        <button className="pill small-pill" disabled={busy} onClick={() => pick('private')}>Keep private</button>
      </div>
      {error && <p className="set-error" role="alert">{error}</p>}
    </div>
  );
}

// the History banner: every source still waiting for an answer
export function SourceAskBanner() {
  const [data, load] = useMeetingSources();
  const waiting = data?.available ? data.sources.filter((s) => s.choice === null) : [];
  if (!waiting.length) return null;
  return <div className="source-ask-banner">{waiting.map((s) => <SourceAsk key={s.key} source={s} data={data} onDone={load} />)}</div>;
}

// Settings > Meetings: each source with its choice, and the one-time share of its past notes
export function MeetingSourcesRows() {
  const [data, load] = useMeetingSources();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  if (!data?.available || (!data.sources.length && !(data.teams?.length ?? 0))) return null;
  const set = async (key: string, choice: 'share' | 'private') => { const r = await window.quorum.meetingsSourceSet(key, choice); setNote('error' in r ? r.error : null); load(); };
  const sharePast = async (key: string) => {
    setConfirming(null);
    const r = await window.quorum.meetingsSourceSharePast(key);
    setNote('error' in r ? r.error : `${r.shared} past ${r.shared === 1 ? 'note' : 'notes'} shared.`);
    load();
  };
  return (
    <>
      <MeetingTeamRow data={data} onDone={load} />
      {data.sources.map((s) => (
        <div key={s.key}>
          <Row icon={<IconNotes width={18} height={18} />} title={`Meetings from ${s.label}`}
            desc={s.choice === 'share' ? `New meetings go to the ${data.kbName ?? 'Meetings'} knowledge base.` : s.choice === 'private' ? 'Kept private.' : 'Not chosen yet, so they stay private.'}>
            <select className="set-select" value={s.choice ?? ''} aria-label={`Meetings from ${s.label}`} onChange={(e) => { if (e.target.value) set(s.key, e.target.value as 'share' | 'private'); }}>
              {s.choice === null && <option value="">Choose</option>}
              <option value="share">Share</option><option value="private">Keep private</option>
            </select>
          </Row>
          {s.past > 0 && (
            <div className="source-past">
              {confirming === s.key ? (
                <>
                  <span>Share {s.past} past {s.past === 1 ? 'note' : 'notes'} from {s.label} with your team? Confidential notes and excluded folders stay private.</span>
                  <button className="pill primary small-pill" onClick={() => sharePast(s.key)}>Share {s.past}</button>
                  <button className="pill small-pill" onClick={() => setConfirming(null)}>Cancel</button>
                </>
              ) : (
                <button className="pill small-pill" disabled={data.sync === false} onClick={() => setConfirming(s.key)}>Share past meeting notes from this source ({s.past})</button>
              )}
            </div>
          )}
        </div>
      ))}
      {note && <p className="set-hint" role="status">{note}</p>}
    </>
  );
}

// Settings > Meetings for a person in several teams: which team's meetings knowledge base receives their meeting notes.
// Until they choose, the team they joined first does
export function MeetingTeamRow({ data, onDone }: { data: MeetingSources; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const teams = data.teams ?? [];
  if (teams.length < 2) return null;
  const pick = async (teamId: string) => {
    setBusy(true);
    setError(null);
    const r = await window.quorum.meetingsTeamSet(teamId).catch((err) => ({ error: String(err) }));
    setBusy(false);
    if ('error' in r) setError(r.error); else onDone();
  };
  return (
    <>
      <Row icon={<IconNotes width={18} height={18} />} title="Meeting team"
        desc={`You are in ${teams.length} teams. Shared meeting notes go to the meetings knowledge base of the team you pick${data.kbName ? `, now ${data.kbName}` : ''}.`}>
        <select className="set-select" value={data.teamId ?? teams[0].id} disabled={busy} aria-label="Meeting team" onChange={(e) => pick(e.target.value)}>
          {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </Row>
      {error && <p className="set-error" role="alert">{error}</p>}
    </>
  );
}
