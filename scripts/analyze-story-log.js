#!/usr/bin/env node
/**
 * Story Run Log Analyzer
 * Analyzes Railway log files from story generation runs.
 *
 * Usage:
 *   node scripts/analyze-story-log.js                    # Analyze latest log in Downloads
 *   node scripts/analyze-story-log.js path/to/log.log   # Analyze specific log file
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ============================================================================
// HELPERS
// ============================================================================

function getLatestLogFile() {
  const downloadsDir = path.join(os.homedir(), 'Downloads');
  try {
    const files = fs.readdirSync(downloadsDir)
      .filter(f => f.match(/^logs\.\d+\.log$/))
      .map(f => ({
        name: f,
        path: path.join(downloadsDir, f),
        time: fs.statSync(path.join(downloadsDir, f)).mtime
      }))
      .sort((a, b) => b.time - a.time);
    return files[0] ? files[0].path : null;
  } catch (e) {
    return null;
  }
}

function parseTimestamp(ts) {
  // Railway format: 2025-12-27T20:45:52.227147756Z
  return new Date(ts.replace(/\.\d{9}Z$/, 'Z'));
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs}s`;
}

function stripAnsiCodes(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

// ============================================================================
// LOG PARSING
// ============================================================================

function parseLogFile(logPath) {
  const content = fs.readFileSync(logPath, 'utf8');
  const lines = content.split('\n');

  const parsed = [];
  for (const line of lines) {
    // Railway format: timestamp [level] message
    const match = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+\[(inf|err|wrn)\]\s+(.*)$/);
    if (match) {
      parsed.push({
        timestamp: match[1],
        level: match[2],
        message: stripAnsiCodes(match[3]),
        raw: line
      });
    }
  }
  return parsed;
}

// ============================================================================
// JOB EXTRACTION
// ============================================================================

function extractJobs(lines) {
  const jobs = [];
  const jobsById = new Map();

  // First pass: find all job IDs and their start/end indices
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const msg = line.message;

    // Find job IDs in various patterns
    const jobIdMatch = msg.match(/(job_\S+)/);
    if (jobIdMatch) {
      const jobId = jobIdMatch[1];
      if (!jobsById.has(jobId)) {
        jobsById.set(jobId, {
          id: jobId,
          user: null,
          startTime: null,
          endTime: null,
          startIndex: i,
          endIndex: i,
          status: 'unknown',
          lines: [] // Will be populated in second pass
        });
      }
      const job = jobsById.get(jobId);
      job.endIndex = i;

      // Update timestamps
      const ts = parseTimestamp(line.timestamp);
      if (!job.startTime || ts < job.startTime) {
        job.startTime = ts;
        job.startIndex = i;
      }
      if (!job.endTime || ts > job.endTime) {
        job.endTime = ts;
      }

      // Job start patterns
      const createMatch = msg.match(/Creating story job (job_\S+) for user (\S+)/);
      if (createMatch) {
        job.user = createMatch[2];
        job.startTime = ts;
        job.startIndex = i;
      }

      // Starting processing pattern
      const startMatch = msg.match(/Starting processing for job (job_\S+)/);
      if (startMatch) {
        job.startTime = ts;
        job.startIndex = i;
      }

      // Job completion patterns (handle [STORYBOOK], [UNIFIED], or plain)
      const completedMatch = msg.match(/(?:\[(?:STORYBOOK|UNIFIED)\]\s+)?Job (job_\S+) completed successfully/);
      if (completedMatch) {
        job.status = 'completed';
        job.endTime = ts;
        job.endIndex = i;
      }

      // Job failed patterns
      const failedMatch = msg.match(/(?:\[(?:STORYBOOK|UNIFIED)\]\s+)?Job (job_\S+) failed/);
      if (failedMatch) {
        job.status = 'failed';
        job.endTime = ts;
        job.endIndex = i;
      }

      // Extract user from story GET request
      const userMatch = msg.match(/GET \/api\/stories\/job_\S+ - User: (\S+)/);
      if (userMatch && !job.user) {
        job.user = userMatch[1];
      }
    }
  }

  // Second pass: collect ALL lines between start and end index for each job
  for (const job of jobsById.values()) {
    // Collect all lines in the job's time range
    for (let i = job.startIndex; i <= job.endIndex; i++) {
      job.lines.push(lines[i]);
    }

    // Only include jobs with meaningful data
    const hasCostData = job.lines.some(l => l.message.includes('Token usage & cost summary'));
    const hasCompletion = job.status === 'completed' || job.status === 'failed';

    if (hasCostData || hasCompletion || job.lines.length > 50) {
      if (job.status === 'unknown') job.status = 'incomplete';
      jobs.push(job);
    }
  }

  return jobs;
}

// ============================================================================
// DATA EXTRACTION
// ============================================================================

function extractStoryInfo(jobLines) {
  const info = {
    title: null,
    language: null,
    languageLevel: null,
    characters: null,
    pages: null,
    storyType: null
  };

  for (const line of jobLines) {
    // Strip [DEBUG] prefix if present
    const msg = line.message.replace(/^\[DEBUG\]\s*/, '');

    // Title - multiple patterns
    // Pattern 1: "Extracted title: "Title""
    const titleMatch = msg.match(/Extracted title.*?:\s*"(.+?)"/);
    if (titleMatch) info.title = titleMatch[1];

    // Pattern 2: "[UPSERT] Saving story job_XXX for user YYY, title: "Title""
    const upsertTitleMatch = msg.match(/\[UPSERT\].*title:\s*"(.+?)"/);
    if (upsertTitleMatch && !info.title) info.title = upsertTitleMatch[1];

    // Pattern 3: "Returning story metadata: Title (X images to load)"
    const metadataTitleMatch = msg.match(/Returning story metadata:\s*(.+?)\s*\(\d+\s*images/);
    if (metadataTitleMatch && !info.title) info.title = metadataTitleMatch[1];

    // Category/Topic/Language/Pages from job input logs
    // Pattern: "Category: adventure, Topic: ..., Theme: ..., Language: en, Pages: 15"
    const categoryMatch = msg.match(/Category:\s*(\S+),.*Language:\s*(\S+),\s*Pages:\s*(\d+)/);
    if (categoryMatch) {
      info.storyType = categoryMatch[1];
      info.language = categoryMatch[2];
      info.pages = parseInt(categoryMatch[3]);
    }

    // Language from standalone log: "  Language: en"
    const langMatch = msg.match(/^\s*Language:\s*(\S+)\s*$/);
    if (langMatch && !info.language) info.language = langMatch[1];

    // Language from image prompt template: "Using storybook template for language: de-ch"
    const templateLangMatch = msg.match(/template for language:\s*(\S+)/);
    if (templateLangMatch && !info.language) info.language = templateLangMatch[1];

    // Language level: "  Language Level: A1" or "Scene count: 15 (A1)"
    const levelMatch = msg.match(/Language Level:\s*(\S+)/);
    if (levelMatch) info.languageLevel = levelMatch[1];

    const sceneCountLevelMatch = msg.match(/Scene count:\s*\d+\s*\((\w+)\)/);
    if (sceneCountLevelMatch && !info.languageLevel) info.languageLevel = sceneCountLevelMatch[1];

    // Characters count from: "characters count: 2"
    const charsMatch = msg.match(/characters count:\s*(\d+)/);
    if (charsMatch) info.characters = parseInt(charsMatch[1]);

    // Pages from: "Scenes to generate: 15"
    const pagesMatch = msg.match(/Scenes to generate:\s*(\d+)/);
    if (pagesMatch && !info.pages) info.pages = parseInt(pagesMatch[1]);

    // Pages from UNIFIED input: "Input: 15 pages"
    const unifiedPagesMatch = msg.match(/\[UNIFIED\].*Input:\s*(\d+)\s*pages/);
    if (unifiedPagesMatch && !info.pages) info.pages = parseInt(unifiedPagesMatch[1]);

    // Pages from streaming efficiency: "Streaming efficiency: 7/7 pages"
    const streamingPagesMatch = msg.match(/Streaming efficiency:\s*\d+\/(\d+)\s*pages/);
    if (streamingPagesMatch && !info.pages) info.pages = parseInt(streamingPagesMatch[1]);

    // Pages from consistency check: "pages 1-10" or "pages 6-15"
    const consistencyPagesMatch = msg.match(/pages\s+\d+-(\d+)\]/);
    if (consistencyPagesMatch) {
      const maxPage = parseInt(consistencyPagesMatch[1]);
      if (!info.pages || maxPage > info.pages) info.pages = maxPage;
    }

    // Returning full story (backup for title)
    const returnMatch = msg.match(/Returning full story:\s*(.+?)\s+with\s+(\d+)\s+images/);
    if (returnMatch && !info.title) {
      info.title = returnMatch[1];
      info.pages = parseInt(returnMatch[2]);
    }
  }

  return info;
}

function extractCostSummary(jobLines) {
  const costs = {
    byProvider: {},
    byFunction: {},
    totals: {
      inputTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      totalCost: 0
    }
  };

  for (const line of jobLines) {
    // Strip [DEBUG] prefix if present
    const msg = line.message.replace(/^\[DEBUG\]\s*/, '');

    // By function entries: "Outline: 4,107 in / 11,870 out (1 calls) $0.1904 [claude-sonnet-4-5-20250929]"
    // Also handles: "Scene Expand: 105,551 in / 23,349 out (15 calls) $0.6669 [claude-sonnet-4-5-20250929]"
    const functionMatch = msg.match(/^\s*([\w\s]+?):\s+([\d,]+)\s+in\s+\/\s+([\d,]+)\s+out\s+\((\d+)\s+calls?\)\s+\$([\d.]+)\s+\[(.+?)\]/);
    if (functionMatch) {
      const name = functionMatch[1].trim();
      // Skip provider-like entries in BY FUNCTION section
      if (!name.match(/^(Anthropic|Gemini)/i)) {
        costs.byFunction[name] = {
          inputTokens: parseInt(functionMatch[2].replace(/,/g, '')),
          outputTokens: parseInt(functionMatch[3].replace(/,/g, '')),
          calls: parseInt(functionMatch[4]),
          cost: parseFloat(functionMatch[5]),
          model: functionMatch[6]
        };
      }
      continue;
    }

    // Provider entries without calls count: "Anthropic: 116,579 in / 40,362 out $0.9552"
    // Also with thinking: "Gemini Quality: 77,694 in / 26,828 out + 53,243 think $0.0398"
    const providerMatch = msg.match(/^\s*(Anthropic|Gemini\s*\w*):\s+([\d,]+)\s+in\s+\/\s+([\d,]+)\s+out(?:\s+\+\s+([\d,]+)\s+think)?\s+\$([\d.]+)/);
    if (providerMatch) {
      const name = providerMatch[1].trim();
      costs.byProvider[name] = {
        inputTokens: parseInt(providerMatch[2].replace(/,/g, '')),
        outputTokens: parseInt(providerMatch[3].replace(/,/g, '')),
        thinkingTokens: providerMatch[4] ? parseInt(providerMatch[4].replace(/,/g, '')) : 0,
        cost: parseFloat(providerMatch[5])
      };
      continue;
    }

    // Provider entries with calls count: "Anthropic: 98,782 in / 49,377 out (17 calls) $1.0370"
    const providerWithCallsMatch = msg.match(/^\s*(Anthropic|Gemini\s*\w*):\s+([\d,]+)\s+in\s+\/\s+([\d,]+)\s+out(?:\s+\/\s+([\d,]+)\s+think)?\s+\((\d+)\s+calls?\)\s+\$([\d.]+)/);
    if (providerWithCallsMatch) {
      const name = providerWithCallsMatch[1].trim();
      costs.byProvider[name] = {
        inputTokens: parseInt(providerWithCallsMatch[2].replace(/,/g, '')),
        outputTokens: parseInt(providerWithCallsMatch[3].replace(/,/g, '')),
        thinkingTokens: providerWithCallsMatch[4] ? parseInt(providerWithCallsMatch[4].replace(/,/g, '')) : 0,
        calls: parseInt(providerWithCallsMatch[5]),
        cost: parseFloat(providerWithCallsMatch[6])
      };
      continue;
    }

    // Total tokens: "TOTAL: 220,183 input, 77,770 output, 695 thinking tokens"
    const totalTokensMatch = msg.match(/TOTAL:\s+([\d,NaN]+)\s+input,\s+([\d,NaN]+)\s+output/);
    if (totalTokensMatch) {
      const input = totalTokensMatch[1].replace(/,/g, '');
      const output = totalTokensMatch[2].replace(/,/g, '');
      costs.totals.inputTokens = input === 'NaN' ? 0 : parseInt(input);
      costs.totals.outputTokens = output === 'NaN' ? 0 : parseInt(output);
      continue;
    }

    // Total cost: "💰 TOTAL COST: $1.7878"
    const totalCostMatch = msg.match(/TOTAL COST:\s+\$([\d.]+)/);
    if (totalCostMatch) {
      costs.totals.totalCost = parseFloat(totalCostMatch[1]);
    }
  }

  return costs;
}

function extractImageStats(jobLines) {
  const stats = {
    // Image retries (how many pages needed multiple attempts)
    retries: {
      attempt1: 0,  // Success on first try
      attempt2: 0,  // Needed 2nd attempt
      attempt3: 0,  // Needed 3rd attempt
      pages: {}     // Track by page: { 1: 1, 2: 3, ... } (page -> final attempt)
    },
    // Auto-repair
    autoRepair: {
      enabled: null,    // true/false/null if unknown
      skipped: 0,       // Times skipped (disabled)
      executed: 0,      // Times actually run
      inpaintCalls: 0   // Number of inpaint API calls
    },
    // Covers
    covers: {
      generated: false,
      skipped: false,
      skipReason: null,
      count: 0
    },
    // Content blocked retries
    contentBlocked: 0
  };

  for (const line of jobLines) {
    const msg = line.message.replace(/^\[DEBUG\]\s*/, '');

    // Cover images
    if (msg.includes('skipCovers=true') || msg.includes('skipCovers') || msg.includes('No cover images to generate')) {
      stats.covers.skipped = true;
      stats.covers.skipReason = 'disabled';
    }
    if (msg.match(/cover_images:\s*(\d+)\s*calls/)) {
      const match = msg.match(/cover_images:\s*(\d+)\s*calls/);
      stats.covers.count = parseInt(match[1]);
      if (stats.covers.count > 0) {
        stats.covers.generated = true;
      } else {
        // 0 cover calls means covers were skipped
        stats.covers.skipped = true;
        if (!stats.covers.skipReason) stats.covers.skipReason = 'disabled or not requested';
      }
    }
    if (msg.includes('[COVERS]') && msg.includes('Generated')) {
      stats.covers.generated = true;
    }

    // Track current page being processed (from attempt messages)
    // Pattern: "🎨 [QUALITY RETRY] [PAGE 8] Attempt 2/3"
    const attemptStartMatch = msg.match(/\[QUALITY RETRY\]\s+\[PAGE\s+(\d+)\]\s+Attempt\s+(\d+)\/(\d+)/);
    if (attemptStartMatch) {
      const page = parseInt(attemptStartMatch[1]);
      const attempt = parseInt(attemptStartMatch[2]);
      // Track highest attempt for each page
      if (!stats.retries.pages[page] || attempt > stats.retries.pages[page]) {
        stats.retries.pages[page] = attempt;
      }
    }

    // Quality retry success - count totals
    // Pattern: "✅ [QUALITY RETRY] Success on attempt X!"
    const successMatch = msg.match(/\[QUALITY RETRY\].*Success on attempt (\d+)/);
    if (successMatch) {
      const attempt = parseInt(successMatch[1]);
      if (attempt === 1) stats.retries.attempt1++;
      else if (attempt === 2) stats.retries.attempt2++;
      else if (attempt === 3) stats.retries.attempt3++;
    }

    // Auto-repair skipped (disabled)
    if (msg.includes('Auto-repair skipped (disabled)')) {
      stats.autoRepair.skipped++;
      stats.autoRepair.enabled = false;
    }

    // Auto-repair executed (would be something like "[AUTO-REPAIR] Executing..." or inpaint calls)
    if (msg.includes('[AUTO-REPAIR]') && !msg.includes('skipped')) {
      stats.autoRepair.executed++;
      stats.autoRepair.enabled = true;
    }

    // Inpaint calls from cost summary
    const inpaintMatch = msg.match(/inpaint:\s*(\d+)\s*calls/);
    if (inpaintMatch) {
      stats.autoRepair.inpaintCalls = parseInt(inpaintMatch[1]);
      if (stats.autoRepair.inpaintCalls > 0) {
        stats.autoRepair.enabled = true;
        stats.autoRepair.executed = stats.autoRepair.inpaintCalls;
      }
    }

    // Content blocked (PROHIBITED_CONTENT)
    if (msg.includes('PROHIBITED_CONTENT') || msg.includes('Content blocked')) {
      stats.contentBlocked++;
    }
  }

  return stats;
}

function extractIssues(jobLines) {
  const issues = {
    warnings: [],
    errors: [],
    fallbacks: [],
    lowQualityScores: [],
    retries: [],
    runtimeErrors: [],  // JavaScript runtime errors (TypeError, etc.)
    nanIssues: [],       // NaN in calculations
    qualityFindings: []  // CONSISTENCY, TEXT CHECK findings (informational, not errors)
  };

  const seenMessages = new Set(); // For deduplication

  for (const line of jobLines) {
    const msg = line.message;
    const ts = line.timestamp.substring(11, 19); // HH:MM:SS

    // Skip Flask development server warning
    if (msg.includes('development server') || msg.includes('WSGI server')) continue;

    // CONSISTENCY and TEXT CHECK findings are INFORMATIONAL (normal part of generation)
    // They report findings but are not errors or warnings
    if (msg.includes('[CONSISTENCY]') && msg.includes('Found')) {
      const key = `consistency-${ts}`;
      if (!seenMessages.has(key)) {
        seenMessages.add(key);
        issues.qualityFindings.push({ time: ts, type: 'CONSISTENCY', message: msg.substring(0, 200) });
      }
      continue; // Don't also add to warnings/errors
    }
    if (msg.includes('[TEXT CHECK]') && msg.includes('Found')) {
      const key = `textcheck-${ts}`;
      if (!seenMessages.has(key)) {
        seenMessages.add(key);
        issues.qualityFindings.push({ time: ts, type: 'TEXT CHECK', message: msg.substring(0, 200) });
      }
      continue; // Don't also add to warnings/errors
    }

    // Warnings - look for actual warning indicators (but not CONSISTENCY/TEXT CHECK)
    if ((msg.includes('WARNING') || msg.includes('\u26a0\ufe0f') || msg.includes('[WARN]') || line.level === 'wrn') &&
        !msg.includes('development server') && !msg.includes('WSGI') &&
        !msg.includes('[CONSISTENCY]') && !msg.includes('[TEXT CHECK]')) {
      const key = `warn-${msg.substring(0, 50)}`;
      if (!seenMessages.has(key)) {
        seenMessages.add(key);
        issues.warnings.push({ time: ts, message: msg.substring(0, 150) });
      }
    }

    // Errors - look for actual error indicators
    // But DON'T classify as error if it's a WARN-level log (avoid duplicates in warnings + errors)
    const isWarnLevel = msg.includes('[WARN]') || line.level === 'wrn';
    const isError = !isWarnLevel && (
                    msg.includes('Error') || msg.includes('\u274c') || msg.includes('[ERROR]') ||
                    (msg.includes('failed') && !msg.includes('story-failed')) ||
                    (msg.includes('Failed') && !msg.includes('story-failed')) ||
                    line.level === 'err');
    if (isError) {
      // Skip checkpoint errors, email templates, CONSISTENCY/TEXT CHECK, and normal log messages
      if (!msg.includes('checkpoint') && !msg.includes('story-failed') &&
          !msg.includes('email template') && !msg.includes('[CONSISTENCY]') &&
          !msg.includes('[TEXT CHECK]')) {
        const key = `err-${msg.substring(0, 50)}`;
        if (!seenMessages.has(key)) {
          seenMessages.add(key);
          issues.errors.push({ time: ts, message: msg.substring(0, 150) });
        }
      }
    }

    // Fallbacks
    if (msg.toLowerCase().includes('fallback')) {
      const key = `fallback-${msg.substring(0, 50)}`;
      if (!seenMessages.has(key)) {
        seenMessages.add(key);
        issues.fallbacks.push({ time: ts, message: msg.substring(0, 150) });
      }
    }

    // Low quality scores (< 80) - look for quality evaluation score patterns
    // Only match final scores from [QUALITY RETRY] success messages or quality evaluations
    // Pattern: "Attempt X score: 60%" or "Success on attempt X! Score 70%"
    const scoreMatch = msg.match(/(?:Attempt \d+ )?[Ss]core[:\s]+(\d+)%/i);
    if (scoreMatch && (msg.includes('[QUALITY') || msg.includes('Success on attempt'))) {
      const score = parseInt(scoreMatch[1]);
      if (score < 80) {
        // Extract page number if present
        const pageMatch = msg.match(/\[PAGE\s+(\d+)\]/);
        const page = pageMatch ? parseInt(pageMatch[1]) : null;
        // Deduplicate by timestamp and score (same event may be logged with/without page)
        const key = `quality-${ts}-${score}`;
        if (!seenMessages.has(key)) {
          seenMessages.add(key);
          issues.lowQualityScores.push({ time: ts, score, page, message: msg.substring(0, 120) });
        }
      }
    }

    // Runtime errors (JavaScript errors like TypeError, .match is not a function, etc.)
    const runtimeErrorPatterns = [
      /is not a function/i,
      /is not defined/i,
      /cannot read propert/i,
      /cannot set propert/i,
      /TypeError/i,
      /ReferenceError/i,
      /SyntaxError/i,
      /undefined is not/i,
      /null is not/i
    ];
    for (const pattern of runtimeErrorPatterns) {
      if (pattern.test(msg)) {
        const key = `runtime-${msg.substring(0, 50)}`;
        if (!seenMessages.has(key)) {
          seenMessages.add(key);
          issues.runtimeErrors.push({ time: ts, message: msg.substring(0, 200) });
        }
        break;
      }
    }

    // NaN issues in calculations
    if (msg.includes('NaN') && (msg.includes('TOTAL') || msg.includes('token') || msg.includes('cost'))) {
      const key = `nan-${msg.substring(0, 50)}`;
      if (!seenMessages.has(key)) {
        seenMessages.add(key);
        issues.nanIssues.push({ time: ts, message: msg.substring(0, 150) });
      }
    }
  }

  return issues;
}

// ============================================================================
// OUTPUT
// ============================================================================

function printAnalysis(job, storyInfo, costs, issues, imageStats) {
  const duration = job.endTime ? job.endTime - job.startTime : null;

  console.log('\n' + '='.repeat(70));
  // Show story title prominently at the top
  if (storyInfo.title) {
    console.log(`📚 ${storyInfo.title}`);
    console.log('-'.repeat(70));
  }
  console.log(`Job: ${job.id}`);
  console.log('='.repeat(70));

  // Story Info
  console.log('\n\ud83d\udcd6 STORY INFO');
  if (!storyInfo.title) console.log(`   Title: (not found)`);
  console.log(`   Language: ${storyInfo.language || '?'} (${storyInfo.languageLevel || '?'})`);
  console.log(`   Characters: ${storyInfo.characters || '?'}`);
  console.log(`   Pages: ${storyInfo.pages || '?'}`);
  if (storyInfo.storyType) console.log(`   Type: ${storyInfo.storyType}`);

  // Timing
  console.log('\n\u23f1\ufe0f  TIMING');
  console.log(`   Started: ${job.startTime.toISOString().substring(11, 19)}`);
  if (job.endTime) {
    console.log(`   Ended: ${job.endTime.toISOString().substring(11, 19)}`);
    console.log(`   Total Duration: ${formatDuration(duration)}`);
  }

  // Image Generation Stats
  console.log('\n\ud83c\udfa8 IMAGE GENERATION');

  // Covers
  if (imageStats.covers.skipped) {
    console.log(`   Covers: SKIPPED (${imageStats.covers.skipReason || 'disabled'})`);
  } else if (imageStats.covers.generated) {
    console.log(`   Covers: Generated (${imageStats.covers.count} images)`);
  } else {
    console.log(`   Covers: ${imageStats.covers.count > 0 ? 'Generated' : 'Not generated'}`);
  }

  // Image Retries
  const totalImages = imageStats.retries.attempt1 + imageStats.retries.attempt2 + imageStats.retries.attempt3;
  const retriedImages = imageStats.retries.attempt2 + imageStats.retries.attempt3;
  console.log(`   Page Images: ${totalImages} total`);
  console.log(`   - First attempt success: ${imageStats.retries.attempt1}`);
  if (imageStats.retries.attempt2 > 0) {
    console.log(`   - Needed 2nd attempt: ${imageStats.retries.attempt2}`);
  }
  if (imageStats.retries.attempt3 > 0) {
    console.log(`   - Needed 3rd attempt: ${imageStats.retries.attempt3}`);
  }
  if (retriedImages > 0) {
    const retriedPages = Object.entries(imageStats.retries.pages)
      .filter(([_, attempts]) => attempts > 1)
      .map(([page, attempts]) => `p${page}(${attempts} attempts)`)
      .join(', ');
    if (retriedPages) {
      console.log(`   - Retried pages: ${retriedPages}`);
    }
  }

  // Content blocked
  if (imageStats.contentBlocked > 0) {
    console.log(`   Content blocked retries: ${imageStats.contentBlocked}`);
  }

  // Auto-repair
  if (imageStats.autoRepair.enabled === false) {
    console.log(`   Auto-repair: DISABLED (${imageStats.autoRepair.skipped} opportunities skipped)`);
  } else if (imageStats.autoRepair.enabled === true) {
    console.log(`   Auto-repair: ENABLED (${imageStats.autoRepair.executed} repairs, ${imageStats.autoRepair.inpaintCalls} inpaints)`);
  } else {
    console.log(`   Auto-repair: Unknown status`);
  }

  // Costs
  console.log('\n\ud83d\udcb0 COST BREAKDOWN');
  if (Object.keys(costs.byProvider).length > 0) {
    for (const [provider, data] of Object.entries(costs.byProvider)) {
      const tokens = `${data.inputTokens.toLocaleString()} in / ${data.outputTokens.toLocaleString()} out`;
      console.log(`   ${provider.padEnd(20)} $${data.cost.toFixed(2).padStart(5)}  (${tokens})`);
    }
    console.log('   ' + '\u2500'.repeat(45));
    console.log(`   ${'TOTAL'.padEnd(20)} $${costs.totals.totalCost.toFixed(2).padStart(5)}`);
  } else {
    console.log('   (no cost data found)');
  }

  // By Function breakdown
  if (Object.keys(costs.byFunction).length > 0) {
    console.log('\n   By Function:');
    for (const [func, data] of Object.entries(costs.byFunction)) {
      console.log(`   - ${func}: $${data.cost.toFixed(4)} (${data.calls} calls) [${data.model}]`);
    }
  }

  // Issues (real problems)
  const totalIssues = issues.warnings.length + issues.errors.length +
                      issues.fallbacks.length + issues.lowQualityScores.length +
                      issues.runtimeErrors.length + issues.nanIssues.length;

  console.log(`\n⚠️  ISSUES (${totalIssues} found)`);

  if (totalIssues === 0) {
    console.log('   ✅ No issues detected');
  } else {
    if (issues.errors.length > 0) {
      console.log(`\n   ❌ Errors (${issues.errors.length}):`);
      issues.errors.slice(0, 10).forEach(e => console.log(`      [${e.time}] ${e.message}`));
      if (issues.errors.length > 10) console.log(`      ... and ${issues.errors.length - 10} more`);
    }

    if (issues.warnings.length > 0) {
      console.log(`\n   ⚠️  Warnings (${issues.warnings.length}):`);
      issues.warnings.slice(0, 5).forEach(w => console.log(`      [${w.time}] ${w.message}`));
      if (issues.warnings.length > 5) console.log(`      ... and ${issues.warnings.length - 5} more`);
    }

    if (issues.fallbacks.length > 0) {
      console.log(`\n   🔄 Fallbacks (${issues.fallbacks.length}):`);
      issues.fallbacks.slice(0, 5).forEach(f => console.log(`      [${f.time}] ${f.message}`));
      if (issues.fallbacks.length > 5) console.log(`      ... and ${issues.fallbacks.length - 5} more`);
    }

    if (issues.lowQualityScores.length > 0) {
      console.log(`\n   📊 Low Quality Scores (${issues.lowQualityScores.length}):`);
      issues.lowQualityScores.forEach(q => {
        const pageStr = q.page ? ` Page ${q.page}:` : '';
        console.log(`      [${q.time}]${pageStr} Score: ${q.score}%`);
      });
    }

    if (issues.runtimeErrors.length > 0) {
      console.log(`\n   💥 Runtime Errors (${issues.runtimeErrors.length}):`);
      issues.runtimeErrors.forEach(e => console.log(`      [${e.time}] ${e.message}`));
    }

    if (issues.nanIssues.length > 0) {
      console.log(`\n   🔢 NaN Issues (${issues.nanIssues.length}):`);
      issues.nanIssues.forEach(n => console.log(`      [${n.time}] ${n.message}`));
    }
  }

  // Quality Findings (informational - normal part of story generation)
  if (issues.qualityFindings.length > 0) {
    console.log(`\n📋 QUALITY FINDINGS (${issues.qualityFindings.length} - informational)`);
    issues.qualityFindings.forEach(f => {
      console.log(`   [${f.time}] [${f.type}] ${f.message.substring(f.message.indexOf('Found'))}`);
    });
  }

  // Status
  const statusEmoji = job.status === 'completed' ? '\u2705' :
                      job.status === 'failed' ? '\u274c' : '\u23f3';
  console.log(`\n${statusEmoji} STATUS: ${job.status.toUpperCase()}`);
  console.log('='.repeat(70) + '\n');
}

// ============================================================================
// MAIN
// ============================================================================

function analyzeLog(logPath) {
  const stats = fs.statSync(logPath);
  const fileDate = stats.mtime;
  const formattedDate = fileDate.toLocaleDateString('en-US', {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });

  console.log(`\nAnalyzing: ${path.basename(logPath)}`);
  console.log(`File date: ${formattedDate}`);
  console.log(`File size: ${(stats.size / 1024).toFixed(1)} KB`);

  const lines = parseLogFile(logPath);
  console.log(`Total log lines: ${lines.length}`);

  const jobs = extractJobs(lines);
  console.log(`Story jobs found: ${jobs.length}`);

  if (jobs.length === 0) {
    console.log('\nNo story generation jobs found in this log file.');
    return;
  }

  // Analyze each job (most recent first)
  for (const job of jobs.reverse()) {
    const storyInfo = extractStoryInfo(job.lines);
    const costs = extractCostSummary(job.lines);
    const issues = extractIssues(job.lines);
    const imageStats = extractImageStats(job.lines);
    printAnalysis(job, storyInfo, costs, issues, imageStats);
  }
}

// CLI Entry Point
const logFile = process.argv[2] || getLatestLogFile();

if (!logFile) {
  console.error('No log file found. Specify a path or ensure logs.*.log exists in Downloads.');
  process.exit(1);
}

if (!fs.existsSync(logFile)) {
  console.error(`Log file not found: ${logFile}`);
  process.exit(1);
}

analyzeLog(logFile);
