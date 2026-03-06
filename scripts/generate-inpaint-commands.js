#!/usr/bin/env node
/**
 * Generate Inpaint Commands
 *
 * Converts consistency analysis results into inpaint command JSON.
 * Reads analysis from any of the three methods (ArcFace, Gemini, Grid).
 *
 * Usage:
 *   node scripts/generate-inpaint-commands.js output/story-<id>/
 *
 * Input:
 *   - extractions.json (required)
 *   - arcface-analysis.json OR gemini-analysis.json OR grid-analysis.json
 *
 * Output:
 *   - inpaint-commands.json - Ready-to-execute inpaint commands
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

// ============================================================================
// CONFIG
// ============================================================================

// Severity thresholds
const THRESHOLDS = {
  HIGH_SEVERITY: 0.30,    // Consistency score below this = high severity
  MEDIUM_SEVERITY: 0.50,  // Below this = medium severity
};

// ============================================================================
// ANALYSIS LOADERS
// ============================================================================

function loadAnalysis(storyDir) {
  // Try loading analysis in order of preference
  const sources = [
    { file: 'grid-analysis.json', method: 'grid' },
    { file: 'gemini-analysis.json', method: 'gemini' },
    { file: 'arcface-analysis.json', method: 'arcface' },
  ];

  for (const source of sources) {
    const filePath = path.join(storyDir, source.file);
    if (fs.existsSync(filePath)) {
      console.log(`   Loading analysis from: ${source.file}`);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return { ...data, sourceFile: source.file, sourceMethod: source.method };
    }
  }

  return null;
}

function loadExtractions(storyDir) {
  const filePath = path.join(storyDir, 'extractions.json');
  if (!fs.existsSync(filePath)) {
    throw new Error(`Extractions file not found: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// ============================================================================
// COMMAND GENERATION
// ============================================================================

function normalizeIssues(analysis, extractions) {
  // Normalize issues from different analysis methods into a common format
  const issues = [];

  for (const [charName, charData] of Object.entries(analysis.characters || {})) {
    if (charData.skipped || charData.error) continue;

    const overallConsistency = charData.overallConsistency || 1;

    // Get issues based on analysis method
    let charIssues = [];

    if (analysis.sourceMethod === 'arcface') {
      // ArcFace: uses outliers array
      charIssues = (charData.outliers || []).map(outlier => ({
        pageNumber: outlier.pageNumber,
        faceId: outlier.faceId,
        severity: outlier.severity || (outlier.avgSimilarity < THRESHOLDS.HIGH_SEVERITY ? 'high' : 'medium'),
        score: outlier.avgSimilarity,
        issues: [`Low similarity to other appearances (${(outlier.avgSimilarity * 100).toFixed(1)}%)`],
      }));
    } else if (analysis.sourceMethod === 'gemini') {
      // Gemini: uses inconsistentImages array
      charIssues = (charData.inconsistentImages || []).map(issue => ({
        pageNumber: issue.pageNumber,
        faceId: issue.faceId,
        severity: issue.severity || 'medium',
        score: null,
        issues: issue.issues || [],
      }));
    } else if (analysis.sourceMethod === 'grid') {
      // Grid: uses inconsistentPages array
      charIssues = (charData.inconsistentPages || []).map(issue => ({
        pageNumber: issue.pageNumber,
        faceId: issue.faceId,
        severity: issue.severity || 'medium',
        score: null,
        issues: issue.issues || [],
      }));
    }

    // Add character context to each issue
    for (const issue of charIssues) {
      issues.push({
        character: charName,
        characterId: extractions.characters[charName]?.characterId,
        ...issue,
        consistentFeatures: charData.consistentFeatures,
        overallConsistency,
      });
    }
  }

  return issues;
}

function getBoundingBox(extractions, pageNumber, faceId) {
  // Find the bounding box for a specific face
  const page = extractions.pages.find(p => p.pageNumber === pageNumber);
  if (!page) return null;

  const extraction = page.extractions.find(e => e.faceId === faceId);
  if (!extraction || !extraction.boundingBox) return null;

  const bb = extraction.boundingBox;
  // Convert to [x, y, width, height] format (already percentages 0-1)
  return [bb.x, bb.y, bb.width, bb.height];
}

function generateFixPrompt(issue) {
  const { character, issues, consistentFeatures } = issue;

  // Build a prompt based on the issues found
  const issueText = issues.length > 0 ? issues.join(', ') : 'inconsistent appearance';

  let prompt = `Fix ${character}'s face to match their consistent appearance.`;

  if (consistentFeatures && consistentFeatures.length > 0) {
    prompt += ` Key features: ${consistentFeatures.join(', ')}.`;
  }

  prompt += ` Issues detected: ${issueText}.`;

  return prompt;
}

function generateInpaintCommands(issues, extractions) {
  const commands = [];

  for (const issue of issues) {
    // Only generate commands for issues with known page numbers
    if (!issue.pageNumber) continue;

    // Get bounding box
    const boundingBox = getBoundingBox(extractions, issue.pageNumber, issue.faceId);

    // Generate fix prompt
    const fixPrompt = generateFixPrompt(issue);

    // Calculate confidence based on severity and method
    let confidence = 0.7;
    if (issue.severity === 'high') confidence = 0.9;
    else if (issue.severity === 'low') confidence = 0.5;

    commands.push({
      pageNumber: issue.pageNumber,
      character: issue.character,
      characterId: issue.characterId,
      faceId: issue.faceId,
      issue: 'face_inconsistency',
      severity: issue.severity,
      boundingBox,
      fixPrompt,
      confidence,
      detectedIssues: issue.issues,
      consistentFeatures: issue.consistentFeatures,
    });
  }

  // Sort by page number, then by severity
  commands.sort((a, b) => {
    if (a.pageNumber !== b.pageNumber) {
      return a.pageNumber - b.pageNumber;
    }
    const severityOrder = { high: 0, medium: 1, low: 2 };
    return (severityOrder[a.severity] || 1) - (severityOrder[b.severity] || 1);
  });

  return commands;
}

// ============================================================================
// MAIN
// ============================================================================

async function generateCommands(storyDir) {
  console.log(`\n🔧 Generate Inpaint Commands`);

  // Load extractions (required)
  const extractions = loadExtractions(storyDir);
  console.log(`   Story: ${extractions.storyTitle}`);

  // Load analysis (from any method)
  const analysis = loadAnalysis(storyDir);
  if (!analysis) {
    throw new Error('No analysis file found. Run one of the test scripts first.');
  }

  console.log(`   Analysis method: ${analysis.sourceMethod}`);
  console.log(`   Characters analyzed: ${Object.keys(analysis.characters || {}).length}`);

  // Normalize issues from analysis
  const issues = normalizeIssues(analysis, extractions);
  console.log(`\n📋 Found ${issues.length} consistency issue(s)`);

  if (issues.length === 0) {
    console.log('   No inconsistencies detected - no inpaint commands needed');

    const output = {
      storyId: extractions.storyId,
      generatedAt: new Date().toISOString(),
      analysisSource: analysis.sourceFile,
      analysisMethod: analysis.sourceMethod,
      totalIssues: 0,
      commands: [],
    };

    const outputPath = path.join(storyDir, 'inpaint-commands.json');
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
    console.log(`\n✅ Saved (empty) commands to: ${outputPath}`);
    return output;
  }

  // Generate inpaint commands
  const commands = generateInpaintCommands(issues, extractions);

  // Summary
  const highSeverity = commands.filter(c => c.severity === 'high').length;
  const mediumSeverity = commands.filter(c => c.severity === 'medium').length;

  console.log(`\n   High severity: ${highSeverity}`);
  console.log(`   Medium severity: ${mediumSeverity}`);

  // Show commands
  console.log(`\n📝 Generated Commands:`);
  for (const cmd of commands) {
    const bbox = cmd.boundingBox
      ? `[${cmd.boundingBox.map(v => (v * 100).toFixed(0) + '%').join(', ')}]`
      : 'no bbox';
    console.log(`   Page ${cmd.pageNumber}: ${cmd.character} (${cmd.severity}) - ${bbox}`);
    if (cmd.detectedIssues?.length > 0) {
      console.log(`      Issues: ${cmd.detectedIssues.join('; ')}`);
    }
  }

  // Build output
  const output = {
    storyId: extractions.storyId,
    generatedAt: new Date().toISOString(),
    analysisSource: analysis.sourceFile,
    analysisMethod: analysis.sourceMethod,
    totalIssues: commands.length,
    summary: {
      highSeverity,
      mediumSeverity,
      charactersCovered: [...new Set(commands.map(c => c.character))],
      pagesCovered: [...new Set(commands.map(c => c.pageNumber))].sort((a, b) => a - b),
    },
    commands,
  };

  // Save output
  const outputPath = path.join(storyDir, 'inpaint-commands.json');
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\n✅ Saved ${commands.length} command(s) to: ${outputPath}`);

  return output;
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  const storyDir = process.argv[2];

  if (!storyDir) {
    console.log('Usage: node scripts/generate-inpaint-commands.js <story-output-dir>');
    console.log('');
    console.log('Example:');
    console.log('  node scripts/generate-inpaint-commands.js output/story-1737234567890/');
    console.log('');
    console.log('Requires:');
    console.log('  - extractions.json (from analyze-story-characters.js)');
    console.log('  - One of: arcface-analysis.json, gemini-analysis.json, grid-analysis.json');
    process.exit(1);
  }

  try {
    await generateCommands(storyDir);
  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    process.exit(1);
  }
}

main();
