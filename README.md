# Tripwire scan server

The engine behind the full scan on [usetripwire.com](https://usetripwire.com). The website calls `GET /api/scan?ca=<mint>` and shows all eight wires. Runs on Node 20+ with no dependencies.

## The eight wires

| Wire | How it works |
|---|---|
| **Bundle** | Rebuilds the launch from the mint's on-chain history. Wallets that bought in the launch block, plus early buyers that share a funding wallet or were funded by the deployer, are grouped as one bundle. Trips if the bundle still holds 10%+ of supply. |
| **Sniper** | Outside wallets that bought within the first 3 blocks. Trips if they still hold 10%+. |
| **Dev history** | The deployer's current holding and selling, plus every other token it created in its recent transactions, checked against DexScreener. Trips if 3+ past launches exist and 60%+ are dead (under $1K liquidity), or if the dev holds 10%+. |
| **Agent** | Reads the last ~120 pool transactions. Flags wallets with machine-steady timing, rapid bursts, or 1,000+ transactions a day. Trips at 50%+ of recent volume. |
| **Wash** | Same sample. Flags wallets buying and selling the same size back and forth, or both in the same block. Trips at 30%+ of recent volume. |
| **Exit** | Pool depth from DexScreener, and the estimated price impact of a $1,000 sell. |
| **Authority** | Mint or freeze authority still active, plus Token-2022 fees, delegates, hooks or pausing. |
| **Holders** | Top-10 concentration, excluding pools, lockers and other program-owned accounts. |

All thresholds are in `config.js` and can be overridden with environment variables. Agent and wash are labeled estimates on purpose: treat them as signals, not proof.

**Known limits.** A token with more than about 20,000 transactions is too busy to rebuild its launch in one scan, so bundle, sniper and dev show "n/a" instead of guessing. Raise `MINT_SIG_PAGES` if your RPC plan allows. A deployer that uses a fresh wallet for every launch won't show past launches, but the dev wire notes when the deployer wallet is less than a day old.

## Running it

It's deployed on Railway from this repository. Every push to `main` redeploys automatically.

Settings (see `env.example.txt`):
- `RPC_URL`: the **server** Helius key. Never put this in the website.
- `SITE_URL`: `https://usetripwire.com`
- `ALLOWED_ORIGINS`: the domains allowed to call the API

Health check: `/health` returns `{"ok":true}`.

On a computer, you can run:
```
npm test                        # offline tests with a simulated launch
npm run scan -- <token mint>    # one real scan, printed in the terminal
npm start                       # run the API locally
```

## Cost
A full scan makes a few hundred RPC calls. Results are cached for 10 minutes, and funding lookups for a week. The Helius free plan is fine for testing, but expect a paid plan once real traffic arrives.

## Files
- `index.js`: starts the API
- `server.js`: the `/api/scan` and `/health` endpoints, with CORS and per-IP rate limits
- `scan.js`: runs every wire for one mint
- `wires.js`: the eight checks and their thresholds
- `chain.js`: reads trades, funding, holdings and past launches from Solana
- `rpc.js`, `dex.js`, `config.js`, `util.js`: helpers
- `test.js`: offline test suite
- `scan-once.js`: one real scan from the command line
