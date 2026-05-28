import * as React from 'react';
import { Text } from '@react-email/components';
import { InfoPanel } from './CardBody';
import { colors, fonts } from '../theme';

interface PerksListProps {
  intro: string;
  perks: string[];
}

/**
 * Soft info panel listing a series of bullet perks. Used in story-complete,
 * trial-story-complete, and trial-reminder.
 *
 * Each perk is its own <Text> with `margin:0` so plain-text render produces
 * tight contiguous lines, not blank-separated paragraphs.
 */
export function PerksList({ intro, perks }: PerksListProps) {
  return (
    <InfoPanel>
      <Text
        style={{
          fontFamily: fonts.sans,
          color: colors.body,
          fontSize: '14px',
          lineHeight: '22px',
          fontWeight: 600,
          margin: '0 0 8px',
        }}
      >
        {intro}
      </Text>
      {perks.map((perk, i) => (
        <Text
          key={i}
          style={{
            fontFamily: fonts.sans,
            color: colors.body,
            fontSize: '14px',
            lineHeight: '22px',
            margin: '0',
          }}
        >
          • {perk}
        </Text>
      ))}
    </InfoPanel>
  );
}
