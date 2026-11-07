// F2 scorer: structural counts over the stand-in re-tellings, by the production parser. No prose is read.
// usage: node score-F2.js <runDir>      (blind map is read only here, after all answers exist)
const fs = require('fs'); const path = require('path');
const ROOT = 'C:/Users/roger/MagicalStory';
const PB = require(ROOT + '/server/lib/promptBuilders');
const dir = process.argv[2];
const map = JSON.parse(fs.readFileSync(path.join(dir, 'F2', 'blind-map.json'), 'utf8'));
const man = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).manifest.F2;
const { Pool } = require(ROOT + '/node_modules/pg');
require(ROOT + '/node_modules/dotenv').config({ path: ROOT + '/.env' });

// HARNESS ONLY: stored arcs predate the three prescribed labels and use others (Crossing in, Getting there ...); this
// widens the exclusion so an old label copied into an answer is not scored as an added rule. Production counts the 3 labels only.
const WORLDISH = /^(world|way in|way back|crossing|return|getting there|getting back|set in)/i;
const norm = (l) => String(l).replace(/\s+/g, ' ').trim().toLowerCase();
(async () => {
  const pools = { prod: new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }), staging: new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } }) };
  const prior = {};
  for (const m of man) {
    const q = await pools[m.env].query('select data->\'arcReviewReport\'->>\'committed\' c from stories where id=$1', [m.id]);
    prior[m.k] = PB.parseStoryLogic(q.rows[0].c);
  }
  const rows = [];
  for (const [nm, it] of Object.entries(map)) {
    const f = path.join(dir, 'F2', 'answers', nm + '.txt');
    if (!fs.existsSync(f)) { rows.push({ nm, ...it, missing: true }); continue; }
    const raw = fs.readFileSync(f, 'utf8');
    const pr = prior[it.k];
    try {
      const rt = PB.parseArcRetell(raw);
      const L = rt.logic;
      const priorSet = new Set(pr.facts.map(norm)); // untagged lines (rules and world lines)
      const priorFig = new Set(PB.parseStoryLogic ? [] : []);
      const figLines = (txt) => txt.split('\n').map(x => x.replace(/\*\*/g, '').trim()).filter(x => /^[-–—*•]\s*.+\((commissioned|new)\)/i.test(x) && !/[—–-]\s*none\.?$/i.test(x)).map(x => norm(x.replace(/^[-–—*•]\s*/, '')));
      const priorFigSet = new Set(figLines(pr.text));
      const newFig = figLines(L.text).filter(x => !priorFigSet.has(x));
      const newRules = L.rules.filter(x => !priorSet.has(norm(x)));
      const over = PB.retellRuleOvershoot(pr, L);
      const rulesH = L.rules.filter(x => !WORLDISH.test(x)).length; const priorH = pr.rules.filter(x => !WORLDISH.test(x)).length;
      rows.push({ nm, ...it, parsed: true, priorRules: pr.rules.length, rules: L.rules.length, rulesAdded: Math.max(0, L.rules.length - pr.rules.length), newRuleLines: newRules.length, newFigureFacts: newFig.length, addedFactLines: newRules.length + newFig.length, rulesH, priorH, grewH: rulesH > priorH, overH: rulesH > 2, worldRulesOver: L.rules.length > 2, overshoot: !!over, newFigures: L.invented.length - pr.invented.length, sentences: rt.sentences });
    } catch (e) { rows.push({ nm, ...it, parsed: false, err: e.message }); }
  }
  const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
  const out = {};
  for (const arm of ['old', 'new']) {
    const r = rows.filter(x => x.arm === arm && x.parsed);
    out[arm] = {
      n: r.length, parseFail: rows.filter(x => x.arm === arm && !x.parsed).length,
      addedFactLinesTotal: sum(r, x => x.addedFactLines), addedFactLinesMean: +(sum(r, x => x.addedFactLines) / r.length).toFixed(2),
      newRuleLines: sum(r, x => x.newRuleLines), newFigureFacts: sum(r, x => x.newFigureFacts),
      retellsAddingAnyFact: r.filter(x => x.addedFactLines > 0).length,
      retellsRulesGrew: r.filter(x => x.rulesAdded > 0).length,
      worldRulesOver: r.filter(x => x.worldRulesOver).length, rulesGrewH: r.filter(x => x.grewH).length, rulesOverCapH: r.filter(x => x.overH).length, rulesAddedPastCapH: r.filter(x => x.grewH && x.overH).length, refusedByOvershoot: r.filter(x => x.overshoot).length,
      newFiguresTotal: sum(r, x => Math.max(0, x.newFigures)),
    };
  }
  fs.writeFileSync(path.join(dir, 'F2', 'scores.json'), JSON.stringify({ out, rows }, null, 1));
  console.log(JSON.stringify(out, null, 1));
  await pools.prod.end(); await pools.staging.end(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
