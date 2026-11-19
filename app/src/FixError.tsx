import { IconClose } from './icons';

// A fix that failed or was cancelled, shown on its item as soon as the run ends and kept until the person dismisses it.
// It carries the full reason and the next steps; actions is a list so another one can join without a new component
export type FixErrorAction = { label: string; onClick: () => void; primary?: boolean };

export function FixError({ title, reason, actions, onDismiss }: { title: string; reason: string; actions: FixErrorAction[]; onDismiss: () => void }) {
  return (
    <div className="run-banner error fix-error" role="alert">
      <div className="run-head">
        <span className="run-text"><strong>{title}</strong> {reason}</span>
        <button className="icon-btn run-dismiss" aria-label="Dismiss" data-tip="Dismiss" onClick={onDismiss}><IconClose width={14} height={14} /></button>
      </div>
      {actions.length > 0 && (
        <div className="fix-error-actions">
          {actions.map((a) => <button key={a.label} className={`act-pill${a.primary ? ' primary' : ''}`} onClick={a.onClick}>{a.label}</button>)}
        </div>
      )}
    </div>
  );
}
