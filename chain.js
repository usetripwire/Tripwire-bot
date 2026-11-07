// Reading transactions: who traded a token, who funded a wallet, who created which mints.
import { rpc, rpcBatch, sigsFor, getTxs } from './rpc.js';
import { cfg } from './config.js';
import { TTLCache, log } from './util.js';
import { metadataPda, isOnCurve } from './pda.js';
import { b58decode } from './auth.js';

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

// Pool authorities that hold reserves for many pools (not regular wallets).
// Pools whose own account holds the reserves (pump.fun, PumpSwap, Orca, Meteora DLMM)
// are caught by the program-owned check instead.
export const KNOWN_POOL_OWNERS = new Set([
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', // Raydium AMM v4 authority
  'GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL', // Raydium CPMM authority
  'WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh',  // Raydium LaunchLab authority
  'HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC', // Meteora DAMM v2 pool authority
  '1nc1nerator11111111111111111111111111111111'   // burn address
]);

export const keysOf = tx => ((tx.transaction.message && tx.transaction.message.accountKeys) || tx.transaction.accountKeys || []).map(k => (typeof k === 'string' ? { pubkey: k, signer: false } : k));
export const feePayerOf = tx => keysOf(tx)[0].pubkey;

export function allInstructions(tx) {
  const outer = (tx.transaction.message && tx.transaction.message.instructions) || [];
  const inner = ((tx.meta && tx.meta.innerInstructions) || []).flatMap(i => i.instructions || []);
  return outer.concat(inner);
}

export function mintsInitialized(tx) {
  return allInstructions(tx)
    .filter(i => i.program === 'spl-token' && i.parsed && /^initializeMint2?$/.test(i.parsed.type))
    .map(i => i.parsed.info.mint);
}

// Trades of `mint` in one transaction, one per signing wallet whose balance changed.
// Pools never sign, so only real traders are returned. Works across DEXes and aggregators.
export function parseTrades(tx, mint) {
  if (!tx || !tx.meta || tx.meta.err) return [];
  const keys = keysOf(tx);
  const signers = new Set(keys.filter(k => k.signer).map(k => k.pubkey));
  signers.add(keys[0].pubkey);
  const delta = new Map();
  const add = (list, sign) => {
    for (const b of list || []) {
      if (b.mint !== mint || !b.owner || !/^\d+$/.test(String(b.uiTokenAmount && b.uiTokenAmount.amount))) continue;
      delta.set(b.owner, (delta.get(b.owner) || 0n) + sign * BigInt(b.uiTokenAmount.amount));
    }
  };
  add(tx.meta.preTokenBalances, -1n);
  add(tx.meta.postTokenBalances, 1n);
  const out = [];
  for (const [owner, d] of delta) {
    if (d === 0n || !signers.has(owner)) continue;
    out.push({ wallet: owner, side: d > 0n ? 'buy' : 'sell', amount: Number(d > 0n ? d : -d), slot: tx.slot, time: tx.blockTime, sig: tx.transaction.signatures[0] });
  }
  return out;
}

// Walk the mint's history back to its creation and read the launch window.
// Busy coins: jump straight to the launch through the token's metadata account,
// then read only the launch block and the few blocks after it.
export async function reconstructLaunch(mint) {
  let before, all = [], reachedStart = false;
  const tryPages = async upto => {
    while (!reachedStart && all.length < upto * 1000) {
      const page = await sigsFor(mint, { limit: 1000, before });
      all = all.concat(page);
      if (page.length < 1000) { reachedStart = true; break; }
      before = page[page.length - 1].signature;
    }
  };
  await tryPages(cfg.scan.mintSigPages);
  if (!reachedStart) {
    const viaMeta = await launchViaMetadata(mint).catch(e => { log('metadata shortcut failed', mint, e.message); return null; });
    if (viaMeta) return viaMeta;
    await tryPages(cfg.scan.mintSigPagesMax);
  }
  if (!reachedStart) return { ok: false, reason: 'too_active', txCount: all.length };
  const okSigs = all.filter(s => !s.err);
  if (!okSigs.length) return { ok: false, reason: 'no_history' };
  const early = okSigs.slice(-cfg.scan.earlyTxs).reverse();
  const txs = (await getTxs(early.map(s => s.signature))).filter(Boolean).sort((a, b) => a.slot - b.slot);
  if (!txs.length) return { ok: false, reason: 'no_history' };
  const creation = txs.find(t => mintsInitialized(t).includes(mint)) || txs[0];
  return {
    ok: true,
    deployer: feePayerOf(creation),
    creationSigners: keysOf(creation).filter(k => k.signer).map(k => k.pubkey),
    creationSlot: creation.slot,
    creationTime: creation.blockTime,
    trades: txs.flatMap(t => parseTrades(t, mint)),
    txCount: all.length
  };
}

async function launchViaMetadata(mint) {
  const meta = metadataPda(mint);
  if (!meta) return null;
  const sigs = (await sigsFor(meta, { limit: 1000 })).filter(s => !s.err);
  if (!sigs.length || sigs.length >= 1000) return null;
  const [creation] = await getTxs([sigs[sigs.length - 1].signature]);
  if (!creation) return null;
  const slots = [];
  for (let s = creation.slot; s <= creation.slot + cfg.scan.sniperSlots; s++) slots.push(s);
  const blocks = await rpcBatch(slots.map(s => ['getBlock', [s, { encoding: 'jsonParsed', transactionDetails: 'accounts', maxSupportedTransactionVersion: 0, rewards: false, commitment: 'confirmed' }]]), 1);
  const seenSig = new Set();
  const trades = [];
  const add = t => { if (!seenSig.has(t.sig + t.wallet)) { seenSig.add(t.sig + t.wallet); trades.push(t); } };
  parseTrades(creation, mint).forEach(add);
  blocks.forEach((b, i) => {
    if (!b) return;
    for (const t of b.transactions || []) parseTrades({ slot: slots[i], blockTime: b.blockTime, meta: t.meta, transaction: t.transaction }, mint).forEach(add);
  });
  return {
    ok: true, viaBlocks: true,
    deployer: feePayerOf(creation),
    creationSigners: keysOf(creation).filter(k => k.signer).map(k => k.pubkey),
    creationSlot: creation.slot,
    creationTime: creation.blockTime,
    trades
  };
}

// Who first sent SOL to each wallet. Cached for a week (funding never changes).
const fundCache = new TTLCache(50000, 7 * 86400e3);
export async function fundersFor(wallets) {
  const need = [...new Set(wallets)].filter(w => !fundCache.has(w));
  const pages = await rpcBatch(need.map(w => ['getSignaturesForAddress', [w, { limit: 1000 }]]), 10);
  const firsts = [];
  need.forEach((w, i) => {
    const page = pages[i] || [];
    if (!page.length || page.length >= 1000) fundCache.set(w, { funder: null, firstTime: null, txs: page.length });
    else firsts.push([w, page[page.length - 1].signature, page.length]);
  });
  const txs = await getTxs(firsts.map(f => f[1]));
  firsts.forEach(([w, , n], i) => {
    const tx = txs[i];
    let funder = null;
    if (tx) {
      for (const ins of allInstructions(tx)) {
        if (ins.program !== 'system' || !ins.parsed) continue;
        const info = ins.parsed.info || {};
        if ((info.destination || info.newAccount) === w && info.source && info.source !== w) { funder = info.source; break; }
      }
    }
    fundCache.set(w, { funder, firstTime: tx ? tx.blockTime : null, txs: n });
  });
  return new Map(wallets.map(w => [w, fundCache.get(w)]));
}

// Current raw balance of `mint` for each wallet.
export async function holdingsOf(wallets, mint) {
  const res = await rpcBatch(wallets.map(w => ['getTokenAccountsByOwner', [w, { mint }, { encoding: 'jsonParsed' }]]), 20);
  return new Map(wallets.map((w, i) => [w, ((res[i] && res[i].value) || []).reduce((s, a) => s + Number(a.account.data.parsed.info.tokenAmount.amount), 0)]));
}

// Mints this wallet created recently (it paid for the initializeMint transaction).
const devCache = new TTLCache(5000, 24 * 3600e3);
export async function launchesBy(deployer, exceptMint) {
  const key = deployer;
  let found = devCache.get(key);
  if (!found) {
    const sigs = (await sigsFor(deployer, { limit: cfg.scan.devHistoryTxs })).filter(s => !s.err);
    const txs = await getTxs(sigs.map(s => s.signature));
    const launches = new Map();
    for (const tx of txs) {
      if (!tx || feePayerOf(tx) !== deployer) continue;
      for (const m of mintsInitialized(tx)) if (!launches.has(m)) launches.set(m, tx.blockTime);
    }
    found = devCache.set(key, { launches, capped: sigs.length >= cfg.scan.devHistoryTxs });
  }
  const launches = new Map([...found.launches].filter(([m]) => m !== exceptMint));
  return { launches, capped: found.capped };
}

// Is each owner a regular wallet, or an account owned by a program (pool, locker, vault)?
export async function ownerKinds(owners) {
  const uniq = [...new Set(owners)].filter(Boolean);
  const kinds = new Map();
  for (let i = 0; i < uniq.length; i += 100) {
    const slice = uniq.slice(i, i + 100);
    const r = await rpc('getMultipleAccounts', [slice, { encoding: 'base64' }]);
    slice.forEach((o, k) => {
      const acc = r && r.value ? r.value[k] : null;
      // Real wallets are ed25519 keys (on the curve). Program addresses (PDAs) are off the curve:
      // bonding-curve reserves, pool vault authorities, lockers. Those aren't holders.
      let offCurve = false;
      try { const raw = b58decode(o); offCurve = raw.length === 32 && !isOnCurve(raw); } catch { /* not base58: leave as is */ }
      kinds.set(o, KNOWN_POOL_OWNERS.has(o) ? 'pool' : offCurve || (acc && acc.owner && acc.owner !== SYSTEM_PROGRAM) ? 'program' : 'wallet');
    });
  }
  return kinds;
}
