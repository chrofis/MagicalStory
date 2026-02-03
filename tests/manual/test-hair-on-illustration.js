/**
 * Test Hair V2 API on illustrated character faces
 */
const fs = require('fs');

const API_KEY = 'cml70oyze000qjr0412v3kdbt';
const API_BASE = 'https://api.magicapi.dev/api/v1/magicapi/hair-v2';

async function uploadToFreeImageHost(imagePath) {
  console.log('Uploading', imagePath, '...');
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
  console.log('Uploaded:', result.image.url);
  return result.image.url;
}

async function runHairChange(imageUrl, hairColor, hairStyle) {
  console.log('Changing hair to:', hairStyle, hairColor);

  const submitResp = await fetch(API_BASE + '/run', {
    method: 'POST',
    headers: { 'x-magicapi-key': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: {
        image: imageUrl,
        haircolor: hairColor,
        hairstyle: hairStyle
      }
    })
  });

  const submitResult = await submitResp.json();
  console.log('Job:', submitResult.id, submitResult.status);

  if (submitResult.error || submitResult.message) {
    console.error('Error:', submitResult);
    return null;
  }

  // Poll for result
  let result = submitResult;
  let attempts = 0;
  while (result.status !== 'COMPLETED' && result.status !== 'FAILED' && attempts < 30) {
    await new Promise(r => setTimeout(r, 3000));
    attempts++;
    process.stdout.write('.');

    const statusResp = await fetch(API_BASE + '/status/' + submitResult.id, {
      headers: { 'x-magicapi-key': API_KEY }
    });
    result = await statusResp.json();
  }
  console.log(' ' + result.status);

  if (result.status === 'FAILED') {
    console.error('Failed:', result);
    return null;
  }

  return result.output?.image_url;
}

async function runHairChangeWithProperty(imageUrl, hairColor, hairStyle, hairProperty, outputName) {
  console.log(`Testing: ${hairStyle} (${hairProperty || 'no property'})`);

  const input = { image: imageUrl, haircolor: hairColor, hairstyle: hairStyle };
  if (hairProperty) input.hairproperty = hairProperty;

  const submitResp = await fetch(API_BASE + '/run', {
    method: 'POST',
    headers: { 'x-magicapi-key': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input })
  });
  const submitResult = await submitResp.json();

  if (submitResult.error || submitResult.message) {
    console.error('Error:', submitResult);
    return null;
  }

  let result = submitResult;
  let attempts = 0;
  while (result.status !== 'COMPLETED' && result.status !== 'FAILED' && attempts < 30) {
    await new Promise(r => setTimeout(r, 3000));
    attempts++;
    process.stdout.write('.');
    const statusResp = await fetch(API_BASE + '/status/' + submitResult.id, {
      headers: { 'x-magicapi-key': API_KEY }
    });
    result = await statusResp.json();
  }
  console.log(' ' + result.status);

  if (result.output?.image_url) {
    const imgResp = await fetch(result.output.image_url);
    const imgBuffer = Buffer.from(await imgResp.arrayBuffer());
    fs.writeFileSync('tests/fixtures/' + outputName, imgBuffer);
    console.log('Saved: ' + outputName);
  }
  return result.output?.image_url;
}

async function main() {
  console.log('Testing Hair V2 API - Forward swept bangs\n');

  const imageUrl = await uploadToFreeImageHost('tests/fixtures/test-lukas-face-C-v3.png');

  // Try forward/bangs style - straight, not curly (like real Lukas)
  await runHairChangeWithProperty(imageUrl, 'light brown', 'forward swept bangs', 'straight', 'test-hair-bangs1.png');
  await runHairChangeWithProperty(imageUrl, 'light brown', 'fringe', 'straight', 'test-hair-fringe.png');
  await runHairChangeWithProperty(imageUrl, 'light brown', 'textured fringe', 'straight', 'test-hair-textured.png');
}

main().catch(console.error);
