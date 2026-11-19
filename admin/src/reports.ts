// The Reports page's data and its one hand-off: a prefilled GitHub new-issue link built from a report people sent from
// the app (Report issue, migration 0046). The repository is public, so the link carries a cleaned description and the
// app facts only: emails, paths and tokens are masked again, and no screenshot, log line, account or install goes into
// it. Screenshots are attached by hand. Pure functions, so the tests read them without a project.
import { REPO } from './errors';

export type ReportStatus = 'new' | 'filed' | 'closed' | 'ignored';
export const REPORT_STATUSES: readonly ReportStatus[] = ['new', 'filed', 'closed', 'ignored'];
export const REPORT_STATUS_LABEL: Record<ReportStatus, string> = { new: 'New', filed: 'Filed', closed: 'Closed', ignored: 'Ignored' };
export type ReportCounts = Record<ReportStatus, number>;

export type ReportRow = {
  id: string; edition: string; version: string; os: string; view: string; title: string; description: string; screenshots: number;
  signedIn: boolean; status: ReportStatus; note: string | null; at: string; receivedAt: string; updatedAt: string;
};
export type ReportDetail = Omit<ReportRow, 'screenshots' | 'signedIn'> & { email: string | null; logLines: string[]; runId: string | null; screenshots: string[] };

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const num = (v: unknown) => Number(v) || 0;
const status = (v: unknown): ReportStatus => (REPORT_STATUSES.includes(v as ReportStatus) ? (v as ReportStatus) : 'new');

export const shapeReportRow = (r: Record<string, unknown>): ReportRow => ({
  id: str(r.id), edition: str(r.edition), version: str(r.version), os: str(r.os), view: str(r.view), title: str(r.title), description: str(r.description),
  screenshots: num(r.screenshots), signedIn: r.signed_in === true, status: status(r.status), note: str(r.note) || null,
  at: str(r.at), receivedAt: str(r.received_at), updatedAt: str(r.updated_at),
});
export function shapeReportDetail(d: unknown): ReportDetail {
  const r = (d ?? {}) as Record<string, unknown>;
  return {
    id: str(r.id), edition: str(r.edition), version: str(r.version), os: str(r.os), view: str(r.view), title: str(r.title), description: str(r.description),
    status: status(r.status), note: str(r.note) || null, at: str(r.at), receivedAt: str(r.received_at), updatedAt: str(r.updated_at),
    email: str(r.email) || null, logLines: strs(r.log_lines), runId: str(r.run_id) || null, screenshots: strs(r.screenshots),
  };
}
export const shapeReportCounts = (d: unknown): ReportCounts => { const o = (d ?? {}) as Record<string, unknown>; return { new: num(o.new), filed: num(o.filed), closed: num(o.closed), ignored: num(o.ignored) }; };

export const NOTE_MAX = 2000;
export function validateReportForm(input: { status: ReportStatus; note: string }): { draft: { status: ReportStatus; note: string | null } } | { error: string } {
  const note = input.note.trim();
  if (note.length > NOTE_MAX) return { error: `The note is at most ${NOTE_MAX} characters.` };
  return { draft: { status: input.status, note: note || null } };
}

// emails, absolute paths and long tokens masked, for text that goes to the public repository
export function clean(text: string): string {
  return String(text ?? '')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>')
    .replace(/file:\/\/\/[^\s)'"]+/g, '<path>')
    .replace(/(?<![\w.])(?:~|\/(?:Users|Volumes|private|var|tmp|home))\/[^\s)'"]+/g, '<path>')
    .replace(/\b(?:sk|pk|rk|ghp|gho|xox[abp]|eyJ)[\w-]{12,}/g, '<token>')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '<token>');
}

export const reportIssueTitle = (r: Pick<ReportDetail, 'title' | 'view'>) => {
  const t = clean(r.title.split('\n')[0].trim()) || `Report from ${r.view || 'the app'}`;
  return t.length > 120 ? `${t.slice(0, 117)}...` : t;
};

export function reportIssueBody(r: ReportDetail): string {
  return [
    'Reported from the Quorum app (Report issue) and triaged on the admin Reports page.',
    '',
    clean(r.description) || '(no description)',
    '',
    `Version: ${r.version || '(unknown)'}`,
    `Edition: ${r.edition || '(unknown)'}`,
    `OS: ${r.os || '(unknown)'}`,
    `Page: ${r.view || '(unknown)'}`,
    `Report: ${r.id.slice(0, 8)}${r.screenshots.length ? ` (${r.screenshots.length} ${r.screenshots.length === 1 ? 'screenshot' : 'screenshots'} to attach)` : ''}`,
  ].join('\n');
}

// a prefilled new-issue link; the body is cut so the URL stays under the length GitHub accepts
export const ISSUE_URL_MAX = 7500;
export function reportIssueUrl(r: ReportDetail): string {
  const base = `https://github.com/${REPO}/issues/new`;
  const build = (body: string) => `${base}?${new URLSearchParams({ title: reportIssueTitle(r), body, labels: 'bug' }).toString()}`;
  let body = reportIssueBody(r);
  let url = build(body);
  while (url.length > ISSUE_URL_MAX && body.length > 200) {
    body = `${body.slice(0, Math.floor(body.length * 0.8))}\n... (cut; the full report is on the admin Reports page)`;
    url = build(body);
  }
  return url;
}

// the audit log's line for this page; rows name a report by id only, the line shows the first 8 characters
export function reportAuditLine(action: string, d: Record<string, unknown>): string | null {
  if (action !== 'report_status') return null;
  const what = typeof d.report === 'string' && d.report ? `report ${d.report.slice(0, 8)}` : 'a report';
  return `Marked ${what} ${REPORT_STATUS_LABEL[status(d.status)].toLowerCase()}`;
}
