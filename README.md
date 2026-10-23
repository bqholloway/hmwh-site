# hmwh.men

The He Man Woman Haters Club league site, served by Cloudflare Pages behind Cloudflare Access.

- `public/index.html` is the whole site (Home, Power Rankings, Pick'em, Statistics, League History, Trades, Lore, Videos).
- `public/data/site.json` holds the league data. The scheduled update runs (Fri / Mon / Tue mornings) rewrite this file from ESPN via Flaim and FantasyCalc; the page reads it on load.

Deployed with `npx wrangler deploy`. `wrangler.jsonc` serves `public/` as static assets and runs `src/worker.js` for `/api/*`.

## Head-to-Head
- `public/data/h2h.json` holds every game since 2015 (regular season, playoffs and consolation) plus each season's owner and team name per franchise slot. Records count regular season and playoffs. Pulled from ESPN via Flaim and checked against each season's final standings. The update runs append each new week.

## Draft Results
- `public/data/draft.json` holds every pick from completed drafts (2025 and 2024 so far) with each player's year-end points under league scoring, from ESPN via Flaim. Each pick gets pts over or under expected: the k-th player taken at a position that season is expected to score what the k-th best drafted player at that position scored, and anyone below waiver-wire level (12th QB, 28th RB, 34th WR, 13th TE, 11th K that season) counts as waiver level. Team totals sum their picks. No letter grades. Add a season once its playoffs end.

## Home
- The scoreboard colors the team name by head-to-head result and the score by bonus win (top 5 weekly score). The Week 7 matchups box shows projections until `live7.kickoff` in `site.json`, then live scores from `live7.scores` (rewritten on each update run, with `asOf`).

## Trades
- `public/data/trades.json` holds every completed 2026 trade with both sides' players and FantasyCalc values. The update runs add new trades once they clear review and re-score them.

## Pick'em
- `public/data/pickem.json` is the schedule: the current week, when picks open and lock, the five games, which one is the 2x Game of the Week, and each game's winner once it's final. The Tuesday update writes the next week's games and fills in last week's winners.
- Picks are stored in a Durable Object (SQLite) called `League`. Each member links their login to one team the first time they visit; the Groundskeeper (`ADMIN_EMAILS`) can undo a link and can save picks before a week opens.
- Scoring: 1 point per correct pick, 2 for the Game of the Week.
- Optional hardening: set `ACCESS_TEAM` (your Zero Trust team name) and `ACCESS_AUD` (the Access app's Application Audience tag) as Worker variables and the Worker will verify Cloudflare Access's signed login token instead of trusting the email header.

Status: wireframe. Design pass, all-time history, the rebuilt Trade Ledger and stored pick'em are still to come.
