/**
 * PuLID 4-View Character Sheet Test
 * Generates all 4 quadrants for a character sheet using PuLID
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { generateWithPuLID } = require('../server/lib/runware');

const VIEWS = [
  { name: 'front-face', prompt: 'professional portrait photo, close-up headshot, front view, looking directly at camera, friendly expression, soft studio lighting, light gray background, sharp focus, high detail, 8k quality, photorealistic' },
  { name: 'three-quarter-face', prompt: 'professional portrait photo, close-up headshot, 3/4 angle view, face turned slightly right, looking at camera, friendly expression, soft studio lighting, light gray background, sharp focus, high detail, 8k quality, photorealistic' }
];

async function generateCharacterSheet(imagePath, outputPrefix) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Generating 4 views for: ${path.basename(imagePath)}`);
  console.log('='.repeat(60));

  // Load image
  const imageBuffer = fs.readFileSync(imagePath);
  const ext = path.extname(imagePath).toLowerCase();
  const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
  const imageData = `data:${mimeType};base64,${imageBuffer.toString('base64')}`;
  console.log(`Loaded: ${Math.round(imageBuffer.length / 1024)}KB\n`);

  const results = [];
  let totalCost = 0;
  const startTime = Date.now();

  for (const view of VIEWS) {
    console.log(`Generating ${view.name}...`);
    const viewStart = Date.now();

    try {
      const result = await generateWithPuLID(imageData, view.prompt, {
        width: 1024,
        height: 1024,
        idWeight: 1.0,
        steps: 30  // More steps for sharper output
      });

      const elapsed = Date.now() - viewStart;
      totalCost += result.usage.cost;

      // Save output
      const outputDir = path.join(__dirname, '..', 'test-output');
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
      const outputPath = path.join(outputDir, `${outputPrefix}-${view.name}.png`);
      let base64 = result.imageData;
      if (base64.startsWith('data:')) {
        base64 = base64.split(',')[1];
      }
      fs.writeFileSync(outputPath, Buffer.from(base64, 'base64'));

      console.log(`  ✓ ${view.name}: ${(elapsed/1000).toFixed(1)}s, $${result.usage.cost.toFixed(4)}`);
      results.push({ view: view.name, success: true, path: outputPath });

    } catch (error) {
      console.log(`  ✗ ${view.name}: ${error.message}`);
      results.push({ view: view.name, success: false, error: error.message });
    }
  }

  const totalTime = (Date.now() - startTime) / 1000;
  console.log(`\nComplete: ${totalTime.toFixed(1)}s total, $${totalCost.toFixed(4)} total cost`);
  console.log(`Output files: ${outputPrefix}-*.png`);

  return { results, totalCost, totalTime };
}

async function main() {
  const manuel = 'C:/Users/roger/OneDrive/Pictures/Manuel2.jpg';
  const franziska = 'C:/Users/roger/OneDrive/Pictures/Franziska.jpg';

  console.log('PuLID 4-View Character Sheet Test');
  console.log('==================================\n');

  // Generate for Manuel
  await generateCharacterSheet(manuel, 'manuel');

  // Generate for Franziska
  await generateCharacterSheet(franziska, 'franziska');

  console.log('\n' + '='.repeat(60));
  console.log('All done! Check the output files:');
  console.log('  manuel-front-face.png, manuel-three-quarter-face.png, etc.');
  console.log('  franziska-front-face.png, franziska-three-quarter-face.png, etc.');
  console.log('='.repeat(60));
}

main().catch(console.error);
