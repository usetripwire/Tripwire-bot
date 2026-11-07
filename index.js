import { cfg } from './config.js';
import { startServer } from './server.js';
import { startRadar } from './radar.js';
import { runSelfTest } from './selftest.js';
import { log } from './util.js';

if (cfg.rpcUrl.includes('api.mainnet-beta.solana.com')) {
  log('WARNING: using the free public Solana RPC. Full scans need a paid RPC (set RPC_URL), or most lookups will be rate limited.');
}
if (!cfg.allowedOrigins.length) log('WARNING: ALLOWED_ORIGINS is empty, so any website can call this API. Set it to your domain.');

if (!cfg.radar.sessionSecret) log('WARNING: SESSION_SECRET is not set, so Radar sign-ins reset when the server restarts.');
startServer();
startRadar();
const selftest = Number(process.env.SELFTEST_COUNT || 0);
if (selftest > 0) setTimeout(() => runSelfTest(selftest).catch(e => log('SELFTEST failed', e.message)), 5000);
