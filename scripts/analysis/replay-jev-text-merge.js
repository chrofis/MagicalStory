#!/usr/bin/env node
/**
 * Replay the text chain's AUDIT + MERGE stage over stored stories with the Jev
 * source added (2026-09-27), and print which pages the one repair pass would
 * be sent, and why. Rung 1 of the validation ladder: the arc-informed and
 * blind audits are NOT re-run (they are paid); their stored raw replies
 * (stories.data.textRefineReport.audits[].raw) are merged as they were, on the
 * text they read (data.writerText). Jev runs live (~$0.003 per story). No
 * repair call is made.
 *
 *   node scripts/analysis/replay-jev-text-merge.js --env=staging job_A job_B
 *   node scripts/analysis/replay-jev-text-merge.js --env=prod job_C --out=path.json
 *
 * Needs DATABASE_URL / STAGING_DATABASE_URL and OPENROUTER_API_KEY.
 * see docs/decisions.md 2026-09-27 "Jev text audit wired"
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const fs = require('fs');
const { Pool } = require('pg');
const { mergeAuditFindings, buildWordBudgetFindings } = require('../../server/lib/textRefine');
const { runJevTextSource } = require('../../server/lib/jevAudit');

const args = process.argv.slice(2);
const env = (args.find(a => a.startsWith('--env=')) || '--env=staging').slice(6);
const out = (args.find(a => a.startsWith('--out=')) || '').slice(6);
const ids = args.filter(a => !a.startsWith('--'));

function pagesOf(t) {
  const re = /(?:^|\n)(?:--- Page (\d+) ---|## Page (\d+))\s*\n/g;
  const idx = []; let m;
  while ((m = re.exec(t || ''))) idx.push({ n: +(m[1] || m[2]), s: m.index, e: re.lastIndex });
  return idx.map((x, i) => ({ pageNumber: x.n, text: t.slice(x.e, i + 1 < idx.length ? idx[i + 1].s : t.length).trim() }));
}

(async () => {
  if (!ids.length) throw new Error('give one or more story ids');
  const pool = new Pool({ connectionString: env === 'prod' ? process.env.DATABASE_URL : process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const report = [];
  for (const id of ids) {
    const r = await pool.query(`select data->>'title' title, data->>'language' language, data->>'languageLevel' level,
      data->>'writerText' wt,
      (select jsonb_agg(jsonb_build_object('source', a->>'source', 'ok', a->'ok', 'raw', a->>'raw')) from jsonb_array_elements(data->'textRefineReport'->'audits') a) audits,
      (select jsonb_agg(jsonb_build_object('pageNumber', s->'pageNumber', 'oe', s->>'outlineExtract')) from jsonb_array_elements(data->'sceneDescriptions') s) sd
      from stories where id = $1`, [id]);
    const d = r.rows[0];
    if (!d) throw new Error(`${id} not found on ${env}`);
    const planByPage = new Map((d.sd || []).map(s => [s.pageNumber, ((String(s.oe || '').match(/(?:^|\n)\s*PLAN\s*:\s*([\s\S]*)$/i) || [, ''])[1] || '').trim()]));
    const pages = pagesOf(d.wt).map(p => ({ ...p, planLine: planByPage.get(p.pageNumber) || '' }));
    const stored = (d.audits || []).filter(a => a.ok && a.raw);
    const t0 = Date.now();
    const jev = await runJevTextSource({ language: d.language }, pages);
    const jevMs = Date.now() - t0;
    const counter = buildWordBudgetFindings(pages, d.level);
    const lists = [...stored.map(a => ({ source: a.source, raw: a.raw })), ...(counter ? [{ source: 'counter', raw: counter }] : [])];
    const before = mergeAuditFindings(lists);
    const after = mergeAuditFindings([...stored.map(a => ({ source: a.source, raw: a.raw })), ...(jev.ok ? [{ source: 'jev', raw: jev.raw }] : []), ...(counter ? [{ source: 'counter', raw: counter }] : [])]);
    const pagesOfMerge = m => [...new Set(m.findings.map(f => f.pageNumber).filter(n => n != null))].sort((a, b) => a - b);
    const pb = pagesOfMerge(before); const pa = pagesOfMerge(after);
    const added = pa.filter(n => !pb.includes(n));
    console.log(`\n##### ${id} ${d.title} (${d.language}, ${pages.length} pages)`);
    console.log(`stored audits: ${stored.map(a => a.source).join(', ') || '(none)'}; jev: ${jev.ok ? `${jev.calls} calls, $${jev.cost.toFixed(5)}, ${(jevMs / 1000).toFixed(1)}s` : `FAILED/NOT RUN: ${jev.error || jev.skipped}`}`);
    console.log(`pages to repair without Jev: [${pb.join(', ')}]  with Jev: [${pa.join(', ')}]  added by Jev only: [${added.join(', ')}]`);
    for (const f of after.findings.filter(x => x.sources.includes('jev'))) {
      const onlyJev = added.includes(f.pageNumber) ? ' (NEW PAGE)' : '';
      console.log(`  p${f.pageNumber}${onlyJev} ${f.line.slice(0, 220)}`);
    }
    report.push({ id, env, title: d.title, language: d.language, pages: pages.length, jev: { ok: jev.ok, calls: jev.calls, cost: jev.cost, ms: jevMs, error: jev.error || jev.skipped || null, flags: jev.flags, mechanical: jev.mechanical }, repairPagesBefore: pb, repairPagesAfter: pa, addedByJev: added, jevFindings: after.findings.filter(x => x.sources.includes('jev')).map(f => ({ pageNumber: f.pageNumber, line: f.line, sources: f.sources })) });
  }
  await pool.end();
  if (out) fs.writeFileSync(out, JSON.stringify(report, null, 1));
})().catch(e => { console.error(e); process.exit(1); });
