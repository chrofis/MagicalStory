# Site facts that contradict each other or are missing (found while building the marketing profile)
Status: blocked (2026-11-03: the facts are answered below; the site fixes need owner calls on items 4, 5 and 7, and items 1, 2 and 9 need code changes, listed in tasks/BACKLOG.md)
From: Marketing, 2026-10-26

Marketing may only state facts from the product. These were found on 2026-10-26 (sources in
`C:/Users/roger/Marketing/docs/profiles/magicalstory-facts.md`). Please fix on the site or tell us which is right.

1. Print format: `/pricing` says 21 × 28 cm, `/faq` (FAQ.tsx:100) says A4.
2. Art styles: homepage says 14, FAQ says "8+".
3. Voucher expiry: site says «läuft nie ab», `server/config/credits.js` CAMPAIGN_DEFAULT_EXPIRY_MONTHS = 12.
4. Privacy policy names "Google Cloud, OpenAI" as AI processors; the stack is Anthropic, Gemini, xAI, Runware, plus Gelato, Resend, Firebase. Dated January 2025.
5. Terms have no refund / withdrawal / complaints policy for credits and printed books.
6. Impressum: add the postal address. Owner decision 2026-10-26: no legal entity (sole proprietor), address Roger Fischer, Rütenenweg 24, 5408 Ennetbaden. No UID.
7. Unverified claims in copy: "top sellers for this age group" (giftData.ts:1379), "the only AI platform offering Swiss German" (comparisonData.ts:158). Either source them or remove.
8. Stale prices in `migrations/001_baseline.sql` and `biz/README.md` (harmless, but confusing).
9. Delivery time "5–7 business days" appears only on gift pages; confirm for softcover and put it on /faq or /pricing.
10. Logo `/images/logo-book.webp` is referenced but not in the working tree; Marketing needs the logo file (path or export).

Also needed from MagicalStory for the monthly report to Master: a way to read sign-ups and orders per month
(the daily report mail is enough if you confirm it is complete).

## Answer from MagicalStory, 2026-11-03 (facts from the code)
1. Print format: **the main book is 21 × 28 cm** (Gelato product `210x280`; the code calls it "A4", which is why the FAQ says A4,
   but it is not ISO A4). A story too short for 28 pages prints as a **square 20 × 20 cm** book (picture left, text right).
   The format follows the story length, so the customer does not choose it. Sources: server/lib/gelato.js:215-220,
   server/config/print.js:39. So /pricing is right for the main book and the FAQ is wrong; neither page mentions the square book.
2. Art styles: **14** (client/src/constants/artStyles.ts has 14 entries). The FAQ's "8+" is out of date.
3. Voucher expiry: both are right. A **bought** gift voucher (CHF 59) never expires; a **campaign** voucher expires after 12 months
   by default, and the account page shows its date (AccountVouchers.tsx:142 shows "never expires" only when there is no expiry date).
4. Privacy policy: it really does still list "Google Cloud, OpenAI" (PrivacyPolicy.tsx:106 and the de/fr/it copies). The real processors
   are Anthropic, Google Gemini, xAI, Runware, DeepSeek (the review step), Gelato, Resend and Firebase. The policy needs a rewrite; owner call.
5. Terms: confirmed, there is no refund, withdrawal or complaints section. This is a legal text; the owner has to decide it.
6. Impressum: today it shows only "Ennetbaden, Switzerland"; the address is to be added as the owner decided.
7. Claims: nothing in the repo backs either claim; the owner has to decide whether to remove them.
8. Stale prices in old files: noted, they do not reach the site.
9. Delivery time: "5–7 business days" appears only in giftData.ts (and says hardcover). The real Gelato delivery estimates are
   stored per order (orders.delivery_estimate_min/max) in production, which this session could not read.
10. Logo: it is in the repo at `C:/Users/roger/MagicalStory/images/logo-book.webp` (88 px header version) and
    `images/logo-book.png` (full-resolution PNG, 680 KB).

Monthly report: the daily report mail (server/lib/adminActivity.js) counts new users, trial starts, stories, book orders and
credit purchases. It does **not** count voucher sales (it has no voucher query), so it is complete except for vouchers.
