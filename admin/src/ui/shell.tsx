import { type ComponentType, type ReactNode, type SVGProps, useEffect, useState } from 'react';
import { IconClose, IconMenu, IconSignOut } from './icons';

// the same shape as Celune's admin-shell: a brand block, nav rows with icons, a bottom block, a main area that scrolls.
// The look follows the desktop app's Settings sidebar (.set-side, .set-nav). Below 820px the sidebar becomes a top bar
// with a menu button that drops the nav rows under it.
export interface NavItem { id: string; label: string; icon: ComponentType<SVGProps<SVGSVGElement>>; bottom?: boolean }

export function Shell({ items, current, email, onSignOut, children }: { items: NavItem[]; current: string; email?: string | null; onSignOut?: () => void; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [current]);
  const row = (it: NavItem) => {
    const Icon = it.icon;
    return <a key={it.id} href={`#/${it.id}`} className={`nav-row ${current === it.id ? 'on' : ''}`} aria-current={current === it.id ? 'page' : undefined}><Icon />{it.label}</a>;
  };
  return (
    <div className="shell">
      <aside className={`side ${open ? 'open' : ''}`}>
        <div className="brand-row">
          <Brand />
          <button className="icon-btn menu-btn" aria-label={open ? 'Close menu' : 'Open menu'} aria-expanded={open} onClick={() => setOpen(!open)}>{open ? <IconClose /> : <IconMenu />}</button>
        </div>
        <nav className="side-nav" aria-label="Pages">
          {items.filter((i) => !i.bottom).map(row)}
          {items.some((i) => i.bottom) && <div className="side-gap" />}
          {items.filter((i) => i.bottom).map(row)}
        </nav>
        {email && (
          <div className="side-foot">
            <div className="side-me"><span className="side-avatar">{email[0].toUpperCase()}</span><span className="side-email">{email}</span></div>
            {onSignOut && <button className="nav-row quit" onClick={onSignOut}><IconSignOut />Sign out</button>}
          </div>
        )}
      </aside>
      <main className="main"><div className="col">{children}</div></main>
    </div>
  );
}

// sign-in, the passkey step and every message before the pages: the brand and one centered card, no sidebar
export function Centered({ children }: { children?: ReactNode }) {
  return (
    <div className="centered">
      <div className="centered-brand"><Brand /></div>
      {children}
    </div>
  );
}

function Brand() {
  return <a className="brand" href="#/overview"><img src="/favicon.svg" alt="" width="30" height="30" /><span>Quorum Admin</span></a>;
}
