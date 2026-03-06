/**
 * FLUX Kontext Test Script
 *
 * Tests FLUX Kontext for character consistency via Runware.
 * FLUX Kontext preserves whole character (face + body + clothing + style).
 *
 * Usage:
 *   node tests/manual/test-flux-kontext.js --scene=<image> --ref=<image> --prompt="instruction"
 *   node tests/manual/test-flux-kontext.js --story=<story-id> --page=<N> --char=<name>
 *
 * Options:
 *   --scene=scene.png           Scene image with character to replace
 *   --ref=character.png         Reference image of replacement character
 *   --prompt="instruction"      What to do (e.g., "Replace the boy with this girl")
 *   --story=job_xxx             Load scene from story in database
 *   --page=5                    Page number to use (0-indexed)
 *   --char="Sophie"             Character name to use as reference
 *   --width=1024                Output width (default: from scene)
 *   --height=1024               Output height (default: from scene)
 *   --output=result.png         Output file path
 *   --no-stitch                 Don't stitch images (use referenceImages param instead)
 *
 * Examples:
 *   # Manual mode - provide images directly
 *   node tests/manual/test-flux-kontext.js \
 *     --scene=scene-with-manuel.png \
 *     --ref=sophie-avatar.png \
 *     --prompt="Replace the boy with this girl"
 *
 *   # Database mode - pull from existing story
 *   node tests/manual/test-flux-kontext.js \
 *     --story=job_1769360030111_ufyj3zi84 \
 *     --page=5 \
 *     --char="Sophie" \
 *     --prompt="Replace Manuel with Sophie"
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const crypto = require('crypto');

// Load environment
require('dotenv').config();

const RUNWARE_API_KEY = process.env.RUNWARE_API_KEY;
const RUNWARE_API_URL = 'https://api.runware.ai/v1';
const FLUX_KONTEXT = 'runware:106@1';

// Estimated costs
const FLUX_KONTEXT_COST = 0.02;  // ~$0.02/image (2x cheaper than pro)

// Supported dimensions for FLUX Kontext
const SUPPORTED_DIMENSIONS = [
  { width: 1568, height: 672 },
  { width: 1504, height: 688 },
  { width: 1456, height: 720 },
  { width: 1392, height: 752 },
  { width: 1328, height: 800 },
  { width: 1248, height: 832 },
  { width: 1184, height: 880 },
  { width: 1104, height: 944 },
  { width: 1024, height: 1024 },
  { width: 944, height: 1104 },
  { width: 880, height: 1184 },
  { width: 832, height: 1248 },
  { width: 800, height: 1328 },
  { width: 752, height: 1392 },
  { width: 720, height: 1456 },
  { width: 688, height: 1504 },
  { width: 672, height: 1568 }
];

/**
 * Find the closest supported dimension for the given aspect ratio
 */
function findClosestDimension(targetWidth, targetHeight) {
  const targetRatio = targetWidth / targetHeight;

  let closest = SUPPORTED_DIMENSIONS[0];
  let closestDiff = Infinity;

  for (const dim of SUPPORTED_DIMENSIONS) {
    const ratio = dim.width / dim.height;
    const diff = Math.abs(ratio - targetRatio);
    if (diff < closestDiff) {
      closestDiff = diff;
      closest = dim;
    }
  }

  return closest;
}

/**
 * Convert image buffer or path to data URI
 */
function toDataUri(image) {
  if (typeof image === 'string') {
    if (image.startsWith('data:')) {
      return image;
    }
    // Assume it's a file path
    const buffer = fs.readFileSync(image);
    const ext = path.extname(image).toLowerCase();
    const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
    return `data:${mimeType};base64,${buffer.toString('base64')}`;
  }
  if (Buffer.isBuffer(image)) {
    return `data:image/png;base64,${image.toString('base64')}`;
  }
  throw new Error('Invalid image format - expected path, buffer, or data URI');
}

/**
 * Stitch two images side by side for multi-image input
 * FLUX Kontext requires stitching images together for character replacement
 */
async function stitchImages(leftImage, rightImage) {
  // Load both images
  const leftBuffer = Buffer.isBuffer(leftImage) ? leftImage : fs.readFileSync(leftImage);
  const rightBuffer = Buffer.isBuffer(rightImage) ? rightImage : fs.readFileSync(rightImage);

  const leftMeta = await sharp(leftBuffer).metadata();
  const rightMeta = await sharp(rightBuffer).metadata();

  // Normalize heights
  const targetHeight = Math.max(leftMeta.height, rightMeta.height);

  // Resize both to same height
  const leftResized = await sharp(leftBuffer)
    .resize({ height: targetHeight, fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .toBuffer();
  const rightResized = await sharp(rightBuffer)
    .resize({ height: targetHeight, fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .toBuffer();

  const leftResizedMeta = await sharp(leftResized).metadata();
  const rightResizedMeta = await sharp(rightResized).metadata();

  // Create side-by-side composite
  const totalWidth = leftResizedMeta.width + rightResizedMeta.width;

  const stitched = await sharp({
    create: {
      width: totalWidth,
      height: targetHeight,
      channels: 3,
      background: { r: 255, g: 255, b: 255 }
    }
  })
  .composite([
    { input: leftResized, left: 0, top: 0 },
    { input: rightResized, left: leftResizedMeta.width, top: 0 }
  ])
  .png()
  .toBuffer();

  return { stitched, width: totalWidth, height: targetHeight };
}

/**
 * Generate with FLUX Kontext for character replacement
 * Uses image stitching approach - combines scene + reference into one input
 *
 * @param {string|Buffer} seedImage - Original scene image
 * @param {string|Buffer|Array} referenceImages - Character reference image(s)
 * @param {string} prompt - Instruction prompt (e.g., "Replace the boy with this girl")
 * @param {Object} options - Generation options
 * @returns {Promise<{imageData: Buffer, cost: number, inferenceTime: number}>}
 */
async function generateWithKontext(seedImage, referenceImages, prompt, options = {}) {
  const { width = 1024, height = 1024, useStitching = true } = options;

  if (!RUNWARE_API_KEY) {
    throw new Error('RUNWARE_API_KEY not configured');
  }

  const taskUUID = crypto.randomUUID();

  let inputImage;
  let inputWidth = width;
  let inputHeight = height;

  if (useStitching) {
    // Stitch scene + reference side by side
    const refImage = Array.isArray(referenceImages) ? referenceImages[0] : referenceImages;
    console.log('Stitching scene + reference images...');
    const { stitched, width: stitchedWidth, height: stitchedHeight } = await stitchImages(seedImage, refImage);
    inputImage = stitched;

    // Save stitched image for debugging
    fs.writeFileSync('tests/fixtures/test-kontext-stitched.png', stitched);
    console.log(`Stitched image saved: tests/fixtures/test-kontext-stitched.png (${stitchedWidth}x${stitchedHeight})`);

    // Find closest supported dimension for the stitched aspect ratio
    const closestDim = findClosestDimension(stitchedWidth, stitchedHeight);
    inputWidth = closestDim.width;
    inputHeight = closestDim.height;
    console.log(`Using supported dimension: ${inputWidth}x${inputHeight}`);
  } else {
    // Original approach - separate seedImage + referenceImages
    inputImage = seedImage;
  }

  const inputDataUri = toDataUri(inputImage);

  console.log('\n--- FLUX Kontext Request ---');
  console.log(`Task ID: ${taskUUID.slice(0, 8)}...`);
  console.log(`Model: ${FLUX_KONTEXT}`);
  console.log(`Input size: ${inputWidth}x${inputHeight}`);
  console.log(`Mode: ${useStitching ? 'STITCHED (scene|ref)' : 'SEPARATE (seedImage + referenceImages)'}`);
  console.log(`Prompt: ${prompt}`);
  console.log(`Estimated cost: $${FLUX_KONTEXT_COST}`);
  console.log('-----------------------------\n');

  const payload = [{
    taskType: 'imageInference',
    taskUUID,
    positivePrompt: prompt,
    model: FLUX_KONTEXT,
    seedImage: inputDataUri,
    width: inputWidth,
    height: inputHeight,
    outputFormat: 'PNG',
    numberResults: 1
  }];

  // Only add referenceImages if NOT using stitching
  if (!useStitching) {
    const refArray = Array.isArray(referenceImages) ? referenceImages : [referenceImages];
    payload[0].referenceImages = refArray.map(toDataUri);
  }

  const startTime = Date.now();

  const response = await fetch(RUNWARE_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RUNWARE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120000)  // 2 minute timeout
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Runware API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const elapsed = Date.now() - startTime;

  // Handle errors in response
  if (data.errors && data.errors.length > 0) {
    const error = data.errors[0];
    throw new Error(`Runware task error: ${error.message || JSON.stringify(error)}`);
  }

  // Find result for our task
  const result = data.data?.find(d => d.taskUUID === taskUUID);
  if (!result) {
    console.error('Full response:', JSON.stringify(data, null, 2));
    throw new Error('No result in Runware response');
  }

  // Get the image - could be URL or base64
  let imageData = result.imageBase64 || result.imageURL;

  // Download if URL
  if (imageData && imageData.startsWith('http')) {
    console.log('Downloading result from URL...');
    const imgResponse = await fetch(imageData);
    const buffer = await imgResponse.arrayBuffer();
    imageData = Buffer.from(buffer);
  } else if (imageData) {
    imageData = Buffer.from(imageData, 'base64');
  }

  if (!imageData) {
    console.error('Result object:', JSON.stringify(result, null, 2));
    throw new Error('No image data in Runware response');
  }

  const cost = result.cost || FLUX_KONTEXT_COST;

  console.log(`--- Result ---`);
  console.log(`Time: ${elapsed}ms`);
  console.log(`Cost: $${cost.toFixed(4)}`);
  console.log(`--------------\n`);

  return {
    imageData,
    cost,
    inferenceTime: result.inferenceTime || elapsed
  };
}

/**
 * Load scene and character from database
 */
async function loadFromDatabase(storyId, pageNum, charName) {
  const { Pool } = require('pg');

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false
  });

  try {
    // Get story data
    const storyResult = await pool.query(`
      SELECT
        s.data,
        s.user_id,
        c.data as character_data
      FROM stories s
      LEFT JOIN characters c ON c.user_id = s.user_id
      WHERE s.id = $1
    `, [storyId]);

    if (storyResult.rows.length === 0) {
      throw new Error(`Story not found: ${storyId}`);
    }

    const story = storyResult.rows[0];
    const storyData = story.data;
    const characterData = story.character_data;

    // Get scene image for the page
    let sceneImage = null;
    if (storyData.sceneImages && storyData.sceneImages[pageNum]) {
      const sceneData = storyData.sceneImages[pageNum];
      sceneImage = sceneData.imageData || sceneData.imageURL;

      // Download if URL
      if (sceneImage && sceneImage.startsWith('http')) {
        console.log(`Downloading scene from URL...`);
        const response = await fetch(sceneImage);
        const buffer = await response.arrayBuffer();
        sceneImage = Buffer.from(buffer);
      } else if (sceneImage && sceneImage.startsWith('data:')) {
        // Extract base64 from data URI
        const base64 = sceneImage.split(',')[1];
        sceneImage = Buffer.from(base64, 'base64');
      }
    }

    if (!sceneImage) {
      throw new Error(`Scene image not found for page ${pageNum}`);
    }

    // Get character reference
    let characterRef = null;
    if (characterData && characterData.characters) {
      const char = characterData.characters.find(c =>
        c.name.toLowerCase() === charName.toLowerCase()
      );

      if (char) {
        // Try styled avatar first, then original avatar
        const avatarData = char.styledAvatar || char.avatarData || char.avatar;
        if (avatarData) {
          if (avatarData.startsWith('http')) {
            console.log(`Downloading character reference from URL...`);
            const response = await fetch(avatarData);
            const buffer = await response.arrayBuffer();
            characterRef = Buffer.from(buffer);
          } else if (avatarData.startsWith('data:')) {
            const base64 = avatarData.split(',')[1];
            characterRef = Buffer.from(base64, 'base64');
          }
        }
      }
    }

    if (!characterRef) {
      throw new Error(`Character reference not found for: ${charName}`);
    }

    return { sceneImage, characterRef };

  } finally {
    await pool.end();
  }
}

/**
 * Create side-by-side comparison image
 */
async function createComparison(scene, reference, result, outputPath) {
  const sceneMeta = await sharp(scene).metadata();
  const refMeta = await sharp(reference).metadata();
  const resultMeta = await sharp(result).metadata();

  // Normalize heights for comparison
  const targetHeight = Math.max(sceneMeta.height, refMeta.height, resultMeta.height);

  // Resize reference to match height (it's usually smaller)
  const refResized = await sharp(reference)
    .resize({ height: targetHeight, fit: 'contain', background: { r: 128, g: 128, b: 128, alpha: 1 } })
    .toBuffer();
  const refResizedMeta = await sharp(refResized).metadata();

  // Scene and result at original size
  const sceneResized = sceneMeta.height !== targetHeight
    ? await sharp(scene).resize({ height: targetHeight, fit: 'contain', background: { r: 128, g: 128, b: 128, alpha: 1 } }).toBuffer()
    : scene;
  const resultResized = resultMeta.height !== targetHeight
    ? await sharp(result).resize({ height: targetHeight, fit: 'contain', background: { r: 128, g: 128, b: 128, alpha: 1 } }).toBuffer()
    : result;

  const sceneResizedMeta = await sharp(sceneResized).metadata();
  const resultResizedMeta = await sharp(resultResized).metadata();

  const totalWidth = sceneResizedMeta.width + refResizedMeta.width + resultResizedMeta.width + 20;  // 10px gaps

  await sharp({
    create: {
      width: totalWidth,
      height: targetHeight,
      channels: 3,
      background: { r: 40, g: 40, b: 40 }
    }
  })
  .composite([
    { input: sceneResized, left: 0, top: 0 },
    { input: refResized, left: sceneResizedMeta.width + 10, top: 0 },
    { input: resultResized, left: sceneResizedMeta.width + refResizedMeta.width + 20, top: 0 }
  ])
  .png()
  .toFile(outputPath);

  console.log(`Comparison saved: ${outputPath}`);
  console.log(`  Layout: [Original Scene] | [Character Ref] | [Result]`);
}

async function runTest() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help')) {
    console.log(`
FLUX Kontext Test Script

Tests character replacement using FLUX Kontext via Runware.
FLUX Kontext preserves whole character (face + body + clothing + style).

Usage:
  node tests/manual/test-flux-kontext.js --scene=<image> --ref=<image> --prompt="instruction"
  node tests/manual/test-flux-kontext.js --story=<id> --page=<N> --char=<name> --prompt="instruction"

Options:
  --scene=scene.png           Scene image with character to replace
  --ref=character.png         Reference image of replacement character
  --prompt="instruction"      What to do (e.g., "Replace the boy with this girl")
  --story=job_xxx             Load scene from story in database
  --page=5                    Page number (0-indexed)
  --char="Sophie"             Character name for reference
  --width=1024                Output width (default: from scene)
  --height=1024               Output height (default: from scene)
  --output=result.png         Output file path

Model Info:
  FLUX Kontext (runware:106@1) - ~$0.02/image
  - Preserves whole character, not just face
  - Uses seedImage (scene) + referenceImages (character)

Examples:
  # Replace character in scene with different character
  node tests/manual/test-flux-kontext.js \\
    --scene=tests/fixtures/scene-with-boy.png \\
    --ref=tests/fixtures/girl-avatar.png \\
    --prompt="Replace the boy with this girl"

  # From database
  node tests/manual/test-flux-kontext.js \\
    --story=job_1769360030111_xyz \\
    --page=3 \\
    --char="Emma" \\
    --prompt="Replace the main character with Emma"
    `);
    return;
  }

  if (!RUNWARE_API_KEY) {
    console.error('Error: RUNWARE_API_KEY not set in environment');
    process.exit(1);
  }

  // Parse options
  const options = {
    scene: null,
    ref: null,
    prompt: 'Replace the character in the left image with the person shown in the right image, keeping the same pose, scene and composition',
    story: null,
    page: 0,
    char: null,
    width: null,
    height: null,
    output: 'tests/fixtures/test-kontext-result.png',
    noStitch: false
  };

  for (const arg of args) {
    if (arg.startsWith('--')) {
      const [key, ...valueParts] = arg.slice(2).split('=');
      const value = valueParts.join('=');  // Handle values with = in them
      if (key === 'scene') options.scene = value;
      else if (key === 'ref') options.ref = value;
      else if (key === 'prompt') options.prompt = value;
      else if (key === 'story') options.story = value;
      else if (key === 'page') options.page = parseInt(value);
      else if (key === 'char') options.char = value;
      else if (key === 'width') options.width = parseInt(value);
      else if (key === 'height') options.height = parseInt(value);
      else if (key === 'output') options.output = value;
      else if (key === 'no-stitch') options.noStitch = true;
    }
  }

  let sceneImage, refImage;

  // Mode 1: Load from database
  if (options.story) {
    if (!options.char) {
      console.error('Error: --char required when using --story');
      process.exit(1);
    }

    console.log(`Loading from database...`);
    console.log(`  Story: ${options.story}`);
    console.log(`  Page: ${options.page}`);
    console.log(`  Character: ${options.char}`);

    const { sceneImage: scene, characterRef } = await loadFromDatabase(
      options.story,
      options.page,
      options.char
    );
    sceneImage = scene;
    refImage = characterRef;
  }
  // Mode 2: Load from files
  else {
    if (!options.scene || !options.ref) {
      console.error('Error: --scene and --ref required (or use --story mode)');
      process.exit(1);
    }

    if (!fs.existsSync(options.scene)) {
      console.error(`Error: Scene image not found: ${options.scene}`);
      process.exit(1);
    }

    if (!fs.existsSync(options.ref)) {
      console.error(`Error: Reference image not found: ${options.ref}`);
      process.exit(1);
    }

    console.log(`Loading images...`);
    console.log(`  Scene: ${options.scene}`);
    console.log(`  Reference: ${options.ref}`);

    sceneImage = fs.readFileSync(options.scene);
    refImage = fs.readFileSync(options.ref);
  }

  // Get scene dimensions
  const sceneMeta = await sharp(sceneImage).metadata();
  const width = options.width || sceneMeta.width;
  const height = options.height || sceneMeta.height;

  console.log(`Scene dimensions: ${sceneMeta.width}x${sceneMeta.height}`);
  console.log(`Output dimensions: ${width}x${height}`);

  // Run FLUX Kontext
  console.log('\nCalling FLUX Kontext...');

  try {
    const result = await generateWithKontext(sceneImage, refImage, options.prompt, {
      width,
      height,
      useStitching: !options.noStitch
    });

    // Save result
    fs.writeFileSync(options.output, result.imageData);
    console.log(`Result saved: ${options.output}`);

    // Create comparison
    const comparisonPath = options.output.replace('.png', '-comparison.png');
    await createComparison(sceneImage, refImage, result.imageData, comparisonPath);

    console.log('\nTest completed successfully!');
    console.log(`  Result: ${options.output}`);
    console.log(`  Comparison: ${comparisonPath}`);
    console.log(`  Cost: $${result.cost.toFixed(4)}`);
    console.log(`  Time: ${result.inferenceTime}ms`);

  } catch (error) {
    console.error('\nFLUX Kontext failed:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  runTest().catch(console.error);
}

module.exports = { generateWithKontext, FLUX_KONTEXT };
