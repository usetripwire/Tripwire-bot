import { cfg } from './config.js';
import { startServer } from './server.js';
import { log } from './util.js';

if (cfg.rpcUrl.includes('api.mainnet-beta.solana.com')) {
  log('WARNING: using the free public Solana RPC. Full scans need a paid RPC (set RPC_URL), or most lookups will be rate limited.');
}
if (!cfg.allowedOrigins.length) log('WARNING: ALLOWED_ORIGINS is empty, so any website can call this API. Set it to your domain.');

startServer();
