import * as React from 'react';
import { Layout } from '../components/Layout';
import { CardBody, Paragraph } from '../components/CardBody';
import { Button } from '../components/Button';
import { Cover } from '../components/Cover';
import { Cond } from '../components/Cond';
import { PerksList } from '../components/PerksList';
import { footer, storyComplete, Lang } from '../i18n';

interface Props {
  lang: Lang;
}

/**
 * Story-complete email for full-account users — sends them straight back to
 * the reader. Optional hero cover image at the top (rendered when the caller
 * passes `coverUrl`).
 *
 * Free-book block (`{?freeBookUrl}`): a plain account note for a person who just
 * signed up from the trial and has not made a real book yet. Transactional mail
 * with one factual line, deliberately NO unsubscribe wording (docs/decisions.md
 * 2026-11-08). Stripped when email.js passes no `freeBookUrl`.
 */
export default function StoryComplete({ lang }: Props) {
  const t = storyComplete[lang];
  const f = footer[lang];
  return (
    <Layout
      lang={lang}
      preview={t.preview}
      footerTagline={f.tagline}
      footerCountry={f.country}
    >
      <Cond when="coverUrl">
        <Cover src="{coverUrl}" alt="{title}" />
      </Cond>
      <CardBody headline={t.headline}>
        <Paragraph>{t.greeting}</Paragraph>
        <Paragraph>{t.body}</Paragraph>
        <div style={{ textAlign: 'center', margin: '8px 0 24px' }}>
          <Button href="{storyUrl}">{t.cta}</Button>
        </div>
        <Cond when="freeBookUrl">
          <Paragraph>{t.freeBook}</Paragraph>
          <div style={{ textAlign: 'center', margin: '8px 0 24px' }}>
            <Button href="{freeBookUrl}">{t.freeBookCta}</Button>
          </div>
        </Cond>
        <PerksList intro={t.perksIntro} perks={t.perks} />
        <Paragraph muted>{t.signoff}</Paragraph>
      </CardBody>
    </Layout>
  );
}
