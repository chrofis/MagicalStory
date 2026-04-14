/**
 * Rebuild the inpaint instruction for a given story page using the current
 * feedback consolidator + name-stripping sanitizer. Prints the exact prompt
 * that would be sent to Grok today.
 *
 * Usage: node tests/manual/rebuild-inpaint-prompt.js <storyId> <pageNum>
 */

require('dotenv').config();

async function main() {
  const storyId = process.argv[2];
  const pageNum = parseInt(process.argv[3], 10);
  if (!storyId || !pageNum) {
    console.error('Usage: node rebuild-inpaint-prompt.js <storyId> <pageNum>');
    process.exit(1);
  }

  const { loadPromptTemplates } = require('../../server/services/prompts');
  await loadPromptTemplates();
  const { consolidateFeedback } = require('../../server/lib/feedbackConsolidator');

  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const { rows } = await pool.query("SELECT data FROM stories WHERE id = $1", [storyId]);
  if (!rows.length) { console.error('Story not found'); process.exit(1); }
  const data = rows[0].data;

  const page = data.sceneImages[pageNum - 1];
  if (!page) { console.error('Page not found'); process.exit(1); }

  // Use the ORIGINAL (pre-repair) evaluation — that's what a fresh repair pass sees.
  const v0 = page.imageVersions?.[0];
  if (!v0) { console.error('No v0 version'); process.exit(1); }

  const evaluation = {
    fixableIssues: v0.fixableIssues || [],
    semanticResult: v0.semanticResult || {},
    bboxDetection: page.bboxDetection || v0.bboxDetection || { figures: [] },
  };

  console.log('Running consolidator with:');
  console.log(`  ${evaluation.fixableIssues.length} fixable issues`);
  console.log(`  ${(evaluation.semanticResult.semanticIssues || evaluation.semanticResult.issues || []).length} semantic issues`);
  console.log(`  ${(evaluation.bboxDetection.figures || []).length} bbox figures`);
  console.log();

  const result = await consolidateFeedback({
    imageDataUri: v0.imageData || null,
    sceneDescription: page.sceneDescription || page.description || '',
    evaluation,
    entityReport: null,
    pageNumber: pageNum,
    characters: data.characters || [],
  });

  if (result.error || !result.plan) {
    console.error('Consolidator failed:', result.error);
    process.exit(1);
  }
  const plan = result.plan;

  // Replicate inpaintPage's name-stripping + prompt assembly
  const characterNames = (data.characters || []).map(c => c?.name).filter(Boolean);
  const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const visualIdByName = new Map();
  for (const pcf of (plan.per_character_fixes || [])) {
    if (pcf?.characterName && pcf?.visual_identifier) {
      visualIdByName.set(pcf.characterName.toLowerCase(), pcf.visual_identifier);
    }
  }
  const stripNames = (text, ownVisualId) => {
    if (!text || characterNames.length === 0) return text;
    let out = text;
    for (const name of characterNames) {
      const vid = visualIdByName.get(name.toLowerCase()) || ownVisualId || 'the character';
      out = out.replace(new RegExp(`\\b${escapeRe(name)}['\u2019]s\\b`, 'g'), `${vid}'s`);
      out = out.replace(new RegExp(`\\b${escapeRe(name)}\\b`, 'g'), vid);
    }
    return out.replace(/\s{2,}/g, ' ').trim();
  };

  const sceneInstr = stripNames(plan.scene_fix?.instruction || '', null);
  const perCharInstrs = (plan.per_character_fixes || [])
    .map(p => {
      const vid = p.visual_identifier || 'this character';
      const fix = stripNames(p.fix_instruction || (p.issues || []).join('; '), vid);
      return `- For ${vid}: ${fix}`;
    });

  const parts = [];
  if (sceneInstr) parts.push(sceneInstr);
  if (perCharInstrs.length > 0) {
    parts.push('Character adjustments:');
    parts.push(...perCharInstrs);
  }
  const editInstruction = parts.join('\n');
  const fullInstruction = `Fix these issues in this children's book illustration:\n${editInstruction}`;

  console.log('='.repeat(78));
  console.log('CONSOLIDATED PLAN (raw Haiku output)');
  console.log('='.repeat(78));
  console.log(JSON.stringify(plan, null, 2));
  console.log();

  console.log('='.repeat(78));
  console.log('DROPPED ISSUES');
  console.log('='.repeat(78));
  for (const d of (plan.dropped_issues || [])) {
    console.log(`- ${d.issue} — ${d.reason}`);
  }
  console.log();

  console.log('='.repeat(78));
  console.log('FINAL INSTRUCTION SENT TO GROK (after name-strip sanitizer)');
  console.log('='.repeat(78));
  console.log(fullInstruction);

  await pool.end();
}

main().catch(e => { console.error('FAIL:', e.message); console.error(e.stack); process.exit(1); });
