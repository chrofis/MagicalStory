/**
 * Extract all styled and base avatars for a user and save as image files.
 * Processes one avatar at a time to avoid memory issues.
 */
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const OUTPUT_DIR = path.join(__dirname, '..', 'tests', 'fixtures', 'avatars');

function sanitizeName(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function saveBase64Image(base64Data, filePath) {
  let ext = 'png';
  let buffer;

  if (base64Data.startsWith('data:')) {
    const match = base64Data.match(/^data:image\/([\w+]+);base64,(.+)$/s);
    if (!match) {
      console.warn(`  WARNING: Unrecognized data URL format, skipping`);
      return false;
    }
    ext = match[1] === 'jpeg' ? 'jpg' : match[1];
    buffer = Buffer.from(match[2], 'base64');
  } else {
    buffer = Buffer.from(base64Data, 'base64');
  }

  const finalPath = filePath.replace(/\.[^.]+$/, `.${ext}`);
  fs.writeFileSync(finalPath, buffer);
  return finalPath;
}

async function main() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const client = await pool.connect();
  const summary = {};
  let totalCount = 0;

  try {
    // Get character set ID
    const charSetRes = await client.query(
      `SELECT id FROM characters WHERE user_id = (SELECT id FROM users WHERE email = $1) ORDER BY created_at DESC LIMIT 1`,
      ['rogerfischer@hotmail.com']
    );
    const charSetId = charSetRes.rows[0].id;
    console.log(`Character set: ${charSetId}\n`);

    // Get number of characters
    const countRes = await client.query(
      `SELECT jsonb_array_length(data->'characters') as cnt FROM characters WHERE id = $1`,
      [charSetId]
    );
    const numChars = countRes.rows[0].cnt;
    console.log(`Total characters: ${numChars}\n`);

    for (let i = 0; i < numChars; i++) {
      // Get character name - use jsonb_array_element with cast
      const nameRes = await client.query(
        `SELECT jsonb_array_element(data->'characters', $2::int)->>'name' as name FROM characters WHERE id = $1`,
        [charSetId, i]
      );
      const charName = nameRes.rows[0]?.name;
      if (!charName) {
        console.log(`\nCharacter index ${i}: NO NAME (skipping)`);
        continue;
      }
      const safeName = sanitizeName(charName);
      summary[charName] = { base: 0, styled: 0, details: [] };

      console.log(`\n=== ${charName} ===`);

      // Extract base avatars (standard, summer, winter)
      for (const clothing of ['standard', 'summer', 'winter']) {
        const avatarRes = await client.query(
          `SELECT jsonb_array_element(data->'characters', $2::int)->'avatars'->>$3 as avatar FROM characters WHERE id = $1`,
          [charSetId, i, clothing]
        );
        const avatar = avatarRes.rows[0]?.avatar;
        if (avatar && (avatar.startsWith('data:') || avatar.length > 200)) {
          const filePath = path.join(OUTPUT_DIR, `${safeName}_base_${clothing}.png`);
          const saved = saveBase64Image(avatar, filePath);
          if (saved) {
            summary[charName].base++;
            totalCount++;
            summary[charName].details.push(`base/${clothing}`);
            console.log(`  Saved: ${path.basename(saved)}`);
          }
        }
      }

      // Get styled avatar style keys for this character
      const styleKeysRes = await client.query(`
        SELECT s.style_key
        FROM characters ch,
          jsonb_each(jsonb_array_element(ch.data->'characters', $2::int)->'avatars'->'styledAvatars') AS s(style_key, style_value)
        WHERE ch.id = $1
        ORDER BY s.style_key
      `, [charSetId, i]);

      for (const styleRow of styleKeysRes.rows) {
        const style = styleRow.style_key;

        // Get clothing keys for this style
        const clothingKeysRes = await client.query(`
          SELECT c.clothing_key
          FROM characters ch,
            jsonb_each(jsonb_array_element(ch.data->'characters', $2::int)->'avatars'->'styledAvatars'->$3) AS c(clothing_key, clothing_value)
          WHERE ch.id = $1
          ORDER BY c.clothing_key
        `, [charSetId, i, style]);

        for (const clothingRow of clothingKeysRes.rows) {
          const clothing = clothingRow.clothing_key;

          // Extract the actual avatar image data
          const avatarRes = await client.query(
            `SELECT jsonb_array_element(data->'characters', $2::int)->'avatars'->'styledAvatars'->$3->>$4 as avatar FROM characters WHERE id = $1`,
            [charSetId, i, style, clothing]
          );
          const avatar = avatarRes.rows[0]?.avatar;
          if (avatar && (avatar.startsWith('data:') || avatar.length > 200)) {
            const filePath = path.join(OUTPUT_DIR, `${safeName}_${style}_${clothing}.png`);
            const saved = saveBase64Image(avatar, filePath);
            if (saved) {
              summary[charName].styled++;
              totalCount++;
              summary[charName].details.push(`${style}/${clothing}`);
              console.log(`  Saved: ${path.basename(saved)}`);
            }
          }
        }
      }
    }

    // Print summary
    console.log('\n\n========== SUMMARY ==========');
    console.log(`Total avatars saved: ${totalCount}`);
    console.log(`Output directory: ${OUTPUT_DIR}\n`);

    for (const [name, info] of Object.entries(summary)) {
      const total = info.base + info.styled;
      if (total > 0) {
        console.log(`${name}: ${total} avatars (${info.base} base, ${info.styled} styled)`);
        const styledByStyle = {};
        for (const d of info.details) {
          if (d.startsWith('base/')) continue;
          const [style] = d.split('/');
          styledByStyle[style] = (styledByStyle[style] || 0) + 1;
        }
        if (Object.keys(styledByStyle).length > 0) {
          console.log(`  Styles: ${Object.entries(styledByStyle).map(([s, c]) => `${s}(${c})`).join(', ')}`);
        }
      } else {
        console.log(`${name}: 0 avatars`);
      }
    }

    // Art style totals
    console.log('\n--- Art Style Totals ---');
    const styleTotals = {};
    for (const info of Object.values(summary)) {
      for (const d of info.details) {
        if (d.startsWith('base/')) {
          styleTotals['base'] = (styleTotals['base'] || 0) + 1;
        } else {
          const [style] = d.split('/');
          styleTotals[style] = (styleTotals[style] || 0) + 1;
        }
      }
    }
    for (const [style, count] of Object.entries(styleTotals).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${style}: ${count}`);
    }

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(console.error);
