import { describe, expect, it } from 'vitest';
import { linkMentions } from '../keeper.js';

describe('linkMentions', () => {
  const note = '---\ntitle: Ana Ruiz sync\n---\n# Ana Ruiz sync\n\nAna Ruiz agreed. Ana Ruiz again.\n```\nAna Ruiz\n```\nThe Acme Platform launch';
  it('links the first plain mention in the body, outside frontmatter, headings and code', () => {
    const out = linkMentions(note, [{ name: 'Ana Ruiz', target: 'ana-ruiz' }, { name: 'Acme Platform', target: 'acme-platform' }]);
    expect(out).toContain('title: Ana Ruiz sync');
    expect(out).toContain('# Ana Ruiz sync');
    expect(out).toContain('[[ana-ruiz|Ana Ruiz]] agreed. Ana Ruiz again.');
    expect(out).toContain('```\nAna Ruiz\n```');
    expect(out).toContain('The [[acme-platform|Acme Platform]] launch');
  });
  it('leaves a name alone when the body already links its note, or the mention sits inside a link', () => {
    expect(linkMentions('Met [[ana-ruiz]] and Ana Ruiz', [{ name: 'Ana Ruiz', target: 'ana-ruiz' }])).toBe('Met [[ana-ruiz]] and Ana Ruiz');
    expect(linkMentions('See [[other|Ana Ruiz]] now', [{ name: 'Ana Ruiz', target: 'ana-ruiz' }])).toBe('See [[other|Ana Ruiz]] now');
  });
  it('matches whole names only and runs again without changes', () => {
    expect(linkMentions('Anarchy is not Ana', [{ name: 'Ana', target: 'ana' }])).toBe('Anarchy is not [[ana|Ana]]');
    const once = linkMentions('Ana Ruiz agreed', [{ name: 'Ana Ruiz', target: 'ana-ruiz' }]);
    expect(linkMentions(once, [{ name: 'Ana Ruiz', target: 'ana-ruiz' }])).toBe(once);
  });
});
