import { Fragment, useEffect, useRef } from 'react';
import { CODE_LENGTH, backspace, codeChar, dashBefore, deleteAt, fromInput, pasteCode, typeInto, type CellEdit } from '../betaCode.js';

// One box per character of an access code, with the dash drawn between groups (betaCode.js GROUPS). A typed
// character replaces the current box and moves on, also when it equals what the box held. Backspace on an empty box
// moves back, Delete clears the box, the arrow keys move, and a pasted code fills every box. The parent owns the
// cells, so it can clear them and decide when a full code is sent.
export function CodeBoxes({ cells, onChange, onHint, disabled, focusKey }: {
  cells: string[];
  onChange: (cells: string[]) => void;
  onHint: (hint: string) => void;
  disabled?: boolean;
  // a new value moves the cursor back to the first box (after a refusal clears them)
  focusKey?: number;
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const focus = (i: number) => { const el = refs.current[Math.max(0, Math.min(CODE_LENGTH - 1, i))]; el?.focus(); el?.select(); };
  useEffect(() => { if (!disabled) focus(0); }, [focusKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = (r: CellEdit) => { onChange(r.cells); onHint(r.hint ?? ''); focus(r.focus); };

  return (
    <div className="code-boxes" role="group" aria-label="Access code">
      {cells.map((c, i) => (
        <Fragment key={i}>
          {dashBefore.includes(i) && <span className="code-dash" aria-hidden="true">-</span>}
          <input
            ref={(el) => { refs.current[i] = el; }}
            className="code-box"
            value={c}
            disabled={disabled}
            inputMode="text"
            autoCapitalize="characters"
            autoComplete={i === 0 ? 'one-time-code' : 'off'}
            spellCheck={false}
            aria-label={`Character ${i + 1} of ${CODE_LENGTH}`}
            onFocus={(e) => e.currentTarget.select()}
            // a single typed character is handled here, so the box never holds two and nothing shifts
            onKeyDown={(e) => {
              if (e.metaKey || e.ctrlKey || e.altKey) return;
              if (e.key === 'Backspace') { e.preventDefault(); apply(backspace(cells, i)); }
              else if (e.key === 'Delete') { e.preventDefault(); apply(deleteAt(cells, i)); }
              else if (e.key === 'ArrowLeft') { e.preventDefault(); focus(i - 1); }
              else if (e.key === 'ArrowRight') { e.preventDefault(); focus(i + 1); }
              else if (e.key.length === 1 && e.key !== ' ') {
                e.preventDefault();
                if (codeChar(e.key) || e.key === '-') apply(typeInto(cells, i, e.key));
                else onHint(typeInto(cells, i, e.key).hint ?? '');
              }
            }}
            // whatever reaches the box without a caught keystroke: autofill, dictation, an input method
            onChange={(e) => apply(fromInput(cells, i, e.target.value))}
            onPaste={(e) => { e.preventDefault(); apply(pasteCode(cells, i, e.clipboardData.getData('text'))); }}
          />
        </Fragment>
      ))}
    </div>
  );
}
