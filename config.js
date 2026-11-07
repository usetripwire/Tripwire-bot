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

  enableBot: bool('ENABLE_BOT', false),
  dryRun: bool('DRY_RUN', true),          // true = log replies instead of posting
  replyBacklog: bool('REPLY_BACKLOG', false),
  // X charges far more for posts containing a link, so replies are link-free unless REPLY_LINK=true
  replyLink: bool('REPLY_LINK', false),
  pollSeconds: num('POLL_SECONDS', 20),
  statePath: path.resolve(root, env('STATE_PATH', './data/state.json')),
  x: {
    apiKey: env('X_API_KEY', ''),
    apiSecret: env('X_API_SECRET', ''),
    accessToken: env('X_ACCESS_TOKEN', ''),
    accessSecret: env('X_ACCESS_SECRET', ''),
    apiBase: env('X_API_BASE', 'https://api.x.com')
  },

  limits: {
    scansPerUserPerHour: num('SCANS_PER_USER_PER_HOUR', 5),
    apiPerIpPerMinute: num('API_PER_IP_PER_MINUTE', 6),
    concurrentScans: num('CONCURRENT_SCANS', 3)
  },

  // How much on-chain history each scan reads. Higher = more accurate, more RPC credits.
  scan: {
    mintSigPages: num('MINT_SIG_PAGES', 20),        // x1000 signatures to walk back to the launch
    earlyTxs: num('EARLY_TXS', 100),                // launch transactions analysed
    sniperSlots: num('SNIPER_SLOTS', 3),            // blocks after creation that count as sniping
    fundingChecks: num('FUNDING_CHECKS', 30),       // early buyers whose funding we trace
    devHistoryTxs: num('DEV_HISTORY_TXS', 150),     // deployer transactions searched for past launches
    recentTxs: num('RECENT_TXS', 120),              // recent pool transactions for agent + wash
    agentWalletChecks: num('AGENT_WALLET_CHECKS', 12),
    rpcConcurrency: num('RPC_CONCURRENCY', 6),
    cacheMinutes: num('CACHE_MINUTES', 10)
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
    minFlowTrades: num('T_MIN_FLOW_TRADES', 15),
    top10: num('T_TOP10', 30),
    single: num('T_SINGLE', 10),
    minLiqUsd: num('T_MIN_LIQ_USD', 10000),
    sellUsd: num('T_SELL_USD', 1000),
    maxSlip: num('T_MAX_SLIP', 10)
  }
};
