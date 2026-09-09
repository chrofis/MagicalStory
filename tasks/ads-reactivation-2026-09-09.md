# Ads reactivation prep — 2026-09-09

Owner decision 2026-09-09: do all four prep streams before reactivating Search-Deutschschweiz-v1.
Keyword `kinderbuch selbst gestalten` is KEPT (best converter) and gets its own ad group — B1 in
`tasks/ads-quality-score.md` is superseded.

- [x] (audit done, writes pending owner OK) S1. Ads account audit (read-only): current assets per type, QS + 3 components per keyword,
      ad-group/keyword map, RSA headline counts. Output → `tasks/ads-audit-2026-09-09.md`.
      Then a DRY-RUN apply plan for C2-C4, B2-B4 (incl. the new selbst-gestalten group). No writes
      without owner OK.
- [x] (d67eb7646) S2. Patenkind page: Göttikind/Göttibub/Göttimeitli wording in `client/src/constants/giftData.ts`
      + `server/lib/seoMeta.js` (+ SSR prerender if it reads those).
- [x] (5d7d8b93f) S3. Landing page A2-A5: hero keyword match, trust signals above the fold, mobile, render-blocking trim.
- [x] (c3028d793) S4. Trial funnel "Bezahlt" filter: paid bucket honours `gclid`; empty-state copy says "no paid visits".

## Owner decisions 2026-09-09 (evening)
- Master push: NOT yet. Everything above stays on staging.
- Ads writes (all three groups from the audit) are APPROVED IN PRINCIPLE but must NOT be applied
  until the S2/S3/S4 commits are on production. Prepare them as a dry-run-by-default script.
- New `Kinderbuch-Selbst-Gestalten` ad group lands on `/kinderbuch-erstellen`.
- **Target: as many clicks as possible below CHF 0.20, then see what converts.** Cheap volume first,
  conversion attribution via `scripts/ads/attribution-report.js` decides what stays.

- [ ] S5. `scripts/ads/apply-audit-changes.js` — dry-run by default, `--apply` flag, idempotent;
      implements the audit's 11-step list.
- [ ] S6. Cheap-click plan: candidate keywords with planner CPC < CHF 0.20 (age-gift cluster,
      Göttikind, Einschulung, Geschwister) → proposed campaign `Search-Cheap-CH`, max CPC 0.20,
      negatives for the direction traps. Dry-run creation script.
