#!/usr/bin/env node
/**
 * Setup script to create the demo user account with pre-loaded Berger family characters.
 * Run once per environment (local / production).
 *
 * Usage:
 *   node scripts/admin/setup-demo-user.js                          # Against production DB
 *   DEMO_PASSWORD=xxx node scripts/admin/setup-demo-user.js        # Custom password
 *   TEST_BASE_URL=http://localhost:5173 node scripts/admin/setup-demo-user.js  # Against local
 */

const DEMO_EMAIL = 'demo@magicalstory.ch';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'DemoStory2026!';

const DEMO_CHARACTERS = [
  {
    id: 1,
    name: 'Emma',
    gender: 'female',
    age: '5',
    ageCategory: 'preschooler',
    storyRole: 'main',
    physical: {
      hairColor: 'brown',
      hairLength: 'long',
      hairStyle: 'pigtails',
      eyeColor: 'brown',
      skinTone: 'light',
      build: 'average',
      height: 'short',
    },
    traits: {
      strengths: ['Neugierig', 'Fröhlich', 'Fantasievoll'],
      flaws: ['Ungeduldig', 'Anhänglich'],
      challenges: ['Mit anderen teilen', 'Angst vor der Dunkelheit'],
      specialDetails: 'Liebt Schmetterlinge, malt gerne, Lieblingsteddy heisst Bärli',
    },
    clothing: {
      structured: {
        upperBody: 'rosa T-Shirt mit Schmetterlings-Aufdruck',
        lowerBody: 'blaue Jeans',
        shoes: 'weisse Turnschuhe',
      },
    },
  },
  {
    id: 2,
    name: 'Noah',
    gender: 'male',
    age: '7',
    ageCategory: 'young-school-age',
    storyRole: 'main',
    physical: {
      hairColor: 'blonde',
      hairLength: 'short',
      hairStyle: 'straight',
      eyeColor: 'blue',
      skinTone: 'light',
      build: 'average',
      height: 'average',
    },
    traits: {
      strengths: ['Mutig', 'Kreativ', 'Abenteuerlustig'],
      flaws: ['Stur', 'Schlechter Verlierer'],
      challenges: ['Regeln befolgen', 'Gefühle kontrollieren'],
      specialDetails: 'Liebt Dinosaurier, baut gerne Lego, spielt Fussball',
    },
    clothing: {
      structured: {
        upperBody: 'grünes Kapuzenpullover',
        lowerBody: 'dunkelgraue Jogginghose',
        shoes: 'blaue Sneakers',
      },
    },
  },
  {
    id: 3,
    name: 'Daniel',
    gender: 'male',
    age: '38',
    ageCategory: 'adult',
    storyRole: 'in',
    physical: {
      hairColor: 'dark brown',
      hairLength: 'short',
      hairStyle: 'straight',
      eyeColor: 'brown',
      skinTone: 'light',
      facialHair: 'trimmed beard',
      build: 'average',
      height: 'tall',
    },
    traits: {
      strengths: ['Geduldig', 'Beschützend', 'Lustig'],
      flaws: ['Vergesslich', 'Zerstreut'],
      challenges: ['Mit Veränderungen umgehen'],
      specialDetails: 'Ingenieur, liebt Wandern und kocht gerne',
    },
    clothing: {
      structured: {
        upperBody: 'dunkelblaues Hemd',
        lowerBody: 'beige Chinos',
        shoes: 'braune Lederschuhe',
      },
    },
  },
  {
    id: 4,
    name: 'Sarah',
    gender: 'female',
    age: '36',
    ageCategory: 'adult',
    storyRole: 'in',
    physical: {
      hairColor: 'blonde',
      hairLength: 'shoulder-length',
      hairStyle: 'straight',
      eyeColor: 'green',
      skinTone: 'light',
      build: 'average',
      height: 'average',
      other: 'wears glasses',
    },
    traits: {
      strengths: ['Hilfsbereit', 'Klug', 'Grosszügig'],
      flaws: ['Perfektionist', 'Ungeduldig'],
      challenges: ['Für sich einstehen'],
      specialDetails: 'Lehrerin, liest gerne Bücher, liebt Gartenarbeit',
    },
    clothing: {
      structured: {
        upperBody: 'weisse Bluse',
        lowerBody: 'dunkelblauer Rock',
        shoes: 'schwarze Ballerinas',
      },
    },
  },
];

const DEMO_RELATIONSHIPS = {
  '1-2': 'sibling',
  '1-3': 'parent-child',
  '1-4': 'parent-child',
  '2-3': 'parent-child',
  '2-4': 'parent-child',
  '3-4': 'partner',
};

async function setupViaApi() {
  const baseUrl = (process.env.TEST_BASE_URL || 'https://magicalstory.ch').replace(/\/$/, '');
  const apiBase = baseUrl.includes('localhost:5173')
    ? 'http://localhost:3000'  // Vite dev → backend on 3000
    : baseUrl;

  console.log(`Setting up demo user against: ${apiBase}\n`);

  // Step 1: Register demo user
  console.log('1. Registering demo user...');
  const registerRes = await fetch(`${apiBase}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: DEMO_EMAIL,
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
      _formStartTime: Date.now() - 5000,  // Pass bot detection
    }),
  });

  if (!registerRes.ok) {
    const err = await registerRes.json().catch(() => ({}));
    if (err.error?.includes('already exists') || err.message?.includes('already exists')) {
      console.log('   User already exists, logging in instead...');
    } else {
      throw new Error(`Registration failed: ${registerRes.status} ${JSON.stringify(err)}`);
    }
  }

  // Step 2: Login to get token
  console.log('2. Logging in...');
  const loginRes = await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: DEMO_EMAIL,
      password: DEMO_PASSWORD,
    }),
  });

  if (!loginRes.ok) {
    throw new Error(`Login failed: ${loginRes.status} ${await loginRes.text()}`);
  }

  const { token, user } = await loginRes.json();
  console.log(`   Logged in as: ${user.email} (id: ${user.id}, credits: ${user.credits})`);

  // Step 3: Save characters
  console.log('3. Saving Berger family characters...');
  const charRes = await fetch(`${apiBase}/api/characters`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      characters: DEMO_CHARACTERS,
      relationships: DEMO_RELATIONSHIPS,
      relationshipTexts: {},
      customRelationships: [],
      customStrengths: [],
      customWeaknesses: [],
      customFears: [],
    }),
  });

  if (!charRes.ok) {
    throw new Error(`Character save failed: ${charRes.status} ${await charRes.text()}`);
  }

  const charResult = await charRes.json();
  console.log(`   Saved ${charResult.count} characters`);

  // Step 4: Summary
  console.log('\nSetup complete!');
  console.log(`  Email:    ${DEMO_EMAIL}`);
  console.log(`  Password: ${DEMO_PASSWORD}`);
  console.log(`  Credits:  ${user.credits}`);
  console.log(`  Characters: Emma (5), Noah (7), Daniel (38), Sarah (36)`);
  console.log('\nNote: If demo user needs more credits, use admin panel or run:');
  console.log('  UPDATE users SET credits = -1 WHERE email = \'demo@magicalstory.ch\';');
}

setupViaApi().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
