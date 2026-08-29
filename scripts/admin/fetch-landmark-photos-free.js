#!/usr/bin/env node
/**
 * Give photoless landmarks a reference photo — with NO model calls at all.
 *
 * WHY NOT the existing path: `findBestLandmarkImage` looks free but its
 * candidate filter calls `analyzeImageQuality`, which sends every candidate
 * image to GEMINI to score quality and verify location. That is what a
 * "free" bulk photo run actually costs, and when those calls fail every
 * candidate is filtered out and the landmark stays photoless anyway.
 *
 * WHAT THIS USES INSTEAD — Wikipedia's own choice of lead image:
 *   prop=pageimages&piprop=original returns the picture the article displays
 *   in its infobox. Human editors picked it, it is of the article's subject by
 *   construction, and it needs no scoring to be trustworthy. Commons category
 *   files fill the remaining slots for variety.
 *
 * Nothing here is billed: Wikipedia and Commons APIs are free, and no image is
 * sent to any model. Quality control is the separate, already-built visual
 * judge (score-landmarks-for-stories.js) or a human looking at the gallery.
 *
 *   node scripts/admin/fetch-landmark-photos-free.js [--limit=N] [--staging] [--dry-run] [--gallery]
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');
const fs = require('fs');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const STAGING = args.includes('--staging');
const GALLERY = args.includes('--gallery');
const limitArg = args.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;
// Wikimedia throttles a sustained run — measured 2026-08-26, throughput fell
// from ~75/min to ~7/min after several hours of load. Slower is faster over a
// long job, and there is no deadline on a free background pass.
const delayArg = args.find(a => a.startsWith('--delay='));
const DELAY = delayArg ? parseInt(delayArg.split('=')[1], 10) : 150;

// Fetch a photo for everything the selector can actually OFFER, which is every
// type except the three it never treats as a place. An earlier 15-type
// "backdrop" allow-list looked equivalent but was not: it silently skipped
// Building, Landmark, Mountain, River and Station, leaving 278 Swiss rows
// photoless that were never once attempted (measured 2026-08-27). A row the
// selector can offer but has no picture for is exactly the gap this fills, so
// the two lists have to be the same list.
const NEVER_A_SETTING = ['Event', 'Organisation', 'Other'];

const UA = { 'User-Agent': 'MagicalStory/1.0 (https://magicalstory.ch; rogerfischer@hotmail.com) landmark-photos' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(host, params) {
  const url = `https://${host}/w/api.php?${new URLSearchParams({ format: 'json', ...params })}`;
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${host} ${res.status}`);
  return res.json();
}

/** The image the Wikipedia article itself shows — chosen by editors, of the subject. */
async function leadImage(lang, pageId) {
  if (!lang || !pageId) return null;
  const j = await api(`${lang}.wikipedia.org`, { action: 'query', prop: 'pageimages', piprop: 'original', pageids: String(pageId) });
  const page = j?.query?.pages?.[String(pageId)];
  return page?.original?.source || null;
}

/** Extra angles from the landmark's own Commons category, in category order. */
async function commonsFiles(qid, want = 3) {
  if (!qid) return [];
  const e = await api('www.wikidata.org', { action: 'wbgetentities', ids: qid, props: 'claims|sitelinks' });
  const ent = e?.entities?.[qid];
  const cat = ent?.claims?.P373?.[0]?.mainsnak?.datavalue?.value
    || (ent?.sitelinks?.commonswiki?.title || '').replace(/^Category:/, '');
  if (!cat) return [];
  const j = await api('commons.wikimedia.org', {
    action: 'query', list: 'categorymembers', cmtitle: `Category:${cat}`, cmlimit: '20', cmtype: 'file',
  });
  return (j?.query?.categorymembers || [])
    .map(m => m.title)
    .filter(t => /\.(jpe?g|png)$/i.test(t))
    .slice(0, want)
    .map(t => `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(t.replace(/^File:/, ''))}`);
}

/**
 * Who took it and under what licence — a licence CONDITION, not a nicety.
 *
 * Commons content is overwhelmingly CC BY / CC BY-SA, both of which require
 * credit. An earlier version of this script stored `photo_url` alone, so six
 * rows landed with a usable picture and no way to credit it. Storing the URL
 * without the author is the one thing a free image source does not permit.
 *
 * `extmetadata` carries the uploader's own Artist and licence string; the
 * `user` field is the fallback when a file has no structured author.
 */
async function attributionFor(fileUrl) {
  const m = /Special:FilePath\/([^?]+)|\/commons\/(?:thumb\/)?[0-9a-f]\/[0-9a-f]{2}\/([^/?]+)/.exec(fileUrl || '');
  const file = decodeURIComponent(m?.[1] || m?.[2] || '');
  if (!file) return null;
  try {
    const j = await api('commons.wikimedia.org', {
      action: 'query', titles: `File:${file}`, prop: 'imageinfo', iiprop: 'user|extmetadata',
    });
    const info = Object.values(j?.query?.pages || {})[0]?.imageinfo?.[0];
    if (!info) return null;
    const meta = info.extmetadata || {};
    const artist = String(meta.Artist?.value || '').replace(/<[^>]*>/g, '').trim();
    const licence = meta.LicenseShortName?.value || '';
    const who = artist || info.user || 'Unknown';
    return `Photo by ${who}${licence ? `, ${licence}` : ''}, Wikimedia Commons`;
  } catch {
    return null;
  }
}

(async () => {
  const url = STAGING ? process.env.STAGING_DATABASE_URL : process.env.DATABASE_URL;
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

  const rows = (await pool.query(
    `SELECT id, name, type, lang, wikipedia_page_id, wikidata_qid, nearest_city
       FROM landmark_index
      WHERE photo_url IS NULL AND NOT (coalesce(type, 'x') = ANY($1))
      ORDER BY id DESC${LIMIT ? ` LIMIT ${LIMIT}` : ''}`, [NEVER_A_SETTING])).rows;

  console.log(`${STAGING ? 'STAGING' : 'PROD'}: ${rows.length} photoless landmark(s) — no model calls`);

  let filled = 0, none = 0;
  const gallery = [];
  for (const l of rows) {
    let lead = null, extra = [];
    try { lead = await leadImage(l.lang, l.wikipedia_page_id); } catch { /* try commons */ }
    try { extra = await commonsFiles(l.wikidata_qid, 3); } catch { /* lead may still exist */ }

    const urls = [lead, ...extra].filter(Boolean).filter((u, i, a) => a.indexOf(u) === i);
    if (!urls.length) { none++; await sleep(150); continue; }

    if (!DRY) {
      const cols = [];
      const vals = [l.id];
      for (const [i, u] of urls.slice(0, 4).entries()) {
        const s = i === 0 ? '' : `_${i + 1}`;
        vals.push(u);
        cols.push(`photo_url${s} = $${vals.length}`);
        // Credit travels with the picture, in the SAME slot — pairing one
        // slot's photo with another's author names the wrong photographer.
        vals.push(await attributionFor(u));
        cols.push(`photo_attribution${s} = $${vals.length}`);
        await sleep(120);
      }
      await pool.query(
        `UPDATE landmark_index SET ${cols.join(', ')}, photo_source = 'wikipedia-lead', updated_at = NOW() WHERE id = $1`, vals);
    }
    gallery.push({ name: l.name, type: l.type, city: l.nearest_city, url: urls[0] });
    filled++;
    if (filled % 50 === 0) console.log(`  ${filled} filled / ${none} with nothing (${filled + none}/${rows.length})`);
    await sleep(DELAY);
  }

  console.log(`\n${DRY ? '[dry-run] ' : ''}${filled} given a photo, ${none} had none on Wikipedia or Commons.`);

  if (GALLERY && gallery.length) {
    const out = path.join(process.env.TEMP || '/tmp', 'landmark-photos-new.html');
    fs.writeFileSync(out, `<!doctype html><meta charset="utf-8"><title>New landmark photos</title>
<style>body{background:#12141a;color:#e8eaf0;font:13px sans-serif;padding:20px}
.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px}
figure{margin:0;background:#181b23;border:1px solid #262a35;border-radius:8px;overflow:hidden}
img{width:100%;height:150px;object-fit:cover;display:block}
figcaption{padding:7px 9px;font-size:12px}.t{color:#9aa0ad}</style>
<h2>${gallery.length} landmarks given a Wikipedia lead image</h2><div class="g">` +
      gallery.map(g => `<figure><img loading="lazy" src="${g.url}" alt=""><figcaption>${g.name}<br><span class="t">${g.type} · ${g.city}</span></figcaption></figure>`).join('') +
      '</div>');
    console.log(`gallery: ${out}`);
  }
  await pool.end();
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
