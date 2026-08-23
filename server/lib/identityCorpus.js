/**
 * HARVEST THE HARD 1% — pages where the evaluator and the detector disagree
 * about who is who.
 *
 * The two sides identify figures by completely different routes: the detector
 * from full-body masks plus per-figure identity lines, the evaluator from the
 * picture and the reference photos. Where they agree, the image was easy and
 * there is nothing to learn from it. Where they disagree, the image is hard in
 * the specific way both sides need to get better at — several same-age children,
 * an occluded body, a swapped outfit. Sampling pages at random buys mostly the
 * easy ones; this buys only the hard ones.
 *
 * The corpus is a normal Test Lab SET (stage `quality_eval`, target
 * {storyId, page}), so it is inspectable, runnable and editable through the
 * existing Lab UI — no parallel mechanism, per the generic-sets rule.
 *
 * Harvesting is best-effort: a corpus write must never fail a generation.
 */

const { log } = require('../utils/logger');

const SET_NAME = 'Identity conflicts (auto-harvested)';
const SET_STAGE = 'quality_eval';

let setIdPromise = null;

/** The set is created once per process, on the first conflict of its life. */
async function ensureSet(dbQuery) {
  if (!setIdPromise) {
    setIdPromise = (async () => {
      const rows = await dbQuery(
        `INSERT INTO testlab_sets (name, stage, params, created_by)
         VALUES ($1, $2, '{}'::jsonb, 'pipeline')
         ON CONFLICT (name, stage) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [SET_NAME, SET_STAGE]
      );
      return rows[0].id;
    })().catch(err => { setIdPromise = null; throw err; });
  }
  return setIdPromise;
}

/**
 * @param {Object} p
 *   storyId, pageNumber, report (from checkIdentityAgreement/reconcileIdentity)
 * @returns {Promise<boolean>} whether a member was recorded
 */
async function harvestIdentityConflict({ storyId, pageNumber, report }) {
  if (!storyId || !report || !report.conflicts?.length) return false;
  try {
    const { dbQuery } = require('../services/database');
    const setId = await ensureSet(dbQuery);
    const pairs = report.conflicts.map(c => `${c.evaluator}→${c.detector}`).join(', ');
    // target_key is UNIQUE per set, so re-harvesting the same page across repair
    // rounds refreshes the label instead of piling up duplicates.
    await dbQuery(
      `INSERT INTO testlab_set_members (set_id, target, params, target_key, label)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (set_id, target_key) DO UPDATE SET label = EXCLUDED.label, params = EXCLUDED.params`,
      [
        setId,
        // `pageNumber` is the key the Lab runner reads (`target.pageNumber`) —
        // a member keyed `page` loads as "Scene not found: … page undefined".
        JSON.stringify({ storyId, pageNumber }),
        JSON.stringify({ identityAgreement: report }),
        `${storyId}:p${pageNumber}`,
        `p${pageNumber} · ${report.conflicts.length}/${report.compared} contested · ${pairs}${report.uncorrectable ? ' · uncorrectable' : ''}`,
      ]
    );
    return true;
  } catch (err) {
    log.debug(`[IDENTITY-CORPUS] Could not harvest ${storyId} p${pageNumber}: ${err.message}`);
    return false;
  }
}

module.exports = { harvestIdentityConflict, SET_NAME, SET_STAGE };
