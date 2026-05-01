// Minimal multiplayer relay server for Sticky Roller / Hole.io clone.
// One global room, no auth, no anti-cheat. Just enough to demo eating each other.
//
// Run: node server.mjs   (default port 8080)
//
// Protocol (JSON over WebSocket):
//   server -> client:  { t: "hello",  id, seed, players }   (on connect)
//   server -> client:  { t: "join",   id, name }            (other player joined)
//   server -> client:  { t: "leave",  id }                  (other player left)
//   server -> client:  { t: "state",  id, x, z, r, name }   (position broadcast)
//   server -> client:  { t: "eaten",  victim, eater }       (eaten event)
//   client -> server:  { t: "name",   name }
//   client -> server:  { t: "state",  x, z, r }
//   client -> server:  { t: "eat",    victim }              (claim: I ate them)

import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 8080);
const wss = new WebSocketServer({ port: PORT });

// One global "room" — same map seed for everyone for the server's lifetime.
const seed = (Date.now() & 0xfffff) ^ ((Math.random() * 0xfffff) | 0);

let nextId = 1;
const players = new Map(); // id -> { ws, name, x, z, r }

function broadcast(obj, exceptId) {
  const msg = JSON.stringify(obj);
  for (const [id, p] of players) {
    if (id === exceptId) continue;
    if (p.ws.readyState === 1) p.ws.send(msg);
  }
}

wss.on("connection", (ws) => {
  const id = nextId++;
  const me = { ws, name: `player${id}`, x: 0, z: 0, r: 1 };
  players.set(id, me);

  // Tell new player who they are + map seed + current roster
  const roster = [];
  for (const [pid, p] of players) {
    if (pid === id) continue;
    roster.push({ id: pid, name: p.name, x: p.x, z: p.z, r: p.r });
  }
  ws.send(JSON.stringify({ t: "hello", id, seed, players: roster }));
  broadcast({ t: "join", id, name: me.name }, id);

  ws.on("message", (data) => {
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (!m || typeof m.t !== "string") return;

    if (m.t === "name" && typeof m.name === "string") {
      me.name = String(m.name).slice(0, 20);
      broadcast({ t: "join", id, name: me.name }, id);
      return;
    }

    if (m.t === "state") {
      me.x = +m.x || 0;
      me.z = +m.z || 0;
      me.r = +m.r || 1;
      broadcast({ t: "state", id, x: me.x, z: me.z, r: me.r, name: me.name }, id);
      return;
    }

    if (m.t === "eat" && typeof m.victim === "number") {
      const victim = players.get(m.victim);
      if (!victim) return;
      // Sanity check: eater must actually be bigger and within reach.
      const dx = me.x - victim.x;
      const dz = me.z - victim.z;
      const d = Math.hypot(dx, dz);
      if (me.r > victim.r * 1.15 && d <= me.r + victim.r * 0.5) {
        // Reset victim's size on their side; broadcast to everyone.
        victim.r = 1;
        broadcast({ t: "eaten", victim: m.victim, eater: id });
      }
      return;
    }
  });

  ws.on("close", () => {
    players.delete(id);
    broadcast({ t: "leave", id });
  });
});

console.log(`[server] listening ws://localhost:${PORT}  (seed=${seed})`);
