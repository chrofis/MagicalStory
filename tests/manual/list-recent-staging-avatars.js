/**
 * List recent staging stories with their styled-avatar sheet URLs and the
 * commit-era they ran in, so a suspected avatar-sheet regression can be dated
 * against a deploy rather than guessed at.
 *
 * Usage: node tests/manual/list-recent-staging-avatars.js [limit]
 */
require('dotenv').config();
const { Pool } = require('pg');
const { ch } = require('../../scripts/lib/chTime.js');

const limit = Number(process.argv[2] || 12);
const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  const rows = await pool.query(
    `select id, created_at, data->>'title' as title,
            data->'characterAvatars' as avatars,
            jsonb_array_length(coalesce(data->'styledAvatarGeneration','[]'::jsonb)) as gen_count
       from stories
      where data->'characterAvatars' is not null
      order by created_at desc
      limit $1`, [limit]);

  for (const r of rows.rows) {
    console.log(`${ch(new Date(r.created_at))}  ${r.id}  gens=${r.gen_count}  ${(r.title || '').slice(0, 34)}`);
    for (const [name, slots] of Object.entries(r.avatars || {})) {
      for (const [slot, url] of Object.entries(slots || {})) {
        console.log(`    ${name}/${slot}: ${url}`);
      }
    }
  }
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
