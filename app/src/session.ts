import { useEffect, useState } from 'react';

// state that survives a reload (⌘R) but not a relaunch, so Quorum comes back on the page you were on;
// Electron keeps sessionStorage across launches, so entries are tagged with the launch they came from
export function useSession<T>(key: string, initial: T, keep: (v: T) => boolean = () => true) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = sessionStorage.getItem(`quorum.${key}`);
      if (raw !== null) {
        const saved = JSON.parse(raw) as { launch: string; v: T };
        if (saved.launch === window.quorum.launchId && keep(saved.v)) return saved.v;
      }
    } catch {}
    return initial;
  });
  useEffect(() => {
    try { sessionStorage.setItem(`quorum.${key}`, JSON.stringify({ launch: window.quorum.launchId, v: value })); } catch {}
  }, [key, value]);
  return [value, setValue] as const;
}
