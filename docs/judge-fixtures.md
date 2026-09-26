# Judge regression fixtures

Judge recall and precision are **measured**, not assumed. A fixture is one stored input a
judge is handed plus the verdict it must return. The runner replays every fixture through
the **current** production judge (with production's own builders, via the Test Lab) and
reports recall, precision and flip rate per judge.

**The rule going forward:** every judge miss found by the owner or by an agent becomes a fixture.
The same goes for a false charge: a correct render that a judge charged becomes a `pass` fixture.

| Piece | Where |
|---|---|
| Fixtures (the source of truth) | `tests/judge-fixtures/fixtures.json` |
| Scoring (pure, unit-tested) | `server/lib/judgeFixtures.js`, `tests/unit/judge-fixtures.test.ts` |
| Lab stage | `judge_fixture` in `server/lib/testlab.js` (story-level; dispatches per judge) |
| Lab sets | `Judge fixtures · <judge>`, stage `judge_fixture`, one per judge (Sets tab) |
| Runner | `scripts/admin/judge-fixtures.js` |
| Baselines | `tests/judge-fixtures/baselines/<date>.json` |

## Run it

```bash
node scripts/admin/judge-fixtures.js validate                  # $0: checks the file
node scripts/admin/judge-fixtures.js run                       # every judge, 1 repeat
node scripts/admin/judge-fixtures.js run --judge=semantic,plate_qc --repeats=3 \
     --save=tests/judge-fixtures/baselines/2026-10-01.json
node scripts/admin/judge-fixtures.js score --experiments=1601,1602   # $0: re-score stored runs
```

`run` first mirrors the file into the Lab sets (members added, changed or removed), then runs
each set as an ordinary Lab experiment, at most two at a time. Every run is visible under
**Sets → Judge fixtures · <judge>**. Each result card carries `verdict.outcome` (TP / FN / TN / FP),
the judge's normalised `findings` and its raw `judgeResult`.

The runner prints one block per fixture with the judge's own words, then a table per judge:

- **recall** = TP / (TP + FN), over `flag` fixtures;
- **precision** = TP / (TP + FP);
- **false alarm** = FP / (FP + TN), over `pass` fixtures;
- **flips** = the fixtures whose repeats disagree, out of those run at least twice.

Every repeat counts once. Judges have no temperature knob, so use `--repeats=N` when a number
has to be trusted. Replays that fail are counted as `err` and never enter the rates.

`score` re-reads finished experiments and scores their stored findings against the **current**
file. When you tighten or correct an expectation, re-score the last run for free instead of
paying for the judges again.

**Cost.** The runner prints the cost of each run. Each entry's `cost.basis` says whether the
number was measured from usage the judge returned or taken from a stated flat estimate. The
2026-09-26 baseline and its cost are in `docs/decisions.md` ("Judge regression fixtures").

**The Lab must run the code you are measuring.** Push to staging and wait for the deploy
(`/api/health` commit SHA) before a run. A fixture run is an experiment, so the pre-push gate
waits for it to finish.

## Add a fixture

1. **Find the stored input.** Use the page image or plate **by its R2 URL**: `story_images.image_url`,
   `sceneImages[].emptySceneQc.v1ImageData` for a rejected plate attempt, or a Lab test version's URL.
   A story-level judge (`entity`, `book_audit`, `arc_panel`) needs only the story id.
2. **Look at the pixels** at full size (crop and zoom), not at the stored verdict. The expected
   verdict must be unambiguous from the evidence: the owner's complaint, the brief, the picture.
   If it depends on a policy nobody has ruled on, do not add the fixture. Note the question in
   `tasks/BACKLOG.md` instead.
3. **Write the entry:**

```json
{
  "id": "sem-<story>-p<N>-<what>",
  "judge": "semantic",
  "target": { "storyId": "job_…", "pageNumber": 6, "versionIndex": 0 },
  "input": { "imageUrl": "https://images-staging.magicalstory.ch/stories/job_…/scene/p6/v0.jpg" },
  "expect": { "verdict": "flag", "types": ["setting"], "minSeverity": "MAJOR", "about": ["fog", "sun"] },
  "source": "story, page, which finding and where the expected verdict comes from"
}
```

4. Run `validate`, then run the judge's set (`run --judge=<judge>`), and commit the file.

**Judges and what the stage runs.** Each judge is replayed through the Lab stage that already
replays it with production's inputs:

| judge | stage used | what it reads |
|---|---|---|
| `semantic` | `semantic_eval` | the fixture image, the page's brief, text, cast, clothing and landmark blocks |
| `quality` | `quality_eval` | the fixture image, production's eval options (`buildEvalReplayOptions`) |
| `lettering` | `quality_eval` | the lettering-check findings from the same call |
| `plate_qc` | `validateEmptyScene` | the per-page option set, or the derived-plate set when the page's plate was derived |
| `entity` | `entity` | one character's grid over the story |
| `book_audit` | `book_audit` | the whole book; the fixture's page scopes the verdict |
| `arc_panel` | `arc_panel_replay` | the stored `arcReviewReport.committed` block |

A fixture pinned to the page's **active** version keeps the stored figure detection, as
production had it. A fixture pinned to any other version is judged without that detection.

## Expectation fields

The selector picks the finding that answers the fixture. `flag` needs at least one matching
finding; `pass` needs none.

- `types`: any of these finding types. For `plate_qc`, the check keys in `plateQc.js`
  (`medium`, `figures`, `text`, `artefact`, `era`, `landmark`, …).
- `minSeverity`: at or above this severity (MINOR < MODERATE < MAJOR < CRITICAL < CATASTROPHIC).
  Plate QC findings carry no severity, so a `plate_qc` fixture never sets it.
- `character`: which figure the finding names.
- `fields`: structured fields the finding must carry, e.g. `{ "landmark_element": true }`, or
  `{ "route": "IMG" }` for the book audit.
- `about`: words of which at least one must appear in the finding's text. This is a locator for
  the measuring stick only. It never reaches production scoring, and the report prints the
  matched finding's own words so a human checks every hit.
- `minPanelists` (`arc_panel`): at least this many panelists raise a matching finding.
- `page` is added automatically for `book_audit` and `entity` fixtures that name a page.

## Known limits

- A fixture reads the **current** stored page context: brief, text and cast. If a story is
  regenerated or its row is deleted, the fixture errors loudly rather than silently judging
  something else.
- The plate QC's vantage option set is approximated by the per-page set: the placements come
  from the fixture's page, not the union over the vantage's page group.
- Consolidator, plan check and scene review have no fixtures yet. See the 2026-09-26 decisions entry.
