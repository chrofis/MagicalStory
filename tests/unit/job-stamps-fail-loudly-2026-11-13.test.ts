/**
 * Pipeline review 2026-11-13, finding 11: when stamping the job's layout or season failed, the
 * pipeline logged a warning and went on. An unstamped layout made buildImagePrompt fall through to
 * textInImage=true (a book in the wrong layout); an unstamped season left every brief without one.
 * Both now throw inside _processStoryJobImpl, whose catch fails AND refunds the job.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.resolve(__dirname, '../../storyJobPipeline.js'), 'utf8');
const impl = src.slice(src.indexOf('async function _processStoryJobImpl'));

function catchAfter(marker: string) {
  const at = impl.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  const c = impl.indexOf('} catch (e) {', at);
  return impl.slice(c, impl.indexOf('\n    }', c));
}

describe('layout and season stamps fail the job instead of continuing', () => {
  it('a failed resolveLayout throws (no textInImage default)', () => {
    const block = catchAfter("inputData.layout = resolveLayout(");
    expect(block).toMatch(/throw new Error\(`resolveLayout failed/);
    expect(block).not.toMatch(/log\.warn/);
  });

  it('a failed resolveSeason throws (no season-less briefs)', () => {
    const block = catchAfter("const resolved = resolveSeason(inputData");
    expect(block).toMatch(/throw new Error\(`resolveSeason failed/);
    expect(block).not.toMatch(/log\.warn/);
  });

  it('the job catch that receives them fails and refunds the job', () => {
    const outer = impl.indexOf('  } catch (error) {');
    expect(outer).toBeGreaterThan(impl.indexOf('resolveSeason failed'));
    expect(impl.slice(outer, outer + 1500)).toMatch(/settleJobWithRefund\(dbPool, jobId, \{\s*status: 'failed'/);
  });
});
