/** Pure next-focus calculation of client/src/hooks/useFocusTrap.ts (no DOM in this env). */
import { describe, it, expect } from 'vitest';
import { nextFocusIndex } from '../../client/src/hooks/useFocusTrap';

describe('useFocusTrap nextFocusIndex', () => {
  it('Tab from the last focusable wraps to the first; Shift+Tab from the first wraps to the last', () => {
    expect(nextFocusIndex(3, 2, false)).toBe(0);
    expect(nextFocusIndex(3, 0, true)).toBe(2);
  });
  it('Tab / Shift+Tab in the middle lets the browser move focus (null)', () => {
    expect(nextFocusIndex(3, 1, false)).toBeNull();
    expect(nextFocusIndex(3, 1, true)).toBeNull();
    expect(nextFocusIndex(3, 0, false)).toBeNull();
  });
  it('focus on the panel itself (index -1) enters at the first, or last with Shift', () => {
    expect(nextFocusIndex(3, -1, false)).toBe(0);
    expect(nextFocusIndex(3, -1, true)).toBe(2);
  });
  it('a panel with no focusables yields null (the hook then swallows the Tab)', () => {
    expect(nextFocusIndex(0, -1, false)).toBeNull();
  });
});
