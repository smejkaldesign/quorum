import { useRef, useState } from 'react';
import { IconBack } from './icons';

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

// the collapsed chats: the first question on one line; the response count shows on hover, and a click opens it
export function ChatList<T extends Turnish>({ chats, onOpen }: { chats: ChatEntry<T>[]; onOpen: (id: string) => void }) {
  if (!chats.length) return null;
  return (
    <section className="note-thread chat-list" aria-label="Chats">
      {chats.map((c) => {
        const n = c.turns.filter((t) => !t.pending).length;
        return (
          <button key={c.id} className="chat-row" onClick={() => onOpen(c.id)}>
            <span className="chat-row-q">{c.turns[0]?.q ?? 'New chat'}</span>
            <span className="chat-row-n">{n} {n === 1 ? 'response' : 'responses'}</span>
          </button>
        );
      })}
    </section>
  );
}

export function ChatExit({ onExit }: { onExit: () => void }) {
  return <button className="chat-exit" onClick={onExit}><IconBack width={14} height={14} /> Exit chat</button>;
}
