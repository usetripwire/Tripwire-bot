// Solana JSON-RPC client. Paces requests to stay under the plan's rate limit,
// batches when the provider allows it, and falls back to single calls when it doesn't.
import { cfg } from './config.js';
import { createLimiter, sleep, log } from './util.js';

const limit = createLimiter(cfg.scan.rpcConcurrency);
let nextId = 1;
let nextAt = 0;
let batchOk = cfg.scan.rpcBatch;
export const stats = { requests: 0, calls: 0, throttled: 0 };
const isThrottle = e => !!e && (e.code === 429 || e.code === -32429 || /rate|limit|too many/i.test(e.message || ''));

// Reserve `items` request slots at RPC_RPS per second; returns how long to wait.
function reserve(items) {
  const now = Date.now();
  const start = Math.max(now, nextAt);
  nextAt = start + (items * 1000) / Math.max(1, cfg.scan.rpcRps);
  return start - now;
}

async function post(body, items) {
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(reserve(items));
    const res = await limit(() => {
      stats.requests++;
      return fetch(cfg.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    });
    if (res.status === 429 || res.status >= 500) {
      stats.throttled++;
      await sleep(Math.min(20000, 1000 * 2 ** attempt));
      continue;
    }
    const j = await res.json().catch(() => null);
    if (!res.ok && !(j && j.error)) throw new Error('rpc_http_' + res.status);
    if (j && !Array.isArray(j) && isThrottle(j.error)) { stats.throttled++; await sleep(Math.min(20000, 1000 * 2 ** attempt)); continue; }
    return j;
  }
  throw new Error('rpc_rate_limited');
}

export async function rpc(method, params) {
  stats.calls++;
  const j = await post({ jsonrpc: '2.0', id: nextId++, method, params }, 1);
  if (!j) throw new Error('rpc_bad_response');
  if (j.error) throw new Error(`rpc_error ${method}: ${j.error.message}`);
  return j.result;
}

const one = createLimiter(cfg.scan.rpcConcurrency);
async function singles(calls) {
  return Promise.all(calls.map(([m, p]) => one(() => rpc(m, p).catch(() => null))));
}

// calls: [[method, params], ...] -> results in the same order (null for failed items)
export async function rpcBatch(calls, chunk = cfg.scan.batchSize) {
  if (!calls.length) return [];
  if (!batchOk) return singles(calls);
  const out = new Array(calls.length).fill(null);
  for (let start = 0; start < calls.length; start += chunk) {
    const slice = calls.slice(start, start + chunk);
    if (!batchOk) { (await singles(slice)).forEach((r, k) => { out[start + k] = r; }); continue; }
    stats.calls += slice.length;
    const j = await post(slice.map(([method, params], k) => ({ jsonrpc: '2.0', id: start + k, method, params })), slice.length);
    if (!Array.isArray(j)) {
      // Provider rejected the batch (common on free plans): switch to single calls for good.
      batchOk = false;
      log('RPC batch requests rejected' + (j && j.error ? ` (${j.error.message})` : '') + '; using single requests from now on.');
      (await singles(slice)).forEach((r, k) => { out[start + k] = r; });
      continue;
    }
    const retry = [];
    for (const r of j) {
      if (!r || r.id == null) continue;
      if (!r.error) out[r.id] = r.result;
      else if (isThrottle(r.error)) retry.push(r.id);
    }
    // Items the provider turned away for rate limits get retried one by one, slower.
    if (retry.length) {
      stats.throttled += retry.length;
      await sleep(1000);
      (await singles(retry.map(id => calls[id]))).forEach((res, k) => { out[retry[k]] = res; });
    }
  }
  return out;
}

export const sigsFor = (address, opts = {}) =>
  rpc('getSignaturesForAddress', [address, { limit: opts.limit || 1000, before: opts.before, commitment: 'confirmed' }]);

export const getTxs = sigs =>
  rpcBatch(sigs.map(s => ['getTransaction', [s, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]]));
