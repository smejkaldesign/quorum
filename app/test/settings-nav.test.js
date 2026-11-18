import { describe, expect, it } from 'vitest';
import { canAdmin, flagHiddenPages, modeOf, resolvePage, voiceMode, workspacePages, TEAM_PAGES, WORKSPACE_PAGES } from '../src/settingsNav.ts';

describe('the Admin button', () => {
  it('shows for everyone in the Local edition', () => {
    for (const role of ['owner', 'admin', 'member', null, undefined]) expect(canAdmin('local', role)).toBe(true);
  });

  it('shows for everyone in Cloud too, members included, since it holds their own AI settings and Connectors', () => {
    for (const role of ['owner', 'admin', 'member', null, undefined]) expect(canAdmin('cloud', role)).toBe(true);
  });
});

describe('which nav shows', () => {
  it('follows from the page: workspace pages open the Admin nav, the rest the account nav', () => {
    for (const p of WORKSPACE_PAGES) expect(modeOf(p)).toBe('admin');
    for (const p of ['preferences', 'memory', 'agent-os', 'calendar', 'meetings', 'voice']) expect(modeOf(p)).toBe('account');
    for (const p of ['developers', 'guardrails', 'connectors']) expect(modeOf(p)).toBe('admin');
  });

  it('lists the top pages alone in the Local edition, in a Cloud build without a hosted account, and for a member', () => {
    expect(workspacePages('local', false)).toEqual(['general', 'notifications', 'developers', 'guardrails', 'connectors']);
    expect(workspacePages('local', true, true)).toEqual(['general', 'notifications', 'developers', 'guardrails', 'connectors']);
    expect(workspacePages('cloud', null)).toEqual(['general', 'notifications', 'developers', 'guardrails', 'connectors']);
    expect(workspacePages('cloud', false)).toEqual(['general', 'notifications', 'developers', 'guardrails', 'connectors']);
    expect(workspacePages('cloud', false, true)).toEqual(['general', 'notifications', 'developers', 'guardrails', 'connectors']);
    expect(workspacePages('cloud', true, true, 'member')).toEqual(['general', 'notifications', 'developers', 'guardrails', 'connectors']);
  });

  it('adds Teams and Billing once a Cloud build reached a hosted account, and the team pages only with a team on', () => {
    expect(workspacePages('cloud', true)).toEqual([...['general', 'notifications', 'developers', 'guardrails', 'connectors'], 'teams', 'billing']);
    expect(workspacePages('cloud', true, false, 'admin')).toEqual([...['general', 'notifications', 'developers', 'guardrails', 'connectors'], 'teams', 'billing']);
    expect(workspacePages('cloud', true, true, 'owner')).toEqual([...['general', 'notifications', 'developers', 'guardrails', 'connectors'], 'teams', 'billing', 'knowledge', 'members', 'org-connectors', 'org-voice', 'org-guardrails']);
    for (const p of TEAM_PAGES) expect(workspacePages('cloud', true, false)).not.toContain(p);
  });
});

describe('resolving a remembered page', () => {
  it('puts Notifications behind the Admin button', () => {
    expect(modeOf('notifications')).toBe('admin');
    expect(resolvePage('notifications', false)).toBe('preferences');
    expect(resolvePage('notifications', true, ['general', 'notifications'])).toBe('notifications');
  });

  it('shows Voice typing with dictation on, the Dictionary with only listening on, and nothing with both off', () => {
    expect(voiceMode(true, true)).toBe('voice');
    expect(voiceMode(false, true)).toBe('dictionary');
    expect(voiceMode(false, false)).toBe(null);
    expect(flagHiddenPages('dictionary')).toEqual([]);
    expect(resolvePage('voice', true, undefined, flagHiddenPages(null))).toBe('preferences');
    expect(resolvePage('voice', true, undefined, flagHiddenPages('dictionary'))).toBe('voice');
    expect(resolvePage('org-voice', true, undefined, flagHiddenPages(null))).toBe('org-voice');
  });

  it('hides the Guardrails page with the guardrails flag off and sends a remembered visit to General', () => {
    expect(flagHiddenPages('voice')).toEqual([]);
    expect(flagHiddenPages('voice', false)).toEqual(['guardrails', 'org-guardrails']);
    expect(flagHiddenPages(null, false)).toEqual(['voice', 'guardrails', 'org-guardrails']);
    expect(resolvePage('guardrails', true, undefined, flagHiddenPages('voice', false))).toBe('general');
    expect(resolvePage('guardrails', true, undefined, flagHiddenPages('voice', true))).toBe('guardrails');
    expect(resolvePage('org-guardrails', true, undefined, flagHiddenPages('voice', true, true))).toBe('org-guardrails');
  });

  it('keeps a page the current nav may show', () => {
    expect(resolvePage('org-voice', true)).toBe('org-voice');
    expect(resolvePage('calendar', false)).toBe('calendar');
    expect(resolvePage('billing', true, ['general', 'teams', 'billing'])).toBe('billing');
  });

  it('sends a member who remembered a workspace page back to Preferences', () => {
    expect(resolvePage('general', false)).toBe('preferences');
    expect(resolvePage('org-connectors', false)).toBe('preferences');
  });

  it('lands a remembered team page on General once the team is off or the build stops listing it', () => {
    expect(resolvePage('members', true, ['general', 'teams', 'billing'])).toBe('general');
    expect(resolvePage('org-guardrails', true, ['general'])).toBe('general');
    expect(resolvePage('members', true, ['general', 'teams', 'billing', 'knowledge', 'members'])).toBe('members');
    expect(resolvePage('calendar', true, ['general'])).toBe('calendar');
    expect(resolvePage('connectors', true, ['general', 'notifications', 'developers', 'guardrails', 'connectors'])).toBe('connectors');
  });

  it('maps the retired Profile and Platform pages and anything unknown to Preferences', () => {
    expect(resolvePage('profile', true)).toBe('preferences');
    expect(resolvePage('platform', true)).toBe('preferences');
    expect(resolvePage('nope', true)).toBe('preferences');
    expect(WORKSPACE_PAGES).not.toContain('platform');
  });
});

describe('the guardrails flags', () => {
  it('hide the workspace Guardrails page unless custom rules are on, and the personal page with the main flag', () => {
    expect(flagHiddenPages('voice', true, false)).toEqual(['org-guardrails']);
    expect(flagHiddenPages('voice', true, true)).toEqual([]);
    expect(flagHiddenPages('voice', false, true)).toEqual(['guardrails', 'org-guardrails']);
    expect(resolvePage('org-guardrails', true, undefined, flagHiddenPages('voice', true, false))).toBe('general');
  });
});
