import * as React from 'react';
import { Text } from '@react-email/components';
import { Layout } from '../components/Layout';
import { CardBody, Paragraph, InfoPanel } from '../components/CardBody';
import { colors, fonts } from '../theme';
import { footer, orderFailed, Lang } from '../i18n';

interface Props {
  lang: Lang;
}

/**
 * Order-failed email. Apology-first tone. No CTA — the team handles the
 * resolution, the customer just needs reassurance they don't have to act.
 */
export default function OrderFailed({ lang }: Props) {
  const t = orderFailed[lang];
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
            {t.reassurance}
          </Text>
        </InfoPanel>
        <Paragraph>{t.questions}</Paragraph>
        <Paragraph muted>{t.signoff}</Paragraph>
      </CardBody>
    </Layout>
  );
}
