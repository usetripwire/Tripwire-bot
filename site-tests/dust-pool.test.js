// Regression: a $1.51 dust pool listed next to the pump.fun bonding curve must never be used as the market.
const { chromium } = require('playwright');
const BASE = 'http://127.0.0.1:8765';
const MINT = '7xKqTr1pWzTestMintHv9bRnZ3hJ5cD8fG2sA4Lpump';
const TOKENKEG = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST, GET, OPTIONS' };
const largest = [250, 29, 25, 20].map((a, i) => ({ address: 'TokAcct' + i + 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'.slice(0, 32), amount: String(a * 1e12), decimals: 6 }));
const dust = { chainId: 'solana', dexId: 'raydium', url: 'https://dexscreener.com/solana/dust', pairAddress: 'DustPoo1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', baseToken: { address: MINT, name: 'Dust Test', symbol: 'DUST' }, priceUsd: '0.0000116', liquidity: { usd: 1.51 }, volume: { h24: 0.31 }, txns: { h24: { buys: 0, sells: 1 } }, marketCap: 11610, pairCreatedAt: Date.now() - 17 * 60e3 };
const curve = { chainId: 'solana', dexId: 'pumpfun', url: 'https://dexscreener.com/solana/curve', pairAddress: 'CurvePoo1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', baseToken: { address: MINT, name: 'Dust Test', symbol: 'DUST' }, priceUsd: '0.0000116', volume: { h24: 231000 }, txns: { h24: { buys: 2727, sells: 2390 } }, marketCap: 11610, pairCreatedAt: Date.now() - 60 * 60e3 };
(async () => {
  const b = await chromium.launch();
  const results = [], errors = [];
  for (const order of [['dust first', [dust, curve]], ['curve first', [curve, dust]]]) {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
    await ctx.route(/api\.mainnet-beta\.solana\.com/, async route => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const body = JSON.parse(req.postData());
      let result;
      if (body.method === 'getAccountInfo') result = { value: { owner: TOKENKEG, data: { program: 'spl-token', parsed: { type: 'mint', info: { decimals: 6, supply: '1000000000000000', mintAuthority: null, freezeAuthority: null } } } } };
      else if (body.method === 'getTokenLargestAccounts') result = { value: largest };
      else if (body.method === 'getMultipleAccounts') result = { value: body.params[0].map((_, i) => ({ owner: '11111111111111111111111111111111', data: { parsed: { info: { owner: 'Own' + i + 'erWa11etxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'.slice(0, 32) } } } })) };
      route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) });
    });
    await ctx.route(/api\.dexscreener\.com/, r => r.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ pairs: order[1] }) }));
    const p = await ctx.newPage();
    p.on('pageerror', e => errors.push(e.message));
    await p.goto(BASE + '/?ca=' + MINT);
    await p.waitForSelector('#result .r-head', { timeout: 10000 });
    const txt = await p.textContent('#result');
    results.push([order[0] + ': exit says bonding curve', txt.includes('Still on the pump.fun bonding curve')]);
    results.push([order[0] + ': no fake 99.9% price move', !txt.includes('99.9%')]);
    results.push([order[0] + ': liquidity shows launch curve, not $1.51', txt.includes('On launch curve') && !txt.includes('$1.51')]);
    await ctx.close();
  }
  await b.close();
  results.forEach(([n, ok]) => console.log((ok ? 'PASS ' : 'FAIL ') + n));
  console.log('page errors:', errors.length ? errors : 'none');
})();
