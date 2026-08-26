// API-based smoke: login as admin, trigger 4-page story, poll job to completion.
const BASE = 'https://staging.magicalstory.ch';
const EMAIL = 'demo-b-hnecf@magicalstory.ch';
const PASSWORD = process.env.DEMO_PASSWORD || 'DemoStory2026!';

// /api/* bypasses the staging Basic-Auth gate (server.js:600), so no
// Basic-Auth header on API calls — that header would otherwise collide
// with the Bearer token in the same Authorization slot and fail JWT verify.
async function jfetch(path, opts = {}) {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

async function tfetch(token, path, opts = {}) {
  return jfetch(path, {
    ...opts,
    headers: { ...(opts.headers || {}), 'Authorization': `Bearer ${token}` },
  });
}

(async () => {
  console.log('1. Login…');
  const login = await jfetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  if (login.status !== 200) {
    console.error('Login failed:', login.status, login.body);
    process.exit(1);
  }
  const token = login.body.token || login.body.accessToken || login.body.access_token;
  if (!token) { console.error('No token in login response:', login.body); process.exit(1); }
  console.log('  ✓ token', String(token).slice(0, 30) + '…');

  console.log('2. Characters…');
  const chars = await tfetch(token, '/api/characters');
  if (chars.status !== 200) { console.error('GET /api/characters failed:', chars.status, chars.body); process.exit(1); }
  const arr = Array.isArray(chars.body) ? chars.body : (chars.body.characters || []);
  console.log(`  ✓ ${arr.length} characters: ${arr.map(c => c.name).join(', ')}`);
  // Pick 2 as mainCharacters (Emma, Noah preferred)
  const preferred = ['Emma', 'Noah'];
  const mainChars = preferred.map(n => arr.find(c => c.name === n)).filter(Boolean);
  if (mainChars.length < 2) {
    // fallback: just take first 2
    mainChars.splice(0, mainChars.length, ...arr.slice(0, 2));
  }
  console.log(`  mainCharacters: ${mainChars.map(c => c.name).join(', ')}`);

  console.log('3. Create story job (4 pages, watercolor, Wilhelm Tell, 5 chars, skip covers)…');
  const inputs = {
    pages: 4,
    language: 'de',
    languageLevel: 'standard',
    storyCategory: 'adventure',
    storyTopic: 'wilhelm-tell',
    storyTheme: 'wilhelm-tell',
    artStyle: 'watercolor',
    storyDetails: 'Eine Wilhelm-Tell-Geschichte: Die Familie besucht Altdorf und erlebt die Legende von Wilhelm Tell nach — Apfelschuss, der strenge Vogt und die Flucht über den See.',
    characters: arr,
    mainCharacters: mainChars.map(c => c.id),
    layout: { mode: 'square-below', imageAspect: '1:1', textInImage: false },
    skipCovers: true,
  };
  const create = await tfetch(token, '/api/jobs/create-story', { method: 'POST', body: JSON.stringify(inputs) });
  if (create.status !== 200) {
    console.error('Create job failed:', create.status, JSON.stringify(create.body).slice(0, 500));
    process.exit(1);
  }
  const jobId = create.body.jobId;
  console.log('  ✓ job id:', jobId);

  console.log('4. Polling job until complete…');
  const startedAt = Date.now();
  let lastProgress = -1;
  for (;;) {
    await new Promise(r => setTimeout(r, 15000));
    const st = await tfetch(token, `/api/jobs/${jobId}/status`);
    if (st.status !== 200) {
      console.log(`  poll error ${st.status}:`, JSON.stringify(st.body).slice(0, 200));
      continue;
    }
    const j = st.body;
    if (j.progress !== lastProgress) {
      console.log(`  [${Math.round((Date.now() - startedAt)/1000)}s] status=${j.status} progress=${j.progress}% ${j.progress_message || j.message || ''}`);
      lastProgress = j.progress;
    }
    if (j.status === 'completed') {
      console.log(`\nDONE in ${Math.round((Date.now() - startedAt)/1000)}s`);
      console.log('Story URL: ' + BASE + '/create?storyId=' + jobId);
      process.exit(0);
    }
    if (j.status === 'failed') {
      console.error(`FAILED: ${j.error_message || JSON.stringify(j).slice(0,500)}`);
      process.exit(1);
    }
    if (Date.now() - startedAt > 30 * 60 * 1000) {
      console.error('TIMEOUT after 30 min');
      process.exit(1);
    }
  }
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
