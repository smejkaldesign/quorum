// The note editor's schema, shared by the React editor and the markdown tests: StarterKit (headings, bold, italic,
// strike, inline code, code blocks, quotes, lists, rules, links), checklists, and Obsidian wiki links kept as written.
import { Node, mergeAttributes, type AnyExtension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';

// [[target]], [[target|alias]] and [[target#heading]] as one inline atom, written back character for character
export const WIKI = /^\[\[([^\]\n|]+?)(?:\|([^\]\n]+))?\]\]/;
export const WikiLink = Node.create({
  name: 'wikiLink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { target: { default: '' }, alias: { default: null } };
  },
  parseHTML() {
    return [{ tag: 'span[data-wiki]', getAttrs: (el) => ({ target: (el as HTMLElement).dataset.wiki ?? '', alias: (el as HTMLElement).dataset.alias ?? null }) }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const { target, alias } = node.attrs as { target: string; alias: string | null };
    return ['span', mergeAttributes(HTMLAttributes, { 'data-wiki': target, ...(alias ? { 'data-alias': alias } : {}), class: 'md-wiki' }), alias || target];
  },
  renderText({ node }) {
    const { target, alias } = node.attrs as { target: string; alias: string | null };
    return `[[${target}${alias ? `|${alias}` : ''}]]`;
  },
  markdownTokenizer: {
    name: 'wikiLink',
    level: 'inline',
    start: (src: string) => src.indexOf('[['),
    tokenize: (src: string) => {
      const m = WIKI.exec(src);
      return m ? { type: 'wikiLink', raw: m[0], target: m[1], alias: m[2] ?? null } : undefined;
    },
  },
  parseMarkdown: (token) => ({ type: 'wikiLink', attrs: { target: String(token.target ?? ''), alias: token.alias ? String(token.alias) : null } }),
  renderMarkdown: (node) => `[[${node.attrs?.target ?? ''}${node.attrs?.alias ? `|${node.attrs.alias}` : ''}]]`,
});

// ![alt](src) as one inline atom written back character for character. The editor shows the alt text as a chip; a
// note's preview (Markdown.tsx) shows the picture, including a quorum://kb-file attachment of a hosted knowledge base
export const IMAGE = /^!\[([^\]\n]*)\]\(([^)\s]+)\)/;
export const ImageRef = Node.create({
  name: 'imageRef',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { alt: { default: '' }, src: { default: '' } };
  },
  parseHTML() {
    return [{ tag: 'span[data-image]', getAttrs: (el) => ({ src: (el as HTMLElement).dataset.image ?? '', alt: (el as HTMLElement).dataset.alt ?? '' }) }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const { alt, src } = node.attrs as { alt: string; src: string };
    return ['span', mergeAttributes(HTMLAttributes, { 'data-image': src, 'data-alt': alt, class: 'md-image-ref' }), alt || 'Image'];
  },
  renderText({ node }) {
    const { alt, src } = node.attrs as { alt: string; src: string };
    return `![${alt}](${src})`;
  },
  markdownTokenizer: {
    name: 'imageRef',
    level: 'inline',
    start: (src: string) => src.indexOf('!['),
    tokenize: (src: string) => {
      const m = IMAGE.exec(src);
      return m ? { type: 'imageRef', raw: m[0], alt: m[1], src: m[2] } : undefined;
    },
  },
  parseMarkdown: (token) => ({ type: 'imageRef', attrs: { alt: String(token.alt ?? ''), src: String(token.src ?? '') } }),
  renderMarkdown: (node) => `![${node.attrs?.alt ?? ''}](${node.attrs?.src ?? ''})`,
});

export function noteExtensions(): AnyExtension[] {
  return [
    StarterKit.configure({ link: { openOnClick: false, autolink: false } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    WikiLink,
    ImageRef,
  ];
}
