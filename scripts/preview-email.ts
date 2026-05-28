/**
 * Render every template into a standalone HTML preview file per language,
 * with placeholders pre-filled with sample data — so the user can open them
 * directly in a browser and judge the design.
 *
 * Output: emails-preview/<slug>.<lang>.html (gitignored).
 *
 * Mirrors `email.js`'s `fillTemplate` logic for `{?key}...{/key}` conditional
 * blocks so the previews show what users actually receive.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as React from 'react';
import { render } from '@react-email/render';

import StoryComplete from '../emails-src/templates/StoryComplete';
import StoryFailed from '../emails-src/templates/StoryFailed';
import TrialStoryComplete from '../emails-src/templates/TrialStoryComplete';
import TrialReminder from '../emails-src/templates/TrialReminder';
import OrderConfirmation from '../emails-src/templates/OrderConfirmation';
import OrderShipped from '../emails-src/templates/OrderShipped';
import OrderFailed from '../emails-src/templates/OrderFailed';
import EmailVerification from '../emails-src/templates/EmailVerification';
import PasswordReset from '../emails-src/templates/PasswordReset';

import * as i18n from '../emails-src/i18n';
import type { Lang } from '../emails-src/i18n';

// Per-language variant copy for trial-reminder. Mirrors
// `TRIAL_REMINDER_COPY.day25` in email.js — without importing it, since
// email.js is CommonJS and we want this preview script to stay zero-effort.
// Keep the day-25 variant in sync if email.js's copy changes.
const TRIAL_REMINDER_VARIANT: Record<Lang, {
  subject: string; headline: string; body: string;
  ctaLabel: string; perksIntro: string;
}> = {
  en: {
    subject: 'Your free credits expire in 5 days',
    headline: 'Last chance — your free credits expire in 5 days.',
    body: 'Your trial claim link is about to expire. Set your password now to keep your 200 free credits and the story you already created. After 5 days the link disappears for good.',
    ctaLabel: 'Claim my account now',
    perksIntro: 'Once you claim, you also unlock:',
  },
  de: {
    subject: 'Deine Gratis-Credits laufen in 5 Tagen ab',
    headline: 'Letzte Chance — deine Gratis-Credits laufen in 5 Tagen ab.',
    body: 'Dein Aktivierungslink läuft bald ab. Setze jetzt dein Passwort, um deine 200 Gratis-Credits und deine bereits erstellte Geschichte zu behalten. Nach 5 Tagen verschwindet der Link endgültig.',
    ctaLabel: 'Konto jetzt aktivieren',
    perksIntro: 'Sobald du aktivierst, erhältst du ausserdem:',
  },
  fr: {
    subject: 'Vos crédits gratuits expirent dans 5 jours',
    headline: 'Dernière chance — vos crédits gratuits expirent dans 5 jours.',
    body: "Votre lien d'activation est sur le point d'expirer. Définissez votre mot de passe maintenant pour garder vos 200 crédits gratuits et l'histoire que vous avez déjà créée. Après 5 jours, le lien disparaît pour de bon.",
    ctaLabel: 'Activer mon compte maintenant',
    perksIntro: 'Une fois votre compte activé, vous débloquez aussi :',
  },
  it: {
    // Italian is not in email.js TRIAL_REMINDER_COPY today, so this is just
    // sample copy modeled on the German variant.
    subject: 'I tuoi crediti gratuiti scadono tra 5 giorni',
    headline: 'Ultima possibilità — i tuoi crediti gratuiti scadono tra 5 giorni.',
    body: 'Il tuo link di attivazione sta per scadere. Imposta la tua password ora per mantenere i tuoi 200 crediti gratuiti e la storia che hai già creato.',
    ctaLabel: 'Attiva il mio account ora',
    perksIntro: 'Una volta attivato, sblocchi anche:',
  },
};

function sampleFor(lang: Lang): Record<string, string> {
  return {
    greeting: 'Roger',
    title: 'The Forest Friend',
    storyUrl: 'https://www.magicalstory.ch/shared/example-token',
    claimUrl: 'https://www.magicalstory.ch/claim/example-token',
    // Mirrors CREDIT_CONFIG.LIMITS.INITIAL_USER in server/config/credits.js.
    credits: '200',
    daysLeft: '5',
    orderId: 'MS-2026-04827',
    verifyUrl: 'https://www.magicalstory.ch/verify/example-token',
    resetUrl: 'https://www.magicalstory.ch/reset/example-token',
    trackingNumber: '1Z999AA10123456784',
    trackingUrl: 'https://www.ups.com/track?tracknum=1Z999AA10123456784',
    amount: '54.90',
    currency: 'CHF',
    addressLine1: 'Bahnhofstrasse 12',
    city: 'Zürich',
    postalCode: '8001',
    country: 'CH',
    deliveryEstimate: 'May 30 - Jun 4',
    coverUrl: 'https://magicalstory.ch/images/email-logo.png',
    // trial-reminder variant placeholders, picked per language
    ...TRIAL_REMINDER_VARIANT[lang],
  };
}

function fill(html: string, values: Record<string, string>): string {
  let out = html;
  out = out.replace(
    /\{\?(\w+)\}([\s\S]*?)\{\/\1\}/g,
    (_m, key, inner) => (values[key] ? inner : '')
  );
  for (const [k, v] of Object.entries(values)) {
    out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
  }
  return out;
}

const TEMPLATES: Array<{ slug: string; Component: React.ComponentType<{ lang: Lang }> }> = [
  { slug: 'story-complete', Component: StoryComplete },
  { slug: 'story-failed', Component: StoryFailed },
  { slug: 'trial-story-complete', Component: TrialStoryComplete },
  { slug: 'trial-reminder', Component: TrialReminder },
  { slug: 'order-confirmation', Component: OrderConfirmation },
  { slug: 'order-shipped', Component: OrderShipped },
  { slug: 'order-failed', Component: OrderFailed },
  { slug: 'email-verification', Component: EmailVerification },
  { slug: 'password-reset', Component: PasswordReset },
];

const OUT_DIR = path.resolve(__dirname, '..', 'emails-preview');

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const { slug, Component } of TEMPLATES) {
    for (const lang of i18n.LANGS) {
      const html = await render(React.createElement(Component, { lang }));
      const filled = fill(html, sampleFor(lang));
      const file = path.join(OUT_DIR, `${slug}.${lang}.html`);
      fs.writeFileSync(file, filled, 'utf8');
    }
    console.log(`✓ ${slug}`);
  }
  console.log(`\nWrote ${TEMPLATES.length * i18n.LANGS.length} preview files to ${path.relative(process.cwd(), OUT_DIR)}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
