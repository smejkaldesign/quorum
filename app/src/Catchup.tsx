import { useEffect, useRef, useState } from 'react';
import type { CatchupEstimate, CatchupStatus } from './quorum';
import { Modal, ModalActions } from './controls';
import { WorkBanner } from './WorkBanner';
import { planRows, progressText, ranAt, showSummary, summaryOf } from './catchupView';

// Check everything now (memoryCatchup.js): one pass over every note the agent has not read yet, past the daily limit.
// Onboarding offers it once the vault connects, and Settings > Memory has the button
export const DRAFTS_NEEDED = 'It also turns on Let the agent draft fixes, which the check needs.';
const calls = (n: number) => `${n} ${n === 1 ? 'call' : 'calls'}`;
// what the pass costs, from the estimate main computes from stage 1 and the drafts that wait
export function catchupCost(e: CatchupEstimate | null) {
  return e ? `This uses your Claude plan for about ${calls(e.calls)} and runs in the background.` : 'This uses your Claude plan and runs in the background.';
}

// the estimate for the connected vault, read again when the memory changes. key: the vault root, so a new vault asks again
export function useCatchupEstimate(key: string | null) {
  // kept with the key it was read for, so a new vault shows no estimate until its own arrives
  const [got, setGot] = useState<{ key: string; est: CatchupEstimate } | null>(null);
  useEffect(() => {
    if (!key) return;
    let live = true;
    const read = () => window.quorum.memoryCatchupEstimate().then((e) => { if (live && e) setGot({ key, est: e }); }).catch(() => {});
    read();
    const off = window.quorum.onMemoryUpdates(() => { read(); });
    return () => { live = false; off(); };
  }, [key]);
  return key && got?.key === key ? got.est : null;
}

// the pass that runs now or ran last
export function useCatchupStatus() {
  const [st, setSt] = useState<CatchupStatus | null>(null);
  useEffect(() => {
    let live = true;
    window.quorum.memoryCatchupStatus().then((s) => { if (live) setSt(s); }).catch(() => {});
    const off = window.quorum.onMemoryCatchup((s) => setSt(s));
    return () => { live = false; off(); };
  }, []);
  return st;
}

// what the last pass did, in one line
export function catchupResult(st: CatchupStatus | null) {
  if (!st || st.running || !st.last) return null;
  const { end, done, total } = st.last;
  if (end === 'done') return `The last check made ${calls(done)}. What it found is in Needs review.`;
  if (end === 'cancelled') return `You stopped the last check after ${done} of ${calls(total)}. The rest runs under the daily limit.`;
  if (end === 'off') return 'The last check stopped because Let the agent draft fixes or background checks are off.';
  if (end === 'crashed') return 'The last check stopped early when Quorum closed. What it checked is saved, and the rest runs under the daily limit.';
  return 'The last check stopped on an error. The rest runs under the daily limit.';
}

// Settings > Memory: the button's text and the row's description, with the estimate and what the last pass did. The
// button is off while a pass runs and while no vault is connected (no estimate). It opens the plan first; Start runs it
export function useCatchupControl(drafting: boolean) {
  const est = useCatchupEstimate('memory');
  const st = useCatchupStatus();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [planning, setPlanning] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const running = !!st?.running;
  const close = () => { setPlanning(false); window.setTimeout(() => opener.current?.focus(), 0); };
  const start = async () => {
    setPlanning(false);
    setBusy(true); setNote('');
    try {
      const r = await window.quorum.memoryCatchupStart();
      if (r.turnedOn) setNote('Let the agent draft fixes is now on. The check needs it.');
    } catch (e) { setNote(String((e as Error)?.message ?? e)); } finally { setBusy(false); }
  };
  const line = st?.running ? `${progressText(st)}.` : catchupResult(st);
  return {
    desc: `Reads every note the agent has not read yet in one pass, past the daily limit, then the limit applies again. ${catchupCost(est)} It writes nothing to your notes; what it finds waits in Needs review.${drafting ? '' : ` ${DRAFTS_NEEDED}`}${line ? ` ${line}` : ''}${note ? ` ${note}` : ''}`,
    control: (
      <>
        <button ref={opener} className="pill small-pill" disabled={!est || running || busy} onClick={() => setPlanning(true)}>{running ? 'Checking' : 'Check everything now'}</button>
        {planning && est && <CatchupPlan est={est} drafting={drafting} onStart={start} onClose={close} />}
      </>
    ),
  };
}

// the plan before a pass starts: the notes to check, the notes saved from earlier checks, and estimates of the pairs to
// judge and the time
export function CatchupPlan({ est, drafting, onStart, onClose }: { est: CatchupEstimate; drafting: boolean; onStart: () => void; onClose: () => void }) {
  return (
    <Modal titleId="catchup-plan-title" title="Check everything now" describedBy="catchup-plan-desc" onClose={onClose}>
      <p id="catchup-plan-desc">{catchupCost(est)} It writes nothing to your notes; what it finds waits in Needs review.{drafting ? '' : ` ${DRAFTS_NEEDED}`}</p>
      <dl className="mh-parts">
        {planRows(est).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
      <ModalActions>
        <button className="pill" onClick={onClose}>Not now</button>
        <button className="pill primary" autoFocus onClick={onStart}>Start the check</button>
      </ModalActions>
    </Modal>
  );
}

// Memory health: the last pass that ended, with when it ran, how long it took, the notes it checked and what it added
// to Needs review. Show these narrows Needs review to its items; Dismiss hides the card for good
export function CatchupSummary({ onShow }: { onShow: (ids: string[], label: string) => void }) {
  const st = useCatchupStatus();
  if (!showSummary(st)) return null;
  const last = st.last;
  const s = summaryOf(last);
  const label = `From the check on ${ranAt(last.startedAt)}`;
  return (
    <WorkBanner
      className="catchup-card"
      state={s.state}
      text={`${s.head}. Ran ${ranAt(last.startedAt)}`}
      startedAt={last.startedAt}
      endedAt={last.endedAt ?? last.startedAt}
      note={<>{s.line}{s.added ? ` ${s.added}` : ''}</>}
      actions={<>
        {s.ids.length > 0 && <button className="act-pill" onClick={() => onShow(s.ids, label)}>Show these</button>}
        <button className="act-pill run-dismiss" onClick={() => { window.quorum.memoryCatchupDismiss().catch(() => {}); }}>Dismiss</button>
      </>}
    />
  );
}
