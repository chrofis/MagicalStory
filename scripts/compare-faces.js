#!/usr/bin/env node
/**
 * Compare character faces for consistency
 *
 * Usage: node scripts/compare-faces.js <storyId> <characterName>
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MODEL = 'gemini-2.5-flash';

async function compareFaces(storyId, characterName) {
  const facesDir = path.join('output', `story-${storyId}`, 'faces', characterName);

  if (!fs.existsSync(facesDir)) {
    console.error(`Folder not found: ${facesDir}`);
    process.exit(1);
  }

  const faceFiles = fs.readdirSync(facesDir).filter(f => f.endsWith('.jpg'));
  console.log(`\n🔍 Comparing ${faceFiles.length} faces for ${characterName}\n`);

  if (faceFiles.length < 2) {
    console.log('Need at least 2 faces to compare.');
    return;
  }

  // Load all faces
  const faces = [];
  for (const file of faceFiles) {
    const filePath = path.join(facesDir, file);
    const buffer = await sharp(filePath)
      .resize(256, 256, { fit: 'cover' })
      .jpeg({ quality: 85 })
      .toBuffer();

    // Extract page number from filename
    const pageMatch = file.match(/page(\d+)/);
    const page = pageMatch ? parseInt(pageMatch[1]) : 0;

    faces.push({
      file,
      page,
      base64: buffer.toString('base64')
    });
  }

  // Sort by page number
  faces.sort((a, b) => a.page - b.page);

  // Build prompt
  const prompt = `I have ${faces.length} face images of the same character "${characterName}" from different pages of a children's storybook.

Analyze each face and determine if any face looks like a DIFFERENT PERSON than the majority.

Focus on:
- Face shape (round, oval, etc.)
- Eye shape and size
- Nose shape
- Hair color and style
- Skin tone
- Overall proportions

For each image, tell me:
1. Does it show a clear face? (If no face visible or too blurry, mark as "skip")
2. Does the face match the majority? Or is it a different person?

The images are labeled A through ${String.fromCharCode(64 + faces.length)} (Page numbers: ${faces.map(f => f.page).join(', ')}).

Return JSON:
{
  "majorityDescription": "Brief description of what the majority face looks like",
  "results": [
    {"label": "A", "page": 1, "status": "match", "notes": "matches majority"},
    {"label": "B", "page": 2, "status": "different", "notes": "different face shape, looks like different person"},
    {"label": "C", "page": 3, "status": "skip", "notes": "no clear face visible"}
  ],
  "differentFaces": ["B"],
  "summary": "1 face appears to be a different person"
}

Be strict - only mark as "different" if it's clearly a different person, not just a different pose or expression.`;

  // Build content with images
  const contentParts = [prompt];

  for (let i = 0; i < faces.length; i++) {
    const label = String.fromCharCode(65 + i);
    contentParts.push(`\n\n${label} (Page ${faces[i].page}):`);
    contentParts.push({
      inlineData: {
        mimeType: 'image/jpeg',
        data: faces[i].base64
      }
    });
  }

  console.log('Sending to Gemini for analysis...\n');

  const model = genAI.getGenerativeModel({ model: MODEL });

  try {
    const result = await model.generateContent(contentParts);
    const text = (await result.response).text();

    // Parse JSON
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const analysis = JSON.parse(jsonMatch[0]);

      console.log('📋 Majority appearance:', analysis.majorityDescription);
      console.log('\n📊 Results:\n');

      for (const r of analysis.results) {
        const face = faces.find(f => f.page === r.page);
        const icon = r.status === 'match' ? '✓' : r.status === 'different' ? '❌' : '⏭️';
        console.log(`${icon} ${r.label} (Page ${r.page}): ${r.status} - ${r.notes}`);
      }

      if (analysis.differentFaces && analysis.differentFaces.length > 0) {
        console.log(`\n⚠️  DIFFERENT FACES: ${analysis.differentFaces.join(', ')}`);

        // Map labels back to files
        for (const label of analysis.differentFaces) {
          const idx = label.charCodeAt(0) - 65;
          if (idx >= 0 && idx < faces.length) {
            console.log(`   - ${faces[idx].file}`);
          }
        }
      } else {
        console.log('\n✅ All faces appear to be the same person');
      }

      console.log(`\n📝 Summary: ${analysis.summary}`);

      // Save results
      const outputPath = path.join('output', `story-${storyId}`, `face-comparison-${characterName}.json`);
      fs.writeFileSync(outputPath, JSON.stringify(analysis, null, 2));
      console.log(`\nSaved to: ${outputPath}`);

      return analysis;
    } else {
      console.log('Could not parse response:', text.substring(0, 500));
    }
  } catch (err) {
    console.error('Error:', err.message);
  }
}

async function main() {
  const storyId = process.argv[2];
  const characterName = process.argv[3];

  if (!storyId || !characterName) {
    console.log('Usage: node scripts/compare-faces.js <storyId> <characterName>');
    console.log('Example: node scripts/compare-faces.js job_1769285688015_idstty79v Lukas');
    process.exit(1);
  }

  await compareFaces(storyId, characterName);
}

main().catch(console.error);
