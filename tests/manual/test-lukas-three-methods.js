/**
 * Test three face replacement methods on Lukas illustration
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;

function imageToDataUri(imgPath) {
  const buffer = fs.readFileSync(imgPath);
  const ext = path.extname(imgPath).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

async function runReplicate(version, input, label) {
  console.log(`\n--- ${label} ---`);

  const resp = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${REPLICATE_API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ version, input })
  });

  const pred = await resp.json();
  if (pred.error) { console.error('Error:', pred.error); return null; }
  console.log('ID:', pred.id);

  let result = pred;
  while (result.status !== 'succeeded' && result.status !== 'failed') {
    await new Promise(r => setTimeout(r, 2000));
    const poll = await fetch(`https://api.replicate.com/v1/predictions/${pred.id}`, {
      headers: { 'Authorization': `Bearer ${REPLICATE_API_TOKEN}` }
    });
    result = await poll.json();
    process.stdout.write('.');
  }
  console.log(' ' + result.status);

  if (result.status === 'failed') { console.error('Failed:', result.error); return null; }

  const url = Array.isArray(result.output) ? result.output[0] : result.output;
  const imgResp = await fetch(url);
  return Buffer.from(await imgResp.arrayBuffer());
}

async function main() {
  const targetPanel = 'tests/fixtures/test-lukas-panel-C.png';
  const sourceFace = 'tests/fixtures/test-lukas-face-B-v3.png';

  console.log('Target: Panel C (full)');
  console.log('Source: Face B v3 (cropped with hair)');

  // Method 1: Face Swap (codeplugtech)
  const faceSwapResult = await runReplicate(
    '278a81e7ebb22db98bcba54de985d22cc1abeead2754eb1f2af717247be69b34',
    {
      input_image: imageToDataUri(targetPanel),
      swap_image: imageToDataUri(sourceFace)
    },
    'Method 1: Face Swap (codeplugtech) - $0.003'
  );
  if (faceSwapResult) {
    fs.writeFileSync('tests/fixtures/test-lukas-method1-faceswap.png', faceSwapResult);
    console.log('Saved: test-lukas-method1-faceswap.png');
  }

  // Method 2: IP-Adapter FaceID
  const ipAdapterResult = await runReplicate(
    'fb81ef963e74776af72e6f380949013533d46dd5c6228a9e586c57db6303d7cd',
    {
      face_image: imageToDataUri(sourceFace),
      prompt: 'illustration of a young boy in blue striped hoodie sitting on floor opening a glowing treasure chest, living room with couch, magical sparkles, children book illustration style',
      negative_prompt: 'realistic, photo, blurry, low quality, ugly, deformed',
      width: 512,
      height: 512,
      agree_to_research_only: true
    },
    'Method 2: IP-Adapter FaceID - $0.03'
  );
  if (ipAdapterResult) {
    fs.writeFileSync('tests/fixtures/test-lukas-method2-ipadapter.png', ipAdapterResult);
    console.log('Saved: test-lukas-method2-ipadapter.png');
  }

  // Method 3: FLUX Fill Inpainting
  console.log('\n--- Method 3: FLUX Fill Inpainting - $0.002 ---');
  const { inpaintWithRunware, RUNWARE_MODELS } = require('./server/lib/runware.js');

  const panelC = fs.readFileSync(targetPanel);
  const panelMeta = await sharp(panelC).metadata();

  // Create mask for face region: left=72, top=8, width=115, height=105
  const mask = await sharp({
    create: { width: panelMeta.width, height: panelMeta.height, channels: 3, background: {r:0,g:0,b:0} }
  })
  .composite([{
    input: await sharp({create: {width: 115, height: 105, channels: 3, background: {r:255,g:255,b:255}}}).png().toBuffer(),
    left: 72, top: 8
  }])
  .png().toBuffer();

  fs.writeFileSync('tests/fixtures/test-lukas-mask-C.png', mask);
  console.log('Mask saved: test-lukas-mask-C.png');

  const inpaintResult = await inpaintWithRunware(
    panelC,
    mask,
    'young boy face with brown hair, gentle smile, same art style, children book illustration',
    { model: RUNWARE_MODELS.FLUX_FILL, width: panelMeta.width, height: panelMeta.height, strength: 0.95 }
  );

  let inpaintBuffer;
  if (inpaintResult.imageData.startsWith('data:')) {
    inpaintBuffer = Buffer.from(inpaintResult.imageData.split(',')[1], 'base64');
  } else if (inpaintResult.imageData.startsWith('http')) {
    const r = await fetch(inpaintResult.imageData);
    inpaintBuffer = Buffer.from(await r.arrayBuffer());
  } else {
    inpaintBuffer = Buffer.from(inpaintResult.imageData, 'base64');
  }
  fs.writeFileSync('tests/fixtures/test-lukas-method3-inpaint.png', inpaintBuffer);
  console.log('Saved: test-lukas-method3-inpaint.png');

  console.log('\n=== All methods complete ===');
}

main().catch(console.error);
