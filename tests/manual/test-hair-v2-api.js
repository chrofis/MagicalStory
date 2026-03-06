/**
 * Test Hair V2 API from api.market
 *
 * API requires publicly accessible image URLs.
 * catbox.moe URLs are blocked, so we try alternative hosting.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

// API key from environment or hardcoded for testing
const API_KEY = process.env.MAGICAPI_KEY || 'cml70oyze000qjr0412v3kdbt';
// IMPORTANT: Use api.magicapi.dev NOT api.market - the latter has Redis issues
const API_BASE = 'https://api.magicapi.dev/api/v1/magicapi/hair-v2';

async function uploadToFileIo(imagePath) {
  console.log(`Uploading ${imagePath} to file.io...`);

  const formData = new FormData();
  const fileBuffer = fs.readFileSync(imagePath);
  const blob = new Blob([fileBuffer], { type: 'image/jpeg' });
  formData.append('file', blob, path.basename(imagePath));

  const response = await fetch('https://file.io', {
    method: 'POST',
    body: formData
  });

  const result = await response.json();
  if (!result.success) {
    throw new Error(`file.io upload failed: ${JSON.stringify(result)}`);
  }

  console.log(`Uploaded: ${result.link}`);
  return result.link;
}

async function uploadToImgBB(imagePath) {
  console.log(`Uploading ${imagePath} to imgbb (anonymous)...`);

  const imageBase64 = fs.readFileSync(imagePath).toString('base64');

  const formData = new URLSearchParams();
  formData.append('image', imageBase64);

  // Using anonymous upload (no API key needed for basic usage)
  const response = await fetch('https://api.imgbb.com/1/upload?key=YOUR_KEY', {
    method: 'POST',
    body: formData
  });

  const result = await response.json();
  if (!result.success) {
    throw new Error(`imgbb upload failed: ${JSON.stringify(result)}`);
  }

  console.log(`Uploaded: ${result.data.url}`);
  return result.data.url;
}

async function runHairChange(imageUrl, hairColor, hairStyle, hairProperty = '') {
  console.log('\n--- Hair V2 API ---');
  console.log(`Image: ${imageUrl}`);
  console.log(`Hair Color: ${hairColor}`);
  console.log(`Hair Style: ${hairStyle}`);
  if (hairProperty) console.log(`Hair Property: ${hairProperty}`);

  // Submit job
  const submitResp = await fetch(`${API_BASE}/run`, {
    method: 'POST',
    headers: {
      'x-magicapi-key': API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      input: {
        image: imageUrl,
        haircolor: hairColor,
        hairstyle: hairStyle,
        ...(hairProperty && { hairproperty: hairProperty })
      }
    })
  });

  if (!submitResp.ok) {
    const errText = await submitResp.text();
    throw new Error(`Submit failed (${submitResp.status}): ${errText}`);
  }

  const submitResult = await submitResp.json();
  console.log(`Job ID: ${submitResult.id}`);
  console.log(`Status: ${submitResult.status}`);

  // Poll for completion
  let result = submitResult;
  const startTime = Date.now();

  while (result.status !== 'COMPLETED' && result.status !== 'FAILED') {
    await new Promise(r => setTimeout(r, 3000));

    const statusResp = await fetch(`${API_BASE}/status/${submitResult.id}`, {
      headers: { 'x-magicapi-key': API_KEY }
    });

    result = await statusResp.json();
    process.stdout.write(`.${result.status}`);
  }

  const elapsed = Date.now() - startTime;
  console.log(`\nCompleted in ${elapsed}ms`);

  if (result.status === 'FAILED') {
    console.error('FAILED:', result.error || result);
    return null;
  }

  console.log('Output:', JSON.stringify(result.output, null, 2));
  return result.output?.image_url;
}

async function testWithUnsplash() {
  console.log('\n=== Test 1: Unsplash Image (known working) ===');

  // Use a real photo from Unsplash
  const unsplashUrl = 'https://images.unsplash.com/photo-1531746020798-e6953c6e8e04?w=512';

  const resultUrl = await runHairChange(
    unsplashUrl,
    'red',
    'short bob',
    'wavy'
  );

  if (resultUrl) {
    console.log(`\nResult: ${resultUrl}`);

    // Download result
    const imgResp = await fetch(resultUrl);
    const imgBuffer = Buffer.from(await imgResp.arrayBuffer());
    fs.writeFileSync('tests/fixtures/test-hair-unsplash-result.jpg', imgBuffer);
    console.log('Saved: tests/fixtures/test-hair-unsplash-result.jpg');
  }
}

async function testWithFileIo() {
  console.log('\n=== Test 2: Local Image via file.io ===');

  const localImage = 'tests/fixtures/characters/Sophie.jpg';

  if (!fs.existsSync(localImage)) {
    console.log(`Image not found: ${localImage}`);
    return;
  }

  try {
    const uploadedUrl = await uploadToFileIo(localImage);

    const resultUrl = await runHairChange(
      uploadedUrl,
      'brunette',
      'long wavy',
      'curly'
    );

    if (resultUrl) {
      console.log(`\nResult: ${resultUrl}`);

      const imgResp = await fetch(resultUrl);
      const imgBuffer = Buffer.from(await imgResp.arrayBuffer());
      fs.writeFileSync('tests/fixtures/test-hair-sophie-result.jpg', imgBuffer);
      console.log('Saved: tests/fixtures/test-hair-sophie-result.jpg');
    }
  } catch (e) {
    console.error('Error:', e.message);
  }
}

async function testWithDirectUrl() {
  console.log('\n=== Test 3: Direct URL from Github/CDN ===');

  // Try a direct CDN URL that might be accepted
  // Using a sample face image from a public CDN
  const cdnUrl = 'https://raw.githubusercontent.com/opencv/opencv/master/samples/data/lena.jpg';

  try {
    const resultUrl = await runHairChange(
      cdnUrl,
      'blonde',
      'pixie cut',
      'straight'
    );

    if (resultUrl) {
      console.log(`\nResult: ${resultUrl}`);
    }
  } catch (e) {
    console.error('Error:', e.message);
  }
}

async function main() {
  console.log('Hair V2 API Testing');
  console.log('====================\n');

  const args = process.argv.slice(2);

  if (args.includes('--unsplash')) {
    await testWithUnsplash();
  } else if (args.includes('--fileio')) {
    await testWithFileIo();
  } else if (args.includes('--github')) {
    await testWithDirectUrl();
  } else {
    // Run all tests
    await testWithUnsplash();
    // await testWithFileIo();  // Disabled by default - file.io URLs expire
    // await testWithDirectUrl();
  }

  console.log('\n=== Done ===');
}

main().catch(console.error);
