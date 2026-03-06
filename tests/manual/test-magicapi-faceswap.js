/**
 * Test MagicAPI Face Swap from api.market
 *
 * Different from codeplugtech - this is api.market's native face swap
 * https://api.market/store/magicapi/faceswap
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.MAGICAPI_KEY || 'cml70oyze000qjr0412v3kdbt';
const API_BASE = 'https://api.magicapi.dev/api/v1/magicapi/faceswap';

async function uploadToFreeImageHost(imagePath) {
  console.log(`Uploading ${imagePath} to freeimage.host...`);

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

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`freeimage.host upload failed: ${response.status} - ${text}`);
  }

  const result = await response.json();
  if (!result.image?.url) {
    throw new Error(`No URL in response: ${JSON.stringify(result)}`);
  }

  console.log(`Uploaded: ${result.image.url}`);
  return result.image.url;
}

async function uploadTo0x0(imagePath) {
  console.log(`Uploading ${imagePath} to 0x0.st...`);

  const fileBuffer = fs.readFileSync(imagePath);
  const formData = new FormData();
  formData.append('file', new Blob([fileBuffer]), path.basename(imagePath));

  const response = await fetch('https://0x0.st', {
    method: 'POST',
    body: formData
  });

  if (!response.ok) {
    throw new Error(`0x0.st upload failed: ${response.status}`);
  }

  const url = await response.text();
  console.log(`Uploaded: ${url.trim()}`);
  return url.trim();
}

async function runFaceSwap(swapImageUrl, targetImageUrl) {
  console.log('\n--- MagicAPI Face Swap ---');
  console.log(`Swap (source face): ${swapImageUrl}`);
  console.log(`Target (scene): ${targetImageUrl}`);

  const startTime = Date.now();

  // Submit job
  const submitResp = await fetch(`${API_BASE}/faceswap-image`, {
    method: 'POST',
    headers: {
      'x-magicapi-key': API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      input: {
        swap_image: swapImageUrl,
        target_image: targetImageUrl
      }
    })
  });

  if (!submitResp.ok) {
    const errText = await submitResp.text();
    throw new Error(`Submit failed (${submitResp.status}): ${errText}`);
  }

  const submitResult = await submitResp.json();
  console.log('Submit response:', JSON.stringify(submitResult, null, 2));

  const requestId = submitResult.request_id || submitResult.id;
  if (!requestId) {
    // Maybe it returned the result directly?
    if (submitResult.output) {
      console.log(`Direct result: ${submitResult.output}`);
      return submitResult.output;
    }
    throw new Error('No request_id in response');
  }

  console.log(`Request ID: ${requestId}`);

  // Poll for result
  let result = null;
  let attempts = 0;
  const maxAttempts = 60; // Increase to 2 minutes

  while (!result && attempts < maxAttempts) {
    await new Promise(r => setTimeout(r, 2000));
    attempts++;
    process.stdout.write('.');

    const resultResp = await fetch(`${API_BASE}/result`, {
      method: 'POST',
      headers: {
        'x-magicapi-key': API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ request_id: requestId })
    });

    const resultText = await resultResp.text();

    if (!resultResp.ok) {
      console.log(`\nResult check error (${resultResp.status}): ${resultText}`);
      continue;
    }

    let resultData;
    try {
      resultData = JSON.parse(resultText);
    } catch (e) {
      console.log(`\nParse error: ${resultText}`);
      continue;
    }

    console.log(`\nPoll ${attempts}: ${JSON.stringify(resultData)}`);

    if (resultData.output) {
      result = resultData.output;
    } else if (resultData.status === 'FAILED' || resultData.error) {
      throw new Error(`Job failed: ${JSON.stringify(resultData)}`);
    }
    // Keep polling if status is IN_QUEUE or PROCESSING
  }

  const elapsed = Date.now() - startTime;
  console.log(`\nCompleted in ${elapsed}ms`);

  if (!result) {
    throw new Error('Timeout waiting for result');
  }

  console.log(`Output: ${result}`);
  return result;
}

async function testWithUnsplash() {
  console.log('\n=== Test 1: Public Images with Extensions ===');

  // API requires URLs with explicit file extensions
  // Using sample images from Wikipedia Commons (public domain)
  const sourceUrl = 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4c/Brad_Pitt_2019_by_Glenn_Francis.jpg/440px-Brad_Pitt_2019_by_Glenn_Francis.jpg';
  const targetUrl = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a0/Pierre-Person.jpg/440px-Pierre-Person.jpg';

  try {
    const resultUrl = await runFaceSwap(sourceUrl, targetUrl);

    if (resultUrl) {
      const imgResp = await fetch(resultUrl);
      const imgBuffer = Buffer.from(await imgResp.arrayBuffer());
      fs.writeFileSync('tests/fixtures/test-magicapi-unsplash.jpg', imgBuffer);
      console.log('Saved: tests/fixtures/test-magicapi-unsplash.jpg');
    }
  } catch (e) {
    console.error('Error:', e.message);
  }
}

async function testWithLocalImages() {
  console.log('\n=== Test 2: Local Images via freeimage.host ===');

  const sourceImage = 'tests/fixtures/characters/Sophie.jpg';

  if (!fs.existsSync(sourceImage)) {
    console.log(`Source not found: ${sourceImage}`);
    return;
  }

  // Find a target image - we need another person's photo
  const targetCandidates = [
    'tests/fixtures/test-lukas-panel-C.png',
    'tests/fixtures/bbox-crops/page13_original.png',
    'tests/fixtures/test-lukas-face-B-v3.png'
  ];

  let targetPath = null;
  for (const candidate of targetCandidates) {
    if (fs.existsSync(candidate)) {
      targetPath = candidate;
      break;
    }
  }

  try {
    // Upload source image
    const sourceUrl = await uploadToFreeImageHost(sourceImage);

    // For target, use a public image with face (Wikipedia portrait)
    const targetUrl = 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ec/Mona_Lisa%2C_by_Leonardo_da_Vinci%2C_from_C2RMF_retouched.jpg/800px-Mona_Lisa%2C_by_Leonardo_da_Vinci%2C_from_C2RMF_retouched.jpg';

    const resultUrl = await runFaceSwap(sourceUrl, targetUrl);

    if (resultUrl) {
      const imgResp = await fetch(resultUrl);
      const imgBuffer = Buffer.from(await imgResp.arrayBuffer());
      fs.writeFileSync('tests/fixtures/test-magicapi-local.jpg', imgBuffer);
      console.log('Saved: tests/fixtures/test-magicapi-local.jpg');
    }
  } catch (e) {
    console.error('Error:', e.message);
  }
}

async function testWith0x0() {
  console.log('\n=== Test 3: Local Images via 0x0.st ===');

  const sourceImage = 'tests/fixtures/characters/Sophie.jpg';

  if (!fs.existsSync(sourceImage)) {
    console.log(`Source not found: ${sourceImage}`);
    return;
  }

  try {
    const sourceUrl = await uploadTo0x0(sourceImage);

    // Use Unsplash as target (known working domain)
    const targetUrl = 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=512';

    const resultUrl = await runFaceSwap(sourceUrl, targetUrl);

    if (resultUrl) {
      const imgResp = await fetch(resultUrl);
      const imgBuffer = Buffer.from(await imgResp.arrayBuffer());
      fs.writeFileSync('tests/fixtures/test-magicapi-0x0.jpg', imgBuffer);
      console.log('Saved: tests/fixtures/test-magicapi-0x0.jpg');
    }
  } catch (e) {
    console.error('Error:', e.message);
  }
}

async function testIllustration() {
  console.log('\n=== Test 4: Sophie Face onto Lukas Illustration ===');

  const sourceImage = 'tests/fixtures/characters/Sophie.jpg';
  const targetImage = 'tests/fixtures/test-lukas-panel-C.png';

  if (!fs.existsSync(sourceImage)) {
    console.log(`Source not found: ${sourceImage}`);
    return;
  }

  if (!fs.existsSync(targetImage)) {
    console.log(`Target not found: ${targetImage}`);
    return;
  }

  try {
    // Upload both images
    console.log('Uploading source (Sophie face)...');
    const sourceUrl = await uploadToFreeImageHost(sourceImage);

    console.log('Uploading target (Lukas panel C)...');
    const targetUrl = await uploadToFreeImageHost(targetImage);

    const resultUrl = await runFaceSwap(sourceUrl, targetUrl);

    if (resultUrl) {
      const imgResp = await fetch(resultUrl);
      const imgBuffer = Buffer.from(await imgResp.arrayBuffer());
      fs.writeFileSync('tests/fixtures/test-magicapi-illustration.png', imgBuffer);
      console.log('Saved: tests/fixtures/test-magicapi-illustration.png');
    }
  } catch (e) {
    console.error('Error:', e.message);
  }
}

async function testRealPhoto() {
  console.log('\n=== Test 5: Face swap between two real photos ===');

  const sourceImage = 'tests/fixtures/characters/Sophie.jpg';
  const targetImage = 'tests/fixtures/test-lukas-real-single.png';

  if (!fs.existsSync(sourceImage) || !fs.existsSync(targetImage)) {
    console.log('Images not found');
    return;
  }

  try {
    const sourceUrl = await uploadToFreeImageHost(sourceImage);
    const targetUrl = await uploadToFreeImageHost(targetImage);

    const resultUrl = await runFaceSwap(sourceUrl, targetUrl);

    if (resultUrl) {
      const imgResp = await fetch(resultUrl);
      const imgBuffer = Buffer.from(await imgResp.arrayBuffer());
      fs.writeFileSync('tests/fixtures/test-magicapi-realphoto.png', imgBuffer);
      console.log('Saved: tests/fixtures/test-magicapi-realphoto.png');
    }
  } catch (e) {
    console.error('Error:', e.message);
  }
}

async function testCropped() {
  console.log('\n=== Test 6: Cropped single faces ===');

  const sourceImage = 'tests/fixtures/test-sophie-frontal.jpg';
  const targetImage = 'tests/fixtures/test-lukas-single-cropped.jpg';

  if (!fs.existsSync(sourceImage) || !fs.existsSync(targetImage)) {
    console.log('Cropped images not found. Run the crop commands first.');
    return;
  }

  try {
    console.log('Uploading Sophie frontal face...');
    const sourceUrl = await uploadToFreeImageHost(sourceImage);

    console.log('Uploading Lukas single face...');
    const targetUrl = await uploadToFreeImageHost(targetImage);

    const resultUrl = await runFaceSwap(sourceUrl, targetUrl);

    if (resultUrl) {
      const imgResp = await fetch(resultUrl);
      const imgBuffer = Buffer.from(await imgResp.arrayBuffer());
      fs.writeFileSync('tests/fixtures/test-magicapi-cropped.jpg', imgBuffer);
      console.log('Saved: tests/fixtures/test-magicapi-cropped.jpg');
    }
  } catch (e) {
    console.error('Error:', e.message);
  }
}

async function main() {
  console.log('MagicAPI Face Swap Testing');
  console.log('===========================\n');
  console.log(`API Key: ${API_KEY.substring(0, 8)}...`);

  const args = process.argv.slice(2);

  if (args.includes('--unsplash')) {
    await testWithUnsplash();
  } else if (args.includes('--local')) {
    await testWithLocalImages();
  } else if (args.includes('--0x0')) {
    await testWith0x0();
  } else if (args.includes('--illustration')) {
    await testIllustration();
  } else if (args.includes('--realphoto')) {
    await testRealPhoto();
  } else if (args.includes('--cropped')) {
    await testCropped();
  } else {
    // Default: test cropped
    await testCropped();
  }

  console.log('\n=== Done ===');
}

main().catch(console.error);
