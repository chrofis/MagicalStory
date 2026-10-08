# Blogger & Influencer Outreach: Christmas 2026 seeding

Revised 2026-10-08. Earlier version (March 2026) is in git history. Handles, follower counts and contacts below were
seen on the cited pages on 2026-10-08. Instagram itself could not be opened by the research tool, so **open each
profile by hand before writing** (still active? kids 2-8? current bio email?).

## Why this channel now
- Paid Google, 14 days to 2026-10-08: CHF 22.68, 33 clicks, 0 trials (`scripts/ads/attribution-report.js --days=14`).
- Competitor pattern that already worked on these exact creators: Librio gifted books to MINT & MALVE (2022,
  "(Werbung/Verlosung)", code MINTUNDMALVE20, giveaway) and Mamalicious (2018, 2020, code MAMAWIMMEL10), timed for
  November/Christmas.
- Personalised books are a Christmas gift: books must reach creators early enough for posts in the second half of
  November.

## The offer (uses what exists, no new code)
1. **Credits for one full story** made by the creator in their own account with their own photos (they control
   their child's images). Admin sets credits: `POST /api/admin/users/:userId/quota` (`server/routes/admin/users.js:119`).
2. **One printed hardcover shipped to them**, paid by us (no free-print mechanism exists; order it via admin
   impersonation, or refund their order).
3. **Their own referral code** from the account page (format `Magic<Name><3 digits>`, `server/lib/referral.js`):
   followers get CHF 10 off a first order, the creator earns CHF 10 per buyer (`server/config/credits.js` REFERRAL).
   That is the commission; no extra fee in wave 1.
4. Optional for top fits: a giveaway (second book) run on their account.

**Ceiling cost per creator:** hardcover up to 30 pages CHF 37 + CHF 10 shipping at retail (`client/src/utils/bookPricing.ts`);
actual print cost is lower. Wave 1 (12 creators) <= ~CHF 560 retail, plus CHF 10 per resulting buyer.

## Rules (legal-requirements R-30/R-31/R-33/R-34 in the Marketing repo)
- Every post labelled "Werbung" (or "Anzeige") + the platform's paid-partnership toggle; a free book is payment in
  kind (SLK B.15). Say this in the first email, not as an afterthought.
- Keep proof: post URL + screenshot, date, label used (tracking sheet below).
- We never repost a creator's child's face without their written OK for that use.
- Say openly that the illustrations are made with AI.
- Address parents and gift buyers, never children ("sag deinen Eltern..." style copy is banned).

## Wave 1: send first (Deutschschweiz, kids roughly 2-8, contact route known)

| # | Who | Handle / site | Size (source, date) | Why | Contact |
|---|---|---|---|---|---|
| 1 | MINT & MALVE (Eliane) | @mintundmalve, mintundmalve.ch | IG 9,300+ (own media kit, Nov 2022) | Children's book blog, active Oct 2026, did Librio before | eliane@mintundmalve.ch ([mediakit](https://www.mintundmalve.ch/mediakit)) |
| 2 | Mamalicious | @mamaliciousworld, mamalicious.ch | IG 13k ([Modash](https://www.modash.io/find-influencers/switzerland/mom), 21.09.2026) | Reviewed Librio twice, runs giveaways | hello@mamalicious.ch |
| 3 | Mama Rocks | @mamarocks_ch (IG + TikTok), mamarocks.ch | unknown | "Mama testet" product tests, labels partnerships | info@mamarocks.ch ([Kooperationen](https://mamarocks.ch/kooperationen/)) |
| 4 | Juana Fiedler | @juana.fiedler | 23.2k (Modash mom) | Boys 7 and 5, does UGC | swissfitmommylife@gmail.com (bio) |
| 5 | Mona Shkele | @mona.shkele | 20.9k (Modash mom), 57.6% CH audience | Mum of 3 | mona.shkele@gmail.com (bio) |
| 6 | Simon Aemmer (dad) | @simonaemmer | 7.5k ([Modash family](https://www.modash.io/find-influencers/switzerland/family), 22.09.2026) | Swiss German dad, "Reels für Brands" | aemmersimon@hotmail.com (bio) |
| 7 | Dedee | @dedesmomlife | 10.6k, engagement 9.8% (Modash mom) | High engagement | justcallmededee@gmx.ch (bio) |
| 8 | Die Angelones (Rita) | @die_angelones, dieangelones.ch | IG 5,173, FB 14,208 (own page, Jan 2024) | Kids are teens: ask her as **network hub** (Schweizer Familienblogs, 59 members), not for her own kids | rita@dieangelones.ch ([Werbung & PR](https://www.dieangelones.ch/werbung-und-pr/)) |
| 9 | Phoebe | @itsphoebely | 25.1k (Modash family) | Two girls | DM |
| 10 | Eli Simic | @eli_simic | 14.2k, 75.9% CH audience (Modash mom) | Single mum | DM |
| 11 | Bärner Mamis | TikTok @baernermamis, IG baernermamis | TikTok 10,100 ([House of Influence](https://www.house-of-influence.ch/post/staff-choice-die-besten-family-influencer-der-schweiz)); IG 99.8K ([HypeAuditor](https://hypeauditor.com/de/top-instagram-family-switzerland/)) | Bern, four mums, Swiss German | DM (IG handle unconfirmed) |
| 12 | Mamas Unplugged | mamasunplugged.ch | unknown | Group blog, active Sep 2026 | mail@mamasunplugged.ch |

## Wave 2 / reserve
- **Deutschschweiz:** @fabzerzuben 43.6K (HypeAuditor), @busy_kids_switzerland 70.7K (HypeAuditor), @carameliita 3,750
  (HoI), @yvipinto 17.3k but 75% DE audience (Modash), @jesca.li 5.4k (baby, too young now), Family First
  (info (at) familyfirst.ch; "sehr reduzierte Anzahl an Kooperationen", or a paid listing from CHF 169/yr,
  [familyfirst.ch/werbung](https://familyfirst.ch/werbung/)).
- **English (expats):** @swiss.mom.life 30.8k (Modash), The Family of 5 (@familyof5.swiss, thefamilyof5.com, contact page),
  @serafimagermann 15.3k (serafima.germann@gmail.com), @mama.on.board 8.4k Basel (kasia.mama.on.board@gmail.com),
  Swiss Family Fun (swissfamilyfun.com).
- **French:** @isaline_ackermann 32,500 (HoI), @yo_obrist 25.7k (Modash, already runs affiliate codes),
  @mengojuice 22.4k (Modash), @byselo_ 16,000 (HoI).
- **Italian:** @chiara_berti83 8,400 (HoI), @asinochileggeancora 20.8K (HypeAuditor, book angle unconfirmed).
- **Too big for wave 1:** @valeriaharris__, @saraleutenegger 140.9K, @mrs_smoothies 147.7k.

## Dropped from the March list
- Mini & Stil: last post 25.11.2019 ("Blogpause").
- MOMof4: last post 11.12.2024 (dormant).
- Chez Mama Poule and schweizerfamilienblogs.ch: domains did not answer on 2026-10-08; recheck by hand.

## Agencies (if wave 1 is too slow)
- influencer-finden.ch (House of Influence): curated creator list from CHF 790, has a filter by children's age.
  hoi@influencer-finden.ch.
- House of Influence, Zürich: ran Migros' Toniebox campaign with 9 family creators. hoi@houseofinfluence.ch.
- Influee (influee.co): UGC videos "ab CHF 47"; such videos could also run in our own ads.
- Kingfluencers, Zürich: no family focus or prices published.

## Email (German, personalise the first line every time)

```
Betreff: Ein Buch, in dem [Kind] die Hauptfigur ist – Weihnachts-Kooperation (Werbung)

Hallo [Name]

Ich bin Roger und habe MagicalStory.ch gebaut: Eltern laden Fotos ihres Kindes hoch,
wählen ein Thema oder ihre Stadt, und es entsteht ein illustriertes Bilderbuch mit
dem Kind als Held – mit echten Schweizer Schauplätzen. Die Bilder entstehen mit KI.

[Ein Satz zu einem konkreten Beitrag von dir.]

Mein Angebot vor Weihnachten:
- Du erstellst kostenlos eine ganze Geschichte für [Kind] (ich schalte die Credits frei,
  deine Fotos bleiben in deinem Konto).
- Ich schicke dir das Buch gedruckt als Hardcover nach Hause.
- Du bekommst deinen eigenen Code: deine Follower erhalten CHF 10 Rabatt auf ihr erstes
  Buch, und du erhältst CHF 10 für jedes Buch, das damit bestellt wird.

Wenn es euch gefällt, freue ich mich über einen ehrlichen Post oder Reel in der zweiten
Novemberhälfte, gekennzeichnet als «Werbung». Wenn nicht, ist das auch ok – das Buch
gehört euch.

Hättest du Lust? Dann schicke ich dir den Zugang.

Herzliche Grüsse
Roger
www.magicalstory.ch
```

Follow up once after 7 days, then stop. For EN/FR creators translate the same text; keep "Werbung" / "#ad" / "publicité".

## Timeline
- Week of 2026-10-12: check profiles by hand, send wave 1 (12 emails/DMs).
- 2026-10-19: one follow-up; send wave 2 to fill up to ~12 yes answers.
- By end of October: credits granted, stories made, books ordered.
- Second half of November: posts go live.
- December: count codes, decide on paid repeats with the creators who sold.

## Tracking (one row per creator)
creator · contacted (date, channel) · answer · account user id · referral code · credits granted · book order id ·
shipped · post URL + screenshot · label used · date live · buyers with code (`referral_events`) · revenue
