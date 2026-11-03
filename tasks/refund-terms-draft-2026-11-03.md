# Draft: refund and complaints section for the Terms (for owner review, 2026-11-03)

Status: DRAFT, not on the site. Owner decision 2026-11-03: "I draft, you review". Once approved it goes in
`client/src/pages/TermsOfService.tsx` as a new section after "3. Description of Service" (the sections after it
renumber), in all four languages.

What the draft is based on (facts from the code, nothing promised that the system does not do):
- A story that fails during generation gets its credits back automatically (server.js:2421-2455, `settleJobWithRefund`).
- Credits are bought in packs and are not tied to an expiry (server/config/credits.js:29-32); campaign vouchers
  expire after 12 months (credits.js:67), bought gift vouchers do not.
- Books are personalised and printed to order by Gelato, shipped to Switzerland only (server/config/print.js:43).
- Background, not legal advice: Swiss law has no general right to withdraw from an online purchase, and personalised
  goods are excluded from the EU withdrawal right too. So the section offers a voluntary goodwill rule.

**Owner decisions inside the draft** (marked ⚠): the 14-day window for unused credits, and the 30-day window for print complaints.
Change any number before it goes live.

---

## English

**4. Refunds, Cancellations and Complaints**

**Credits.** Credits are a prepaid balance for creating stories. ⚠ You can ask for a refund of credits you bought and have not
used yet within 14 days of the purchase; write to us and we refund them to your original payment method. Credits that have
been used for a story, and free credits (welcome credits, promotions, vouchers you received), are not refundable.

**Failed stories.** If a story cannot be completed because of a technical problem on our side, the credits for it are returned
to your account automatically.

**Printed books.** Every book is personalised and printed to order, so it cannot be cancelled or returned once it has been sent
to print. Please check the preview carefully before ordering. ⚠ If your book arrives damaged, misprinted, or not matching the
preview you approved, tell us within 30 days of delivery, with a photo of the problem. We reprint and send it again free of
charge, or refund the book if a reprint is not possible.

**Vouchers.** A gift voucher you bought does not expire. Promotional vouchers show their expiry date in your account.
Vouchers cannot be exchanged for cash.

**Complaints.** Send any complaint to the contact address in section 18 (Contact). We answer within 5 working days.

## Deutsch

**4. Rückerstattung, Stornierung und Reklamationen**

**Credits.** Credits sind ein vorausbezahltes Guthaben zum Erstellen von Geschichten. ⚠ Gekaufte, noch nicht verwendete Credits
erstatten wir auf Anfrage innerhalb von 14 Tagen nach dem Kauf auf das ursprüngliche Zahlungsmittel zurück. Bereits für eine
Geschichte verwendete Credits sowie geschenkte Credits (Willkommens-Credits, Aktionen, erhaltene Gutscheine) werden nicht erstattet.

**Fehlgeschlagene Geschichten.** Kann eine Geschichte wegen eines technischen Problems auf unserer Seite nicht fertiggestellt
werden, erhältst du die Credits automatisch auf dein Konto zurück.

**Gedruckte Bücher.** Jedes Buch wird persönlich gestaltet und auf Bestellung gedruckt. Sobald es in den Druck gegangen ist, kann
es nicht storniert oder zurückgegeben werden. Bitte prüfe die Vorschau vor der Bestellung sorgfältig. ⚠ Kommt dein Buch beschädigt,
fehlerhaft gedruckt oder anders als die freigegebene Vorschau an, melde dich innerhalb von 30 Tagen nach Erhalt mit einem Foto des
Problems. Wir drucken und senden es kostenlos neu oder erstatten den Buchpreis, wenn ein Neudruck nicht möglich ist.

**Gutscheine.** Ein gekaufter Geschenkgutschein läuft nicht ab. Aktionsgutscheine zeigen ihr Ablaufdatum in deinem Konto.
Gutscheine können nicht in Bargeld umgetauscht werden.

**Reklamationen.** Reklamationen bitte an die Kontaktadresse in Abschnitt 18 (Kontakt). Wir antworten innerhalb von 5 Arbeitstagen.

(French and Italian are translated from the approved version.)
