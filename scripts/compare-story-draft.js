#!/usr/bin/env node
/**
 * Story Outline Review - Analyze CRITICAL ANALYSIS findings
 *
 * Usage:
 *   node scripts/compare-story-draft.js [storyId]
 *
 * If storyId is provided, fetches from API (requires server running)
 * Otherwise, fetches latest story from database directly
 */

const https = require('https');
const http = require('http');

// Parse command line args
const storyId = process.argv[2];
const apiBase = process.env.API_BASE || 'http://localhost:3000';

async function fetchFromApi(storyId) {
  return new Promise((resolve, reject) => {
    const url = `${apiBase}/api/stories/${storyId}/dev-metadata`;
    const client = url.startsWith('https') ? https : http;

    // Note: This requires authentication in production
    // For local dev, you may need to temporarily disable auth or use a token
    const req = client.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`API returned ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
  });
}

async function fetchFromDatabase() {
  const { Pool } = require('pg');
  const dbUrl = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;

  if (!dbUrl) {
    throw new Error('No database URL. Set DATABASE_PUBLIC_URL or DATABASE_URL');
  }

  const pool = new Pool({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false }
  });

  try {
    const result = await pool.query(`
      SELECT
        id,
        data->'outline' as outline,
        data->'originalStory' as story,
        data->'title' as title
      FROM stories
      ORDER BY created_at DESC LIMIT 1
    `);

    const row = result.rows[0];
    if (!row) return null;

    // Extract CRITICAL ANALYSIS from outline
    let criticalAnalysis = null;
    if (row.outline) {
      const analysisMatch = row.outline.match(/---CRITICAL ANALYSIS---\s*\n([\s\S]*?)(?=\n---TITLE---|$)/);
      if (analysisMatch) {
        criticalAnalysis = analysisMatch[1].trim();
      }
    }

    return {
      id: row.id,
      title: row.title,
      criticalAnalysis,
      originalStory: row.story
    };
  } finally {
    await pool.end();
  }
}

function analyzeCriticalAnalysis(analysisText, storyText) {
  const results = {
    categories: [],
    fixes: [],
    bannedGestureScan: []
  };

  if (!analysisText) return results;

  // Extract category sections
  const sectionPattern = /\d+\.\s*\*\*([^*]+)\*\*\s*\n([\s\S]*?)(?=\n\d+\.\s*\*\*|\*\*Fixes|\n---|\n$)/gi;
  let match;
  while ((match = sectionPattern.exec(analysisText)) !== null) {
    const category = match[1].trim();
    const content = match[2].trim();
    const lines = content.split('\n').filter(l => l.trim());

    const hasIssue = !lines.every(line =>
      line.includes('✓') || line.includes('✔') || line.trim() === ''
    );

    const issues = hasIssue
      ? lines.filter(l => !l.includes('✓') && !l.includes('✔') && l.trim())
      : [];

    results.categories.push({
      name: category,
      passed: !hasIssue,
      issues: issues.map(l => l.trim())
    });
  }

  // Extract fixes
  const fixesMatch = analysisText.match(/\*\*Fixes:?\*\*:?\s*\n([\s\S]*?)$/i);
  if (fixesMatch) {
    const fixPattern = /\d+\.\s*(?:Seite|Page)\s*(\d+):\s*["„]?([^"„→\n]+)[""]?\s*→\s*(.+)/gi;
    while ((match = fixPattern.exec(fixesMatch[1])) !== null) {
      const page = parseInt(match[1]);
      const before = match[2].trim();
      const after = match[3].trim();

      // Check if fix was applied
      let fixed = true;
      if (storyText) {
        const pagePattern = new RegExp(`--- Page ${page} ---\\s*\\n([\\s\\S]*?)(?=--- Page \\d+ ---|$)`, 'i');
        const pageMatch = storyText.match(pagePattern);
        if (pageMatch) {
          const pageText = pageMatch[1].toLowerCase();
          // Check for banned patterns
          fixed = ![
            /hand.*schulter/, /arm.*um.*schulter/, /umarmte.*kurz/,
            /wuschelte.*haar/, /klopfte.*rücken/, /nickte.*wissend/,
            /sagte.*praktisch/
          ].some(p => p.test(pageText));
        }
      }

      results.fixes.push({ page, before, after, fixed });
    }
  }

  // Scan for banned gestures in final story
  if (storyText) {
    const bannedPatterns = [
      { pattern: /hand.{0,15}schulter/gi, name: 'Hand on shoulder' },
      { pattern: /arm.{0,10}um.{0,15}schulter/gi, name: 'Arm around shoulders' },
      { pattern: /wuschelte.{0,10}haar/gi, name: 'Ruffled hair' },
      { pattern: /klopfte.{0,15}rücken/gi, name: 'Patted on back' },
      { pattern: /nickte.{0,10}wissend/gi, name: 'Nodded wisely' },
      { pattern: /legte.{0,10}arm.{0,10}um/gi, name: 'Put arm around' }
    ];

    for (const { pattern, name } of bannedPatterns) {
      const matches = storyText.match(pattern);
      results.bannedGestureScan.push({
        name,
        found: matches || [],
        clean: !matches
      });
    }
  }

  return results;
}

function printResults(data, analysis) {
  console.log(`Story: ${data.title || 'Untitled'}`);
  console.log(`ID: ${data.id}\n`);
  console.log('='.repeat(80));

  // Categories
  console.log('\n# CRITICAL ANALYSIS FINDINGS\n');
  console.log('## Issues Identified:\n');

  for (const cat of analysis.categories) {
    const status = cat.passed ? '✅' : '⚠️';
    console.log(`${status} **${cat.name}**`);
    if (!cat.passed) {
      for (const issue of cat.issues) {
        console.log(`   ${issue}`);
      }
    }
    console.log();
  }

  // Fixes
  if (analysis.fixes.length > 0) {
    console.log('\n## Fixes Applied:\n');
    for (const fix of analysis.fixes) {
      console.log(`### Page ${fix.page}`);
      console.log();
      console.log(`**Before:** "${fix.before}"`);
      console.log(`**After:**  "${fix.after}"`);
      console.log(`**Status:** ${fix.fixed ? '✅ Fixed in final' : '❌ Not fixed'}`);
      console.log();
      console.log('-'.repeat(60));
      console.log();
    }
  }

  // Banned gesture scan
  console.log('\n# BANNED GESTURE SCAN (Final Story)\n');
  let allClean = true;
  for (const scan of analysis.bannedGestureScan) {
    if (scan.clean) {
      console.log(`✅ ${scan.name}: Clean`);
    } else {
      console.log(`❌ ${scan.name}: FOUND "${scan.found.join('", "')}"`);
      allClean = false;
    }
  }
  if (allClean) {
    console.log('\n✅ All banned gestures successfully removed!');
  }

  // Summary
  console.log('\n' + '='.repeat(80));
  console.log('# SUMMARY\n');
  const pageCount = (data.originalStory?.match(/--- Page \d+ ---/g) || []).length;
  const issueCount = analysis.categories.filter(c => !c.passed).length;
  const fixCount = analysis.fixes.length;
  const fixedCount = analysis.fixes.filter(f => f.fixed).length;

  console.log(`Total pages: ${pageCount}`);
  console.log(`Categories with issues: ${issueCount}`);
  console.log(`Fixes applied: ${fixedCount}/${fixCount}`);
  console.log(`Banned gestures remaining: ${allClean ? '0 (all clean)' : 'Some found'}`);
}

async function main() {
  console.log('Fetching story data...\n');

  let data;
  try {
    if (storyId) {
      console.log(`Using API for story: ${storyId}`);
      data = await fetchFromApi(storyId);
      data.id = storyId;
    } else {
      console.log('Using database for latest story');
      data = await fetchFromDatabase();
    }
  } catch (err) {
    console.error('Error fetching data:', err.message);
    process.exit(1);
  }

  if (!data) {
    console.log('No story data found');
    process.exit(1);
  }

  const analysis = analyzeCriticalAnalysis(data.criticalAnalysis, data.originalStory);
  printResults(data, analysis);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
