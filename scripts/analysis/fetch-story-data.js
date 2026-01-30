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
 * Parse raw LLM response to extract [DRAFT], [REVIEW], [FINAL] per story idea.
 * Handles both formats:
 *   - "=== STORY 1 ===" with [DRAFT]/[REVIEW]/[FINAL] (no number suffix)
 *   - [DRAFT_1]/[REVIEW_1]/[FINAL_1] (numbered suffix)
 */
function parseStoryIdeasResponse(rawResponse) {
  if (!rawResponse) return null;

  const result = { stories: [] };

  // Try per-story format first: "=== STORY N ==="
  const storyBlocks = rawResponse.split(/===\s*STORY\s*(\d+)\s*===/i);
  if (storyBlocks.length > 1) {
    // storyBlocks = ['', '1', 'content1', '2', 'content2', ...]
    for (let i = 1; i < storyBlocks.length; i += 2) {
      const storyNum = parseInt(storyBlocks[i]);
      const content = storyBlocks[i + 1] || '';
      const story = parseIdeaSections(content);
      story.storyNum = storyNum;
      result.stories.push(story);
    }
  } else {
    // Try numbered format: [DRAFT_1], [REVIEW_1], [FINAL_1]
    const story1 = {};
    const patterns = [
      { key: 'draft', regex: /\[DRAFT_1\]\s*([\s\S]*?)(?=\[REVIEW_1\]|\[FINAL_1\]|$)/i },
      { key: 'review', regex: /\[REVIEW_1\]\s*([\s\S]*?)(?=\[FINAL_1\]|$)/i },
      { key: 'final', regex: /\[FINAL_1\]\s*([\s\S]*?)(?=\[DRAFT_2\]|\[REVIEW_2\]|\[FINAL_2\]|$)/i },
    ];
    for (const { key, regex } of patterns) {
      const match = rawResponse.match(regex);
      if (match) story1[key] = match[1].trim();
    }
    if (Object.keys(story1).length > 0) {
      story1.storyNum = 1;
      result.stories.push(story1);
    }

    const story2 = {};
    const patterns2 = [
      { key: 'draft', regex: /\[DRAFT_2\]\s*([\s\S]*?)(?=\[REVIEW_2\]|\[FINAL_2\]|$)/i },
      { key: 'review', regex: /\[REVIEW_2\]\s*([\s\S]*?)(?=\[FINAL_2\]|$)/i },
      { key: 'final', regex: /\[FINAL_2\]\s*([\s\S]*?)$/i },
    ];
    for (const { key, regex } of patterns2) {
      const match = rawResponse.match(regex);
      if (match) story2[key] = match[1].trim();
    }
    if (Object.keys(story2).length > 0) {
      story2.storyNum = 2;
      result.stories.push(story2);
    }
  }

  return result.stories.length > 0 ? result : null;
}

/**
 * Parse [DRAFT], [REVIEW], [FINAL] from a single story block
 */
function parseIdeaSections(content) {
  const sections = {};
  // Handle both "## [DRAFT]" and "[DRAFT]" formats
  const draftMatch = content.match(/(?:##\s*)?\[DRAFT\]\s*([\s\S]*?)(?=(?:##\s*)?\[REVIEW\]|(?:##\s*)?\[FINAL\]|$)/i);
  const reviewMatch = content.match(/(?:##\s*)?\[REVIEW\]\s*([\s\S]*?)(?=(?:##\s*)?\[FINAL\]|$)/i);
  const finalMatch = content.match(/(?:##\s*)?\[FINAL\]\s*([\s\S]*?)$/i);

  if (draftMatch) sections.draft = draftMatch[1].trim();
  if (reviewMatch) sections.review = reviewMatch[1].trim();
  if (finalMatch) sections.final = finalMatch[1].trim();

  return sections;
}

/**
 * Extract ACTIONS/OUTLINE lines from idea text for comparison
 */
function extractIdeaActions(text) {
  if (!text) return null;
  const actionsMatch = text.match(/ACTIONS[^:]*:\s*([\s\S]*?)(?=\n\s*\n|OUTLINE|$)/i);
  const outlineMatch = text.match(/OUTLINE[^:]*:\s*([\s\S]*?)$/i);
  return {
    actions: actionsMatch ? actionsMatch[1].trim() : null,
    outline: outlineMatch ? outlineMatch[1].trim() : null
  };
}

/**
 * Extract outline sections (STORY DRAFT, CRITICAL ANALYSIS, STORY PAGES) from unified outline
 */
function extractOutlineSections(outline) {
  if (!outline) return null;

  const result = {};

  // Extract named sections
  const sectionRegex = /---([A-Z\s]+)---/g;
  const positions = [];
  let match;
  while ((match = sectionRegex.exec(outline)) !== null) {
    positions.push({ name: match[1].trim(), start: match.index, headerEnd: match.index + match[0].length });
  }

  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].headerEnd;
    const end = positions[i + 1]?.start || outline.length;
    const content = outline.substring(start, end).trim();
    result[positions[i].name] = content;
  }

  return result;
}

/**
 * Compare story draft text vs final pages text, returning per-page diffs
 */
function compareStoryDraftVsFinal(draftSection, pagesSection) {
  if (!draftSection || !pagesSection) return null;

  // Extract per-page text from draft (**Draft N** = page N)
  const draftPages = {};
  const draftBlocks = draftSection.split(/\*\*Draft (\d+)\*\*/);
  // draftBlocks = ['', '1', 'content1', '2', 'content2', ...]
  for (let i = 1; i < draftBlocks.length; i += 2) {
    const pageNum = parseInt(draftBlocks[i]);
    let text = draftBlocks[i + 1] || '';
    // Remove SCENE HINT blocks and word counts
    text = text
      .replace(/\n\s*\(?\*?\(Word count:.*?\)\*?\)?\s*/g, '\n')
      .replace(/\nSCENE HINT:[\s\S]*?(?=\n\*\*Draft|\n--- Page|$)/g, '')
      .trim();
    draftPages[pageNum] = text;
  }

  // Extract per-page text from final (--- Page N --- TEXT:)
  const finalPages = {};
  const pageRegex = /--- Page (\d+) ---\s*TEXT:\s*([\s\S]*?)(?=SCENE HINT:|--- Page \d|$)/g;
  let pm;
  while ((pm = pageRegex.exec(pagesSection)) !== null) {
    finalPages[parseInt(pm[1])] = pm[2].trim();
  }

  const allPageNums = [...new Set([...Object.keys(draftPages), ...Object.keys(finalPages)])]
    .map(Number).sort((a, b) => a - b);

  const pageComparisons = [];
  let totalChanges = 0;

  for (const pageNum of allPageNums) {
    const draft = draftPages[pageNum] || '';
    const final = finalPages[pageNum] || '';

    if (draft === final) {
      pageComparisons.push({ page: pageNum, identical: true });
      continue;
    }

    // Find paragraph-level differences
    const draftParas = draft.split(/\n\n+/).filter(p => p.trim());
    const finalParas = final.split(/\n\n+/).filter(p => p.trim());
    const changes = [];

    const maxParas = Math.max(draftParas.length, finalParas.length);
    for (let i = 0; i < maxParas; i++) {
      const d = (draftParas[i] || '').trim();
      const f = (finalParas[i] || '').trim();
      if (d !== f && (d || f)) {
        changes.push({ para: i + 1, draft: d, final: f });
      }
    }

    totalChanges += changes.length;
    pageComparisons.push({ page: pageNum, identical: false, changes });
  }

  return {
    pageCount: allPageNums.length,
    totalChanges,
    allIdentical: totalChanges === 0,
    pages: pageComparisons
  };
}

/**
 * Extract text check results from finalChecksReport
 */
function extractTextCheck(finalChecksReport) {
  if (!finalChecksReport?.textCheck) return null;

  const tc = finalChecksReport.textCheck;
  let parsed = null;

  // Parse rawResponse (may be wrapped in markdown fences, may have broken JSON)
  if (tc.rawResponse) {
    try {
      let raw = tc.rawResponse;
      raw = raw.replace(/```json\s*/gi, '').replace(/```\s*/gi, '');
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      }
    } catch {
      // JSON may have unescaped quotes in German text. Try extracting key fields with regex.
      const raw = tc.rawResponse;
      parsed = {
        quality: (raw.match(/"quality"\s*:\s*"([^"]+)"/) || [])[1] || null,
        overallScore: parseInt((raw.match(/"overallScore"\s*:\s*(\d+)/) || [])[1]) || null,
        issues: [],
        summary: (raw.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/s) || [])[1] || null
      };
      // Count issues by finding issue objects
      const issueMatches = raw.match(/"type"\s*:\s*"(\w+)"/g);
      const severityMatches = raw.match(/"severity"\s*:\s*"(\w+)"/g);
      const pageMatches = raw.match(/"page"\s*:\s*(\d+)/g);
      const issueTextMatches = raw.match(/"issue"\s*:\s*"((?:[^"\\]|\\.)*)"/g);
      if (issueMatches) {
        for (let i = 0; i < issueMatches.length; i++) {
          parsed.issues.push({
            type: (issueMatches[i].match(/"(\w+)"$/) || [])[1],
            severity: severityMatches?.[i] ? (severityMatches[i].match(/"(\w+)"$/) || [])[1] : null,
            page: pageMatches?.[i] ? parseInt((pageMatches[i].match(/(\d+)/) || [])[1]) : null,
            issue: issueTextMatches?.[i] ? (issueTextMatches[i].match(/"issue"\s*:\s*"(.*)"/) || [])[1] : null
          });
        }
      }
    }
  }

  return {
    parseError: tc.parseError || false,
    quality: parsed?.quality || null,
    overallScore: parsed?.overallScore || null,
    issues: parsed?.issues || [],
    summary: parsed?.summary || null,
    hasCorrections: !!(parsed?.fullCorrectedText),
    textWasModified: tc.fullOriginalText !== undefined // if original was saved, text might have changed
  };
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
/**
 * Compare two objects and return differences
 */
function diffObjects(draft, output, prefix = '') {
  const diffs = [];
  if (!draft || !output) return diffs;

  const allKeys = new Set([...Object.keys(draft), ...Object.keys(output)]);
  for (const key of allKeys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const dVal = draft[key];
    const oVal = output[key];

    if (dVal === undefined && oVal !== undefined) {
      diffs.push({ path, type: 'added', value: oVal });
    } else if (dVal !== undefined && oVal === undefined) {
      diffs.push({ path, type: 'removed', value: dVal });
    } else if (typeof dVal === 'string' && typeof oVal === 'string' && dVal !== oVal) {
      diffs.push({ path, type: 'changed', draft: dVal, output: oVal });
    } else if (Array.isArray(dVal) && Array.isArray(oVal)) {
      if (JSON.stringify(dVal) !== JSON.stringify(oVal)) {
        diffs.push({ path, type: 'array_changed', draft: dVal, output: oVal });
      }
    } else if (typeof dVal === 'object' && typeof oVal === 'object' && dVal && oVal) {
      diffs.push(...diffObjects(dVal, oVal, path));
    } else if (dVal !== oVal) {
      diffs.push({ path, type: 'changed', draft: dVal, output: oVal });
    }
  }
  return diffs;
}

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

    const draft = parsedDescription?.draft || null;
    const critique = parsedDescription?.critique || null;
    const output = parsedDescription?.output || null;

    // Compare draft vs output to find what changed
    let draftVsOutput = [];
    if (draft && output) {
      draftVsOutput = diffObjects(draft, output);
    }

    scenes.push({
      pageNumber: pageNum,
      // Outline hint (brief scene from outline)
      outlineHint: desc.outlineExtract || image?.outlineExtract || null,
      // Translated summary (what user sees)
      translatedSummary: desc.translatedSummary || null,
      // Image summary from output (final) or draft
      imageSummary: desc.imageSummary || output?.imageSummary || draft?.imageSummary || null,
      // Draft section
      draft: draft ? {
        imageSummary: draft.imageSummary || null,
        setting: draft.setting || null,
        characters: draft.characters || null,
        objects: draft.objects || null
      } : null,
      // Critique section
      critique: critique ? {
        issues: critique.issues || [],
        corrections: critique.corrections || [],
        // Collect failed checks
        failedChecks: Object.entries(critique)
          .filter(([k, v]) => typeof v === 'string' && /fail|issue|incorrect|wrong|missing/i.test(v))
          .map(([k, v]) => ({ check: k, result: v }))
      } : null,
      // Output (final) section
      output: output ? {
        imageSummary: output.imageSummary || null,
        setting: output.setting || null,
        characters: output.characters || null,
        objects: output.objects || null
      } : null,
      // Differences between draft and output
      draftVsOutput,
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

  // Extract outline sections (STORY DRAFT, CRITICAL ANALYSIS, STORY PAGES)
  const outlineSections = extractOutlineSections(storyData.outline);
  const outlineComparison = outlineSections
    ? compareStoryDraftVsFinal(outlineSections['STORY DRAFT'], outlineSections['STORY PAGES'])
    : null;

  // Extract text check
  const textCheck = extractTextCheck(storyData.finalChecksReport);

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
      parsedStages: parsedIdeas  // Extracted draft/review/final per story
    } : null,

    // Outline: STORY DRAFT vs STORY PAGES + CRITICAL ANALYSIS
    outline: {
      sections: outlineSections ? Object.keys(outlineSections).map(k => ({ name: k, length: outlineSections[k].length })) : [],
      criticalAnalysis: outlineSections?.['CRITICAL ANALYSIS'] || null,
      draftVsFinal: outlineComparison
    },

    // Text consistency check
    textCheck,

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
    console.log(`   Selected: Idea ${analysis.ideaGeneration.selectedIndex != null ? analysis.ideaGeneration.selectedIndex + 1 : 'custom'}`);

    if (analysis.ideaGeneration.parsedStages?.stories) {
      for (const story of analysis.ideaGeneration.parsedStages.stories) {
        const isSelected = story.storyNum === (analysis.ideaGeneration.selectedIndex + 1);
        console.log(`\n   Story ${story.storyNum}${isSelected ? ' ← SELECTED' : ''}:`);

        if (story.review) {
          console.log(`     [REVIEW] ${story.review.slice(0, 200)}${story.review.length > 200 ? '...' : ''}`);
        }

        // Compare ACTIONS between draft and final
        const draftActions = extractIdeaActions(story.draft);
        const finalActions = extractIdeaActions(story.final);

        if (draftActions?.actions && finalActions?.actions && draftActions.actions !== finalActions.actions) {
          console.log(`     [ACTIONS CHANGED]:`);
          // Show sentences that differ
          const dSentences = draftActions.actions.split(/\.\s+/).filter(s => s.trim());
          const fSentences = finalActions.actions.split(/\.\s+/).filter(s => s.trim());
          const allSentences = new Set([...dSentences, ...fSentences]);
          for (const s of allSentences) {
            const inDraft = dSentences.some(d => d === s);
            const inFinal = fSentences.some(f => f === s);
            if (!inDraft && inFinal) {
              console.log(`       + ${s.slice(0, 120)}`);
            } else if (inDraft && !inFinal) {
              console.log(`       - ${s.slice(0, 120)}`);
            }
          }
        } else if (draftActions?.actions && finalActions?.actions) {
          console.log(`     [ACTIONS]: Draft and Final IDENTICAL`);
        }
      }
    }
  }

  // === OUTLINE: STORY DRAFT vs FINAL ===
  if (analysis.outline) {
    console.log('\nOUTLINE (Unified Story)');
    console.log('-'.repeat(60));

    // Show sections
    if (analysis.outline.sections.length > 0) {
      console.log('   Sections:');
      for (const s of analysis.outline.sections) {
        console.log(`     ${s.name} (${(s.length / 1024).toFixed(1)}KB)`);
      }
    }

    // Show critical analysis summary
    if (analysis.outline.criticalAnalysis) {
      const ca = analysis.outline.criticalAnalysis;
      console.log('\n   Critical Analysis:');
      // Extract FIXES REQUIRED section
      const fixesMatch = ca.match(/\*\*FIXES REQUIRED:\*\*\s*([\s\S]*?)$/i) || ca.match(/FIXES REQUIRED[:\s]*([\s\S]*?)$/i);
      if (fixesMatch) {
        const fixes = fixesMatch[1].trim().split(/\n-\s*/).filter(s => s.trim());
        for (const fix of fixes) {
          console.log(`     • ${fix.trim().slice(0, 120)}`);
        }
      } else {
        // Show first 300 chars
        console.log(`     ${ca.slice(0, 300)}${ca.length > 300 ? '...' : ''}`);
      }
    }

    // Show draft vs final comparison
    const dvf = analysis.outline.draftVsFinal;
    if (dvf) {
      console.log(`\n   Story Text: Draft vs Final (${dvf.pageCount} pages):`);
      if (dvf.allIdentical) {
        console.log(`     All pages IDENTICAL — no changes from draft to final`);
      } else {
        console.log(`     ${dvf.totalChanges} paragraph(s) changed across pages`);
        for (const pc of dvf.pages) {
          if (pc.identical) continue;
          console.log(`\n     Page ${pc.page} (${pc.changes.length} changes):`);
          for (const ch of pc.changes) {
            if (ch.draft && ch.final) {
              console.log(`       ¶${ch.para}:`);
              console.log(`         draft:  ${ch.draft.slice(0, 120)}`);
              console.log(`         final:  ${ch.final.slice(0, 120)}`);
            } else if (ch.final) {
              console.log(`       ¶${ch.para}: + ${ch.final.slice(0, 120)}`);
            } else {
              console.log(`       ¶${ch.para}: - ${ch.draft.slice(0, 120)}`);
            }
          }
        }
      }
    }
  }

  // === TEXT CHECK ===
  if (analysis.textCheck) {
    console.log('\nTEXT CONSISTENCY CHECK');
    console.log('-'.repeat(60));
    const tc = analysis.textCheck;
    console.log(`   Quality: ${tc.quality || 'N/A'} | Score: ${tc.overallScore || 'N/A'}/10`);
    console.log(`   Parse error: ${tc.parseError ? 'YES' : 'no'} | Text modified: ${tc.hasCorrections ? 'YES' : 'no'}`);

    if (tc.issues.length > 0) {
      // Group by type
      const byType = {};
      for (const issue of tc.issues) {
        const type = issue.type || 'other';
        if (!byType[type]) byType[type] = [];
        byType[type].push(issue);
      }

      console.log(`   Issues (${tc.issues.length}):`);
      for (const [type, issues] of Object.entries(byType)) {
        console.log(`     ${type} (${issues.length}):`);
        for (const issue of issues.slice(0, 5)) {
          const page = issue.page ? `p${issue.page}` : '';
          const sev = issue.severity ? `[${issue.severity}]` : '';
          console.log(`       ${page} ${sev} ${(issue.issue || issue.description || '').slice(0, 100)}`);
          if (issue.originalText && issue.correctedText && issue.originalText !== issue.correctedText) {
            console.log(`         "${issue.originalText.slice(0, 60)}" → "${issue.correctedText.slice(0, 60)}"`);
          }
        }
        if (issues.length > 5) console.log(`       ... and ${issues.length - 5} more`);
      }
    } else {
      console.log(`   No issues found`);
    }

    if (tc.summary) {
      console.log(`   Summary: ${tc.summary.slice(0, 200)}`);
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

      // Show draft setting
      const draftSetting = scene.draft?.setting;
      const outputSetting = scene.output?.setting;
      if (draftSetting) {
        console.log(`     Setting: ${draftSetting.location || ''} - ${draftSetting.description || ''}`);
      }

      // Show characters from draft
      if (scene.draft?.characters && Array.isArray(scene.draft.characters)) {
        const chars = scene.draft.characters.map(c => {
          const name = c.label || c.name || '?';
          const pos = c.position || '';
          return pos ? `${name} (${pos})` : name;
        }).join(', ');
        console.log(`     Characters: ${chars}`);
      }

      if (scene.characterClothing) {
        const clothing = Object.entries(scene.characterClothing).map(([name, cat]) => `${name}:${cat}`).join(', ');
        console.log(`     Clothing: ${clothing}`);
      }

      // Show critique issues and corrections
      if (scene.critique) {
        const issues = scene.critique.issues || [];
        const corrections = scene.critique.corrections || [];
        const failedChecks = scene.critique.failedChecks || [];

        if (issues.length > 0 || corrections.length > 0 || failedChecks.length > 0) {
          console.log(`     Critique:`);
          for (const issue of issues) {
            console.log(`       ⚠ ${typeof issue === 'string' ? issue : JSON.stringify(issue)}`);
          }
          for (const fix of corrections) {
            console.log(`       ✏ ${typeof fix === 'string' ? fix : JSON.stringify(fix)}`);
          }
          for (const fc of failedChecks) {
            console.log(`       ✗ ${fc.check}: ${fc.result.slice(0, 100)}`);
          }
        } else {
          console.log(`     Critique: No issues found`);
        }
      }

      // Show draft vs output differences
      if (scene.draftVsOutput && scene.draftVsOutput.length > 0) {
        console.log(`     Changes (${scene.draftVsOutput.length}):`);
        for (const diff of scene.draftVsOutput) {
          if (diff.type === 'changed') {
            const dStr = typeof diff.draft === 'string' ? diff.draft : JSON.stringify(diff.draft);
            const oStr = typeof diff.output === 'string' ? diff.output : JSON.stringify(diff.output);
            // Truncate long values
            const dShort = dStr.length > 80 ? dStr.slice(0, 80) + '...' : dStr;
            const oShort = oStr.length > 80 ? oStr.slice(0, 80) + '...' : oStr;
            console.log(`       ${diff.path}:`);
            console.log(`         draft:  ${dShort}`);
            console.log(`         output: ${oShort}`);
          } else if (diff.type === 'added') {
            const vStr = typeof diff.value === 'string' ? diff.value : JSON.stringify(diff.value);
            console.log(`       + ${diff.path}: ${vStr.slice(0, 100)}`);
          } else if (diff.type === 'removed') {
            const vStr = typeof diff.value === 'string' ? diff.value : JSON.stringify(diff.value);
            console.log(`       - ${diff.path}: ${vStr.slice(0, 100)}`);
          } else if (diff.type === 'array_changed') {
            console.log(`       ${diff.path}: array changed (${JSON.stringify(diff.draft).length} → ${JSON.stringify(diff.output).length} chars)`);
          }
        }
      } else if (scene.draft && scene.output) {
        console.log(`     Changes: Draft and Output are IDENTICAL`);
      } else if (!scene.draft && !scene.output) {
        console.log(`     (No draft/output structure found)`);
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
