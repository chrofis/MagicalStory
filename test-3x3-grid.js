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
  name: 'pirate-captain',
  costume: 'pirate captain',
  description: 'A dashing pirate captain outfit: long navy blue coat with gold trim and brass buttons, white ruffled shirt underneath, brown leather belt with gold buckle, black boots. No hat - hair flowing freely.'
};

async function generate3x3Grid(character, costume, temperature, outputDir) {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const standardAvatar = character.avatars?.standard;

  const artStyle = 'pixar';
  const artStylePrompt = '3D render, Pixar animation style, natural proportions, highly detailed textures, soft studio lighting, vibrant colors, smooth shading';

  // 3x4 grid (12 images) - all same costume, slight face variations
  const gridPrompt = `Create a 3x4 character sheet (3 rows, 4 columns = 12 images) in ${artStyle} animation style.

Show the SAME young person from the reference in 12 views, ALL wearing: ${costume.description}

GRID LAYOUT (3 rows x 4 columns):
Row 1: 4 face close-ups, ALL facing STRAIGHT forward at camera
Row 2: 4 face close-ups, ALL facing SLIGHTLY RIGHT (3/4 profile)
Row 3: 2 full body facing straight | 2 full body facing right

EXPRESSION: ALL 12 images show HAPPY expression with LIPS CLOSED (gentle smile, no teeth)

IMPORTANT - FACE VARIATIONS:
- Keep the SAME face identity but add SLIGHT STRUCTURAL variations
- Vary: face width, eye spacing, nose size, chin shape slightly
- This helps find which variation best matches the reference
- All variations should still be recognizable as the same person

Style: ${artStylePrompt}
Background: Light grey studio in each cell
Same costume in ALL 12 images.`;

  const avatarBase64 = standardAvatar.replace(/^data:image\/\w+;base64,/, '');
  const avatarMimeType = standardAvatar.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';

  const systemText = `You create character illustration sheets for children's books.
Create a 3x4 grid (12 images) of the same character in ${artStyle} style with slight face variations.`;

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
      imageConfig: { aspectRatio: "4:3" }  // Wide for 3x4 grid
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

async function compareAllQuadrants(standardAvatar, gridImage, rows = 3, cols = 4) {
  const photoAnalyzerUrl = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';
  const quadrants = [];

  // Generate positions for any grid size
  const rowNames = ['top', 'middle', 'bottom'];
  const colNames = cols === 4 ? ['col1', 'col2', 'col3', 'col4'] : ['left', 'center', 'right'];

  // Determine grid_size parameter for photo_analyzer
  const gridSizeParam = cols === 4 ? '3x4' : (cols === 3 ? 3 : 2);

  const positions = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      positions.push(`${rowNames[r]}-${colNames[c]}`);
    }
  }

  console.log(`   Comparing ${positions.length} positions: ${positions.join(', ')}`);

  for (const pos of positions) {
    try {
      const response = await fetch(`${photoAnalyzerUrl}/compare-identity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image1: standardAvatar,
          image2: gridImage,
          quadrant1: 'top-left',
          quadrant2: pos,
          grid_size: gridSizeParam
        })
      });

      const result = await response.json();
      if (result.success) {
        quadrants.push({
          position: pos,
          similarity: result.similarity,
          samePerson: result.same_person,
          confidence: result.confidence
        });
      } else {
        quadrants.push({ position: pos, error: result.error });
      }
    } catch (err) {
      quadrants.push({ position: pos, error: err.message });
    }
  }

  return quadrants;
}

async function main() {
  console.log('🎭 3x4 Grid Test - Generate 12 variations\n');

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

  // Test temperatures including 2.0
  const temperatures = [1.0, 1.5, 2.0];

  console.log('2. Generating 3x3 grids...\n');

  for (const temp of temperatures) {
    console.log(`   Temperature ${temp}...`);

    const genResult = await generate3x3Grid(sophie, TEST_COSTUME, temp, baseOutputDir);

    if (genResult.success) {
      saveImage(genResult.imageData, baseOutputDir, `grid-temp-${temp}.png`);
      console.log(`   ✅ Saved grid`);

      // Compare all 12 quadrants (3x4 grid)
      console.log(`   📊 Comparing all 12 cells...`);
      const comparisons = await compareAllQuadrants(sophie.avatars.standard, genResult.imageData, 3, 4);

      // Find best
      const valid = comparisons.filter(c => c.similarity !== undefined);
      if (valid.length > 0) {
        const best = valid.reduce((a, b) => a.similarity > b.similarity ? a : b);
        const worst = valid.reduce((a, b) => a.similarity < b.similarity ? a : b);
        const avg = valid.reduce((sum, c) => sum + c.similarity, 0) / valid.length;

        console.log(`   Best:  ${best.position} = ${(best.similarity * 100).toFixed(1)}%`);
        console.log(`   Worst: ${worst.position} = ${(worst.similarity * 100).toFixed(1)}%`);
        console.log(`   Avg:   ${(avg * 100).toFixed(1)}%`);
        console.log(`   Pass:  ${valid.filter(c => c.samePerson).length}/${valid.length}\n`);

        // Save detailed results
        fs.writeFileSync(
          path.join(baseOutputDir, `results-temp-${temp}.json`),
          JSON.stringify({ temperature: temp, comparisons, best, worst, avg }, null, 2)
        );
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
