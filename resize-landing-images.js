const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const imagesDir = path.join(__dirname, 'images');

// Images to resize for landing page
const imagesToResize = [
  // Section 1: Characters (3 language versions)
  { input: 'Characters and relations.jpeg', output: 'landing-characters-en.jpg' },
  { input: 'Characters and relations - DE.jpeg', output: 'landing-characters-de.jpg' },
  { input: 'Characters and relations - FR.jpeg', output: 'landing-characters-fr.jpg' },
  // Section 2: Story plot
  { input: 'story plot.jpeg', output: 'landing-story.jpg' },
  // Section 3: Art styles
  { input: 'art styles.jpeg', output: 'landing-styles.jpg' },
  // Section 4: Download/Print
  { input: 'download print book.jpeg', output: 'landing-print.jpg' },
];

async function resizeImages() {
  for (const img of imagesToResize) {
    const inputPath = path.join(imagesDir, img.input);
    const outputPath = path.join(imagesDir, img.output);

    if (!fs.existsSync(inputPath)) {
      console.log(`❌ Not found: ${img.input}`);
      continue;
    }

    try {
      const metadata = await sharp(inputPath).metadata();
      console.log(`📷 ${img.input}: ${metadata.width}x${metadata.height}`);

      await sharp(inputPath)
        .resize(800, null, { withoutEnlargement: true }) // Max 800px width
        .jpeg({ quality: 80 }) // Good quality, smaller file
        .toFile(outputPath);

      const stats = fs.statSync(outputPath);
      console.log(`✅ ${img.output}: ${(stats.size / 1024).toFixed(1)} KB`);
    } catch (err) {
      console.log(`❌ Error processing ${img.input}: ${err.message}`);
    }
  }
}

resizeImages().then(() => console.log('\nDone!'));
