# Ads reactivation prep — 2026-09-09

Owner decision 2026-09-09: do all four prep streams before reactivating Search-Deutschschweiz-v1.
Keyword `kinderbuch selbst gestalten` is KEPT (best converter) and gets its own ad group — B1 in
`tasks/ads-quality-score.md` is superseded.

- [ ] S1. Ads account audit (read-only): current assets per type, QS + 3 components per keyword,
      ad-group/keyword map, RSA headline counts. Output → `tasks/ads-audit-2026-09-09.md`.
      Then a DRY-RUN apply plan for C2-C4, B2-B4 (incl. the new selbst-gestalten group). No writes
      without owner OK.
- [x] (d67eb7646) S2. Patenkind page: Göttikind/Göttibub/Göttimeitli wording in `client/src/constants/giftData.ts`
      + `server/lib/seoMeta.js` (+ SSR prerender if it reads those).
- [ ] S3. Landing page A2-A5: hero keyword match, trust signals above the fold, mobile, render-blocking trim.
- [x] (c3028d793) S4. Trial funnel "Bezahlt" filter: paid bucket honours `gclid`; empty-state copy says "no paid visits".
