import { useEffect, useSyncExternalStore } from 'react';
import markProd from '../assets/quorum-mark.png';
import markDev from '../assets/quorum-mark-dev.png';
import { AppLogo, sourceApp } from './AppChip';

// Which vault folders a meeting notetaker writes into (main.js meeting-folder-apps): Quorum's own notes folder, the dev
// copy's, and each source folder such as granola or zoom. Loaded once per launch and shared by every tree row.
let apps: Record<string, string> = {};
let loading = false;
const subs = new Set<() => void>();
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

function useFolderApps() {
  useEffect(() => {
    if (loading) return;
    loading = true;
    window.quorum.meetingFolderApps().then((list) => {
      apps = Object.fromEntries(list.map((f) => [f.rel, f.app]));
      subs.forEach((f) => f());
    }).catch(() => { loading = false; });
  }, []);
  return useSyncExternalStore(subscribe, () => apps, () => apps);
}

// the notetaker's logo beside its folder in the Memory tree
export function FolderApp({ rel }: { rel: string }) {
  const app = useFolderApps()[rel];
  if (!app) return null;
  const label = app === 'quorum' ? 'Quorum' : app === 'quorum-dev' ? 'Quorum Dev' : sourceApp(app).name;
  return (
    <span className="folder-app" data-tip={`Notes from ${label}`} aria-label={`Notes from ${label}`}>
      {app === 'quorum' || app === 'quorum-dev' ? <img className="app-logo" src={app === 'quorum' ? markProd : markDev} alt="" /> : <AppLogo {...sourceApp(app)} />}
    </span>
  );
}
