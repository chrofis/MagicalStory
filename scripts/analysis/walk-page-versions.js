// Walk through every saved version of a page interactively. For each version,
// shows the eval that triggered the next redo + the issues that drove it,
// pauses for a comment, and saves all comments to a single Markdown report.
//
// Usage:
//   node scripts/analysis/walk-page-versions.js <storyId> <pageNumber>
//   node scripts/analysis/walk-page-versions.js <storyId> <pageNumber> --no-interactive
//
// At each version prompt:
//   <type your comment>  → saved with that version
//   (empty line)         → skip to next without recording a comment
//   q                    → quit, write whatever comments you've made so far
//
// Output: tests/_reports/<storyId>-page<N>-walkthrough.md

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const versionLabel = (idx) => (idx === 0 ? 'Original (V1)' : `V${idx + 1}`);
const issueLine = (i) => `  - **[${i.severity || '?'}]** ${i.description || i.issue || JSON.stringify(i).slice(0, 200)}`;

function buildVersionBlock(idx, v, rh) {
  const label = versionLabel(idx);
  const tag = v?.type && v.type !== 'original' ? ` (${v.type})` : '';
  const source = rh?.source ? ` [source=${rh.source}]` : '';

  const lines = [];
  lines.push(`## ${label}${tag}${source}`);
  if (v) {
    lines.push('');
    lines.push(`- modelId: \`${v.modelId || '-'}\``);
    lines.push(`- qualityScore: ${v.qualityScore ?? '-'}`);
    lines.push(`- semanticScore: ${v.semanticScore ?? '-'}`);
    lines.push(`- promptLen: ${(v.prompt || '').length}`);
  }

  // Issues that triggered the next redo
  let issues = [];
  let issuesSource = '';
  if (rh?.postRepairEval?.fixableIssues?.length) {
    issues = rh.postRepairEval.fixableIssues;
    issuesSource = 'postRepairEval (eval ran AFTER this version was rendered)';
  } else if (v?.fixableIssues?.length) {
    issues = v.fixableIssues;
    issuesSource = 'version.fixableIssues';
  } else if (v?.qualityReasoning) {
    try {
      const qr = typeof v.qualityReasoning === 'string' ? JSON.parse(v.qualityReasoning) : v.qualityReasoning;
      const xs = qr?.fixable_issues || qr?.fixableIssues || [];
      if (xs.length) {
        issues = xs;
        issuesSource = 'qualityReasoning.fixable_issues';
      } else if (qr?.issues_summary) {
        lines.push('');
        lines.push(`**Issues summary:** ${qr.issues_summary}`);
      }
    } catch { /* not JSON */ }
  }
  if (issues.length > 0) {
    lines.push('');
    lines.push(`**Fixable issues (${issues.length}, from ${issuesSource}):**`);
    lines.push(...issues.map(issueLine));
  } else if (v) {
    lines.push('');
    lines.push('_no fixable issues recorded_');
  }

  // Character-fix specifics
  if (rh?.source?.startsWith('character-fix') || rh?.source?.includes('entity')) {
    const target = rh?.character || rh?.targetCharacter || (rh.source.split(':')[1] || 'all');
    lines.push('');
    lines.push(`**Character/entity repair targeting:** ${target}`);
    if (rh.bbox) lines.push(`- bbox: \`${JSON.stringify(rh.bbox)}\``);
    if (rh.method) lines.push(`- method: ${rh.method}`);
  }

  return { text: lines.join('\n'), issuesCount: issues.length };
}

(async () => {
  const id = process.argv[2];
  const page = parseInt(process.argv[3] || 'NaN', 10);
  const interactive = !process.argv.includes('--no-interactive');
  if (!id || Number.isNaN(page)) {
    console.error('Usage: node scripts/analysis/walk-page-versions.js <storyId> <pageNumber>');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  const r = await pool.query('SELECT data FROM stories WHERE id=$1', [id]);
  if (!r.rows[0]) { console.error('story not found'); process.exit(1); }
  const d = r.rows[0].data;
  const s = (d.sceneImages || []).find(x => x.pageNumber === page);
  if (!s) { console.error(`page ${page} not in sceneImages`); process.exit(1); }

  const versions = s.imageVersions || [];
  const retries = s.retryHistory || [];
  const total = Math.max(versions.length, retries.length);
  if (total === 0) { console.error('no versions for this page'); process.exit(1); }

  const reportDir = path.join('tests', '_reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `${id}-page${page}-walkthrough.md`);

  const blocks = [];
  blocks.push(`# Page ${page} version walkthrough`);
  blocks.push('');
  blocks.push(`Story: \`${id}\``);
  blocks.push(`Generated: ${new Date().toISOString()}`);
  blocks.push(`Final pick (\`bestSource\`): \`${s.bestSource || '-'}\``);
  blocks.push('');

  const rl = interactive
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : null;
  const ask = (q) => new Promise((res) => rl ? rl.question(q, res) : res(''));

  for (let i = 0; i < total; i++) {
    const block = buildVersionBlock(i, versions[i], retries[i]);
    console.log('\n' + '═'.repeat(70));
    console.log(block.text);
    console.log('═'.repeat(70));

    let comment = '';
    if (interactive) {
      console.log('\nYour comment (empty = skip, q = quit & write report):');
      comment = (await ask('> ')).trim();
      if (comment === 'q' || comment === 'Q') {
        blocks.push(block.text);
        if (comment) blocks.push('', '> _quit before commenting_', '');
        break;
      }
    }
    blocks.push(block.text);
    if (comment) {
      blocks.push('');
      blocks.push(`> **Comment:** ${comment}`);
      blocks.push('');
    } else {
      blocks.push('');
    }
  }

  // Append final entity-consistency report (drove later character fixes)
  const ent = d.finalChecksReport?.entity;
  if (ent?.characters) {
    const onPage = [];
    for (const [name, res] of Object.entries(ent.characters)) {
      const charIssues = [];
      if (res.byClothing) for (const cr of Object.values(res.byClothing)) if (cr.issues) charIssues.push(...cr.issues);
      else if (res.issues) charIssues.push(...res.issues);
      for (const it of charIssues) {
        const pages = it.pagesToFix || (it.pageNumber ? [it.pageNumber] : []);
        if (pages.includes(page)) onPage.push({ name, ...it });
      }
    }
    if (onPage.length > 0) {
      blocks.push('## Final entity-consistency report');
      blocks.push('');
      blocks.push('_Drove the V5+ character/entity-repair passes._');
      blocks.push('');
      for (const it of onPage) {
        blocks.push(`- **${it.name}** [${it.severity || '?'}]: ${it.description || it.fixInstruction || ''}`);
      }
      blocks.push('');
    }
  }

  fs.writeFileSync(reportPath, blocks.join('\n'));
  console.log(`\n✅ Wrote walkthrough report: ${reportPath}`);

  if (rl) rl.close();
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
