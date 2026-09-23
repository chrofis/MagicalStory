import { describe, it, expect } from 'vitest';

// The per-page style gate returned the ART STYLE's own face clause as its
// observation on 6 of 6 quality responses of staging job_1790100385959_1nitlympp,
// always with matches_style true. An observation copied from the input is not an
// observation: evaluateImageQuality records such a gate as no verdict (null),
// never a pass. Same idea as the avatar-sheet echo guard (isEchoedJudgeVerdict).

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { styleGateEchoedFields } = require('../../server/lib/evalPipeline');

const STYLE = 'A bold traditional watercolor painting: prominent visible brushstrokes, wet-on-wet washes. '
  + 'Faces: loose washes with visible brushstroke texture. Each character keeps their real age.';
const TEMPLATE = 'linework — no outlines at all, forms defined by paint edges; faces — loose paint washes with no outline';

describe('style gate echo', () => {
  it('flags a face observation copied from the art style', () => {
    expect(styleGateEchoedFields({ faces: 'loose washes with visible brushstroke texture' }, STYLE, TEMPLATE)).toEqual(['faces']);
  });
  it('flags the copy with a word spliced in', () => {
    expect(styleGateEchoedFields({ faces: 'loose paint washes with visible brushstroke texture' }, STYLE, TEMPLATE)).toEqual(['faces']);
  });
  it('an answer taken from the template’s own options is not an echo', () => {
    expect(styleGateEchoedFields({ linework: 'no outlines at all, forms defined by paint edges', faces: 'loose paint washes with no outline' }, STYLE, TEMPLATE)).toEqual([]);
  });
  it('an observation in the judge’s own words is not an echo', () => {
    expect(styleGateEchoedFields({ faces: 'smooth digital shading, crisp defined features', observed: 'watercolor painting' }, STYLE, TEMPLATE)).toEqual([]);
  });
  it('no art style, no echo', () => {
    expect(styleGateEchoedFields({ faces: 'loose washes with visible brushstroke texture' }, '', TEMPLATE)).toEqual([]);
  });
});
