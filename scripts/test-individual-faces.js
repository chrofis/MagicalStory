#!/usr/bin/env node
require('dotenv').config();
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const outputDir = 'output/story-job_1768859833557_x2dpb3fe2';
const facesDir = path.join(outputDir, 'faces/Luis');
const apiKey = process.env.GEMINI_API_KEY;
const model = 'gemini-2.5-flash-image';

const prompt = `Change the hair in this image:

COLOR: dark brown #65350F
TEXTURE: messy, tousled, wispy - NOT straight
LENGTH: very short, cropped
BANGS: very short, end at mid-forehead (NOT touching eyebrows)

Keep face, expression, pose, clothes, background unchanged.`;

async function processOneFace(facePath, index) {
  const buffer = await sharp(facePath)
    .resize(256, 256, { fit: 'cover' })
    .jpeg({ quality: 95 })
    .toBuffer();

  console.log(`Processing face ${index + 1}...`);

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
      const outPath = path.join(outputDir, `individual-face${index + 1}-output.png`);
      fs.writeFileSync(outPath, Buffer.from(inlineData.data, 'base64'));
      console.log(`  Saved: ${outPath}`);
      return true;
    }
  }
  console.log(`  No image returned for face ${index + 1}`);
  return false;
}

async function main() {
  const faceFiles = fs.readdirSync(facesDir).filter(f => f.endsWith('.jpg')).slice(0, 4);

  console.log(`Processing ${faceFiles.length} faces individually...\n`);

  for (let i = 0; i < faceFiles.length; i++) {
    await processOneFace(path.join(facesDir, faceFiles[i]), i);
  }

  console.log('\nDone!');
}

main().catch(console.error);
