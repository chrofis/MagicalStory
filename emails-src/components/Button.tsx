import * as React from 'react';
import { Button as REButton } from '@react-email/components';
import { colors, fonts, spacing } from '../theme';

interface ButtonProps {
  href: string;
  children: React.ReactNode;
}

/**
 * Primary CTA. One styling source of truth — every email button looks the
 * same. `box-sizing: border-box` keeps padding inside the button width, which
 * matters for Outlook.
 */
export function Button({ href, children }: ButtonProps) {
  return (
    <REButton
      href={href}
      style={{
        backgroundColor: colors.ctaBg,
        color: colors.ctaText,
        fontFamily: fonts.sans,
        fontWeight: 600,
        fontSize: '16px',
        lineHeight: '20px',
        textDecoration: 'none',
        textAlign: 'center',
        padding: '14px 28px',
        borderRadius: spacing.buttonRadius,
        boxSizing: 'border-box',
        display: 'inline-block',
      }}
    >
      {children}
    </REButton>
  );
}
