// Solana JSON-RPC client with batching, a concurrency cap and retry on rate limits.
import { cfg } from './config.js';
import { createLimiter, sleep } from './util.js';

const limit = createLimiter(cfg.scan.rpcConcurrency);
let nextId = 1;
export const stats = { requests: 0, calls: 0 };

async function post(body) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await limit(() => {
      stats.requests++;
      return fetch(cfg.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    });
    if (res.status === 429 || res.status >= 500) { await sleep(400 * 2 ** attempt); continue; }
    if (!res.ok) throw new Error('rpc_http_' + res.status);
    return res.json();
  }
  throw new Error('rpc_rate_limited');
}

export async function rpc(method, params) {
  stats.calls++;
  const j = await post({ jsonrpc: '2.0', id: nextId++, method, params });
  if (j.error) throw new Error(`rpc_error ${method}: ${j.error.message}`);
  return j.result;
}

// calls: [[method, params], ...] -> results in the same order (null for failed items)
export async function rpcBatch(calls, chunk = 25) {
  const out = new Array(calls.length).fill(null);
  if (!calls.length) return out;
  stats.calls += calls.length;
  const starts = [];
  for (let i = 0; i < calls.length; i += chunk) starts.push(i);
  await Promise.all(starts.map(async start => {
    const body = calls.slice(start, start + chunk).map(([method, params], k) => ({ jsonrpc: '2.0', id: start + k, method, params }));
    const j = await post(body);
    for (const r of Array.isArray(j) ? j : [j]) if (r && r.id != null && !r.error) out[r.id] = r.result;
  }));
  return out;
}

export const sigsFor = (address, opts = {}) =>
  rpc('getSignaturesForAddress', [address, { limit: opts.limit || 1000, before: opts.before, commitment: 'confirmed' }]);

export const getTxs = sigs =>
  rpcBatch(sigs.map(s => ['getTransaction', [s, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]]), 20);
