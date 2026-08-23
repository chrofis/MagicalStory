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

This works because **staging and production share the same R2 bucket**
(`magicalstory-images` / `images.magicalstory.ch`). No image bytes ever move:
prod image URLs resolve on staging, and images generated on staging are already
in the bucket prod reads from.

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

## What moves, and what must not

| Moves back to prod | Never moves |
|---|---|
| `stories.data`, `.metadata`, `.image_version_meta` | `user_id` |
| `story_images` rows | `share_token`, `is_shared` |
| | `created_at` |

Ownership and the user's existing share link must survive the promotion.

## Traps

**`promote` UPDATES, it never CREATES.** A story invented on staging cannot be
handed to a user this way — there is no prod row to update, and inventing one
means deciding ownership, credits and share state. Different problem, ask first.

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
- Assuming images need copying → they never do, the bucket is shared
