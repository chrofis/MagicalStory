/**
 * Character Replacement Test Script
 *
 * Tests inpainting-based character replacement using:
 * 1. FLUX Fill - Pure inpainting with text description
 * 2. ACE++ local_editing - Inpainting with face reference
 *
 * Usage:
 *   node tests/manual/test-character-replacement.js --scene=<image> --ref=<image> --mask=x,y,w,h
 *   node tests/manual/test-character-replacement.js --scene=<image> --ref=<image> --auto-mask
 *
 * Options:
 *   --scene=scene.png           Scene image with character to replace
 *   --ref=character.png         Reference image of replacement character
 *   --mask=x,y,w,h              Mask region as percentages (e.g., 50,10,30,80)
 *   --auto-mask                 Auto-detect faces and create mask (requires bbox)
 *   --bbox=x1,y1,x2,y2          Bounding box for character (normalized 0-1)
 *   --prompt="description"      Description of replacement character
 *   --method=all|flux|ace       Which method to test (default: all)
 *   --output=result.png         Output file prefix
 *
 * Examples:
 *   # Replace right character with Sophie
 *   node tests/manual/test-character-replacement.js \
 *     --scene=tests/fixtures/bbox-crops/page13_original.png \
 *     --ref=tests/fixtures/characters/Sophie.jpg \
 *     --mask=50,10,35,85 \
 *     --prompt="young girl with brown hair in medieval dress"
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const crypto = require('crypto');

require('dotenv').config();

const RUNWARE_API_KEY = process.env.RUNWARE_API_KEY;
const RUNWARE_API_URL = 'https://api.runware.ai/v1';

const MODELS = {
  FLUX_FILL: 'runware:102@1',  // Best inpainting, ~$0.05/img
  FLUX_DEV: 'runware:101@1',   // Good quality, ~$0.004/img
  FLUX_SCHNELL: 'runware:100@1' // Fast/cheap, ~$0.0006/img
};

/**
 * Create a mask image from percentage-based region
 */
async function createMask(width, height, region, options = {}) {
  const { margin = 0, feather = 0 } = options;

  // region = {x, y, w, h} as percentages (0-100)
  let x = Math.round((region.x / 100) * width);
  let y = Math.round((region.y / 100) * height);
  let w = Math.round((region.w / 100) * width);
  let h = Math.round((region.h / 100) * height);

  // Apply margin
  if (margin > 0) {
    x = Math.max(0, x - margin);
    y = Math.max(0, y - margin);
    w = Math.min(width - x, w + margin * 2);
    h = Math.min(height - y, h + margin * 2);
  }

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

/**
 * Convert image to data URI
 */
function toDataUri(image, mimeType = 'image/png') {
  if (typeof image === 'string' && image.startsWith('data:')) {
    return image;
  }
  const buffer = Buffer.isBuffer(image) ? image : fs.readFileSync(image);
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

/**
 * Method 1: FLUX Fill Inpainting (text description only)
 */
async function replaceWithFluxFill(seedImage, maskImage, prompt, options = {}) {
  const { width = 1024, height = 1024, strength = 0.95 } = options;

  const taskUUID = crypto.randomUUID();

  console.log('\n--- FLUX Fill Inpainting ---');
  console.log(`Task ID: ${taskUUID.slice(0, 8)}...`);
  console.log(`Size: ${width}x${height}`);
  console.log(`Strength: ${strength}`);
  console.log(`Prompt: ${prompt.substring(0, 100)}...`);

  const payload = [{
    taskType: 'imageInference',
    taskUUID,
    positivePrompt: prompt,
    negativePrompt: 'blurry, low quality, distorted, disfigured, bad anatomy',
    model: MODELS.FLUX_FILL,
    seedImage: toDataUri(seedImage),
    maskImage: toDataUri(maskImage),
    strength,
    width,
    height,
    outputFormat: 'PNG',
    numberResults: 1
  }];

  const startTime = Date.now();

  const response = await fetch(RUNWARE_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RUNWARE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120000)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`FLUX Fill error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const elapsed = Date.now() - startTime;

  if (data.errors?.length > 0) {
    throw new Error(`FLUX Fill error: ${data.errors[0].message}`);
  }

  const result = data.data?.find(d => d.taskUUID === taskUUID);
  if (!result) {
    throw new Error('No result from FLUX Fill');
  }

  let imageData = result.imageBase64 || result.imageURL;
  if (imageData?.startsWith('http')) {
    const imgResponse = await fetch(imageData);
    imageData = Buffer.from(await imgResponse.arrayBuffer());
  } else if (imageData) {
    imageData = Buffer.from(imageData, 'base64');
  }

  const cost = result.cost || 0.05;
  console.log(`Result: ${elapsed}ms, Cost: $${cost.toFixed(4)}`);
  console.log('----------------------------\n');

  return { imageData, cost, time: elapsed, method: 'flux-fill' };
}

/**
 * Method 2: ACE++ Local Editing (with face reference)
 */
async function replaceWithACE(seedImage, maskImage, referenceImage, prompt, options = {}) {
  const { width = 1024, height = 1024, identityStrength = 0.8 } = options;

  const taskUUID = crypto.randomUUID();

  console.log('\n--- ACE++ Local Editing ---');
  console.log(`Task ID: ${taskUUID.slice(0, 8)}...`);
  console.log(`Size: ${width}x${height}`);
  console.log(`Identity Strength: ${identityStrength}`);
  console.log(`Prompt: ${prompt.substring(0, 100)}...`);

  const payload = [{
    taskType: 'imageInference',
    taskUUID,
    positivePrompt: prompt,
    negativePrompt: 'blurry, low quality, distorted, disfigured, bad anatomy',
    model: MODELS.FLUX_FILL,
    seedImage: toDataUri(seedImage),
    maskImage: toDataUri(maskImage),
    referenceImages: [toDataUri(referenceImage)],
    width,
    height,
    outputFormat: 'PNG',
    numberResults: 1,
    acePlusPlus: {
      type: 'local_editing',
      identityStrength
    }
  }];

  const startTime = Date.now();

  const response = await fetch(RUNWARE_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RUNWARE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120000)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ACE++ error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const elapsed = Date.now() - startTime;

  if (data.errors?.length > 0) {
    throw new Error(`ACE++ error: ${data.errors[0].message}`);
  }

  const result = data.data?.find(d => d.taskUUID === taskUUID);
  if (!result) {
    throw new Error('No result from ACE++');
  }

  let imageData = result.imageBase64 || result.imageURL;
  if (imageData?.startsWith('http')) {
    const imgResponse = await fetch(imageData);
    imageData = Buffer.from(await imgResponse.arrayBuffer());
  } else if (imageData) {
    imageData = Buffer.from(imageData, 'base64');
  }

  const cost = result.cost || 0.05;
  console.log(`Result: ${elapsed}ms, Cost: $${cost.toFixed(4)}`);
  console.log('---------------------------\n');

  return { imageData, cost, time: elapsed, method: 'ace-local-editing' };
}

/**
 * Method 3: ACE++ Subject mode (full character generation with reference)
 */
async function replaceWithACESubject(seedImage, maskImage, referenceImage, prompt, options = {}) {
  const { width = 1024, height = 1024, identityStrength = 0.8 } = options;

  const taskUUID = crypto.randomUUID();

  console.log('\n--- ACE++ Subject Mode ---');
  console.log(`Task ID: ${taskUUID.slice(0, 8)}...`);
  console.log(`Size: ${width}x${height}`);
  console.log(`Identity Strength: ${identityStrength}`);
  console.log(`Prompt: ${prompt.substring(0, 100)}...`);

  const payload = [{
    taskType: 'imageInference',
    taskUUID,
    positivePrompt: prompt,
    negativePrompt: 'blurry, low quality, distorted, disfigured, bad anatomy',
    model: MODELS.FLUX_FILL,
    seedImage: toDataUri(seedImage),
    maskImage: toDataUri(maskImage),
    referenceImages: [toDataUri(referenceImage)],
    width,
    height,
    outputFormat: 'PNG',
    numberResults: 1,
    acePlusPlus: {
      type: 'subject',  // Full subject (face + body + clothing)
      identityStrength
    }
  }];

  const startTime = Date.now();

  const response = await fetch(RUNWARE_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RUNWARE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120000)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ACE++ Subject error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const elapsed = Date.now() - startTime;

  if (data.errors?.length > 0) {
    throw new Error(`ACE++ Subject error: ${data.errors[0].message}`);
  }

  const result = data.data?.find(d => d.taskUUID === taskUUID);
  if (!result) {
    throw new Error('No result from ACE++ Subject');
  }

  let imageData = result.imageBase64 || result.imageURL;
  if (imageData?.startsWith('http')) {
    const imgResponse = await fetch(imageData);
    imageData = Buffer.from(await imgResponse.arrayBuffer());
  } else if (imageData) {
    imageData = Buffer.from(imageData, 'base64');
  }

  const cost = result.cost || 0.05;
  console.log(`Result: ${elapsed}ms, Cost: $${cost.toFixed(4)}`);
  console.log('--------------------------\n');

  return { imageData, cost, time: elapsed, method: 'ace-subject' };
}

/**
 * Create comparison image
 */
async function createComparison(images, outputPath) {
  // images = [{label, buffer}, ...]
  const targetHeight = 512;
  const gap = 5;

  const resized = await Promise.all(images.map(async img => {
    const buf = await sharp(img.buffer).resize({ height: targetHeight }).toBuffer();
    const meta = await sharp(buf).metadata();
    return { ...img, buffer: buf, width: meta.width, height: meta.height };
  }));

  const totalWidth = resized.reduce((sum, img) => sum + img.width, 0) + gap * (resized.length - 1);

  let composite = [];
  let x = 0;
  for (const img of resized) {
    composite.push({ input: img.buffer, left: x, top: 0 });
    x += img.width + gap;
  }

  await sharp({
    create: {
      width: totalWidth,
      height: targetHeight,
      channels: 3,
      background: { r: 30, g: 30, b: 30 }
    }
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
Character Replacement Test Script

Tests inpainting-based character replacement using multiple methods.

Usage:
  node tests/manual/test-character-replacement.js --scene=<image> --ref=<image> --mask=x,y,w,h

Options:
  --scene=scene.png           Scene image with character to replace
  --ref=character.png         Reference image of replacement character
  --mask=x,y,w,h              Mask region as percentages (e.g., 50,10,30,80)
  --prompt="description"      Description of replacement character
  --method=all|flux|ace|subject  Which method to test (default: all)
  --output=result.png         Output file prefix

Methods:
  flux     - FLUX Fill inpainting (text only, no face reference)
  ace      - ACE++ local_editing (with face reference)
  subject  - ACE++ subject mode (full character with reference)
  all      - Test all methods

Examples:
  # Replace right-side character (woman) with Sophie
  node tests/manual/test-character-replacement.js \\
    --scene=tests/fixtures/bbox-crops/page13_original.png \\
    --ref=tests/fixtures/characters/Sophie.jpg \\
    --mask=55,5,40,90 \\
    --prompt="young girl with brown hair carrying wooden table"
    `);
    return;
  }

  if (!RUNWARE_API_KEY) {
    console.error('Error: RUNWARE_API_KEY not set');
    process.exit(1);
  }

  // Parse options
  const options = {
    scene: null,
    ref: null,
    mask: '50,10,40,80',  // Default: right half
    prompt: 'young girl with brown hair in period clothing, same pose, children book illustration style',
    method: 'all',
    output: 'tests/fixtures/test-replacement'
  };

  for (const arg of args) {
    if (arg.startsWith('--')) {
      const [key, ...valueParts] = arg.slice(2).split('=');
      const value = valueParts.join('=');
      if (key === 'scene') options.scene = value;
      else if (key === 'ref') options.ref = value;
      else if (key === 'mask') options.mask = value;
      else if (key === 'prompt') options.prompt = value;
      else if (key === 'method') options.method = value;
      else if (key === 'output') options.output = value;
    }
  }

  if (!options.scene || !options.ref) {
    console.error('Error: --scene and --ref are required');
    process.exit(1);
  }

  if (!fs.existsSync(options.scene)) {
    console.error(`Error: Scene not found: ${options.scene}`);
    process.exit(1);
  }

  if (!fs.existsSync(options.ref)) {
    console.error(`Error: Reference not found: ${options.ref}`);
    process.exit(1);
  }

  // Load images
  console.log('Loading images...');
  const sceneBuffer = fs.readFileSync(options.scene);
  const refBuffer = fs.readFileSync(options.ref);
  const sceneMeta = await sharp(sceneBuffer).metadata();

  console.log(`Scene: ${options.scene} (${sceneMeta.width}x${sceneMeta.height})`);
  console.log(`Reference: ${options.ref}`);

  // Create mask
  const [mx, my, mw, mh] = options.mask.split(',').map(Number);
  console.log(`Mask region: x=${mx}%, y=${my}%, w=${mw}%, h=${mh}%`);

  const maskBuffer = await createMask(sceneMeta.width, sceneMeta.height, { x: mx, y: my, w: mw, h: mh });

  // Save mask for debugging
  const maskPath = `${options.output}-mask.png`;
  fs.writeFileSync(maskPath, maskBuffer);
  console.log(`Mask saved: ${maskPath}`);

  // Collect results
  const results = [];
  results.push({ label: 'Original', buffer: sceneBuffer });
  results.push({ label: 'Mask', buffer: maskBuffer });

  // Run tests based on method
  const methods = options.method === 'all' ? ['flux', 'ace', 'subject'] : [options.method];

  for (const method of methods) {
    try {
      let result;

      if (method === 'flux') {
        result = await replaceWithFluxFill(sceneBuffer, maskBuffer, options.prompt, {
          width: sceneMeta.width,
          height: sceneMeta.height
        });
      } else if (method === 'ace') {
        result = await replaceWithACE(sceneBuffer, maskBuffer, refBuffer, options.prompt, {
          width: sceneMeta.width,
          height: sceneMeta.height,
          identityStrength: 0.8
        });
      } else if (method === 'subject') {
        result = await replaceWithACESubject(sceneBuffer, maskBuffer, refBuffer, options.prompt, {
          width: sceneMeta.width,
          height: sceneMeta.height,
          identityStrength: 0.9
        });
      }

      if (result) {
        const outputPath = `${options.output}-${method}.png`;
        fs.writeFileSync(outputPath, result.imageData);
        console.log(`Saved: ${outputPath}`);
        results.push({ label: method.toUpperCase(), buffer: result.imageData });
      }

    } catch (error) {
      console.error(`${method} failed:`, error.message);
    }
  }

  // Create comparison
  if (results.length > 2) {
    await createComparison(results, `${options.output}-comparison.png`);
  }

  console.log('\n=== Test Complete ===');
  console.log(`Results saved with prefix: ${options.output}`);
}

// Run
if (require.main === module) {
  runTest().catch(console.error);
}

module.exports = {
  replaceWithFluxFill,
  replaceWithACE,
  replaceWithACESubject,
  createMask
};
