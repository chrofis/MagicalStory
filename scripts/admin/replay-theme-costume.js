#!/usr/bin/env node
/**
 * Replay the REAL wardrobe-writer step (Test Lab story_bible_replay: the real
 * buildStoryBibleFromBeatsPrompt over a stored story, one real model call) and
 * classify who got costumed. Used to measure the theme-costume rule
 * (docs/decisions.md 2026-10-18). One story per call, raw output saved.
 *
 *   node scripts/admin/replay-theme-costume.js --db=staging|prod --out=<dir> <storyId>...
 *   node scripts/admin/replay-theme-costume.js --summarise --out=<dir>
 *
 * Costs one wardrobe call per story (printed). Reads stories only.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (k) => (args.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];
const out = opt('out');
const ids = args.filter(a => !a.startsWith('--'));
if (!out) throw new Error('--out=<dir> required');
fs.mkdirSync(out, { recursive: true });

const isChild = (c) => Number(c.age) < 18;

function classify(storyData, clothing) {
  const rows = [];
  for (const c of storyData.characters || []) {
    const entry = (clothing || {})[c.name] || {};
    const costumed = entry.costumed && entry.costumed.used ? entry.costumed : null;
    rows.push({
      name: c.name, age: c.age, child: isChild(c),
      costumed: !!costumed, costume: costumed ? costumed.costume || null : null,
      outfit: (costumed || entry.standard || {}).description || null,
    });
  }
  return rows;
}

async function run() {
  if (opt('db') === 'staging') process.env.DATABASE_URL = process.env.STAGING_DATABASE_URL;
  process.env.PGSSLMODE = 'no-verify'; // Railway proxy needs TLS without a verifiable chain
  const { runStoryBibleReplayStage } = require('../../server/lib/testlab');
  const { guideCostume, getTeachingGuide } = require('../../server/lib/promptBuilders');
  const { UnifiedStoryParser } = require('../../server/lib/outlineParser/unified');
  const db = require('../../server/services/database');
  db.initializePool();
  for (const id of ids) {
    const file = path.join(out, `${id}.json`);
    if (fs.existsSync(file)) { console.log(`${id}: already done`); continue; }
    const rows = await db.dbQuery('SELECT data FROM stories WHERE id = $1', [id]);
    const sd = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
    const theme = sd.storyTheme || sd.storyTopic;
    const themeCostume = guideCostume(getTeachingGuide(sd.storyCategory, sd.storyCategory === 'adventure' ? (sd.storyTheme || sd.storyTopic) : (sd.storyTopic || sd.storyTheme)));
    const r = await runStoryBibleReplayStage({ storyId: id }, { params: {} });
    const after = new UnifiedStoryParser(r.rawResponse).extractClothingRequirements();
    const rec = {
      storyId: id, db: opt('db'), theme, themeCostume, beatsSource: r.beatsSource, model: r.modelId, cost: r.cost,
      stored: classify(sd, sd.clothingRequirements), replay: classify(sd, after),
      prompt: r.prompt, rawResponse: r.rawResponse,
    };
    fs.writeFileSync(file, JSON.stringify(rec, null, 1));
    console.log(`${id} theme=${theme} costume=${themeCostume || '-'} cost=${JSON.stringify(r.cost)} replay=${rec.replay.map(x => `${x.name}${x.child ? '(c)' : '(a)'}:${x.costumed ? x.costume : 'std'}`).join(' ')}`);
  }
  process.exit(0);
}

function summarise() {
  const recs = fs.readdirSync(out).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(out, f), 'utf8')));
  const match = (c, want) => c.costumed && want && String(c.costume || '').toLowerCase().includes(want.toLowerCase());
  const sum = { stories: recs.length, positives: 0, negatives: 0 };
  let pos = { storiesAllChildrenRight: 0, childRight: 0, childN: 0, storedChildRight: 0, adultCostumed: 0, adultN: 0, storedAdultCostumed: 0 };
  let neg = { childCostumed: 0, childN: 0, storedChildCostumed: 0 };
  for (const r of recs) {
    const kids = r.replay.filter(c => c.child), adults = r.replay.filter(c => !c.child);
    if (r.themeCostume) {
      sum.positives++;
      pos.childN += kids.length; pos.adultN += adults.length;
      pos.childRight += kids.filter(c => match(c, r.themeCostume)).length;
      pos.storedChildRight += r.stored.filter(c => c.child && match(c, r.themeCostume)).length;
      pos.adultCostumed += adults.filter(c => c.costumed).length;
      pos.storedAdultCostumed += r.stored.filter(c => !c.child && c.costumed).length;
      if (kids.length && kids.every(c => match(c, r.themeCostume))) pos.storiesAllChildrenRight++;
    } else {
      sum.negatives++;
      neg.childN += kids.length; neg.childCostumed += kids.filter(c => c.costumed).length;
      neg.storedChildCostumed += r.stored.filter(c => c.child && c.costumed).length;
    }
  }
  const cost = recs.reduce((a, r) => a + (Number(typeof r.cost === 'object' ? r.cost.total ?? r.cost.cost : r.cost) || 0), 0);
  console.log(JSON.stringify({ sum, pos, neg, cost }, null, 1));
}

if (args.includes('--summarise')) summarise(); else run().catch(e => { console.error(e); process.exit(1); });
