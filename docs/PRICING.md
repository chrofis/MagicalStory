# Pricing & Cost Structure

**Last updated**: April 2026

## Credit Packages

Users purchase credits in fixed packages via Stripe (CHF):

| Package   | Credits | Price    | Per Credit |
|-----------|---------|----------|------------|
| Starter   | 300     | CHF 5.-  | CHF 0.017  |
| Popular   | 700     | CHF 10.- | CHF 0.014  |
| Best Value| 1,500   | CHF 20.- | CHF 0.013  |
| Pro       | 4,000   | CHF 50.- | CHF 0.013  |

New users receive **500 free credits** on signup (~1-2 stories).

Config: `server/config/credits.js` → `CREDIT_CONFIG.PRICING.PACKAGES`

## Credit Costs Per Operation

| Operation              | Credits | Notes |
|------------------------|---------|-------|
| Story page             | 10      | Text generation + image generation |
| Image regeneration     | 5       | Re-roll a single scene image |
| Cover regeneration     | 5       | Re-roll a cover image |

Config: `server/config/credits.js` → `CREDIT_CONFIG.COSTS`

### Story Examples

| Story Size | Pages | Credits | Cheapest Package |
|------------|-------|---------|------------------|
| Short      | 10    | 100     | 300 for CHF 5    |
| Medium     | 20    | 200     | 300 for CHF 5    |
| Standard   | 30    | 300     | 300 for CHF 5    |
| Long       | 50    | 500     | 700 for CHF 10   |

## API Cost Breakdown (per story)

Approximate generation costs for a **30-page story with ~15 images**:

| Provider   | Usage                              | Est. Cost   |
|------------|-------------------------------------|-------------|
| Anthropic  | Outline + text + scene descriptions | ~CHF 0.50   |
| Gemini     | Image generation (~15 images)       | ~CHF 1.50   |
| Gemini     | Quality evaluation                  | ~CHF 0.20   |
| Gemini     | Covers (front, back, dedication)    | ~CHF 0.30   |
| **Total**  |                                     | **~CHF 2.50** |

With repair workflow (optional, adds re-evaluations and redos): **~CHF 3-4**.

## Margin Analysis

| Scenario | Revenue | API Cost | Margin |
|----------|---------|----------|--------|
| 30-page story (Starter package) | CHF 5 | ~CHF 2.50 | ~50% |
| 30-page story (Popular package, credits left over) | CHF 10 | ~CHF 2.50 | >50% |
| 50-page story (Popular package) | CHF 10 | ~CHF 4 | ~60% |
| Heavy repair (30-page + full workflow) | CHF 5 | ~CHF 3.50 | ~30% |

**Target margin: ~50%** on the smallest package (Starter). Larger packages give better per-credit rates to the user but also benefit from volume (users generate multiple stories, not all 30 pages).

## Book Printing (Physical)

Print orders go through Gelato. Prices charged to users (April 2026):

| Seiten | Softcover<br>21 × 28 cm | Hardcover<br>21 × 28 cm |
|--------|------------------------:|------------------------:|
| 1-30   | CHF 29.- | CHF 37.- |
| 31-40  | CHF 35.- | CHF 43.- |
| 41-50  | CHF 41.- | CHF 49.- |
| 51-60  | CHF 47.- | CHF 55.- |
| 61-70  | CHF 52.- | CHF 60.- |
| 71-80  | CHF 58.- | CHF 66.- |
| 81-90  | CHF 64.- | CHF 72.- |
| 91-100 | CHF 69.- | CHF 77.- |

**Pricing model:**
- Softcover anchored at CHF 29 for 30p, scaling linearly to CHF 69 at 100p
- Hardcover = Softcover + flat CHF 8 across all tiers
- Margin scales from CHF 12 (soft 30p) up to CHF 25 (soft/hard 100p)
- Shipping: separate flat CHF 10 line at checkout
- Promo budget: CHF 10 discount keeps every tier profitable

Config: Pricing tiers stored in `pricing_tiers` DB table, seeded on first run. Endpoint: `GET /api/pricing`.

### Credit Reward on Book Purchase

Book purchases reward credits: **10 credits/page x 2 (double promo) = 20 credits/page**.

The promo multiplier is configurable via admin (`token_promo_multiplier` in `config` table, currently 2x).

Credit value at best rate: CHF 50 / 4000 credits = **CHF 0.0125/credit**.

| Pages | Credits Back (2x) | Credit Value (CHF) | Softcover Price | Net Effective Price |
|-------|-------------------|-------------------|-----------------|---------------------|
| 30    | 600               | 7.50              | 29              | 21.50               |
| 40    | 800               | 10.00             | 35              | 25.00               |
| 50    | 1000              | 12.50             | 41              | 28.50               |
| 60    | 1200              | 15.00             | 47              | 32.00               |
| 70    | 1400              | 17.50             | 52              | 34.50               |
| 80    | 1600              | 20.00             | 58              | 38.00               |
| 90    | 1800              | 22.50             | 64              | 41.50               |
| 100   | 2000              | 25.00             | 69              | 44.00               |

### Gelato Cost Breakdown (Switzerland, April 2026)

Gelato charges us per book (manufacturing only, CHF). Shipping is a separate
CHF 10 line item charged to the customer at checkout. AI cost is assumed at
CHF 0.20/page for the high-quality model with ~5 images per page.

| Pages | Gelato Soft | Gelato Hard | AI cost | Soft total | Hard total | Soft retail | Hard retail | Soft margin | Hard margin |
|------:|------------:|------------:|--------:|-----------:|-----------:|------------:|------------:|------------:|------------:|
| 30  | 11.08 | 14.44 | 6.00  | 17.08 | 20.44 | 29 | 37 | 11.92 | 16.56 |
| 40  | 12.86 | 16.88 | 8.00  | 20.86 | 24.88 | 35 | 43 | 14.14 | 18.12 |
| 50  | 14.63 | 19.32 | 10.00 | 24.63 | 29.32 | 41 | 49 | 16.37 | 19.68 |
| 60  | 16.41 | 21.76 | 12.00 | 28.41 | 33.76 | 47 | 55 | 18.59 | 21.24 |
| 70  | 18.18 | 24.21 | 14.00 | 32.18 | 38.21 | 52 | 60 | 19.82 | 21.79 |
| 80  | 19.96 | 26.64 | 16.00 | 35.96 | 42.64 | 58 | 66 | 22.04 | 23.36 |
| 90  | 21.73 | 29.10 | 18.00 | 39.73 | 47.10 | 64 | 72 | 24.27 | 24.90 |
| 100 | 23.51 | 31.53 | 20.00 | 43.51 | 51.53 | 69 | 77 | 25.49 | 25.47 |

**Margin model**: linear 12 → 25 (soft) and 16 → 25 (hard). Hardcover is a flat CHF 8 above softcover.

**Promo budget**: A CHF 10 discount keeps even the smallest tier profitable —
soft 30p still earns CHF 1.92, hard 30p still earns CHF 6.56.

Source: Gelato CHF prices for `photobooks-softcover/hardcover_pf_210x280-mm-8x11-inch`, April 2026.

## Key Files

| File | What |
|------|------|
| `server/config/credits.js` | Package definitions, credit costs, limits |
| `server/routes/print.js` | Stripe checkout endpoints, pricing API |
| `server.js` | Stripe webhook (credit fulfillment) |
| `client/src/components/common/CreditsModal.tsx` | Package selection UI |
| `client/src/services/storyService.ts` | `createCreditsCheckout()` API call |
| `docs/business-review-2025.md` | Competitive pricing analysis |
