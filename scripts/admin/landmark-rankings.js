#!/usr/bin/env node
/**
 * Show landmark rankings by score (current) vs fame (proposed).
 * Used for the backfill report to show impact on selection.
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function showRankings(cities) {
  console.log('Landmark Rankings Report\n');
  console.log('Current ranking (by score DESC) vs Proposed (by fame_sitelinks DESC)\n');

  for (const city of cities) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`${city.toUpperCase()}`);
    console.log(`${'='.repeat(80)}\n`);

    // By current score
    const scoreRes = await pool.query(`
      SELECT
        ROW_NUMBER() OVER (ORDER BY score DESC) as score_rank,
        name,
        score,
        boost_amount,
        fame_sitelinks,
        fame_pageviews
      FROM landmark_index
      WHERE nearest_city = $1 AND wikidata_qid IS NOT NULL
      ORDER BY score DESC
      LIMIT 15
    `, [city]);

    const scoreResults = scoreRes.rows;

    // By fame sitelinks
    const fameRes = await pool.query(`
      SELECT
        ROW_NUMBER() OVER (ORDER BY COALESCE(fame_sitelinks, 0) DESC) as fame_rank,
        name,
        score,
        boost_amount,
        fame_sitelinks,
        fame_pageviews
      FROM landmark_index
      WHERE nearest_city = $1 AND wikidata_qid IS NOT NULL AND fame_sitelinks IS NOT NULL
      ORDER BY fame_sitelinks DESC
      LIMIT 15
    `, [city]);

    const fameResults = fameRes.rows;

    console.log('By SCORE (current, top 15):');
    console.log('-'.repeat(80));
    console.log('Rank | Name                                      | Score | Sitelinks | Pageviews');
    console.log('-'.repeat(80));
    scoreResults.forEach(r => {
      const name = (r.name || '').padEnd(40);
      const score = String(r.score || 0).padEnd(5);
      const sitelinks = String(r.fame_sitelinks || '-').padEnd(9);
      const pageviews = String(r.fame_pageviews || '-').padEnd(9);
      console.log(`${String(r.score_rank).padStart(4)} | ${name} | ${score} | ${sitelinks} | ${pageviews}`);
    });

    console.log('\n\nBy FAME_SITELINKS (proposed, top 15):');
    console.log('-'.repeat(80));
    console.log('Rank | Name                                      | Score | Sitelinks | Pageviews');
    console.log('-'.repeat(80));
    fameResults.forEach(r => {
      const name = (r.name || '').padEnd(40);
      const score = String(r.score || 0).padEnd(5);
      const sitelinks = String(r.fame_sitelinks || '-').padEnd(9);
      const pageviews = String(r.fame_pageviews || '-').padEnd(9);
      console.log(`${String(r.fame_rank).padStart(4)} | ${name} | ${score} | ${sitelinks} | ${pageviews}`);
    });

    // Find specific landmarks
    const grossmunster = await pool.query(`
      SELECT
        name,
        score,
        fame_sitelinks,
        fame_pageviews,
        (SELECT COUNT(*) + 1 FROM landmark_index l2 WHERE l2.nearest_city = $1 AND l2.score > landmark_index.score) as score_rank,
        (SELECT COUNT(*) + 1 FROM landmark_index l2 WHERE l2.nearest_city = $1 AND COALESCE(l2.fame_sitelinks, 0) > COALESCE(landmark_index.fame_sitelinks, 0)) as fame_rank
      FROM landmark_index
      WHERE nearest_city = $1 AND name ILIKE '%Grossmünster%'
    `, [city]);

    if (grossmunster.rows.length > 0) {
      const gm = grossmunster.rows[0];
      console.log(`\n\nGrossmünster in ${city}:`);
      console.log(`  By score: rank ${gm.score_rank} (score=${gm.score})`);
      console.log(`  By fame:  rank ${gm.fame_rank} (sitelinks=${gm.fame_sitelinks})`);
    }
  }

  await pool.end();
}

const cities = ['Zürich', 'Bern', 'Luzern', 'Genève'];
showRankings(cities).catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
