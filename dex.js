import { log } from './util.js';
// DexScreener public API (no key needed).
const BASE = 'https://api.dexscreener.com';

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('dex_http_' + res.status);
  return res.json();
}

const liq = p => (p && p.liquidity && p.liquidity.usd) || 0;

// All Solana pools where this mint is the base token, deepest first.
export async function pairsFor(mint) {
  const j = await get(`${BASE}/latest/dex/tokens/${mint}`);
  const pairs = (j.pairs || []).filter(p => p.chainId === 'solana' && p.baseToken && p.baseToken.address === mint);
  return rankPairs(pairs);
}

// Deepest pool first, but never trust a pool that claims more liquidity than it could hold by its own
// price (a pool is two sides, so at most about 2x the market cap), or whose price puts the coin at 20x+ the market cap every other pool shows
// (bad indexer data or a fake pool set up to look safe).
export function rankPairs(pairs) {
  const mc = p => p.marketCap || p.fdv || 0;
  const median = xs => { const a = xs.filter(x => x > 0).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; };
  for (const p of pairs) {
    const own = mc(p);
    const others = median(pairs.filter(q => q !== p).map(mc));
    p._suspect = pairs.length > 1 && liq(p) > 0 && ((own > 0 && liq(p) > own * 2.05) || (others > 0 && own > others * 20 && liq(p) > others));
  }
  const bad = pairs.filter(p => p._suspect);
  if (bad.length) log('ignored pools', JSON.stringify(bad.map(p => ({ dex: p.dexId, pool: p.pairAddress, liq: liq(p), mcap: mc(p), quote: p.quoteToken && p.quoteToken.symbol }))));
  return pairs.sort((a, b) => (a._suspect - b._suspect) || (liq(b) - liq(a)));
}


// Deepest-pool liquidity for many mints (30 per request). Returns Map mint -> liquidity USD.
export async function liquidityFor(mints) {
  const out = new Map();
  for (let i = 0; i < mints.length; i += 30) {
    const batch = mints.slice(i, i + 30);
    try {
      const j = await get(`${BASE}/tokens/v1/solana/${batch.join(',')}`);
      for (const p of Array.isArray(j) ? j : j.pairs || []) {
        const m = p.baseToken && p.baseToken.address;
        if (m && batch.includes(m)) out.set(m, Math.max(out.get(m) || 0, liq(p)));
      }
    } catch { /* leave missing: treated as unknown */ }
  }
  return out;
}
