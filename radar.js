// Tripwire Radar: finds coins graduating from pump.fun, waits for some trading,
// runs the full scan, and keeps a feed of results.
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';
import { sigsFor, getTxs } from './rpc.js';
import { pairsFor } from './dex.js';
import { scan } from './scan.js';
import { log } from './util.js';

const R = cfg.radar;
const WSOL = 'So11111111111111111111111111111111111111112';

function load() {
  try { return JSON.parse(fs.readFileSync(R.storePath, 'utf8')); } catch { return { entries: [], lastSig: null }; }
}
let store = load();
const seen = new Set(store.entries.map(e => e.mint));
const queue = [];
let scanTimes = [];
const stats = { detected: 0, scanned: 0, skipped: 0, since: Date.now() };

function save() {
  try {
    fs.mkdirSync(path.dirname(R.storePath), { recursive: true });
    fs.writeFileSync(R.storePath + '.tmp', JSON.stringify(store));
    fs.renameSync(R.storePath + '.tmp', R.storePath);
  } catch (e) { log('radar save failed', e.message); }
}

export function enqueue(mint, sig, now = Date.now()) {
  if (!mint || mint === WSOL || seen.has(mint) || queue.some(q => q.mint === mint)) return false;
  queue.push({ mint, sig, detectedAt: now });
  stats.detected++;
  if (queue.length > 500) queue.shift();
  return true;
}

// Token mints touched by a graduation transaction (the LP mint has no pool and gets filtered later).
export function mintsFromTx(tx) {
  if (!tx || !tx.meta || tx.meta.err) return [];
  const logs = (tx.meta.logMessages || []).join('\n').toLowerCase();
  if (!logs.includes(R.logMatch.toLowerCase())) return [];
  const all = [...(tx.meta.postTokenBalances || []), ...(tx.meta.preTokenBalances || [])].map(b => b.mint);
  return [...new Set(all)].filter(m => m && m !== WSOL);
}

// Read new transactions on the migration account since the last poll.
export async function pollOnce(now = Date.now()) {
  const sigs = await sigsFor(R.watchAccount, { limit: 100 });
  if (!sigs.length) return 0;
  if (!store.lastSig) { store.lastSig = sigs[0].signature; save(); return 0; } // first run: start from now
  const fresh = [];
  for (const s of sigs) { if (s.signature === store.lastSig) break; if (!s.err) fresh.push(s.signature); }
  store.lastSig = sigs[0].signature;
  save();
  if (!fresh.length) return 0;
  const txs = await getTxs(fresh.reverse());
  let added = 0, grads = 0;
  for (let i = 0; i < txs.length; i++) {
    const ms = mintsFromTx(txs[i]);
    if (ms.length) grads++;
    for (const m of ms) if (enqueue(m, fresh[i], now)) added++;
  }
  stats.graduations = (stats.graduations || 0) + grads;
  if (grads) log(`Radar: ${grads} graduation tx(s) in ${fresh.length} new, ${added} mint(s) queued`);
  return added;
}

function toEntry(r, q) {
  const ran = r.checks.filter(c => !c.na);
  const trips = ran.filter(c => c.tripped).length;
  return {
    mint: r.mint, name: r.token.name, symbol: r.token.symbol, image: r.token.image,
    detectedAt: q.detectedAt, scannedAt: Date.now(), trips, ran: ran.length, clean: trips === 0,
    wires: r.checks.map(c => ({ key: c.key, name: c.name, tripped: !!c.tripped, na: !!c.na, brief: c.brief })),
    liquidity: r.pair && r.pair.liquidity ? r.pair.liquidity.usd : null,
    marketCap: r.pair ? r.pair.marketCap || r.pair.fdv || null : null,
    url: r.pair ? r.pair.url || null : null
  };
}

// Scan queued coins once they've traded for a bit, within the hourly budget.
export async function processQueue(now = Date.now()) {
  scanTimes = scanTimes.filter(t => now - t < 3600e3);
  const ready = queue.filter(q => now - q.detectedAt >= R.scanDelaySec * 1000);
  for (const q of ready) {
    if (scanTimes.length >= R.maxScansPerHour) break;
    queue.splice(queue.indexOf(q), 1);
    seen.add(q.mint);
    try {
      const pairs = await pairsFor(q.mint);
      const liq = (pairs[0] && pairs[0].liquidity && pairs[0].liquidity.usd) || 0;
      if (liq < R.minLiqUsd) { stats.skipped++; continue; }
      log(`Radar scanning ${q.mint} (liq $${Math.round(liq)})`);
      scanTimes.push(now);
      const r = await scan(q.mint, { background: true });
      store.entries.unshift(toEntry(r, q));
      store.entries = store.entries.slice(0, R.keep);
      stats.scanned++;
      save();
      log(`Radar added ${r.token.symbol || q.mint}: ${store.entries[0].trips}/${store.entries[0].ran} tripped`);
    } catch (e) {
      log('radar scan failed', q.mint, e.message);
    }
  }
}

// What a viewer gets: holders see everything live; others see a delayed clean preview.
export function feed({ holder }, now = Date.now()) {
  if (holder) return { mode: 'live', entries: store.entries.slice(0, 100) };
  const delay = R.publicDelayMin * 60e3;
  const old = store.entries.filter(e => now - e.scannedAt >= delay);
  return {
    mode: 'preview',
    delayMinutes: R.publicDelayMin,
    entries: R.publicLimit > 0 ? old.filter(e => e.clean).slice(0, R.publicLimit) : [],
    lockedCount: store.entries.length - Math.min(R.publicLimit, old.filter(e => e.clean).length)
  };
}

export const radarInfo = () => ({ enabled: R.enabled, minHold: R.minHold, tokenLive: !!R.tripMint, queued: queue.length, ...stats });

// Test helper
export function _reset() { store = { entries: [], lastSig: null }; seen.clear(); queue.length = 0; scanTimes = []; }

export function startRadar() {
  if (!R.enabled) { log('Radar disabled (RADAR_ENABLED=false).'); return; }
  log(`Radar on: watching ${R.watchAccount} every ${R.pollSeconds}s, up to ${R.maxScansPerHour} scans/hour.`);
  const tick = async () => {
    try { await pollOnce(); } catch (e) { log('radar poll failed', e.message); }
    try { await processQueue(); } catch (e) { log('radar queue failed', e.message); }
  };
  tick();
  setInterval(tick, R.pollSeconds * 1000);
  setInterval(() => {
    log(`Radar last 15 min: ${stats.graduations || 0} graduations, ${stats.detected} mints queued, ${stats.scanned} scanned, ${stats.skipped} skipped (low liquidity or no pool), ${queue.length} waiting, ${store.entries.length} in feed.`);
    stats.detected = stats.scanned = stats.skipped = stats.graduations = 0;
  }, 900e3);
}
