import { describe, expect, it } from 'vitest';
import { sourceAt, sourceLabel, syncTip, syncedFolderAt } from '../src/syncedFolders.ts';

const list = [
  { rel: '08-meetings', with: { kind: 'meetings' } },
  { rel: '08-meetings/quorum', with: { kind: 'source', app: 'quorum' } },
  { rel: '08-meetings/quorum-dev', with: { kind: 'source', app: 'quorum-dev' } },
  { rel: '08-meetings/granola', with: { kind: 'source', app: 'granola' } },
  { rel: '05-knowledge/team', with: { kind: 'knowledge', name: 'Team docs' } },
];
const nameOf = (app) => ({ granola: 'Granola' })[app] ?? app;

describe('synced folders', () => {
  it('counts the meetings folder, each source folder and a knowledge folder as synced', () => {
    expect(syncedFolderAt(list, '08-meetings')?.with.kind).toBe('meetings');
    expect(syncedFolderAt(list, '08-meetings/granola')?.with).toEqual({ kind: 'source', app: 'granola' });
    expect(syncedFolderAt(list, '05-knowledge/team')?.with.kind).toBe('knowledge');
  });

  it('does not count parents, children or look-alike names', () => {
    expect(syncedFolderAt(list, '05-knowledge')).toBeNull();
    expect(syncedFolderAt(list, '08-meetings/granola/2026')).toBeNull();
    expect(syncedFolderAt(list, '08-meetings/gran')).toBeNull();
    expect(syncedFolderAt([], '08-meetings')).toBeNull();
  });

  it('puts a source icon only on the exact source folder', () => {
    expect(sourceAt(list, '08-meetings/granola')).toBe('granola');
    expect(sourceAt(list, '08-meetings/quorum')).toBe('quorum');
    expect(sourceAt(list, '08-meetings')).toBeNull();
    expect(sourceAt(list, '05-knowledge/team')).toBeNull();
    expect(sourceAt(list, '')).toBeNull();
  });

  it('names what each folder syncs with', () => {
    expect(syncTip(list[0], nameOf)).toBe('Quorum writes meeting notes here');
    expect(syncTip(list[1], nameOf)).toBe('Synced with Quorum');
    expect(syncTip(list[2], nameOf)).toBe('Synced with Quorum Dev');
    expect(syncTip(list[3], nameOf)).toBe('Synced with Granola');
    expect(syncTip(list[4], nameOf)).toBe('Synced with Team docs');
    expect(sourceLabel('fireflies', () => 'Fireflies')).toBe('Fireflies');
  });
});
