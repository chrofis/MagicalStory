#!/usr/bin/env node
/**
 * Analyze database JSONB structure for inconsistencies
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function analyze() {
  console.log('='.repeat(60));
  console.log('CHARACTERS.DATA STRUCTURE');
  console.log('='.repeat(60));

  const chars = await pool.query('SELECT data FROM characters LIMIT 1');
  if (chars.rows[0]?.data) {
    const data = chars.rows[0].data;
    console.log('Top-level keys:', Object.keys(data));

    if (data.characters?.[0]) {
      // Collect all keys across all characters
      const charKeys = new Set();
      for (const char of data.characters) {
        Object.keys(char).forEach(k => charKeys.add(k));
      }
      console.log('\nAll character field names:');
      console.log([...charKeys].sort().join('\n'));

      // Check for naming pattern issues
      console.log('\n--- Naming Pattern Analysis ---');
      const snakeCase = [...charKeys].filter(k => k.includes('_'));
      const camelCase = [...charKeys].filter(k => /[a-z][A-Z]/.test(k));
      console.log('snake_case fields:', snakeCase.join(', ') || 'none');
      console.log('camelCase fields:', camelCase.join(', ') || 'none');
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('STORIES.DATA STRUCTURE');
  console.log('='.repeat(60));

  const stories = await pool.query('SELECT id, data FROM stories ORDER BY created_at DESC LIMIT 3');
  const allStoryKeys = new Set();
  const allCharKeys = new Set();

  for (const row of stories.rows) {
    const data = row.data;
    Object.keys(data).forEach(k => allStoryKeys.add(k));

    if (data.characters) {
      for (const char of data.characters) {
        Object.keys(char).forEach(k => allCharKeys.add(k));
      }
    }
  }

  console.log('Story top-level keys:', [...allStoryKeys].sort().join(', '));
  console.log('\nCharacter keys in stories:', [...allCharKeys].sort().join(', '));

  // Check for snake_case vs camelCase
  const snakeStory = [...allStoryKeys].filter(k => k.includes('_'));
  const camelStory = [...allStoryKeys].filter(k => /[a-z][A-Z]/.test(k));
  console.log('\n--- Story Naming Pattern Analysis ---');
  console.log('snake_case:', snakeStory.join(', ') || 'none');
  console.log('camelCase:', camelStory.join(', ') || 'none');

  const snakeChar = [...allCharKeys].filter(k => k.includes('_'));
  const camelChar = [...allCharKeys].filter(k => /[a-z][A-Z]/.test(k));
  console.log('\n--- Story Character Naming ---');
  console.log('snake_case:', snakeChar.join(', ') || 'none');
  console.log('camelCase:', camelChar.join(', ') || 'none');

  // Check avatar structure
  console.log('\n' + '='.repeat(60));
  console.log('AVATAR STRUCTURE ANALYSIS');
  console.log('='.repeat(60));

  const charsFull = await pool.query('SELECT data FROM characters');
  const avatarKeys = new Set();
  const styledAvatarStyles = new Set();
  const clothingKeys = new Set();

  for (const row of charsFull.rows) {
    const data = row.data;
    if (data.characters) {
      for (const char of data.characters) {
        if (char.avatars) {
          Object.keys(char.avatars).forEach(k => avatarKeys.add(k));
          if (char.avatars.styledAvatars) {
            Object.keys(char.avatars.styledAvatars).forEach(k => styledAvatarStyles.add(k));
          }
          if (char.avatars.clothing) {
            Object.keys(char.avatars.clothing).forEach(k => clothingKeys.add(k));
          }
        }
      }
    }
  }

  console.log('Avatar object keys:', [...avatarKeys].sort().join(', '));
  console.log('Art styles in styledAvatars:', [...styledAvatarStyles].sort().join(', '));
  console.log('Clothing categories:', [...clothingKeys].sort().join(', '));

  // Check physical traits structure
  console.log('\n' + '='.repeat(60));
  console.log('PHYSICAL TRAITS ANALYSIS');
  console.log('='.repeat(60));

  const physicalKeys = new Set();
  const flatPhysicalKeys = new Set();

  for (const row of charsFull.rows) {
    const data = row.data;
    if (data.characters) {
      for (const char of data.characters) {
        // Check physical object
        if (char.physical) {
          Object.keys(char.physical).forEach(k => physicalKeys.add(k));
        }
        // Check flat physical fields
        const flatFields = ['hair_color', 'eye_color', 'hair_style', 'hair_length', 'build', 'skin_tone', 'facial_hair'];
        for (const f of flatFields) {
          if (char[f]) flatPhysicalKeys.add(f);
        }
      }
    }
  }

  console.log('physical object keys:', [...physicalKeys].sort().join(', ') || 'none');
  console.log('Flat physical fields found:', [...flatPhysicalKeys].sort().join(', ') || 'none');

  // Check traits structure
  console.log('\n' + '='.repeat(60));
  console.log('TRAITS STRUCTURE ANALYSIS');
  console.log('='.repeat(60));

  const traitsKeys = new Set();
  const flatTraitFields = new Set();

  for (const row of charsFull.rows) {
    const data = row.data;
    if (data.characters) {
      for (const char of data.characters) {
        if (char.traits) {
          Object.keys(char.traits).forEach(k => traitsKeys.add(k));
        }
        // Check for flat trait fields
        if (char.strengths) flatTraitFields.add('strengths');
        if (char.flaws || char.weaknesses) flatTraitFields.add('flaws/weaknesses');
        if (char.challenges || char.fears) flatTraitFields.add('challenges/fears');
      }
    }
  }

  console.log('traits object keys:', [...traitsKeys].sort().join(', ') || 'none');
  console.log('Flat trait fields found:', [...flatTraitFields].sort().join(', ') || 'none');

  // Story job analysis
  console.log('\n' + '='.repeat(60));
  console.log('STORY_JOBS STRUCTURE');
  console.log('='.repeat(60));

  const jobs = await pool.query('SELECT input_data, result_data FROM story_jobs WHERE input_data IS NOT NULL LIMIT 1');
  if (jobs.rows[0]) {
    console.log('input_data keys:', Object.keys(jobs.rows[0].input_data || {}).sort().join(', '));
    console.log('result_data keys:', Object.keys(jobs.rows[0].result_data || {}).sort().join(', '));
  }

  await pool.end();
}

analyze().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
