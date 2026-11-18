import { afterEach, describe, expect, it } from 'vitest';
import { resolveCloudConfig } from '../ee/account.js';
import { isDevelopment } from '../edition.js';
import { mcpLink } from '../src/AgentLinks.tsx';

describe('production data in a development copy', () => {
  afterEach(() => { delete process.env.QUORUM_USE_PRODUCTION; });
  it('stays off without the setting or the launch variable', () => {
    expect(resolveCloudConfig({}).useProduction).toBe(false);
  });
  it('turns on with QUORUM_USE_PRODUCTION=1 in a development copy only', () => {
    process.env.QUORUM_USE_PRODUCTION = '1';
    expect(resolveCloudConfig({}).useProduction).toBe(isDevelopment);
  });
  it('turns on with the saved setting in a development copy only', () => {
    expect(resolveCloudConfig({ devUseProduction: true }).useProduction).toBe(isDevelopment);
  });
});

describe('mcpLink', () => {
  const agents = (claude, busy = '') => ({ status: { claude, codex: { installed: false, added: false } }, busy, msg: {}, addClaude: () => {}, addCodex: () => {}, removeClaude: () => {}, removeCodex: () => {} });
  it('reads a working registration as connected', () => {
    expect(mcpLink(agents({ installed: true, added: true }), 'claude')).toMatchObject({ added: true, registered: true, error: null, installed: true });
  });
  it('keeps a broken registration registered, with its error, so it can be fixed or disconnected', () => {
    expect(mcpLink(agents({ installed: true, added: true, error: 'config unreadable' }), 'claude')).toMatchObject({ added: false, registered: true, error: 'config unreadable' });
  });
  it('marks both tools busy while either one is changing', () => {
    expect(mcpLink(agents({ installed: true, added: false }, 'codex'), 'claude').busy).toBe(true);
  });
});
