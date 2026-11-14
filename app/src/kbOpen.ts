// A request to open one knowledge base note in the Knowledge tab, from a chat source card or a quorum://kb link. The
// tab loads on demand, so the request waits here until the KB browser (ee/src/KbBrowser.tsx) mounts or hears the event
export type KbOpenTarget = { kbId: string; noteId: string };
export const KB_OPEN = 'quorum:kb-open';

let pending: KbOpenTarget | null = null;

export function requestKbOpen(target: KbOpenTarget) {
  pending = target;
  window.dispatchEvent(new Event(KB_OPEN));
}

export function takeKbOpen(): KbOpenTarget | null {
  const t = pending;
  pending = null;
  return t;
}
