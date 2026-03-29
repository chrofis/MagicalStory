# Grok Inpaint Repair in Manual Workflow

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace Runware inpainting with Grok edit for targeted image repair, and expose it as a step in the manual repair workflow panel.

**Architecture:** Add a Grok backend path to the existing `inpaintWithMask()` function using the blackout+blend technique from character repair. Add an `inpaint-repair` step to the repair workflow hook and panel UI, allowing per-page fix-target-based inpainting with before/after display.

**Tech Stack:** Express.js backend, Grok Imagine edit API (`editWithGrok`), Sharp for image compositing, React/TypeScript frontend

---

### Task 1: Add Grok backend to `inpaintWithMask()`

**Files:**
- Modify: `server/lib/images.js:8259-8270` (routing in `inpaintWithMask`)
- Modify: `server/lib/images.js` (new `inpaintWithGrokBackend` function, add near line 8270)

**Step 1: Add `inpaintWithGrokBackend()` function**

Insert after line 8270 in `server/lib/images.js`. The approach mirrors `repairCharacterMismatchWithGrok` blended mode:
1. Black out all bounding box regions on the original image (white overlay)
2. Send blackout image + fix prompt to `editWithGrok()`
3. Extract each bbox region from Grok result
4. Feathered-blend each region back onto the original (30px feather)

```javascript
async function inpaintWithGrokBackend(originalImage, boundingBoxes, fixPrompt, options = {}) {
  const { includeDebugImages = false } = options;
  const { editWithGrok } = require('./grok');

  // 1. Create whiteout overlay on all bounding box regions
  const origBase64 = originalImage.replace(/^data:image\/\w+;base64,/, '');
  const origBuffer = Buffer.from(origBase64, 'base64');
  const metadata = await sharp(origBuffer).metadata();
  const { width, height } = metadata;

  // Build composite operations for all bounding boxes
  const composites = [];
  for (const bbox of boundingBoxes) {
    const [ymin, xmin, ymax, xmax] = bbox;
    const bx = Math.round(xmin * width);
    const by = Math.round(ymin * height);
    const bw = Math.max(1, Math.round((xmax - xmin) * width));
    const bh = Math.max(1, Math.round((ymax - ymin) * height));
    // White rectangle with 80% opacity (same as character repair)
    const whiteRect = await sharp({
      create: { width: bw, height: bh, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 204 } }
    }).png().toBuffer();
    composites.push({ input: whiteRect, left: bx, top: by });
  }

  const whiteoutBuffer = await sharp(origBuffer)
    .composite(composites)
    .jpeg({ quality: 90 })
    .toBuffer();
  const whiteoutDataUri = `data:image/jpeg;base64,${whiteoutBuffer.toString('base64')}`;

  // 2. Build prompt for Grok
  const regionDescriptions = boundingBoxes.map((bbox, idx) => {
    const [ymin, xmin, ymax, xmax] = bbox;
    return `Region ${idx + 1}: top ${Math.round(ymin * 100)}%-${Math.round(ymax * 100)}%, left ${Math.round(xmin * 100)}%-${Math.round(xmax * 100)}%`;
  }).join('\n');

  const grokPrompt = `Fix the whited-out region(s) in this illustration. Regenerate ONLY the blanked areas to match the surrounding art style perfectly.

TARGET REGIONS:
${regionDescriptions}

WHAT TO FIX:
${fixPrompt}

IMPORTANT:
- Preserve everything outside the white regions exactly as shown
- Match the art style, lighting, and color palette of the surrounding image
- Make the repaired areas blend seamlessly with the rest`;

  // 3. Send to Grok
  log.info(`🔧 [INPAINT-GROK] Sending ${boundingBoxes.length} region(s) to Grok for repair`);
  const grokResult = await editWithGrok(grokPrompt, [whiteoutDataUri], {
    model: GROK_MODELS.STANDARD,
    aspectRatio: width > height ? '16:9' : height > width ? '9:16' : '1:1'
  });

  if (!grokResult?.imageData) {
    throw new Error('Grok returned no image');
  }

  // 4. Feathered blend each region back onto original
  const FEATHER_PX = 30;
  const grokBase64 = grokResult.imageData.replace(/^data:image\/\w+;base64,/, '');
  let resultBuffer = origBuffer;

  for (const bbox of boundingBoxes) {
    const [ymin, xmin, ymax, xmax] = bbox;
    // Add 10% padding for blend region
    const padX = (xmax - xmin) * 0.1;
    const padY = (ymax - ymin) * 0.1;
    const bx = Math.max(0, Math.round((xmin - padX) * width));
    const by = Math.max(0, Math.round((ymin - padY) * height));
    const bx2 = Math.min(width, Math.round((xmax + padX) * width));
    const by2 = Math.min(height, Math.round((ymax + padY) * height));
    const bw = bx2 - bx;
    const bh = by2 - by;

    if (bw <= 0 || bh <= 0) continue;

    // Extract regions from both images
    const origRegion = await sharp(resultBuffer).extract({ left: bx, top: by, width: bw, height: bh }).raw().toBuffer();
    // Resize Grok result to match original dimensions before extracting
    const grokResized = await sharp(Buffer.from(grokBase64, 'base64')).resize(width, height, { fit: 'fill' }).raw().toBuffer();
    const grokRegion = await sharp(grokResized, { raw: { width, height, channels: 3 } })
      .extract({ left: bx, top: by, width: bw, height: bh }).raw().toBuffer();

    // Create feathered blend
    const blended = Buffer.alloc(bw * bh * 3);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        // Distance from edge (0 at edge, 1 in center)
        const dx = Math.min(x, bw - 1 - x) / FEATHER_PX;
        const dy = Math.min(y, bh - 1 - y) / FEATHER_PX;
        const alpha = Math.min(1, Math.min(dx, dy)); // 0=original, 1=grok
        const idx = (y * bw + x) * 3;
        for (let c = 0; c < 3; c++) {
          blended[idx + c] = Math.round(origRegion[idx + c] * (1 - alpha) + grokRegion[idx + c] * alpha);
        }
      }
    }

    // Composite blended region back
    const blendedPng = await sharp(blended, { raw: { width: bw, height: bh, channels: 3 } }).png().toBuffer();
    resultBuffer = await sharp(resultBuffer).composite([{ input: blendedPng, left: bx, top: by }]).jpeg({ quality: 92 }).toBuffer();
  }

  const finalDataUri = `data:image/jpeg;base64,${resultBuffer.toString('base64')}`;

  return {
    imageData: finalDataUri,
    modelId: grokResult.modelId || 'grok-imagine',
    usage: grokResult.usage,
    fullPrompt: grokPrompt
  };
}
```

**Step 2: Add routing in `inpaintWithMask()`**

In `inpaintWithMask` at line 8268, add the Grok route before the Gemini default:

```javascript
// After the runware check (line 8269), add:
if (backend === 'grok') {
  return inpaintWithGrokBackend(originalImage, boundingBoxes, fixPrompt, options);
}
```

**Step 3: Commit**

```
feat: add Grok backend for inpainting via blackout+blend
```

---

### Task 2: Change default inpaint backend to Grok

**Files:**
- Modify: `server/config/models.js:89`

**Step 1: Change default**

```javascript
// Line 89: Change from
inpaintBackend: 'runware',
// To:
inpaintBackend: 'grok',
```

**Step 2: Commit**

```
chore: switch default inpaint backend from Runware to Grok
```

---

### Task 3: Add `inpaint-repair` step to the repair workflow hook

**Files:**
- Modify: `client/src/hooks/useRepairWorkflow.ts`

**Step 1: Add step to types and order**

In the `RepairWorkflowStep` type (find union type), add `'inpaint-repair'`.

In `STEP_ORDER` array (line 91-99), add `'inpaint-repair'` after `'character-repair'`:

```typescript
const STEP_ORDER: RepairWorkflowStep[] = [
  'idle',
  'collect-feedback',
  'identify-redo-pages',
  'redo-pages',
  're-evaluate',
  'consistency-check',
  'character-repair',
  'inpaint-repair',    // NEW
];
```

Add initial state for the step in `stepStatus`:
```typescript
'inpaint-repair': 'pending',
```

**Step 2: Add `repairInpaint` function**

Add a new callback that calls `storyService.repairImage()` for a specific page:

```typescript
const repairInpaint = useCallback(async (pageNumber: number, fixTargets?: Array<{ boundingBox: number[]; issue: string; fixPrompt: string }>) => {
  if (!storyId) return;

  startStep('inpaint-repair');

  try {
    const result = await storyService.repairImage(storyId, pageNumber, fixTargets);

    if (result.repaired && result.imageData && onImageUpdate) {
      try {
        onImageUpdate(pageNumber, result.imageData, undefined, {
          type: 'inpaint-repair',
        });
      } catch (err) {
        console.error(`[RepairWorkflow] Failed to notify parent of inpaint update for page ${pageNumber}:`, err);
      }
    }

    setWorkflowState(prev => ({
      ...prev,
      stepStatus: {
        ...prev.stepStatus,
        'inpaint-repair': result.repaired ? 'completed' : 'failed',
      },
    }));

    // Re-evaluate the repaired page
    if (result.repaired) {
      try {
        await reEvaluatePages([pageNumber]);
      } catch (evalErr) {
        console.warn('[RepairWorkflow] Post-inpaint re-evaluation failed:', evalErr);
      }
    }

    return result;
  } catch (error) {
    console.error('Inpaint repair failed:', error);
    failStep('inpaint-repair', error instanceof Error ? error.message : 'Unknown error');
  }
}, [storyId, startStep, failStep, onImageUpdate]);
```

**Step 3: Return `repairInpaint` from the hook**

Add to the return object alongside `repairCharacter`.

**Step 4: Commit**

```
feat: add inpaint-repair step to repair workflow hook
```

---

### Task 4: Add inpaint repair UI to RepairWorkflowPanel

**Files:**
- Modify: `client/src/components/generation/RepairWorkflowPanel.tsx`

**Step 1: Add step config**

In `STEP_CONFIG`, add:
```typescript
'inpaint-repair': { label: 'Inpaint Repair', icon: Paintbrush, description: 'Fix specific image regions using Grok edit' },
```

Import `Paintbrush` from lucide-react.

**Step 2: Add inpaint repair section in the panel**

After the character repair section and before pick-best-versions, add a new expandable step section. The UI should:

1. Show a page selector (same pattern as character repair)
2. For each selected page, show fix targets from evaluation data (if available)
3. A "Repair" button that calls `repairInpaint(pageNumber, fixTargets)`
4. Show repair status (loading spinner, success/failure)

The fix targets come from `workflowState.evaluationResults` — each page's evaluation has `fixTargets` with bounding boxes and fix prompts.

```tsx
{renderStepHeader('inpaint-repair')}
{expandedSteps.has('inpaint-repair') && (
  <div className="px-4 pb-4 space-y-3">
    <p className="text-sm text-gray-600">{STEP_CONFIG['inpaint-repair'].description}</p>

    {/* Page selector — show pages that have fix targets */}
    <div className="space-y-2">
      <div className="text-xs font-medium text-gray-700">Select page to repair:</div>
      <div className="flex flex-wrap gap-1">
        {Array.from({ length: totalPages }, (_, i) => i).map(pageNum => {
          const evalData = workflowState.evaluationResults?.[pageNum];
          const fixTargetCount = evalData?.fixTargets?.length || 0;
          return (
            <button
              key={pageNum}
              onClick={() => setSelectedInpaintPage(pageNum)}
              className={`px-2 py-1 text-xs rounded border ${
                selectedInpaintPage === pageNum
                  ? 'bg-orange-100 border-orange-400 text-orange-800'
                  : fixTargetCount > 0
                    ? 'bg-yellow-50 border-yellow-300 text-yellow-800 hover:bg-yellow-100'
                    : 'bg-gray-50 border-gray-200 text-gray-500 hover:bg-gray-100'
              }`}
            >
              P{pageNum} {fixTargetCount > 0 && `(${fixTargetCount})`}
            </button>
          );
        })}
      </div>
    </div>

    {/* Show fix targets for selected page */}
    {selectedInpaintPage !== null && (
      <div className="space-y-2">
        {(() => {
          const evalData = workflowState.evaluationResults?.[selectedInpaintPage];
          const fixTargets = evalData?.fixTargets || [];
          return fixTargets.length > 0 ? (
            <>
              <div className="text-xs text-gray-600">
                {fixTargets.length} fixable issue{fixTargets.length !== 1 ? 's' : ''} on page {selectedInpaintPage}:
              </div>
              <ul className="text-xs text-gray-500 list-disc pl-4 space-y-0.5">
                {fixTargets.map((t, i) => (
                  <li key={i}>{t.issue}</li>
                ))}
              </ul>
            </>
          ) : (
            <div className="text-xs text-gray-400">No fix targets available for this page. Run evaluation first.</div>
          );
        })()}

        <button
          onClick={async () => {
            const evalData = workflowState.evaluationResults?.[selectedInpaintPage!];
            const fixTargets = evalData?.fixTargets;
            const result = await repairInpaint(selectedInpaintPage!, fixTargets);
            if (result?.repaired && onRefreshStory) {
              await onRefreshStory();
            }
          }}
          disabled={disableForFinalSteps || selectedInpaintPage === null || workflowState.stepStatus['inpaint-repair'] === 'running'}
          className="flex items-center gap-2 px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 disabled:opacity-50"
        >
          <Paintbrush className="w-4 h-4" />
          Inpaint Page {selectedInpaintPage ?? '?'}
          {workflowState.stepStatus['inpaint-repair'] === 'running' && (
            <Loader2 className="w-4 h-4 animate-spin" />
          )}
        </button>
      </div>
    )}
  </div>
)}
```

**Step 3: Add state for selected page**

```typescript
const [selectedInpaintPage, setSelectedInpaintPage] = useState<number | null>(null);
```

**Step 4: Wire up `repairInpaint` from the hook**

Destructure `repairInpaint` from `useRepairWorkflow()` alongside `repairCharacter`.

**Step 5: Commit**

```
feat: add inpaint repair step to RepairWorkflowPanel UI
```

---

### Task 5: Build and verify

**Step 1: Build frontend**

```bash
cd client && npm run build
```

Fix any TypeScript errors.

**Step 2: Manual test**

- Open a story in dev mode
- Go to repair workflow
- Expand "Inpaint Repair" step
- Select a page that has fix targets from a previous evaluation
- Click "Inpaint Page X"
- Verify the Grok backend is called (check server logs for `[INPAINT-GROK]`)
- Verify the image updates in the UI

**Step 3: Final commit with build**

```
build: compile frontend with inpaint repair changes
```
