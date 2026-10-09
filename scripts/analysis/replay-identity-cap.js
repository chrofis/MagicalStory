/**
 * Replay of the compliance identity-absence cap over STORED staging findings.
 * For every stored finding the cap stamped (severityCapped 'identity-input'), asks:
 * was it capped by its TYPE (missing_character) or only by the description regex
 * that evalPipeline.capComplianceIdentitySeverity used to carry? Free, read-only.
 *   node scripts/analysis/replay-identity-cap.js
 */
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
const OLD_RE = /\bnot identified\b|\bunidentified\b|matches\s*\[\s*\]|\bno (?:entry|match(?:es)?) in\b|\babsent from (?:the )?match/i;
(async () => {
  const r = await pool.query("select id, data from stories where data::text like '%identity-input%'");
  const rows = [];
  const walk = (v, id) => {
    if (Array.isArray(v)) return v.forEach(x => walk(x, id));
    if (!v || typeof v !== 'object') return;
    if (v.severityCapped === 'identity-input') rows.push({ id, type: v.type, regex: OLD_RE.test(String(v.description || '')), sev: v.severity, desc: String(v.description || '').slice(0, 110) });
    for (const k of Object.keys(v)) walk(v[k], id);
  };
  for (const x of r.rows) walk(x.data, x.id);
  const byType = rows.filter(x => x.type === 'missing_character').length;
  const regexOnly = rows.filter(x => x.type !== 'missing_character');
  console.log(`stories with a capped finding: ${r.rows.length}; capped findings: ${rows.length}; capped by type missing_character: ${byType}; capped ONLY by the description regex: ${regexOnly.length}`);
  for (const x of regexOnly) console.log(' regex-only:', x.id, x.type, '|', x.desc);
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
