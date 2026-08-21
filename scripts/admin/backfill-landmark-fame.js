#!/usr/bin/env node
/**
 * Backfill Wikipedia fame signals (sitelinks and pageviews) into landmark_index.
 *
 * Usage:
 *   node scripts/admin/backfill-landmark-fame.js              # Full backfill (resumable)
 *   node scripts/admin/backfill-landmark-fame.js --limit=100  # Trial run (first 100)
 *   node scripts/admin/backfill-landmark-fame.js --force      # Reprocess all rows
 *
 * Fetches:
 *   - Wikidata: sitelinks (language editions) per landmark
 *   - Wikimedia: monthly pageviews 2025-08-01 to 2026-08-01
 *
 * Key behavior:
 *   - fame_sitelinks is ALWAYS written (0 or higher), never NULL
 *   - fame_updated_at is only stamped on successful sitelinks fetch
 *   - fame_pageviews is best-effort: NULL if no usable title, not suppressing sitelinks
 *   - For pageviews title: prefer row's lang, then enwiki, then any available language
 */

require('dotenv').config();
const { Pool } = require('pg');
const https = require('https');

// Wikidata accepts 50 entities per wbgetentities call — no reason to ask for
// fewer. The pauses were 3s EACH, applied before every single pageview request
// and sequentially: 4.3k rows would have spent 3.6 hours asleep. Wikimedia's
// published guidance tolerates far more than this from a client sending a real
// User-Agent, which we do.
const BATCH_SIZE = 50;
const PAUSE_MS = 1000;       // between pageview waves, not between requests
const BATCH_PAUSE_MS = 250;  // between Wikidata batches
const PV_CONCURRENCY = 2;    // pageview requests in flight at once
const LOG_INTERVAL = 500;
const USER_AGENT = 'MagicalStory/1.0 (https://magicalstory.ch; landmark fame backfill)';

// Command-line args
const args = process.argv.slice(2);
const limitArg = args.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;
const force = args.includes('--force');
// The two signals have wildly different costs: sitelinks batch 50 per Wikidata
// call (whole index in ~96 requests), while pageviews are one throttled request
// per row. Splitting them means the signal that actually fixes the ranking can
// land in minutes instead of waiting behind hours of 429 backoff.
const skipPageviews = args.includes('--skip-pageviews');
const pageviewsOnly = args.includes('--pageviews-only');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function httpsGet(url, headers = {}, attempt = 0, maxRetries = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 404) {
          resolve(null); // Not found
        } else if (res.statusCode === 429) {
          // Rate limited; retry with exponential backoff + Retry-After
          if (attempt < maxRetries) {
            // Respect Retry-After header if present, otherwise use exponential backoff
            const retryAfter = res.headers['retry-after'];
            const waitMs = retryAfter
              ? parseInt(retryAfter) * 1000
              : (5000 * Math.pow(2, attempt)); // 5s, 10s, 20s, 40s, 80s
            console.error(`    [RETRY] Rate limited (429); waiting ${waitMs}ms before retry ${attempt + 1}/${maxRetries}`);
            setTimeout(() => {
              httpsGet(url, headers, attempt + 1, maxRetries)
                .then(resolve)
                .catch(reject);
            }, waitMs);
          } else {
            console.error(`    [FAIL] Rate limited (429); max retries exhausted`);
            resolve(null); // Give up after max retries
          }
        } else if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`JSON parse error: ${e.message}`));
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    }).on('error', reject);
  });
}

async function batchFetchSitelinks(qids) {
  const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qids.join('|')}&props=sitelinks&format=json`;
  try {
    const data = await httpsGet(url, { 'User-Agent': USER_AGENT });
    if (!data || !data.entities) {
      // Fetch failed; return null (not an empty object) so we don't mark these as processed
      return null;
    }

    const result = {};
    for (const qid of qids) {
      const entity = data.entities[qid];
      if (!entity) {
        result[qid] = { sitelinks: 0, sitelinksObj: {}, titles: {} };
      } else if (!entity.sitelinks) {
        result[qid] = { sitelinks: 0, sitelinksObj: {}, titles: {} };
      } else {
        const sitelinksCount = Object.keys(entity.sitelinks).length;
        const sitelinksObj = entity.sitelinks;

        // Collect all titles for fallback logic
        const titles = {};
        for (const [wiki, link] of Object.entries(sitelinksObj)) {
          titles[wiki] = link.title;
        }

        result[qid] = { sitelinks: sitelinksCount, sitelinksObj, titles };
      }
    }
    return result;
  } catch (err) {
    console.error(`  [ERROR] batchFetchSitelinks: ${err.message}`);
    return null; // Return null on error so we don't mark as processed
  }
}

async function fetchPageviews(wiki, title) {
  if (!title) return null;

  try {
    const encoded = encodeURIComponent(title);
    const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/${wiki}.wikipedia/all-access/all-agents/${encoded}/monthly/2025080100/2026080100`;
    const data = await httpsGet(url, { 'User-Agent': USER_AGENT });

    if (!data || !data.items || data.items.length === 0) return null;

    const views = data.items.map(item => item.views);
    const avg = Math.round(views.reduce((a, b) => a + b, 0) / views.length);
    return avg;
  } catch (err) {
    if (err.message.includes('404')) {
      return null; // No data
    }
    console.error(`  [ERROR] fetchPageviews(${wiki}, ${title}): ${err.message}`);
    return null; // Non-fatal failure
  }
}

async function getLandmarksToProcess() {
  let query = `
    SELECT id, name, wikidata_qid, lang
    FROM landmark_index
    WHERE wikidata_qid IS NOT NULL
  `;

  if (pageviewsOnly) {
    // Rows that have a sitelink count but no pageviews yet — independent of
    // fame_updated_at, which a --skip-pageviews pass will already have stamped.
    query += ` AND fame_sitelinks > 0 AND fame_pageviews IS NULL`;
  } else if (!force) {
    query += ` AND fame_updated_at IS NULL`;
  }

  query += ` ORDER BY id`;

  if (limit) {
    query += ` LIMIT ${limit}`;
  }

  const res = await pool.query(query);
  return res.rows;
}

async function updateSitelinks(id, sitelinksCount) {
  // Only update fame_sitelinks and stamp fame_updated_at on successful fetch
  const now = new Date().toISOString();
  await pool.query(
    `UPDATE landmark_index
     SET fame_sitelinks = $1, fame_updated_at = $2
     WHERE id = $3`,
    [sitelinksCount, now, id]
  );
}

async function updatePageviews(id, pageviews) {
  // Update pageviews only (does not re-stamp fame_updated_at)
  await pool.query(
    `UPDATE landmark_index
     SET fame_pageviews = $1
     WHERE id = $2`,
    [pageviews, id]
  );
}

async function main() {
  console.log(`Backfilling landmark fame signals...`);
  console.log(`  Mode: ${force ? 'reprocess all' : 'resumable (skip already processed)'}`);
  if (limit) console.log(`  Limit: ${limit} rows`);

  const landmarks = await getLandmarksToProcess();
  console.log(`Found ${landmarks.length} landmark(s) to process\n`);

  if (landmarks.length === 0) {
    console.log('Nothing to do.');
    await pool.end();
    return;
  }

  let processed = 0;
  let withSitelinks = 0;
  let withPageviews = 0;
  let fetchFailed = 0;

  // Process in batches for sitelinks
  const qidBatches = [];
  const qidToRows = {};

  for (let i = 0; i < landmarks.length; i += BATCH_SIZE) {
    const batch = landmarks.slice(i, i + BATCH_SIZE);
    const qids = batch.map(r => r.wikidata_qid);
    qidBatches.push({ qids, rows: batch });
    for (const row of batch) {
      if (!qidToRows[row.wikidata_qid]) {
        qidToRows[row.wikidata_qid] = [];
      }
      qidToRows[row.wikidata_qid].push(row);
    }
  }

  console.log(`Processing ${qidBatches.length} batch(es) of Wikidata sitelinks...\n`);

  for (let batchIdx = 0; batchIdx < qidBatches.length; batchIdx++) {
    const { qids, rows } = qidBatches[batchIdx];

    const sitelinksData = await batchFetchSitelinks(qids);

    if (!sitelinksData) {
      // Fetch failed; don't mark as processed, so they'll be retried
      console.error(`  [WARN] Batch ${batchIdx + 1} fetch failed; skipping ${rows.length} rows (will retry next run)`);
      fetchFailed += rows.length;

      if (batchIdx < qidBatches.length - 1) {
        await new Promise(resolve => setTimeout(resolve, BATCH_PAUSE_MS));
      }
      continue;
    }

    const pageviewJobs = [];
    for (const row of rows) {
      const qid = row.wikidata_qid;
      const data = sitelinksData[qid];

      if (!data) {
        // This shouldn't happen if batchFetchSitelinks worked, but handle it
        fetchFailed++;
        processed++;
        continue;
      }

      const sitelinksCount = data.sitelinks;

      // Update sitelinks (and stamp fame_updated_at)
      await updateSitelinks(row.id, sitelinksCount);
      processed++;

      if (sitelinksCount > 0) {
        withSitelinks++;

        // Try to find a title for pageviews
        const titles = data.titles;
        let title = null;
        let wiki = null;

        // Prefer row's language
        if (row.lang) {
          const langWiki = `${row.lang}wiki`;
          if (titles[langWiki]) {
            title = titles[langWiki];
            wiki = row.lang;
          }
        }

        // Fall back to English
        if (!title && titles.enwiki) {
          title = titles.enwiki;
          wiki = 'en';
        }

        // Fall back to ANY available language
        if (!title) {
          const available = Object.keys(titles).filter(w => w.endsWith('wiki'));
          if (available.length > 0) {
            wiki = available[0].replace('wiki', '');
            title = titles[available[0]];
          }
        }

        // Queue the pageview lookup — it runs concurrently after the batch's
        // sitelinks are safely written, so a slow or 404ing article can never
        // hold up the signal that actually matters.
        if (title && wiki && !skipPageviews) pageviewJobs.push({ id: row.id, wiki, title });
      }

      if (processed % LOG_INTERVAL === 0) {
        console.log(`  Progress: ${processed}/${landmarks.length}`);
      }
    }

    // Pageviews for this batch, PV_CONCURRENCY at a time.
    for (let i = 0; i < pageviewJobs.length; i += PV_CONCURRENCY) {
      const wave = pageviewJobs.slice(i, i + PV_CONCURRENCY);
      const views = await Promise.all(
        wave.map(j => fetchPageviews(j.wiki, j.title).catch(() => null))
      );
      for (let k = 0; k < wave.length; k++) {
        if (views[k] !== null) {
          await updatePageviews(wave[k].id, views[k]);
          withPageviews++;
        }
      }
      if (i + PV_CONCURRENCY < pageviewJobs.length) {
        await new Promise(resolve => setTimeout(resolve, PAUSE_MS));
      }
    }

    // Pause between batches
    if (batchIdx < qidBatches.length - 1) {
      await new Promise(resolve => setTimeout(resolve, BATCH_PAUSE_MS));
    }
  }

  console.log(`\nBackfill complete!`);
  console.log(`  Rows processed: ${processed}`);
  console.log(`  Rows with sitelinks: ${withSitelinks}`);
  console.log(`  Rows with pageviews: ${withPageviews}`);
  console.log(`  Rows with fetch failures (will retry): ${fetchFailed}`);

  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
