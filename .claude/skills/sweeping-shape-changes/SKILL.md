---
name: sweeping-shape-changes
description: Use when renaming a field, changing a data structure or its storage location, changing an LLM output format that parsers consume, or adding/altering database schema (new column, table, migration)
---

# Sweeping Shape Changes

## Overview

~150 historical fix commits are one-crash-at-a-time repairs after a data shape changed and its consumers didn't: `[object Object]` in prompts, `storyText` vs `story`, `faceBox` vs `face_box`, the non-existent `updated_at` column queried 4 times, R2-migration leaks for 7 months, DDL written into a dead init path repeatedly. **Core principle: a shape change ships with a complete inventory of its readers and writers, not with the first few you remember.**

## Schema changes — one live path

DDL goes in a **new `migrations/00N_*.sql` file** (repo root), run by `server/services/migrate.js` at boot. Nothing else runs:

- `server.js` `REMOVED_initializeDatabase_DEAD()` — dead, despite comments claiming otherwise
- `server/services/database.js` `initializeDatabase()` — exported, never called at boot
- `database/migrations/` — legacy system, manual-only

Also: never edit an already-applied migration; make new ones idempotent (`IF NOT EXISTS`, defaults); **query prod data before writing a migration that assumes emptiness** (`SELECT COUNT` first — a "surely empty" version slot had 210 real rows); after deploy, verify `information_schema` in the target environment before shipping dependent code; boot twice to confirm idempotency.

## Field/format changes — inventory before edit

1. `grep -rn` the old name/format. **Read every hit in context** — names are overloaded here (`sceneDescription` is simultaneously a scene field, a model-config key, an HTTP body field, and a lookalike of `sceneDescriptions[].description`). Sort hits into: target readers, target writers, unrelated homonyms.
2. Old data persists forever in `stories.data` JSONB — use the repo's established **read-compat, write-new** aliasing pattern (`x.newKey ?? x.oldKey`) instead of hard renames or bulk JSONB rewrites.
3. Changing what an LLM emits (prompt output format, page markers, section headers)? **Grep every regex parser that consumes it** — parsers broke silently on `Characters (MAX 3):` vs `Characters:`, German page markers, removed age strings. A parser returning empty must log, not shrug.
4. Frontend + backend + Python service all hold copies of some shapes. Check `client/src/types/*`, `storyService.ts`, and `photo_analyzer.py` boundaries (camelCase/snake_case drift).
5. Cached/derived flags referencing the old location (`hasThumbnail`-class bugs) must be updated or replaced with live checks.

## Rationalizations

| Excuse | Reality |
|---|---|
| "I updated the writer and the obvious readers" | The non-obvious reader crashes a real story next week. Inventory means all of them. |
| "I'll put the ALTER TABLE next to the other CREATE statements" | Those statements are dead code. Migration file or it doesn't exist. |
| "The old rows can be migrated in place" | A blind JSONB rewrite nearly corrupted 210 rows. Read-compat alias first, backfill later if ever. |
| "Find-and-replace handles the rename" | `sceneDescription` has 4 unrelated meanings. Context-read every hit. |

## Red flags — STOP

- Writing DDL anywhere except a new `migrations/00N_*.sql`.
- A rename diff produced purely by find-and-replace.
- Changing a prompt's output wording without grepping for its parsers.
