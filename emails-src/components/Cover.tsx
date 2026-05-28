import * as React from 'react';
import { Img, Section } from '@react-email/components';
import { colors } from '../theme';

interface CoverProps {
  src: string;
  alt: string;
  /**
   * Visual role of the cover image:
   *   - 'hero' (default): full-bleed at the top of the card, edge-to-edge,
   *     used in story-complete / trial-story-complete where the cover is
   *     the email's main visual.
   *   - 'thumbnail': small (~180px), centered, padded — used in order
   *     emails where the cover is just a reminder of what was ordered;
   *     the order-details panel is the real focus.
   */
  size?: 'hero' | 'thumbnail';
}

export function Cover({ src, alt, size = 'hero' }: CoverProps) {
  if (size === 'thumbnail') {
    return (
      <Section
        style={{
          textAlign: 'center',
          padding: '24px 24px 0',
        }}
      >
        <Img
          src={src}
          alt={alt}
          width="160"
          height="160"
          style={{
            width: '160px',
            height: 'auto',
            display: 'inline-block',
            borderRadius: '6px',
            border: `1px solid ${colors.cardBorder}`,
          }}
        />
      </Section>
    );
  }

  // hero (default)
  return (
    <Img
      src={src}
      alt={alt}
      width="560"
      style={{
        width: '100%',
        height: 'auto',
        display: 'block',
        borderBottom: `1px solid ${colors.cardBorder}`,
      }}
    />
  );
}
