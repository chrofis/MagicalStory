/**
 * Inpainting Test Script
 *
 * Usage:
 *   node test-inpaint.js <image-path> [options]
 *
 * Options:
 *   --model=sdxl|flux|sd15|ace  Model to use (default: sdxl, ace=ACE++ local_editing)
 *   --strength=0.85             Inpaint strength 0-1 (default: 0.85)
 *   --steps=20                  Inference steps (default: 20)
 *   --margin=48                 Mask margin in pixels (default: 0)
 *   --prompt="fix text"         What to generate in masked area
 *   --mask=x,y,w,h              Mask region as percentages (e.g., 10,10,30,30)
 *   --ref=reference.jpg         Reference image for ACE++ (character to match)
 *   --output=result.png         Output file path
 *
 * Examples:
 *   node test-inpaint.js test-image.png --model=sdxl --mask=25,25,50,50 --prompt="a red apple"
 *   node test-inpaint.js test-image.png --model=flux --strength=0.9 --steps=30
 *   node test-inpaint.js test-image.png --model=ace --ref=character.jpg --mask=0,10,35,80 --prompt="young boy"
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// Load environment
require('dotenv').config();

const RUNWARE_API_KEY = process.env.RUNWARE_API_KEY;
const RUNWARE_API_URL = 'https://api.runware.ai/v1';

const MODELS = {
  'sd15': 'runware:100@1',      // $0.0006/img - Fast, low quality
  'sdxl': 'runware:101@1',      // $0.002/img - Good balance
  'flux': 'runware:102@1',      // ~$0.05/img - Best quality
  'ace': 'runware:102@1',       // ACE++ local_editing with reference image
};

const MODEL_COSTS = {
  'runware:100@1': 0.0006,
  'runware:101@1': 0.002,
  'runware:102@1': 0.05,
  'ace': 0.05,                  // ACE++ uses FLUX Fill pricing
};

async function createMask(width, height, region) {
  // region = {x, y, w, h} as percentages (0-100)
  const x = Math.round((region.x / 100) * width);
  const y = Math.round((region.y / 100) * height);
  const w = Math.round((region.w / 100) * width);
  const h = Math.round((region.h / 100) * height);

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

async function inpaint(seedImage, maskImage, prompt, options = {}) {
  const {
    model = MODELS.sdxl,
    strength = 0.85,
    steps = 20,
    maskMargin = 0,
    width = 1024,
    height = 1024,
    negativePrompt = '',
    cfgScale = 7
  } = options;

  const taskUUID = require('crypto').randomUUID();

  // Convert to data URIs
  const seedDataUri = `data:image/png;base64,${seedImage.toString('base64')}`;
  const maskDataUri = `data:image/png;base64,${maskImage.toString('base64')}`;

  const payload = [{
    taskType: 'imageInference',
    taskUUID: taskUUID,
    positivePrompt: prompt,
    model: model,
    seedImage: seedDataUri,
    maskImage: maskDataUri,
    strength: strength,
    steps: steps,
    width: width,
    height: height,
    outputFormat: 'PNG',
    numberResults: 1
  }];

  // Add maskMargin for SDXL/SD15 (not supported by FLUX Fill)
  if (maskMargin > 0 && model !== MODELS.flux) {
    payload[0].maskMargin = maskMargin;
  }

  // Add negative prompt if provided
  if (negativePrompt) {
    payload[0].negativePrompt = negativePrompt;
  }

  console.log('\n--- Runware Inpaint Request ---');
  console.log(`Model: ${model}`);
  console.log(`Strength: ${strength}`);
  if (negativePrompt) console.log(`Negative: ${negativePrompt}`);
  console.log(`Steps: ${steps}`);
  console.log(`Mask Margin: ${maskMargin}`);
  console.log(`Prompt: ${prompt}`);
  console.log(`Estimated Cost: $${MODEL_COSTS[model] || 'unknown'}`);
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

  if (result.data && result.data.length > 0) {
    const imageResult = result.data[0];

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
    console.log(`Cost: $${MODEL_COSTS[model] || 'unknown'}`);
    console.log(`--------------\n`);

    return imageData;
  }

  throw new Error('No result returned from API');
}

async function runTest() {
  // Parse arguments
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help') {
    console.log(`
Inpainting Test Script

Usage:
  node test-inpaint.js <image-path> [options]

Options:
  --model=sdxl|flux|sd15    Model to use (default: sdxl)
  --strength=0.85           Inpaint strength 0-1 (default: 0.85)
  --steps=20                Inference steps (default: 20)
  --margin=48               Mask margin in pixels (default: 0)
  --prompt="fix text"       What to generate in masked area
  --mask=x,y,w,h            Mask region as percentages (e.g., 10,10,30,30)
  --output=result.png       Output file path

Models:
  sd15  - SD 1.5 Inpaint    $0.0006/img  (fast, low quality)
  sdxl  - SDXL Inpaint      $0.002/img   (good balance) [DEFAULT]
  flux  - FLUX Fill         $0.05/img    (best quality)

Examples:
  node test-inpaint.js image.png --mask=25,25,50,50 --prompt="a red apple"
  node test-inpaint.js image.png --model=flux --strength=0.9
  node test-inpaint.js image.png --model=sdxl --margin=48 --steps=30
    `);
    return;
  }

  if (!RUNWARE_API_KEY) {
    console.error('Error: RUNWARE_API_KEY not set in environment');
    process.exit(1);
  }

  const imagePath = args[0];

  if (!fs.existsSync(imagePath)) {
    console.error(`Error: Image not found: ${imagePath}`);
    process.exit(1);
  }

  // Parse options
  const options = {
    model: 'sdxl',
    strength: 0.85,
    steps: 20,
    margin: 0,
    prompt: 'Fix this area naturally, maintaining style consistency',
    mask: '25,25,50,50',  // Default: center 50%
    output: 'inpaint-result.png'
  };

  for (const arg of args.slice(1)) {
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=');
      if (key === 'model') options.model = value;
      else if (key === 'strength') options.strength = parseFloat(value);
      else if (key === 'steps') options.steps = parseInt(value);
      else if (key === 'margin') options.margin = parseInt(value);
      else if (key === 'prompt') options.prompt = value;
      else if (key === 'mask') options.mask = value;
      else if (key === 'output') options.output = value;
      else if (key === 'neg') options.neg = value;
    }
  }

  // Load and process image
  console.log(`Loading image: ${imagePath}`);
  const imageBuffer = fs.readFileSync(imagePath);
  const metadata = await sharp(imageBuffer).metadata();

  console.log(`Image size: ${metadata.width}x${metadata.height}`);

  // Resize to 1024 if needed
  let processedImage = imageBuffer;
  let width = metadata.width;
  let height = metadata.height;

  if (width > 1024 || height > 1024) {
    console.log('Resizing to fit 1024px...');
    const resized = await sharp(imageBuffer)
      .resize(1024, 1024, { fit: 'inside' })
      .png()
      .toBuffer();
    processedImage = resized;
    const newMeta = await sharp(resized).metadata();
    width = newMeta.width;
    height = newMeta.height;
    console.log(`Resized to: ${width}x${height}`);
  }

  // Create mask
  const [mx, my, mw, mh] = options.mask.split(',').map(Number);
  console.log(`Creating mask: x=${mx}%, y=${my}%, w=${mw}%, h=${mh}%`);

  const maskBuffer = await createMask(width, height, { x: mx, y: my, w: mw, h: mh });

  // Save mask for debugging
  const maskPath = options.output.replace('.png', '-mask.png');
  fs.writeFileSync(maskPath, maskBuffer);
  console.log(`Mask saved to: ${maskPath}`);

  // Run inpainting
  console.log('\nStarting inpainting...');

  try {
    const result = await inpaint(processedImage, maskBuffer, options.prompt, {
      model: MODELS[options.model] || MODELS.sdxl,
      strength: options.strength,
      steps: options.steps,
      maskMargin: options.margin,
      negativePrompt: options.neg || '',
      width: width,
      height: height
    });

    fs.writeFileSync(options.output, result);
    console.log(`Result saved to: ${options.output}`);

    // Create comparison image
    const comparisonPath = options.output.replace('.png', '-comparison.png');
    await sharp({
      create: {
        width: width * 3,
        height: height,
        channels: 3,
        background: { r: 128, g: 128, b: 128 }
      }
    })
    .composite([
      { input: processedImage, left: 0, top: 0 },
      { input: maskBuffer, left: width, top: 0 },
      { input: result, left: width * 2, top: 0 }
    ])
    .png()
    .toFile(comparisonPath);

    console.log(`Comparison saved to: ${comparisonPath}`);
    console.log('\nDone!');

  } catch (error) {
    console.error('Inpainting failed:', error.message);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  runTest().catch(console.error);
}

module.exports = { inpaint, createMask, MODELS };
