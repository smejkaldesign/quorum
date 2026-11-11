import { useEffect, useLayoutEffect, useRef, useState } from 'react';

// a them turn's name as the speaker pass or a correction left it; a turn the pass never saw has none of these
export type SpeakerInfo = { speaker: string | null; confidence: number; cluster: string | null; corrected: boolean };
export type SpeakerTurn = { id: number; channel: 'me' | 'them'; text: string } & Partial<SpeakerInfo>;
export const LOW = 0.6;

// the name on a them turn is a button; the popover lists the participants, Someone else… (typed) and Unknown. A pick
// on a turn that had no name renames it alone and then offers to apply the name to the turns the pass grouped with
// it. Names under LOW confidence are dotted: Quorum's guess. Fixed positioning keeps the popover out of the card's scroll
export function SpeakerName({ turn, fallback, participants, similar, onPick }: { turn: SpeakerTurn; fallback: string; participants: string[]; similar: number; onPick: (name: string | null, similar: boolean) => Promise<void> | void }) {
  const [open, setOpen] = useState(false);
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState('');
  const [offer, setOffer] = useState<string | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = () => { setOpen(false); setTyping(false); setOffer(null); setTyped(''); };

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key); };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !wrap.current || !menu.current) return;
    const a = wrap.current.getBoundingClientRect();
    const h = menu.current.offsetHeight;
    const top = a.bottom + 4 + h > innerHeight - 8 ? Math.max(8, a.top - 4 - h) : a.bottom + 4;
    setPos({ left: Math.min(a.left, innerWidth - menu.current.offsetWidth - 8), top });
  }, [open, typing, offer, participants.length]);

  const guess = !!turn.speaker && !turn.corrected && (turn.confidence ?? 0) < LOW;
  const pick = async (name: string | null) => {
    const unnamed = !turn.speaker;
    await onPick(name, false);
    if (unnamed && name && similar > 0) { setOffer(name); setTyping(false); return; }
    close();
  };

  return (
    <span className="speaker" ref={wrap}>
      <button type="button" className={`speaker-name${guess ? ' guess' : ''}${open ? ' open' : ''}`} {...(guess ? { 'data-tip': "Quorum's guess; click to correct", 'data-tip-pos': 'top' } : {})} onClick={(e) => { e.stopPropagation(); if (open) close(); else setOpen(true); }}>
        {turn.speaker ?? fallback}
      </button>
      {open && (
        <div className="menu speaker-menu" role="menu" ref={menu} style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}>
          {offer ? (
            <>
              <div className="menu-info flat"><span>This turn is {offer}'s now.</span></div>
              <button role="menuitem" onClick={async () => { await onPick(offer, true); close(); }}>Apply to {similar} similar turn{similar === 1 ? '' : 's'}</button>
              <button role="menuitem" onClick={close}>Just this one</button>
            </>
          ) : (
            <>
              {participants.map((p) => <button key={p} role="menuitem" className={p === turn.speaker ? 'checked' : ''} onClick={() => pick(p)}>{p}</button>)}
              {participants.length > 0 && <div className="menu-sep" />}
              {typing ? (
                <form onSubmit={(e) => { e.preventDefault(); const n = typed.trim(); if (n) pick(n); }}>
                  <input autoFocus value={typed} placeholder="Name" aria-label="Name" onChange={(e) => setTyped(e.target.value)} />
                </form>
              ) : <button role="menuitem" onClick={() => setTyping(true)}>Someone else…</button>}
              <button role="menuitem" className={!turn.speaker && turn.corrected ? 'checked' : ''} onClick={() => pick(null)}>Unknown</button>
            </>
          )}
        </div>
      )}
    </span>
  );
}

// how many them turns the pass grouped with this one, for the Apply to similar turns offer
export const similarCount = (turns: SpeakerTurn[], t: SpeakerTurn) => (t.cluster ? turns.filter((x) => x.channel === 'them' && x.id !== t.id && x.cluster === t.cluster && !x.corrected).length : 0);

// who said it, at a glance: the person's own photo, or initials on a color that stays the same for a name. Meeting apps
// give Quorum names, never photos, so everyone but the recorder gets initials
export function Avatar({ name, photo = null, size = 20 }: { name: string; photo?: string | null; size?: number }) {
  const style = { width: size, height: size, fontSize: Math.round(size * 0.46) };
  if (photo) return <span className="avatar-sm" style={style}><img src={photo} alt="" /></span>;
  const words = name.trim().split(/\s+/).filter(Boolean);
  const initials = (words.length > 1 ? words[0][0] + words[words.length - 1][0] : (words[0] ?? '?').slice(0, 1)).toUpperCase();
  let h = 0;
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return <span className="avatar-sm" style={{ ...style, background: `hsl(${h} 42% 40%)` }} aria-hidden="true">{initials}</span>;
}
