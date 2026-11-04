#!/usr/bin/env node
/**
 * Turn chosen Test Lab versions of a story's pages into real versions, on the STAGING copy only,
 * so the owner's pick can go back with promote-story-to-prod.js (which never moves is_test rows).
 *
 * A page's imageVersions array is indexed by version_index, so a chosen Lab version brings along
 * any earlier Lab version of that page that would otherwise leave a gap. Each chosen page is pinned,
 * like every other interactive choice (decisions.md: every interactive flow PINS its choice).
 *
 * Usage:
 *   node scripts/admin/adopt-lab-versions.js <storyId> --experiment=<labId> --picks=1:4,3:4,7:2 [--dry-run]
 *
 * Reads the Lab's own version list from the Lab experiment results; the customer's production story is untouched.
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

function parsePicks(s) {
  const picks = new Map();
  for (const part of String(s || '').split(',').filter(Boolean)) {
    const m = part.match(/^(\d+):(\d+)$/);
    if (!m) throw new Error(`bad pick "${part}", expected page:version`);
    picks.set(Number(m[1]), Number(m[2]));
  }
  if (picks.size === 0) throw new Error('no picks given');
  return picks;
}

/**
 * The plan for one page: which Lab versions become real, and the imageVersions entries to append.
 * @param {object} rec the stored page record
 * @param {number} version the chosen Lab version_index
 * @param {object} labPage the page's entry in the Lab result (`pages[]`)
 * @param {number} experimentId
 * @returns {{adopt: number[], entries: object[]}}
 */
function planPage(rec, version, labPage, experimentId) {
  const existing = Array.isArray(rec.imageVersions) ? rec.imageVersions.length : 0;
  if (version < existing) throw new Error(`p${rec.pageNumber}: version ${version} is already a real version`);
  const v0 = (rec.imageVersions || [])[0] || {};
  const adopt = [];
  const entries = [];
  for (let i = existing; i <= version; i++) {
    const lab = (labPage?.versions || []).find(v => v.labVersionIndex === i);
    if (!lab) throw new Error(`p${rec.pageNumber}: Lab ${experimentId} has no version ${i}`);
    adopt.push(i);
    entries.push({
      type: 'repair',
      source: lab.source,
      method: lab.method,
      finalScore: lab.finalScore,
      scoreSource: 'book_review',
      labExperimentId: experimentId,
      description: v0.description ?? rec.description ?? null,
      sceneMetadata: v0.sceneMetadata ?? rec.sceneMetadata ?? null,
      sceneCharacters: rec.sceneCharacters ?? null,
    });
  }
  return { adopt, entries };
}

async function main() {
  const args = process.argv.slice(2);
  const storyId = args.find(a => !a.startsWith('--'));
  const opt = n => (args.find(a => a.startsWith(`--${n}=`)) || '').slice(n.length + 3);
  const experimentId = Number(opt('experiment'));
  const DRY = args.includes('--dry-run');
  if (!storyId || !experimentId) throw new Error('usage: adopt-lab-versions.js <storyId> --experiment=<id> --picks=page:version,... [--dry-run]');
  const picks = parsePicks(opt('picks'));
  if (!process.env.STAGING_DATABASE_URL) throw new Error('STAGING_DATABASE_URL is not set');

  const { Client } = require('pg');
  const c = new Client({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    const lab = (await c.query('SELECT results FROM testlab_experiments WHERE id = $1', [experimentId])).rows[0];
    if (!lab) throw new Error(`Lab experiment ${experimentId} not found`);
    const results = typeof lab.results === 'string' ? JSON.parse(lab.results) : lab.results;
    const labPages = results.find(r => r.storyId === storyId)?.pages;
    if (!labPages) throw new Error(`Lab ${experimentId} has no result for ${storyId}`);

    await c.query('BEGIN');
    const row = (await c.query("SELECT data->'sceneImages' AS si FROM stories WHERE id = $1 FOR UPDATE", [storyId])).rows[0];
    if (!row) throw new Error(`${storyId} not found on staging`);
    const sceneImages = typeof row.si === 'string' ? JSON.parse(row.si) : row.si;

    for (const [page, version] of picks) {
      const idx = sceneImages.findIndex(s => s.pageNumber === page);
      if (idx < 0) throw new Error(`p${page} not in the story`);
      const { adopt, entries } = planPage(sceneImages[idx], version, labPages.find(p => p.pageNumber === page), experimentId);
      for (const v of adopt) {
        const u = await c.query(
          `UPDATE story_images SET is_test = FALSE, experiment_id = NULL
            WHERE story_id = $1 AND image_type = 'scene' AND page_number = $2 AND version_index = $3 AND is_test AND experiment_id = $4`,
          [storyId, page, v, experimentId]);
        if (u.rowCount !== 1) throw new Error(`p${page} v${v}: expected one Lab row of experiment ${experimentId}, found ${u.rowCount}`);
      }
      sceneImages[idx].imageVersions = [...(sceneImages[idx].imageVersions || []), ...entries];
      sceneImages[idx].bestSource = entries[entries.length - 1].source;
      await c.query(
        `UPDATE stories SET image_version_meta = jsonb_set(COALESCE(image_version_meta, '{}')::jsonb, $1::text[], $2::jsonb) WHERE id = $3`,
        [[String(page)], JSON.stringify({ activeVersion: version, pinned: true }), storyId]);
      console.log(`p${page}: active v${version} (adopted ${adopt.map(v => `v${v}`).join(', ')}, source ${entries[entries.length - 1].source})`);
    }
    await c.query(`UPDATE stories SET data = jsonb_set(data, '{sceneImages}', $1::jsonb) WHERE id = $2`, [JSON.stringify(sceneImages), storyId]);
    if (DRY) { await c.query('ROLLBACK'); console.log('--dry-run: rolled back'); } else { await c.query('COMMIT'); console.log('committed on staging'); }
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await c.end();
  }
}

if (require.main === module) main().catch(e => { console.error(`ERROR: ${e.message}`); process.exit(1); });

module.exports = { parsePicks, planPage };
