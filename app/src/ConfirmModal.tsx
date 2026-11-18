import { Modal, ModalActions } from './controls';

// a yes-or-no sheet for the steps that cannot be undone from Quorum
export function ConfirmModal({ title, body, action, onDone }: { title: string; body: string; action: string; onDone: (ok: boolean) => void }) {
  return (
    <Modal titleId="confirm-title" title={title} role="alertdialog" onClose={() => onDone(false)}>
      <p>{body}</p>
      <ModalActions>
        <button className="pill" autoFocus onClick={() => onDone(false)}>Cancel</button>
        <button className="pill danger-pill" onClick={() => onDone(true)}>{action}</button>
      </ModalActions>
    </Modal>
  );
}

