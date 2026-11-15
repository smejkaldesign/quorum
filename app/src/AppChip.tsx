import { type ReactNode, useEffect, useState, useSyncExternalStore } from 'react';
import { CONNECTORS } from '../connectors/library';

// The meeting apps a calendar event or a note can name, by the connector that carries the logo
export type Platform = 'zoom' | 'meet' | 'teams';
export const PLATFORM_APP: Record<Platform, { id: string; name: string; short: string }> = {
  zoom: { id: 'zoom', name: 'Zoom', short: 'Zoom' },
  meet: { id: 'google-meet', name: 'Google Meet', short: 'Meet' },
  teams: { id: 'teams', name: 'Microsoft Teams', short: 'Teams' },
};

// connector logos, loaded once per launch and shared by every row
let icons: Record<string, string | null> = {};
let loading = false;
const subs = new Set<() => void>();
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
export function useAppIcons() {
  useEffect(() => {
    if (loading) return;
    loading = true;
    window.quorum.libraryIcons().then((i) => { icons = i ?? {}; subs.forEach((f) => f()); }).catch(() => { loading = false; });
  }, []);
  return useSyncExternalStore(subscribe, () => icons, () => icons);
}

// a notes source (granola, fireflies, ...) as the connector that brings it in
export function sourceApp(source: string) {
  const c = CONNECTORS.find((x) => x.source === source || x.id === source);
  return c ? { id: c.id, name: c.name } : { id: source, name: source[0].toUpperCase() + source.slice(1) };
}

// An app's logo, the letter of its name when there is no logo
export function AppLogo({ id, name }: { id: string; name: string }) {
  const icons = useAppIcons();
  const [broken, setBroken] = useState(false);
  return icons[id] && !broken ? <img className="app-logo" src={icons[id]!} alt="" onError={() => setBroken(true)} /> : <span className="app-logo app-chip-letter">{name[0]}</span>;
}

// An app's logo and name in a row's details, subdued until hovered. With a link, a click opens the item in that app
// without opening the row.
export function AppChip({ id, name, url }: { id: string; name: string; url?: string | null }) {
  if (!url) return <span className="app-chip"><AppLogo id={id} name={name} />{name}</span>;
  return (
    <a className="app-chip link" href={url} data-tip={`Open in ${name}`}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.quorum.openExternal(url); }}
      onKeyDown={(e) => e.stopPropagation()}>
      <AppLogo id={id} name={name} />{name}
    </a>
  );
}

// Details text that opens the item in its app: subdued, white on hover, without opening the row
export function AppLink({ url, name, children }: { url: string; name: string; children: ReactNode }) {
  return (
    <a className="app-link hist-sub-text" href={url} data-tip={`Open in ${name}`}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.quorum.openExternal(url); }}
      onKeyDown={(e) => e.stopPropagation()}>
      {children}
    </a>
  );
}
