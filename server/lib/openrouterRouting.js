/**
 * Pick FAST OpenRouter upstreams, from live data.
 *
 * WHY: OpenRouter serves one model from many providers and, left alone, balances
 * on price. For deepseek-v4-pro the published 30-minute p50 throughput spans
 * 6 tok/s (DigitalOcean) to 117 tok/s (BaseTen) — an 18x spread that decides
 * whether a 15k-token review takes 2 minutes or 42. A staging run drew the slow
 * end and burned 20 minutes on one call.
 *
 * `provider: { sort: 'throughput' }` is only advisory over OpenRouter's own
 * ranking and observably drifts between calls. `provider: { order: [...] }` is
 * the lever that actually selects — but a hand-written order goes stale as
 * provider performance changes, which is exactly the failure we are fixing.
 *
 * So the order is built from the live endpoints API and cached briefly. Speed is
 * ranked first and price is deliberately not a criterion: the fast tier costs
 * about 4x the cheapest (~$0.10 vs ~$0.024 per review) and that is worth paying
 * to turn 42 minutes into 2.
 *
 * Failure is non-fatal everywhere: any error returns null and the caller falls
 * back to `sort: 'throughput'`, which is still better than nothing.
 */

const { log } = require('../utils/logger');

const ENDPOINTS_URL = 'https://openrouter.ai/api/v1/models/{model}/endpoints';
const CACHE_TTL_MS = 15 * 60 * 1000;   // provider stats are 30-min windows
const MIN_UPTIME = 95;                 // %, last 30 min
const TOP_N = 6;                       // enough fallbacks to survive an outage

const cache = new Map(); // modelId -> { at, order }

/**
 * Ordered provider names for a model, fastest first.
 * @returns {Promise<string[]|null>} null when unavailable (caller falls back)
 */
async function fastProviderOrder(modelId) {
  const hit = cache.get(modelId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.order;

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch(ENDPOINTS_URL.replace('{model}', modelId), {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();

    const ranked = (body.data?.endpoints || [])
      .map(e => ({
        name: e.provider_name,
        tps: e.throughput_last_30m?.p50 ?? 0,
        uptime: e.uptime_last_30m ?? 100,
      }))
      // A provider that is fast but flapping costs more than it saves: a failed
      // call is retried from scratch, three times, at five minutes a go.
      .filter(p => p.name && p.uptime >= MIN_UPTIME && p.tps > 0)
      .sort((a, b) => b.tps - a.tps)
      .slice(0, TOP_N);

    if (ranked.length === 0) throw new Error('no endpoint met the uptime/throughput floor');

    const order = ranked.map(p => p.name);
    cache.set(modelId, { at: Date.now(), order });
    log.debug(`🚀 [OPENROUTER] ${modelId} routing order: ${ranked.map(p => `${p.name} ${p.tps}tok/s`).join(' > ')}`);
    return order;
  } catch (err) {
    // Never let a routing lookup break the actual call.
    log.debug(`[OPENROUTER] provider ranking unavailable for ${modelId} (${err.message}) — falling back to sort:throughput`);
    cache.set(modelId, { at: Date.now(), order: null });
    return null;
  }
}

module.exports = { fastProviderOrder };
