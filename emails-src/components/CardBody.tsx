import * as React from 'react';
import { Section, Heading, Text } from '@react-email/components';
import { colors, fonts, spacing } from '../theme';

interface CardBodyProps {
  headline: string;
  children: React.ReactNode;
}

/**
 * Inner card content area. The headline uses our serif stack (storybook feel)
 * and sits above arbitrary children — usually a greeting paragraph, a body
 * paragraph, a CTA, and an optional info panel.
 */
export function CardBody({ headline, children }: CardBodyProps) {
  return (
    <Section style={{ padding: spacing.cardPad }}>
      <Heading
        as="h1"
        style={{
          fontFamily: fonts.serif,
          color: colors.headline,
          fontSize: '26px',
          lineHeight: '32px',
          fontWeight: 600,
          margin: '0 0 16px',
        }}
      >
        {headline}
      </Heading>
      {children}
    </Section>
  );
}

interface ParagraphProps {
  children: React.ReactNode;
  muted?: boolean;
}

/** Standard body paragraph used inside <CardBody>. */
export function Paragraph({ children, muted }: ParagraphProps) {
  return (
    <Text
      style={{
        fontFamily: fonts.sans,
        color: muted ? colors.muted : colors.body,
        fontSize: '16px',
        lineHeight: '24px',
        margin: '0 0 16px',
      }}
    >
      {children}
    </Text>
  );
}

interface InfoPanelProps {
  children: React.ReactNode;
  variant?: 'info' | 'warn';
}

/**
 * Soft-bordered info block — for shipping addresses, delivery estimates,
 * tracking numbers, and similar metadata. `warn` variant is used in failure
 * emails.
 */
export function InfoPanel({ children, variant = 'info' }: InfoPanelProps) {
  const bg = variant === 'warn' ? colors.warnBg : colors.infoBg;
  const border = variant === 'warn' ? colors.warnBorder : colors.infoBorder;
  return (
    <Section
      style={{
        backgroundColor: bg,
        border: `1px solid ${border}`,
        borderRadius: '8px',
        padding: '16px 20px',
        margin: '8px 0 24px',
      }}
    >
      {children}
    </Section>
  );
}
