# Google Ads — Quality Score & Ad Rank Improvement Plan

**Ad Rank = Bid × Quality Score × Assets impact.** So there are levers on all three,
not just Quality Score. Goal: win more of the ~2,336 auctions/week currently lost to
rank (only ~1% is lost to budget — budget is fine).

Campaign: `Search-Deutschschweiz-v1` (only active campaign).
Diagnosis: Ad relevance & Expected CTR mostly Above/Average ✅ — **Landing Page
Experience is BELOW average on every keyword** (the weak component).

## Already done ✅
- Bid raised 0.80 → 1.20 CHF
- Negatives: kostenlos, selber basteln, ausmalbuch, wimmelbuch (+ competitor brands)
- Ads repointed `/try` → homepage
- Business logo (gold book) + business name assets created — under review
- Homepage LCP 9.2s → 1.9s fix — **on staging, not yet on master**

---

## A. Landing Page Experience  (the weak QS component)
- [x] (2026-09-06, a51316ad7 + 0d3fb7efd) A1. Ship the LCP fix to production — both commits are
      present on `origin/master` for `client/index.html`.
- [x] (e42752e6e hero subhead, on master; 2026-09-09 meta description aligned) A2. Above-the-fold:
      "personalisiertes Kinderbuch" in the hero subhead directly under the H1 + in the homepage
      meta/og description (`server/lib/seoMeta.js` '/', `client/index.html`).
- [x] (2026-09-09; price "ab CHF 29" since e42752e6e) A3. Trust row under the hero CTA:
      Stripe payment, printed+shipped in CH, Impressum, Datenschutz (`LandingPage.tsx`).
      Reviews/testimonials still open — no real reviews collected yet (never fabricate).
- [x] (2026-09-09) A4. Mobile UX: hero CTA is 60px tall; login + trust links got min-h 44px;
      no consent banner/interstitial exists (Consent Mode defaults granted, CH-only); body text
      is 18px on mobile.
- [x] (2026-09-09) A5. Render-blocking audit: gtag.js already async, fonts async (preload+swap),
      homepage critical CSS inlined by beasties (c29f3b867), module bundle deferred. Only change:
      `<meta charset>`/viewport moved to the top of `<head>` (was past the 1024-byte boundary).
- [ ] A6. Re-measure after each change: `node tests/manual/measure-lcp.js https://magicalstory.ch/`
      (Moto G4 + Slow-4G, prints LCP element + FCP/LCP) + PageSpeed Insights / CrUX.

## B. Ad Relevance
- [ ] B1. Pause `kinderbuch selbst gestalten` (BELOW ad relevance — DIY intent, doesn't
      match a done-for-you product).
- [ ] B2. Per ad group, ensure ≥2 headlines contain that group's keyword theme
      (e.g. "Personalisiertes Kinderbuch", "Bilderbuch mit eigenem Kind",
      "Kinderbuch als Geschenk").
- [ ] B3. Tighten ad groups to one tight theme each; move any off-theme keyword to the
      group that matches it.
- [ ] B4. Add keyword-mirroring RSA headlines where a group lacks them.

## C. Expected CTR + Ad Assets  (also a direct Ad Rank lever)
- [ ] C1. Audit current assets (sitelinks, callouts, structured snippets, images,
      promotions, calls).
- [ ] C2. Sitelinks — add 4–6 (e.g. So funktioniert's · Beispiele ansehen · Preise ·
      Für jeden Anlass · Gratis Testgeschichte).
- [ ] C3. Callouts — add 6–8 (Gedruckt in der Schweiz · In 3 Minuten fertig · Foto rein,
      Buch raus · Persönliche Geschichte · Sichere Zahlung · Schweizer Städte & Sagen).
- [ ] C4. Structured snippets — e.g. Header "Themen": Mut, Freundschaft, Einschulung,
      Geschwister, Schlafenszeit…
- [ ] C5. Promotion asset if there's an offer (e.g. gratis Testgeschichte).
- [ ] C6. Image assets on the search ad (book/story imagery).
- [ ] C7. Business logo + name — confirm they clear review; check advertiser identity
      verification (gates the logo actually showing).
- [ ] C8. RSA hygiene — 15 headlines / 4 descriptions per ad, minimal pinning, let
      Google optimise the combinations.

## D. Measurement / Follow-up
- [ ] D1. Weekly: log QS per keyword + the three component buckets.
- [ ] D2. Track impression share ↑ / lost-to-rank ↓ as QS + assets improve.
- [ ] D3. Re-check advertiser verification status (blocks logo display).

## E. Upstream blocker (bigger than QS)
- [x] (2026-09-06, e37e3194a) E1. Confirm the GA4 conversion event actually fires — **CONFIRMED.**
      `client/src/utils/gtagConversion.ts` defines 3 Ads conversions, wired in `TrialWizard.tsx`
      and `TrialGenerationPage.tsx`; `docs/decisions.md:1500` records a conversion-goal decision
      taken ON real conversion data; e37e3194a fixed the consent default that was discarding
      attribution.

---

### Suggested order (fast + high-impact first)
1. **C1–C8 ad assets** — quick, no dev, effect is NOT delayed 2 weeks (immediate CTR + Ad Rank).
2. **B1 pause DIY keyword** — 1 minute, removes a QS drag.
3. **A1 ship LCP fix to prod** — the big landing-page win (QS effect lags ~2 weeks).
4. **A2–A5 homepage content/trust/speed** — the rest of landing-page experience.
5. **E1 GA4 conversion check** — do in parallel; nothing else matters if conversions aren't tracked.
