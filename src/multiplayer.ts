// Minimal multiplayer client. Connects to ws://<host>:8080 and tracks
// other players' hole positions. Other holes are rendered by main.ts.
//
// Public API:
//   connectMultiplayer(opts) — opens the socket, returns immediately.
//   sendState(x, z, r)       — call ~10x/sec from the game loop.
//   claimEat(victimId)       — call when local hole overlaps a smaller remote one.
//   onRemoteUpdate(cb)       — register callback for remote state.
//   onRemoteLeave(cb)        — register callback when a remote leaves.
//   onMapSeed(cb)            — register callback for the server's map seed.
//   onEaten(cb)              — register callback when an eat event is broadcast.
//   getMyId()                — returns local player id (0 until connected).

type StateCb = (id: number, x: number, z: number, r: number, name: string) => void;
type LeaveCb = (id: number) => void;
type SeedCb = (seed: number) => void;
type EatCb = (victim: number, eater: number) => void;

let socket: WebSocket | null = null;
let myId = 0;
let stateCb: StateCb | null = null;
let leaveCb: LeaveCb | null = null;
let seedCb: SeedCb | null = null;
let eatCb: EatCb | null = null;
let lastSendAt = 0;

export function getMyId() { return myId; }
export function isConnected() { return !!socket && socket.readyState === WebSocket.OPEN; }

export function onRemoteUpdate(cb: StateCb) { stateCb = cb; }
export function onRemoteLeave(cb: LeaveCb) { leaveCb = cb; }
export function onMapSeed(cb: SeedCb) { seedCb = cb; }
export function onEaten(cb: EatCb) { eatCb = cb; }

export function connectMultiplayer(opts: { url?: string; name?: string } = {}) {
  // Default URL: same host as the page, port 8080.
  const host = location.hostname || "localhost";
  const url = opts.url ?? `ws://${host}:8080`;
  try {
    socket = new WebSocket(url);
  } catch (e) {
    console.warn("[mp] connect failed:", e);
    return;
  }
  socket.addEventListener("open", () => {
    if (opts.name) socket?.send(JSON.stringify({ t: "name", name: opts.name }));
  });
  socket.addEventListener("message", (ev) => {
    let m: any;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (!m || !m.t) return;
    if (m.t === "hello") {
      myId = m.id;
      if (typeof m.seed === "number" && seedCb) seedCb(m.seed);
      if (Array.isArray(m.players)) {
        for (const p of m.players) {
          stateCb?.(p.id, p.x, p.z, p.r, p.name);
        }
      }
    } else if (m.t === "join") {
      stateCb?.(m.id, 0, 0, 1, m.name);
    } else if (m.t === "state") {
      stateCb?.(m.id, m.x, m.z, m.r, m.name);
    } else if (m.t === "leave") {
      leaveCb?.(m.id);
    } else if (m.t === "eaten") {
      eatCb?.(m.victim, m.eater);
    }
  });
  socket.addEventListener("close", () => { socket = null; });
  socket.addEventListener("error", () => { /* swallow */ });
}

export function sendState(x: number, z: number, r: number) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const now = performance.now();
  if (now - lastSendAt < 90) return; // ~10/sec
  lastSendAt = now;
  socket.send(JSON.stringify({ t: "state", x, z, r }));
}

export function claimEat(victimId: number) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ t: "eat", victim: victimId }));
}
