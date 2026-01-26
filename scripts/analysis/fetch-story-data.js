/**
 * Fetch Story Data for Analysis
 *
 * Extracts story generation data including:
 * - Raw LLM responses with draft/review/final stages (story ideas)
 * - Parsed story ideas
 * - Image evaluation data
 * - Job checkpoints
 *
 * Usage:
 *   node scripts/analysis/fetch-story-data.js <storyId>
 *   node scripts/analysis/fetch-story-data.js --recent 10
 *   node scripts/analysis/fetch-story-data.js --list
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
    `SELECT id, input_data, result_data, created_at
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
    qualityReasoning: img.evaluation?.qualityReasoning,
    fixTargets: img.evaluation?.fixTargets || [],
    repairHistory: img.repairHistory || [],
    retryHistory: img.retryHistory || []
  })) || [];

  return {
    storyId,
    title: storyData.title,
    language: storyData.language,
    createdAt: story.created_at,

    // Idea generation with all stages
    ideaGeneration: ideaGeneration ? {
      input: ideaGeneration.input,
      model: ideaGeneration.model,
      selectedIndex: ideaGeneration.selectedIndex,
      parsedFinals: ideaGeneration.output,  // The [FINAL] sections only
      rawResponse: ideaGeneration.rawResponse,  // Full LLM response
      parsedStages: parsedIdeas  // Extracted draft/review/final
    } : null,

    // Image evaluations
    evaluations,

    // Job checkpoints (for other analysis)
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
    console.log('  node fetch-story-data.js <storyId>        Fetch single story');
    console.log('  node fetch-story-data.js --recent 10     Fetch N recent stories');
    console.log('  node fetch-story-data.js --list          List recent stories');
    process.exit(1);
  }

  try {
    // Test connection
    await pool.query('SELECT 1');
    console.log('✓ Database connected');

    if (args[0] === '--list') {
      const stories = await listRecentStories(20);
      console.log('\nRecent Stories:');
      console.log('-'.repeat(100));
      for (const s of stories) {
        const hasRaw = s.has_raw_response ? '✓' : '-';
        console.log(`${s.id}  ${s.created_at.toISOString().slice(0, 16)}  [raw:${hasRaw}]  ${s.title || '(no title)'}`);
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
          const hasStages = analysis.ideaGeneration?.parsedStages ? '✓' : '-';
          console.log(`✓ ${s.id} [stages:${hasStages}] → ${path.basename(filepath)}`);
        } catch (err) {
          console.error(`✗ ${s.id}: ${err.message}`);
        }
      }
      return;
    }

    // Single story
    const storyId = args[0];
    const analysis = await fetchStoryAnalysis(storyId);

    // Print summary
    console.log('\n' + '='.repeat(80));
    console.log(`Story: ${analysis.title || '(no title)'}`);
    console.log(`ID: ${analysis.storyId}`);
    console.log(`Created: ${analysis.createdAt}`);
    console.log('='.repeat(80));

    if (analysis.ideaGeneration) {
      console.log('\n📝 Idea Generation:');
      console.log(`  Model: ${analysis.ideaGeneration.model}`);
      console.log(`  Selected: Idea ${analysis.ideaGeneration.selectedIndex !== null ? analysis.ideaGeneration.selectedIndex + 1 : 'custom'}`);
      console.log(`  Has raw response: ${analysis.ideaGeneration.rawResponse ? 'YES' : 'NO'}`);

      if (analysis.ideaGeneration.parsedStages) {
        console.log('\n  📋 Parsed Stages:');
        const stages = analysis.ideaGeneration.parsedStages;
        if (stages.draft1) console.log(`    [DRAFT_1]: ${stages.draft1.slice(0, 100)}...`);
        if (stages.review1) console.log(`    [REVIEW_1]: ${stages.review1.slice(0, 100)}...`);
        if (stages.final1) console.log(`    [FINAL_1]: ${stages.final1.slice(0, 100)}...`);
        if (stages.draft2) console.log(`    [DRAFT_2]: ${stages.draft2.slice(0, 100)}...`);
        if (stages.review2) console.log(`    [REVIEW_2]: ${stages.review2.slice(0, 100)}...`);
        if (stages.final2) console.log(`    [FINAL_2]: ${stages.final2.slice(0, 100)}...`);
      }
    }

    if (analysis.evaluations.length > 0) {
      console.log('\n🎨 Image Evaluations:');
      for (const e of analysis.evaluations) {
        const score = e.qualityScore !== undefined ? e.qualityScore.toFixed(1) : 'N/A';
        const fixes = e.fixTargets.length;
        console.log(`  Page ${e.pageNumber}: score=${score}, fixes=${fixes}`);
      }
    }

    // Save to file
    const outputDir = path.join(__dirname, '../../output/analysis');
    const filepath = saveAnalysis(analysis, outputDir);
    console.log(`\n💾 Saved to: ${filepath}`);

  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
