# The landmark database

Real places a story can be set at: how they are discovered, photographed, judged,
ranked and served. This is the **index subsystem**. For how a location reaches the
story in the first place (IP detection, Nominatim verify, Visual Bible injection),
see `docs/landmarks.html` — the two do not overlap.

Code: `server/lib/landmarkPhotos.js` (~3,830 lines), tables `landmark_index` and
`landmark_photo_scores`, ~21 tools under `scripts/admin/`.

---

## 1. The model in one paragraph

A landmark is a row in `landmark_index`, discovered from Wikipedia by geosearch
around a town, carrying up to **six reference photos** with descriptions and CC
attribution. Photos are judged **by looking at them**, producing two scores and a
framing per photo. Serving answers one question — *"what can a story in town X be
set at?"* — by filtering out what is not a place and what has been judged
unusable, then ranking what survives. A landmark with no photo can be named but
not drawn, so it always ranks below one that has a picture.

---

## 2. Tables

### `landmark_index` — 53 columns

| Group | Columns | Notes |
|---|---|---|
| Identity | `id`, `name`, `wikipedia_page_id`, `wikidata_qid`, `lang` | `wikidata_qid` is UNIQUE and is the upsert key |
| Place | `latitude`, `longitude`, `nearest_city`, `municipality`, `locality`, `country`, `region` | three-level model, §3 |
| Classification | `type`, `categories[]`, `boost_amount`, `score` | `boost_amount`/`score` are legacy, superseded by §5 |
| Photos ×6 | `photo_url[_2..6]`, `photo_attribution[_2..6]`, `photo_description[_2..6]`, `photo_type[_2..6]` | slot 1 has no suffix |
| Photo meta | `photo_source`, `commons_photo_count` | |
| Text | `wikipedia_extract` | fed to the writer as DESCRIPTION |
| Fame | `fame_sitelinks`, `fame_pageviews`, `fame_updated_at` | migration 025 |
| Judging | `story_score`, `story_score_reason`, `story_score_at` | derived, §6 |
| Stamps | `created_at`, `updated_at`, `municipality_updated_at`, `locality_updated_at` | |

### `landmark_photo_scores` — one row per (landmark, slot)

`landmark_id`, `slot` (1–6), `draw_score`, `photo_score`, `framing`, `reason`,
`judged_at`. PK `(landmark_id, slot)`.

Migrations: `020_landmark_photo_type`, `025_landmark_fame`,
`028_landmark_municipality`, `029_landmark_story_score`,
`031_landmark_photo_scores`, `032_landmark_locality`,
`033_landmark_photo_framing`. **Schema changes go in a new `migrations/*.sql`
only** — the DDL in `database.js` never runs.

---

## 3. Three levels of place — and why all three exist

| Column | Means | Trap |
|---|---|---|
| `nearest_city` | the town discovery was **searching around** | **not** where the landmark is. 10 km radius, so it holds neighbours |
| `municipality` | the political commune (Wikidata P131) | `NULL` means *not yet resolved*, never *not local* — 57% of the index has no municipality-class P131 |
| `locality` | the village/hamlet (Nominatim zoom 14) | a hamlet is not a former municipality; the geocoder cannot tell them apart |

A landmark answers to **both** its village and its municipality
(`TOWN_MATCHES_SQL`), and own-village rows rank first (`LOCALITY_FIRST_SQL`).
Village-only matching was measured over the whole index and strands **327
municipalities with zero landmarks** (Zug's church is tagged `Oberwil`, Langnau's
`Bärau`). Matching either name covers 2,373 towns against 2,054.

Ordering matters: `HAS_PHOTO` is sorted **before** locality-first. Ranked the
other way, Langnau opens on a photoless castle instead of its own church —
"in the village" must not beat "can be illustrated".

---

## 4. Lifecycle

```
geosearch (Wikipedia, by lat/lon)
  → Wikidata dedup + category enrichment  → type, boost, fame
  → findBestLandmarkImage()               → up to 3 exterior + 3 interior
      Commons category (via Wikidata P373) → Wikipedia article images → Commons search
      every candidate judged by Gemini; diversity picked; drawings/signs/plaques rejected
  → saveLandmarkToIndex()                 → upsert on wikidata_qid
  → per-image judging (agents, $0)        → landmark_photo_scores → story_score
  → serving: resolveAvailableLandmarks()
```

**Fetching is free, describing is paid.** `fetchPhotos` (Wikipedia/Commons) and
`analyzePhotos` (Gemini) are separate flags. They used to be one, and a
cost-free bulk run therefore inserted **4,903 landmarks with no image at all**.

---

## 5. Ranking — what is offered first

Three ordered mechanisms, applied in this order:

**a. Class (`LANDMARK_CLASS_SQL`) — an ALLOW-list, not a deny-list.**

| Class | What | Examples |
|---|---|---|
| 2 | a scene can be set here | Church, Castle, Museum, Bridge, Tower, Square, Fountain, Park, Monument, Theatre, Library, Abbey, Monastery, Cathedral, Palace |
| 1 | real but weak — *and the default* | ordinary building, station, road, lake, mountain, **anything untyped** |
| 0 | not a place | City, Village, Event, Organisation, Other + non-place categories (Gemeinde, Bezirk, Schlacht, Flugunfall, Unternehmen…) |

Excluding junk by pattern was a losing game — each new category had to be
discovered in a shipped list first. Inverting it makes the default safe.

**b. `LANDMARK_RANK_SQL`** — `HAS_PHOTO DESC, class DESC, fame_pageviews DESC,
fame_sitelinks DESC, score DESC`.

`fame_pageviews` (99.8% populated, free) ranks every city sensibly.
`fame_sitelinks` is the *worst* signal and is only a last resort: a motorway has
15 language editions, a cyclocross championship 8, against 2 for the town's
medieval church.

**c. `story_score` is a FILTER, never a sort key.** Ordering by it puts every
judged row above every unjudged one, so mid-run a pleasant minor square outranks
a landmark nobody has looked at — Lindenhof (judged 78, 425 views) displaced the
Grossmünster (unjudged, 2,093 views) as Zürich's first offer. The judge answers
*"is this usable at all"*; pageviews answer *"which is more prominent"*.

---

## 6. The judging model

Two scores plus a framing, per photo:

- **`draw_score`** — is the PLACE worth drawing? Fame must **not** raise it.
- **`photo_score`** — does THIS picture show it usably?
- **`framing`** — `medium` | `closeup` | `interior` | `wide` | `view-from` | `aerial`

`story_score` is **derived, never authored**:
`LEAST(MAX(draw_score), MAX(photo_score))` — min, not average.

`MIN_USABLE_PHOTO = 40` is the single cutoff governing both the per-image filter
and `JUDGED_USABLE_SQL = (story_score IS NULL OR story_score >= 40)`. Note an
**unjudged NULL is served; a judged 39 is not.**

**Framing outranks score** (`FRAMING_RANK_SQL`). Most stories put the action *at*
the place, which needs the building filling the frame — a superb photo of the
same castle as a speck on a ridge scores higher and is useless. `bestPhotoSlots()`
returns the best slot **per framing**, so a scene set inside a castle can reach
the interior shot. Serving takes **every field from the same slot**: no
cross-slot fallback, because pairing slot 3's photo with slot 1's credit names
the wrong photographer, and attribution is a CC licence condition.

Judging is done by **Claude agents reading the image files directly — $0**, not
by a vision API. See `docs/landmark-judging-instructions.md`,
`prep-landmark-judging.js`, `merge-landmark-judgments.js`.

---

**Premise pin.** `resolveAvailableLandmarks({ premiseText })` puts any index row
whose name the family's story idea mentions FIRST (after the shuffle), so the
writer's top-3 opens on it. Lexical only: `premiseMentionsLandmark` (pure,
unit-tested in `tests/unit/premise-landmark-match.test.ts`) — strip "(Town)",
fold accents, drop generic type words and articles, every remaining token must
be a whole word of the premise and they must total 5+ chars. SQL prefilters on
folded whole-word overlap; same usable/never-a-setting filters, class > 0,
`story_score DESC`, cap 3.

## 7. Serving — the fallback ladder

`resolveAvailableLandmarks(location, opts)` is the **single entry point** for both
the ideas route and the story pipeline. `getIndexedLandmarks()` tries in order:

1. exact town-name match (locality **or** municipality/nearest_city, diacritics folded)
2. comma-normalised match — `Bremgarten Aargau` → `Bremgarten, Aargau`
3. first-word match — `Bremgarten` from `Bremgarten Aargau`
4. **proximity** at 20 → 50 → 100 km (only when lat/lon are numbers)
5. the town's own `(Stadt)` aerial, as last resort

A name match containing **nothing servable** counts as *no match* and lets
proximity run. Two cases fall under it: only the town's `(Stadt)` aerial —
otherwise Locarno was served its own aerial while the Madonna del Sasso sat 2 km
away under Ascona's anchor — and **only photoless rows**. `HAS_PHOTO_SQL` merely
sorts, so before 2026-08-29 a single photoless row suppressed proximity and the
story was set somewhere nobody can draw: Ehrikon was handed `Ruine Alt-Wildberg`,
a castle burned down c.1320 with nothing standing. Measured across the index,
42 towns were affected; 41 now get a photographed landmark and none lost one,
because the weak rows are still returned when nothing is found within 100 km.

Then `resolveAvailableLandmarks` layers on: best-slot photo selection, per-framing
`photoVariants`, language-matched Wikidata name variants, and optional
Fisher-Yates `shuffle` (the pipeline uses it so the model stops reaching for the
same top entries every story).

Options: `limit`, `discoverOnMiss`, `language`, `shuffle`, `onStatus`.

---

## 8. The auto-index trigger ⚠️

When index **and** cache come back empty and `discoverOnMiss` is true,
`discoverLandmarksForLocation()` runs — and at `landmarkPhotos.js:2196` it fires
`indexLandmarksForCity(city, country, { analyzePhotos: true, maxLandmarks: 30 })`
**in the background, not awaited**.

Consequences worth knowing before changing anything here:

- It is **user-reachable**. `storyIdeas.js` passes `discoverOnMiss: true` (both
  variants); `storyJobPipeline.js` passes `false`.
- The 15 s timeout bounds only the *awaited* discovery. The background index it
  spawned keeps running unbounded after the request is gone.
- It costs **paid Gemini calls per triggering request** — up to 30 landmarks ×
  every candidate image.
- Every **foreign** location triggers it (nothing foreign is indexed).
- Every **already-indexed** town is now barred from triggering it at all
  (`townAlreadyIndexed()`), regardless of how little it has to offer.

**Why the bar exists.** A town whose landmarks were all judged below 40 resolves
to zero, so it used to re-trigger discovery on every cold cache. Discovery
re-found the *same* Wikipedia places, the background indexer re-saved them, and
`saveLandmarkToIndex` deliberately preserves `story_score` — so the rerun could
not change the verdict. It just cost another ~30 landmarks of paid analysis,
forever. Measured 2026-08-29: **146 of 2,264 Swiss towns** were in that loop.

It also closed a correctness hole: discovery returns raw Wikipedia hits, not
index rows, so its results bypassed `JUDGED_USABLE_SQL` entirely and handed the
story exactly the landmarks the judge had rejected.

Discovery now fires only where we have genuinely **never looked** — zero rows for
the town. That keeps new/foreign locations working (verified: Tromsø, Valparaíso
still discover) while Merlischachen, Aefligen and Nuolen return empty in ~130 ms
with zero outbound calls.

---

## 9. Failure guard — "cannot look" is not "nothing to see"

`analyzeImageQuality()` returns `null` **only** on failure (API error, empty
reply, unparseable JSON). A genuinely bad photo returns a **low score object**.
These were indistinguishable until 2026-08-29, when a thinking-budget
misconfiguration truncated every reply and 405 real Swiss places were recorded as
photoless.

Three levels now separate them:

1. `analyzeAndFilterImages` counts judged vs unjudgeable separately.
2. `findBestLandmarkImage` **throws** `err.analysisUnavailable` when zero
   candidates could be judged — a flag on the error, never a regex on its message.
3. `indexLandmarksForCities` skips the save and **aborts the run** after 3
   consecutive failures, returning `abortedAnalyzerDown: true` so an aborted run
   cannot read as a complete one. Any success resets the counter.

Pinned both directions by `tests/unit/landmark-analysis-guard.test.ts` (offline).

**Gemini 2.5 note:** `maxOutputTokens` is a budget for *thinking plus answer*.
Every landmark call sets `thinkingConfig: { thinkingBudget: 0 }`
(`landmarkPhotos.js:916`, `:1115`). Do not lower the caps below ~600.

---

## 10. Caches

| Cache | TTL | Scope |
|---|---|---|
| `availableLandmarkCache` | 7 days | discovered (non-indexed) landmarks, **shared** by every caller |
| photo/module cache (`CACHE_TTL`) | 24 h | fetched photo payloads; `clearCache()` / `getCacheStats()` |

The available-landmark cache is deliberately one shared Map — `storyIdeas.js` kept
a private one, so landmarks it discovered were invisible to the pipeline.

---

## 11. Admin tooling

**Discovery / coverage**
`discover-missing-city-landmarks.js` · `add-iconic-landmarks.js` ·
`broad-city-overviews.js` (+ `-fallback`) · `reindex-missing-cities.js`

**Photos**
`backfill-landmark-photos.js` (uses `findBestLandmarkImage`; aborts on
`analysisUnavailable`) · `fetch-landmark-photos-free.js` (no model calls at all) ·
`classify-landmark-photos.js` (camera angle, Gemini) ·
`prep-landmark-descriptions.js` → agents → `merge-landmark-descriptions.js`
($0 — fills the `photo_description[_N]` slots that `fetch-landmark-photos-free.js`
left NULL, ~10,000 on prod. Batches are cut BY LANDMARK (all of a landmark's slots
in one ~25-photo batch, `--limit` counts landmarks) so agents see a landmark's
photos together; per photo they write `{description (1-2 sentences, visible
features only), scope, season, timeOfDay, subjectMatch, discard}` to
`descs_<batch>.json` — `--brief` prints the brief. Merge validates the enums
and 40-400 chars, stores kept entries as `[scope, season, timeOfDay] description`
in the slot column, and never writes discards (wrong subject, unrecognisable,
map/print/archival, duplicate of a lower slot) — those go to a DISCARD table and
`discards.json` for a later slot-clearing pass)

**Judging**
`prep-landmark-judging.js` → agents → `merge-landmark-judgments.js` ·
`score-landmarks-for-stories.js` · `landmark-rankings.js`

**Data repair** (all free — Wikidata/Nominatim)
`backfill-landmark-municipality.js` (P131) · `backfill-landmark-fame.js` ·
`backfill-landmark-types.js` · `fix-landmark-country.js` (P17) ·
`fix-landmark-coordinates.js` (P625) · `reanchor-landmarks-to-municipality.js` ·
`canonicalize-landmark-names.js` · `strip-landmark-abbreviations.js` ·
`rewrite-landmark-extracts.js` (Haiku, paid)

**Ops**
`sync-landmark-index-to-staging.js` (prod → staging **only**; never the reverse) ·
`clean-blind-run-landmark-rows.js`

**Licensing.** Commons content is overwhelmingly CC BY / CC BY-SA, where credit is
a licence CONDITION. `photo_attribution` is therefore not decoration, and it is
stored per slot — pairing one slot's picture with another's author names the
wrong photographer. `fetch-landmark-photos-free.js` once wrote `photo_url`
alone, leaving 2,843 rows holding a usable picture with no lawful way to credit
it; it now resolves Artist + licence from Commons `extmetadata` inline, and
`backfill-landmark-attribution.js` repairs the historical rows (free, resumable).

### HTTP endpoints

Mounted at `/api/admin/swiss-landmarks` (`server/routes/admin/swiss-landmarks.js`):
`POST /index`, `GET /index/status`, `POST /recalculate-scores`,
`POST /update-type`, `GET /stats`, `GET /`, `DELETE /broken`, `DELETE /by-ids`.

> `server/routes/admin/landmark-index.js` defines a near-identical router that is
> **required by nothing and mounted nowhere** — dead code as of 2026-08-29.

---

## 12. Known gaps

Measured on production, 2026-08-29 (6,093 Swiss rows, 2,264 towns):

| Gap | Count |
|---|---|
| Towns with **no scene-settable landmark** | **790 / 2,264 (35%)** |
| Towns resolving to zero → auto-index trigger | 146 |
| Rows judged unusable (< 40) | 841 |
| Rows never judged | 384 |
| Rows with no photo at all | 292 |

The largest single type is **1,508 `City`** rows — the `(Stadt)` aerials, which
are overviews, not settings. Type assignment is unreliable on fresh discovery
(a commercial school typed `Mountain`, others `null`).

Wikipedia geosearch is largely tapped for the towns already searched, but a
village never discovered was never geosearched — the 2,264 town names came from
discovery itself, so the blind spot cannot be enumerated from the repo. Untapped
sources: Wikidata P131 queries per municipality (not radius-bound), Commons
categories per municipality, federal heritage inventories (KGS / ISOS).

Open items live in `tasks/BACKLOG.md`.

---

## 13. Where the reasoning lives

Every rule above was a decision with evidence. `docs/decisions.md` holds them —
search for `landmark`. The load-bearing ones:

- 2026-08-25 — `nearest_city` is a search anchor, not a location
- 2026-08-25 — ranked by a judged story score, not by any fame proxy
- 2026-08-25 (add. 2) — a landmark judged unsuitable is not offered at all
- 2026-08-26 — coverage discovery; the judge filters instead of ranking
- 2026-08-28 — every photo judged by looking at it; two scores, a framing, a 40 cutoff
- 2026-08-28 — a landmark answers to BOTH its village and its municipality
- 2026-08-29 — a failed photo analysis is not a verdict about the place
