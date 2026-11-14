import type { UpdateState } from './quorum';

// The header's update item, from the updater's state (app/updater.js): nothing while idle, a small progress state
// while a version downloads, and an "Update to vX" button once it is ready to install.
export type UpdateBadge = { kind: 'none' } | { kind: 'progress'; percent: number; label: string } | { kind: 'ready'; label: string; tip: string };

const v = (version: string | null) => (version ? `v${version.replace(/^v/i, '')}` : null);

export function updateBadge(s: UpdateState | null | undefined): UpdateBadge {
  if (!s) return { kind: 'none' };
  const name = v(s.version);
  if (s.status === 'downloading') {
    const percent = Math.max(0, Math.min(100, Math.round(s.percent || 0)));
    return { kind: 'progress', percent, label: `Downloading Quorum${name ? ` ${name}` : ''}, ${percent}%` };
  }
  if (s.status === 'ready') return { kind: 'ready', label: name ? `Update to ${name}` : 'Update', tip: `Restart and install Quorum${name ? ` ${name}` : ''}` };
  return { kind: 'none' };
}

// Arrow keys in a menu: the next enabled item down or up, wrapping at either end, Home and End to the first and last.
// current is -1 when nothing in the menu has focus yet. Returns null for keys the menu does not move on.
export function nextMenuIndex(current: number, key: string, disabled: boolean[]): number | null {
  const n = disabled.length;
  const enabled = disabled.map((d, i) => (d ? -1 : i)).filter((i) => i >= 0);
  if (!enabled.length) return null;
  if (key === 'Home') return enabled[0];
  if (key === 'End') return enabled[enabled.length - 1];
  const step = key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : 0;
  if (!step) return null;
  if (current < 0) return step > 0 ? enabled[0] : enabled[enabled.length - 1];
  for (let k = 1; k <= n; k++) {
    const i = (((current + step * k) % n) + n) % n;
    if (!disabled[i]) return i;
  }
  return null;
}
