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
| 31-40      | 42              | 57              |
| 41-50      | 46              | 61              |
| 51-60      | 50              | 65              |
| 61-70      | 54              | 69              |
| 71-80      | 58              | 73              |
| 81-90      | 62              | 77              |
| 91-100     | 66              | 81              |

Gelato manufacturing + shipping costs vary by region. Target print margin: **40-50%**.

Book purchases reward credits: **10 credits per page** (so a 30-page book purchase gives 300 credits back).

Config: Pricing tiers stored in `pricing_tiers` DB table, seeded on first run. Endpoint: `GET /api/pricing`.

## Key Files

| File | What |
|------|------|
| `server/config/credits.js` | Package definitions, credit costs, limits |
| `server/routes/print.js` | Stripe checkout endpoints, pricing API |
| `server.js` | Stripe webhook (credit fulfillment) |
| `client/src/components/common/CreditsModal.tsx` | Package selection UI |
| `client/src/services/storyService.ts` | `createCreditsCheckout()` API call |
| `docs/business-review-2025.md` | Competitive pricing analysis |
