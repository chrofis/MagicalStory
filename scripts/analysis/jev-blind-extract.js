// Extract blind-judge samples (inventory + contract + findings) from stored staging stories.
// Usage: node scripts/analysis/jev-blind-extract.js <outFile>
require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
const slim = (f) => f && ({ label: f.label, zone: f.zone, facing: f.facing, hair: f.hair, clothing: f.clothing, headwear: f.headwear, worn_carried: f.worn_carried,
  age_group: f.age_group, apparent_age: f.apparent_age, height_rank: f.height_rank });
(async () => {
  const ids = (await pool.query("select id from stories where data ? 'sceneImages' order by created_at desc limit 400")).rows.map(r => r.id);
  const out = [];
  for (const id of ids) {
    const q = await pool.query("select data->'sceneImages' si, data->>'title' t, data->'characters' ch from stories where id=$1", [id]);
    const si = q.rows[0].si || [];
    let n = 0;
    si.forEach((p, pi) => (p.imageVersions || []).forEach((v, vi) => {
      const ts = v.threeStageResult; if (!ts || !ts.visionInventory || !ts.complianceResult) return;
      let inv; try { inv = JSON.parse(ts.visionInventory); } catch { return; }
      const rp = ((v.referencePhotos && v.referencePhotos.length ? v.referencePhotos : p.referencePhotos) || []).filter(x => x.name).map(x => ({ name: x.name, cat: x.clothingCategory, outfit: x.clothingDescription }));
      out.push({
        story: id, page: p.pageNumber, ver: vi, title: q.rows[0].t,
        prompt: (v.prompt || '').slice(0, 9000), storyText: p.text, artStyle: undefined,
        contract: rp, cast: (p.sceneCharacters || v.sceneCharacters || []).map(c => ({ name: c.name, age: c.age, ageCat: c.ageCategory })),
        figures: (inv.figures || []).map(slim), nObjects: (inv.objects || []).length, objects: (inv.objects || []).map(o => ({ what: o.what, complete: o.complete })),
        lettering: inv.lettering || [], qfig: (v.figures || []).map(f => ({ id: f.id, zone: f.zone })), qmatch: v.matches || [],
        blind: (ts.complianceResult.fixable_issues || []).map(i => ({ type: i.type, sev: i.severity, ch: i.character, d: i.description })),
        others: {
          quality: (v.deductions?.quality || []), semantic: (v.deductions?.semantic || []), entity: (v.deductions?.entity || []),
          consolidated: (v.deductions?.consolidated || []).map(x => ({ type: x.type, d: (x.description || '').slice(0, 200), src: x.sources || x.source }))
        },
        fixableIssues: (v.fixableIssues || []).map(i => ({ type: i.type, sev: i.severity, ch: i.character, src: i.sources || i.source, d: (i.description || '').slice(0, 250) })),
        qualityIssues: (v.scoreBreakdown?.visual?.issues || []).slice(0, 12), entityIssues: (v.entityIssues || []).slice(0, 8),
      });
      n++;
    }));
    if (n) console.error(id, n);
  }
  fs.writeFileSync(process.argv[2], JSON.stringify(out));
  console.error('total versions', out.length, 'figures', out.reduce((a, x) => a + x.figures.length, 0));
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
