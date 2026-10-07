// Every compiled email template, in every language, filled exactly as its
// sender fills it, leaves no `{placeholder}` behind — in the subject, the
// plain-text part or the HTML part.
//
// Two leaks this pins, both found 2026-10-07 by filling the committed
// emails/*.html with the senders' value sets:
//   1. order-confirmation / order-shipped wrote `alt="{title}"` on the cover
//      thumbnail, but their senders have no title (orders carry only
//      story_id), so every order mail with a cover shipped a literal
//      `{title}` alt. The alt is now a static localized string (`coverAlt`).
//   2. trial-reminder's plain-text part carried `{HEADLINE}`: React Email's
//      plain-text renderer upper-cases the <h1>, and fillTemplate is
//      case-sensitive, so every reminder's text part showed the raw token.
//      scripts/build-emails.ts restores the token's case after rendering.

import { describe, it, expect } from 'vitest';
import path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const email = require(path.join(ROOT, 'email.js'));
const { getTemplateSection, fillTemplate } = email;

const LANGUAGES = ['English', 'German', 'French', 'Italian'];

// The value keys each sender supplies — mirrors the `values` objects in
// email.js. A key a template reads that is missing here is exactly the bug.
const greeting = ' Anna';
const SENDER_VALUES: Record<string, Record<string, string>> = {
  'story-complete': { greeting, title: 'Der Drache', storyUrl: 'https://magicalstory.ch/shared/t', claimUrl: '', coverUrl: 'https://r2/c.jpg', credits: '10' },
  'trial-story-complete': { greeting, title: 'Der Drache', storyUrl: 'https://magicalstory.ch/shared/t', claimUrl: 'https://magicalstory.ch/claim/x', coverUrl: 'https://r2/c.jpg', credits: '10' },
  'story-failed': { greeting },
  'trial-reminder': { greeting, claimUrl: 'https://magicalstory.ch/claim/x', subject: 'S', headline: 'Deine 10 Gratis-Credits warten noch.', body: 'B', ctaLabel: 'C', perksIntro: 'P', credits: '10', daysLeft: '3', unsubscribeUrl: 'https://magicalstory.ch/api/email/unsubscribe/dTE.ab' },
  'order-confirmation': { greeting, orderId: 'ABCD1234', amount: '49.00', currency: 'CHF', addressLine1: 'Weg 1', city: 'Baden', postalCode: '5400', country: 'CH', deliveryEstimate: '5–7 Werktage', coverUrl: 'https://r2/c.jpg' },
  'order-shipped': { greeting, orderId: 'ABCD1234', trackingNumber: 'TN1', trackingUrl: 'https://track/x', coverUrl: 'https://r2/c.jpg' },
  'order-failed': { greeting },
  'email-verification': { verifyUrl: 'https://magicalstory.ch/api/auth/verify-email/t' },
  'password-reset': { resetUrl: 'https://magicalstory.ch/reset-password/t' },
};

const TOKEN = /\{[\w?/]+\}/g;

describe('compiled email templates leave no placeholder unfilled', () => {
  for (const [name, values] of Object.entries(SENDER_VALUES)) {
    for (const language of LANGUAGES) {
      it(`${name} [${language}] — subject, text and html`, () => {
        const section = getTemplateSection(name, language);
        expect(section).not.toBeNull();
        for (const part of ['subject', 'text', 'html'] as const) {
          expect(section[part].length).toBeGreaterThan(0);
          const left = fillTemplate(section[part], values).match(TOKEN) || [];
          expect(left, `${name} ${language} ${part}`).toEqual([]);
        }
      });
    }
  }
});

describe('order mails: the cover alt is a localized string, not {title}', () => {
  for (const name of ['order-confirmation', 'order-shipped']) {
    for (const language of LANGUAGES) {
      it(`${name} [${language}]`, () => {
        const { html } = getTemplateSection(name, language);
        expect(html).not.toContain('{title}');
        const alt = html.match(/<img[^>]*alt="([^"]*)"/)?.[1];
        expect(alt).toBeTruthy();
      });
    }
  }
});

describe('trial-reminder: the plain-text headline token keeps its case', () => {
  for (const language of LANGUAGES) {
    it(`[${language}]`, () => {
      const { text } = getTemplateSection('trial-reminder', language);
      expect(text).toContain('{headline}');
      expect(text).not.toMatch(/\{[A-Z]+\}/);
    });
  }
});

describe('order-shipped: no tracking URL means no tracking button, never a dead "#" one', () => {
  const base = { greeting, orderId: 'ABCD1234', trackingNumber: 'TN1', coverUrl: 'https://r2/c.jpg' };
  for (const language of LANGUAGES) {
    it(`[${language}] the {?trackingUrl} block is stripped when the value is empty`, () => {
      const { html, text } = getTemplateSection('order-shipped', language);
      const filledHtml = fillTemplate(html, { ...base, trackingUrl: '' }, { html: true });
      const filledText = fillTemplate(text, { ...base, trackingUrl: '' });
      expect(filledHtml).not.toContain('href="#"');
      expect(filledHtml).not.toMatch(/<a[^>]*href=""/);
      expect(filledHtml.match(TOKEN) || []).toEqual([]);
      expect(filledText.match(TOKEN) || []).toEqual([]);
      const withUrl = fillTemplate(html, { ...base, trackingUrl: 'https://track/x' }, { html: true });
      expect(withUrl).toContain('href="https://track/x"');
      // The CTA label exists only inside the conditional block.
      const cta = withUrl.match(/href="https:\/\/track\/x"[^>]*>\s*(?:<[^>]+>\s*)*([^<]+)</)?.[1]?.trim();
      expect(cta).toBeTruthy();
      expect(filledHtml).not.toContain(cta as string);
    });
  }
  it('email.js passes an empty value, not "#"', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const source = require('fs').readFileSync(path.join(ROOT, 'email.js'), 'utf8');
    expect(source).not.toMatch(/trackingUrl\s*\|\|\s*'#'/);
    expect(source).toMatch(/trackingUrl: trackingDetails\.trackingUrl \|\| ''/);
  });
});
