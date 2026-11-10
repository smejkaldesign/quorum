import { useEffect, useState, type ReactNode } from 'react';

export function Row({ icon, title, desc, children }: { icon: ReactNode; title: ReactNode; desc: ReactNode; children?: ReactNode }) {
  return (
    <div className="set-row">
      <span className="set-icon">{icon}</span>
      <div className="set-text"><strong>{title}</strong><span>{desc}</span></div>
      {children && <div className="set-ctrl">{children}</div>}
    </div>
  );
}

export function Toggle({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={`switch ${disabled ? 'off' : ''}`}>
      <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="track"><span className="thumb" /></span>
    </label>
  );
}

// a small ••• or + dropdown that closes on any outside click
export function useMenu() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [open]);
  return [open, setOpen] as const;
}
