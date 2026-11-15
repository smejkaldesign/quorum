import { useEffect, useRef, useState } from 'react';
import { Avatar } from './Speaker';

// The chats on one note, meeting or recording. A page can hold several: each shows collapsed to its first question
// on one line, with View on hover; one opens at a time, and Exit chat goes back to the list.
export type ChatEntry<T> = { id: string; turns: T[] };
type Turnish = { q: string; a: string; pending?: boolean };

export function useChats<T extends Turnish>() {
  const [chats, setChats] = useState<ChatEntry<T>[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  // Exit chat plays the opening in reverse: the chat slides down and fades, then closes
  const [closing, setClosing] = useState(false);
  const wantNew = useRef(false);
  const chatsRef = useRef(chats);
  chatsRef.current = chats;
  const active = chats.find((c) => c.id === openId) ?? null;
  // where a new question goes: the open chat, a fresh one after New chat, or else the latest; a fresh one is 'new' to
  // the main process until its answer brings back the saved id
  function target() {
    let id = openId;
    if (!id && !wantNew.current && chatsRef.current.length) id = chatsRef.current[chatsRef.current.length - 1].id;
    if (!id) {
      id = `new-${Date.now()}`;
      const fresh = id;
      setChats((cs) => [...cs, { id: fresh, turns: [] }]);
    }
    wantNew.current = false;
    setOpenId(id);
    const c = chatsRef.current.find((x) => x.id === id);
    return { id, history: (c?.turns ?? []).filter((t) => !t.pending).map(({ q, a }) => ({ q, a })), send: id.startsWith('new-') ? 'new' : id };
  }
  const update = (id: string, fn: (turns: T[]) => T[]) => setChats((cs) => cs.map((c) => (c.id === id ? { ...c, turns: fn(c.turns) } : c)));
  const settle = (tmp: string, real?: string) => {
    if (!real || tmp === real) return;
    setChats((cs) => cs.map((c) => (c.id === tmp ? { ...c, id: real } : c)));
    setOpenId((o) => (o === tmp ? real : o));
  };
  const newChat = () => { wantNew.current = true; setOpenId(null); };
  const exit = () => {
    if (closing) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setOpenId(null); return; }
    setClosing(true);
    window.setTimeout(() => { setOpenId(null); setClosing(false); }, 220);
  };
  return { chats, setChats, openId, setOpenId, active, target, update, settle, newChat, exit, closing };
}

type Me = { name: string; photo: string | null };
// The chats on a page, floating above the composer the way the quick asks do: "N chats" beside the first chat (avatar,
// name, its first question), and View (one chat) or View all chats at the right. View all opens the list below the
// first row, five rows tall and scrolling past that; every row opens its chat. Opening one scrolls the page so the
// chat starts at the top, or as high as it can go when it is short
export function ChatStrip<T extends Turnish>({ chats, onOpen, me }: { chats: ChatEntry<T>[]; onOpen: (id: string) => void; me: Me }) {
  const [all, setAll] = useState(false);
  if (!chats.length) return null;
  const newest = [...chats].reverse();
  const open = (id: string) => {
    setAll(false);
    onOpen(id);
    requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector('.note-thread.chat-open')?.scrollIntoView({ behavior: 'smooth', block: 'start' })));
  };
  const row = (c: ChatEntry<T>) => (
    <button key={c.id} className="cs-row" onClick={() => open(c.id)} data-tip={c.turns[0]?.q}>
      <Avatar name={me.name} photo={me.photo} size={20} /><strong>{me.name}</strong><span className="cs-q">{c.turns[0]?.q ?? 'New chat'}</span>
    </button>
  );
  return (
    <div className={`chat-strip${all ? ' all' : ''}`} role="group" aria-label="Chats on this page">
      <span className="cs-count">{chats.length} {chats.length === 1 ? 'chat' : 'chats'}</span>
      <div className="cs-list">{(all ? newest : newest.slice(0, 1)).map(row)}</div>
      <button className="up-all cs-all" aria-expanded={chats.length > 1 ? all : undefined} onClick={() => (chats.length === 1 ? open(chats[0].id) : setAll((x) => !x))}>
        {chats.length === 1 ? 'View' : all ? 'Hide' : 'View all chats'}
      </button>
    </div>
  );
}

// an open chat's Exit chat sits where its View button was, on the first line of the chat
export function ChatExit({ onExit }: { onExit: () => void }) {
  return <button className="pill small-pill chat-btn chat-exit" onClick={onExit}>Exit chat</button>;
}

// Quick asks show only while the person is in the chat input: true while focus is in a composer or on the asks
// themselves, so a click on an ask still lands
export function useComposerFocus() {
  const inside = (el: EventTarget | null) => el instanceof Element && !!el.closest('.composer, .skill-pills');
  const [on, setOn] = useState(() => inside(document.activeElement));
  useEffect(() => {
    const gain = (e: FocusEvent) => setOn(inside(e.target));
    const lose = (e: FocusEvent) => { if (!inside(e.relatedTarget)) setOn(false); };
    document.addEventListener('focusin', gain);
    document.addEventListener('focusout', lose);
    return () => { document.removeEventListener('focusin', gain); document.removeEventListener('focusout', lose); };
  }, []);
  return on;
}
