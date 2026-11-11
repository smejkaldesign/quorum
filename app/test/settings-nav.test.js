import { describe, expect, it } from 'vitest';
import { canAdmin, modeOf, resolvePage, workspacePages, WORKSPACE_PAGES } from '../src/settingsNav.ts';

describe('the Admin button', () => {
  it('shows for everyone in the Local edition', () => {
    for (const role of ['owner', 'admin', 'member', null, undefined]) expect(canAdmin('local', role)).toBe(true);
  });

  it('shows for owners and admins in Cloud, and before a workspace exists, and never for members', () => {
    expect(canAdmin('cloud', 'owner')).toBe(true);
    expect(canAdmin('cloud', 'admin')).toBe(true);
    expect(canAdmin('cloud', null)).toBe(true);
    expect(canAdmin('cloud', undefined)).toBe(true);
    expect(canAdmin('cloud', 'member')).toBe(false);
  });
});

describe('which nav shows', () => {
  it('follows from the page: workspace pages open the Admin nav, the rest the account nav', () => {
    for (const p of WORKSPACE_PAGES) expect(modeOf(p)).toBe('admin');
    for (const p of ['preferences', 'memory', 'connectors', 'voice']) expect(modeOf(p)).toBe('account');
  });

  it('lists Members only in a Cloud build that reached a hosted account', () => {
    expect(workspacePages('local', false)).toEqual(['general', 'knowledge', 'org-connectors', 'org-voice', 'org-guardrails']);
    expect(workspacePages('cloud', null)).toEqual(['general', 'knowledge', 'org-connectors', 'org-voice', 'org-guardrails']);
    expect(workspacePages('cloud', false)).toEqual(['general', 'knowledge', 'org-connectors', 'org-voice', 'org-guardrails']);
    expect(workspacePages('cloud', true)).toEqual(['general', 'knowledge', 'members', 'org-connectors', 'org-voice', 'org-guardrails']);
  });
});

describe('resolving a remembered page', () => {
  it('keeps a page the current nav may show', () => {
    expect(resolvePage('org-voice', true)).toBe('org-voice');
    expect(resolvePage('calendar', false)).toBe('calendar');
  });

  it('sends a member who remembered a workspace page back to Preferences', () => {
    expect(resolvePage('general', false)).toBe('preferences');
    expect(resolvePage('org-connectors', false)).toBe('preferences');
  });

  it('maps the retired Profile and Platform pages and anything unknown to Preferences', () => {
    expect(resolvePage('profile', true)).toBe('preferences');
    expect(resolvePage('platform', true)).toBe('preferences');
    expect(resolvePage('nope', true)).toBe('preferences');
    expect(WORKSPACE_PAGES).not.toContain('platform');
  });
});
