// The eight checks. Each returns { key, name, tripped, na, items[], brief }.
// `brief` is the short note used in the X reply.
import { cfg } from './config.js';
import { TOKEN_2022 } from './chain.js';
import { pct, usd, short, sum } from './util.js';

const T = cfg.t;
const about = x => (x > 0 && x < 1 ? 'Under 1%' : `About ${pct(x, 0)}`);
const na = (key, name, why) => ({ key, name, na: true, tripped: false, items: [why], brief: 'n/a' });

/* ---------------- Authority ---------------- */
export function authorityWire(mintAcc) {
  const info = mintAcc.data.parsed.info;
  const items = [], flags = [];
  if (info.mintAuthority) { flags.push('mint on'); items.push(`Mint authority is active: more supply can be created (${short(info.mintAuthority)}).`); }
  else items.push('Mint authority revoked: supply is fixed.');
  if (info.freezeAuthority) { flags.push('freeze on'); items.push(`Freeze authority is active: holder wallets can be frozen (${short(info.freezeAuthority)}).`); }
  else items.push('Freeze authority revoked.');
  if (mintAcc.owner === TOKEN_2022) {
    for (const ext of info.extensions || []) {
      const s = ext.state || {};
      if (ext.extension === 'transferFeeConfig') {
        const bps = ((s.newerTransferFee || {}).transferFeeBasisPoints) || ((s.olderTransferFee || {}).transferFeeBasisPoints) || 0;
        if (bps > 0) { flags.push(`${bps / 100}% fee`); items.push(`Transfer fee of ${bps / 100}% on every transfer.`); }
      }
      if (ext.extension === 'permanentDelegate' && s.delegate) { flags.push('delegate'); items.push('Permanent delegate set: one wallet can move or burn anyone\'s tokens.'); }
      if (ext.extension === 'transferHook' && s.programId) { flags.push('hook'); items.push('Transfer hook set: custom code runs on every transfer.'); }
      if (ext.extension === 'pausableConfig' && s.authority) { flags.push('pausable'); items.push('Pausable: transfers can be paused.'); }
    }
  }
  return { key: 'authority', name: 'Authority', tripped: flags.length > 0, items, brief: flags.length ? flags.join(', ') : 'revoked' };
}

/* ---------------- Holders ---------------- */
export function holdersWire(largest, owners, kinds, supply, poolSet) {
  if (!supply) return na('holders', 'Holders', 'Supply is zero, so concentration can\'t be measured.');
  const rows = largest.map((acc, i) => {
    const owner = owners[i] || '';
    const kind = poolSet.has(owner) || poolSet.has(acc.address) ? 'pool' : kinds.get(owner) || 'wallet';
    return { address: acc.address, owner, share: (Number(acc.amount) / supply) * 100, kind };
  });
  const wallets = rows.filter(r => r.kind === 'wallet');
  const top10 = sum(wallets.slice(0, 10).map(r => r.share));
  const top1 = wallets.length ? wallets[0].share : 0;
  const pooled = sum(rows.filter(r => r.kind === 'pool').map(r => r.share));
  const program = sum(rows.filter(r => r.kind === 'program').map(r => r.share));
  const items = [`Top 10 wallets hold ${pct(top10)} of supply (pools and programs excluded).`, `Largest single wallet holds ${pct(top1)}.`];
  if (pooled >= 0.05) items.push(`${pct(pooled)} of supply sits in trading pools.`);
  if (program >= 0.05) items.push(`${pct(program)} is held by programs (bonding curves, pool vaults or lockers), not people.`);
  return { key: 'holders', name: 'Holders', tripped: top10 > T.top10 || top1 > T.single, items, brief: `top10 ${pct(top10, 0)}`, rows };
}

/* ---------------- Exit ---------------- */
export function exitWire(pairs) {
  if (!pairs.length) return { key: 'exit', name: 'Exit', tripped: true, items: ['No trading pool found on DexScreener. You may not be able to sell.'], brief: 'no pool' };
  const p = pairs[0];
  const liq = (p.liquidity && p.liquidity.usd) || 0;
  if (!liq) {
    const where = p.dexId === 'pumpfun' ? 'the pump.fun bonding curve' : p.dexId ? `a ${p.dexId} launch curve` : 'a launch curve';
    return { key: 'exit', name: 'Exit', na: true, tripped: false, items: [`Still on ${where}, which doesn't report pool liquidity, so sells go back into the curve. Pool depth is checked after it graduates.`], brief: 'on curve' };
  }
  const q = liq / 2; // constant-product estimate: quote side is about half the pool's value
  const slip = q > 0 ? (T.sellUsd / (q + T.sellUsd)) * 100 : 100;
  return {
    key: 'exit', name: 'Exit', tripped: liq < T.minLiqUsd || slip > T.maxSlip,
    items: [`Deepest pool: ${usd(liq)} liquidity on ${p.dexId || 'a DEX'}.`, `Selling ${usd(T.sellUsd)} would move the price about ${pct(slip)} (estimate).`],
    brief: `${usd(liq)} liq`
  };
}

/* ---------------- Launch wires: Bundle, Sniper, Dev ---------------- */
// Union-find over wallets that share a funder, or were funded by each other or the deployer.
function clusters(wallets, funders, deployer) {
  const parent = new Map(wallets.map(w => [w, w]));
  const find = w => { while (parent.get(w) !== w) { parent.set(w, parent.get(parent.get(w))); w = parent.get(w); } return w; };
  const union = (a, b) => { if (!parent.has(a) || !parent.has(b)) return; const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  const byFunder = new Map();
  for (const w of wallets) {
    const f = funders.get(w) && funders.get(w).funder;
    if (!f) continue;
    if (parent.has(f)) union(w, f);                // funded by another early buyer or the deployer
    if (!byFunder.has(f)) byFunder.set(f, []);
    byFunder.get(f).push(w);
  }
  for (const group of byFunder.values()) for (let i = 1; i < group.length; i++) union(group[0], group[i]);
  const devFunder = funders.get(deployer) && funders.get(deployer).funder;
  if (devFunder && byFunder.has(devFunder)) for (const w of byFunder.get(devFunder)) union(w, deployer);
  const groups = new Map();
  for (const w of wallets) { const r = find(w); if (!groups.has(r)) groups.set(r, new Set()); groups.get(r).add(w); }
  return { groupOf: w => groups.get(find(w)), groups: [...groups.values()] };
}

export function launchWires({ launch, funders, holdings, supply, history, now }) {
  const { deployer, creationSlot, creationTime, trades } = launch;
  const buys = trades.filter(t => t.side === 'buy');
  const bought = new Map();
  const firstSlot = new Map();
  for (const t of buys) if (!firstSlot.has(t.wallet)) firstSlot.set(t.wallet, t.slot);
  // "Bought" = each wallet's peak position during the launch window, so buy-sell-buy flipping
  // isn't counted twice. Mints count toward the position (they're tokens the wallet controlled).
  const running = new Map();
  const ordered = trades.slice().sort((a, b) => a.slot - b.slot);
  for (const t of ordered) {
    if (t.side === 'lp') continue;
    const cur = (running.get(t.wallet) || 0) + (t.side === 'sell' ? -t.amount : t.side === 'buy' ? t.amount : 0);
    running.set(t.wallet, Math.max(0, cur));
    if (t.side === 'buy') bought.set(t.wallet, Math.max(bought.get(t.wallet) || 0, running.get(t.wallet)));
  }
  const sold = new Map();
  for (const t of trades.filter(t => t.side === 'sell')) sold.set(t.wallet, (sold.get(t.wallet) || 0) + t.amount);

  const earlyWallets = [...firstSlot.keys()];
  if (!earlyWallets.includes(deployer)) earlyWallets.unshift(deployer);
  const { groupOf } = clusters(earlyWallets, funders, deployer);
  const share = raw => Math.min(100, (raw / supply) * 100);
  const held = w => holdings.get(w) || 0;

  // Bundle: launch-block buyers + any early buyers sharing funding + the deployer's cluster
  const bundle = new Set(groupOf(deployer));
  for (const w of earlyWallets) {
    if (firstSlot.get(w) === creationSlot) bundle.add(w);
    if (groupOf(w).size >= 2) for (const x of groupOf(w)) bundle.add(x);
  }
  const bundleBought = share(sum([...bundle].map(w => bought.get(w) || 0)));
  const bundleHeld = share(sum([...bundle].map(held)));
  const devFunded = [...bundle].filter(w => w !== deployer && funders.get(w) && funders.get(w).funder === deployer).length;
  const bundleOthers = [...bundle].filter(w => w !== deployer && (bought.get(w) || 0) > 0).length;
  let bundleWire;
  if (!bundleOthers) {
    const devBuy = share(bought.get(deployer) || 0);
    bundleWire = { key: 'bundle', name: 'Bundle', tripped: false, items: [devBuy >= 0.05 ? `No linked wallets. Only the dev bought at launch (${pct(devBuy)} of supply), which the dev wire covers.` : 'No linked wallets bought in the launch block or with shared funding.'], brief: 'clear' };
  } else {
    const items = [
      `${bundle.size} linked wallets held up to ${pct(bundleBought)} of supply at launch (same block or shared funding).`,
      `They still hold ${pct(bundleHeld)}.`
    ];
    if (devFunded) items.push(`${devFunded} of them were funded directly by the deployer.`);
    const major = bundleBought >= T.bundleMajor;
    if (major) items.push(bundleHeld < 1 ? 'A bundle that grabbed over half the supply at launch, then sold out, is a classic pump-and-dump pattern.' : 'A bundle holding this much can move the price whenever it wants.');
    bundleWire = { key: 'bundle', name: 'Bundle', tripped: major || bundleHeld >= T.bundleHeld || (bundleBought >= T.bundleBought && bundleHeld >= T.bundleHeld / 2), items, brief: major ? `grabbed ${pct(bundleBought, 0)}` : `holds ${pct(bundleHeld, 0)}` };
  }

  // Sniper: outside wallets that bought within the first few blocks
  const snipers = earlyWallets.filter(w => !bundle.has(w) && firstSlot.has(w) && firstSlot.get(w) <= creationSlot + cfg.scan.sniperSlots);
  let sniperWire;
  if (!snipers.length) {
    sniperWire = { key: 'sniper', name: 'Sniper', tripped: false, items: [`No outside wallets bought in the first ${cfg.scan.sniperSlots} blocks.`], brief: 'clear' };
  } else {
    const sBought = sum(snipers.map(w => bought.get(w) || 0));
    const sHeld = sum(snipers.map(held));
    const soldShare = sBought ? Math.max(0, Math.min(100, (1 - sHeld / sBought) * 100)) : 0;
    sniperWire = {
      key: 'sniper', name: 'Sniper', tripped: share(sHeld) >= T.sniperHeld,
      items: [
        `${snipers.length === 1 ? '1 wallet' : snipers.length + ' wallets'} sniped ${pct(share(sBought))} of supply in the first ${cfg.scan.sniperSlots} blocks.`,
        `They still hold ${pct(share(sHeld))} (about ${pct(soldShare, 0)} already sold).`
      ],
      brief: `hold ${pct(share(sHeld), 0)}`
    };
  }

  // Dev: deployer's current holdings, selling, and past launches
  const devBought = bought.get(deployer) || 0;
  const devHeld = share(held(deployer));
  const items = [`Deployer ${short(deployer)} holds ${pct(devHeld)} of supply now.`];
  const devMinted = sum(trades.filter(t => t.side === 'mint' && t.wallet === deployer).map(t => t.amount));
  if (devMinted > 0) items.push(`Dev minted ${pct(share(devMinted))} of supply straight to their own wallet at launch (not a market buy).`);
  if (devBought > 0) items.push(held(deployer) < devBought * 0.5 ? `Dev has sold most of their launch buy (${pct(share(devBought))} of supply).` : `Dev still holds most of their launch buy.`);
  let tripped = devHeld >= T.devHeld;
  let brief = `holds ${pct(devHeld, 0)}`;
  if (launch.launchpad) items.push(`Launched through a launchpad account (${short(launch.launchpad)}); checking the creator who co-signed instead.`);
  if (launch.platform) {
    items.push('Created through a shared launchpad account that launches tokens for many people, so its history says nothing about this dev.');
  } else if (history) {
    const past = [...history.launches.entries()];
    const aged = past.filter(([, t]) => t && now - t > 86400);
    const recent = past.length - aged.length;
    const dead = aged.filter(([m]) => (history.liquidity.get(m) || 0) < T.deadLiqUsd);
    if (!past.length) items.push('No other launches found from this deployer.');
    else {
      const scope = history.capped ? ' in their recent history' : '';
      if (aged.length) {
        items.push(`Deployer launched ${past.length} other token${past.length === 1 ? '' : 's'}${scope}; ${dead.length} of the ${aged.length} older than a day ${dead.length === 1 ? 'is' : 'are'} dead (under ${usd(T.deadLiqUsd)} liquidity).`);
        brief = `${dead.length}/${aged.length} past dead`;
        if (aged.length >= T.devMinLaunches && (dead.length / aged.length) * 100 >= T.devDeadShare) tripped = true;
      } else {
        items.push(`Deployer launched ${past.length} other token${past.length === 1 ? '' : 's'} in the last day, too recent to judge how they ended.`);
        brief = `${past.length} recent launches`;
      }
      if (recent >= T.serialLaunches) { tripped = true; items.push(`That's ${recent} launches in under a day: a serial launcher.`); brief = `${recent} launches/day`; }
    }
  }
  const df = funders.get(deployer);
  if (df && df.firstTime && creationTime && creationTime - df.firstTime < 86400) items.push('Deployer wallet was created less than a day before launch.');
  const devWire = { key: 'dev', name: 'Dev history', tripped, items, brief };

  return { bundleWire, sniperWire, devWire };
}

/* ---------------- Flow wires: Agent, Wash ---------------- */
export function flowWires({ trades, decimals, priceUsd, fastWallets }) {
  const nt = trades.length;
  if (nt < T.minFlowTrades) {
    const why = nt ? `Only ${nt} trade${nt === 1 ? '' : 's'} in this coin's recent history, which is too little to judge.` : 'No trades found in this coin\'s recent history.';
    return { agentWire: na('agent', 'Agent', why), washWire: na('wash', 'Wash', why) };
  }
  const val = t => (t.amount / 10 ** decimals) * (priceUsd || 0) || t.amount; // fall back to raw size if price unknown
  const byWallet = new Map();
  for (const t of trades) {
    if (!byWallet.has(t.wallet)) byWallet.set(t.wallet, []);
    byWallet.get(t.wallet).push(t);
  }
  const total = sum(trades.map(val)) || 1;
  const weak = nt < T.lowFlowTrades ? `Low activity: only ${nt} trades to read, so treat this as a weak signal.` : `Based on the last ${nt} trades (estimate).`;

  // Agent: steady cadence, bursts, or a wallet that transacts ~1000+ times a day
  const agents = [];
  for (const [w, ts] of byWallet) {
    const times = ts.map(t => t.time).filter(Boolean).sort((a, b) => a - b);
    const gaps = times.slice(1).map((t, i) => t - times[i]).filter(g => g >= 0);
    const mean = gaps.length ? sum(gaps) / gaps.length : Infinity;
    const sd = gaps.length ? Math.sqrt(sum(gaps.map(g => (g - mean) ** 2)) / gaps.length) : Infinity;
    const steady = ts.length >= 4 && mean > 0 && sd / mean < 0.35;
    const burst = ts.length >= 6 && mean < 20;
    if (steady || burst || fastWallets.has(w)) agents.push(w);
  }
  const agentVol = sum(agents.flatMap(w => byWallet.get(w).map(val)));
  const agentShare = (agentVol / total) * 100;
  const agentWire = {
    key: 'agent', name: 'Agent', tripped: agentShare >= T.agentShare,
    items: [agents.length ? `${about(agentShare)} of recent volume came from ${agents.length === 1 ? '1 wallet that trades like a bot' : agents.length + ' wallets that trade like bots'}.` : `No bot-like trading in the last ${nt} trades.`, weak],
    brief: `~${pct(agentShare, 0)}`
  };

  // Wash: wallets buying and selling similar size back and forth
  const washers = [];
  for (const [w, ts] of byWallet) {
    const b = sum(ts.filter(t => t.side === 'buy').map(val));
    const s = sum(ts.filter(t => t.side === 'sell').map(val));
    const sameSlotFlip = ts.some(t => t.side === 'buy' && ts.some(u => u.side === 'sell' && u.slot === t.slot));
    if ((ts.length >= 4 && b > 0 && s > 0 && Math.min(b, s) / Math.max(b, s) >= 0.7) || sameSlotFlip) washers.push(w);
  }
  const washVol = sum(washers.flatMap(w => byWallet.get(w).map(val)));
  const washShare = (washVol / total) * 100;
  const washWire = {
    key: 'wash', name: 'Wash', tripped: washShare >= T.washShare,
    items: [washers.length ? `${about(washShare)} of recent volume is ${washers.length === 1 ? '1 wallet' : washers.length + ' wallets'} buying and selling the same size back and forth.` : `No wash trading in the last ${nt} trades.`, weak],
    brief: `~${pct(washShare, 0)} of vol`
  };
  return { agentWire, washWire };
}
