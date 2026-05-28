import * as React from 'react';
import { Text } from '@react-email/components';
import { Layout } from '../components/Layout';
import { CardBody, Paragraph, InfoPanel } from '../components/CardBody';
import { Button } from '../components/Button';
import { Cover } from '../components/Cover';
import { Cond } from '../components/Cond';
import { colors, fonts } from '../theme';
import { footer, orderShipped, Lang } from '../i18n';

interface Props {
  lang: Lang;
}

/**
 * Order-shipped email. Tracking info panel + CTA to the carrier. Includes
 * an optional cover hero when the caller provides it, and closes with a
 * review prompt the customer can act on once the book arrives.
 */
export default function OrderShipped({ lang }: Props) {
  const t = orderShipped[lang];
  const f = footer[lang];

  const labelStyle: React.CSSProperties = {
    fontFamily: fonts.sans,
    color: colors.muted,
    fontSize: '12px',
    lineHeight: '18px',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    margin: '0',
  };
  const valueStyle: React.CSSProperties = {
    fontFamily: fonts.sans,
    color: colors.body,
    fontSize: '14px',
    lineHeight: '22px',
    margin: '0 0 12px',
  };

  return (
    <Layout
      lang={lang}
      preview={t.preview}
      footerTagline={f.tagline}
      footerCountry={f.country}
    >
      <Cond when="coverUrl">
        <Cover src="{coverUrl}" alt="{title}" size="thumbnail" />
      </Cond>
      <CardBody headline={t.headline}>
        <Paragraph>{t.greeting}</Paragraph>
        <Paragraph>{t.body}</Paragraph>
        <InfoPanel>
          <Text
            style={{
              fontFamily: fonts.serif,
              color: colors.headline,
              fontSize: '16px',
              lineHeight: '22px',
              fontWeight: 600,
              margin: '0 0 12px',
            }}
          >
            {t.trackingTitle}
          </Text>
          <Text style={labelStyle}>{t.labelOrderId}</Text>
          <Text style={valueStyle}>{'{orderId}'}</Text>
          <Text style={labelStyle}>{t.labelTracking}</Text>
          <Text style={{ ...valueStyle, margin: '0' }}>{'{trackingNumber}'}</Text>
        </InfoPanel>
        <div style={{ textAlign: 'center', margin: '8px 0 24px' }}>
          <Button href="{trackingUrl}">{t.cta}</Button>
        </div>
        <Paragraph>{t.closing}</Paragraph>
        <Paragraph muted>{t.reviewPrompt}</Paragraph>
        <Paragraph muted>{t.signoff}</Paragraph>
      </CardBody>
    </Layout>
  );
}
