import { useEffect, useSyncExternalStore } from 'react';
import markProd from '../assets/quorum-mark.png';
import markDev from '../assets/quorum-mark-dev.png';
import { AppLogo, sourceApp } from './AppChip';
import { IconFolder, IconFolderOpen } from './icons';
import { type SyncedFolder, sourceAt, sourceLabel, syncTip, syncedFolderAt } from './syncedFolders';

// The vault folders that sync with something (main.js synced-folders): the meetings folder Quorum writes to and each
// meeting source folder. Loaded once per launch and shared by every tree row.
let folders: SyncedFolder[] = [];
let loading = false;
const subs = new Set<() => void>();
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
const nameOf = (app: string) => sourceApp(app).name;

function useSyncedFolders() {
  useEffect(() => {
    if (loading) return;
    loading = true;
    window.quorum.syncedFolders().then((list) => {
      folders = list;
      subs.forEach((f) => f());
    }).catch(() => { loading = false; });
  }, []);
  return useSyncExternalStore(subscribe, () => folders, () => folders);
}

// A folder row's icon: open or closed, green with a tooltip naming what it syncs with when the folder is synced
export function FolderIcon({ rel, open }: { rel: string; open: boolean }) {
  const synced = syncedFolderAt(useSyncedFolders(), rel);
  const Icon = open ? IconFolderOpen : IconFolder;
  if (!synced) return <Icon className="kb-folder" width={16} height={16} />;
  const tip = syncTip(synced, nameOf);
  return <Icon className="kb-folder synced" width={16} height={16} role="img" aria-hidden={false} aria-label={tip} data-tip={tip} />;
}

// the logo of the meeting source that syncs with this exact folder; a parent folder shows none
export function FolderApp({ rel }: { rel: string }) {
  const app = sourceAt(useSyncedFolders(), rel);
  if (!app) return null;
  const label = sourceLabel(app, nameOf);
  return (
    <span className="folder-apps">
      <span className="folder-app" data-tip={`Notes from ${label}`} aria-label={`Notes from ${label}`}>
        {app === 'quorum' || app === 'quorum-dev' ? <img className="app-logo own" src={app === 'quorum' ? markProd : markDev} alt="" /> : <AppLogo {...sourceApp(app)} />}
      </span>
    </span>
  );
}
