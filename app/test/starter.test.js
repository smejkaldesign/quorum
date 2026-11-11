import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MARK_CLOSE, MARK_OPEN, applySection, folderName, normalizeAnswers, parseSuggestion, plan, readSetup, rerunSetup, slug, writeStarter } from '../starter.js';

const answers = { template: 'founder', role: 'Product designer', goals: 'Ship Quorum', projects: ['Quorum', 'Benefind app'], people: ['Ada Lovelace', 'Grace Hopper'], organize: 'areas' };

describe('starter plan', () => {
  it('normalizes loose answers', () => {
    const n = normalizeAnswers({ template: 'nope', projects: 'A, B;C\nD', people: [' X ', ''], organize: 'weird' });
    expect(n.template).toBe('personal');
    expect(n.projects).toEqual(['A', 'B', 'C', 'D']);
    expect(n.people).toEqual(['X']);
    expect(n.organize).toBe('areas');
  });
  it('names folders by template and organize answer', () => {
    expect(folderName('people', 'areas')).toBe('02-people');
    expect(folderName('people', 'plain')).toBe('people');
    expect(folderName('decisions', 'areas')).toBe('decisions');
    expect(slug('Grace Hopper')).toBe('grace-hopper');
  });
  it('builds a founder folder with a note per project and person, listed in the index', () => {
    const p = plan({ name: 'Studio', answers });
    const rels = Object.keys(p.files);
    expect(rels).toContain('04-company/README.md');
    expect(rels).toContain('decisions/README.md');
    expect(rels).toContain('03-projects/quorum.md');
    expect(rels).toContain('02-people/grace-hopper.md');
    expect(p.files['index.md']).toContain('[[grace-hopper]] - person: Grace Hopper');
    expect(p.files['CLAUDE.md']).toContain(MARK_OPEN);
    expect(p.files['CLAUDE.md']).toContain('Role: Product designer');
    expect(p.files['CLAUDE.md']).toContain('confidential: personal` or `confidential: finance`');
    expect(JSON.parse(p.files['.quorum/setup.json']).answers.template).toBe('founder');
  });
  it('plain organize drops the numbers', () => {
    const p = plan({ answers: { ...answers, template: 'team-lead', organize: 'plain' } });
    expect(Object.keys(p.files)).toContain('one-on-ones/README.md');
    expect(p.meetings).toBe('meetings/quorum');
  });
});

describe('writing and re-running', () => {
  it('never overwrites an existing file, and a re-run keeps hand edits outside the markers', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'starter-'));
    writeStarter(dir, plan({ name: 'Studio', answers }));
    const note = path.join(dir, '02-people', 'ada-lovelace.md');
    writeFileSync(note, '# Ada\n\nhand written\n');
    const claude = path.join(dir, 'CLAUDE.md');
    writeFileSync(claude, readFileSync(claude, 'utf8') + '\n## Mine\n\nkeep this\n');
    const r = rerunSetup(dir, { name: 'Studio', answers: { ...answers, role: 'Founder', people: ['Ada Lovelace', 'Linus'] } });
    expect(readFileSync(note, 'utf8')).toContain('hand written');
    expect(r.written).toContain('02-people/linus.md');
    const text = readFileSync(claude, 'utf8');
    expect(text).toContain('Role: Founder');
    expect(text).not.toContain('Role: Product designer');
    expect(text).toContain('keep this');
    expect(text.split(MARK_OPEN).length).toBe(2);
    const index = readFileSync(path.join(dir, 'index.md'), 'utf8');
    expect(index.match(/\[\[ada-lovelace\]\]/g)).toHaveLength(1);
    expect(index).toContain('[[linus]] - person: Linus');
    expect(readSetup(dir).answers.role).toBe('Founder');
    expect(existsSync(path.join(dir, '08-meetings', 'quorum'))).toBe(true);
  });
  it('a re-run keeps the folder naming, lists every area on disk, and survives a damaged marker pair', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'starter-'));
    writeStarter(dir, plan({ name: 'Studio', answers }));
    const claude = path.join(dir, 'CLAUDE.md');
    writeFileSync(claude, readFileSync(claude, 'utf8').replace(MARK_CLOSE, '') + '\n## Mine\n\nkeep this\n');
    rerunSetup(dir, { name: 'Studio', answers: { ...answers, template: 'personal', organize: 'plain', projects: ['Quorum'], people: ['Quorum'] } });
    expect(existsSync(path.join(dir, 'people'))).toBe(false);
    expect(existsSync(path.join(dir, '02-people', 'quorum.md'))).toBe(true);
    const text = readFileSync(claude, 'utf8');
    expect(text.split(MARK_OPEN).length).toBe(2);
    expect(text.split(MARK_CLOSE).length).toBe(2);
    expect(text).toContain('keep this');
    expect(text).toContain('`04-company/`');
    expect(text).toContain('`decisions/`');
    const index = readFileSync(path.join(dir, 'index.md'), 'utf8');
    expect(index).toContain('[[quorum]] - project: Quorum');
    expect(index).toContain('[[quorum]] - person: Quorum');
    expect(readSetup(dir).answers.organize).toBe('areas');
  });
  it('readSetup normalizes a hand-edited answers file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'starter-'));
    writeStarter(dir, plan({ name: 'Studio', answers }));
    writeFileSync(path.join(dir, '.quorum', 'setup.json'), JSON.stringify({ version: 1, name: 'Studio', answers: { template: 'founder', projects: 'A, B' } }));
    expect(readSetup(dir).answers).toMatchObject({ template: 'founder', projects: ['A', 'B'], people: [], organize: 'areas' });
  });
  it('appends the section to a CLAUDE.md that has none', () => {
    const out = applySection('# Mine\n\nrules\n', `${MARK_OPEN}\nX\n${MARK_CLOSE}`);
    expect(out.startsWith('# Mine\n\nrules\n\n' + MARK_OPEN)).toBe(true);
  });
});

describe('suggestion parsing', () => {
  it('reads the JSON out of a chatty answer and drops empty ones', () => {
    expect(parseSuggestion('Sure:\n{"role":"Designer","projects":["Q"],"people":[],"template":"founder"}\nDone')).toMatchObject({ role: 'Designer', projects: ['Q'], template: 'founder' });
    expect(parseSuggestion('{"role":"","projects":[]}')).toBeNull();
    expect(parseSuggestion('I do not know')).toBeNull();
  });
});
