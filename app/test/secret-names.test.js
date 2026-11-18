// The development copy and the installed app keep separate secrets: every name a development copy asks for carries
// quorum-dev, and the installed app's names stay as earlier builds wrote them
import { afterEach, describe, expect, it, vi } from 'vitest';

const saved = process.env.QUORUM_ENV;
afterEach(() => { process.env.QUORUM_ENV = saved; vi.doUnmock('../secrets.js'); vi.resetModules(); });

async function namesFor(env) {
  process.env.QUORUM_ENV = env;
  vi.resetModules();
  const asked = [];
  vi.doMock('../secrets.js', () => ({ secrets: { get: async (name, legacy = []) => { asked.push([name, ...legacy]); return null; }, set: async () => true, remove: async () => {} } }));
  const { connectorKey } = await import('../connectors/keys.js');
  const { decisionsKey } = await import('../decisions.js');
  const { createTokenStore } = await import('../sources/tokens.js');
  await connectorKey('anthropic');
  await decisionsKey('openai');
  await createTokenStore().tokens.get('slack');
  return asked;
}

describe('secret names per environment', () => {
  it('a development copy asks only for quorum-dev names', async () => {
    expect(await namesFor('development')).toEqual([['quorum-dev-connector-anthropic'], ['quorum-dev-openai-decisions'], ['quorum-dev-source-slack']]);
  });

  it('the installed app asks for its own names, with the old Anthropic name as a fallback', async () => {
    expect(await namesFor('production')).toEqual([['quorum-connector-anthropic', 'quorum-model-anthropic'], ['openai-decisions'], ['quorum-source-slack']]);
  });
});

describe('a key that could not be decrypted', () => {
  it('is asked for again on the next call instead of being cached as missing', async () => {
    process.env.QUORUM_ENV = 'production';
    vi.resetModules();
    const answers = [undefined, 'fake-key'];
    vi.doMock('../secrets.js', () => ({ secrets: { get: async () => answers.shift(), set: async () => true, remove: async () => {} } }));
    const { connectorKey } = await import('../connectors/keys.js');
    expect(await connectorKey('openai')).toBeNull();
    expect(await connectorKey('openai')).toBe('fake-key');
  });
});
