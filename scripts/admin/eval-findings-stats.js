#!/usr/bin/env node
// Per-style / per-genre eval failure stats from the eval_findings table.
//
//   node scripts/admin/eval-findings-stats.js                 # by art_style
//   node scripts/admin/eval-findings-stats.js --by=genre
//   node scripts/admin/eval-findings-stats.js --by=bucket --since=2026-07-01
//
// Answers "what goes wrong per style / story type" once eval_findings has data
// (populated when evaluateImageQuality is called with evalOptions.storyMeta).
const { getEvalFindingsStats, closePool } = require('../../server/services/database');

function arg(name, def = null) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
}

(async () => {
  const groupBy = arg('by', 'art_style');
  const since = arg('since', null);
  try {
    const rows = await getEvalFindingsStats({ groupBy, since });
    if (!rows.length) {
      console.log(`No eval_findings rows yet${since ? ` since ${since}` : ''}. ` +
        `Rows populate when evaluateImageQuality runs with evalOptions.storyMeta.`);
      return;
    }
    // Roll up into { group_key: { bucket: count } }.
    const byGroup = {};
    for (const r of rows) {
      const g = r.group_key ?? '(none)';
      (byGroup[g] ||= {});
      byGroup[g][r.bucket] = (byGroup[g][r.bucket] || 0) + Number(r.n);
    }
    console.log(`\nEval failures grouped by ${groupBy}${since ? ` (since ${since})` : ''}:\n`);
    for (const [g, buckets] of Object.entries(byGroup)) {
      const total = Object.values(buckets).reduce((a, b) => a + b, 0);
      const top = Object.entries(buckets).sort((a, b) => b[1] - a[1]);
      console.log(`■ ${g}  (${total} findings)`);
      for (const [bucket, n] of top) {
        const pct = Math.round((n / total) * 100);
        console.log(`    ${String(n).padStart(4)}  ${String(pct).padStart(3)}%  ${bucket}`);
      }
      console.log('');
    }
  } catch (e) {
    console.error('Failed to read eval_findings:', e.message);
    process.exitCode = 1;
  } finally {
    try { await closePool(); } catch { /* ignore */ }
  }
})();
