// Browser test for the Radar section with a mocked server and a mocked Phantom wallet.
const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');
const out = process.argv[2];
const BASE = 'http://127.0.0.1:8765';
const W = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const full = JSON.parse(fs.readFileSync(path.join(out, 'sample-result.json'), 'utf8'));
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
const wires = (trip) => ['bundle', 'sniper', 'dev', 'agent', 'wash', 'exit', 'authority', 'holders'].map((k, i) => ({ key: k, name: k, tripped: trip && i < 3, na: false, brief: '' }));
const entry = (o) => ({ mint: o.mint, name: o.name, symbol: o.symbol, image: '', detectedAt: Date.now() - 9e5, scannedAt: o.at, trips: o.trip ? 3 : 0, ran: 8, clean: !o.trip, wires: wires(o.trip), liquidity: 52000, marketCap: 410000, url: 'https://dexscreener.com/solana/x' });
const cleanOld = entry({ mint: '7xKqTr1pWzTestMintHv9bRnZ3hJ5cD8fG2sA4Lpump', name: 'Clean Coin', symbol: 'CLEAN', at: Date.now() - 20 * 60e3 });
const trippedNew = entry({ mint: 'Bad1Mint9xKqWv7bRnZ3hJ5cD8fG2sA4LTrippump', name: 'Rug Coin', symbol: 'RUG', at: Date.now() - 60e3, trip: true });

async function setup(ctx, withWallet) {
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await ctx.route(BASE + '/config.js', route => {
    const src = fs.readFileSync(path.join(process.argv[3], 'config.js'), 'utf8')
      .replace(/apiUrl: "[^"]*"/, 'apiUrl: "https://api.tripwire.test"')
      .replace(/rpcUrl: "[^"]*"/, 'rpcUrl: "https://api.mainnet-beta.solana.com"');
    route.fulfill({ status: 200, contentType: 'application/javascript', body: src });
  });
  await ctx.route(/api\.tripwire\.test/, async route => {
    const req = route.request(), u = new URL(req.url());
    const json = (o, s = 200) => route.fulfill({ status: s, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(o) });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (u.pathname === '/api/radar/nonce') return json({ nonce: 'n1', message: 'Tripwire Radar sign-in' });
    if (u.pathname === '/api/radar/session') return json({ token: 'tok', wallet: W, exp: Date.now() + 864e5, holder: true, balance: 150000 });
    if (u.pathname === '/api/radar/feed') {
      if ((req.headers()['authorization'] || '') === 'Bearer tok') return json({ mode: 'live', entries: [trippedNew, cleanOld], gate: { signedIn: true, holder: true, wallet: W, balance: 150000, minHold: 100000, tokenLive: true } });
      return json({ mode: 'preview', delayMinutes: 15, entries: [cleanOld], lockedCount: 5, gate: { signedIn: false, holder: false, minHold: 100000, tokenLive: false } });
    }
    if (u.pathname === '/api/scan') return json(full);
    return json({ error: 'not_found' }, 404);
  });
  if (withWallet) await ctx.addInitScript(() => {
    window.phantom = { solana: {
      connect: async () => ({ publicKey: { toString: () => '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' } }),
      signMessage: async () => ({ signature: new Uint8Array(64).fill(7) }),
      disconnect: async () => {}
    } };
  });
}

(async () => {
  const b = await chromium.launch();
  const results = [], errors = [];
  const ok = (n, v) => results.push([n, !!v]);

  const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  await setup(ctx, true);
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(e.message));
  await p.goto(BASE + '/');
  await p.waitForSelector('#radar .radar-item', { timeout: 10000 });
  let txt = await p.textContent('#radar');
  ok('nav has Radar, no Watch', (await p.$('#nav-links a[href="#radar"]')) && !(await p.$('#nav-links a[href="#watch"]')));
  ok('no Watch section left on the page', !(await p.$('#watch')) && !/Tripwire Watch/.test(await p.textContent('body')));
  ok('preview mode before sign-in', txt.includes('Preview mode') && txt.includes('Opens at $TRIP launch'));
  ok('preview shows the 1 delayed clean coin', (await p.$$('#radar .radar-item')).length === 1 && txt.includes('Clean Coin'));
  ok('locked count shown', txt.includes('5 more results are in the live feed'));
  ok('clean-only toggle locked in preview', await p.isDisabled('#radar-clean'));
  await p.locator('#radar').screenshot({ path: path.join(out, 'radar-preview.png') });

  await p.click('#radar-connect');
  await p.waitForFunction(() => document.querySelector('#radar-gate-title').textContent.includes('Live feed unlocked'), null, { timeout: 10000 });
  txt = await p.textContent('#radar');
  ok('holder sign-in unlocks live feed', txt.includes('150,000 $TRIP'));
  ok('live feed shows both coins, tripped one too', (await p.$$('#radar .radar-item')).length === 2 && txt.includes('Rug Coin') && txt.includes('TRIPPED · 3 OF 8'));
  ok('pill switches to Live', (await p.textContent('#radar-pill')).includes('Live'));
  ok('session kept in this browser', await p.evaluate(() => !!localStorage.getItem('tw_radar_session')));
  await p.check('#radar-clean');
  ok('clean-only filter hides the tripped coin', (await p.$$('#radar .radar-item')).length === 1);
  await p.uncheck('#radar-clean');
  await p.locator('#radar').screenshot({ path: path.join(out, 'radar-live.png') });

  await p.locator('#radar .radar-item', { hasText: 'Rug Coin' }).getByRole('button', { name: 'Full scan' }).click();
  await p.waitForSelector('#result .r-head', { timeout: 10000 });
  ok('Full scan button runs the 8-wire scan up top', (await p.$$('#result .check')).length === 8);

  await p.reload();
  await p.waitForFunction(() => document.querySelector('#radar-gate-title').textContent.includes('Live feed unlocked'), null, { timeout: 10000 });
  ok('still signed in after reload', true);
  await p.getByRole('button', { name: 'Disconnect' }).click();
  await p.waitForFunction(() => document.querySelector('#radar-gate-title').textContent.includes('Preview mode'), null, { timeout: 10000 });
  ok('disconnect returns to preview', true);

  // iPhone Safari: no wallet in the browser
  const m = await b.newContext({ ...devices['iPhone 13'] });
  await setup(m, false);
  const mp = await m.newPage();
  mp.on('pageerror', e => errors.push(e.message));
  await mp.goto(BASE + '/#radar');
  await mp.waitForSelector('#radar .radar-item', { timeout: 10000 });
  await mp.click('#radar-connect');
  ok('iPhone offers Open in Phantom / Solflare', (await mp.getAttribute('#radar-gate a:has-text("Open in Phantom")', 'href')).startsWith('https://phantom.app/ul/browse/') && !!(await mp.$('#radar-gate a:has-text("Open in Solflare")')));
  ok('no sideways scroll on phone', (await mp.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0);
  await mp.locator('#radar').screenshot({ path: path.join(out, 'radar-mobile.png') });

  await b.close();
  results.forEach(([n, v]) => console.log((v ? 'PASS ' : 'FAIL ') + n));
  console.log('page errors:', errors.length ? errors : 'none');
})();
