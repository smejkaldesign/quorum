import { forwardRef, useEffect, useRef } from 'react';
import { useSession } from './session';

export const PLACEHOLDER = 'Jot what matters. Quorum fills in the rest from the transcript.';

export const IconPen = (p: React.SVGProps<SVGSVGElement>) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
);

// what you type during a call and its review. The text reaches the main process 500 ms after the last keystroke, and at
// once on blur, so a crash keeps it. A reload keeps it too; a new call starts it empty. It only ever leaves this Mac
// inside the notes prompt
export function usePrivateNotes() {
  const [text, setText] = useSession('privateNotes', '');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<string | null>(null);
  const flush = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (pending.current === null) return;
    window.quorum.privateNotesSet(pending.current);
    pending.current = null;
  };
  const change = (next: string) => {
    setText(next);
    pending.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 500);
  };
  const reset = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; pending.current = null; setText(''); };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return { text, change, flush, reset };
}

export const PrivateNotes = forwardRef<HTMLTextAreaElement, { value: string; onChange: (v: string) => void; onBlur: () => void }>(function PrivateNotes({ value, onChange, onBlur }, ref) {
  return <textarea ref={ref} className="my-notes" aria-label="Your notes" placeholder={PLACEHOLDER} value={value} onChange={(e) => onChange(e.target.value)} onBlur={onBlur} />;
});
