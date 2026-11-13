import { Fragment, useEffect, useRef } from 'react';
import { CODE_LENGTH, backspace, dashBefore, pasteCode, typeInto } from '../betaCode.js';

// One box per character of an access code, with the dash drawn between groups (betaCode.js GROUPS). Typing moves on,
// Backspace on an empty box moves back, the arrow keys move, and a pasted code fills every box. The parent owns the
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

  const apply = (r: { cells: string[]; focus: number; hint?: string }) => { onChange(r.cells); onHint(r.hint ?? ''); focus(r.focus); };

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
            onChange={(e) => {
              // the box holds one character; what arrived is whatever is new in it
              const raw = e.target.value;
              const typed = c && raw.startsWith(c) ? raw.slice(c.length) : raw;
              if (!typed) return;
              apply(typeInto(cells, i, typed));
            }}
            onPaste={(e) => { e.preventDefault(); apply(pasteCode(cells, i, e.clipboardData.getData('text'))); }}
            onKeyDown={(e) => {
              if (e.key === 'Backspace') { e.preventDefault(); apply(backspace(cells, i)); }
              else if (e.key === 'ArrowLeft') { e.preventDefault(); focus(i - 1); }
              else if (e.key === 'ArrowRight') { e.preventDefault(); focus(i + 1); }
            }}
          />
        </Fragment>
      ))}
    </div>
  );
}
