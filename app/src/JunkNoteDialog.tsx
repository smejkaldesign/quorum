import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Modal } from './controls';

// asked before a note with no recording and almost no real words is saved (noteJunk.js). There are only the two
// answers, so the note is never saved or dropped without the person choosing. Discard moves a saved file to the Trash
export function JunkNoteDialog({ reason, onDiscard, onSave }: { reason: string; onDiscard: () => Promise<void> | void; onSave: () => Promise<void> | void }) {
  const [busy, setBusy] = useState(false);
  const run = (fn: () => Promise<void> | void) => async () => { setBusy(true); try { await fn(); } finally { setBusy(false); } };
  return createPortal(
    <Modal titleId="junk-title" title="This note looks empty" role="alertdialog" describedBy="junk-reason">
      <p id="junk-reason">{reason}</p>
      <div className="modal-actions">
        <span />
        <span className="modal-actions-end">
          <button className="pill danger-pill" disabled={busy} onClick={run(onDiscard)}>Discard</button>
          <button className="pill primary" autoFocus disabled={busy} onClick={run(onSave)}>Save anyway</button>
        </span>
      </div>
    </Modal>,
    document.body,
  );
}
