import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

const { checkFaceIntegrity } = require_('../../server/lib/faceIntegrityGate.js');
const { MODEL_DEFAULTS } = require_('../../server/config/models.js');
const textModels = require_('../../server/lib/textModels.js');
const prompts = require_('../../server/services/prompts.js');

const log = { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} };

let calls: any[] = [];
let reply: any = null;
let realCall: any;
let realTemplate: any;

beforeEach(() => {
  calls = [];
  reply = null;
  realCall = textModels.callTextModel;
  realTemplate = prompts.PROMPT_TEMPLATES.repairFaceCheck;
  // The templates are loaded at boot in production; give the gate one here.
  prompts.PROMPT_TEMPLATES.repairFaceCheck = 'Is {CHARACTER} still intact?';
  textModels.callTextModel = async (prompt: string, maxTokens: any, modelId: string, opts: any) => {
    calls.push({ prompt, maxTokens, modelId, opts });
    if (typeof reply === 'function') return reply();
    return reply;
  };
});

afterEach(() => {
  textModels.callTextModel = realCall;
  prompts.PROMPT_TEMPLATES.repairFaceCheck = realTemplate;
});

describe('face-integrity gate', () => {
  it('the configured model exists — the gate fell back to a hardcoded id because this key was missing', () => {
    expect(typeof MODEL_DEFAULTS.repairFaceCheck).toBe('string');
    expect(MODEL_DEFAULTS.repairFaceCheck.length).toBeGreaterThan(0);
  });

  it('refuses a repair whose verdict says the face is not intact', async () => {
    reply = { text: '{"intact": false, "reason": "face smeared"}' };
    expect(await checkFaceIntegrity('data:before', 'data:after', 'CharacterA', { log }))
      .toEqual({ ok: false, available: true, reason: 'face smeared' });
  });

  it('accepts an intact verdict', async () => {
    reply = { text: 'sure: {"intact": true}' };
    expect(await checkFaceIntegrity('data:before', 'data:after', 'CharacterA', { log }))
      .toEqual({ ok: true, available: true, reason: null });
  });

  it('sends before and after in that order, uncapped, on the configured model', async () => {
    reply = { text: '{"intact": true}' };
    await checkFaceIntegrity('data:before', 'data:after', 'CharacterA', { log });
    expect(calls).toHaveLength(1);
    expect(calls[0].opts.images).toEqual(['data:before', 'data:after']);
    expect(calls[0].maxTokens).toBeNull(); // no output caps, ever
    expect(calls[0].modelId).toBe(MODEL_DEFAULTS.repairFaceCheck);
    expect(calls[0].prompt).toContain('CharacterA');
  });

  it('fails OPEN and says so when the model throws', async () => {
    reply = () => { throw new Error('502 upstream'); };
    expect(await checkFaceIntegrity('data:before', 'data:after', 'CharacterA', { log }))
      .toEqual({ ok: true, available: false, reason: '502 upstream' });
  });

  it('fails OPEN and says so when the verdict is unparsable', async () => {
    reply = { text: 'I could not tell.' };
    const r = await checkFaceIntegrity('data:before', 'data:after', 'CharacterA', { log });
    expect(r.ok).toBe(true);
    expect(r.available).toBe(false);
  });

  it('reports usage under the repair_face_check label', async () => {
    reply = { text: '{"intact": true}', usage: { input_tokens: 5 }, modelId: 'x' };
    const seen: any[] = [];
    await checkFaceIntegrity('a', 'b', 'CharacterA', { log, usageTracker: (...args: any[]) => seen.push(args) });
    expect(seen[0][2]).toBe('repair_face_check');
  });
});

describe('the gate is wired into all three char-repair entry points', () => {
  const fs = require_('fs');
  const path = require_('path');
  const ROOT = path.resolve(__dirname, '../..');
  for (const rel of [
    'server/lib/repairPipeline.js',
    'server/lib/entityConsistency.js',
    'server/routes/regeneration.js',
  ]) {
    it(`${rel} calls checkFaceIntegrity`, () => {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      expect(src).toContain('faceIntegrityGate');
      expect(src).toContain('checkFaceIntegrity');
    });
  }
});
