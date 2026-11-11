#!/usr/bin/env node
/**
 * Free replay of the per-layout book price (docs/decisions.md 2026-11-11 "Price per layout from the page tiers"):
 * the real computeBookPageInfo over STORED stories and the real pricing_tiers table (read-only DB read, no paid call).
 * Prints, per combination of the first N stories with --pages scenes, A4 and square printed pages and price, and the
 * OLD price (tier of the one-page count + CHF 5 when square was chosen over an available A4).
 *   node scripts/admin/replay-book-layout-prices.js <userId> [--pages=10]
 */
require('dotenv').config();
const { Pool } = require('pg');
const { computeBookPageInfo } = require('../../server/lib/gelato');
const { parseStoryPages } = require('../../server/lib/pdf');

(async () => {
  const userId = process.argv[2];
  const pagesArg = Number((process.argv.find(a => a.startsWith('--pages=')) || '--pages=10').split('=')[1]);
  if (!userId) throw new Error('usage: replay-book-layout-prices.js <userId> [--pages=10]');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const tiers = (await pool.query('SELECT max_pages, softcover_price, hardcover_price FROM pricing_tiers ORDER BY max_pages ASC')).rows;
  const price = (pages, hard) => {
    const t = tiers.find(x => x.max_pages >= pages) || tiers[tiers.length - 1];
    return Number(hard ? t.hardcover_price : t.softcover_price);
  };
  const rows = (await pool.query('SELECT id, data FROM stories WHERE user_id = $1 ORDER BY created_at', [userId])).rows;
  const stories = rows.map(r => typeof r.data === 'string' ? JSON.parse(r.data) : r.data).filter(d => parseStoryPages(d).length === pagesArg);
  console.log(`${stories.length} stories with ${pagesArg} scenes of user ${userId}; tiers: ${tiers.map(t => `${t.max_pages}:${t.softcover_price}/${t.hardcover_price}`).join(' ')}`);
  console.log('n | A4 content/printed/avail | square content/printed/avail | soft: A4, square, OLD default, OLD square | hard: A4, square, OLD default, OLD square');
  for (let n = 1; n <= Math.min(6, stories.length); n++) {
    const datas = stories.slice(0, n);
    const info = await computeBookPageInfo(pool, datas, 'softcover');
    const { single, spread } = info.layouts;
    const cell = l => `${l.contentPages}/${l.printedPages}/${l.available ? 'yes' : 'no'}`;
    const cols = hard => {
      const a4 = price(single.contentPages, hard), sq = price(spread.contentPages, hard);
      const oldBase = price(single.contentPages, hard);       // old rule: tier of the one-page count
      const oldSq = oldBase + (single.available ? 5 : 0);      // + CHF 5 when square was chosen over an available A4
      const oldDefault = single.available ? oldBase : oldBase; // default layout was A4 when available, else square at the base
      return `${single.available ? a4 : 'n/a'}, ${spread.available ? sq : 'n/a'}, ${oldDefault}, ${spread.available ? oldSq : 'n/a'}`;
    };
    console.log(`${n} | ${cell(single)} | ${cell(spread)} | ${cols(false)} | ${cols(true)}`);
  }
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
