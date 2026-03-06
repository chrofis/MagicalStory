// Download Baden landmark photos from production API
const https = require('https');
const fs = require('fs');
const path = require('path');

const API_URL = 'https://www.magicalstory.ch/api/admin/landmarks-photos?city=baden&secret=clear-landmarks-2026';
const OUTPUT_DIR = path.join(__dirname, 'baden-landmarks');

async function downloadPhotos() {
  // Create output directory
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  console.log('Fetching landmark photos from API...');

  return new Promise((resolve, reject) => {
    https.get(API_URL, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);

          if (json.error) {
            console.error('API Error:', json.error);
            return reject(new Error(json.error));
          }

          console.log(`Found ${json.count} photos for ${json.city}\n`);

          const summary = [];

          json.photos.forEach((photo, i) => {
            const num = i + 1;

            // Extract image type and data
            const matches = photo.photoData.match(/^data:image\/(\w+);base64,(.+)$/);
            if (matches) {
              const [, imageType, base64Data] = matches;
              const ext = imageType === 'jpeg' ? 'jpg' : imageType;

              // Clean filename
              const safeName = photo.name
                .replace(/[^a-zA-Z0-9äöüÄÖÜß\s-]/g, '')
                .replace(/\s+/g, '_')
                .substring(0, 50);

              const filename = `${String(num).padStart(2, '0')}_${safeName}.${ext}`;
              const filepath = path.join(OUTPUT_DIR, filename);

              // Save image
              const buffer = Buffer.from(base64Data, 'base64');
              fs.writeFileSync(filepath, buffer);

              console.log(`${num}. ${photo.name} [${photo.type}] - ${photo.sizeKB}KB`);

              summary.push({
                num,
                name: photo.name,
                type: photo.type,
                locationKey: photo.locationKey,
                sizeKB: photo.sizeKB,
                filename,
                hasDescription: !!photo.photoDescription,
                description: photo.photoDescription
              });
            }
          });

          // Write summary
          const summaryPath = path.join(OUTPUT_DIR, '_summary.json');
          fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

          // Write summary text
          const summaryTxtPath = path.join(OUTPUT_DIR, '_summary.txt');
          const summaryTxt = summary.map(s =>
            `${s.num}. ${s.name} [${s.type}] - ${s.sizeKB}KB${s.hasDescription ? ' +desc' : ''}\n   File: ${s.filename}${s.description ? `\n   Desc: ${s.description}` : ''}`
          ).join('\n\n');
          fs.writeFileSync(summaryTxtPath, summaryTxt);

          console.log(`\n✅ Downloaded ${summary.length} photos to: ${OUTPUT_DIR}`);
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

// Run directly
downloadPhotos().catch(err => console.error('Error:', err.message));
