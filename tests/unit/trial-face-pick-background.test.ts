/**
 * Owner 2026-10-09: "I could immediately select which one, but then had to wait 39 seconds
 * before the next screen." Picking one of several faces re-runs analyze-photo (body crop +
 * background removal, ~20 s); the details form used to open only once that returned.
 * The pick now opens the form at once from the thumbnail already in hand, the analysis runs in the
 * background, a Next pressed meanwhile waits for it, and a failure brings the face picker + error back.
 * Behaviour is proven in WebKit by tests/manual/trial-face-pick-background.cjs (no component-test
 * stack in this repo), so these are structure guards on the pieces that carry it.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
const src = fs.readFileSync(path.resolve(__dirname, '../../client/src/pages/trial/TrialCharacterStep.tsx'), 'utf8').replace(/\r\n/g, '\n');
const handler = src.slice(src.indexOf('const handleFaceSelect'), src.indexOf('const handleRemovePhoto'));

describe('face pick does not block on the analysis', () => {
  it('handleFaceSelect shows the picked thumbnail and does not await the analysis', () => {
    expect(handler).toContain('setPickedFaceThumb(picked.thumbnail)');
    expect(handler).not.toMatch(/await\s+analyzePhoto/);
  });
  it('a failed analysis restores the picker, drops a queued Next and returns to the photo phase', () => {
    expect(handler).toContain('setNextWaitingForPhoto(false)');
    expect(handler).toContain('setDetectedFaces(facesBeforePick)');
    expect(handler).toContain("setPhase('photo')");
  });
  it('analyzePhoto reports success so a failure cannot pass silently', () => {
    expect(src).toMatch(/analyzePhoto = useCallback\(async \([^)]*\): Promise<boolean>/);
  });
  it('Next pressed while the photo is pending waits for canProceed, then runs handleNext', () => {
    expect(src).toContain('if (!nextWaitingForPhoto || !canProceed) return;');
    expect(src).toContain('canQueueNext ? () => setNextWaitingForPhoto(true) : handleNext');
  });
});
