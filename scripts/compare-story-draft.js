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

    const outlineStr = typeof outline === 'string' ? outline : String(outline);
    const storyStr = typeof story === 'string' ? story : String(story);

    // =========================================================================
    // SECTION 1: EXTRACT AND DISPLAY CRITICAL ANALYSIS
    // =========================================================================

    const analysisMatch = outlineStr.match(/---CRITICAL ANALYSIS---\s*\n([\s\S]*?)(?=\n---TITLE---|$)/);

    if (!analysisMatch) {
      console.log('\n❌ No CRITICAL ANALYSIS section found');
    } else {
      console.log('\n# CRITICAL ANALYSIS FINDINGS\n');

      const analysisText = analysisMatch[1];

      // Parse all issues mentioned with page numbers
      const issues = [];

      // Pattern 1: "Seite X: ..." or "Seite X hat ..." or "Page X: ..."
      const pageIssuePattern = /(?:Seite|Page)\s*(\d+)(?:\s*hat|\s*:)?\s*["„]?([^""\n]+)[""]?/gi;
      let match;
      while ((match = pageIssuePattern.exec(analysisText)) !== null) {
        issues.push({
          page: parseInt(match[1]),
          issue: match[2].trim(),
          type: 'page-specific'
        });
      }

      // Pattern 2: "Seiten X und Y" (multiple pages)
      const multiPagePattern = /(?:Seiten|Pages)\s*(\d+)\s*(?:und|and|,)\s*(\d+)[^-\n]*[-–]\s*([^\n]+)/gi;
      while ((match = multiPagePattern.exec(analysisText)) !== null) {
        issues.push({
          page: `${match[1]}, ${match[2]}`,
          issue: match[3].trim(),
          type: 'multi-page'
        });
      }

      // Extract fixes section
      const fixesMatch = analysisText.match(/\*\*Fixes:?\*\*:?\s*\n([\s\S]*?)$/i);
      const fixes = [];
      if (fixesMatch) {
        // Parse numbered fixes: "1. Seite X: before → after"
        const fixPattern = /\d+\.\s*(?:Seite|Page)\s*(\d+):\s*["„]?([^"„→\n]+)[""]?\s*→\s*(.+)/gi;
        while ((match = fixPattern.exec(fixesMatch[1])) !== null) {
          fixes.push({
            page: parseInt(match[1]),
            before: match[2].trim(),
            after: match[3].trim()
          });
        }
      }

      // Display all issues found
      console.log('## Issues Identified:\n');

      // Group by category from analysis
      const categories = {
        'Logic': /logic|timeline|motivation|physik/i,
        'Reading Level': /reading|wortzahl|vokabular/i,
        'Scene Hints': /scene|szene|charaktere|position|wetter|weather/i,
        'Banned Gestures': /banned|hand.*shoulder|schulter|ruffled|hair|patted|back/i,
        'Repeated Gestures': /repeated|wiederh|umarmung|nicken/i,
        'Clothing': /clothing|kleidung|standard|winter|costumed/i,
        'Show vs Tell': /show.*tell|trait|zeigen/i
      };

      // Extract category sections
      const sectionPattern = /\d+\.\s*\*\*([^*]+)\*\*\s*\n([\s\S]*?)(?=\n\d+\.\s*\*\*|\*\*Fixes|\n---|\n$)/gi;
      while ((match = sectionPattern.exec(analysisText)) !== null) {
        const category = match[1].trim();
        const content = match[2].trim();

        // Check if this section has issues (not all ✓)
        const hasIssue = !content.split('\n').every(line =>
          line.includes('✓') || line.includes('✔') || line.trim() === ''
        );

        const status = hasIssue ? '⚠️' : '✅';
        console.log(`${status} **${category}**`);

        // Show details for sections with issues
        if (hasIssue) {
          const lines = content.split('\n').filter(l => l.trim());
          for (const line of lines) {
            const isOk = line.includes('✓') || line.includes('✔');
            if (!isOk) {
              console.log(`   ${line.trim()}`);
            }
          }
        }
        console.log();
      }

      // =========================================================================
      // SECTION 2: SHOW FIXES WITH BEFORE/AFTER
      // =========================================================================

      if (fixes.length > 0) {
        console.log('\n## Fixes Applied:\n');

        for (const fix of fixes) {
          console.log(`### Page ${fix.page}`);
          console.log();
          console.log(`**Before:** "${fix.before}"`);
          console.log(`**After:**  "${fix.after}"`);

          // Check if fix was applied in final story
          const pagePattern = new RegExp(`--- Page ${fix.page} ---\\s*\\n([\\s\\S]*?)(?=--- Page \\d+ ---|$)`, 'i');
          const pageMatch = storyStr.match(pagePattern);
          if (pageMatch) {
            const pageText = pageMatch[1].toLowerCase();
            // Check if the problematic phrase still exists
            // Extract the key problematic words (exclude common words like "Sophie", "sagte")
            const commonWords = ['sophie', 'lukas', 'manuel', 'franziska', 'roger', 'sagte', 'fragte', 'rief'];
            const beforeLower = fix.before.toLowerCase();

            // Check for specific banned patterns in the before text
            const bannedInBefore = [
              /hand.*schulter/, /arm.*um/, /umarmte/, /wuschelte.*haar/,
              /klopfte.*rücken/, /nickte.*wissend/, /praktisch/
            ].some(p => p.test(beforeLower));

            let isFixed = true;
            if (bannedInBefore) {
              // Check if the banned pattern exists in final
              isFixed = ![
                /hand.*schulter/, /arm.*um.*schulter/, /umarmte.*kurz/,
                /wuschelte.*haar/, /klopfte.*rücken/, /nickte.*wissend/,
                /sagte.*praktisch/
              ].some(p => p.test(pageText));
            }

            if (isFixed) {
              console.log(`**Status:** ✅ Fixed in final`);
            } else {
              console.log(`**Status:** ❌ Not fixed - problematic phrase still exists`);
            }

            // Show relevant excerpt from final
            console.log(`**Final text excerpt:**`);
            // Try to find context around where the fix should be
            const excerpt = pageText.substring(0, 300);
            console.log(`   "${excerpt}${pageText.length > 300 ? '...' : ''}"`);
          }
          console.log();
          console.log('-'.repeat(60));
          console.log();
        }
      }
    }

    // =========================================================================
    // SECTION 3: BANNED GESTURE SCAN ON FINAL STORY
    // =========================================================================

    console.log('\n# BANNED GESTURE SCAN (Final Story)\n');

    const bannedPatterns = [
      { pattern: /hand.{0,15}schulter/gi, name: 'Hand on shoulder' },
      { pattern: /arm.{0,10}um.{0,15}schulter/gi, name: 'Arm around shoulders' },
      { pattern: /wuschelte.{0,10}haar/gi, name: 'Ruffled hair' },
      { pattern: /klopfte.{0,15}rücken/gi, name: 'Patted on back' },
      { pattern: /nickte.{0,10}wissend/gi, name: 'Nodded wisely' },
      { pattern: /legte.{0,10}arm.{0,10}um/gi, name: 'Put arm around' }
    ];

    let foundBanned = false;
    for (const { pattern, name } of bannedPatterns) {
      const matches = storyStr.match(pattern);
      if (matches) {
        console.log(`❌ ${name}: FOUND "${matches.join('", "')}""`);
        foundBanned = true;
      } else {
        console.log(`✅ ${name}: Clean`);
      }
    }

    if (!foundBanned) {
      console.log('\n✅ All banned gestures successfully removed!');
    }

    // =========================================================================
    // SECTION 4: SUMMARY
    // =========================================================================

    console.log('\n' + '='.repeat(80));
    console.log('# SUMMARY\n');

    // Count pages
    const pageMatches = storyStr.match(/--- Page \d+ ---/g);
    console.log(`Total pages: ${pageMatches ? pageMatches.length : 0}`);
    console.log(`Banned gestures remaining: ${foundBanned ? 'Some found' : '0 (all clean)'}`);

  } catch (e) {
    console.error('Error:', e.message);
    console.error(e.stack);
  }

  await pool.end();
}

main();
