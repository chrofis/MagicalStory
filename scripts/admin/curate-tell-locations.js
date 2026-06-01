#!/usr/bin/env node
/**
 * Curate historical artwork for the Wilhelm Tell story.
 *
 * For each canonical Tell location, searches Wikimedia Commons biased
 * toward 18th–19th century lithographs, engravings, and paintings
 * (well-known Tell illustrators: Disteli, Stückelberg, Vogel, Volz,
 * Reinhart). Downloads up to N candidates per location into a local
 * folder and writes a preview HTML + manifest for user review.
 *
 * Output:
 *   tests/tell-curated/<slug>/01-<title>.jpg
 *   tests/tell-curated/<slug>/...
 *   tests/tell-curated/manifest.json
 *   tests/tell-curated/review.html  ← open in browser, pick favourites
 *
 * NO database writes until the user approves the picks (separate step).
 */

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.resolve(__dirname, '..', '..', 'tests', 'tell-curated');
const PER_LOCATION = 4; // candidates per location

// 8 canonical Tell locations + period-art search queries.
// Each query is tuned with terms that bias Wikimedia toward historical
// artwork rather than modern photographs (lithograph / engraving / artist
// names). The location_query stays simple — that's what runtime falls
// back to when DB lookup misses.
const LOCATIONS = [
  {
    slug: 'marktplatz-altdorf',
    location_name: 'Marktplatz Altdorf',
    location_query: 'Marktplatz Altdorf',
    location_type: 'Square',
    aliases: ['altdorf market square', 'tell square', 'altdorf-platz'],
    searches: [
      'Altdorf Uri lithograph',
      'Altdorf historical engraving',
      'Tell Altdorf 19th century',
    ],
  },
  {
    slug: 'tell-monument',
    location_name: 'Tell Monument',
    location_query: 'Wilhelm Tell Monument Altdorf',
    location_type: 'Monument',
    aliases: ['wilhelm tell statue', 'tell denkmal', 'apfelschuss monument'],
    searches: [
      'Wilhelm Tell Denkmal Altdorf historical',
      'Tell Monument Kissling 1895',
      'Tell statue Altdorf engraving',
    ],
  },
  {
    slug: 'tellskapelle',
    location_name: 'Tellskapelle',
    location_query: 'Tellskapelle Sisikon',
    location_type: 'Chapel',
    aliases: ["tell's chapel", 'tellsplatte chapel', 'chapelle de tell'],
    searches: [
      'Tellskapelle lithograph 19th century',
      'Tell chapel Lake Lucerne engraving',
      'Tellsplatte historical painting',
    ],
  },
  {
    slug: 'tellsplatte',
    location_name: 'Tellsplatte',
    location_query: 'Tellsplatte Lake Uri',
    location_type: 'Historic Site',
    aliases: ["tell's leap", 'tells sprung', 'tellsplattfels'],
    searches: [
      'Tell Sprung Disteli',
      'Tell jumps boat lithograph',
      'Tells Platte engraving',
      'Tellsplatte Vierwaldstaettersee',
      'Wilhelm Tell escape boat',
    ],
  },
  {
    slug: 'hohle-gasse',
    location_name: 'Hohle Gasse',
    location_query: 'Hohle Gasse Küssnacht',
    location_type: 'Historic Site',
    aliases: ['sunken road', 'tell ambush', 'küssnacht hohle gasse'],
    searches: [
      'Hohle Gasse Küssnacht historical engraving',
      'Tell shoots Gessler lithograph',
      'Hohle Gasse painting 19th century',
    ],
  },
  {
    slug: 'burg-zwing-uri',
    location_name: 'Burg Zwing-Uri',
    location_query: 'Zwing-Uri castle',
    location_type: 'Castle',
    aliases: ["gessler's castle", 'habsburg watchtower uri', 'zwing uri burg'],
    searches: [
      'Zwing Uri Burg Stich engraving',
      'Habsburg castle Uri historical',
      'Zwing-Uri castle ruins lithograph',
    ],
  },
  {
    slug: 'ruetli-meadow',
    location_name: 'Rütli',
    location_query: 'Rütli meadow oath',
    location_type: 'Historic Site',
    aliases: ['rütlischwur', 'rütli oath meadow', 'grütli meadow'],
    searches: [
      'Ruetlischwur',
      'Rutlischwur Stueckelberg',
      'Ruetli oath',
      'Rutli meadow Stueckelberg',
      'Stueckelberg Ruetli 1891',
    ],
  },
  {
    slug: 'tellshaus-buerglen',
    location_name: 'Tellshaus Bürglen',
    location_query: 'Tellshaus Bürglen Uri',
    location_type: 'Building',
    aliases: ["tell's house bürglen", 'tellshaus uri', 'tell birthplace'],
    searches: [
      'Tellskapelle Buerglen',
      'Buerglen Tell chapel',
      'Buerglen Uri historical',
      'Tell birthplace Buerglen',
      'Wilhelm Tell Buerglen',
    ],
  },
];

const WIKI_HEADERS = {
  'User-Agent': 'MagicalStory/1.0 (https://magicalstory.ch; contact@magicalstory.ch) Node.js',
  'Accept': 'application/json',
};

// Wikimedia Commons file-namespace search restricted to image filetypes.
// We bias toward historical artwork by including the search terms; we do
// NOT filter out paintings/engravings here (the runtime usually does).
// Limit file types to web-renderable formats; TIFFs from CH-NB are often
// 30-70MB and don't render in browsers. JPG/PNG/WEBP only.
async function searchCommons(query, limit = 6) {
  const url = `https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query + ' filetype:jpg|jpeg|png|webp -filetype:tif')}&srnamespace=6&srlimit=${limit}&format=json&origin=*`;
  const res = await fetch(url, { headers: WIKI_HEADERS });
  if (!res.ok) throw new Error(`Commons search HTTP ${res.status}`);
  const data = await res.json();
  return (data.query?.search || []).map(r => ({
    title: r.title.replace(/^File:/, ''),
    snippet: r.snippet?.replace(/<[^>]+>/g, '') || '',
  }));
}

// Get the actual download URL + metadata for a file title.
async function getFileInfo(filename) {
  const url = `https://commons.wikimedia.org/w/api.php?action=query&titles=File:${encodeURIComponent(filename)}&prop=imageinfo&iiprop=url|extmetadata|size&format=json&origin=*`;
  const res = await fetch(url, { headers: WIKI_HEADERS });
  if (!res.ok) return null;
  const data = await res.json();
  const pages = data.query?.pages || {};
  const page = Object.values(pages)[0];
  const ii = page?.imageinfo?.[0];
  if (!ii) return null;
  const meta = ii.extmetadata || {};
  return {
    url: ii.url,
    width: ii.width,
    height: ii.height,
    description: stripHtml(meta.ImageDescription?.value) || '',
    artist: stripHtml(meta.Artist?.value) || '',
    licenseShortName: meta.LicenseShortName?.value || '',
    dateOriginal: meta.DateTimeOriginal?.value || '',
    objectName: meta.ObjectName?.value || filename,
  };
}

function stripHtml(s) {
  if (!s) return '';
  return String(s).replace(/<[^>]+>/g, '').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

async function downloadImage(url, destPath) {
  const res = await fetch(url, { headers: { 'User-Agent': WIKI_HEADERS['User-Agent'] } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buf);
  return buf.length;
}

function safeFilename(s) {
  return String(s).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const manifest = { generatedAt: new Date().toISOString(), locations: [] };

  for (const loc of LOCATIONS) {
    console.log(`\n=== ${loc.location_name} (${loc.slug}) ===`);
    const locDir = path.join(OUT_DIR, loc.slug);
    if (!fs.existsSync(locDir)) fs.mkdirSync(locDir, { recursive: true });

    // Aggregate search results across all queries, dedupe by title.
    // Filter out obvious modern photos (filename pattern: 4-digit year >= 1950).
    const seen = new Set();
    const candidates = [];
    const isLikelyModernPhoto = (title) => {
      const yearMatch = title.match(/\b(19[5-9]\d|20\d{2})\b/);
      return yearMatch && parseInt(yearMatch[1], 10) >= 1950;
    };
    for (const query of loc.searches) {
      try {
        const results = await searchCommons(query, 8);
        for (const r of results) {
          if (seen.has(r.title)) continue;
          seen.add(r.title);
          if (isLikelyModernPhoto(r.title)) continue;
          if (/\.tiff?$/i.test(r.title)) continue;
          candidates.push({ title: r.title, snippet: r.snippet, query });
          if (candidates.length >= PER_LOCATION) break;
        }
      } catch (e) {
        console.log(`  search "${query}" failed: ${e.message}`);
      }
      if (candidates.length >= PER_LOCATION) break;
    }

    const locEntry = {
      slug: loc.slug,
      location_name: loc.location_name,
      location_query: loc.location_query,
      location_type: loc.location_type,
      aliases: loc.aliases,
      candidates: [],
    };

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const idx = String(i + 1).padStart(2, '0');
      try {
        const info = await getFileInfo(c.title);
        if (!info?.url) {
          console.log(`  ${idx}. SKIP "${c.title}" (no URL)`);
          continue;
        }
        const ext = (info.url.match(/\.(jpe?g|png|webp)$/i) || ['', 'jpg'])[1].toLowerCase();
        const fname = `${idx}-${safeFilename(c.title.replace(/\.\w+$/, ''))}.${ext}`;
        const fpath = path.join(locDir, fname);
        const bytes = await downloadImage(info.url, fpath);
        console.log(`  ${idx}. ${c.title.slice(0, 60)} (${(bytes / 1024).toFixed(0)}KB) — ${info.dateOriginal || 'undated'}`);
        locEntry.candidates.push({
          file: fname,
          title: c.title,
          query: c.query,
          searchSnippet: c.snippet,
          wikimediaUrl: info.url,
          width: info.width,
          height: info.height,
          description: info.description.slice(0, 500),
          artist: info.artist.slice(0, 200),
          license: info.licenseShortName,
          dateOriginal: info.dateOriginal,
          bytes,
        });
      } catch (e) {
        console.log(`  ${idx}. FAILED ${c.title}: ${e.message}`);
      }
    }

    manifest.locations.push(locEntry);
  }

  // Write manifest
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // Write review HTML
  const html = renderReviewHtml(manifest);
  fs.writeFileSync(path.join(OUT_DIR, 'review.html'), html);

  console.log(`\n✅ Done. Open in browser:`);
  console.log(`   ${path.join(OUT_DIR, 'review.html').replace(/\\/g, '/')}`);
  console.log(`   ${manifest.locations.length} locations, ${manifest.locations.reduce((n, l) => n + l.candidates.length, 0)} candidate images.`);
})().catch(e => { console.error(e); process.exit(1); });

function renderReviewHtml(manifest) {
  const sections = manifest.locations.map(loc => {
    const cards = loc.candidates.map(c => `
    <div class="card">
      <img src="${loc.slug}/${c.file}" alt="${escapeHtml(c.title)}" />
      <div class="meta">
        <div class="title">${escapeHtml(c.title)}</div>
        <div class="dim">${c.width}×${c.height} · ${(c.bytes / 1024).toFixed(0)}KB · ${escapeHtml(c.dateOriginal || 'undated')}</div>
        ${c.artist ? `<div class="dim">Artist: ${escapeHtml(c.artist).slice(0, 80)}</div>` : ''}
        ${c.license ? `<div class="dim">License: ${escapeHtml(c.license)}</div>` : ''}
        <div class="desc">${escapeHtml(c.description.slice(0, 200))}</div>
        <div class="dim">Query: <em>${escapeHtml(c.query)}</em></div>
        <a href="${c.wikimediaUrl}" target="_blank">source</a>
      </div>
    </div>`).join('');
    return `
  <section>
    <h2>${escapeHtml(loc.location_name)} <span class="dim">(${loc.candidates.length} candidates)</span></h2>
    <div class="grid">${cards || '<em>No candidates found.</em>'}</div>
  </section>`;
  }).join('');

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Tell location curation</title>
<style>
body { font-family: -apple-system, sans-serif; max-width: 1400px; margin: 1em auto; padding: 0 1em; }
section { margin: 2em 0; border-top: 2px solid #ddd; padding-top: 1em; }
h2 { margin: 0 0 0.5em 0; }
.dim { color: #666; font-size: 0.85em; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1em; }
.card { border: 1px solid #ccc; padding: 0.5em; }
.card img { width: 100%; height: 240px; object-fit: contain; background: #f5f5f5; display: block; }
.meta { padding: 0.5em 0; }
.title { font-weight: 600; word-break: break-word; }
.desc { font-size: 0.85em; margin: 0.5em 0; color: #333; }
</style></head><body>
<h1>Wilhelm Tell — historical-artwork curation</h1>
<p>Generated ${escapeHtml(manifest.generatedAt)}. Pick one favourite per location and reply with the slug → file mapping.</p>
${sections}
</body></html>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
