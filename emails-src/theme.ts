/**
 * Shared design tokens for MagicalStory emails.
 *
 * Style direction: warm storybook — cream parchment background, white card,
 * serif headline, sans body, indigo CTA, gold accent. Designed for the
 * children's-book feel of the product while staying readable in every major
 * inbox.
 *
 * Keep colours and spacing in this file only. Components consume tokens; never
 * hardcode hex values in template .tsx files.
 */

export const colors = {
  // Page background — warm parchment
  pageBg: '#FAF7F2',
  // Card surface
  cardBg: '#FFFFFF',
  // Card border (very subtle, only visible against cream)
  cardBorder: '#EFE9DF',
  // Headline text (warm near-black)
  headline: '#1F1B16',
  // Body text
  body: '#4A4439',
  // Muted secondary text (footer, captions)
  muted: '#9B948A',
  // Soft divider
  divider: '#EFE9DF',
  // Brand CTA
  ctaBg: '#6366F1',
  ctaText: '#FFFFFF',
  // Warm gold accent (sparkles, small decorative bits)
  accent: '#E5B860',
  // Error/warn accent for failure emails
  warnBg: '#FEF2F2',
  warnBorder: '#FCA5A5',
  warnText: '#7F1D1D',
  // Subtle highlight for info panels (delivery info, claim banner)
  infoBg: '#F5F1E8',
  infoBorder: '#E7DEC9',
} as const;

export const fonts = {
  // System serif stack — used for headline only (more characterful than the
  // body sans). Email clients can't reliably load web fonts.
  serif:
    "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, 'Times New Roman', serif",
  // System sans — body, buttons, captions
  sans:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
} as const;

export const spacing = {
  pagePad: '32px 16px',
  cardPad: '32px',
  cardRadius: '12px',
  buttonRadius: '8px',
} as const;

export const sizes = {
  containerWidth: '560px',
  logoHeight: '40px',
} as const;
