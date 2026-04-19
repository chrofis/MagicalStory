require('dotenv').config();
const { initializePool, dbQuery } = require('../../server/services/database');
(async () => {
  await initializePool();
  const jobId = process.argv[2] || 'job_1776554957628_pw7g3k0d5';
  const r = await dbQuery(`
    SELECT data::jsonb->'clothingRequirements' as cr,
           data::jsonb->'pageClothing' as pc,
           data::jsonb->'characters' as characters
    FROM stories WHERE id = $1`, [jobId]);
  if (!r[0]) { console.log('no row'); process.exit(0); }
  console.log('=== clothingRequirements ===');
  console.log(JSON.stringify(r[0].cr, null, 2).slice(0, 3000));
  console.log('\n=== pageClothing ===');
  console.log(JSON.stringify(r[0].pc, null, 2).slice(0, 2500));
  console.log('\n=== characters ===');
  const chars = r[0].characters || [];
  for (const c of chars) {
    const avKeys = Object.keys(c.avatars || {});
    const styled = c.avatars?.styledAvatars?.realistic || {};
    const clothing = Object.keys(c.avatars?.clothing || {});
    console.log(`- ${c.name}: avatar keys=${avKeys.join(',')}  styled[realistic]=${Object.keys(styled).join(',') || 'none'}  clothing keys=${clothing.join(',') || 'none'}`);
  }
  process.exit(0);
})().catch(e => { console.error(e.message, e.stack); process.exit(1); });
