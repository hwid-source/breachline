# BREACHLINE — Tactical Arena

An original, browser-based multiplayer first-person arena prototype. It uses Three.js for rendering and a small Node.js + WebSocket server for shared player movement, health, eliminations, respawning, and round state.

## Requirements

- Node.js 18 or newer
- A modern desktop browser with WebGL
- Internet access on the client for the Three.js ES module CDN

## Run locally

```bash
npm install
npm start
```

Open http://localhost:3000 in a desktop browser. Open the same address in additional browser windows or on other devices on the same network to join the same arena. For a public match, deploy this folder to a Node.js host that supports persistent WebSocket connections and use the host's HTTPS URL.

## Controls

- `W A S D` — move
- `Shift` — sprint
- `R` — reload (server-authoritative ammo)
- `Tab` — scoreboard (hold)
- Mouse — look
- Left mouse — fire
- `Esc` — release pointer / pause (click RESUME to continue)

## Mechanics

- Headshots (70 dmg) vs body (26 dmg), sprint spread, 30/90 ammo with reload
- Health (+50) and ammo pickups that respawn every 20 s
- 2 s spawn shield, safer spawn selection, kill streak announcements
- Round winner banner, hit/hurt sounds, hurt flash

## Deployment notes

The server listens on `0.0.0.0` and uses the `PORT` environment variable (default `3000`). The `/health` endpoint returns a small health/status JSON response. Put the app behind a TLS-enabled reverse proxy for public hosting so browsers use secure WebSockets (`wss://`).

This is an original prototype, not a CS2 clone: the map, name, UI, and weapon design are original. It is a lightweight arena foundation rather than a production matchmaking, anti-cheat, or ranked service.
