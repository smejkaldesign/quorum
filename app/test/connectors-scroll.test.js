import { describe, expect, it } from 'vitest';
import { connectorsScroll } from '../src/connectorsNav.ts';

describe('Settings scroll around a connector page', () => {
  it('a detail page opens at the top, and Back returns the list to where it was', () => {
    const open = connectorsScroll('connectors:list', 'connectors:detail:github', 640, {});
    expect(open.top).toBe(0);
    const back = connectorsScroll('connectors:detail:github', 'connectors:list', 0, open.saved);
    expect(back.top).toBe(640);
    expect(back.saved).toEqual({});
  });
  it('the library keeps its own position, apart from the list', () => {
    const a = connectorsScroll('connectors:library', 'connectors:detail:slack', 300, { 'connectors:list': 90 });
    expect(connectorsScroll('connectors:detail:slack', 'connectors:library', 0, a.saved).top).toBe(300);
  });
  it('one detail page to another opens at the top too, also when arriving from another page', () => {
    expect(connectorsScroll('connectors:detail:slack', 'connectors:detail:notion', 200, {}).top).toBe(0);
    expect(connectorsScroll('memory', 'connectors:detail:notion', 500, {}).top).toBe(0);
  });
  it('leaves other page changes alone and forgets saved positions', () => {
    expect(connectorsScroll('memory', 'preferences', 120, {})).toEqual({ top: null, saved: {} });
    expect(connectorsScroll('connectors:list', 'memory', 120, {})).toEqual({ top: null, saved: {} });
    expect(connectorsScroll('connectors:list', 'connectors:list', 120, { x: 1 }).top).toBeNull();
  });
});
