import { useState } from 'react';
import type { WhoAsk } from './quorum';

export type WhoAnswers = { names: Record<string, string>; people: string[]; me: string | null; lead: string | null };

const voiceLabel = (v: WhoAsk['voices'][number]) => (v.voice != null ? `${v.channel === 'me' ? 'Person' : 'Speaker'} ${v.voice + 1}`
  : v.channel === 'me' ? 'Your microphone' : "Your Mac's sound");

// After a recording, before anything is summarized: who each voice was, which one was you, and who led it. With voices
// told apart (Deepgram) each gets a name; with one microphone hearing the whole room, it asks who was there. The notes
// are written only after Summarize or Skip, so a recording that is discarded costs no model call.
export function WhoSpoke({ ask, onDone }: { ask: WhoAsk; onDone: (answers: WhoAnswers | null) => void }) {
  const [names, setNames] = useState<Record<string, string>>({});
  const [people, setPeople] = useState('');
  const [me, setMe] = useState<string | null>(null);
  const [lead, setLead] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const separated = ask.voices.some((v) => v.voice != null);
  const finish = (skip: boolean) => {
    setBusy(true);
    onDone(skip ? null : { names: separated ? names : {}, people: people.split(',').map((p) => p.trim()).filter(Boolean), me, lead: separated ? lead : null });
  };
  return (
    <section className="who-spoke">
      <h2>Who spoke?</h2>
      <p className="muted">{separated
        ? 'Quorum told these voices apart. Name them and the summary says who said what. Nothing is summarized until you continue.'
        : 'Quorum heard this through one microphone and cannot tell the voices apart. Say who was there and the summary uses their names. Nothing is summarized until you continue.'}</p>
      {ask.voices.map((v) => (
        <div key={v.key} className="who-voice">
          <div className="who-head">
            <strong>{voiceLabel(v)}</strong>
            <label className="who-pick"><input type="radio" name="who-me" checked={me === v.key} onChange={() => setMe(v.key)} />This was me</label>
            {separated && <label className="who-pick"><input type="radio" name="who-lead" checked={lead === v.key} onChange={() => setLead(v.key)} />Led it</label>}
          </div>
          <ul className="who-lines">{v.lines.map((l, i) => <li key={i}>"{l}"</li>)}</ul>
          {separated && me !== v.key && (
            <input className="who-input" placeholder="Name" value={names[v.key] ?? ''} onChange={(e) => setNames((n) => ({ ...n, [v.key]: e.target.value }))} />
          )}
        </div>
      ))}
      {!separated && <input className="who-input" placeholder="Who was there? Names, separated by commas" value={people} onChange={(e) => setPeople(e.target.value)} />}
      <div className="who-actions">
        <button className="pill who-go" disabled={busy} onClick={() => finish(false)}>Summarize</button>
        <button className="pill ghost" disabled={busy} onClick={() => finish(true)}>Skip</button>
      </div>
    </section>
  );
}
