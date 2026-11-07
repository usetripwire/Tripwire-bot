// Self-test: scan a random mix of real Solana tokens and log every wire's result.
// Turn on with SELFTEST_COUNT=10 (runs once, shortly after the server starts).
import { scan } from './scan.js';
import { stats } from './rpc.js';
import { log } from './util.js';

const SOURCES = [
  ['new profiles', 'https://api.dexscreener.com/token-profiles/latest/v1'],
  ['latest boosts', 'https://api.dexscreener.com/token-boosts/latest/v1'],
  ['top boosts', 'https://api.dexscreener.com/token-boosts/top/v1']
];

async function pickTokens(n) {
  const pools = [];
  for (const [label, url] of SOURCES) {
    try {
      const res = await fetch(url);
      const j = await res.json();
      const list = (Array.isArray(j) ? j : []).filter(t => t.chainId === 'solana' && t.tokenAddress).map(t => t.tokenAddress);
      pools.push({ label, list: [...new Set(list)].sort(() => Math.random() - 0.5) });
    } catch (e) { log('selftest source failed', label, e.message); }
  }
  const picked = [];
  // Round-robin across sources so we get fresh launches and bigger coins
  while (picked.length < n && pools.some(p => p.list.length)) {
    for (const p of pools) {
      const m = p.list.shift();
      if (m && !picked.some(x => x.mint === m)) picked.push({ mint: m, from: p.label });
      if (picked.length >= n) break;
    }
  }
  return picked;
}

export async function runSelfTest(n) {
  const tokens = await pickTokens(n);
  log(`SELFTEST start: ${tokens.length} tokens`);
  const summary = [];
  for (const [i, t] of tokens.entries()) {
    const callsBefore = stats.calls;
    try {
      const r = await scan(t.mint);
      const ran = r.checks.filter(c => !c.na);
      const head = `SELFTEST ${i + 1}/${tokens.length} ${r.token.symbol || '?'} ${t.mint} [${t.from}] dex=${r.pair ? r.pair.dexId : 'none'} liq=${r.pair && r.pair.liquidity ? Math.round(r.pair.liquidity.usd || 0) : 0} took=${(r.tookMs / 1000).toFixed(0)}s calls=${stats.calls - callsBefore} tripped=${ran.filter(c => c.tripped).length}/${ran.length}`;
      log(head);
      for (const c of r.checks) log(`  ${c.na ? 'N/A ' : c.tripped ? 'TRIP' : 'OK  '} ${c.key}: ${c.items.join(' | ')}`);
      summary.push(`${r.token.symbol || t.mint.slice(0, 6)}: ${r.checks.filter(c => c.na).map(c => c.key).join(',') || 'all ran'}`);
    } catch (e) {
      log(`SELFTEST ${i + 1}/${tokens.length} ${t.mint} [${t.from}] ERROR ${e.code || ''} ${e.message}`);
      summary.push(`${t.mint.slice(0, 6)}: error ${e.message}`);
    }
  }
  log('SELFTEST done. n/a by token -> ' + summary.join(' ; '));
}
