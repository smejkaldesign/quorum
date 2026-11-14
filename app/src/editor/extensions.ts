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

export function noteExtensions(): AnyExtension[] {
  return [
    StarterKit.configure({ link: { openOnClick: false, autolink: false } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    WikiLink,
  ];
}
