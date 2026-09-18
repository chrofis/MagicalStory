import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  assessImageResponse, classifyImageFinishReason, describeImageBlock, describeImageOutcome,
  IMAGE_REFUSAL_REASONS,
} = require('../../server/lib/imageReplyGuard.js');
const {
  NATURAL_STOP, TRUNCATING_STOP_REASONS, REFUSING_STOP_REASONS,
} = require('../../server/lib/textReplyGuard.js');

/** A Gemini image/vision response envelope. */
const resp = (finishReason: string | null, over: any = {}) => ({
  candidates: [{ ...(finishReason === null ? {} : { finishReason }), content: { parts: [{ text: 'ok' }] } }],
  ...over,
});

// Every non-natural value the v1beta FinishReason enum defines
// (googleapis/googleapis generative_service.proto, read 2026-09-18).
const GEMINI_NON_NATURAL = [
  'FINISH_REASON_UNSPECIFIED', 'SAFETY', 'RECITATION', 'LANGUAGE', 'OTHER',
  'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'MALFORMED_FUNCTION_CALL',
  'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'IMAGE_OTHER', 'NO_IMAGE',
  'IMAGE_RECITATION', 'UNEXPECTED_TOOL_CALL', 'TOO_MANY_TOOL_CALLS',
];

describe('classifyImageFinishReason — the allow-list decides', () => {
  it('STOP is the only Gemini value that passes', () => {
    expect(classifyImageFinishReason('STOP')).toBe('natural');
    for (const r of GEMINI_NON_NATURAL) {
      expect(classifyImageFinishReason(r), `${r} must not classify as natural`).not.toBe('natural');
    }
  });

  it('MAX_TOKENS is a truncation, never a refusal (its own retry path keys off that)', () => {
    expect(classifyImageFinishReason('MAX_TOKENS')).toBe('truncation');
    expect(assessImageResponse(resp('MAX_TOKENS'))).toMatchObject({ blocked: false, truncated: true, cls: 'truncation' });
  });

  it('the IMAGE_* family is a refusal — the exact hole the two-value list left open', () => {
    for (const r of ['IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'IMAGE_OTHER', 'IMAGE_RECITATION', 'NO_IMAGE']) {
      expect(classifyImageFinishReason(r), r).toBe('refusal');
    }
  });

  it('the reasons the old two-value test missed are all refusals', () => {
    for (const r of ['RECITATION', 'BLOCKLIST', 'SPII', 'LANGUAGE', 'ESCALATION', 'OTHER', 'FINISH_REASON_UNSPECIFIED']) {
      expect(classifyImageFinishReason(r), r).toBe('refusal');
    }
  });

  it('the two the old test DID catch still classify as refusals', () => {
    expect(classifyImageFinishReason('SAFETY')).toBe('refusal');
    expect(classifyImageFinishReason('PROHIBITED_CONTENT')).toBe('refusal');
  });

  it('a value Google invents later is unknown — and unknown is NOT a pass', () => {
    expect(classifyImageFinishReason('MODEL_ARMOR')).toBe('unknown');
    expect(classifyImageFinishReason('IMAGE_SOMETHING_NEW')).toBe('unknown');
    expect(assessImageResponse(resp('MODEL_ARMOR')).blocked).toBe(true);
  });

  it('matching is case-insensitive and whitespace-tolerant', () => {
    expect(classifyImageFinishReason('image_other')).toBe('refusal');
    expect(classifyImageFinishReason('  Prohibited_Content ')).toBe('refusal');
    expect(classifyImageFinishReason('stop')).toBe('natural');
  });

  it('absent is distinct from unknown — no reason reported is not an alarm', () => {
    expect(classifyImageFinishReason(null)).toBe('absent');
    expect(classifyImageFinishReason(undefined)).toBe('absent');
    expect(classifyImageFinishReason('')).toBe('absent');
    expect(assessImageResponse(resp(null))).toMatchObject({ blocked: false, cls: 'absent', reason: null });
  });

  it('the synthesized Grok / OpenRouter vision envelopes (finishReason STOP) pass', () => {
    expect(assessImageResponse(resp('STOP')).blocked).toBe(false);
    // and the OpenAI-shaped words those providers use natively
    expect(classifyImageFinishReason('end_turn')).toBe('natural');
  });
});

describe('assessImageResponse — prompt-level and structural blocks', () => {
  it('any promptFeedback.blockReason blocks and is named', () => {
    for (const r of ['SAFETY', 'OTHER', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'IMAGE_SAFETY']) {
      const v = assessImageResponse({ promptFeedback: { blockReason: r }, candidates: [] });
      expect(v).toMatchObject({ blocked: true, source: 'promptFeedback', reason: r });
      expect(describeImageBlock(v)).toContain(r);
    }
  });

  it('no candidates blocks', () => {
    expect(assessImageResponse({ candidates: [] }).blocked).toBe(true);
    expect(assessImageResponse({}).blocked).toBe(true);
    expect(assessImageResponse(null).blocked).toBe(true);
    expect(assessImageResponse({ candidates: [] }).source).toBe('no-candidates');
  });

  it('a candidate-level blockReason blocks', () => {
    const v = assessImageResponse({ candidates: [{ blockReason: 'PROHIBITED_CONTENT' }] });
    expect(v).toMatchObject({ blocked: true, source: 'candidate', reason: 'PROHIBITED_CONTENT' });
  });

  it('a clean response is not blocked', () => {
    expect(assessImageResponse(resp('STOP'))).toMatchObject({ blocked: false, truncated: false, cls: 'natural' });
  });
});

describe('the reason reaches the operator', () => {
  it('describeImageBlock always names the literal provider value', () => {
    expect(describeImageBlock(assessImageResponse(resp('IMAGE_OTHER')))).toContain('IMAGE_OTHER');
    expect(describeImageBlock(assessImageResponse(resp('MODEL_ARMOR')))).toContain('MODEL_ARMOR');
    expect(describeImageBlock(assessImageResponse(resp('MODEL_ARMOR')))).toMatch(/UNRECOGNISED/);
    expect(describeImageBlock(assessImageResponse(resp('MAX_TOKENS')))).toContain('MAX_TOKENS');
    expect(describeImageBlock(assessImageResponse({ candidates: [] }))).toBe('no candidates in response');
  });

  it('describeImageOutcome is informative even when nothing was blocked', () => {
    // "expected an image, got none" with a natural finish reason must still say STOP.
    expect(describeImageOutcome(assessImageResponse(resp('STOP')))).toBe('finishReason=STOP');
    expect(describeImageOutcome(assessImageResponse(resp(null)))).toBe('no finish reason reported');
    expect(describeImageOutcome(assessImageResponse(resp('IMAGE_SAFETY')))).toContain('IMAGE_SAFETY');
  });
});

describe('ONE source of truth — the shared vocabulary is imported, never copied', () => {
  it('every text-guard refusal reason is also a refusal on the image path', () => {
    for (const r of REFUSING_STOP_REASONS as Set<string>) {
      expect(classifyImageFinishReason(r), r).toBe('refusal');
    }
  });

  it('every text-guard truncation reason is a truncation on the image path', () => {
    for (const r of TRUNCATING_STOP_REASONS as Set<string>) {
      expect(classifyImageFinishReason(r), r).toBe('truncation');
    }
  });

  it('every text-guard natural reason passes on the image path', () => {
    for (const r of NATURAL_STOP as Set<string>) {
      expect(classifyImageFinishReason(r), r).toBe('natural');
    }
  });

  it('the image-only set adds ONLY values the text guard does not already carry', () => {
    const shared = new Set<string>([...(REFUSING_STOP_REASONS as Set<string>), ...(TRUNCATING_STOP_REASONS as Set<string>), ...(NATURAL_STOP as Set<string>)]);
    for (const r of IMAGE_REFUSAL_REASONS as Set<string>) {
      expect(shared.has(r), `${r} is declared in both guards — that is the drift this set exists to prevent`).toBe(false);
    }
  });
});

// ── Call-site wiring ────────────────────────────────────────────────────────
// Source-scanned rather than imported: requiring images.js / evalPipeline.js
// pulls in the whole provider graph, which this machine cannot afford. These
// pin the SHAPE of the fix, not any wording.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '../..');

/** File source with `//`-style and `*`-continuation comment lines removed. */
function codeOf(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
    .split(/\r?\n/)
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');
}

function listJs(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') listJs(p, out); }
    else if (e.name.endsWith('.js')) out.push(path.relative(ROOT, p).split(path.sep).join('/'));
  }
  return out;
}

describe('image call sites read the guard, not a two-value refusal list', () => {
  it('no file tests a candidate finishReason against a refusal literal any more', () => {
    const offenders: string[] = [];
    for (const rel of listJs(path.join(ROOT, 'server'))) {
      const code = codeOf(rel);
      // The exact bug shape: `finishReason` compared to a Gemini refusal value.
      const m = code.match(/finishReason\s*(===|==|!==|!=)\s*['"](SAFETY|PROHIBITED_CONTENT|RECITATION|BLOCKLIST|SPII|LANGUAGE|IMAGE_[A-Z_]+|NO_IMAGE)['"]/g);
      if (m) offenders.push(`${rel}: ${m.join(', ')}`);
    }
    // avatars.js keys its RETRY policy off IMAGE_OTHER on purpose (which
    // refusals are worth paying to retry is a cost decision, not this fix);
    // it already fails loudly on every other reason.
    const allowed = /^server\/routes\/avatars\.js:/;
    expect(offenders.filter((o) => !allowed.test(o))).toEqual([]);
  });

  it('the three fixed sites delegate to imageReplyGuard', () => {
    for (const rel of ['server/lib/images.js', 'server/lib/evalPipeline.js', 'server/lib/character2x4Sheet.js']) {
      const code = codeOf(rel);
      expect(code, rel).toContain("require('./imageReplyGuard')");
      expect(code, rel).toContain('assessImageResponse(');
    }
  });

  it('isBlockedResponse is the guard verdict, so MAX_TOKENS keeps its own retry path', () => {
    const code = codeOf('server/lib/evalPipeline.js');
    expect(code).toMatch(/const isBlockedResponse = \(responseData\) => assessImageResponse\(responseData\)\.blocked;/);
    // the dedicated MAX_TOKENS retry must still exist downstream of it
    expect(code).toContain("finishReason === 'MAX_TOKENS'");
  });

  it('imageReplyGuard declares no copy of the shared vocabulary', () => {
    const code = codeOf('server/lib/imageReplyGuard.js');
    expect(code).toContain("require('./textReplyGuard')");
    for (const shared of ['NATURAL_STOP', 'TRUNCATING_STOP_REASONS', 'REFUSING_STOP_REASONS']) {
      // each name appears ONLY in the import destructuring and in use — never
      // as a `const X = new Set(` of its own.
      expect(code, shared).not.toMatch(new RegExp('const\s+' + shared + '\s*='));
    }
  });
});
