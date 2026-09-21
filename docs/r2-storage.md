# R2 storage — what is in the bucket, who references it, and how to clean it

Written 2026-09-13, after a production cleanup took **four** attempts because none of this
was written down. Read this before touching any `scripts/admin/*r2*` tool.

Public host: `https://images.magicalstory.ch/` — the key is the URL path after that host.
Key builders all live in `server/lib/r2.js`; that file is the source of truth for shapes,
this page is the map.

---

## 1. Prefix map

### `stories/{storyId}/…`
Everything a story owns. `storyId` is a job id (`job_…`) or a story id.

| Sub-path | Contents | Builder (`server/lib/r2.js`) |
|---|---|---|
| `{imageType}/{pageSlug}/v{n}.jpg` | the page/cover images themselves | `:88` |
| `retry/{pageSlug}/{type}-r{n}.jpg` | retry attempts | `:94` |
| `style-lab/p{n}/{runId}-{model}.jpg` | Test Lab style comparisons | `:99` |
| `characters/{characterId}/{slot}.jpg` | per-story character refs | `:103` |
| `vb/{entryId}.jpg` | Visual Bible entry images | `:171` |
| `styled-avatars/{char}/{artStyle}/…` | style-transferred avatars | `:233`, `:240` |
| `debug/…` | **pipeline diagnostics** — grok/inpaint refs, entity + char + VB grids, bbox overlays, repair frames, styled-avatar steps, landmark refs | `:180`-`:224` |

**Diagnostics are KEPT deliberately.** Owner's call 2026-09-13: they are a research asset
("maybe later we go and check all cases where x failed"). At Cloudflare's $0.015/GB-month the
whole bucket cost ~$0.16/month — cost is not a reason to delete anything here.

### `characters/{userId}/{characterId}/…`
The user's own character library, independent of any story: `photos/{slot}.jpg` (`:109`),
`avatars/{slot}.jpg` (`:155`), `avatars/styled/…` (`:159`), `avatars/thumbs/…` (`:164`).

Note the shape: **two** id segments, user then character. Under `stories/` there is only one.

### `orders/{files.id}.pdf` (`:140`)
Print-ready order PDFs. **No database row stores this URL.** The `orders` row survives after
the `stories` and `files` rows are pruned, and it has never held the PDF URL. A URL scan is
structurally blind here. Protected unconditionally in code — never infer these are dead.

### `landmarks/…`
`landmarks/index/{id}/{hash}.jpg` (`:120`) and `landmarks/historical/{rowId}-{slug}.jpg`
(`:133`). Audited 2026-09-13: **16,143 objects, zero unreferenced** — the subsystem tracks its
own storage correctly. Protected unconditionally anyway. See `docs/landmark-database.md`.

### The `migrated/` shape — the one that bites
`server/lib/dbHousekeeping.js:148` offloads inline base64 out of JSONB with

```js
const prefix = `${table}/${safe(row.owner || 'unknown')}/${safe(row.id)}/migrated`;
```

So for these keys **segment 2 is the OWNER (user) id, not the row id**, even under
`stories/`. Any code that reads segment 2 as a story id will mis-file live users' images as
dead stories. This is exactly how live user `1764881868108` (27 stories, 77 orders) landed in
a delete list.

---

## 2. Where references live

Do not enumerate columns. References sit in JSONB at arbitrary depth — `stories.data`
(`sceneImages[]`, `coverImages`, `characters[]`), `characters.data`, `story_images`, `files`,
`landmark_index`, `landmark_photo_scores`, and others.

The only reliable discovery method is: cast **every** BASE TABLE in the `public` schema to
text (`src::text` covers every column including JSONB), regex out every
`https://images.magicalstory.ch/<key>` occurrence, and take the set of keys. A new table, a
new column, or a URL parked at a path nobody enumerated is then caught automatically.

**A table that fails to scan is a FATAL stop, never a skip.** A silent zero from one table
would mark all of that table's objects deletable.

---

## 3. The COHORT rule — the only sound deletion rule we have

Group every bucket key by its **owner prefix cohort**:

- `stories/{id}/`
- `characters/{user}/{char}/`
- `orders/`, `landmarks/`, and **any unrecognised top-level prefix** → protected, always

A cohort is DEAD only if **ZERO of its objects appear in any URL stored anywhere in the
database**. No id parsing, no substring matching, no type coercion — the only question ever
asked is whether an exact key string is a member of the referenced set.

It is deliberately conservative: a cohort with even one referenced object is untouchable **in
full**, so a live user with both live and deleted stories keeps everything. Some genuine
orphans survive. Accepted.

**Why not something smarter.** Three earlier classifiers all assumed *absence of a database
reference means the object is dead*. That inference is the trap:

1. `orders/` — the reference structurally does not exist (above). 22 paid-order PDFs were in a
   delete list.
2. `migrated/` — segment 2 is a user id (above). A live user was in a delete list.
3. Id-space ambiguity — numeric ids are simultaneously user ids, character ids, and values
   inside `stories.data` JSONB (`{"id": 1765719852125, "name": "Roger"}`). A verifier built on
   `src::text LIKE '%id%'` substring matching returned 9 "false positives" out of 40 that were
   themselves partly spurious: substring hits inside longer numbers and unrelated JSONB.
   Classifier *and* verifier were both unreliable.

The cohort rule survives all three. Full write-up: `docs/decisions.md`, 2026-09-13 entry
"R2 garbage collection is COHORT-based".

Demo/showcase characters are protected by the general reference rule only — there is **no**
carve-out for them (owner declined one, 2026-09-13). Their canonical photos live on disk at
`tests/fixtures/demo-photos/{berger,dubois,miller}/`, so a bucket loss is recoverable.

---

## 4. Running it

**Two entrypoints over ONE scan.** The cohort rule, the bucket walk and the whole report
live in `scripts/lib/r2Cohorts.js`; that module lists and reports and exports no delete
function, so the rule cannot drift between the tools. (Two earlier tools,
`audit-r2-orphans.js` and `delete-r2-orphans.js`, were deleted on 2026-09-13: they were built
on id attribution, the approach the cohort rule replaced, and each had its own scan.)

```bash
node scripts/admin/audit-r2-dead-cohorts.js                  # READ ONLY — no delete path exists in this file
node scripts/admin/delete-r2-dead-cohorts.js --report-only   # report + manifest, cannot delete in this mode
node scripts/admin/delete-r2-dead-cohorts.js                 # dry run (default), same report
node scripts/admin/delete-r2-dead-cohorts.js --confirm --production   # actually deletes
```

`audit-r2-dead-cohorts.js` is the GDPR control (ruling Q7): it prints the identical report and
manifest, and cannot delete by construction — no delete command imported, no S3 client built,
no confirm/production flag. `--report-only` on the deleting tool stays as a convenience for
someone already in that tool. Both entrypoints and both guarantees are pinned by
`tests/unit/r2-cohort-gc.test.ts`.

### The other direction: is anything still IN the database?

The bucket tools answer "is this object still referenced". The opposite question — are
there image bytes sitting in a JSONB column instead of in R2 — is answered by
`sweepInlineImages()` in `server/lib/dbHousekeeping.js`, which walks EVERY json/jsonb
column discovered from `information_schema` (not a maintained list). It runs inside the
daily Railway housekeeping routine and logs an error per offending column with the exact
key paths; run it yourself with:

```bash
node scripts/admin/check-inline-images.js                  # staging (default)
node scripts/admin/check-inline-images.js --env=production
node scripts/admin/check-inline-images.js --env=both --json # exits 1 on any find
```

One declared exception: `story_job_checkpoints.step_data` for the `partial_page` /
`partial_cover` steps, which ARE the progressive-display payload and die with their job.
The save path is pinned by `tests/unit/no-inline-images-in-jsonb.test.ts`.

**Fixing what it finds** is `scripts/admin/offload-jsonb-images.js`, which drives
`offloadJsonbColumn()` — the same one implementation the daily routine uses, sharing this
sweep's candidate predicate and byte test, so a column the sweep flags is a column the tool
can clean:

```bash
node scripts/admin/offload-jsonb-images.js --dry-run                      # report only
node scripts/admin/offload-jsonb-images.js --env=production --limit=5
node scripts/admin/offload-jsonb-images.js --table=characters.metadata
```

It **never deletes a byte**. A value becomes a URL only after the object behind that URL is
fetched back and md5-matched against the value being replaced; keys are content-addressed
(`…-<md5>.jpg`), so a re-run is a no-op and an image already in R2 — including the same
image offloaded earlier into a sibling column — is proven identical and reused rather than
re-uploaded. Each row is written in its own transaction against the pre-write `::text`
fingerprint, so a row that changed under the run is skipped, not clobbered. Every affected
row is dumped to `--backup-dir` BEFORE the write.

Like `delete-r2-dead-cohorts.js`, it **refuses to run when the configured bucket is not the
one the target database serves** — `.env` points at production (`images.magicalstory.ch`),
staging serves `images-staging.magicalstory.ch` from a different bucket, and a staging run
with production credentials would leave staging rows referencing objects production's own
GC would later delete.

#### Every environment cleans itself, nightly (owner, 2026-09-21)

The daily housekeeping routine's offload used to cover `characters.data` and `stories.data`
while the sweep beside it reported on all 35 json/jsonb columns — so a leak into
`characters.metadata`, `story_jobs.input_data` or `users.trial_data` was reported loudly
every morning and fixed by nobody. Since 2026-09-21 the routine runs
`offloadInlineImages()` over **all of `OFFLOADABLE_COLUMNS`**, which is the same list the
admin tool uses, through the same `offloadJsonbColumn()` implementation. That is what
finally cleans staging: staging serves a different R2 bucket and only production
credentials are checked in, so the bytes can only be moved by the staging container itself,
with its own keys, on its own schedule.

Because it now runs unattended against live data it is bounded and resumable:

- **Budget** `DAILY_OFFLOAD_BUDGET` = 100 rows / 256 MB per run, checked before each row.
  The measured corpus is 34 rows / 33.8 MB (production, 190 days' accumulation), 38 rows /
  99.7 MB (staging), largest single row 7.07 MB — so a real backlog clears in one night,
  while a write path that starts dumping bytes into every row costs at most 100 rewritten
  rows per 24 h instead of the whole database in one unattended pass.
- **Resume** the column a run stopped in is stored in `config.db_housekeeping_offload_cursor`
  and the next run starts there, rotating through the rest so no column is starved. A
  skipped row consumes no budget, so a column that cannot be cleaned cannot hold the
  cursor hostage.
- **Refusal** the routine calls the shared `verifyBucketMatchesDatabase()` before writing
  anything: R2 unconfigured, no sample URL to check against, or a bucket host that is not
  the one this database serves ⇒ it logs an error and writes nothing. The admin script
  turns the identical verdict into a hard error.
- **Self-check** the sweep runs after the offload, and a column the offload cleaned this
  run (no skipped rows, not the cursor column) that the sweep still finds bytes in is
  logged as `OFFLOAD/SWEEP DISAGREE` — the fixer and the guard are not seeing the same
  bytes, which matters more than the leak.

`story_job_checkpoints.step_data` is absent from `OFFLOADABLE_COLUMNS` and stays untouched.
All of this is pinned by `tests/unit/jsonb-image-offload.test.ts`.

Options: `--age-days=30` (cohort age floor — a cohort whose newest object is younger than
this is never swept, which protects an in-flight generation), `--list=20` (sample keys per
prefix), `--out=path.json` / `--no-manifest` (the review manifest).

The report breaks the bucket down by prefix and by sub-kind (`debug`, `aux`, `retry`, `vb`,
`empty_scene`, `migrated`, `tl_*`, …) with objects / bytes / referenced / unreferenced for
each, and prints any **unrecognised** top-level prefix with sample keys — those are
protected unconditionally, but a new one means this page is out of date. Sub-kinds are
reporting only; they never enter a deletion decision.

The manifest is a **review artefact, never an input**. Nothing can be deleted by feeding a
file back in, so a stale or hand-edited manifest cannot drive a delete.

Safety layers, in order: `--report-only` cannot delete at all → dry-run default → both
`--confirm` and `--production` required → bucket/database host guard →
FATAL on any table that fails to scan → the age floor → final assertion that no victim key
is in the referenced set → batches of 1000 (S3 API max) → every deleted key appended to
`tasks/r2-deletion-log-<date>.jsonl` (gitignored).

Reads `DATABASE_URL`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
`R2_BUCKET` from `.env`. Point `DATABASE_URL` at the environment you mean — the
`--production` flag is a human gate, not an environment switch.

---

## 5. Why orphans exist at all

Deletion paths removed database rows without removing the objects behind them — e.g.
`deleteStoryArtefacts()` logged failures and returned a count rather than throwing, so a
failed prune left objects behind silently.

Root causes are fixed in commit `0e07da278` ("fix(r2): stop creating orphans — record failed
prunes, and delete the object with its row"). **That commit is on `staging` only, not on
`master`** — until it is promoted, production keeps accumulating orphans and this cleanup will
need repeating.

---

## 6. The 2026-09-13 cleanup (production)

| | |
|---|---|
| Before | 116,189 objects / 20.66 GB |
| Deleted | **22,011 objects / 3,107 MB** — 95 dead story cohorts, 235 dead character cohorts (≈100 deleted test accounts) |
| Kept | 13.4 GB live-owner content, **including all diagnostics** |
| `landmarks/` | 16,143 objects, zero unreferenced — pristine |
| Log | `tasks/r2-deletion-log-2026-09-13.jsonl` (gitignored) |

Found while scanning, **not** fixed: 17 of 128 production stories are owned by a `user_id`
with no `users` row — stories outliving their owner. Real integrity problem, independent of
R2. On `tasks/BACKLOG.md`.
