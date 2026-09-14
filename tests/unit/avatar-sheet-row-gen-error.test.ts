/**
 * Pass-1 row generation: a THROWN backend call consumes one try, never the sheet
 * (server/lib/character2x4Sheet.js → generateComposited2x4).
 *
 * Origin: backlog #53. `avatar_guarantee_fallback` fired on two of three staging
 * validation runs — Max on job_1789337998754_apslnsq1z, Julian on
 * job_1789343124794_z2c779f7i — and the stored styled-avatar audit named the
 * same reason both times:
 *
 *   "generation threw: [CHARACTER 2×4] pass-1 generation failed for <name>:
 *    The operation was aborted due to timeout"
 *
 * Not a Gemini IMAGE_OTHER safety refusal and not a gate rejection: the 120s
 * AbortSignal.timeout on editWithGrok threw, and the throw propagated straight
 * out of the row loop that had a second try provisioned. One transient HTTP
 * timeout therefore destroyed a whole sheet. Pass 2 already contained per-attempt
 * throws (stage 'gen-error', decisions.md 2026-07-30 layer 1); Pass 1 did not.
 *
 * What is pinned here is behaviour, not wording: a throw is retried, a recovered
 * sheet ships, the failed try is recorded in attemptHistory, and a sheet where
 * EVERY try throws still fails loudly.
 *
 * The module can't be require()'d (native sharp + side effects), so the REAL
 * function source is sliced out and run in an isolated vm with the backend and
 * the row judges stubbed.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const SRC = fs.readFileSync(
  path.join(__dirname, '../../server/lib/character2x4Sheet.js'),
  'utf8'
);

function extractFunction(src: string, name: string): string {
  let start = src.indexOf(`async function ${name}(`);
  if (start === -1) start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`could not find function ${name}`);
  let p = src.indexOf('(', start);
  let pdepth = 0;
  for (; p < src.length; p++) {
    if (src[p] === '(') pdepth++;
    else if (src[p] === ')') { pdepth--; if (pdepth === 0) { p++; break; } }
  }
  let i = src.indexOf('{', p);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

const TIMEOUT = 'The operation was aborted due to timeout';

/**
 * @param throwsOn e.g. ['body:1'] — throw on try 1 of the body row.
 */
async function runPass1(throwsOn: string[] = []) {
  const remaining = new Set(throwsOn);
  const calls = { body: 0, head: 0, warns: [] as string[] };
  const ctx: any = {
    module: { exports: {} },
    log: { info() {}, debug() {}, error() {}, warn(m: string) { calls.warns.push(m); } },
    GROK_MODELS: { STANDARD: 'grok-imagine-image' },
    MODEL_DEFAULTS: { sheetEvalModel: 'gemini-2.5-flash' },
    resolveFacePhoto: async () => 'data:image/jpeg;base64,FACE',
    resolveStandardAvatar: async () => 'data:image/jpeg;base64,AVATAR',
    splitSheetRows: async () => ({ topHeads: 'data:image/jpeg;base64,HEADS' }),
    loadPhantomVariant: () => 'phantom',
    phantomRow: async () => 'data:image/jpeg;base64,PHANTOM',
    buildBodyRowPrompt: () => 'BODY PROMPT',
    buildHeadRowPrompt: () => 'HEAD PROMPT',
    editWithGrok: async (prompt: string) => {
      const row = prompt === 'BODY PROMPT' ? 'body' : 'head';
      const t = row === 'body' ? ++calls.body : ++calls.head;
      if (remaining.delete(`${row}:${t}`)) throw new Error(TIMEOUT);
      return { imageData: `data:image/jpeg;base64,${row.toUpperCase()}${t}`, usage: null, modelId: 'grok-imagine-image' };
    },
    reviewBodyRow: async () => ({ valid: true, score: 9, bodies: { finalScore: 9, outfit: { outfitScore: 9 }, fullBody: { fullBodyScore: 10 }, failureReasons: [] } }),
    reviewHeadRow: async () => ({ valid: true, score: 9, heads: { finalScore: 9, cleanRender: { cleanScore: 9 }, failureReasons: [] }, identity: { identityScore: 9, reason: 'ok' } }),
    stackRowsInto2x4: async (head: string, body: string) => ({ imageData: `SHEET(${head}|${body})`, splitY: 100 }),
    require: () => ({}),
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(
    `${extractFunction(SRC, 'generateComposited2x4')}\nmodule.exports = generateComposited2x4;`,
    ctx
  );
  const fn = ctx.module.exports as (c: any, o: any) => Promise<any>;
  const out = await fn({ name: 'TestChar', age: 8 }, { costumeDescription: 'standard outfit' });
  return { out, calls };
}

describe('Pass 1 row generation — a thrown backend call consumes ONE try, not the sheet', () => {
  it('a body-row timeout on try 1 is retried and the sheet still ships', async () => {
    const { out, calls } = await runPass1(['body:1']);
    expect(calls.body).toBe(2);
    expect(out.imageData).toContain('BODY2');
    expect(out.verdict.valid).toBe(true);
  });

  it('a head-row timeout on try 1 is retried and the sheet still ships', async () => {
    const { out, calls } = await runPass1(['head:1']);
    expect(calls.head).toBe(2);
    expect(out.imageData).toContain('HEAD2');
  });

  it('the failed try is recorded in attemptHistory, never swallowed', async () => {
    const { out, calls } = await runPass1(['body:1']);
    const failed = out.attemptHistory.filter((a: any) => a.error);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ stage: 'body', try: 1 });
    expect(failed[0].error).toContain(TIMEOUT);
    expect(calls.warns.join(' ')).toContain(TIMEOUT);
  });

  it('BOTH body tries throwing still fails loudly, carrying the provider error', async () => {
    await expect(runPass1(['body:1', 'body:2'])).rejects.toThrow(/body row produced no image for TestChar.*aborted due to timeout/);
  });

  it('BOTH head tries throwing still fails loudly, carrying the provider error', async () => {
    await expect(runPass1(['head:1', 'head:2'])).rejects.toThrow(/head row produced no image for TestChar.*aborted due to timeout/);
  });

  it('a clean run is unaffected — one call per row, no retries', async () => {
    const { out, calls } = await runPass1();
    expect(calls.body).toBe(1);
    expect(calls.head).toBe(1);
    expect(out.attemptHistory.filter((a: any) => a.error)).toHaveLength(0);
    expect(out.verdict.finalScore).toBe(9);
  });
});
