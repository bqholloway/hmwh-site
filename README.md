# hmwh.men

The He Man Woman Haters Club league site, served by Cloudflare Pages behind Cloudflare Access.

- `public/index.html` is the whole site (Home, Power Rankings, Pick'em, Statistics, League History, Trades, Videos).
- `public/data/site.json` holds the league data. The scheduled update runs (Fri / Mon / Tue mornings) rewrite this file from ESPN via Flaim and FantasyCalc; the page reads it on load.

Deployed with `npx wrangler deploy`. `wrangler.jsonc` serves `public/` as static assets and runs `src/worker.js` for `/api/*`.

## Head-to-Head
- `public/data/h2h.json` holds every game since 2015 (regular season, playoffs and consolation) plus each season's owner and team name per franchise slot. Records count regular season and playoffs. Pulled from ESPN via Flaim and checked against each season's final standings. The update runs append each new week.

## Trades
- `public/data/trades.json` holds every completed 2026 trade with both sides' players and FantasyCalc values. The update runs add new trades once they clear review and re-score them.

## Pick'em
- `public/data/pickem.json` is the schedule: the current week, when picks open and lock, the five games, which one is the 2x Game of the Week, and each game's winner once it's final. The Tuesday update writes the next week's games and fills in last week's winners.
- Picks are stored in a Durable Object (SQLite) called `League`. Each member links their login to one team the first time they visit; the Groundskeeper (`ADMIN_EMAILS`) can undo a link and can save picks before a week opens.
- Scoring: 1 point per correct pick, 2 for the Game of the Week.
- Optional hardening: set `ACCESS_TEAM` (your Zero Trust team name) and `ACCESS_AUD` (the Access app's Application Audience tag) as Worker variables and the Worker will verify Cloudflare Access's signed login token instead of trusting the email header.

Status: wireframe. Design pass, all-time history, the rebuilt Trade Ledger and stored pick'em are still to come.
