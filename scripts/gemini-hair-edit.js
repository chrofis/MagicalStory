#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const outputDir = 'output/story-job_1768859833557_x2dpb3fe2';

async function editWithGemini(imagePath, label) {
  const imageData = fs.readFileSync(imagePath);
  const base64Image = imageData.toString('base64');

  const apiKey = process.env.GEMINI_API_KEY;
  const model = 'gemini-2.5-flash-image';

  const prompt = `Edit this image of children's book characters.
Change ONLY the hair color to dark brown #65350F.
Keep EVERYTHING else exactly the same - same faces, expressions, poses, clothing, backgrounds.
Only modify the hair color.`;

  console.log('Sending', label, 'to Gemini', model, '...');

  const requestBody = {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: 'image/jpeg', data: base64Image } }
      ]
    }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      temperature: 0.2
    }
  };

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    }
  );

  if (!response.ok) {
    const error = await response.text();
    console.error('API Error:', response.status, error.substring(0, 500));
    return null;
  }

  const result = await response.json();

  if (!result.candidates || result.candidates.length === 0) {
    console.error('No candidates in response');
    console.log(JSON.stringify(result, null, 2).substring(0, 500));
    return null;
  }

  // Extract image
  const parts = result.candidates[0].content?.parts || [];
  for (const part of parts) {
    const inlineData = part.inlineData || part.inline_data;
    if (inlineData && inlineData.data) {
      const outputPath = path.join(outputDir, 'luis-grid-' + label + '-gemini.png');
      fs.writeFileSync(outputPath, Buffer.from(inlineData.data, 'base64'));
      console.log('Saved:', outputPath);
      return outputPath;
    }
    if (part.text) {
      console.log('Text:', part.text.substring(0, 200));
    }
  }

  console.log('No image in response');
  return null;
}

async function main() {
  for (const label of ['2x2', '3x2', '3x3']) {
    const imagePath = path.join(outputDir, 'luis-grid-' + label + '-original.jpg');
    if (fs.existsSync(imagePath)) {
      await editWithGemini(imagePath, label);
    }
  }
}

main().catch(console.error);
