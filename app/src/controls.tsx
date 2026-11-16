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

// a centered sheet over a dimmed scrim. A press on the scrim or Escape calls onClose; locked ignores both while work runs.
// escape={false} is for sheets that listen for Escape on the window themselves
export function Modal({ titleId, title, className, role = 'dialog', describedBy, onClose, escape = true, locked, children }: {
  titleId: string; title: ReactNode; className?: string; role?: 'dialog' | 'alertdialog'; describedBy?: string;
  onClose?: () => void; escape?: boolean; locked?: boolean; children?: ReactNode;
}) {
  return (
    <div className="palette-scrim" onMouseDown={onClose && ((e) => { if (e.target === e.currentTarget && !locked) onClose(); })}
      onKeyDown={onClose && escape ? (e) => { if (e.key === 'Escape' && !locked) { e.stopPropagation(); onClose(); } } : undefined}>
      <div className={className ? `modal ${className}` : 'modal'} role={role} aria-modal="true" aria-labelledby={titleId} aria-describedby={describedBy}>
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

// the button row under a Modal: an optional start slot (a link or a destructive action) and the main actions at the end
export function ModalActions({ start, children }: { start?: ReactNode; children: ReactNode }) {
  return <div className="modal-actions">{start ?? <span />}<span className="modal-actions-end">{children}</span></div>;
}

// the card a settings list shows when it has nothing in it yet: an icon, a title, then a line and an action as children
export function EmptyState({ icon, title, children }: { icon: ReactNode; title: ReactNode; children?: ReactNode }) {
  return <div className="set-card set-zero"><span className="set-zero-icon">{icon}</span><strong>{title}</strong>{children}</div>;
}

export type SegOption<T extends string> = { id: T; label: ReactNode; ariaLabel?: string; tip?: string };

// the rounded segmented switch (.seg). kind sets the ARIA pattern: tabs for a view switch, radio inside a form,
// pressed for a pair of toggle buttons
export function Segmented<T extends string>({ options, value, onChange, kind, label, className, disabled, inline }: {
  options: SegOption<T>[]; value: T; onChange: (id: T) => void; kind: 'tabs' | 'radio' | 'pressed';
  label: string; className?: string; disabled?: boolean; inline?: boolean;
}) {
  const Wrap = inline ? 'span' : 'div';
  const role = kind === 'tabs' ? 'tablist' : kind === 'radio' ? 'radiogroup' : 'group';
  return (
    <Wrap className={className ? `seg ${className}` : 'seg'} role={role} aria-label={label}>
      {options.map((o) => {
        const on = o.id === value;
        const state = kind === 'tabs' ? { role: 'tab', 'aria-selected': on } : kind === 'radio' ? { role: 'radio', 'aria-checked': on } : { 'aria-pressed': on };
        return <button key={o.id} type="button" {...state} disabled={disabled} aria-label={o.ariaLabel} data-tip={o.tip} className={on ? 'on' : ''} onClick={() => onChange(o.id)}>{o.label}</button>;
      })}
    </Wrap>
  );
}
