import { describe, it, expect, beforeAll } from 'vitest';

// A character-repair prompt names its two images by number. The numbers must be
// the slots the call actually fills. They were hand-written "IMAGE 1 =
// reference, IMAGE 2 = scene" in every template, while callModel sends the
// treated crop FIRST — so every face repair and every cutout repair told the
// model the scene was the reference (Lab 1554, staging
// job_1790446348343_z3fw660ie initialPage, 2026-09-27). The labels are now built
// from the order constant each send site uses; these tests pin that the words
// and the bytes agree, by capturing what is really sent.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const sharp = require('sharp');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const grok = require('../../server/lib/grok');

// Capture every editWithGrok call. imageCompositing destructures editWithGrok
// at load, so the stub goes on BEFORE it is first required.
const sent: Array<{ prompt: string; images: string[] }> = [];
let replyUri = '';
grok.editWithGrok = async (prompt: string, images: string[]) => {
  sent.push({ prompt, images });
  return { imageData: replyUri, usage: { cost: 0 } };
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const faceRepair = require('../../server/lib/faceRepair');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { grokEditSceneExact } = require('../../server/lib/imageCompositing');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const prompts = require('../../server/services/prompts');

const EDIT = 'data:image/png;base64,EDIT';
const REF = 'data:image/png;base64,REF';

// Every axis combination the spine can resolve to, grok model.
const AXES = [
  { treatment: 'blur', regionSource: 'cutout', faceOnly: true },       // production face repair
  { treatment: 'blur', regionSource: 'box', faceOnly: false },
  { treatment: 'crosshatch', regionSource: 'box', faceOnly: false },   // production body repair
  { treatment: 'crosshatch', regionSource: 'cutout', faceOnly: false },
];

const refSlot = (prompt: string) => {
  const m = prompt.match(/- IMAGE (\d) = REFERENCE PORTRAIT/);
  if (!m) throw new Error(`no reference label in: ${prompt.slice(0, 300)}`);
  return Number(m[1]) - 1;
};

async function send(axes: Record<string, unknown>, prompt: string) {
  sent.length = 0;
  if (axes.regionSource === 'box') {
    const scene = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#888' } }).png().toBuffer();
    await grokEditSceneExact(prompt, [REF], scene, 64, 48, { encode: 'png' });
    return sent[0].images.map((u: string) => (u === REF ? 'REF' : 'EDIT'));
  }
  await faceRepair.callModel({ model: 'grok', prompt, treatedUri: EDIT, avatarUri: REF, aspect: '1:1', cropW: 64, cropH: 64 });
  return sent[0].images.map((u: string) => (u === REF ? 'REF' : 'EDIT'));
}

describe('character repair: the prompt names the images in the order they are sent', () => {
  beforeAll(async () => {
    await prompts.loadPromptTemplates();
    replyUri = `data:image/png;base64,${(await sharp({ create: { width: 64, height: 48, channels: 3, background: '#888' } }).png().toBuffer()).toString('base64')}`;
  });

  for (const axes of AXES) {
    it(`${axes.treatment}/${axes.regionSource}/${axes.faceOnly ? 'face' : 'body'}: the slot called REFERENCE carries the avatar`, async () => {
      const prompt = await faceRepair.buildPrompt({ model: 'grok', ...axes, charName: 'CharA', opts: { artStyle: 'watercolor' } });
      const slots = await send(axes, prompt);
      expect(slots[refSlot(prompt)]).toBe('REF');
      expect(slots.filter(s => s === 'EDIT')).toHaveLength(1);
    });
  }

  it('the face whiteout prompt says first/second the way callModel sends them', async () => {
    // whiteout builds its own sentence; check its ordinals against the order constant.
    const { editOrdinal, referenceOrdinal } = faceRepair.imageSlotLabels(faceRepair.CALL_MODEL_IMAGE_ORDER);
    expect([editOrdinal, referenceOrdinal]).toEqual(['first', 'second']);
    const slots = await send({ regionSource: 'cutout' }, 'x');
    expect(slots).toEqual(['EDIT', 'REF']);
  });

  it('no repair template hard-codes an image number, and each names both slots', () => {
    for (const key of ['characterRepairBlended', 'characterRepairBodyBlended', 'characterRepairCutout', 'characterRepairInpaint']) {
      const tpl = prompts.PROMPT_TEMPLATES[key];
      expect(tpl, key).toBeTruthy();
      expect(tpl, key).not.toMatch(/\bIMAGE [0-9]\b/);
      expect(tpl, key).toContain('{EDIT_IMAGE}');
      expect(tpl, key).toContain('{REFERENCE_IMAGE}');
    }
  });

  it('a prompt built without the model refuses rather than guessing the order', async () => {
    await expect(faceRepair.buildPrompt({ ...AXES[0], charName: 'CharA', opts: {} })).rejects.toThrow(/model is required/);
  });
});
