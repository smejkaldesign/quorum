import type { ButtonHTMLAttributes } from 'react';

// Celune's Button variants in the desktop app's clothes: `default` is the outlined .pill, `primary` the white pill,
// `danger` the red-outlined pill, `ghost` a pill without a border, `link` the underlined text button
export type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost' | 'link';

export function Button({ variant = 'default', className = '', type = 'button', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  const cls = variant === 'link' ? 'link-btn' : `pill ${variant === 'default' ? '' : variant}`;
  return <button type={type} className={`${cls} ${className}`} {...rest} />;
}

// a filter in a row of filters, the one that is on painted like the desktop's selected tab
export function Chip({ on, className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { on?: boolean }) {
  return <button type="button" className={`chip ${on ? 'on' : ''} ${className}`} aria-pressed={on} {...rest} />;
}
