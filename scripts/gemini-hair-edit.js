#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const outputDir = 'output/story-job_1768859833557_x2dpb3fe2';

function buildPrompt(faceCount, gridSize) {
  return `This is a ${gridSize} grid with ${faceCount} child face images.

TASK: Change hair color to dark brown #65350F in all ${faceCount} images.
GOAL: Every face in the grid must have #65350F brown hair.
REQUIREMENT: All ${faceCount} images need the hair recolored, not just some.

Keep everything else identical: faces, expressions, poses, clothes, backgrounds.
Only the hair color changes from blonde to dark brown #65350F.`;
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
      const outputPath = path.join(outputDir, 'luis-grid-' + label + '-v4.png');
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
