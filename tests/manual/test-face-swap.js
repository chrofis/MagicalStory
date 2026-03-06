/**
 * Face Swap Test Script
 *
 * Tests TRUE face swap APIs that replace a face in an existing image
 * while preserving scene, pose, lighting, and background.
 *
 * APIs tested:
 * 1. Replicate codeplugtech/face-swap - $0.003/run, fast, CPU
 * 2. fal.ai face-swap - fast, good quality
 *
 * Usage:
 *   node tests/manual/test-face-swap.js --target=<scene> --source=<face>
 *
 * Options:
 *   --target=scene.png        Image with person to replace (the scene)
 *   --source=face.png         Face image to swap in
 *   --api=replicate|fal|all   Which API to test (default: all)
 *   --output=result.png       Output file prefix
 *
 * Examples:
 *   node tests/manual/test-face-swap.js \
 *     --target=tests/fixtures/bbox-crops/page13_original.png \
 *     --source=tests/fixtures/characters/Sophie.jpg
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

require('dotenv').config();

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const FAL_KEY = process.env.FAL_KEY;

/**
 * Upload image to temp URL for API consumption
 * Returns a data URI for APIs that accept it, or uploads to the service
 */
function imageToDataUri(imagePath) {
  const buffer = fs.readFileSync(imagePath);
  const ext = path.extname(imagePath).toLowerCase();
  const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

/**
 * Method 1: Replicate codeplugtech/face-swap
 * Cost: ~$0.003/run
 * Preserves: Background, pose, lighting
 */
async function swapWithReplicate(targetImage, sourceImage) {
  if (!REPLICATE_API_TOKEN) {
    throw new Error('REPLICATE_API_TOKEN not set');
  }

  console.log('\n--- Replicate Face Swap ---');
  console.log('Model: codeplugtech/face-swap');
  console.log('Cost: ~$0.003/run');

  const startTime = Date.now();

  // Create prediction
  const createResponse = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${REPLICATE_API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      version: '278a81e7ebb22db98bcba54de985d22cc1abeead2754eb1f2af717247be69b34',
      input: {
        input_image: imageToDataUri(targetImage),  // Scene with person
        swap_image: imageToDataUri(sourceImage)    // Face to swap in
      }
    })
  });

  if (!createResponse.ok) {
    const error = await createResponse.text();
    throw new Error(`Replicate create error: ${error}`);
  }

  const prediction = await createResponse.json();
  console.log(`Prediction ID: ${prediction.id}`);

  // Poll for completion
  let result = prediction;
  while (result.status !== 'succeeded' && result.status !== 'failed') {
    await new Promise(r => setTimeout(r, 1000));
    const pollResponse = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
      headers: { 'Authorization': `Bearer ${REPLICATE_API_TOKEN}` }
    });
    result = await pollResponse.json();
    process.stdout.write('.');
  }
  console.log('');

  const elapsed = Date.now() - startTime;

  if (result.status === 'failed') {
    throw new Error(`Replicate failed: ${result.error}`);
  }

  // Download result image
  const imageUrl = result.output;
  const imageResponse = await fetch(imageUrl);
  const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());

  console.log(`Time: ${elapsed}ms`);
  console.log(`Cost: ~$0.003`);
  console.log('---------------------------\n');

  return { imageData: imageBuffer, cost: 0.003, time: elapsed, method: 'replicate' };
}

/**
 * Method 2: fal.ai face-swap
 * Fast, good quality
 */
async function swapWithFal(targetImage, sourceImage) {
  if (!FAL_KEY) {
    throw new Error('FAL_KEY not set');
  }

  console.log('\n--- fal.ai Face Swap ---');
  console.log('Model: fal-ai/face-swap');

  const startTime = Date.now();

  // fal.ai accepts data URIs directly
  const response = await fetch('https://fal.run/fal-ai/face-swap', {
    method: 'POST',
    headers: {
      'Authorization': `Key ${FAL_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      base_image_url: imageToDataUri(targetImage),  // Scene with person
      swap_image_url: imageToDataUri(sourceImage)   // Face to swap in
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`fal.ai error: ${error}`);
  }

  const result = await response.json();
  const elapsed = Date.now() - startTime;

  // Download result image
  const imageUrl = result.image?.url || result.output?.url;
  if (!imageUrl) {
    console.log('Response:', JSON.stringify(result, null, 2));
    throw new Error('No image URL in fal.ai response');
  }

  const imageResponse = await fetch(imageUrl);
  const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());

  console.log(`Time: ${elapsed}ms`);
  console.log('------------------------\n');

  return { imageData: imageBuffer, cost: 0.01, time: elapsed, method: 'fal' };
}

/**
 * Create comparison image
 */
async function createComparison(images, outputPath) {
  const targetHeight = 512;
  const gap = 8;

  const processed = await Promise.all(images.map(async img => {
    const buf = await sharp(img.buffer).resize({ height: targetHeight }).toBuffer();
    const meta = await sharp(buf).metadata();
    return { ...img, buffer: buf, width: meta.width };
  }));

  const totalWidth = processed.reduce((sum, p) => sum + p.width, 0) + gap * (processed.length - 1);

  let composite = [];
  let x = 0;
  for (const p of processed) {
    composite.push({ input: p.buffer, left: x, top: 0 });
    x += p.width + gap;
  }

  await sharp({
    create: { width: totalWidth, height: targetHeight, channels: 3, background: { r: 30, g: 30, b: 30 } }
  })
  .composite(composite)
  .png()
  .toFile(outputPath);

  console.log(`Comparison saved: ${outputPath}`);
}

async function runTest() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help')) {
    console.log(`
Face Swap Test Script

Tests TRUE face swap APIs that preserve scene while swapping faces.

Usage:
  node tests/manual/test-face-swap.js --target=<scene> --source=<face>

Options:
  --target=scene.png        Image with person to replace
  --source=face.png         Face image to swap in
  --api=replicate|fal|all   Which API to test (default: all)
  --output=result.png       Output file prefix

APIs:
  replicate  - codeplugtech/face-swap ($0.003/run)
  fal        - fal-ai/face-swap

Environment Variables Required:
  REPLICATE_API_TOKEN  - For Replicate API
  FAL_KEY              - For fal.ai API

Example:
  node tests/manual/test-face-swap.js \\
    --target=tests/fixtures/bbox-crops/page13_original.png \\
    --source=tests/fixtures/characters/Sophie.jpg
    `);
    return;
  }

  // Parse options
  const options = {
    target: null,
    source: null,
    api: 'all',
    output: 'tests/fixtures/test-faceswap'
  };

  for (const arg of args) {
    if (arg.startsWith('--')) {
      const [key, ...valueParts] = arg.slice(2).split('=');
      const value = valueParts.join('=');
      if (key === 'target') options.target = value;
      else if (key === 'source') options.source = value;
      else if (key === 'api') options.api = value;
      else if (key === 'output') options.output = value;
    }
  }

  if (!options.target || !options.source) {
    console.error('Error: --target and --source are required');
    process.exit(1);
  }

  if (!fs.existsSync(options.target)) {
    console.error(`Error: Target not found: ${options.target}`);
    process.exit(1);
  }

  if (!fs.existsSync(options.source)) {
    console.error(`Error: Source not found: ${options.source}`);
    process.exit(1);
  }

  console.log('Face Swap Test');
  console.log('==============');
  console.log(`Target (scene): ${options.target}`);
  console.log(`Source (face): ${options.source}`);
  console.log(`APIs: ${options.api}`);
  console.log('');

  // Collect results
  const results = [];
  results.push({ label: 'Target', buffer: fs.readFileSync(options.target) });
  results.push({ label: 'Source', buffer: fs.readFileSync(options.source) });

  const apis = options.api === 'all' ? ['replicate', 'fal'] : [options.api];

  for (const api of apis) {
    try {
      let result;

      if (api === 'replicate') {
        result = await swapWithReplicate(options.target, options.source);
      } else if (api === 'fal') {
        result = await swapWithFal(options.target, options.source);
      }

      if (result) {
        const outputPath = `${options.output}-${api}.png`;
        fs.writeFileSync(outputPath, result.imageData);
        console.log(`Saved: ${outputPath}`);
        results.push({ label: api.toUpperCase(), buffer: result.imageData });
      }

    } catch (error) {
      console.error(`${api} failed:`, error.message);
    }
  }

  // Create comparison
  if (results.length > 2) {
    await createComparison(results, `${options.output}-comparison.png`);
  }

  console.log('\n=== Test Complete ===');
}

// Run
if (require.main === module) {
  runTest().catch(console.error);
}

module.exports = { swapWithReplicate, swapWithFal };
