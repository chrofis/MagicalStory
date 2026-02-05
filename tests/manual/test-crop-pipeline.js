/**
 * Crop-based pipeline with evaluation
 * 1. Crop face region from panel
 * 2. Evaluate crop quality
 * 3. Face swap on cropped region
 * 4. Hair fix on cropped region
 * 5. Stitch back with blending
 */
const fs = require('fs');
const sharp = require('sharp');

const API_KEY = 'cml70oyze000qjr0412v3kdbt';
const FACESWAP_BASE = 'https://api.magicapi.dev/api/v1/magicapi/faceswap';
const HAIR_BASE = 'https://api.magicapi.dev/api/v1/magicapi/hair-v2';

async function uploadBuffer(buffer) {
  const base64 = buffer.toString('base64');
  const formData = new URLSearchParams();
  formData.append('source', base64);
  formData.append('type', 'base64');
  formData.append('action', 'upload');

  const response = await fetch('https://freeimage.host/api/1/upload?key=6d207e02198a847aa98d0a2a901485a5', {
    method: 'POST',
    body: formData
  });

  const result = await response.json();
  if (!result.image?.url) throw new Error('Upload failed');
  return result.image.url;
}

async function cropFace(imagePath, region) {
  const image = sharp(imagePath);
  const meta = await image.metadata();

  console.log(`  Original size: ${meta.width}x${meta.height}`);
  console.log(`  Crop region: left=${region.left}, top=${region.top}, width=${region.width}, height=${region.height}`);

  // Validate crop is within bounds
  if (region.left + region.width > meta.width || region.top + region.height > meta.height) {
    console.error('  ERROR: Crop region exceeds image bounds!');
    return null;
  }

  const cropped = await image.extract(region).toBuffer();
  return cropped;
}

async function faceSwap(sourceBuffer, targetBuffer) {
  console.log('  Face swap...');

  const sourceUrl = await uploadBuffer(sourceBuffer);
  const targetUrl = await uploadBuffer(targetBuffer);

  const submitResp = await fetch(FACESWAP_BASE + '/faceswap-image', {
    method: 'POST',
    headers: { 'x-magicapi-key': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { swap_image: sourceUrl, target_image: targetUrl }
    })
  });

  const submitResult = await submitResp.json();
  if (!submitResult.request_id) {
    console.error('  Face swap error:', submitResult);
    return targetBuffer;
  }

  let result = submitResult;
  while (result.status !== 'processed' && result.status !== 'failed') {
    await new Promise(r => setTimeout(r, 2000));
    process.stdout.write('.');

    const statusResp = await fetch(FACESWAP_BASE + '/result', {
      method: 'POST',
      headers: { 'x-magicapi-key': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ request_id: submitResult.request_id })
    });
    result = await statusResp.json();
  }
  console.log(' ' + result.status);

  if (result.status === 'failed') return targetBuffer;

  const imgResp = await fetch(result.output);
  return Buffer.from(await imgResp.arrayBuffer());
}

async function fixHair(imageBuffer) {
  console.log('  Hair fix...');

  const imageUrl = await uploadBuffer(imageBuffer);

  const submitResp = await fetch(HAIR_BASE + '/run', {
    method: 'POST',
    headers: { 'x-magicapi-key': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: {
        image: imageUrl,
        haircolor: 'dark brown',
        hairstyle: 'short bangs above eyebrows forward',
        hairproperty: 'textured'
      }
    })
  });

  const submitResult = await submitResp.json();
  if (!submitResult.id) {
    console.error('  Hair API error:', submitResult);
    return imageBuffer;
  }

  let result = submitResult;
  while (result.status !== 'COMPLETED' && result.status !== 'FAILED') {
    await new Promise(r => setTimeout(r, 3000));
    process.stdout.write('.');

    const statusResp = await fetch(HAIR_BASE + '/status/' + submitResult.id, {
      headers: { 'x-magicapi-key': API_KEY }
    });
    result = await statusResp.json();
  }
  console.log(' ' + result.status);

  if (result.status === 'FAILED' || !result.output?.image_url) {
    return imageBuffer;
  }

  const imgResp = await fetch(result.output.image_url);
  return Buffer.from(await imgResp.arrayBuffer());
}

async function stitchBack(faceBuffer, originalPath, region) {
  console.log('  Stitching back...');

  const original = fs.readFileSync(originalPath);
  const { left, top, width, height } = region;

  // Resize face to exact region size
  const resizedFace = await sharp(faceBuffer)
    .resize(width, height, { fit: 'fill' })
    .toBuffer();

  // Create feathered oval mask
  const feather = 8;
  const svgMask = Buffer.from(
    `<svg width="${width}" height="${height}">
      <defs><filter id="blur"><feGaussianBlur stdDeviation="${feather}"/></filter></defs>
      <ellipse cx="${width/2}" cy="${height/2}" rx="${width/2 - feather}" ry="${height/2 - feather}" fill="white" filter="url(#blur)"/>
    </svg>`
  );

  const mask = await sharp(svgMask).png().toBuffer();

  // Apply mask
  const maskedFace = await sharp(resizedFace)
    .ensureAlpha()
    .composite([{ input: mask, blend: 'dest-in' }])
    .toBuffer();

  // Composite
  const result = await sharp(original)
    .composite([{ input: maskedFace, left, top }])
    .png()
    .toBuffer();

  return result;
}

async function createComparisonGrid(images, labels) {
  const s = 200;
  const bufs = await Promise.all(images.map(async (img) => {
    if (Buffer.isBuffer(img)) {
      return sharp(img).resize(s, s, { fit: 'contain', background: { r: 30, g: 30, b: 30 } }).toBuffer();
    }
    return sharp(img).resize(s, s, { fit: 'contain', background: { r: 30, g: 30, b: 30 } }).toBuffer();
  }));

  const grid = await sharp({
    create: { width: s * bufs.length + (bufs.length - 1) * 4, height: s, channels: 3, background: { r: 30, g: 30, b: 30 } }
  })
  .composite(bufs.map((b, i) => ({ input: b, left: i * (s + 4), top: 0 })))
  .png()
  .toBuffer();

  return grid;
}

async function main() {
  console.log('=== CROP-BASED PIPELINE ===\n');

  // Parse command line args
  const args = process.argv.slice(2);
  const useSimpleSwap = args.includes('--simple');

  let panelPath, sourceFacePath, cropRegion, outputPrefix;

  if (useSimpleSwap) {
    panelPath = 'tests/fixtures/test-simple-swap-replicate.png';
    sourceFacePath = 'tests/fixtures/test-lukas-face-B-v3.png';
    outputPrefix = 'crop-simple';
    // Face is in upper-middle portion of 512x1024 image
    // Person is centered at x=256, face top around y=300
    cropRegion = {
      left: 108,     // X position - adjusted 20% left
      top: 300,      // Y position - includes hair
      width: 85,     // Width of crop - tight on face
      height: 115    // Height of crop (hair to neck)
    };
  } else {
    panelPath = 'tests/fixtures/test-lukas-panel-C.png';
    sourceFacePath = 'tests/fixtures/test-lukas-face-B-v3.png';
    outputPrefix = 'crop';
    cropRegion = {
      left: 55,      // X position
      top: 0,        // Y position
      width: 150,    // Width of crop
      height: 140    // Height of crop (include hair)
    };
  }

  // Get panel dimensions
  const panelMeta = await sharp(panelPath).metadata();
  console.log(`Panel: ${panelMeta.width}x${panelMeta.height}`);
  console.log(`Using: ${panelPath}`);

  // STEP 1: Crop and evaluate
  console.log('\n--- STEP 1: Crop Face Region ---');
  const croppedFace = await cropFace(panelPath, cropRegion);
  if (!croppedFace) return;

  fs.writeFileSync(`tests/fixtures/${outputPrefix}-step1-initial.png`, croppedFace);
  console.log(`  Saved: ${outputPrefix}-step1-initial.png (EVALUATE THIS)`);

  // Load source face
  const sourceFace = fs.readFileSync(sourceFacePath);

  // STEP 2: Face swap on cropped region
  console.log('\n--- STEP 2: Face Swap ---');
  const swappedFace = await faceSwap(sourceFace, croppedFace);
  fs.writeFileSync(`tests/fixtures/${outputPrefix}-step2-faceswap.png`, swappedFace);
  console.log(`  Saved: ${outputPrefix}-step2-faceswap.png`);

  // STEP 3: Hair fix on swapped face
  console.log('\n--- STEP 3: Hair Fix ---');
  const fixedFace = await fixHair(swappedFace);
  fs.writeFileSync(`tests/fixtures/${outputPrefix}-step3-hairfix.png`, fixedFace);
  console.log(`  Saved: ${outputPrefix}-step3-hairfix.png`);

  // STEP 4: Stitch back
  console.log('\n--- STEP 4: Stitch Back ---');
  const final = await stitchBack(fixedFace, panelPath, cropRegion);
  fs.writeFileSync(`tests/fixtures/${outputPrefix}-step4-final.png`, final);
  console.log(`  Saved: ${outputPrefix}-step4-final.png`);

  // Create comparison
  console.log('\n--- Creating Comparison ---');
  const comparison = await createComparisonGrid(
    [panelPath, croppedFace, swappedFace, fixedFace, final],
    ['Original', 'Crop', 'FaceSwap', 'HairFix', 'Final']
  );
  fs.writeFileSync(`tests/fixtures/${outputPrefix}-comparison.png`, comparison);
  console.log(`  Saved: ${outputPrefix}-comparison.png`);

  console.log('\n=== DONE ===');
  console.log('Check crop-step1-initial.png - if crop is wrong, adjust cropRegion values');
}

main().catch(console.error);
