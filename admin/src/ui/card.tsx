import type { HTMLAttributes, ReactNode } from 'react';

// the desktop app's .set-card: one bordered container, rows inside it. `list` drops the side padding so table rows
// run edge to edge; `form` marks a card that holds inputs.
export function Card({ className = '', list, form, danger, ...rest }: HTMLAttributes<HTMLDivElement> & { list?: boolean; form?: boolean; danger?: boolean }) {
  return <div className={`card ${list ? 'list' : ''} ${form ? 'form' : ''} ${danger ? 'danger' : ''} ${className}`} {...rest} />;
}

// a key and a value on one line, like the desktop's .set-line
export function CardLine({ label, children }: { label: ReactNode; children?: ReactNode }) {
  return <div className="line"><span>{label}</span><strong>{children}</strong></div>;
}

// the desktop's .set-col h3: a small heading above a card or a group of rows
export function SectionTitle({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return <div className="section-head"><h3>{children}</h3>{actions && <div className="actions">{actions}</div>}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="muted pad">{children}</p>;
}
