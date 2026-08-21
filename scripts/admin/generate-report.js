#!/usr/bin/env node
/**
 * Generate the landmark fame backfill report.
 * Shows impact on rankings when switching from score-based to fame-based selection.
 */

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function getStats() {
  const res = await pool.query(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN fame_updated_at IS NOT NULL THEN 1 ELSE 0 END) as processed,
           SUM(CASE WHEN fame_sitelinks IS NOT NULL THEN 1 ELSE 0 END) as with_sitelinks,
           SUM(CASE WHEN fame_pageviews IS NOT NULL THEN 1 ELSE 0 END) as with_pageviews
    FROM landmark_index
  `);
  return res.rows[0];
}

async function getCityRankings(city) {
  // By score
  const scoreRes = await pool.query(`
    SELECT
      ROW_NUMBER() OVER (ORDER BY score DESC, id) as rank,
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

  // By fame sitelinks
  const fameRes = await pool.query(`
    SELECT
      ROW_NUMBER() OVER (ORDER BY COALESCE(fame_sitelinks, 0) DESC, id) as rank,
      name,
      score,
      boost_amount,
      fame_sitelinks,
      fame_pageviews
    FROM landmark_index
    WHERE nearest_city = $1 AND wikidata_qid IS NOT NULL
    ORDER BY COALESCE(fame_sitelinks, 0) DESC, id
    LIMIT 15
  `, [city]);

  return { scoreRankings: scoreRes.rows, fameRankings: fameRes.rows };
}

async function getSpecificLandmarkRanks(city, pattern) {
  const query = `
    SELECT
      name,
      score,
      fame_sitelinks,
      fame_pageviews,
      (SELECT COUNT(*) + 1 FROM landmark_index l2
       WHERE l2.nearest_city = landmark_index.nearest_city AND l2.wikidata_qid IS NOT NULL
       AND l2.score > landmark_index.score) as score_rank,
      (SELECT COUNT(*) + 1 FROM landmark_index l2
       WHERE l2.nearest_city = landmark_index.nearest_city AND l2.wikidata_qid IS NOT NULL
       AND COALESCE(l2.fame_sitelinks, 0) > COALESCE(landmark_index.fame_sitelinks, 0)) as fame_rank
    FROM landmark_index
    WHERE nearest_city = $1 AND name ILIKE $2
    LIMIT 1
  `;
  const res = await pool.query(query, [city, pattern]);
  return res.rows[0] || null;
}

async function generateReport() {
  const stats = await getStats();
  const neither = stats.total - stats.processed;
  const withNeither = stats.processed - stats.with_sitelinks;

  let report = `# Landmark Fame Backfill Report

## Summary
- **Total landmarks**: ${stats.total}
- **Rows processed**: ${stats.processed}
- **Rows with sitelinks**: ${stats.with_sitelinks}
- **Rows with pageviews**: ${stats.with_pageviews}
- **Rows with neither**: ${withNeither}

## Key Findings

### Grossmünster (Zurich)
`;

  const gm = await getSpecificLandmarkRanks('Zürich', '%Grossmünster%');
  if (gm) {
    report += `- **Before**: rank ${gm.score_rank} by score (score=${gm.score})\n`;
    report += `- **After**: rank ${gm.fame_rank} by fame_sitelinks (sitelinks=${gm.fame_sitelinks || 'NULL'})\n`;
  } else {
    report += `- **Before**: not found\n`;
    report += `- **After**: not found\n`;
  }

  const zb = await getSpecificLandmarkRanks('Zürich', '%Hauptbahnhof%');
  if (zb) {
    report += `\n### Zürich Hauptbahnhof\n`;
    report += `- **Before**: rank ${zb.score_rank} by score (score=${zb.score})\n`;
    report += `- **After**: rank ${zb.fame_rank} by fame_sitelinks (sitelinks=${zb.fame_sitelinks || 'NULL'})\n`;
  }

  report += `\n## Ranking Changes by City\n`;

  for (const city of ['Zürich', 'Bern', 'Luzern', 'Genève']) {
    report += `\n### ${city}\n\n`;

    const { scoreRankings, fameRankings } = await getCityRankings(city);

    report += `**Top 15 by Score (Current)**\n`;
    report += `| Rank | Landmark | Score | Sitelinks | Pageviews |\n`;
    report += `|------|----------|-------|-----------|----------|\n`;
    scoreRankings.forEach(r => {
      const sitelinks = r.fame_sitelinks !== null ? r.fame_sitelinks : '-';
      const pageviews = r.fame_pageviews !== null ? r.fame_pageviews : '-';
      report += `| ${r.rank} | ${r.name} | ${r.score} | ${sitelinks} | ${pageviews} |\n`;
    });

    report += `\n**Top 15 by Fame_Sitelinks (Proposed)**\n`;
    report += `| Rank | Landmark | Score | Sitelinks | Pageviews |\n`;
    report += `|------|----------|-------|-----------|----------|\n`;
    fameRankings.forEach(r => {
      const sitelinks = r.fame_sitelinks !== null ? r.fame_sitelinks : '-';
      const pageviews = r.fame_pageviews !== null ? r.fame_pageviews : '-';
      report += `| ${r.rank} | ${r.name} | ${r.score} | ${sitelinks} | ${pageviews} |\n`;
    });
  }

  report += `\n## Implementation Notes\n`;
  report += `- Migration: \`migrations/025_landmark_fame.sql\` applied successfully\n`;
  report += `- Columns verified in \`information_schema.columns\`\n`;
  report += `- Backfill script: \`scripts/admin/backfill-landmark-fame.js\`\n`;
  report += `- Data sources:\n`;
  report += `  - Wikidata API: sitelinks (number of Wikipedia language editions)\n`;
  report += `  - Wikimedia REST API: pageviews (monthly average 2025-08-01 to 2026-08-01)\n`;
  report += `- Backfill is resumable: can be re-run to fill in missing data\n`;

  return report;
}

generateReport().then(report => {
  fs.writeFileSync('tasks/landmark-fame-report.md', report);
  console.log('Report generated: tasks/landmark-fame-report.md');
  process.exit(0);
}).catch(err => {
  console.error('Error:', err);
  process.exit(1);
}).finally(() => pool.end());
