import { useEffect, useState } from 'react';
import type { MeetingPrepSettings } from './quorum';
import { Row, Toggle } from './controls';
import { IconCalendar, IconNotes, IconPeople } from './icons';
import { useFlag } from './flags';

const DEFAULTS: MeetingPrepSettings = { enabled: false, ahead: 'today', minInvitees: 3, orNew: true, minPast: 3 };

// Settings > Calendar > Meeting prep (main.js meeting-prep): on or off, how far ahead notes are prepared, and which
// meetings get one ahead of time, and how many past meetings a meeting page needs before it writes prep notes by itself.
// Shown only while the meeting-prep flag is on
export function MeetingPrepCard() {
  const on = useFlag('meeting-prep');
  const [conf, setConf] = useState<MeetingPrepSettings | null>(null);
  useEffect(() => { window.quorum.getSettings().then((s) => setConf({ ...DEFAULTS, ...(s?.meetingPrep ?? {}) })).catch(() => setConf(DEFAULTS)); }, []);
  if (!on || !conf) return null;
  const save = async (patch: Partial<MeetingPrepSettings>) => {
    const s = await window.quorum.setSettings({ meetingPrep: { ...conf, ...patch } });
    setConf({ ...DEFAULTS, ...(s?.meetingPrep ?? {}) });
  };
  return (
    <>
      <h3>Meeting prep</h3>
      <div className="set-card">
        <Row icon={<IconNotes width={18} height={18} />} title="Prep notes for upcoming meetings" desc="Opening a meeting in Up next shows a note built from your vault, written by your own model and saved into your vault">
          <Toggle on={conf.enabled} onChange={(v) => save({ enabled: v })} />
        </Row>
        <Row icon={<IconCalendar width={18} height={18} />} title="Prepare ahead" desc="Notes for meetings in this window are ready before you open them">
          <select className="set-select" disabled={!conf.enabled} value={String(conf.ahead)} onChange={(e) => save({ ahead: e.target.value === 'today' ? 'today' : (Number(e.target.value) as MeetingPrepSettings['ahead']) })}>
            <option value="today">Rest of today</option>
            {[2, 4, 8, 24].map((h) => <option key={h} value={h}>Next {h} hours</option>)}
          </select>
        </Row>
        <Row icon={<IconPeople width={18} height={18} />} title="Which meetings" desc="Smaller meetings with people you already know are prepared only when you ask">
          <select className="set-select" disabled={!conf.enabled} value={conf.minInvitees} onChange={(e) => save({ minInvitees: Number(e.target.value) as MeetingPrepSettings['minInvitees'] })}>
            <option value={0}>Every meeting</option>
            {[2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} or more people</option>)}
          </select>
        </Row>
        {conf.minInvitees > 0 && (
          <Row icon={<IconPeople width={18} height={18} />} title="Also when someone is new" desc="Prepare a note when someone invited has never been in a meeting with you">
            <Toggle on={conf.orNew} disabled={!conf.enabled} onChange={(v) => save({ orNew: v })} />
          </Row>
        )}
        <Row icon={<IconNotes width={18} height={18} />} title="Meetings that are not recurring yet" desc="A meeting page writes prep notes by itself after this many meetings. Before that, Generate anyway writes them from the invite and your vault">
          <select className="set-select" value={conf.minPast} onChange={(e) => save({ minPast: Number(e.target.value) as MeetingPrepSettings['minPast'] })}>
            <option value={0}>Every meeting</option>
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>After {n} {n === 1 ? 'meeting' : 'meetings'}</option>)}
          </select>
        </Row>
      </div>
    </>
  );
}
