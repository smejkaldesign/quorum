// Back's history: the place a page was opened from goes on top, and Back returns to the newest one other than the current page
import { describe, expect, it } from 'vitest';
import { NAV_LIMIT, placeKey, popPlace, pushPlace, samePlace } from '../src/navHistory.ts';

const notifications = { kind: 'notifications' };
const home = { kind: 'home', page: null };
const noteA = { kind: 'note', file: '/vault/a.md' };
const memory = (rel) => ({ kind: 'memory', rel });
const event = (id) => ({ kind: 'home', page: { kind: 'event', event: { id, title: 'Standup', start: '', end: '' } } });

describe('pushPlace', () => {
  it('adds the place on top', () => {
    expect(pushPlace([home], notifications)).toEqual([home, notifications]);
  });
  it('keeps the same place twice in a row once', () => {
    expect(pushPlace([home, notifications], { kind: 'notifications' })).toEqual([home, notifications]);
  });
  it('keeps the same place again when another one sits between', () => {
    expect(pushPlace([notifications, home], notifications)).toEqual([notifications, home, notifications]);
  });
  it('drops the oldest past the limit', () => {
    let s = [];
    for (let i = 0; i < NAV_LIMIT + 5; i++) s = pushPlace(s, memory(`n${i}.md`));
    expect(s).toHaveLength(NAV_LIMIT);
    expect(s[0]).toEqual(memory('n5.md'));
    expect(s[s.length - 1]).toEqual(memory(`n${NAV_LIMIT + 4}.md`));
  });
  it('leaves the stack it was given unchanged', () => {
    const s = [home];
    pushPlace(s, notifications);
    expect(s).toEqual([home]);
  });
});

describe('popPlace', () => {
  it('returns the newest place and the rest of the history', () => {
    expect(popPlace([home, notifications], noteA)).toEqual({ place: notifications, stack: [home] });
  });
  it('skips entries equal to the page on screen', () => {
    expect(popPlace([notifications, noteA, noteA], noteA)).toEqual({ place: notifications, stack: [] });
  });
  it('returns no place on an empty history, so the page falls back to Home', () => {
    expect(popPlace([], noteA)).toEqual({ place: null, stack: [] });
    expect(popPlace([noteA], noteA)).toEqual({ place: null, stack: [] });
  });
  it('takes any newest place when the current one is unknown', () => {
    expect(popPlace([home], null)).toEqual({ place: home, stack: [] });
  });
});

describe('samePlace', () => {
  it('tells meeting pages and memory notes apart', () => {
    expect(samePlace(event('1'), event('1'))).toBe(true);
    expect(samePlace(event('1'), event('2'))).toBe(false);
    expect(samePlace(memory('a.md'), memory('b.md'))).toBe(false);
    expect(samePlace(home, { kind: 'home', page: null, convo: true })).toBe(false);
  });
  it('names Settings by its page', () => {
    expect(placeKey({ kind: 'settings', page: 'memory' })).not.toBe(placeKey({ kind: 'settings', page: 'guardrails' }));
  });
});
