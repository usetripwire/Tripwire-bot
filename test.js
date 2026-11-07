// End-to-end test with a simulated Solana + DexScreener + X world. No network needed.
// Every address and number here is a test fixture, not real data.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-'));
Object.assign(process.env, {
  RPC_URL: 'https://rpc.test', SITE_URL: 'https://tripwirescan.com', DRY_RUN: 'false',
  X_API_KEY: 'k', X_API_SECRET: 's', X_ACCESS_TOKEN: 't', X_ACCESS_SECRET: 'ts', X_API_BASE: 'https://api.x.test',
  STATE_PATH: path.join(tmp, 'state.json'), ALLOWED_ORIGINS: 'https://tripwirescan.com'
});

/* ---------- fixture world ---------- */
const MINT = '7xKqTr1pWzTestMintHv9bRnZ3hJ5cD8fG2sA4Lpump';
const POOL = 'Poo1PairAddr', LOCKER = 'LockerVau1t', DEV = 'DevWa11et', FUNDX = 'FunderX';
const TOKENKEG = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SYSTEM = '11111111111111111111111111111111';
const P = 1e13; // 1% of supply (supply 1e15 raw, 6 decimals)
const T0 = Math.floor(Date.now() / 1000) - 3 * 86400;
const txs = new Map();
const sigLists = new Map(); // address -> [{signature, blockTime, err}] newest first
const holdings = new Map();
const pushSig = (addr, sig, time) => { if (!sigLists.has(addr)) sigLists.set(addr, []); sigLists.get(addr).push({ signature: sig, blockTime: time, err: null }); };

function mkTx({ sig, slot, time, payer, changes, inner = [], extraSigners = [] }) {
  const owners = [...new Set([payer, ...extraSigners, ...changes.map(c => c.owner)])];
  const keys = owners.map(o => ({ pubkey: o, signer: o === payer || extraSigners.includes(o), writable: true }));
  const pre = [], post = [];
  changes.forEach((c, i) => {
    pre.push({ accountIndex: i, mint: MINT, owner: c.owner, uiTokenAmount: { amount: String(c.pre), decimals: 6 } });
    post.push({ accountIndex: i, mint: MINT, owner: c.owner, uiTokenAmount: { amount: String(c.post), decimals: 6 } });
  });
  txs.set(sig, {
    slot, blockTime: time,
    meta: { err: null, fee: 5000, preBalances: [], postBalances: [], preTokenBalances: pre, postTokenBalances: post, innerInstructions: inner.length ? [{ index: 0, instructions: inner }] : [] },
    transaction: { signatures: [sig], message: { accountKeys: keys, instructions: [] } }
  });
}
const buy = (sig, slot, time, w, amt) => { amt = Math.round(amt); mkTx({ sig, slot, time, payer: w, changes: [{ owner: w, pre: 0, post: amt }, { owner: POOL, pre: 1e15, post: 1e15 - amt }] }); };
const sell = (sig, slot, time, w, amt) => { amt = Math.round(amt); mkTx({ sig, slot, time, payer: w, changes: [{ owner: w, pre: amt, post: 0 }, { owner: POOL, pre: 1e14, post: 1e14 + amt }] }); };

// Launch: dev creates + buys 3%, four bundle wallets buy 4% each in the same block
const mintLog = [];
mkTx({ sig: 'create', slot: 1000, time: T0, payer: DEV, changes: [{ owner: DEV, pre: 0, post: 3 * P }, { owner: POOL, pre: 0, post: 97 * P }], inner: [{ program: 'spl-token', parsed: { type: 'initializeMint2', info: { mint: MINT } } }] });
mintLog.push(['create', T0]);
['B1', 'B2', 'B3', 'B4'].forEach((w, i) => { buy('bundle' + i, 1000, T0, w, 4 * P); mintLog.push(['bundle' + i, T0]); });
buy('snipe1', 1001, T0 + 1, 'S1', 3 * P); mintLog.push(['snipe1', T0 + 1]);
buy('snipe2', 1002, T0 + 1, 'S2', 3 * P); mintLog.push(['snipe2', T0 + 1]);
['O1', 'O2', 'O3', 'O4', 'O5'].forEach((w, i) => { buy('org' + i, 1010 + i, T0 + 5 + i, w, 0.5 * P); mintLog.push(['org' + i, T0 + 5 + i]); });
sell('devsell', 1100, T0 + 60, DEV, 3 * P); mintLog.push(['devsell', T0 + 60]);
sell('s2sell', 1200, T0 + 120, 'S2', 3 * P); mintLog.push(['s2sell', T0 + 120]);
mintLog.reverse().forEach(([s, t]) => pushSig(MINT, s, t));

// Funding: B1,B2 funded by the dev; B3,B4 share a funder; snipers/organic funded separately
const funding = { [DEV]: 'FundDev', B1: DEV, B2: DEV, B3: FUNDX, B4: FUNDX, S1: 'F1', S2: 'F2', O1: 'FO1', O2: 'FO2', O3: 'FO3', O4: 'FO4', O5: 'FO5' };
for (const [w, f] of Object.entries(funding)) {
  const sig = 'fund_' + w;
  txs.set(sig, { slot: 900, blockTime: T0 - 11 * 86400, meta: { err: null, innerInstructions: [], preTokenBalances: [], postTokenBalances: [] }, transaction: { signatures: [sig], message: { accountKeys: [{ pubkey: f, signer: true }, { pubkey: w, signer: false }], instructions: [{ program: 'system', parsed: { type: 'transfer', info: { source: f, destination: w, lamports: 1e9 } } }] } } });
}
// Dev history: created 6 earlier tokens 10 days ago, plus this one
for (const [w] of Object.entries(funding)) if (w !== DEV) pushSig(w, 'fund_' + w, T0 - 11 * 86400);
pushSig(DEV, 'create', T0);
for (let i = 1; i <= 6; i++) {
  const sig = 'old' + i;
  txs.set(sig, { slot: 500 + i, blockTime: T0 - 10 * 86400, meta: { err: null, preTokenBalances: [], postTokenBalances: [], innerInstructions: [{ index: 0, instructions: [{ program: 'spl-token', parsed: { type: 'initializeMint2', info: { mint: 'OldMint' + i } } }] }] }, transaction: { signatures: [sig], message: { accountKeys: [{ pubkey: DEV, signer: true }], instructions: [] } } });
  pushSig(DEV, sig, T0 - 10 * 86400);
}
pushSig(DEV, 'fund_' + DEV, T0 - 11 * 86400);
const oldLiq = { OldMint1: 50000, OldMint2: 500 };

// Current holdings
Object.entries({ [DEV]: 0, B1: 4 * P, B2: 4 * P, B3: 4 * P, B4: 4 * P, S1: 3 * P, S2: 0, O1: 0.5 * P, O2: 0.5 * P, O3: 0.5 * P, O4: 0.5 * P, O5: 0.5 * P }).forEach(([w, a]) => holdings.set(w, a));

// Recent pool trading: W round-trips (wash), A buys every 30s (agent), plus organic
const pool = [];
const now = Math.floor(Date.now() / 1000);
const wTimes = [0, 7, 31, 40, 95, 102, 160, 171, 230, 251];
wTimes.forEach((dt, i) => { const s = 'w' + i; (i % 2 ? sell : buy)(s, 5000 + i * 3, now - 600 + dt, 'W', P); pool.push([s, now - 600 + dt]); });
for (let i = 0; i < 12; i++) { const s = 'a' + i; buy(s, 5100 + i, now - 500 + i * 30, 'A', 0.2 * P); pool.push([s, now - 500 + i * 30]); }
for (let i = 0; i < 18; i++) { const s = 'r' + i; buy(s, 5200 + i, now - 400 + i * 13 + (i % 3) * 5, 'R' + i, (0.1 + (i % 5) * 0.1) * P); pool.push([s, now - 400 + i * 13]); }
pool.sort((a, b) => b[1] - a[1]).forEach(([s, t]) => pushSig(POOL, s, t));
// W is a high-frequency wallet: 1000 txs in 2 hours
sigLists.set('W', Array.from({ length: 1000 }, (_, i) => ({ signature: 'wh' + i, blockTime: now - i * 7, err: null })));

const largest = [
  ['poolAcc', POOL, 40], ['lockAcc', LOCKER, 5], ['b1Acc', 'B1', 4], ['b2Acc', 'B2', 4], ['b3Acc', 'B3', 4], ['b4Acc', 'B4', 4],
  ['s1Acc', 'S1', 3], ['o1Acc', 'O1', 0.5], ['o2Acc', 'O2', 0.5], ['o3Acc', 'O3', 0.5], ['o4Acc', 'O4', 0.5], ['o5Acc', 'O5', 0.5]
];
const ownerOfAcc = Object.fromEntries(largest.map(([a, o]) => [a, o]));
const programOwned = { [POOL]: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', [LOCKER]: 'LockerProgram' };

/* ---------- mock fetch ---------- */
const realFetch = globalThis.fetch;
const posted = [];
let rpcCalls = 0;
function rpcAnswer({ method, params }) {
  rpcCalls++;
  const [a, opts] = params;
  switch (method) {
    case 'getAccountInfo':
      if (a !== MINT) return { value: { owner: SYSTEM, data: ['', 'base64'] } };
      return { value: { owner: TOKENKEG, data: { program: 'spl-token', parsed: { type: 'mint', info: { decimals: 6, supply: '1000000000000000', mintAuthority: null, freezeAuthority: null } } } } };
    case 'getTokenLargestAccounts':
      return { value: largest.map(([addr, , p]) => ({ address: addr, amount: String(p * P), decimals: 6 })) };
    case 'getMultipleAccounts':
      if (opts && opts.encoding === 'jsonParsed') return { value: a.map(acc => ({ data: { parsed: { info: { owner: ownerOfAcc[acc] } } } })) };
      return { value: a.map(o => (programOwned[o] ? { owner: programOwned[o], data: ['', 'base64'] } : { owner: SYSTEM, data: ['', 'base64'] })) };
    case 'getSignaturesForAddress': {
      const list = sigLists.get(a) || [];
      let start = 0;
      if (opts && opts.before) start = list.findIndex(s => s.signature === opts.before) + 1;
      return list.slice(start, start + ((opts && opts.limit) || 1000));
    }
    case 'getTransaction': return txs.get(a) || null;
    case 'getTokenAccountsByOwner': {
      const amt = holdings.get(a) || 0;
      return { value: amt ? [{ account: { data: { parsed: { info: { tokenAmount: { amount: String(amt) } } } } } }] : [] };
    }
    default: throw new Error('unmocked rpc ' + method);
  }
}
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.startsWith('http://127.0.0.1')) return realFetch(url, init);
  if (url === 'https://rpc.test') {
    const body = JSON.parse(init.body);
    if (Array.isArray(body)) return json(body.map(b => ({ jsonrpc: '2.0', id: b.id, result: rpcAnswer(b) })));
    return json({ jsonrpc: '2.0', id: body.id, result: rpcAnswer(body) });
  }
  if (url.startsWith('https://api.dexscreener.com/latest/dex/tokens/')) {
    return json({ pairs: [{ chainId: 'solana', dexId: 'pumpswap', url: 'https://dexscreener.com/solana/x', pairAddress: POOL, baseToken: { address: MINT, name: 'Test Coin', symbol: 'TEST' }, priceUsd: '0.0004521', liquidity: { usd: 48200 }, marketCap: 452000, volume: { h24: 912000 }, txns: { h24: { buys: 1820, sells: 1404 } }, pairCreatedAt: T0 * 1000, info: {} }] });
  }
  if (url.startsWith('https://api.dexscreener.com/tokens/v1/solana/')) {
    const mints = url.split('/').pop().split(',');
    return json(mints.filter(m => oldLiq[m]).map(m => ({ chainId: 'solana', baseToken: { address: m }, liquidity: { usd: oldLiq[m] } })));
  }
  if (url.startsWith('https://api.x.test/2/users/me')) return json({ data: { id: '999', username: 'TripwireScan' } });
  if (url.startsWith('https://api.x.test/2/tweets')) { posted.push(JSON.parse(init.body)); return json({ data: { id: 'reply' + posted.length } }); }
  throw new Error('unmocked fetch ' + url);
};

/* ---------- tests ---------- */
const results = [];
const test = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name + ' -> ' + e.message]); }
};

const { oauthHeader } = await import('./x.js');
const { parseTrades } = await import('./chain.js');
const { scan } = await import('./scan.js');
const { replyText, xLength } = await import('./format.js');
const { interpret, handleMention, loadState } = await import('./bot.js');
const { createServer } = await import('./server.js');

await test('OAuth 1.0a signature matches X\'s published example', () => {
  const h = oauthHeader('POST', 'https://api.twitter.com/1.1/statuses/update.json?include_entities=true',
    { status: 'Hello Ladies + Gentlemen, a signed OAuth request!' },
    { apiKey: 'xvz1evFS4wEEPTGEFPHBog', apiSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw', accessToken: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb', accessSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE' },
    'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg', '1318622958');
  assert.match(h, /oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"/);
});

await test('trade parser ignores the pool and finds the signer', () => {
  const t = parseTrades(txs.get('bundle0'), MINT);
  assert.equal(t.length, 1); assert.equal(t[0].wallet, 'B1'); assert.equal(t[0].side, 'buy');
});

let result;
await test('full scan completes', async () => { result = await scan(MINT); assert.equal(result.checks.length, 8); });
const get = k => result.checks.find(c => c.key === k);
await test('Bundle trips: dev + 4 linked wallets, 16% still held', () => {
  const c = get('bundle'); assert.equal(c.tripped, true, c.items.join(' | '));
  assert.match(c.items.join(' '), /bought 19\.0%/); assert.match(c.items.join(' '), /still hold 16\.0%/);
  assert.match(c.items.join(' '), /2 of them were funded directly by the deployer/);
});
await test('Sniper: 2 snipers, 3% still held -> clear', () => {
  const c = get('sniper'); assert.equal(c.tripped, false, c.items.join(' | ')); assert.match(c.items.join(' '), /2 wallets sniped 6\.0%/);
});
await test('Dev trips: 5 of 6 past launches dead', () => {
  const c = get('dev'); assert.equal(c.tripped, true, c.items.join(' | ')); assert.match(c.items.join(' '), /5 of 6 older ones are dead/);
});
await test('Wash trips on the round-tripping wallet', () => { const c = get('wash'); assert.equal(c.tripped, true, c.items.join(' | ')); });
await test('Agent trips (steady 30s buyer + 1000-tx/day wallet)', () => { const c = get('agent'); assert.equal(c.tripped, true, c.items.join(' | ')); });
await test('Exit clear at $48K liquidity', () => assert.equal(get('exit').tripped, false));
await test('Authority clear when revoked', () => assert.equal(get('authority').tripped, false));
await test('Holders excludes pool + locker (top 10 = 21.5%)', () => {
  const c = get('holders'); assert.equal(c.tripped, false); assert.match(c.items.join(' '), /Top 10 wallets hold 21\.5%/); assert.match(c.items.join(' '), /5\.0% is held by programs/);
});
await test('Second scan is served from cache (no new RPC calls)', async () => { const before = rpcCalls; await scan(MINT); assert.equal(rpcCalls, before); });

let reply;
await test('Reply fits in 280 characters', () => { reply = replyText(result); assert.ok(xLength(reply) <= 280, String(xLength(reply))); assert.match(reply, /TRIPPED 4 of 8/); assert.match(reply, /tripwirescan\.com\/\?ca=/); });

const ctx = { botId: '999', botUsername: 'TripwireScan' };
await test('Bot: CA in the post -> scan', () => assert.equal(interpret({ text: '@TripwireScan ' + MINT }, {}, '999', 'TripwireScan').action, 'scan'));
await test('Bot: tagged under a post with a CA -> scans the parent', () => {
  const r = interpret({ text: '@alice @TripwireScan', referenced_tweets: [{ type: 'replied_to', id: 'p1' }] }, { tweets: [{ id: 'p1', author_id: '5', text: 'aping ' + MINT }] }, '999', 'TripwireScan');
  assert.equal(r.action, 'scan'); assert.equal(r.mints[0], MINT);
});
await test('Bot: CA inside a dexscreener link -> scan', () => assert.equal(interpret({ text: '@TripwireScan look', entities: { urls: [{ expanded_url: 'https://dexscreener.com/solana/' + MINT }] } }, {}, '999', 'TripwireScan').action, 'scan'));
await test('Bot: chit-chat under its own reply -> ignored', () => {
  const r = interpret({ text: '@TripwireScan @bob lol thanks', in_reply_to_user_id: '999', referenced_tweets: [{ type: 'replied_to', id: 'b1' }] }, { tweets: [{ id: 'b1', author_id: '999', text: '$TEST: TRIPPED ' + MINT }] }, '999', 'TripwireScan');
  assert.equal(r.action, 'ignore');
});
await test('Bot: watch command -> Phase 2 notice', () => assert.equal(interpret({ text: '@TripwireScan watch ' + MINT }, {}, '999', 'TripwireScan').action, 'watch'));

await test('Bot posts the scan as a reply to the mention', async () => {
  const state = loadState();
  await handleMention({ id: '100', author_id: '42', text: '@TripwireScan ' + MINT }, {}, ctx, state);
  assert.equal(posted.length, 1); assert.equal(posted[0].reply.in_reply_to_tweet_id, '100'); assert.match(posted[0].text, /TRIPPED/);
});
await test('Bot never answers the same mention twice', async () => {
  const state = loadState(); state.processed.push('100');
  await handleMention({ id: '100', author_id: '42', text: '@TripwireScan ' + MINT }, {}, ctx, state);
  assert.equal(posted.length, 1);
});
await test('Bot rate-limits one user to 5 scans an hour', async () => {
  const state = loadState(); const n = posted.length;
  for (let i = 0; i < 7; i++) await handleMention({ id: 'r' + i, author_id: '77', text: '@TripwireScan ' + MINT }, {}, ctx, state);
  assert.equal(posted.length - n, 5);
});
await test('Bot replies "not a mint" for a wallet address', async () => {
  const state = loadState(); const n = posted.length;
  await handleMention({ id: '200', author_id: '43', text: '@TripwireScan 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' }, {}, ctx, state);
  assert.equal(posted.length - n, 1); assert.match(posted[posted.length - 1].text, /isn't a Solana token mint/);
});

await test('API returns the full scan with CORS for the site', async () => {
  const server = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/api/scan?ca=${MINT}`, { headers: { origin: 'https://tripwirescan.com' } });
  const body = await res.json();
  assert.equal(res.status, 200); assert.equal(body.checks.length, 8);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://tripwirescan.com');
  const bad = await fetch(`http://127.0.0.1:${port}/api/scan?ca=nope`);
  assert.equal(bad.status, 400);
  server.close();
});

console.log('\nSample X reply:\n' + reply + `\n(${xLength(reply)} of 280 characters)\n`);
for (const [s, n] of results) console.log(s, n);
const failed = results.filter(r => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
