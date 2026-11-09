# personal-jarvis-market

A small robot that refreshes market prices for a personal phone dashboard.

- Every 10 minutes during Korean and US market hours (every 30 minutes otherwise), GitHub Actions runs `market.js`.
- It fetches prices, a 14-day RSI and the Fear & Greed index, then writes them to a single Firestore document.
- It only knows a list of ticker symbols. No account, holding or personal data is stored here or passes through here.
- The document path is kept in the `BOT_KEY` repository secret.
