// Launch mode: config.tokenCA set -> token section, roadmap, footer go live.
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const [out, siteDir] = process.argv.slice(2);
const BASE = 'http://127.0.0.1:8765';
const CA = '7xKqTr1pWzTestMintHv9bRnZ3hJ5cD8fG2sA4Lpump';
(async () => {
  const b = await chromium.launch();
  const results = [], errors = [];
  for (const [label, opts] of [['desktop', { viewport: { width: 1440, height: 1000 } }], ['phone', { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true }]]) {
    const ctx = await b.newContext({ ...opts, deviceScaleFactor: 1 });
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
    await ctx.route(/helius|mainnet-beta|dexscreener|railway/, r => r.abort());
    await ctx.route(BASE + '/config.js', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(siteDir, 'config.js'), 'utf8').replace('tokenCA: ""', `tokenCA: "${CA}"`) }));
    const p = await ctx.newPage();
    p.on('pageerror', e => errors.push(e.message));
    await p.goto(BASE + '/');
    await p.waitForSelector('#token-ca:not([hidden])', { timeout: 5000 }).catch(() => {});
    const box = await p.textContent('#token-ca').catch(() => '');
    results.push([label + ': CA box shown', box.includes(CA)]);
    results.push([label + ': pill says Live', (await p.textContent('#token-pill')).includes('Live')]);
    results.push([label + ': pump.fun buy link', !!(await p.$(`#token-ca a[href="https://pump.fun/coin/${CA}"]`))]);
    results.push([label + ': chart + scan links', !!(await p.$(`#token-ca a[href="https://dexscreener.com/solana/${CA}"]`)) && !!(await p.$(`#token-ca a[href="?ca=${CA}#scan"]`))]);
    results.push([label + ': roadmap phase 2 live', (await p.textContent('#phase2')).includes('Live')]);
    results.push([label + ': footer CA', (await p.textContent('#foot-ca')).includes(CA)]);
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    results.push([label + ': no horizontal scroll (' + overflow + 'px)', overflow <= 0]);
    await p.locator('#token').screenshot({ path: path.join(out, `launch-${label}.png`) });
    await ctx.close();
  }
  await b.close();
  results.forEach(([n, ok]) => console.log((ok ? 'PASS ' : 'FAIL ') + n));
  console.log('page errors:', errors.length ? errors : 'none');
})();
