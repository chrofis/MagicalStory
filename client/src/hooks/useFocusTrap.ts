import { useEffect, type RefObject } from 'react';

// Keeps Tab / Shift+Tab inside an open dialog panel (WAI-ARIA modal dialog pattern).
// The three dialogs (common/Modal, CreditsModal, ChangePasswordModal) already take focus on
// open, close on Escape and return focus on close; this adds the missing cycle.

export const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Pure next-focus calculation so the key handling is testable without a DOM.
 * Returns the index in `focusables` that should receive focus when Tab (or Shift+Tab)
 * is pressed while `activeIndex` is focused (-1 = focus is on the panel itself / outside
 * the list), or null when the browser's default should run.
 */
export function nextFocusIndex(count: number, activeIndex: number, shiftKey: boolean): number | null {
  if (count === 0) return null;
  if (activeIndex === -1) return shiftKey ? count - 1 : 0;
  if (shiftKey) return activeIndex <= 0 ? count - 1 : null;
  return activeIndex >= count - 1 ? 0 : null;
}

export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const panel = ref.current;
      if (!panel) return;
      const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      const activeIndex = focusables.indexOf(document.activeElement as HTMLElement);
      const next = nextFocusIndex(focusables.length, activeIndex, e.shiftKey);
      if (next === null) {
        if (focusables.length === 0) e.preventDefault();
        return;
      }
      e.preventDefault();
      focusables[next].focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [ref, active]);
}
