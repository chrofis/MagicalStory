import React from 'react';

/** The first `lines` lines of `text`, fading out at the last one. */
const ClampedText: React.FC<{ text: string; lines: number; style?: React.CSSProperties; className?: string }> = ({ text, lines, style, className }) => (
  <p
    className={className}
    style={{
      ...style,
      display: '-webkit-box',
      WebkitBoxOrient: 'vertical',
      WebkitLineClamp: lines,
      overflow: 'hidden',
      WebkitMaskImage: 'linear-gradient(to bottom, #000 55%, transparent 100%)',
      maskImage: 'linear-gradient(to bottom, #000 55%, transparent 100%)',
    }}
  >
    {text}
  </p>
);

export default ClampedText;
