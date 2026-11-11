import type { ButtonHTMLAttributes, CSSProperties, HTMLAttributes, ReactNode } from 'react';

// Celune's Table as the desktop app draws it (.plat-row, .ac-row): a grid of rows inside a card, a small uppercase
// header row, each row either plain or a button that opens a drawer under it. `columns` is the grid template; the
// rows inherit it from the table so every page states its columns once.
export function Table({ columns, className = '', children, ...rest }: HTMLAttributes<HTMLDivElement> & { columns: string; children: ReactNode }) {
  return <div className={`table ${className}`} style={{ '--cols': columns } as CSSProperties} {...rest}>{children}</div>;
}

export function TableHead({ children }: { children: ReactNode }) {
  return <div className="trow thead">{children}</div>;
}

// a row that opens: aria-expanded marks the state, `on` paints it while its drawer is open
export function TableRowButton({ on, className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { on?: boolean }) {
  return <button className={`trow ${on ? 'on' : ''} ${className}`} aria-expanded={on} {...rest} />;
}

export function TableRow({ className = '', ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`trow ${className}`} {...rest} />;
}

// one entry in the table: the row (and its drawer when open), with a rule under it
export function TableItem({ open, children }: { open?: boolean; children: ReactNode }) {
  return <div className={`titem ${open ? 'open' : ''}`}>{children}</div>;
}

export function Drawer({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`drawer ${className}`}>{children}</div>;
}
