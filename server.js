'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const TICK_RATE = 30, SNAPSHOT_RATE = 15;
const ARENA_LIMIT = 22.3, R = 0.42;
const MOVE_SPEED = 5.2, SPRINT_SPEED = 7.1;
const FIRE_MS = 135, MAX_HEALTH = 100;
const MAG = 30, RESERVE = 90, RELOAD_MS = 1450;
const BODY_DMG = 26, HEAD_DMG = 70, RANGE = 60;
const RESPAWN_MS = 2500, SHIELD_MS = 2000, ROUND_MS = 5 * 60 * 1000;

// Keep BLOCKS / PICKUPS in sync with public/index.html.
const BLOCKS = [
  { x: 0, z: -22.3, w: 46, d: 1.2, h: 5 }, { x: 0, z: 22.3, w: 46, d: 1.2, h: 5 },
  { x: -22.3, z: 0, w: 1.2, d: 46, h: 5 }, { x: 22.3, z: 0, w: 1.2, d: 46, h: 5 },
  { x: -8, z: -8, w: 5, d: 2.2, h: 2.2 }, { x: 7, z: -9, w: 2.4, d: 6, h: 2.6 },
  { x: 0, z: -2, w: 7, d: 2, h: 1.7 }, { x: -10, z: 5, w: 2, d: 7, h: 2.5 },
  { x: 9, z: 5, w: 6, d: 2, h: 2.2 }, { x: 1, z: 10, w: 3, d: 5, h: 2.4 },
  { x: -15, z: -1, w: 3, d: 3, h: 1.5 }, { x: 15, z: -12, w: 3, d: 3, h: 1.5 },
  { x: 14, z: 14, w: 4, d: 3, h: 1.8 }, { x: -14, z: 14, w: 4, d: 3, h: 1.8 },
  { x: -3, z: 17, w: 6, d: 2, h: 1.4 }, { x: 3, z: -17, w: 6, d: 2, h: 1.4 }
];
const SPAWNS = [
  { x: -17, z: -17 }, { x: 17, z: 17 }, { x: 17, z: -17 },
  { x: -17, z: 17 }, { x: 0, z: 18 }, { x: 0, z: -18 }
];
const PICKUPS = [
  { type: 'health', x: -4, z: -12 }, { type: 'ammo', x: 4, z: 12 },
  { type: 'health', x: 12, z: 0 }, { type: 'ammo', x: -12, z: -8 },
  { type: 'health', x: -18, z: 10 }, { type: 'ammo', x: 18, z: -5 }
];
const PICKUP_COOLDOWN_MS = 20000;
const pickupReadyAt = PICKUPS.map(() => 0);

const app = express();
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/health', (_req, res) => res.json({ ok: true, players: players.size }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/game' });
const players = new Map();
let snapshotAccumulator = 0;
let roundEndsAt = Date.now() + ROUND_MS;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function send(p, payload) { if (p.socket.readyState === WebSocket.OPEN) p.socket.send(JSON.stringify(payload)); }
function broadcast(payload) { for (const p of players.values()) send(p, payload); }
function safeName(value) {
  const name = String(value || 'Rookie').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 16);
  return name || 'Rookie';
}

// Pick the spawn farthest from living players (avoids spawn-camping / spawning on top of enemies).
function pickSpawn(selfId) {
  let best = SPAWNS[0], bestScore = -1;
  for (const s of SPAWNS) {
    let min = 999;
    for (const p of players.values()) {
      if (p.id === selfId || p.health <= 0) continue;
      min = Math.min(min, Math.hypot(p.x - s.x, p.z - s.z));
    }
    const score = min + Math.random() * 4;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return { x: best.x + (Math.random() - 0.5) * 1.4, z: best.z + (Math.random() - 0.5) * 1.4 };
}

function collides(x, z) {
  if (Math.abs(x) > ARENA_LIMIT - R || Math.abs(z) > ARENA_LIMIT - R) return true;
  for (const b of BLOCKS) {
    const cx = clamp(x, b.x - b.w / 2, b.x + b.w / 2);
    const cz = clamp(z, b.z - b.d / 2, b.z + b.d / 2);
    const dx = x - cx, dz = z - cz;
    if (dx * dx + dz * dz < R * R) return true;
  }
  return false;
}

function rayBoxDistance(o, d, box) {
  const min = [box.x - box.w / 2, 0, box.z - box.d / 2];
  const max = [box.x + box.w / 2, box.h, box.z + box.d / 2];
  const oo = [o.x, o.y, o.z], dd = [d.x, d.y, d.z];
  let tMin = 0, tMax = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(dd[i]) < 1e-8) { if (oo[i] < min[i] || oo[i] > max[i]) return Infinity; }
    else {
      let t1 = (min[i] - oo[i]) / dd[i], t2 = (max[i] - oo[i]) / dd[i];
      if (t1 > t2) [t1, t2] = [t2, t1];
      tMin = Math.max(tMin, t1); tMax = Math.min(tMax, t2);
      if (tMax < tMin) return Infinity;
    }
  }
  return tMin;
}

function raySphere(o, d, cx, cy, cz, r) {
  const vx = cx - o.x, vy = cy - o.y, vz = cz - o.z;
  const t = vx * d.x + vy * d.y + vz * d.z;
  if (t <= 0) return Infinity;
  const px = vx - t * d.x, py = vy - t * d.y, pz = vz - t * d.z;
  return px * px + py * py + pz * pz <= r * r ? t : Infinity;
}

function startReload(p, now) {
  if (p.reloadUntil || p.ammo >= MAG || p.reserve <= 0 || p.health <= 0) return;
  p.reloadUntil = now + RELOAD_MS;
}

function performShot(shooter, now) {
  if (shooter.health <= 0 || shooter.reloadUntil || now - shooter.lastShot < FIRE_MS) return;
  if (shooter.ammo <= 0) { startReload(shooter, now); return; }
  shooter.lastShot = now;
  shooter.ammo--;
  shooter.shieldUntil = 0; // shooting drops spawn protection
  const spread = shooter.input.sprint ? 0.03 : 0.01;
  const yaw = shooter.yaw + (Math.random() - 0.5) * spread;
  const pitch = shooter.pitch + (Math.random() - 0.5) * spread;
  const cp = Math.cos(pitch);
  const dir = { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
  const origin = { x: shooter.x, y: 1.62, z: shooter.z };
  let best = null, bestT = RANGE, head = false;

  for (const t of players.values()) {
    if (t.id === shooter.id || t.health <= 0 || now < t.shieldUntil) continue;
    const th = raySphere(origin, dir, t.x, 1.62, t.z, 0.26);
    const tb = Math.min(raySphere(origin, dir, t.x, 1.05, t.z, 0.5), raySphere(origin, dir, t.x, 0.4, t.z, 0.42));
    const hit = Math.min(th, tb);
    if (hit >= bestT) continue;
    if (BLOCKS.some(b => rayBoxDistance(origin, dir, b) < hit)) continue;
    best = t; bestT = hit; head = th <= tb;
  }

  if (best) {
    best.health = Math.max(0, best.health - (head ? HEAD_DMG : BODY_DMG));
    send(shooter, { type: 'shot', hit: true, head, target: best.name });
    send(best, { type: 'hurt', from: Math.atan2(-(shooter.x - best.x), -(shooter.z - best.z)) });
    if (best.health === 0) {
      shooter.kills++; shooter.streak++; best.deaths++; best.streak = 0;
      best.respawnAt = now + RESPAWN_MS; best.reloadUntil = 0; best.input.shoot = false;
      broadcast({ type: 'feed', text: `${shooter.name} ${head ? 'headshot' : 'tagged'} ${best.name}` });
      if (shooter.streak >= 3) broadcast({ type: 'feed', text: `${shooter.name} is on a ${shooter.streak} streak!` });
    }
  }
  if (shooter.ammo === 0) startReload(shooter, now);
}

function respawn(p, now) {
  const s = pickSpawn(p.id);
  Object.assign(p, { x: s.x, z: s.z, health: MAX_HEALTH, ammo: MAG, reserve: RESERVE, respawnAt: 0, reloadUntil: 0, shieldUntil: now + SHIELD_MS, budget: 0 });
  send(p, { type: 'respawn', x: p.x, z: p.z });
}

wss.on('connection', (socket) => {
  const id = crypto.randomBytes(8).toString('hex');
  const player = {
    id, socket, name: 'Rookie', x: 0, z: 0, yaw: 0, pitch: 0, health: MAX_HEALTH,
    kills: 0, deaths: 0, streak: 0, ammo: MAG, reserve: RESERVE, reloadUntil: 0,
    input: { sprint: false, shoot: false }, lastShot: 0, respawnAt: 0, shieldUntil: 0,
    budget: 2, alive: true
  };
  const s = pickSpawn(id);
  player.x = s.x; player.z = s.z; player.shieldUntil = Date.now() + SHIELD_MS;
  players.set(id, player);
  send(player, { type: 'welcome', id, name: player.name, x: player.x, z: player.z });
  socket.on('pong', () => { player.alive = true; });

  socket.on('message', (raw) => {
    if (raw.length > 2048) return;
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'join') {
      player.name = safeName(msg.name);
      send(player, { type: 'joined', id, name: player.name });
      broadcast({ type: 'feed', text: `${player.name} entered the arena` });
    } else if (msg.type === 'reload') {
      startReload(player, Date.now());
    } else if (msg.type === 'input' && msg.input && typeof msg.input === 'object' && player.health > 0) {
      const i = msg.input;
      if (Number.isFinite(i.yaw)) player.yaw = i.yaw;
      if (Number.isFinite(i.pitch)) player.pitch = clamp(i.pitch, -1.35, 1.35);
      player.input = { sprint: Boolean(i.sprint), shoot: Boolean(i.shoot) };
      // Client-predicted position, validated against a movement budget and the map.
      if (Number.isFinite(i.x) && Number.isFinite(i.z)) {
        const d = Math.hypot(i.x - player.x, i.z - player.z);
        if (d <= player.budget + 0.05 && !collides(i.x, i.z)) { player.x = i.x; player.z = i.z; player.budget = Math.max(0, player.budget - d); }
        else if (d > 0.01) send(player, { type: 'correct', x: player.x, z: player.z });
      }
    }
  });

  socket.on('close', () => {
    players.delete(id);
    broadcast({ type: 'feed', text: `${player.name} left the arena` });
  });
});

setInterval(() => {
  for (const p of players.values()) {
    if (!p.alive) { p.socket.terminate(); continue; }
    p.alive = false; try { p.socket.ping(); } catch {}
  }
}, 15000);

let previous = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.05, (now - previous) / 1000);
  previous = now;

  for (const p of players.values()) {
    if (p.health <= 0) { if (p.respawnAt && now >= p.respawnAt) respawn(p, now); continue; }
    p.budget = Math.min(3, p.budget + SPRINT_SPEED * 1.25 * dt);
    if (p.reloadUntil && now >= p.reloadUntil) {
      const take = Math.min(MAG - p.ammo, p.reserve);
      p.ammo += take; p.reserve -= take; p.reloadUntil = 0;
    }
    if (p.input.shoot) performShot(p, now);
    PICKUPS.forEach((pk, i) => {
      if (now < pickupReadyAt[i] || Math.hypot(p.x - pk.x, p.z - pk.z) > 1) return;
      if (pk.type === 'health' && p.health < MAX_HEALTH) p.health = Math.min(MAX_HEALTH, p.health + 50);
      else if (pk.type === 'ammo' && p.reserve < RESERVE) p.reserve = RESERVE;
      else return;
      pickupReadyAt[i] = now + PICKUP_COOLDOWN_MS;
      send(p, { type: 'pickup', kind: pk.type });
    });
  }

  snapshotAccumulator += dt;
  if (snapshotAccumulator >= 1 / SNAPSHOT_RATE) {
    snapshotAccumulator = 0;
    broadcast({
      type: 'state',
      players: Array.from(players.values()).map(p => ({
        id: p.id, name: p.name, x: p.x, z: p.z, yaw: p.yaw, health: p.health,
        kills: p.kills, deaths: p.deaths, ammo: p.ammo, reserve: p.reserve,
        reloading: !!p.reloadUntil, prot: now < p.shieldUntil
      })),
      pickups: pickupReadyAt.map(t => now >= t),
      timeLeft: Math.max(0, Math.ceil((roundEndsAt - now) / 1000))
    });
    if (now >= roundEndsAt) {
      roundEndsAt = now + ROUND_MS;
      const top = Array.from(players.values()).sort((a, b) => b.kills - a.kills)[0];
      broadcast({ type: 'round', text: top && top.kills > 0 ? `ROUND OVER — ${top.name} WINS (${top.kills} ELIMS)` : 'ROUND OVER — NO WINNER' });
      for (const p of players.values()) { p.kills = 0; p.deaths = 0; p.streak = 0; respawn(p, now); }
      pickupReadyAt.fill(0);
    }
  }
}, 1000 / TICK_RATE);

server.listen(PORT, '0.0.0.0', () => console.log(`Tactical FPS running at http://localhost:${PORT}`));
