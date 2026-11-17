// Tab containment for dialogs (controls.tsx Modal): Tab on the last control goes to the first, Shift+Tab on the first
// goes to the last, and focus outside the dialog comes back in. null: the browser moves focus as usual
export function trapTarget<T>(items: T[], active: T | null, back: boolean): T | null {
  if (!items.length) return null;
  const i = active == null ? -1 : items.indexOf(active);
  if (back) return i <= 0 ? items[items.length - 1] : null;
  return i === -1 || i === items.length - 1 ? items[0] : null;
}
export const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
