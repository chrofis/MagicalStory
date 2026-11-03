# Competitive Analysis: where we stand, November 2026 (2026-11-03)

> Follows `biz/02-competitive-analysis.md` (March 2026) and `docs/competitive-analysis-2026-07.md` (July 2026).
> Method: one live web-research agent (sources checked 2026-11-03, URLs below) plus one repo agent (git log,
> docs/decisions.md, config files). USD 0 spent. Anything not confirmed from a source says "not verified".
> The repo is 11 months old (first commit 2025-11-23), so "last year" = the whole product history.

## Summary
- **The market changed more than the prices did.** Classic brands are being bought up (Hooray Heroes → Personalized
  Story Group, Oct 2026) and now market themselves as "never AI". Large companies are moving in: **Myposter**
  (German photo printer, ships to DACH) launched an AI photo-plus-name children's book in July 2026, and **Meta StoryKit**
  (a photo-to-storybook app) is being piloted in Mexico.
- **Our July "only us" trial lead has shrunk.** Magic Story, Lullaby.ink and MeinEigenesBüchlein.de now offer a free
  personalised preview without an account. Our trial is still deeper (6 pages, real photo, reading gate, reminders), but
  "nobody else does this" can no longer be claimed.
- **AI-native prices went up**: Lullaby's digital book from $5 to $14.99, LoveToRead's hardcover from $24.99 to $39.99, and
  MyStoryBot to $29-115/mo. Our CHF 29-37 for a book of up to 30 pages, plus CHF 10 shipping, is now mid-market rather than
  premium. There is room above.
- **Our Swiss position is uncontested.** No AI rival found offers Swiss German or real local places. The only Swiss
  competitor, Librio, is template-based, prints in the EU, and markets "no AI". The Swiss publishing trade organised
  against AI children's books (protest letters over the Swisscom campaign, 2025-07).
- **Weak spot: none of the 10 upgrades recommended in July has been finished.** Effort went into the text pipeline,
  trial, print layouts and vouchers instead. The upgrade that would close the visible gap with competitors, a premium
  layflat book (Lullaby now sells one), was not started.

## Scoreboard: July → November

| # | Feature | July | Nov | What changed since July |
|---|---|---|---|---|
| 1 | Photo → avatars | 🟡 | 🟡 | One Grok Imagine 2.0 call per sheet (16 s, $0.04, 17/18 sheets acceptable). Gemini 3.x was never re-tested (memory verdict: Gemini stays off, Grok is cheaper). No likeness gate (the ArcFace gate is built but off). No fallback when Grok refuses a photo (failed prod story 2026-11-02). |
| 2 | Story gen + critique | ✅ | ✅ | Beats pipeline, Jev decision layer, Sonnet 5.5 arc, Haiku 5.5 audits, Gemini 3.1 Pro lector, Opus book audit. No before/after quality score on record. |
| 3 | Visual Bible consistency | ✅ | ✅ | State cells, kept-garment gate, element budget per page. Open: scale drift, cast dropped from pictures (gull rerun). |
| 4 | Eval + auto-repair | ✅ | ✅ | Median-of-judges severity, an extra round for CRITICAL findings, a book audit per round. A single Opus whole-book review is on staging only (one story: 8/8 defects at $0.20 vs ~3/8 at $1.15). |
| 5 | Surgical face repair | ✅ | ✅ | Hardened (blur, absent-character refusal, CRITICAL only); still MobileSAM, SAM 3.1 not adopted. |
| 6 | Colour normalisation | ✅ | ⚪ off | Switched off 2026-10-08 (~10 attempts, 0 useful). It no longer counts as a feature. |
| 7 | Text overlay | ✅ | ✅ | Cover titles are now painted into the art. Print uses a Grok-outpainted strip, and long text goes on white under the picture (05e8fff9c, 2026-11-02). **That conflicts with the owner's 2026-10-27 rule "never text on white"**, so it needs an owner check. |
| 8 | Swiss landmarks | ✅ | ✅+ | Fame ranking, 2,567 photos judged worldwide, the Art Director cites the photo, Jev picks landmarks. Still no live fetch for places that aren't indexed. |
| 9 | Print pipeline | 🟡 | 🟡 | Better commerce: vouchers, square mini book, preview before paying, Gelato resubmit. **Still no layflat/premium tier**, CH-only shipping, no multi-copy discount. Lullaby now sells layflat, and Childbook added print. |
| 10 | Instant trial | ✅ | 🟡→✅ | Our trial got much better (reading gate, reminders, age-fit topics, per-step funnel; 50% conversion after completion, 4/8). But three rivals now offer a free no-account preview, so it is no longer unique. |

## July's 10 recommended upgrades: status
| # | Upgrade | Status |
|---|---|---|
| 1 | Re-test Gemini 3.x for avatars | ❌ not done. Went Grok 2.0 instead (cost); memory verdict "Gemini stays off" |
| 2 | Layflat premium tier | ❌ not done; product moved to square mini + A4 main instead |
| 3 | Persistent watermarked trial share link | 🟡 partly: reading gate, sign-in, reminders; no watermark or public share link |
| 4 | On-demand landmark acquisition | 🟡 offline batch only, no live fetch at story time |
| 5 | SAM 3.1 masks | ❌ not done (MobileSAM default) |
| 6 | Local illuminant estimation | ❌ moot: the colour fix itself is off |
| 7 | Judge-disagreement gate | 🟡 second opinions added; on staging, superseded by the single Opus review |
| 8 | Embedding identity score | 🟡 built (ArcFace), off by default (memory contention with GroundingDINO) |
| 9 | Typographic art direction | 🟡 customer-editable cover type; no interior typography |
| 10 | Text judge as prod gate + marketing | ❌ not done (merged into T9(b)) |

## Competitors: what changed
**Classic / template**
- **Wonderbly**: $34.99-39.99 (unchanged). Trustpilot 4.5 from 91,302 reviews (82K+ in March). Now says "never AI". (wonderbly.com, trustpilot)
- **Hooray Heroes**: **acquired** by Personalized Story Group, reported 2026-10-07; the site stresses "produced by talented humans". Trustpilot 4.3 / 7,493. (pulse2.com, hoorayheroes.com)
- **Librio (CH)**: from €34.99; the Globi book at Ex Libris dropped from CHF 49.90 to 44.90. Now "printed in the EU", 2-3 days production. New titles for grandparents, weddings and couples. Trustpilot 4.8 / 851. 15% Famigros discount. 27 languages and dialects incl. Swiss German and Romansh, no AI. (librio.com, exlibris.ch, famigros)
- **I See Me!**: $29.99-34.99, now with UK/IE/AU/FR/CA stores. Trustpilot 4.7 / 1,800. **Framily**: no news; price not verified.

**AI-native**
- **Lullaby.ink**: digital $14.99 (was $5), print from $29.99 (was $25), up to 4 characters, **softcover/hardcover/layflat**, free preview without a card, English only. (lullaby.ink/pricing)
- **LoveToRead.ai**: dropped credits; $14.99 digital, $39.99 hardcover (was $24.99). (lovetoread.ai)
- **Magic Story**: $44.99 hardcover ($24.99 with subscription), **free preview with no account**, now ships CA/UK/MX, iOS app. Trustpilot 4.6 / 503. (magicstory.com)
- **Childbook.ai**: $19/29/99 per month; **now prints** (Premium includes a $20/mo softcover credit); Canva app. (childbook.ai)
- **MyStoryBot**: $29/39/69-115 per month (was $5.99-39). **ToonyStory**: $9.99/19.99 per month, a QR code in the book links to a video version, 19-21 languages, iOS app.
- **Oscar Stories (AT/DE)**: 10 languages incl. DE/FR/IT; pricing pages 404, so the July $59.99 layflat claim is not verified.
- **Possibly gone** (unreachable or bad certificates on 2026-11-03, not confirmed): MagicTales, StoryBird.ai, CreateBookAI, Storywizard.ai (pivoted to schools).

**New entrants**
- **Myposter KI-Kinderbuch** (DACH, launched 2026-07-09): photo plus name, consistent faces, printed. Price and languages not found. **The closest new rival in our region; watch it.** (Myposter company update on indeed.com, kita.de)
- **MeinEigenesBüchlein.de** (German-language, NL company): up to 5 photos, 21×21 cm hardcover for €29.99 plus shipping, full free preview. Switzerland shipping not stated.
- A long tail of English photo-to-hardcover apps from 2026 (Little Hero Book, Storique, Noli, Amanbook, Lumora, Wondybook), with no independent reviews.
- No Swiss AI-book startup found.

**Platforms**
- **Meta StoryKit**: iPhone pilot (2026-07-21, Mexico, 18+). A photo becomes a character; output is a story, narration, music and a PDF. No print.
- **OpenAI**: gpt-image-2 / ChatGPT Images 2.0 (2026-04), better likeness preservation; no storybook product.
- **Google Gemini Storybook**: unchanged (10 pages, 45+ languages, experimental); the engine underneath is now Nano Banana Pro.
- No platform prints and ships a book yet. **Amazon/Canva/Apple**: nothing first-party.

## Where to push next (for the owner to decide, ranked)
1. **Premium layflat/hardcover tier.** This is the one gap that two rivals visibly fill and our price ladder lacks. AI-native prices
   rose, so a CHF 59-69 tier is plausible. Needs a Gelato SKU check first.
2. **Lead with "AI done carefully, in Swiss German, with your real places".** The no-AI brands leave this open, and Myposter has not
   shown Swiss German or local places (not verified). Use only claims we can source; the "only AI platform with Swiss
   German" line in comparisonData.ts is still unsourced (Marketing inbox item 7).
3. **A fallback model when Grok refuses a photo for the avatar.** It is the one failure that loses a story outright. NOTE: the
   NO-FALLBACKS rule means this would be an owner decision and a decisions.md entry, not a quiet second path.
4. **Shareable trial result** (July #3, the half not built), now that free previews are common elsewhere.
5. **Fix the facts on our own site first** (FAQ A4 / "8+" styles, privacy processors, refund terms). Rivals with Trustpilot scores of 4.3-4.8 set the trust bar.
6. **Watch Myposter**: price, languages, CH shipping. Re-check in this review's next round.
