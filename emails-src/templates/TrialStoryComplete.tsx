import * as React from 'react';
import { Text } from '@react-email/components';
import { Layout } from '../components/Layout';
import { CardBody, Paragraph, InfoPanel } from '../components/CardBody';
import { Button } from '../components/Button';
import { Cover } from '../components/Cover';
import { Cond } from '../components/Cond';
import { PerksList } from '../components/PerksList';
import { colors, fonts } from '../theme';
import { footer, trialStoryComplete, Lang } from '../i18n';

interface Props {
  lang: Lang;
}

/**
 * Trial-user story-complete email. Mirrors the full-account story-complete
 * but adds:
 *   - A note that the PDF is attached
 *   - A claim-account info panel + dedicated CTA pointing at /claim/<token>
 *   - The perks list comes after the CTA (incentive to claim)
 *
 * The cover image is shown when the caller provides `coverUrl`.
 */
export default function TrialStoryComplete({ lang }: Props) {
  const t = trialStoryComplete[lang];
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
        <Paragraph>{t.attachmentNote}</Paragraph>
        <InfoPanel>
          <Text
            style={{
              fontFamily: fonts.sans,
              color: colors.body,
              fontSize: '15px',
              lineHeight: '22px',
              margin: '0',
            }}
          >
            {t.claimLine}
          </Text>
        </InfoPanel>
        <div style={{ textAlign: 'center', margin: '8px 0 24px' }}>
          <Button href="{claimUrl}">{t.cta}</Button>
        </div>
        <PerksList intro={t.perksIntro} perks={t.perks} />
        <Paragraph muted>{t.signoff}</Paragraph>
      </CardBody>
    </Layout>
  );
}
