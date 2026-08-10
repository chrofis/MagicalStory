# Production TODO — admin drafts + persistent showcase accounts

Everything below is **live on staging** and must ship to production together, in
this order. Shipping the code without step 1 breaks story saving outright:
`upsertStory` INSERTs `admin_draft`, and the column does not exist on prod yet.

## 1. Run the migration BEFORE the deploy

```
migrations/015_admin_draft_stories.sql
```

Adds `stories.admin_draft BOOLEAN NOT NULL DEFAULT false` plus two indexes.
Backfill is the DEFAULT: every existing story is published, which is correct.
Applied on staging 2026-08-10 against 119 stories, none of which became drafts.

Verify after running:

```sql
SELECT column_name, column_default, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'stories' AND column_name = 'admin_draft';
SELECT count(*) FILTER (WHERE admin_draft) AS drafts, count(*) AS total FROM stories;
```

Expect `drafts = 0`. Anything else means the default was not applied.

## 2. Deploy the code

Ownership gate, hard-fail rehydrate, draft visibility, admin endpoints:

- `server/routes/jobs.js` — 403 when a requested character id is not on the
  caller's account; `inputData.adminDraft` set from `req.user.impersonating`;
  drafts skip the credit check, the reservation and `credits_reserved`
- `server.js` — job processing hard-fails on any unresolved character id; both
  save paths pass `adminDraft` through
- `server/services/database.js` — `upsertStory` writes `admin_draft` on INSERT only
- `server/routes/stories.js` — owner list + detail filter drafts out
- `server/routes/sharing.js` — share resolver filters drafts (they get a
  `share_token` at insert, so an unpublished draft otherwise has a live link)
- `server/routes/admin.js` — `GET /api/admin/drafts`, `POST /api/admin/stories/:id/publish`, `/unpublish`

## 3. Confirm a prod admin exists for the showcase

`impersonateFamilyAccount()` defaults to `demo-b-hnecf@magicalstory.ch`, which is
an admin **on staging**. Check prod and set `SHOWCASE_ADMIN_EMAIL` /
`SHOWCASE_ADMIN_PASSWORD` if it differs:

```sql
SELECT email FROM users WHERE role = 'admin';
```

The admin must not be the family account itself — nobody can impersonate
themselves, and the orchestrator throws a clear error if they collide.

## 4. First production showcase creates the persistent accounts

`demo-berger@`, `demo-miller@`, `demo-dubois@magicalstory.ch` are created on
first use. Existing prod demo accounts are left alone; nothing migrates old
stories onto them. Expect the first run per family to create characters (photo
upload) and every later run to reuse them.

## Still open (not blocking)

- **No admin UI.** The endpoints exist; there is no drafts screen and no publish
  button. Publishing is a POST for now.
- **Old demo accounts are not consolidated.** Staging had 49; they stay. Only new
  runs land on the persistent accounts.
- **The draft path is unproven end-to-end.** The visibility chain is verified with
  real impersonation tokens against staging, but no full story has yet been
  generated through it — the first showcase run is the real test.
- `tests/demo-story.spec.ts` uses `DEMO_IMPERSONATION_TOKEN` when present and
  falls back to the login form otherwise, so a `--fresh-account` run is unchanged.
