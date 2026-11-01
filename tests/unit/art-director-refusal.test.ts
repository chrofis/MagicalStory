import { describe, it, expect, vi } from 'vitest';

// Bug art-director-safety-refusal-shipped-as-brief (2026-10-31): Google refused the bedtime page briefs
// (PROHIBITED_CONTENT); a cut-off refused reply was shipped as page 6's brief and the story failed 20 minutes later.
// Owner: a refused Art Director call is asked once on another model; refused again, the run stops.
const { askArtDirector, ArtDirectorRefusedError, isRefusal } = require('../../server/lib/artDirectorCall.js');
const { MODEL_DEFAULTS } = require('../../server/config/models.js');

const ok = (text: string, modelId = 'm') => ({ text, modelId, truncation: { suspected: false } });
const refused = (text = 'In a waist-') => ({
  text, modelId: 'google/gemini-3.1-pro-preview', provider: 'Google AI Studio',
  truncation: { suspected: true, reason: 'refusal', stopReason: 'content_filter', outputTokens: 0, provider: 'Google AI Studio' },
});

describe('askArtDirector', () => {
  it('passes a normal reply through with one call', async () => {
    const call = vi.fn(async () => ok('brief'));
    const res = await askArtDirector('P', null, 'gemini-3.7-flash', { usageLabel: 'beats_scene_expansion' }, { call });
    expect(res.text).toBe('brief');
    expect(call).toHaveBeenCalledTimes(1);
    expect(res.refusalReroute).toBeUndefined();
  });

  it('a cut reply that is not a refusal stays the caller\'s business (no reroute)', async () => {
    const cut = { text: 'half', truncation: { suspected: true, reason: 'cap_hit' } };
    const call = vi.fn(async () => cut);
    const res = await askArtDirector('P', null, 'gemini-3.7-flash', {}, { call });
    expect(res).toBe(cut);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('a refused reply is never returned: the same prompt goes once to the refusal model, with only the usage label', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce(refused())
      .mockResolvedValueOnce(ok('a whole brief', 'claude-sonnet-5-5'));
    const res = await askArtDirector('THE PROMPT', null, 'gemini-3.1-pro', { usageLabel: 'beats_scene_expansion_fallback', reasoning: { effort: 'low' } }, { call });
    expect(res.text).toBe('a whole brief');
    expect(res.refusalReroute).toMatchObject({ refusedModel: 'gemini-3.1-pro', refusedProvider: 'Google AI Studio', model: MODEL_DEFAULTS.artDirectorRefusalModel });
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1][0]).toBe('THE PROMPT');
    expect(call.mock.calls[1][3]).toBe(MODEL_DEFAULTS.artDirectorRefusalModel);
    expect(call.mock.calls[1][4]).toEqual({ usageLabel: 'beats_scene_expansion_fallback_refusal_reroute' });
  });

  it('refused by both models: the run stops with ArtDirectorRefusedError, never a refused fragment', async () => {
    const call = vi.fn(async () => refused());
    await expect(askArtDirector('P', null, 'gemini-3.7-flash', { usageLabel: 'beats_brief_reask' }, { call }))
      .rejects.toBeInstanceOf(ArtDirectorRefusedError);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('a refusal by the refusal model itself is not asked again', async () => {
    const call = vi.fn(async () => refused());
    await expect(askArtDirector('P', null, MODEL_DEFAULTS.artDirectorRefusalModel, {}, { call })).rejects.toThrow(/no other Art Director model/);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('the refusal model is not a Google model and not Haiku (rejected for briefs)', () => {
    expect(MODEL_DEFAULTS.artDirectorRefusalModel).toBeTruthy();
    expect(MODEL_DEFAULTS.artDirectorRefusalModel).not.toMatch(/gemini|haiku/i);
  });

  it('isRefusal reads only the typed verdict', () => {
    expect(isRefusal(refused())).toBe(true);
    expect(isRefusal(ok('x'))).toBe(false);
    expect(isRefusal(null)).toBe(false);
  });
});

describe('every Art Director call site goes through askArtDirector and rethrows a refusal stop', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (f: string) => fs.readFileSync(path.join(__dirname, '../../server/lib', f), 'utf8');
  it('beatsPipeline: label repair, Visual Bible, all-pages briefs, per-page fallback', () => {
    const src = read('beatsPipeline.js');
    for (const label of ['beats_vb_label_repair', 'beats_visual_bible', 'beats_scene_expansion', 'beats_scene_expansion_fallback']) {
      expect(src, label).toMatch(new RegExp(`askArtDirector\\([^)]*usageLabel: '${label}'`));
      expect(src, label).not.toMatch(new RegExp(`callTextModelStreaming\\([^)]*usageLabel: '${label}'`));
    }
    expect((src.match(/if \(err instanceof ArtDirectorRefusedError\) throw err;/g) || []).length).toBe(4);
  });
  it('briefChecks: the re-ask', () => {
    const src = read('briefChecks.js');
    expect(src).toMatch(/askArtDirector\(prompt, null, model, \{ usageLabel: 'beats_brief_reask'/);
    expect(src).toMatch(/instanceof require\('\.\/artDirectorCall'\)\.ArtDirectorRefusedError\) throw err/);
  });
  it('trial path: the per-page expansion when the unified pass gave no scene prose', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../storyJobPipeline.js'), 'utf8');
    expect(src).toMatch(/askArtDirector\(expansionPrompt, [^)]*\)[^;]*usageLabel: 'scene_expansion'/);
    expect(src).not.toMatch(/callTextModelStreaming\([^;]*usageLabel: 'scene_expansion'/);
  });
});
