/**
 * iPhone trial: an IP lookup that finds no town used to give a placeless first
 * idea under a bare "Deine Stadt" label, with no hint and no question. The
 * ideas step now waits for the lookup, and when it found no town it opens the
 * city editor with an explanation (or lets the visitor go on without).
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8').split('\r\n').join('\n');
const STEP = read('client', 'src', 'pages', 'trial', 'TrialIdeasStep.tsx');
const WIZARD = read('client', 'src', 'pages', 'TrialWizard.tsx');

describe('trial ideas step and an unknown town', () => {
  it('does not auto-generate while the lookup is pending or found no town', () => {
    expect(STEP).toContain('const locationPending = !!onLocationChange && userLocation == null;');
    expect(STEP).toMatch(/const locationUnknown = !!onLocationChange && userLocation != null && !userLocation\.city && !skipLocation/);
    expect(STEP).toMatch(/if \(mayGenerate && !hasFinalIdeas && !hasGenerated && !isGenerating\) \{\s*\n\s*generateIdeas\(\);/);
    expect(STEP).toContain('}, [mayGenerate]);');
  });

  it('asks for the town (editor open) and offers an explicit skip', () => {
    expect(STEP).toContain('{(editingCity || locationUnknown) ? (');
    expect(STEP).toContain('{t.locationUnknown}');
    expect(STEP).toContain('onClick={() => setSkipLocation(true)}');
  });

  it('has the question in all four languages', () => {
    expect((STEP.match(/^\s+locationUnknown: "/gm) || []).length).toBe(4);
    expect((STEP.match(/^\s+skipLocation: "/gm) || []).length).toBe(4);
  });

  it('entering the first town does not double-generate (the auto effect starts the ideas)', () => {
    expect(STEP).toContain('regenAfterCityRef.current = hasGenerated || !!hasFinalIdeas || isGenerating;');
  });

  it('the wizard turns a failed or empty lookup into an explicit no-town answer, never a permanent null', () => {
    expect(WIZARD).toContain('}).catch(() => setUserLocation(NO_LOCATION));');
    expect(WIZARD).toContain('setUserLocation(loc || NO_LOCATION);');
  });
});
