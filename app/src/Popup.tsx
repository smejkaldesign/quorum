import { useEffect, useRef, useState } from 'react';
import type { PopupEvent, PopupMode } from './quorum';
import appIcon from '../assets/icon-64.png';
import { IconChevron, IconClose } from './icons';

// the lines name the call's app and chat; a provider without a chat Quorum can post in gets the on-Mac wording
const copyFor = (p: PopupEvent): { title: string; sub: string; cta?: string } => {
  const chat = p.chatName ?? 'Zoom chat';
  switch (p.mode) {
    case 'detected': return { title: 'Meeting detected', sub: p.provider ?? 'Zoom', cta: 'Listen' };
    case 'starting': return { title: 'Starting Quorum', sub: p.chat === false ? 'Listening on this Mac…' : `Posting the notice in the ${chat}…` };
    case 'listening': return { title: 'Quorum is listening', sub: p.chat === false ? 'No chat notice · Stop ends it' : `Posted in the ${chat} · STOP ends it`, cta: 'Open' };
    case 'failed': return { title: "Quorum isn't recording", sub: `Couldn't post the notice in the ${chat}`, cta: 'Try again' };
  }
};

export function Popup() {
  const [p, setP] = useState<PopupEvent>({ mode: 'detected', durationMs: 0, autoListen: false });
  const [run, setRun] = useState(0);
  const [hover, setHover] = useState(false);
  const left = useRef(0);
  const last = useRef(0);
  const bar = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const offs = [
      window.quorum.onPopup((next) => {
        setP(next); left.current = next.durationMs; setRun((r) => r + 1);
        // let the window appear off to the right first, then slide in
        setTimeout(() => setShown(true), 40);
      }),
      window.quorum.onPopupOut(() => setShown(false)),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  // countdown that pauses on hover, like Granola's
  useEffect(() => {
    if (!p.durationMs) return;
    last.current = performance.now();
    const t = setInterval(() => {
      const now = performance.now();
      if (!hover) left.current -= now - last.current;
      last.current = now;
      if (bar.current) bar.current.style.width = `${Math.min(100, 100 * (1 - left.current / p.durationMs))}%`;
      if (left.current <= 0) { clearInterval(t); window.quorum.popupDismiss(); }
    }, 50);
    return () => clearInterval(t);
  }, [run, hover, p.durationMs]);

  const copy = copyFor(p);
  const act = () => (p.mode === 'listening' ? window.quorum.popupOpen() : window.quorum.popupListen());
  return (
    <div className={`popup-shell ${shown ? 'in' : ''}`} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <button className="popup-close" aria-label="Dismiss" onClick={() => window.quorum.popupDismiss()}><IconClose width={12} height={12} /></button>
      <div className="popup">
      <div className="popup-grip" />
      <div className="popup-text">
        <strong>{copy.title}</strong>
        <span>{copy.sub}</span>
      </div>
      {copy.cta ? (
        <div className="popup-split">
          <button className="popup-cta" onClick={act}><img src={appIcon} alt="" />{copy.cta}</button>
          <button className="popup-more" aria-label="More options" onClick={() => window.quorum.popupMenu()}><IconChevron /></button>
        </div>
      ) : <div className="popup-spinner" aria-label="Working" />}
      {p.durationMs > 0 && <div className="popup-progress" ref={bar} />}
      </div>
    </div>
  );
}
