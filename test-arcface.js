const fs = require('fs');
const path = require('path');

async function test() {
  const img1Path = path.join(__dirname, 'test-output', 'face-variations-1768656355768', '2-variation-1-top-left.jpg');
  const img2Path = path.join(__dirname, 'test-output', 'face-variations-1768656355768', '2-variation-2-top-right.jpg');

  const img1 = `data:image/jpeg;base64,${fs.readFileSync(img1Path).toString('base64')}`;
  const img2 = `data:image/jpeg;base64,${fs.readFileSync(img2Path).toString('base64')}`;

  console.log('Testing ArcFace with real images...');

  const response = await fetch('http://127.0.0.1:5000/compare-identity', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image1: img1, image2: img2 })
  });

  const result = await response.json();
  console.log('Result:', JSON.stringify(result, null, 2));
}

test().catch(console.error);
