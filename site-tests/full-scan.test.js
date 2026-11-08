// Browser test of the site's full-scan mode (config.apiUrl set) and its fallback.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const out = process.argv[2];
const siteDir = process.argv[3];
const BASE = 'http://127.0.0.1:8765';
const MINT = '7xKqTr1pWzTestMintHv9bRnZ3hJ5cD8fG2sA4Lpump';
const API = 'https://api.tripwire.test';
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' };
const fullResult = JSON.parse(fs.readFileSync(path.join(out, 'sample-result.json'), 'utf8'));
let apiMode = 'ok';

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  const results = [], errors = [];
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await ctx.route(BASE + '/config.js', async route => {
    const src = fs.readFileSync(path.join(siteDir, 'config.js'), 'utf8').replace('apiUrl: ""', `apiUrl: "${API}"`);
    route.fulfill({ status: 200, contentType: 'application/javascript', body: src });
  });
  await ctx.route(/api\.tripwire\.test/, route => {
    if (apiMode === 'busy') return route.fulfill({ status: 503, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ error: 'busy', message: 'busy' }) });
    if (apiMode === 'down') return route.fulfill({ status: 503, headers: cors, body: '{}' });
    if (apiMode === 'notmint') return route.fulfill({ status: 422, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ error: 'not_mint', message: 'That address is not a Solana token mint.' }) });
    route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(fullResult) });
  });
  // Quick-scan fallback data
  await ctx.route(/api\.mainnet-beta\.solana\.com/, async route => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-methods': 'POST' } });
    const body = JSON.parse(req.postData());
    let result;
    if (body.method === 'getAccountInfo') result = { value: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: { parsed: { type: 'mint', info: { decimals: 6, supply: '1000000000000000', mintAuthority: null, freezeAuthority: null } } } } };
    else if (body.method === 'getTokenLargestAccounts') result = { value: [{ address: 'acc1', amount: '50000000000000' }, { address: 'acc2', amount: '20000000000000' }] };
    else if (body.method === 'getMultipleAccounts' && body.params[1].encoding === 'jsonParsed') result = { value: [{ data: { parsed: { info: { owner: 'LockerVau1t' } } } }, { data: { parsed: { info: { owner: 'Wa11etOne' } } } }] };
    else if (body.method === 'getMultipleAccounts') result = { value: [{ owner: 'LockerProgram111' }, { owner: '11111111111111111111111111111111' }] };
    route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result }) });
  });
  await ctx.route(/api\.dexscreener\.com/, route => route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ pairs: [{ chainId: 'solana', dexId: 'pumpswap', pairAddress: 'Poo1', baseToken: { address: MINT, name: 'Test Coin', symbol: 'TEST' }, liquidity: { usd: 48200 }, priceUsd: '0.0004' }] }) }));

  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(e.message));
  await p.goto(BASE + '/');
  results.push(['"With X bot" labels flip to Live', (await p.$$eval('[data-full-pill]', els => els.every(e => e.textContent.includes('Live now')))) ]);
  results.push(['placeholder says eight wires', (await p.textContent('#result')).includes('Eight wires')]);

  await p.fill('#ca', MINT);
  await p.click('#scan-btn');
  await p.waitForSelector('#result .r-head', { timeout: 10000 });
  let txt = await p.textContent('#result');
  results.push(['full scan shows 8 wires', (await p.$$('#result .check')).length === 8]);
  results.push(['verdict TRIPPED 4 OF 8', txt.includes('TRIPPED · 4 OF 8')]);
  results.push(['bundle detail shown', txt.includes('linked wallets bought')]);
  results.push(['full-scan footnote', txt.includes('Automated estimates from on-chain data')]);
  await p.locator('#scan').screenshot({ path: path.join(out, 'shot-full-scan.png') });

  apiMode = 'notmint';
  await p.fill('#ca', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
  await p.click('#scan-btn');
  await p.waitForFunction(() => document.querySelector('#result').textContent.includes('not a Solana token mint'), null, { timeout: 10000 });
  results.push(['not-a-mint from API shown', true]);

  apiMode = 'down';
  await p.fill('#ca', MINT);
  await p.click('#scan-btn');
  await p.waitForFunction(() => document.querySelector('#result').textContent.includes('Quick Scan only'), null, { timeout: 15000 });
  txt = await p.textContent('#result');
  results.push(['falls back to Quick Scan when API is down', (await p.$$('#result .check')).length === 3]);
  results.push(['program-owned holder excluded (5% locker)', txt.includes('5.0% is held by programs') && txt.includes('Top 10 wallets hold 2.0%')]);

  apiMode = 'busy';
  await p.fill('#ca', MINT);
  await p.click('#scan-btn');
  await p.waitForFunction(() => document.querySelector('#result').textContent.includes('full scans are busy'), null, { timeout: 15000 });
  results.push(['busy server: Quick Scan with busy note', (await p.$$('#result .check')).length === 3]);

  await b.close();
  results.forEach(([n, ok]) => console.log((ok ? 'PASS ' : 'FAIL ') + n));
  console.log('page errors:', errors.length ? errors : 'none');
})();
