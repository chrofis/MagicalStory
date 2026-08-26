require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const storyId = process.argv[2] || 'job_1776601005131_7dxzq9184';
  const pageNumber = parseInt(process.argv[3] || '8', 10);
  const pool = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const r = await pool.query(
    `SELECT version_index, image_data FROM story_images
     WHERE story_id = $1 AND page_number = $2 AND image_type = 'scene'
     ORDER BY version_index ASC`,
    [storyId, pageNumber]
  );
  const sharp = require('sharp');
  for (const row of r.rows) {
    const b64 = row.image_data.replace(/^data:image\/[a-z]+;base64,/, '');
    const buf = Buffer.from(b64, 'base64');
    const img = sharp(buf).raw();
    const { data, info } = await img.toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    // Per-row mean brightness
    console.log(`\nv${row.version_index}: ${width}x${height}`);
    const rowMean = [];
    for (let y = 0; y < height; y++) {
      let sum = 0;
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * channels;
        sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
      }
      rowMean.push(sum / width);
    }
    // Print top 10 and bottom 10 rows
    console.log('  First 15 rows (mean brightness):');
    for (let y = 0; y < 15; y++) console.log(`    y=${y}: ${rowMean[y].toFixed(1)}`);
    console.log('  Sample around row 50:');
    for (let y = 40; y < 60; y++) console.log(`    y=${y}: ${rowMean[y].toFixed(1)}`);
    console.log(`  Middle row ${Math.floor(height / 2)}: ${rowMean[Math.floor(height / 2)].toFixed(1)}`);
    console.log('  Last 15 rows:');
    for (let y = height - 15; y < height; y++) console.log(`    y=${y}: ${rowMean[y].toFixed(1)}`);
    // Detect near-white bands (mean > 220)
    let topBand = 0;
    for (let y = 0; y < height; y++) { if (rowMean[y] > 220) topBand = y + 1; else break; }
    let bottomBand = 0;
    for (let y = height - 1; y >= 0; y--) { if (rowMean[y] > 220) bottomBand = height - y; else break; }
    console.log(`  Top bright band (>220): ${topBand}px, Bottom bright band: ${bottomBand}px`);
  }
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
