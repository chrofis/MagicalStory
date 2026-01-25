const { Pool } = require('pg');

async function main() {
  const dbUrl = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;

  const pool = new Pool({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false }
  });

  try {
    console.log('Fetching latest story...\n');

    const result = await pool.query(`
      SELECT
        id,
        data->'outline' as outline,
        data->'originalStory' as story,
        data->'title' as title
      FROM stories
      ORDER BY created_at DESC LIMIT 1
    `);

    const { outline, story, title, id } = result.rows[0] || {};

    if (!outline || !story) {
      console.log('No story data found');
      return;
    }

    console.log(`Story: ${title || 'Untitled'}`);
    console.log(`ID: ${id}\n`);
    console.log('='.repeat(80));

    // Both outline and story are strings
    const outlineStr = typeof outline === 'string' ? outline : String(outline);
    const storyStr = typeof story === 'string' ? story : String(story);

    // Parse draft from outline (between ---STORY DRAFT--- and ---CRITICAL ANALYSIS---)
    const draftMatch = outlineStr.match(/---STORY DRAFT---\s*\n([\s\S]*?)(?=\n---CRITICAL ANALYSIS---|$)/);

    if (!draftMatch) {
      console.log('Could not find ---STORY DRAFT--- section in outline');
      return;
    }

    const draftText = draftMatch[1];

    // Parse draft pages (format: **Draft Page N**)
    const draftPages = {};
    const draftPageRegex = /\*\*Draft Page (\d+)\*\*\s*\n([\s\S]*?)(?=\*\*Draft Page \d+\*\*|$)/gi;
    let match;
    while ((match = draftPageRegex.exec(draftText)) !== null) {
      const pageNum = match[1];
      // Extract text before SCENE HINT or word count
      let pageContent = match[2];
      const sceneHintIdx = pageContent.search(/SCENE HINT:|Characters \(MAX/i);
      if (sceneHintIdx > -1) {
        pageContent = pageContent.substring(0, sceneHintIdx);
      }
      // Remove word count line
      pageContent = pageContent.replace(/\*\(Word count:.*?\)\*/g, '').trim();
      draftPages[pageNum] = pageContent;
    }

    // Parse final story pages (format: --- Page N ---)
    const finalPages = {};
    const finalPageRegex = /--- Page (\d+) ---\s*\n([\s\S]*?)(?=--- Page \d+ ---|$)/gi;
    while ((match = finalPageRegex.exec(storyStr)) !== null) {
      const pageNum = match[1];
      finalPages[pageNum] = match[2].trim();
    }

    const pageNumbers = [...new Set([...Object.keys(draftPages), ...Object.keys(finalPages)])].sort((a, b) => a - b);

    let changedCount = 0;
    let bannedGestureFixes = [];

    console.log('\n# Page-by-Page Comparison\n');

    for (const pageNum of pageNumbers) {
      const draftTextOnly = draftPages[pageNum] || '';
      const finalText = finalPages[pageNum] || '';

      // Normalize for comparison
      const normalizedDraft = draftTextOnly.replace(/\s+/g, ' ').trim();
      const normalizedFinal = finalText.replace(/\s+/g, ' ').trim();

      const isChanged = normalizedDraft !== normalizedFinal;
      if (isChanged && draftTextOnly && finalText) changedCount++;

      console.log(`## Page ${pageNum} ${isChanged ? '✅ CHANGED' : '❌ No change'}`);
      console.log();

      if (isChanged && draftTextOnly && finalText) {
        // Find differences
        console.log('**Draft:**');
        console.log(draftTextOnly.substring(0, 400) + (draftTextOnly.length > 400 ? '...' : ''));
        console.log();
        console.log('**Final:**');
        console.log(finalText.substring(0, 400) + (finalText.length > 400 ? '...' : ''));
        console.log();

        // Check for banned gesture fixes
        const bannedPatterns = [
          { pattern: /arm um.*schulter/i, name: 'arm around shoulders' },
          { pattern: /hand auf.*schulter/i, name: 'hand on shoulder' },
          { pattern: /wuschelte.*haar/i, name: 'ruffling hair' },
          { pattern: /legte.*arm.*um/i, name: 'arm around' },
          { pattern: /einen arm um/i, name: 'arm around' }
        ];

        for (const { pattern, name } of bannedPatterns) {
          if (pattern.test(draftTextOnly) && !pattern.test(finalText)) {
            bannedGestureFixes.push({ page: pageNum, gesture: name });
            console.log(`🚫 BANNED GESTURE FIXED: "${name}"`);
          }
        }
      }

      console.log('-'.repeat(60));
      console.log();
    }

    // Summary
    console.log('\n' + '='.repeat(80));
    console.log('# SUMMARY\n');
    console.log(`Total pages: ${pageNumbers.length}`);
    console.log(`Pages modified: ${changedCount}`);
    console.log(`Banned gesture fixes: ${bannedGestureFixes.length}`);

    if (bannedGestureFixes.length > 0) {
      console.log('\nBanned gestures fixed:');
      for (const fix of bannedGestureFixes) {
        console.log(`  - Page ${fix.page}: ${fix.gesture}`);
      }
    }

  } catch (e) {
    console.error('Error:', e.message);
  }

  await pool.end();
}

main();
