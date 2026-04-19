// Replay the feedback-consolidator for a specific page using stored eval data.
// Shows the EXACT input sent to Haiku and the EXACT output it returned.
//
// Usage: node scripts/analysis/replay-consolidator.js <storyId> <pageNumber>

require('dotenv').config();
const { Pool } = require('pg');
const { buildFeedbackInput, flattenEntityIssues } = require('../../server/lib/feedbackConsolidator');
const { PROMPT_TEMPLATES, loadPromptTemplates } = require('../../server/services/prompts');
const { callTextModel } = require('../../server/lib/textModels');
const { extractJsonFromText, buildCharacterPhysicalDescription } = require('../../server/lib/storyHelpers');

(async () => {
  const storyId = process.argv[2];
  const pageNum = parseInt(process.argv[3], 10);
  if (!storyId || !pageNum) {
    console.error('Usage: node replay-consolidator.js <storyId> <pageNumber>');
    process.exit(1);
  }
  await loadPromptTemplates();
  const pool = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const r = await pool.query('SELECT data FROM stories WHERE id = $1', [storyId]);
  if (!r.rows[0]) { console.error('not found'); process.exit(1); }
  const d = r.rows[0].data || {};
  const scenes = d.sceneImages || [];
  const scene = scenes.find(s => s.pageNumber === pageNum);
  if (!scene) { console.error('page not found'); process.exit(1); }

  // Rebuild eval shape the same way iteratePageCore/round loop does
  const evaluation = {
    fixableIssues: scene.fixableIssues || [],
    semanticResult: scene.semanticResult || {},
    bboxDetection: scene.bboxDetection || {},
    qualityScore: scene.qualityScore,
    semanticScore: scene.semanticScore,
  };

  const fixableIssues = evaluation.fixableIssues;
  const semanticIssues = evaluation.semanticResult?.semanticIssues || evaluation.semanticResult?.issues || [];
  const bboxFigures = evaluation.bboxDetection?.figures || [];
  let entityIssues = flattenEntityIssues(d.finalChecksReport?.entity || null);
  entityIssues = entityIssues.filter(e => !e.pageNumbers || e.pageNumbers.includes(pageNum));

  const characterDescriptions = {};
  for (const c of (d.characters || [])) {
    if (!c?.name) continue;
    let desc = c.physicalDescription || c.description || '';
    if (!desc) { try { desc = buildCharacterPhysicalDescription(c) || ''; } catch {} }
    if (desc) characterDescriptions[c.name] = desc;
  }

  const userInput = buildFeedbackInput({
    sceneDescription: scene.sceneDescription || scene.description || '',
    fixableIssues, semanticIssues, entityIssues, bboxFigures,
    characterDescriptions,
  });

  const template = PROMPT_TEMPLATES.feedbackConsolidator;
  const fullPrompt = `${template}\n\n---\n\n${userInput}`;

  console.log('='.repeat(90));
  console.log(`FULL PROMPT SENT TO HAIKU  —  story ${storyId}  page ${pageNum}`);
  console.log('='.repeat(90));
  console.log(fullPrompt);
  console.log('\n' + '='.repeat(90));
  console.log('CALLING HAIKU...');
  console.log('='.repeat(90));

  // Get the page's imageData (v0) for Haiku to look at
  const imageDataUri = scene.imageVersions?.[0]?.imageData || scene.imageData || null;

  const result = await callTextModel(fullPrompt, 3000, 'claude-haiku', imageDataUri ? { images: [imageDataUri] } : {});

  console.log('\n' + '='.repeat(90));
  console.log('RAW HAIKU RESPONSE');
  console.log('='.repeat(90));
  console.log(result?.text || '(no text)');

  console.log('\n' + '='.repeat(90));
  console.log('PARSED PLAN');
  console.log('='.repeat(90));
  const plan = extractJsonFromText(result.text);
  console.log(JSON.stringify(plan, null, 2));

  console.log('\n' + '='.repeat(90));
  console.log(`USAGE: ${result?.usage?.input_tokens || '?'} in / ${result?.usage?.output_tokens || '?'} out  (model: ${result?.modelId || '?'})`);
  process.exit(0);
})().catch(e => { console.error(e.message, e.stack); process.exit(1); });
