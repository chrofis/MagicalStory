/**
 * Test pipeline on FULL images (no cropping)
 * See if face swap + hair fix work on complete scenes
 */
const fs = require('fs');
const path = require('path');

const API_KEY = 'cml70oyze000qjr0412v3kdbt';
const FACESWAP_BASE = 'https://api.magicapi.dev/api/v1/magicapi/faceswap';
const HAIR_BASE = 'https://api.magicapi.dev/api/v1/magicapi/hair-v2';

async function uploadImage(imagePath) {
  console.log(`  Uploading ${path.basename(imagePath)}...`);
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
  console.log('  Running face swap...');

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
    return null;
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

  if (result.status === 'failed') return null;

  const imgResp = await fetch(result.output);
  return Buffer.from(await imgResp.arrayBuffer());
}

async function fixHair(imageBuffer) {
  console.log('  Running hair fix...');

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

async function runPipeline(targetImage, sourceImage, outputPrefix) {
  console.log(`\n=== Pipeline: ${outputPrefix} ===`);
  console.log(`  Target: ${targetImage}`);
  console.log(`  Source: ${sourceImage}`);

  // Upload images
  const targetUrl = await uploadImage(targetImage);
  const sourceUrl = await uploadImage(sourceImage);

  // Step 1: Face swap
  const swapped = await faceSwap(sourceUrl, targetUrl);
  if (!swapped) {
    console.log('  Face swap failed, skipping...');
    return;
  }
  fs.writeFileSync(`tests/fixtures/${outputPrefix}-step1-faceswap.png`, swapped);
  console.log(`  Saved: ${outputPrefix}-step1-faceswap.png`);

  // Step 2: Hair fix
  const fixed = await fixHair(swapped);
  fs.writeFileSync(`tests/fixtures/${outputPrefix}-step2-hairfix.png`, fixed);
  console.log(`  Saved: ${outputPrefix}-step2-hairfix.png`);

  console.log(`  Done: ${outputPrefix}`);
}

async function main() {
  console.log('=== FULL IMAGE PIPELINE TEST ===\n');

  // Test 1: Full panel C with face B as source
  await runPipeline(
    'tests/fixtures/test-lukas-panel-C.png',
    'tests/fixtures/test-lukas-face-B-v3.png',
    'fullimg-panelC'
  );

  // Test 2: test-simple-swap-replicate (if exists)
  const simpleSwapPath = 'tests/fixtures/test-simple-swap-replicate.png';
  if (fs.existsSync(simpleSwapPath)) {
    await runPipeline(
      simpleSwapPath,
      'tests/fixtures/test-lukas-face-B-v3.png',
      'fullimg-simpleswap'
    );
  } else {
    console.log(`\nSkipping: ${simpleSwapPath} not found`);

    // Try to find similar files
    const fixtures = fs.readdirSync('tests/fixtures').filter(f => f.includes('swap') || f.includes('replicate'));
    if (fixtures.length > 0) {
      console.log('Available swap/replicate files:', fixtures.slice(0, 5));
    }
  }

  console.log('\n=== ALL TESTS COMPLETE ===');
}

main().catch(console.error);
