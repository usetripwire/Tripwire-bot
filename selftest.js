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

// Older coins (months to years old) so every round also covers big, busy histories
const OLD = [
  ['BONK', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'],
  ['WIF', 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm'],
  ['POPCAT', '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr'],
  ['JUP', 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'],
  ['RAY', '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R'],
  ['SAMO', '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'],
  ['MEW', 'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5'],
  ['PNUT', '2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump'],
  ['GOAT', 'CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump'],
  ['FARTCOIN', '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump'],
  ['MYRO', 'HhJpBhRRn4g56VsyLuT8DL5Bv31HkXqsrahTTUCZeZg4'],
  ['ORCA', 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE']
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
  const oldN = Math.max(0, Number(process.env.SELFTEST_OLD || 5));
  const only = (process.env.SELFTEST_OLD_LIST || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
  const old = (only.length ? OLD.filter(([sym]) => only.includes(sym)) : [...OLD].sort(() => Math.random() - 0.5)).slice(0, oldN);
  for (const [sym, m] of old) if (!picked.some(x => x.mint === m)) picked.push({ mint: m, from: 'old ' + sym });
  return picked;
}

async function scanOne(t, i, total, summary) {
  const callsBefore = stats.calls;
  try {
    const r = await scan(t.mint, { background: true });
    const ran = r.checks.filter(c => !c.na);
    log(`SELFTEST ${i + 1}/${total} ${r.token.symbol || '?'} ${t.mint} [${t.from}] dex=${r.pair ? r.pair.dexId : 'none'} liq=${r.pair && r.pair.liquidity ? Math.round(r.pair.liquidity.usd || 0) : 0} took=${(r.tookMs / 1000).toFixed(0)}s calls=${stats.calls - callsBefore} tripped=${ran.filter(c => c.tripped).length}/${ran.length}`);
    for (const c of r.checks) log(`  ${c.na ? 'N/A ' : c.tripped ? 'TRIP' : 'OK  '} ${c.key}: ${c.items.join(' | ')}`);
    summary.push(`${r.token.symbol || t.mint.slice(0, 6)}: ${r.checks.filter(c => c.na).map(c => c.key).join(',') || 'all ran'} (${(r.tookMs / 1000).toFixed(0)}s)`);
  } catch (e) {
    log(`SELFTEST ${i + 1}/${total} ${t.mint} [${t.from}] ERROR ${e.code || ''} ${e.message}`);
    summary.push(`${t.mint.slice(0, 6)}: error ${e.message}`);
  }
}

// SELFTEST_PARALLEL=n scans n coins at the same moment, like a rush of visitors.
export async function runSelfTest(n) {
  const tokens = await pickTokens(n);
  const par = Math.max(1, Number(process.env.SELFTEST_PARALLEL || 1));
  log(`SELFTEST start: ${tokens.length} tokens, ${par} at a time`);
  const summary = [];
  const t0 = Date.now(), th0 = stats.throttled;
  for (let i = 0; i < tokens.length; i += par) {
    await Promise.all(tokens.slice(i, i + par).map((t, j) => scanOne(t, i + j, tokens.length, summary)));
  }
  log(`SELFTEST done in ${((Date.now() - t0) / 1000).toFixed(0)}s, throttled ${stats.throttled - th0}. n/a by token -> ` + summary.join(' ; '));
}
