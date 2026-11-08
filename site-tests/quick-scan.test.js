// Browser test for the Tripwire site with mocked Solana RPC + DexScreener.
// Mock values below are test fixtures only; they are not part of the site.
const { chromium } = require('playwright');
const path = require('path');
const out = process.argv[2];
const BASE = 'http://127.0.0.1:8765';
const MINT = '7xKqTr1pWzTestMintHv9bRnZ3hJ5cD8fG2sA4Lpump';
const WALLET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const POOL = 'PooLAddrXyz9bRnZ3hJ5cD8fG2sA4Lqq7xKqTr1pWz';
const TOKENKEG = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const supply = '1000000000000000';
const amounts = [400, 92, 61, 44, 30, 25, 21, 18, 15, 12, 10, 9]; // per 1000 of supply
const largest = amounts.map((a, i) => ({ address: 'TokAcct' + i + 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'.slice(0, 32), amount: String(a * 1e12), decimals: 6 }));
const owners = largest.map((_, i) => i === 0 ? POOL : 'Own' + i + 'erWa11etxxxxxxxxxxxxxxxxxxxxxxxxxxxx'.slice(0, 32));
let mode = 'ok';
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST, GET, OPTIONS' };

(async () => {
  const b = await chromium.launch();
  const results = [];
  const errors = [];
  async function setup(ctx) {
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
    await ctx.route(/api\.mainnet-beta\.solana\.com/, async route => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (mode === 'ratelimit') return route.fulfill({ status: 429, headers: cors, body: 'Too many requests' });
      const body = JSON.parse(req.postData());
      let result;
      if (body.method === 'getAccountInfo') {
        const addr = body.params[0];
        if (addr === WALLET) result = { context: { slot: 1 }, value: { owner: '11111111111111111111111111111111', lamports: 1, data: ['', 'base64'] } };
        else result = { context: { slot: 1 }, value: { owner: TOKENKEG, data: { program: 'spl-token', parsed: { type: 'mint', info: { decimals: 6, supply, mintAuthority: null, freezeAuthority: 'FrzAuth1111xxxxxxxxxxxxxxxxxxxxxxxxxxxxx', isInitialized: true } } } } };
      } else if (body.method === 'getTokenLargestAccounts') {
        result = { context: { slot: 1 }, value: largest };
      } else if (body.method === 'getMultipleAccounts') {
        result = { context: { slot: 1 }, value: owners.map(o => ({ data: { parsed: { info: { owner: o } } } })) };
      }
      route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result }) });
    });
    await ctx.route(/api\.dexscreener\.com/, route => route.fulfill({
      status: 200, headers: { ...cors, 'content-type': 'application/json' },
      body: JSON.stringify({ schemaVersion: '1.0.0', pairs: [{ chainId: 'solana', dexId: 'pumpswap', url: 'https://dexscreener.com/solana/test', pairAddress: POOL, baseToken: { address: MINT, name: 'Test Coin <b>x</b>', symbol: 'TEST' }, priceUsd: '0.0004521', txns: { h24: { buys: 1820, sells: 1404 } }, volume: { h24: 912000 }, liquidity: { usd: 48200 }, marketCap: 452000, pairCreatedAt: Date.now() - 5 * 3600e3, info: {} }] })
    }));
  }

  // Desktop
  const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  await setup(ctx);
  const p = await ctx.newPage();
  p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  p.on('pageerror', e => errors.push(e.message));
  await p.goto(BASE + '/');

  // 1. invalid input
  await p.fill('#ca', 'not-an-address');
  await p.click('#scan-btn');
  results.push(['invalid input message', (await p.textContent('#ca-error')).includes("doesn't look like")]);

  // 2. wallet instead of mint
  await p.fill('#ca', WALLET);
  await p.click('#scan-btn');
  await p.waitForSelector('#result .placeholder', { timeout: 10000 });
  await p.waitForFunction(() => document.querySelector('#result').getAttribute('aria-busy') === 'false');
  results.push(['wallet rejected', (await p.textContent('#result')).includes("isn't a token mint")]);

  // 3. good scan
  await p.fill('#ca', MINT);
  await p.click('#scan-btn');
  await p.waitForSelector('#result .r-head', { timeout: 10000 });
  const txt = await p.textContent('#result');
  results.push(['verdict tripped 2 of 3', txt.includes('TRIPPED · 2 OF 3')]);
  results.push(['freeze authority flagged', txt.includes('Freeze authority is active')]);
  results.push(['pool excluded from holders', txt.includes('40.0% of supply sits in trading pools')]);
  results.push(['top10 computed (32.8%)', txt.includes('Top 10 wallets hold 32.8%')]);
  results.push(['exit clear at $48k liq', /Exit wire\s*CLEAR/.test(txt)]);
  results.push(['token name rendered as text, not HTML', (await p.$$('#result .r-name b')).length === 0 && txt.includes('Test Coin <b>x</b>')]);
  results.push(['url updated with ?ca=', p.url().includes('?ca=' + MINT)]);
  const share = await p.getAttribute('#result a[href^="https://x.com/intent"]', 'href');
  results.push(['share link present', !!share && decodeURIComponent(share).includes('$TEST')]);
  await p.locator('#scan').screenshot({ path: path.join(out, 'shot-desktop-scan.png') });
  await p.screenshot({ path: path.join(out, 'shot-desktop-full.png'), fullPage: true });

  // 4. rate limited
  mode = 'ratelimit';
  await p.fill('#ca', MINT);
  await p.click('#scan-btn');
  await p.waitForFunction(() => document.querySelector('#result').textContent.includes('rate limiting'), null, { timeout: 10000 });
  results.push(['rate limit message', true]);
  mode = 'ok';

  // 5. deep link auto-scan
  const p2 = await ctx.newPage();
  p2.on('pageerror', e => errors.push(e.message));
  await p2.goto(BASE + '/?ca=' + MINT);
  await p2.waitForSelector('#result .r-head', { timeout: 10000 });
  results.push(['deep link auto-scans', true]);

  // Mobile
  const m = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await setup(m);
  const mp = await m.newPage();
  mp.on('pageerror', e => errors.push(e.message));
  await mp.goto(BASE + '/?ca=' + MINT);
  await mp.waitForSelector('#result .r-head', { timeout: 10000 });
  const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  results.push(['no horizontal scroll on phone (' + overflow + 'px)', overflow <= 0]);
  await mp.click('.menu-btn');
  results.push(['mobile menu opens', await mp.isVisible('#nav-links a[href="#radar"]')]);
  await mp.click('.menu-btn');
  await mp.screenshot({ path: path.join(out, 'shot-mobile.png'), fullPage: false });
  await mp.evaluate(() => document.querySelector('#result').scrollIntoView());
  await mp.screenshot({ path: path.join(out, 'shot-mobile-result.png') });

  // Other pages
  for (const pg of ['/terms.html', '/privacy.html', '/404.html']) {
    const r = await p.goto(BASE + pg);
    results.push([pg + ' loads', r.status() === 200]);
  }

  await b.close();
  results.forEach(([n, ok]) => console.log((ok ? 'PASS ' : 'FAIL ') + n));
  console.log('console errors:', errors.filter(e => !/fonts|ERR_FAILED|net::/.test(e)).length ? errors : 'none');
})();
