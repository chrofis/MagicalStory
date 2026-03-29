# Unify Cover and Page Image Treatment

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove separate cover repair steps (Step 7 artifact repair, Step 8 cover repair) from the manual workflow. Treat covers as regular pages — iterate on them with feedback, show version history, fix bbox to use active image.

**Architecture:** Extend the existing `iterate` endpoint to support negative page numbers (covers). The endpoint already does scene analysis, 17-check validation, and feedback-driven regeneration. For covers, we adapt this: use the cover's stored description as the scene, the cover prompt template for image generation, and the cover-specific character selection. Frontend removes Steps 7+8, covers flow through the normal redo/mark-for-redo path.

**Tech Stack:** Express backend (server/routes/regeneration.js), React frontend (useRepairWorkflow.ts, RepairWorkflowPanel.tsx, StoryDisplay.tsx)

---

## Task 1: Extend iterate endpoint to support covers

**Files:**
- Modify: `server/routes/regeneration.js` — the `POST /:id/iterate/:pageNum` route

The iterate endpoint currently only works with positive page numbers (scene images). It needs to handle negative page numbers (-1 = frontCover, -2 = initialPage, -3 = backCover).

**What to change:**

1. At the top of the handler, detect if `pageNum` is negative → it's a cover.
2. For covers:
   - Look up the cover in `storyData.coverImages[coverKey]` instead of `sceneImages`
   - Use the cover's stored `description` as the scene description
   - Use the cover prompt template (frontCover/initialPage/backCover) instead of the scene image prompt
   - Use cover character selection logic (main chars only for front, main+extras for others, max 5)
   - Skip the 17-point scene validation (covers don't have scene hints in the same format)
   - Generate with `generateImageWithQualityRetry` using the cover prompt template
   - Save the new version to `coverImages[coverKey].imageVersions` and `story_images` table
   - Update `image_version_meta` with the new active version

3. Use the existing `COVER_PAGE_MAP` constant for the mapping:
   ```js
   const COVER_PAGE_MAP = { '-1': 'frontCover', '-2': 'initialPage', '-3': 'backCover' };
   ```

4. The response format should match the existing iterate response so the frontend doesn't need separate handling.

**Key considerations:**
- Cover evaluation must use `evaluationType: 'cover'` (text-focused for title page)
- The `evaluationFeedback` from the repair workflow should be passed through
- Credits are deducted the same as page iteration

**Commit:** `feat: extend iterate endpoint to support cover images via negative page numbers`

---

## Task 2: Remove Step 7 (artifact repair) and Step 8 (cover repair) from frontend

**Files:**
- Modify: `client/src/hooks/useRepairWorkflow.ts`
- Modify: `client/src/components/generation/RepairWorkflowPanel.tsx`

**In useRepairWorkflow.ts:**

1. Remove the `repairArtifacts` function
2. Remove the `regenerateCovers` function and `coverRepairProgress` state
3. Remove `'artifact-repair'` and `'cover-repair'` from:
   - `RepairWorkflowStep` type
   - `STEP_ORDER` array
   - `createInitialState()` stepStatus
4. Remove from the return object: `repairArtifacts`, `regenerateCovers`, `coverRepairProgress`
5. Remove from the `UseRepairWorkflowReturn` interface

**In RepairWorkflowPanel.tsx:**

1. Remove the entire Step 7 (Artifact Repair) UI section
2. Remove the entire Step 8 (Cover Repair) UI section
3. Remove related state: `selectedArtifactPages`, `selectedCovers`, etc.

**Commit:** `refactor: remove Step 7 (artifact) and Step 8 (cover) from repair workflow`

---

## Task 3: Update redoCoverOrPage to use iterate for covers

**Files:**
- Modify: `client/src/hooks/useRepairWorkflow.ts`
- Modify: `client/src/services/storyService.ts` (if iteratePage doesn't accept negative numbers)

**In useRepairWorkflow.ts:**

Update `redoCoverOrPage` to call `iteratePage` for covers instead of `regenerateCover`:

```typescript
const redoCoverOrPage = useCallback(async (
  pageNumber: number,
  evalFeedback?: { ... },
) => {
  // Both covers (negative page numbers) and pages use iteratePage now
  return storyService.iteratePage(storyId!, pageNumber, imageModel, { evaluationFeedback: evalFeedback });
}, [storyId, imageModel]);
```

**In storyService.ts:**

Verify that `iteratePage` sends the page number correctly for negative values. The endpoint URL pattern is `/:id/iterate/:pageNum` — negative numbers in URL paths need to be handled (e.g., `/-1` should work).

**Commit:** `feat: covers now iterate through same path as pages`

---

## Task 4: Ensure cover versions show in ImageHistoryModal

**Files:**
- Modify: `client/src/components/generation/StoryDisplay.tsx`

Check that cover `imageVersions` are displayed correctly:
1. The cover sections (frontCover, initialPage, backCover) should show the version count badge when `imageVersions.length > 1`
2. Clicking the badge opens `ImageHistoryModal` with the cover's versions
3. The modal's `onSelectVersion` calls the cover active-image endpoint

Search for where page version badges are shown and verify covers have the same treatment. Look for `getImageVersions` — it only works for scene images. Covers need a similar helper or inline logic.

**Commit:** `fix: show version history badge and modal for cover images`

---

## Task 5: Fix bbox detection to use active image version

**Files:**
- Modify: `client/src/components/generation/story/ObjectDetectionDisplay.tsx`
- Modify: `server/routes/stories.js` — the `/dev-image` endpoint

The bbox overlay image is generated from whatever image was evaluated. When the user selects a different version (via ImageHistoryModal), the bbox display should update to show detection for the active version, not the original.

**Current issue:** The overlay fetch uses `type=original` which loads from the scene's stored bbox data. After switching versions, this is stale.

**Fix:** When fetching the overlay, pass the active `versionIndex` so the server can return the correct overlay. OR: re-run bbox detection on the active image client-side (expensive). The simpler approach: clear the cached overlay when the active version changes, so the next "load overlay" click fetches fresh data.

**Commit:** `fix: bbox overlay refreshes when active image version changes`

---

## Expected Result

After all tasks:
- Steps 7 and 8 removed from repair workflow UI
- Covers appear in the "Identify Redo Pages" list alongside regular pages
- Marking a cover for redo and clicking "Redo Pages" iterates on it with the same quality as page iteration
- Cover version history shows in the version badge/modal
- Bbox detection shows for the currently active version
- Full automated workflow treats covers identically to pages
