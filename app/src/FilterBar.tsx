import type { RefObject } from 'react';
import { IconCheck, IconChevron, IconClose, IconSearch } from './icons';
import { useMenu } from './controls';

// The filter bar pieces Notifications and Memory health share: Type and Sort menus, and search behind an icon button
// that folds a field open below the bar

// A pill button that opens Quorum's own menu: one pick (Sort) or several (Type, with a blue count of the picks). The
// button is as wide as its label
export function PickMenu<T extends string>({ label, count = 0, multi = false, options, picked, onPick }: { label: string; count?: number; multi?: boolean; options: [T, string][]; picked: T[]; onPick: (v: T) => void }) {
  const [open, setOpen] = useMenu();
  return (
    <span className="menu-wrap nf-pick-wrap">
      <button className={`nf-pick${open ? ' open' : ''}`} aria-haspopup="menu" aria-expanded={open} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>
        {label}{count > 0 && <span className="nf-badge" aria-label={`${count} selected`}>{count}</span>}<IconChevron width={13} height={13} />
      </button>
      {open && (
        <div className="menu nf-pick-menu" role="menu" onClick={(e) => { if (multi) e.stopPropagation(); }}>
          {options.map(([id, text]) => (
            <button key={id} role={multi ? 'menuitemcheckbox' : 'menuitemradio'} aria-checked={picked.includes(id)} className={picked.includes(id) ? 'checked' : ''} onClick={() => { onPick(id); if (!multi) setOpen(false); }}>
              <span>{text}</span>{picked.includes(id) && <IconCheck width={14} height={14} />}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

export function SearchButton({ open, label, onToggle }: { open: boolean; label: string; onToggle: () => void }) {
  return <button className={`icon-btn nf-search-btn${open ? ' on' : ''}`} aria-label={label} aria-expanded={open} data-tip="Search" onClick={onToggle}><IconSearch width={16} height={16} /></button>;
}

export function SearchField({ open, inputRef, value, placeholder, onChange, onClose }: { open: boolean; inputRef: RefObject<HTMLInputElement | null>; value: string; placeholder: string; onChange: (v: string) => void; onClose: () => void }) {
  return (
    <div className={`nf-search-wrap${open ? ' open' : ''}`} aria-hidden={!open}>
      <label className="nf-search">
        <IconSearch width={16} height={16} />
        <input ref={inputRef} value={value} tabIndex={open ? 0 : -1} placeholder={placeholder} aria-label={placeholder} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }} />
        <button className="icon-btn nf-search-x" tabIndex={open ? 0 : -1} aria-label="Close search" onClick={(e) => { e.preventDefault(); onClose(); }}><IconClose width={16} height={16} /></button>
      </label>
    </div>
  );
}
