# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Subsystem deep-dives live in `docs/codebase-guide.md`** (repair workflow, text overlay,
> referral, trial flow, test models, Grok-vs-Gemini comparison, etc.). Read the relevant
> section there before touching that code path. This file stays lean so it loads fast every session.

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact**: Changes should only touch what's necessary. Avoid introducing bugs.

## Memory Safety (16GB System)

This machine has only 16GB RAM. **NEVER run 3D mesh generation or large ML models locally** (TRELLIS,
TripoSG, Hunyuan3D, trimesh heavy ops) — they BSOD the system. Always use remote APIs (Tripo3D, HF
Spaces). Before launching any Python script, consider its memory footprint; cap it with
`resource.setrlimit` if a local run is unavoidable. (Full rule in `~/.claude/CLAUDE.md`.)

## Working Principles

### 1. Plan Mode Default
- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
- If something goes sideways, STOP and re-plan immediately - don't keep pushing
- Use plan mode for verification steps, not just building
- Write detailed specs upfront to reduce ambiguity

### 2. Subagent Strategy (keep main context window clean)
- Offload research, exploration, and parallel analysis to subagents
- For complex problems, throw more compute at it via subagents
- One task per subagent for focused execution

### 3. Self-Improvement Loop
- After ANY correction from the user: update `tasks/lessons.md` with the pattern
- Write rules for yourself that prevent the same mistake
- Ruthlessly iterate on these lessons until mistake rate drops
- Review lessons at session start for relevant project

### 4. Verification Before Done
- Never mark a task complete without proving it works
- Diff behavior between main and your changes when relevant
- Ask yourself: "Would a staff engineer approve this?"
- Run tests, check logs, demonstrate correctness

### 5. Demand Elegance (Balanced)
- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution"
- Skip this for simple, obvious fixes - don't over-engineer
- Challenge your own work before presenting it

### 6. Autonomous Bug Fixing — ENFORCED by the pre-push gate
- When given a bug report: just fix it. Don't ask for hand-holding
- Point at logs, errors, failing tests -> then resolve them
- Zero context switching required from the user
- Go fix failing CI tests without being told how
- **A CLEAR bug (owner-reported, or reproduced from stored evidence) goes into
  `tasks/bugs.json` the moment it is confirmed — and `check-open-bugs.js` in the
  pre-push hook BLOCKS every push while any entry is open.** Fix it now, flip
  its entry to `"fixed"` (with the commit hash) in the same commit. Only clear
  bugs belong in the registry — design questions and improvements stay on the
  task list. Emergency escape: `PUSH_WITH_OPEN_BUGS=1 git push` (defers, never
  dismisses).

## Task Management

**`tasks/BACKLOG.md` is the single index of open work — read it at session start, and add to
it the moment you find something.** One line per item with a `→ file:line` pointer; the detail
stays in the source document. Closing an item means ticking it in BOTH places. This exists
because open items used to be written into whatever doc a session happened to be editing:
a 2026-08-20 sweep found ~184 live items across ~40 files, and a backlog was lost outright when
`tasks/todo.md` — untracked, and used as a shared scratch filename by every session — was
overwritten. `check-backlog-index.js` warns at push time (never blocks) when a file gains open
items the index does not point at.

Which file does a new item go in?
- **A clear, reproduced bug** → `tasks/bugs.json`. It blocks every push while open. Fix it now.
- **A behaviour change that needs a story run to prove it** → an entry in `tasks/verify.json`
  (claim, runShape, check) in the same push — gate 4b blocks otherwise (`Verify: none (<reason>)` /
  `Verify: <id>` trailers are the escape). **After EVERY verification run: `node scripts/admin/verify-run.js <storyId> --write`
  and commit `tasks/verify.json`** — CONFIRMED/FAILED become evidence + status, HUMAN/NOT COVERED stay pending with a
  `lastChecked` pointer; a FAILED gets a BACKLOG line. The pre-push hook warns while a staging run is unrecorded.
- **Anything else open** (improvement, unbuilt feature, unrun experiment, deferred decision)
  → a line in `tasks/BACKLOG.md`, plus the detail wherever it belongs.
- **A plan for the work you are doing right now** → `tasks/<topic>-<date>.md`, never the bare
  `todo.md`, and index it. Two sessions both writing `todo.md` destroy each other's notes.
- **Superseded material** → `docs/archive/` (see its README). Sweeps skip that directory.

1. **Plan First**: Write the plan to `tasks/<topic>-<date>.md` with checkable items
2. **Verify Plan**: Check in before starting implementation
3. **Track Progress**: Mark items complete as you go, in the plan AND in `tasks/BACKLOG.md`
4. **Explain Changes**: High-level summary at each step
5. **Document Results**: Add a review to the plan file
6. **Capture Lessons**: Update `tasks/lessons.md` after corrections

## Important Rules

- **Confirm the issue is real before fixing anything — and never fix what wasn't asked.** Before touching code for a "problem" you noticed yourself, first verify it actually exists from stored evidence (DB rows, logs, a reproduction) and report it; the deliverable is the finding, not an unrequested fix. If a fix has meaningfully different options (scope, approach, which file), list them and stop — use `AskUserQuestion`, don't pick and ship.

- **Paid API calls need a mandate and a cap.** Every Grok/Gemini/Anthropic/Runware/OpenRouter call and every story generation costs real money. Rules:
  1. Paid calls are allowed only as part of a task the user actually assigned — never for a side-quest Claude invented.
  2. Within an assigned task, individual calls under ~CHF 0.50 are fine without asking; anything bigger (showcases, full story runs, batch experiments) needs explicit permission or a spend cap the user stated for THIS task.
  3. **Burn-loop hard stop:** if two paid attempts at the same thing fail, or you suspect the approach is off track, STOP — no third paid retry. Report what happened, list the options, and wait. Ten repeats of a 50-cent call while off track is exactly the failure mode this rule exists to prevent.
  4. A spend cap authorizes the task it was given for, nothing else. New idea → new ask.

- **NEVER push to `master` without explicit per-push approval — even for "safe" changes.** Every push to `master` auto-deploys to production. Each prod deploy (a) **kills any in-flight story generation** (real users mid-creation lose their work) AND (b) causes brief downtime. "Functionally safe", "additive", "backward-compatible", "trivial typo fix" are NOT valid reasons to skip the approval step — they all have the same downtime + in-flight-job cost. The mandatory flow for ANY change:
  1. `git push origin master:staging` (or push to your feature branch + PR-merge into staging)
  2. Verify on `https://staging.magicalstory.ch` — page loads, smoke test the affected area
  3. **Ask the user explicitly: "OK to push to master?"**
  4. Only after an explicit yes (not silence, not "looks good", not "ship it" from earlier in the conversation about a different change): `git push origin master`

  Even when the user said "push" earlier in the session for an unrelated commit, that authorization does NOT carry forward. Every prod push is its own approval moment. When in doubt, push staging only and wait.

- **Pushes are gated on the target environment being idle.** `.githooks/pre-push` asks
  `GET /api/health/busy` (staging for `staging`, production for `master`) and refuses the
  push while a story generation or Test Lab experiment is running — a deploy restarts the
  container and kills it. When it lets a push through, it first flags the environment
  "deploy pending" (`POST /api/admin/deploy-pending`) so the Test Lab refuses new runs
  until the new commit boots — a failure to set the flag blocks the push. **Enabled automatically by `npm install`** (`prepare` →
  `scripts/admin/setup-git-hooks.js`); run that script directly if you skipped install.
  It sets `core.hooksPath` to an ABSOLUTE path deliberately — a relative one is resolved
  per working tree, so an agent worktree on a branch older than the hook has no
  `.githooks/pre-push`, and **git skips a missing hook silently**. That is exactly how a
  push killed a running Test Lab experiment on 2026-08-05.
  If it blocks you, **wait** — `--no-verify` is only for a run you are willing to destroy,
  and on `master` that means a real user's paid generation. Never disable the hook to get
  a push through. Check status any time with `node scripts/admin/check-push-idle.js`
  (`docs/decisions.md`, 2026-08-04 entry).
- **Ask if unclear.** If there are different implementation options, ask rather than assuming.
- **Eval logic: classification belongs to the PROMPT, code may only change a severity. Ask before coding either.** When a class of finding is mis-handled, the fix is a **type** in the evaluator prompts plus, if needed, a **ceiling** on what that type may cost (`ZERO_POINT_TYPES` / `MAX_SEVERITY_TYPES` in `server/lib/scoring.js`). NEVER pattern-match a finding's description text in code to work out what it means — recognising "clothing" or "a left/right mirror" in prose does not generalise past the story you tuned it on. A regex mirror-guard was built and removed the same day (2026-08-09) once the prompt-side fix alone produced zero mirror findings. Prompt-vs-code is the owner's call: propose the shape and ask BEFORE writing it.
- **Interview the user with `AskUserQuestion` — never decide direction for them.** When the user surfaces a problem with multiple valid resolutions (different scopes, different trade-offs, different "which file to touch" choices, "revert vs adjust vs leave alone"), STOP and ask via `AskUserQuestion` with 2-4 framed options + their trade-offs. Do NOT pick the option you think makes sense and "just ship it" with a "let me know if you want differently" tail. Do NOT bury the choice in prose ("Want me to do X? Or Y?") — that loses framing, hides trade-offs, and ends up as a slow back-and-forth. Use the actual question tool with explicit options. Exception: the "default to the proper fix" rule above (clean root-cause vs hacky shortcut) — there you don't ask, you ship proper. Every other choice → interview.
- **NO FALLBACKS. Build the proper thing and let it fail loudly.** Do not keep an old
  implementation alive "as the fallback" when a new one replaces it, do not add a second code
  path for when the first one does not answer, do not silently degrade to previous behaviour.
  Two implementations of the same thing means they drift, the weaker one hides the failures of
  the stronger one, and nobody ever finds out the new path is broken because the old one quietly
  covers for it. When a required input is missing or a call fails: log an error and stop that
  piece of work — no output is correct, a quietly-worse output is not. Replacing a mechanism
  means DELETING it, not demoting it. If some path genuinely cannot be migrated (stored data in
  an old shape, an external contract), say so explicitly as a constraint and ask — never assume a
  fallback is wanted.

- **Default to the proper fix — never offer "quick workaround vs proper" as a choice.** When a bug has a clean root-cause fix and a hacky shortcut, silently pick proper and ship it. Don't ask which one to do. Workarounds contaminate the codebase (rotation entries get permanently mangled to dodge a spec bug, code paths get one-off skips, etc.) and waste the user's time on a vote whose answer is always "proper". Only mention the shortcut if the proper fix isn't viable for a real reason (would take days, breaks a contract) — and then frame it as a constraint, not a choice.
- **Unified mode is primary.** All new features and developer options must work in unified mode (the default story generation mode). Don't implement features only for legacy modes (pictureBook, outlineAndText) - unified mode is the mode the user wants to use.
- **Action button styling MUST be identical across rows.** When adding or modifying any button in an action button row (e.g. the StoryDisplay top/bottom action bars: Buch erstellen, PDF herunterladen, Geschichte ansehen, Neue Geschichte), copy the EXACT className from a sibling button. Never invent new gradient/padding/text-size combos for "this one special CTA" — they all share the row, they all look the same. The standard for `StoryDisplay` action buttons is: `bg-indigo-500 text-white px-3 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 hover:bg-indigo-600` with icon `size={16}`. If you find yourself writing different styling for one button in a row, STOP — copy the sibling instead.
- **Prompts must stay generic — no story-specific examples.** When writing or editing anything in `prompts/*.txt` or prompt builders, never embed names, characters, settings, or plotlines from a specific test story (e.g. "Gessler's soldiers", "Manuel", "Altdorf square"). The prompts run on every story — a Wilhelm Tell reference leaks into an unrelated unicorn story. Use archetypal examples only: "the main character", "a guard", "N soldiers surrounding the hero", "a marketplace crowd". Same rule for bug-fix wording: don't write "Lukas sat on the right" into a rule; write "if a character's outline position is on the forbidden side". If you can read the prompt and tell which test story it came from, rewrite it.
- **A fix must reach every sibling of the path it fixes — `scripts/admin/sibling-registry.json` says which.** 27 of 173 behaviour commits in one 60-hour window were partial fixes that landed on one code or prompt path and not its sibling (per-page vs all-pages Art Director template, trial vs unified writer, lector vs diff pass, Lab vs prod, cover vs page). Run `node scripts/admin/check-sibling-paths.js --list` before declaring a fix done, and add a set the moment you find a pair the registry does not know. Pre-push gate 9 blocks a commit that moves one side only; the escape is `Siblings-Checked: <reason>` in the commit message. Explainer: `docs/sibling-paths.md`. The same registry enforces generator↔critic pairs (`axis: generator-vs-critic`): a rule a judge can deduct for is a rule the generator was given — prefer one JS constant injected into both templates, and see the `syncing-generator-and-critic` skill before editing any evaluator prompt.

- **Read `docs/SETTLED.md` before editing prompts, eval rules, model routing, or pipeline behavior — reversing a settled verdict has a protocol.** That file is the one-page index of decisions that historically flip-flopped (A → B → back to A). Reversing any line on it requires ALL of: (1) explicit user sign-off via `AskUserQuestion`, framed as a reversal; (2) evidence — a Test Lab experiment ID or ≥3 pages/stories showing the current rule failing (one motivating page is never enough); (3) a superseding `docs/decisions.md` entry citing that evidence; (4) updating the SETTLED.md line. String-detectable verdicts are enforced by `scripts/admin/check-settled.js` in the pre-push hook — if it blocks you, that's the flip-flop guard working, not an obstacle to route around.

- **Check memory before recommending vendors, models, or technologies.** Every time you're about to suggest a specific API, model, library, or external service as a solution, FIRST read the relevant memory files (especially `project_image_model_tests.md`, `project_lora_investigation.md`, `project_image_pipeline_ideas.md`). Past experiments have usually already been done — don't recommend something that's already been rejected. If you make a recommendation based on tested experience, log the verdict in the matching project memory so future sessions don't waste the user's time re-litigating it.
- **Read `docs/image-routing.md` before any image-gen ROUTING decision (which model, direct vs composite, which pass).** It's the single decision map: task → method/model → verdict → which Test Lab stage re-tests it. It exists so we stop re-deriving and flipping back and forth — link back to the Test Lab stage instead of re-scripting an experiment. **Update it after every experiment** (add the verdict + the stage that reproduces it). It routes to the deep sources below.
- **Read `docs/image-generation-methods.html` before touching any image-generation code path.** It's the inventory of every entry function (`editWithGrok`, `generateImageWithQualityRetry`, `repairCharacterMismatchWithGrok`, etc.), which provider each one dispatches to, the by-task lookup ("I'm working on X — which function do I call?"), the aspect-ratio behaviour quirks per provider (especially Grok edit's input-aspect coercion), and the rejected-approach log. Any new image-gen feature or refactor: read this first, and update it in the same PR.
- **Lab findings, decisions, and SETTLED are one system with directional flow.** The Lab's eval-findings registry holds raw measured findings (evidence); a `docs/decisions.md` entry born from a Lab run MUST cite its experiment/registry IDs; a registry finding that changes behavior gets a decisions.md entry (otherwise it's just data); the re-litigated ones get a SETTLED.md line. Measured facts live in the repo where agents can see them — never only in the registry or only in memory files.
- **Log decisions and verdicts — don't rely on human memory.** When a technology, vendor, parameter, or approach is tried and evaluated, write the verdict (✅ kept / ❌ rejected / 🟡 conditional) plus a one-line reason into a project memory file. The only place "we tried FLUX Dev and it's unusable" belongs is a memory file — not in someone's head or buried in a commit message.
- **Log every architectural decision in `docs/decisions.md`.** Not just tried-and-rejected tech — also deliberate design choices, mode-specific shortcuts ("trial skips X to be fast"), and "we omit Y because Z". If the answer to "why does the code do this" lives only in someone's head, a commit message, or a single inline comment, log it. Triggers that mean a decision needs an entry: writing `// we deliberately skip…` / `// by design…` / `// intentionally omit…` in code; choosing a different path for trial / dev / admin mode; disabling a feature for speed or cost; setting a non-obvious threshold; suppressing a downstream warning. Each entry: **Context / Decision / Rationale / Touched files**. **Read `docs/decisions.md` before diagnosing any warning** — a warning about something "missing" may be a logging bug because the thing is missing on purpose.
- **Run the cheapest real exercise of the code before you push — a unit test is not validation.** A behaviour change that has never executed against real data is unproven, however green the suite is. Before pushing, run the cheapest rung of this ladder that actually exercises the changed path, and say in your report which rung you used: (1) replay the derivation over STORED rows/prompts/images — free, and enough for most eval, scoring and parser changes; (2) a Test Lab stage on a stored story — cents, and the right rung for prompt and routing changes; (3) a 4-page smoke story on `demo-b-hnecf@magicalstory.ch`; (4) a full showcase — last resort only (`running-validation-stories`). **Under ~CHF 0.50 and a few minutes counts as cheap: if it is cheap, it is not optional.** If nothing cheap exercises the change, say so explicitly — "not validated, and here is why" is an acceptable report; silence is not. Every story run you do or read ends with `node scripts/admin/verify-run.js <storyId> --write` and a commit of `tasks/verify.json` (running-validation-stories skill). Measured 2026-09-19: ~130 commits reached staging in one session with zero story validation, and a cross-page scale check was written, unit-tested, documented and shipped without ever being run once against a real story — its multi-call research protocol was mistaken for production behaviour precisely because nobody executed the shipped version.

- **IRON RULE — retest on stored data, never run a new story to test a fix (owner, 2026-10-09).** A fix or prompt change is tested by re-running the ONE changed stage on EXISTING stories: replay the real builder/check over stored rows, prompts and inventories (`eval_calls` holds the raw judge/inventory answers), or call the real prompt function in the console / a Test Lab stage on stored pages. Test over a SET — at least 20 cases, positives AND clean negatives — and report a rate, never one example. **A single defect instance and a single rerun without it prove nothing** (a 6% defect is absent from most single stories). A new story or trial run is an integration check only, allowed after **20 successful stage/feature tests** since the last story run, never to prove one fix. Before any paid call, state the price and keep one running total per task, agents' spend included; an agent gets a hard cap and stops at it. Measured 2026-10-09: about USD 27.50 spent, much of it on story and trial reruns that proved single cases, while the stored-data replays (gaze, parent check, place names) ran in minutes, mostly free, and gave rates over dozens of cases.
- **Never assume — check.** When diagnosing a pipeline bug, always pull the actual stored data (DB row, log line, cached image, prompt sent to the model) before proposing a fix. Do not speculate about what "probably" happened at a prior stage. The evidence is always retrievable: scene metadata in `story_images` / `stories.data`, consolidator audit records, retry history, Railway logs. If you catch yourself writing "probably" or "must have" about pipeline state, stop and query the source.

## Showcase command

"Run a (new) showcase story" and its variants → the `running-showcases` skill. A showcase is the LAST resort for validation (running-validation-stories ladder first); never run one unprompted.

## Folder Organization Rules

**Do NOT create files in the project root** unless they are core config files. Use the organized folder structure:

| Content Type | Location | Examples |
|--------------|----------|----------|
| Admin/utility scripts | `scripts/admin/` | check-users.js, setup-admin.js |
| Analysis scripts | `scripts/analysis/` | compare-faces.js |
| Other scripts | `scripts/` | download-photos.js |
| Manual test scripts | `tests/manual/` | test-*.js, test_*.py |
| E2E tests | `tests/e2e/` | Playwright tests |
| Test fixtures/images | `tests/fixtures/` | (gitignored) |
| Documentation | `docs/` | *.md files (except README.md, CLAUDE.md) |
| AI prompts | `prompts/` | *.txt prompt templates |

**NEVER commit to git:**
- Test output images (test-*.png, test-*.jpg)
- Temp files (tmpclaude-*, temp_photos/)
- Large data files (*.tflite, baden-landmarks/)

**Core files that stay in root:** server.js, storyJobPipeline.js, email.js, photo_analyzer.py, package.json, README.md, CLAUDE.md

## Build & Development Commands

```bash
# Install all dependencies
npm install && cd client && npm install && cd ..
pip install -r requirements.txt   # Python dependencies for photo processing

# Development (THREE terminals for full local setup)
npm run dev            # Terminal 1: Backend on :3000
npm run dev:client     # Terminal 2: Frontend on :5173
npm run dev:python     # Terminal 3: Python photo analyzer on :5000

# Build frontend for production
cd client && npm run build     # Outputs to /dist

# Deploy to staging (auto-deploys from `staging` branch)
git push origin staging

# Deploy to production (auto-deploys from `master` branch)
# Standard flow: merge staging → master, push.
git checkout master && git merge staging && git push origin master

# View Railway logs (current environment, set via `railway environment`)
railway logs
```

**Branch / deploy flow:**
- `feature/X` → PR → `staging` → smoke-test on staging.magicalstory.ch → `master` (prod).
- Hotfixes can push direct to `master` but should be the exception.

### Python Photo Analyzer Service

The `photo_analyzer.py` Flask service handles:
- Face detection (MediaPipe/MTCNN)
- Background removal (rembg/U2-Net)

**Must be running on port 5000 for photo upload to work locally.**

### Pre-deployment Testing Workflow

When user says **"run tests"** or **"test before deploy"**:

1. Start local servers in background
2. Run `npm run test:local`
3. Report results (all tests should pass)
4. If all pass, ask if user wants to deploy

Tests check: homepage images, character photos, API health, auth, no JS errors, no 404s, wizard navigation.

## Architecture Overview

### AI Service Providers
| Service | Provider | Purpose |
|---------|----------|---------|
| Text Generation | Claude (Anthropic) | Story outline, text, scene descriptions |
| Image Generation | Gemini (Google) + Grok (xAI) | Page illustrations, covers, avatars |
| Character Repair | Grok Imagine (xAI) | Cutout + blended character repair ($0.02/img) |
| Cheap Images | Runware | Dev mode, inpainting (SDXL $0.002/img) |
| Avatar Faces | Grok Imagine (xAI) | Clothing + costumed avatars: both passes (identity sheet + style transfer) default to Grok (env `AVATAR_STYLE_BACKEND`). Grok is the default because it is CHEAPER ($0.02 vs $0.04) — that is the routing reason, nothing else. Gemini stays as the fallback and works for most requests; its `IMAGE_OTHER` safety refusal (no image returned) triggers on a COMBINATION of factors — clothing, art style, age, and similar — so an occasional request is refused unpredictably. A refusal must fail loudly, never ship an empty page. Full history + rationale: `docs/decisions.md` → "Avatar style transfer (pass-2) uses Grok, not Gemini" and the avatar-guarantee entry. |
| Face Detection | Python service (MediaPipe/Haar) | Cascade face detection for illustrations |

### Story Generation Pipeline (Unified Mode)
Beats is the pipeline in EVERY environment (trials excepted — always unified). The value is a code
constant in `server/config/runtime.js`, which is also where every other behavioural setting lives:
behaviour is code, only secrets are env vars. `GET /api/health/config` reports what an environment
is actually running.

```
POST /api/jobs/create-story → Background Job:
  1. Generate full story: writer call (outline + visual bible + text + scene hints; arc→scenes→text order) + separate review call (analysis + fixes; SPLIT_OUTLINE_REVIEW gate; reviewer model set in server/config/models.js — currently DeepSeek V4 Pro, was Opus)
  2. Parse scenes, expand each into Art Director prose (scene-expansion.txt)
     → Each scene gets: character descriptions, interactions, textPosition, emptyScenePrompt
  3. Generate empty scene backgrounds (style anchors for iterative placement)
  4. Generate page images (Grok/Gemini, parallel) with VB grid references
  5. Text region detection + white wash (calmness map → lighten calm area for text)
  6. Quality eval + semantic eval + entity consistency (parallel)
  7. Auto-repair: redo low-scoring pages (up to 3 passes)
  8. Character repair: cutout/blended fix for mismatched characters (Grok)
  9. Pick best versions per page
  10. Generate covers (front, initial/dedication, back)
  → GET /api/jobs/:id/status (polling)
```

### Subsystem deep-dives → `docs/codebase-guide.md`

These detailed sections were moved out of CLAUDE.md to keep it lean. Read the matching one
before touching that code:

- **Repair Workflow (Post-Generation)** — scoring model, pass loop, repair methods, endpoints, key files
- **Text Overlay System** — calmness detection, white wash, spread rules (also `docs/text-overlay.html`)
- **Referral / Promo Code System** — codes, discounts, credits, key files
- **Shared Story Viewer — Book Spread** — desktop two-page layout
- **Preset-Aligned Cutout Extract** — `computePresetAlignedExtract()` algorithm
- **Entity Consistency Improvements** — cascade face merge, coordinate normalization
- **Centralized Aspect Ratio** — `MODEL_DEFAULTS.pageAspect` / `coverAspect` / `avatarAspect`
- **Admin Trial Bypass** — repeated `/try` testing for admins
- **Trial Flow — Prewarm + PATCH Sync** — prewarm, trait cache, consent, deferred email, the one-trial-per-user hard cap, per-cache-scope avatar logs, avatar eval thresholds, and other trial plumbing
- **Test Models (Dev Mode)** — side-by-side model comparison, iterative placement, style transfer
- **Image Model Comparison (Grok vs Gemini)** — strengths, when-to-use, Grok prompting tips

**Landmark database → `docs/landmark-database.md`** (its own file, not in the guide). Read it
before touching `server/lib/landmarkPhotos.js`, the `landmark_index` /
`landmark_photo_scores` tables, or any `scripts/admin/*landmark*` tool: schema, the
three-level place model, class/fame/judged-score ranking, the two-score + framing judging
model, the serving fallback ladder, and the **user-reachable auto-index trigger** that spawns
paid background indexing. Location→story flow (IP, Nominatim, VB injection) stays in
`docs/landmarks.html`.

### Key Backend Files
- `storyJobPipeline.js` is root-level on purpose: its inline `require('./server/lib/...')` paths must stay verbatim-valid.

## Model Configuration

Models are configured in `server/config/models.js`. Frontend can override via developer mode.
Grok-vs-Gemini strengths and prompting tips → `docs/codebase-guide.md`.

**Important model notes:**
- `gemini-2.5-flash` is required for quality evaluation (spatial reasoning for fix_targets)
- `gemini-2.0-flash` cannot return bounding boxes for auto-repair
- Runware has 3000 char prompt limit (vs 30000 for Gemini)
- ACE++ uses `referenceImages` at root level, not inside `acePlusPlus` object

## Prompt Templates

All prompts are in `/prompts/*.txt` and loaded via `server/services/prompts.js`.
**Full inventory of all ~72 templates (consumer + stage + hardcoded JS prompts) → `docs/prompt-inventory.md`** — keep it updated when adding/renaming a template. Most-touched ones:
- `scene-expansion.txt` - Art Director: expands outline hints into illustration briefs (includes interactions, textPosition, emptyScenePrompt)
- `image-generation.txt` - Scene illustration prompt (unified template, includes COPY SPACE instruction)
- `image-evaluation.txt` - Quality evaluation criteria (includes declared interactions check)
- `image-semantic.txt` - Semantic fidelity evaluation (includes interactions placement check)
- `empty-scene.txt` - Background-only scene generation (for iterative placement)
- `avatar-main-prompt.txt` - Gemini avatar generation
- `avatar-ace-prompt.txt` - Runware ACE++ avatars
- `character-repair-cutout.txt` - Grok cutout repair prompt
- `character-repair-blended.txt` - Grok blended repair prompt
- `bbox-refine.txt` - Bounding box refinement (2-pass detection)
- `cover-composition.txt` - Cover generation. NOTE: the former `front-cover.txt` / `back-cover.txt` / `initial-page-*.txt` templates no longer exist; covers are assembled from the outline's structured cover hint in JS (`buildCoverSceneFromHint`, `server/lib/coverIterate.js`) plus this template.

**Note**: `image-generation.txt` is the single image-prompt template. Legacy `image-generation-storybook.txt` was merged into it, and the per-language (`-de`, `-fr`) plus `-sequential` variants were deleted along with the `isStorybook` / `isSequential` flags on `buildImagePrompt()` — unified mode is the only generation pipeline.

## Admin API auth (for scripts, agents, Test Lab, smoke stories)

Any script or agent that needs an admin Bearer token — Test Lab runs, `/api/admin/*`, 4-page smoke/validation stories — gets it ONE way:

```bash
TOKEN=$(node scripts/admin/get-admin-token.js)                    # staging (default)
TOKEN=$(node scripts/admin/get-admin-token.js --base=https://magicalstory.ch)  # prod
curl -H "Authorization: Bearer $TOKEN" https://staging.magicalstory.ch/api/admin/...
```

It logs in as the admin smoke-test account (`demo-b-hnecf@magicalstory.ch`; overrides via `TESTLAB_USER`/`TESTLAB_PASSWORD` env). Two facts agents keep getting wrong: (1) the staging Basic-auth gate (`STAGING_AUTH_USER/PASSWORD` in `.env`) protects HTML/static ONLY — `/api/*` needs just the Bearer token; (2) don't hand-roll a login flow or hunt for credentials — the helper is the canonical path. Runners that already embed this flow: `scripts/admin/run-testlab-set.js`, `scripts/test-scene-composite-smoke.js`.

## Log Analysis

"Analyze log" / "check the log" / "analyze story run" → the `analyzing-story-logs` skill.

## Timezone — Swiss local ONLY, via `scripts/lib/chTime.js` (settled 2026-08-09)

**Every timestamp shown to the user — in scripts and in replies — is Swiss local time, marked `CH`. UTC is never shown, and no timezone arithmetic is ever done by hand.** Format via the helper: `ch(d)` → `2026-07-30 22:01:15 CH`, `chTime(d)` → `22:01:15 CH`. `Intl`/`Europe/Zurich` handles DST. (This supersedes the May-2026 UTC-only rule, which superseded dual-labeling — see docs/SETTLED.md; a third reversal needs the full protocol.)

Three timestamp behaviors exist; pick the right entry point:
- **Railway logs / ISO strings with Z**: true UTC → `ch()` directly.
- **Naive Postgres `TIMESTAMP` columns via node-pg**: the driver parses the stored-UTC wall clock as LOCAL — rehome with `fromPgNaive(d)` FIRST, then format (skipping this double-shifts; the trap once killed two live Test Lab runs via client-side age math — or compute ages in SQL).
- **Browser-rendered admin pages**: already local; leave alone.

When searching logs for a time the user named, convert silently in code (Swiss → UTC) — never narrate the conversion, never show the UTC value in the reply.
