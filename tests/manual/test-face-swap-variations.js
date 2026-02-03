/**
 * Face Swap Variations Test
 *
 * Tests different approaches to optimize face swap quality:
 * 1. Single frontal face vs multiple angles
 * 2. Cropped face vs full photo
 * 3. Multiple iterations for multi-face scenes
 *
 * Usage:
 *   node tests/manual/test-face-swap-variations.js
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

require('dotenv').config();

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const MODEL_VERSION = '278a81e7ebb22db98bcba54de985d22cc1abeead2754eb1f2af717247be69b34';

function imageToDataUri(imagePath) {
  const buffer = fs.readFileSync(imagePath);
  const ext = path.extname(imagePath).toLowerCase();
  const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

function bufferToDataUri(buffer, mimeType = 'image/png') {
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

async function runFaceSwap(targetImage, sourceImage, label) {
  console.log(`\n--- ${label} ---`);

  const startTime = Date.now();

  // Create prediction
  const createResponse = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${REPLICATE_API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      version: MODEL_VERSION,
      input: {
        input_image: targetImage,
        swap_image: sourceImage
      }
    })
  });

  if (!createResponse.ok) {
    const error = await createResponse.text();
    throw new Error(`Create error: ${error}`);
  }

  const prediction = await createResponse.json();
  console.log(`Prediction ID: ${prediction.id}`);

  // Poll for completion
  let result = prediction;
  while (result.status !== 'succeeded' && result.status !== 'failed') {
    await new Promise(r => setTimeout(r, 2000));
    const pollResponse = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
      headers: { 'Authorization': `Bearer ${REPLICATE_API_TOKEN}` }
    });
    result = await pollResponse.json();
    process.stdout.write('.');
  }
  console.log('');

  if (result.status === 'failed') {
    throw new Error(`Failed: ${result.error}`);
  }

  const elapsed = Date.now() - startTime;
  console.log(`Time: ${elapsed}ms`);

  // Download result
  const imageResponse = await fetch(result.output);
  const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());

  return imageBuffer;
}

async function cropFaceRegion(imagePath, region) {
  // region = {x, y, w, h} as percentages
  const image = sharp(fs.readFileSync(imagePath));
  const meta = await image.metadata();

  const left = Math.round((region.x / 100) * meta.width);
  const top = Math.round((region.y / 100) * meta.height);
  const width = Math.round((region.w / 100) * meta.width);
  const height = Math.round((region.h / 100) * meta.height);

  return await image.extract({ left, top, width, height }).toBuffer();
}

async function createComparisonGrid(images, outputPath, cols = 3) {
  const cellSize = 400;
  const gap = 4;
  const rows = Math.ceil(images.length / cols);

  const resized = await Promise.all(images.map(async img => {
    return await sharp(img.buffer)
      .resize(cellSize, cellSize, { fit: 'contain', background: { r: 30, g: 30, b: 30 } })
      .toBuffer();
  }));

  const totalWidth = cols * cellSize + (cols - 1) * gap;
  const totalHeight = rows * cellSize + (rows - 1) * gap;

  let composite = [];
  for (let i = 0; i < resized.length; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    composite.push({
      input: resized[i],
      left: col * (cellSize + gap),
      top: row * (cellSize + gap)
    });
  }

  await sharp({
    create: { width: totalWidth, height: totalHeight, channels: 3, background: { r: 30, g: 30, b: 30 } }
  })
  .composite(composite)
  .png()
  .toFile(outputPath);

  console.log(`\nGrid saved: ${outputPath}`);
}

async function runTests() {
  if (!REPLICATE_API_TOKEN) {
    console.error('REPLICATE_API_TOKEN not set');
    process.exit(1);
  }

  const targetScene = 'tests/fixtures/bbox-crops/page13_original.png';
  const sophiePhoto = 'tests/fixtures/characters/Sophie.jpg';

  console.log('=== Face Swap Optimization Tests ===\n');
  console.log('Target scene:', targetScene);
  console.log('Source face:', sophiePhoto);

  const results = [];

  // Load original for comparison
  results.push({ label: 'Original Scene', buffer: fs.readFileSync(targetScene) });
  results.push({ label: 'Sophie Reference', buffer: fs.readFileSync(sophiePhoto) });

  // ============================================
  // Test 1: Full photo as source
  // ============================================
  try {
    const result1 = await runFaceSwap(
      imageToDataUri(targetScene),
      imageToDataUri(sophiePhoto),
      'Test 1: Full photo as source'
    );
    fs.writeFileSync('tests/fixtures/test-swap-v1-fullphoto.png', result1);
    results.push({ label: 'V1: Full Photo', buffer: result1 });
  } catch (e) {
    console.error('Test 1 failed:', e.message);
  }

  // ============================================
  // Test 2: Cropped face only (just the face region from Sophie's photo)
  // ============================================
  try {
    // Sophie's face is roughly in the top-left quadrant of her reference sheet
    const croppedFace = await cropFaceRegion(sophiePhoto, { x: 5, y: 5, w: 45, h: 50 });
    fs.writeFileSync('tests/fixtures/test-swap-cropped-face.png', croppedFace);

    const result2 = await runFaceSwap(
      imageToDataUri(targetScene),
      bufferToDataUri(croppedFace),
      'Test 2: Cropped face only'
    );
    fs.writeFileSync('tests/fixtures/test-swap-v2-cropped.png', result2);
    results.push({ label: 'V2: Cropped Face', buffer: result2 });
  } catch (e) {
    console.error('Test 2 failed:', e.message);
  }

  // ============================================
  // Test 3: Two iterations (swap result again to catch missed faces)
  // ============================================
  try {
    // First pass
    const pass1 = await runFaceSwap(
      imageToDataUri(targetScene),
      imageToDataUri(sophiePhoto),
      'Test 3a: First iteration'
    );

    // Second pass on the result
    const pass2 = await runFaceSwap(
      bufferToDataUri(pass1),
      imageToDataUri(sophiePhoto),
      'Test 3b: Second iteration'
    );
    fs.writeFileSync('tests/fixtures/test-swap-v3-twopass.png', pass2);
    results.push({ label: 'V3: Two Passes', buffer: pass2 });
  } catch (e) {
    console.error('Test 3 failed:', e.message);
  }

  // ============================================
  // Test 4: Target just one person (crop scene to right half, swap, composite back)
  // ============================================
  try {
    // Crop right side of scene (the woman)
    const sceneBuffer = fs.readFileSync(targetScene);
    const sceneMeta = await sharp(sceneBuffer).metadata();

    const rightHalf = await sharp(sceneBuffer)
      .extract({
        left: Math.round(sceneMeta.width * 0.45),
        top: 0,
        width: Math.round(sceneMeta.width * 0.55),
        height: sceneMeta.height
      })
      .toBuffer();
    fs.writeFileSync('tests/fixtures/test-swap-righthalf.png', rightHalf);

    // Swap face on cropped region
    const swappedRight = await runFaceSwap(
      bufferToDataUri(rightHalf),
      imageToDataUri(sophiePhoto),
      'Test 4: Swap on cropped region (right person only)'
    );

    // Composite back
    const finalComposite = await sharp(sceneBuffer)
      .composite([{
        input: swappedRight,
        left: Math.round(sceneMeta.width * 0.45),
        top: 0
      }])
      .toBuffer();

    fs.writeFileSync('tests/fixtures/test-swap-v4-selective.png', finalComposite);
    results.push({ label: 'V4: Right Person Only', buffer: finalComposite });
  } catch (e) {
    console.error('Test 4 failed:', e.message);
  }

  // ============================================
  // Test 5: Use frontal face crop only (top-left of Sophie's reference)
  // ============================================
  try {
    // The frontal smiling face is top-left in Sophie's 2x2 grid
    const frontalFace = await cropFaceRegion(sophiePhoto, { x: 0, y: 0, w: 50, h: 50 });
    fs.writeFileSync('tests/fixtures/test-swap-frontal-only.png', frontalFace);

    const result5 = await runFaceSwap(
      imageToDataUri(targetScene),
      bufferToDataUri(frontalFace),
      'Test 5: Frontal face only (from grid)'
    );
    fs.writeFileSync('tests/fixtures/test-swap-v5-frontal.png', result5);
    results.push({ label: 'V5: Frontal Only', buffer: result5 });
  } catch (e) {
    console.error('Test 5 failed:', e.message);
  }

  // Create comparison grid
  if (results.length > 2) {
    await createComparisonGrid(results, 'tests/fixtures/test-swap-variations-grid.png', 3);
  }

  console.log('\n=== All Tests Complete ===');
  console.log('Results saved in tests/fixtures/test-swap-*.png');
}

runTests().catch(console.error);
