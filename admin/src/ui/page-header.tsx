import type { ReactNode } from 'react';

// Celune's PageHeader: a title, an optional description and actions on the right. The title is the desktop app's
// serif settings heading.
export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div className="page-head-text">
        <h1>{title}</h1>
        {description && <p className="muted lede">{description}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}
