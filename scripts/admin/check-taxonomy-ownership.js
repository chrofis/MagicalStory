#!/usr/bin/env node
/**
 * Pre-push gate: evalBuckets.js owns the finding taxonomy; scoring.js owns cost.
 *
 * WHY THIS EXISTS — 2026-08-19. Billing per (class, subject) was first written
 * with its own `DEDUCTION_CATEGORY` map from raw evaluator TYPE to category,
 * living in scoring.js. That was a second taxonomy beside the one the repair
 * router already used, and it was wrong within hours of being written: it missed
 * every alias evalBuckets handles (`face`, `age`, `skin_tone`, `hair_change` all
 * mean character_identity), missed the compound-type splitter that resolves
 * junk like `pose_clothing_age`, and grouped `scale` with anatomy when scale
 * actually routes to composition_textzone with a different repair method.
 *
 * The failure mode is SILENT. `deductionClassKey` resolves a finding's type to a
 * BUCKET first, then looks the bucket up in the billing tables. So a raw TYPE
 * placed in those tables never matches anything — the entry looks present, reads
 * correctly to a human, and does nothing. No error, no log line, and the page
 * quietly bills the old way.
 *
 * This gate makes that unmissable: every key in PAGE_SCOPED_BUCKETS and
 * BUCKET_BILLING_CATEGORY must be a real bucket in evalBuckets.BUCKETS.
 *
 * Usage:
 *   node scripts/admin/check-taxonomy-ownership.js          # gate
 *   node scripts/admin/check-taxonomy-ownership.js --list   # show resolved tables
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

const { BUCKETS, TYPE_TO_BUCKET } = require(path.join(ROOT, 'server/lib/evalBuckets'));
const scoring = require(path.join(ROOT, 'server/lib/scoring'));

const failures = [];
const bucketNames = new Set(Object.keys(BUCKETS));

const checkTable = (label, keys) => {
  for (const key of keys) {
    if (bucketNames.has(key)) continue;
    // A raw type that merely ALIASES to a bucket is the exact mistake this gate
    // is for — name the bucket it should have been, so the fix is obvious.
    const alias = TYPE_TO_BUCKET[key];
    failures.push(
      alias
        ? `${label}: "${key}" is an evaluator TYPE, not a bucket — deductionClassKey resolves types to buckets first, so this entry never matches. Use its bucket: "${alias}".`
        : `${label}: "${key}" is not a bucket in evalBuckets.BUCKETS (and not a known type alias either). Add the bucket there first — evalBuckets owns the taxonomy.`
    );
  }
};

checkTable('PAGE_SCOPED_BUCKETS', scoring.PAGE_SCOPED_BUCKETS || []);
checkTable('BUCKET_BILLING_CATEGORY', Object.keys(scoring.BUCKET_BILLING_CATEGORY || {}));

if (process.argv.includes('--list')) {
  console.log('buckets defined in evalBuckets.js:', bucketNames.size);
  console.log('\nPAGE_SCOPED_BUCKETS (one charge per page, subject ignored):');
  for (const b of scoring.PAGE_SCOPED_BUCKETS || []) console.log(`  ${b}`);
  console.log('\nBUCKET_BILLING_CATEGORY (buckets that merge into one billing category):');
  for (const [b, c] of Object.entries(scoring.BUCKET_BILLING_CATEGORY || {})) console.log(`  ${b.padEnd(22)} -> ${c}`);
  console.log('\nEvery other bucket bills under its own name.');
}

if (failures.length) {
  console.error('\n✗ TAXONOMY OWNERSHIP\n');
  for (const f of failures) console.error(`  • ${f}`);
  console.error('\nevalBuckets.js owns the taxonomy (closed bucket set, type aliases, compound');
  console.error('splitter, repair route). scoring.js owns only what a class COSTS.\n');
  process.exit(1);
}

console.log('check-taxonomy-ownership: OK' +
  ` (${(scoring.PAGE_SCOPED_BUCKETS || []).size || 0} page-scoped, ` +
  `${Object.keys(scoring.BUCKET_BILLING_CATEGORY || {}).length} merged, all resolve to real buckets)`);
