import { describe, expect, it } from 'vitest';
import { MAIN_TAB_LABEL, keepTab, mainTabs, matchesQuery, showsKnowledge } from '../src/mainTabs.ts';

const signedIn = { signedIn: true, workspace: { id: 'w', name: 'Acme', domain: null, domainJoin: false, role: 'member' } };

describe('the top tabs', () => {
  it('names the graph view Memory and the shared notes Knowledge', () => {
    expect(MAIN_TAB_LABEL.memory).toBe('Memory');
    expect(MAIN_TAB_LABEL.knowledge).toBe('Knowledge');
  });

  it('lists Home and Memory in every build', () => {
    expect(mainTabs('local', null)).toEqual(['home', 'memory']);
    expect(mainTabs('cloud', null)).toEqual(['home', 'memory']);
  });

  it('adds Knowledge only in Cloud, once the person is signed in to a workspace, whatever their role', () => {
    expect(mainTabs('cloud', signedIn)).toEqual(['home', 'memory', 'knowledge']);
    for (const role of ['owner', 'admin', 'member']) expect(showsKnowledge('cloud', { ...signedIn, workspace: { ...signedIn.workspace, role } })).toBe(true);
    expect(showsKnowledge('cloud', { signedIn: true, workspace: null })).toBe(false);
    expect(showsKnowledge('cloud', { signedIn: false, workspace: null })).toBe(false);
    expect(showsKnowledge('local', signedIn)).toBe(false);
    expect(mainTabs('local', signedIn)).toEqual(['home', 'memory']);
  });

  it('reopens a remembered tab only when the build has it', () => {
    expect(keepTab('local')('memory')).toBe(true);
    expect(keepTab('local')('knowledge')).toBe(false);
    expect(keepTab('cloud')('knowledge')).toBe(true);
    expect(keepTab('cloud')('chat')).toBe(false);
    expect(keepTab('cloud')('')).toBe(false);
  });
});

describe('searching shared notes', () => {
  const note = { title: 'Roadmap review', rel: '08-meetings/2026-11-08 Roadmap review.md' };
  it('matches every word against the title or the path, ignoring case', () => {
    expect(matchesQuery(note, '')).toBe(true);
    expect(matchesQuery(note, '  ')).toBe(true);
    expect(matchesQuery(note, 'ROADMAP')).toBe(true);
    expect(matchesQuery(note, 'meetings review')).toBe(true);
    expect(matchesQuery(note, 'roadmap budget')).toBe(false);
  });
});
