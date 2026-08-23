// One-off analysis: interaction shape vs semantic outcome, two prod stories.
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const STORIES = [
  ['job_1787436913379_mfedxinwqd', 'Drache'],
  ['job_1787423677246_r9llf5yi9', 'Fiona'],
];

// Hand-labelled interaction group, keyed book:page:index (see prior dump of all rows).
const GROUP = {
  'Drache:1:0': 'GESTURE', 'Drache:1:1': 'GAZE',
  'Drache:3:0': 'HANDS_ON', 'Drache:3:1': 'POSTURE', 'Drache:3:2': 'GESTURE',
  'Drache:4:0': 'GROUP', 'Drache:4:1': 'POSTURE', 'Drache:4:2': 'POSTURE',
  'Drache:5:0': 'POSTURE', 'Drache:5:1': 'POSTURE', 'Drache:5:2': 'POSTURE',
  'Drache:6:0': 'GESTURE',
  'Drache:7:0': 'GROUP', 'Drache:7:1': 'GAZE',
  'Drache:8:0': 'GESTURE',
  'Drache:10:0': 'POSTURE', 'Drache:10:1': 'POSTURE', 'Drache:10:2': 'POSTURE', 'Drache:10:3': 'GAZE',
  'Drache:11:0': 'GESTURE',
  'Drache:12:0': 'HANDS_ON', 'Drache:12:1': 'POSTURE',
  'Drache:13:0': 'GESTURE', 'Drache:14:0': 'POSTURE', 'Drache:15:0': 'GAZE',
  'Drache:16:0': 'HANDS_ON', 'Drache:16:1': 'HANDS_ON',
  'Drache:17:0': 'GROUP', 'Drache:18:0': 'GROUP',
  'Fiona:1:0': 'POSTURE',
  'Fiona:3:0': 'GESTURE', 'Fiona:3:1': 'POSTURE',
  'Fiona:4:0': 'HANDS_ON',
  'Fiona:5:0': 'HANDS_ON', 'Fiona:5:1': 'HANDS_ON',
  'Fiona:6:0': 'HANDS_ON',
  'Fiona:7:0': 'GESTURE', 'Fiona:7:1': 'HANDS_ON',
  'Fiona:8:0': 'HANDS_ON', 'Fiona:8:1': 'HANDS_ON',
  'Fiona:9:0': 'GAZE', 'Fiona:9:1': 'GAZE',
  'Fiona:10:0': 'POSTURE', 'Fiona:10:1': 'POSTURE',
  'Fiona:11:0': 'HANDS_ON', 'Fiona:11:1': 'GESTURE', 'Fiona:11:2': 'GAZE', 'Fiona:11:3': 'POSTURE',
  'Fiona:12:0': 'HANDS_ON',
  'Fiona:13:0': 'HANDS_ON', 'Fiona:13:1': 'GAZE',
  'Fiona:14:0': 'HANDS_ON', 'Fiona:14:1': 'POSTURE', 'Fiona:14:2': 'GAZE', 'Fiona:14:3': 'GAZE', 'Fiona:14:4': 'GAZE',
  'Fiona:15:0': 'GESTURE', 'Fiona:15:1': 'POSTURE',
  'Fiona:16:0': 'HANDS_ON', 'Fiona:16:1': 'GROUP',
};

const norm = (s) => String(s || '').toLowerCase().replace(/kapit(ä|ae)nin /, '').trim();
const avg = (a) => (a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(0) : '-');

function bucket(rows, label, keyFn) {
  const g = {};
  rows.forEach((r) => { const k = keyFn(r); if (k === null) return; (g[k] = g[k] || []).push(r); });
  console.log(`\n${label}`);
  Object.keys(g).sort().forEach((k) => {
    const a = g[k];
    const sems = a.map((r) => r.sem);
    const fails = a.filter((r) => r.sem <= 50).length;
    console.log(`   ${String(k).padEnd(26)} n=${String(a.length).padStart(2)}  avgSem=${String(avg(sems)).padStart(3)}  pages<=50: ${fails}/${a.length}   pages: ${a.map((r) => r.book[0] + r.p).join(' ')}`);
  });
}

(async () => {
  const pages = [];
  for (const [jid, book] of STORIES) {
    const r = await pool.query('select data from stories where id=$1', [jid]);
    const d = r.rows[0].data;
    const imgs = await pool.query(
      "select page_number, max(image_url) url from story_images where story_id=$1 and image_type='scene' group by page_number", [jid]);
    const urlBy = Object.fromEntries(imgs.rows.map((x) => [x.page_number, x.url]));

    for (const s of d.sceneImages) {
      const ints = (s.sceneMetadata || {}).interactions || [];
      const bad = ((s.semanticResult || {}).semanticIssues || []).filter((x) => /action_interaction|wrong_interaction/.test(x.type));
      const rows = ints.map((i, n) => {
        const g = GROUP[`${book}:${s.pageNumber}:${n}`] || 'UNK';
        const names = String(i.character || '').split('+').map(norm);
        const flagged = bad.some((b) => (b.character ? names.includes(norm(b.character)) : g === 'GROUP'));
        return {
          group: g, who: i.character, n_people: names.length,
          priority: i.priority || '-', storyRelevant: !!i.storyRelevant,
          where: (i.where || ''), flagged,
        };
      });
      const groups = rows.map((x) => x.group);
      pages.push({
        book, p: s.pageNumber, sem: s.semanticScore, final: s.finalScore,
        versions: (s.imageVersions || []).length,
        cast: (s.sceneCharacters || []).length,
        rows, nInt: rows.length,
        nTypes: new Set(groups).size,
        nHands: groups.filter((g) => g === 'HANDS_ON').length,
        nPosture: groups.filter((g) => g === 'POSTURE').length,
        nEssential: rows.filter((x) => x.priority === 'essential').length,
        nStoryRel: rows.filter((x) => x.storyRelevant).length,
        // distinct "actors": how many separate character-rows (fused rows count as 1 row but N people)
        nActorRows: rows.length,
        peopleInRows: rows.reduce((a, x) => a + x.n_people, 0),
        url: urlBy[s.pageNumber] || null,
      });
    }
  }

  console.log('=========== A. Pages whose ONLY interaction is a single HANDS_ON ===========');
  const soloHands = pages.filter((x) => x.nInt === 1 && x.nHands === 1);
  soloHands.forEach((x) => console.log(`  ${x.book} p${x.p}  sem=${x.sem} final=${x.final} versions=${x.versions} cast=${x.cast}  ${x.rows[0].priority}/${x.rows[0].storyRelevant ? 'storyRelevant' : 'not-story'}  :: ${x.rows[0].where.slice(0, 90)}`));
  console.log(`  -> n=${soloHands.length} avgSem=${avg(soloHands.map((x) => x.sem))}`);

  console.log('\n=========== B. hands-on present  x  total interaction count ===========');
  bucket(pages.filter((x) => x.nInt > 0), 'split:', (r) => `${r.nHands ? 'HANDS-ON' : 'no-hands'} & ${r.nInt === 1 ? '1 int' : r.nInt === 2 ? '2 int' : '3+ int'}`);

  console.log('\n=========== C. posture count per page ===========');
  bucket(pages.filter((x) => x.nInt > 0), 'nPosture:', (r) => `${r.nPosture} posture rows`);

  console.log('\n=========== D. cast size  x  distinct interaction TYPES ===========');
  bucket(pages.filter((x) => x.nInt > 0), 'cast x types:', (r) => `cast${r.cast} x ${r.nTypes}type`);
  bucket(pages.filter((x) => x.nInt > 0), 'cast x n interactions:', (r) => `cast${r.cast} x ${r.nInt}int`);

  console.log('\n=========== E. shared single interaction vs one row per person ===========');
  bucket(pages.filter((x) => x.cast >= 2 && x.nInt > 0), 'multi-person pages:', (r) => {
    if (r.rows.some((x) => x.n_people > 1) && r.nInt === 1) return 'A: 1 fused row, all same action';
    if (r.nInt === 1) return 'B: 1 row (others unlisted)';
    if (r.nTypes === 1) return 'C: N rows, all SAME type';
    return 'D: N rows, DIFFERENT types';
  });

  console.log('\n=========== F. mandatory load: essential / storyRelevant rows ===========');
  bucket(pages.filter((x) => x.nInt > 0), 'essential rows per page:', (r) => `${r.nEssential} essential`);
  bucket(pages.filter((x) => x.nInt > 0), 'storyRelevant rows per page:', (r) => `${r.nStoryRel} storyRelevant`);

  const allRows = pages.flatMap((x) => x.rows.map((r) => ({ ...r, book: x.book, p: x.p })));
  const byPri = {};
  allRows.forEach((r) => { const k = `${r.priority}/${r.storyRelevant ? 'story' : 'notStory'}`; byPri[k] = byPri[k] || { n: 0, f: 0 }; byPri[k].n++; if (r.flagged) byPri[k].f++; });
  console.log('\nper-ROW flag rate by priority:');
  Object.entries(byPri).sort((a, b) => b[1].f / b[1].n - a[1].f / a[1].n).forEach(([k, v]) =>
    console.log(`   ${k.padEnd(22)} rows=${String(v.n).padStart(2)}  flagged=${v.f}  (${Math.round(100 * v.f / v.n)}%)`));

  const OUT = process.env.OUT_DIR || process.cwd();
  fs.writeFileSync(path.join(OUT, 'pages.json'), JSON.stringify(pages, null, 1));
  console.log('\nwrote pages.json');
  await pool.end();
})();
