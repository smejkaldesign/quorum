import type { KbFile } from '../../src/quorum';

// Files attached to notes of knowledge bases hosted by Quorum, in the note's text (ee/kbHosted.js, migration 0034). A
// note links to a file as quorum://kb-file/<file id>: a picture as an image, a PDF as a link, with the file's name as
// the text.

const ID = '[0-9A-HJKMNP-TV-Z]{26}';
const label = (name: string) => String(name || 'File').replace(/[[\]\n]/g, '').trim() || 'File';

export const fileMarkdown = (f: Pick<KbFile, 'id' | 'name' | 'mime' | 'link'>): string =>
  `${f.mime.startsWith('image/') ? '!' : ''}[${label(f.name)}](${f.link || `quorum://kb-file/${f.id}`})`;

// the text with a file's link put at its end, after a blank line
export const withFile = (text: string, f: Pick<KbFile, 'id' | 'name' | 'mime' | 'link'>): string => {
  const head = text.replace(/\s+$/, '');
  return `${head}${head ? '\n\n' : ''}${fileMarkdown(f)}\n`;
};

// the text without any link to a file: the image or link goes, and a line left empty by it goes with it
export function withoutFile(text: string, fileId: string): string {
  if (!new RegExp(`^${ID}$`).test(fileId)) return text;
  const link = new RegExp(`!?\\[[^\\]\\n]*\\]\\(quorum://kb-file/${fileId}\\)`, 'g');
  return text
    .split('\n')
    .flatMap((line) => {
      if (!link.test(line)) return [line];
      link.lastIndex = 0;
      const kept = line.replace(link, '').replace(/[ \t]+$/, '');
      return kept.trim() ? [kept] : [];
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}
