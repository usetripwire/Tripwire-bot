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
  return (j.pairs || [])
    .filter(p => p.chainId === 'solana' && p.baseToken && p.baseToken.address === mint)
    .sort((a, b) => liq(b) - liq(a));
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
