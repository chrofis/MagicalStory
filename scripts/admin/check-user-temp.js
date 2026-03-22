const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  try {
    const u = await pool.query("SELECT id, username, email, credits FROM users WHERE email = 'corina.luethy@gmx.ch'");
    if (!u.rows.length) { console.log('User not found'); return; }
    const user = u.rows[0];
    console.log('USER:', user.id, '|', user.username, '|', user.email, '| credits:', user.credits);

    const j = await pool.query('SELECT id, status, error_message, created_at, credits_reserved FROM story_jobs WHERE user_id = $1 ORDER BY created_at DESC', [user.id]);
    console.log('\nJOBS (' + j.rows.length + '):');
    j.rows.forEach(r => console.log('  ', r.id, '|', r.status, '|', r.created_at, '| reserved:', r.credits_reserved, '|', (r.error_message || '-').substring(0, 80)));

    const s = await pool.query("SELECT id, title, status, created_at, data->>'totalScenes' as scenes, data->>'sceneCount' as scene_count FROM stories WHERE user_id = $1 ORDER BY created_at DESC", [user.id]);
    console.log('\nSTORIES (' + s.rows.length + '):');
    for (const r of s.rows) {
      // Check how many scenes have images
      const storyData = await pool.query("SELECT data->'sceneImages' as images, data->'coverImages' as covers FROM stories WHERE id = $1", [r.id]);
      const images = storyData.rows[0]?.images;
      const covers = storyData.rows[0]?.covers;
      const imgCount = Array.isArray(images) ? images.filter(i => i && i.imageData).length : 0;
      const hasFront = covers?.frontCover?.imageData ? 'Y' : 'N';
      const hasBack = covers?.backCover?.imageData ? 'Y' : 'N';
      console.log('  ', r.id, '|', r.status, '|', r.title, '| scenes:', r.scenes || r.scene_count, '| images:', imgCount, '| covers: front=' + hasFront + ' back=' + hasBack, '|', r.created_at);
    }
  } finally {
    await pool.end();
  }
})();
