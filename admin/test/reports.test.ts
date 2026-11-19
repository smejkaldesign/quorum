import { describe, expect, it } from 'vitest';
import { ISSUE_URL_MAX, clean, reportAuditLine, reportIssueBody, reportIssueTitle, reportIssueUrl, shapeReportCounts, shapeReportDetail, shapeReportRow, validateReportForm } from '../src/reports';
import { auditLine } from '../src/shape';

const ID = '7d1f2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';
const row = (over: Record<string, unknown> = {}) => ({
  id: ID, edition: 'cloud', version: '0.4.3', os: 'macOS 26.4 arm64', view: 'settings/memory', title: 'Fix failed', description: 'It failed.', screenshots: 2,
  signed_in: true, status: 'new', note: null, at: '2026-11-19T11:59:00Z', received_at: '2026-11-19T12:00:00Z', updated_at: '2026-11-19T12:00:00Z', ...over,
});
const detail = (over: Record<string, unknown> = {}) => shapeReportDetail({ ...row(), screenshots: [`${ID}/1.png`, `${ID}/2.jpg`], email: 'sam@example.com', log_lines: ['a', 'b'], run_id: 'run_7', ...over });

describe('shapes', () => {
  it('reads a list row, a detail and the counts', () => {
    expect(shapeReportRow(row())).toMatchObject({ id: ID, screenshots: 2, signedIn: true, status: 'new', receivedAt: '2026-11-19T12:00:00Z' });
    expect(shapeReportRow(row({ status: 'weird', signed_in: null })).status).toBe('new');
    const d = detail();
    expect(d).toMatchObject({ email: 'sam@example.com', logLines: ['a', 'b'], runId: 'run_7', screenshots: [`${ID}/1.png`, `${ID}/2.jpg`] });
    expect(shapeReportCounts({ new: 2, filed: '1' })).toEqual({ new: 2, filed: 1, closed: 0, ignored: 0 });
  });
});

describe('the status form', () => {
  it('trims the note and refuses one over 2000 characters', () => {
    expect(validateReportForm({ status: 'filed', note: '  #191 ' })).toEqual({ draft: { status: 'filed', note: '#191' } });
    expect(validateReportForm({ status: 'closed', note: '' })).toEqual({ draft: { status: 'closed', note: null } });
    expect(validateReportForm({ status: 'new', note: 'x'.repeat(2001) })).toHaveProperty('error');
  });
});

describe('the GitHub issue', () => {
  it('masks emails, paths and tokens', () => {
    const tok = `${'gh'}p_${'z'.repeat(20)}`;
    expect(clean(`sam@example.com saw /Volumes/Work/vault/Plan.md and ~/x/y with ${tok}`)).toBe('<email> saw <path> and <path> with <token>');
  });
  it('masks note names the way the app does', () => {
    expect(clean('See [[Board prep]], "Sam Lee.md", People/Sam Lee.md and Plan.md')).toBe('See [[<note>]], "<note>.md", <note>.md and <note>.md');
  });
  it('carries the cleaned description and app facts, never the account, log lines or screenshot links', () => {
    const d = detail({ description: 'Broke for sam@example.com at /Volumes/Work/vault/x.md' });
    const body = reportIssueBody(d);
    expect(body).toContain('Broke for <email> at <path>');
    expect(body).toContain('Version: 0.4.3');
    expect(body).toContain('Page: settings/memory');
    expect(body).toContain(`Report: ${ID.slice(0, 8)} (2 screenshots to attach)`);
    expect(body).not.toContain('sam@example.com');
    expect(body).not.toContain('run_7');
    expect(body).not.toContain('.png');
    const url = new URL(reportIssueUrl(d));
    expect(url.pathname).toBe('/smejkaldesign/quorum/issues/new');
    expect(url.searchParams.get('title')).toBe('Fix failed');
    expect(url.searchParams.get('labels')).toBe('bug');
  });
  it('names the page when there is no title, and cuts a long body under the URL limit', () => {
    expect(reportIssueTitle({ title: '', view: 'main/home' })).toBe('Report from main/home');
    expect(reportIssueUrl(detail({ description: 'word '.repeat(4000) })).length).toBeLessThanOrEqual(ISSUE_URL_MAX);
  });
});

describe('the audit line', () => {
  it('names a report by its first 8 characters', () => {
    expect(reportAuditLine('report_status', { report: ID, status: 'filed' })).toBe(`Marked report ${ID.slice(0, 8)} filed`);
    expect(reportAuditLine('other', {})).toBe(null);
    expect(auditLine({ id: 1, actor: null, action: 'report_status', targetWorkspace: null, detail: { report: ID, status: 'closed' }, createdAt: '' } as never)).toBe(`Marked report ${ID.slice(0, 8)} closed`);
  });
});
