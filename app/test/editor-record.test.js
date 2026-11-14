// Record in the rich editor: turns written into the document by position, growth in place, and the caret left alone
import { describe, expect, it } from 'vitest';
import { getSchema } from '@tiptap/core';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { noteExtensions } from '../src/editor/extensions.ts';
import { toDoc, toMarkdown } from '../src/editor/markdown.ts';
import { emptyTail, mapTail, recordTurn } from '../src/editor/record.ts';

const schema = getSchema(noteExtensions());
const stateOf = (md) => EditorState.create({ schema, doc: schema.nodeFromJSON(toDoc(md)) });
const md = (state) => toMarkdown(state.doc.toJSON());
function play(state, turns, model = emptyTail()) {
  for (const t of turns) {
    const r = recordTurn(state, model, t);
    if (!r) continue;
    state = state.apply(r.tr);
    model = r.model;
  }
  return { state, model };
}

describe('Record into the rich editor', () => {
  it('writes into an empty note without a blank first paragraph, then appends', () => {
    const { state } = play(stateOf(''), [{ id: 1, channel: 'me', text: 'Hello' }, { id: 2, channel: 'them', text: 'Hi', label: 'Ada' }]);
    expect(md(state)).toBe('**You:** Hello\n\n**Ada:** Hi');
  });

  it('grows a turn in place even with markdown characters in the text and the name', () => {
    const turns = [
      { id: 1, channel: 'them', label: 'O_Brien [PM]', text: 'use *stars* and snake_case' },
      { id: 1, channel: 'them', label: 'O_Brien [PM]', text: 'use *stars* and snake_case with [brackets]', replace: true },
      { id: 1, channel: 'them', label: 'O_Brien [PM]', text: 'use *stars* and snake_case with [brackets] and 2 * 3', replace: true },
    ];
    const { state } = play(stateOf('# Notes'), turns);
    expect(state.doc.childCount).toBe(2);
    expect(state.doc.lastChild.textContent).toContain('with [brackets] and 2 * 3');
    expect(state.doc.lastChild.textContent.match(/use/g)).toHaveLength(1);
  });

  it('adds only the gained words once you typed after the turn', () => {
    let { state, model } = play(stateOf(''), [{ id: 1, channel: 'me', text: 'call the' }]);
    const tr = state.tr.insert(state.doc.content.size, schema.nodes.paragraph.create(null, schema.text('mine')));
    model = mapTail(model, tr.mapping);
    state = state.apply(tr);
    ({ state } = play(state, [{ id: 1, channel: 'me', text: 'call the bank', replace: true }], model));
    expect(md(state)).toBe('**You:** call the\n\nmine\n\nbank');
  });

  it('stops rewriting a paragraph you edited', () => {
    let { state, model } = play(stateOf(''), [{ id: 1, channel: 'me', text: 'call the' }]);
    const tr = state.tr.insertText('!', state.doc.content.size - 1);
    model = mapTail(model, tr.mapping);
    state = state.apply(tr);
    ({ state } = play(state, [{ id: 1, channel: 'me', text: 'call the bank', replace: true }], model));
    expect(md(state)).toBe('**You:** call the!\n\nbank');
  });

  it('keeps the caret where it is, and follows the end only when the caret was there', () => {
    let state = stateOf('First paragraph\n\nSecond');
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 3)));
    let r = play(state, [{ id: 1, channel: 'me', text: 'appended' }]);
    expect(r.state.selection.head).toBe(3);
    state = stateOf('Only');
    state = state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)));
    r = play(state, [{ id: 1, channel: 'me', text: 'next' }]);
    expect(r.state.selection.head).toBe(TextSelection.atEnd(r.state.doc).head);
  });

  it('does nothing for an empty or unchanged turn', () => {
    const s = stateOf('x');
    expect(recordTurn(s, emptyTail(), { id: 1, channel: 'me', text: '  ' })).toBeNull();
    const { state, model } = play(s, [{ id: 1, channel: 'me', text: 'same' }]);
    const again = recordTurn(state, model, { id: 1, channel: 'me', text: 'same', replace: true });
    expect(md(state.apply(again.tr))).toBe('x\n\n**You:** same');
  });
});
