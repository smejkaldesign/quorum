import { Component, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { Modal, ModalActions, Toggle } from './controls';
import { IconClose } from './icons';
import type { IssueReportPrep } from './quorum';
import { DESCRIPTION_MAX, MAX_SHOTS, MAX_SHOT_BYTES, MAX_TOTAL_SHOT_BYTES, TITLE_MAX, addShots, dataUrlBytes, initialDraft, onOpenReport, reportPreview, shotsTotal, type ReportRequest } from './issueReport';

// The Report issue sheet. openReport() (issueReport.ts) opens it from the avatar menu, the crash page or any error that
// stays on screen. Two steps: Write (title, description, screenshots by drag and drop, paste or file pick) and Review,
// which shows exactly the text that goes out and lets the person remove any screenshot or log line before Send. Note
// names and paths stay masked unless the person turns them on. Mounted once beside the window's root error boundary
// (main.tsx), so the crash page of the whole window can open it too.
type Step = 'write' | 'review' | 'sent';
type Open = { req: ReportRequest; prep: IssueReportPrep; n: number };

export function ReportIssueHost() {
  const [open, setOpen] = useState<Open | null>(null);
  const busy = useRef(false);
  const count = useRef(0);
  useEffect(() => onOpenReport(async (req) => {
    if (busy.current) return;
    busy.current = true;
    const ctx = req.context;
    try {
      // the window is captured before the sheet covers it
      const prep = await window.quorum.reportIssuePrepare({ view: ctx?.view, action: ctx?.action ?? null, runId: ctx?.runId ?? null, message: ctx?.error ?? null, capture: ctx?.capture ?? !!ctx?.error });
      count.current += 1;
      setOpen({ req, prep, n: count.current });
    } catch (e) { console.error('report issue: prepare', (e as Error)?.message); } finally { busy.current = false; }
  }), []);
  if (!open) return null;
  return <Quiet><ReportSheet key={open.n} req={open.req} prep={open.prep} onClose={() => setOpen(null)} /></Quiet>;
}

// the sheet failing to draw closes it rather than taking the window down with it
class Quiet extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    window.quorum?.reportError?.({ view: 'report-issue', message: error.message, stack: error.stack ?? '', componentStack: info.componentStack ?? '', repeat: false }).catch?.(() => {});
  }
  render() { return this.state.failed ? null : this.props.children; }
}

// an image file as a PNG or JPEG data URL under the relay's 2 MB limit: wider than 2000 px is scaled down, and a PNG
// still over the limit becomes a JPEG. Other formats the page can draw (GIF, WebP, HEIC on macOS) are converted the same way
async function imageData(file: Blob): Promise<string | null> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return null;
  const scale = Math.min(1, 2000 / bitmap.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const png = canvas.toDataURL('image/png');
  if (dataUrlBytes(png) <= MAX_SHOT_BYTES) return png;
  for (const q of [0.85, 0.7, 0.5]) { const jpg = canvas.toDataURL('image/jpeg', q); if (dataUrlBytes(jpg) <= MAX_SHOT_BYTES) return jpg; }
  return null;
}

function ReportSheet({ req, prep, onClose }: { req: ReportRequest; prep: IssueReportPrep; onClose: () => void }) {
  const start = initialDraft(req, prep);
  const [step, setStep] = useState<Step>('write');
  const [title, setTitle] = useState(start.title);
  const [description, setDescription] = useState(start.description);
  const [shots, setShots] = useState<string[]>(prep.screenshot ? [prep.screenshot] : []);
  const [withPaths, setWithPaths] = useState(false);
  // indexes of the log lines the person removed; the same index in either masked or unmasked list
  const [dropped, setDropped] = useState<Set<number>>(new Set());
  // off until the person turns it on: a report is anonymous by default
  const [attach, setAttach] = useState(false);
  // the time the body carries, set when the Review step opens so the preview shows the one that is sent
  const [at, setAt] = useState(() => new Date().toISOString());
  const [over, setOver] = useState(false);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const add = async (files: Iterable<Blob>) => {
    const list = [...files].filter((f) => f.type.startsWith('image/'));
    if (!list.length) return;
    const urls: string[] = [];
    let unreadable = 0;
    for (const f of list) { const u = await imageData(f); if (u) urls.push(u); else unreadable += 1; }
    const r = addShots(shots, urls);
    setShots(r.shots);
    setNote(r.dropped ? `A report holds ${MAX_SHOTS} screenshots; ${r.dropped} did not fit.` : unreadable ? `${unreadable === 1 ? 'One image' : `${unreadable} images`} could not be read or stayed over 2 MB.` : '');
  };
  const lines = (withPaths ? prep.linesWithPaths : prep.lines).filter((_l, i) => !dropped.has(i));
  const draft = { at, view: prep.view, title: title.slice(0, TITLE_MAX), description: description.slice(0, DESCRIPTION_MAX), logLines: lines, runId: prep.runId, screenshots: shots, attachAccount: attach && !!prep.account };
  const empty = !title.trim() && !description.trim();
  const tooBig = shotsTotal(shots) > MAX_TOTAL_SHOT_BYTES;
  const send = async () => {
    setSending(true); setError('');
    const r = await window.quorum.reportIssueSend(draft).catch(() => ({ ok: false, error: 'The report could not be sent. Try again.' }));
    setSending(false);
    if (r.ok) setStep('sent'); else setError(r.error ?? 'The report could not be sent. Try again.');
  };

  if (step === 'sent') return (
    <Modal titleId="report-title" title="Report sent" className="report-sheet" onClose={onClose}>
      <p>Thank you. It goes to the Quorum team only, and it is deleted after 90 days.</p>
      <ModalActions><button className="pill primary" autoFocus onClick={onClose}>Done</button></ModalActions>
    </Modal>
  );

  const shotList = shots.length > 0 && (
    <ul className="report-shots" aria-label="Screenshots">
      {shots.map((s, i) => (
        <li key={s.slice(-48)}>
          <img src={s} alt={`Screenshot ${i + 1}`} />
          <button className="report-remove" aria-label={`Remove screenshot ${i + 1}`} data-tip="Remove" onClick={() => setShots(shots.filter((x) => x !== s))}><IconClose width={12} height={12} /></button>
        </li>
      ))}
    </ul>
  );

  if (step === 'review') return (
    <Modal titleId="report-title" title="Review the report" className="report-sheet" onClose={sending ? undefined : onClose} locked={sending}>
      <p>This is everything that will be sent, to the Quorum team only. Remove anything you would rather keep.</p>
      <pre className="report-preview" aria-label="The text that will be sent">{reportPreview(draft, prep)}</pre>
      {shotList}
      {(withPaths ? prep.linesWithPaths : prep.lines).length > 0 && (
        <>
          <h3 className="report-h">Log lines</h3>
          <ul className="report-lines">
            {(withPaths ? prep.linesWithPaths : prep.lines).map((l, i) => (dropped.has(i) ? null : (
              <li key={i}><code>{l}</code><button className="report-remove" aria-label={`Remove log line ${i + 1}`} data-tip="Remove" onClick={() => setDropped(new Set(dropped).add(i))}><IconClose width={12} height={12} /></button></li>
            )))}
          </ul>
          <div className="report-switch"><Toggle on={withPaths} onChange={setWithPaths} label="Include note names and paths" /><span>Include note names and paths in the log lines</span></div>
        </>
      )}
      {prep.account && <div className="report-switch"><Toggle on={attach} onChange={setAttach} label="Attach my account" /><span>Attach my account ({prep.account.email}) so the team can reply</span></div>}
      {tooBig && <p className="set-error" role="alert">The screenshots add up to more than 5 MB. Remove one to send.</p>}
      {error && <p className="set-error" role="alert">{error}</p>}
      <ModalActions start={<button className="link-btn" disabled={sending} onClick={() => setStep('write')}>Back</button>}>
        <button className="pill" disabled={sending} onClick={onClose}>Cancel</button>
        <button className="pill primary" disabled={sending || empty || tooBig} onClick={send}>{sending ? 'Sending…' : 'Send report'}</button>
      </ModalActions>
    </Modal>
  );

  return (
    <Modal titleId="report-title" title="Report issue" className="report-sheet" onClose={onClose}>
      <div onPaste={(e) => { const files = [...e.clipboardData.files]; if (files.some((f) => f.type.startsWith('image/'))) { e.preventDefault(); add(files); } }}>
        <p>Tell the Quorum team what went wrong. You review everything before it is sent.</p>
        <label className="report-label" htmlFor="report-title-input">Title</label>
        <div className="set-field"><input id="report-title-input" value={title} maxLength={TITLE_MAX} autoFocus={!title} placeholder="What went wrong, in a few words" onChange={(e) => setTitle(e.target.value)} /></div>
        <label className="report-label" htmlFor="report-description">Description</label>
        <textarea id="report-description" className="set-area report-area" value={description} maxLength={DESCRIPTION_MAX} autoFocus={!!title} placeholder="What you were doing, what happened, and what you expected" onChange={(e) => setDescription(e.target.value)} />
        <span className="report-label">Screenshots</span>
        {shotList}
        {shots.length < MAX_SHOTS && (
          <div className={`dropzone report-drop${over ? ' on' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setOver(false); add(e.dataTransfer.files); }}>
            <strong>Drop, paste or choose a screenshot</strong>
            <span>PNG or JPEG, up to {MAX_SHOTS}</span>
            <input type="file" accept="image/png,image/jpeg" multiple aria-label="Choose screenshots" onChange={(e) => { if (e.target.files) add(e.target.files); e.target.value = ''; }} />
          </div>
        )}
        {note && <p className="muted small">{note}</p>}
      </div>
      <ModalActions>
        <button className="pill" onClick={onClose}>Cancel</button>
        <button className="pill primary" disabled={empty} onClick={() => { setAt(new Date().toISOString()); setStep('review'); }}>Review</button>
      </ModalActions>
    </Modal>
  );
}
