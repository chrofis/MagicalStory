/**
 * Test costume generation with different temperatures
 * Using modified system instruction: "transform the avatar into"
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

const TEMPERATURES = [0.4, 0.8, 1.2, 1.8];

const TEST_COSTUME = {
  name: 'medieval-peasant',
  costume: 'medieval peasant',
  description: 'A medieval peasant outfit: rough brown linen tunic with rope belt, simple cream-colored undershirt with loose sleeves, brown wool pants, and worn leather boots. No hat or head covering.'
};

async function generateWithTemperature(character, costume, temperature, outputDir) {
  const geminiApiKey = process.env.GEMINI_API_KEY;

  const standardAvatar = character.avatars?.standard;
  if (!standardAvatar) {
    return { success: false, error: 'No standard avatar' };
  }

  const artStyle = 'pixar';
  const artStylePrompt = '3D render, Pixar animation style, natural proportions, highly detailed textures, soft studio lighting, vibrant colors, smooth shading';

  // Build prompt from template
  const template = PROMPT_TEMPLATES.styledCostumedAvatar || '';
  const avatarPrompt = fillTemplate(template, {
    'ART_STYLE_PROMPT': artStylePrompt,
    'COSTUME_DESCRIPTION': costume.description,
    'COSTUME_TYPE': costume.costume,
    'PHYSICAL_TRAITS': ''
  });

  // Prepare image
  const avatarBase64 = standardAvatar.replace(/^data:image\/\w+;base64,/, '');
  const avatarMimeType = standardAvatar.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';

  // MODIFIED system instruction per user request
  const systemText = `You are an expert character artist creating stylized avatar illustrations for children's books.
You are given a reference avatar for FACIAL IDENTITY ONLY.
Your task is to TRANSFORM the avatar into: ${artStyle} style wearing a completely different costume.
- Preserves the EXACT facial identity from the reference avatar
- IGNORES the reference clothing completely - apply the new costume instead
- IGNORES the reference body shape - generate a new body fitting the costume
- Creates all 4 grid quadrants with the SAME costume`;

  const requestBody = {
    systemInstruction: {
      parts: [{ text: systemText }]
    },
    contents: [{
      parts: [
        {
          inline_data: {
            mime_type: avatarMimeType,
            data: avatarBase64
          }
        },
        { text: avatarPrompt }
      ]
    }],
    generationConfig: {
      temperature: temperature,
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: {
        aspectRatio: "9:16"
      }
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" }
    ]
  };

  // Save the prompt for reference
  fs.writeFileSync(
    path.join(outputDir, `prompt-temp-${temperature}.txt`),
    `SYSTEM INSTRUCTION:\n${systemText}\n\nUSER PROMPT:\n${avatarPrompt}\n\nTEMPERATURE: ${temperature}`
  );

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
      const errorText = await response.text();
      return { success: false, error: `API error: ${response.status} - ${errorText.substring(0, 200)}` };
    }

    const data = await response.json();

    // Extract image
    const parts = data.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));

    if (!imagePart) {
      return { success: false, error: 'No image in response' };
    }

    const imageData = `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}`;
    return { success: true, imageData };

  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function runArcFaceComparison(standardAvatar, costumedAvatar) {
  const photoAnalyzerUrl = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';

  try {
    const response = await fetch(`${photoAnalyzerUrl}/compare-identity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image1: standardAvatar,
        image2: costumedAvatar,
        quadrant1: 'top-left',
        quadrant2: 'top-left'
      })
    });

    const result = await response.json();
    if (result.success) {
      return {
        similarity: result.similarity,
        samePerson: result.same_person,
        confidence: result.confidence
      };
    }
    return null;
  } catch (err) {
    return null;
  }
}

async function main() {
  console.log('🎭 Temperature Test - Costume Generation\n');

  const baseOutputDir = path.join(__dirname, 'test-output', `temp-test-${Date.now()}`);
  console.log(`Output: ${baseOutputDir}\n`);

  // Get character data
  console.log('1. Fetching character data...');
  const result = await pool.query(
    `SELECT data FROM characters WHERE user_id = $1`,
    ['1767568240635']
  );

  const data = JSON.parse(result.rows[0].data);
  const sophie = data.characters.find(c => c.name === 'Sophie' || c.name.includes('Sophie'));
  console.log(`   Found: ${sophie.name}\n`);

  // Save reference
  saveImage(sophie.avatars.standard, baseOutputDir, '0-reference.png');
  console.log('   Saved reference image\n');

  // Test each temperature
  console.log('2. Testing temperatures...\n');

  const results = [];

  for (const temp of TEMPERATURES) {
    console.log(`   Temperature ${temp}...`);

    const genResult = await generateWithTemperature(sophie, TEST_COSTUME, temp, baseOutputDir);

    if (genResult.success) {
      const filename = `temp-${temp}-result.png`;
      saveImage(genResult.imageData, baseOutputDir, filename);

      // Run ArcFace
      const arcface = await runArcFaceComparison(sophie.avatars.standard, genResult.imageData);

      const resultInfo = {
        temperature: temp,
        success: true,
        arcface: arcface ? `${(arcface.similarity * 100).toFixed(1)}% (${arcface.confidence})` : 'N/A',
        samePerson: arcface?.samePerson
      };
      results.push(resultInfo);

      console.log(`   ✅ Saved: ${filename}`);
      console.log(`   📊 ArcFace: ${resultInfo.arcface}, same_person: ${resultInfo.samePerson}\n`);
    } else {
      results.push({ temperature: temp, success: false, error: genResult.error });
      console.log(`   ❌ Failed: ${genResult.error}\n`);
    }
  }

  // Summary
  console.log('\n3. Summary:\n');
  console.log('   Temp  | ArcFace     | Same Person');
  console.log('   ------|-------------|------------');
  for (const r of results) {
    if (r.success) {
      console.log(`   ${r.temperature}   | ${r.arcface.padEnd(11)} | ${r.samePerson}`);
    } else {
      console.log(`   ${r.temperature}   | FAILED      | ${r.error?.substring(0, 30)}`);
    }
  }

  console.log(`\n   Output folder: ${baseOutputDir}`);

  await pool.end();
  console.log('\n✅ Done');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
