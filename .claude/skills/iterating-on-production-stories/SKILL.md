---
name: iterating-on-production-stories
description: Use when a real user's story or characters came out badly and need fixing — pulling production data to staging to rerun and repair, then giving the improved version back to that user
---

# Iterating on Production Stories

## Overview

A user's story is disappointing. You need to fix it *for them* — not for the next
story. Fixing it in production means deploying to prod on every attempt, which
kills in-flight generations and makes iteration impossible.

**Pull it to staging, iterate freely, promote it back when it's actually good.**

Staging and production have **separate R2 buckets** (`images-staging.magicalstory.ch`
vs `images.magicalstory.ch`). The pull copies no bytes: prod image URLs are public and
resolve on staging. Images made on staging land in the staging bucket, and the promote
copies each one to the production bucket and rewrites its URL. The promote needs the
production service's R2 credentials (`railway variables --service MagicalStory
--environment production`); a stale local secret fails the upload before any DB write.

## The loop

```bash
node scripts/admin/copy-story-to-staging.js <storyId>      # pull
# …fix prompts/code, rerun stages on staging, repeat as often as you like…
node scripts/admin/promote-story-to-prod.js <storyId> --dry-run
node scripts/admin/promote-story-to-prod.js <storyId> --yes   # give it back
```

The pull brings `stories` + `story_images` + the owner's `characters` row, and
stamps a provenance hash. Iterate with the Test Lab or the regeneration
endpoints against the staging `storyId` — no deploy needed for prompt/data fixes.
Code fixes still need a staging deploy, which is cheap.

## Two more modes (same script)

```bash
# Give the user the fixed version as a SEPARATE new book (the original stays untouched).
# Free: no credits, no job row, so no email; not shared; created_at = now; same title.
node scripts/admin/promote-story-to-prod.js <stagingStoryId> --as-new --user=<prodUserId> --dry-run
node scripts/admin/promote-story-to-prod.js <stagingStoryId> --as-new --user=<prodUserId> --yes

# Put a story back EXACTLY as a promote backup captured it (undo an in-place promote).
node scripts/admin/promote-story-to-prod.js <storyId> --restore-from=backups/story-promotions/<storyId>-<ts>.json --dry-run
node scripts/admin/promote-story-to-prod.js <storyId> --restore-from=backups/story-promotions/<storyId>-<ts>.json --yes
```

`--as-new` mints a fresh id and copies EVERY image the story references under the new id
(`stories/<newId>/...`), including production-bucket ones: story delete prunes R2 by that prefix,
so two stories must never share objects. It refuses a user that does not exist. Listing needs
nothing else (a story with no `story_jobs` row lists as finished). `--restore-from` keeps
`user_id`, `share_token`, `is_shared`, `created_at`, backs up the current row first, writes in
one transaction and refuses a backup that mentions the staging bucket. `--target=staging` runs
either mode against the staging DB/bucket (R2_* env must be staging's) to exercise the tooling.
**Prefer `--as-new` over an in-place promote when the user already has a book they may want back.**
An in-place promote overwrites objects at the same key, so a restore cannot bring those bytes back.

## What moves, and what must not

| Moves back to prod | Never moves |
|---|---|
| `stories.data`, `.metadata`, `.image_version_meta` | `user_id` |
| `story_images` rows | `share_token`, `is_shared` |
| | `created_at` |

Ownership and the user's existing share link must survive the promotion.

## Traps

**Default `promote` UPDATES, it never CREATES.** To hand a user a story as a new book use
`--as-new` (above); that is a deliberate owner-approved choice about ownership and share state, not a default.

**Provenance guard is not bureaucracy.** If the user (or a repair job) touched
the story in prod after your pull, promoting silently discards their change. The
tool refuses — even with `--yes`. Only override with `--force` when you have
actually looked at what changed.

**Orders mean a printed book exists.** Changing images under an ordered story
leaves the customer's physical copy not matching their online one. `--force`
required, and it should be a real decision.

**Never `--force` to make a refusal go away.** Each guard corresponds to
destroying something a user can see. Read the message, then decide.

## Verify before you promote

Look at the actual pages on staging — the point of the loop is that the story is
good, not that the pipeline ran. `--dry-run` first: it reports image counts and
provenance without writing. A backup of the prod row lands in
`backups/story-promotions/` before any write, and the write is one transaction,
so a half-promoted story is never visible.

## Red flags

- Deploying to production to test a story fix → use this loop instead
- Passing `--force` without reading what the guard said
- Promoting without opening the story on staging first
- Copying images by hand → the promote copies staging-bucket images and rewrites the URLs
