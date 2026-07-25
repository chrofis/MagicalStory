# Full Code Review — 2026-07-25

> Deep review of the entire codebase, run in parallel waves by subsystem.
> Findings are recorded per area with severity, file:line evidence, and a
> proposed fix direction. Verified findings are marked; unverified ones are
> hypotheses from a single reviewer pass.
>
> Severity scale: **P0** data loss / security / money — fix now · **P1** real
> user-visible bug · **P2** correctness edge case / robustness · **P3** code
> health, perf, maintainability.

## Status

- [ ] Wave 1 — backend core (security, payments, pipeline, images, entity, text/PDF, regeneration, avatars/trial)
- [ ] Wave 2 — client, DB layer, prompts↔parsers, providers, python analyzer, composites, email/sharing
- [ ] Wave 3 — adversarial verification of P0/P1 findings + synthesis
- [ ] Final summary + ranked fix list

## Scope inventory

| Area | ~Lines | Files |
|---|---|---|
| server.js (monolith) | 8,280 | server.js |
| server/lib | 65,145 | images.js (17k), storyHelpers (6k), entityConsistency (3k), … |
| server/routes | 25,002 | regeneration (6.2k), stories (3.8k), avatars (3.6k), trial (2.7k), print (2.1k), … |
| server services/config | 8,456 | database.js (3.2k), models.js, prompts.js, middleware |
| client/src | 73,746 | StoryWizard (6.2k), StoryDisplay (7k), AdminDashboard (2k), … |
| prompts | 71 templates | |
| python | 3,439 | photo_analyzer.py |
| email | 1,108 | email.js |

---

## Findings

(populated per wave below)
