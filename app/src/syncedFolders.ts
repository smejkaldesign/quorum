// A vault folder that stays in step with something outside it. The meetings folder is where Quorum writes meeting
// notes; a source folder (granola, zoom, quorum) is where one notetaker's notes land; a knowledge folder will hold
// what a knowledge base syncs. The notes tree marks each one, and only that exact folder.
export type SyncTarget = { kind: 'meetings' } | { kind: 'source'; app: string } | { kind: 'knowledge'; name: string };
export type SyncedFolder = { rel: string; with: SyncTarget };

export function syncedFolderAt(list: SyncedFolder[], rel: string): SyncedFolder | null {
  return list.find((f) => f.rel === rel) ?? null;
}

// the meeting source whose logo sits beside this folder; parents of a source folder show none
export function sourceAt(list: SyncedFolder[], rel: string): string | null {
  const f = syncedFolderAt(list, rel);
  return f?.with.kind === 'source' ? f.with.app : null;
}

export function sourceLabel(app: string, nameOf: (app: string) => string): string {
  if (app === 'quorum') return 'Quorum';
  if (app === 'quorum-dev') return 'Quorum Dev';
  return nameOf(app);
}

export function syncTip(f: SyncedFolder, nameOf: (app: string) => string): string {
  if (f.with.kind === 'meetings') return 'Quorum writes meeting notes here';
  if (f.with.kind === 'source') return `Synced with ${sourceLabel(f.with.app, nameOf)}`;
  return `Synced with ${f.with.name}`;
}
