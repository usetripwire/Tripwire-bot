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

// Deepest pool first, but never trust a pool that claims more liquidity than the whole coin is worth
// (bad indexer data or a fake pool set up to look safe). Market cap comes from the busiest pool.
export function rankPairs(pairs) {
  const vol = p => (p.volume && p.volume.h24) || 0;
  const busiest = [...pairs].sort((a, b) => vol(b) - vol(a))[0];
  const ref = busiest ? busiest.marketCap || busiest.fdv || 0 : 0;
  for (const p of pairs) p._suspect = !!(ref && liq(p) > ref * 1.05 && pairs.length > 1);
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
