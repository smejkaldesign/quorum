import { describe, expect, it } from 'vitest';
import { buildTerms, orgOf, TERM_CAP, topNames, VAULT_PEOPLE } from '../terms.js';

describe('buildTerms', () => {
  it('puts the call first, then the dictionary, company, owner and vault people, without repeats', () => {
    const t = buildTerms({
      invitees: ['Jane Doe', 'Acme'], participants: ['Sam Lee (Acme)', 'jane doe'],
      dictionary: [{ heard: 'sell loon', write: 'Celune' }, { heard: 'quorum', write: 'Quorum' }],
      company: 'Smejkal Design', owner: 'Alex Rivera', vaultPeople: ['Pat Quinn', 'Sam Lee'],
    });
    expect(t).toEqual(['Jane Doe', 'Acme', 'Sam Lee', 'Celune', 'Quorum', 'Smejkal Design', 'Alex Rivera', 'Pat Quinn']);
  });

  it('drops single letters, numbers, common words and long phrases, and strips emails and tags', () => {
    const t = buildTerms({ participants: ['A', '12', 'Guest', 'the', 'Pat Quinn <pat@acme.com>', 'One Two Three Four Five', '  Kim   Park  ', 'J. Park'] });
    expect(t).toEqual(['Pat Quinn', 'Kim Park', 'J. Park']);
  });

  it('caps the list at TERM_CAP and keeps the earliest sources', () => {
    const vaultPeople = Array.from({ length: 400 }, (_, i) => `Person${i}`);
    const t = buildTerms({ invitees: ['First Guest'], vaultPeople });
    expect(t).toHaveLength(TERM_CAP);
    expect(t[0]).toBe('First Guest');
    expect(t.at(-1)).toBe(`Person${TERM_CAP - 2}`);
    expect(buildTerms({ vaultPeople, cap: 10 })).toHaveLength(10);
  });

  it('includes the write side of every dictionary entry and tolerates empty input', () => {
    expect(buildTerms({ dictionary: [{ heard: 'x', write: 'Xylo' }, { heard: 'y' }, null] })).toEqual(['Xylo']);
    expect(buildTerms()).toEqual([]);
    expect(buildTerms({ invitees: [null, undefined, ''], company: undefined })).toEqual([]);
  });
});

describe('orgOf', () => {
  it('reads a company from a work email or a Zoom tag, and skips mail providers and role tags', () => {
    expect(orgOf('Jane Doe <jane@acme.com>')).toBe('Acme');
    expect(orgOf('jane@mail.acme.io')).toBe('Mail');
    expect(orgOf('sam@gmail.com')).toBeNull();
    expect(orgOf('Sam Lee (Acme Corp)')).toBe('Acme Corp');
    expect(orgOf('Alex Rivera (recorder)')).toBeNull();
    expect(orgOf('Pat Quinn')).toBeNull();
  });
});

describe('topNames', () => {
  it('ranks names by how often they appear and caps at VAULT_PEOPLE', () => {
    expect(topNames([['Pat', 'Sam'], ['Sam'], ['Sam', 'Kim'], null])).toEqual(['Sam', 'Pat', 'Kim']);
    const lists = Array.from({ length: 200 }, (_, i) => [`N${i}`]);
    expect(topNames(lists)).toHaveLength(VAULT_PEOPLE);
    expect(topNames(lists, 5)).toHaveLength(5);
  });
});
