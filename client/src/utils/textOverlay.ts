/**
 * Text Overlay Position Utility
 *
 * Calculates where to place story text on page images, cycling through
 * 6 positions for visual variety. Sizes adapt to text length.
 *
 * Used by: StoryDisplay (browser CSS), pdf.js (PDFKit rendering)
 */

import type { CSSProperties } from 'react';

export type TextPosition = 'top-left' | 'bottom-full' | 'top-right' | 'bottom-left' | 'top-full' | 'bottom-right';

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
  widthPercent: number;   // Width as % of image
  heightPercent: number;  // Max height as % of image
  textAlign: 'left' | 'center' | 'right';
  // Gradient direction (Tailwind format)
  gradientFrom: string;  // e.g., 'from-white/80'
  gradientDir: string;   // e.g., 'to-t' for bottom positions, 'to-b' for top
}

function getTextSize(text: string): 'short' | 'medium' | 'long' {
  const wordCount = text.trim().split(/\s+/).length;
  if (wordCount < 20) return 'short';
  if (wordCount < 50) return 'medium';
  return 'long';
}

export function getTextOverlayPosition(pageNumber: number, text: string, explicitPosition?: TextPosition | null): TextOverlayLayout {
  // Use explicit position from scene expansion if available, otherwise cycle
  const posIndex = ((pageNumber - 1) % POSITION_CYCLE.length + POSITION_CYCLE.length) % POSITION_CYCLE.length;
  const position = (explicitPosition && POSITION_CYCLE.includes(explicitPosition)) ? explicitPosition : POSITION_CYCLE[posIndex];
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
 * Get CSS classes for the text overlay container.
 * Uses a small inset (1.5%) so the overlay never lands on a Grok-added border
 * or gets clipped by the image's rounded corners.
 */
export function getOverlayClasses(_layout: TextOverlayLayout): string {
  return 'absolute';
}

/**
 * Inline positioning style for the overlay container.
 * Adds a 1.5% inset from image edges so text never sits on Grok borders
 * or gets clipped by rounded corners.
 */
export function getOverlayPositionStyle(layout: TextOverlayLayout): CSSProperties {
  const inset = '1.5%';
  const style: CSSProperties = {};
  if (layout.top !== 'auto') style.top = inset;
  else style.bottom = inset;
  if (layout.left !== 'auto') style.left = inset;
  if (layout.right !== 'auto') style.right = inset;
  return style;
}

/**
 * Get inline style for the gradient background.
 * Uses radial gradient from the corner for corners, linear for full-width.
 * Fades gradually in ALL directions — no hard box edges.
 *
 * Corner positions also get a CSS mask that feathers the two non-corner edges
 * (e.g. bottom + right for top-left) so `overflow:hidden` on the container
 * never creates a visible hard line.
 */
export function getGradientStyle(layout: TextOverlayLayout): CSSProperties {
  const isTop = layout.position.startsWith('top');
  const isFullWidth = layout.position.includes('full');
  const isLeft = layout.position.includes('left') || isFullWidth;

  if (isFullWidth) {
    // Full-width: vertical gradient from edge
    const dir = isTop ? 'to bottom' : 'to top';
    return {
      background: `linear-gradient(${dir}, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0.35) 50%, rgba(255,255,255,0) 100%)`,
    };
  }

  // Corner: radial gradient emanating from the corner
  const originX = isLeft ? '0%' : '100%';
  const originY = isTop ? '0%' : '100%';

  // Feather mask: fade the two non-corner edges to transparent so the container
  // clip (`overflow:hidden`) never shows a hard line.
  // E.g. top-left → fade bottom edge (to top) + fade right edge (to left)
  const vertDir = isTop ? 'to top' : 'to bottom';   // toward the anchored edge
  const horizDir = isLeft ? 'to left' : 'to right';  // toward the anchored edge
  const maskEdgeV = `linear-gradient(${vertDir}, transparent 0%, black 25%)`;
  const maskEdgeH = `linear-gradient(${horizDir}, transparent 0%, black 25%)`;

  return {
    background: `radial-gradient(ellipse at ${originX} ${originY}, rgba(255,255,255,0.6) 0%, rgba(255,255,255,0.35) 40%, rgba(255,255,255,0) 80%)`,
    WebkitMaskImage: `${maskEdgeV}, ${maskEdgeH}`,
    WebkitMaskComposite: 'destination-in' as any,
    maskImage: `${maskEdgeV}, ${maskEdgeH}`,
    maskComposite: 'intersect',
  };
}
