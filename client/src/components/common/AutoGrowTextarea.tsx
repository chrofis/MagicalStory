import type { TextareaHTMLAttributes } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

/** A textarea that is always as tall as its text, so the idea never scrolls inside its box
 *  (owner 2026-10-09: ideas run to ~75 words). Re-measures on text and on width change. */
export function AutoGrowTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, []);
  // Layout effect: measured before the first paint, so the box is never painted one line tall (the "collapse" the owner saw
  // when the idea was finished). Re-measured when the text changes, when the web fonts have loaded (a measure taken with the
  // fallback font is the wrong height) and whenever the box's width changes.
  useLayoutEffect(() => { fit(); }, [fit, props.value]);
  useEffect(() => {
    void document.fonts?.ready.then(fit);
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== width) { width = el.clientWidth; fit(); }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);
  return <textarea ref={ref} rows={1} {...props} />;
}
