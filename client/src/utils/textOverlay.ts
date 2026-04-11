/**
 * Text Overlay Position Utility
 *
 * Calculates where to place story text on page images, cycling through
 * 6 positions for visual variety. Sizes adapt to text length.
 *
 * Used by: StoryDisplay (browser CSS), pdf.js (PDFKit rendering)
 */

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

export function getTextOverlayPosition(pageNumber: number, text: string): TextOverlayLayout {
  // Cycle through 6 positions (1-indexed page numbers)
  const posIndex = ((pageNumber - 1) % POSITION_CYCLE.length + POSITION_CYCLE.length) % POSITION_CYCLE.length;
  const position = POSITION_CYCLE[posIndex];
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
 * Get CSS classes for the text overlay container
 */
export function getOverlayClasses(layout: TextOverlayLayout): string {
  const posClasses: string[] = ['absolute', 'p-3', 'md:p-5'];

  // Position
  if (layout.top !== 'auto') posClasses.push(`top-0`);
  if (layout.bottom !== 'auto') posClasses.push(`bottom-0`);
  if (layout.left !== 'auto') posClasses.push(`left-0`);
  if (layout.right !== 'auto') posClasses.push(`right-0`);

  return posClasses.join(' ');
}

/**
 * Get CSS classes for the gradient background
 */
export function getGradientClasses(layout: TextOverlayLayout): string {
  const isTop = layout.position.startsWith('top');

  // Subtle feathered gradient — mostly transparent, just enough to read text
  // Edge where text sits: ~50% white, feathers out to fully transparent
  const vGradient = isTop
    ? 'bg-gradient-to-b from-white/50 via-white/30 via-30% to-transparent'
    : 'bg-gradient-to-t from-white/50 via-white/30 via-30% to-transparent';

  return vGradient;
}
