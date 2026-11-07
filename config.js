// Settings come from environment variables (or a .env file next to package.json).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

function loadEnvFile() {
  try {
    const text = fs.readFileSync(path.join(root, '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env file: fine */ }
}
loadEnvFile();

const env = (k, d) => (process.env[k] != null && process.env[k] !== '' ? process.env[k] : d);
const num = (k, d) => Number(env(k, d));
const bool = (k, d) => String(env(k, d)) === 'true';

export const cfg = {
  root,
  rpcUrl: env('RPC_URL', 'https://api.mainnet-beta.solana.com'),
  siteUrl: env('SITE_URL', 'https://tripwire.example').replace(/\/$/, ''),
  port: num('PORT', 8080),
  allowedOrigins: env('ALLOWED_ORIGINS', '').split(',').map(s => s.trim()).filter(Boolean),


  limits: {
    apiPerIpPerMinute: num('API_PER_IP_PER_MINUTE', 6),
    feedPerIpPerMinute: num('FEED_PER_IP_PER_MINUTE', 30),
    concurrentScans: num('CONCURRENT_SCANS', 3)
  },

  // How much on-chain history each scan reads. Higher = more accurate, more RPC credits.
  scan: {
    mintSigPages: num('MINT_SIG_PAGES', 60),        // x1000 signatures to walk back to the launch
    earlyTxs: num('EARLY_TXS', 60),                // launch transactions analysed
    sniperSlots: num('SNIPER_SLOTS', 3),            // blocks after creation that count as sniping
    fundingChecks: num('FUNDING_CHECKS', 15),       // early buyers whose funding we trace
    devHistoryTxs: num('DEV_HISTORY_TXS', 60),     // deployer transactions searched for past launches
    recentTxs: num('RECENT_TXS', 60),              // recent pool transactions for agent + wash
    recentTxsMax: num('RECENT_TXS_MAX', 180),     // read further back when a coin trades slowly
    agentWalletChecks: num('AGENT_WALLET_CHECKS', 6),
    rpcConcurrency: num('RPC_CONCURRENCY', 4),
    rpcRps: num('RPC_RPS', 5),                       // requests per second (Helius free plan allows ~10)
    rpcBatch: bool('RPC_BATCH', true),              // set false if your RPC plan rejects batch requests
    batchSize: num('RPC_BATCH_SIZE', 5),
    cacheMinutes: num('CACHE_MINUTES', 10)
  },

  // Tripwire Radar: auto-scans pump.fun graduations; real-time feed for $TRIP holders
  radar: {
    enabled: bool('RADAR_ENABLED', true),
    tripMint: env('TRIP_MINT', ''),                       // $TRIP mint address (empty until launch)
    minHold: num('RADAR_MIN_HOLD', 100000),              // $TRIP needed for real-time access
    allowWallets: env('RADAR_ALLOW_WALLETS', '').split(',').map(s => s.trim()).filter(Boolean), // testers
    sessionSecret: env('SESSION_SECRET', ''),
    watchAccount: env('RADAR_WATCH_ACCOUNT', '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg'), // pump.fun migration account
    logMatch: env('RADAR_LOG_MATCH', 'migrate'),        // log text that marks a graduation
    pollSeconds: num('RADAR_POLL_SECONDS', 30),
    scanDelaySec: num('RADAR_SCAN_DELAY_SEC', 120),     // wait for some trading before scanning
    maxScansPerHour: num('RADAR_MAX_SCANS_PER_HOUR', 4),
    minLiqUsd: num('RADAR_MIN_LIQ_USD', 15000),         // skip coins with less pool liquidity
    publicDelayMin: num('RADAR_PUBLIC_DELAY_MIN', 15),
    publicLimit: num('RADAR_PUBLIC_LIMIT', 3),
    keep: num('RADAR_KEEP', 300),
    storePath: path.resolve(root, env('RADAR_STORE_PATH', './data/radar.json'))
  },

  // Trip thresholds (percent of supply unless noted)
  t: {
    bundleHeld: num('T_BUNDLE_HELD', 10),
    bundleBought: num('T_BUNDLE_BOUGHT', 25),
    sniperHeld: num('T_SNIPER_HELD', 10),
    devHeld: num('T_DEV_HELD', 10),
    devMinLaunches: num('T_DEV_MIN_LAUNCHES', 3),
    devDeadShare: num('T_DEV_DEAD_SHARE', 60),     // % of past launches dead
    deadLiqUsd: num('T_DEAD_LIQ_USD', 1000),
    agentShare: num('T_AGENT_SHARE', 50),          // % of recent volume
    washShare: num('T_WASH_SHARE', 30),            // % of recent volume
    minFlowTrades: num('T_MIN_FLOW_TRADES', 5),
    lowFlowTrades: num('T_LOW_FLOW_TRADES', 15),      // below this, agent/wash carry a weak-signal note
    platformLaunches: num('T_PLATFORM_LAUNCHES', 15), // a 'deployer' with this many launches is a launchpad account
    serialLaunches: num('T_SERIAL_LAUNCHES', 5),      // a real dev with this many very recent launches is a serial launcher
    top10: num('T_TOP10', 30),
    single: num('T_SINGLE', 10),
    minLiqUsd: num('T_MIN_LIQ_USD', 10000),
    sellUsd: num('T_SELL_USD', 1000),
    maxSlip: num('T_MAX_SLIP', 10)
  }
};
