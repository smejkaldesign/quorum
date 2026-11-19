import { describe, expect, it } from 'vitest';
import { type ErrorDetail, ISSUE_URL_MAX, agentPrompt, errorAuditLine, githubIssueUrl, issueTitle, regressed, shapeErrorCounts, shapeErrorDetail, shapeErrorGroup, statusLine, validateStatusForm } from '../src/errors';
import { auditLine } from '../src/shape';

const FP = 'ab'.repeat(32);
const groupRow = (over: Record<string, unknown> = {}) => ({
  fingerprint: FP, message: "Cannot read properties of undefined (reading 'map')", view: 'settings/connectors', first_seen: '2026-11-18T09:00:00Z', last_seen: '2026-11-19T10:00:00Z',
  events: 12, installs: 3, repeats: 2, versions: ['0.4.2', '0.4.1'], editions: ['cloud', 'local'], latest_stack: 'TypeError: x\n    at ConnectorsPage (src/ConnectorsPage.tsx:120:14)',
  latest_component_stack: 'at ConnectorsPage\nat Settings', status: 'new', fixed_in: null, note: null, updated_at: '2026-11-19T10:00:00Z', ...over,
});
const detail = (over: Record<string, unknown> = {}, extra: Partial<{ oses: string[] }> = {}): ErrorDetail =>
  shapeErrorDetail({ group: groupRow(over), oses: extra.oses ?? ['macOS 26.4 arm64'], events: [{ id: 9, workspace_id: null, edition: 'local', version: '0.4.2', os: 'macOS 26.4 arm64', view: 'settings/connectors', kind: 'render', repeat: true, message: 'm', at: 't', received_at: 't' }] });

describe('the rows', () => {
  it('shapes a group and its detail, defaulting what is missing', () => {
    const g = shapeErrorGroup(groupRow());
    expect(g).toMatchObject({ fingerprint: FP, events: 12, installs: 3, repeats: 2, versions: ['0.4.2', '0.4.1'], status: 'new', fixedIn: null });
    expect(shapeErrorGroup({ status: 'odd', versions: 'x' })).toMatchObject({ status: 'new', versions: [], events: 0, message: '' });
    const d = detail();
    expect(d.events[0]).toMatchObject({ id: 9, repeat: true, workspaceId: null });
    expect(shapeErrorDetail(null)).toMatchObject({ oses: [], events: [] });
    expect(shapeErrorCounts({ new: 4, fixed: '2' })).toEqual({ new: 4, fixing: 0, fixed: 2, ignored: 0 });
  });
  it('names the status and spots a regression', () => {
    expect(statusLine({ status: 'fixed', fixedIn: '0.4.3' })).toBe('Fixed in 0.4.3');
    expect(statusLine({ status: 'ignored', fixedIn: null })).toBe('Ignored');
    expect(regressed({ status: 'new', fixedIn: '0.4.3' })).toBe(true);
    expect(regressed({ status: 'fixed', fixedIn: '0.4.3' })).toBe(false);
  });
});

describe('the status form', () => {
  it('needs a version for fixed and keeps it only there', () => {
    expect(validateStatusForm({ status: 'fixed', fixedIn: ' ', note: '' })).toHaveProperty('error');
    expect(validateStatusForm({ status: 'fixed', fixedIn: 'soon', note: '' })).toHaveProperty('error');
    expect(validateStatusForm({ status: 'fixed', fixedIn: ' 0.4.3 ', note: ' PR 160 ' })).toEqual({ draft: { status: 'fixed', fixedIn: '0.4.3', note: 'PR 160' } });
    expect(validateStatusForm({ status: 'ignored', fixedIn: '0.4.3', note: '' })).toEqual({ draft: { status: 'ignored', fixedIn: null, note: null } });
    expect(validateStatusForm({ status: 'new', fixedIn: '', note: 'x'.repeat(2001) })).toHaveProperty('error');
  });
});

describe('the agent prompt', () => {
  it('carries what broke, where, the builds, the stacks, how to reproduce and what to hand back', () => {
    const p = agentPrompt(detail());
    expect(p).toContain('smejkaldesign/quorum');
    expect(p).toContain("Error: Cannot read properties of undefined (reading 'map')");
    expect(p).toContain('View: settings/connectors');
    expect(p).toContain('Seen: 12 times on 3 installs');
    expect(p).toContain('Versions: 0.4.2, 0.4.1');
    expect(p).toContain('Editions: cloud, local');
    expect(p).toContain('OS: macOS 26.4 arm64');
    expect(p).toContain('Broken on reload');
    expect(p).toContain('src/ConnectorsPage.tsx:120:14');
    expect(p).toContain('at Settings');
    expect(p).toContain('open the "settings/connectors" view');
    expect(p).toContain('Add a test');
    expect(p).toContain('draft pull request');
    expect(p).toContain(FP);
  });
  it('mentions a regression and leaves out what does not apply', () => {
    expect(agentPrompt(detail({ fixed_in: '0.4.1' }))).toContain('marked fixed in 0.4.1 and came back');
    const p = agentPrompt(detail({ repeats: 0, events: 1, installs: 1 }, { oses: [] }));
    expect(p).not.toContain('Broken on reload');
    expect(p).not.toContain('Regression');
    expect(p).toContain('Seen: 1 time on 1 install');
    expect(p).toContain('OS: (unknown)');
  });
  it('keeps a stack that holds a code fence inside its own block', () => {
    const p = agentPrompt(detail({ latest_stack: 'a ``` b' }));
    expect(p).toContain("a ''' b");
  });
});

describe('the GitHub issue link', () => {
  it('opens a new issue in the repo with a title, the body and the bug label', () => {
    const u = new URL(githubIssueUrl(detail()));
    expect(`${u.origin}${u.pathname}`).toBe('https://github.com/smejkaldesign/quorum/issues/new');
    expect(u.searchParams.get('labels')).toBe('bug');
    expect(u.searchParams.get('title')).toBe("Crash in settings/connectors: Cannot read properties of undefined (reading 'map')");
    const body = u.searchParams.get('body') ?? '';
    expect(body).toContain('View: settings/connectors');
    expect(body).toContain('src/ConnectorsPage.tsx:120:14');
  });
  it('shortens a long title and keeps the link under the length GitHub accepts', () => {
    expect(issueTitle({ message: 'x'.repeat(300), view: '' })).toMatch(/^Crash in an unknown view: x{117}\.\.\.$/);
    const url = githubIssueUrl(detail({ latest_stack: '<'.repeat(8000), latest_component_stack: '>'.repeat(4000) }));
    expect(url.length).toBeLessThanOrEqual(ISSUE_URL_MAX);
    expect(new URL(url).searchParams.get('body')).toContain('(cut; the full stack is on the admin Errors page)');
  });
});

describe('the audit lines', () => {
  const base = { id: 'a', actor: null, targetWorkspace: null, createdAt: 't' };
  it('reads the status changes and the reopen', () => {
    expect(errorAuditLine('error_status', { message: 'Boom', status: 'fixed', fixed_in: '0.4.3' })).toBe('Marked "Boom" fixed in 0.4.3');
    expect(auditLine({ ...base, action: 'error_status', detail: { message: 'Boom', status: 'ignored' } })).toBe('Marked "Boom" ignored');
    expect(auditLine({ ...base, action: 'error_reopened', detail: { message: 'Boom', version: '0.4.4', fixed_in: '0.4.3' } })).toBe('"Boom" came back in 0.4.4 after the fix in 0.4.3');
    expect(errorAuditLine('flag_set', {})).toBeNull();
  });
});
