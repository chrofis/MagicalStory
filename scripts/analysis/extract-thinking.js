#!/usr/bin/env node
/**
 * Extract Gemini Thinking Text from Railway Logs
 *
 * Extracts and displays all thinking text from Gemini image generation calls,
 * grouped by page/cover with attempt tracking.
 *
 * Usage:
 *   node scripts/analysis/extract-thinking.js                    # Latest log in Downloads
 *   node scripts/analysis/extract-thinking.js path/to/log.log   # Specific log file
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

function stripAnsiCodes(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function parseTimestampMs(ts) {
  // Railway format: 2026-02-15T21:57:11.088545098Z
  // Extract seconds and nanoseconds for sub-second precision
  const m = ts.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d+)Z/);
  if (!m) return new Date(ts).getTime();
  const baseMs = new Date(m[1] + 'Z').getTime();
  const nanos = m[2].padEnd(9, '0').slice(0, 9);
  const subMs = parseInt(nanos) / 1e6;
  return baseMs + subMs;
}

function parseLogFile(logPath) {
  const content = fs.readFileSync(logPath, 'utf8');
  const rawLines = content.split('\n');

  const lines = [];
  for (const line of rawLines) {
    const match = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+\[(inf|err|wrn)\]\s+(.*)$/);
    if (match) {
      lines.push({
        timestamp: match[1],
        tsMs: parseTimestampMs(match[1]),
        level: match[2],
        message: stripAnsiCodes(match[3].trimEnd()),
        lineNum: lines.length
      });
    }
  }
  return lines;
}

/**
 * Check if a line is a "tagged" log line (has a [CATEGORY] marker or emoji prefix)
 * vs plain thinking text (paragraphs, bold headers, or blank lines).
 */
function isTaggedLine(msg) {
  // Blank or whitespace-only lines are thinking text continuation
  if (msg.trim() === '') return false;

  // Lines with [BRACKET_TAG] patterns are tagged
  if (/^\[DEBUG\]/.test(msg)) return true;
  if (/^\[WARN\]/.test(msg)) return true;

  // Lines starting with known emoji+tag prefixes
  if (/^[✅❌⚠️🖼️📊🧠🗜️⭐🔲📦🎨💾🆕🔐🔍🔧🌍📖📚💳📧🔗🚀📝📍🛡️💰📦]/.test(msg)) return true;

  // Lines with [IMAGE GEN], [QUALITY], [COMPRESSION], [UNIFIED], etc.
  if (/\[(IMAGE GEN|QUALITY|COMPRESSION|UNIFIED|BBOX|IMAGE CACHE|AVATAR|CLOTHING|SCENE META|IMAGE PROMPT|VB-GRID|STYLED|GEN:|STREAM|REF-SHEET|LANDMARK)\]/.test(msg)) return true;

  return false;
}

// ============================================================================
// EXTRACTION
// ============================================================================

function extractThinking(lines) {
  const storyTitle = findStoryTitle(lines);
  const thinkingBlocks = findThinkingBlocks(lines);
  const labeled = labelBlocks(thinkingBlocks, lines);
  return { storyTitle, blocks: labeled };
}

function findStoryTitle(lines) {
  for (const line of lines) {
    const m = line.message.match(/Title detected: "(.+?)"/);
    if (m) return m[1];
    const m2 = line.message.match(/\[UNIFIED-PARSER\] Title: "(.+?)"/);
    if (m2) return m2[1];
    const m3 = line.message.match(/Parsed: title="(.+?)"/);
    if (m3) return m3[1];
  }
  return '(unknown)';
}

function findThinkingBlocks(lines) {
  const blocks = [];

  for (let i = 0; i < lines.length; i++) {
    const msg = lines[i].message;

    // Look for "Full thinking:" marker
    if (!/\[IMAGE GEN\] Full thinking:/.test(msg)) continue;

    const blockTsMs = lines[i].tsMs;

    // Extract token info from nearby Token usage line (within 8 lines in either direction)
    let thinkingTokens = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    // Search backward first
    for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
      const tokenMatch = lines[j].message.match(/\[IMAGE GEN\] Token usage - input: ([\d,]+), output: ([\d,]+), thinking: ([\d,]+)/);
      if (tokenMatch) {
        inputTokens = parseInt(tokenMatch[1].replace(/,/g, ''));
        outputTokens = parseInt(tokenMatch[2].replace(/,/g, ''));
        thinkingTokens = parseInt(tokenMatch[3].replace(/,/g, ''));
        break;
      }
    }
    // If not found backward, search forward
    if (thinkingTokens === 0) {
      for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
        const tokenMatch = lines[j].message.match(/\[IMAGE GEN\] Token usage - input: ([\d,]+), output: ([\d,]+), thinking: ([\d,]+)/);
        if (tokenMatch) {
          inputTokens = parseInt(tokenMatch[1].replace(/,/g, ''));
          outputTokens = parseInt(tokenMatch[2].replace(/,/g, ''));
          thinkingTokens = parseInt(tokenMatch[3].replace(/,/g, ''));
          break;
        }
      }
    }

    // Extract the thinking summary line for the short title (search wider range)
    let summaryTitle = '';
    for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
      const sumMatch = lines[j].message.match(/\[IMAGE GEN\] Thinking \(\d+ chars\): (.+)/);
      if (sumMatch) {
        summaryTitle = sumMatch[1];
        break;
      }
    }
    if (!summaryTitle) {
      for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
        const sumMatch = lines[j].message.match(/\[IMAGE GEN\] Thinking \(\d+ chars\): (.+)/);
        if (sumMatch) {
          summaryTitle = sumMatch[1];
          break;
        }
      }
    }

    // Collect thinking text: lines after "Full thinking:" that are:
    // 1. Not tagged log lines
    // 2. Share close timestamps (within 200ms gap between consecutive untagged lines)
    //
    // The thinking text is logged as one console output, so all lines share
    // very close timestamps (<1ms apart). Lines from other parallel streams
    // have larger timestamp gaps (>100ms typically).
    const textLines = [];
    let lastUntaggedTs = blockTsMs;
    const maxGapMs = 0.5; // max gap (ms) between consecutive untagged lines
    // Thinking text is logged as one console.log() call, so all lines share
    // very close timestamps (<0.02ms apart). Lines from parallel streams
    // have 0.9ms+ gaps. Using 0.5ms cleanly separates them.

    for (let j = i + 1; j < lines.length && j < i + 50; j++) {
      const lineMsg = lines[j].message;
      const lineTsMs = lines[j].tsMs;

      // Stop if we hit another Full thinking marker
      if (/\[IMAGE GEN\] Full thinking:/.test(lineMsg)) break;

      if (isTaggedLine(lineMsg)) {
        // Skip interleaved tagged lines from parallel operations
        continue;
      }

      // Check timestamp gap from the last untagged line we collected
      const gap = lineTsMs - lastUntaggedTs;
      if (gap > maxGapMs && textLines.length > 0) {
        // Large gap means this is likely from a different parallel stream
        break;
      }

      textLines.push(lineMsg);
      lastUntaggedTs = lineTsMs;
    }

    // Trim trailing blank lines
    while (textLines.length > 0 && textLines[textLines.length - 1].trim() === '') {
      textLines.pop();
    }
    // Trim leading blank lines
    while (textLines.length > 0 && textLines[0].trim() === '') {
      textLines.shift();
    }

    const thinkingText = textLines.join('\n');

    blocks.push({
      lineIndex: i,
      timestamp: lines[i].timestamp,
      tsMs: blockTsMs,
      thinkingText,
      thinkingTokens,
      inputTokens,
      outputTokens,
      summaryTitle,
      charCount: thinkingText.length
    });
  }

  return blocks;
}

function labelBlocks(blocks, lines) {
  // For each thinking block, determine which page/cover it belongs to.
  //
  // Strategy:
  // 1. Look forward for quality evaluation to identify pages (QUALITY P1 Starting...PAGE X)
  // 2. For covers, look forward for quality retry score lines (tracking claimed ones)
  // 3. Look backward for generation start markers for attempt tracking

  // Track which quality score lines have been claimed (for covers, prevents double-matching)
  const claimedScoreLines = new Set();

  for (const block of blocks) {
    const startIdx = block.lineIndex;
    let target = null;
    let attempt = 1;

    // STRATEGY 1: Look forward for quality evaluation within 120 lines
    for (let j = startIdx + 1; j < lines.length && j < startIdx + 120; j++) {
      const msg = lines[j].message;

      // "Starting two-pass evaluation for PAGE X" - definitive page link
      const pageMatch = msg.match(/\[QUALITY P1\] Starting two-pass evaluation for PAGE (\d+)/);
      if (pageMatch) {
        target = `Page ${pageMatch[1]}`;
        break;
      }

      // Single-pass quality fallback for page
      const singlePassMatch = msg.match(/\[QUALITY\] Two-pass incomplete, using single-pass fallback for PAGE (\d+)/);
      if (singlePassMatch) {
        target = `Page ${singlePassMatch[1]}`;
        break;
      }

      // Direct quality retry score for page (only unclaimed)
      const retryScoreMatch = msg.match(/\[QUALITY RETRY\] \[PAGE (\d+)\] Attempt (\d+) score:/);
      if (retryScoreMatch && !claimedScoreLines.has(j)) {
        target = `Page ${retryScoreMatch[1]}`;
        attempt = parseInt(retryScoreMatch[2]);
        claimedScoreLines.add(j);
        break;
      }

      // Quality retry score for cover (only unclaimed)
      const coverScoreMatch = msg.match(/\[QUALITY RETRY\] \[(FRONT COVER|BACK COVER|INITIAL PAGE)\] Attempt (\d+) score:/);
      if (coverScoreMatch && !claimedScoreLines.has(j)) {
        target = coverScoreMatch[1];
        attempt = parseInt(coverScoreMatch[2]);
        claimedScoreLines.add(j);
        break;
      }

      // Note: STREAM-COVER lines are not used for matching because they come
      // after quality evaluation and can cause false matches with interleaved covers
    }

    // STRATEGY 2: Use thinking summary title as hint
    if (!target && block.summaryTitle) {
      if (/front cover/i.test(block.summaryTitle)) target = 'FRONT COVER';
      else if (/back cover/i.test(block.summaryTitle)) target = 'BACK COVER';
      else if (/dedication|introduction|initial/i.test(block.summaryTitle)) target = 'INITIAL PAGE';
    }

    // Look backward for attempt number if we have a target but attempt is still 1
    if (target) {
      for (let j = startIdx - 1; j >= 0 && j > startIdx - 80; j--) {
        const msg = lines[j].message;
        const targetPattern = target.startsWith('Page')
          ? target.replace('Page ', 'PAGE ')
          : target;
        const attemptMatch = msg.match(new RegExp(
          `\\[QUALITY RETRY\\] \\[${targetPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\] Attempt (\\d+)\\/\\d+ \\(threshold`
        ));
        if (attemptMatch) {
          attempt = parseInt(attemptMatch[1]);
          break;
        }
      }
    }

    block.target = target || 'Unknown';
    block.attempt = attempt;
  }

  return blocks;
}

// ============================================================================
// OUTPUT
// ============================================================================

function printResults({ storyTitle, blocks }) {
  const separator = '='.repeat(78);
  const thinSep = '-'.repeat(78);

  console.log('');
  console.log(separator);
  console.log('  GEMINI THINKING TEXT EXTRACTION');
  console.log(separator);
  console.log('');
  console.log(`  Story: ${storyTitle}`);
  console.log(`  Total thinking blocks: ${blocks.length}`);

  // Calculate totals
  const totalThinkingTokens = blocks.reduce((sum, b) => sum + b.thinkingTokens, 0);
  console.log(`  Total thinking tokens: ${totalThinkingTokens.toLocaleString()}`);
  console.log('');

  // Group blocks: covers first, then pages in order
  const coverBlocks = blocks.filter(b => !b.target.startsWith('Page'));
  const pageBlocks = blocks.filter(b => b.target.startsWith('Page'));

  // Sort pages by page number, then by attempt
  pageBlocks.sort((a, b) => {
    const pageA = parseInt(a.target.match(/\d+/)?.[0] || 0);
    const pageB = parseInt(b.target.match(/\d+/)?.[0] || 0);
    if (pageA !== pageB) return pageA - pageB;
    return a.attempt - b.attempt;
  });

  // Print covers
  if (coverBlocks.length > 0) {
    console.log(separator);
    console.log('  COVERS');
    console.log(separator);

    for (const block of coverBlocks) {
      console.log('');
      console.log(`  ${thinSep}`);
      const label = formatTarget(block.target);
      const attemptStr = block.attempt > 1 ? ` (Attempt ${block.attempt})` : '';
      console.log(`  ${label}${attemptStr}`);
      console.log(`  Thinking tokens: ${block.thinkingTokens.toLocaleString()} | Text: ${block.charCount} chars`);
      console.log(`  ${thinSep}`);
      console.log('');
      printIndented(block.thinkingText);
      console.log('');
    }
  }

  // Print pages
  if (pageBlocks.length > 0) {
    console.log(separator);
    console.log('  PAGE IMAGES');
    console.log(separator);

    let lastPage = '';
    for (const block of pageBlocks) {
      const pageLabel = block.target;

      // Add extra spacing between different pages
      if (pageLabel !== lastPage && lastPage !== '') {
        console.log('');
      }
      lastPage = pageLabel;

      console.log('');
      console.log(`  ${thinSep}`);
      const attemptStr = block.attempt > 1 ? ` -- RETRY Attempt ${block.attempt}` : '';
      console.log(`  ${pageLabel}${attemptStr}`);
      console.log(`  Thinking tokens: ${block.thinkingTokens.toLocaleString()} | Text: ${block.charCount} chars`);
      console.log(`  ${thinSep}`);
      console.log('');
      printIndented(block.thinkingText);
      console.log('');
    }
  }

  // Summary table
  console.log('');
  console.log(separator);
  console.log('  SUMMARY');
  console.log(separator);
  console.log('');
  console.log('  Target                    Attempt  Thinking Tokens  Text Length');
  console.log('  ' + '-'.repeat(72));

  for (const block of [...coverBlocks, ...pageBlocks]) {
    const target = formatTarget(block.target).padEnd(26);
    const attempt = String(block.attempt).padEnd(8);
    const tokens = block.thinkingTokens.toLocaleString().padStart(8);
    const chars = block.charCount.toLocaleString().padStart(12);
    console.log(`  ${target} ${attempt} ${tokens}     ${chars}`);
  }

  console.log('  ' + '-'.repeat(72));
  const totalChars = blocks.reduce((sum, b) => sum + b.charCount, 0);
  console.log(`  ${'TOTAL'.padEnd(26)} ${''.padEnd(8)} ${totalThinkingTokens.toLocaleString().padStart(8)}     ${totalChars.toLocaleString().padStart(12)}`);
  console.log('');
}

function formatTarget(target) {
  const map = {
    'FRONT COVER': 'Front Cover',
    'BACK COVER': 'Back Cover',
    'INITIAL PAGE': 'Initial Page (Dedication)'
  };
  return map[target] || target;
}

function printIndented(text) {
  const lines = text.split('\n');
  for (const line of lines) {
    console.log(`    ${line}`);
  }
}

// ============================================================================
// MAIN
// ============================================================================

function main() {
  const logPath = process.argv[2] || getLatestLogFile();

  if (!logPath) {
    console.error('No log file found. Provide a path or have logs.*.log files in ~/Downloads.');
    process.exit(1);
  }

  if (!fs.existsSync(logPath)) {
    console.error(`Log file not found: ${logPath}`);
    process.exit(1);
  }

  console.log(`Reading: ${logPath}`);

  const lines = parseLogFile(logPath);
  console.log(`Parsed ${lines.length} log lines`);

  const result = extractThinking(lines);
  printResults(result);
}

main();
