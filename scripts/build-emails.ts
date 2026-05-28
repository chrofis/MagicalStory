/**
 * Render every React Email template into the existing `emails/<slug>.html`
 * multi-language file format that `email.js` already parses.
 *
 * The .tsx components are the single source of truth. Subjects and body copy
 * come from `emails-src/i18n.ts`. The render output is wrapped in the
 * existing `[LANGUAGE]` / `Subject:` / `Text:` / `---` / `Html:` block
 * structure so the runtime parser stays untouched.
 *
 * Run: `npm run build:emails`
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

type TemplateSpec = {
  /** Output filename slug — produces emails/<slug>.html */
  slug: string;
  /** React component to render. Must accept `{ lang }`. */
  Component: React.ComponentType<{ lang: Lang }>;
  /**
   * Per-language subject lookup. Returns the raw subject string with
   * placeholders intact — `email.js` substitutes them at send time.
   *
   * For `trial-reminder` the subject is `{subject}` itself: the actual
   * subject text is variant-dependent (day-5 vs day-25) and gets injected
   * by `email.js` from `TRIAL_REMINDER_COPY`.
   */
  subjects: Record<Lang, string>;
};

function perLang<T>(getter: (l: Lang) => T): Record<Lang, T> {
  return Object.fromEntries(i18n.LANGS.map((l) => [l, getter(l)])) as Record<Lang, T>;
}

const TEMPLATES: TemplateSpec[] = [
  {
    slug: 'story-complete',
    Component: StoryComplete,
    subjects: perLang((l) => i18n.storyComplete[l].subject),
  },
  {
    slug: 'story-failed',
    Component: StoryFailed,
    subjects: perLang((l) => i18n.storyFailed[l].subject),
  },
  {
    slug: 'trial-story-complete',
    Component: TrialStoryComplete,
    subjects: perLang((l) => i18n.trialStoryComplete[l].subject),
  },
  {
    slug: 'trial-reminder',
    Component: TrialReminder,
    // email.js owns the subject — see TRIAL_REMINDER_COPY[reminderType][lang].
    subjects: perLang(() => '{subject}'),
  },
  {
    slug: 'order-confirmation',
    Component: OrderConfirmation,
    subjects: perLang((l) => i18n.orderConfirmation[l].subject),
  },
  {
    slug: 'order-shipped',
    Component: OrderShipped,
    subjects: perLang((l) => i18n.orderShipped[l].subject),
  },
  {
    slug: 'order-failed',
    Component: OrderFailed,
    subjects: perLang((l) => i18n.orderFailed[l].subject),
  },
  {
    slug: 'email-verification',
    Component: EmailVerification,
    subjects: perLang((l) => i18n.emailVerification[l].subject),
  },
  {
    slug: 'password-reset',
    Component: PasswordReset,
    subjects: perLang((l) => i18n.passwordReset[l].subject),
  },
];

const EMAILS_DIR = path.resolve(__dirname, '..', 'emails');

async function buildOne(spec: TemplateSpec) {
  const blocks: string[] = [];

  for (const lang of i18n.LANGS) {
    const element = React.createElement(spec.Component, { lang });
    const html = await render(element, { pretty: true });
    const text = await render(element, { plainText: true });
    const subject = spec.subjects[lang];

    const block = `[${i18n.langMarkers[lang]}]
Subject: ${subject}
Text:
${text.trim()}
---
Html:
${html.trim()}`;

    blocks.push(block);
  }

  const out = blocks.join('\n\n') + '\n';
  const outPath = path.join(EMAILS_DIR, `${spec.slug}.html`);
  fs.writeFileSync(outPath, out, 'utf8');
  console.log(`✓ ${spec.slug.padEnd(22)} ${out.length.toLocaleString()} bytes`);
}

async function main() {
  if (!fs.existsSync(EMAILS_DIR)) {
    fs.mkdirSync(EMAILS_DIR, { recursive: true });
  }
  for (const spec of TEMPLATES) {
    await buildOne(spec);
  }
  console.log(`\nBuilt ${TEMPLATES.length} email template(s).`);
}

main().catch((err) => {
  console.error('Email build failed:', err);
  process.exit(1);
});
