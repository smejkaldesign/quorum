import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { Placeholder } from '@tiptap/extensions';
import type { TreeItem } from '../quorum';
import { noteExtensions } from './extensions';
import { firstChangedBlock, toDoc, toMarkdown } from './markdown';
import { linkName } from './frontmatter';

// The note view's rich editor. value is the note body as markdown; every edit comes back through onChange as
// markdown. A value that changes from outside (Record appending) replaces only the blocks from the first changed one
// to the end, so the cursor and everything above it stay put. Typing [[ opens a picker of vault notes, and / at the
// start of an empty line opens the block commands; the toolbar holds the same commands with their shortcuts.

type Command = { id: string; label: string; keys: string; run: (e: Editor) => void };
const COMMANDS: Command[] = [
  { id: 'h1', label: 'Heading 1', keys: '⌘⌥1', run: (e) => e.chain().focus().toggleHeading({ level: 1 }).run() },
  { id: 'h2', label: 'Heading 2', keys: '⌘⌥2', run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run() },
  { id: 'h3', label: 'Heading 3', keys: '⌘⌥3', run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run() },
  { id: 'bullet', label: 'Bulleted list', keys: '⌘⇧8', run: (e) => e.chain().focus().toggleBulletList().run() },
  { id: 'ordered', label: 'Numbered list', keys: '⌘⇧7', run: (e) => e.chain().focus().toggleOrderedList().run() },
  { id: 'task', label: 'Checklist', keys: '⌘⇧9', run: (e) => e.chain().focus().toggleTaskList().run() },
  { id: 'quote', label: 'Quote', keys: '⌘⇧B', run: (e) => e.chain().focus().toggleBlockquote().run() },
  { id: 'code', label: 'Code block', keys: '⌘⌥C', run: (e) => e.chain().focus().toggleCodeBlock().run() },
  { id: 'rule', label: 'Divider', keys: '---', run: (e) => e.chain().focus().setHorizontalRule().run() },
];
const MARKS = [
  { id: 'bold', label: 'B', tip: 'Bold ⌘B', run: (e: Editor) => e.chain().focus().toggleBold().run() },
  { id: 'italic', label: 'I', tip: 'Italic ⌘I', run: (e: Editor) => e.chain().focus().toggleItalic().run() },
  { id: 'strike', label: 'S', tip: 'Strikethrough ⌘⇧S', run: (e: Editor) => e.chain().focus().toggleStrike().run() },
  { id: 'code', label: '</>', tip: 'Inline code ⌘E', run: (e: Editor) => e.chain().focus().toggleCode().run() },
];

type Menu = { kind: 'link' | 'slash'; query: string; from: number; to: number; x: number; y: number; index: number } | null;
const flatten = (items: TreeItem[], out: string[] = []) => { for (const it of items) { if (it.dir) flatten(it.children ?? [], out); else if (it.path.endsWith('.md')) out.push(it.path); } return out; };

// the open picker's state from the text before the cursor: "[[query" anywhere in the line, or "/query" as the whole line
function menuAt(editor: Editor): Menu {
  const { state, view } = editor;
  const { $from, empty } = state.selection;
  if (!empty || !$from.parent.isTextblock) return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼');
  const link = /\[\[([^\]\n[]*)$/.exec(before);
  const slash = /^\/(\w*)$/.exec(before);
  const m = link ?? slash;
  if (!m) return null;
  const from = $from.pos - m[0].length;
  const at = view.coordsAtPos($from.pos);
  return { kind: link ? 'link' : 'slash', query: m[1], from, to: $from.pos, x: at.left, y: at.bottom + 6, index: 0 };
}

export function NoteEditor({ value, onChange, readOnly, placeholder }: { value: string; onChange: (md: string) => void; readOnly: boolean; placeholder: string }) {
  const emitted = useRef(value);
  const applying = useRef(false);
  const [menu, setMenu] = useState<Menu>(null);
  const menuRef = useRef<Menu>(null);
  menuRef.current = menu;
  const [notes, setNotes] = useState<string[]>([]);
  useEffect(() => { window.quorum.vaultTree().then((t) => setNotes(flatten(t ?? []))).catch(() => {}); }, []);

  const extensions = useMemo(() => [...noteExtensions(), Placeholder.configure({ placeholder })], [placeholder]);
  const editor = useEditor({
    extensions,
    content: toDoc(value),
    editable: !readOnly,
    immediatelyRender: true,
    // the toolbar shows which marks and blocks are on at the cursor
    shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: { class: 'note-rich', 'aria-label': 'Note' },
      handleKeyDown: (_view, e) => keyInMenu(e),
    },
    onUpdate: ({ editor: ed }) => {
      setMenu(menuAt(ed));
      if (applying.current) return;
      const md = toMarkdown(ed.getJSON());
      if (md === emitted.current) return;
      emitted.current = md;
      onChange(md);
    },
    onSelectionUpdate: ({ editor: ed }) => setMenu(menuAt(ed)),
    onBlur: () => setTimeout(() => setMenu(null), 150),
  });

  useEffect(() => { editor?.setEditable(!readOnly); }, [editor, readOnly]);

  // a value from outside: replace from the first changed top-level block to the end
  useEffect(() => {
    if (!editor || value === emitted.current) return;
    const doc = editor.state.doc;
    const blocks: string[] = [];
    doc.forEach((n) => { blocks.push(toMarkdown({ type: 'doc', content: [n.toJSON()] })); });
    const { index, offset } = firstChangedBlock(blocks, emitted.current, value);
    let from = 0;
    doc.forEach((n, pos, i) => { if (i < index) from = pos + n.nodeSize; });
    const tail = value.slice(offset);
    const nodes = tail.trim() ? (toDoc(tail).content ?? []).map((j) => editor.schema.nodeFromJSON(j)) : [];
    applying.current = true;
    try {
      const tr = editor.state.tr;
      if (nodes.length) tr.replaceWith(from, doc.content.size, nodes); else if (from < doc.content.size) tr.delete(from, doc.content.size);
      editor.view.dispatch(tr);
    } finally { applying.current = false; }
    const md = toMarkdown(editor.getJSON());
    emitted.current = md;
    if (md !== value) onChange(md);
  }, [editor, value]); // eslint-disable-line react-hooks/exhaustive-deps

  const items = useMemo(() => {
    if (!menu) return [] as { id: string; label: string; hint: string; run: () => void }[];
    const q = menu.query.toLowerCase();
    if (menu.kind === 'slash') {
      return COMMANDS.filter((c) => !q || c.label.toLowerCase().includes(q) || c.id.startsWith(q)).map((c) => ({
        id: c.id, label: c.label, hint: c.keys,
        run: () => { if (!editor) return; editor.chain().focus().deleteRange({ from: menu.from, to: menu.to }).run(); c.run(editor); },
      }));
    }
    return notes.filter((p) => !q || p.toLowerCase().includes(q)).slice(0, 8).map((p) => ({
      id: p, label: p.split('/').pop()!.replace(/\.md$/, ''), hint: p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '',
      run: () => {
        if (!editor) return;
        // the picker typed "[[query"; a closing "]]" the editor may have auto-added is taken too
        const after = editor.state.doc.textBetween(menu.to, Math.min(menu.to + 2, editor.state.doc.content.size), undefined, '￼');
        const to = after === ']]' ? menu.to + 2 : menu.to;
        editor.chain().focus().deleteRange({ from: menu.from, to }).insertContent([{ type: 'wikiLink', attrs: { target: linkName(p, notes), alias: null } }, { type: 'text', text: ' ' }]).run();
      },
    }));
  }, [menu, notes, editor]);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  function keyInMenu(e: KeyboardEvent): boolean {
    const m = menuRef.current;
    const list = itemsRef.current;
    if (!m || !list.length) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setMenu({ ...m, index: (m.index + step + list.length) % list.length });
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') { list[Math.min(m.index, list.length - 1)].run(); setMenu(null); return true; }
    if (e.key === 'Escape') { setMenu(null); return true; }
    return false;
  }

  if (!editor) return null;
  return (
    <div className="note-rich-wrap">
      {!readOnly && (
        <div className="note-toolbar" role="toolbar" aria-label="Formatting">
          {MARKS.map((m) => (
            <button key={m.id} className={`tb-btn tb-${m.id} ${editor.isActive(m.id) ? 'on' : ''}`} aria-label={m.tip} data-tip={m.tip} onMouseDown={(e) => e.preventDefault()} onClick={() => m.run(editor)}>{m.label}</button>
          ))}
          <span className="tb-sep" />
          {COMMANDS.slice(0, 8).map((c) => {
            const active = c.id.startsWith('h') ? editor.isActive('heading', { level: Number(c.id.slice(1)) }) : editor.isActive({ bullet: 'bulletList', ordered: 'orderedList', task: 'taskList', quote: 'blockquote', code: 'codeBlock' }[c.id] ?? c.id);
            return <button key={c.id} className={`tb-btn ${active ? 'on' : ''}`} aria-label={`${c.label} ${c.keys}`} data-tip={`${c.label} ${c.keys}`} onMouseDown={(e) => e.preventDefault()} onClick={() => c.run(editor)}>{TB_LABEL[c.id]}</button>;
          })}
          <span className="tb-sep" />
          <button className="tb-btn" aria-label="Link to a note" data-tip="Link to a note [[" onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().insertContent('[[').run()}>[[ ]]</button>
        </div>
      )}
      <EditorContent editor={editor} />
      {menu && items.length > 0 && (
        <div className="menu note-picker" role="listbox" aria-label={menu.kind === 'link' ? 'Link to a note' : 'Insert a block'} style={{ position: 'fixed', left: menu.x, top: menu.y }}>
          {items.map((it, i) => (
            <button key={it.id} role="option" aria-selected={i === menu.index} className={i === menu.index ? 'sel' : ''} onMouseDown={(e) => { e.preventDefault(); it.run(); setMenu(null); }}>
              <span>{it.label}</span>{it.hint && <em>{it.hint}</em>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const TB_LABEL: Record<string, string> = { h1: 'H1', h2: 'H2', h3: 'H3', bullet: '•', ordered: '1.', task: '☑', quote: '❝', code: '{ }' };
