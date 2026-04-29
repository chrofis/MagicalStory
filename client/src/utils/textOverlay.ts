/**
 * Text Overlay Position Utility
 *
 * Calculates where to place story text on page images, cycling through
 * 6 positions for visual variety. Sizes adapt to text length.
 *
 * The overlay covers the ENTIRE image — the gradient shape itself defines the
 * visible area (radial ellipse for corners, linear band for full-width).
 * No rectangular container, no clipping, no hard edges.
 *
 * Used by: StoryDisplay (browser CSS), pdf.js (PDFKit rendering)
 */

import type { CSSProperties } from 'react';

export type TextPosition = 'top-left' | 'bottom-full' | 'top-right' | 'bottom-left' | 'top-full' | 'bottom-right';

/** Consistent overlay font size across all browser views (matches PDF ~14pt). */
export const OVERLAY_FONT_SIZE = 'clamp(0.7rem, 1.6vw, 1rem)';
/** Legacy — kept for back-compat. Prefer OVERLAY_TEXT_STROKE_STYLE below. */
export const OVERLAY_TEXT_SHADOW = 'none';
/** White text with a crisp dark glyph-stroke — mirrors the server-rendered overlay. */
export const OVERLAY_TEXT_STROKE_STYLE: CSSProperties = {
  WebkitTextStroke: '2.5px rgba(0,0,0,0.85)',
  paintOrder: 'stroke fill',
  color: '#ffffff',
};

// 6-position cycle
const POSITION_CYCLE: TextPosition[] = [
  'top-left',      // Page 1
  'bottom-full',   // Page 2
  'top-right',     // Page 3
  'bottom-left',   // Page 4
  'top-full',      // Page 5
  'bottom-right',  // Page 6
];

export interface TextOverlayLayout {
  position: TextPosition;
  // CSS values (percentages of container)
  top: string | 'auto';
  bottom: string | 'auto';
  left: string | 'auto';
  right: string | 'auto';
  widthPercent: number;   // Max width for text area as % of image
  heightPercent: number;  // Max height for text area as % of image
  textAlign: 'left' | 'center' | 'right';
  // Gradient direction (Tailwind format)
  gradientFrom: string;  // e.g., 'from-white/80'
  gradientDir: string;   // e.g., 'to-t' for bottom positions, 'to-b' for top
}

function getTextSize(text: string): 'short' | 'medium' | 'long' {
  // ''.trim().split(/\s+/) returns [''] (length 1), so filter empty tokens
  // before counting — otherwise empty/whitespace text reports 1 word.
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount < 20) return 'short';
  if (wordCount < 50) return 'medium';
  return 'long';
}

/**
 * Apply the book-spread parity rule: odd pages sit on the left side of the
 * spread (text must use *-left or *-full), even pages sit on the right
 * (text must use *-right or *-full). Mirrors enforceSpreadTextPosition in
 * server/lib/storyHelpers.js so the CSS fallback can't render text on the
 * wrong side of the gutter while the server-rendered overlay PNG loads.
 */
function enforceSpreadParity(position: TextPosition, pageNumber: number): TextPosition {
  if (!pageNumber || pageNumber < 1) return position;
  const isLeftPage = pageNumber % 2 === 1;
  if (isLeftPage && position.includes('right')) {
    return position.replace('right', 'left') as TextPosition;
  }
  if (!isLeftPage && position.includes('left')) {
    return position.replace('left', 'right') as TextPosition;
  }
  return position;
}

export function getTextOverlayPosition(pageNumber: number, text: string, explicitPosition?: TextPosition | null): TextOverlayLayout {
  // Use explicit position from scene expansion if available, otherwise cycle
  const posIndex = ((pageNumber - 1) % POSITION_CYCLE.length + POSITION_CYCLE.length) % POSITION_CYCLE.length;
  const rawPosition = (explicitPosition && POSITION_CYCLE.includes(explicitPosition)) ? explicitPosition : POSITION_CYCLE[posIndex];
  const position = enforceSpreadParity(rawPosition, pageNumber);
  const size = getTextSize(text);

  // Width for corner positions (adapts to text length)
  const cornerWidth = size === 'short' ? 42 : size === 'medium' ? 52 : 62;
  // Height for full-width positions
  const fullHeight = size === 'short' ? 18 : size === 'medium' ? 22 : 28;
  // Height for corner positions
  const cornerHeight = size === 'short' ? 22 : size === 'medium' ? 28 : 35;

  switch (position) {
    case 'top-left':
      return {
        position, top: '0', bottom: 'auto', left: '0', right: 'auto',
        widthPercent: cornerWidth, heightPercent: cornerHeight,
        textAlign: 'left', gradientFrom: 'from-white/80', gradientDir: 'to-b',
      };
    case 'top-right':
      return {
        position, top: '0', bottom: 'auto', left: 'auto', right: '0',
        widthPercent: cornerWidth, heightPercent: cornerHeight,
        textAlign: 'right', gradientFrom: 'from-white/80', gradientDir: 'to-b',
      };
    case 'top-full':
      return {
        position, top: '0', bottom: 'auto', left: '0', right: '0',
        widthPercent: 100, heightPercent: fullHeight,
        textAlign: 'center', gradientFrom: 'from-white/80', gradientDir: 'to-b',
      };
    case 'bottom-left':
      return {
        position, top: 'auto', bottom: '0', left: '0', right: 'auto',
        widthPercent: cornerWidth, heightPercent: cornerHeight,
        textAlign: 'left', gradientFrom: 'from-white/80', gradientDir: 'to-t',
      };
    case 'bottom-right':
      return {
        position, top: 'auto', bottom: '0', left: 'auto', right: '0',
        widthPercent: cornerWidth, heightPercent: cornerHeight,
        textAlign: 'right', gradientFrom: 'from-white/80', gradientDir: 'to-t',
      };
    case 'bottom-full':
      return {
        position, top: 'auto', bottom: '0', left: '0', right: '0',
        widthPercent: 100, heightPercent: fullHeight,
        textAlign: 'center', gradientFrom: 'from-white/80', gradientDir: 'to-t',
      };
  }
}

/**
 * CSS class for the overlay container.
 * Covers the full image — the gradient defines the visible shape.
 */
export function getOverlayClasses(_layout: TextOverlayLayout): string {
  return 'absolute flex pointer-events-none';
}

/**
 * Inline positioning style for the overlay container.
 * Covers the full image with a small inset, plus flexbox alignment
 * to position text in the correct corner/edge.
 */
export function getOverlayPositionStyle(layout: TextOverlayLayout): CSSProperties {
  const inset = '1.5%';
  const isTop = layout.position.startsWith('top');
  const isFullWidth = layout.position.includes('full');

  const style: CSSProperties = {
    top: inset, bottom: inset, left: inset, right: inset,
    alignItems: isTop ? 'flex-start' : 'flex-end',
  };

  if (isFullWidth) {
    style.justifyContent = 'center';
  } else if (layout.position.includes('left')) {
    style.justifyContent = 'flex-start';
  } else {
    style.justifyContent = 'flex-end';
  }

  return style;
}

/**
 * Inline style for the text container inside the overlay.
 * Constrains text width for corner positions.
 */
export function getTextContainerStyle(layout: TextOverlayLayout): CSSProperties {
  const isFullWidth = layout.position.includes('full');
  return {
    maxWidth: isFullWidth ? '100%' : `${layout.widthPercent}%`,
    maxHeight: `${layout.heightPercent}%`,
    overflow: 'hidden' as const,
    textAlign: layout.textAlign,
  };
}

/**
 * Get inline style for the gradient background.
 * Applied to the full-image overlay — the gradient shape itself defines
 * the visible area (no rectangular box, no clipping).
 *
 * Corner positions: radial ellipse emanating from the corner.
 * Full-width: linear gradient from the edge.
 */
export function getGradientStyle(layout: TextOverlayLayout): CSSProperties {
  const isTop = layout.position.startsWith('top');
  const isFullWidth = layout.position.includes('full');
  const isLeft = layout.position.includes('left') || isFullWidth;

  if (isFullWidth) {
    // Full-width: linear gradient concentrated in the text band.
    // Stops scaled to heightPercent so the fade matches the text area.
    const dir = isTop ? 'to bottom' : 'to top';
    const h = layout.heightPercent;
    return {
      background: `linear-gradient(${dir}, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0.3) ${h * 0.5}%, rgba(255,255,255,0) ${h}%)`,
    };
  }

  // Corner: radial ellipse sized to the text area.
  // Explicit size keeps the fade tight around the corner regardless of image dimensions.
  const originX = isLeft ? '0%' : '100%';
  const originY = isTop ? '0%' : '100%';
  const w = layout.widthPercent;
  const h = layout.heightPercent;

  return {
    background: `radial-gradient(${w}% ${h}% at ${originX} ${originY}, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0.3) 40%, rgba(255,255,255,0) 80%)`,
  };
}
