/**
 * A deterministic stand-in for the Jev decision model (jevAudit.callJev) in
 * unit tests: every noul answers 0.5 unless `noul` says otherwise, every
 * choice picks its first option with a peaked probability table. Records each
 * call so a test can compare two callers' Jev traffic.
 */
export function makeJevStub({ noul = (_q: string, _s: string) => 0.5 }: { noul?: (q: string, s: string) => number } = {}) {
  const calls: any[] = [];
  const impl = async ({ state, questions }: any) => {
    calls.push({ state, questions });
    const answers: any = {};
    for (const [id, q] of Object.entries<any>(questions)) {
      if (q.type === 'noul') answers[id] = { noul: noul(q.instructions, state) };
      else {
        const keys = Object.keys(q.criteria || {});
        answers[id] = { choice: keys[0], probabilities: Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 0.9 : 0.1 / Math.max(1, keys.length - 1)])) };
      }
    }
    return { answers, cost: 0, model: 'stub', usage: {} };
  };
  return { impl, calls };
}
