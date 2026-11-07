// Scan one token from the command line and print every wire.
// Usage: npm run scan -- <TOKEN_MINT>
import { scan } from './scan.js';
import { stats } from './rpc.js';

const mint = process.argv[2];
if (!mint) { console.error('Usage: npm run scan -- <TOKEN_MINT>'); process.exit(1); }
try {
  const r = await scan(mint);
  const ran = r.checks.filter(c => !c.na);
  console.log(`\n${r.token.symbol ? '$' + r.token.symbol : r.token.name}: ${ran.filter(c => c.tripped).length} of ${ran.length} wires tripped\n`);
  for (const c of r.checks) {
    console.log(`${c.na ? 'N/A    ' : c.tripped ? 'TRIPPED' : 'CLEAR  '}  ${c.name}`);
    for (const i of c.items) console.log('          ' + i);
  }
  console.log(`\nTook ${(r.tookMs / 1000).toFixed(1)}s, ${stats.calls} RPC calls in ${stats.requests} requests.`);
} catch (e) {
  console.error('Scan failed:', e.message);
  process.exit(1);
}
