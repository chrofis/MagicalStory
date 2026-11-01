import { describe, it, expect } from 'vitest';

// Staging job_1793526073039_9nhq3ju59 (2026-11-01) logged "no clothingRequirements — the Art Director sees no outfit
// text": the brief re-ask built its Art Director context without the wardrobe contract, so a page sent back (a cover
// in nightwear among them) was rewritten with no outfits to copy.
const fs = require('fs');
const path = require('path');

describe('the brief re-ask gives the Art Director the same outfit text as the first call', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../server/lib/briefChecks.js'), 'utf8');
  it('passes clothingRequirements to buildBriefReaskContext', () => {
    const call = src.slice(src.indexOf('buildBriefReaskContext(inputData'), src.indexOf('}) ||', src.indexOf('buildBriefReaskContext(inputData')));
    expect(call).toMatch(/\bclothingRequirements\b/);
  });
  it('runBriefChecks receives clothingRequirements from its caller', () => {
    expect(src).toMatch(/async function runBriefChecks\(\{[^}]*\bclothingRequirements\b/);
  });
});
