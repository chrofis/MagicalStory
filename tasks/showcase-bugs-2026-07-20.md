# Showcase bug tracker — staging realistic run (2026-07-20)

Story: **"Emma und das Steinchen vom Fluss"** — 10 pages, realistic, Berger family.
Account: demo-b-hpgr3@magicalstory.ch (staging, userId dd0d192a, job_1784495870765_g66n5qps2)

## A. Cover typography

- [x] **A1 — Front title GARBLED on long titles.** `fitRender` measured on a bare W×H
      canvas → resvg clipped overflowing edge letters before `inkBBox` saw them
      ("Emma und das"→"mma und da"). FIX: pad measurement canvas (coverTypography.js).
      Verified locally. **Uncommitted.**
- [x] **A2 — Top third not reserved for title.** Figures fill the frame (feet fix pushed
      heads up) → `bestRect` dropped title low-left. FIX: hardened `front-cover.txt`
      top-third instruction (user chose prompt-harden). **Uncommitted.**
- [x] **A3 — Back-cover "magicalstory.ch" UNRELIABLE (3/4 missing, 1 double)** — CLOSED
      2026-09-06 (c0d594a75): cover templates retired, so branding is no longer model-rendered —
      `coverTypography.js:140` `BRAND_TEXT` is composited deterministically in the back path
      (`:530-538`); font rotation 1e1fd0782. Original finding: two bakers
      both run: `applyCoverTypography` (server.js:6591) + `bakeCoverTypographyPostPersist`
      (server.js:7021); post-persist idempotency guard checks a `${key}Art` row that
      applyCoverTypography never creates → can't tell it's already branded → double; and it
      doesn't run / misses the active version on others → missing. FIX: single reliable baker.
      **← NEXT (user: finish back-brand first).**

## B. Figure detection / repair — local GroundingDINO blowouts (staging)

Staging uses local DINO (`FIGURE_DETECTION_BACKEND=grounding-dino`); prod uses Gemini.
DINO is producing bad boxes across MANY figures/pages on this story → repair can't target.

- [ ] **B1 — Sarah, initialPage:** bodyBox 69%×72% (merged w/ neighbours), faceBox mislocated
      to her legs (y=0.70–0.91) → face repair fails.
- [ ] **B2 — Sarah, page 2:** fails same as initial page ("fails twice").
- [ ] **B3 — Hans, page 3:** detection fails.
- [ ] **B4 — Noah, page 9:** detection fails.
- [x] **B5 — Noah + Emma, page 10:** both fail.
- [x] **FIXED (2026-07-20, agent-verified).** ROOT CAUSE: not DINO — the DINO box is tight
      and accurate. MobileSAM is BOX-prompted per figure and `/figure-mask` UNIONS every mask
      it returns (photo_analyzer.py), so on flat painterly art with touching figures the
      silhouette grabs neighbours/background → `bodyBox = mask bounds` explodes (2.1×–4.2× the
      DINO box; Hans p3 = whole frame). Figures where SAM failed (`samApplied=false`) fell back
      to the tight DINO box and were ALL correct — proving the box is fine, the union mask is
      the culprit. Head/faceBox accurate throughout. FIX (images.js): blown-mask guard —
      `samApplied` det with bodyBox ≥1.6× gdinoBox → re-derive silhouette via POINT-prompted
      MobileSAM from the head point (+ torso point); else drop mask, keep tight gdinoBox.
      Verified: point-prompt collapses each box −57%…−81% to the correct single figure.
      grounding-dino path only; Gemini path untouched. **Committed, needs oil-showcase E2E.**

## C. Content / Visual Bible

- [x] **C1 — "Lena" on page 7 — NOT A BUG.** Lena is a legitimate secondary story character
      (VB characters = ["Frau Meier", "Lena"]: the teacher + a classmate Emma meets:
      «Ich heisse Lena»). outlineCharacters p7 = ["Emma","Lena"] is correct. The
      "missing character" log = the bbox detector couldn't identify her because she has no
      reference avatar (minor invented character, model-rendered, not identity-tracked). Normal.

## D. Needs info

- [ ] **D1 — "Emma on title failed."** Front-cover box data looks fine (bodyBox 38%×60%,
      faceBox up top). Need exact action + result (repair click → error? no change?).
- [ ] **D2 — "Geschichte ansehen" button shows but does nothing.** Button renders in
      StoryDisplay but the click does not navigate/open the viewer. Needs client
      investigation (onClick / share-token / route). Which surface: creator view or shared?

## E. Lab → story path missing rights (likely root of D2 + repair access)

- [ ] **E1 — Lab→story opens as plain admin, missing owner/impersonation rights.** CONFIRMED
      root cause of **D2**: `/api/shared/:token` (sharing.js:139) returns the story only when
      `share_token` matches AND (`is_shared=true` OR requester is owner OR signed link). Owner
      view works; admin-via-Lab (not owner, not shared) → 404 → "Geschichte ansehen" does
      nothing. Likely also blocks figure-repair (write paths gated to owner/impersonator).
      **FIX = deliberate Test Lab Phase 1** (tasks/todo.md): grant `role==='admin'` read access
      on shared/read paths (+ decide which write paths like repair). Security-sensitive perms
      change — **DEFERRED, not patched speculatively (user: "if in doubt don't change code").**

## Content / VB (extra note)

- [ ] **C2 — Lena VB binding is name-only in the prompt.** Lena (CHR002) HAS a generated
      reference image and it's in the page-7 VB grid, but the page prompt doesn't reference
      CHR002 by id — binding relies on name-in-prose + grid cell. Mild consistency gap.

## Done + pushed to staging

- [x] `883a240d` Feet root-cause: 2×4 body cells full-length head-to-feet (verified live — Sarah avatar shod).
- [x] `303d68f4` Cover figure-orientation lever (turned-prompt) + composite feet hardening + 80% fill.
- [x] `26484786` A1 title garbling (fitRender pad) + A3 single-baker brand + A2 top-third prompt.
- [x] `de595857` B-cluster: blown MobileSAM box-mask → point-prompt-from-head guard (grounding-dino only).

## Validation — oil showcase #1 ("Die Lieblingsfarbe von Luca", 10pp, job_1784501408216)

- [x] **Feet ✅** — oil styled avatars full-length; all cover figures shod head-to-toe.
- [x] **Cover typography ✅** — long title "Die Lieblingsfarbe von Luca" baked CLEAN (no garble),
      in the TOP THIRD (prompt hardening worked), single brand; dedication clean. A1/A2/A3 confirmed on oil.
- [x] **Oil render quality ✅** — genuine impasto oil, identity consistent.
- [ ] **Detection guard ❌ DID NOT FIRE on this run.** 5 figures still blown (Hans/Emma p5 2.08×/4.15×,
      p8 UNKNOWNs + Emma up to 16.5×), `blownMaskFixed` absent. Two causes found + fixed:
      (1) **Deploy race** — front cover proves the worker was on 26484786 (cover fixes) but NOT
      de595857 (detection guard); the oil job started right as de595857 was cutting over.
      (2) **Faceless gap** — guard required a paired face, so faceless blown boxes (Emma p8) got no
      fallback. FIXED in `44d0999a`: blown box always corrected (point-sam if head paired, else
      tight gdinoBox); `blownMaskFixed` now surfaced on output so a run is verifiable.
## Validation — oil showcase #2 ("Lena fragt, ob sie ihn anschauen darf", 14pp, job_1784504285382, on drained 44d0999a)

- [x] **Cover typography ✅ (definitive)** — 7-word/2-line title baked CLEAN + complete, top third; back
      cover single "magicalstory.ch" (no double). A1/A2/A3 confirmed on a long title.
- [x] **Feet ✅** — all cover figures full-length, shod.
- [🟡] **Detection guard — FIRES + fixes, but not 100%.** blownMaskFixed flags present (point-sam ×2,
      gdino-fallback ×1) → guard runs on 44d0999a. Blowouts down from oil#1 (5, incl a 16.5× whole-frame,
      none fixed) to 4 (worst 4.21×), 2 fully fixed. Remaining 3 (p4 Sarah/Hans, p11 Noah) show `fixed=-`
      (guard didn't run on THAT detection pass) despite sam=true — samApplied only ever set inside
      detectFiguresWithGroundingDino (where the guard lives), so the STORED pass differs from the guarded
      one. Prime suspect: the **bbox detection CACHE** (images.js:~3120 `return cached` / _bboxCacheSet)
      serving a pass computed while the staging **Python analyzer was restarting mid-run** (a "Restart
      Python analyzer" task fired during this generation). NOT root-caused → **not patched further**
      (user: "if in doubt don't change"). **IMPORTANT: guard is grounding-dino path = STAGING ONLY; prod
      uses Gemini bbox → this does not affect production.** Open investigation for a focused session:
      does the bbox cache store a pre-guard/degraded pass, or does analyzer instability need a retry?

## Deploy decision (goal: "deploy all the things you could fix")

- Staging: all 5 commits pushed + deployed (883a240d→44d0999a), validated.
- **Prod (master)**: cover typography (A1/A2/A3) + feet fixes are used EVERYWHERE incl prod, fully
  validated → beneficial. Detection guard is grounding-dino/staging-only → no prod effect (safe no-op).
- ⚠️ **staging is 259 commits AHEAD of master** — my 5 fixes sit atop 254 prior-session commits; no clean
  cherry-pick. Promoting = a 259-commit big-bang prod deploy. Prod in-flight jobs = 0 (checked, so no
  generation would be killed right now). This is NOT an autonomous call — **needs explicit user approval**
  for the full staging→master promotion. Held.
- [ ] **Prod promotion** — bring the batch to the user for the master push (prod deploy kills
      in-flight generation → explicit approval required, not assumed).
- Deferred (documented, not changed per "if in doubt don't change"): B→Gemini fallback option,
  E1/D2 lab→story admin rights (Test Lab Phase 1), C2 Lena VB id-binding, D1 needs repro.
