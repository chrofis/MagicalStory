import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const promptsDir = path.join(here, '..', '..', 'prompts');
const read = (f: string) => readFileSync(path.join(promptsDir, f), 'utf8');

// BEHAVIOUR PINNED — THE REASON, so no future session "helpfully" wires this up:
//
// The two late-stage TEXT judges — the refiner (prompts/text-refine.txt) and the
// arc-informed auditor (prompts/story-text-audit.txt) — must NOT see the
// pre-arc commission ({STORY_BRIEF}: title, category, theme, topic, season,
// setting, relationships and the user's own story idea).
//
// By this stage the ARC is the master. The generator that wrote this text was
// deliberately denied the commission and wrote from the arc and the page plan.
// A judge that can see the commission grades the text against a spec its writer
// never had — it "fixes" prose toward ideas the arc consciously dropped. That is
// spec drift, and it is severe because the judges' findings are applied.
//
// Until 2026-09-13 a STORY_BRIEF value was computed and passed into both
// templates. Neither declared the placeholder, so fillTemplate silently dropped
// it — the accident was load-bearing. The argument was deleted rather than
// wired up (owner decision), and this test pins the absence.
//
// If you are here because you want the brief in one of these prompts: don't.
// Put the fact in the ARC, which both the writer and the judge already read.

const JUDGE_TEMPLATES = ['text-refine.txt', 'story-text-audit.txt'];

describe('the late text judges never receive the pre-arc commission', () => {
  for (const file of JUDGE_TEMPLATES) {
    it(`${file} declares no {STORY_BRIEF} placeholder`, () => {
      expect(read(file)).not.toContain('{STORY_BRIEF}');
    });
  }

  it('the builders pass no STORY_BRIEF into either template', () => {
    // Normalise line endings first. core.autocrlf=true checks .js out as CRLF on
    // Windows (.gitattributes pins eol=lf for *.txt and *.md only), so the
    // newline-brace-newline scan below found nothing, sliced to the end of the
    // file, and this test then read every builder in it. It passed only on an LF
    // working tree.
    const src = readFileSync(path.join(here, '..', '..', 'server', 'lib', 'promptBuilders.js'), 'utf8')
      .split(String.fromCharCode(13) + String.fromCharCode(10)).join(String.fromCharCode(10));
    // Scope to the two builder bodies: STORY_BRIEF is legitimate elsewhere
    // (arc-create, arc-panel, the arc audit, the child critic, scene review…).
    for (const fn of ['function buildTextRefinePrompt', 'function buildTextAuditPrompt']) {
      const start = src.indexOf(fn);
      expect(start, `${fn} not found — rename?`).toBeGreaterThan(-1);
      const body = src.slice(start, src.indexOf('\n}\n', start));
      expect(body).not.toContain('STORY_BRIEF:');
    }
  });

  it('other templates may still declare {STORY_BRIEF} — this ban is scoped', () => {
    expect(read('arc-create.txt')).toContain('{STORY_BRIEF}');
  });
});
