/**
 * Avatar guarantee chain — the "a story character must NEVER end up with zero
 * identity reference" backstop.
 *
 * Pure, dependency-free resolver: walks an ordered list of steps (generation
 * engines first, then static reference fallbacks), returns the first usable
 * image plus a warning trail describing every step that failed. Callers own
 * all logging/surfacing — this module never touches the logger, the cache, or
 * the network, which keeps it deterministically unit-testable
 * (tests/manual/test-avatar-guarantee.js).
 *
 * Used by styledAvatars.ensureStyledAvatarCoverage() after styled-avatar
 * generation: when a required character has no styled avatar in ANY bucket,
 * the chain resolves the best available raw reference (standard clothing
 * avatar → bg-removed body photo → face photo) so downstream page rendering
 * and eval identity matching always receive an identity reference.
 * See docs/decisions.md "Styled-avatar MUST guarantee".
 */

'use strict';

/**
 * Walk `steps` in order; return the first step that yields a usable image.
 *
 * A step is `{ source: string, fn: () => Promise<string|null> }`. Its fn may
 * return a data-URI image string, null/undefined (unavailable), or throw —
 * failures of every kind are recorded as warnings and the chain continues.
 * Only a `data:image...` string counts as usable (references are packed into
 * provider payloads as data URIs; URL-shaped values must be resolved by the
 * step itself before returning).
 *
 * @param {Object} opts
 * @param {string} opts.characterName - for warning texts only
 * @param {Array<{source: string, fn: Function}>} opts.steps - ordered chain
 * @returns {Promise<{imageData: string|null, source: string|null, warnings: string[]}>}
 *   imageData is null ONLY when every step failed — callers must treat that
 *   as a loud error state, never a shrug.
 */
async function resolveGuaranteedReference({ characterName, steps }) {
  const warnings = [];
  for (const step of steps || []) {
    const source = step?.source || 'unnamed step';
    if (typeof step?.fn !== 'function') {
      warnings.push(`${source}: no resolver function`);
      continue;
    }
    let candidate;
    try {
      candidate = await step.fn();
    } catch (err) {
      warnings.push(`${source}: threw (${err && err.message ? err.message : err})`);
      continue;
    }
    if (typeof candidate === 'string' && candidate.startsWith('data:image')) {
      return { imageData: candidate, source, warnings };
    }
    if (candidate) {
      warnings.push(`${source}: returned a non data-URI value — unusable as reference`);
    } else {
      warnings.push(`${source}: unavailable`);
    }
  }
  warnings.push(`ALL steps exhausted for ${characterName || 'character'} — no identity reference available`);
  return { imageData: null, source: null, warnings };
}

module.exports = { resolveGuaranteedReference };
