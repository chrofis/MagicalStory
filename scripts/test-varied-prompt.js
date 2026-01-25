#!/usr/bin/env node
require('dotenv').config();
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const outputDir = 'output/story-job_1768859833557_x2dpb3fe2';
const facesDir = path.join(outputDir, 'faces/Luis');
const inputDir = path.join(outputDir, 'input');

const CELL_SIZE = 256;
const apiKey = process.env.GEMINI_API_KEY;
const model = 'gemini-2.5-flash-image';

const prompt = `This is a 2x2 grid of 4 child face images.

Change the hair in EACH face to match these instructions:

Top-left face:
- COLOR: warm chestnut brown #65350F
- TEXTURE: messy, tousled, wispy
- LENGTH: very short, cropped
- BANGS: end at mid-forehead, not touching eyebrows

Top-right face:
- COLOR: deep chocolate #65350F
- LENGTH: cropped, very short
- TEXTURE: wispy, tousled, messy
- BANGS: mid-forehead height, well above eyebrows

Bottom-left face:
- COLOR: rich cocoa brown #65350F
- BANGS: short, stopping at mid-forehead
- TEXTURE: tousled, wispy, messy
- LENGTH: very short and cropped

Bottom-right face:
- COLOR: dark coffee brown #65350F
- TEXTURE: wispy, messy, tousled
- BANGS: mid-forehead, nowhere near eyebrows
- LENGTH: cropped very short

All 4 faces must have their hair changed.
Keep faces, expressions, poses, clothes, backgrounds unchanged.`;

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

async function main() {
  // Load 4 faces and create 2x2 grid
  const faces = await loadFaces(4);
  const inputBuffer = await createGrid(faces, 2);

  // Save input
  const inputPath = path.join(inputDir, 'varied-2x2-input.jpg');
  fs.writeFileSync(inputPath, inputBuffer);
  console.log('Input saved:', inputPath);

  // Call Gemini
  console.log('Sending to Gemini with varied descriptions...');

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [
          { text: prompt },
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
      const outPath = path.join(outputDir, 'varied-2x2-output.png');
      fs.writeFileSync(outPath, Buffer.from(inlineData.data, 'base64'));
      console.log('Output saved:', outPath);
      return;
    }
  }
  console.log('No image returned');
  console.log('Response:', JSON.stringify(result, null, 2).substring(0, 500));
}

main().catch(console.error);
