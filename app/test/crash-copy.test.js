import { describe, expect, it } from 'vitest';
import { crashCopy, crashKind, pageName } from '../src/crash';

describe('crash page words', () => {
  it('names the page a person knows', () => {
    expect(pageName('settings/connectors')).toBe('Connectors');
    expect(pageName('settings/developers')).toBe('AI tools');
    expect(pageName('main/home')).toBe('Home');
    expect(pageName('lazy/your note')).toBe('Your note');
    expect(pageName('settings/new-page')).toBe('New page');
  });
  it('tells a network failure apart from a bug, and a stale bundle from both', () => {
    expect(crashKind('TypeError: Failed to fetch', null, 0)).toBe('network');
    expect(crashKind('Failed to fetch dynamically imported module: x.js', null, 0)).toBe('stale');
    expect(crashKind('(0 , rn.fileURLToPath) is not a function', 1000, 1100)).toBe('repeat');
    expect(crashKind('x is undefined', null, 0)).toBe('once');
  });
  it('titles each kind with the page and offers the step that helps', () => {
    expect(crashCopy('settings/connectors', 'once')).toMatchObject({ title: "Connectors couldn't open", action: 'Reload view', window: false });
    expect(crashCopy('settings/connectors', 'repeat')).toMatchObject({ title: "Connectors won't open", action: 'Reload Quorum', window: true });
    expect(crashCopy('main/home', 'network')).toMatchObject({ title: "Home couldn't connect", action: 'Try again' });
    expect(crashCopy('main/home', 'stale')).toMatchObject({ title: 'Reload to open Home', window: true });
    expect(crashCopy('root', 'once', { whole: true }).action).toBe('Reload Quorum');
  });
  it('reads right for page names that start with The', () => {
    expect(crashCopy('main/live', 'stale').title).toBe('Reload to open the call view');
  });
  it('says whether a report was sent', () => {
    expect(crashCopy('main/home', 'once').body).toContain('sent a report');
    expect(crashCopy('main/home', 'once', { reports: false }).body).toContain('reports are off');
  });
});
