/**
 * Test FLUX AI Hair Style & Color Changer API
 * https://api.market/store/magicapi/flux-ai-hair-style-color-changer
 */
require('dotenv').config();
const fs = require('fs');

const API_KEY = process.env.MAGICAPI_KEY || 'cml70oyze000qjr0412v3kdbt';
const API_BASE = 'https://prod.api.market/api/v1/magicapi/ai-hair-style-color-changer';

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

  const result = await response.json();
  if (!result.image?.url) {
    throw new Error(`Upload failed: ${JSON.stringify(result)}`);
  }
  console.log(`Uploaded: ${result.image.url}`);
  return result.image.url;
}

async function runHairChange(imageUrl, haircut, hairColor) {
  console.log('\n--- FLUX Hair Changer ---');
  console.log(`Image: ${imageUrl}`);
  console.log(`Haircut: ${haircut}`);
  console.log(`Color: ${hairColor}`);

  const startTime = Date.now();

  // Create prediction
  const submitResp = await fetch(`${API_BASE}/predictions`, {
    method: 'POST',
    headers: {
      'x-magicapi-key': API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      input: {
        input_image: imageUrl,
        haircut: haircut,
        hair_color: hairColor,
        aspect_ratio: 'match_input_image',
        output_format: 'png',
        safety_tolerance: 2
      }
    })
  });

  if (!submitResp.ok) {
    const errText = await submitResp.text();
    throw new Error(`Submit failed (${submitResp.status}): ${errText}`);
  }

  const submitResult = await submitResp.json();
  console.log(`Prediction ID: ${submitResult.id}`);
  console.log(`Status: ${submitResult.status}`);

  // Poll for result
  let result = submitResult;
  let attempts = 0;
  const maxAttempts = 60;

  while (result.status !== 'succeeded' && result.status !== 'failed' && attempts < maxAttempts) {
    await new Promise(r => setTimeout(r, 2000));
    attempts++;
    process.stdout.write('.');

    const statusResp = await fetch(`${API_BASE}/predictions/${submitResult.id}`, {
      headers: { 'x-magicapi-key': API_KEY }
    });

    if (!statusResp.ok) {
      console.log(`\nStatus check failed: ${statusResp.status}`);
      continue;
    }

    result = await statusResp.json();
  }

  const elapsed = Date.now() - startTime;
  console.log(`\nCompleted in ${elapsed}ms`);
  console.log(`Status: ${result.status}`);

  if (result.status === 'failed') {
    console.error('Failed:', result.error || result);
    return null;
  }

  if (result.status !== 'succeeded') {
    console.error('Timeout or unknown status');
    return null;
  }

  const outputUrl = result.output;
  console.log(`Output: ${outputUrl}`);
  return outputUrl;
}

async function main() {
  console.log('FLUX Hair Changer API Test');
  console.log('==========================\n');

  const sourceImage = 'tests/fixtures/test-sophie-frontal.jpg';

  if (!fs.existsSync(sourceImage)) {
    console.log(`Source not found: ${sourceImage}`);
    return;
  }

  try {
    // Upload image
    const imageUrl = await uploadToFreeImageHost(sourceImage);

    // Test 1: Change to short bob, blonde
    const result1 = await runHairChange(imageUrl, 'Short Bob', 'blonde');
    if (result1) {
      const imgResp = await fetch(result1);
      const imgBuffer = Buffer.from(await imgResp.arrayBuffer());
      fs.writeFileSync('tests/fixtures/test-flux-hair-blonde-bob.png', imgBuffer);
      console.log('Saved: tests/fixtures/test-flux-hair-blonde-bob.png');
    }

    // Test 2: Change to long wavy, red
    const result2 = await runHairChange(imageUrl, 'Long Wavy', 'red');
    if (result2) {
      const imgResp = await fetch(result2);
      const imgBuffer = Buffer.from(await imgResp.arrayBuffer());
      fs.writeFileSync('tests/fixtures/test-flux-hair-red-wavy.png', imgBuffer);
      console.log('Saved: tests/fixtures/test-flux-hair-red-wavy.png');
    }

  } catch (e) {
    console.error('Error:', e.message);
  }

  console.log('\n=== Done ===');
}

main().catch(console.error);
