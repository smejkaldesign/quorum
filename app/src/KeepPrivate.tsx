import { useEffect, useState } from 'react';
import type { HandNoteRef, MeetingShare } from './quorum';
import { Toggle } from './controls';

// Keep private for one meeting note (Quorum Cloud with a team): off, the note is shared in the workspace's meetings
// knowledge base; on, it is the author's private note. Shows nothing when the workspace has no meetings knowledge base
// for this person (the Local edition, a solo workspace, readers narrowed) or the note is no meeting note. hash, from
// the note view, makes the main process refuse when the file changed on disk; onRef hands the new file state back
export function KeepPrivate({ file, hash, disabled, beforeChange, onRef, onAvailable }: {
  file: string; hash?: string | null; disabled?: boolean; beforeChange?: () => Promise<string | null | undefined>; onRef?: (ref: HandNoteRef) => void; onAvailable?: (on: boolean) => void;
}) {
  const [share, setShare] = useState<MeetingShare | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    window.quorum.meetingShare(file).then((s) => { if (on) { setShare(s); onAvailable?.(s.available); } }).catch(() => {});
    return () => { on = false; };
  }, [file]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!share?.available) return null;

  async function change(keepPrivate: boolean) {
    setBusy(true);
    setError(null);
    try {
      const at = beforeChange ? await beforeChange() : hash;
      const r = await window.quorum.meetingShareSet(file, keepPrivate, at ?? null);
      if ('conflict' in r) setError('This note changed on disk, so the choice was not saved.');
      else if ('error' in r) setError(r.error);
      else { setShare(r.state); onRef?.(r.ref); }
    } catch (err) {
      setError(String(err).replace(/^.*Error:\s*/, ''));
    } finally { setBusy(false); }
  }

  const where = share.kbName ? `the ${share.kbName} knowledge base` : "the team's meetings knowledge base";
  const tip = share.locked ? 'This note is marked confidential or has withheld lines, so it stays private.'
    : share.keepPrivate ? `Only you can read this note. Turn off to share it in ${where}.` : `Shared in ${where} for your team. Turn on to keep it to yourself.`;
  return (
    <span className="keep-private" data-tip={tip}>
      <span className="keep-private-label">Keep private</span>
      <Toggle on={share.keepPrivate || share.locked} disabled={disabled || busy || share.locked} onChange={change} />
      {error && <span className="set-error keep-private-error" role="alert">{error}</span>}
    </span>
  );
}
