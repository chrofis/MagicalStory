/**
 * Test Replicate face swap models
 */

require('dotenv').config();
const Replicate = require('replicate');
const fs = require('fs');
const path = require('path');

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN
});

async function toDataUri(filePath) {
  const buffer = fs.readFileSync(filePath);
  const ext = path.extname(filePath).slice(1);
  return `data:image/${ext};base64,${buffer.toString('base64')}`;
}

async function downloadImage(url, outputPath) {
  const response = await fetch(url);
  const buffer = await response.arrayBuffer();
  fs.writeFileSync(outputPath, Buffer.from(buffer));
  console.log(`Saved: ${outputPath}`);
}

async function testCodeplugtech(targetImage, sourceFace, outputPrefix) {
  console.log('\n--- Testing codeplugtech/face-swap ---');
  const startTime = Date.now();

  try {
    const output = await replicate.run(
      "codeplugtech/face-swap",
      {
        input: {
          source_image: await toDataUri(sourceFace),
          target_image: await toDataUri(targetImage)
        }
      }
    );

    const elapsed = Date.now() - startTime;
    console.log(`Time: ${elapsed}ms`);

    if (output) {
      await downloadImage(output, `${outputPrefix}-codeplugtech.png`);
      return true;
    }
  } catch (e) {
    console.error('codeplugtech error:', e.message);
  }
  return false;
}

async function testEasel(targetImage, sourceFace, outputPrefix) {
  console.log('\n--- Testing easel/advanced-face-swap ---');
  const startTime = Date.now();

  try {
    const output = await replicate.run(
      "easel/advanced-face-swap",
      {
        input: {
          swap_image: await toDataUri(sourceFace),
          target_image: await toDataUri(targetImage),
          hair_source: "target"
        }
      }
    );

    const elapsed = Date.now() - startTime;
    console.log(`Time: ${elapsed}ms`);

    if (output) {
      await downloadImage(output, `${outputPrefix}-easel.png`);
      return true;
    }
  } catch (e) {
    console.error('easel error:', e.message);
  }
  return false;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.log(`
Usage: node scripts/test-replicate-faceswap.js <target-image> <source-face> [output-prefix] [model]

Models: codeplugtech, easel, all (default: all)
`);
    return;
  }

  const targetImage = args[0];
  const sourceFace = args[1];
  const outputPrefix = args[2] || 'output/faceswap-test/replicate';
  const model = args[3] || 'all';

  console.log(`Target: ${targetImage}`);
  console.log(`Source face: ${sourceFace}`);

  if (model === 'all' || model === 'codeplugtech') {
    await testCodeplugtech(targetImage, sourceFace, outputPrefix);
  }

  if (model === 'all' || model === 'easel') {
    // Wait a bit to avoid rate limiting
    if (model === 'all') {
      console.log('\nWaiting 10s to avoid rate limit...');
      await new Promise(r => setTimeout(r, 10000));
    }
    await testEasel(targetImage, sourceFace, outputPrefix);
  }

  console.log('\nDone!');
}

main().catch(console.error);
