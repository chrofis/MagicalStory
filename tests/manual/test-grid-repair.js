#!/usr/bin/env node
/**
 * Grid-Based Repair Test Script
 *
 * Tests the grid-based repair pipeline with a story page.
 *
 * Usage:
 *   node tests/manual/test-grid-repair.js <storyId> [pageNumber]
 *
 * Examples:
 *   node tests/manual/test-grid-repair.js job_abc123           # Test all pages
 *   node tests/manual/test-grid-repair.js job_abc123 5         # Test page 5 only
 *   node tests/manual/test-grid-repair.js job_abc123 5 --skip-verify  # Skip verification
 *
 * Output:
 *   output/story-{storyId}/
 *   ├── issues/
 *   │   ├── manifest.json
 *   │   ├── page5/
 *   │   │   ├── original.jpg
 *   │   │   ├── issue_1_face.jpg
 *   │   │   ├── issue_2_hand.jpg
 *   │   │   ├── repaired/
 *   │   │   │   ├── A_issue_1_accepted.jpg
 *   │   │   │   └── B_issue_2_rejected.jpg
 *   │   │   └── comparison.jpg
 *   │   └── grids/
 *   │       ├── batch_1.jpg
 *   │       ├── batch_1_repaired.jpg
 *   │       └── batch_1_manifest.json
 *   └── repair-history.json
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const { gridBasedRepair } = require('../../server/lib/gridBasedRepair');
const { evaluateImageQuality } = require('../../server/lib/images');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const OUTPUT_DIR = path.join(__dirname, '..', '..', 'output');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Load story data from database
 */
async function loadStoryData(storyId) {
  const storyResult = await pool.query('SELECT data FROM stories WHERE id = $1', [storyId]);
  if (storyResult.rows.length === 0) {
    throw new Error(`Story not found: ${storyId}`);
  }
  return storyResult.rows[0].data;
}

/**
 * Load page image from database
 */
async function loadPageImage(storyId, pageNumber) {
  const result = await pool.query(`
    SELECT image_data, quality_score, generated_at
    FROM story_images
    WHERE story_id = $1 AND page_number = $2 AND image_type = 'scene'
    ORDER BY version_index DESC
    LIMIT 1
  `, [storyId, pageNumber]);

  if (result.rows.length === 0) {
    return null;
  }

  return {
    imageData: result.rows[0].image_data,
    qualityScore: result.rows[0].quality_score,
    generatedAt: result.rows[0].generated_at
  };
}

/**
 * Get quality evaluation from story data
 */
function getPageEvaluation(story, pageNumber) {
  const scene = (story.sceneImages || []).find(s => s.pageNumber === pageNumber);
  if (!scene) return null;

  // Try to extract evaluation data from qualityReasoning
  let qualityResult = null;
  if (scene.qualityReasoning) {
    try {
      const reasoning = typeof scene.qualityReasoning === 'string'
        ? JSON.parse(scene.qualityReasoning)
        : scene.qualityReasoning;

      qualityResult = {
        score: scene.qualityScore,
        reasoning,
        fixTargets: reasoning.fixTargets || [],
        // Map fixable_issues to fixTargets format if present
        ...(reasoning.fixable_issues && {
          fixTargets: reasoning.fixable_issues.map(issue => ({
            element: issue.type,
            severity: issue.severity?.toLowerCase() || 'major',
            issue: issue.description,
            fix_instruction: issue.fix,
            bounds: reasoning.matches?.find(m =>
              m.issues?.includes(issue.description.split(' ')[0])
            )?.face_bbox || null
          }))
        })
      };
    } catch (e) {
      console.warn(`  Could not parse qualityReasoning: ${e.message}`);
    }
  }

  return qualityResult;
}

/**
 * Run fresh quality evaluation on a page
 */
async function evaluatePage(imageData, story, pageNumber) {
  const scene = (story.sceneImages || []).find(s => s.pageNumber === pageNumber);
  if (!scene) {
    throw new Error(`No scene found for page ${pageNumber}`);
  }

  // Get character references
  const characterData = story.characters || [];
  const referencePhotos = characterData
    .filter(c => c.avatar)
    .map(c => ({
      name: c.name,
      imageData: c.avatar
    }));

  console.log(`  Running quality evaluation with ${referencePhotos.length} character references...`);

  const result = await evaluateImageQuality(
    imageData,
    scene.sceneDescription || '',
    referencePhotos
  );

  return result;
}

/**
 * Create mock evaluation data for testing
 */
function createMockEvaluation(pageNumber) {
  // Create some fake issues for testing the pipeline
  return {
    quality: {
      score: 6,
      fixTargets: [
        {
          element: 'hand',
          severity: 'major',
          bounds: [0.4, 0.3, 0.55, 0.45],  // [ymin, xmin, ymax, xmax]
          issue: 'Hand has 6 fingers',
          fix_instruction: 'Fix hand to have exactly 5 fingers'
        },
        {
          element: 'face',
          severity: 'major',
          bounds: [0.1, 0.4, 0.3, 0.6],
          issue: 'Face has asymmetrical eyes',
          fix_instruction: 'Make eyes symmetrical and properly aligned'
        }
      ],
      reasoning: {
        identity_sync: []
      }
    },
    incremental: null,
    final: null
  };
}

/**
 * Main test function
 */
async function testGridRepair(storyId, pageNumber = null, options = {}) {
  console.log(`\n🔧 Grid-Based Repair Test`);
  console.log(`   Story: ${storyId}`);
  console.log(`   Page: ${pageNumber || 'all'}`);
  console.log(`   Options: ${JSON.stringify(options)}`);

  // Load story
  const story = await loadStoryData(storyId);
  console.log(`\n📖 Story: ${story.title}`);
  console.log(`   Characters: ${(story.characters || []).map(c => c.name).join(', ')}`);
  console.log(`   Pages: ${(story.sceneImages || []).length}`);

  // Create output directory
  const outputDir = path.join(OUTPUT_DIR, `story-${storyId}`);
  ensureDir(outputDir);
  console.log(`   Output: ${outputDir}`);

  // Determine which pages to process
  const scenes = story.sceneImages || [];
  const pagesToProcess = pageNumber
    ? scenes.filter(s => s.pageNumber === pageNumber)
    : scenes;

  if (pagesToProcess.length === 0) {
    console.error(`\n❌ No pages found to process`);
    return;
  }

  console.log(`\n🔍 Processing ${pagesToProcess.length} page(s)...`);

  const allResults = [];

  for (const scene of pagesToProcess) {
    const pageNum = scene.pageNumber;
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`📄 Page ${pageNum}`);
    console.log(`${'─'.repeat(60)}`);

    // Load image
    const pageData = await loadPageImage(storyId, pageNum);
    if (!pageData) {
      console.log(`   ⚠️  No image found for page ${pageNum}, skipping`);
      continue;
    }

    // Get or create evaluation data
    let evalResults;
    if (options.useMockData) {
      console.log(`   Using mock evaluation data`);
      evalResults = createMockEvaluation(pageNum);
    } else if (options.freshEval) {
      console.log(`   Running fresh evaluation...`);
      const quality = await evaluatePage(pageData.imageData, story, pageNum);
      evalResults = {
        quality,
        incremental: null,
        final: null
      };
    } else {
      // Try to use existing evaluation data
      const existing = getPageEvaluation(story, pageNum);
      if (existing && existing.fixTargets && existing.fixTargets.length > 0) {
        console.log(`   Using existing evaluation (${existing.fixTargets.length} fix targets)`);
        evalResults = {
          quality: existing,
          incremental: null,
          final: null
        };
      } else {
        console.log(`   No existing evaluation with fix targets, running fresh...`);
        const quality = await evaluatePage(pageData.imageData, story, pageNum);
        evalResults = {
          quality,
          incremental: null,
          final: null
        };
      }
    }

    // Log evaluation summary
    const fixTargetCount = evalResults.quality?.fixTargets?.length || 0;
    console.log(`   Quality score: ${evalResults.quality?.score || 'N/A'}`);
    console.log(`   Fix targets: ${fixTargetCount}`);

    if (fixTargetCount === 0) {
      console.log(`   ✓ No issues to fix on this page`);
      allResults.push({
        pageNumber: pageNum,
        status: 'no-issues',
        issueCount: 0
      });
      continue;
    }

    // Run grid-based repair
    try {
      const result = await gridBasedRepair(pageData.imageData, pageNum, evalResults, {
        outputDir,
        storyId,
        skipVerification: options.skipVerify,
        saveIntermediates: true,
        onProgress: (step, message) => {
          // Progress is logged inside gridBasedRepair
        }
      });

      console.log(`\n   Results:`);
      console.log(`   - Issues found: ${result.totalIssues || 0}`);
      console.log(`   - Fixed: ${result.fixedCount || 0}`);
      console.log(`   - Failed: ${result.failedCount || 0}`);
      console.log(`   - Repaired: ${result.repaired ? 'Yes' : 'No'}`);

      if (result.history?.comparisonImage) {
        console.log(`   - Comparison: ${result.history.comparisonImage}`);
      }

      // Save repaired image
      if (result.repaired && result.imageData) {
        const repairedPath = path.join(outputDir, 'issues', `page${pageNum}`, 'repaired_full.jpg');
        fs.writeFileSync(repairedPath, result.imageData);
        console.log(`   - Saved: ${repairedPath}`);
      }

      allResults.push({
        pageNumber: pageNum,
        status: result.repaired ? 'repaired' : 'unchanged',
        issueCount: result.totalIssues,
        fixedCount: result.fixedCount,
        failedCount: result.failedCount
      });

    } catch (err) {
      console.error(`\n   ❌ Error: ${err.message}`);
      allResults.push({
        pageNumber: pageNum,
        status: 'error',
        error: err.message
      });
    }
  }

  // Summary
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`📊 Summary`);
  console.log(`${'═'.repeat(60)}`);

  const repaired = allResults.filter(r => r.status === 'repaired').length;
  const unchanged = allResults.filter(r => r.status === 'unchanged' || r.status === 'no-issues').length;
  const errors = allResults.filter(r => r.status === 'error').length;
  const totalFixed = allResults.reduce((sum, r) => sum + (r.fixedCount || 0), 0);
  const totalFailed = allResults.reduce((sum, r) => sum + (r.failedCount || 0), 0);

  console.log(`   Pages processed: ${allResults.length}`);
  console.log(`   Pages repaired: ${repaired}`);
  console.log(`   Pages unchanged: ${unchanged}`);
  console.log(`   Pages with errors: ${errors}`);
  console.log(`   Total fixes applied: ${totalFixed}`);
  console.log(`   Total fixes failed: ${totalFailed}`);

  // Save full results
  const historyPath = path.join(outputDir, 'repair-history.json');
  fs.writeFileSync(historyPath, JSON.stringify({
    storyId,
    storyTitle: story.title,
    processedAt: new Date().toISOString(),
    options,
    results: allResults
  }, null, 2));
  console.log(`\n✅ Results saved to: ${historyPath}`);

  return allResults;
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help')) {
    console.log(`
Grid-Based Repair Test Script

Usage:
  node tests/manual/test-grid-repair.js <storyId> [pageNumber] [options]

Options:
  --skip-verify    Skip verification step (accept all repairs)
  --fresh-eval     Run fresh quality evaluation instead of using existing
  --mock           Use mock evaluation data for testing
  --help           Show this help

Examples:
  node tests/manual/test-grid-repair.js job_abc123
  node tests/manual/test-grid-repair.js job_abc123 5
  node tests/manual/test-grid-repair.js job_abc123 5 --skip-verify
  node tests/manual/test-grid-repair.js job_abc123 --mock
`);
    process.exit(0);
  }

  const storyId = args[0];
  const pageNumber = args[1] && !args[1].startsWith('--') ? parseInt(args[1], 10) : null;

  const options = {
    skipVerify: args.includes('--skip-verify'),
    freshEval: args.includes('--fresh-eval'),
    useMockData: args.includes('--mock')
  };

  if (!process.env.DATABASE_URL) {
    console.error('Error: DATABASE_URL not set');
    process.exit(1);
  }

  if (!process.env.GEMINI_API_KEY) {
    console.error('Error: GEMINI_API_KEY not set');
    process.exit(1);
  }

  try {
    await testGridRepair(storyId, pageNumber, options);
  } catch (err) {
    console.error(`\n❌ Fatal error: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
