/**
 * The trial ideas step must never end in two half cards with no button.
 *
 * generate-ideas-stream (server/routes/trial.js) emits each card as
 * `{ storyN, isFinal: true }` only when its self-check produced an idea, then
 * `{ done: true }` regardless; a proxy or a phone's network switch can also
 * close the stream before `done`. The step only showed the retry on an
 * explicit `{ error }` line, so a stream that ended with a card still
 * non-final left the cards unselectable (isEditable false), "Create" disabled,
 * no regenerate button (hasGenerated false) and no error: a dead end that
 * needed a browser reload — which restarts the whole funnel.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

const STEP = fs.readFileSync(
  path.join(__dirname, '..', '..', 'client', 'src', 'pages', 'trial', 'TrialIdeasStep.tsx'),
  'utf8'
).split('\r\n').join('\n');

const generate = STEP.slice(STEP.indexOf('const generateIdeas = useCallback'), STEP.indexOf('// When both ideas are final'));

describe('an idea stream that ends before both cards are final shows the retry', () => {
  it('tracks the finals outside React state and raises the error when either is missing', () => {
    expect(generate).toContain('const finals = [false, false];');
    expect(generate).toMatch(/if \(finals\[0\] && finals\[1\]\) return false;\s*\n\s*setError\(t\.serverError\);/);
    expect(generate).toContain("if (data.story1 !== undefined) finals[0] = true;");
    expect(generate).toContain("if (data.story2 !== undefined) finals[1] = true;");
  });

  it('checks on the done event AND when the stream closes without one', () => {
    const doneBranch = generate.slice(generate.indexOf('if (data.done) {'), generate.indexOf('if (data.isFinal) {'));
    expect(doneBranch).toContain('endedIncomplete();');
    const afterLoop = generate.slice(generate.lastIndexOf('endedIncomplete();'));
    expect(afterLoop).toMatch(/endedIncomplete\(\);\s*\n\s*setIsGenerating\(false\);\s*\n\s*\} catch/);
  });

  it('the error block offers the regenerate call, so the visitor is never stuck', () => {
    const errorBlock = STEP.slice(STEP.indexOf('{/* Error state */}'), STEP.indexOf('{/* Loading indicator'));
    expect(errorBlock).toContain('onClick={generateIdeas}');
    expect(errorBlock).toContain('{t.errorRetry}');
  });

  it('serverError, the message shown, exists in every language', () => {
    for (const lang of ['en', 'de', 'fr', 'it']) {
      const block = STEP.slice(STEP.indexOf(`  ${lang}: {`), STEP.indexOf('  },', STEP.indexOf(`  ${lang}: {`)));
      expect(block, lang).toMatch(/serverError: ['"]/);
    }
  });
});
