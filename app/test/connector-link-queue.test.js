import { describe, expect, it } from 'vitest';
import { createConnectorLinks } from '../connectors/appLink.js';

const setup = ({ window = true } = {}) => {
  const delivered = [];
  const state = { window };
  const links = createConnectorLinks({ deliver: (id) => delivered.push(id), windowReady: () => state.window, scheme: () => 'quorum-dev' });
  return { links, delivered, state };
};

describe('connector links from the OS', () => {
  it('a cold launch keeps the link until the window exists and the renderer listens', () => {
    const { links, delivered, state } = setup({ window: false });
    expect(links.open('quorum-dev://connectors/github')).toBe(true);
    expect(delivered).toEqual([]);
    state.window = true;
    links.flush();
    expect(delivered).toEqual([]);
    links.ready();
    expect(delivered).toEqual(['github']);
    links.flush();
    expect(delivered).toEqual(['github']);
  });
  it('once listening, links go straight through, the list link as null', () => {
    const { links, delivered } = setup();
    links.ready();
    links.open('quorum-dev://connectors/notion');
    links.open('quorum-dev://connectors');
    expect(delivered).toEqual(['notion', null]);
  });
  it('leaves other links for their own handlers', () => {
    const { links, delivered } = setup();
    links.ready();
    expect(links.open('quorum-dev://note/meeting.md')).toBe(false);
    expect(links.open('quorum://connectors/github')).toBe(false);
    expect(links.open('quorum-dev://connectors/not-a-connector')).toBe(false);
    expect(delivered).toEqual([]);
  });
});
