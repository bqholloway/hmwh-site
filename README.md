# hmwh.men

The He Man Woman Haters Club league site, served by Cloudflare Pages behind Cloudflare Access.

- `public/index.html` is the whole site (Home, Power Rankings, Pick'em, Statistics, League History, Trades, Videos).
- `public/data/site.json` holds the league data. The scheduled update runs (Fri / Mon / Tue mornings) rewrite this file from ESPN via Flaim and FantasyCalc; the page reads it on load.

Deployed with `npx wrangler deploy`; `wrangler.jsonc` serves the `public/` folder as static assets.

Status: wireframe. Design pass, all-time history, the rebuilt Trade Ledger and stored pick'em are still to come.
