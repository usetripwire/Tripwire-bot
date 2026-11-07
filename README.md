# Tripwire server: full scan engine + @TripwireScan X bot

One small Node.js program does two jobs:

1. **The X bot.** It reads mentions of your bot account, finds the contract address, runs all eight wires and replies.
2. **The website API.** Your site calls `GET /api/scan?ca=<mint>` to show the same eight-wire scan.

It has no dependencies (Node 20 or newer, nothing to `npm install`).

## The eight wires

| Wire | How it works |
|---|---|
| **Bundle** | Rebuilds the launch from the mint's on-chain history. Wallets that bought in the launch block, plus early buyers that share a funding wallet (or were funded by the deployer), are grouped as one bundle. Trips if the bundle still holds 10%+ of supply. |
| **Sniper** | Outside wallets that bought within the first 3 blocks. Trips if they still hold 10%+. |
| **Dev history** | The deployer's current holding and sells, plus every other token it created in its recent transactions, checked against DexScreener. Trips if 3+ past launches exist and 60%+ are dead (under $1K liquidity), or if the dev holds 10%+. |
| **Agent** | Reads the last ~120 pool transactions. Flags wallets with machine-steady timing, rapid bursts, or 1,000+ transactions a day. Trips if they're 50%+ of recent volume. |
| **Wash** | Same sample. Flags wallets buying and selling the same size back and forth, or both buying and selling in the same block. Trips at 30%+ of recent volume. |
| **Exit** | Pool depth from DexScreener, and the estimated price impact of a $1,000 sell. |
| **Authority** | Mint or freeze authority still active, plus Token-2022 fees, delegates, hooks or pausing. |
| **Holders** | Top-10 concentration, excluding pools, lockers and other program-owned accounts. |

All thresholds are in `config.js` and can be overridden with environment variables. Agent and wash are labeled estimates on purpose: they use heuristics, so treat them as signals, not proof.

**Known limits.** A token with more than about 20,000 transactions is too busy to rebuild its launch in one scan. Bundle, sniper and dev then show "n/a" instead of guessing. Raise `MINT_SIG_PAGES` if you have the RPC budget. Serial ruggers who use a fresh wallet per launch won't show past launches, but the dev wire still notes when the deployer wallet is less than a day old.

## What it costs to run

- **Solana RPC (Helius):** a full scan makes a few hundred RPC calls (`npm run scan` prints the exact count). Results are cached for 10 minutes and funding lookups for a week. The free plan is fine for testing, but expect a paid plan once real traffic arrives.
- **X API:** pay-per-use. You pay per mention read and per reply posted, and polling only fetches new mentions.
- **Hosting:** a small always-on server, roughly $5–10 a month.

## Setup

### 1. Create the bot's X account
1. Make the account (e.g. @TripwireScan) with a profile picture, bio and link to your site.
2. Turn on the **Automated** label: Settings → Your account → Account information → **Automation** → choose your main account as the managing account.

### 2. Get X API keys (sign in as the BOT account)
1. Go to **developer.x.com** while logged in as the bot account, and sign up for API access (pay-per-use credits).
2. Create a **Project** and an **App**.
3. In the app's **User authentication settings**, set **App permissions: Read and write**, **Type of App: Web App, Automated App or Bot**, and any callback and website URL (your site is fine).
4. Under **Keys and tokens**, copy the **API Key** and **API Key Secret**, then generate an **Access Token** and **Access Token Secret**. Generate the access token *after* setting Read and write, or it will be read-only.
5. Add credits to your developer account.

### 3. Get a server-side Helius key
Create a **second** Helius API key just for the server. Don't domain-restrict it, since the server isn't a browser. Keep the website's key restricted to your domain.

### 4. Test on your own computer first
```
cp env.example.txt .env        # then fill it in, leaving DRY_RUN=true
npm test                    # 23 offline tests with simulated data
npm run scan -- <any Solana token mint>   # one real scan, printed in the terminal
npm start                   # runs the API, and the bot if ENABLE_BOT=true
```
With `DRY_RUN=true`, the bot prints its replies in the terminal instead of posting them. On its first start it skips old mentions, so it won't reply to a backlog.

### 5. Deploy it (Railway example)
1. Put this folder in a **private** GitHub repo. `.env` is git-ignored, so never commit it.
2. Go to **railway.app** → New Project → Deploy from GitHub repo → pick the repo. Railway runs `npm start` automatically.
3. Under **Variables**, add everything from your `.env` file.
4. Add a **Volume** mounted at `/app/data` so the bot remembers which mentions it already answered across restarts, and set `STATE_PATH=/app/data/state.json`.
5. Under **Settings → Networking**, click **Generate Domain**. That URL is your `apiUrl`, e.g. `https://tripwire-bot.up.railway.app`.
6. Check `https://<that-url>/health`. It should say `{"ok":true}`.

Render and Fly.io work the same way: a Node web service, environment variables, and a small persistent disk for `data/`.

### 6. Connect the website
In the website's `config.js`, set:
```js
apiUrl: "https://tripwire-bot.up.railway.app",
botLive: true      // once the bot is posting for real
```
Then redeploy the site on Netlify. The "With X bot" labels switch to **Live now**, and scans run all eight wires. If the server is ever down, the site falls back to the three-wire Quick Scan on its own.

### 7. Go live
1. Watch the server logs for a day with `DRY_RUN=true`, and tag the bot from your own account to check the replies.
2. When the replies look right, set `DRY_RUN=false` and restart.

## Bot behavior

- It replies **only** to posts that mention it, which is X's rule for automated replies.
- **`@TripwireScan <CA>`** scans that address. CAs inside DexScreener or pump.fun links work too.
- Tagging the bot under someone else's post with no CA of your own scans the CA in that post.
- **`watch` / `unwatch` / `watches`** get a one-time "Watch launches in Phase 2" note.
- Chatting in a thread under the bot's own reply is ignored unless you include a new CA or tag it again.
- Each user gets up to 5 scans an hour, and no mention is ever answered twice.
- Wallet or pool addresses get a "that's not a token mint" reply.

## Files
Everything sits in one folder, so it uploads to GitHub straight from an iPhone.
- `index.js`: starts the API and the bot
- `scan.js`: runs all wires for one mint
- `wires.js`: the eight checks and their thresholds
- `chain.js`: reads trades, funding, holdings and past launches from Solana
- `bot.js`: the mention loop and reply rules
- `x.js`: the X API client (OAuth 1.0a)
- `server.js`: the website API
- `format.js`, `rpc.js`, `dex.js`, `config.js`, `util.js`: helpers
- `test.js`: the offline test suite
- `scan-once.js`: one real scan from the command line
- `env.example.txt`: every setting, with notes (on Railway, type these under Variables)
