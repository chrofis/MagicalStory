#!/usr/bin/env node
/**
 * Compare Gemini 2.5 Flash vs Grok 4 Fast for image quality evaluation.
 * Loads a real story from DB, evaluates 5 pages with both models, compares results.
 *
 * Usage: node tests/manual/test-grok-vs-gemini-eval.js [storyId] [pageCount]
 *   storyId: Story ID to test (default: most recent story)
 *   pageCount: Number of pages to test (default: 5)
 *
 * Requires: DATABASE_URL, GEMINI_API_KEY, XAI_API_KEY in environment
 */

require('dotenv').config();
const { getPool, rehydrateStoryImages } = require('../../server/services/database');
const { evaluateImageQuality } = require('../../server/lib/images');
const { getPageText } = require('../../server/lib/storyHelpers');

async function main() {
  const storyId = process.argv[2];
  const pageCount = parseInt(process.argv[3]) || 5;

  const pool = getPool();

  // Find story
  let query, params;
  if (storyId) {
    query = 'SELECT id, data FROM stories WHERE id = $1';
    params = [storyId];
  } else {
    query = 'SELECT id, data FROM stories ORDER BY created_at DESC LIMIT 1';
    params = [];
  }

  const result = await pool.query(query, params);
  if (result.rows.length === 0) {
    console.error('No story found');
    process.exit(1);
  }

  const story = result.rows[0];
  let storyData = typeof story.data === 'string' ? JSON.parse(story.data) : story.data;
  storyData = await rehydrateStoryImages(story.id, storyData);

  console.log(`\n📖 Story: ${storyData.title || story.id}`);
  console.log(`   Pages: ${storyData.sceneImages?.length || 0}`);
  console.log(`   Testing: ${pageCount} pages\n`);

  const scenes = (storyData.sceneImages || []).slice(0, pageCount);
  const fullStoryText = storyData.story || storyData.storyText || '';
  const characters = storyData.characters || [];
  const referencePhotos = characters.map(c => ({
    name: c.name,
    photoUrl: c.photos?.face || c.photoUrl || c.avatars?.standard || null
  })).filter(r => r.photoUrl);

  console.log(`   Characters: ${characters.map(c => c.name).join(', ')}`);
  console.log(`   Reference photos: ${referencePhotos.length}`);
  console.log('');
  console.log('='.repeat(100));

  const results = [];

  for (const scene of scenes) {
    if (!scene.imageData) {
      console.log(`\n⏭️  Page ${scene.pageNumber}: No image data, skipping`);
      continue;
    }

    const pageText = getPageText(fullStoryText, scene.pageNumber) || scene.text || '';
    const sceneHint = scene.outlineExtract || scene.sceneHint || '';
    const prompt = scene.prompt || scene.description || '';

    console.log(`\n📸 Page ${scene.pageNumber}`);
    console.log(`   Scene: ${(sceneHint || prompt).substring(0, 80)}...`);

    // Test with Gemini 2.5 Flash
    console.log('\n   🔵 Gemini 2.5 Flash...');
    const geminiStart = Date.now();
    let geminiResult;
    try {
      geminiResult = await evaluateImageQuality(
        scene.imageData, prompt, referencePhotos, 'scene',
        'gemini-2.5-flash', `PAGE ${scene.pageNumber}`,
        pageText, sceneHint
      );
      const geminiTime = Date.now() - geminiStart;
      console.log(`      Score: ${geminiResult?.score ?? 'N/A'}/100 (quality: ${geminiResult?.qualityScore ?? 'N/A'}, semantic: ${geminiResult?.semanticScore ?? 'N/A'})`);
      console.log(`      Issues: ${geminiResult?.fixableIssues?.length || 0}`);
      console.log(`      Time: ${geminiTime}ms`);
      if (geminiResult?.issuesSummary) console.log(`      Summary: ${geminiResult.issuesSummary.substring(0, 120)}`);
      if (geminiResult?.blocked) console.log(`      ⚠️  CONTENT BLOCKED — used sanitized fallback`);
    } catch (err) {
      console.log(`      ❌ Error: ${err.message}`);
      geminiResult = null;
    }

    // Test with Grok 4 Fast
    console.log('\n   🟠 Grok 4 Fast (vision)...');
    const grokStart = Date.now();
    let grokResult;
    try {
      grokResult = await evaluateImageQuality(
        scene.imageData, prompt, referencePhotos, 'scene',
        'grok-4-fast', `PAGE ${scene.pageNumber}`,
        pageText, sceneHint
      );
      const grokTime = Date.now() - grokStart;
      console.log(`      Score: ${grokResult?.score ?? 'N/A'}/100 (quality: ${grokResult?.qualityScore ?? 'N/A'}, semantic: ${grokResult?.semanticScore ?? 'N/A'})`);
      console.log(`      Issues: ${grokResult?.fixableIssues?.length || 0}`);
      console.log(`      Time: ${grokTime}ms`);
      if (grokResult?.issuesSummary) console.log(`      Summary: ${grokResult.issuesSummary.substring(0, 120)}`);
    } catch (err) {
      console.log(`      ❌ Error: ${err.message}`);
      grokResult = null;
    }

    // Compare
    const geminiScore = geminiResult?.score ?? null;
    const grokScore = grokResult?.score ?? null;
    const diff = (geminiScore != null && grokScore != null) ? Math.abs(geminiScore - grokScore) : null;

    results.push({
      page: scene.pageNumber,
      geminiScore,
      grokScore,
      diff,
      geminiIssues: geminiResult?.fixableIssues?.length || 0,
      grokIssues: grokResult?.fixableIssues?.length || 0,
      geminiBlocked: !!geminiResult?.blocked,
      geminiTime: geminiResult ? Date.now() - geminiStart : null,
    });

    console.log(`\n   📊 Diff: ${diff != null ? diff + ' points' : 'N/A'}`);
    console.log('   ' + '-'.repeat(80));
  }

  // Summary
  console.log('\n' + '='.repeat(100));
  console.log('\n📋 SUMMARY\n');
  console.log('Page | Gemini Score | Grok Score | Diff | Gemini Issues | Grok Issues | Blocked');
  console.log('-----|-------------|------------|------|---------------|-------------|--------');
  for (const r of results) {
    console.log(
      `  ${String(r.page).padStart(2)} | ` +
      `${r.geminiScore != null ? String(r.geminiScore).padStart(11) : '      N/A  '} | ` +
      `${r.grokScore != null ? String(r.grokScore).padStart(10) : '     N/A  '} | ` +
      `${r.diff != null ? String(r.diff).padStart(4) : ' N/A'} | ` +
      `${String(r.geminiIssues).padStart(13)} | ` +
      `${String(r.grokIssues).padStart(11)} | ` +
      `${r.geminiBlocked ? '  YES' : '   no'}`
    );
  }

  const avgGemini = results.filter(r => r.geminiScore != null).reduce((s, r) => s + r.geminiScore, 0) / (results.filter(r => r.geminiScore != null).length || 1);
  const avgGrok = results.filter(r => r.grokScore != null).reduce((s, r) => s + r.grokScore, 0) / (results.filter(r => r.grokScore != null).length || 1);
  const avgDiff = results.filter(r => r.diff != null).reduce((s, r) => s + r.diff, 0) / (results.filter(r => r.diff != null).length || 1);
  const blocked = results.filter(r => r.geminiBlocked).length;

  console.log('-----|-------------|------------|------|---------------|-------------|--------');
  console.log(`  Avg | ${String(Math.round(avgGemini)).padStart(11)} | ${String(Math.round(avgGrok)).padStart(10)} | ${String(Math.round(avgDiff)).padStart(4)} |               |             | ${blocked}/${results.length}`);

  console.log(`\n✅ Gemini content blocks: ${blocked}/${results.length} pages`);
  console.log(`📊 Average score difference: ${Math.round(avgDiff)} points`);
  console.log(`📊 Average Gemini score: ${Math.round(avgGemini)}`);
  console.log(`📊 Average Grok score: ${Math.round(avgGrok)}`);

  if (avgDiff <= 15) {
    console.log('\n✅ VERDICT: Grok scores are close to Gemini — viable replacement');
  } else {
    console.log('\n⚠️  VERDICT: Significant score difference — needs investigation');
  }

  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
