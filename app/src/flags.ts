import { useSyncExternalStore } from 'react';
import type { FlagsState } from './quorum';

// the flags the main process holds (app/flags.js): read once, then kept current by the `flags` event the relay
// refresh sends. useFlag answers false until the first read lands, so a gated surface never shows before the app
// knows; useFlags gives the whole table with each value's source for the Developers page.
let shared: FlagsState | null = null;
const listeners = new Set<() => void>();
let wired = false;
function wire() {
  if (wired || typeof window === 'undefined' || !window.quorum?.flags) return;
  wired = true;
  window.quorum.flags().then(push).catch(() => {});
  window.quorum.onFlags?.(push);
}
function push(s: FlagsState) { shared = s; for (const l of listeners) l(); }
const subscribe = (l: () => void) => { wire(); listeners.add(l); return () => { listeners.delete(l); }; };
const snapshot = () => shared;

export function useFlags(): FlagsState | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function useFlag(key: string): boolean {
  const s = useFlags();
  return s?.flags[key]?.enabled === true;
}

// for code outside React (and tests): the last state the renderer saw
export const currentFlags = (): FlagsState | null => shared;
