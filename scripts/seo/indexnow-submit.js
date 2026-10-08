#!/usr/bin/env node
/**
 * Submit our sitemap URLs to IndexNow (Bing, Yandex, ... share them), so Bing --
 * whose index ChatGPT search draws on -- picks pages up quickly.
 * Protocol: https://www.indexnow.org/documentation. Setup: docs/seo-indexnow.md.
 *
 * Run: INDEXNOW_KEY=<key> node scripts/seo/indexnow-submit.js [--dry-run]
 *        [--base=https://magicalstory.ch] [--urls=https://a,https://b]
 *
 * Before sending anything it fetches <base>/<key>.txt and requires it to contain
 * the key (the same check the search engine makes); fails loudly otherwise.
 */
const ENDPOINT = 'https://api.indexnow.org/indexnow';
const MAX_URLS_PER_POST = 10000; // protocol limit
const KEY_RE = /^[A-Za-z0-9-]{8,128}$/;

function parseSitemapUrls(xml) {
  const urls = [];
  const re = /<loc>\s*([^<]+?)\s*<\/loc>/g;
  let m;
  while ((m = re.exec(xml))) {
    urls.push(m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"));
  }
  return [...new Set(urls)];
}

function batchUrls(urls, size = MAX_URLS_PER_POST) {
  const out = [];
  for (let i = 0; i < urls.length; i += size) out.push(urls.slice(i, i + size));
  return out;
}

function validateKey(key) {
  if (!key) throw new Error('INDEXNOW_KEY is not set');
  if (!KEY_RE.test(key)) throw new Error('INDEXNOW_KEY must be 8-128 chars of a-z A-Z 0-9 and -');
  return key;
}

async function verifyKeyFile(base, key, fetchFn = fetch) {
  const url = `${base}/${key}.txt`;
  const r = await fetchFn(url);
  if (!r.ok) throw new Error(`key file ${url} returned HTTP ${r.status}`);
  const body = (await r.text()).trim();
  if (body !== key) throw new Error(`key file ${url} does not contain the key`);
}

function buildPayload(host, key, urlList) {
  return { host, key, urlList };
}

function parseArgs(argv) {
  const get = n => (argv.find(a => a.startsWith(`--${n}=`)) || '').slice(n.length + 3);
  return {
    dryRun: argv.includes('--dry-run'),
    base: (get('base') || 'https://magicalstory.ch').replace(/\/+$/, ''),
    urls: get('urls') ? get('urls').split(',').map(s => s.trim()).filter(Boolean) : null,
  };
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const { dryRun, base, urls: explicit } = parseArgs(argv);
  const key = validateKey(env.INDEXNOW_KEY);
  const host = new URL(base).host;

  await verifyKeyFile(base, key);
  console.log(`key file OK at ${base}/${key.slice(0, 4)}...txt`);

  let urls = explicit;
  if (!urls) {
    const r = await fetch(`${base}/sitemap.xml`);
    if (!r.ok) throw new Error(`sitemap ${base}/sitemap.xml returned HTTP ${r.status}`);
    urls = parseSitemapUrls(await r.text());
  }
  const foreign = urls.filter(u => new URL(u).host !== host);
  if (foreign.length) throw new Error(`${foreign.length} URL(s) not on host ${host} (IndexNow would 422), first: ${foreign[0]}`);
  if (!urls.length) throw new Error('no URLs to submit');

  const batches = batchUrls(urls);
  console.log(`${urls.length} URL(s) in ${batches.length} batch(es)${dryRun ? ' [dry-run]' : ''}`);
  let failed = false;
  for (let i = 0; i < batches.length; i++) {
    if (dryRun) {
      console.log(`batch ${i + 1}: would POST ${batches[i].length} URLs to ${ENDPOINT}; first: ${batches[i][0]}`);
      continue;
    }
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(buildPayload(host, key, batches[i])),
    });
    console.log(`batch ${i + 1}/${batches.length}: HTTP ${res.status} (${batches[i].length} URLs)`);
    if (!(res.status >= 200 && res.status < 300)) failed = true;
  }
  if (failed) throw new Error('at least one batch got a non-2xx response');
}

module.exports = { parseSitemapUrls, batchUrls, validateKey, verifyKeyFile, buildPayload, parseArgs, MAX_URLS_PER_POST };

if (require.main === module) {
  main().catch(e => { console.error('FAIL: ' + e.message); process.exitCode = 1; });
}
