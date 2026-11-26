'use strict';
const http = require('http'), path = require('path'), crypto = require('crypto'), express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const MAPS = require('./maps'), P = require('./public/phys.js');

const PORT = Number(process.env.PORT || 3000), TICK = 30, SNAP = 20;
const FREEZE = 6000, ROUND = 115000, END = 5000, BUY_LIVE = 15000, WIN_ROUNDS = 8;
const clamp = P.cl;

const WEAPONS = {
  knife:  { name: 'KNIFE',  slot: 'knife', price: 0, dmg: 45, hs: 1, rate: 550, melee: true, range: 2.4, speed: 1.12, reward: 1500 },
  usp:    { name: 'USP-S',  slot: 'secondary', price: 0, dmg: 30, hs: 4, rate: 170, mag: 12, res: 36, reload: 1900, auto: false, spread: .004, mv: .03, kick: .03, speed: 1.05, reward: 300 },
  deagle: { name: 'DEAGLE', slot: 'secondary', price: 700, dmg: 54, hs: 4, rate: 400, mag: 7, res: 35, reload: 2200, auto: false, spread: .003, mv: .05, kick: .09, speed: 1, reward: 300 },
  mp9:    { name: 'MP9',    slot: 'primary', price: 1250, dmg: 18, hs: 3, rate: 70, mag: 30, res: 120, reload: 2100, auto: true, spread: .008, mv: .035, kick: .012, speed: 1.02, reward: 600 },
  ak:     { name: 'AK-47',  slot: 'primary', price: 2700, dmg: 36, hs: 4, rate: 100, mag: 30, res: 90, reload: 2400, auto: true, spread: .006, mv: .06, kick: .02, speed: .96, reward: 300 },
  awp:    { name: 'AWP',    slot: 'primary', price: 4750, dmg: 115, hs: 1.2, rate: 1450, mag: 5, res: 20, reload: 3000, auto: false, spread: 0, mv: .15, kick: .1, speed: .85, reward: 100, scope: true }
};

const app = express();
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/maps', (_q, res) => res.json({ maps: MAPS, weapons: WEAPONS }));
app.get('/health', (_q, res) => res.json({ ok: true, players: players.size, map: MAPS[mapIdx].name }));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/game' });
const players = new Map();
let mapIdx = 0, phase = 'freeze', phaseEnds = Date.now() + FREEZE, roundStart = 0, matchOver = false;
const scores = { CT: 0, T: 0 };

const send = (p, o) => { if (p.socket.readyState === WebSocket.OPEN) p.socket.send(JSON.stringify(o)); };
const broadcast = (o) => { for (const p of players.values()) send(p, o); };
const hgt = (p) => (p.crouch ? P.HC : P.HS);
const eye = (p) => p.y + (p.crouch ? 1.18 : 1.62);
const curW = (p) => WEAPONS[p.load[p.cur]];
const safeName = (v) => (String(v || 'Rookie').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 16) || 'Rookie');

function give(p, id) { const w = WEAPONS[id]; p.load[w.slot] = id; p.ammo[id] = w.mag || 0; p.res[id] = w.res || 0; p.cur = w.slot; p.reloadUntil = 0; }
function resetLoadout(p) { p.load = { primary: null, secondary: null, knife: null }; p.ammo = {}; p.res = {}; give(p, 'knife'); give(p, 'usp'); }
function placeAt(p, i) {
  const s = MAPS[mapIdx].spawns[p.team][i % 5];
  p.x = s.x + (Math.random() - .5) * .6; p.z = s.z; p.y = 0; p.crouch = false; p.budget = 3; p.vb = 2.5;
  p.yaw = p.team === 'CT' ? Math.PI : 0; p.pitch = 0;
  send(p, { type: 'respawn', x: p.x, y: 0, z: p.z, yaw: p.yaw });
}
function startRound(now) {
  phase = 'freeze'; phaseEnds = now + FREEZE; matchOver = false;
  const idx = { CT: 0, T: 0 };
  for (const p of players.values()) {
    if (p.health <= 0) resetLoadout(p);
    for (const id of Object.values(p.load)) if (id) { p.ammo[id] = WEAPONS[id].mag || 0; p.res[id] = WEAPONS[id].res || 0; }
    p.health = 100; p.reloadUntil = 0; p.firedPress = p.input.press || 0;
    placeAt(p, idx[p.team]++);
  }
}
function endRound(win, now) {
  phase = 'end'; phaseEnds = now + END; scores[win]++;
  for (const p of players.values()) p.money = Math.min(16000, p.money + (p.team === win ? 3250 : 1400));
  matchOver = scores[win] >= WIN_ROUNDS;
  const name = win === 'CT' ? 'COUNTER-TERRORISTS' : 'TERRORISTS';
  broadcast({ type: 'round', text: matchOver ? `${name} WIN THE MATCH` : `${name} WIN THE ROUND`, win });
}
function newMatch() {
  scores.CT = scores.T = 0; mapIdx = (mapIdx + 1) % MAPS.length;
  for (const p of players.values()) { p.money = 800; p.kills = p.deaths = 0; resetLoadout(p); p.health = 0; }
  broadcast({ type: 'map', map: mapIdx });
}
function startReload(p, now) {
  const w = curW(p); if (w.melee || p.reloadUntil || p.health <= 0 || p.ammo[p.load[p.cur]] >= w.mag || p.res[p.load[p.cur]] <= 0) return;
  p.reloadUntil = now + w.reload;
}

function raySphere(o, d, cx, cy, cz, r) {
  const vx = cx - o.x, vy = cy - o.y, vz = cz - o.z, t = vx * d.x + vy * d.y + vz * d.z;
  if (t <= 0) return Infinity;
  const px = vx - t * d.x, py = vy - t * d.y, pz = vz - t * d.z;
  return px * px + py * py + pz * pz <= r * r ? t : Infinity;
}
function rayBox(o, d, b) {
  const mn = [b.x - b.w / 2, b.y, b.z - b.d / 2], mx = [b.x + b.w / 2, b.y + b.h, b.z + b.d / 2], oo = [o.x, o.y, o.z], dd = [d.x, d.y, d.z];
  let a = 0, c = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(dd[i]) < 1e-8) { if (oo[i] < mn[i] || oo[i] > mx[i]) return Infinity; continue; }
    let t1 = (mn[i] - oo[i]) / dd[i], t2 = (mx[i] - oo[i]) / dd[i]; if (t1 > t2) [t1, t2] = [t2, t1];
    a = Math.max(a, t1); c = Math.min(c, t2); if (c < a) return Infinity;
  }
  return a;
}

function tryShot(s, now) {
  const id = s.load[s.cur], w = WEAPONS[id];
  if (s.health <= 0 || phase !== 'live' || s.reloadUntil || now - s.lastShot < w.rate) return false;
  if (!w.melee && s.ammo[id] <= 0) { startReload(s, now); return true; }
  s.lastShot = now; if (!w.melee) s.ammo[id]--;
  const inp = s.input;
  let sp = w.melee ? 0 : w.spread * (s.crouch ? .6 : 1) + (inp.moving ? w.mv : 0) + (inp.air ? .12 : 0) + (w.scope && !inp.scoped ? .12 : 0);
  const yaw = s.yaw + (Math.random() - .5) * sp * 2, pitch = s.pitch + (Math.random() - .5) * sp * 2, cp = Math.cos(pitch);
  const dir = { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp }, o = { x: s.x, y: eye(s), z: s.z };
  const range = w.range || 80;
  let best = null, bt = range, part = 1;
  for (const t of players.values()) {
    if (t.id === s.id || t.health <= 0 || t.team === s.team) continue;
    const c = t.crouch;
    const th = raySphere(o, dir, t.x, t.y + (c ? 1.15 : 1.58), t.z, .24);
    const tc = raySphere(o, dir, t.x, t.y + (c ? .78 : 1.1), t.z, .42);
    const tl = raySphere(o, dir, t.x, t.y + (c ? .3 : .4), t.z, .36);
    const hit = Math.min(th, tc, tl);
    if (hit >= bt || P && MAPS[mapIdx].blocks.some(b => rayBox(o, dir, b) < hit)) continue;
    best = t; bt = hit; part = hit === th ? 0 : hit === tc ? 1 : 2;
  }
  if (best) {
    const dmg = Math.round(w.dmg * (part === 0 ? w.hs : part === 2 ? .75 : 1));
    best.health = Math.max(0, best.health - dmg);
    send(s, { type: 'shot', hit: true, head: part === 0 });
    send(best, { type: 'hurt' });
    if (best.health === 0) {
      s.kills++; best.deaths++; best.died = true; best.respawnAt = now + 2500; best.reloadUntil = 0;
      s.money = Math.min(16000, s.money + w.reward);
      broadcast({ type: 'kill', killer: s.name, victim: best.name, kt: s.team, vt: best.team, weapon: w.name, head: part === 0 });
    }
  }
  if (!w.melee && s.ammo[id] === 0) startReload(s, now);
  return true;
}

wss.on('connection', (socket) => {
  const id = crypto.randomBytes(8).toString('hex');
  const cnt = { CT: 0, T: 0 }; for (const q of players.values()) cnt[q.team]++;
  const team = cnt.CT < cnt.T ? 'CT' : cnt.T < cnt.CT ? 'T' : (Math.random() < .5 ? 'CT' : 'T');
  const p = { id, socket, name: 'Rookie', team, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, crouch: false, health: 0, kills: 0, deaths: 0, money: 800,
    load: {}, ammo: {}, res: {}, cur: 'secondary', reloadUntil: 0, lastShot: 0, firedPress: 0, respawnAt: 0, died: false, budget: 3, vb: 2.5, alive: true,
    input: { shoot: false, press: 0 } };
  resetLoadout(p); players.set(id, p);
  send(p, { type: 'welcome', id, team, map: mapIdx });
  const solo = players.size < 2 || [...players.values()].every(q => q.team === team);
  if (phase === 'freeze' || solo) { p.health = 100; placeAt(p, cnt[team]); }
  socket.on('pong', () => { p.alive = true; });

  socket.on('message', (raw) => {
    if (raw.length > 2048) return;
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    const now = Date.now();
    if (m.type === 'join') { p.name = safeName(m.name); send(p, { type: 'joined', name: p.name }); broadcast({ type: 'feed', text: `${p.name} joined ${p.team}` }); }
    else if (m.type === 'reload') startReload(p, now);
    else if (m.type === 'slot' && p.health > 0 && p.load[m.slot]) { p.cur = m.slot; p.reloadUntil = 0; }
    else if (m.type === 'buy' && p.health > 0 && (phase === 'freeze' || (phase === 'live' && now - roundStart < BUY_LIVE))) {
      const w = WEAPONS[m.item]; if (w && w.price > 0 && p.money >= w.price) { p.money -= w.price; give(p, m.item); }
    } else if (m.type === 'input' && m.input && p.health > 0) {
      const i = m.input;
      if (Number.isFinite(i.yaw)) p.yaw = i.yaw;
      if (Number.isFinite(i.pitch)) p.pitch = clamp(i.pitch, -1.6, 1.6);
      p.input = { shoot: !!i.shoot, press: Number(i.press) | 0, scoped: !!i.scoped, moving: !!i.moving, air: !!i.air };
      p.crouch = !!i.crouch;
      if (phase === 'freeze') return;
      if ([i.x, i.y, i.z].every(Number.isFinite)) {
        const d = Math.hypot(i.x - p.x, i.z - p.z), dy = i.y - p.y, bl = MAPS[mapIdx].blocks;
        const ok = d <= p.budget + .05 && dy <= p.vb + .05 && i.y >= P.floorAt(bl, i.x, i.z, i.y) - .06 && !P.blocked(bl, i.x, i.z, i.y, hgt(p));
        if (ok) { p.x = i.x; p.y = i.y; p.z = i.z; p.budget = Math.max(0, p.budget - d); p.vb = Math.max(0, p.vb - Math.max(0, dy)); }
        else send(p, { type: 'correct', x: p.x, y: p.y, z: p.z });
      }
    }
  });
  socket.on('close', () => { players.delete(id); broadcast({ type: 'feed', text: `${p.name} left` }); });
});

setInterval(() => { for (const p of players.values()) { if (!p.alive) { p.socket.terminate(); continue; } p.alive = false; try { p.socket.ping(); } catch {} } }, 15000);

let prev = Date.now(), acc = 0;
setInterval(() => {
  const now = Date.now(), dt = Math.min(.05, (now - prev) / 1000); prev = now;
  const list = [...players.values()];
  const nCT = list.filter(p => p.team === 'CT').length, nT = list.length - nCT, versus = nCT > 0 && nT > 0;
  for (const p of list) {
    p.budget = Math.min(3, p.budget + 9.75 * dt); p.vb = Math.min(2.5, p.vb + 8 * dt);
    if (p.health > 0 && p.reloadUntil && now >= p.reloadUntil) {
      const id = p.load[p.cur], w = WEAPONS[id], take = Math.min(w.mag - p.ammo[id], p.res[id]); p.ammo[id] += take; p.res[id] -= take; p.reloadUntil = 0;
    }
    if (p.health > 0 && phase === 'live') {
      const w = curW(p), want = w.auto ? p.input.shoot : p.input.press > p.firedPress;
      if (want && tryShot(p, now)) p.firedPress = p.input.press;
    }
    if (p.health <= 0 && !versus && p.respawnAt && now >= p.respawnAt) { p.respawnAt = 0; p.health = 100; if (p.died) { resetLoadout(p); p.died = false; } placeAt(p, 0); }
  }
  if (phase === 'freeze' && now >= phaseEnds) { phase = 'live'; roundStart = now; phaseEnds = now + ROUND; }
  else if (phase === 'live') {
    if (versus) {
      const aCT = list.filter(p => p.team === 'CT' && p.health > 0).length, aT = list.filter(p => p.team === 'T' && p.health > 0).length;
      if (aCT === 0) endRound('T', now); else if (aT === 0) endRound('CT', now); else if (now >= phaseEnds) endRound('CT', now);
    } else if (now >= phaseEnds) startRound(now);
  } else if (phase === 'end' && now >= phaseEnds) { if (matchOver) newMatch(); startRound(now); }

  acc += dt;
  if (acc >= 1 / SNAP) {
    acc = 0;
    broadcast({ type: 'state', phase, map: mapIdx, scores, timeLeft: Math.max(0, Math.ceil((phaseEnds - now) / 1000)),
      players: list.map(p => ({ id: p.id, name: p.name, team: p.team, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, crouch: p.crouch, health: p.health,
        kills: p.kills, deaths: p.deaths, money: p.money, cur: p.cur, pr: p.load.primary, se: p.load.secondary, ammo: p.ammo[p.load[p.cur]], res: p.res[p.load[p.cur]], reloading: !!p.reloadUntil })) });
  }
}, 1000 / TICK);

server.listen(PORT, '0.0.0.0', () => console.log(`Tactical FPS running at http://localhost:${PORT}`));
