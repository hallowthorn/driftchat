# Driftchat

A full Omegle / Umingle-style site: random stranger **text chat** and **video chat**, interest matching, skip with Esc, typing indicator, live online count, chat-log saving, reports, IP bans and a moderator panel. No AI scanning — moderation is human (reports → admin panel) plus an optional auto temp-ban when several different people report the same person.

## Run it

```bash
npm install
ADMIN_PASSWORD=pick-something-strong npm start
```

Open http://localhost:3000 in two browser tabs (or two devices) to match with yourself. The admin panel is at http://localhost:3000/admin.

On Windows PowerShell: `$env:ADMIN_PASSWORD="pick-something-strong"; npm start`

## Deploy: GitHub Pages + Render (free)

GitHub Pages only serves static files, so the site lives on Pages and the matching server runs on Render.

1. **Server → Render.** render.com → New → Blueprint → pick this repo. It reads `render.yaml`. When it's live you get a URL like `https://driftchat.onrender.com`. Your admin password is under the service's Environment tab.
2. **Point the site at it.** On GitHub: Settings → Secrets and variables → Actions → Variables → New variable `DRIFTCHAT_SERVER` = your Render URL (no trailing slash).
3. **Turn on Pages.** Settings → Pages → Source: **GitHub Actions**. Then Actions → "Deploy site to GitHub Pages" → Run workflow (it also runs on every push to `main`).
4. Site: `https://<you>.github.io/driftchat/` · Admin: `https://<you>.github.io/driftchat/admin.html`

If your Pages URL isn't `https://hallowthorn.github.io`, change `ALLOWED_ORIGINS` in Render to match.

**Free tier caveats:** Render's free server sleeps after ~15 minutes idle, so the first visitor waits ~30–60s while it wakes up (the site shows "Waking up the chat server…"). Its disk is wiped on every restart, so bans and reports in `data/` don't survive restarts — fine for testing; for a real launch use a paid instance with a persistent disk.

## Features

| | |
|---|---|
| Text & video modes | Separate queues; video uses WebRTC peer-to-peer (server only relays signaling) |
| Interests | Up to 10 tags, best-overlap match; falls back to random after 10s |
| Skip | Stop → Really? → New, mapped to the Esc key like Omegle |
| Chat UX | Typing indicator, "you both like…", tab-title unread alerts, save log as .txt, mobile layout |
| Video | Mic/camera toggles, mirrored self-view, picture-in-picture on phones |
| Safety | 18+ checkbox, report dialog (sends the text transcript + IP), message rate limiting, no instant re-match with the person you just skipped |
| Moderation | `/admin`: open reports with transcripts, ban 24h / 7d / forever, ban false reporters, manual IP bans, unban, live queue stats |
| Auto-ban | `AUTO_BAN_REPORTS` different reporters within 24h → 24h ban (default 5) |

Data (bans, reports, settings) is stored in `data/*.json` — no database needed.

## Admin panel

`/admin.html` (or `/admin` when the server hosts the site). Tabs:

- **Overview** — online now, active chats, queue sizes, peak online, chats/messages started, average chat length, chats-per-hour chart (last 24h), and quick switches for text chat, video chat and maintenance mode.
- **Live** — every active chat (end it) and everyone online with IP, status, mode, interests, time online, message count and report count. Per-user actions: **Warn** (popup they must acknowledge), **End chat**, **Kick** (disconnect, no ban), **Ban**. Live message text is never shown — only reported transcripts.
- **Reports** — filter by reason, search IPs and transcript text, under-18 reports sorted first, ban 24h/7d/forever, ban the reporter for false reports, dismiss one / all on an IP / everything.
- **Bans** — manual ban (1h to permanent), search, make a temp ban permanent, unban, unban everyone.
- **Site controls** — broadcast a one-time message to everyone online, an announcement banner at the top of the site, maintenance message, word filter (mask with `****` or block the message), auto-ban threshold, interest-match wait time, message rate limit.
- **Lookup & data** — IP lookup (ban status, online sessions, reports against and filed, with ban/kick/dismiss buttons), JSON export, and import to restore bans/settings after a restart.

Click any IP anywhere in the panel to open its lookup.

## Environment variables

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `ADMIN_PASSWORD` | `changeme` | Password for `/admin` — **change it** |
| `ALLOWED_ORIGINS` | `*` | Sites allowed to connect, comma-separated (e.g. `https://you.github.io`) |
| `TRUST_PROXY` | off | Set to `1` behind nginx / Cloudflare / Render / Railway so real IPs are used for bans |
| `AUTO_BAN_REPORTS` | `5` | Distinct reporters in 24h before an automatic 24h ban |
| `TURN_URL` / `TURN_USER` / `TURN_PASS` | — | TURN server for video (comma-separate multiple URLs) |

## Going public

1. **HTTPS is required** for camera/mic on anything except localhost. Put it behind Cloudflare, Caddy, or a host like Render/Railway/Fly that gives you HTTPS, and set `TRUST_PROXY=1`.
2. **Add a TURN server.** STUN alone works for most home connections, but roughly 10–20% of people (mobile data, school/work Wi-Fi) need TURN or video won't connect. Options: self-host `coturn`, or use a hosted one (Metered, Cloudflare Calls, Twilio). Text chat always works regardless.
3. **Scaling:** one Node process easily handles a few thousand concurrent users. Past that, add the Socket.IO Redis adapter and move the queues into Redis.
4. Keep an eye on `/admin` — reports are the only moderation without AI scanning, and random video sites attract bad actors fast. Act on "under 18" reports first.

## Files

```
server.js          matching, relay, signaling, reports, bans, admin API
public/index.html  site
public/style.css   styles
public/app.js      client logic (chat, WebRTC, reports)
public/admin.html  moderator panel
data/              bans.json, reports.json (created on first run)
```
