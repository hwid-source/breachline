# BREACHLINE — Tactical Arena (CS-style)

Node + WebSocket server, Three.js client. `npm install && npm start`, open http://localhost:3000 (needs internet for the Three.js CDN).

## Gameplay
- Teams CT vs T (auto-balanced), rounds with freeze time, no respawn until next round, first to 8 wins, map rotates each match (DUSTY, FACTORY)
- Economy: $800 start, kill rewards per weapon, round win $3250 / loss $1400. Buy menu (`B`, then 1-4) during freeze or first 15 s
- Weapons: Knife, USP-S, Deagle, MP9, AK-47, AWP (scope with right click). Headshots, recoil, movement/jump/crouch accuracy
- Jump, crouch, stairs and platforms (shared collision in `public/phys.js`), spectate teammates when dead, friendly fire off

## Controls
WASD move · Space jump · C/Ctrl crouch · Shift walk · R reload · 1/2/3 weapons · B buy · Tab scoreboard · RMB scope · Esc pause

## Performance ("potato mode" by default)
Procedural 64px textures (no downloads), blocks merged into ~5 draw calls, Lambert shading, no shadows/AA, adaptive resolution that lowers pixel ratio when FPS < 40.
