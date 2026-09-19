# GDPR erasure — admin SOP

How to handle a "delete my data" request. The tool is
**`scripts/admin/delete-user-data.js`** — the most destructive script in this repo.

Design notes, the full table list and the FK reasoning: `tasks/gdpr-erasure-2026-09-11.md`.

> **Status (2026-09-12):** admin-run script only, and the privacy policy now says so — it
> describes the email request path (`privacy@magicalstory.ch`, one month) instead of a
> non-existent account setting. A self-serve delete button is a later follow-up
> (`tasks/BACKLOG.md`). All eight design questions were ruled on 2026-09-12; the rulings and
> the limits they accept are in `docs/decisions.md` and
> `tasks/gdpr-erasure-2026-09-11.md` §8.

---

## 1. Receiving a request

A request is valid however it arrives — email to privacy@magicalstory.ch, a reply to any of
our mail, a support message. It does not have to say "GDPR" or "article 17".

**Clock: 30 days** from receipt (GDPR art. 12(3)) to complete it and reply. Start by
acknowledging receipt the same day.

Record in the request thread: **who asked, when, from which address, and which account** they
mean.

---

## 2. Verifying identity

Never erase on an unverified request — the damage is irreversible, and honouring a forged
request is itself a data breach.

**Sufficient:** the request arrives from the address on the account (`users.email`), and that
address is `email_verified = TRUE`.

**Not sufficient on its own:** a request naming an account from a different address, a phone
call, or a message through a third party. In that case send a confirmation link/code to the
address **on the account** and wait for it to be used. Do not accept identity documents — we
have no need for them and asking is itself over-collection.

If the account holder is a child and a parent is asking: the account was created by an adult
(our terms), so treat the registered address as the authority.

---

## 3. Before running: check what is in flight

The script refuses to run and tells you why if:
- a `story_jobs` row for this user is `pending` / `running` — **wait for it to finish**; the
  pipeline would otherwise write rows back after the delete;
- an **unprocessed** `stripe_webhook_retry` row mentions the address — that is a payment not
  yet booked as an order. Triage it at `/api/admin/stripe-webhook-retry`, then re-run. This
  abort is a **decision**, not a default (ruling Q4, 2026-09-12): erasing the row would lose a
  real purchase, so a human resolves it first;
- the configured R2 bucket does not match the target database's image host (see §6).

---

## 4. Dry run — always first

```bash
# staging (default target)
node scripts/admin/delete-user-data.js --email=person@example.com

# production
node scripts/admin/delete-user-data.js --email=person@example.com --production
```

Dry run is the default: **without `--confirm` nothing is ever written.** A `--production` dry
run is read-only and safe.

Read the whole output. Check specifically:
- **§1 Subject** — is this the right account? (one id, the expected username and creation date)
- **§2 Database** — do the counts look like this person's activity?
- **§3 Retention** — how many orders will be *kept*, and the Stripe/Gelato ids you must follow
  up on by hand;
- **§3 Ledgers** — how many `credit_transactions` / `referral_payouts` rows move to the
  sentinel user, and whether the sentinel row already exists;
- **§4 Retention** — as above;
- **§5 Referral** — how many *other people's* rows still carry the erased person's
  name-bearing code. Those rows are **left alone** (ruling Q2/Q3): the count is the accepted
  limit, printed so it stays visible;
- **§6 R2** — an object count, a byte total **and the exact list of keys that would be
  deleted**. **A zero here on an account with stories means something is wrong** — stop and
  investigate. Read the key list: it is the only rehearsal there is (§6 below).

---

## 5. Running the erasure

```bash
node scripts/admin/delete-user-data.js \
  --email=person@example.com \
  --confirm=person@example.com \
  --production \
  --actor=<your admin username>
```

- `--confirm` must carry the address and must match `--email` exactly. Typing it twice is the
  interlock; a bare `--confirm` is refused.
- `--production` is required to touch production. Default is staging.
- `--actor` is recorded on the audit row. Defaults to the OS user.

The database work runs as **one transaction**. R2 deletion happens only after it commits,
then the script re-lists every prefix and fails if a single object survives.

**If it fails:** read the message. A failure before the commit rolled everything back — fix
and re-run. A failure *after* `✓ transaction COMMITTED` means the rows are gone but the images
may not be: do **not** close the request; finish the R2 deletion by hand and note it.

---

## 6. R2 — production only, and it cannot be rehearsed

Staging and production use **different buckets**, and there are **no staging R2 credentials**
— by decision (ruling Q8, 2026-09-12), not by oversight. Consequences, state them plainly:

- **The R2 half of an erasure only ever runs against production.**
- **It can never be rehearsed on staging. The first real erasure is the first real execution
  of that code.** Treat it accordingly: read the output, do not batch two requests.
- To compensate, the dry run prints **every key it would delete**. That list is the review
  step. Read it before typing `--confirm`.

The checked-in `.env` points at production (`images.magicalstory.ch` /
`magicalstory-images`), while staging serves `images-staging.magicalstory.ch`. The script
samples a real image URL from the target database and **aborts on a mismatch** rather than
silently deleting nothing — that guard is what caught this, and it stays. A staging dry run
will therefore stop at §6 with a bucket-mismatch error; that is correct behaviour.

---

## 7. What is NOT erased, and why

The receipt says this too. You must be able to repeat it to the person.

| Kept | Rule |
|---|---|
| `orders` rows — amount, currency, payment status, Stripe session/payment-intent id, Gelato order id, shipping **country**, dates | Swiss **OR art. 958f**: business records and accounting vouchers must be kept **10 years**; the privacy policy states 10 years for payment records. **GDPR art. 17(3)(b)** exempts processing required by law. |
| `credit_transactions` and `referral_payouts` — amounts, balances, types, dates, `order_stripe_session_id`, `stripe_refund_id` | Ruling Q1 (2026-09-12): the credit and commission ledgers are an audit trail and are kept. Both columns are `NOT NULL`, so the rows are reassigned to the sentinel user `gdpr-erased-sentinel` and **scrubbed** of `description` / `reference_id` on the way. The sentinel cannot log in, cannot be emailed, and does not appear in any admin listing or user count. |

**Nothing records when a retained row expires, and no purge job exists** (ruling Q5): these
rows stay indefinitely unless someone deletes them by hand. Tracked in `tasks/BACKLOG.md`.

The person is **unlinked** from those rows: `user_id`, `story_id`, name, email, street address,
city, state, postal code, tracking number and tracking URL are all cleared. What remains cannot
identify them from our side.

Rows belonging to **other people** are never deleted, and since ruling Q2/Q3 (2026-09-12)
they are not rewritten either. Two of them keep the erased person's **name-bearing referral
code** (`Magic<Firstname><NNN>`):

- other users' `users.referred_by` — NULLing it would silently restore their one-code-ever
  entitlement, and a tombstone would still be us editing someone else's row;
- `orders.referral_code_used` on other people's retained orders — part of a financial record
  we must keep intact.

**That is an accepted limit: a first name survives.** The script counts those rows and prints
the count in the dry run and on the receipt, so it is visible at every erasure. If the person
asks, say so honestly.

Where a row records **someone else's** transaction but carried the erased person's *id*
(`referral_events.buyer_user_id`, `referral_payouts.source_user_id`), the id is replaced with
a tombstone: the reference goes, the other person's audit trail stays intact.

---

## 8. Manual follow-ups — the request is not closed until these are done

The script never calls a third-party API. It prints exactly what you must chase:

1. **Stripe** — holds the customer object, email and full billing/shipping address for each
   listed session. Stripe is the record-keeper for the invoice, so this is normally
   *scheduled*, not immediate: note the sessions and delete the customer once the retention
   period expires, or request redaction via Stripe support if the person insists.
2. **Gelato** — holds the recipient's name and address **and the printed book PDF, which
   contains the child's illustrated likeness and first name**. Email Gelato support citing
   each `gelato_order_id` from the receipt and request deletion.
3. **Email provider** — any transactional mail already sent sits in the provider's logs and
   in the recipient's inbox. Nothing to do beyond noting it if asked.
4. **Google Analytics / Google Ads** — pseudonymous client ids only, not linkable to our
   `user_id`. No action.

---

## 9. Replying to the person

Within 30 days of the request, in their language. Say:

- their account and all stories, characters, uploaded photographs and generated images have
  been deleted, and the images removed from our image storage;
- purchase records and the credit/commission ledger entries are kept for **10 years** because
  Swiss accounting law requires it (OR art. 958f), but no longer carry their name, email,
  address or any free-text description;
- if they had a printed book, that our print partner has been asked to delete the order and
  its file;
- the date the erasure was performed.

Do not attach the receipt — it contains internal ids and counts. Summarise it.

---

## 10. The audit trail

One row is written to `logs` with action `GDPR_ERASURE`, carrying the **erased user's id**,
the environment, the operator, the per-table counts and the anonymisation/tombstone counts.

It deliberately records **the fact of the erasure, not the erased data** — no email, no name,
no content. That row is how we evidence compliance, so it must not itself be deleted.

```sql
SELECT username AS operator, details, timestamp
FROM logs WHERE action = 'GDPR_ERASURE' ORDER BY timestamp DESC;
```

---

## 11. Design rulings and the limits they accept

All eight open questions were ruled on **2026-09-12** — `docs/decisions.md` (2026-09-12) and
`tasks/gdpr-erasure-2026-09-11.md` §8. Three limits are **accepted**, not fixed; be able to
state them:

1. **A first name survives** on third parties' `users.referred_by` and
   `orders.referral_code_used`, inside the erased person's referral code (§7).
2. **Retained rows have no expiry.** Nothing stamps a deletion date and no purge job exists,
   so the 10-year clock is not enforced by anything (§7).
3. **The R2 half cannot be rehearsed** — production only, no staging credentials (§6).

## 12. Auditing orphaned R2 objects

A story deleted before an erasure can leave its objects behind: `deleteStoryArtefacts`
(`server/routes/stories.js:3334`) logs failures instead of throwing, so a failed prune is
silent. Those objects are unreachable per-user, so no erasure can find them.

```bash
node scripts/admin/audit-r2-dead-cohorts.js             # the audit — cannot delete, at all
node scripts/admin/audit-r2-dead-cohorts.js --list=200  # more example keys
```

It reports objects, bytes, referenced and unreferenced counts grouped by key prefix and
sub-kind, and writes the same review manifest. Ruling Q7 (2026-09-12) asked for a read-only
audit that "deletes nothing and has no delete mode": that is this **file**, not a mode —
it imports no delete command, constructs no S3 client and has no confirm/production flag, so
deletion is unreachable from it without reading a line of argument parsing. The scan itself is
shared with the deleting tool (`scripts/lib/r2Cohorts.js`) so the cohort rule cannot drift
between them; the guarantee is pinned by `tests/unit/r2-cohort-gc.test.ts`.

`node scripts/admin/delete-r2-dead-cohorts.js --report-only` prints the identical report and
also deletes nothing — a convenience inside the deleting tool, not the Q7 answer.

Note that the audit's old *id-attribution* verdict is
gone — deletion is decided by the COHORT rule only (`docs/r2-storage.md`), after the three
false-positive classes of 2026-09-13. The two earlier scripts (`audit-r2-orphans.js`,
`delete-r2-orphans.js`) were deleted that day.
