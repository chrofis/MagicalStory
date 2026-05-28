import * as React from 'react';
import { Layout } from '../components/Layout';
import { CardBody, Paragraph } from '../components/CardBody';
import { Button } from '../components/Button';
import { PerksList } from '../components/PerksList';
import { footer, trialReminder, Lang } from '../i18n';

interface Props {
  lang: Lang;
}

/**
 * Trial-reminder email. Most of the customer-facing copy (headline, body,
 * CTA label, perks intro) is injected at send time by `email.js`, which
 * picks day-5 vs day-25 variant strings from `TRIAL_REMINDER_COPY`. The
 * template keeps those as raw placeholders so the same React component
 * serves both variants.
 *
 * The greeting, perks bullet list, and signoff are static-per-language and
 * come from `i18n.trialReminder`.
 */
export default function TrialReminder({ lang }: Props) {
  const t = trialReminder[lang];
  const f = footer[lang];
  return (
    <Layout
      lang={lang}
      preview={t.preview}
      footerTagline={f.tagline}
      footerCountry={f.country}
    >
      <CardBody headline="{headline}">
        <Paragraph>{t.greeting}</Paragraph>
        <Paragraph>{'{body}'}</Paragraph>
        <div style={{ textAlign: 'center', margin: '8px 0 24px' }}>
          <Button href="{claimUrl}">{'{ctaLabel}'}</Button>
        </div>
        <PerksList intro="{perksIntro}" perks={t.perks} />
        <Paragraph muted>{t.signoff}</Paragraph>
      </CardBody>
    </Layout>
  );
}
