# Ads activation — 4 campaigns, CHF 10/day, one week — 2026-09-21

**Owner mandate:** "activate the google campaigns, try at least 3 different ones. Total spend 10.- a day
for this week to get a bit of signal." Follow-up: make the 4th one a life-challenge topic
("anxiety or getting rid of pacifier or some other life challenge that no one is buying").

## Preconditions

- [x] Prod carries the attribution fix — the 2026-09-09 condition ("apply only AFTER the staging commits
      reach production"). Prod `/api/health` = `bdb6e44e8`; `origin/master:client/src/App.tsx:80` has the
      `captureAttribution()` mount hook; the live bundle contains the UTM capture. Local `master` ref is
      stale at `8f3a3ae9e` — ignore it.
- [x] Google Ads OAuth re-authorised 2026-09-21. `authorize.js` only PRINTS the token, it does not write it —
      the value was moved into `scripts/ads/config.json` by hand. **Worth fixing: the script should offer to
      write it.** Account verified healthy: `customers/6507339241`, status ENABLED, CHF / Europe-Zurich.

## The four arms (CHF 10/day total)

| Campaign | CHF/day | What it tests |
|---|---|---|
| Search-Deutschschweiz-v1 (exists, PAUSED) | 3 | high-intent head terms; all 9 account conversions came from here |
| Search-Cheap-Age-CH (to create) | 3 | age-gift cluster at CPC cap 0.20 — most clicks per franc |
| Search-Cheap-Occasion-CH (to create) | 2 | Göttikind / Einschulung / Geschwisterkind, mostly unbid tails |
| Search-LifeChallenge-CH (to create) | 2 | life-challenge topics — measured 2026-08-26 as volume with ZERO bid estimates |

Max CPC CHF 0.20 on the three cheap arms (owner choice). Deutschschweiz keeps its existing caps
(Geschenk 0.95, other two groups 1.20).

## Work done this session

- [x] `scripts/ads/lib/search-campaign.js` — engine extracted verbatim from `create-search-cheap.js`
      so the cheap campaigns are three specs over one engine, not three copies that drift.
- [x] `scripts/ads/create-search-cheap.js` — now `--set=age|occasion|both`, two specs at CHF 3 / CHF 2,
      separate `utm_campaign` values (`cheap-age-ch`, `cheap-occasion-ch`) so attribution-report.js
      can tell the arms apart. Dry-run still the default. Validation passes for both specs.
- [x] `scripts/ads/activate-week.js` — single place that sets all four budgets and flips status.
      Refuses to run if the arm budgets do not sum to `TOTAL_CAP` (10.00), so the cap cannot drift.
      `--pause --apply` is the exact reverse.
- [x] Landing pages verified live on prod (HTTP 200, German titles):
      `/themes/life-challenges/{no-pacifier, first-kindergarten, anxiety-worrying, managing-emotions,
      whining, sibling-fighting, potty-training, going-to-bed, dealing-bully}`.

## Keyword Planner, measured 2026-09-21 (raw rows: `tasks/ads-lifechallenge-keywords-2026-09-21/`)

- ✅ **Trotzphase — the thesis holds.** 264 ideas, none bid on. Heads: `autonomiephase` 210/mo,
  `trotzphase` 170, `trotzphase bei kleinkindern` 170, `trotzalter` 30 — low top-of-page bids CHF 0.01–0.12.
- ✅ **Schnuller — best of the four, and it has BUYING intent in the tail.** `nuggi abgewöhnen` 140/mo,
  `schnuller abgewöhnen` 110, plus unbid book-intent rows: `kinderbuch schnuller abgewöhnen`,
  `buch schnuller abgewöhnen`, `buch schnuller weg`, `bücher schnuller abgewöhnen`.
- ✅ **Book-intent across life challenges — the strongest intent in the campaign, all unbid.**
  `kinderbuch über wut` / `kinderbücher über wut` 30/mo each, `kinderbuch emotionen` 20, `bilderbuch wut` 20.
  Became its own ad group (`Buch-Gefuehle`) so topic-intent vs book-intent can be told apart in the report.
- ❌ **Eingewöhnung Kindergarten — DROPPED, it is a direction trap.** The volume is daycare STAFF:
  `eingewöhnungsmodell berliner` 70/mo, `beobachtungsbogen`, `checkliste`, `fortbildung`. Parent-facing rows
  were 10/mo. Not worth an ad group; the staff terms are campaign negatives.
- ⚠️ **Anxiety — thin and contaminated with ADULT/clinical intent.** `angst kind` seeds returned 0 rows
  (planner refuses sentence-shaped seeds); re-probed with noun phrasing per the standing lesson → 48 ideas.
  Usable child-framed slice only ~80/mo. Deliberately NOT bid: `trennungsangst erwachsene`,
  `angst im dunkeln erwachsene`, `angstzustände im dunkeln`, `panische angst im dunkeln`, `schulphobie` —
  we do not put a children's-book ad in front of someone searching panic-attack terms. All are negatives.

## Done 2026-09-21 — ALL FOUR ARE LIVE

- [x] `scripts/ads/create-search-lifechallenge.js` written from the measured list (4 ad groups, 70 keywords).
- [x] Dry-ran all three creates; owner reviewed the life-challenge ad copy before launch.
- [x] `--apply` on all three creates — campaigns landed PAUSED.
- [x] `node scripts/ads/activate-week.js --apply` → all four ENABLED at CHF 10/day, verified from the API:

| Campaign | status | CHF/day | geo | keywords | negatives | ads |
|---|---|---|---|---|---|---|
| Search-Deutschschweiz-v1 | ENABLED | 3 | 19 | 16 | 12 | 3 APPROVED |
| Search-Cheap-Age-CH | ENABLED | 3 | 19 | 81 | 101 | 6 (in review) |
| Search-Cheap-Occasion-CH | ENABLED | 2 | 19 | 43 | 101 | 3 (in review) |
| Search-LifeChallenge-CH | ENABLED | 2 | 19 | 70 | 69 | 4 (in review) |

Deutschschweiz's budget was cut CHF 5 → 3 to fit the CHF 10 cap. Its 3 RSAs were already APPROVED so it
serves immediately; the three new campaigns ramp as Google reviews their ads (~24h).

## Open

- [ ] **`Die Schnullerfee kommt` headline** (Schnuller group). Flagged to the owner as asserting story content
      the generator does not guarantee; owner chose to launch as-is. Revisit if the group underperforms.
- [ ] Mid-week check (~day 3): did the CHF 0.20 arms actually spend their budget, or does the bid bind?
      Owner chose 0.20 knowing this risk. Report, do not silently raise.
- [ ] End of week: `node scripts/ads/attribution-report.js --days=7`.

## Expectation stated to the owner up front

CHF 10/day × 7 = ~CHF 70. At measured CPCs that is ~100–200 clicks; the historical click→trial rate is
~1.2%. So this week buys **CPC and traffic-quality signal, not conversion signal** — expect 0–2 trials.
The Aug-26 decision rule (≥3 completions in one arm) needs ~CHF 150 *per arm*. A zero in one arm this
week is not a verdict on that arm.
