// Show exactly what was sent to the empty-scene generator for a given page:
//  - Haiku-written emptyScenePrompt (from the scene metadata)
//  - The text-area mask PNG that got attached as a reference image
//  - The final composition instruction the pipeline builds around them
//
// Note: only the first two are persisted in the DB. The composition
// instruction is rebuilt from the code each run (not stored), but we can
// reconstruct it the same way server.js:4741 does.
//
// Usage:
//   node scripts/analysis/inspect-empty-scene-prompt.js <storyId>          # list all pages
//   node scripts/analysis/inspect-empty-scene-prompt.js <storyId> <pageN>  # dump full content + extract mask

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { getTextAreaMask } = require('../../server/lib/textMasks');

(async () => {
  const storyId = process.argv[2];
  const pageArg = process.argv[3];
  if (!storyId) { console.error('Usage: <storyId> [pageN]'); process.exit(1); }

  const pool = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const r = await pool.query('SELECT data FROM stories WHERE id = $1', [storyId]);
  if (!r.rows[0]) { console.error('story not found'); process.exit(1); }
  const d = r.rows[0].data || {};
  const langLevel = d.languageLevel || 'standard';
  const scenes = (d.sceneImages || []).sort((a, b) => a.pageNumber - b.pageNumber);

  const parseHint = (s) => {
    if (!s) return null;
    try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return null; }
  };

  if (!pageArg) {
    console.log(`${storyId}  (${scenes.length} pages, langLevel=${langLevel})\n`);
    for (const s of scenes) {
      const hint = parseHint(s.outlineExtract);
      const pos = s.textPosition || hint?.textPosition || '?';
      const esp = s.emptyScenePrompt || hint?.emptyScenePrompt || '(none)';
      console.log(`P${s.pageNumber}  textPosition=${pos}`);
      console.log('  emptyScenePrompt:', esp.slice(0, 140) + (esp.length > 140 ? '…' : ''));
    }
    console.log('\nRun with a page number to see full prompt + mask.');
    process.exit(0);
  }

  const pageNum = parseInt(pageArg, 10);
  const s = scenes.find(sc => sc.pageNumber === pageNum);
  if (!s) { console.error(`P${pageNum} not found`); process.exit(1); }
  const hint = parseHint(s.outlineExtract);
  const textPosition = s.textPosition || hint?.textPosition || null;
  const emptyScenePrompt = s.emptyScenePrompt || hint?.emptyScenePrompt || '(none)';

  console.log('='.repeat(90));
  console.log(`${storyId}  P${pageNum}  textPosition=${textPosition}  langLevel=${langLevel}`);
  console.log('='.repeat(90));

  console.log('\n--- 1. emptyScenePrompt (written by Haiku, stored on the scene) ---');
  console.log(emptyScenePrompt);

  console.log('\n--- 2. text-area mask (attached as reference image to Gemini) ---');
  const mask = textPosition ? getTextAreaMask(textPosition, langLevel) : null;
  if (!mask) {
    console.log('(no mask — textPosition missing or layout has text-below)');
  } else {
    const sizeName = langLevel === '1st-grade' ? 'small' : langLevel === 'advanced' ? 'large' : 'medium';
    const fname = `text-mask-${textPosition}-${sizeName}.png`;
    const srcPath = path.join(__dirname, '..', '..', 'assets', 'masks', fname);
    const outPath = path.join(__dirname, '..', '..', 'tmp', `inspect-p${pageNum}-${fname}`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.copyFileSync(srcPath, outPath);
    console.log('  file:', srcPath);
    console.log('  copied to:', outPath, '← open to verify');
    console.log('  mask semantics: BLACK blurred region = reserved text zone (dark); WHITE = allow full detail');
  }

  console.log('\n--- 3. composition instruction (rebuilt from server.js:4741) ---');
  const cornerDesc = {
    'top-left': 'upper left corner', 'top-right': 'upper right corner',
    'bottom-left': 'lower left corner', 'bottom-right': 'lower right corner',
    'top-full': 'upper third (full width)', 'bottom-full': 'lower third (full width)',
  };
  const emptyTextAreaInstr = !textPosition ? '' :
    `COMPOSITION — KEEP THIS AREA DARK AND QUIET: The ${(cornerDesc[textPosition] || textPosition.replace('-', ' '))} area of the scene must stay dark, low-luminance, and visually simple. [... see server.js:4741 for full text ...]`;
  console.log(emptyTextAreaInstr);

  console.log('\n='.repeat(90));
  console.log('NOTE: The actual prompt sent to the image model combines emptyScenePrompt + the composition instruction.');
  console.log('The mask image is attached as a reference alongside this text.');
  console.log('='.repeat(90));
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
