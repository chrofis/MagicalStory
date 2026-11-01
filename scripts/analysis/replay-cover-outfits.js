#!/usr/bin/env node
/**
 * RUNG 1 for "Cover outfit decided by code" (docs/decisions.md 2026-11-01): replay the REAL decider (coverBeats.coverOutfits)
 * and the REAL pin (jevDecisions.pinBrief, with jevBriefFields.coverFacts) over the covers of STORED staging stories. No
 * model call, no write.
 *
 *   node scripts/analysis/replay-cover-outfits.js [--limit=40] [--dotenv=<path>]
 *
 * Per story and cover it prints the figures, what the stored brief's METADATA dressed each in, what code decides, and
 * whether the pin would change the stored brief. A story whose wardrobe has no `standard` day outfit for a cover figure
 * is the case the wardrobe step (prompts/story-bible-from-beats.txt, DAY_OUTFIT_DEF) must now prevent: it is counted.
 */
const path = require('path');
const ROOT = path.join(__dirname, '../..');
const argv = process.argv.slice(2);
const dotenvArg = argv.find(a => a.startsWith('--dotenv='));
const limitArg = argv.find(a => a.startsWith('--limit='));
require('dotenv').config({ path: dotenvArg ? dotenvArg.slice(9) : path.join(ROOT, '.env') });
const LIMIT = limitArg ? Number(limitArg.slice(8)) : 40;

(async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const { coverCasts, coverOutfits } = require('../../server/lib/coverBeats');
  const { coverFacts } = require('../../server/lib/jevBriefFields');
  const { pinBrief } = require('../../server/lib/jevDecisions');
  const { parseProseMetadataFormat } = require('../../server/lib/sceneMetadata');
  const { assertCoverClothingIsDecided } = require('../../server/lib/clothingCategories');

  const rows = (await pool.query(
    `select id, data->'characters' characters, data->'mainCharacters' mains, data->'clothingRequirements' reqs, data->'coverImages' covers
       from stories where data->'coverImages' is not null and jsonb_typeof(data->'coverImages') = 'object'
        and coalesce(data->>'trialMode','false') <> 'true' and data->'characters' is not null
      order by created_at desc limit $1`, [LIMIT * 3])).rows;
  await pool.end();

  let stories = 0, withoutStandard = 0, covers = 0, storedNight = 0, pinChanged = 0, guardOk = 0, openFigures = 0;
  const table = [];
  for (const r of rows) {
    const keys = Object.keys(r.covers || {}).filter(k => r.covers[k] && (r.covers[k].sceneDescription || r.covers[k].description));
    if (!keys.length) continue;
    if (stories >= LIMIT) break;
    stories++;
    const input = { characters: r.characters || [], mainCharacters: r.mains || [] };
    const casts = coverCasts(input);
    let missing = null;
    const perCover = [];
    for (const k of keys) {
      const names = casts[k];
      if (!names) continue;
      let o;
      try { o = coverOutfits(names, r.reqs); } catch (e) { missing = e.message.replace(/^coverBeats: /, '').replace(/ in the wardrobe.*$/, ''); break; }
      covers++;
      const facts = coverFacts({ coverKey: k, storyBeats: [], outfits: o });
      const brief = r.covers[k].sceneDescription || r.covers[k].description;
      const parsed = parseProseMetadataFormat(brief);
      const stored = parsed ? Object.fromEntries((parsed.metadata.characters || []).map(c => [c.name, c.clothing || null])) : {};
      if (Object.values(stored).some(c => String(c).toLowerCase().includes('nightwear'))) storedNight++;
      openFigures += Object.keys(o.open).length;
      const pinned = pinBrief(brief, facts);
      const changes = pinned.changes.filter(c => c.field === 'clothing');
      if (changes.length) pinChanged++;
      const after = parseProseMetadataFormat(pinned.brief);
      const perChar = Object.fromEntries((after ? after.metadata.characters || [] : []).map(c => [c.name, c.clothing || null]));
      const asRendered = Object.fromEntries(Object.entries(perChar).filter(([n]) => names.includes(n)));
      let guard = 'ok';
      try { assertCoverClothingIsDecided(asRendered, facts, k); guardOk++; } catch (e) { guard = e.message.slice(0, 80); }
      perCover.push(`${k}: ${names.map(n => `${n}[stored ${stored[n] || '-'} -> ${o.fixed[n] || `open ${o.open[n].join('|')}`}]`).join(', ')}${changes.length ? ` (pin changes ${changes.length})` : ''} guard ${guard}`);
    }
    if (missing) { withoutStandard++; table.push(`${r.id}  NO STANDARD DAY OUTFIT: ${missing}`); }
    else table.push(`${r.id}\n    ${perCover.join('\n    ')}`);
  }
  console.log(table.join('\n'));
  console.log(`\nstories ${stories}, covers decided ${covers}, stories WITHOUT a standard day outfit for a cover figure ${withoutStandard}`);
  console.log(`stored cover briefs with a nightwear figure ${storedNight}; covers where the pin changes a clothing row ${pinChanged}; covers passing the render guard after the pin ${guardOk}/${covers}; costume-open figure slots ${openFigures}`);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
