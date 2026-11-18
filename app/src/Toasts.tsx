import { useEffect, useState } from 'react';
import { IconCheck, IconClose } from './icons';

// Toasts: short confirmations at the bottom center of the window, for an action the person just took. Each one stays
// 6 seconds, with a bar along its bottom that runs out over that time, and an X to close it sooner. Any part of the app
// shows one with toast(); the Toaster mounted once in App draws them
export const TOAST_MS = 6000;
type Toast = { id: number; text: string; tone: 'ok' | 'info' | 'error' };
const EVENT = 'quorum:toast';
let next = 1;

export function toast(text: string, tone: Toast['tone'] = 'ok') {
  window.dispatchEvent(new CustomEvent<Toast>(EVENT, { detail: { id: next++, text, tone } }));
}

export function Toaster() {
  const [list, setList] = useState<Toast[]>([]);
  useEffect(() => {
    const add = (e: Event) => {
      const t = (e as CustomEvent<Toast>).detail;
      setList((xs) => [...xs.slice(-3), t]);
      window.setTimeout(() => setList((xs) => xs.filter((x) => x.id !== t.id)), TOAST_MS);
    };
    window.addEventListener(EVENT, add);
    // what an AI tool did through the quorum MCP (appActions.js), shown the way a button's confirmation is
    const off = window.quorum?.onAgentAction?.((a) => toast(a.text, 'info'));
    return () => { window.removeEventListener(EVENT, add); off?.(); };
  }, []);
  if (!list.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          <span className="toast-icon" aria-hidden="true">{t.tone === 'error' ? <IconClose width={14} height={14} /> : <IconCheck width={15} height={15} />}</span>
          <span className="toast-text">{t.text}</span>
          <button className="icon-btn toast-x" aria-label="Close" onClick={() => setList((xs) => xs.filter((x) => x.id !== t.id))}><IconClose width={14} height={14} /></button>
          <i className="toast-bar" style={{ animationDuration: `${TOAST_MS}ms` }} aria-hidden="true" />
        </div>
      ))}
    </div>
  );
}
