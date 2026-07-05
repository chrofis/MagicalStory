// Run the (updated) Pass-2 style eval 3x on the SAME sheet to measure eval
// variance. Default target: the old PAINTED Ethan comic sheet from
// job_1783248362816_v53orc1yb — the new clean-render check must catch it
// consistently. Usage: node tests/manual/test-sheet-eval-3x.js
require('dotenv').config();
const { loadPromptTemplates } = require('../../server/services/prompts');
const { _internal } = require('../../server/lib/character2x4Sheet');

const BASE = 'https://images-staging.magicalstory.ch/stories/job_1783248362816_v53orc1yb';
const URLS = {
  facePhoto: `${BASE}/debug/styled-avatar/styledAvatarGeneration-2/facePhoto.jpg`,
  pass1: `${BASE}/aux/styledAvatarGeneration-2-passes-pass1-imageData.jpg`,
  styled: `${BASE}/debug/styled-avatar/styledAvatarGeneration-2/output.jpg`, // the painted one
};

async function toDataUri(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

(async () => {
  await loadPromptTemplates();
  const [facePhoto, pass1, styled] = await Promise.all([
    toDataUri(URLS.facePhoto), toDataUri(URLS.pass1), toDataUri(URLS.styled),
  ]);
  console.log('Evaluating the OLD PAINTED Ethan comic sheet 3x with the new eval...\n');
  for (let i = 1; i <= 3; i++) {
    try {
      const v = await _internal.evaluateStyledSheetWithGemini(
        facePhoto, pass1, styled, 'comic', process.env.GEMINI_API_KEY, null
      );
      console.log(`EVAL ${i}: layout=${v.layoutScore} identity=${v.identityScore} style=${v.styleScore} outfit=${v.outfitScore} clean=${v.cleanScore} final=${v.finalScore} valid=${v.valid}`);
      if (v.failureReasons?.length) console.log(`   reasons: ${v.failureReasons.join('; ').slice(0, 220)}`);
      if (v.clean?.reason) console.log(`   clean reason: ${String(v.clean.reason).slice(0, 220)}`);
    } catch (e) {
      console.log(`EVAL ${i} ERROR: ${e.message}`);
    }
  }
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
