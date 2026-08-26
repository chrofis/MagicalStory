// Waits until staging reports a commit DIFFERENT from the one given, and then
// stays on that commit for two consecutive polls (so we do not start a run
// during a rolling restart). Exits 0 with the settled SHA on stdout.
const { ch } = require('../lib/chTime');

const URL = 'https://staging.magicalstory.ch/api/health';
const WAS = process.argv[2];
const EVERY_MS = 30_000;
const MAX_MIN = 25;

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const deadline = Date.now() + MAX_MIN * 60_000;
  let lastSeen = null;
  let stable = 0;
  let n = 0;
  let result = 2;
  while (Date.now() < deadline) {
    n++;
    let commit = null;
    try {
      commit = (await (await fetch(URL)).json()).commit;
    } catch (e) {
      console.log(`${ch(new Date())}  poll ${n}: unreachable (${e.message}) — restart in progress`);
      stable = 0;
      await sleep(EVERY_MS);
      continue;
    }
    if (commit && commit !== WAS) {
      stable = commit === lastSeen ? stable + 1 : 1;
      lastSeen = commit;
      console.log(`${ch(new Date())}  poll ${n}: commit ${commit} (stable x${stable})`);
      if (stable >= 2) { console.log(`SETTLED ${commit}`); result = 0; break; }
    } else {
      console.log(`${ch(new Date())}  poll ${n}: still ${commit} — deploy not landed`);
      stable = 0;
    }
    await sleep(EVERY_MS);
  }
  if (result !== 0) console.log(`${ch(new Date())}  gave up after ${MAX_MIN} min`);
  process.exitCode = result;   // let the event loop drain; process.exit() trips a libuv assert on Windows
})();
