---
name: running-showcases
description: Use when the owner says "run a (new) showcase story", "showcase the <family>", "showcase entry N" or similar - the full fresh-account showcase orchestrator, its rotation config and environment choice
---

# Running a showcase story

When the user says **"run a new showcase story"** (or any short variant: "run a showcase", "showcase the Bergers", "showcase entry 7"):

1. The command is the orchestrator at `scripts/admin/showcase.js` (`npm run showcase`).
2. It picks a rotation entry (default = next from `tests/demo-rotation-state.json`; override via `--entry=N`), creates a **fresh timestamped account** (`demo-{family}-{YYYYMMDD-HHmm}@magicalstory.ch`), uploads characters + the curated photos from `tests/fixtures/demo-photos/{family}/`, and triggers the Playwright spec → server starts story generation.
3. Each run is fully isolated. Old stories stay accessible on their original accounts.
4. If the user says "for the Bergers" / "with Miller" / "in French", look up the matching rotation index in `tests/helpers/demo-rotation.json` and pass `--entry=N`.
5. If photos for the family don't exist yet on disk, run `node scripts/admin/generate-demo-photos.js --family=<id> --save-to=true --no-upload` first, let the user inspect, then proceed.
6. Default backend is **production**. For local: `npm run showcase:local`. Always confirm environment with the user before launching.

Rotation config: `tests/helpers/demo-rotation.json`; state: `tests/demo-rotation-state.json`; orchestrator source is the doc (`scripts/admin/showcase.js`).

**A showcase is the LAST resort for validation, not the first.** For validating a change, use the running-validation-stories skill's ladder: stored evidence → single-page rerun → cheap 4-page run on the existing smoke account (`demo-b-hnecf@magicalstory.ch`, no character recreation) → full-story rerun on that same account (identical wizard start point; vary one knob like art style or location) → full showcase only after long/structural changes or character-pipeline changes.
