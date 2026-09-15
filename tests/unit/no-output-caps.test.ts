/**
 * Owner rule (2026-08-29, re-ordered 2026-09-11): NO output caps — every text
 * call runs at the model's own maxOutputTokens. This test scans the source and
 * FAILS when a numeric literal is passed as the max-tokens argument to any
 * text-model entry point, or as max_tokens / maxOutputTokens on a direct
 * provider call. The only exceptions are the allow-listed sites below, each
 * with the reason the owner may veto.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '../..');

// Direct provider calls that keep a numeric cap, with the reason.
const KEPT_DIRECT_CAPS: Array<{ file: string; match: RegExp; why: string }> = [
  { file: 'server/routes/admin/diagnostics.js', match: /max_tokens: 1,/,
    why: 'API-key liveness ping ("hi"); the reply is discarded' },
  { file: 'server/lib/bboxDetection.js', match: /maxOutputTokens: 2500,/,
    why: 'documented pressure valve: gemini-2.5-flash-lite repetition loops run to 15k+ tokens inside one label; failing fast hands off to the Grok fallback' },
];

// Files whose numeric max-tokens are NOT call-site caps.
const NOT_CALL_SITES = new Set([
  'server/config/models.js',       // TEXT_MODELS[*].maxOutputTokens — the model ceilings themselves
  'server/lib/textModels.js',      // passes the resolved ceiling through to the provider
  'scripts/test-models.js',        // registers ad-hoc TEXT_MODELS entries for a bake-off
]);

function listJs(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'client') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listJs(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const FILES = [
  ...listJs(path.join(ROOT, 'server')),
  ...listJs(path.join(ROOT, 'scripts')),
  path.join(ROOT, 'storyJobPipeline.js'),
  path.join(ROOT, 'server.js'),
].filter(f => fs.existsSync(f));

const rel = (f: string) => path.relative(ROOT, f).replace(/\\/g, '/');

/** Top-level argument list of the call starting at `open` (index of "("), quote/paren aware. */
function splitArgs(src: string, open: number): string[] | null {
  const args: string[] = [];
  let depth = 0, cur = '', i = open + 1, quote: string | null = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      cur += c;
      if (c === '\\') { cur += src[++i]; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; cur += c; continue; }
    if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) { args.push(cur.trim()); return args; }
      depth--; cur += c; continue;
    }
    if (c === ',' && depth === 0) { args.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  return null;
}

const ENTRY_POINTS = /\b(callTextModel|callTextModelStreaming|callClaudeAPI|callStream|callAnthropicAPI|callAnthropicAPIStreaming|callGeminiTextAPI|callGeminiTextAPIStreaming|callXaiAPI|callXaiAPIStreaming|callOpenRouterAPI|callOpenRouterAPIStreaming)\s*\(/g;

describe('no output caps — text-model entry points', () => {
  it('no call passes a numeric literal as the max-tokens argument (null = model max)', () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      const r = rel(f);
      if (r === 'server/lib/textModels.js') continue;   // the provider functions themselves
      const src = fs.readFileSync(f, 'utf8');
      let m: RegExpExecArray | null;
      ENTRY_POINTS.lastIndex = 0;
      while ((m = ENTRY_POINTS.exec(src))) {
        // skip definitions and doc mentions
        const before = src.slice(Math.max(0, m.index - 20), m.index);
        if (/function\s+$/.test(before) || /\*\s*$/.test(before) || /\/\/[^\n]*$/.test(before)) continue;
        const args = splitArgs(src, m.index + m[0].length - 1);
        if (!args || args.length < 2) continue;
        if (/^\d+$/.test(args[1])) {
          const line = src.slice(0, m.index).split('\n').length;
          offenders.push(`${r}:${line} ${m[1]}(…, ${args[1]}, …)`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('textModels.js itself defaults maxTokens to null on every public entry point', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/lib/textModels.js'), 'utf8');
    expect(src).toMatch(/async function callTextModel\(prompt, maxTokens = null,/);
    expect(src).toMatch(/async function callTextModelStreaming\(prompt, maxTokens = null,/);
    expect(src).toMatch(/async function callClaudeAPI\(prompt, maxTokens = null,/);
    expect(src).not.toMatch(/maxTokens = \d+/);
  });
});

describe('no output caps — direct provider calls (max_tokens / maxOutputTokens / max_completion_tokens)', () => {
  it('every numeric cap outside TEXT_MODELS is on the kept list', () => {
    const offenders: string[] = [];
    const seenKept = new Set<string>();
    for (const f of FILES) {
      const r = rel(f);
      if (NOT_CALL_SITES.has(r)) continue;
      const src = fs.readFileSync(f, 'utf8');
      const re = /\b(max_tokens|maxOutputTokens|max_output_tokens|max_completion_tokens)\s*:\s*(\d+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const line = src.slice(0, m.index).split('\n').length;
        const lineText = src.split('\n')[line - 1];
        if (/^\s*\/\//.test(lineText)) continue;  // a comment quoting the old value
        const kept = KEPT_DIRECT_CAPS.find(k => k.file === r && k.match.test(m![0] + ','));
        if (kept) { seenKept.add(kept.file + kept.match.source); continue; }
        offenders.push(`${r}:${line} ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
    // Every kept entry must still exist — a stale allow-list hides a removal.
    for (const k of KEPT_DIRECT_CAPS) expect(seenKept.has(k.file + k.match.source), `kept cap no longer present: ${k.file} ${k.match}`).toBe(true);
  });

  it('client-controlled passthroughs keep no server-side numeric default the model could hit silently', () => {
    // ai-proxy forwards the client's max_tokens with an 8192 fallback and WARNS
    // on stop_reason max_tokens; listed for the owner in BACKLOG, not a call this
    // pipeline makes. Pin the warning so a silent truncation there stays impossible.
    const src = fs.readFileSync(path.join(ROOT, 'server/routes/ai-proxy.js'), 'utf8');
    expect(src).toMatch(/stop_reason === 'max_tokens'/);
  });
});

describe('callers that must react to a truncated reply (source-level wiring)', () => {
  const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  it('beatsPipeline: the scene review falls back to the raw briefs; worn throws into its catch; arc creator retries', () => {
    const src = read('server/lib/beatsPipeline.js');
    expect(src).toMatch(/const srTruncated = !!srRes\.truncation\?\.suspected;/);
    expect(src).toMatch(/const parsed = srTruncated \? \{ analysis: '', pages: \[\] \} : parseRefinedText\(srRes\.text/);
    expect(src).toMatch(/failed: sceneReviewFailed,/);
    expect(src).toMatch(/if \(wrRes\.truncation\?\.suspected\) throw new Error/);
    expect(src).toMatch(/if \(res\.truncation\?\.suspected\) throw new Error\(`reply \$\{textModels\.describeTruncation\(res\.truncation\)\}`\);/);
    // The `rrRes` guard that used to be asserted here belonged to the scene
    // review's SECOND reviewer round, deleted in 27c37dfd9 ("kill the scene
    // review's second reviewer round") because it measured net break-even.
    // The guard went with the round; `rrRes` no longer exists anywhere.
    expect(src).not.toMatch(/\brrRes\b/);
  });
  it('textRefine: audit → ok:false, repair/diff/lector → throw into the catch that keeps the input text; no MAX_OUT literal left', () => {
    const src = read('server/lib/textRefine.js');
    expect(src).not.toMatch(/MAX_OUT/);
    expect(src).toMatch(/if \(r\.truncation\?\.suspected\) \{\s*const error = `audit reply/);
    expect(src).toMatch(/if \(r\.truncation\?\.suspected\) \{\s*throw new Error\(`reply \$\{describeTruncation\(r\.truncation\)\} — rewrites unusable`\)/);
    expect(src).toMatch(/if \(dr\.truncation\?\.suspected\) throw new Error/);
    expect(src).toMatch(/if \(lr\.truncation\?\.suspected\) throw new Error/);
  });
  it('storyJobPipeline: a truncated outline review is a failed attempt (retry once, then unpatched draft)', () => {
    const src = read('storyJobPipeline.js');
    expect(src).toMatch(/if \(reviewResult\.truncation\?\.suspected\) \{[\s\S]*?continue;\s*\}/);
  });
  it('evalPipeline: truncated compliance reply → evalFailed with the reason; MAX_TOKENS inventory → null with the reason', () => {
    const src = read('server/lib/evalPipeline.js');
    expect(src).toMatch(/if \(sonnetResult\.truncation\?\.suspected\) \{[\s\S]*?return \{ evalFailed: true, evalError: `compliance reply \$\{reason\}`/);
    expect(src).toMatch(/if \(threeStageResult\?\.evalFailed\)/);
    expect(src).toMatch(/threeStageResult && threeStageResult\.evalFailed/);
    expect(src).toMatch(/p1Data\.candidates\[0\]\?\.finishReason === 'MAX_TOKENS'\) \{[\s\S]{0,400}?evalFailed: inventory TRUNCATED[\s\S]{0,200}?return null;/);
  });
  it('health/config reports the counter', () => {
    expect(read('server/routes/health.js')).toMatch(/textTruncation: require\('\.\.\/lib\/textReplyGuard'\)\.getTruncationStats\(\)/);
  });
});
