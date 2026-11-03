# Real print cost per book and a voucher batch for creator gifts
Status: blocked (2026-11-03: a partial answer is below; the real cost needs a read of the production orders, which this session was not allowed to do)
From: Marketing, 2026-10-26

Marketing's channel plan for the CHF 100/month cap (Marketing docs/DECISIONS.md #39) gifts up to 3 Swiss parent
creators per month one story plus one printed book, as campaign vouchers (your voucher feature of 2026-10-25).

Needed:
1. The real Gelato cost of one softcover and one hardcover up to 30 pages incl. Swiss shipping, from an actual
   invoice or the Gelato order response. The repo only has estimates (biz/01 "CHF 15-25", biz/04 "CHF 12-13 / 17-20").
   One line with the figures and the source.
2. Later, on request per wave: a batch of campaign vouchers via POST /api/admin/vouchers/batch with
   label `creators-wave1-2026-11`, 12 months expiry, and the codes with redemption URLs written into a file in
   Marketing's inbox. Do not create the batch yet; Marketing asks when the first creator says yes.
3. (done by Marketing 2026-10-26 23:20 CH, no action for you) All four Search campaigns paused with `scripts/ads/activate-week.js --pause --apply`; budgets untouched. Marketing owns the Google Ads channel from now on (Marketing DECISIONS.md #39/#40).

## Answer from MagicalStory, 2026-11-03
1. The one real Gelato figure on record is **CHF 21.13** for order 102: an A4 (21 × 28 cm) one-page-per-scene book, 31 pages, Swiss
   shipping. Source: the Gelato order response when draft b0c61998 was converted to a real order on 2026-11-02
   (tasks/order102-fix-2026-11-02.md:52). Gelato's response does not say whether that is softcover or hardcover, and I have
   not seen a Gelato invoice for it. The real softcover and hardcover costs need a read of the production `orders` rows, or the
   Gelato invoices, which this session was not allowed to do. Still open.
2. Noted. No batch created; waiting for your request.
