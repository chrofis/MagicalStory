#!/usr/bin/env node
/**
 * Generate photo-realistic portraits of the Berger family using Gemini.
 * Then upload them as character photos to the demo account.
 *
 * Usage:
 *   node scripts/admin/generate-demo-photos.js
 *
 * Requires:
 *   - GEMINI_API_KEY in .env
 *   - Demo user already created (run setup-demo-user.js first)
 */

require('dotenv').config();
const sharp = require('sharp');

const DEMO_EMAIL = process.env.DEMO_EMAIL || 'demo@magicalstory.ch';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'DemoStory2026!';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = 'gemini-2.5-flash-image';

if (!GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY not found in environment. Add it to .env');
  process.exit(1);
}

// Photo-realistic portrait prompts for each family member
const PORTRAIT_PROMPTS = [
  {
    characterId: 1,
    name: 'Emma',
    prompt: `Professional portrait photograph of a 5-year-old European girl named Emma. She has brown hair in pigtails, warm brown eyes, light/fair skin, and a cheerful smile. She is wearing a pink t-shirt with a butterfly print. The photo is taken in natural daylight, slightly blurred background (bokeh), sharp focus on the face. Photo-realistic, high quality, like a family portrait session. Upper body shot showing face clearly. No text, no watermarks.`,
  },
  {
    characterId: 2,
    name: 'Noah',
    prompt: `Professional portrait photograph of a 7-year-old European boy named Noah. He has short straight blonde hair, bright blue eyes, light/fair skin, and a confident smile. He is wearing a green hoodie. The photo is taken in natural daylight, slightly blurred background (bokeh), sharp focus on the face. Photo-realistic, high quality, like a family portrait session. Upper body shot showing face clearly. No text, no watermarks.`,
  },
  {
    characterId: 3,
    name: 'Daniel',
    prompt: `Professional portrait photograph of a 38-year-old European man named Daniel. He has short dark brown hair, a neatly trimmed beard, brown eyes, light skin, tall build. He is wearing a dark blue button-up shirt. The photo is taken in natural daylight, slightly blurred background (bokeh), sharp focus on the face. Photo-realistic, high quality, like a professional headshot. Upper body shot showing face clearly. Warm, approachable expression. No text, no watermarks.`,
  },
  {
    characterId: 4,
    name: 'Sarah',
    prompt: `Professional portrait photograph of a 36-year-old European woman named Sarah. She has shoulder-length straight blonde hair, green eyes, light skin, and she wears modern rectangular glasses. She is wearing a white blouse. The photo is taken in natural daylight, slightly blurred background (bokeh), sharp focus on the face. Photo-realistic, high quality, like a professional headshot. Upper body shot showing face clearly. Warm, kind smile. No text, no watermarks.`,
  },
];

async function generatePortrait(prompt, name) {
  console.log(`  Generating portrait for ${name}...`);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const body = {
    contents: [
      {
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      temperature: 0.4,
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error (${res.status}): ${errText}`);
  }

  const data = await res.json();

  // Extract image from response
  const candidates = data.candidates || [];
  if (candidates.length === 0) {
    throw new Error(`No candidates in Gemini response for ${name}`);
  }

  const parts = candidates[0].content?.parts || [];
  const imagePart = parts.find(p => p.inlineData);

  if (!imagePart) {
    const textPart = parts.find(p => p.text);
    throw new Error(`No image in response for ${name}. Text: ${textPart?.text || 'none'}`);
  }

  const rawBase64 = imagePart.inlineData.data;
  const rawSizeKb = Math.round(rawBase64.length * 0.75 / 1024);

  // Compress to JPEG (max 800px, quality 85) to reduce payload size
  const rawBuffer = Buffer.from(rawBase64, 'base64');
  const jpegBuffer = await sharp(rawBuffer)
    .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();

  const jpegBase64 = jpegBuffer.toString('base64');
  const jpegSizeKb = Math.round(jpegBase64.length * 0.75 / 1024);
  const dataUri = `data:image/jpeg;base64,${jpegBase64}`;

  console.log(`  Generated ${name}: ${rawSizeKb}KB → ${jpegSizeKb}KB (compressed JPEG)`);

  return dataUri;
}

async function main() {
  const baseUrl = (process.env.TEST_BASE_URL || 'https://magicalstory.ch').replace(/\/$/, '');
  const apiBase = baseUrl.includes('localhost:5173')
    ? 'http://localhost:3000'
    : baseUrl;

  console.log(`Generating demo portraits and uploading to: ${apiBase}\n`);

  // Step 1: Login
  console.log('1. Logging in as demo user...');
  const loginRes = await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: DEMO_EMAIL, password: DEMO_PASSWORD }),
  });

  if (!loginRes.ok) {
    throw new Error(`Login failed: ${loginRes.status} ${await loginRes.text()}`);
  }

  const { token } = await loginRes.json();
  console.log('   Logged in.\n');

  // Step 2: Get existing characters
  console.log('2. Fetching existing characters...');
  const charRes = await fetch(`${apiBase}/api/characters`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!charRes.ok) {
    throw new Error(`Failed to fetch characters: ${charRes.status}`);
  }

  const charData = await charRes.json();
  const characters = charData.characters || [];
  console.log(`   Found ${characters.length} characters.\n`);

  if (characters.length === 0) {
    throw new Error('No characters found. Run setup-demo-user.js first.');
  }

  // Step 3: Generate portraits
  console.log('3. Generating photo-realistic portraits with Gemini...');
  const photos = {};

  for (const entry of PORTRAIT_PROMPTS) {
    try {
      const dataUri = await generatePortrait(entry.prompt, entry.name);
      photos[entry.characterId] = dataUri;
    } catch (err) {
      console.error(`   Failed to generate ${entry.name}: ${err.message}`);
      // Continue with other characters
    }
  }

  console.log(`   Generated ${Object.keys(photos).length}/${PORTRAIT_PROMPTS.length} portraits.\n`);

  // Step 4: Update characters with photos
  console.log('4. Uploading photos to character profiles...');

  const updatedCharacters = characters.map(char => {
    const photoUri = photos[char.id];
    if (photoUri) {
      return {
        ...char,
        photos: {
          ...(char.photos || {}),
          original: photoUri,
          face: photoUri,  // Use full image as face (will be processed by pipeline)
        },
      };
    }
    return char;
  });

  const saveRes = await fetch(`${apiBase}/api/characters`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      characters: updatedCharacters,
      relationships: charData.relationships || {},
      relationshipTexts: charData.relationshipTexts || {},
      customRelationships: charData.customRelationships || [],
      customStrengths: charData.customStrengths || [],
      customWeaknesses: charData.customWeaknesses || [],
      customFears: charData.customFears || [],
    }),
  });

  if (!saveRes.ok) {
    throw new Error(`Failed to save characters: ${saveRes.status} ${await saveRes.text()}`);
  }

  const saveResult = await saveRes.json();
  console.log(`   Saved ${saveResult.count} characters with photos.\n`);

  console.log('Done! Demo characters now have photo-realistic portraits.');
  console.log('These will be used as reference images during story generation.');
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
