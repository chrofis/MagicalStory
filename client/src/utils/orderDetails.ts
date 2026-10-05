// Order-success dialog lines. The server withholds the customer / shipping fields unless the
// bearer token belongs to the order's user (expired token, other browser), so every field is
// optional and a missing one is omitted, never printed as "undefined".

export interface OrderDetailFields {
  amount_total?: number | null;
  customer_name?: string | null;
  customer_email?: string | null;
  shipping_name?: string | null;
  shipping_address_line1?: string | null;
  shipping_postal_code?: string | null;
  shipping_city?: string | null;
  shipping_country?: string | null;
}

const LABELS: Record<string, { customer: string; amount: string; tokens: string; shipTo: string }> = {
  en: { customer: 'Customer', amount: 'Amount', tokens: 'Credits earned', shipTo: 'Shipping to' },
  de: { customer: 'Kunde', amount: 'Betrag', tokens: 'Credits erhalten', shipTo: 'Versand an' },
  fr: { customer: 'Client', amount: 'Montant', tokens: 'Crédits gagnés', shipTo: 'Expédié à' },
  it: { customer: 'Cliente', amount: 'Importo', tokens: 'Crediti ricevuti', shipTo: 'Spedizione a' },
};

const present = (v: unknown): v is string | number => v !== undefined && v !== null && String(v).trim() !== '';

export function buildOrderDetailLines(order: OrderDetailFields, language: string, tokensCredited = 0): string[] {
  const l = LABELS[language] || LABELS.en;
  const lines: string[] = [];
  if (present(order.customer_name)) lines.push(`${l.customer}: ${order.customer_name}`);
  if (present(order.customer_email)) lines.push(`Email: ${order.customer_email}`);
  if (typeof order.amount_total === 'number') lines.push(`${l.amount}: CHF ${(order.amount_total / 100).toFixed(2)}`);
  if (tokensCredited > 0) lines.push(`${l.tokens}: ${tokensCredited}`);
  if (present(order.shipping_name)) lines.push(`${l.shipTo}: ${order.shipping_name}`);
  if (present(order.shipping_address_line1)) lines.push(`${order.shipping_address_line1}`);
  const cityLine = [order.shipping_postal_code, order.shipping_city].filter(present).join(' ');
  if (cityLine) lines.push(cityLine);
  if (present(order.shipping_country)) lines.push(`${order.shipping_country}`);
  return lines;
}
