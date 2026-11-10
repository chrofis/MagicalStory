import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

// Regression: "Change title" was dead on every model-baked front cover (no textless
// `frontCoverArt` row -> paintServedCoverTitle returned 'no textless art layer' -> refund,
// cover kept the old title; all 4 prod attempts failed). Fix (owner, 2026-11-10): one Grok
// edit of the served cover that repaints only the lettering, judged against the new title.
const req = createRequire(import.meta.url);
const prompts = req('../../server/services/prompts.js');
const paint = req('../../server/lib/coverTitlePaint.js');
const typo = req('../../server/lib/coverTypography.js');
const database = req('../../server/services/database.js');
const r2 = req('../../server/lib/r2.js');

const COVER = Buffer.from('fake-cover-bytes');

beforeAll(async () => { await prompts.loadPromptTemplates(); });

describe('cover-title-edit prompt', () => {
  it('carries the new title through {TITLE} and leaves no unfilled placeholder', () => {
    const p = prompts.fillTemplate(prompts.PROMPT_TEMPLATES.coverTitleEdit, { TITLE: 'Die Nacht der Äpfel' });
    expect(p).toContain('Die Nacht der Äpfel');
    expect(p).not.toMatch(/\{[A-Z_]+\}/);
    expect(p).toMatch(/only the title lettering/i);
  });
});

describe('editBakedCoverTitle', () => {
  const okVerify = async () => ({ matches: true, problem: '' });
  it('sends the served cover and the new title in ONE edit, and returns the edited image when the judge agrees', async () => {
    const calls: any[] = [];
    const edit = async (prompt: string, refs: string[], opts: any) => { calls.push({ prompt, refs, opts }); return { imageData: 'data:image/jpeg;base64,AAAA' }; };
    const res = await paint.editBakedCoverTitle(COVER, 'Lina und Zoë', { editWithGrok: edit, verifyTitleRender: okVerify });
    expect(res.ok).toBe(true);
    expect(res.imageData).toBe('data:image/jpeg;base64,AAAA');
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toContain('Lina und Zoë');
    expect(calls[0].refs).toEqual([`data:image/jpeg;base64,${COVER.toString('base64')}`]);
    expect(calls[0].opts.model).toBe('grok-imagine-image-2.0');   // runtime coverTitleBakedModel
  });

  it('keeps the old cover (ok:false) when the judge reads a different title', async () => {
    const edit = async () => ({ imageData: 'data:image/jpeg;base64,AAAA' });
    const verify = async () => ({ matches: false, problem: 'The word "Zoë" is missing' });
    const res = await paint.editBakedCoverTitle(COVER, 'Lina und Zoë', { editWithGrok: edit, verifyTitleRender: verify });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/^eval:/);
  });

  it('reports ok:false when the model returns no image, and never calls the judge', async () => {
    let judged = false;
    const res = await paint.editBakedCoverTitle(COVER, 'Lina', {
      editWithGrok: async () => ({}), verifyTitleRender: async () => { judged = true; return { matches: true }; } });
    expect(res.ok).toBe(false);
    expect(judged).toBe(false);
  });

  it('lets a model transport failure propagate (the route refunds and answers 500)', async () => {
    await expect(paint.editBakedCoverTitle(COVER, 'Lina', {
      editWithGrok: async () => { throw new Error('boom'); }, verifyTitleRender: okVerify })).rejects.toThrow('boom');
  });
});

describe('paintServedCoverTitle routing', () => {
  const origQuery = database.dbQuery;
  const origBytes = r2.bytesFromAnyImage;
  const origEdit = paint.editBakedCoverTitle;
  const origSave = database.saveStoryImage;
  const restore = () => { database.saveStoryImage = origSave; database.dbQuery = origQuery; r2.bytesFromAnyImage = origBytes; paint.editBakedCoverTitle = origEdit; };

  it('a cover WITHOUT an art row is edited in place on the active version (was: painted:false "no textless art layer")', async () => {
    const saved: any[] = [];
    database.dbQuery = async (sql: string) => {
      if (sql.includes('image_version_meta')) return [{ image_version_meta: { frontCover: { activeVersion: 2 } } }];
      if (sql.includes("image_type=$2 AND version_index=$3")) return [{ image_url: 'https://r2/x.jpg' }];
      return [];   // no frontCoverArt row
    };
    database.saveStoryImage = async (...a: any[]) => { saved.push(a); };
    r2.bytesFromAnyImage = async () => COVER;
    paint.editBakedCoverTitle = async (_b: Buffer, t: string) => ({ ok: true, imageData: 'data:image/jpeg;base64,BBBB', t });
    try {
      const res = await typo.paintServedCoverTitle('s1', { title: 'Neuer Titel', coverImages: { frontCover: {} } });
      expect(res.painted).toBe(true);
      expect(saved).toHaveLength(1);
      expect(saved[0].slice(0, 4)).toEqual(['s1', 'frontCover', null, 'data:image/jpeg;base64,BBBB']);
      expect(saved[0][4]).toMatchObject({ versionIndex: 2, cacheBust: true, preserveScore: true });
    } finally { restore(); }
  });

  it('a judge mismatch saves nothing and reports painted:false with the reason', async () => {
    const saved: any[] = [];
    database.dbQuery = async (sql: string) => {
      if (sql.includes('image_version_meta')) return [{ image_version_meta: {} }];
      if (sql.includes("image_type=$2 AND version_index=$3")) return [{ image_url: 'https://r2/x.jpg' }];
      return [];
    };
    database.saveStoryImage = async (...a: any[]) => { saved.push(a); };
    r2.bytesFromAnyImage = async () => COVER;
    paint.editBakedCoverTitle = async () => ({ ok: false, reason: 'eval: title does not match' });
    try {
      const res = await typo.paintServedCoverTitle('s1', { title: 'Neuer Titel' });
      expect(res).toEqual({ painted: false, reason: 'eval: title does not match' });
      expect(saved).toHaveLength(0);
    } finally { restore(); }
  });
});
