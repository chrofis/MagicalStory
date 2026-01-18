// Extract Baden landmark photos from database and save to files
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function extractBadenPhotos() {
  const outputDir = path.join(__dirname, 'baden-landmarks');

  // Create output directory
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  try {
    const result = await pool.query(
      "SELECT city, country, language, landmarks, created_at FROM landmarks_discovery WHERE LOWER(city) = 'baden' ORDER BY language"
    );

    console.log(`Found ${result.rowCount} entries for Baden\n`);

    let photoCount = 0;
    const summary = [];

    for (const row of result.rows) {
      let landmarks = row.landmarks;
      if (typeof landmarks === 'string') {
        landmarks = JSON.parse(landmarks);
      }

      if (!Array.isArray(landmarks)) continue;

      for (const landmark of landmarks) {
        if (landmark.photoData && landmark.photoData.startsWith('data:image')) {
          photoCount++;

          // Extract image type and data
          const matches = landmark.photoData.match(/^data:image\/(\w+);base64,(.+)$/);
          if (matches) {
            const [, imageType, base64Data] = matches;
            const ext = imageType === 'jpeg' ? 'jpg' : imageType;

            // Clean filename
            const safeName = landmark.name
              .replace(/[^a-zA-Z0-9äöüÄÖÜß\s-]/g, '')
              .replace(/\s+/g, '_')
              .substring(0, 50);

            const filename = `${String(photoCount).padStart(2, '0')}_${safeName}.${ext}`;
            const filepath = path.join(outputDir, filename);

            // Save image
            const buffer = Buffer.from(base64Data, 'base64');
            fs.writeFileSync(filepath, buffer);

            const sizeKB = Math.round(buffer.length / 1024);
            console.log(`${photoCount}. ${landmark.name} [${landmark.type}] - ${sizeKB}KB -> ${filename}`);

            summary.push({
              num: photoCount,
              name: landmark.name,
              type: landmark.type || 'Unknown',
              lang: row.language,
              sizeKB,
              filename,
              hasDescription: !!landmark.photoDescription,
              description: landmark.photoDescription || null
            });
          }
        }
      }
    }

    // Write summary JSON
    const summaryPath = path.join(outputDir, '_summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

    // Write summary text
    const summaryTxtPath = path.join(outputDir, '_summary.txt');
    const summaryTxt = summary.map(s =>
      `${s.num}. ${s.name} [${s.type}] (${s.lang}) - ${s.sizeKB}KB${s.hasDescription ? ' +desc' : ''}\n   File: ${s.filename}${s.description ? `\n   Desc: ${s.description.substring(0, 100)}...` : ''}`
    ).join('\n\n');
    fs.writeFileSync(summaryTxtPath, summaryTxt);

    console.log(`\n✅ Extracted ${photoCount} photos to: ${outputDir}`);
    console.log(`   Summary: ${summaryPath}`);

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
}

extractBadenPhotos();
