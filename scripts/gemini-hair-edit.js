#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const outputDir = 'output/story-job_1768859833557_x2dpb3fe2';

function buildPrompt(faceCount, gridSize) {
  const positions = [];
  for (let i = 1; i <= faceCount; i++) {
    positions.push(`Image ${i}: change hair to #65350F`);
  }

  return `TASK: RECOLOR HAIR IN ALL ${faceCount} IMAGES.

This is a ${gridSize} GRID containing exactly ${faceCount} separate face images.

The grid layout:
- Grid size: ${gridSize}
- Total images in grid: ${faceCount}
- Each cell contains one child's face

YOUR TASK: Change the hair color in EACH AND EVERY one of the ${faceCount} images.

${positions.join('\n')}

Target hair color: dark brown #65350F

CRITICAL: You must change the hair in ALL ${faceCount} images. Not 1, not 2, but ALL ${faceCount}.

Count them:
${Array.from({length: faceCount}, (_, i) => `${i + 1}. Change hair to #65350F ✓`).join('\n')}

That's ${faceCount} images total. Every single one needs dark brown #65350F hair.

DO NOT skip any image.
DO NOT leave any hair blonde.
DO NOT change anything except hair color.

Keep faces, expressions, poses, backgrounds, clothing, art style IDENTICAL.

ONLY change: hair color → dark brown #65350F
Change it in: ALL ${faceCount} images in the ${gridSize} grid

FINAL CHECK: Did you change the hair in all ${faceCount} images? Every single one?`;
}

async function editWithGemini(imagePath, label, faceCount, gridSize) {
  const imageData = fs.readFileSync(imagePath);
  const base64Image = imageData.toString('base64');

  const apiKey = process.env.GEMINI_API_KEY;
  const model = 'gemini-2.5-flash-image';
  const prompt = buildPrompt(faceCount, gridSize);

  console.log('Sending', label, '(' + faceCount + ' faces) to Gemini...');

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: 'image/jpeg', data: base64Image } }
          ]
        }],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
          temperature: 0.1
        }
      })
    }
  );

  if (!response.ok) {
    const error = await response.text();
    console.error('API Error:', response.status, error.substring(0, 300));
    return null;
  }

  const result = await response.json();
  const parts = result.candidates?.[0]?.content?.parts || [];

  for (const part of parts) {
    const inlineData = part.inlineData || part.inline_data;
    if (inlineData && inlineData.data) {
      const outputPath = path.join(outputDir, 'luis-grid-' + label + '-v3.png');
      fs.writeFileSync(outputPath, Buffer.from(inlineData.data, 'base64'));
      console.log('Saved:', outputPath);
      return outputPath;
    }
  }
  console.log('No image returned');
  return null;
}

async function main() {
  const grids = [
    { label: '2x2', faces: 4, gridSize: '2x2 (2 rows, 2 columns)' },
    { label: '3x2', faces: 6, gridSize: '3x2 (2 rows, 3 columns)' },
    { label: '3x3', faces: 9, gridSize: '3x3 (3 rows, 3 columns)' }
  ];

  for (const g of grids) {
    const imagePath = path.join(outputDir, 'luis-grid-' + g.label + '-original.jpg');
    if (fs.existsSync(imagePath)) {
      await editWithGemini(imagePath, g.label, g.faces, g.gridSize);
    }
  }
}

main().catch(console.error);
