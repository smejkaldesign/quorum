import { useState } from 'react';
import { api } from '../api';
import { type ResetOutcome, resetRefusal, resetTypedMatches } from '../reset';
import { CODE_PLAN_LABEL, type CodePlan, type User, formatCode } from '../shape';
import { Button, Dialog, Field, Input, Select, Switch, useToast } from '../ui';

// Reset user on the Users page (migration 0047): the account goes with the workspaces it is alone in, its shared notes
// stay with their teams, and the same email can be invited again on a plan. The owner types the email to confirm.
// A refusal names the workspaces that hold it back; a reinvite shows the new code to copy, as Access does.
export function ResetUser({ user, onClose }: { user: User; onClose: (reset: boolean) => void }) {
  const [typed, setTyped] = useState('');
  const [reinvite, setReinvite] = useState(true);
  const [plan, setPlan] = useState<CodePlan>('free');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<Extract<ResetOutcome, { ok: true }> | null>(null);
  const toast = useToast();
  const ok = resetTypedMatches(typed, user.email);
  const go = async () => {
    if (!ok || busy) return;
    setBusy(true); setError('');
    const r = await api.resetUser(user.userId, reinvite, plan);
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    if (!r.value.ok) { setError(resetRefusal(r.value)); return; }
    setDone(r.value);
    toast.success(`${user.email} was reset.`);
  };
  const copy = async (code: string) => { try { await navigator.clipboard.writeText(formatCode(code)); toast.success('Copied.'); } catch { toast.error('Could not copy; select the code instead.'); } };
  if (done) {
    return (
      <Dialog open onOpenChange={() => onClose(true)} title={`${user.email} was reset`}
        description={done.workspaces.length ? `The account and ${done.workspaces.join(', ')} were deleted.` : 'The account was deleted.'}>
        {done.invite
          ? <p>New {CODE_PLAN_LABEL[done.invite.plan]} code: <code className="code">{formatCode(done.invite.code)}</code>. Send it from Access, or copy it here.</p>
          : <p>No new code was issued. Add the person under Access to invite them again.</p>}
        <div className="modal-actions">
          {done.invite && <Button onClick={() => copy(done.invite!.code)}>Copy code</Button>}
          <Button variant="primary" autoFocus onClick={() => onClose(true)}>Done</Button>
        </div>
      </Dialog>
    );
  }
  return (
    <Dialog open onOpenChange={() => { if (!busy) onClose(false); }} title={`Reset ${user.email}?`}
      description="This deletes the account and every workspace it is the only member of, with their notes, meetings, chats and knowledge bases. Notes it shared with other people's workspaces move to each workspace's owner. Quorum on the person's Mac shows that the account was deleted. This cannot be undone.">
      <div className="fields">
        <Field label="Invite again"><Switch checked={reinvite} onChange={setReinvite} label="Invite the same email again" disabled={busy} /></Field>
        {reinvite && <Field label="Plan"><Select value={plan} disabled={busy} onChange={(e) => setPlan(e.target.value === 'cloud' ? 'cloud' : 'free')}><option value="free">Free</option><option value="cloud">Cloud</option></Select></Field>}
        <Field label="Type the email to confirm"><Input autoFocus value={typed} placeholder={user.email} disabled={busy} spellCheck={false} autoCapitalize="off" onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') go(); }} /></Field>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="modal-actions">
        <Button variant="link" disabled={busy} onClick={() => onClose(false)}>Cancel</Button>
        <Button variant="danger" disabled={!ok || busy} onClick={go}>{busy ? 'Resetting…' : 'Reset user'}</Button>
      </div>
    </Dialog>
  );
}
