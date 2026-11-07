// End-to-end test with a simulated Solana + DexScreener world. No network needed.
// Every address and number here is a test fixture, not real data.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-'));
Object.assign(process.env, {
  RPC_URL: 'https://rpc.test', MINT_SIG_PAGES: '1', MINT_SIG_PAGES_MAX: '2', RPC_RPS: '100000', TRIP_MINT: 'TripMint111', RADAR_WATCH_ACCOUNT: 'MigrAcct', RADAR_SCAN_DELAY_SEC: '0', RADAR_MIN_LIQ_USD: '10000', RADAR_PUBLIC_DELAY_MIN: '15', RADAR_STORE_PATH: path.join(tmp, 'radar.json'), SESSION_SECRET: 'test-secret', SITE_URL: 'https://tripwirescan.com',  ALLOWED_ORIGINS: 'https://tripwirescan.com'
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
const tripBal = new Map();
const blocks = new Map();
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
    case 'getBlock': return blocks.get(a) || null;
    case 'getTokenAccountsByOwner': {
      if (opts && opts.mint === 'TripMint111') {
        const ui = tripBal.get(a) || 0;
        return { value: ui ? [{ account: { data: { parsed: { info: { tokenAmount: { amount: String(ui * 1e6), uiAmountString: String(ui) } } } } } }] : [] };
      }
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
    if (Array.isArray(body) && globalThis.throttleFirst) {
      const n = globalThis.throttleFirst; globalThis.throttleFirst = 0;
      return json(body.map((b, i) => i < n ? { jsonrpc: '2.0', id: b.id, error: { code: -32429, message: 'rate limit exceeded' } } : { jsonrpc: '2.0', id: b.id, result: rpcAnswer(b) }));
    }
    if (Array.isArray(body) && globalThis.rejectBatch) return json({ jsonrpc: '2.0', id: null, error: { code: -32403, message: 'Batch requests are only available for paid plans' } }, 403);
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
  throw new Error('unmocked fetch ' + url);
};

/* ---------- tests ---------- */
const results = [];
const test = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name + ' -> ' + e.message]); }
};

const { parseTrades } = await import('./chain.js');
const { scan } = await import('./scan.js');
const { createServer } = await import('./server.js');

await test('trade parser ignores the pool and finds the signer', () => {
  const t = parseTrades(txs.get('bundle0'), MINT);
  assert.equal(t.length, 1); assert.equal(t[0].wallet, 'B1'); assert.equal(t[0].side, 'buy');
});

let result;
await test('full scan completes', async () => { result = await scan(MINT); assert.equal(result.checks.length, 8); });
const get = k => result.checks.find(c => c.key === k);
await test('Bundle trips: dev + 4 linked wallets, 16% still held', () => {
  const c = get('bundle'); assert.equal(c.tripped, true, c.items.join(' | '));
  assert.match(c.items.join(' '), /held up to 19\.0%/); assert.match(c.items.join(' '), /still hold 16\.0%/);
  assert.match(c.items.join(' '), /2 of them were funded directly by the deployer/);
});
await test('Sniper: 2 snipers, 3% still held -> clear', () => {
  const c = get('sniper'); assert.equal(c.tripped, false, c.items.join(' | ')); assert.match(c.items.join(' '), /2 wallets sniped 6\.0%/);
});
await test('Dev trips: 5 of 6 past launches dead', () => {
  const c = get('dev'); assert.equal(c.tripped, true, c.items.join(' | ')); assert.match(c.items.join(' '), /5 of the 6 older than a day are dead/);
});
await test('Wash trips on the round-tripping wallet', () => { const c = get('wash'); assert.equal(c.tripped, true, c.items.join(' | ')); });
await test('Agent trips (steady 30s buyer + 1000-tx/day wallet)', () => { const c = get('agent'); assert.equal(c.tripped, true, c.items.join(' | ')); });
await test('Exit clear at $48K liquidity', () => assert.equal(get('exit').tripped, false));
await test('Authority clear when revoked', () => assert.equal(get('authority').tripped, false));
await test('Holders excludes pool + locker (top 10 = 21.5%)', () => {
  const c = get('holders'); assert.equal(c.tripped, false); assert.match(c.items.join(' '), /Top 10 wallets hold 21\.5%/); assert.match(c.items.join(' '), /5\.0% is held by programs/);
});
await test('Second scan is served from cache (no new RPC calls)', async () => { const before = rpcCalls; await scan(MINT); assert.equal(rpcCalls, before); });

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


/* ---------- Radar + wallet sign-in ---------- */
const crypto = await import('node:crypto');
const { b58encode, b58decode, issueNonce, createSession } = await import('./auth.js');
const radar = await import('./radar.js');
function newWallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { address: b58encode(raw), sign: msg => crypto.sign(null, Buffer.from(msg, 'utf8'), privateKey).toString('base64') };
}
const whale = newWallet(), minnow = newWallet();
tripBal.set(whale.address, 150000);
tripBal.set(minnow.address, 50000);

await test('base58 encode/decode round-trips', () => {
  const buf = crypto.randomBytes(32);
  assert.deepEqual(b58decode(b58encode(buf)), buf);
});
let whaleSession;
await test('Holder with 150k $TRIP signs in and unlocks Radar', async () => {
  const { nonce, message } = issueNonce(whale.address);
  whaleSession = await createSession({ wallet: whale.address, nonce, signature: whale.sign(message) });
  assert.equal(whaleSession.holder, true); assert.equal(whaleSession.balance, 150000); assert.ok(whaleSession.token);
});
await test('Wallet with 50k $TRIP signs in but stays locked', async () => {
  const { nonce, message } = issueNonce(minnow.address);
  const s = await createSession({ wallet: minnow.address, nonce, signature: minnow.sign(message) });
  assert.equal(s.holder, false);
});
await test('A forged signature is rejected', async () => {
  const { nonce, message } = issueNonce(whale.address);
  await assert.rejects(createSession({ wallet: whale.address, nonce, signature: minnow.sign(message) }), e => e.code === 'bad_signature');
});
await test('A sign-in message can only be used once', async () => {
  const { nonce, message } = issueNonce(whale.address);
  const sig = whale.sign(message);
  await createSession({ wallet: whale.address, nonce, signature: sig });
  await assert.rejects(createSession({ wallet: whale.address, nonce, signature: sig }), e => e.code === 'expired');
});

// Graduation transaction on the migration account
txs.set('migrate1', { slot: 9000, blockTime: now, meta: { err: null, logMessages: ['Program log: Instruction: Migrate'],
  preTokenBalances: [], postTokenBalances: [{ mint: MINT, owner: POOL, uiTokenAmount: { amount: '1' } }, { mint: 'So11111111111111111111111111111111111111112', owner: POOL, uiTokenAmount: { amount: '1' } }, { mint: 'LpMint111', owner: 'X', uiTokenAmount: { amount: '1' } }] },
  transaction: { signatures: ['migrate1'], message: { accountKeys: [{ pubkey: 'MigrAcct', signer: true }], instructions: [] } } });
sigLists.set('MigrAcct', [{ signature: 'older', blockTime: now - 100, err: null }]);

await test('Radar starts from "now" on first run (no backlog)', async () => {
  radar._reset();
  assert.equal(await radar.pollOnce(), 0);
});
await test('Radar spots a graduation and queues the coin', async () => {
  sigLists.get('MigrAcct').unshift({ signature: 'migrate1', blockTime: now, err: null });
  assert.equal(await radar.pollOnce(), 2); // the coin + its LP mint
});
await test('Radar scans the coin and skips the LP mint (no pool)', async () => {
  await radar.processQueue();
  const live = radar.feed({ holder: true });
  assert.equal(live.mode, 'live'); assert.equal(live.entries.length, 1);
  assert.equal(live.entries[0].mint, MINT); assert.equal(live.entries[0].trips, 4); assert.equal(live.entries[0].wires.length, 8);
});
await test('Non-holders get a delayed preview with only clean coins', () => {
  const p = radar.feed({ holder: false });
  assert.equal(p.mode, 'preview'); assert.equal(p.entries.length, 0); assert.equal(p.lockedCount, 1);
  const later = radar.feed({ holder: false }, Date.now() + 20 * 60e3);
  assert.equal(later.entries.length, 0, 'tripped coin never shown in preview');
});

await test('Radar API: sign in over HTTP and get the live feed', async () => {
  const server = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const n = await (await fetch(`${base}/api/radar/nonce?wallet=${whale.address}`)).json();
  const sres = await fetch(`${base}/api/radar/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet: whale.address, nonce: n.nonce, signature: whale.sign(n.message) }) });
  const s = await sres.json();
  assert.equal(sres.status, 200); assert.equal(s.holder, true);
  const live = await (await fetch(`${base}/api/radar/feed`, { headers: { authorization: 'Bearer ' + s.token } })).json();
  assert.equal(live.mode, 'live'); assert.equal(live.gate.holder, true); assert.equal(live.entries.length, 1);
  const anon = await (await fetch(`${base}/api/radar/feed`)).json();
  assert.equal(anon.mode, 'preview'); assert.equal(anon.gate.minHold, 100000);
  const forged = await (await fetch(`${base}/api/radar/feed`, { headers: { authorization: 'Bearer ' + s.token.slice(0, -2) + 'xx' } })).json();
  assert.equal(forged.mode, 'preview');
  server.close();
});


await test('Rate-limited items inside a batch are retried instead of dropped', async () => {
  const { rpcBatch } = await import('./rpc.js');
  globalThis.throttleFirst = 2;
  const r = await rpcBatch([['getTransaction', ['create', {}]], ['getTransaction', ['bundle0', {}]], ['getTransaction', ['bundle1', {}]]]);
  assert.equal(r.filter(Boolean).length, 3);
});
await test('Bags-style curve with no liquidity reported: Exit n/a, not tripped', async () => {
  const { exitWire } = await import('./wires.js');
  const c = exitWire([{ dexId: 'bags', liquidity: { usd: 0 } }]);
  assert.equal(c.na, true); assert.equal(c.tripped, false); assert.match(c.items[0], /bags launch curve/);
});
await test('Shared launchpad deployer is not judged as the dev', async () => {
  const { launchWires } = await import('./wires.js');
  const base = { deployer: 'Pad', creationSlot: 1, creationTime: 1, trades: [], platform: true };
  const r = launchWires({ launch: base, funders: new Map(), holdings: new Map(), supply: 1e15, history: null, now: 2 });
  assert.equal(r.devWire.tripped, false); assert.match(r.devWire.items.join(' '), /shared launchpad account/);
});
await test('Serial launcher (6 launches today) trips Dev', async () => {
  const { launchWires } = await import('./wires.js');
  const now = 1e6;
  const launches = new Map(Array.from({ length: 6 }, (_, i) => ['M' + i, now - 3600]));
  const r = launchWires({ launch: { deployer: 'D', creationSlot: 1, creationTime: now, trades: [] }, funders: new Map(), holdings: new Map(), supply: 1e15, history: { launches, liquidity: new Map(), capped: false }, now });
  assert.equal(r.devWire.tripped, true); assert.match(r.devWire.items.join(' '), /serial launcher/);
});
await test('Slow coin with 8 trades: Agent/Wash still judge, with a weak-signal note', async () => {
  const { flowWires } = await import('./wires.js');
  const trades = Array.from({ length: 8 }, (_, i) => ({ wallet: 'W' + i, side: 'buy', amount: 1e9, slot: i, time: 1000 + i * 97 }));
  const r = flowWires({ trades, decimals: 6, priceUsd: 0.001, fastWallets: new Set() });
  assert.equal(r.agentWire.na, undefined); assert.match(r.agentWire.items[1], /weak signal/); assert.equal(r.washWire.tripped, false);
});
await test('Bonding-curve coin: Exit shows n/a instead of a false trip', async () => {
  const { exitWire } = await import('./wires.js');
  const c = exitWire([{ dexId: 'pumpfun', liquidity: {} }]);
  assert.equal(c.na, true); assert.equal(c.tripped, false); assert.match(c.items[0], /bonding curve/);
});
await test('Free-plan RPC that rejects batches: falls back to single requests', async () => {
  const { rpcBatch } = await import('./rpc.js');
  globalThis.rejectBatch = true;
  const r = await rpcBatch([['getAccountInfo', [MINT, { encoding: 'jsonParsed' }]], ['getTransaction', ['create', {}]]]);
  globalThis.rejectBatch = false;
  assert.equal(r[0].value.owner, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'); assert.equal(r[1].slot, 1000);
});


/* ---------- busy coins: metadata shortcut ---------- */
const { isOnCurve, metadataPda } = await import('./pda.js');
await test('Curve check: real wallet keys are on the curve', () => {
  for (let i = 0; i < 25; i++) {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    assert.equal(isOnCurve(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)), true);
  }
});
await test('Curve check: about half of random hashes are off the curve', () => {
  let off = 0;
  for (let i = 0; i < 200; i++) if (!isOnCurve(crypto.randomBytes(32))) off++;
  assert.ok(off > 60 && off < 140, String(off));
});
await test('Holders: an off-curve owner (bonding-curve reserve) counts as a program, a real key as a wallet', async () => {
  const { ownerKinds } = await import('./chain.js');
  const { findPda } = await import('./pda.js');
  const reserve = findPda([Buffer.from('bonding-curve'), b58decode('7xKqTr1pWzTestMintHv9bRnZ3hJ5cD8fG2sA4Lpump')], '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
  const k = await ownerKinds([reserve, whale.address]);
  assert.equal(k.get(reserve), 'program'); assert.equal(k.get(whale.address), 'wallet');
});
await test('Removing liquidity (tokens AND SOL come back) is not a buy', () => {
  const tx = { slot: 1, blockTime: 1, meta: { err: null, fee: 5000, preBalances: [1e9, 0], postBalances: [3e9, 0],
    preTokenBalances: [{ accountIndex: 1, mint: MINT, owner: 'LPer', uiTokenAmount: { amount: '0' } }],
    postTokenBalances: [{ accountIndex: 1, mint: MINT, owner: 'LPer', uiTokenAmount: { amount: '500' } }], innerInstructions: [] },
    transaction: { signatures: ['lp1'], message: { accountKeys: [{ pubkey: 'LPer', signer: true }, { pubkey: 'LPerATA', signer: false }], instructions: [] } } };
  assert.equal(parseTrades(tx, MINT)[0].side, 'lp');
  const buy = JSON.parse(JSON.stringify(tx)); buy.meta.postBalances = [0.5e9, 0];
  assert.equal(parseTrades(buy, MINT)[0].side, 'buy');
});
await test('Minting supply to yourself is not counted as a buy', () => {
  const tx = { slot: 1, blockTime: 1, meta: { err: null,
    preTokenBalances: [{ accountIndex: 1, mint: MINT, owner: 'Minter', uiTokenAmount: { amount: '0' } }],
    postTokenBalances: [{ accountIndex: 1, mint: MINT, owner: 'Minter', uiTokenAmount: { amount: '900' } }],
    innerInstructions: [{ index: 0, instructions: [{ program: 'spl-token', parsed: { type: 'mintTo', info: { mint: MINT, account: 'MinterATA', amount: '800' } } }] }] },
    transaction: { signatures: ['m1'], message: { accountKeys: [{ pubkey: 'Minter', signer: true }, { pubkey: 'MinterATA', signer: false }], instructions: [] } } };
  const t = parseTrades(tx, MINT);
  assert.deepEqual(t.map(x => [x.side, x.amount]), [['mint', 800], ['buy', 100]]);
});
await test('A bundle that grabbed over half the supply trips even after dumping', async () => {
  const { launchWires } = await import('./wires.js');
  const S = 1e15, tr = (w, a) => ({ wallet: w, side: 'buy', amount: a, slot: 5, time: 1, sig: 's' + w });
  const r = launchWires({ launch: { deployer: 'D', creationSlot: 5, creationTime: 1, trades: [tr('X1', 0.3 * S), tr('X2', 0.3 * S)] }, funders: new Map(), holdings: new Map(), supply: S, history: null, now: 2 });
  assert.equal(r.bundleWire.tripped, true); assert.match(r.bundleWire.items.join(' '), /pump-and-dump/);
});
await test('Busy pump.fun coin: launch rebuilt from its bonding-curve history', async () => {
  const { reconstructLaunch } = await import('./chain.js');
  const { findPda } = await import('./pda.js');
  const CM = 'CurveMint9xKqWv7bRnZ3hJ5cD8fG2sA4LTrippump';
  sigLists.set(CM, Array.from({ length: 2600 }, (_, i) => ({ signature: 'cbusy' + i, blockTime: now - i, err: null })));
  const curve = findPda([Buffer.from('bonding-curve'), b58decode(CM)], '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
  const mk = (sig, slot, w, amt, init) => {
    txs.set(sig, { slot, blockTime: T0, meta: { err: null, preTokenBalances: [{ accountIndex: 0, mint: CM, owner: w, uiTokenAmount: { amount: '0' } }], postTokenBalances: [{ accountIndex: 0, mint: CM, owner: w, uiTokenAmount: { amount: String(amt) } }], innerInstructions: init ? [{ index: 0, instructions: [{ program: 'spl-token', parsed: { type: 'initializeMint2', info: { mint: CM } } }] }] : [] }, transaction: { signatures: [sig], message: { accountKeys: [{ pubkey: w, signer: true }], instructions: [] } } });
  };
  mk('ccreate', 8000, 'CurveDev', 1e12, true); mk('cb1', 8000, 'CB1', 5e13); mk('cs1', 8002, 'CS1', 2e13); mk('corg', 8050, 'COrg', 1e12);
  sigLists.set(curve, [['corg', 3], ['cs1', 2], ['cb1', 1], ['ccreate', 0]].map(([s, t]) => ({ signature: s, blockTime: T0 + t, err: null })));
  const L = await reconstructLaunch(CM);
  assert.equal(L.ok, true); assert.equal(L.viaCurve, true); assert.equal(L.deployer, 'CurveDev'); assert.equal(L.creationSlot, 8000);
  assert.deepEqual(L.trades.filter(t => t.side === 'buy').map(t => t.wallet).sort(), ['CB1', 'COrg', 'CS1', 'CurveDev']);
});
await test('A busy service account (1,000 txs in a day) is flagged as a launchpad', async () => {
  const { launchesBy } = await import('./chain.js');
  sigLists.set('BusyPad', Array.from({ length: 1000 }, (_, i) => ({ signature: 'bp' + i, blockTime: now - i * 30, err: null })));
  const d = await launchesBy('BusyPad', MINT);
  assert.equal(d.busy, true);
});
await test('Buy-sell-buy flipping counts the peak position, not every buy', async () => {
  const { launchWires } = await import('./wires.js');
  const S = 1e15, tr = (w, side, a, slot) => ({ wallet: w, side, amount: a, slot, time: slot, sig: w + slot });
  const trades = [tr('F1', 'buy', 0.2 * S, 5), tr('F1', 'sell', 0.2 * S, 6), tr('F1', 'buy', 0.2 * S, 7), tr('F2', 'buy', 0.1 * S, 5)];
  const r = launchWires({ launch: { deployer: 'D', creationSlot: 5, creationTime: 1, trades }, funders: new Map(), holdings: new Map(), supply: S, history: null, now: 9 });
  assert.match(r.bundleWire.items[0], /held up to 30\.0%/);
});
await test('Dev-only launch buy is not called a bundle', async () => {
  const { launchWires } = await import('./wires.js');
  const r = launchWires({ launch: { deployer: 'D', creationSlot: 5, creationTime: 1, trades: [{ wallet: 'D', side: 'buy', amount: 1.79e14, slot: 5, time: 1, sig: 'x' }] }, funders: new Map(), holdings: new Map(), supply: 1e15, history: null, now: 2 });
  assert.equal(r.bundleWire.tripped, false); assert.match(r.bundleWire.items[0], /Only the dev bought at launch \(17\.9%/);
});
await test('Busy coin (2,500+ txs): launch rebuilt from its metadata account and launch blocks', async () => {
  const { reconstructLaunch } = await import('./chain.js');
  const BIG = 'BigMint9xKqWv7bRnZ3hJ5cD8fG2sA4LTrippump';
  sigLists.set(BIG, Array.from({ length: 2600 }, (_, i) => ({ signature: 'busy' + i, blockTime: now - i, err: null })));
  const META = metadataPda(BIG);
  assert.ok(META);
  sigLists.set(META, [{ signature: 'bigcreate', blockTime: T0, err: null }]);
  const keys = w => [{ pubkey: w, signer: true }, { pubkey: POOL, signer: false }];
  const bal = (w, amt) => ({ pre: [{ accountIndex: 0, mint: BIG, owner: w, uiTokenAmount: { amount: '0' } }], post: [{ accountIndex: 0, mint: BIG, owner: w, uiTokenAmount: { amount: String(amt) } }] });
  const btx = (w, amt) => { const b = bal(w, amt); return { meta: { err: null, preTokenBalances: b.pre, postTokenBalances: b.post }, transaction: { signatures: ['b' + w], accountKeys: keys(w) } }; };
  const cb = bal('BigDev', 2 * P);
  txs.set('bigcreate', { slot: 7000, blockTime: T0, meta: { err: null, preTokenBalances: cb.pre, postTokenBalances: cb.post, innerInstructions: [{ index: 0, instructions: [{ program: 'spl-token', parsed: { type: 'initializeMint2', info: { mint: BIG } } }] }] }, transaction: { signatures: ['bigcreate'], message: { accountKeys: keys('BigDev'), instructions: [] } } });
  blocks.set(7000, { blockTime: T0, transactions: [btx('BX1', 5 * P), btx('BX2', 5 * P), { meta: { err: null, preTokenBalances: [], postTokenBalances: [] }, transaction: { signatures: ['other'], accountKeys: keys('Rando') } }] });
  blocks.set(7002, { blockTime: T0 + 1, transactions: [btx('SN1', 3 * P)] });
  const L = await reconstructLaunch(BIG);
  assert.equal(L.ok, true); assert.equal(L.viaBlocks, true); assert.equal(L.deployer, 'BigDev'); assert.equal(L.creationSlot, 7000);
  const buyers = L.trades.filter(t => t.side === 'buy').map(t => t.wallet).sort();
  assert.deepEqual(buyers, ['BX1', 'BX2', 'BigDev', 'SN1']);
});

await test('Mint authority set to the system program counts as burned', async () => {
  const { authorityWire } = await import('./wires.js');
  const r = authorityWire({ owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: { parsed: { info: { mintAuthority: '11111111111111111111111111111111', freezeAuthority: null } } } });
  assert.equal(r.tripped, false); assert.match(r.items[0], /burned/);
});
await test('Established coin: bot-heavy flow is explained, not tripped', async () => {
  const { flowWires } = await import('./wires.js');
  const trades = [];
  for (let i = 0; i < 40; i++) trades.push({ wallet: 'ARB', side: i % 2 ? 'sell' : 'buy', amount: 1e9, time: 1000 + i * 2, slot: 100 + i, sig: 's' + i });
  for (let i = 0; i < 6; i++) trades.push({ wallet: 'U' + i, side: 'buy', amount: 1e8, time: 900 + i * 37, slot: 50 + i, sig: 'u' + i });
  const young = flowWires({ trades, decimals: 6, priceUsd: 1, fastWallets: new Set(['ARB']) });
  const old = flowWires({ trades, decimals: 6, priceUsd: 1, fastWallets: new Set(['ARB']), established: true });
  assert.equal(young.agentWire.tripped, true); assert.equal(old.agentWire.tripped, false);
  assert.ok(old.agentWire.items.some(x => /established coin/.test(x)));
});
await test('Tiny price impact reads "less than 0.1%"', async () => {
  const { exitWire } = await import('./wires.js');
  const r = exitWire([{ dexId: 'raydium', liquidity: { usd: 1e8 } }]);
  assert.ok(r.items.some(x => /less than 0\.1%/.test(x))); assert.ok(!r.items.some(x => /about under/.test(x)));
});
await test('Sold-out groups read naturally', async () => {
  const { launchWires } = await import('./wires.js');
  const trades = [{ wallet: 'D', side: 'buy', amount: 5e13, slot: 5, time: 1, sig: 'a' }, { wallet: 'S1', side: 'buy', amount: 2e13, slot: 6, time: 2, sig: 'b' }];
  const r = launchWires({ launch: { deployer: 'D', creationSlot: 5, creationTime: 1, trades }, funders: new Map(), holdings: new Map(), supply: 1e15, history: null, now: 9 });
  assert.ok(r.sniperWire.items.some(x => x === 'They have sold all of it.'));
  assert.match(r.devWire.items[0], /holds none of the supply/);
});

await test('Pool claiming more liquidity than the market cap is not trusted', async () => {
  const { rankPairs } = await import('./dex.js');
  const { exitWire } = await import('./wires.js');
  const pairs = rankPairs([
    { dexId: 'raydium', pairAddress: 'FAKE', liquidity: { usd: 235e6 }, volume: { h24: 10 }, marketCap: 9e6 },
    { dexId: 'orca', pairAddress: 'REAL', liquidity: { usd: 4e5 }, volume: { h24: 5e5 }, marketCap: 9e6 }
  ]);
  assert.equal(pairs[0].pairAddress, 'REAL');
  const r = exitWire(pairs);
  assert.match(r.items[0], /\$400(\.0)?K/); assert.ok(r.items.some(x => /Ignored a raydium pool/.test(x)));
  // A real deep pool next to a busy tiny pool is kept
  const ok = rankPairs([
    { dexId: 'raydium', pairAddress: 'DEEP', liquidity: { usd: 137800 }, volume: { h24: 50 }, marketCap: 2e6 },
    { dexId: 'meteora', pairAddress: 'TINY', liquidity: { usd: 391 }, volume: { h24: 9000 }, marketCap: 2e6 }
  ]);
  assert.equal(ok[0].pairAddress, 'DEEP'); assert.ok(!ok.some(p => p._suspect));
});

for (const [s, n] of results) console.log(s, n);
const failed = results.filter(r => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
