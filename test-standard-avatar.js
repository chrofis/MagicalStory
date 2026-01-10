/**
 * Test standard avatar generation - generate 3x, pick best per quadrant
 */

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Configuration - can override with command line args
const CONFIG = {
  imagePath: process.argv[2] || null,  // Optional: path to image file
  smiling: true  // Add smiling requirement to prompt
};

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

async function generateStandardAvatar(facePhoto, category, temperature, isFemale = true) {
  const geminiApiKey = process.env.GEMINI_API_KEY;

  // Get clothing style from template
  const mainPrompt = PROMPT_TEMPLATES.avatarMainPrompt || '';
  const clothingKey = `[${category.toUpperCase()}_${isFemale ? 'FEMALE' : 'MALE'}]`;

  // Extract clothing style from template
  const clothingSection = mainPrompt.split('---')[1] || '';
  const clothingMatch = clothingSection.match(new RegExp(`\\[${category.toUpperCase()}_${isFemale ? 'FEMALE' : 'MALE'}\\]\\s*([^\\[]+)`));
  const clothingStyle = clothingMatch ? clothingMatch[1].trim() : 'Casual everyday clothes';

  let avatarPrompt = fillTemplate(mainPrompt.split('---')[0], {
    'CLOTHING_STYLE': clothingStyle
  });

  // Remove ASCII grid art which causes IMAGE_OTHER errors
  // Remove entire GRID LAYOUT section including the box drawing
  avatarPrompt = avatarPrompt.replace(/GRID LAYOUT \(with clear black dividing lines between quadrants\):[\s\S]*?└[─┴┘]+\n\n/g,
    `GRID LAYOUT:
- TOP-LEFT: Face front view (looking at camera)
- TOP-RIGHT: Face 3/4 profile (looking RIGHT)
- BOTTOM-LEFT: Full body front view
- BOTTOM-RIGHT: Full body side view (facing RIGHT)

`);

  // Add smiling requirement if configured
  if (CONFIG.smiling) {
    avatarPrompt = avatarPrompt.replace(
      'IDENTITY PERSISTENCE:',
      'EXPRESSION:\n- The person must be SMILING with TEETH SHOWING in all 4 quadrants.\n- Natural, warm, genuine smile.\n\nIDENTITY PERSISTENCE:'
    );
  }

  const base64Data = facePhoto.replace(/^data:image\/\w+;base64,/, '');
  const mimeType = facePhoto.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/png';

  const requestBody = {
    systemInstruction: {
      parts: [{ text: PROMPT_TEMPLATES.avatarSystemInstruction }]
    },
    contents: [{
      parts: [
        { inline_data: { mime_type: mimeType, data: base64Data } },
        { text: avatarPrompt }
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

    // Debug: log response structure
    if (data.promptFeedback?.blockReason) {
      return { success: false, error: `Blocked: ${data.promptFeedback.blockReason}` };
    }
    if (!data.candidates || data.candidates.length === 0) {
      console.log(`   API response: ${JSON.stringify(data).substring(0, 300)}`);
      return { success: false, error: 'No candidates in response' };
    }

    const parts = data.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));

    if (!imagePart) {
      const textPart = parts.find(p => p.text);
      console.log(`   Finish reason: ${data.candidates[0].finishReason}`);
      if (textPart) console.log(`   Text response: ${textPart.text.substring(0, 200)}`);
      return { success: false, error: 'No image in response' };
    }

    const imageData = `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}`;
    return { success: true, imageData };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function detectAndCompareAllFaces(referenceImage, generatedImage) {
  const photoAnalyzerUrl = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';

  try {
    const response = await fetch(`${photoAnalyzerUrl}/detect-all-faces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: generatedImage,
        reference_image: referenceImage
      })
    });

    const result = await response.json();
    return result.success ? result.faces : [];
  } catch (err) {
    console.log(`   Error: ${err.message}`);
    return [];
  }
}

async function main() {
  console.log('🎭 Standard Avatar Test - Generate 3x, pick best per quadrant\n');
  if (CONFIG.smiling) console.log('📸 SMILING mode enabled - teeth showing\n');

  const baseOutputDir = path.join(__dirname, 'test-output', `standard-avatar-${Date.now()}`);
  console.log(`Output: ${baseOutputDir}\n`);

  let facePhoto;
  let imageName;

  // Load from file or database
  if (CONFIG.imagePath) {
    console.log('1. Loading image from file...');
    const imagePath = CONFIG.imagePath;
    if (!fs.existsSync(imagePath)) {
      console.log(`   ❌ File not found: ${imagePath}`);
      await pool.end();
      return;
    }
    const imageBuffer = fs.readFileSync(imagePath);
    const ext = path.extname(imagePath).toLowerCase();
    const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
    facePhoto = `data:${mimeType};base64,${imageBuffer.toString('base64')}`;
    imageName = path.basename(imagePath);
    console.log(`   Loaded: ${imageName}\n`);
  } else {
    // Get character from database
    console.log('1. Fetching character from database...');
    const result = await pool.query(`SELECT data FROM characters WHERE user_id = $1`, ['1767568240635']);
    const data = JSON.parse(result.rows[0].data);
    const sophie = data.characters.find(c => c.name?.includes('Sophie'));
    console.log(`   Found: ${sophie.name}`);

    // Get the body-no-bg photo - this is the INPUT for standard avatar generation
    const bodyPhoto = sophie.body_photo_url;
    if (!bodyPhoto) {
      console.log('   ❌ No body_photo_url found');
      await pool.end();
      return;
    }
    facePhoto = bodyPhoto;
    imageName = sophie.name;
    console.log(`   Using body_photo_url as input\n`);
  }

  // Save reference
  saveImage(facePhoto, baseOutputDir, '0-reference.png');

  // Generate 3 attempts
  const temperature = 1.0;
  const numAttempts = 3;
  const category = 'standard';

  console.log(`2. Generating ${numAttempts} standard avatars at temperature ${temperature}...\n`);

  const allAttempts = [];

  for (let i = 1; i <= numAttempts; i++) {
    console.log(`   Attempt ${i}/${numAttempts}...`);

    const genResult = await generateStandardAvatar(facePhoto, category, temperature);

    if (genResult.success) {
      saveImage(genResult.imageData, baseOutputDir, `attempt-${i}.png`);
      console.log(`   ✅ Saved attempt-${i}.png`);

      // Detect all faces and compare to reference
      const faces = await detectAndCompareAllFaces(facePhoto, genResult.imageData);
      console.log(`   Found ${faces.length} faces:`);
      for (const face of faces) {
        const score = ((face.similarity || 0) * 100).toFixed(1);
        const pass = face.same_person ? '✅' : '❌';
        console.log(`      - pos(${face.box.x}, ${face.box.y}) size(${face.box.w}x${face.box.h}): ${score}% ${pass}`);
      }
      console.log('');

      allAttempts.push({
        attempt: i,
        imageData: genResult.imageData,
        faces: faces
      });
    } else {
      console.log(`   ❌ Failed: ${genResult.error}\n`);
    }
  }

  // Analyze each quadrant
  console.log('3. Finding best face for each quadrant...\n');

  // 1:1 aspect ratio - 2x2 grid positions
  const quadrants = [
    { name: 'top-left', xRange: [0, 0.5], yRange: [0, 0.5] },
    { name: 'top-right', xRange: [0.5, 1], yRange: [0, 0.5] },
    { name: 'bottom-left', xRange: [0, 0.5], yRange: [0.5, 1] },
    { name: 'bottom-right', xRange: [0.5, 1], yRange: [0.5, 1] }
  ];

  const bestPerQuadrant = {};

  for (const quad of quadrants) {
    let bestFace = null;
    let bestAttempt = null;

    for (const attempt of allAttempts) {
      // Estimate image size (1:1 ratio, ~1024x1024)
      const imageWidth = 1024;
      const imageHeight = 1024;

      for (const face of attempt.faces) {
        const normX = face.box.x / imageWidth;
        const normY = face.box.y / imageHeight;

        if (normX >= quad.xRange[0] && normX < quad.xRange[1] &&
            normY >= quad.yRange[0] && normY < quad.yRange[1]) {
          if (!bestFace || (face.similarity || 0) > (bestFace.similarity || 0)) {
            bestFace = face;
            bestAttempt = attempt.attempt;
          }
        }
      }
    }

    if (bestFace) {
      bestPerQuadrant[quad.name] = {
        attempt: bestAttempt,
        similarity: bestFace.similarity,
        samePerson: bestFace.same_person,
        confidence: bestFace.match_confidence
      };
      const score = ((bestFace.similarity || 0) * 100).toFixed(1);
      const pass = bestFace.same_person ? '✅' : '❌';
      console.log(`   ${quad.name}: Attempt ${bestAttempt} = ${score}% ${pass}`);
    } else {
      console.log(`   ${quad.name}: No face detected`);
    }
  }

  // Build full score grid (4 quadrants x 3 attempts = 12 scores)
  const scoreGrid = {};
  for (const quad of quadrants) {
    scoreGrid[quad.name] = [];
    for (const attempt of allAttempts) {
      const imageSize = 1024;
      let bestFaceInQuad = null;
      for (const face of attempt.faces) {
        const normX = face.box.x / imageSize;
        const normY = face.box.y / imageSize;
        if (normX >= quad.xRange[0] && normX < quad.xRange[1] &&
            normY >= quad.yRange[0] && normY < quad.yRange[1]) {
          if (!bestFaceInQuad || (face.similarity || 0) > (bestFaceInQuad.similarity || 0)) {
            bestFaceInQuad = face;
          }
        }
      }
      scoreGrid[quad.name].push(bestFaceInQuad ? bestFaceInQuad.similarity : null);
    }
  }

  // Summary - ALL 12 scores
  console.log('\n4. ALL SCORES (4 quadrants x 3 attempts):\n');
  console.log('   Quadrant      | Attempt 1 | Attempt 2 | Attempt 3 | BEST');
  console.log('   --------------|-----------|-----------|-----------|------');
  for (const quad of quadrants) {
    const scores = scoreGrid[quad.name];
    const formatted = scores.map(s => s !== null ? `${(s * 100).toFixed(1).padStart(5)}%` : '   N/A ');
    const best = scores.filter(s => s !== null);
    const bestScore = best.length > 0 ? Math.max(...best) : null;
    const bestStr = bestScore !== null ? `${(bestScore * 100).toFixed(1)}%` : 'N/A';
    const pass = bestScore !== null && bestScore >= 0.45 ? '✅' : '❌';
    console.log(`   ${quad.name.padEnd(13)} | ${formatted[0]} | ${formatted[1]} | ${formatted[2]} | ${bestStr} ${pass}`);
  }

  // Save results
  fs.writeFileSync(
    path.join(baseOutputDir, 'all-scores.json'),
    JSON.stringify({ temperature, numAttempts, scoreGrid, bestPerQuadrant }, null, 2)
  );

  await pool.end();
  console.log(`\n✅ Done - check ${baseOutputDir}`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
