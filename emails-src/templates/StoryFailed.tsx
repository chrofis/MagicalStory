import * as React from 'react';
import { Text } from '@react-email/components';
import { Layout } from '../components/Layout';
import { CardBody, Paragraph, InfoPanel } from '../components/CardBody';
import { Button } from '../components/Button';
import { colors, fonts } from '../theme';
import { footer, storyFailed, Lang } from '../i18n';

interface Props {
  lang: Lang;
}

/**
 * Sent when story generation fails. Warm storybook chrome stays, but the
 * info panel uses the `warn` variant so it reads as an apology, not as an
 * upsell. CTA points back to the wizard so the user can retry immediately.
 */
export default function StoryFailed({ lang }: Props) {
  const t = storyFailed[lang];
  const f = footer[lang];
  return (
    <Layout
      lang={lang}
      preview={t.preview}
      footerTagline={f.tagline}
      footerCountry={f.country}
    >
      <CardBody headline={t.headline}>
        <Paragraph>{t.greeting}</Paragraph>
        <Paragraph>{t.body}</Paragraph>
        <InfoPanel variant="warn">
          <Text
            style={{
              fontFamily: fonts.sans,
              color: colors.warnText,
              fontSize: '14px',
              lineHeight: '22px',
              margin: '0',
            }}
          >
            {t.warnLine}
          </Text>
        </InfoPanel>
        <div style={{ textAlign: 'center', margin: '8px 0 24px' }}>
          <Button href="https://magicalstory.ch">{t.cta}</Button>
        </div>
        <Paragraph>{t.apology}</Paragraph>
        <Paragraph muted>{t.signoff.split('\n').map((line, i, arr) => (
          <React.Fragment key={i}>
            {line}
            {i < arr.length - 1 && <br />}
          </React.Fragment>
        ))}</Paragraph>
      </CardBody>
    </Layout>
  );
}
