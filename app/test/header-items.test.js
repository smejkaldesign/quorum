import { describe, expect, it } from 'vitest';
import { nextMenuIndex, updateBadge } from '../src/headerItems.ts';
import { UP_NEXT_SHOWN, dayLabel, upNextRows } from '../src/upNextList.ts';
import { CONNECTOR_BY_ID, canNewNote, connectorsFor, isConnected } from '../connectors/library.js';

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
  const zoomOn = { id: 'zoom', enabled: true, installed: true, access: true };
  const lib = connectorsFor({ meetingCapture: true });
  it('stays away with nothing connected', () => {
    expect(canNewNote(none, lib)).toBe(false);
  });
  it('appears for a connected meeting notes source', () => {
    expect(canNewNote({ ...none, sources: [{ id: 'granola', connected: true }] }, lib)).toBe(true);
    expect(canNewNote({ ...none, sources: [{ id: 'granola', connected: false }] }, lib)).toBe(false);
  });
  it('does not count a meeting app that is only installed', () => {
    expect(canNewNote({ ...none, providers: [zoomOn] }, lib)).toBe(false);
    expect(canNewNote({ ...none, providers: [zoomOn], added: { zoom: { enabled: false } } }, lib)).toBe(false);
  });
  it('counts a meeting app the person turned on, or a connected cloud account', () => {
    expect(canNewNote({ ...none, providers: [zoomOn], added: { zoom: { enabled: true } } }, lib)).toBe(true);
    expect(canNewNote({ ...none, providers: [{ ...zoomOn, access: false }], added: { zoom: { enabled: true } } }, lib)).toBe(false);
    expect(canNewNote({ ...none, platforms: [{ id: 'zoom', connected: true }] }, lib)).toBe(true);
  });
  it('with meeting capture off, counts a meeting app only by its cloud account', () => {
    const off = connectorsFor({ meetingCapture: false });
    expect(canNewNote({ ...none, providers: [zoomOn], added: { zoom: { enabled: true } } }, off)).toBe(false);
    expect(canNewNote({ ...none, platforms: [{ id: 'zoom', connected: true }] }, off)).toBe(true);
  });
  it('counts only the Meetings and Meeting notes categories', () => {
    expect(canNewNote({ ...none, cal: { enabled: true, status: 'granted' }, mcp: { added: true } }, lib)).toBe(false);
  });
});

describe('the shared connected check', () => {
  it('reads each kind the way Settings > Connectors shows it', () => {
    expect(isConnected(CONNECTOR_BY_ID['apple-calendar'], { cal: { enabled: true, status: 'granted' } })).toBe(true);
    expect(isConnected(CONNECTOR_BY_ID['apple-calendar'], { cal: { enabled: true, status: 'denied' } })).toBe(false);
    expect(isConnected(CONNECTOR_BY_ID['google-calendar'], { cal: { google: { connected: true } } })).toBe(true);
    expect(isConnected(CONNECTOR_BY_ID['claude-code'], { mcp: { added: true } })).toBe(true);
    expect(isConnected(CONNECTOR_BY_ID.zoom, { providers: [{ id: 'zoom', enabled: true, installed: true, access: null }] })).toBe(true);
    expect(isConnected(CONNECTOR_BY_ID.slack, {})).toBe(false);
  });
});
