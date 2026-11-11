import { type ReactNode, createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

// a small stand-in for sonner, bottom-left like Celune's: toast.success / toast.error from anywhere under the provider
type Kind = 'info' | 'success' | 'error';
interface Toast { id: number; kind: Kind; text: string }
interface Api { show: (kind: Kind, text: string) => void; success: (text: string) => void; error: (text: string) => void; info: (text: string) => void }

const Ctx = createContext<Api | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const next = useRef(1);
  const show = useCallback((kind: Kind, text: string) => {
    const id = next.current++;
    setList((l) => [...l, { id, kind, text }]);
    window.setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), kind === 'error' ? 7000 : 4000);
  }, []);
  const api = useMemo<Api>(() => ({ show, success: (t) => show('success', t), error: (t) => show('error', t), info: (t) => show('info', t) }), [show]);
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toasts" aria-live="polite">
        {list.map((t) => <div key={t.id} className={`toast ${t.kind}`} role="status">{t.text}</div>)}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): Api {
  const api = useContext(Ctx);
  if (!api) throw new Error('useToast needs a ToastProvider above it');
  return api;
}
