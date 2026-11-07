// Scan one token from the command line and print the X reply plus full details.
// Usage: npm run scan -- <TOKEN_MINT>
import { scan } from './scan.js';
import { replyText, xLength } from './format.js';
import { stats } from './rpc.js';

const mint = process.argv[2];
if (!mint) { console.error('Usage: npm run scan -- <TOKEN_MINT>'); process.exit(1); }
try {
  const r = await scan(mint);
  const text = replyText(r);
  console.log('\n--- X reply (' + xLength(text) + '/280) ---\n' + text + '\n');
  for (const c of r.checks) {
    console.log(`${c.na ? 'N/A    ' : c.tripped ? 'TRIPPED' : 'CLEAR  '}  ${c.name}`);
    for (const i of c.items) console.log('          ' + i);
  }
  console.log(`\nTook ${(r.tookMs / 1000).toFixed(1)}s, ${stats.calls} RPC calls in ${stats.requests} requests.`);
} catch (e) {
  console.error('Scan failed:', e.message);
  process.exit(1);
}
