// hmwh.men Worker: serves the static site from ./public and runs the pick'em API.
//
// Who is asking: Cloudflare Access sits in front of hmwh.men, so every request carries
// the signed-in member's email. If ACCESS_TEAM and ACCESS_AUD are set, the signed Access
// token is verified too; otherwise the email header Access adds is trusted (the workers.dev
// address is disabled, so Access is the only way in).
//
// Where picks live: one Durable Object ("League") with a small SQLite database.
// What the week looks like (games, lock time, winners): public/data/pickem.json, which the
// scheduled update runs rewrite in git. Nothing here needs a secret.

import { DurableObject } from "cloudflare:workers";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export class League extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS claims (email TEXT PRIMARY KEY, slot INTEGER UNIQUE NOT NULL, at TEXT NOT NULL)"
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS picks (email TEXT NOT NULL, season INTEGER NOT NULL, week INTEGER NOT NULL, game TEXT NOT NULL, team INTEGER NOT NULL, at TEXT NOT NULL, PRIMARY KEY (email, season, week, game))"
    );
  }

  claims() {
    return this.sql.exec("SELECT email, slot FROM claims").toArray();
  }

  claim(email, slot) {
    const mine = this.sql.exec("SELECT slot FROM claims WHERE email = ?", email).toArray();
    if (mine.length) return { error: "Your email is already linked to a team." };
    const taken = this.sql.exec("SELECT email FROM claims WHERE slot = ?", slot).toArray();
    if (taken.length) return { error: "Someone already claimed that team. Ask Bradley if that's wrong." };
    this.sql.exec("INSERT INTO claims (email, slot, at) VALUES (?, ?, ?)", email, slot, new Date().toISOString());
    return { ok: true };
  }

  release(slot) {
    this.sql.exec("DELETE FROM claims WHERE slot = ?", slot);
    return { ok: true };
  }

  savePicks(email, season, week, picks) {
    const at = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      for (const [game, team] of Object.entries(picks)) {
        this.sql.exec(
          "INSERT INTO picks (email, season, week, game, team, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (email, season, week, game) DO UPDATE SET team = excluded.team, at = excluded.at",
          email, season, week, game, team, at
        );
      }
    });
    return { ok: true, at };
  }

  allPicks(season) {
    return this.sql
      .exec("SELECT email, week, game, team, at FROM picks WHERE season = ?", season)
      .toArray();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    const email = await identify(request, env);
    if (!email) return json({ error: "Sign in at hmwh.men to use the pick'em." }, 401);

    const admins = (env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const admin = admins.includes(email);
    const league = env.LEAGUE.get(env.LEAGUE.idFromName("hmwh"));
    const cfg = await loadJson(env, request, "/data/pickem.json");
    if (!cfg) return json({ error: "The pick'em schedule couldn't be loaded." }, 500);
    const week = cfg.weeks.find((w) => w.week === cfg.current);

    try {
      if (url.pathname === "/api/state" && request.method === "GET") {
        return json(await buildState(league, cfg, week, email, admin));
      }

      if (url.pathname === "/api/claim" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const slot = Number(body.slot);
        if (!Number.isInteger(slot) || slot < 1 || slot > 10) return json({ error: "Pick a team from the list." }, 400);
        const r = await league.claim(email, slot);
        return r.error ? json(r, 409) : json(await buildState(league, cfg, week, email, admin));
      }

      if (url.pathname === "/api/picks" && request.method === "POST") {
        if (!week) return json({ error: "There's no open pick'em week right now." }, 400);
        const body = await request.json().catch(() => ({}));
        if (Number(body.week) !== week.week) return json({ error: "Those picks are for a different week. Refresh the page." }, 400);
        const status = weekStatus(week);
        if (status === "locked") return json({ error: "Picks are locked for this week." }, 403);
        if (status === "upcoming" && !admin) return json({ error: "Picks for this week aren't open yet." }, 403);
        const claims = await league.claims();
        if (!claims.some((c) => c.email === email)) return json({ error: "Pick which team is yours first." }, 400);
        const clean = {};
        for (const g of week.games) {
          const t = Number((body.picks || {})[g.id]);
          if (t === g.a || t === g.b) clean[g.id] = t;
        }
        if (!Object.keys(clean).length) return json({ error: "Pick at least one matchup." }, 400);
        await league.savePicks(email, cfg.season, week.week, clean);
        return json(await buildState(league, cfg, week, email, admin));
      }

      if (url.pathname === "/api/admin/access-info" && request.method === "GET") {
        // Shows the Groundskeeper which Access team and audience tag his login token carries,
        // so they can be copied into ACCESS_TEAM / ACCESS_AUD. Neither value is a secret.
        if (!admin) return json({ error: "Only the Groundskeeper can do that." }, 403);
        const token = request.headers.get("cf-access-jwt-assertion");
        if (!token) return json({ error: "No Cloudflare Access token on this request." }, 400);
        try {
          const payload = JSON.parse(new TextDecoder().decode(b64u(token.split(".")[1])));
          const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
          return json({ team: payload.iss, aud, verifying: !!(env.ACCESS_TEAM && env.ACCESS_AUD) });
        } catch {
          return json({ error: "Couldn't read the Access token." }, 400);
        }
      }

      if (url.pathname === "/api/admin/release" && request.method === "POST") {
        if (!admin) return json({ error: "Only the Groundskeeper can do that." }, 403);
        const body = await request.json().catch(() => ({}));
        await league.release(Number(body.slot));
        return json(await buildState(league, cfg, week, email, admin));
      }

      return json({ error: "Not found." }, 404);
    } catch (e) {
      return json({ error: "Something went wrong saving that. Try again." }, 500);
    }
  },
};

function weekStatus(w) {
  const now = Date.now();
  if (now >= Date.parse(w.locksAt)) return "locked";
  if (now < Date.parse(w.opensAt)) return "upcoming";
  return "open";
}

async function buildState(league, cfg, week, email, admin) {
  const claims = await league.claims();
  const bySlot = Object.fromEntries(claims.map((c) => [c.slot, c.email]));
  const slotOf = Object.fromEntries(claims.map((c) => [c.email, c.slot]));
  const rows = await league.allPicks(cfg.season);

  // Scoring: 1 point per correct pick, 2 for the Game of the Week.
  const board = {};
  for (let s = 1; s <= 10; s++) board[s] = { slot: s, claimed: !!bySlot[s], points: 0, correct: 0, graded: 0, gotwW: 0, gotwL: 0, last: null };
  const lastScored = [...cfg.weeks].filter((w) => w.games.every((g) => g.winner)).map((w) => w.week).sort((a, b) => b - a)[0];
  for (const w of cfg.weeks) {
    const games = Object.fromEntries(w.games.map((g) => [g.id, g]));
    for (const r of rows) {
      if (r.week !== w.week) continue;
      const slot = slotOf[r.email];
      const g = games[r.game];
      if (!slot || !g || !g.winner) continue;
      const b = board[slot];
      const hit = r.team === g.winner;
      b.graded++;
      if (hit) { b.correct++; b.points += g.x2 ? 2 : 1; }
      if (g.x2) hit ? b.gotwW++ : b.gotwL++;
      if (w.week === lastScored) b.last = (b.last || 0) + (hit ? (g.x2 ? 2 : 1) : 0);
    }
  }

  let status = null, mine = {}, submitted = [], everyone = null, savedAt = null;
  if (week) {
    status = weekStatus(week);
    const wk = rows.filter((r) => r.week === week.week);
    for (const r of wk) if (r.email === email) { mine[r.game] = r.team; savedAt = r.at > (savedAt || "") ? r.at : savedAt; }
    submitted = [...new Set(wk.map((r) => slotOf[r.email]).filter(Boolean))];
    if (status === "locked") {
      everyone = {};
      for (const r of wk) {
        const s = slotOf[r.email];
        if (s) (everyone[r.game] ||= {})[s] = r.team;
      }
    }
  }

  return {
    email,
    admin,
    mySlot: slotOf[email] || null,
    claimed: Object.keys(bySlot).map(Number),
    claimEmails: admin ? bySlot : undefined,
    week: week ? week.week : null,
    status,
    myPicks: mine,
    savedAt,
    submitted,
    everyone,
    lastScored: lastScored || null,
    leaderboard: Object.values(board),
  };
}

async function loadJson(env, request, path) {
  try {
    const r = await env.ASSETS.fetch(new Request(new URL(path, request.url)));
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function identify(request, env) {
  if (env.ACCESS_TEAM && env.ACCESS_AUD) {
    const token = request.headers.get("cf-access-jwt-assertion");
    if (!token) return null;
    const payload = await verifyAccessJwt(token, env);
    return payload && payload.email ? String(payload.email).toLowerCase() : null;
  }
  const e = request.headers.get("cf-access-authenticated-user-email");
  return e ? e.trim().toLowerCase() : null;
}

let certs = null, certsAt = 0;
const b64u = (s) => {
  const b = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
};

async function verifyAccessJwt(token, env) {
  try {
    const [h, p, s] = token.split(".");
    if (!s) return null;
    const dec = new TextDecoder();
    const header = JSON.parse(dec.decode(b64u(h)));
    const payload = JSON.parse(dec.decode(b64u(p)));
    const team = String(env.ACCESS_TEAM).replace(/^https?:\/\//, "").replace(/\.cloudflareaccess\.com.*$/, "");
    const iss = `https://${team}.cloudflareaccess.com`;
    if (payload.iss !== iss) return null;
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(env.ACCESS_AUD)) return null;
    if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
    if (!certs || Date.now() - certsAt > 3600e3) {
      const r = await fetch(`${iss}/cdn-cgi/access/certs`);
      certs = (await r.json()).keys;
      certsAt = Date.now();
    }
    const jwk = certs.find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(s), new TextEncoder().encode(`${h}.${p}`));
    return ok ? payload : null;
  } catch {
    return null;
  }
}
