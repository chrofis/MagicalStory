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

  // First pass: find all job IDs mentioned in the log
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
          lines: []
        });
      }
      const job = jobsById.get(jobId);
      job.lines.push(line);
      job.endIndex = i;

      // Update timestamps
      const ts = parseTimestamp(line.timestamp);
      if (!job.startTime || ts < job.startTime) job.startTime = ts;
      if (!job.endTime || ts > job.endTime) job.endTime = ts;

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

  // Convert to array and filter to only jobs with meaningful data
  for (const job of jobsById.values()) {
    // Only include jobs with cost data or completion status
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
    const msg = line.message;

    // Title
    const titleMatch = msg.match(/Extracted title.*?:\s*"(.+?)"/);
    if (titleMatch) info.title = titleMatch[1];

    // Story type, language, characters from idea generation
    const ideaMatch = msg.match(/Story type:\s*(.+?),\s*Language:\s*(\S+),\s*Characters:\s*(\d+)/);
    if (ideaMatch) {
      info.storyType = ideaMatch[1];
      info.language = ideaMatch[2];
      info.characters = parseInt(ideaMatch[3]);
    }

    // Language level
    const levelMatch = msg.match(/Language Level:\s*(\S+)/);
    if (levelMatch) info.languageLevel = levelMatch[1];

    // Pages
    const pagesMatch = msg.match(/Scenes to generate:\s*(\d+)/);
    if (pagesMatch) info.pages = parseInt(pagesMatch[1]);

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
    const msg = line.message;

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

function extractIssues(jobLines) {
  const issues = {
    warnings: [],
    errors: [],
    fallbacks: [],
    lowQualityScores: [],
    retries: []
  };

  for (const line of jobLines) {
    const msg = line.message;
    const ts = line.timestamp.substring(11, 19); // HH:MM:SS

    // Skip Flask development server warning
    if (msg.includes('development server') || msg.includes('WSGI server')) continue;

    // Warnings
    if (msg.includes('WARNING') || msg.includes('\u26a0\ufe0f') || line.level === 'wrn') {
      issues.warnings.push({ time: ts, message: msg.substring(0, 150) });
    }

    // Errors
    if (msg.includes('Error') || msg.includes('\u274c') || msg.includes('failed') || line.level === 'err') {
      // Skip checkpoint errors and normal log messages
      if (!msg.includes('checkpoint') && !msg.includes('story-failed')) {
        issues.errors.push({ time: ts, message: msg.substring(0, 150) });
      }
    }

    // Fallbacks
    if (msg.toLowerCase().includes('fallback')) {
      issues.fallbacks.push({ time: ts, message: msg.substring(0, 150) });
    }

    // Low quality scores (< 80)
    const scoreMatch = msg.match(/score:\s*(\d+)/i);
    if (scoreMatch) {
      const score = parseInt(scoreMatch[1]);
      if (score < 80) {
        issues.lowQualityScores.push({ time: ts, score, message: msg.substring(0, 100) });
      }
    }

    // Retries
    if (msg.includes('retry') || msg.includes('Retry') || msg.includes('attempt')) {
      issues.retries.push({ time: ts, message: msg.substring(0, 150) });
    }
  }

  return issues;
}

// ============================================================================
// OUTPUT
// ============================================================================

function printAnalysis(job, storyInfo, costs, issues) {
  const duration = job.endTime ? job.endTime - job.startTime : null;

  console.log('\n' + '='.repeat(70));
  console.log(`STORY RUN ANALYSIS: ${job.id}`);
  console.log('='.repeat(70));

  // Story Info
  console.log('\n\ud83d\udcd6 STORY INFO');
  console.log(`   Title: ${storyInfo.title || '(not found)'}`);
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

  // Issues
  const totalIssues = issues.warnings.length + issues.errors.length +
                      issues.fallbacks.length + issues.lowQualityScores.length;

  console.log(`\n\u26a0\ufe0f  ISSUES (${totalIssues} found)`);

  if (totalIssues === 0) {
    console.log('   (none)');
  } else {
    if (issues.errors.length > 0) {
      console.log(`\n   \u274c Errors (${issues.errors.length}):`);
      issues.errors.slice(0, 5).forEach(e => console.log(`      [${e.time}] ${e.message}`));
      if (issues.errors.length > 5) console.log(`      ... and ${issues.errors.length - 5} more`);
    }

    if (issues.warnings.length > 0) {
      console.log(`\n   \u26a0\ufe0f  Warnings (${issues.warnings.length}):`);
      issues.warnings.slice(0, 5).forEach(w => console.log(`      [${w.time}] ${w.message}`));
      if (issues.warnings.length > 5) console.log(`      ... and ${issues.warnings.length - 5} more`);
    }

    if (issues.fallbacks.length > 0) {
      console.log(`\n   \ud83d\udd04 Fallbacks (${issues.fallbacks.length}):`);
      issues.fallbacks.slice(0, 5).forEach(f => console.log(`      [${f.time}] ${f.message}`));
      if (issues.fallbacks.length > 5) console.log(`      ... and ${issues.fallbacks.length - 5} more`);
    }

    if (issues.lowQualityScores.length > 0) {
      console.log(`\n   \ud83d\udcca Low Quality Scores (${issues.lowQualityScores.length}):`);
      issues.lowQualityScores.forEach(q => console.log(`      [${q.time}] Score: ${q.score}`));
    }
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
  console.log(`\nAnalyzing: ${logPath}`);
  console.log(`File size: ${(fs.statSync(logPath).size / 1024).toFixed(1)} KB`);

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
    printAnalysis(job, storyInfo, costs, issues);
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
