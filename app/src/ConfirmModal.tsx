// a yes-or-no sheet for the steps that cannot be undone from Quorum
export function ConfirmModal({ title, body, action, onDone }: { title: string; body: string; action: string; onDone: (ok: boolean) => void }) {
  return (
    <div className="palette-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onDone(false); }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onDone(false); } }}>
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
        <h2 id="confirm-title">{title}</h2>
        <p>{body}</p>
        <div className="modal-actions">
          <span />
          <span className="modal-actions-end">
            <button className="pill" autoFocus onClick={() => onDone(false)}>Cancel</button>
            <button className="pill danger-pill" onClick={() => onDone(true)}>{action}</button>
          </span>
        </div>
      </div>
    </div>
  );
}

