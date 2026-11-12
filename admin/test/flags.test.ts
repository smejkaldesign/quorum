import { describe, expect, it } from 'vitest';
import { auditLine, filterFlags, flagKeyFrom, parseTags, shapeFlag, validateFlagForm } from '../src/shape';

const row = (over: Record<string, unknown> = {}) => ({ id: 'f1', key: 'meeting-capture', name: 'Meeting capture', description: 'Detects calls', enabled: false, tags: ['notetaker'], created_at: '2026-11-12T00:00:00Z', updated_at: '2026-11-12T01:00:00Z', ...over });

describe('a flag row', () => {
  it('shapes the owner RPC row, defaulting what is missing', () => {
    expect(shapeFlag(row())).toEqual({ id: 'f1', key: 'meeting-capture', name: 'Meeting capture', description: 'Detects calls', enabled: false, tags: ['notetaker'], createdAt: '2026-11-12T00:00:00Z', updatedAt: '2026-11-12T01:00:00Z' });
    expect(shapeFlag({ id: 'x', key: 'k', created_at: 't' })).toMatchObject({ name: 'k', description: '', enabled: false, tags: [], updatedAt: 't' });
    expect(shapeFlag(row({ enabled: 'true', tags: 'notetaker' }))).toMatchObject({ enabled: false, tags: [] });
  });
});

describe('the forms', () => {
  it('derives a key from a name the way the database accepts it', () => {
    expect(flagKeyFrom('Meeting capture')).toBe('meeting-capture');
    expect(flagKeyFrom('  Live  Assist! (beta) ')).toBe('live-assist-beta');
    expect(flagKeyFrom('---')).toBe('');
  });

  it('splits tags, lowercases them and drops duplicates', () => {
    expect(parseTags('Notetaker, cloud ,notetaker,, ')).toEqual(['notetaker', 'cloud']);
    expect(parseTags('')).toEqual([]);
  });

  it('refuses an empty name or a bad key and cleans the rest', () => {
    expect(validateFlagForm({ name: ' ', key: 'a', description: '', tags: '' })).toEqual({ error: 'Give the flag a name.' });
    expect(validateFlagForm({ name: 'A', key: 'Bad Key', description: '', tags: '' })).toEqual({ error: 'A key is lowercase letters, digits and hyphens, like dark-mode.' });
    expect(validateFlagForm({ name: 'A', key: '-a', description: '', tags: '' })).toHaveProperty('error');
    expect(validateFlagForm({ name: 'A'.repeat(81), key: 'a', description: '', tags: '' })).toEqual({ error: 'The name is at most 80 characters.' });
    expect(validateFlagForm({ name: 'A', key: 'a', description: 'x'.repeat(501), tags: '' })).toEqual({ error: 'The description is at most 500 characters.' });
    expect(validateFlagForm({ name: 'A', key: 'a', description: '', tags: Array.from({ length: 21 }, (_, i) => `t${i}`).join(',') })).toEqual({ error: 'A flag has at most 20 tags.' });
    expect(validateFlagForm({ name: 'A', key: 'a'.repeat(61), description: '', tags: '' })).toHaveProperty('error');
    expect(validateFlagForm({ name: ' Dark mode ', key: 'dark-mode', description: ' Night colors ', tags: 'ui, UI' })).toEqual({ draft: { name: 'Dark mode', key: 'dark-mode', description: 'Night colors', tags: ['ui'] } });
  });
});

describe('the list', () => {
  const flags = [shapeFlag(row()), shapeFlag(row({ id: 'f2', key: 'manual-listen', name: 'Manual listening', enabled: true, tags: ['notetaker', 'core'] })), shapeFlag(row({ id: 'f3', key: 'dark-mode', name: 'Dark mode', tags: [] }))];
  it('filters by status and searches name, key and tags', () => {
    expect(filterFlags(flags, '', 'all').map((f) => f.key)).toEqual(['meeting-capture', 'manual-listen', 'dark-mode']);
    expect(filterFlags(flags, '', 'enabled').map((f) => f.key)).toEqual(['manual-listen']);
    expect(filterFlags(flags, '', 'disabled').map((f) => f.key)).toEqual(['meeting-capture', 'dark-mode']);
    expect(filterFlags(flags, 'LISTEN', 'all').map((f) => f.key)).toEqual(['manual-listen']);
    expect(filterFlags(flags, 'core', 'all').map((f) => f.key)).toEqual(['manual-listen']);
    expect(filterFlags(flags, 'dark', 'enabled')).toEqual([]);
  });
});

describe('the audit line', () => {
  it('reads the flag actions', () => {
    const base = { id: 'a', actor: null, targetWorkspace: null, createdAt: 't' };
    expect(auditLine({ ...base, action: 'flag_set', detail: { key: 'live-assist', enabled: true } })).toBe('Turned the live-assist flag on');
    expect(auditLine({ ...base, action: 'flag_set', detail: { key: 'live-assist', enabled: false } })).toBe('Turned the live-assist flag off');
    expect(auditLine({ ...base, action: 'flag_create', detail: { key: 'dark-mode' } })).toBe('Created the dark-mode flag');
    expect(auditLine({ ...base, action: 'flag_update', detail: { key: 'dark-mode' } })).toBe('Edited the dark-mode flag');
  });
});
