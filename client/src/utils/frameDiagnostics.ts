/**
 * Layout measurement for an image inside a fixed frame, sent to the server log.
 *
 * Owner, iPhone, 2026-10-10: the trial waiting screen cuts the avatar's head and feet, while the stored cells are whole
 * (figures have 4-150 px of margin) and every rendering path uses object-contain — and WebKit emulation at 375/390/430
 * shows the whole figure. So the cut happens only on the real device. This reports what the device actually laid out:
 * the frame box, the image box, the image's natural size, the computed object-fit / aspect-ratio and the viewport, so the
 * crop can be located from evidence instead of guessed. Sent at most `MAX_REPORTS` times per page load.
 */
const MAX_REPORTS = 4;
let reportsSent = 0;

export function reportImageFrame(img: HTMLImageElement, label: string): void {
  if (reportsSent >= MAX_REPORTS) return;
  reportsSent++;
  try {
    const frame = img.parentElement;
    const r = (el: Element | null) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
    };
    const cs = getComputedStyle(img);
    const fcs = frame ? getComputedStyle(frame) : null;
    const detail = {
      label,
      natural: { w: img.naturalWidth, h: img.naturalHeight },
      img: r(img),
      frame: r(frame),
      objectFit: cs.objectFit,
      imgPosition: cs.position,
      imgPadding: cs.padding,
      frameAspectRatio: fcs ? fcs.aspectRatio : null,
      frameOverflow: fcs ? fcs.overflow : null,
      supportsAspectRatio: typeof CSS !== 'undefined' && CSS.supports ? CSS.supports('aspect-ratio', '1') : null,
      viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
      visualViewport: window.visualViewport ? { w: Math.round(window.visualViewport.width), h: Math.round(window.visualViewport.height), scale: window.visualViewport.scale } : null,
    };
    void fetch(`${import.meta.env.VITE_API_URL || ''}/api/log-error`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        errorType: 'layout-diagnostic',
        message: `[FRAME] ${JSON.stringify(detail)}`.slice(0, 500),
        url: window.location.pathname,
        userAgent: navigator.userAgent.slice(0, 500),
        timestamp: new Date().toISOString(),
      }),
    }).catch(() => { /* a measurement, never blocks the page */ });
  } catch { /* a measurement, never blocks the page */ }
}
