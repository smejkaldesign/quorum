// Tab containment in the app's dialogs (controls.tsx Modal, focusTrap.ts)
import { describe, expect, it } from 'vitest';
import { trapTarget } from '../src/focusTrap.ts';

describe('Tab inside a dialog', () => {
  const items = ['keep', 'stop', 'link'];
  it('wraps from the last control to the first, and Shift+Tab from the first to the last', () => {
    expect(trapTarget(items, 'link', false)).toBe('keep');
    expect(trapTarget(items, 'keep', true)).toBe('link');
  });
  it('leaves Tab to the browser between the first and the last', () => {
    expect(trapTarget(items, 'keep', false)).toBeNull();
    expect(trapTarget(items, 'stop', true)).toBeNull();
  });
  it('brings focus from outside the dialog back in', () => {
    expect(trapTarget(items, 'outside', false)).toBe('keep');
    expect(trapTarget(items, null, true)).toBe('link');
  });
  it('does nothing in a dialog with no controls', () => {
    expect(trapTarget([], null, false)).toBeNull();
  });
});
