import { useSyncExternalStore } from 'react';
import type { FlagsState } from './quorum';

// the flags the main process holds (app/flags.js), kept current by the `flags` event the relay refresh sends. Until
// the first read lands the renderer answers from the same defaults the main process starts with, so manual listening
// reads on, screen context (which needs it) reads on, and the notetaker features read off. A failed first read is tried again on the next hook mount, and after
// a short wait, so a renderer that starts before the main process is ready still catches up.
export const RENDERER_DEFAULTS: Readonly<Record<string, boolean>> = Object.freeze({ 'meeting-capture': false, 'live-assist': false, 'manual-listen': true, 'screen-context': true });
const RETRY_MS = 5000;

const fallback: FlagsState = { flags: Object.fromEntries(Object.entries(RENDERER_DEFAULTS).map(([k, v]) => [k, { enabled: v, source: 'defaults' as const }])), fetchedAt: null, source: 'production', error: null };
let shared: FlagsState | null = null;
const listeners = new Set<() => void>();
let subscribed = false;
let reading = false;
let wired = false;
let retry: ReturnType<typeof setTimeout> | null = null;

function read() {
  if (wired || reading || typeof window === 'undefined' || !window.quorum?.flags) return;
  if (!subscribed && window.quorum.onFlags) { subscribed = true; window.quorum.onFlags(push); }
  reading = true;
  window.quorum.flags()
    .then((s) => { wired = true; push(s); })
    .catch(() => { if (!retry) retry = setTimeout(() => { retry = null; read(); }, RETRY_MS); })
    .finally(() => { reading = false; });
}
function push(s: FlagsState) { shared = s; for (const l of listeners) l(); }
const subscribe = (l: () => void) => { read(); listeners.add(l); return () => { listeners.delete(l); }; };
const snapshot = () => shared ?? fallback;

export function useFlags(): FlagsState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function useFlag(key: string): boolean {
  return useFlags().flags[key]?.enabled === true;
}

// the notetaker switches the renderer mirrors (app/notetaker.js holds the same rules for the main process, which is the
// one that refuses). The values are the resolved ones from the main process, so a flag whose parent is off (every
// notetaker flag requires manual-listen) already reads off here
export type Notetaker = { meetingCapture: boolean; liveAssist: boolean; manualListen: boolean; screenContext: boolean };
export function notetakerOf(s: FlagsState): Notetaker {
  const on = (k: string) => s.flags[k]?.enabled === true;
  return { meetingCapture: on('meeting-capture'), liveAssist: on('live-assist'), manualListen: on('manual-listen'), screenContext: on('screen-context') };
}
export const useNotetaker = (): Notetaker => notetakerOf(useFlags());

// for code outside React (and tests): the last state the renderer saw, or the defaults before any read
export const currentFlags = (): FlagsState => shared ?? fallback;
