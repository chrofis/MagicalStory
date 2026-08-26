require('dotenv').config();
const fs = require('fs'); const path = require('path');
const { paintCoverTitle } = require('../../server/lib/coverTitlePaint');
const D = 'C:/Users/roger/AppData/Local/Temp/claude/C--Users-roger-MagicalStory/b543fa41-dfc3-4336-8724-63f14913b708/scratchpad/rerun';
const TITLE = 'Levin und der Drache ohne Schuppe';
(async () => {
  const artBuffer = fs.readFileSync(path.join(D, 'k-frontCoverArt_cover_v0.jpg'));
  const out = [];
  for (const fontId of process.argv.slice(2)) {
    const r = await paintCoverTitle(artBuffer, TITLE, { style: { fontId }, artStyle: 'watercolor', seed: TITLE });
    const file = `fix-${fontId}.jpg`;
    fs.writeFileSync(path.join(D, file), Buffer.from(String(r.imageData).replace(/^data:image\/\w+;base64,/, ''), 'base64'));
    out.push({ fontId, file, ok: r.ok, reason: r.reason || null, coverage: r.coverage, spill: r.spill });
    process.stdout.write(`${fontId} ok=${r.ok} cov=${r.coverage != null ? r.coverage.toFixed(2) : '-'} spill=${r.spill != null ? r.spill.toFixed(2) : '-'} ${r.reason || ''}\n`);
  }
  fs.writeFileSync(path.join(D, 'fix-results.json'), JSON.stringify(out));
})().catch(e => { process.stdout.write('ERR ' + e.message + '\n'); process.exit(1); });
