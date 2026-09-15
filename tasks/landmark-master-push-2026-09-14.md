# Landmark serving: what is on `staging` and not on `master`

Written 2026-09-14. **Nothing here has been executed.** No push, no merge.
The owner's reported landmark symptom is fixed by work that has been sitting on
`staging`; this document says exactly what that work is, what it changes, and
what has to be checked before anyone asks for a prod push.

## 0. The headline: this is not a cherry-pick, it is a release

```
git log --oneline master..staging | wc -l   ->  2270
git diff --name-only master..staging | wc -l ->  2793
```

`staging` is 2270 commits ahead of `master` across 2793 files. The landmark
commits below are interleaved with the whole beats/eval/repair programme, and
several of them touch files that the rest of that programme also rewrote
(`promptBuilders.js`, `storyJobPipeline.js`, `images.js`). **There is no safe
landmark-only cherry-pick.** Pushing the landmark fix to production means
merging `staging` into `master` — i.e. shipping the entire backlog — and it has
to be planned, smoke-tested and approved as such.

## 1. Commits touching `server/lib/landmarkPhotos.js` (the serving path)

39 commits, oldest last. These are the ones that can change which landmark a
story is given and which photo it sees.

| Commit | What it does | Behaviour or docs |
|---|---|---|
| `4161d0562` | prompt checked for unfilled placeholders at the model-call boundary | behaviour (guard) |
| `497890e1f` | no output caps anywhere (null = model max) + truncation guard | behaviour (incidental — touches this file only via a shared caller) |
| `9676d4024` | search Italian Wikipedia for Swiss landmarks | behaviour (indexing) |
| `428f72152` | make Italian a fully supported language | behaviour (incidental) |
| `0134333e8` | town lookup trims the name, matches `nearest_city` on its own | **behaviour (serving)** |
| `112f6a189` | premise pin matches the name-final place token; city tokens excluded; prefilter narrowed | **behaviour (serving)** |
| `43c907d2e` | Swiss stories resolve landmarks index-only; a cited landmark never renders blind and silent | **behaviour (serving)** |
| `c9b332877` | town-name lookup serves the locality alone; widens to the commune only under `MIN_OWN_LOCALITY_ROWS = 5` | **behaviour (serving)** |
| `a826447f0` | serving REQUIRES a photo (`HAS_PHOTO_SQL` filters instead of only sorting); class scores as a bonus, not a tier | **behaviour (serving)** |
| `75e43a367` | landmark reference photos stored on R2, Commons URL kept as provenance | behaviour (storage) |
| `a53c7262c` | premise-named landmark pinned first; $0 photo-description prep/merge scripts | **behaviour (serving)** |
| `b38bad6b7` | non-free images blocked at both write paths | behaviour (licensing) |
| `25c0c425e` | **a photoless row no longer suppresses the proximity fallback** — introduces `weakOnly` | **behaviour (serving)** |
| `102f32f63` | an indexed town never triggers indexing again | behaviour (cost) |
| `47b384711` | a blind run can no longer record places as photoless | behaviour (indexing) |
| `37646a21a` | `maxOutputTokens` is a THINKING budget on 2.5-flash — every image analysis was truncated | behaviour (indexing) |
| `67032a88c` | judge every stored photo by looking at it; keep villages out of their commune | **behaviour (serving)** |
| `66716da33` | merge: Wave C (child critic, evaluator 4.4, title judge) | behaviour (unrelated merge that touched the file) |
| `b18f76a7a` | a photoless landmark never outranks a photographed one | **behaviour (serving)** |
| `8e8391923` | discover the 57 missing cities; judge filters, pageviews rank | behaviour (indexing + ranking) |
| `c0d594a75` | retire the cover templates — a cover is a page plus the typography pass | behaviour (incidental) |
| `b7cbbba6b` | a landmark judged unsuitable is not offered at all | **behaviour (serving)** |
| `a4d4ce15f` / `84f022341` | rank on pageviews, drop non-places | **behaviour (serving)** |
| `c43365432` | rank by a judged story score; offer a town only its own | **behaviour (serving)** |
| `8f0f66ced` | strip abbreviations on the way IN | behaviour (text) |
| `5a893152c` | class is a bonus, not a tier; re-type all 4764 rows | **behaviour (serving)** |
| `31659cdb8` | fix-ledger enforcement on arc/beats/scene/text reviews | behaviour (incidental) |
| `84065fe30` | every row typed — 983 NULLs filled from Wikidata P31 | data + behaviour |
| `d785039be` | the story's own town wins first — `nearest_city` before distance | **behaviour (serving)** |
| `37f6b0da1` | built landmarks outrank rivers and lakes | **behaviour (serving)** |
| `1ef5654e0` | rank inside distance bands — a Baden story was offered Zurich | **behaviour (serving)** |
| `32e6d5a7a` / `b74b64e60` | rank by fame (`fame_sitelinks`) | **behaviour (serving)** |
| `6a831196f` | time-proportional progress bar, deploy-window launch gate, indexer writes photo kinds | behaviour (mixed) |
| `f771fc2c2` | photo owns the building, scene owns the conditions; attach by view kind | **behaviour (prompt + serving)** |
| `13690892f` | one `resolveAvailableLandmarks()` + one shared cache | refactor |
| `14140b57f` | defect batch L1-L7 — beats see landmarks, vantage-safe variants, one shape, dedupe | **behaviour (serving)** |
| `010e5019b` | single-photo landmarks get a citable `[LOCxxx.1]` id + URL fallback | behaviour (serving) |
| `5c2fd38a6` | gemini-2.0-flash retired; utility model to 2.5-flash | behaviour (incidental) |

Plus, on this branch and not yet pushed anywhere, the two fixes of 2026-09-14:
the matched row supplying its own proximity centre, and the photo kind reaching
`buildLandmarkFidelityBlock`. **The second carries DRAFT prompt wording that the
owner has not signed off — it must not go to master before that.**

## 2. Docs and scripts (no runtime effect)

`docs/landmark-database.md` (created by `ba41ff985`, corrected by `1fa7ec1fa`)
and the `scripts/admin/*landmark*` family (`63f1288f5`, `0248a8e50`,
`aee2692fa`, `4b7201c39`, `eb509228c`, `e8bcb0f35`, `23dd46a07`, `37660bd2f`,
`79d5726c8`, `1c6b2e1f0`, `9e5083e74`, `8184ea157`) are agent-run tooling and
documentation. They change nothing a story sees.

## 3. The two changes that most change what a story gets

### `weakOnly` (`25c0c425e`, `server/lib/landmarkPhotos.js` in `getIndexedLandmarks`)

`git show master:server/lib/landmarkPhotos.js | grep -c weakOnly` -> **0**. It
exists only on staging.

Before it: a town whose name lookup matched *anything* — including its own
class-0 aerial (`<Town> (Stadt)`) or a photoless ruin — counted as a match, and
the proximity fallback was never tried. Locarno was served its own aerial while
the Castello Visconteo sat 500m away; Ehrikon was served a castle that burned
down around 1320 and has no photo because there is nothing to photograph.

After it: a match consisting only of unusable rows is treated as no match, the
20/50/100 km proximity ladder runs, and the weak rows are kept as the
fallback-of-last-resort if nothing real is within 100 km.

**Consequence to state plainly:** on master today, some towns are handed their
own aerial. After the merge they will be handed a *neighbouring town's*
landmark. That is the intended fix and it is also the biggest observable
difference.

### The serving filters `JUDGED_USABLE_SQL` and `HAS_PHOTO_SQL` (`c43365432`, `a826447f0`, `b7cbbba6b`)

```js
const MIN_USABLE_PHOTO = 40;
const JUDGED_USABLE_SQL = `(story_score IS NULL OR story_score >= ${MIN_USABLE_PHOTO})`;
```

`grep -c JUDGED_USABLE_SQL` on master -> **0**. Neither the score filter nor the
photo filter exists there.

Note the NULL tolerance: a row that has never been judged is still served. Only
a row judged below 40 is withheld. Combined with `HAS_PHOTO_SQL` now *filtering*
(it used to only sort), the effect is: fewer rows are offered, and the ones
offered are drawable. On a town whose rows are all judged low, the offer set can
go from several to zero — which is precisely when the proximity ladder is
supposed to take over, so these two changes must ship together. They already do:
both are on staging, neither is on master.

## 4. Risk on the full-story path

1. **A story's location resolves to a different landmark than before.** Ranking
   changed four times (`fame`, `pageviews`, `story_score`, class-as-bonus) and
   the own-town rule changed twice. A Baden story that used to get a Zurich
   landmark now gets a Baden one; a village story that used to get its own
   aerial now gets a neighbour. Both are the intended direction, but a prod push
   changes the output of every Swiss-located story.
2. **Zero landmarks where there used to be one.** The score and photo filters
   subtract rows. If the proximity ladder then also finds nothing inside 100 km,
   the story runs with no landmark photo — prose carries the setting. That is by
   design (`decideLandmarkPhotoSource` returning null is a designed outcome) but
   it is a visible difference.
3. **A fidelity block shipping without its photo.** `ensureLandmarkPhotoBytes`
   drops entries whose bytes cannot be fetched so block ⇔ bytes always holds.
   With photos now served from R2 (`75e43a367`), a prod push depends on the R2
   bucket and `R2_PUBLIC_URL` being correct in the production environment. Check
   this explicitly: it is the one change with an infrastructure dependency.
4. **Auto-indexing spends money.** `102f32f63` stops an already-indexed town
   re-triggering indexing. Without it, a user-reachable path spawns paid
   background indexing. This one reduces prod risk, not raises it.
5. **The blast radius is the whole 2270-commit release**, not the landmark
   subset. Beats, evaluator, repair routing, covers and the trial flow all move
   at the same time.

## 5. Staging smoke test — concrete checks before asking for prod

Read-only DB checks (no paid calls, no story runs):

- [ ] **A town with no landmark of its own resolves to a neighbour.**
      `getIndexedLandmarks('Abtwil SG', 5)` must return St. Gallen landmarks
      (Fürstabtei St. Gallen ~3.8 km, Open art museum ~3.2 km), not
      `Gaiserwald (Stadt)`. Verified on staging 2026-09-14.
- [ ] **A town WITH a good landmark still resolves to its own.**
      `getIndexedLandmarks('Fislisbach', 5)` must return `Kirche Rohrdorf`
      (story_score 60) — the proximity ladder must NOT fire. Verified 2026-09-14.
      Same for a city: `getIndexedLandmarks('Baden', 5)` must be Baden rows.
- [ ] **No town resolves to a photoless row.** Every returned row has
      `photo_url IS NOT NULL`.
- [ ] **No town resolves to its own aerial when a real landmark is reachable.**
      Spot-check Locarno: the Castello Visconteo / Madonna del Sasso, not
      `Locarno (Stadt)`.
- [ ] **R2 photo serving works from the target environment.** Fetch one
      `photo_r2_url` returned by the serving path and confirm HTTP 200 and
      image bytes. This is the infrastructure dependency in item 3 above.

Then one cheap end-to-end on the smoke account (`demo-b-hnecf@magicalstory.ch`,
4-page bypass, per the running-validation-stories ladder — NOT a showcase):

- [ ] A 4-page story located in a small town. Check: a landmark photo was
      attached, the page prompt carried the fidelity block, the rendered page is
      in the art style (not a repainted photograph), and the landmark is the one
      the index offered.

## 6. Standing rules that apply to this push

- **Every push to `master` needs its own explicit yes.** An earlier "ship it" in
  this or any other conversation does not carry forward. Push to `staging`,
  verify at `https://staging.magicalstory.ch`, then ask.
- **The push is gated on the target environment being idle.** `.githooks/pre-push`
  asks `GET /api/health/busy` and refuses while a story generation or Test Lab
  experiment is running — a deploy restarts the container and kills it. If it
  blocks, **wait**. `--no-verify` on `master` means destroying a real user's paid
  generation. Check with `node scripts/admin/check-push-idle.js`.
- **A prod deploy kills in-flight story generation and causes brief downtime.**
  That cost applies to "safe" and "additive" changes identically.
- **The DRAFT fidelity wording (fix 2, 2026-09-14) is unapproved.** It must be
  signed off or reverted before it is part of any master push.

## 7. Open question for the owner

The landmark work is entangled with 2270 commits. Two ways forward, and this is
the owner's call, not an agent's:

- **A. Merge `staging` -> `master` as one release.** Everything ships. Needs a
  broad smoke test, not just the landmark checks above.
- **B. Hold, and keep landing landmark work on staging** until the rest of the
  release is ready to go with it.

There is no viable option C (a landmark-only cherry-pick): the commits touch
files the rest of the release rewrote.
