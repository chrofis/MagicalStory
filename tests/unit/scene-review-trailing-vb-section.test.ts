/**
 * THE SCENE REVIEW'S TRAILING ---VISUAL BIBLE--- BLOCK IS NOT PART OF A BRIEF.
 *
 * scene-review.txt's output contract is `---ANALYSIS---`, then `---SCENES---`
 * with one `## Page N` brief per rewritten page, then an OPTIONAL fenced
 * `---VISUAL BIBLE---` block carrying the entries the reviewer corrected.
 * `parseRefinedText` runs the last page to the end of the reply unless the
 * caller names a terminator, so that block was appended to the LAST rewritten
 * brief and stored as part of it.
 *
 * Measured on staging job_1789759147125_p08djwhbl p17 — the page where the
 * book's creature hatches, and the last page that review rewrote. Its brief
 * shipped with another page's vantage JSON glued on; the METADATA parse was
 * destroyed by the appended section (fixed separately in b5443396a), the page
 * rendered on prose alone, and the brief credited NOTHING to the Visual Bible
 * usage rebuild — so the creature reached the bible for page 18 only and the
 * hatching page asked for no creature at all.
 *
 * Pinned here as BEHAVIOUR, never as prompt wording: a page's brief ends where
 * the next named section begins, and its own ---METADATA--- block survives.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { parseRefinedText, BRIEF_TRAILING_MARKERS } = require_('../../server/lib/promptBuilders');
const { extractSceneMetadata } = require_('../../server/lib/sceneMetadata');

const P17_METADATA = {
  characters: [{ name: 'the younger child', clothing: 'standard', position: 'center foreground' }],
  shot: 'close-up',
  objects: ['LOC005.3', 'ANI003', 'CLO002'],
  interactions: [{ character: 'ANI003', object: 'the younger child', action: 'sneezing', priority: 'essential' }],
  wornItems: [{ id: 'CLO002', owner: 'the older child', state: 'worn', wearer: 'the younger child' }],
};

const REVIEW_REPLY = [
  '---ANALYSIS---',
  '9f. [vb_state_range] none',
  '10a. [plate_contains_effect] page 11',
  'FAULTED PAGES: 16, 17',
  'REMOVED CAST: NONE',
  '',
  '---SCENES---',
  '## Page 16',
  'The older child kneels over the shell in the lane.',
  '',
  '---METADATA---',
  JSON.stringify({ characters: [{ name: 'the older child' }], objects: ['LOC005.2', 'ART001'] }),
  '',
  '## Page 17',
  'The younger child fills the close-up frame, laughing.',
  '',
  '---METADATA---',
  JSON.stringify(P17_METADATA),
  '',
  '---VISUAL BIBLE---',
  '```json',
  '{"vantages": [{"id": "LOC004.1", "emptyScenePrompt": "An ultra-wide view over sloping rooftops."}]}',
  '```',
].join('\n');

describe('scene review reply — the trailing Visual Bible block', () => {
  it('does not end up inside the last rewritten brief', () => {
    const parsed = parseRefinedText(REVIEW_REPLY, [16, 17], 'SCENES', BRIEF_TRAILING_MARKERS);
    const p17 = parsed.pages.find((p: any) => p.pageNumber === 17);
    expect(p17).toBeTruthy();
    expect(p17.text).not.toMatch(/VISUAL\s+BIBLE/i);
    expect(p17.text).not.toMatch(/LOC004\.1/);
  });

  it('leaves the last brief its own METADATA block — a page is not cut at ---METADATA---', () => {
    const parsed = parseRefinedText(REVIEW_REPLY, [16, 17], 'SCENES', BRIEF_TRAILING_MARKERS);
    const p17 = parsed.pages.find((p: any) => p.pageNumber === 17);
    const meta = extractSceneMetadata(p17.text);
    expect(meta).toBeTruthy();
    expect(meta.isRecovered).not.toBe(true);
    // The brief NAMES the creature and the vantage; both must survive the split.
    expect(meta.objects).toEqual(['LOC005.3', 'ANI003', 'CLO002']);
    expect(meta.characters).toEqual(['the younger child']);
  });

  it('still parses every earlier page, and the analysis, unchanged', () => {
    const parsed = parseRefinedText(REVIEW_REPLY, [16, 17], 'SCENES', BRIEF_TRAILING_MARKERS);
    expect(parsed.pages.map((p: any) => p.pageNumber)).toEqual([16, 17]);
    expect(parsed.missing).toEqual([]);
    expect(parsed.analysis).toMatch(/FAULTED PAGES: 16, 17/);
    const p16 = parsed.pages.find((p: any) => p.pageNumber === 16);
    expect(extractSceneMetadata(p16.text).objects).toEqual(['LOC005.2', 'ART001']);
  });

  it('is unaffected when the reviewer corrected no entry and emits no block', () => {
    const noBlock = REVIEW_REPLY.split('---VISUAL BIBLE---')[0].trimEnd();
    const parsed = parseRefinedText(noBlock, [16, 17], 'SCENES', BRIEF_TRAILING_MARKERS);
    expect(parsed.pages.map((p: any) => p.pageNumber)).toEqual([16, 17]);
    const meta = extractSceneMetadata(parsed.pages[1].text);
    expect(meta.objects).toEqual(['LOC005.3', 'ANI003', 'CLO002']);
  });

  it('WITHOUT the terminator the block is swallowed — the regression this pins', () => {
    const parsed = parseRefinedText(REVIEW_REPLY, [16, 17], 'SCENES');
    const p17 = parsed.pages.find((p: any) => p.pageNumber === 17);
    expect(p17.text).toMatch(/VISUAL\s+BIBLE/i);
  });
});

/**
 * ONE CONSTANT, NOT A LITERAL PER CALL SITE. Six call sites parse a reply that
 * carries `## Page N` briefs — the all-pages Art Director expansion, the live
 * review and its worn-state round (beatsPipeline.js), and the Lab's expansion
 * replay plus both of its review replays (testlab.js). A terminator added at
 * one of them only leaves the others splicing the section back into a brief.
 */
describe('every brief-reply parser passes the terminator', () => {
  const fs = require_('node:fs');
  const path = require_('node:path');
  const root = path.join(__dirname, '..', '..');

  it('names BRIEF_TRAILING_MARKERS at every SCENES call site', () => {
    const seen: string[] = [];
    for (const rel of ['server/lib/beatsPipeline.js', 'server/lib/testlab.js']) {
      const src = fs.readFileSync(path.join(root, rel), 'utf8');
      // The Lab aliases the import as `parseAll`; both spellings count.
      const calls = src.match(/(?:parseRefinedText|parseAll)\([^;]*?'SCENES'[^;]*?\)/g) || [];
      expect(calls.length, `${rel} has no 'SCENES' brief-reply parse`).toBeGreaterThan(0);
      for (const call of calls) {
        seen.push(`${rel}: ${call}`);
        expect(call, `${rel}: ${call}`).toMatch(/BRIEF_TRAILING_MARKERS/);
      }
    }
    // A call site deleted without replacement would pass the loop above.
    expect(seen.length).toBeGreaterThanOrEqual(6);
  });

  it('the constant names the block the two brief templates actually emit', () => {
    for (const tpl of ['scene-review.txt', 'scene-expansion-all.txt']) {
      const template = fs.readFileSync(path.join(root, 'prompts', tpl), 'utf8');
      for (const name of BRIEF_TRAILING_MARKERS) {
        expect(template, tpl).toContain(`---${name}---`);
      }
    }
  });
});
