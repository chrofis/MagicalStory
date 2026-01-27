/**
 * Fetch Story Data for Analysis
 *
 * Extracts story generation data including:
 * - Cost breakdown by function and model
 * - Generation timing by stage
 * - Story idea draft/review/final stages
 * - Scene descriptions per page
 * - Image evaluation data with quality scores
 * - Job checkpoints
 *
 * Usage:
 *   node fetch-story-data.js <storyId>           Fetch single story
 *   node fetch-story-data.js --last              Fetch most recent story
 *   node fetch-story-data.js --page <N>          Show page N of last story
 *   node fetch-story-data.js --page <id> <N>     Show page N of specific story
 *   node fetch-story-data.js --recent 10         Fetch N recent stories
 *   node fetch-story-data.js --list              List recent stories
 */

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Connect to Railway database
const pool = new Pool({
  connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/**
 * Parse raw LLM response to extract [DRAFT_1], [REVIEW_1], [FINAL_1], etc.
 */
function parseStoryIdeasResponse(rawResponse) {
  if (!rawResponse) return null;

  const sections = {};

  // Extract each section using regex
  const patterns = [
    { key: 'draft1', regex: /\[DRAFT_1\]\s*([\s\S]*?)(?=\[REVIEW_1\]|\[FINAL_1\]|$)/i },
    { key: 'review1', regex: /\[REVIEW_1\]\s*([\s\S]*?)(?=\[FINAL_1\]|$)/i },
    { key: 'final1', regex: /\[FINAL_1\]\s*([\s\S]*?)(?=\n---|\[DRAFT_2\]|\[REVIEW_2\]|\[FINAL_2\]|##\s*STORY\s*2|$)/i },
    { key: 'draft2', regex: /\[DRAFT_2\]\s*([\s\S]*?)(?=\[REVIEW_2\]|\[FINAL_2\]|$)/i },
    { key: 'review2', regex: /\[REVIEW_2\]\s*([\s\S]*?)(?=\[FINAL_2\]|$)/i },
    { key: 'final2', regex: /\[FINAL_2\]\s*([\s\S]*?)$/i },
  ];

  for (const { key, regex } of patterns) {
    const match = rawResponse.match(regex);
    if (match) {
      sections[key] = match[1].trim();
    }
  }

  return Object.keys(sections).length > 0 ? sections : null;
}

/**
 * Extract cost and timing data from generationLog
 */
function extractCostAndTiming(generationLog) {
  if (!generationLog || !Array.isArray(generationLog)) return null;

  const costs = [];
  let totalCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let stageTiming = null;

  for (const entry of generationLog) {
    if (entry.event === 'api_usage' && entry.details) {
      const d = entry.details;
      costs.push({
        function: d.function,
        model: d.model,
        inputTokens: d.inputTokens || 0,
        outputTokens: d.outputTokens || 0,
        thinkingTokens: d.thinkingTokens || 0,
        cost: d.estimatedCost || 0
      });
      totalCost += d.estimatedCost || 0;
      totalInputTokens += d.inputTokens || 0;
      totalOutputTokens += d.outputTokens || 0;
    }

    if (entry.event === 'timing_summary' && entry.details?.stageTiming) {
      stageTiming = entry.details.stageTiming;
    }
  }

  // Group costs by function
  const byFunction = {};
  for (const c of costs) {
    if (!byFunction[c.function]) {
      byFunction[c.function] = { calls: 0, cost: 0, inputTokens: 0, outputTokens: 0, model: c.model };
    }
    byFunction[c.function].calls++;
    byFunction[c.function].cost += c.cost;
    byFunction[c.function].inputTokens += c.inputTokens;
    byFunction[c.function].outputTokens += c.outputTokens;
  }

  return {
    totalCost,
    totalInputTokens,
    totalOutputTokens,
    byFunction,
    stageTiming,
    rawCosts: costs
  };
}

/**
 * Extract scene description data per page
 */
function extractSceneData(storyData) {
  const scenes = [];

  // Get scene descriptions
  const sceneDescs = storyData.sceneDescriptions || [];
  const sceneImages = storyData.sceneImages || [];

  for (const desc of sceneDescs) {
    const pageNum = desc.pageNumber;
    const image = sceneImages.find(img => img.pageNumber === pageNum);

    let parsedDescription = null;
    if (desc.description) {
      try {
        parsedDescription = typeof desc.description === 'string'
          ? JSON.parse(desc.description)
          : desc.description;
      } catch {
        parsedDescription = null;
      }
    }

    scenes.push({
      pageNumber: pageNum,
      // Outline hint (brief scene from outline)
      outlineHint: desc.outlineExtract || image?.outlineExtract || null,
      // Translated summary (what user sees)
      translatedSummary: desc.translatedSummary || null,
      // Image summary (English, for image generation)
      imageSummary: desc.imageSummary || parsedDescription?.draft?.imageSummary || null,
      // Full description (may contain draft with setting, figures, objects)
      setting: parsedDescription?.draft?.setting || null,
      figures: parsedDescription?.draft?.figures || parsedDescription?.figures || null,
      objects: parsedDescription?.draft?.objects || null,
      // Character clothing for this page
      characterClothing: desc.characterClothing || image?.sceneCharacterClothing || null,
      // Model used
      textModelId: desc.textModelId || null,
      // Raw description length
      descriptionLength: typeof desc.description === 'string' ? desc.description.length : JSON.stringify(desc.description || '').length
    });
  }

  return scenes;
}

/**
 * Fetch analysis data for a single story
 */
async function fetchStoryAnalysis(storyId) {
  // Get story data
  const storyResult = await pool.query(
    'SELECT id, user_id, data, metadata, created_at FROM stories WHERE id = $1',
    [storyId]
  );

  if (storyResult.rows.length === 0) {
    throw new Error(`Story not found: ${storyId}`);
  }

  const story = storyResult.rows[0];
  const storyData = typeof story.data === 'string' ? JSON.parse(story.data) : story.data;

  // Get job data (includes ideaGeneration with rawResponse)
  const jobResult = await pool.query(
    `SELECT id, input_data, result_data, created_at, completed_at
     FROM story_jobs
     WHERE result_data->>'storyId' = $1
     ORDER BY created_at DESC LIMIT 1`,
    [storyId]
  );

  let jobData = null;
  let ideaGeneration = null;
  let parsedIdeas = null;

  if (jobResult.rows.length > 0) {
    const job = jobResult.rows[0];
    jobData = {
      jobId: job.id,
      createdAt: job.created_at,
      completedAt: job.completed_at,
      inputData: typeof job.input_data === 'string' ? JSON.parse(job.input_data) : job.input_data
    };

    ideaGeneration = jobData.inputData?.ideaGeneration;

    // Parse raw response if available
    if (ideaGeneration?.rawResponse) {
      parsedIdeas = parseStoryIdeasResponse(ideaGeneration.rawResponse);
    }
  }

  // Get checkpoints
  const checkpointResult = await pool.query(
    `SELECT step_name, step_index, step_data, created_at
     FROM story_job_checkpoints
     WHERE job_id = $1
     ORDER BY created_at ASC`,
    [jobData?.jobId]
  );

  // Extract evaluation data from scenes
  const evaluations = storyData.sceneImages?.map(img => ({
    pageNumber: img.pageNumber,
    qualityScore: img.qualityScore || img.evaluation?.qualityScore,
    fixTargets: img.evaluation?.fixTargets || [],
    repairHistory: img.repairHistory || [],
    retryHistory: img.retryHistory || [],
    totalAttempts: img.totalAttempts || 1,
    wasRegenerated: img.wasRegenerated || false,
    wasAutoRepaired: img.wasAutoRepaired || false
  })) || [];

  // Extract cost and timing from generationLog
  const costAndTiming = extractCostAndTiming(storyData.generationLog);

  // Extract scene data
  const sceneData = extractSceneData(storyData);

  return {
    storyId,
    title: storyData.title,
    language: storyData.language,
    artStyle: storyData.artStyle,
    pages: storyData.sceneImages?.length || 0,
    createdAt: story.created_at,

    // Cost and timing
    cost: costAndTiming,

    // Idea generation with all stages
    ideaGeneration: ideaGeneration ? {
      input: {
        characters: ideaGeneration.input?.characters?.map(c => c.name) || [],
        storyCategory: ideaGeneration.input?.storyCategory,
        storyTopic: ideaGeneration.input?.storyTopic,
        storyTheme: ideaGeneration.input?.storyTheme,
        pages: ideaGeneration.input?.pages,
        language: ideaGeneration.input?.language
      },
      model: ideaGeneration.model,
      selectedIndex: ideaGeneration.selectedIndex,
      parsedFinals: ideaGeneration.output,  // The [FINAL] sections only
      rawResponse: ideaGeneration.rawResponse,  // Full LLM response
      parsedStages: parsedIdeas  // Extracted draft/review/final
    } : null,

    // Scene descriptions per page
    scenes: sceneData,

    // Image evaluations
    evaluations,

    // Job checkpoints
    checkpoints: checkpointResult.rows.map(cp => ({
      stepName: cp.step_name,
      stepIndex: cp.step_index,
      createdAt: cp.created_at,
      data: typeof cp.step_data === 'string' ? JSON.parse(cp.step_data) : cp.step_data
    }))
  };
}

/**
 * List recent stories
 */
async function listRecentStories(limit = 20) {
  const result = await pool.query(`
    SELECT s.id, s.metadata->>'title' as title, s.created_at, sj.id as job_id,
           sj.input_data->'ideaGeneration'->>'rawResponse' IS NOT NULL as has_raw_response
    FROM stories s
    LEFT JOIN story_jobs sj ON sj.result_data->>'storyId' = s.id
    ORDER BY s.created_at DESC
    LIMIT $1
  `, [limit]);

  return result.rows;
}

/**
 * Get the most recent story ID
 */
async function getLastStoryId() {
  const result = await pool.query(`
    SELECT id FROM stories ORDER BY created_at DESC LIMIT 1
  `);
  return result.rows[0]?.id;
}

/**
 * Fetch a specific page from a story
 */
async function fetchPageDetails(storyId, pageNumber) {
  const storyResult = await pool.query(
    'SELECT data FROM stories WHERE id = $1',
    [storyId]
  );

  if (storyResult.rows.length === 0) {
    throw new Error(`Story not found: ${storyId}`);
  }

  const storyData = storyResult.rows[0].data;
  const page = storyData.sceneImages?.find(s => s.pageNumber === pageNumber);

  if (!page) {
    throw new Error(`Page ${pageNumber} not found in story. Available pages: ${storyData.sceneImages?.map(s => s.pageNumber).join(', ')}`);
  }

  return {
    storyId,
    title: storyData.title,
    pageNumber,
    text: page.text,
    outlineExtract: page.outlineExtract,
    description: page.description,
    sceneCharacters: page.sceneCharacters?.map(c => c.name) || [],
    sceneCharacterClothing: page.sceneCharacterClothing,
    qualityScore: page.qualityScore,
    qualityReasoning: page.qualityReasoning,
    totalAttempts: page.totalAttempts,
    wasRegenerated: page.wasRegenerated,
    retryHistory: page.retryHistory?.length || 0,
    repairHistory: page.repairHistory?.length || 0
  };
}

/**
 * Format milliseconds to human-readable duration
 */
function formatDuration(ms) {
  if (!ms) return 'N/A';
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs}s`;
}

/**
 * Print page details in a readable format
 */
function printPageDetails(page) {
  console.log('\n' + '='.repeat(80));
  console.log(`${page.title || '(no title)'}`);
  console.log(`   Story ID: ${page.storyId}`);
  console.log('='.repeat(80));

  console.log(`\nPAGE ${page.pageNumber}`);
  console.log('-'.repeat(40));

  console.log('\nTEXT:');
  console.log(page.text || '(no text)');

  console.log('\nOUTLINE EXTRACT:');
  console.log(page.outlineExtract || '(none)');

  console.log('\nCHARACTERS:', page.sceneCharacters.join(', ') || '(none)');

  if (page.sceneCharacterClothing) {
    console.log('CLOTHING:', JSON.stringify(page.sceneCharacterClothing));
  }

  console.log('\nSCENE DESCRIPTION:');
  if (page.description) {
    // Try to parse if it's JSON
    try {
      const desc = typeof page.description === 'string' ? JSON.parse(page.description) : page.description;
      if (desc.draft?.imageSummary) {
        console.log('   Summary:', desc.draft.imageSummary);
      }
      if (desc.draft?.setting) {
        console.log('   Setting:', desc.draft.setting.location, '-', desc.draft.setting.description);
      }
    } catch {
      console.log(page.description.substring(0, 500) + (page.description.length > 500 ? '...' : ''));
    }
  } else {
    console.log('(none)');
  }

  console.log('\nQUALITY:');
  console.log(`   Score: ${page.qualityScore || 'N/A'}`);
  console.log(`   Attempts: ${page.totalAttempts || 1}`);
  console.log(`   Regenerated: ${page.wasRegenerated ? 'Yes' : 'No'}`);
  console.log(`   Retry history: ${page.retryHistory} entries`);
  console.log(`   Repair history: ${page.repairHistory} entries`);
}

/**
 * Print full story analysis summary
 */
function printAnalysisSummary(analysis) {
  console.log('\n' + '='.repeat(80));
  console.log(`Story: ${analysis.title || '(no title)'}`);
  console.log(`ID: ${analysis.storyId}`);
  console.log(`Created: ${analysis.createdAt}`);
  console.log(`Language: ${analysis.language || 'N/A'} | Art: ${analysis.artStyle || 'N/A'} | Pages: ${analysis.pages}`);
  console.log('='.repeat(80));

  // === COST BREAKDOWN ===
  if (analysis.cost) {
    console.log('\nCOST BREAKDOWN');
    console.log('-'.repeat(60));
    console.log(`   Total: $${analysis.cost.totalCost.toFixed(4)}`);
    console.log(`   Tokens: ${analysis.cost.totalInputTokens.toLocaleString()} in / ${analysis.cost.totalOutputTokens.toLocaleString()} out`);

    if (Object.keys(analysis.cost.byFunction).length > 0) {
      console.log('\n   By Function:');
      const sorted = Object.entries(analysis.cost.byFunction)
        .sort((a, b) => b[1].cost - a[1].cost);
      for (const [func, data] of sorted) {
        console.log(`   - ${func}: $${data.cost.toFixed(4)} (${data.calls} calls) [${data.model}]`);
        console.log(`     ${data.inputTokens.toLocaleString()} in / ${data.outputTokens.toLocaleString()} out`);
      }
    }
  }

  // === TIMING ===
  if (analysis.cost?.stageTiming) {
    console.log('\nTIMING');
    console.log('-'.repeat(60));
    const totalMs = Object.values(analysis.cost.stageTiming).reduce((sum, ms) => sum + ms, 0);
    console.log(`   Total: ${formatDuration(totalMs)}`);
    for (const [stage, ms] of Object.entries(analysis.cost.stageTiming)) {
      const pct = totalMs > 0 ? Math.round(ms / totalMs * 100) : 0;
      console.log(`   - ${stage}: ${formatDuration(ms)} (${pct}%)`);
    }
  }

  // === IDEA GENERATION ===
  if (analysis.ideaGeneration) {
    console.log('\nIDEA GENERATION');
    console.log('-'.repeat(60));
    console.log(`   Model: ${analysis.ideaGeneration.model}`);
    console.log(`   Selected: Idea ${analysis.ideaGeneration.selectedIndex !== null ? analysis.ideaGeneration.selectedIndex + 1 : 'custom'}`);
    console.log(`   Has raw response: ${analysis.ideaGeneration.rawResponse ? 'YES' : 'NO'}`);

    if (analysis.ideaGeneration.parsedStages) {
      const stages = analysis.ideaGeneration.parsedStages;
      console.log('\n   Draft -> Review -> Final (Idea 1):');
      if (stages.draft1) console.log(`     [DRAFT_1]  ${stages.draft1.slice(0, 120)}...`);
      if (stages.review1) console.log(`     [REVIEW_1] ${stages.review1.slice(0, 120)}...`);
      if (stages.final1) console.log(`     [FINAL_1]  ${stages.final1.slice(0, 120)}...`);

      if (stages.draft2) {
        console.log('\n   Draft -> Review -> Final (Idea 2):');
        console.log(`     [DRAFT_2]  ${stages.draft2.slice(0, 120)}...`);
        if (stages.review2) console.log(`     [REVIEW_2] ${stages.review2.slice(0, 120)}...`);
        if (stages.final2) console.log(`     [FINAL_2]  ${stages.final2.slice(0, 120)}...`);
      }

      // Show what changed between draft and final
      if (stages.draft1 && stages.final1 && stages.draft1 !== stages.final1) {
        console.log('\n   Changes (Idea 1): Draft and Final DIFFER');
        console.log(`     Draft length: ${stages.draft1.length} chars`);
        console.log(`     Final length: ${stages.final1.length} chars`);
      } else if (stages.draft1 && stages.final1) {
        console.log('\n   Changes (Idea 1): Draft and Final are IDENTICAL');
      }
    }
  }

  // === SCENE DESCRIPTIONS ===
  if (analysis.scenes && analysis.scenes.length > 0) {
    console.log('\nSCENE DESCRIPTIONS');
    console.log('-'.repeat(60));
    for (const scene of analysis.scenes) {
      console.log(`\n   Page ${scene.pageNumber}:`);
      if (scene.outlineHint) {
        console.log(`     Outline: ${scene.outlineHint.slice(0, 100)}${scene.outlineHint.length > 100 ? '...' : ''}`);
      }
      if (scene.imageSummary) {
        console.log(`     Summary: ${scene.imageSummary.slice(0, 100)}${scene.imageSummary.length > 100 ? '...' : ''}`);
      }
      if (scene.setting) {
        console.log(`     Setting: ${scene.setting.location || ''} - ${scene.setting.description || ''}`);
      }
      if (scene.figures && Array.isArray(scene.figures)) {
        console.log(`     Figures: ${scene.figures.map(f => f.label || f.name || '?').join(', ')}`);
      }
      if (scene.characterClothing) {
        const clothing = Object.entries(scene.characterClothing).map(([name, cat]) => `${name}:${cat}`).join(', ');
        console.log(`     Clothing: ${clothing}`);
      }
      if (scene.textModelId) {
        console.log(`     Model: ${scene.textModelId}`);
      }
    }
  }

  // === IMAGE EVALUATIONS ===
  if (analysis.evaluations.length > 0) {
    console.log('\nIMAGE EVALUATIONS');
    console.log('-'.repeat(60));
    for (const e of analysis.evaluations) {
      const score = e.qualityScore !== undefined ? e.qualityScore.toFixed(1) : 'N/A';
      const fixes = e.fixTargets.length;
      const attempts = e.totalAttempts || 1;
      const flags = [
        e.wasRegenerated ? 'REGEN' : null,
        e.wasAutoRepaired ? 'REPAIRED' : null,
        e.retryHistory.length > 0 ? `${e.retryHistory.length} retries` : null,
      ].filter(Boolean).join(', ');
      console.log(`   Page ${e.pageNumber}: score=${score}${fixes > 0 ? `, fixes=${fixes}` : ''}${attempts > 1 ? `, attempts=${attempts}` : ''}${flags ? ` [${flags}]` : ''}`);
    }
  }

  // === CHECKPOINTS ===
  if (analysis.checkpoints.length > 0) {
    console.log('\nCHECKPOINTS');
    console.log('-'.repeat(60));
    for (const cp of analysis.checkpoints) {
      const dataSize = JSON.stringify(cp.data).length;
      console.log(`   ${cp.stepName}[${cp.stepIndex}] - ${(dataSize / 1024).toFixed(1)}KB (${cp.createdAt ? new Date(cp.createdAt).toISOString().slice(11, 19) : 'N/A'})`);
    }
  }
}

/**
 * Save analysis to file
 */
function saveAnalysis(analysis, outputDir) {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const filename = `${analysis.storyId}_${Date.now()}.json`;
  const filepath = path.join(outputDir, filename);

  fs.writeFileSync(filepath, JSON.stringify(analysis, null, 2));
  return filepath;
}

// Main execution
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage:');
    console.log('  node fetch-story-data.js <storyId>           Fetch single story');
    console.log('  node fetch-story-data.js --last              Fetch most recent story');
    console.log('  node fetch-story-data.js --page <N>          Show page N of last story');
    console.log('  node fetch-story-data.js --page <id> <N>     Show page N of specific story');
    console.log('  node fetch-story-data.js --recent 10         Fetch N recent stories');
    console.log('  node fetch-story-data.js --list              List recent stories');
    process.exit(1);
  }

  try {
    // Test connection
    await pool.query('SELECT 1');
    console.log('Database connected');

    // Handle --page command
    if (args[0] === '--page') {
      let storyId, pageNumber;
      if (args.length === 2) {
        // --page <N> - use last story
        storyId = await getLastStoryId();
        pageNumber = parseInt(args[1]);
      } else {
        // --page <id> <N>
        storyId = args[1];
        pageNumber = parseInt(args[2]);
      }

      if (!storyId) throw new Error('No stories found');
      if (isNaN(pageNumber)) throw new Error('Invalid page number');

      const page = await fetchPageDetails(storyId, pageNumber);
      printPageDetails(page);
      return;
    }

    // Handle --last command
    if (args[0] === '--last') {
      const storyId = await getLastStoryId();
      if (!storyId) throw new Error('No stories found');
      args[0] = storyId;  // Fall through to single story handling
    }

    if (args[0] === '--list') {
      const stories = await listRecentStories(20);
      console.log('\nRecent Stories:');
      console.log('-'.repeat(100));
      for (const s of stories) {
        const hasRaw = s.has_raw_response ? 'raw' : '-';
        console.log(`${s.id}  ${s.created_at.toISOString().slice(0, 16)}  [${hasRaw}]  ${s.title || '(no title)'}`);
      }
      return;
    }

    if (args[0] === '--recent') {
      const limit = parseInt(args[1]) || 10;
      const stories = await listRecentStories(limit);

      const outputDir = path.join(__dirname, '../../output/analysis');
      console.log(`\nFetching ${stories.length} recent stories...`);

      for (const s of stories) {
        try {
          const analysis = await fetchStoryAnalysis(s.id);
          const filepath = saveAnalysis(analysis, outputDir);
          const cost = analysis.cost ? `$${analysis.cost.totalCost.toFixed(2)}` : 'N/A';
          console.log(`  ${s.id} [${cost}] -> ${path.basename(filepath)}`);
        } catch (err) {
          console.error(`  ${s.id}: ${err.message}`);
        }
      }
      return;
    }

    // Single story
    const storyId = args[0];
    const analysis = await fetchStoryAnalysis(storyId);

    // Print detailed summary
    printAnalysisSummary(analysis);

    // Save to file
    const outputDir = path.join(__dirname, '../../output/analysis');
    const filepath = saveAnalysis(analysis, outputDir);
    console.log(`\nSaved to: ${filepath}`);

  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
