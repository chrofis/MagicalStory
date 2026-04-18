# Demo Story Generation

Playwright-driven generator that creates real, diverse demo stories for the homepage. Each test run picks the next entry from a rotation list and drives the full UI wizard end-to-end. Use it for two purposes:

1. **Smoke-test the wizard** — every run walks Step 1 → Step 5 in a real browser against a real backend.
2. **Generate gallery content** — the resulting stories sit in the demo accounts and can be surfaced on the homepage.

## What rotates

Each entry in `tests/helpers/demo-rotation.ts` (`DemoRotationEntry`) crosses four axes:

| Axis | Source |
|------|--------|
| `familyId` | One of `berger` / `miller` / `dubois` (demo account per family) |
| `language` | `de` / `en` / `fr` — language passed via `?lang=…` URL param |
| `storyCategory` + `storyTopic` | Topic & category id; matched to UI label by regex |
| `artStyle` | Art style id; resolved to a per-language label |

The current rotation has 18 entries (~6 per family, full art-style + topic spread).

## Demo accounts

Three demo users, one per family, holding only that family's characters and photos:

| Family | Email | Characters |
|--------|-------|------------|
| Berger (DE) | `demo@magicalstory.ch` | Emma 5, Noah 7, Daniel 38, Sarah 36 |
| Miller (EN) | `demo-miller@magicalstory.ch` | Lily 6, Ethan 9, James 42, Aisha 40 |
| Dubois (FR) | `demo-dubois@magicalstory.ch` | Léa 4, Hugo 8, Marc 36, Élodie 34 |

All three accounts share a single password (`DemoStory2026!` by default; override with `DEMO_PASSWORD`).

The single source of truth for both the test helpers AND the admin scripts is `tests/helpers/demo-families.json`. Edit family data there — both sides pick it up.

## Setup (one-time per environment)

```bash
# 1. Create all three demo users (idempotent — safe to re-run)
node scripts/admin/setup-demo-user.js
# Or just one: node scripts/admin/setup-demo-user.js --family=miller

# 2. Generate Gemini photo-realistic portraits and upload as character photos
node scripts/admin/generate-demo-photos.js
# Or just one: node scripts/admin/generate-demo-photos.js --family=miller
# Also save JPEGs to disk for inspection (gitignored — local only):
#   node scripts/admin/generate-demo-photos.js --save-to=true
# Inspect-only (no upload):
#   node scripts/admin/generate-demo-photos.js --save-to=true --no-upload

# 3. (If credits get low) Top up via SQL
#    UPDATE users SET credits = -1 WHERE email IN (
#      'demo@magicalstory.ch','demo-miller@magicalstory.ch','demo-dubois@magicalstory.ch');
```

`TEST_BASE_URL=http://localhost:5173` switches both scripts (and the test) to local servers.

## Running

```bash
# Production, next entry from rotation state
npm run test:demo

# Local backend
npm run test:demo:local

# Visible browser (debug)
npm run test:demo:headed

# Force a specific entry (does NOT advance rotation state)
DEMO_ENTRY_INDEX=7 npm run test:demo
```

`DEMO_ENTRY_INDEX` is the index into `DEMO_ROTATION` — useful for debugging a specific
family/language/topic combination without burning credits on entries you didn't want.

## Pipeline

```
preSeedLanguage(?lang=…)  →  loginAs(family.email)  →  /create?new=true&lang=…
   ↓
Step 1: verify all 4 family characters render → click main on first 2 if needed
Step 2: set page count (slider → 14)
Step 3: pick category → pick topic (regex matches DE/EN/FR labels)
Step 4: pick art style (per-language label table)
Step 5: wait for ideas → "Use this" → "Generate Story"
   ↓
Test asserts no JS errors, advances rotation state, exits.
Story generation runs in the background on the server (5–10 min).
```

The test only verifies that **generation was triggered** — not that it completed. Job
completion / image quality is the server's responsibility and is observable via Railway
logs or the user's "My Stories" page.

## Key files

| File | Purpose |
|------|---------|
| `tests/helpers/demo-families.json` | Source of truth: families × characters × photo prompts |
| `tests/helpers/demo-characters.ts` | Typed loader, family lookups, back-compat exports |
| `tests/helpers/demo-rotation.ts` | The rotation list (`DemoRotationEntry[]`) |
| `tests/demo-story.spec.ts` | The Playwright spec — single test that runs one entry |
| `tests/demo-rotation-state.json` | Persists `currentIndex` between runs |
| `scripts/admin/setup-demo-user.js` | Create demo users + characters via API |
| `scripts/admin/generate-demo-photos.js` | Generate Gemini portraits + upload as photos |

## Future work (not yet wired)

- **Scheduled run** — call `npm run test:demo` from a cron/CI on a fixed cadence so the
  homepage gallery stays fresh. Right now it's manual.
- **Completion gate** — extend the test to poll `/api/jobs/:id/status` after triggering,
  so a single run also gives us a pass/fail signal on the full pipeline (currently only
  the wizard flow is asserted).
- **Homepage surfacing** — decide which demo stories to feature on the landing page (e.g.
  by share-token-pinning the most recent N completed jobs per language).
- **Art-style-only gallery** — one fixed scene rendered in all 13 styles for a
  side-by-side style comparison page.
