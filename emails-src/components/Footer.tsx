import * as React from 'react';
import { Img, Link, Row, Column, Section, Text } from '@react-email/components';
import { colors, fonts } from '../theme';

interface FooterProps {
  tagline: string;
  // Single country/legal line, e.g. "MagicalStory, Schweiz"
  country: string;
}

// Support email is universal across all languages — kept in code, not i18n.
// Matches `EMAIL_REPLY_TO` in email.js (the actual reply destination).
const SUPPORT_EMAIL = 'info@magicalstory.ch';

/**
 * Footer below the card — logo on the LEFT, contact stack on the RIGHT,
 * matching the original email layout. Uses Row/Column (table-based) so the
 * two-column layout survives in every email client (Outlook included).
 *
 * The footer text — tagline, magicalstory.ch link, contact line, country —
 * stacks vertically next to the logo. All copy is muted grey to read as
 * supporting material, not body content.
 */
export function Footer({ tagline, country }: FooterProps) {
  const mutedLine: React.CSSProperties = {
    fontFamily: fonts.sans,
    color: colors.muted,
    fontSize: '12px',
    lineHeight: '18px',
    margin: '0',
  };

  return (
    <Section style={{ padding: '24px 8px 0' }}>
      <Row>
        <Column
          style={{
            width: '96px',
            verticalAlign: 'middle',
            paddingRight: '16px',
          }}
        >
          <Link href="https://magicalstory.ch" style={{ textDecoration: 'none' }}>
            <Img
              src="https://magicalstory.ch/images/email-logo.png"
              alt="MagicalStory"
              width="80"
              height="80"
              style={{ width: '80px', height: 'auto', display: 'block' }}
            />
          </Link>
        </Column>
        <Column style={{ verticalAlign: 'middle' }}>
          {/*
            Two-line footer: tagline + a single contact/legal line that
            separates site link, support email, and country with middle dots.
            Single <Text> block with <br/> avoids the blank-line spacing that
            separate <p> elements produce in both HTML and plain text.
          */}
          <Text style={mutedLine}>
            {tagline}
            <br />
            <Link
              href="https://magicalstory.ch"
              style={{ color: colors.muted, textDecoration: 'none' }}
            >
              magicalstory.ch
            </Link>
            {' · '}
            <Link
              href={`mailto:${SUPPORT_EMAIL}`}
              style={{ color: colors.muted, textDecoration: 'none' }}
            >
              {SUPPORT_EMAIL}
            </Link>
            {' · '}
            {country}
          </Text>
        </Column>
      </Row>
    </Section>
  );
}
