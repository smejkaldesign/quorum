import { describe, expect, it } from 'vitest';
import { nextMenuIndex, updateBadge } from '../src/headerItems.ts';
import { UP_NEXT_SHOWN, canNewNote, dayLabel, upNextRows } from '../src/upNextList.ts';

const state = (patch) => ({ status: 'idle', current: '1.0.0', version: null, percent: 0, notes: null, checkedAt: null, error: null, ...patch });

describe('the header update item', () => {
  it('shows nothing while idle, checking, off or failed', () => {
    for (const status of ['idle', 'checking', 'off', 'failed']) expect(updateBadge(state({ status })).kind).toBe('none');
    expect(updateBadge(null).kind).toBe('none');
  });
  it('shows progress while a version downloads', () => {
    expect(updateBadge(state({ status: 'downloading', version: '1.2.0', percent: 41.6 }))).toEqual({ kind: 'progress', percent: 42, label: 'Downloading Quorum v1.2.0, 42%' });
    expect(updateBadge(state({ status: 'downloading', percent: 140 })).percent).toBe(100);
  });
  it('names the version once it is ready', () => {
    expect(updateBadge(state({ status: 'ready', version: '1.2.0' }))).toMatchObject({ kind: 'ready', label: 'Update to v1.2.0' });
    expect(updateBadge(state({ status: 'ready', version: 'v1.2.0' })).label).toBe('Update to v1.2.0');
    expect(updateBadge(state({ status: 'ready' })).label).toBe('Update');
  });
});

describe('menu arrow keys', () => {
  const disabled = [false, true, false, false];
  it('skips disabled items and wraps', () => {
    expect(nextMenuIndex(0, 'ArrowDown', disabled)).toBe(2);
    expect(nextMenuIndex(3, 'ArrowDown', disabled)).toBe(0);
    expect(nextMenuIndex(0, 'ArrowUp', disabled)).toBe(3);
    expect(nextMenuIndex(2, 'ArrowUp', disabled)).toBe(0);
  });
  it('starts at either end when nothing has focus', () => {
    expect(nextMenuIndex(-1, 'ArrowDown', disabled)).toBe(0);
    expect(nextMenuIndex(-1, 'ArrowUp', disabled)).toBe(3);
    expect(nextMenuIndex(2, 'Home', [true, false, false])).toBe(1);
    expect(nextMenuIndex(0, 'End', disabled)).toBe(3);
  });
  it('ignores other keys', () => {
    expect(nextMenuIndex(0, 'a', disabled)).toBeNull();
    expect(nextMenuIndex(0, 'ArrowDown', [true, true])).toBeNull();
  });
});

describe('the Up next strip', () => {
  const events = ['a', 'b', 'c', 'd', 'e'];
  it('shows the next three until opened', () => {
    expect(UP_NEXT_SHOWN).toBe(3);
    expect(upNextRows(events, false)).toEqual({ rows: ['a', 'b', 'c'], more: true });
    expect(upNextRows(events, true)).toEqual({ rows: events, more: true });
    expect(upNextRows(['a', 'b', 'c'], false)).toEqual({ rows: ['a', 'b', 'c'], more: false });
  });
  it('labels nearby days by name', () => {
    const today = new Date(2026, 10, 13, 9);
    expect(dayLabel(new Date(2026, 10, 13, 15), today)).toBe('Today');
    expect(dayLabel(new Date(2026, 10, 14, 15), today)).toBe('Tomorrow');
    expect(dayLabel(new Date(2026, 10, 12, 15), today)).toBe('Yesterday');
    expect(dayLabel(null, today)).toBe('Undated');
  });
});

describe('+ New in Up next', () => {
  const none = { sources: [], providers: [], platforms: [] };
  it('stays away with nothing connected', () => {
    expect(canNewNote(none)).toBe(false);
  });
  it('appears for a connected meeting notes app', () => {
    expect(canNewNote({ ...none, sources: [{ id: 'granola', connected: true }] })).toBe(true);
    expect(canNewNote({ ...none, sources: [{ id: 'granola', connected: false }] })).toBe(false);
  });
  it('appears for a meeting app that listens on this Mac or has its cloud account connected', () => {
    expect(canNewNote({ ...none, providers: [{ id: 'zoom', enabled: true, installed: true, access: true }] })).toBe(true);
    expect(canNewNote({ ...none, providers: [{ id: 'zoom', enabled: true, installed: true, access: false }] })).toBe(false);
    expect(canNewNote({ ...none, providers: [{ id: 'zoom', enabled: false, installed: true, access: true }] })).toBe(false);
    expect(canNewNote({ ...none, platforms: [{ id: 'zoom', connected: true }] })).toBe(true);
  });
  it('counts only the Meetings and Meeting notes categories', () => {
    const lib = [{ id: 'x', category: 'calendar', kind: 'mcp-source', source: 'cal' }, { id: 'w', category: 'meeting-notes', kind: 'mcp-source', source: 'wispr' }];
    expect(canNewNote({ ...none, sources: [{ id: 'cal', connected: true }] }, lib)).toBe(false);
    expect(canNewNote({ ...none, sources: [{ id: 'wispr', connected: true }] }, lib)).toBe(true);
  });
});
