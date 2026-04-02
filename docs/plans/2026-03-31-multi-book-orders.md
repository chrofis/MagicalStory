# Multi-Book Orders (Cart System)

## Problem

Currently each book purchase creates a separate Gelato order with its own shipping cost (~CHF 5-7). Customers who want multiple copies (gifts, siblings) pay shipping per book. Competitor magischeskinderbuch.de offers free shipping for 2+ books.

## Goal

Allow customers to order multiple books in a single Gelato order, sharing shipping costs. This reduces effective per-book cost and incentivizes larger orders.

## Scope

### Phase 1: Quantity Selector (simplest)
- Add quantity selector (1-5) on the order/checkout page for the current story
- Same story, multiple copies → single Gelato order with `quantity: N`
- Shipping cost shared across copies
- Discount: e.g. 10% off for 2+, 15% off for 3+

### Phase 2: Multi-Story Cart
- Cart that collects multiple different stories
- "Add to Cart" button instead of immediate checkout
- Cart page showing all books with quantities
- Single Gelato order with multiple items (different PDFs, shared shipping)
- Requires: cart state (localStorage or DB), cart UI, modified checkout flow

### Phase 3: Gift Bundles
- Pre-configured bundles (e.g. "Sibling Pack" = 2 stories, "Family Pack" = 3)
- Bundle pricing with built-in discount
- Marketing angle for gift occasions

## Technical Details

### Gelato API
- Already supports `quantity > 1` per item
- Supports multiple items per order (different products/PDFs)
- Shipping calculated per order, not per item
- No code change needed on API side — just pass higher quantity or multiple items

### Current Flow
```
User clicks "Order" → Stripe checkout → Webhook → Create Gelato order (qty: 1)
```

### Phase 1 Flow
```
User selects qty (1-5) → Price updates → Stripe checkout (qty × price) → Webhook → Gelato order (qty: N)
```

### Phase 2 Flow
```
User adds stories to cart → Cart page → Stripe checkout (total) → Webhook → Single Gelato order (multiple items)
```

## Files to Modify

### Phase 1 (Quantity Only)
- `client/src/pages/StoryWizard.tsx` — add quantity selector to order section
- `server/routes/print.js` — pass quantity to Gelato, calculate multi-copy pricing
- `server/lib/gelato.js` — already supports quantity, just needs to receive it
- Stripe: adjust line item quantity/price

### Phase 2 (Full Cart)
- New: `client/src/context/CartContext.tsx` — cart state management
- New: `client/src/pages/Cart.tsx` — cart page
- `server/routes/print.js` — handle multi-item orders
- `server/lib/gelato.js` — build multi-item order payload
- DB: cart table or localStorage approach

## Recommendation

Start with Phase 1 — it's a 1-day change and covers the most common case (grandparents ordering 2-3 copies of the same book). Phase 2 is a bigger project for later.
