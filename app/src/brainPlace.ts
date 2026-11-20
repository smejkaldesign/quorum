import type { Brain } from './quorum';

// where the connected Agent OS and its notes are, for one line of text: the notes folder relative to the Agent OS when
// it is inside it. full holds both paths for a tooltip
export function brainPlace(brain: Brain, home: (p: string) => string): { text: string; full: string } {
  const root = brain.root;
  const vault = brain.vault || root;
  const full = `Agent OS: ${root}\nNotes: ${vault}`;
  if (vault === root) return { text: home(root), full };
  const inside = vault.startsWith(`${root}/`);
  return { text: `Agent OS ${home(root)} · Notes ${inside ? `in ${vault.slice(root.length + 1)}` : home(vault)}`, full };
}
