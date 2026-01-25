#!/usr/bin/env node
require('dotenv').config();
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const outputDir = 'output/story-job_1768859833557_x2dpb3fe2';
const facesDir = path.join(outputDir, 'faces/Luis');
const inputDir = path.join(outputDir, 'input');

// Create input folder
if (!fs.existsSync(inputDir)) fs.mkdirSync(inputDir);

const CELL_SIZE = 256;
const apiKey = process.env.GEMINI_API_KEY;
const model = 'gemini-2.5-flash-image';

const prompt = `Change the hair in this image to match this exact style:

COLOR: dark brown #65350F
PARTING: right side
TYPE: messy, tousled, wispy texture - NOT straight
LENGTH: very short, cropped
BANGS: very short, ending at mid-forehead (NOT touching eyebrows)

The hair should look natural and slightly messy, not neat or slicked.
Keep face, expression, pose, clothes, background unchanged.`;

function buildPrompt(count, cols) {
  const positions = [];
  const rows = Math.ceil(count / cols);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (idx >= count) break;
      const rowName = r === 0 ? 'Top' : r === 1 ? 'Middle' : 'Bottom';
      const colName = c === 0 ? 'left' : c === 1 ? 'center' : 'right';
      const pos = cols === 1 ? `Image ${idx + 1}` : `${rowName}-${colName} face`;
      positions.push(`${pos}: change hair to dark brown #65350F`);
    }
  }

  return `This is a grid of ${count} child face images.

Change the hair in EACH face to this style:
- COLOR: dark brown #65350F
- TYPE: messy, tousled, wispy - NOT straight
- LENGTH: very short, cropped
- BANGS: very short, mid-forehead (NOT touching eyebrows)

${positions.join('\n')}

Every face listed above must have its hair changed.
Keep faces, expressions, poses, clothes, backgrounds unchanged.`;
}

async function loadFaces(count) {
  const faceFiles = fs.readdirSync(facesDir).filter(f => f.endsWith('.jpg'));
  const faces = [];
  for (let i = 0; i < count && i < faceFiles.length; i++) {
    const buffer = await sharp(path.join(facesDir, faceFiles[i]))
      .resize(CELL_SIZE, CELL_SIZE, { fit: 'cover' })
      .toBuffer();
    faces.push(buffer);
  }
  return faces;
}

async function createGrid(faces, cols) {
  const rows = Math.ceil(faces.length / cols);
  const composites = faces.map((buf, i) => ({
    input: buf,
    left: (i % cols) * CELL_SIZE,
    top: Math.floor(i / cols) * CELL_SIZE
  }));
  return sharp({
    create: { width: cols * CELL_SIZE, height: rows * CELL_SIZE, channels: 3, background: { r: 255, g: 255, b: 255 } }
  }).composite(composites).jpeg({ quality: 95 }).toBuffer();
}

async function processGrid(label, count, cols) {
  const faces = await loadFaces(count);
  const inputBuffer = count === 1 ? faces[0] : await createGrid(faces, cols);

  // Save input
  const inputPath = path.join(inputDir, label + '-input.jpg');
  fs.writeFileSync(inputPath, inputBuffer);
  console.log('Input saved:', inputPath);

  // Call Gemini
  const promptText = buildPrompt(count, cols);
  console.log('Sending', label, 'to Gemini...');

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [
          { text: promptText },
          { inline_data: { mime_type: 'image/jpeg', data: inputBuffer.toString('base64') } }
        ]}],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'], temperature: 0.1 }
      })
    }
  );

  const result = await response.json();
  const parts = result.candidates?.[0]?.content?.parts || [];

  for (const part of parts) {
    const inlineData = part.inlineData || part.inline_data;
    if (inlineData?.data) {
      const outPath = path.join(outputDir, label + '-output-v2.png');
      fs.writeFileSync(outPath, Buffer.from(inlineData.data, 'base64'));
      console.log('Output saved:', outPath);
      return;
    }
  }
  console.log('No image returned for', label);
}

async function main() {
  // Test with 3 images (1x3 grid)
  await processGrid('3faces', 3, 3);

  // Test with 2x2 grid (4 images)
  await processGrid('2x2', 4, 2);
}

main().catch(console.error);
