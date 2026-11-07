// Full scan: runs every wire for one mint and returns a JSON-friendly result.
import { cfg } from './config.js';
import { rpc, rpcBatch, sigsFor, getTxs, stats } from './rpc.js';
import { pairsFor, liquidityFor } from './dex.js';
import { TOKEN_PROGRAM, TOKEN_2022, reconstructLaunch, fundersFor, holdingsOf, launchesBy, ownerKinds, parseTrades } from './chain.js';
import { authorityWire, holdersWire, exitWire, launchWires, flowWires } from './wires.js';
import { TTLCache, ScanError, B58, createLimiter, log } from './util.js';

const cache = new TTLCache(2000, cfg.scan.cacheMinutes * 60e3);
const inflight = new Map();
const scanLimit = createLimiter(cfg.limits.concurrentScans);

const na = (key, name, why) => ({ key, name, na: true, tripped: false, items: [why], brief: 'n/a' });

export function scan(mint) {
  if (!B58.test(mint || '')) return Promise.reject(new ScanError('invalid', 'That is not a Solana address.'));
  const hit = cache.get(mint);
  if (hit) return Promise.resolve(hit);
  if (inflight.has(mint)) return inflight.get(mint);
  const p = scanLimit(() => runScan(mint)).then(r => { cache.set(mint, r); return r; }).finally(() => inflight.delete(mint));
  inflight.set(mint, p);
  return p;
}

async function runScan(mint) {
  const started = Date.now();
  const [mintR, pairsR, largestR] = await Promise.allSettled([
    rpc('getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]),
    pairsFor(mint),
    rpc('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }])
  ]);
  if (mintR.status === 'rejected') throw new ScanError('rpc', 'Could not reach Solana right now.');
  const acc = mintR.value && mintR.value.value;
  const parsed = acc && acc.data && acc.data.parsed;
  if (!acc || !(acc.owner === TOKEN_PROGRAM || acc.owner === TOKEN_2022) || !parsed || parsed.type !== 'mint') {
    throw new ScanError('not_mint', 'That address is not a Solana token mint.');
  }
  const supply = Number(parsed.info.supply);
  const decimals = parsed.info.decimals;
  const pairs = pairsR.status === 'fulfilled' ? pairsR.value : null;
  const pair = pairs && pairs[0];
  const poolSet = new Set((pairs || []).map(p => p.pairAddress).filter(Boolean));
  const now = Math.floor(Date.now() / 1000);
  // Established: deep liquidity, or a decent pool that has traded for 90+ days
  const liqUsd = (pair && pair.liquidity && pair.liquidity.usd) || 0;
  const ageDays = pair && pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 86400e3 : 0;
  const established = liqUsd >= cfg.t.establishedLiqUsd || (ageDays >= 90 && liqUsd >= cfg.t.establishedLiqUsd / 4);

  // Basics
  const authority = authorityWire(acc);
  const exit = pairs ? exitWire(pairs) : na('exit', 'Exit', 'DexScreener did not respond, so pool depth could not be checked.');
  let holders = na('holders', 'Holders', 'The RPC refused the holder lookup. Try again shortly.');
  if (largestR.status === 'fulfilled' && largestR.value && largestR.value.value) {
    const largest = largestR.value.value;
    try {
      const tokAccs = await rpcBatch([['getMultipleAccounts', [largest.map(a => a.address), { encoding: 'jsonParsed' }]]]);
      const owners = ((tokAccs[0] && tokAccs[0].value) || []).map(a => (a && a.data && a.data.parsed ? a.data.parsed.info.owner : ''));
      const kinds = await ownerKinds(owners);
      holders = holdersWire(largest, owners, kinds, supply, poolSet, { established });
    } catch { /* keep n/a */ }
  }

  // Launch wires and flow wires run in parallel
  const launchP = (async () => {
    const launch = await reconstructLaunch(mint);
    if (!launch.ok) {
      const why = launch.reason === 'too_active'
        ? `This token has more than ${(cfg.scan.mintSigPagesMax * 1000).toLocaleString('en-US')} transactions and no short record (bonding curve or metadata) that leads to its launch, so the launch can't be rebuilt.`
        : 'Could not read this token\'s launch history.';
      return { bundleWire: na('bundle', 'Bundle', why), sniperWire: na('sniper', 'Sniper', why), devWire: na('dev', 'Dev history', why) };
    }
    const order = [];
    for (const t of launch.trades) if (t.side === 'buy' && !order.includes(t.wallet)) order.push(t.wallet);
    // Launchpads (Bags, some others) pay for the launch from one shared account.
    // If the fee payer has launched lots of tokens, look for the real creator among the other signers.
    let dev = await launchesBy(launch.deployer, mint).catch(() => null);
    launch.platform = false;
    const isPlatform = d => d && (d.busy || d.launches.size >= cfg.t.platformLaunches);
    if (isPlatform(dev)) {
      const alt = (launch.creationSigners || []).find(s => s !== launch.deployer);
      const altDev = alt ? await launchesBy(alt, mint).catch(() => null) : null;
      if (alt && altDev && !isPlatform(altDev)) { launch.launchpad = launch.deployer; launch.deployer = alt; dev = altDev; }
      else { launch.platform = true; dev = null; }
    }
    const traced = [launch.deployer, ...order.filter(w => w !== launch.deployer)].slice(0, cfg.scan.fundingChecks + 1);
    const [funders, holdings] = await Promise.all([fundersFor(traced), holdingsOf(traced, mint)]);
    let history = null;
    if (dev) {
      const mints = [...dev.launches.keys()].slice(0, 60);
      history = { launches: new Map(mints.map(m => [m, dev.launches.get(m)])), liquidity: await liquidityFor(mints), capped: dev.capped };
    }
    // Only wallets we traced take part in clustering and holdings
    const tracedSet = new Set(traced);
    const scoped = { ...launch, trades: launch.trades.filter(t => tracedSet.has(t.wallet)) };
    return launchWires({ launch: scoped, funders, holdings, supply, history, now });
  })().catch(e => {
    log('launch wires failed', mint, e.message);
    const why = /rate_limited/.test(e.message) ? 'Our Solana data provider is busy right now. Try again in a minute.' : 'The launch history lookup failed. Try again shortly.';
    return { bundleWire: na('bundle', 'Bundle', why), sniperWire: na('sniper', 'Sniper', why), devWire: na('dev', 'Dev history', why) };
  });

  const flowP = (async () => {
    if (!pair || !pair.pairAddress) {
      const why = 'No trading pool found, so there is no recent trading to read.';
      return { agentWire: na('agent', 'Agent', why), washWire: na('wash', 'Wash', why) };
    }
    // Read recent pool transactions; go further back if the coin trades slowly.
    // Busy pools are full of failed bot transactions, so only successful ones count toward the budget.
    // Read the pool first; if it yields few trades, also read the coin's own history (pump.fun and
    // most pools include the coin's mint in every trade).
    const diag = { pool: pair.pairAddress, sigs: 0, ok: 0, empty: 0, errorsBefore: stats.itemErrors };
    const readFrom = async (address, budget) => {
      let found = [], before, read = 0, pagesRead = 0;
      while (read < budget && pagesRead < 15) {
        const page = await sigsFor(address, { limit: 200, before });
        pagesRead++;
        diag.sigs += page.length;
        if (!page.length) break;
        before = page[page.length - 1].signature;
        const ok = page.filter(s => !s.err).slice(0, budget - read);
        read += ok.length;
        diag.ok += ok.length;
        const txs = await getTxs(ok.map(s => s.signature));
        diag.empty += txs.filter(t => !t).length;
        found = found.concat(txs.flatMap(tx => parseTrades(tx, mint)));
        if (found.length >= cfg.t.lowFlowTrades * 3 || page.length < 200) break;
      }
      return found;
    };
    let trades = await readFrom(pair.pairAddress, cfg.scan.recentTxsMax);
    diag.poolTrades = trades.length;
    if (trades.length < cfg.t.lowFlowTrades) {
      const seenSig = new Set(trades.map(t => t.sig + t.wallet));
      for (const t of await readFrom(mint, cfg.scan.recentTxsMax)) if (!seenSig.has(t.sig + t.wallet)) { seenSig.add(t.sig + t.wallet); trades.push(t); }
    }
    diag.trades = trades.length;
    diag.itemErrors = stats.itemErrors - diag.errorsBefore;
    log('trade read', mint, JSON.stringify({ ...diag, errorsBefore: undefined, lastError: diag.itemErrors ? stats.lastError : undefined }));
    // Check the busiest wallets' overall transaction rate (1000 txs in under a day = automated)
    const vol = new Map();
    for (const t of trades) vol.set(t.wallet, (vol.get(t.wallet) || 0) + t.amount);
    const top = [...vol.entries()].sort((a, b) => b[1] - a[1]).slice(0, cfg.scan.agentWalletChecks).map(e => e[0]);
    const pages = await rpcBatch(top.map(w => ['getSignaturesForAddress', [w, { limit: 1000 }]]), 10);
    const fastWallets = new Set();
    top.forEach((w, i) => {
      const p = pages[i] || [];
      if (p.length >= 1000 && p[0].blockTime && p[p.length - 1].blockTime && p[0].blockTime - p[p.length - 1].blockTime < 86400) fastWallets.add(w);
    });
    return flowWires({ trades, decimals, priceUsd: Number(pair.priceUsd) || 0, fastWallets, established });
  })().catch(e => {
    log('trade wires failed', mint, e.message);
    const why = /rate_limited/.test(e.message) ? 'Our Solana data provider is busy right now. Try again in a minute.' : 'Recent trades could not be read. Try again shortly.';
    return { agentWire: na('agent', 'Agent', why), washWire: na('wash', 'Wash', why) };
  });

  const [lw, fw] = await Promise.all([launchP, flowP]);
  const checks = [lw.bundleWire, lw.sniperWire, lw.devWire, fw.agentWire, fw.washWire, exit, authority, holders];

  return {
    mint,
    token: {
      name: ((pair && pair.baseToken.name) || '').replace(/\s+/g, ' ').trim() || 'Unknown token',
      symbol: ((pair && pair.baseToken.symbol) || '').replace(/\s+/g, ' ').trim(),
      image: pair && pair.info && /^https:\/\//.test(pair.info.imageUrl || '') ? pair.info.imageUrl : ''
    },
    checks,
    pair: pair ? {
      dexId: pair.dexId, url: pair.url, priceUsd: pair.priceUsd, marketCap: pair.marketCap, fdv: pair.fdv,
      liquidity: pair.liquidity, volume: pair.volume, txns: pair.txns, pairCreatedAt: pair.pairCreatedAt
    } : null,
    generatedAt: new Date().toISOString(),
    tookMs: Date.now() - started,
    full: true
  };
}
