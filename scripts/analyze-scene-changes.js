#!/usr/bin/env node
require('dotenv').config();
const pg = require('pg');

const jobId = process.argv[2] || 'job_1769373235483_1cazuipuh';
const pageFilter = process.argv[3] ? parseInt(process.argv[3]) : null;

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function compareFields(draft, output, path = '') {
  const changes = [];

  if (typeof draft !== typeof output) {
    changes.push({ path, draft, output });
    return changes;
  }

  if (Array.isArray(draft)) {
    const maxLen = Math.max(draft.length, output.length);
    for (let i = 0; i < maxLen; i++) {
      if (i >= draft.length) {
        changes.push({ path: `${path}[${i}]`, draft: '(missing)', output: JSON.stringify(output[i]).substring(0, 100) });
      } else if (i >= output.length) {
        changes.push({ path: `${path}[${i}]`, draft: JSON.stringify(draft[i]).substring(0, 100), output: '(removed)' });
      } else {
        changes.push(...compareFields(draft[i], output[i], `${path}[${i}]`));
      }
    }
  } else if (typeof draft === 'object' && draft !== null) {
    const allKeys = new Set([...Object.keys(draft || {}), ...Object.keys(output || {})]);
    for (const key of allKeys) {
      const newPath = path ? `${path}.${key}` : key;
      if (!(key in draft)) {
        changes.push({ path: newPath, draft: '(missing)', output: JSON.stringify(output[key]).substring(0, 80) });
      } else if (!(key in output)) {
        changes.push({ path: newPath, draft: JSON.stringify(draft[key]).substring(0, 80), output: '(removed)' });
      } else {
        changes.push(...compareFields(draft[key], output[key], newPath));
      }
    }
  } else if (draft !== output) {
    changes.push({ path, draft, output });
  }

  return changes;
}

(async () => {
  const result = await pool.query(
    `SELECT result_data->'sceneDescriptions' as scenes, result_data->'title' as title FROM story_jobs WHERE id = $1`,
    [jobId]
  );

  if (!result.rows.length || !result.rows[0].scenes) {
    // Try stories table
    const storyResult = await pool.query(
      `SELECT data->'sceneDescriptions' as scenes, data->'title' as title FROM stories WHERE id = $1`,
      [jobId]
    );
    if (!storyResult.rows.length || !storyResult.rows[0].scenes) {
      console.log('Story not found');
      await pool.end();
      return;
    }
    result.rows = storyResult.rows;
  }

  const scenes = result.rows[0].scenes;
  console.log('# Scene Analysis:', result.rows[0].title);
  console.log('Job ID:', jobId);
  console.log('Total scenes:', scenes.length);
  console.log('');

  let totalIssues = 0;
  let pagesWithIssues = 0;

  scenes.forEach((scene, i) => {
    const pageNum = i + 1;
    if (pageFilter && pageNum !== pageFilter) return;

    const descMatch = scene.description?.match(/```json\n([\s\S]*?)\n```/);
    if (!descMatch) {
      console.log(`## Page ${pageNum}: no JSON found`);
      return;
    }

    try {
      const parsed = JSON.parse(descMatch[1]);
      const draft = parsed.draft;
      const output = parsed.output;
      const critique = parsed.critique || {};
      const issues = critique.issues || [];
      const corrections = critique.corrections || [];

      console.log(`## Page ${pageNum}`);
      console.log('');

      if (issues.length === 0) {
        console.log('**Status:** Draft was correct (no changes needed)');
        console.log('');
        return;
      }

      totalIssues += issues.length;
      pagesWithIssues++;

      console.log(`**Issues Found:** ${issues.length}`);
      issues.forEach((issue, j) => console.log(`${j + 1}. ${issue}`));
      console.log('');

      console.log('**Corrections Applied:**');
      corrections.forEach((corr, j) => console.log(`${j + 1}. ${corr}`));
      console.log('');

      // Compare draft vs output
      if (draft && output) {
        console.log('**Field Changes (Draft → Output):**');

        // Compare imageSummary
        if (draft.imageSummary !== output.imageSummary) {
          console.log('');
          console.log('`imageSummary`:');
          console.log(`  - Draft: "${draft.imageSummary?.substring(0, 120)}..."`);
          console.log(`  - Output: "${output.imageSummary?.substring(0, 120)}..."`);
        }

        // Compare setting fields
        const settingChanges = compareFields(draft.setting || {}, output.setting || {}, 'setting');
        if (settingChanges.length > 0) {
          console.log('');
          console.log('`setting`:');
          settingChanges.forEach(c => {
            console.log(`  - ${c.path}: "${c.draft}" → "${c.output}"`);
          });
        }

        // Compare characters
        const draftChars = draft.characters || [];
        const outputChars = output.characters || [];

        // Check for added/removed characters
        const draftNames = draftChars.map(c => c.name);
        const outputNames = outputChars.map(c => c.name);
        const addedChars = outputNames.filter(n => !draftNames.includes(n));
        const removedChars = draftNames.filter(n => !outputNames.includes(n));

        if (addedChars.length || removedChars.length) {
          console.log('');
          console.log('`characters` (added/removed):');
          if (addedChars.length) console.log(`  + Added: ${addedChars.join(', ')}`);
          if (removedChars.length) console.log(`  - Removed: ${removedChars.join(', ')}`);
        }

        // Compare matching characters
        draftChars.forEach(draftChar => {
          const outputChar = outputChars.find(c => c.name === draftChar.name);
          if (outputChar) {
            const charChanges = [];
            ['position', 'pose', 'action', 'expression', 'clothing'].forEach(field => {
              if (draftChar[field] !== outputChar[field]) {
                charChanges.push({ field, draft: draftChar[field], output: outputChar[field] });
              }
            });
            // Check holding
            if (JSON.stringify(draftChar.holding) !== JSON.stringify(outputChar.holding)) {
              charChanges.push({
                field: 'holding',
                draft: JSON.stringify(draftChar.holding),
                output: JSON.stringify(outputChar.holding)
              });
            }

            if (charChanges.length > 0) {
              console.log('');
              console.log(`\`${draftChar.name}\`:`);
              charChanges.forEach(c => {
                console.log(`  - ${c.field}: "${c.draft}" → "${c.output}"`);
              });
            }
          }
        });

        // Compare objects
        const draftObjs = draft.objects || [];
        const outputObjs = output.objects || [];
        const objChanges = compareFields(draftObjs, outputObjs, 'objects');
        if (objChanges.length > 0) {
          console.log('');
          console.log('`objects`:');
          objChanges.forEach(c => {
            console.log(`  - ${c.path}: "${c.draft}" → "${c.output}"`);
          });
        }
      }

      console.log('');
      console.log('---');
      console.log('');

    } catch (e) {
      console.log(`## Page ${pageNum}: parse error - ${e.message}`);
    }
  });

  if (!pageFilter) {
    console.log('## Summary');
    console.log(`- Pages with issues: ${pagesWithIssues}/${scenes.length} (${Math.round((1 - pagesWithIssues/scenes.length) * 100)}% draft accuracy)`);
    console.log(`- Total issues found: ${totalIssues}`);
  }

  await pool.end();
})();
