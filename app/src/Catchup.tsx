import { useEffect, useState } from 'react';
import type { CatchupEstimate, CatchupStatus } from './quorum';

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
  return 'The last check stopped on an error. The rest runs under the daily limit.';
}

// Settings > Memory: the button's text and the row's description, with the estimate and what the last pass did. The
// button is off while a pass runs and while no vault is connected (no estimate)
export function useCatchupControl(drafting: boolean) {
  const est = useCatchupEstimate('memory');
  const st = useCatchupStatus();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const running = !!st?.running;
  const start = async () => {
    setBusy(true); setNote('');
    try {
      const r = await window.quorum.memoryCatchupStart();
      if (r.turnedOn) setNote('Let the agent draft fixes is now on. The check needs it.');
    } catch (e) { setNote(String((e as Error)?.message ?? e)); } finally { setBusy(false); }
  };
  const line = st?.running ? `Checking all ${st.notes} notes: ${st.done} of ${calls(st.total)}.` : catchupResult(st);
  return {
    desc: `Reads every note the agent has not read yet in one pass, past the daily limit, then the limit applies again. ${catchupCost(est)} It writes nothing to your notes; what it finds waits in Needs review.${drafting ? '' : ` ${DRAFTS_NEEDED}`}${line ? ` ${line}` : ''}${note ? ` ${note}` : ''}`,
    control: <button className="pill small-pill" disabled={!est || running || busy} onClick={start}>{running ? 'Checking' : 'Check everything now'}</button>,
  };
}
