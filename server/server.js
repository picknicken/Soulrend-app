/* Soulrend server: accounts, saves, presence, chat and mod tools.
   The game rules still run in each client (friends-only trust model). The server stores saves,
   shows players to each other, relays chat and executes mod commands.
   Env: PORT, DATA_DIR, MOD_NAME (default "Mod"), MOD_PASS (required to enable the mod account). */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = +process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MOD_NAME = process.env.MOD_NAME || 'Mod';
const MOD_PASS = process.env.MOD_PASS || '';
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'accounts.json');

let db = {};
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { db = {}; }
let dirty = false, writing = false;
function flush() {
  if (!dirty || writing) return;
  dirty = false; writing = true;
  const tmp = DB_FILE + '.tmp';
  fs.writeFile(tmp, JSON.stringify(db), err => {
    if (!err) try { fs.renameSync(tmp, DB_FILE); } catch (e) { console.error('db rename', e.message); }
    writing = false; if (dirty) setTimeout(flush, 200);
  });
}
const touch = () => { dirty = true; setTimeout(flush, 1500); };
const key = n => String(n).toLowerCase();
const hashPass = (pass, salt) => crypto.scryptSync(String(pass), salt, 32).toString('hex');
const okName = n => typeof n === 'string' && /^[A-Za-z0-9_ -]{3,16}$/.test(n) && n.trim() === n;
const okItem = i => typeof i === 'string' && /^[a-z0-9_]{1,40}$/.test(i);
const okSkill = i => typeof i === 'string' && /^[a-z]{3,20}$/.test(i);

function ensureMod() {
  if (!MOD_PASS) { console.warn('MOD_PASS not set: the mod account is disabled.'); return; }
  const k = key(MOD_NAME), salt = db[k] ? db[k].salt : crypto.randomBytes(16).toString('hex');
  db[k] = Object.assign(db[k] || { created: Date.now(), save: null }, { name: MOD_NAME, salt, hash: hashPass(MOD_PASS, salt), role: 'mod' });
  touch();
}
ensureMod();

const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('Soulrend server ' + online.size + ' online\n'); });
const wss = new WebSocketServer({ server, maxPayload: 600 * 1024 });
const online = new Map(); // key -> session

const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
const broadcast = o => { const s = JSON.stringify(o); for (const c of online.values()) if (c.ws.readyState === 1) c.ws.send(s); };

function publicList(except) {
  const out = [];
  for (const c of online.values()) if (c !== except && c.pos) out.push({ n: c.name, r: c.role, m: c.pos.map, x: c.pos.x, y: c.pos.y, f: c.pos.face, eq: c.pos.eq });
  return out;
}
let lastSig = '';
setInterval(() => {
  const sig = JSON.stringify(publicList(null));
  const force = Date.now() % 5000 < 600;
  if (sig === lastSig && !force) return;
  lastSig = sig;
  for (const c of online.values()) send(c.ws, { t: 'players', list: publicList(c) });
}, 600);
setInterval(() => { flush(); for (const c of online.values()) { if (c.alive === false) { c.ws.terminate(); continue; } c.alive = false; try { c.ws.ping(); } catch (e) {} } }, 15000);

/* Shared world: the first player on a map simulates its monsters (the "host") and everyone else follows.
   The server only decides who the host is and relays messages; it does not run game rules. */
const hosts = {}; // map -> player key
function reelect(map) {
  if (!map || map === 'home') return;
  const here = [...online.entries()].filter(([, c]) => c.pos && c.pos.map === map);
  let h = hosts[map];
  if (!h || !here.some(([k]) => k === h)) {
    here.sort((a, b) => (a[1].mapSince || 0) - (b[1].mapSince || 0));
    h = here.length ? here[0][0] : null;
    if (h) hosts[map] = h; else delete hosts[map];
  }
  const name = h ? online.get(h).name : null;
  for (const [, c] of here) send(c.ws, { t: 'host', map, host: name });
}
function logMod(c, what) { console.log(`[mod] ${c.name}: ${what}`); }

function applyOffline(acc, op, m) {
  const s = acc.save; if (!s) return false;
  if (op === 'item') {
    s.inv = s.inv || {}; s.inv[m.item] = Math.max(0, (s.inv[m.item] || 0) + m.n); if (!s.inv[m.item]) delete s.inv[m.item];
  } else if (op === 'xp') {
    s.xp = s.xp || {}; s.xp[m.skill] = m.set !== undefined ? Math.max(0, m.set) : Math.max(0, (s.xp[m.skill] || 0) + m.delta);
  } else if (op === 'coins') { s.coins = Math.max(0, (s.coins || 0) + m.n); }
  touch(); return true;
}

function viewData(acc, c) {
  const d = c && c.snap ? c.snap : acc.save || {};
  return { inv: d.inv || {}, bank: d.bank || {}, eq: d.eq || {}, xp: d.xp || {}, coins: d.coins || 0, pet: d.pet || null };
}

function handleMod(c, m) {
  if (c.role !== 'mod') return send(c.ws, { t: 'error', m: 'Not a mod.' });
  const target = m.name ? db[key(m.name)] : null;
  const tc = target ? online.get(key(m.name)) : null;
  switch (m.op) {
    case 'players': {
      const list = Object.values(db).map(a => { const o = online.get(key(a.name)); return { name: a.name, role: a.role, online: !!o, map: o && o.pos ? o.pos.map : null, x: o && o.pos ? o.pos.x : null, y: o && o.pos ? o.pos.y : null, last: a.last || 0 }; });
      return send(c.ws, { t: 'mod', op: 'players', list });
    }
    case 'view':
      if (!target) return send(c.ws, { t: 'error', m: 'No such player.' });
      return send(c.ws, { t: 'mod', op: 'view', name: target.name, online: !!tc, data: viewData(target, tc) });
    case 'item': case 'xp': case 'coins': {
      if (!target) return send(c.ws, { t: 'error', m: 'No such player.' });
      const cmd = { op: m.op };
      if (m.op === 'item') { if (!okItem(m.item) || !Number.isFinite(m.n)) return; cmd.item = m.item; cmd.n = Math.trunc(m.n); }
      else if (m.op === 'xp') { if (!okSkill(m.skill)) return; cmd.skill = m.skill; if (m.set !== undefined) cmd.set = Math.max(0, +m.set || 0); else cmd.delta = Math.trunc(+m.delta || 0); }
      else cmd.n = Math.trunc(+m.n || 0);
      logMod(c, `${m.op} ${JSON.stringify(cmd)} -> ${target.name}`);
      if (tc) send(tc.ws, { t: 'cmd', ...cmd, by: c.name }); else applyOffline(target, m.op, cmd);
      return send(c.ws, { t: 'mod', op: 'done', msg: `${m.op} applied to ${target.name}${tc ? '' : ' (offline)'}.` });
    }
    case 'maxall': {
      if (!target) return;
      const xp = Math.max(0, +m.xp || 0), skills = Array.isArray(m.skills) ? m.skills.filter(okSkill) : [];
      logMod(c, `maxall -> ${target.name}`);
      for (const sk of skills) { if (tc) send(tc.ws, { t: 'cmd', op: 'xp', skill: sk, set: xp, by: c.name }); else applyOffline(target, 'xp', { skill: sk, set: xp }); }
      return send(c.ws, { t: 'mod', op: 'done', msg: `All skills set for ${target.name}.` });
    }
    case 'tp': // mod goes to a player
      if (!tc || !tc.pos) return send(c.ws, { t: 'error', m: 'Player is offline.' });
      return send(c.ws, { t: 'mod', op: 'tp', map: tc.pos.map, x: tc.pos.x, y: tc.pos.y });
    case 'bring':
      if (!tc || !c.pos) return send(c.ws, { t: 'error', m: 'Player is offline.' });
      logMod(c, `bring ${target.name}`);
      return send(tc.ws, { t: 'cmd', op: 'tp', map: c.pos.map, x: c.pos.x, y: c.pos.y, by: c.name });
    case 'kick':
      if (!tc) return; logMod(c, `kick ${target.name}`); send(tc.ws, { t: 'error', m: 'You were removed by a mod.' }); tc.ws.close(); return;
    case 'announce': {
      const text = String(m.text || '').slice(0, 160); if (!text) return;
      logMod(c, `announce ${text}`); return broadcast({ t: 'chat', from: 'Server', r: 'sys', text });
    }
  }
}

wss.on('connection', ws => {
  let c = null; ws.on('pong', () => { if (c) c.alive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    if (!c) {
      if (m.t !== 'login' && m.t !== 'register') return;
      if (!okName(m.name) || typeof m.pass !== 'string' || m.pass.length < 4 || m.pass.length > 64) return send(ws, { t: 'error', m: 'Name: 3-16 letters, numbers, space, - or _. Password: 4+ characters.' });
      const k = key(m.name);
      let acc = db[k];
      if (m.t === 'register') {
        if (acc) return send(ws, { t: 'error', m: 'That name is taken.' });
        const salt = crypto.randomBytes(16).toString('hex');
        acc = db[k] = { name: m.name, salt, hash: hashPass(m.pass, salt), role: 'player', created: Date.now(), save: (m.save && typeof m.save === 'object') ? m.save : null };
        touch(); console.log('new account', m.name);
      } else if (!acc || !crypto.timingSafeEqual(Buffer.from(hashPass(m.pass, acc.salt), 'hex'), Buffer.from(acc.hash, 'hex'))) {
        return send(ws, { t: 'error', m: 'Wrong name or password.' });
      }
      const old = online.get(k); if (old) { send(old.ws, { t: 'error', m: 'Logged in somewhere else.' }); old.ws.close(); }
      c = { ws, name: acc.name, role: acc.role, pos: null, snap: null, lastChat: 0, alive: true };
      online.set(k, c); acc.last = Date.now(); touch();
      send(ws, { t: 'welcome', name: acc.name, role: acc.role, save: acc.save, online: online.size });
      broadcast({ t: 'chat', from: 'Server', r: 'sys', text: acc.name + ' joined.' });
      console.log('login', acc.name, acc.role);
      return;
    }
    const acc = db[key(c.name)];
    switch (m.t) {
      case 'pos':
        if (typeof m.map !== 'string' || m.map.length > 12) return;
      {
        const prev = c.pos ? c.pos.map : null;
        c.pos = { map: m.map, x: m.x | 0, y: m.y | 0, face: String(m.face || 'down').slice(0, 6), eq: m.eq && typeof m.eq === 'object' ? m.eq : {} };
        if (prev !== m.map) { c.mapSince = Date.now(); if (prev) reelect(prev); reelect(m.map); }
      }
        break;
      case 'rel': { // relay an event to one player (hits, kill credit, mob attacks)
        if (!m.ev || typeof m.ev !== 'object') return;
        const tc = online.get(key(m.to)); if (tc) send(tc.ws, { t: 'rel', from: c.name, ev: m.ev });
        break;
      }
      case 'mc': { // cast an event to everyone else on the same map (monster snapshots)
        if (!c.pos || c.pos.map !== m.map || !m.ev || typeof m.ev !== 'object') return;
        const s2 = JSON.stringify({ t: 'mc', from: c.name, map: m.map, ev: m.ev });
        for (const o of online.values()) if (o !== c && o.pos && o.pos.map === m.map && o.ws.readyState === 1) o.ws.send(s2);
        break;
      }
      case 'save':
        if (m.save && typeof m.save === 'object') { acc.save = m.save; touch(); }
        break;
      case 'snap':
        if (m.snap && typeof m.snap === 'object') c.snap = m.snap;
        break;
      case 'chat': {
        const now = Date.now(); if (now - c.lastChat < 350) return; c.lastChat = now;
        const text = String(m.text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 160); if (!text) return;
        if (m.to) {
          const tc = online.get(key(m.to)); if (!tc) return send(ws, { t: 'chat', from: 'Server', r: 'sys', text: m.to + ' is not online.' });
          const msg = { t: 'chat', from: c.name, r: c.role, text, w: true };
          send(tc.ws, Object.assign({ to: tc.name }, msg)); send(ws, Object.assign({ to: tc.name }, msg)); return;
        }
        broadcast({ t: 'chat', from: c.name, r: c.role, text });
        break;
      }
      case 'mod': handleMod(c, m); break;
    }
  });
  ws.on('close', () => {
    if (c && online.get(key(c.name)) === c) { online.delete(key(c.name)); if (c.pos) reelect(c.pos.map); broadcast({ t: 'chat', from: 'Server', r: 'sys', text: c.name + ' left.' }); }
  });
  ws.on('error', () => {});
});

process.on('SIGTERM', () => { dirty = true; flush(); setTimeout(() => process.exit(0), 400); });
server.listen(PORT, () => console.log('Soulrend server on :' + PORT));
