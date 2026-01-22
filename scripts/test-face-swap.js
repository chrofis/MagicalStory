/**
 * Face Swap Test Script using ACE++ local_editing
 *
 * Usage:
 *   node scripts/test-face-swap.js <source-image> <reference-face> [options]
 *
 * Options:
 *   --mask=x,y,w,h    Mask region as percentages (e.g., 20,10,30,40)
 *   --autodetect      Auto-detect face region using Python service
 *   --strength=0.85   How much to change (0-1, default 0.85)
 *   --output=result   Output filename prefix
 *
 * Examples:
 *   node scripts/test-face-swap.js page01.jpg avatar.jpg --mask=20,10,30,40
 *   node scripts/test-face-swap.js page01.jpg avatar.jpg --autodetect
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const crypto = require('crypto');

const RUNWARE_API_KEY = process.env.RUNWARE_API_KEY;
const RUNWARE_API_URL = 'https://api.runware.ai/v1';
const PYTHON_SERVICE_URL = process.env.PHOTO_ANALYZER_URL || 'http://localhost:5000';

async function detectFace(imageBuffer) {
  // Call Python service to detect face
  const response = await fetch(`${PYTHON_SERVICE_URL}/detect-face`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image: `data:image/png;base64,${imageBuffer.toString('base64')}`
    })
  });

  if (!response.ok) {
    throw new Error(`Face detection failed: ${response.status}`);
  }

  const result = await response.json();
  if (!result.faces || result.faces.length === 0) {
    throw new Error('No faces detected');
  }

  // Return largest face bounding box (as percentages)
  const face = result.faces[0];
  return {
    x: face.x * 100,
    y: face.y * 100,
    w: face.width * 100,
    h: face.height * 100
  };
}

async function createMask(width, height, region, padding = 0.1) {
  // Add padding around the face region
  const paddingX = region.w * padding;
  const paddingY = region.h * padding;

  const x = Math.max(0, Math.round(((region.x - paddingX) / 100) * width));
  const y = Math.max(0, Math.round(((region.y - paddingY) / 100) * height));
  const w = Math.min(width - x, Math.round(((region.w + paddingX * 2) / 100) * width));
  const h = Math.min(height - y, Math.round(((region.h + paddingY * 2) / 100) * height));

  // Create black background with white rectangle for inpaint area
  const mask = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 0, g: 0, b: 0 }
    }
  })
  .composite([{
    input: await sharp({
      create: {
        width: w,
        height: h,
        channels: 3,
        background: { r: 255, g: 255, b: 255 }
      }
    }).png().toBuffer(),
    left: x,
    top: y
  }])
  .png()
  .toBuffer();

  return mask;
}

async function faceSwapWithACE(seedImage, referenceImage, maskImage, options = {}) {
  const {
    strength = 0.85,
    identityStrength = 0.9,
    width = 1024,
    height = 1024
  } = options;

  const taskUUID = crypto.randomUUID();

  // Convert to data URIs
  const seedDataUri = `data:image/png;base64,${seedImage.toString('base64')}`;
  const maskDataUri = `data:image/png;base64,${maskImage.toString('base64')}`;
  const refDataUri = `data:image/png;base64,${referenceImage.toString('base64')}`;

  // ACE++ local_editing request
  const payload = [{
    taskType: 'imageInference',
    taskUUID: taskUUID,
    positivePrompt: 'face portrait, same person, natural lighting, high quality',
    model: 'runware:102@1',  // FLUX Fill
    seedImage: seedDataUri,
    maskImage: maskDataUri,
    strength: strength,
    width: width,
    height: height,
    outputFormat: 'PNG',
    numberResults: 1,
    referenceImages: [refDataUri],
    acePlusPlus: {
      type: 'local_editing',
      identityStrength: identityStrength
    }
  }];

  console.log('\n--- ACE++ Face Swap Request ---');
  console.log(`Task UUID: ${taskUUID.slice(0, 8)}...`);
  console.log(`Size: ${width}x${height}`);
  console.log(`Strength: ${strength}`);
  console.log(`Identity Strength: ${identityStrength}`);
  console.log('-------------------------------\n');

  const startTime = Date.now();

  const response = await fetch(RUNWARE_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RUNWARE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API error ${response.status}: ${errorText}`);
  }

  const result = await response.json();
  const elapsed = Date.now() - startTime;

  console.log('Response:', JSON.stringify(result, null, 2).slice(0, 500));

  if (result.errors && result.errors.length > 0) {
    throw new Error(`Task error: ${JSON.stringify(result.errors)}`);
  }

  if (result.data && result.data.length > 0) {
    const imageResult = result.data.find(d => d.taskUUID === taskUUID);

    if (!imageResult) {
      throw new Error('No result for task');
    }

    if (imageResult.error) {
      throw new Error(`Task error: ${imageResult.error}`);
    }

    let imageData = imageResult.imageBase64 || imageResult.imageURL;

    // Download if URL
    if (imageData && imageData.startsWith('http')) {
      console.log('Downloading result from URL...');
      const imgResponse = await fetch(imageData);
      const buffer = await imgResponse.arrayBuffer();
      imageData = Buffer.from(buffer);
    } else if (imageData) {
      imageData = Buffer.from(imageData, 'base64');
    }

    console.log(`\n--- Result ---`);
    console.log(`Time: ${elapsed}ms`);
    console.log(`Cost: ~$0.05`);
    console.log(`--------------\n`);

    return imageData;
  }

  throw new Error('No result returned from API');
}

async function runTest() {
  const args = process.argv.slice(2);

  if (args.length < 2 || args[0] === '--help') {
    console.log(`
Face Swap Test using ACE++ local_editing

Usage:
  node scripts/test-face-swap.js <source-image> <reference-face> [options]

Options:
  --mask=x,y,w,h    Mask region as percentages (e.g., 20,10,30,40)
  --autodetect      Auto-detect face using Python service
  --strength=0.85   Inpaint strength (default: 0.85)
  --id=0.9          Identity preservation strength (default: 0.9)
  --output=result   Output filename prefix

Examples:
  node scripts/test-face-swap.js output/faceswap-test/pages/page01.jpg output/faceswap-test/avatars/Noel/base_standard.jpg --mask=20,10,30,50
    `);
    return;
  }

  if (!RUNWARE_API_KEY) {
    console.error('Error: RUNWARE_API_KEY not set');
    process.exit(1);
  }

  const sourcePath = args[0];
  const refPath = args[1];

  if (!fs.existsSync(sourcePath)) {
    console.error(`Source image not found: ${sourcePath}`);
    process.exit(1);
  }

  if (!fs.existsSync(refPath)) {
    console.error(`Reference image not found: ${refPath}`);
    process.exit(1);
  }

  // Parse options
  const options = {
    mask: null,
    autodetect: false,
    strength: 0.85,
    identityStrength: 0.9,
    output: 'faceswap-result'
  };

  for (const arg of args.slice(2)) {
    if (arg === '--autodetect') options.autodetect = true;
    else if (arg.startsWith('--mask=')) options.mask = arg.slice(7);
    else if (arg.startsWith('--strength=')) options.strength = parseFloat(arg.slice(11));
    else if (arg.startsWith('--id=')) options.identityStrength = parseFloat(arg.slice(5));
    else if (arg.startsWith('--output=')) options.output = arg.slice(9);
  }

  // Load images
  console.log(`Loading source: ${sourcePath}`);
  const sourceBuffer = fs.readFileSync(sourcePath);
  const sourceMeta = await sharp(sourceBuffer).metadata();
  console.log(`Source size: ${sourceMeta.width}x${sourceMeta.height}`);

  console.log(`Loading reference: ${refPath}`);
  const refBuffer = fs.readFileSync(refPath);
  const refMeta = await sharp(refBuffer).metadata();
  console.log(`Reference size: ${refMeta.width}x${refMeta.height}`);

  // Resize source to 1024 max
  let processedSource = sourceBuffer;
  let width = sourceMeta.width;
  let height = sourceMeta.height;

  if (width > 1024 || height > 1024) {
    console.log('Resizing source to fit 1024px...');
    processedSource = await sharp(sourceBuffer)
      .resize(1024, 1024, { fit: 'inside' })
      .png()
      .toBuffer();
    const newMeta = await sharp(processedSource).metadata();
    width = newMeta.width;
    height = newMeta.height;
    console.log(`Resized to: ${width}x${height}`);
  }

  // Get face region
  let faceRegion;

  if (options.autodetect) {
    console.log('\nAuto-detecting face...');
    try {
      faceRegion = await detectFace(processedSource);
      console.log(`Detected face at: x=${faceRegion.x.toFixed(1)}%, y=${faceRegion.y.toFixed(1)}%, w=${faceRegion.w.toFixed(1)}%, h=${faceRegion.h.toFixed(1)}%`);
    } catch (e) {
      console.error('Face detection failed:', e.message);
      console.log('Using default mask region (center)');
      faceRegion = { x: 25, y: 10, w: 50, h: 50 };
    }
  } else if (options.mask) {
    const [mx, my, mw, mh] = options.mask.split(',').map(Number);
    faceRegion = { x: mx, y: my, w: mw, h: mh };
    console.log(`Using manual mask: x=${mx}%, y=${my}%, w=${mw}%, h=${mh}%`);
  } else {
    console.log('Using default mask (center of image)');
    faceRegion = { x: 25, y: 10, w: 50, h: 50 };
  }

  // Create mask
  console.log('\nCreating mask...');
  const maskBuffer = await createMask(width, height, faceRegion);

  // Save mask for debugging
  const outputDir = path.dirname(options.output) || 'output';
  if (!fs.existsSync(outputDir) && outputDir !== '.') {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const maskPath = `${options.output}-mask.png`;
  fs.writeFileSync(maskPath, maskBuffer);
  console.log(`Mask saved to: ${maskPath}`);

  // Process reference image (resize to reasonable size)
  let processedRef = refBuffer;
  if (refMeta.width > 768 || refMeta.height > 768) {
    processedRef = await sharp(refBuffer)
      .resize(768, 768, { fit: 'inside' })
      .png()
      .toBuffer();
  }

  // Run face swap
  console.log('\nStarting ACE++ face swap...');

  try {
    const result = await faceSwapWithACE(processedSource, processedRef, maskBuffer, {
      strength: options.strength,
      identityStrength: options.identityStrength,
      width: width,
      height: height
    });

    const outputPath = `${options.output}.png`;
    fs.writeFileSync(outputPath, result);
    console.log(`Result saved to: ${outputPath}`);

    // Create comparison image
    const comparisonPath = `${options.output}-comparison.png`;
    await sharp({
      create: {
        width: width * 3 + 20,
        height: height + Math.max(refMeta.height, 0),
        channels: 3,
        background: { r: 40, g: 40, b: 40 }
      }
    })
    .composite([
      { input: processedSource, left: 0, top: 0 },
      { input: maskBuffer, left: width + 10, top: 0 },
      { input: result, left: (width + 10) * 2, top: 0 },
      { input: processedRef, left: 0, top: height + 10 }
    ])
    .png()
    .toFile(comparisonPath);

    console.log(`Comparison saved to: ${comparisonPath}`);
    console.log('\nDone!');

  } catch (error) {
    console.error('\nFace swap failed:', error.message);
    process.exit(1);
  }
}

runTest().catch(console.error);
