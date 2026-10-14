/* Smoke test: node test.js (starts its own server on a temp data dir). */
const { spawn } = require('child_process'), WebSocket = require('ws'), os = require('os'), fs = require('fs'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-')), port = 18099;
const srv = spawn('node', ['server.js'], { env: Object.assign({}, process.env, { PORT: port, DATA_DIR: dir, MOD_PASS: 'modpass1' }), stdio: 'inherit' });
const wait = ms => new Promise(r => setTimeout(r, ms));
function client() { const ws = new WebSocket('ws://localhost:' + port), inbox = []; ws.on('message', d => inbox.push(JSON.parse(d)));
  return new Promise(r => ws.on('open', () => r({ ws, inbox, send: o => ws.send(JSON.stringify(o)), last: t => [...inbox].reverse().find(m => m.t === t) }))); }
let fails = 0; const ok = (c, n) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
(async () => {
  await wait(700);
  const a = await client(); a.send({ t: 'register', name: 'Alice', pass: 'pw1234', save: { inv: { logs: 3 }, xp: { combat: 10 }, coins: 5 } }); await wait(200);
  ok(a.last('welcome') && a.last('welcome').role === 'player', 'register + welcome');
  const b = await client(); b.send({ t: 'register', name: 'Bob', pass: 'pw1234', save: null }); await wait(200);
  const bad = await client(); bad.send({ t: 'login', name: 'Alice', pass: 'nope!' }); await wait(200);
  ok(bad.last('error'), 'wrong password rejected');
  a.send({ t: 'pos', map: 'world', x: 10, y: 12, face: 'down', eq: { weapon: 'iron_sword' } }); b.send({ t: 'pos', map: 'world', x: 11, y: 12, face: 'up', eq: {} }); await wait(900);
  ok(b.last('players') && b.last('players').list.some(p => p.n === 'Alice' && p.x === 10), 'presence visible');
  a.send({ t: 'chat', text: 'hello' }); await wait(200);
  ok(b.last('chat') && b.inbox.some(m => m.t === 'chat' && m.text === 'hello' && m.from === 'Alice'), 'chat broadcast');
  const mod = await client(); mod.send({ t: 'login', name: 'Mod', pass: 'modpass1' }); await wait(200);
  ok(mod.last('welcome') && mod.last('welcome').role === 'mod', 'mod login');
  a.send({ t: 'mod', op: 'players' }); await wait(150); ok(!a.inbox.some(m => m.t === 'mod'), 'player cannot use mod ops');
  mod.send({ t: 'mod', op: 'players' }); await wait(150); ok(mod.last('mod') && mod.last('mod').list.length === 3, 'mod lists players');
  mod.send({ t: 'mod', op: 'item', name: 'Alice', item: 'yew_logs', n: 7 }); await wait(200);
  ok(a.inbox.some(m => m.t === 'cmd' && m.item === 'yew_logs' && m.n === 7), 'online give goes to client');
  b.ws.close(); await wait(300);
  mod.send({ t: 'mod', op: 'item', name: 'Alice', item: 'logs', n: -1 }); b.ws.terminate();
  mod.send({ t: 'mod', op: 'xp', name: 'Bob', skill: 'combat', delta: 500 }); await wait(200);
  mod.send({ t: 'mod', op: 'view', name: 'Bob' }); await wait(200);
  ok(mod.last('mod') && mod.last('mod').op === 'view', 'view offline player (no save yet is fine)');
  mod.send({ t: 'mod', op: 'tp', name: 'Alice' }); await wait(150);
  ok(mod.inbox.some(m => m.t === 'mod' && m.op === 'tp' && m.x === 10), 'teleport target position');
  mod.send({ t: 'mod', op: 'view', name: 'Alice' }); await wait(150);
  ok(mod.last('mod').data.inv.logs === 3, 'view inventory from save');
  // shared world: host election, map cast and relay
  const h1 = await client(); h1.send({ t: 'register', name: 'Host1', pass: 'pw1234', save: null }); await wait(150);
  const h2 = await client(); h2.send({ t: 'register', name: 'Host2', pass: 'pw1234', save: null }); await wait(150);
  h1.send({ t: 'pos', map: 'marsh', x: 1, y: 1, face: 'down', eq: {} }); await wait(150);
  h2.send({ t: 'pos', map: 'marsh', x: 2, y: 1, face: 'down', eq: {} }); await wait(200);
  ok(h2.last('host') && h2.last('host').host === 'Host1', 'first player on a map is host');
  h1.send({ t: 'mc', map: 'marsh', ev: { k: 'mobs', l: [[1, 2, 3]] } }); await wait(150);
  ok(h2.inbox.some(m => m.t === 'mc' && m.ev.k === 'mobs'), 'map cast reaches others');
  ok(!h1.inbox.some(m => m.t === 'mc'), 'map cast skips sender');
  h2.send({ t: 'rel', to: 'Host1', ev: { k: 'hit', id: 4, d: 3 } }); await wait(150);
  ok(h1.inbox.some(m => m.t === 'rel' && m.from === 'Host2' && m.ev.d === 3), 'relay to one player');
  h1.ws.close(); await wait(300);
  ok(h2.last('host') && h2.last('host').host === 'Host2', 'host moves when host leaves');
  srv.kill(); await wait(300); process.exit(fails ? 1 : 0);
})();
