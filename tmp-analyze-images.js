const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function analyze() {
  // Get a sample of image sizes
  const result = await pool.query(`
    SELECT
      image_type,
      page_number,
      version_index,
      LENGTH(image_data) as size_bytes,
      LEFT(image_data, 30) as data_prefix
    FROM story_images
    ORDER BY LENGTH(image_data) DESC
    LIMIT 20
  `);

  console.log('Top 20 largest images:');
  result.rows.forEach(r => {
    const sizeMB = (r.size_bytes / 1024 / 1024).toFixed(2);
    const sizeKB = (r.size_bytes / 1024).toFixed(0);
    const format = r.data_prefix.includes('png') ? 'PNG' : r.data_prefix.includes('jpeg') ? 'JPEG' : 'unknown';
    console.log(`  ${r.image_type} p${r.page_number || '-'} v${r.version_index}: ${sizeKB}KB (${sizeMB}MB) - ${format}`);
  });

  // Get totals by format
  const totals = await pool.query(`
    SELECT
      CASE WHEN image_data LIKE '%png%' THEN 'PNG' ELSE 'JPEG' END as format,
      COUNT(*) as count,
      SUM(LENGTH(image_data)) as total_bytes
    FROM story_images
    GROUP BY CASE WHEN image_data LIKE '%png%' THEN 'PNG' ELSE 'JPEG' END
  `);

  console.log('\nTotals by format:');
  totals.rows.forEach(r => {
    const totalMB = (r.total_bytes / 1024 / 1024).toFixed(1);
    console.log(`  ${r.format}: ${r.count} images, ${totalMB}MB total`);
  });

  await pool.end();
}

analyze().catch(e => console.error(e));
