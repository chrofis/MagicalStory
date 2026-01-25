#!/usr/bin/env node
require('dotenv').config();
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const outputDir = 'output/story-job_1768859833557_x2dpb3fe2';
const facesDir = path.join(outputDir, 'faces/Luis');
const apiKey = process.env.GEMINI_API_KEY;
const model = 'gemini-2.5-flash-image';

// New style
const individualPrompt = `Change the hair in this image:

COLOR: dark brown #4C3224
TYPE: straight, styled
TEXTURE: medium thickness
PARTING: side part on the right
LENGTH: short on top and sides
BANGS: no bangs

Keep face, expression, pose, clothes, background unchanged.`;

// Varied descriptions for 2x2 grid (same style, different wording)
const gridPrompt = `This is a 2x2 grid of 4 child face images.

Change the hair in EACH face to match these instructions:

Top-left face:
- COLOR: dark espresso brown #4C3224
- TYPE: straight, neatly styled
- PARTING: right side part
- LENGTH: short all around
- BANGS: none, forehead fully visible

Top-right face:
- COLOR: deep walnut #4C3224
- PARTING: parted on the right
- TYPE: styled, straight hair
- LENGTH: short on top and sides
- BANGS: no bangs at all

Bottom-left face:
- COLOR: rich dark brown #4C3224
- LENGTH: cropped short
- TYPE: straight and styled
- PARTING: side part to the right
- BANGS: completely absent

Bottom-right face:
- COLOR: warm chestnut-brown #4C3224
- TYPE: neat, straight, styled
- PARTING: right-side part
- LENGTH: short throughout
- BANGS: forehead clear, no bangs

All 4 faces must have their hair changed.
Keep faces, expressions, poses, clothes, backgrounds unchanged.`;

const CELL_SIZE = 256;

async function loadFaces(count) {
  const faceFiles = fs.readdirSync(facesDir).filter(f => f.endsWith('.jpg'));
  const faces = [];
  for (let i = 0; i < count && i < faceFiles.length; i++) {
    const buffer = await sharp(path.join(facesDir, faceFiles[i]))
      .resize(CELL_SIZE, CELL_SIZE, { fit: 'cover' })
      .jpeg({ quality: 95 })
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

async function callGemini(buffer, prompt) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [
          { text: prompt },
          { inline_data: { mime_type: 'image/jpeg', data: buffer.toString('base64') } }
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
      return Buffer.from(inlineData.data, 'base64');
    }
  }
  return null;
}

async function main() {
  const faceFiles = fs.readdirSync(facesDir).filter(f => f.endsWith('.jpg')).slice(0, 4);

  // === Individual faces ===
  console.log('Processing 4 faces individually...\n');
  const individualOutputs = [];

  for (let i = 0; i < faceFiles.length; i++) {
    const buffer = await sharp(path.join(facesDir, faceFiles[i]))
      .resize(CELL_SIZE, CELL_SIZE, { fit: 'cover' })
      .jpeg({ quality: 95 })
      .toBuffer();

    console.log(`  Face ${i + 1}...`);
    const result = await callGemini(buffer, individualPrompt);
    if (result) {
      const outPath = path.join(outputDir, `newstyle-individual-${i + 1}.png`);
      fs.writeFileSync(outPath, result);
      individualOutputs.push(result);
      console.log(`    Saved: ${outPath}`);
    } else {
      console.log(`    No image returned`);
    }
  }

  // === 2x2 Grid ===
  console.log('\nProcessing 2x2 grid...');
  const faces = await loadFaces(4);
  const gridBuffer = await createGrid(faces, 2);

  // Save input
  const gridInputPath = path.join(outputDir, 'input', 'newstyle-grid-input.jpg');
  fs.writeFileSync(gridInputPath, gridBuffer);
  console.log(`  Input saved: ${gridInputPath}`);

  const gridResult = await callGemini(gridBuffer, gridPrompt);
  if (gridResult) {
    const outPath = path.join(outputDir, 'newstyle-grid-output.png');
    fs.writeFileSync(outPath, gridResult);
    console.log(`  Output saved: ${outPath}`);
  } else {
    console.log('  No image returned for grid');
  }

  // === Comparison image ===
  console.log('\nCreating comparison...');
  const inputs = await loadFaces(4);
  const outputs = [];
  for (let i = 1; i <= 4; i++) {
    const p = path.join(outputDir, `newstyle-individual-${i}.png`);
    if (fs.existsSync(p)) {
      outputs.push(await sharp(p).resize(CELL_SIZE, CELL_SIZE, { fit: 'cover' }).toBuffer());
    }
  }

  if (outputs.length === 4) {
    const composites = [];
    for (let i = 0; i < 4; i++) {
      composites.push({ input: inputs[i], left: i * CELL_SIZE, top: 0 });
      composites.push({ input: outputs[i], left: i * CELL_SIZE, top: CELL_SIZE });
    }
    const comparison = await sharp({
      create: { width: 4 * CELL_SIZE, height: 2 * CELL_SIZE, channels: 3, background: { r: 255, g: 255, b: 255 } }
    }).composite(composites).jpeg({ quality: 95 }).toBuffer();

    const compPath = path.join(outputDir, 'newstyle-comparison.jpg');
    fs.writeFileSync(compPath, comparison);
    console.log(`  Comparison saved: ${compPath}`);
  }

  console.log('\nDone!');
}

main().catch(console.error);
