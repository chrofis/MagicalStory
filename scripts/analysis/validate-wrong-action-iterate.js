/**
 * Paid validation (owner 2026-10-15, cap USD 1): the page-redo route (iteratePageCore, the
 * route wrong_action now takes) on STORED pages whose shipped version carries a MAJOR+
 * wrong-action finding. For each case: (1) judge the ORIGINAL with the real semantic
 * judge (positive control: does the new wrong_action rule fire on it?), (2) iterate,
 * (3) judge the redo with the same judge, (4) save both images for a visual read.
 * Nothing is written to the DB. Usage:
 *   node scripts/analysis/validate-wrong-action-iterate.js <storyId>:<page> [...]
 */
require('dotenv').config();
const fs = require('fs'); const path = require('path');
const T = require('../../server/lib/testlab');
const outDir = process.env.OUT_DIR || '.';
const toBuf = (d) => Buffer.from(String(d).replace(/^data:image\/\w+;base64,/, ''), 'base64');
(async () => {
  require('../../server/services/database').initializePool();
  const { loadPromptTemplates } = require('../../server/services/prompts');
  await loadPromptTemplates();
  const { iteratePageCore } = require('../../server/lib/images');
  const usage = [];
  for (const spec of process.argv.slice(2)) {
    const [storyId, pn] = spec.split(':'); const pageNumber = parseInt(pn, 10);
    const row = { storyId, pageNumber };
    try {
      const ctx = await T.loadSceneContext(storyId, pageNumber);
      ctx.target = { storyId, pageNumber }; ctx.versionIndex = null;
      const orig = await T.loadActivePageImage(storyId, pageNumber);
      // The reader (book-audit) is the judge that files this class: the per-page semantic
      // judge scored the shipped p5 original 100 with no finding. One page, no object-scale pass.
      const db = require('../../server/services/database');
      const rows = await db.dbQuery('SELECT data FROM stories WHERE id = $1', [storyId]);
      const raw = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
      const si = (raw.sceneImages || []).find(x => x.pageNumber === pageNumber);
      const { auditStoryBook, buildAuditPages } = require('../../server/lib/bookAudit');
      const judge = async (img) => {
        const dataUrl = /^data:/.test(img) ? img : `data:image/jpeg;base64,${img}`;
        const pages = buildAuditPages([{ ...si, imageData: dataUrl }], () => null);
        const a = await auditStoryBook({ id: storyId, visualBible: raw.visualBible || null, characters: raw.characters || [], sceneImages: pages }, { objectScale: false });
        return { faults: (a.byRoute.IMG || []).map(f => `${f.severity}|${f.type}|${String(f.line || '').slice(0, 160)}`) };
      };
      row.before = await judge(orig);
      const storyData = await db.rehydrateStoryImages(storyId, raw);
      const stored = T.storedEvalFromScene(ctx.scene);
      const r = await iteratePageCore(orig, pageNumber, storyData, {
        evaluationFeedback: stored, aspectRatio: ctx.layout?.imageAspect || null, skipEval: true,
        usageTracker: (p, u, f, m) => usage.push({ p, f, m, u }),
      });
      if (!r?.imageData) throw new Error('iterate produced no image');
      fs.writeFileSync(path.join(outDir, `${storyId.slice(-9)}_p${pageNumber}_before.jpg`), toBuf(orig));
      fs.writeFileSync(path.join(outDir, `${storyId.slice(-9)}_p${pageNumber}_after.jpg`), toBuf(r.imageData));
      row.after = await judge(r.imageData);
    } catch (e) { row.error = e.message; }
    console.log('RESULT', JSON.stringify(row));
  }
  console.log('USAGE', JSON.stringify(usage));
  process.exit(0);
})();
