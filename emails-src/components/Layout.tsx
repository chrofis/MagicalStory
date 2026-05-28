import * as React from 'react';
import {
  Html,
  Head,
  Preview,
  Body,
  Container,
  Section,
} from '@react-email/components';
import { colors, fonts, spacing, sizes } from '../theme';
import { Footer } from './Footer';

interface LayoutProps {
  lang: 'en' | 'de' | 'fr' | 'it';
  preview: string;
  children: React.ReactNode;
  // Localized footer strings — passed in by the template (kept out of the
  // shared layout so all four languages compile from the same component).
  footerTagline: string;
  footerCountry: string;
}

const htmlLang = {
  en: 'en',
  de: 'de-CH',
  fr: 'fr-CH',
  it: 'it-CH',
} as const;

/**
 * Outer email shell: cream page background, centered white card, footer.
 * The card surface and rounded corners come from this component so every
 * template gets the same chrome without repeating it.
 */
export function Layout({
  lang,
  preview,
  children,
  footerTagline,
  footerCountry,
}: LayoutProps) {
  return (
    <Html lang={htmlLang[lang]}>
      <Head>
        <meta name="color-scheme" content="light only" />
        <meta name="supported-color-schemes" content="light only" />
      </Head>
      <Preview>{preview}</Preview>
      <Body
        style={{
          backgroundColor: colors.pageBg,
          margin: 0,
          padding: 0,
          fontFamily: fonts.sans,
          color: colors.body,
          WebkitTextSizeAdjust: '100%',
        }}
      >
        <Container
          style={{
            maxWidth: sizes.containerWidth,
            margin: '0 auto',
            padding: spacing.pagePad,
          }}
        >
          <Section
            style={{
              backgroundColor: colors.cardBg,
              borderRadius: spacing.cardRadius,
              border: `1px solid ${colors.cardBorder}`,
              overflow: 'hidden',
            }}
          >
            {children}
          </Section>
          <Footer tagline={footerTagline} country={footerCountry} />
        </Container>
      </Body>
    </Html>
  );
}
