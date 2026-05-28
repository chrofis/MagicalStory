import * as React from 'react';
import { Layout } from '../components/Layout';
import { CardBody, Paragraph } from '../components/CardBody';
import { Button } from '../components/Button';
import { footer, passwordReset, Lang } from '../i18n';

interface Props {
  lang: Lang;
}

/**
 * Password-reset email. Same shape as email-verification — single CTA,
 * expiration note, ignore-line. Body copy differs but layout is identical.
 */
export default function PasswordReset({ lang }: Props) {
  const t = passwordReset[lang];
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
          <Button href="{resetUrl}">{t.cta}</Button>
        </div>
        <Paragraph muted>{t.expires}</Paragraph>
        <Paragraph muted>{t.ignoreLine}</Paragraph>
      </CardBody>
    </Layout>
  );
}
