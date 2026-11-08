# Website browser tests

Regression tests for usetripwire.com (the Tripwire-site repo), run in a real browser with mocked
Solana RPC, DexScreener and API responses. Run them before every site change.

    # 1. Make a test copy of the site with test config
    cp -r ../Tripwire-site /tmp/sitetest
    sed -i -E 's#apiUrl: "[^"]*"#apiUrl: ""#; s#rpcUrl: "[^"]*"#rpcUrl: "https://api.mainnet-beta.solana.com"#' /tmp/sitetest/config.js
    (cd /tmp/sitetest && python3 -m http.server 8765 &)

    # 2. Run (needs Playwright + Chromium)
    mkdir -p /tmp/out && cp sample-result.json /tmp/out/
    for t in *.test.js; do node $t /tmp/out /tmp/sitetest; done

Every line should read PASS.

| File | Covers |
|---|---|
| quick-scan.test.js | Browser-only scan, bad input, rate limits, deep links, phone layout |
| full-scan.test.js | Server scan, fallbacks when the server is down or busy |
| radar.test.js | Wallet sign-in, holder gate, delayed preview |
| launch-mode.test.js | Setting the $TRIP address switches the site to launch mode |
| dust-pool.test.js | A $1.51 dust pool must never stand in for the coin's market |
