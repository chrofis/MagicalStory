// Read-only: stored landmark selections + idea generation records of staging stories, for the Jev idea/landmark review.
// writes evals/runs/2026-10-09_jev-idea-review/lm-stories.jsonl
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const OUT = require('path').join(__dirname, '../../evals/runs/2026-10-09_jev-idea-review');
const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  const { rows } = await pool.query(`SELECT id, created_at, data FROM stories WHERE data ? 'landmarkSelection' OR data ? 'ideaGeneration' ORDER BY created_at`);
  fs.mkdirSync(OUT, { recursive: true });
  const out = rows.map(r => {
    const d = r.data;
    return { id: r.id, at: r.created_at, city: d.userLocation?.city, category: d.storyCategory, theme: d.storyTheme, topic: d.storyTopic,
      cast: (d.characters || []).map(c => ({ age: c.age })), ideaWorld: d.ideaWorld, ideaPick: d.ideaPick,
      landmarkSelection: d.landmarkSelection, ideaGeneration: d.ideaGeneration, storyDetails: d.storyDetails, premiseNamedWorld: d.premiseNamedWorld, language: d.language };
  });
  fs.writeFileSync(OUT + '/lm-stories.jsonl', out.map(x => JSON.stringify(x)).join('\n'));
  console.log(out.length, 'rows;', out.filter(x => x.landmarkSelection).length, 'with landmarkSelection;', out.filter(x => x.ideaGeneration).length, 'with ideaGeneration');
  const ig = out.find(x => x.ideaGeneration); console.log(JSON.stringify(ig?.ideaGeneration).slice(0, 2500));
  await pool.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
