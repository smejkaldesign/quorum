import { useEffect, useRef, useState } from 'react';
import { Avatar } from './Speaker';

// The chats on one note, meeting or recording. A page can hold several: each shows collapsed to its first question
// on one line, with its response count on hover; one opens at a time, and Exit chat goes back to the list.
export type ChatEntry<T> = { id: string; turns: T[] };
type Turnish = { q: string; a: string; pending?: boolean };

export function useChats<T extends Turnish>() {
  const [chats, setChats] = useState<ChatEntry<T>[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
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
  return { chats, setChats, openId, setOpenId, active, target, update, settle, newChat, exit: () => setOpenId(null) };
}

type Me = { name: string; photo: string | null };
// the collapsed chats: who asked and the first question under it, with View on the right; View opens that chat alone
export function ChatList<T extends Turnish>({ chats, onOpen, me }: { chats: ChatEntry<T>[]; onOpen: (id: string) => void; me: Me }) {
  if (!chats.length) return null;
  return (
    <section className="note-thread chat-list" aria-label="Chats">
      <h3 className="chat-list-head">{chats.length} {chats.length === 1 ? 'chat' : 'chats'}</h3>
      {chats.map((c) => (
        <div key={c.id} className="chat-row">
          <div className="nt-who"><Avatar name={me.name} photo={me.photo} size={22} /><strong>{me.name}</strong>
            <button className="pill small-pill chat-btn" onClick={() => onOpen(c.id)}>View</button></div>
          <p className="nt-q chat-row-q">{c.turns[0]?.q ?? 'New chat'}</p>
        </div>
      ))}
    </section>
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
