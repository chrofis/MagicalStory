/**
 * Generate multiple images and pick the best one based on ArcFace
 * Test higher temperatures (up to 2.0)
 */

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Load prompt templates
const PROMPT_TEMPLATES = {};
const promptsDir = path.join(__dirname, 'prompts');
fs.readdirSync(promptsDir).forEach(file => {
  if (file.endsWith('.txt')) {
    const key = file.replace('.txt', '').replace(/-/g, '_').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
    const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    PROMPT_TEMPLATES[camelKey] = fs.readFileSync(path.join(promptsDir, file), 'utf8');
  }
});

function fillTemplate(template, values) {
  let result = template;
  for (const [key, value] of Object.entries(values)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value || '');
  }
  return result;
}

function saveImage(base64Data, outputDir, filename) {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const base64Clean = base64Data.replace(/^data:image\/\w+;base64,/, '');
  const filepath = path.join(outputDir, filename);
  fs.writeFileSync(filepath, Buffer.from(base64Clean, 'base64'));
  return filepath;
}

const TEST_COSTUME = {
  name: 'pirate-captain',
  costume: 'pirate captain',
  description: 'A dashing pirate captain outfit: long navy blue coat with gold trim and brass buttons, white ruffled shirt underneath, brown leather belt with gold buckle, black boots. No hat - hair flowing freely.'
};

async function generateAvatar(character, costume, temperature) {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const standardAvatar = character.avatars?.standard;

  const artStyle = 'pixar';
  const artStylePrompt = '3D render, Pixar animation style, natural proportions, highly detailed textures, soft studio lighting, vibrant colors, smooth shading';

  const template = PROMPT_TEMPLATES.styledCostumedAvatar || '';
  const avatarPrompt = fillTemplate(template, {
    'ART_STYLE_PROMPT': artStylePrompt,
    'COSTUME_DESCRIPTION': costume.description,
    'COSTUME_TYPE': costume.costume,
    'PHYSICAL_TRAITS': ''
  });

  const avatarBase64 = standardAvatar.replace(/^data:image\/\w+;base64,/, '');
  const avatarMimeType = standardAvatar.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';

  const systemText = `⚠️ CRITICAL: Create ${artStyle.toUpperCase()} STYLE ILLUSTRATION - NOT photo-realistic.

You are an expert character illustrator for children's books.

CREATE A 2x2 GRID:
- TOP-LEFT: The reference image rendered in ${artStyle} style (SAME pose & clothes as reference)
- TOP-RIGHT: Face/shoulders view wearing the NEW COSTUME
- BOTTOM-LEFT: Full body front view wearing the NEW COSTUME
- BOTTOM-RIGHT: Full body side view wearing the NEW COSTUME

CRITICAL:
- ALL 4 quadrants must show the SAME PERSON (identical face)
- TOP-LEFT: Reference clothes, illustrated style
- Other 3: NEW costume (all identical costume)
- Output must be ${artStyle} illustration, NOT a photograph`;

  const requestBody = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents: [{
      parts: [
        { inline_data: { mime_type: avatarMimeType, data: avatarBase64 } },
        { text: avatarPrompt }
      ]
    }],
    generationConfig: {
      temperature: temperature,
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: { aspectRatio: "9:16" }
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" }
    ]
  };

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      }
    );

    if (!response.ok) {
      return { success: false, error: `API ${response.status}` };
    }

    const data = await response.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));

    if (!imagePart) {
      return { success: false, error: 'No image' };
    }

    const imageData = `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}`;
    return { success: true, imageData };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function getArcFaceScore(standardAvatar, generatedImage) {
  const photoAnalyzerUrl = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';

  try {
    const response = await fetch(`${photoAnalyzerUrl}/compare-identity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image1: standardAvatar,
        image2: generatedImage,
        quadrant1: 'top-left',
        quadrant2: 'top-right'  // Compare costumed quadrant
      })
    });

    const result = await response.json();
    return result.success ? result : null;
  } catch (err) {
    return null;
  }
}

async function main() {
  console.log('🎭 Multi-Generation Test - Generate 5 images, pick best\n');

  const baseOutputDir = path.join(__dirname, 'test-output', `multi-gen-${Date.now()}`);
  console.log(`Output: ${baseOutputDir}\n`);

  // Get character
  console.log('1. Fetching character...');
  const result = await pool.query(`SELECT data FROM characters WHERE user_id = $1`, ['1767568240635']);
  const data = JSON.parse(result.rows[0].data);
  const sophie = data.characters.find(c => c.name?.includes('Sophie'));
  console.log(`   Found: ${sophie.name}\n`);

  saveImage(sophie.avatars.standard, baseOutputDir, '0-reference.png');

  // Generate 5 images at temperature 2.0
  const temperature = 2.0;
  const numGenerations = 5;

  console.log(`2. Generating ${numGenerations} images at temperature ${temperature}...\n`);

  const results = [];

  for (let i = 1; i <= numGenerations; i++) {
    process.stdout.write(`   [${i}/${numGenerations}] Generating... `);

    const genResult = await generateAvatar(sophie, TEST_COSTUME, temperature);

    if (genResult.success) {
      const arcface = await getArcFaceScore(sophie.avatars.standard, genResult.imageData);
      const score = arcface?.similarity || 0;
      const samePerson = arcface?.same_person || false;

      results.push({
        index: i,
        imageData: genResult.imageData,
        score: score,
        samePerson: samePerson,
        confidence: arcface?.confidence
      });

      saveImage(genResult.imageData, baseOutputDir, `gen-${i}-score-${(score * 100).toFixed(0)}.png`);
      console.log(`✅ ArcFace: ${(score * 100).toFixed(1)}% ${samePerson ? '✓' : '✗'}`);
    } else {
      console.log(`❌ ${genResult.error}`);
    }
  }

  // Find best
  console.log('\n3. Results Summary:\n');

  results.sort((a, b) => b.score - a.score);

  console.log('   Rank | Score  | Same Person');
  console.log('   -----|--------|------------');
  results.forEach((r, i) => {
    const marker = i === 0 ? ' 👑 BEST' : '';
    console.log(`   ${i + 1}    | ${(r.score * 100).toFixed(1)}%  | ${r.samePerson ? '✅' : '❌'} ${r.confidence || ''}${marker}`);
  });

  if (results.length > 0) {
    const best = results[0];
    saveImage(best.imageData, baseOutputDir, `BEST-gen-${best.index}-score-${(best.score * 100).toFixed(0)}.png`);
    console.log(`\n   Best image: gen-${best.index} with ${(best.score * 100).toFixed(1)}%`);
  }

  const passing = results.filter(r => r.samePerson).length;
  console.log(`   Pass rate: ${passing}/${results.length} (${((passing/results.length)*100).toFixed(0)}%)`);

  await pool.end();
  console.log(`\n✅ Done - check ${baseOutputDir}`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
