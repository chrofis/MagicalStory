import * as React from 'react';
import { Text } from '@react-email/components';
import { Layout } from '../components/Layout';
import { CardBody, Paragraph, InfoPanel } from '../components/CardBody';
import { Cover } from '../components/Cover';
import { Cond } from '../components/Cond';
import { colors, fonts } from '../theme';
import { footer, orderConfirmation, Lang } from '../i18n';

interface Props {
  lang: Lang;
}

/**
 * Order-confirmation email. Layout: optional cover hero → headline + body →
 * order-details info panel (id, amount, shipping address, delivery estimate)
 * → follow-up note → signoff. No CTA: customer takes no action here, they
 * just wait for the shipped email.
 */
export default function OrderConfirmation({ lang }: Props) {
  const t = orderConfirmation[lang];
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
            {t.detailsTitle}
          </Text>
          <Text style={labelStyle}>{t.labelOrderId}</Text>
          <Text style={valueStyle}>{'{orderId}'}</Text>
          <Text style={labelStyle}>{t.labelAmount}</Text>
          <Text style={valueStyle}>{'{amount} {currency}'}</Text>
          <Text style={labelStyle}>{t.labelShipping}</Text>
          <Text style={{ ...valueStyle, margin: '0 0 12px' }}>
            {'{addressLine1}'}
            <br />
            {'{city}, {postalCode}'}
            <br />
            {'{country}'}
          </Text>
          <Text style={labelStyle}>{t.labelDelivery}</Text>
          <Text style={{ ...valueStyle, margin: '0' }}>{'{deliveryEstimate}'}</Text>
        </InfoPanel>
        <Paragraph>{t.followUp}</Paragraph>
        <Paragraph muted>{t.signoff}</Paragraph>
      </CardBody>
    </Layout>
  );
}
