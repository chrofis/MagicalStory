/**
 * Test 3x3 grid approach - generate 9 face variations, pick the best
 * Also test temperature 2.0
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
  name: 'wizard',
  costume: 'wizard',
  description: 'A magical wizard outfit: long purple robe with silver stars and moons pattern, leather belt with pouch, brown boots, wooden magic wand in hand. NO HAT - hair visible and flowing freely.'
};

async function generate3x3Grid(character, costume, temperature, outputDir) {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const standardAvatar = character.avatars?.standard;

  const artStyle = 'cartoon';
  const artStylePrompt = 'Colorful cartoon style, expressive features, clean bold lines, cel-shaded coloring, vibrant saturated colors, smooth gradients, Disney-inspired';

  // 2x2 grid: top = exact copy of reference face, bottom = new style with costume
  const gridPrompt = `Create a 2x2 character sheet.

TOP ROW - EXACT COPIES OF REFERENCE (same style as reference):
- TOP-LEFT: EXACT COPY of the reference face. Same style, same colors, same everything. Just zoomed in to show only face (forehead to chin). No shoulders, no clothing visible.
- TOP-RIGHT: EXACT COPY of reference face, but head turned right (nose pointing right). Keep the SAME STYLE as reference image.

⚠️ TOP ROW MUST KEEP THE ORIGINAL REFERENCE STYLE - DO NOT CHANGE THE ART STYLE FOR TOP ROW.

BOTTOM ROW - NEW STYLE WITH COSTUME (${artStyle}):
- BOTTOM-LEFT: Full body front view in ${artStyle} style: ${artStylePrompt}. Wearing: ${costume.description}
- BOTTOM-RIGHT: Full body side view facing RIGHT in ${artStyle} style. Same costume.

⚠️ ONLY THE BOTTOM ROW gets the new ${artStyle} style. Top row stays in reference style.

REQUIREMENTS:
- SAME person in all 4 images
- TOP ROW: Original reference style (exact copy)
- BOTTOM ROW: New ${artStyle} style with costume
- NO HATS or HEAD COVERINGS
- FACE MUST BE VISIBLE in all quadrants
- Background: Light grey studio`;

  const avatarBase64 = standardAvatar.replace(/^data:image\/\w+;base64,/, '');
  const avatarMimeType = standardAvatar.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';

  const systemText = `You create character illustration sheets for children's books.
Create a 2x2 grid: top row shows face-only close-ups (no clothing), bottom row shows full body with costume. All in ${artStyle} style.`;

  const requestBody = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents: [{
      parts: [
        { inline_data: { mime_type: avatarMimeType, data: avatarBase64 } },
        { text: gridPrompt }
      ]
    }],
    generationConfig: {
      temperature: temperature,
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: { aspectRatio: "1:1" }  // Square for 2x2 grid
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" }
    ]
  };

  // Save prompt
  fs.writeFileSync(path.join(outputDir, `prompt-3x3-temp-${temperature}.txt`), gridPrompt);

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
      return { success: false, error: `API ${response.status}: ${errorText.substring(0, 200)}` };
    }

    const data = await response.json();

    // Debug: log full response structure
    console.log(`   API Response: candidates=${data.candidates?.length}, finishReason=${data.candidates?.[0]?.finishReason}`);
    if (data.candidates?.[0]?.content?.parts) {
      const partTypes = data.candidates[0].content.parts.map(p => p.text ? 'text' : p.inlineData ? 'image' : 'unknown');
      console.log(`   Parts: ${partTypes.join(', ')}`);
    }
    if (data.promptFeedback) {
      console.log(`   Feedback: ${JSON.stringify(data.promptFeedback)}`);
    }

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

async function detectAndCompareAllFaces(referenceAvatar, gridImage) {
  const photoAnalyzerUrl = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';

  try {
    console.log(`   Calling /detect-all-faces...`);
    const response = await fetch(`${photoAnalyzerUrl}/detect-all-faces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: gridImage,
        reference_image: referenceAvatar
      })
    });

    const result = await response.json();
    if (result.success) {
      console.log(`   Found ${result.total_faces} faces in grid`);
      return result.faces;
    } else {
      console.log(`   Error: ${result.error}`);
      return [];
    }
  } catch (err) {
    console.log(`   Error: ${err.message}`);
    return [];
  }
}

async function main() {
  console.log('🎭 2x2 Grid Test - Face anchors + Full body costume\n');

  const baseOutputDir = path.join(__dirname, 'test-output', `grid-3x3-${Date.now()}`);
  console.log(`Output: ${baseOutputDir}\n`);

  // Get character
  console.log('1. Fetching character...');
  const result = await pool.query(`SELECT data FROM characters WHERE user_id = $1`, ['1767568240635']);
  const data = JSON.parse(result.rows[0].data);
  const sophie = data.characters.find(c => c.name?.includes('Sophie'));
  console.log(`   Found: ${sophie.name}\n`);

  // Save reference
  saveImage(sophie.avatars.standard, baseOutputDir, '0-reference.png');

  // Test temp 0.5
  const temperatures = [0.5];

  console.log('2. Generating 3x3 grids...\n');

  for (const temp of temperatures) {
    console.log(`   Temperature ${temp}...`);

    const genResult = await generate3x3Grid(sophie, TEST_COSTUME, temp, baseOutputDir);

    if (genResult.success) {
      saveImage(genResult.imageData, baseOutputDir, `grid-temp-${temp}.png`);
      console.log(`   ✅ Saved grid`);

      // Detect all faces and compare to reference
      console.log(`   📊 Detecting all faces in grid...`);
      const faces = await detectAndCompareAllFaces(sophie.avatars.standard, genResult.imageData);

      if (faces.length > 0) {
        // Already sorted by similarity (highest first)
        const top3 = faces.slice(0, 3);
        const avg = faces.reduce((sum, f) => sum + (f.similarity || 0), 0) / faces.length;
        const passing = faces.filter(f => f.same_person).length;

        console.log(`\n   🏆 TOP 3 MATCHES:`);
        top3.forEach((face, i) => {
          const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉';
          const pos = `(${face.box.x}, ${face.box.y})`;
          console.log(`   ${medal} #${i+1}: ${(face.similarity * 100).toFixed(1)}% at ${pos} [${face.match_confidence}]`);
        });

        console.log(`\n   Stats: ${faces.length} faces, avg ${(avg * 100).toFixed(1)}%, ${passing}/${faces.length} pass\n`);

        // Save detailed results
        fs.writeFileSync(
          path.join(baseOutputDir, `results-temp-${temp}.json`),
          JSON.stringify({ temperature: temp, faces, top3, avg, total: faces.length, passing }, null, 2)
        );
      } else {
        console.log(`   ⚠️ No faces detected in grid\n`);
      }
    } else {
      console.log(`   ❌ Failed: ${genResult.error}\n`);
    }
  }

  await pool.end();
  console.log(`\n✅ Done - check ${baseOutputDir}`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
