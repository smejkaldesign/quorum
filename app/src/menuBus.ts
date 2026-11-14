import { useEffect } from 'react';

// One menu open at a time across the window: a menu that opens announces itself, and every other menu closes.
const MENU_OPENED = 'quorum:menu-opened';

export function useExclusiveMenu(id: string, open: boolean, close: () => void) {
  useEffect(() => {
    if (open) window.dispatchEvent(new CustomEvent(MENU_OPENED, { detail: id }));
  }, [id, open]);
  useEffect(() => {
    if (!open) return;
    const other = (e: Event) => { if ((e as CustomEvent<string>).detail !== id) close(); };
    window.addEventListener(MENU_OPENED, other);
    return () => window.removeEventListener(MENU_OPENED, other);
  }, [id, open, close]);
}
