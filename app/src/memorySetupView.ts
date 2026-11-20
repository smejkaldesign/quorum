// What the Memory setup card shows (MemorySetup.tsx), as plain functions the tests can run.
import type { MemorySetupState, ModelPassEstimate, ModelPassStatus } from './quorum';

// The keeper row. On a vault the person connected, in onboarding, the keeper is offered: shown selected and pending
// until the person chooses. Pending writes nothing; finishing setup with it selected, or a toggle, records the choice.
// A choice already made (on or off) is never offered again
export function keeperRow({ offer, made, choice, on }: { offer: boolean; made: 'quorum' | null; choice: 'on' | 'off' | null; on: boolean }) {
  const pending = offer && made !== 'quorum' && choice == null;
  return { on: pending ? true : on, pending };
}

// the scan's share done, 0 to 100
export function percent(progress: MemorySetupState['progress']) {
  return progress ? Math.round((progress.done / Math.max(1, progress.total)) * 100) : 0;
}

// what a screen reader hears: the phase name only. The visible label adds a count that changes every quarter second
export function phaseName(s: Pick<MemorySetupState, 'phase' | 'phases'>) {
  return s.phases?.find((p) => p.id === s.phase)?.label ?? 'Starting';
}

// The model pass row (MemorySetup.tsx ModelPassRow): the estimate before it runs, and what a run is doing or did
const num = (x: number) => Math.round(x).toLocaleString('en-US');
const many = (x: number, one: string, more = `${one}s`) => `${num(x)} ${x === 1 ? one : more}`;
export function duration(seconds: number) {
  if (seconds < 90) return 'about a minute';
  const m = Math.round(seconds / 60);
  if (m < 90) return `about ${m} minutes`;
  const h = Math.round(m / 6) / 10;
  return `about ${h} hours`;
}
export function modelEstimateText(e: ModelPassEstimate | null | undefined) {
  if (!e) return 'Quorum estimates the cost once the memory graph is built.';
  const out: string[] = [];
  if (!e.notes) out.push('Nothing to read now: every note it may read is read.');
  else {
    out.push(`Reads ${many(e.notes, 'note')}: about ${num(e.tokens)} tokens in ${many(e.calls, 'call')}, ${duration(e.seconds)}.`);
    out.push(`${e.cost.label}.`);
    if (e.runs > 1) out.push(`Your cap of ${num(e.cap)} tokens a run splits it into ${num(e.runs)} runs.`);
    if (e.cut) out.push(`${many(e.cut, 'long note')} ${e.cut === 1 ? 'is' : 'are'} read up to the first 40,000 characters.`);
  }
  if (e.withheld) out.push(`${many(e.withheld, 'note')} never ${e.withheld === 1 ? 'goes' : 'go'} to the model: private, confidential, opted out or on the never-listen list.`);
  return out.join(' ');
}
export function modelStateText(s: Pick<ModelPassStatus, 'phase' | 'done' | 'total' | 'tokens' | 'cap' | 'edges' | 'proposals' | 'error' | 'counts' | 'on'>) {
  const held = s.counts ? `${many(s.counts.edges, 'connection')} from the model in the graph · ${num(s.counts.waiting)} waiting in Needs review` : '';
  const run = (() => {
    switch (s.phase) {
      case 'running': return `Reading ${num(s.done)} of ${many(s.total, 'note')} · ${num(s.tokens)} of ${num(s.cap)} tokens`;
      case 'paused': return 'Paused while Quorum records. It goes on after the meeting.';
      case 'capped': return `Stopped at your cap of ${num(s.cap)} tokens. The next run goes on from there.`;
      case 'cancelled': return 'Cancelled. What it read before stays; the next run goes on from there.';
      case 'failed': return s.error ? `Stopped: ${s.error}` : 'Stopped.';
      case 'stopped': return s.error ?? 'Stopped.';
      case 'done': return `Read ${many(s.done, 'note')}: ${many(s.edges, 'connection')} added, ${num(s.proposals)} for you to check.`;
      default: return '';
    }
  })();
  return [run, held].filter(Boolean).join(' · ');
}
