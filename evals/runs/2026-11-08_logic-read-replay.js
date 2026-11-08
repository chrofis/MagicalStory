// Free replay of the logic read (prompts/story-text-logic-read.txt) over the 16 staging books of quality test E.
// Text = the pipeline's final text stored by test C (evals/runs/2026-11-08_quality-tests-C/books/bookNN.txt = last
// roundTrace pass = lector output). Those folders hold customer text and are git-ignored; so is the output.
//
//   node evals/runs/2026-11-08_logic-read-replay.js build <outDir>        real prompt per book -> <outDir>/bookNN.prompt.txt
//   node evals/runs/2026-11-08_logic-read-replay.js score <answers.json>  type the answers with the REAL parseLogicRead
//
// answers.json: { "bookNN": { "resolution": {...}, "findings": [ {pages, question, severity, quote, fix} ] } }, i.e. the
// reply an agent (stand-in for the model) gave to the built prompt. score drops and reports every entry the parser rejects.
// A stand-in run costs USD 0. See docs/decisions.md 2026-11-08 "Logic read of the finished text".
const fs = require('fs');
const path = require('path');

const C = path.join(__dirname, '2026-11-08_quality-tests-C');
const E = path.join(__dirname, '2026-11-08_quality-tests-E');
const key = JSON.parse(fs.readFileSync(path.join(C, 'key.json'), 'utf8'));
const heroes = JSON.parse(fs.readFileSync(path.join(E, 't2-heroes.json'), 'utf8'));
const VERSE = new Set(['job_1794128424739_0j933o99i5u']);

function loadBook(book) {
  const raw = fs.readFileSync(path.join(C, 'books', book + '.txt'), 'utf8');
  const language = (raw.match(/^LANGUAGE:\s*(.+)$/m) || [])[1].trim();
  const pages = [...raw.matchAll(/--- Page (\d+) ---\n([\s\S]*?)(?=\n--- Page \d+ ---|$)/g)]
    .map(m => ({ pageNumber: +m[1], text: m[2].trim() }));
  return { language, pages };
}

async function build(outDir) {
  const { loadPromptTemplates } = require('../../server/services/prompts');
  await loadPromptTemplates();
  const { buildTextLogicReadPrompt } = require('../../server/lib/promptBuilders');
  fs.mkdirSync(outDir, { recursive: true });
  const index = [];
  for (const [book, id] of Object.entries(key)) {
    if (!heroes[id]) continue;
    const { language, pages } = loadBook(book);
    const characters = heroes[id].hero.map((name, i) => ({ id: 'm' + i, name }));
    const storyData = { language, characters, mainCharacters: characters.map(c => c.id) };
    if (VERSE.has(id)) { storyData.storyCategory = 'educational'; storyData.storyTopic = 'rhyming'; }
    const prompt = buildTextLogicReadPrompt(storyData, pages);
    fs.writeFileSync(path.join(outDir, book + '.prompt.txt'), prompt);
    index.push({ book, id, title: heroes[id].title, pages: pages.length, chars: prompt.length, verse: VERSE.has(id) });
  }
  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index, null, 1));
  console.log(index.map(i => `${i.book} ${i.id.slice(-9)} p${i.pages} ${i.chars}c ${i.verse ? 'VERSE' : ''} ${i.title}`).join('\n'));
}

function score(answersFile) {
  const { parseLogicRead } = require('../../server/lib/textLogicRead');
  const answers = JSON.parse(fs.readFileSync(answersFile, 'utf8'));
  const out = {};
  for (const [book, ans] of Object.entries(answers)) {
    const { pages } = loadBook(book);
    const r = parseLogicRead(JSON.stringify(ans), pages);
    out[book] = { id: key[book], ok: r.ok, findings: r.findings, dropped: r.dropped };
    console.log(book, 'findings', r.findings.length, 'MAJOR', r.findings.filter(f => f.severity === 'MAJOR').length,
      'dropped', r.dropped.map(d => d.reason + ':' + String(d.finding.quote || '').slice(0, 40)).join(' | '));
  }
  fs.writeFileSync(answersFile.replace(/\.json$/, '.typed.json'), JSON.stringify(out, null, 1));
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'build' && arg) build(arg).catch(e => { console.error(e); process.exit(1); });
else if (cmd === 'score' && arg) score(arg);
else { console.error('usage: build <outDir> | score <answers.json>'); process.exit(2); }
