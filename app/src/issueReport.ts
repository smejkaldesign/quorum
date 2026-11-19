import type { CrashKind } from './crash';
import type { IssueReportDraft, IssueReportPrep } from './quorum';

// Report issue: the renderer bus any page uses to open the Report issue sheet (ReportIssue.tsx), and the pure pieces
// the sheet builds from what it is given. openReport({ title, description, context }) opens the sheet; with a context
// and no description, the sheet writes one from the context (what the person was doing, the error, what was on screen,
// the steps) once the main process has masked the error message. A context with an error captures the Quorum window
// first, as it was when the error happened, unless capture is false. Everything stays editable on the sheet.
export type ReportContext = {
  // the page, as an ErrorBoundary view id (settings/memory, main/home)
  view?: string;
  // what the person was doing, in their words: "Running the fix on a dead-link item in Memory health"
  doing?: string;
  // the error text; masked in the main process before it is shown
  error?: string;
  // what was on screen, as label and value: the item's title, its recommendation, the reason the last fix failed
  screen?: { label: string; value: string }[];
  steps?: string[];
  // a word the log lines for this action carry, and the run id, so the sheet offers those lines first
  action?: string;
  runId?: string;
  capture?: boolean;
};
export type ReportRequest = { title?: string; description?: string; context?: ReportContext };

const OPEN = 'quorum:report-issue';

export function openReport(req: ReportRequest = {}) {
  window.dispatchEvent(new CustomEvent<ReportRequest>(OPEN, { detail: req }));
}
export function onOpenReport(cb: (req: ReportRequest) => void): () => void {
  const on = (e: Event) => cb((e as CustomEvent<ReportRequest>).detail ?? {});
  window.addEventListener(OPEN, on);
  return () => window.removeEventListener(OPEN, on);
}

export const MAX_SHOTS = 5;
// the relay's limits (relay/reports.js): 2 MB a screenshot, and the five together under its 8 MB body
export const MAX_SHOT_BYTES = 2 * 1024 * 1024;
export const MAX_TOTAL_SHOT_BYTES = 5 * 1024 * 1024;
export const TITLE_MAX = 200;
export const DESCRIPTION_MAX = 8000;

// a view id as people read it: settings/memory is "Settings, Memory", main/home is "Home"
export function pageLabel(view: string | undefined): string {
  const v = String(view ?? '').trim();
  if (!v || v === 'root') return 'Quorum';
  const words = (s: string) => s.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  const [head, ...rest] = v.split('/');
  if (head === 'main' && rest.length) return words(rest.join(' '));
  return [head, ...rest].map(words).join(', ');
}

const oneLine = (s: string) => s.split('\n')[0].trim();
export function reportTitle(ctx: ReportContext | undefined, message: string): string {
  const msg = oneLine(message);
  const page = pageLabel(ctx?.view);
  const t = msg ? `${page}: ${msg}` : ctx?.doing ? `${page}: ${oneLine(ctx.doing)}` : '';
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 3)}...` : t;
}

// the description written from an error: what the person was doing, the message, what was on screen and the steps
export function generatedDescription(ctx: ReportContext, message: string): string {
  const doing = ctx.doing?.trim() || `Using the ${pageLabel(ctx.view)} page.`;
  const screen = (ctx.screen ?? []).filter((s) => s.value?.trim());
  const steps = (ctx.steps ?? []).filter((s) => s.trim());
  return [
    `What I was doing: ${doing}`,
    ...(message ? ['', `Error: ${message}`] : []),
    ...(screen.length ? ['', 'On screen:', ...screen.map((s) => `- ${s.label}: ${s.value.trim()}`)] : []),
    '',
    'Steps:',
    ...(steps.length ? steps.map((s, i) => `${i + 1}. ${s.trim()}`) : ['1. ', '2. ']),
    '',
    'What I expected: ',
  ].join('\n').slice(0, DESCRIPTION_MAX);
}

// what the sheet starts with for a request, once the main process has answered prepare()
export function initialDraft(req: ReportRequest, prep: IssueReportPrep): { title: string; description: string } {
  const ctx = req.context;
  const fromError = !!ctx && (!!ctx.error || !!ctx.doing || !!ctx.screen?.length);
  return {
    title: (req.title ?? (ctx ? reportTitle(ctx, prep.message) : '')).slice(0, TITLE_MAX),
    description: (req.description ?? (fromError ? generatedDescription(ctx!, prep.message) : '')).slice(0, DESCRIPTION_MAX),
  };
}

// the screenshots after adding some: duplicates dropped, at most five kept, and how many did not fit
export function addShots(have: string[], add: string[]): { shots: string[]; dropped: number } {
  const next = [...have];
  let dropped = 0;
  for (const s of add) {
    if (next.includes(s)) continue;
    if (next.length >= MAX_SHOTS) { dropped += 1; continue; }
    next.push(s);
  }
  return { shots: next, dropped };
}

// the size of a data URL's image in bytes
export const dataUrlBytes = (url: string) => { const b64 = url.slice(url.indexOf(',') + 1); return Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0); };

// exactly the text that goes out with the screenshots, for the review step: every field the body carries
export function reportPreview(d: IssueReportDraft, prep: Pick<IssueReportPrep, 'install' | 'version' | 'edition' | 'os' | 'account'>): string {
  return [
    `Title: ${d.title.trim() || '(none)'}`,
    '',
    'Description:',
    d.description.trim() || '(none)',
    '',
    `App: Quorum ${prep.version} (${prep.edition} edition)`,
    `OS: ${prep.os}`,
    `Page: ${d.view || '(none)'}`,
    ...(d.runId ? [`Run: ${d.runId}`] : []),
    `Account: ${d.attachAccount && prep.account ? prep.account.email : 'not attached'}`,
    `Install: ${prep.install} (an anonymous id for this Mac; the server keeps only a hash of it)`,
    `Time: ${d.at}`,
    `Screenshots: ${d.screenshots.length}`,
    '',
    `Log lines (${d.logLines.length}):`,
    ...(d.logLines.length ? d.logLines : ['(none)']),
  ].join('\n');
}

// the context for a page that stopped drawing (the crash page's Report as issue): the page, the message, the steps the
// crash page knows, and the window captured as it is
export function crashReport(view: string, error: { message: string }, kind: CrashKind): ReportContext {
  return {
    view,
    doing: `Using the ${pageLabel(view)} page when it stopped drawing.`,
    error: error.message,
    steps: [`Open ${pageLabel(view)}.`, ...(kind === 'repeat' ? ['Press Reload view; the page fails again.'] : [])],
    action: 'render crash',
    capture: true,
  };
}

// the screenshots together, in bytes, against the total the relay's body allows
export const shotsTotal = (shots: string[]) => shots.reduce((n, s) => n + dataUrlBytes(s), 0);
