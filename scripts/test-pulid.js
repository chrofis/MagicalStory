/**
 * PuLID Face Identity Preservation Test
 *
 * Tests Runware's PuLID for face-consistent image generation.
 * Uses our existing RUNWARE_API_KEY - no additional API keys needed!
 *
 * Usage:
 *   node scripts/test-pulid.js <image-path-or-url> [prompt]
 *
 * Examples:
 *   node scripts/test-pulid.js ./test-photo.jpg
 *   node scripts/test-pulid.js ./test-photo.jpg "portrait as a pirate captain"
 *   node scripts/test-pulid.js https://example.com/photo.jpg "fantasy warrior"
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { generateWithPuLID, generateAvatarWithACE, isRunwareConfigured } = require('../server/lib/runware');

// Check for API key
if (!isRunwareConfigured()) {
  console.error('Error: RUNWARE_API_KEY not found in environment');
  console.error('Add to .env: RUNWARE_API_KEY=your-key');
  process.exit(1);
}

async function testPuLID() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: node scripts/test-pulid.js <image-path-or-url> [prompt]');
    console.log('');
    console.log('Examples:');
    console.log('  node scripts/test-pulid.js ./test-photo.jpg');
    console.log('  node scripts/test-pulid.js photo.jpg "portrait as medieval knight"');
    console.log('');
    console.log('Options:');
    console.log('  --ace    Use ACE++ instead of PuLID for comparison');
    process.exit(1);
  }

  const useACE = args.includes('--ace');
  const filteredArgs = args.filter(a => !a.startsWith('--'));
  const imageInput = filteredArgs[0];
  const prompt = filteredArgs[1] || 'portrait, color, cinematic lighting, high quality, professional photo';

  console.log('='.repeat(60));
  console.log(useACE ? 'ACE++ Face Identity Test' : 'PuLID-FLUX Face Identity Test');
  console.log('='.repeat(60));
  console.log(`Input: ${imageInput}`);
  console.log(`Prompt: ${prompt}`);
  console.log('');

  // Prepare image input
  let imageData;
  if (imageInput.startsWith('http://') || imageInput.startsWith('https://')) {
    // Download URL to base64
    console.log('Downloading image from URL...');
    const response = await fetch(imageInput);
    const buffer = Buffer.from(await response.arrayBuffer());
    const mimeType = response.headers.get('content-type') || 'image/jpeg';
    imageData = `data:${mimeType};base64,${buffer.toString('base64')}`;
    console.log(`Downloaded: ${Math.round(buffer.length / 1024)}KB`);
  } else {
    // Read local file
    const imagePath = path.resolve(imageInput);
    if (!fs.existsSync(imagePath)) {
      console.error(`File not found: ${imagePath}`);
      process.exit(1);
    }
    const imageBuffer = fs.readFileSync(imagePath);
    const ext = path.extname(imagePath).toLowerCase();
    const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
    imageData = `data:${mimeType};base64,${imageBuffer.toString('base64')}`;
    console.log(`Loaded: ${imagePath} (${Math.round(imageBuffer.length / 1024)}KB)`);
  }

  console.log('');
  console.log(`Generating with ${useACE ? 'ACE++' : 'PuLID-FLUX'}...`);
  console.log('(This typically takes 10-30 seconds)');
  console.log('');

  const startTime = Date.now();

  try {
    let result;

    if (useACE) {
      result = await generateAvatarWithACE(imageData, prompt, {
        width: 768,
        height: 1024,
        identityStrength: 0.8
      });
    } else {
      result = await generateWithPuLID(imageData, prompt, {
        width: 896,
        height: 1152,
        idWeight: 1.0,    // Identity strength (0-3)
        startStep: 0      // Apply identity from start (strongest)
      });
    }

    const elapsed = Date.now() - startTime;
    console.log(`Generation completed in ${(elapsed / 1000).toFixed(1)}s`);
    console.log('');

    // Save output
    const outputDir = path.join(__dirname, '..', 'test-output');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const outputFilename = useACE ? 'ace-test-output.png' : 'pulid-test-output.png';
    const outputPath = path.join(outputDir, outputFilename);

    // Extract base64 from data URI
    let base64Data = result.imageData;
    if (base64Data.startsWith('data:')) {
      base64Data = base64Data.split(',')[1];
    }

    const outputBuffer = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(outputPath, outputBuffer);

    console.log(`Saved to: ${outputPath}`);
    console.log(`Size: ${Math.round(outputBuffer.length / 1024)}KB`);
    console.log(`Cost: $${result.usage.cost.toFixed(4)}`);

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }

  console.log('');
  console.log('='.repeat(60));
  console.log(`Test complete! Compare ${useACE ? 'ace' : 'pulid'}-test-output.png with your input.`);
  console.log('');
  console.log('To compare both methods:');
  console.log('  node scripts/test-pulid.js photo.jpg "your prompt"');
  console.log('  node scripts/test-pulid.js photo.jpg "your prompt" --ace');
  console.log('='.repeat(60));
}

testPuLID().catch(console.error);
