#!/usr/bin/env node
/**
 * Check story_jobs table for avatar objects
 */
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false
});

async function checkJobs() {
  console.log('\n🔍 Checking story_jobs for object-format avatars...\n');

  try {
    const result = await pool.query(
      "SELECT id, created_at, input_data FROM story_jobs ORDER BY created_at DESC LIMIT 10"
    );

    console.log(`Found ${result.rows.length} recent jobs\n`);

    let foundObjects = 0;

    for (const row of result.rows) {
      const inputData = row.input_data;
      const chars = inputData?.characters || [];

      for (const char of chars) {
        if (!char.avatars) continue;

        // Check regular avatars
        for (const cat of ['standard', 'winter', 'summer', 'formal']) {
          const val = char.avatars[cat];
          if (val && typeof val === 'object' && val.imageData) {
            console.log(`📦 OBJECT FOUND: job=${row.id}, char=${char.name}, avatars.${cat}`);
            foundObjects++;
          }
        }

        // Check costumed avatars
        if (char.avatars.costumed) {
          for (const [type, val] of Object.entries(char.avatars.costumed)) {
            if (val && typeof val === 'object' && val.imageData) {
              console.log(`📦 OBJECT FOUND: job=${row.id}, char=${char.name}, avatars.costumed.${type}`);
              foundObjects++;
            }
          }
        }

        // Check styledAvatars
        if (char.avatars.styledAvatars) {
          for (const [style, styleData] of Object.entries(char.avatars.styledAvatars)) {
            if (!styleData || typeof styleData !== 'object') continue;
            for (const [cat, val] of Object.entries(styleData)) {
              if (cat === 'costumed' && val && typeof val === 'object') {
                for (const [type, costVal] of Object.entries(val)) {
                  if (costVal && typeof costVal === 'object' && costVal.imageData) {
                    console.log(`📦 OBJECT FOUND: job=${row.id}, char=${char.name}, styledAvatars.${style}.costumed.${type}`);
                    foundObjects++;
                  }
                }
              } else if (val && typeof val === 'object' && val.imageData) {
                console.log(`📦 OBJECT FOUND: job=${row.id}, char=${char.name}, styledAvatars.${style}.${cat}`);
                foundObjects++;
              }
            }
          }
        }
      }
    }

    console.log(`\n${'='.repeat(50)}`);
    if (foundObjects > 0) {
      console.log(`⚠️  Found ${foundObjects} object-format avatars in story_jobs`);
    } else {
      console.log(`✅ No object-format avatars found in recent jobs`);
    }

  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

checkJobs();
