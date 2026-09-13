/**
 * ONE fed-back round over the Visual Bible's element labels.
 *
 * An element's `label` is the only handle a page prompt has on it — ids never
 * reach an image model. On job_1789301291267_ueh8h145m two artifacts both
 * typed "tool", so REQUIRED OBJECTS read `**tool** (object)` twice. The round
 * validates deterministically, gives the author exactly ONE extra call over
 * the faulted ids, repairs survivors in code, and SHIPS either way.
 *
 * These tests pin the behaviour, not the prompt wording: no model call when
 * the bible is clean, one call when it is not, the reply confined to the
 * listed ids and the `label` field, a failed call falling through to the code
 * repair, survivors flagged rather than thrown, and the labels projected into
 * the transcript JSON every later stage re-parses.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const textModels = require('../../server/lib/textModels.js');
const { PROMPT_TEMPLATES } = require('../../server/services/prompts.js');
const { runVisualBibleLabelRound, syncVisualBibleSection } = require('../../server/lib/beatsPipeline.js');
const { validateLabels } = require('../../server/lib/vbLabel.js');

PROMPT_TEMPLATES.vbLabelRepair = require('node:fs')
  .readFileSync(new URL('../../prompts/vb-label-repair.txt', import.meta.url), 'utf8');

const realCall = textModels.callTextModelStreaming;
const calls: any[] = [];
function stubModel(impl: (prompt: string) => any) {
  calls.length = 0;
  textModels.callTextModelStreaming = async (prompt: string) => {
    calls.push(prompt);
    return impl(prompt);
  };
}

const gl = { info: () => {}, warn: () => {} };
const logger = { info: () => {}, warn: () => {}, error: () => {} };

const bible = (artifacts: any[]) => ({
  secondaryCharacters: [],
  animals: [],
  artifacts,
  locations: [],
  vehicles: [],
  clothing: [],
});

const clean = () => bible([
  { id: 'ART001', name: 'the lantern', label: 'copper lantern', type: 'lantern', description: 'a dented copper lantern' },
  { id: 'ART002', name: 'the saw', label: 'crosscut saw', type: 'saw', description: 'a long crosscut saw' },
]);

// The measured defect: two elements whose only name is the same bare category.
const faulty = () => bible([
  { id: 'ART001', name: 'the chisel', label: 'tool', type: 'tool', description: 'a flat steel chisel with a worn handle' },
  { id: 'ART002', name: 'the mallet', label: 'tool', type: 'tool', description: 'a heavy wooden mallet' },
]);

beforeEach(() => { textModels.callTextModelStreaming = realCall; });

describe('runVisualBibleLabelRound', () => {
  it('makes no model call when every label is already sound', async () => {
    stubModel(() => { throw new Error('must not be called'); });
    const vb = clean();
    const report = await runVisualBibleLabelRound(vb, { model: 'm', gl, log: logger });
    expect(calls.length).toBe(0);
    expect(report).toMatchObject({ round: 0, findings: 0 });
    expect(vb.artifacts[0].label).toBe('copper lantern');
  });

  it('runs exactly one round and applies the reply only to the listed ids and only to `label`', async () => {
    stubModel(() => ({
      text: JSON.stringify({
        labels: [
          { id: 'ART001', label: 'steel chisel' },
          { id: 'ART002', label: 'wooden mallet' },
          // Not in the findings — must be ignored outright.
          { id: 'ART999', label: 'ghost prop' },
        ],
      }),
    }));
    const vb = faulty();
    (vb.artifacts[0] as any).extra = 'untouched';
    const report = await runVisualBibleLabelRound(vb, { model: 'm', gl, log: logger });

    expect(calls.length).toBe(1);
    expect(report.round).toBe(1);
    expect(vb.artifacts[0].label).toBe('steel chisel');
    expect(vb.artifacts[1].label).toBe('wooden mallet');
    // Only the label moved.
    expect(vb.artifacts[0].name).toBe('the chisel');
    expect(vb.artifacts[0].type).toBe('tool');
    expect((vb.artifacts[0] as any).extra).toBe('untouched');
    expect(vb.artifacts.find((a: any) => a.id === 'ART999')).toBeUndefined();
    expect(validateLabels(vb)).toEqual([]);
  });

  it('falls through to the code repair when the call throws, and still yields valid unique labels', async () => {
    stubModel(() => { throw new Error('provider down'); });
    const vb = faulty();
    const report = await runVisualBibleLabelRound(vb, { model: 'm', gl, log: logger });
    expect(report.round).toBe(0);
    expect(report.repairedByCode).toBeGreaterThan(0);
    expect(validateLabels(vb)).toEqual([]);
    expect(vb.artifacts[0].label).not.toBe(vb.artifacts[1].label);
  });

  it('treats a truncated reply as a failed round', async () => {
    stubModel(() => ({ text: '{"labels":[{"id":"ART001","lab', truncation: { suspected: true, reason: 'max_tokens' } }));
    const vb = faulty();
    const report = await runVisualBibleLabelRound(vb, { model: 'm', gl, log: logger });
    expect(report.round).toBe(0);
    expect(validateLabels(vb)).toEqual([]);
  });

  it('flags survivors and warns instead of throwing', async () => {
    const warned: string[] = [];
    // Nothing to distinguish these two: same bare label, same description, no
    // usable type — the code repair runs out of ladder and admits defeat.
    const vb = bible([
      { id: 'ART001', label: 'tool', type: 'tool', description: 'tool' },
      { id: 'ART002', label: 'tool', type: 'tool', description: 'tool' },
    ]);
    stubModel(() => ({ text: 'not json at all' }));
    const report = await runVisualBibleLabelRound(vb, {
      model: 'm', log: logger,
      gl: { info: () => {}, warn: (code: string) => warned.push(code) },
    });
    expect(report.unresolved.length).toBeGreaterThan(0);
    expect((vb as any).labelUnresolved).toEqual(report.unresolved);
    expect(warned).toContain('beats_vb_label_unresolved');
    // Shipped, never killed: every entry still carries a distinct label.
    expect(vb.artifacts[0].label).not.toBe(vb.artifacts[1].label);
  });

  it('records the round on the stage report beside the other rounds', async () => {
    stubModel(() => ({ text: JSON.stringify({ labels: [{ id: 'ART001', label: 'steel chisel' }, { id: 'ART002', label: 'wooden mallet' }] }) }));
    const meta: any = {};
    await runVisualBibleLabelRound(faulty(), { model: 'm', gl, log: logger, stageReport: meta });
    expect(meta.labelRound).toMatchObject({ round: 1, unresolved: [] });
    expect(meta.labelRound.findings).toBeGreaterThan(0);
  });
});

describe('syncVisualBibleSection', () => {
  it('writes the label (and the repair code) into the transcript JSON', () => {
    const vb = faulty();
    const transcript = [
      '---VISUAL BIBLE---',
      '```json',
      JSON.stringify({
        artifacts: [
          { id: 'ART001', name: 'the chisel', label: 'tool', pages: [1] },
          { id: 'ART002', name: 'the mallet', label: 'tool', pages: [2] },
        ],
      }, null, 2),
      '```',
      '',
      '---COVER SCENE HINTS---',
      'a workbench',
      '',
    ].join('\n');

    vb.artifacts[0].label = 'steel chisel';
    (vb.artifacts[1] as any).label = 'wooden mallet';
    (vb.artifacts[1] as any).labelRepaired = 'label_duplicate';

    const out = syncVisualBibleSection(transcript, vb);
    const json = JSON.parse(out.match(/```json\s*([\s\S]*?)```/)![1]);
    expect(json.artifacts[0].label).toBe('steel chisel');
    expect(json.artifacts[1].label).toBe('wooden mallet');
    expect(json.artifacts[1].labelRepaired).toBe('label_duplicate');
    expect(out).toContain('---COVER SCENE HINTS---');
  });
});
