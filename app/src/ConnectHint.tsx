import { useEffect, useState, type ReactNode } from 'react';
import { IconGrid } from './icons';

// The card every surface shows where data Quorum wants lives in another tool: the tool's logo (from the connector
// library) or an icon, one line on what connecting gives, and the actions the caller passes. Home's empty states,
// the onboarding meeting-notes step, the Memory page and the Meetings page all render this one component, so the
// offer to connect looks the same wherever it appears.
export function useLibraryIcons() {
  const [icons, setIcons] = useState<Record<string, string | null>>({});
  useEffect(() => {
    let live = true;
    window.quorum.libraryIcons().then((m) => { if (live && m) setIcons(m); }).catch(() => {});
    return () => { live = false; };
  }, []);
  return icons;
}

export function ConnectHint({ connector, icon, title, desc, children, compact, className }: {
  connector?: string; icon?: ReactNode; title: ReactNode; desc?: ReactNode; children?: ReactNode; compact?: boolean; className?: string;
}) {
  const icons = useLibraryIcons();
  const logo = connector ? icons[connector] : null;
  return (
    <div className={`connect-hint${compact ? ' compact' : ''}${className ? ` ${className}` : ''}`}>
      <span className="connect-hint-logo">{logo ? <img src={logo} alt="" /> : icon ?? <IconGrid width={18} height={18} />}</span>
      <div className="connect-hint-text"><strong>{title}</strong>{desc && <em>{desc}</em>}</div>
      {children && <div className="connect-hint-actions">{children}</div>}
    </div>
  );
}
