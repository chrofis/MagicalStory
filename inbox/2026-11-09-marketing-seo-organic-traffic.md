# SEO: more organic traffic (audit findings to implement)
Status: open (items 2 and 6b done 2026-11-10; 1 waits on owner steps; 3, 4, 5, 7 open, see Result)
From: Marketing, 2026-11-09

Owner asked for an organic-traffic audit of all sites and then said "so do this all" (2026-11-09). Marketing ran a read-only audit (live fetch with a Googlebot user agent + this repo). Technical setup is good: prerendered HTML (`scripts/prerender.mjs`), self-canonicals, 10 hreflang, per-language structured data, sitemap with 1,400 URLs. Plan reference: `tasks/seo-creation-repositioning-2026-08-25.md` (Phase B live, C partly, D not started). Please implement under your own rules and set this file done/blocked per item.

## 1. Measurement (owner steps, please prepare and tell him exactly what to run)
- `node scripts/seo/report.js` fails with `invalid_grant`: Search Console refresh token is dead; re-mint with `scripts/seo/get-refresh-token.js` (needs the owner's Google login).
- Bing Webmaster / IndexNow owner steps still open (`tasks/BACKLOG.md:2369`). A Bing `site:magicalstory.ch` fetch showed no results (one bot fetch, hint only). ChatGPT is the #1 trial source and draws on Bing (`docs/seo-indexnow.md:3`).

## 2. "vs" description bug on list pages (small fix)
`/vergleich/beste-ki-kinderbuch-generatoren` (best URL by impressions, ~position 7 FR) has the meta description "Magical Story vs Beste KI-Generatoren"; DE "Beste Kinderbücher" too. Cause: `buildComparisonDescription` (`server/lib/seoMeta.js:1513`) applies the vs-template to list pages (names at `seoMeta.js:584-585`). Also add FAQPage/ItemList structured data to `/vergleich` pages (BreadcrumbList only today).

## 3. Christmas before December
`/anlass/weihnachten` and `/anlass/nikolaus` have ~330 words incl. navigation. Add real content and an order-by date for Christmas delivery (planned in `biz/06-seo-geo-strategy.md:178`; only a date you can confirm). Separate them from `/geschenk/weihnachtsgeschenk` and `/geschenk/nikolausgeschenk` (same intent).

## 4. Reviews and mentions (Phase D, main ranking limit)
Head terms sat at position 38-52, ~10 clicks/month (Aug 2026, repositioning doc A1/A2/A6: "a link problem"). Trustpilot: 1 review, 3.7 (`tasks/chatgpt-mentions-2026-10-08.md:11`) although `biz/13-review-platforms.md` lists automatic invitations as done: find out why none arrive. For outreach to moms.de, familie.de, papaseite.de, Mamalicious and a Product Hunt launch: prepare the facts/offer (free book) and send the pitch texts to Marketing's inbox; Marketing writes and sends outbound mail after owner OK.

## 5. Missing comparison pages (Phase C1)
Buchkraft, myposter KI-Kinderbuch, a FR comparison (data in `comparisonData.ts` plus server copy in `seoMeta.js`, BACKLOG:1155). Facts only from sourced competitor info.

## 6. Owner decisions to ask (do not decide yourselves)
- Homepage title "Magical Story – Dein Kind als Held seiner eigenen Geschichte" lacks "personalisiertes Kinderbuch"; no recorded decision found. "Kinderbuch mit Namen / mit Foto" has no own page.
- `/geschenk/fuer-kinder` and `/geschenk/einzigartiges-geschenk` share one title (left as owner call, decisions.md 2026-10-07).
- Contradiction: `biz/13` says Google Business Profile active and its review link is in a shipped email; the mentions plan says not eligible (online-only), do not create one.

## 7. Guides on parenting topics (medium effort)
Owner's Keyword Planner check CH 2026-08-26 (decisions.md ~line 47550): Trotzphase 210 / cluster 3,610, Schnuller abgewöhnen 110 / 1,720, Eingewöhnung Kindergarten 70 / 1,350 per month. Unsourced volumes in `biz/06` were not used.

Source: Marketing audit 2026-11-09; file paths from this repo.

## Result (MagicalStory, 2026-11-10)
- 1 Measurement: owner steps named to the owner 2026-11-10: run `node scripts/seo/get-refresh-token.js`, resubmit `https://magicalstory.ch/sitemap.xml` and remove the www sitemap in Search Console, then the IndexNow/Bing steps (BACKLOG:2369). Waiting on the owner.
- 2 "vs" description: done in 4e097de02 (list pages get their own description; French colon fixed in 13f388f68). FAQPage/ItemList structured data on /vergleich: NOT done, open.
- 3 Christmas content: open.
- 4 Reviews/outreach: open (no pitch texts prepared yet).
- 5 Comparison pages: open.
- 6 Owner decisions: homepage title, owner says keep (2026-11-09). The two gift pages that shared a title now have distinct titles (owner approved the small-defects batch, 4e097de02). Google Business Profile contradiction: not asked yet.
- Also done (from our own audit, same day): grammatical theme titles with "MagicalStory.ch" (4e097de02), real per-set sitemap lastmod (4e097de02), /try noindex and out of the sitemap (4e097de02), the sitemap lists only the German URL of templated theme/city/occasion/gift pages, 1,396 -> 634 URLs (3721cd634). All on staging; production after the owner's OK.
