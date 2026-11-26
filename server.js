'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const TICK_RATE = 30;
const SNAPSHOT_RATE = 15;
const ARENA_LIMIT = 23;
const PLAYER_RADIUS = 0.42;
const MOVE_SPEED = 5.2;
const SPRINT_SPEED = 7.1;
const FIRE_INTERVAL_MS = 135;
const MAX_HEALTH = 100;

// Keep this list in sync with WORLD_BLOCKS in public/index.html.
const BLOCKS = [
  { x: 0, z: -22.3, w: 46, d: 1.2, h: 5 },
  { x: 0, z: 22.3, w: 46, d: 1.2, h: 5 },
  { x: -22.3, z: 0, w: 1.2, d: 46, h: 5 },
  { x: 22.3, z: 0, w: 1.2, d: 46, h: 5 },
  { x: -8, z: -8, w: 5, d: 2.2, h: 2.2 },
  { x: 7, z: -9, w: 2.4, d: 6, h: 2.6 },
  { x: 0, z: -2, w: 7, d: 2, h: 1.7 },
  { x: -10, z: 5, w: 2, d: 7, h: 2.5 },
  { x: 9, z: 5, w: 6, d: 2, h: 2.2 },
  { x: 1, z: 10, w: 3, d: 5, h: 2.4 },
  { x: -15, z: -1, w: 3, d: 3, h: 1.5 },
  { x: 15, z: -12, w: 3, d: 3, h: 1.5 },
  { x: 14, z: 14, w: 4, d: 3, h: 1.8 },
  { x: -14, z: 14, w: 4, d: 3, h: 1.8 },
  { x: -3, z: 17, w: 6, d: 2, h: 1.4 },
  { x: 3, z: -17, w: 6, d: 2, h: 1.4 }
];

const SPAWNS = [
  { x: -17, z: -17 }, { x: 17, z: 17 },
  { x: 17, z: -17 }, { x: -17, z: 17 },
  { x: 0, z: 18 }, { x: 0, z: -18 }
];

const app = express();
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/health', (_req, res) => res.json({ ok: true, players: players.size }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/game' });
const players = new Map();
let snapshotAccumulator = 0;
let roundEndsAt = Date.now() + 5 * 60 * 1000;

function safeName(value) {
  const name = String(value || 'Rookie').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 16);
  return name || 'Rookie';
}

function spawnFor(id) {
  const index = parseInt(id.slice(0, 6), 16) % SPAWNS.length;
  const base = SPAWNS[index];
  return { x: base.x + (Math.random() - 0.5) * 1.4, z: base.z + (Math.random() - 0.5) * 1.4 };
}

function collides(x, z) {
  if (Math.abs(x) > ARENA_LIMIT - PLAYER_RADIUS || Math.abs(z) > ARENA_LIMIT - PLAYER_RADIUS) return true;
  for (const b of BLOCKS) {
    const closestX = Math.max(b.x - b.w / 2, Math.min(x, b.x + b.w / 2));
    const closestZ = Math.max(b.z - b.d / 2, Math.min(z, b.z + b.d / 2));
    const dx = x - closestX;
    const dz = z - closestZ;
    if (dx * dx + dz * dz < PLAYER_RADIUS * PLAYER_RADIUS) return true;
  }
  return false;
}

function movePlayer(p, dt) {
  const input = p.input;
  const forward = Math.max(-1, Math.min(1, Number(input.forward) || 0));
  const strafe = Math.max(-1, Math.min(1, Number(input.strafe) || 0));
  const yaw = Number.isFinite(input.yaw) ? input.yaw : p.yaw;
  p.yaw = yaw;
  p.pitch = Math.max(-1.35, Math.min(1.35, Number(input.pitch) || 0));
  const magnitude = Math.hypot(forward, strafe) || 1;
  const speed = input.sprint ? SPRINT_SPEED : MOVE_SPEED;
  const f = forward / magnitude * speed * dt;
  const s = strafe / magnitude * speed * dt;
  const dx = -Math.sin(yaw) * f + Math.cos(yaw) * s;
  const dz = -Math.cos(yaw) * f - Math.sin(yaw) * s;
  if (!collides(p.x + dx, p.z)) p.x += dx;
  if (!collides(p.x, p.z + dz)) p.z += dz;
}

function rayBoxDistance(origin, dir, box) {
  const min = [box.x - box.w / 2, 0, box.z - box.d / 2];
  const max = [box.x + box.w / 2, box.h, box.z + box.d / 2];
  const o = [origin.x, origin.y, origin.z];
  const d = [dir.x, dir.y, dir.z];
  let tMin = 0;
  let tMax = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-8) {
      if (o[i] < min[i] || o[i] > max[i]) return Infinity;
    } else {
      let t1 = (min[i] - o[i]) / d[i];
      let t2 = (max[i] - o[i]) / d[i];
      if (t1 > t2) [t1, t2] = [t2, t1];
      tMin = Math.max(tMin, t1);
      tMax = Math.min(tMax, t2);
      if (tMax < tMin) return Infinity;
    }
  }
  return tMin;
}

function performShot(shooter, now) {
  if (now - shooter.lastShot < FIRE_INTERVAL_MS || shooter.health <= 0) return;
  shooter.lastShot = now;
  const cp = Math.cos(shooter.pitch);
  const dir = {
    x: -Math.sin(shooter.yaw) * cp,
    y: Math.sin(shooter.pitch),
    z: -Math.cos(shooter.yaw) * cp
  };
  const origin = { x: shooter.x, y: 1.52, z: shooter.z };
  let best = null;
  let bestT = 42;

  for (const target of players.values()) {
    if (target.id === shooter.id || target.health <= 0) continue;
    const vx = target.x - origin.x;
    const vy = 1.05 - origin.y;
    const vz = target.z - origin.z;
    const t = vx * dir.x + vy * dir.y + vz * dir.z;
    if (t <= 0 || t >= bestT) continue;
    const px = vx - t * dir.x;
    const py = vy - t * dir.y;
    const pz = vz - t * dir.z;
    if (px * px + py * py + pz * pz > 0.62 * 0.62) continue;
    const blocked = BLOCKS.some(b => rayBoxDistance(origin, dir, b) < t);
    if (!blocked) { best = target; bestT = t; }
  }

  if (best) {
    best.health = Math.max(0, best.health - 34);
    shooter.socket.send(JSON.stringify({ type: 'shot', hit: true, target: best.name }));
    if (best.health === 0) {
      shooter.kills += 1;
      best.deaths += 1;
      best.respawnAt = now + 2500;
      broadcast({ type: 'feed', text: `${shooter.name} tagged ${best.name}` });
    }
  } else {
    shooter.socket.send(JSON.stringify({ type: 'shot', hit: false }));
  }
}

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const p of players.values()) {
    if (p.socket.readyState === WebSocket.OPEN) p.socket.send(data);
  }
}

wss.on('connection', (socket) => {
  const id = crypto.randomBytes(8).toString('hex');
  const spawn = spawnFor(id);
  const player = {
    id, socket, name: 'Rookie', x: spawn.x, z: spawn.z,
    yaw: 0, pitch: 0, health: MAX_HEALTH, kills: 0, deaths: 0,
    input: { forward: 0, strafe: 0, sprint: false, yaw: 0, pitch: 0, shoot: false },
    lastShot: 0, respawnAt: 0
  };
  players.set(id, player);
  socket.send(JSON.stringify({ type: 'welcome', id, name: player.name, x: player.x, z: player.z }));
  broadcast({ type: 'feed', text: 'A new player entered the arena' });

  socket.on('message', (raw) => {
    if (raw.length > 2048) return;
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'join') {
      player.name = safeName(msg.name);
      socket.send(JSON.stringify({ type: 'joined', id, name: player.name }));
    } else if (msg.type === 'input' && msg.input && typeof msg.input === 'object') {
      const i = msg.input;
      player.input = {
        forward: Math.max(-1, Math.min(1, Number(i.forward) || 0)),
        strafe: Math.max(-1, Math.min(1, Number(i.strafe) || 0)),
        sprint: Boolean(i.sprint),
        yaw: Number.isFinite(i.yaw) ? i.yaw : player.yaw,
        pitch: Number.isFinite(i.pitch) ? i.pitch : player.pitch,
        shoot: Boolean(i.shoot)
      };
    }
  });

  socket.on('close', () => {
    players.delete(id);
    broadcast({ type: 'feed', text: `${player.name} left the arena` });
  });
});

let previous = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.05, (now - previous) / 1000);
  previous = now;
  for (const p of players.values()) {
    if (p.health <= 0 && p.respawnAt && now >= p.respawnAt) {
      const s = spawnFor(p.id);
      p.x = s.x; p.z = s.z; p.health = MAX_HEALTH; p.respawnAt = 0;
    }
    if (p.health > 0) {
      movePlayer(p, dt);
      if (p.input.shoot) performShot(p, now);
    }
  }
  snapshotAccumulator += dt;
  if (snapshotAccumulator >= 1 / SNAPSHOT_RATE) {
    snapshotAccumulator = 0;
    const state = {
      type: 'state',
      players: Array.from(players.values()).map(p => ({
        id: p.id, name: p.name, x: p.x, z: p.z, yaw: p.yaw,
        health: p.health, kills: p.kills, deaths: p.deaths
      })),
      timeLeft: Math.max(0, Math.ceil((roundEndsAt - now) / 1000))
    };
    broadcast(state);
    if (now >= roundEndsAt) {
      roundEndsAt = now + 5 * 60 * 1000;
      for (const p of players.values()) { p.kills = 0; p.deaths = 0; }
      broadcast({ type: 'feed', text: 'New round started' });
    }
  }
}, 1000 / TICK_RATE);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Tactical FPS running at http://localhost:${PORT}`);
});
