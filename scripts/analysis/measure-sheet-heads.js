// Head-to-height of every BODY cell (cells 1-3, the ones with a face) of the sheets in <dir>/img, read by a vision model:
// eye line, chin and feet; head = (chin-eye)/0.47. Writes <dir>/measure2.json. Reproduces the 2026-10-10 costume-sheet Lab
// measurement (docs/decisions.md 'Trial costume sheet'). Usage: node scripts/analysis/measure-sheet-heads.js <dir>
const path0 = require('path'); process.chdir(path0.join(__dirname, '../..'));
require('dotenv').config();
const fs = require('fs'), path = require('path');
const { cutSheet } = require('../../server/lib/sheetCut');
const D = path.resolve(process.argv[2]);
const prompt = fs.readFileSync('prompts/experiments/sheet-head-box-measure.txt', 'utf8');
let inTok = 0, outTok = 0, calls = 0;
async function ask(buf) {
  const body = { contents: [{ parts: [{ inline_data: { mime_type: 'image/png', data: buf.toString('base64') } }, { text: prompt }] }], generationConfig: { responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } } };
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json(); calls++;
  inTok += j.usageMetadata?.promptTokenCount || 0; outTok += j.usageMetadata?.candidatesTokenCount || 0;
  const t = j.candidates?.[0]?.content?.parts?.[0]?.text; const v = JSON.parse(t);
  const [e, k, f] = [Number(v.eyeY), Number(v.chinY), Number(v.feetY)];
  if (!(f > k && k > e)) return { error: 'unusable', v };
  // Eye line sits ~0.47 of the head's height above the chin (crown-to-chin = head): head = (chin-eye)/0.47, crown = chin - head.
  const head = (k - e) / 0.47; const crown = k - head;
  return { eye: e, chin: k, feet: f, head: Math.round(head), n: Number(((f - crown) / head).toFixed(2)) };
}
(async () => {
  const out = {}; const files = fs.readdirSync(path.join(D, 'img'));
  const queue = files.slice();
  const work = async () => {
    while (queue.length) {
      const f = queue.shift();
      try {
        const pieces = await cutSheet(fs.readFileSync(path.join(D, 'img', f)));
        out[f] = [];
        for (const b of pieces.slice(4, 7)) { try { out[f].push(await ask(b)); } catch (e) { out[f].push({ error: e.message }); } }
      } catch (e) { out[f] = { error: e.message }; }
    }
  };
  await Promise.all([work(), work(), work(), work()]);
  fs.writeFileSync(path.join(D, 'measure2.json'), JSON.stringify(out, null, 1));
  console.log('files', files.length, 'calls', calls, 'in', inTok, 'out', outTok, 'usd~', (inTok * 0.3e-6 + outTok * 2.5e-6).toFixed(4));
  process.exit(0);
})();
