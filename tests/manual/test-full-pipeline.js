/**
 * Full Character Replacement Pipeline
 * 1. Face swap (B face onto C)
 * 2. Hair fix
 * 3. Stitch back to original panel
 */
const fs = require('fs');
const sharp = require('sharp');

const API_KEY = 'cml70oyze000qjr0412v3kdbt';
const FACESWAP_BASE = 'https://api.magicapi.dev/api/v1/magicapi/faceswap';
const HAIR_BASE = 'https://api.magicapi.dev/api/v1/magicapi/hair-v2';

async function uploadImage(imagePath) {
  console.log(`  Uploading ${imagePath}...`);
  const fileBuffer = fs.readFileSync(imagePath);
  const base64 = fileBuffer.toString('base64');

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
  console.log(`  Uploaded: ${result.image.url}`);
  return result.image.url;
}

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

async function faceSwap(sourceUrl, targetUrl) {
  console.log('\n=== STEP 1: Face Swap ===');
  console.log(`  Source (face to use): ${sourceUrl}`);
  console.log(`  Target (face to replace): ${targetUrl}`);

  const submitResp = await fetch(FACESWAP_BASE + '/faceswap-image', {
    method: 'POST',
    headers: { 'x-magicapi-key': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { swap_image: sourceUrl, target_image: targetUrl }
    })
  });

  const submitResult = await submitResp.json();
  if (!submitResult.request_id) {
    console.error('Face swap error:', submitResult);
    return null;
  }
  console.log(`  Job: ${submitResult.request_id}`);

  // Poll for result
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

  if (result.status === 'failed') {
    console.error('Face swap failed:', result);
    return null;
  }

  // Download result
  const imgResp = await fetch(result.output);
  const buffer = Buffer.from(await imgResp.arrayBuffer());
  fs.writeFileSync('tests/fixtures/pipeline-step1-faceswap.png', buffer);
  console.log('  Saved: pipeline-step1-faceswap.png');
  return buffer;
}

async function fixHair(imageBuffer) {
  console.log('\n=== STEP 2: Fix Hair ===');

  const imageUrl = await uploadBuffer(imageBuffer);
  console.log(`  Image: ${imageUrl}`);

  const submitResp = await fetch(HAIR_BASE + '/run', {
    method: 'POST',
    headers: { 'x-magicapi-key': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: {
        image: imageUrl,
        haircolor: 'dark brown',
        hairstyle: 'short bangs above eyebrows forward parting',
        hairproperty: 'textured'
      }
    })
  });

  const submitResult = await submitResp.json();
  if (!submitResult.id) {
    console.error('Hair API error:', submitResult);
    return imageBuffer; // Return original if hair fix fails
  }
  console.log(`  Job: ${submitResult.id}`);

  // Poll for result
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
    console.error('Hair fix failed:', result);
    return imageBuffer;
  }

  // Download result
  const imgResp = await fetch(result.output.image_url);
  const buffer = Buffer.from(await imgResp.arrayBuffer());
  fs.writeFileSync('tests/fixtures/pipeline-step2-hairfix.png', buffer);
  console.log('  Saved: pipeline-step2-hairfix.png');
  return buffer;
}

async function stitchBack(faceBuffer, originalPanelPath, faceRegion) {
  console.log('\n=== STEP 3: Stitch Back with Blending ===');

  const originalPanel = fs.readFileSync(originalPanelPath);
  const panelMeta = await sharp(originalPanel).metadata();
  console.log(`  Original panel: ${panelMeta.width}x${panelMeta.height}`);

  const { left, top, width, height } = faceRegion;
  console.log(`  Face region: left=${left}, top=${top}, width=${width}, height=${height}`);

  // Resize face to fit the region
  const resizedFace = await sharp(faceBuffer)
    .resize(width, height, { fit: 'cover' })
    .toBuffer();

  // Create a feathered/blurred mask for smooth blending
  const feather = 8;
  const mask = await sharp({
    create: {
      width: width,
      height: height,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 255 }
    }
  })
  .blur(feather)
  .toBuffer();

  // Apply mask to face (make edges transparent)
  const maskedFace = await sharp(resizedFace)
    .ensureAlpha()
    .composite([{
      input: mask,
      blend: 'dest-in'
    }])
    .toBuffer();

  // Composite onto original with blending
  const result = await sharp(originalPanel)
    .ensureAlpha()
    .composite([{ input: maskedFace, left, top, blend: 'over' }])
    .png()
    .toBuffer();

  fs.writeFileSync('tests/fixtures/pipeline-step3-final.png', result);
  console.log('  Saved: pipeline-step3-final.png');
  return result;
}

async function main() {
  console.log('=== FULL CHARACTER REPLACEMENT PIPELINE ===\n');

  const sourceFace = 'tests/fixtures/test-lukas-face-B-v3.png';  // Face to use
  const targetFace = 'tests/fixtures/test-lukas-face-C-v3.png';  // Face to replace
  const originalPanel = 'tests/fixtures/test-lukas-panel-C.png'; // Original full panel

  // Get face region from panel C (approximate - you may need to adjust)
  // Based on earlier mask: left=72, top=8, width=115, height=105
  const faceRegion = { left: 72, top: 8, width: 115, height: 105 };

  // Upload images
  console.log('Uploading images...');
  const sourceUrl = await uploadImage(sourceFace);
  const targetUrl = await uploadImage(targetFace);

  // Step 1: Face swap
  const swappedFace = await faceSwap(sourceUrl, targetUrl);
  if (!swappedFace) {
    console.error('Pipeline failed at face swap');
    return;
  }

  // Step 2: Fix hair
  const fixedFace = await fixHair(swappedFace);

  // Step 3: Stitch back
  await stitchBack(fixedFace, originalPanel, faceRegion);

  console.log('\n=== PIPELINE COMPLETE ===');
  console.log('Results:');
  console.log('  pipeline-step1-faceswap.png - After face swap');
  console.log('  pipeline-step2-hairfix.png  - After hair fix');
  console.log('  pipeline-step3-final.png    - Final composited result');
}

main().catch(console.error);
