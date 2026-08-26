// Polls the staging busy gate until it reports idle, then exits 0.
// Exits 2 if it never frees up within the window, so a timeout is
// distinguishable from a real all-clear.
const { ch } = require('../lib/chTime');

const URL = 'https://staging.magicalstory.ch/api/health/busy';
const EVERY_MS = 60_000;
const MAX_MIN = 90;

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const deadline = Date.now() + MAX_MIN * 60_000;
  let n = 0;
  while (Date.now() < deadline) {
    n++;
    let body;
    try {
      body = await (await fetch(URL)).json();
    } catch (e) {
      console.log(`${ch(new Date())}  poll ${n}: unreachable (${e.message})`);
      await sleep(EVERY_MS);
      continue;
    }
    if (!body.busy) {
      console.log(`${ch(new Date())}  poll ${n}: IDLE — commit ${body.commit}`);
      // process.exit() with a fetch handle still settling trips a libuv
      // assertion on Windows (exit 127, after the answer was already printed).
      process.exitCode = 0;
      return;
    }
    console.log(`${ch(new Date())}  poll ${n}: busy — ${(body.reasons || []).join('; ')}`);
    await sleep(EVERY_MS);
  }
  console.log(`${ch(new Date())}  gave up after ${MAX_MIN} min — still busy`);
  process.exit(2);
})();
