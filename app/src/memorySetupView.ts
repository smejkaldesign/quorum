// What the Memory setup card shows (MemorySetup.tsx), as plain functions the tests can run.
import type { MemorySetupState } from './quorum';

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
