#!/usr/bin/env node
/**
 * Dump a story's pages against the age-band plot rules so the prose can be
 * judged page by page (prompts/age-band-*.txt).
 *
 * Prints the page text and the scene brief's prose for each page, plus a set of
 * mechanical flags for the rules that are literally checkable. The flags are a
 * reading aid, NOT a verdict — the real check is reading the pages.
 *
 *   node scripts/analysis/toddler-page-review.js <storyId> [--prod]
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');

const storyId = process.argv[2];
const useProd = process.argv.includes('--prod');
if (!storyId) {
  console.error('Usage: node scripts/analysis/toddler-page-review.js <storyId> [--prod]');
  process.exit(1);
}

// Words that signal the story shapes the routine and quest bands forbid: a quest, a search,
// a rescue, a secret or a prize. German + English, matched on the shipped text.
const QUEST_WORDS = /\b(schatz|schätze|quest|mission|rätsel|geheimnis|geheime|karte|hinweis|spur|retten|rettung|gewinn|preis|beute|suche|suchen|gesucht|versteckt|vergraben|treasure|clue|riddle|secret|rescue|prize|hunt)\b/gi;
const SWEETS = /\b(süssigkeit|süßigkeit|bonbon|schokolade|kuchen|eis|glace|zucker|keks|candy|chocolate|ice cream|sweets|cookie)\b/gi;

(async () => {
  const pool = new Pool({
    connectionString: useProd ? process.env.DATABASE_URL : process.env.STAGING_DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  const r = await pool.query('SELECT data FROM stories WHERE id = $1', [storyId]);
  if (!r.rows.length) { console.error('no such story'); await pool.end(); process.exit(1); }
  const d = r.rows[0].data || {};
  const scenes = Array.isArray(d.sceneImages) ? d.sceneImages : [];

  console.log(`TITLE: ${d.title || '(none)'}`);
  const emma = (d.characters || []).find(c => c.name === 'Emma');
  console.log(`focus character age as stored: ${emma ? JSON.stringify(emma.age) : 'n/a'}`);
  console.log('='.repeat(72));

  const allText = [];
  for (const s of scenes) {
    const text = String(s.text || '').trim();
    allText.push(text);
    const prose = String(s.sceneDescription || '').split('---METADATA---')[0].trim();
    console.log(`\n── Page ${s.pageNumber} ${'─'.repeat(50)}`);
    console.log('TEXT:  ' + (text || '(none)'));
    console.log('SCENE: ' + (prose.slice(0, 300) || '(none)').replace(/\n/g, '\n       '));
  }

  console.log('\n' + '='.repeat(72));
  console.log('MECHANICAL FLAGS (reading aid, not a verdict)');
  const joined = allText.join('\n');
  const quest = [...new Set((joined.match(QUEST_WORDS) || []).map(w => w.toLowerCase()))];
  const sweets = [...new Set((joined.match(SWEETS) || []).map(w => w.toLowerCase()))];
  console.log(`  pages: ${scenes.length}`);
  console.log(`  quest/secret/prize vocabulary: ${quest.length ? quest.join(', ') : 'none'}`);
  console.log(`  sweets/ice cream vocabulary:   ${sweets.length ? sweets.join(', ') : 'none'}`);
  const longest = allText.reduce((m, t) => Math.max(m, t.split(/\s+/).filter(Boolean).length), 0);
  console.log(`  longest page: ${longest} words`);
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
