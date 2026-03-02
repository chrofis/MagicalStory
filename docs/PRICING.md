# Pricing & Cost Structure

**Last updated**: March 2026

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

Print orders go through Gelato. Prices charged to users:

| Page Range | Softcover (CHF) | Hardcover (CHF) |
|------------|-----------------|-----------------|
| 1-30       | 38              | 53              |
| 31-40      | 45              | 60              |
| 41-50      | 51              | 66              |
| 51-60      | 57              | 72              |
| 61-70      | 63              | 78              |
| 71-80      | 69              | 84              |
| 81-90      | 75              | 90              |
| 91-100     | 81              | 96              |

Config: Pricing tiers stored in `pricing_tiers` DB table, seeded on first run. Endpoint: `GET /api/pricing`.

### Credit Reward on Book Purchase

Book purchases reward credits: **10 credits/page x 2 (double promo) = 20 credits/page**.

The promo multiplier is configurable via admin (`token_promo_multiplier` in `config` table, currently 2x).

Credit value at best rate: CHF 50 / 4000 credits = **CHF 0.0125/credit**.

| Pages | Credits Back (2x) | Credit Value (CHF) | Softcover Price | Net Effective Price |
|-------|-------------------|-------------------|-----------------|---------------------|
| 30    | 600               | 7.50              | 38              | 30.50               |
| 40    | 800               | 10.00             | 45              | 35.00               |
| 50    | 1000              | 12.50             | 51              | 38.50               |
| 60    | 1200              | 15.00             | 57              | 42.00               |
| 70    | 1400              | 17.50             | 63              | 45.50               |
| 80    | 1600              | 20.00             | 69              | 49.00               |
| 90    | 1800              | 22.50             | 75              | 52.50               |
| 100   | 2000              | 25.00             | 81              | 56.00               |

The credit reward effectively subsidizes the book price by ~CHF 7.50-25, encouraging repeat story generation.

### Gelato Cost Breakdown (Switzerland, March 2026)

Our prices include Gelato manufacturing, ~CHF 10 shipping (Swiss Post Economy), and 8% Swiss VAT.

| Pages | Gelato Soft | Gelato Hard | + Ship + Tax | Our Soft | Our Hard | Soft Margin | Hard Margin |
|-------|------------|------------|--------------|----------|----------|-------------|-------------|
| 30    | 10.86      | 14.32      | 22.53 / 26.27 | 38     | 53       | 41%         | 50%         |
| 40    | 12.47      | 16.16      | 24.27 / 28.25 | 45     | 60       | 46%         | 53%         |
| 50    | 14.07      | 17.98      | 26.00 / 30.22 | 51     | 66       | 49%         | 54%         |
| 60    | 15.68      | 19.81      | 27.74 / 32.20 | 57     | 72       | 51%         | 55%         |
| 70    | 17.30      | 21.65      | 29.48 / 34.18 | 63     | 78       | 53%         | 56%         |
| 80    | 18.91      | 23.47      | 31.22 / 36.15 | 69     | 84       | 55%         | 57%         |
| 90    | 20.51      | 25.31      | 32.95 / 38.13 | 75     | 90       | 56%         | 58%         |
| 100   | 22.12      | 27.14      | 34.69 / 40.11 | 81     | 96       | 57%         | 58%         |

**Margin range: 41-58%** before credit reward. After accounting for the credit reward value, the effective margin on softcovers drops to ~21-38%.

Source: Gelato Product Prices API (`/v3/products/{uid}/prices?country=CH&currency=CHF`), queried March 2026. Shipping ~CHF 8.50-10 (Swiss Post Economy, varies by weight).

## Key Files

| File | What |
|------|------|
| `server/config/credits.js` | Package definitions, credit costs, limits |
| `server/routes/print.js` | Stripe checkout endpoints, pricing API |
| `server.js` | Stripe webhook (credit fulfillment) |
| `client/src/components/common/CreditsModal.tsx` | Package selection UI |
| `client/src/services/storyService.ts` | `createCreditsCheckout()` API call |
| `docs/business-review-2025.md` | Competitive pricing analysis |
