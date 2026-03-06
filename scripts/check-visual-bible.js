require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  // Get latest story - fetch cover images structure specifically
  const result = await pool.query(`
    SELECT id, data->>'title' as title,
           jsonb_typeof(data->'coverImages'->'frontCover') as front_type,
           jsonb_typeof(data->'coverImages'->'initialPage') as initial_type,
           jsonb_typeof(data->'coverImages'->'backCover') as back_type,
           data->'coverImages'->'frontCover'->'bboxDetection' as front_bbox,
           data->'coverImages'->'initialPage'->'bboxDetection' as initial_bbox,
           data->'coverImages'->'backCover'->'bboxDetection' as back_bbox,
           length(data->'coverImages'->'frontCover'->>'imageData') as front_img_len,
           length(data->'coverImages'->'initialPage'->>'imageData') as initial_img_len,
           length(data->'coverImages'->'backCover'->>'imageData') as back_img_len,
           length(data->'coverImages'->'frontCover'->>'bboxOverlayImage') as front_overlay_len,
           length(data->'coverImages'->'initialPage'->>'bboxOverlayImage') as initial_overlay_len,
           length(data->'coverImages'->'backCover'->>'bboxOverlayImage') as back_overlay_len,
           data->'finalChecksReport'->'entity'->'grids'->0->'gridImage' IS NOT NULL as has_grid_image
    FROM stories
    ORDER BY created_at DESC
    LIMIT 1
  `);

  if (result.rows.length === 0) {
    console.log('No stories found');
    await pool.end();
    return;
  }

  const story = result.rows[0];
  console.log('Story ID:', story.id);
  console.log('Title:', story.title);

  console.log('\n=== Cover Images Structure ===');
  console.log('frontCover type:', story.front_type);
  console.log('  imageData length:', story.front_img_len || 0);
  console.log('  bboxOverlayImage length:', story.front_overlay_len || 0);
  console.log('  bboxDetection:', story.front_bbox ? 'present' : 'missing');
  if (story.front_bbox) {
    console.log('    figures:', story.front_bbox.figures?.length || 0);
  }

  console.log('\ninitialPage type:', story.initial_type);
  console.log('  imageData length:', story.initial_img_len || 0);
  console.log('  bboxOverlayImage length:', story.initial_overlay_len || 0);
  console.log('  bboxDetection:', story.initial_bbox ? 'present' : 'missing');
  if (story.initial_bbox) {
    console.log('    figures:', story.initial_bbox.figures?.length || 0);
  }

  console.log('\nbackCover type:', story.back_type);
  console.log('  imageData length:', story.back_img_len || 0);
  console.log('  bboxOverlayImage length:', story.back_overlay_len || 0);
  console.log('  bboxDetection:', story.back_bbox ? 'present' : 'missing');
  if (story.back_bbox) {
    console.log('    figures:', story.back_bbox.figures?.length || 0);
  }

  console.log('\n=== Entity Grid Images ===');
  console.log('Has grid images in report:', story.has_grid_image);

  // Now fetch the actual grid images to check their content
  const gridResult = await pool.query(`
    SELECT
      jsonb_array_length(data->'finalChecksReport'->'entity'->'grids') as grid_count,
      data->'finalChecksReport'->'entity'->'grids' as grids
    FROM stories
    WHERE id = $1
  `, [story.id]);

  if (gridResult.rows[0]?.grids) {
    const grids = gridResult.rows[0].grids;
    console.log('Grid count:', gridResult.rows[0].grid_count);

    grids.forEach((grid, i) => {
      console.log(`\nGrid ${i}: ${grid.entityName} (${grid.clothingCategory})`);
      console.log('  gridImage length:', grid.gridImage?.length || 0);
      console.log('  cellCount:', grid.cellCount);
      if (grid.manifest?.cells) {
        console.log('  manifest cells:', grid.manifest.cells.length);
        grid.manifest.cells.forEach((cell, j) => {
          const hasImage = cell.cropImage?.length > 100;
          console.log(`    [${j}] ${cell.letter} page ${cell.pageNumber} - cropImage: ${hasImage ? 'yes' : 'no'}`);
        });
      }
    });
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
