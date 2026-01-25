/**
 * Grid-Based Repair Orchestrator
 *
 * Main entry point for the grid-based repair pipeline:
 * 1. Collect issues from all evaluation paths
 * 2. Extract regions to 256x256 thumbnails
 * 3. Batch into grids
 * 4. Send to Gemini for repair
 * 5. Verify each repair
 * 6. Apply only successful repairs
 */

const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const {
  collectAllIssues,
  deduplicateIssues,
  extractPageIssues,
  saveManifest,
  loadManifest,
  TARGET_REGION_SIZE
} = require('./issueExtractor');

const {
  createIssueGrid,
  batchIssuesForGrids,
  repairGridWithGemini,
  extractRepairedRegions,
  saveGridFiles,
  buildGridRepairPrompt,
  MAX_PER_GRID
} = require('./repairGrid');

const {
  verifyRepairedRegion,
  checkForNewArtifacts,
  applyVerifiedRepairs,
  createComparisonImage
} = require('./repairVerification');

// Default configuration
const DEFAULT_OPTIONS = {
  outputDir: null,             // Required: output directory
  retryFailed: false,          // Retry failed repairs once
  maxRetries: 1,               // Max retry attempts per issue
  skipVerification: false,     // Skip verification (accept all repairs)
  saveIntermediates: true,     // Save grids and comparisons
  onProgress: null             // Progress callback
};

/**
 * Repair history entry
 * @typedef {Object} RepairAttempt
 * @property {number} attemptNumber
 * @property {string} gridPath
 * @property {boolean} verified
 * @property {boolean} accepted
 * @property {string} reason
 * @property {Object} verification
 * @property {string} timestamp
 */

/**
 * Main orchestrator for grid-based repair
 *
 * @param {Buffer|string} imageData - Image buffer or base64 data URL
 * @param {number} pageNum - Page number
 * @param {Object} evalResults - Results from all evaluation paths
 * @param {Object} evalResults.quality - From evaluateImageQuality
 * @param {Object} evalResults.incremental - From evaluateIncrementalConsistency
 * @param {Object} evalResults.final - From runFinalConsistencyChecks
 * @param {Object} options - Configuration options
 * @returns {Promise<{imageData: Buffer, repaired: boolean, history: Object}>}
 */
async function gridBasedRepair(imageData, pageNum, evalResults, options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };

  if (!config.outputDir) {
    throw new Error('outputDir is required for grid-based repair');
  }

  const progress = (step, message) => {
    if (config.onProgress) config.onProgress(step, message);
    console.log(`  [Page ${pageNum}] ${step}: ${message}`);
  };

  // Convert to buffer if needed
  const imageBuffer = Buffer.isBuffer(imageData)
    ? imageData
    : Buffer.from(imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');

  const metadata = await sharp(imageBuffer).metadata();
  const imgDimensions = { width: metadata.width, height: metadata.height };

  // Initialize history
  const history = {
    pageNumber: pageNum,
    startedAt: new Date().toISOString(),
    originalDimensions: imgDimensions,
    steps: [],
    issueCount: 0,
    fixedCount: 0,
    failedCount: 0,
    totalAttempts: 0
  };

  // =========================================================================
  // Step 1: Collect issues from all evaluation paths
  // =========================================================================
  progress('collect', 'Collecting issues from evaluations');

  const rawIssues = collectAllIssues(evalResults, pageNum, imgDimensions);
  history.steps.push({
    step: 'collect',
    timestamp: new Date().toISOString(),
    rawIssueCount: rawIssues.length,
    sources: {
      quality: rawIssues.filter(i => i.source === 'quality').length,
      incremental: rawIssues.filter(i => i.source === 'incremental').length,
      final: rawIssues.filter(i => i.source === 'final').length
    }
  });

  if (rawIssues.length === 0) {
    progress('collect', 'No issues found');
    return {
      imageData: imageBuffer,
      repaired: false,
      noIssues: true,
      history
    };
  }

  // =========================================================================
  // Step 2: Deduplicate overlapping issues
  // =========================================================================
  progress('dedupe', `Deduplicating ${rawIssues.length} issues`);

  const issues = deduplicateIssues(rawIssues);
  history.issueCount = issues.length;
  history.steps.push({
    step: 'dedupe',
    timestamp: new Date().toISOString(),
    beforeCount: rawIssues.length,
    afterCount: issues.length,
    removed: rawIssues.length - issues.length
  });

  progress('dedupe', `${issues.length} unique issues after dedup`);

  // =========================================================================
  // Step 3: Extract issue regions to thumbnails
  // =========================================================================
  progress('extract', `Extracting ${issues.length} regions`);

  const extractedIssues = await extractPageIssues(pageNum, imageBuffer, issues, config.outputDir);
  const extractionSuccesses = extractedIssues.filter(i => i.extraction?.absolutePath).length;

  history.steps.push({
    step: 'extract',
    timestamp: new Date().toISOString(),
    attempted: issues.length,
    succeeded: extractionSuccesses,
    failed: issues.length - extractionSuccesses
  });

  // Filter to only issues with successful extraction
  const extractableIssues = extractedIssues.filter(i => i.extraction?.absolutePath);

  if (extractableIssues.length === 0) {
    progress('extract', 'No extractable issues (missing bounding boxes)');
    return {
      imageData: imageBuffer,
      repaired: false,
      noExtractable: true,
      history
    };
  }

  // =========================================================================
  // Step 4: Batch issues into grids
  // =========================================================================
  progress('batch', `Batching ${extractableIssues.length} issues`);

  const batches = batchIssuesForGrids(extractableIssues, MAX_PER_GRID);

  history.steps.push({
    step: 'batch',
    timestamp: new Date().toISOString(),
    issueCount: extractableIssues.length,
    batchCount: batches.length
  });

  progress('batch', `Created ${batches.length} batch(es)`);

  // =========================================================================
  // Step 5-7: Process each batch (repair → verify → apply)
  // =========================================================================
  let currentImage = imageBuffer;
  let anyRepaired = false;
  const allRepairs = [];
  const allGrids = [];  // Collect grid data for UI display

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    const batchNum = batchIdx + 1;

    progress('grid', `Processing batch ${batchNum}/${batches.length} (${batch.length} issues)`);

    // Create grid
    const { buffer: gridBuffer, manifest, cellPositions } = await createIssueGrid(batch, {
      title: `Page ${pageNum} - Batch ${batchNum}`
    });

    // Build repair prompt for this grid
    const repairPrompt = buildGridRepairPrompt(manifest);

    // Save grid files
    let repairedGridBuffer = null;
    let gridFiles = null;

    // Initialize grid entry for collection (will be updated with repaired buffer)
    const gridEntry = {
      batchNum,
      original: gridBuffer.toString('base64'),
      repaired: null,
      manifest,
      prompt: repairPrompt
    };

    try {
      // Send to Gemini for repair
      progress('repair', `Sending batch ${batchNum} to Gemini`);
      const repairResult = await repairGridWithGemini(gridBuffer, manifest);
      repairedGridBuffer = repairResult.buffer;
      gridEntry.repaired = repairedGridBuffer.toString('base64');
      history.totalAttempts++;

      // Save grid files
      if (config.saveIntermediates) {
        gridFiles = await saveGridFiles(
          gridBuffer,
          repairedGridBuffer,
          manifest,
          config.outputDir,
          batchNum
        );
      }

      // Extract repaired regions
      const repairedRegions = await extractRepairedRegions(repairedGridBuffer, cellPositions);

      // Verify each repair
      progress('verify', `Verifying ${repairedRegions.length} repairs`);

      for (const region of repairedRegions) {
        const issue = batch.find(i => i.id === region.issueId);
        if (!issue) continue;

        // Get original thumbnail for comparison
        const originalPath = issue.extraction.absolutePath;
        const originalBuffer = fs.readFileSync(originalPath);

        let verification;
        if (config.skipVerification) {
          verification = { accepted: true, reason: 'Verification skipped' };
        } else {
          verification = await verifyRepairedRegion(originalBuffer, region.buffer, issue);
        }

        const repair = {
          issueId: issue.id,
          letter: region.letter,
          issue,
          buffer: region.buffer,
          accepted: verification.accepted,
          verification,
          batchIndex: batchNum
        };

        // Record attempt
        issue.repairAttempts.push({
          attemptNumber: issue.repairAttempts.length + 1,
          batchIndex: batchNum,
          verified: !config.skipVerification,
          accepted: verification.accepted,
          reason: verification.reason,
          timestamp: new Date().toISOString()
        });

        if (verification.accepted) {
          issue.repairStatus = 'verified';
          history.fixedCount++;
        } else {
          issue.repairStatus = 'failed';
          history.failedCount++;
        }

        allRepairs.push(repair);
      }

      // Save repaired regions
      if (config.saveIntermediates) {
        const repairedDir = path.join(config.outputDir, 'issues', `page${pageNum}`, 'repaired');
        if (!fs.existsSync(repairedDir)) {
          fs.mkdirSync(repairedDir, { recursive: true });
        }
        for (const region of repairedRegions) {
          const repair = allRepairs.find(r => r.letter === region.letter);
          const status = repair?.accepted ? 'accepted' : 'rejected';
          const filename = `${region.letter}_${region.issueId}_${status}.jpg`;
          fs.writeFileSync(path.join(repairedDir, filename), region.buffer);
        }
      }

    } catch (err) {
      console.error(`  Batch ${batchNum} repair failed: ${err.message}`);
      history.steps.push({
        step: 'repair-error',
        timestamp: new Date().toISOString(),
        batchIndex: batchNum,
        error: err.message
      });

      // Save original grid even on failure
      if (config.saveIntermediates) {
        gridFiles = await saveGridFiles(gridBuffer, null, manifest, config.outputDir, batchNum);
      }
    }

    history.steps.push({
      step: `batch_${batchNum}`,
      timestamp: new Date().toISOString(),
      issueCount: batch.length,
      repairsAttempted: batch.length,
      accepted: allRepairs.filter(r => r.batchIndex === batchNum && r.accepted).length,
      rejected: allRepairs.filter(r => r.batchIndex === batchNum && !r.accepted).length,
      gridFiles: gridFiles ? {
        original: gridFiles.gridPath,
        repaired: gridFiles.repairedPath
      } : null
    });

    // Add grid data for UI display
    allGrids.push(gridEntry);
  }

  // =========================================================================
  // Step 8: Apply verified repairs
  // =========================================================================
  const acceptedRepairs = allRepairs.filter(r => r.accepted);

  if (acceptedRepairs.length > 0) {
    progress('apply', `Applying ${acceptedRepairs.length} verified repairs`);

    currentImage = await applyVerifiedRepairs(currentImage, acceptedRepairs);
    anyRepaired = true;

    history.steps.push({
      step: 'apply',
      timestamp: new Date().toISOString(),
      appliedCount: acceptedRepairs.length
    });

    // Save comparison image
    if (config.saveIntermediates) {
      const comparison = await createComparisonImage(imageBuffer, currentImage, allRepairs);
      const comparisonPath = path.join(config.outputDir, 'issues', `page${pageNum}`, 'comparison.jpg');
      fs.writeFileSync(comparisonPath, comparison);
      history.comparisonImage = comparisonPath;
    }
  }

  // =========================================================================
  // Step 9: Final artifact check (optional)
  // =========================================================================
  if (anyRepaired && !config.skipVerification) {
    progress('artifacts', 'Checking for new artifacts');

    const artifactCheck = await checkForNewArtifacts(currentImage, 'object');

    history.steps.push({
      step: 'final-artifact-check',
      timestamp: new Date().toISOString(),
      hasArtifacts: artifactCheck.hasArtifacts,
      artifacts: artifactCheck.artifacts,
      severity: artifactCheck.severity
    });

    if (artifactCheck.hasArtifacts && artifactCheck.severity === 'critical') {
      console.warn(`  Warning: Critical artifacts detected in final image`);
    }
  }

  // =========================================================================
  // Save manifest
  // =========================================================================
  const manifest = {
    storyId: config.storyId,
    pageNumber: pageNum,
    processedAt: new Date().toISOString(),
    issueCount: history.issueCount,
    fixedCount: history.fixedCount,
    failedCount: history.failedCount,
    issues: extractedIssues.map(i => ({
      id: i.id,
      source: i.source,
      type: i.type,
      severity: i.severity,
      description: i.description,
      repairStatus: i.repairStatus,
      attempts: i.repairAttempts.length
    }))
  };

  saveManifest(config.outputDir, manifest);
  history.completedAt = new Date().toISOString();

  progress('done', `Fixed ${history.fixedCount}/${history.issueCount} issues`);

  return {
    imageData: currentImage,
    repaired: anyRepaired,
    history,
    fixedCount: history.fixedCount,
    failedCount: history.failedCount,
    totalIssues: history.issueCount,
    // Grid images for UI display (base64 encoded)
    grids: allGrids.map(g => ({
      batchNum: g.batchNum,
      original: g.original,
      repaired: g.repaired,
      manifest: g.manifest,
      prompt: g.prompt
    }))
  };
}

/**
 * Retry failed repairs with different strategies
 *
 * @param {Object[]} failedRepairs - Repairs that failed verification
 * @param {Object} options - Retry options
 */
async function retryFailedRepairs(failedRepairs, options) {
  // For now, just return empty - future enhancement
  // Could try: different prompts, individual repair, higher quality model
  return [];
}

/**
 * Process multiple pages in parallel or sequential
 *
 * @param {Object[]} pages - Array of {pageNum, imageData, evalResults}
 * @param {Object} options - Processing options
 */
async function processMultiplePages(pages, options = {}) {
  const { parallel = false, ...repairOptions } = options;

  const results = [];

  if (parallel) {
    const promises = pages.map(page =>
      gridBasedRepair(page.imageData, page.pageNum, page.evalResults, repairOptions)
    );
    const settled = await Promise.allSettled(promises);
    for (let i = 0; i < settled.length; i++) {
      if (settled[i].status === 'fulfilled') {
        results.push({ pageNum: pages[i].pageNum, ...settled[i].value });
      } else {
        results.push({ pageNum: pages[i].pageNum, error: settled[i].reason.message });
      }
    }
  } else {
    for (const page of pages) {
      try {
        const result = await gridBasedRepair(page.imageData, page.pageNum, page.evalResults, repairOptions);
        results.push({ pageNum: page.pageNum, ...result });
      } catch (err) {
        results.push({ pageNum: page.pageNum, error: err.message });
      }
    }
  }

  return results;
}

module.exports = {
  gridBasedRepair,
  retryFailedRepairs,
  processMultiplePages,
  DEFAULT_OPTIONS
};
