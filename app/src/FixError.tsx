import { IconClose } from './icons';

// A fix that failed or was cancelled, shown on its item as soon as the run ends and kept until the person dismisses it.
// It carries the full reason and the next steps; actions is a list so another one can join without a new component.
// fresh: the run ended while the page was open, so it is announced once; a kept error is read as status, not an alert
export type FixErrorAction = { label: string; onClick: () => void; primary?: boolean; disabled?: boolean; tip?: string };

export function FixError({ title, reason, actions, fresh = false, onDismiss }: { title: string; reason: string; actions: FixErrorAction[]; fresh?: boolean; onDismiss: () => void }) {
  return (
    <div className="run-banner error fix-error" role={fresh ? 'alert' : 'status'}>
      <div className="run-head">
        <span className="run-text"><strong>{title}</strong> {reason}</span>
        <button className="icon-btn run-dismiss" aria-label="Dismiss" data-tip="Dismiss" onClick={onDismiss}><IconClose width={14} height={14} /></button>
      </div>
      {actions.length > 0 && (
        <div className="fix-error-actions">
          {actions.map((a) => <button key={a.label} className={`act-pill${a.primary ? ' primary' : ''}`} disabled={a.disabled} data-tip={a.disabled ? a.tip : undefined} onClick={a.onClick}>{a.label}</button>)}
        </div>
      )}
    </div>
  );
}
