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

  // Special prompt for 3x3 grid with anchor and variations
  const gridPrompt = `⚠️ MANDATORY OUTPUT STYLE: ${artStylePrompt}
DO NOT CREATE PHOTO-REALISTIC OUTPUT. CREATE AN ILLUSTRATION.

TASK: Create a 3x3 grid (9 images) of the SAME character. 8 images show the NEW COSTUME, 1 image (middle-center) shows the ORIGINAL clothing styled.

NEW COSTUME - ${costume.costume}:
${costume.description}

GRID LAYOUT (3 rows x 3 columns):

TOP ROW - All 3 faces looking FORWARD at camera, wearing NEW COSTUME:
| Top-Left: Face front, costumed | Top-Center: Face front, costumed | Top-Right: Face front, costumed |

MIDDLE ROW - Faces looking RIGHT, except middle-center ANCHOR looks FORWARD:
| Middle-Left: Face right, costumed | Middle-Center: ANCHOR - Face FRONT, Original clothes, styled (NO costume) | Middle-Right: Face right, costumed |

BOTTOM ROW - Full body views, wearing NEW COSTUME:
| Bottom-Left: Full body front | Bottom-Center: Full body front | Bottom-Right: Full body facing right |

IMPORTANT - SLIGHT FACE VARIATIONS:
- Add SLIGHT natural variations between faces (subtle expression changes, minor angle shifts)
- This helps test which variation best preserves identity
- Variations should be subtle - still clearly the same person
- The ANCHOR (middle-center) should match reference most closely

CRITICAL:
- ALL 9 images show the SAME PERSON (same identity from reference)
- 8 images wear the NEW COSTUME
- 1 image (middle-center) wears ORIGINAL CLOTHES from reference - this is the styled ANCHOR
- ${artStyle} illustrated style throughout (NOT photo-realistic)
- Light grey studio background in each cell

REFERENCE IMAGE: Extract facial identity. Middle-center copies the pose/clothes but in illustration style.`;

  const avatarBase64 = standardAvatar.replace(/^data:image\/\w+;base64,/, '');
  const avatarMimeType = standardAvatar.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';

  const systemText = `You create character illustration grids for children's books.

Generate a 3x3 grid showing the same character with SLIGHT VARIATIONS in each cell.
- TOP ROW: 3 faces looking forward, all in costume
- MIDDLE ROW: 3 faces looking right, but MIDDLE-CENTER shows original clothes (anchor)
- BOTTOM ROW: 3 full body views in costume

Add subtle natural variations to help identify which face best matches the reference.
The middle-center cell is the ANCHOR - same pose/clothes as reference, just styled.
Output must be ${artStyle} illustration style, NOT photo-realistic.`;

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
      imageConfig: { aspectRatio: "1:1" }  // Square for 3x3 grid
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

async function compareAllQuadrants(standardAvatar, gridImage, gridSize = 3) {
  const photoAnalyzerUrl = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';
  const quadrants = [];

  // For 3x3: positions are like top-left, top-center, top-right, middle-left, etc.
  const positions = [
    'top-left', 'top-center', 'top-right',
    'middle-left', 'middle-center', 'middle-right',
    'bottom-left', 'bottom-center', 'bottom-right'
  ];

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
          grid_size: gridSize
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
  console.log('🎭 3x3 Grid Test - Generate 9 variations\n');

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

      // Compare all 9 quadrants
      console.log(`   📊 Comparing all 9 cells...`);
      const comparisons = await compareAllQuadrants(sophie.avatars.standard, genResult.imageData, 3);

      // Find best
      const valid = comparisons.filter(c => c.similarity !== undefined);
      if (valid.length > 0) {
        const best = valid.reduce((a, b) => a.similarity > b.similarity ? a : b);
        const worst = valid.reduce((a, b) => a.similarity < b.similarity ? a : b);
        const avg = valid.reduce((sum, c) => sum + c.similarity, 0) / valid.length;

        console.log(`   Best:  ${best.position} = ${(best.similarity * 100).toFixed(1)}%`);
        console.log(`   Worst: ${worst.position} = ${(worst.similarity * 100).toFixed(1)}%`);
        console.log(`   Avg:   ${(avg * 100).toFixed(1)}%`);
        console.log(`   Pass:  ${valid.filter(c => c.samePerson).length}/9\n`);

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
