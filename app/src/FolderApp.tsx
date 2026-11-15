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

// the notetakers that write into a folder or any folder inside it, as logos beside it in the Memory tree
export function FolderApp({ rel }: { rel: string }) {
  const all = useFolderApps();
  const here = [...new Set(Object.entries(all).filter(([r]) => r === rel || r.startsWith(`${rel}/`)).map(([, app]) => app))];
  if (!here.length) return null;
  return (
    <span className="folder-apps">
      {here.map((app) => {
        const label = app === 'quorum' ? 'Quorum' : app === 'quorum-dev' ? 'Quorum Dev' : sourceApp(app).name;
        return (
          <span key={app} className="folder-app" data-tip={`Notes from ${label}`} aria-label={`Notes from ${label}`}>
            {app === 'quorum' || app === 'quorum-dev' ? <img className="app-logo" src={app === 'quorum' ? markProd : markDev} alt="" /> : <AppLogo {...sourceApp(app)} />}
          </span>
        );
      })}
    </span>
  );
}
