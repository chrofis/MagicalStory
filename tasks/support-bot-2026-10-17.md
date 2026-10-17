# Support bot: short trial books printed mostly blank (2026-10-17)

## Case that started it
Order #100 (2026-10-15): a 6-page trial story printed as the 30-page minimum hardcover, 23 blank
pages. CHF 47 paid. At that time production only showed a passive warning (7a777c796); the required
acknowledgement checkbox (f8940c187) was built 2026-10-17 and is not on master. Shipped 2026-10-16.

## Owner decisions (2026-10-17, AskUserQuestion)
- **Remedy for this case type:** credits for a full story (top up to 250 = 25 pages) + the new book
  printed and shipped free. Applies to orders placed before the acknowledgement checkbox is live.
- **Bot autonomy:** drafts only. The bot finds cases, fills the email from DB facts, lists it in the
  daily digest as a draft; it is sent only after the owner approves.

## Guiding principles
1. Facts come from the database, never guessed. Missing fact (balance, child name, tracking,
   language) = no email, case listed as "needs owner" in the digest.
2. Fixed per-language templates with typed slots; the offer comes from a typed policy constant.
   No LLM writes customer copy at send time.
3. Customer's language, Swiss style: formal address, Swiss guillemets, ss not ß, no dashes,
   gender-neutral greeting.
4. Honest: say what they will hold in their hands, own our part, never blame the customer, never
   spin a defect into a feature.
5. The remedy costs the customer no effort: no new photos, one step, a human to reply to.
6. Service mail, not marketing: no upsell, no review request. Brand chrome only (logo footer).
7. Send as soon as detected, ideally before delivery; the text must stay true either way.
8. Owner approval before send; dedupe per order; every case (draft / sent / blocked + reason) in
   the daily digest.
9. Every case is evidence for the root-cause fix at checkout.

## Reviews done
Round 1 (marketing, finance, customer, engineering, parallel) on v1, round 2 (all four lenses) on
v2. Final text v3 previewed to the owner (branded layout). Corrections that came out of review:
customer confirmed nothing (no checkbox in prod); max story 25 pages, a 25-page book still has
4 blank pages; no voucher mechanism for a free print (owner fulfils via admin order); subject was
marketing-sounding; no delivery-date promise.

## Build plan
- [ ] Send the order #100 email once its credits are confirmed >= 250 (balance read blocked in
      session; owner tops up or allows the read) and the owner approves the final text.
- [ ] `emails-src/templates/SupportShortTrialBook.tsx` + i18n copy (en/de/fr/it), built by
      `npm run build:emails`; layout = card + logo footer, no headline/cover.
- [ ] `email.js` `sendSupportShortTrialBookEmail()` via `sendTracked` with
      `email_type='support-short-trial-book'`, from/reply-to roger@magicalstory.ch.
- [ ] Detection: orders joined to stories with `trialMode`, page info from
      `computeBookPageInfo` (`server/lib/gelato.js:159`), ordered before the checkbox went live.
- [ ] Draft queue + owner approval (admin), dedupe per order (migration: unique claim per
      email_type + order id, claimed before send).
- [ ] Daily digest section (`server/lib/adminActivity.js` feed + `email.js` sendAdminDailySummary):
      drafts waiting, sent, blocked with reason.
- [ ] Unit tests for detection + fact-gating; functional test rendering all four languages.
- [ ] Root cause (separate owner decision): checkout lets a trial story print mostly blank.
      Engineering review proposes blocking checkout above ~30% blank pages and offering
      "extend this story" / "combine stories" (`client/src/pages/BookBuilder.tsx:402`,
      `server/routes/print.js:1645`, sibling `server/lib/gelato.js:366`). Also: put f8940c187 on
      master so no new cases accrue.
