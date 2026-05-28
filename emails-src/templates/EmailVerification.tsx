import * as React from 'react';
import { Layout } from '../components/Layout';
import { CardBody, Paragraph } from '../components/CardBody';
import { Button } from '../components/Button';
import { footer, emailVerification, Lang } from '../i18n';

interface Props {
  lang: Lang;
}

/**
 * Email-verification email. Single, focused action: confirm the address.
 * Short body, big CTA, fine-print expiration + "ignore if not you" line.
 */
export default function EmailVerification({ lang }: Props) {
  const t = emailVerification[lang];
  const f = footer[lang];
  return (
    <Layout
      lang={lang}
      preview={t.preview}
      footerTagline={f.tagline}
      footerCountry={f.country}
    >
      <CardBody headline={t.headline}>
        <Paragraph>{t.body}</Paragraph>
        <div style={{ textAlign: 'center', margin: '8px 0 24px' }}>
          <Button href="{verifyUrl}">{t.cta}</Button>
        </div>
        <Paragraph muted>{t.expires}</Paragraph>
        <Paragraph muted>{t.ignoreLine}</Paragraph>
      </CardBody>
    </Layout>
  );
}
