import { type ReactNode, useEffect } from 'react';
import { Button } from './button';

// Celune's Dialog and ConfirmDialog on a plain overlay: the desktop app's .modal look, Escape and a click outside
// close it, focus stays inside while it is open
export function Dialog({ open, onOpenChange, title, description, children }: { open: boolean; onOpenChange: (open: boolean) => void; title: ReactNode; description?: ReactNode; children?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onOpenChange(false); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [open, onOpenChange]);
  if (!open) return null;
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onOpenChange(false); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
        <h2 id="dlg-title">{title}</h2>
        {description && <p>{description}</p>}
        {children}
      </div>
    </div>
  );
}

export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel = 'Confirm', cancelLabel = 'Cancel', variant = 'default', loading = false, onConfirm }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: ReactNode; description?: ReactNode; confirmLabel?: string; cancelLabel?: string; variant?: 'default' | 'destructive'; loading?: boolean; onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} description={description}>
      <div className="modal-actions">
        <Button variant="link" disabled={loading} onClick={() => onOpenChange(false)}>{cancelLabel}</Button>
        <Button variant={variant === 'destructive' ? 'danger' : 'primary'} disabled={loading} onClick={onConfirm} autoFocus>{loading ? 'Working…' : confirmLabel}</Button>
      </div>
    </Dialog>
  );
}
