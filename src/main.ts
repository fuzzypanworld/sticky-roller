import "./style.css";
import * as THREE from "three";
import * as CANNON from "cannon-es";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import * as MP from "./multiplayer";
void MP;

type StickyKind =
  | "trash" | "cone" | "bike" | "person" | "breakable" | "civilian" | "car" | "spike"
  | "mailbox" | "hydrant" | "bench" | "lamppost" | "police"
  | "building_S" | "building_M" | "building_L";

type StickyObject = {
  id: number;
  kind: StickyKind;
  value: number;
  radius: number;
  mesh: THREE.Object3D;
  body: CANNON.Body;
  stuck: boolean;
  tier: number;          // hole tier required to swallow
  falling?: { startY: number; t: number; dur: number };
  // For NPCs that move
  npc?: NPCState;
  chunkIndex?: number;
};

type NPCState =
  | { type: "civilian"; sideX: number; dir: 1 | -1; speed: number; phase: number }
  | { type: "car"; speed: number; lane: number; axis?: "x" | "z" };

// ---------- Renderer / scene / camera ----------
const canvas = document.getElementById("c") as HTMLCanvasElement;
const elSize = document.getElementById("size")!;
const elScore = document.getElementById("score")!;

// New Hole.io-style HUD elements
const elMissionGoal = document.getElementById("missionGoal");
const elMissionFill = document.getElementById("missionFill");
const elXpFill = document.getElementById("xpFill");
const elTimerText = document.getElementById("timerText");
const elKillCount = document.getElementById("killCount");
const elNameplate = document.getElementById("nameplate");
const elNpLvl = document.getElementById("npLvl");
const elNpHpFill = document.getElementById("npHpFill");
const elNpHpCur = document.getElementById("npHpCur");
const elNpHpMax = document.getElementById("npHpMax");

// Mission + counters
const MISSION_GOAL = 20;
let lampPostsEaten = 0;
let killCount = 0;
let gameStartedAt = 0;
const MATCH_DURATION_MS = 3 * 60 * 1000;
if (elMissionGoal) elMissionGoal.textContent = String(MISSION_GOAL);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();

// Gradient sky background
function makeSkyTexture() {
  const c = document.createElement("canvas");
  c.width = 8; c.height = 512;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0.00, "#1f4ea0");
  grad.addColorStop(0.35, "#4ab3f5");
  grad.addColorStop(0.70, "#aedcff");
  grad.addColorStop(1.00, "#f6e2c2");
  g.fillStyle = grad;
  g.fillRect(0, 0, 8, 512);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  return t;
}
scene.background = makeSkyTexture();
scene.fog = new THREE.Fog(0xbcdcf5, 150, 380);

// PBR environment for subtle, realistic reflections on metal/clearcoat
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
}

const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 600);

// ---------- Lighting (soft, Hole.io-style flat look) ----------
const hemi = new THREE.HemisphereLight(0xffffff, 0xb6d8f0, 1.55);
scene.add(hemi);
scene.add(new THREE.AmbientLight(0xffffff, 0.55));

const sun = new THREE.DirectionalLight(0xfff1d6, 0.95);
sun.position.set(40, 80, 28);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 0.5;
sun.shadow.camera.far = 220;
sun.shadow.camera.left = -75;
sun.shadow.camera.right = 75;
sun.shadow.camera.top = 75;
sun.shadow.camera.bottom = -75;
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.02;
sun.shadow.radius = 6; // soft shadows
scene.add(sun);

// ---------- Physics ----------
const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -14, 0) });
world.broadphase = new CANNON.SAPBroadphase(world);
world.allowSleep = true;

const matBall = new CANNON.Material("ball");
const matGround = new CANNON.Material("ground");
const matProp = new CANNON.Material("prop");
world.defaultContactMaterial.friction = 0.35;
world.defaultContactMaterial.restitution = 0.0;
world.addContactMaterial(new CANNON.ContactMaterial(matBall, matGround, { friction: 0.55, restitution: 0.0 }));
world.addContactMaterial(new CANNON.ContactMaterial(matBall, matProp, { friction: 0.65, restitution: 0.0 }));

// ---------- Audio ----------
const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
let audioUnlocked = false;
function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  void audioCtx.resume();
}
window.addEventListener("pointerdown", unlockAudio, { once: true });
window.addEventListener("keydown", unlockAudio, { once: true });

// Pac-Man "wakka" chomp: two quick pitch sweeps (high-low, low-high) for the classic chomp feel
function playPickupSound(intensity: number) {
  if (!audioUnlocked) return;
  const t0 = audioCtx.currentTime;
  const base = 260 + intensity * 60;
  const makeChirp = (when: number, fStart: number, fEnd: number, dur: number) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(fStart, t0 + when);
    osc.frequency.exponentialRampToValueAtTime(fEnd, t0 + when + dur);
    gain.gain.setValueAtTime(0.0001, t0 + when);
    gain.gain.exponentialRampToValueAtTime(0.16, t0 + when + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + when + dur);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t0 + when);
    osc.stop(t0 + when + dur + 0.02);
  };
  makeChirp(0.00, base, base * 0.55, 0.07);  // wak-
  makeChirp(0.08, base * 0.55, base, 0.07);  // -ka
}

function playBreakSound() {
  if (!audioUnlocked) return;
  const t0 = audioCtx.currentTime;
  const bufferSize = 1 * audioCtx.sampleRate * 0.10;
  const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    const x = i / bufferSize;
    data[i] = (Math.random() * 2 - 1) * (1 - x) * 0.9;
  }
  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  const filter = audioCtx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(900, t0);
  filter.frequency.exponentialRampToValueAtTime(250, t0 + 0.1);
  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(0.18, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.11);
  src.connect(filter).connect(gain).connect(audioCtx.destination);
  src.start(t0);
  src.stop(t0 + 0.12);
}

// ---------- Police siren (looping) ----------
let sirenOsc: OscillatorNode | null = null;
let sirenGain: GainNode | null = null;
let sirenLfo: OscillatorNode | null = null;

function ensureSirenStarted() {
  if (sirenOsc || !audioUnlocked) return;
  const t0 = audioCtx.currentTime;
  sirenOsc = audioCtx.createOscillator();
  sirenOsc.type = "sawtooth";
  sirenOsc.frequency.value = 720;

  sirenLfo = audioCtx.createOscillator();
  sirenLfo.type = "sine";
  sirenLfo.frequency.value = 3.0;
  const lfoDepth = audioCtx.createGain();
  lfoDepth.gain.value = 220;
  sirenLfo.connect(lfoDepth).connect(sirenOsc.frequency);

  sirenGain = audioCtx.createGain();
  sirenGain.gain.value = 0;
  sirenOsc.connect(sirenGain).connect(audioCtx.destination);

  sirenOsc.start(t0);
  sirenLfo.start(t0);
}

function setSirenVolume(target: number) {
  if (!audioUnlocked) return;
  if (target < 0.001) {
    if (sirenGain) {
      const t0 = audioCtx.currentTime;
      sirenGain.gain.cancelScheduledValues(t0);
      sirenGain.gain.linearRampToValueAtTime(0, t0 + 0.15);
    }
    return;
  }
  ensureSirenStarted();
  if (sirenGain) {
    const t0 = audioCtx.currentTime;
    sirenGain.gain.cancelScheduledValues(t0);
    sirenGain.gain.linearRampToValueAtTime(target, t0 + 0.18);
  }
}

function playHonk() {
  if (!audioUnlocked) return;
  const t0 = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "square";
  osc.frequency.setValueAtTime(330, t0);
  osc.frequency.exponentialRampToValueAtTime(300, t0 + 0.16);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(0.07, t0 + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t0); osc.stop(t0 + 0.2);
}

let lastHonkAt = 0;
function maybeHonk() {
  if (!audioUnlocked) return;
  const now = performance.now();
  // Find nearest car
  let nearest = Infinity;
  for (const p of props) {
    if ((p.kind === "car" || p.kind === "police") && !p.stuck && !p.falling) {
      const dx = p.mesh.position.x - holePos.x;
      const dz = p.mesh.position.z - holePos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < nearest) nearest = d2;
    }
  }
  if (nearest === Infinity) return;
  // Closer = more frequent honks (frantic when ball is bearing down)
  const d = Math.sqrt(nearest);
  let cooldown = 1800;
  if (d < 8) cooldown = 220;
  else if (d < 16) cooldown = 600;
  else if (d < 28) cooldown = 1200;
  else return;
  if (now - lastHonkAt < cooldown) return;
  playHonk();
  lastHonkAt = now;
}

function playYelp() {
  if (!audioUnlocked) return;
  const t0 = audioCtx.currentTime;
  // A more dramatic scream — sustained "AAAAH!" with vibrato and a falling tail
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(520, t0);
  osc.frequency.exponentialRampToValueAtTime(880, t0 + 0.10);
  osc.frequency.exponentialRampToValueAtTime(700, t0 + 0.45);
  osc.frequency.exponentialRampToValueAtTime(180, t0 + 0.65);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(0.22, t0 + 0.04);
  gain.gain.setValueAtTime(0.22, t0 + 0.45);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.70);
  // Heavy vibrato for panic
  const lfo = audioCtx.createOscillator();
  lfo.frequency.value = 22;
  const lfoG = audioCtx.createGain();
  lfoG.gain.value = 70;
  lfo.connect(lfoG).connect(osc.frequency);
  // Slight noisy "breath"
  const bufSize = Math.floor(audioCtx.sampleRate * 0.65);
  const buf = audioCtx.createBuffer(1, bufSize, audioCtx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < bufSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufSize) * 0.4;
  const noise = audioCtx.createBufferSource();
  noise.buffer = buf;
  const noiseG = audioCtx.createGain();
  noiseG.gain.value = 0.05;
  noise.connect(noiseG).connect(audioCtx.destination);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t0); lfo.start(t0); noise.start(t0);
  osc.stop(t0 + 0.72); lfo.stop(t0 + 0.72); noise.stop(t0 + 0.7);
}

// "Approach scream" — civilian about to get eaten cries before being swallowed
let lastApproachScreamAt = 0;
function maybeApproachScream() {
  if (!audioUnlocked) return;
  const now = performance.now();
  if (now - lastApproachScreamAt < 1400) return;
  const tier = holeTier();
  for (const p of props) {
    if (p.kind !== "civilian" && p.kind !== "person") continue;
    if (p.stuck || p.falling) continue;
    if (p.tier > tier) continue;
    const dx = p.mesh.position.x - holePos.x;
    const dz = p.mesh.position.z - holePos.z;
    const d = Math.hypot(dx, dz);
    if (d < holeRadius + 3.5 && d > holeRadius + p.radius) {
      playYelp();
      lastApproachScreamAt = now;
      return;
    }
  }
}

function playTrainHorn() {
  if (!audioUnlocked) return;
  const t0 = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(180, t0);
  osc.frequency.exponentialRampToValueAtTime(140, t0 + 0.6);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(0.10, t0 + 0.05);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.7);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t0);
  osc.stop(t0 + 0.75);
}

// ---------- Helpers ----------
function clamp(x: number, a: number, b: number) { return Math.min(b, Math.max(a, x)); }
function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
function smoothstep(e0: number, e1: number, x: number) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
function rand(seed: number) {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function makeCanvasTexture(size: number, draw: (ctx: CanvasRenderingContext2D, s: number) => void) {
  const c = document.createElement("canvas");
  c.width = size; c.height = size;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("No 2D ctx");
  draw(ctx, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  tex.needsUpdate = true;
  return tex;
}

// ---------- Endless world layout ----------
const ROAD_HALF = 5;
const SIDEWALK_W = 2.6;
const CURB_H = 0.16;
const CHUNK_LEN = 60;
const VIEW_AHEAD = 6;     // chunks ahead of ball
const VIEW_BEHIND = 2;    // chunks behind
const CROSS_EVERY = 3;    // every 3rd chunk has a cross-section
const RAIL_EVERY = 7;     // every 7th chunk has a railway
const CROSS_X_HALF = 38;  // perpendicular cross-road extent

// ---------- Procedural textures ----------
const asphaltTex = makeCanvasTexture(512, (ctx, s) => {
  ctx.fillStyle = "#3a3f47";
  ctx.fillRect(0, 0, s, s);
  for (let i = 0; i < 7000; i++) {
    const x = (Math.random() * s) | 0;
    const y = (Math.random() * s) | 0;
    const v = 60 + ((Math.random() * 28) | 0);
    ctx.fillStyle = `rgb(${v},${v},${v + 2})`;
    ctx.fillRect(x, y, 1, 1);
  }
});

const sidewalkTex = makeCanvasTexture(256, (ctx, s) => {
  ctx.fillStyle = "#aab1ba";
  ctx.fillRect(0, 0, s, s);
  ctx.strokeStyle = "rgba(0,0,0,0.16)";
  ctx.lineWidth = 2;
  for (let i = 0; i <= 8; i++) {
    const y = (i * s) / 8;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(s, y); ctx.stroke();
  }
  for (let i = 0; i <= 4; i++) {
    const x = (i * s) / 4;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, s); ctx.stroke();
  }
});

const dashedTex = makeCanvasTexture(64, (ctx, s) => {
  ctx.clearRect(0, 0, s, s);
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  for (let y = 0; y < s; y += 16) ctx.fillRect(s * 0.4, y, s * 0.2, 8);
});

const solidTex = makeCanvasTexture(16, (ctx, s) => {
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.fillRect(s * 0.35, 0, s * 0.3, s);
});

const crosswalkTex = makeCanvasTexture(256, (ctx, s) => {
  ctx.clearRect(0, 0, s, s);
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  const stripes = 8;
  const stripeW = s / stripes;
  for (let i = 0; i < stripes; i++) {
    if (i % 2 === 0) ctx.fillRect(i * stripeW, s * 0.1, stripeW * 0.85, s * 0.8);
  }
});

const windowTex = makeCanvasTexture(256, (ctx, s) => {
  ctx.fillStyle = "#0e1832";
  ctx.fillRect(0, 0, s, s);
  const cols = 8, rows = 16;
  const cw = s / cols, rh = s / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * cw + cw * 0.18;
      const y = r * rh + rh * 0.22;
      const w = cw * 0.64, h = rh * 0.56;
      const lit = Math.random();
      if (lit < 0.55) {
        ctx.fillStyle = `rgba(${180 + Math.random() * 60 | 0},${210 + Math.random() * 40 | 0},255,0.85)`;
      } else if (lit < 0.78) {
        ctx.fillStyle = `rgba(${250},${210 + Math.random() * 30 | 0},${130 + Math.random() * 40 | 0},0.85)`;
      } else {
        ctx.fillStyle = "rgba(20,28,46,0.95)";
      }
      ctx.fillRect(x, y, w, h);
    }
  }
});

const windowAlbedo = makeCanvasTexture(256, (ctx, s) => {
  ctx.fillStyle = "#cfd9e8";
  ctx.fillRect(0, 0, s, s);
  const cols = 8, rows = 16;
  const cw = s / cols, rh = s / rows;
  ctx.fillStyle = "#5d7393";
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * cw + cw * 0.18;
      const y = r * rh + rh * 0.22;
      ctx.fillRect(x, y, cw * 0.64, rh * 0.56);
    }
  }
});

// Shared materials
const groundMatShared = new THREE.MeshStandardMaterial({
  color: 0xffffff, map: asphaltTex.clone(), roughness: 0.95, metalness: 0.0,
});
(groundMatShared.map as THREE.Texture).repeat.set(2, 8);
(groundMatShared.map as THREE.Texture).needsUpdate = true;

const sidewalkMatShared = new THREE.MeshStandardMaterial({
  color: 0xffffff, map: sidewalkTex.clone(), roughness: 0.9,
});
(sidewalkMatShared.map as THREE.Texture).repeat.set(1, 6);
(sidewalkMatShared.map as THREE.Texture).needsUpdate = true;

const curbMat = new THREE.MeshStandardMaterial({ color: 0xb8c0cc, roughness: 0.85 });
const concreteMat = new THREE.MeshStandardMaterial({
  color: 0xffffff, map: windowAlbedo, roughness: 0.55, metalness: 0.05,
  emissive: new THREE.Color(0x162a55), emissiveMap: windowTex, emissiveIntensity: 0.85,
});
const roofMat = new THREE.MeshStandardMaterial({ color: 0x9aa3b3, roughness: 0.85 });

const buildingPalette = [
  0xff7a3d, // orange
  0x4ec9c4, // teal
  0xff9bb0, // pink
  0xc44d3f, // red brick
  0xeed6a6, // cream
  0x5b8ad6, // sky blue
  0xa6d65b, // lime
  0xeacd3a, // yellow
  0xb98ee6, // lavender
  0xff6b6b, // coral red
  0x6dc987, // mint
  0xffb347, // amber
];

// ---------- Hole (Hole.io style) ----------
const baseHoleRadius = 1.0;
let holeRadius = baseHoleRadius;
let score = 0;
let level = 1;
let map = 1;
const MAX_MAPS = 3;
const LEVELS_PER_MAP = 8;
// Items needed to advance from each within-map level (idx 0 = L1 of that map, etc.)
const ITEMS_PER_LEVEL: number[] = [10, 20, 25, 30, 35, 40, 45, 50];
function itemsForLevel(lvl: number): number {
  return ITEMS_PER_LEVEL[(lvl - 1) % LEVELS_PER_MAP] ?? 50;
}
let itemsEatenThisLevel = 0;

// holeTier gates what you can swallow
// level 1-2 -> 1; 3-4 -> 2; 5-6 -> 3; 7-8 -> 4; 9-10 -> 5; 11-14 -> 6; 15-22 -> 7; 23+ -> 8
function holeTier(): number {
  // Each level unlocks the next tier exactly:
  //  L1 civilians+small | L2 cars | L3 trees | L4 tiny bldg | L5 medium | L6 large
  return clamp(level, 1, 7);
}

// Score needed to reach next level
function levelThreshold(lvl: number): number {
  return Math.floor(8 * Math.pow(lvl, 1.45));
}

// Position of the hole (on ground plane)
const holePos = new THREE.Vector3(0, 0, 10);
const holeVel = new THREE.Vector3();

// Visual: a rolling pink ball
const holeGroup = new THREE.Group();
scene.add(holeGroup);

// Hole.io-style hole: a flat black disk on the ground that scales with holeRadius.
// Inner pure-black "void" + a slightly larger faint dark rim for depth.
const holeDisk = new THREE.Mesh(
  new THREE.CircleGeometry(1, 64),
  new THREE.MeshBasicMaterial({ color: 0x0a1a3a }),
);
holeDisk.rotation.x = -Math.PI / 2;
holeDisk.renderOrder = 2;
holeGroup.add(holeDisk);

// Bright cyan rim — hole.io blue-themed look
const holeRim = new THREE.Mesh(
  new THREE.RingGeometry(0.97, 1.18, 64),
  new THREE.MeshBasicMaterial({ color: 0x4dc8ff, transparent: true, opacity: 0.95, side: THREE.DoubleSide }),
);
holeRim.rotation.x = -Math.PI / 2;
holeRim.renderOrder = 2;
holeGroup.add(holeRim);

// Outer soft glow ring
const holeGlow = new THREE.Mesh(
  new THREE.RingGeometry(1.18, 1.45, 64),
  new THREE.MeshBasicMaterial({ color: 0x6ad8ff, transparent: true, opacity: 0.35, side: THREE.DoubleSide }),
);
holeGlow.rotation.x = -Math.PI / 2;
holeGlow.renderOrder = 2;
holeGroup.add(holeGlow);

// (No soft outer shadow — the hole disk itself is the visual anchor.)
const ballShadow = new THREE.Object3D();
scene.add(ballShadow);
// Compatibility alias — old code references `ballSphere` (it's harmless to keep as the group).
const ballSphere = holeGroup;
void ballSphere;

function applyHoleScale() {
  holeGroup.scale.set(holeRadius, holeRadius, holeRadius);
}
applyHoleScale();

// ---------- Confetti particle burst ----------
type Particle = { life: number; max: number; vel: THREE.Vector3; mesh: THREE.Mesh };
const particles: Particle[] = [];
const particleGroup = new THREE.Group();
scene.add(particleGroup);

function emitConfetti(x: number, z: number, count: number) {
  const colors = [0xffd23a, 0xff58d4, 0x4dc6ff, 0x6dffae, 0xffffff, 0xff7a4d];
  for (let i = 0; i < count; i++) {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(0.18, 0.32),
      new THREE.MeshBasicMaterial({ color: colors[(Math.random() * colors.length) | 0], transparent: true, side: THREE.DoubleSide }),
    );
    m.position.set(x, 0.1, z);
    m.rotation.set(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28);
    particleGroup.add(m);
    const angle = Math.random() * Math.PI * 2;
    const speed = 4 + Math.random() * 7;
    const v = new THREE.Vector3(Math.cos(angle) * speed, 6 + Math.random() * 5, Math.sin(angle) * speed);
    particles.push({ life: 0, max: 1.4 + Math.random() * 0.6, vel: v, mesh: m });
  }
}

function updateParticles(dt: number) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life += dt;
    p.vel.y -= 14 * dt; // gravity
    p.vel.x *= Math.pow(0.6, dt);
    p.vel.z *= Math.pow(0.6, dt);
    p.mesh.position.x += p.vel.x * dt;
    p.mesh.position.y += p.vel.y * dt;
    p.mesh.position.z += p.vel.z * dt;
    p.mesh.rotation.x += dt * 6;
    p.mesh.rotation.z += dt * 4;
    const u = p.life / p.max;
    (p.mesh.material as THREE.MeshBasicMaterial).opacity = clamp(1 - u, 0, 1);
    if (p.life >= p.max || p.mesh.position.y < -2) {
      particleGroup.remove(p.mesh);
      (p.mesh.geometry as any).dispose?.();
      ((p.mesh.material as any).dispose)?.();
      particles.splice(i, 1);
    }
  }
}

// Compatibility shim so existing code that reads ball position keeps working
const ballMesh = { position: holePos } as unknown as THREE.Object3D & { position: THREE.Vector3 };
const ballBody = { position: holePos, velocity: holeVel } as any;
let ballScale = 1.0;
const baseRadius = baseHoleRadius;

// ---------- Props registry ----------
let nextId = 1;
const props: StickyObject[] = [];
const bodyIdToProp = new Map<number, StickyObject>();
const pendingStickIds = new Set<number>();
const propsGroup = new THREE.Group();
scene.add(propsGroup);

function tierForKind(kind: StickyKind): number {
  switch (kind) {
    // Level 1 — civilians + all small street props
    case "civilian":   return 1;
    case "person":     return 1;
    case "trash":      return 1;
    case "cone":       return 1;
    case "spike":      return 1;
    case "bike":       return 1;
    case "mailbox":    return 1;
    case "hydrant":    return 1;
    case "bench":      return 1;
    case "lamppost":   return 1;
    // Level 2 — cars
    case "car":        return 2;
    case "police":     return 2;
    // Level 3 — trees (tagged as "breakable")
    case "breakable":  return 3;
    // Levels 4/5/6 — tiny / medium / large buildings
    case "building_S": return 4;
    case "building_M": return 5;
    case "building_L": return 6;
    default:           return 1;
  }
}

function addProp(p: Omit<StickyObject, "id" | "stuck" | "tier"> & { tier?: number }) {
  const tier = p.tier ?? tierForKind(p.kind);
  const obj: StickyObject = { ...p, id: nextId++, stuck: false, tier };
  props.push(obj);
  bodyIdToProp.set(obj.body.id, obj);
  return obj;
}

function removeProp(p: StickyObject) {
  const idx = props.indexOf(p);
  if (idx >= 0) props.splice(idx, 1);
  bodyIdToProp.delete(p.body.id);
  if (p.body.world) world.removeBody(p.body);
  if (p.mesh.parent) p.mesh.parent.remove(p.mesh);
}

// ---------- Prop mesh factories ----------
function makeTrashMesh(): THREE.Object3D {
  const g = new THREE.Group();
  const can = new THREE.Mesh(
    new THREE.CylinderGeometry(0.18, 0.18, 0.5, 10),
    new THREE.MeshStandardMaterial({ color: 0x93a1b0, roughness: 0.6, metalness: 0.55 }),
  );
  can.castShadow = true; g.add(can);
  const lid = new THREE.Mesh(
    new THREE.CylinderGeometry(0.2, 0.2, 0.06, 10),
    new THREE.MeshStandardMaterial({ color: 0x6d7a88, roughness: 0.65, metalness: 0.4 }),
  );
  lid.position.y = 0.28; lid.castShadow = true; g.add(lid);
  return g;
}
function makeConeMesh(): THREE.Object3D {
  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(0.23, 0.6, 12),
    new THREE.MeshStandardMaterial({ color: 0xff7a21, roughness: 0.85 }),
  );
  cone.castShadow = true; return cone;
}
function makeBikeMesh(): THREE.Object3D {
  const g = new THREE.Group();
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(0.85, 0.18, 0.25),
    new THREE.MeshStandardMaterial({ color: 0x2cffe2, roughness: 0.55, metalness: 0.25 }),
  );
  frame.castShadow = true; g.add(frame);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x0d0f18, roughness: 0.95 });
  const wheelGeo = new THREE.TorusGeometry(0.25, 0.06, 10, 14);
  const w1 = new THREE.Mesh(wheelGeo, wheelMat); w1.rotation.y = Math.PI / 2; w1.position.set(-0.35, -0.05, 0);
  const w2 = w1.clone(); w2.position.x = 0.35;
  w1.castShadow = true; w2.castShadow = true;
  g.add(w1, w2); return g;
}
function makePersonMesh(color = 0xbad7ff): THREE.Object3D {
  const g = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: 0xffd2a8, roughness: 0.85 });
  const shirt = new THREE.MeshStandardMaterial({ color, roughness: 0.75 });
  const pants = new THREE.MeshStandardMaterial({ color: 0x2a3a55, roughness: 0.85 });
  const shoes = new THREE.MeshStandardMaterial({ color: 0x111418, roughness: 0.7 });

  // Legs (slightly apart, knees bent slightly via two stacked boxes)
  for (const sx of [-0.085, 0.085]) {
    const thigh = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.34, 0.12), pants);
    thigh.position.set(sx, 0.17, 0);
    thigh.castShadow = true; g.add(thigh);
    const shin = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.28, 0.11), pants);
    shin.position.set(sx, 0.36, 0.02);
    shin.castShadow = true; g.add(shin);
    const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.06, 0.20), shoes);
    shoe.position.set(sx, 0.03, 0.04);
    shoe.castShadow = true; g.add(shoe);
  }
  // Torso
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.40, 0.20), shirt);
  torso.position.set(0, 0.66, 0);
  torso.castShadow = true; g.add(torso);
  // Arms (slight outward angle)
  for (const sx of [-1, 1]) {
    const arm = new THREE.Group();
    arm.position.set(sx * 0.22, 0.85, 0);
    arm.rotation.z = sx * -0.15;
    const upper = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.28, 0.10), shirt);
    upper.position.y = -0.14;
    upper.castShadow = true;
    arm.add(upper);
    const fore = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.24, 0.09), skin);
    fore.position.y = -0.40;
    fore.castShadow = true;
    arm.add(fore);
    g.add(arm);
  }
  // Neck
  const neck = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.06, 0.10), skin);
  neck.position.set(0, 0.90, 0);
  g.add(neck);
  // Head
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 14, 12), skin);
  head.position.set(0, 1.04, 0);
  head.castShadow = true; g.add(head);
  // Hair cap
  const hairColors = [0x2b1d12, 0x4a3220, 0x8a6a3a, 0xd1a467, 0x111111];
  const hair = new THREE.Mesh(
    new THREE.SphereGeometry(0.135, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: hairColors[(Math.random() * hairColors.length) | 0], roughness: 0.85 }),
  );
  hair.position.set(0, 1.06, 0);
  g.add(hair);
  // Eyes
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.4 });
  const eyeGeo = new THREE.SphereGeometry(0.018, 8, 6);
  for (const sx of [-0.045, 0.045]) {
    const eye = new THREE.Mesh(eyeGeo, eyeMat);
    eye.position.set(sx, 1.06, 0.115);
    g.add(eye);
  }
  return g;
}
function makeBreakableMesh(): THREE.Object3D {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 0.8, 0.7),
    new THREE.MeshStandardMaterial({ color: 0x7f8cff, roughness: 0.75 }),
  );
  m.castShadow = true; return m;
}
function makeCarMesh(color: number): THREE.Object3D {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(1.0, 0.55, 2.1),
    new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.25 }),
  );
  body.position.y = 0.27;
  body.castShadow = true; g.add(body);
  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(0.92, 0.45, 1.05),
    new THREE.MeshStandardMaterial({ color: 0x223144, roughness: 0.3, metalness: 0.3 }),
  );
  cabin.position.set(0, 0.6, -0.15);
  cabin.castShadow = true; g.add(cabin);
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x131419, roughness: 0.95 });
  const wheelGeo = new THREE.CylinderGeometry(0.18, 0.18, 0.18, 12);
  for (const off of [[-0.5, 0.7], [0.5, 0.7], [-0.5, -0.7], [0.5, -0.7]]) {
    const w = new THREE.Mesh(wheelGeo, tireMat);
    w.rotation.z = Math.PI / 2;
    w.position.set(off[0], 0.18, off[1]);
    w.castShadow = true;
    g.add(w);
  }
  return g;
}

// ---------- Giant flat ground (covers any map / chunk world) ----------
const groundBody = new CANNON.Body({ type: CANNON.Body.STATIC, material: matGround });
groundBody.addShape(new CANNON.Box(new CANNON.Vec3(5000, 0.5, 5000)));
groundBody.position.set(0, -0.5, 0);
world.addBody(groundBody);

// ---------- Map system (Phase 2) ----------
type MapProp = { type: string; pos: [number, number]; rot?: number; size?: [number, number]; height?: number };
type MapData = {
  name: string;
  size: [number, number];
  cellSize: number;
  startPos: [number, number];
  grid: string[];
  props: MapProp[];
};

let currentMap: MapData | null = null;
let mapGroup: THREE.Group | null = null;
let mapBodies: CANNON.Body[] = [];
let mapPropIds: number[] = [];
let mapBounds = { minX: -50, maxX: 50, minZ: -50, maxZ: 50 };

// ---- Traffic lights (map mode, single junction) ----
type TrafficLamp = { red: THREE.Mesh; yellow: THREE.Mesh; green: THREE.Mesh };
type TrafficSystem = {
  // Junction center in world coords
  cx: number; cz: number;
  // Stop-line distance from center along each axis (= ROAD_HALF + small margin)
  stopDist: number;
  // Phase cycle: ns_g 7s, ns_y 1.8s, ew_g 7s, ew_y 1.8s
  phase: "ns_g" | "ns_y" | "ew_g" | "ew_y";
  t: number;
  nsLamps: TrafficLamp[];
  ewLamps: TrafficLamp[];
};
let traffic: TrafficSystem | null = null;
function nsLightState(): "g" | "y" | "r" {
  if (!traffic) return "g";
  if (traffic.phase === "ns_g") return "g";
  if (traffic.phase === "ns_y") return "y";
  return "r";
}
function ewLightState(): "g" | "y" | "r" {
  if (!traffic) return "g";
  if (traffic.phase === "ew_g") return "g";
  if (traffic.phase === "ew_y") return "y";
  return "r";
}

// Stylized sidewalk texture: clean cream tile with subtle gray grid
const styledSidewalkTex = makeCanvasTexture(256, (ctx, s) => {
  ctx.fillStyle = "#e6e6e2";
  ctx.fillRect(0, 0, s, s);
  ctx.strokeStyle = "rgba(0,0,0,0.07)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const p = (i * s) / 4;
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(s, p); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, s); ctx.stroke();
  }
});

// Parking lot tile with painted stripes
const parkingLotTex = makeCanvasTexture(256, (ctx, s) => {
  ctx.fillStyle = "#cdd0d3";
  ctx.fillRect(0, 0, s, s);
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  // Vertical parking stripes
  for (let x = 24; x < s - 14; x += 36) {
    ctx.fillRect(x, 24, 3, s - 48);
  }
});

function makeTileMaterial(ch: string): THREE.Material {
  if (ch === "R" || ch === "X") {
    const t = asphaltTex.clone();
    t.repeat.set(0.5, 0.5);
    t.needsUpdate = true;
    return new THREE.MeshStandardMaterial({ color: 0xffffff, map: t, roughness: 0.95 });
  }
  if (ch === "S") {
    const t = styledSidewalkTex.clone();
    t.needsUpdate = true;
    return new THREE.MeshStandardMaterial({ color: 0xffffff, map: t, roughness: 0.85 });
  }
  if (ch === "P") {
    const t = parkingLotTex.clone();
    t.needsUpdate = true;
    return new THREE.MeshStandardMaterial({ color: 0xffffff, map: t, roughness: 0.9 });
  }
  if (ch === "G") {
    return new THREE.MeshStandardMaterial({ color: 0x6cc35a, roughness: 0.85 });
  }
  if (ch === "W") {
    return new THREE.MeshStandardMaterial({ color: 0x2a72c8, roughness: 0.35, metalness: 0.4 });
  }
  return new THREE.MeshStandardMaterial({ color: 0x2a2a2a });
}

function makeTreeMesh(): THREE.Object3D {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.18, 0.22, 1.2, 8),
    new THREE.MeshStandardMaterial({ color: 0x6b4226, roughness: 0.9 }),
  );
  trunk.position.y = 0.6; trunk.castShadow = true;
  g.add(trunk);
  const leaves = new THREE.Mesh(
    new THREE.SphereGeometry(0.95, 12, 10),
    new THREE.MeshStandardMaterial({ color: 0x3aa54f, roughness: 0.85 }),
  );
  leaves.position.y = 1.7; leaves.castShadow = true;
  g.add(leaves);
  return g;
}

function makeMailboxMesh(): THREE.Object3D {
  const g = new THREE.Group();
  const post = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.07, 0.9, 8),
    new THREE.MeshStandardMaterial({ color: 0x556070, roughness: 0.85 }),
  );
  post.position.y = 0.45; post.castShadow = true; g.add(post);
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(0.55, 0.4, 0.35),
    new THREE.MeshStandardMaterial({ color: 0x2156c2, roughness: 0.55, metalness: 0.2 }),
  );
  box.position.y = 1.05; box.castShadow = true; g.add(box);
  return g;
}

function makeHydrantMesh(): THREE.Object3D {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.18, 0.22, 0.6, 12),
    new THREE.MeshStandardMaterial({ color: 0xd11b1b, roughness: 0.65 }),
  );
  body.position.y = 0.3; body.castShadow = true; g.add(body);
  const top = new THREE.Mesh(
    new THREE.SphereGeometry(0.22, 12, 10),
    new THREE.MeshStandardMaterial({ color: 0xff5050, roughness: 0.6 }),
  );
  top.position.y = 0.6; g.add(top);
  return g;
}

function makeBenchMesh(): THREE.Object3D {
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0x8a5a32, roughness: 0.8 });
  const seat = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.08, 0.45), wood);
  seat.position.y = 0.42; seat.castShadow = true; g.add(seat);
  const back = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.6, 0.08), wood);
  back.position.set(0, 0.7, -0.18); back.castShadow = true; g.add(back);
  const legMat = new THREE.MeshStandardMaterial({ color: 0x444a55, roughness: 0.7, metalness: 0.4 });
  for (const dx of [-0.65, 0.65]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.42, 0.45), legMat);
    leg.position.set(dx, 0.21, 0); leg.castShadow = true; g.add(leg);
  }
  return g;
}

function makeLamppostMesh(): THREE.Object3D {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.12, 3.6, 10),
    new THREE.MeshStandardMaterial({ color: 0x2a3352, roughness: 0.85 }),
  );
  pole.position.y = 1.8; pole.castShadow = true; g.add(pole);
  const arm = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 0.06, 0.08),
    new THREE.MeshStandardMaterial({ color: 0x2a3352 }),
  );
  arm.position.set(0.35, 3.5, 0); g.add(arm);
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.22, 12, 10),
    new THREE.MeshStandardMaterial({ color: 0xfff1c8, emissive: 0xffe1a8, emissiveIntensity: 1.2 }),
  );
  head.position.set(0.7, 3.45, 0); g.add(head);
  return g;
}

function makePoliceCarMesh(): THREE.Object3D {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(1.0, 0.55, 2.1),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, metalness: 0.3 }),
  );
  body.position.y = 0.27; body.castShadow = true; g.add(body);
  // Black hood/trunk
  const stripe = new THREE.Mesh(
    new THREE.BoxGeometry(1.02, 0.04, 0.6),
    new THREE.MeshStandardMaterial({ color: 0x111418, roughness: 0.7 }),
  );
  stripe.position.set(0, 0.55, 0); g.add(stripe);
  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(0.92, 0.45, 1.05),
    new THREE.MeshStandardMaterial({ color: 0x1a3a72, roughness: 0.3, metalness: 0.3 }),
  );
  cabin.position.set(0, 0.6, -0.15); cabin.castShadow = true; g.add(cabin);
  // Light bar
  const bar = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 0.12, 0.25),
    new THREE.MeshStandardMaterial({ color: 0x111418, roughness: 0.5 }),
  );
  bar.position.set(0, 0.95, -0.15); g.add(bar);
  const redL = new THREE.Mesh(
    new THREE.BoxGeometry(0.28, 0.10, 0.22),
    new THREE.MeshStandardMaterial({ color: 0xff2222, emissive: 0xff2222, emissiveIntensity: 1.5 }),
  );
  redL.position.set(-0.18, 0.95, -0.15); g.add(redL);
  const blueR = new THREE.Mesh(
    new THREE.BoxGeometry(0.28, 0.10, 0.22),
    new THREE.MeshStandardMaterial({ color: 0x2266ff, emissive: 0x2266ff, emissiveIntensity: 1.5 }),
  );
  blueR.position.set(0.18, 0.95, -0.15); g.add(blueR);
  // Tires
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x131419, roughness: 0.95 });
  const wheelGeo = new THREE.CylinderGeometry(0.18, 0.18, 0.18, 12);
  for (const off of [[-0.5, 0.7], [0.5, 0.7], [-0.5, -0.7], [0.5, -0.7]]) {
    const w = new THREE.Mesh(wheelGeo, tireMat);
    w.rotation.z = Math.PI / 2;
    w.position.set(off[0], 0.18, off[1]);
    w.castShadow = true;
    g.add(w);
  }
  return g;
}

function spawnSimpleStatic(kind: StickyKind, mesh: THREE.Object3D, wx: number, wz: number, radius: number, value: number, halfH: number, halfW?: number, halfD?: number): StickyObject {
  mesh.position.set(wx, 0, wz);
  propsGroup.add(mesh);
  const body = new CANNON.Body({ mass: 0, type: CANNON.Body.STATIC, material: matProp });
  const hw = halfW ?? radius * 0.7;
  const hd = halfD ?? radius * 0.7;
  body.addShape(new CANNON.Box(new CANNON.Vec3(hw, halfH, hd)));
  body.position.set(wx, halfH, wz);
  world.addBody(body);
  return addProp({ kind, value, radius, mesh, body });
}

function spawnPoliceAt(wx: number, wz: number, rotY = 0): StickyObject {
  const mesh = makePoliceCarMesh();
  mesh.position.set(wx, 0, wz);
  mesh.rotation.y = rotY;
  propsGroup.add(mesh);
  const body = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, material: matProp });
  body.addShape(new CANNON.Box(new CANNON.Vec3(0.55, 0.5, 1.1)));
  body.position.set(wx, 0.5, wz);
  body.quaternion.setFromEuler(0, rotY, 0);
  world.addBody(body);
  // Police "patrol" along the road like cars; axis depends on facing direction
  const facingX = Math.abs(Math.cos(rotY)) < Math.abs(Math.sin(rotY));
  const npc: NPCState = facingX
    ? { type: "car", speed: 3.0 * (Math.sin(rotY) > 0 ? 1 : -1), lane: wz, axis: "x" }
    : { type: "car", speed: 3.0 * (Math.cos(rotY) > 0 ? 1 : -1), lane: wx, axis: "z" };
  return addProp({
    kind: "police", value: 30, radius: 1.2, mesh, body, npc,
  });
}

function spawnTreeAt(wx: number, wz: number): StickyObject {
  const mesh = makeTreeMesh();
  mesh.position.set(wx, 0, wz);
  propsGroup.add(mesh);
  const body = new CANNON.Body({ mass: 0, type: CANNON.Body.STATIC, material: matProp });
  body.addShape(new CANNON.Cylinder(0.3, 0.3, 2.0, 8));
  body.position.set(wx, 1, wz);
  world.addBody(body);
  return addProp({ kind: "breakable", value: 4, radius: 0.95, mesh, body, tier: 3 });
}

// Stylized building palette — bright low-poly colors
const stylizedBuildingPalette = [
  0xff6b4a, // red-orange
  0xf2eee6, // off-white
  0x8a93a6, // gray
  0xb6c7d6, // light blue-gray
  0x355a8b, // dark navy
  0x4ec3e9, // bright teal
  0xefd3b5, // beige
  0xff9b7a, // peach
];

function makeBuildingFaceTexture(bodyHex: number, accentHex: number, brick = false): THREE.Texture {
  return makeCanvasTexture(256, (ctx, s) => {
    const r = (bodyHex >> 16) & 0xff, g = (bodyHex >> 8) & 0xff, b = bodyHex & 0xff;
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(0, 0, s, s);

    // Brick courses: faint horizontal mortar lines
    if (brick) {
      ctx.fillStyle = "rgba(0,0,0,0.12)";
      const rowH = 6;
      for (let y = 0; y < s; y += rowH) ctx.fillRect(0, y, s, 1);
      // staggered vertical mortars
      for (let y = 0; y < s; y += rowH) {
        const stagger = ((y / rowH) | 0) % 2 === 0 ? 0 : rowH * 2;
        for (let x = stagger; x < s; x += rowH * 4) ctx.fillRect(x, y, 1, rowH);
      }
    }

    // Tight window grid (dense small squares)
    const ar = (accentHex >> 16) & 0xff, ag = (accentHex >> 8) & 0xff, ab = accentHex & 0xff;
    ctx.fillStyle = `rgb(${ar},${ag},${ab})`;
    const cols = brick ? 5 : 6;
    const rows = brick ? 9 : 10;
    const ww = (s / cols) * 0.55;
    const wh = (s / rows) * 0.42;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const x = ((col + 0.5) / cols) * s - ww / 2;
        const y = ((row + 0.5) / rows) * s - wh / 2;
        ctx.fillRect(x, y, ww, wh);
      }
    }

    // Subtle floor-divider lines for non-brick (concrete bands)
    if (!brick) {
      ctx.fillStyle = "rgba(0,0,0,0.06)";
      for (let row = 1; row < rows; row++) {
        const y = (row / rows) * s;
        ctx.fillRect(0, y - 1, s, 2);
      }
    }

    // Slight top trim
    ctx.fillStyle = "rgba(0,0,0,0.18)";
    ctx.fillRect(0, 0, s, 4);
  });
}

function spawnMapBuilding(wx: number, wz: number, sizeCells: [number, number], height: number, kind: "building_S" | "building_M" | "building_L"): StickyObject {
  const cs = currentMap?.cellSize ?? 5;
  const w = sizeCells[0] * cs * 0.92;
  const d = sizeCells[1] * cs * 0.92;
  const colorIdx = (Math.abs(Math.floor(wx * 13 + wz * 7)) % stylizedBuildingPalette.length);
  const bodyColor = stylizedBuildingPalette[colorIdx];
  const accentColor = 0x1c2333;
  // Red-orange and peach are brick buildings
  const isBrick = bodyColor === 0xff6b4a || bodyColor === 0xff9b7a;

  const g = new THREE.Group();

  const tex = makeBuildingFaceTexture(bodyColor, accentColor, isBrick);
  const tex2 = makeBuildingFaceTexture(bodyColor, accentColor, isBrick);
  // Stretch UVs vertically to fit height
  const yRepeat = Math.max(1, Math.round(height / 3));
  tex.repeat.set(1, yRepeat); tex.needsUpdate = true;
  tex2.repeat.set(1, yRepeat); tex2.needsUpdate = true;
  const sideMat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: tex, roughness: 0.7, metalness: 0.05 });
  const sideMat2 = new THREE.MeshStandardMaterial({ color: 0xffffff, map: tex2, roughness: 0.7, metalness: 0.05 });
  const flatMat = new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.7, metalness: 0.05 });
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(w, height, d),
    // [right, left, top, bottom, front, back]
    [sideMat, sideMat, flatMat, flatMat, sideMat2, sideMat2],
  );
  m.position.y = height / 2;
  m.castShadow = true; m.receiveShadow = true;
  g.add(m);

  // Flat dark roof cap
  const roof = new THREE.Mesh(
    new THREE.BoxGeometry(w * 1.02, 0.35, d * 1.02),
    new THREE.MeshStandardMaterial({ color: 0x2c3340, roughness: 0.9 }),
  );
  roof.position.y = height + 0.18;
  roof.castShadow = true;
  g.add(roof);

  const ox = (sizeCells[0] - 1) * cs * 0.5;
  const oz = (sizeCells[1] - 1) * cs * 0.5;
  g.position.set(wx + ox, 0, wz + oz);
  propsGroup.add(g);

  const b = new CANNON.Body({ type: CANNON.Body.STATIC, material: matGround });
  b.addShape(new CANNON.Box(new CANNON.Vec3(w / 2, height / 2, d / 2)));
  b.position.set(g.position.x, height / 2, g.position.z);
  world.addBody(b);

  // Use widest dimension as effective swallow radius (so the hole has to be over the building)
  const radius = Math.max(w, d) * 0.5;
  const value = kind === "building_S" ? 60 : kind === "building_M" ? 140 : 280;
  return addProp({ kind, value, radius, mesh: g, body: b });
}

function gridToWorld(gx: number, gz: number): [number, number] {
  if (!currentMap) return [0, 0];
  const cs = currentMap.cellSize;
  const W = currentMap.size[0], H = currentMap.size[1];
  const halfW = W * cs / 2, halfH = H * cs / 2;
  return [gx * cs - halfW + cs / 2, gz * cs - halfH + cs / 2];
}

function spawnPlayground(cx: number, cz: number) {
  if (!mapGroup) return;
  const g = new THREE.Group();
  g.position.set(cx, 0, cz);
  mapGroup.add(g);

  // ---- Swing set ----
  const metalMat = new THREE.MeshStandardMaterial({ color: 0x6f7a87, roughness: 0.5, metalness: 0.4 });
  const seatMat = new THREE.MeshStandardMaterial({ color: 0x2a3a55, roughness: 0.7 });
  const beam = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.10, 0.10), metalMat);
  beam.position.set(0, 2.0, 0);
  beam.castShadow = true;
  g.add(beam);
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 2.05, 8), metalMat);
    post.position.set(sx * 1.7, 1.025, 0);
    post.castShadow = true;
    g.add(post);
  }
  for (const sx of [-0.6, 0.6]) {
    // Chains
    for (const sz of [-0.07, 0.07]) {
      const chain = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 1.2, 6), metalMat);
      chain.position.set(sx, 1.4, sz);
      g.add(chain);
    }
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.06, 0.22), seatMat);
    seat.position.set(sx, 0.85, 0);
    seat.castShadow = true;
    g.add(seat);
  }

  // ---- Slide (ladder + ramp) ----
  const slideX = 2.6;
  const slideMat = new THREE.MeshStandardMaterial({ color: 0xff7a3a, roughness: 0.6 });
  const platform = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.10, 0.7), slideMat);
  platform.position.set(slideX, 1.5, 0);
  platform.castShadow = true;
  g.add(platform);
  // Ladder posts
  for (const sz of [-0.3, 0.3]) {
    const lp = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.5, 8), metalMat);
    lp.position.set(slideX - 0.4, 0.75, sz);
    g.add(lp);
  }
  // Ramp
  const ramp = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.08, 2.2), slideMat);
  ramp.position.set(slideX, 0.78, 1.2);
  ramp.rotation.x = -0.55;
  ramp.castShadow = true;
  g.add(ramp);

  // ---- Sandbox edge (low fence) ----
  const fenceMat = new THREE.MeshStandardMaterial({ color: 0xb78a4a, roughness: 0.85 });
  const fenceLen = 5.0;
  for (const [px, pz, rot] of [[-1.7, 1.7, 0], [1.7, 1.7, 0], [0, 3.2, 0], [0, 0.2, 0]] as [number, number, number][]) {
    void rot;
  }
  // Simple corner posts
  for (const [px, pz] of [[-2, 2.4], [2, 2.4], [-2, -2.4], [2, -2.4]] as [number, number][]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 0.12), fenceMat);
    post.position.set(px, 0.25, pz);
    g.add(post);
  }
  void fenceLen;

  // ---- Playground balls (eatable, tier 1) ----
  const ballColors = [0xff3b3b, 0x3aa9ff, 0xffd23a, 0x33dd6a];
  for (let i = 0; i < 3; i++) {
    const r = 0.32;
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(r, 18, 14),
      new THREE.MeshStandardMaterial({ color: ballColors[i % ballColors.length], roughness: 0.4 }),
    );
    const bx = cx + (Math.random() - 0.5) * 4.0;
    const bz = cz + (Math.random() - 0.5) * 4.0;
    m.position.set(bx, r, bz);
    m.castShadow = true;
    propsGroup.add(m);
    const body = new CANNON.Body({ mass: 0, type: CANNON.Body.STATIC, material: matProp });
    body.addShape(new CANNON.Sphere(r));
    body.position.set(bx, r, bz);
    world.addBody(body);
    const obj = addProp({ kind: "trash", value: 3, radius: r * 1.4, mesh: m, body, tier: 1 });
    mapPropIds.push(obj.id);
  }

  // ---- Kids playing (small civilians) ----
  for (let i = 0; i < 3; i++) {
    const kx = cx + (Math.random() - 0.5) * 3.6;
    const kz = cz + (Math.random() - 0.5) * 3.6;
    const kid = spawnCivilian(kx, kz, Math.random() < 0.5 ? 1 : -1, -1);
    if (kid) {
      kid.mesh.scale.setScalar(0.65);
      mapPropIds.push(kid.id);
    }
  }
}

function spawnPerimeterRailing(data: MapData) {
  const W = data.size[0], H = data.size[1], cs = data.cellSize;
  const halfW = W * cs / 2, halfH = H * cs / 2;
  // Detect water boundary: cells where ch === "W" but a non-water inner cell is adjacent
  // For our generator the water is exactly the outermost ring (1 cell). Place posts along
  // the inner border, every ~2.5m along the rectangle perimeter.
  const innerMinX = -halfW + cs;
  const innerMaxX = halfW - cs;
  const innerMinZ = -halfH + cs;
  const innerMaxZ = halfH - cs;
  const railMat = new THREE.MeshStandardMaterial({ color: 0xe6e9ee, roughness: 0.5, metalness: 0.4 });
  const capMat = new THREE.MeshStandardMaterial({ color: 0xc23a3a, roughness: 0.6 });
  const spacing = 2.5;
  const rails: [number, number][] = [];
  for (let x = innerMinX; x <= innerMaxX; x += spacing) {
    rails.push([x, innerMinZ]);
    rails.push([x, innerMaxZ]);
  }
  for (let z = innerMinZ + spacing; z < innerMaxZ; z += spacing) {
    rails.push([innerMinX, z]);
    rails.push([innerMaxX, z]);
  }
  for (const [x, z] of rails) {
    const g = new THREE.Group();
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.12, 1.0, 8), railMat);
    post.position.y = 0.5; post.castShadow = true;
    g.add(post);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 10), capMat);
    cap.position.y = 1.05;
    g.add(cap);
    g.position.set(x, 0, z);
    propsGroup.add(g);
    const body = new CANNON.Body({ mass: 0, type: CANNON.Body.STATIC, material: matProp });
    body.addShape(new CANNON.Box(new CANNON.Vec3(0.15, 0.55, 0.15)));
    body.position.set(x, 0.55, z);
    world.addBody(body);
    // Use "cone" kind (tier 1) so they're edible from the start
    const obj = addProp({ kind: "cone", value: 2, radius: 0.4, mesh: g, body, tier: 1 });
    mapPropIds.push(obj.id);
  }
}

function spawnMapProp(mp: MapProp) {
  const [wx, wz] = gridToWorld(mp.pos[0], mp.pos[1]);
  const t = mp.type;
  let obj: StickyObject | null = null;
  if (t === "trash" || t === "cone" || t === "bike" || t === "breakable" || t === "person") {
    spawnRoadProp(t as StickyKind, wx, wz, -1);
    obj = lastSpawnedProp;
  } else if (t === "civilian") {
    obj = spawnCivilian(wx, wz, 1, -1);
  } else if (t === "car") {
    obj = spawnCar(wx, wz, -1);
    if (obj && obj.npc?.type === "car") {
      const rot = typeof mp.rot === "number" ? mp.rot : 0;
      obj.mesh.rotation.y = rot;
      // If facing east/west (cos(rot) ≈ 0), drive along X with lane = z; else drive along Z
      const facingX = Math.abs(Math.cos(rot)) < Math.abs(Math.sin(rot));
      const speedMag = Math.abs(obj.npc.speed);
      if (facingX) {
        obj.npc.axis = "x";
        obj.npc.lane = wz;
        // sin(rot) > 0 → facing +X
        obj.npc.speed = speedMag * (Math.sin(rot) > 0 ? 1 : -1);
      } else {
        obj.npc.axis = "z";
        obj.npc.lane = wx;
        obj.npc.speed = speedMag * (Math.cos(rot) > 0 ? 1 : -1);
      }
    }
  } else if (t === "tree") {
    obj = spawnTreeAt(wx, wz);
  } else if (t === "mailbox") {
    obj = spawnSimpleStatic("mailbox", makeMailboxMesh(), wx, wz, 0.45, 8, 0.6);
  } else if (t === "hydrant") {
    obj = spawnSimpleStatic("hydrant", makeHydrantMesh(), wx, wz, 0.35, 6, 0.4);
  } else if (t === "bench") {
    // Bench is 1.6 wide × 0.45 deep × ~1.0 tall — give it a matching collision box
    obj = spawnSimpleStatic("bench", makeBenchMesh(), wx, wz, 0.95, 12, 0.5, 0.8, 0.25);
    if (obj && typeof mp.rot === "number") {
      obj.mesh.rotation.y = mp.rot;
      obj.body.quaternion.setFromEuler(0, mp.rot, 0);
    }
  } else if (t === "lamppost") {
    obj = spawnSimpleStatic("lamppost", makeLamppostMesh(), wx, wz, 0.4, 18, 1.8);
  } else if (t === "police") {
    obj = spawnPoliceAt(wx, wz, mp.rot ?? 0);
  } else if (t === "building_S" || t === "building_M" || t === "building_L") {
    obj = spawnMapBuilding(wx, wz, mp.size ?? [2, 2], mp.height ?? 8, t as any);
  }
  if (obj) mapPropIds.push(obj.id);
}

function makeTrafficLightPole(): { group: THREE.Group; lamp: TrafficLamp } {
  const group = new THREE.Group();
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x222a36, roughness: 0.85 });
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 4.0, 10), poleMat);
  pole.position.y = 2.0; pole.castShadow = true;
  group.add(pole);
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.10, 1.4), poleMat);
  arm.position.set(0, 4.0, 0.7);
  group.add(arm);
  // Housing
  const housing = new THREE.Mesh(
    new THREE.BoxGeometry(0.32, 0.95, 0.32),
    new THREE.MeshStandardMaterial({ color: 0x16202c, roughness: 0.7 }),
  );
  housing.position.set(0, 3.5, 1.4);
  housing.castShadow = true;
  group.add(housing);
  // Lamps (red on top, yellow middle, green bottom)
  const lampGeo = new THREE.SphereGeometry(0.10, 12, 10);
  const mkLamp = (color: number) => new THREE.MeshStandardMaterial({
    color, emissive: color, emissiveIntensity: 0.15, roughness: 0.4,
  });
  const red = new THREE.Mesh(lampGeo, mkLamp(0xff2a2a));
  const yellow = new THREE.Mesh(lampGeo, mkLamp(0xffd13a));
  const green = new THREE.Mesh(lampGeo, mkLamp(0x33dd6a));
  red.position.set(0, 3.85, 1.57);
  yellow.position.set(0, 3.5, 1.57);
  green.position.set(0, 3.15, 1.57);
  group.add(red, yellow, green);
  return { group, lamp: { red, yellow, green } };
}
function setLampOn(lamp: THREE.Mesh, on: boolean) {
  const m = lamp.material as THREE.MeshStandardMaterial;
  m.emissiveIntensity = on ? 1.6 : 0.08;
}
function applyTrafficVisuals() {
  if (!traffic) return;
  const ns = nsLightState();
  const ew = ewLightState();
  for (const l of traffic.nsLamps) {
    setLampOn(l.red, ns === "r");
    setLampOn(l.yellow, ns === "y");
    setLampOn(l.green, ns === "g");
  }
  for (const l of traffic.ewLamps) {
    setLampOn(l.red, ew === "r");
    setLampOn(l.yellow, ew === "y");
    setLampOn(l.green, ew === "g");
  }
}
function updateTrafficLights(dt: number) {
  if (!traffic) return;
  traffic.t += dt;
  const dur = traffic.phase.endsWith("_y") ? 1.8 : 7.0;
  if (traffic.t >= dur) {
    traffic.t = 0;
    traffic.phase =
      traffic.phase === "ns_g" ? "ns_y" :
      traffic.phase === "ns_y" ? "ew_g" :
      traffic.phase === "ew_g" ? "ew_y" : "ns_g";
    applyTrafficVisuals();
  }
}

function unloadMap() {
  traffic = null;
  if (mapGroup) {
    scene.remove(mapGroup);
    mapGroup.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose?.();
      const mat = m.material as any;
      if (mat?.dispose) mat.dispose();
    });
    mapGroup = null;
  }
  for (const b of mapBodies) if (b.world) world.removeBody(b);
  mapBodies = [];
  for (const id of mapPropIds.slice()) {
    const p = props.find((x) => x.id === id);
    if (p) removeProp(p);
  }
  mapPropIds = [];
  // Remove any trains spawned (rail crossings only exist in chunk mode)
  for (const t of trains) {
    for (const b of t.barriers) {
      scene.remove(b.pivot);
      if (b.body.world) world.removeBody(b.body);
    }
    if (t.mesh.parent) t.mesh.parent.remove(t.mesh);
    if (t.body.world) world.removeBody(t.body);
  }
  trains.length = 0;
  // Remove any chunks that may still exist from previous mode
  for (const [, ch] of chunks) disposeChunk(ch);
  chunks.clear();
  currentMap = null;
}

function loadMap(data: MapData) {
  unloadMap();
  currentMap = data;
  mapGroup = new THREE.Group();
  scene.add(mapGroup);

  const W = data.size[0], H = data.size[1], cs = data.cellSize;
  const halfW = W * cs / 2, halfH = H * cs / 2;
  mapBounds = { minX: -halfW, maxX: halfW, minZ: -halfH, maxZ: halfH };

  // Surrounding water (huge plane well below the island)
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(2400, 2400),
    new THREE.MeshStandardMaterial({ color: 0x2a72c8, roughness: 0.35, metalness: 0.4 }),
  );
  water.rotation.x = -Math.PI / 2;
  water.position.set(0, -0.9, 0);
  water.receiveShadow = true;
  mapGroup.add(water);

  // Map base slab — gives the island thickness; top sits BELOW the tile layer
  const slabH = 0.7;
  const slab = new THREE.Mesh(
    new THREE.BoxGeometry(W * cs + 0.4, slabH, H * cs + 0.4),
    new THREE.MeshStandardMaterial({ color: 0xd8d2c2, roughness: 0.9 }),
  );
  // Top of slab at y = -0.05, well below tiles which are at y >= 0
  slab.position.set(0, -0.05 - slabH / 2, 0);
  slab.receiveShadow = true;
  mapGroup.add(slab);

  // Render terrain tiles
  for (let r = 0; r < H; r++) {
    const row = data.grid[r] || "";
    for (let c = 0; c < W; c++) {
      const ch = row[c] || "G";
      const [wx, wz] = gridToWorld(c, r);
      const tile = new THREE.Mesh(
        new THREE.PlaneGeometry(cs + 0.02, cs + 0.02),
        makeTileMaterial(ch),
      );
      tile.rotation.x = -Math.PI / 2;
      tile.position.set(wx, ch === "R" || ch === "X" ? 0.02 : 0.01, wz);
      tile.receiveShadow = true;
      mapGroup.add(tile);
    }
  }

  // Lane markings on horizontal/vertical road centers
  // Detect main road rows/cols by looking at the X intersection cell
  let xRow = -1, xCol = -1;
  for (let r = 0; r < H && xRow < 0; r++) {
    const row = data.grid[r] || "";
    for (let c = 0; c < W; c++) {
      if (row[c] === "X") { xRow = r; xCol = c; break; }
    }
  }
  if (xRow >= 0) {
    const dt = dashedTex.clone(); dt.repeat.set(1, 8); dt.needsUpdate = true;
    const dh = dashedTex.clone(); dh.rotation = Math.PI / 2; dh.center.set(0.5, 0.5); dh.repeat.set(8, 1); dh.needsUpdate = true;
    const [, czWorld] = gridToWorld(0, xRow);
    const [cxWorld] = gridToWorld(xCol, 0);
    const hLine = new THREE.Mesh(
      new THREE.PlaneGeometry(W * cs, 0.4),
      new THREE.MeshStandardMaterial({ color: 0xffffff, map: dh, transparent: true, roughness: 0.4 }),
    );
    hLine.rotation.x = -Math.PI / 2;
    hLine.position.set(0, 0.035, czWorld + cs * 0.5);
    mapGroup.add(hLine);
    const vLine = new THREE.Mesh(
      new THREE.PlaneGeometry(0.4, H * cs),
      new THREE.MeshStandardMaterial({ color: 0xffffff, map: dt, transparent: true, roughness: 0.4 }),
    );
    vLine.rotation.x = -Math.PI / 2;
    vLine.position.set(cxWorld + cs * 0.5, 0.035, 0);
    mapGroup.add(vLine);

    // ---- Traffic light poles at the four junction corners ----
    const jcx = cxWorld + cs * 0.5;
    const jcz = czWorld + cs * 0.5;
    const ROAD_HALF_LOCAL = cs * 0.5; // road occupies the X cell column / row
    const STOP = ROAD_HALF_LOCAL + 0.4;
    const nsLamps: TrafficLamp[] = [];
    const ewLamps: TrafficLamp[] = [];
    // 4 corners: (sx, sz) ∈ {-1,1}². Each pole faces the approaching driver (looks back along their direction).
    for (const sx of [-1, 1] as const) {
      for (const sz of [-1, 1] as const) {
        const { group, lamp } = makeTrafficLightPole();
        group.position.set(jcx + sx * (ROAD_HALF_LOCAL + 0.5), 0, jcz + sz * (ROAD_HALF_LOCAL + 0.5));
        // Diagonal corners govern the perpendicular pair: (sx=+1, sz=-1) and (sx=-1, sz=+1) → governs NS approach
        // Actually — give each corner a pair: corner (sx, sz) faces the traffic on the approach roads it sees.
        // We assign two corners to NS lights (visible to N→S and S→N drivers) and two to EW.
        // Simple split: corners (sx=+1,sz=-1) and (sx=-1,sz=+1) host the NS-facing lights;
        // the other two host EW-facing lights.
        const isNSCorner = sx * sz < 0;
        if (isNSCorner) {
          // Face along ±Z (toward the approaching NS car). For NS green to be visible to N→S driver at +z side, pole at sz=-1 should face +z.
          group.rotation.y = sz < 0 ? 0 : Math.PI;
          nsLamps.push(lamp);
        } else {
          group.rotation.y = sx < 0 ? Math.PI / 2 : -Math.PI / 2;
          ewLamps.push(lamp);
        }
        mapGroup.add(group);
      }
    }
    traffic = {
      cx: jcx, cz: jcz, stopDist: STOP,
      phase: "ns_g", t: 0, nsLamps, ewLamps,
    };
    applyTrafficVisuals();
  }

  // Spawn cluster — guarantee a busy pocket within ~10 cells of the start position
  {
    const [sx, sy] = data.startPos;
    const R = 10;
    const types: Array<{ kind: "civilian" | "lamppost" | "mailbox" | "hydrant" | "bench" | "trash" | "cone" | "bike" | "car"; on: string[]; chance: number }> = [
      { kind: "civilian", on: ["S"], chance: 0.28 },
      { kind: "lamppost", on: ["S"], chance: 0.15 },
      { kind: "mailbox",  on: ["S"], chance: 0.05 },
      { kind: "hydrant",  on: ["S"], chance: 0.05 },
      { kind: "bench",    on: ["S"], chance: 0.08 },
      { kind: "trash",    on: ["R"], chance: 0.15 },
      { kind: "cone",     on: ["R"], chance: 0.13 },
      { kind: "car",      on: ["R"], chance: 0.15 },
      { kind: "bike",     on: ["S", "G"], chance: 0.10 },
    ];
    let cs = 1;
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const r = sy + dy, c = sx + dx;
        if (r < 0 || r >= data.size[1] || c < 0 || c >= data.size[0]) continue;
        const dist = Math.hypot(dx, dy);
        if (dist < 2 || dist > R) continue; // keep a small clear ring around the hole
        const ch = data.grid[r]?.[c];
        if (!ch) continue;
        // proximity bias: closer cells get more chance
        const proximity = 1 - dist / R;
        for (const t of types) {
          if (!t.on.includes(ch)) continue;
          cs++;
          const roll = rand(cs * 13.7);
          if (roll < t.chance * (0.5 + proximity)) {
            data.props.push({ type: t.kind, pos: [c, r] });
            break; // one prop per cell
          }
        }
      }
    }
  }

  // Spawn props
  for (const mp of data.props) spawnMapProp(mp);

  // Auto-place a few playgrounds on any 3×3 block of grass cells
  {
    const placed: Array<[number, number]> = [];
    for (let r = 0; r < data.size[1] - 2 && placed.length < 9; r++) {
      for (let c = 0; c < data.size[0] - 2 && placed.length < 9; c++) {
        let allGrass = true;
        for (let dr = 0; dr < 3 && allGrass; dr++)
          for (let dc = 0; dc < 3 && allGrass; dc++)
            if (data.grid[r + dr]?.[c + dc] !== "G") allGrass = false;
        if (!allGrass) continue;
        // Spread out playgrounds — at least 7 cells apart so they appear at a distance
        const tooClose = placed.some(([pr, pc]) => Math.hypot(pr - r, pc - c) < 7);
        if (tooClose) continue;
        placed.push([r, c]);
        spawnPlayground(...gridToWorld(c + 1, r + 1));
      }
    }
  }

  // Edible perimeter railing: rows of cones along the inner edge of the water,
  // so the player can chew through them and see the city extend to the water line.
  spawnPerimeterRailing(data);

  // Place hole at map start
  const [hx, hz] = gridToWorld(data.startPos[0], data.startPos[1]);
  holePos.set(hx, 0, hz);
  holeVel.set(0, 0, 0);
  // P2 starts a few units away
  holePos2.set(hx + 6, 0, hz + 6);
  holeVel2.set(0, 0, 0);
  holeRadius2 = baseHoleRadius;
  applyHole2Scale();
}

// Procedural fallback for maps 2-5 — sidewalk-default, dense props
function generateMap(seed: number, name: string): MapData {
  // City: 32×32 cells × 5m = 160m × 160m (50% smaller per side, ~25% area).
  const W = 32, H = 32, cs = 5;
  const WATER = 1; // perimeter water ring
  // Road bands — fewer, since the map is smaller.
  const HROADS = [8, 16, 24]; // each road occupies r and r-1 (2 cells wide)
  const VROADS = [8, 16, 24];
  const onHRoad = (r: number) => HROADS.some((x) => r === x || r === x - 1);
  const onVRoad = (c: number) => VROADS.some((x) => c === x || c === x - 1);
  // The lit junction (traffic lights) is the central intersection.
  const X_R = HROADS[1] - 1, X_C = VROADS[1] - 1; // top-left of the X pair
  const isCenterX = (r: number, c: number) => (r === X_R || r === X_R + 1) && (c === X_C || c === X_C + 1);

  const grid: string[] = [];
  for (let r = 0; r < H; r++) {
    let row = "";
    for (let c = 0; c < W; c++) {
      if (r < WATER || r >= H - WATER || c < WATER || c >= W - WATER) {
        row += "W"; continue;
      }
      if (isCenterX(r, c)) row += "X";
      else if (onHRoad(r) || onVRoad(c)) row += "R";
      else row += "S";
    }
    grid.push(row);
  }

  function fill(rect: [number, number, number, number], ch: string) {
    const [x, y, w, h] = rect;
    for (let r = y; r < y + h && r < H; r++) {
      let row = grid[r];
      for (let c = x; c < x + w && c < W; c++) {
        if (row[c] === "S") row = row.slice(0, c) + ch + row.slice(c + 1);
      }
      grid[r] = row;
    }
  }
  let s = seed;
  // Lots of grass patches and parking lots tucked between road bands
  for (let i = 0; i < 12; i++) { s++; fill([2 + Math.floor(rand(s) * (W - 6)), 2 + Math.floor(rand(s * 2) * (H - 6)), 3, 3], "G"); }
  for (let i = 0; i < 10; i++) { s++; fill([2 + Math.floor(rand(s * 3) * (W - 5)), 2 + Math.floor(rand(s * 4) * (H - 5)), 2, 2], "P"); }

  const props: MapProp[] = [];
  function tryPush(p: MapProp, allowed: string[]) {
    const c = p.pos[0], r = p.pos[1];
    if (r < 0 || r >= H || c < 0 || c >= W) return;
    if (allowed.includes(grid[r][c])) props.push(p);
  }

  // Trees scattered on grass — extra dense for jungle-themed map 3
  const treeCount = name === "Jungle" ? 110 : 55;
  for (let i = 0; i < treeCount; i++) {
    s++;
    tryPush({ type: "tree", pos: [Math.floor(rand(s * 1.7) * W), Math.floor(rand(s * 2.3) * H)] }, ["G"]);
  }
  for (let i = 0; i < 70; i++) {
    s++;
    tryPush({ type: "civilian", pos: [Math.floor(rand(s * 1.13) * W), Math.floor(rand(s * 4.7) * H)] }, ["S"]);
  }
  for (let i = 0; i < 18; i++) {
    s++;
    tryPush({ type: "bench", pos: [Math.floor(rand(s * 5.6) * W), Math.floor(rand(s * 6.7) * H)], rot: rand(s) > 0.5 ? 0 : 1.57 }, ["S"]);
  }
  for (let i = 0; i < 36; i++) {
    s++;
    tryPush({ type: "lamppost", pos: [Math.floor(rand(s * 7.3) * W), Math.floor(rand(s * 8.1) * H)] }, ["S"]);
  }
  for (let i = 0; i < 14; i++) {
    s++;
    tryPush({ type: "mailbox", pos: [Math.floor(rand(s * 9) * W), Math.floor(rand(s * 9.7) * H)] }, ["S"]);
  }
  for (let i = 0; i < 14; i++) {
    s++;
    tryPush({ type: "hydrant", pos: [Math.floor(rand(s * 10.3) * W), Math.floor(rand(s * 11.1) * H)] }, ["S"]);
  }
  for (let i = 0; i < 32; i++) {
    s++;
    const c = Math.floor(rand(s * 5.3) * W);
    const r = Math.floor(rand(s * 6.1) * H);
    tryPush({ type: rand(s * 7) > 0.5 ? "trash" : "cone", pos: [c, r] }, ["R"]);
  }
  for (let i = 0; i < 14; i++) {
    s++;
    tryPush({ type: "bike", pos: [Math.floor(rand(s * 8) * W), Math.floor(rand(s * 9) * H)] }, ["S", "G"]);
  }
  // Cars: steady traffic
  for (let i = 0; i < 26; i++) {
    s++;
    const c = Math.floor(rand(s * 10) * W);
    const r = Math.floor(rand(s * 11) * H);
    tryPush({ type: "car", pos: [c, r] }, ["R"]);
  }
  for (let i = 0; i < 4; i++) {
    s++;
    const c = Math.floor(rand(s * 12) * W);
    const r = Math.floor(rand(s * 13) * H);
    tryPush({ type: "police", pos: [c, r] }, ["R"]);
  }

  // Buildings — smaller blocks, fewer because the map is smaller
  for (let bi = 0; bi < 50; bi++) {
    s++;
    const c = 2 + Math.floor(rand(s * 1.31) * (W - 5));
    const r = 2 + Math.floor(rand(s * 2.11) * (H - 5));
    // Skip if would overlap a road
    let bad = false;
    for (let dr = 0; dr < 3 && !bad; dr++) for (let dc = 0; dc < 3 && !bad; dc++) {
      const ch = grid[r + dr]?.[c + dc];
      if (ch !== "S" && ch !== "G") bad = true;
    }
    if (bad) continue;
    const sizeRoll = rand(s * 3.07);
    const sz: [number, number] = sizeRoll < 0.5 ? [2, 2] : sizeRoll < 0.85 ? [3, 3] : [3, 4];
    const heightRoll = rand(s * 4.13);
    const h = sizeRoll < 0.5 ? lerp(3.5, 5.5, heightRoll)
            : sizeRoll < 0.85 ? lerp(5, 7.5, heightRoll)
                              : lerp(7, 9.5, heightRoll);
    const kind = h >= 7 ? "building_L" : h >= 5 ? "building_M" : "building_S";
    props.push({ type: kind, pos: [c, r], size: sz, height: h });
  }

  // Prefer to start INSIDE a parking lot (P), nearest to the map center.
  let sx = Math.floor(W / 2), sy = Math.floor(H / 2);
  let bestDist = Infinity;
  let foundP = false;
  for (let r = 1; r < H - 1; r++) {
    for (let c = 1; c < W - 1; c++) {
      if (grid[r][c] !== "P") continue;
      const d = Math.hypot(c - W / 2, r - H / 2);
      if (d < bestDist) { bestDist = d; sx = c; sy = r; foundP = true; }
    }
  }
  // Fallback: nearest sidewalk to the center if no parking lot exists
  if (!foundP) {
    outer:
    for (let dr = 0; dr < 6; dr++) for (let dc = 0; dc < 6; dc++) {
      for (const [a, b] of [[dr, dc], [-dr, dc], [dr, -dc], [-dr, -dc]] as [number, number][]) {
        const r = sy + a, c = sx + b;
        if (r < 1 || r >= H || c < 1 || c >= W) continue;
        const ch = grid[r][c];
        if (ch === "S" || ch === "G") { sx = c; sy = r; break outer; }
      }
    }
  }

  return {
    name, size: [W, H], cellSize: cs, startPos: [sx, sy],
    grid, props,
  };
}

function getMapForLevel(lvl: number): MapData {
  const m = Math.min(MAX_MAPS, Math.ceil(lvl / LEVELS_PER_MAP));
  const names = ["Downtown", "Suburbs", "Jungle"];
  return generateMap(1000 + m * 1009, names[m - 1] ?? "City");
}

// ---------- Chunk system ----------
type Chunk = {
  index: number;
  group: THREE.Group;
  bodies: CANNON.Body[];
  propIds: number[];
  hasCross: boolean;
  hasRail: boolean;
  roadGapZ?: number; // for rail crossing pickup behavior
};

const chunks = new Map<number, Chunk>();
const carPalette = [0xff4d6d, 0x4dc6ff, 0xffd84d, 0x6dffae, 0xffffff, 0x2a2f3a, 0xff7a4d];
const civilianPalette = [0xff8aa6, 0x9be7ff, 0xffd97a, 0x9affb1, 0xc8baff, 0xffc299];

function chunkZStart(index: number) { return -index * CHUNK_LEN; }
function chunkZEnd(index: number) { return -(index + 1) * CHUNK_LEN; }

function generateChunk(index: number): Chunk {
  const chunk: Chunk = {
    index, group: new THREE.Group(), bodies: [], propIds: [],
    hasCross: index > 0 && index % CROSS_EVERY === 0,
    hasRail: index > 0 && index % RAIL_EVERY === 0,
  };
  scene.add(chunk.group);

  const zStart = chunkZStart(index);   // larger Z
  const zEnd = chunkZEnd(index);       // smaller Z
  const zMid = (zStart + zEnd) / 2;

  // Avoid putting cross + rail in same chunk
  if (chunk.hasCross && chunk.hasRail) chunk.hasRail = false;

  // ---- Visible road slab on top of physics ground ----
  {
    const roadTex = asphaltTex.clone();
    roadTex.repeat.set(2, CHUNK_LEN / 8);
    roadTex.needsUpdate = true;
    const road = new THREE.Mesh(
      new THREE.PlaneGeometry(2 * ROAD_HALF, CHUNK_LEN),
      new THREE.MeshStandardMaterial({ color: 0xffffff, map: roadTex, roughness: 0.95 }),
    );
    road.rotation.x = -Math.PI / 2;
    road.position.set(0, 0.005, zMid);
    road.receiveShadow = true;
    chunk.group.add(road);
  }

  // ---- Lawn flanking the road so buildings sit on visible ground (not in dark void) ----
  {
    const lawnMat = new THREE.MeshStandardMaterial({ color: 0x6cc35a, roughness: 0.9 });
    for (const side of [-1, 1] as const) {
      const lawnW = 80; // wide enough to extend past all building rows
      const lawn = new THREE.Mesh(
        new THREE.PlaneGeometry(lawnW, CHUNK_LEN),
        lawnMat,
      );
      lawn.rotation.x = -Math.PI / 2;
      lawn.position.set(side * (ROAD_HALF + SIDEWALK_W + lawnW / 2), 0.0, zMid);
      lawn.receiveShadow = true;
      chunk.group.add(lawn);
    }
  }

  // ---- Lane markings ----
  {
    const dl = dashedTex.clone(); dl.repeat.set(1, CHUNK_LEN / 4); dl.needsUpdate = true;
    const dm = new THREE.Mesh(
      new THREE.PlaneGeometry(0.4, CHUNK_LEN),
      new THREE.MeshStandardMaterial({ color: 0xffffff, map: dl, transparent: true, roughness: 0.4 }),
    );
    dm.rotation.x = -Math.PI / 2;
    dm.position.set(0, 0.012, zMid);
    chunk.group.add(dm);
  }

  // ---- Sidewalks split around cross/rail ----
  const blockedSpans: [number, number][] = [];
  if (chunk.hasCross) blockedSpans.push([zMid + ROAD_HALF + 0.1, zMid - ROAD_HALF - 0.1]);
  if (chunk.hasRail) blockedSpans.push([zMid + 1.6, zMid - 1.6]);

  function buildSidewalkSegment(side: -1 | 1, segStart: number, segEnd: number) {
    const length = segStart - segEnd;
    if (length <= 0.2) return;
    const x = side * (ROAD_HALF + SIDEWALK_W / 2);
    const z = (segStart + segEnd) / 2;

    const swTex = sidewalkTex.clone();
    swTex.repeat.set(1, Math.max(2, length / 4)); swTex.needsUpdate = true;
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(SIDEWALK_W, CURB_H, length),
      new THREE.MeshStandardMaterial({ color: 0xffffff, map: swTex, roughness: 0.9 }),
    );
    slab.position.set(x, CURB_H / 2, z);
    slab.receiveShadow = true;
    chunk.group.add(slab);

    const curb = new THREE.Mesh(
      new THREE.BoxGeometry(0.12, CURB_H * 1.05, length),
      curbMat,
    );
    curb.position.set(side * (ROAD_HALF + 0.06), CURB_H / 2 + 0.001, z);
    curb.receiveShadow = true;
    chunk.group.add(curb);

    // Physics: solid raised platform — smaller balls bump off, bigger ones climb
    const swBody = new CANNON.Body({ type: CANNON.Body.STATIC, material: matGround });
    swBody.addShape(new CANNON.Box(new CANNON.Vec3(SIDEWALK_W / 2, CURB_H / 2, length / 2)));
    swBody.position.set(x, CURB_H / 2, z);
    world.addBody(swBody);
    chunk.bodies.push(swBody);
  }

  // Generate sidewalk segments avoiding blocked spans
  {
    let z = zStart;
    const sortedBlocked = blockedSpans.slice().sort((a, b) => b[0] - a[0]);
    for (const [topZ, botZ] of sortedBlocked) {
      if (z > topZ) {
        buildSidewalkSegment(-1, z, topZ);
        buildSidewalkSegment(1, z, topZ);
      }
      z = botZ;
    }
    if (z > zEnd) {
      buildSidewalkSegment(-1, z, zEnd);
      buildSidewalkSegment(1, z, zEnd);
    }
  }

  // ---- Cross-section (perpendicular drivable platform, the "swerve into different sections") ----
  if (chunk.hasCross) {
    // Visual cross asphalt
    const ct = asphaltTex.clone();
    ct.repeat.set(CROSS_X_HALF / 4, 2);
    ct.needsUpdate = true;
    const crossMesh = new THREE.Mesh(
      new THREE.BoxGeometry(CROSS_X_HALF * 2, 0.04, 2 * ROAD_HALF + 0.08),
      new THREE.MeshStandardMaterial({ color: 0xffffff, map: ct, roughness: 0.95 }),
    );
    crossMesh.position.set(0, 0.022, zMid);
    crossMesh.receiveShadow = true;
    chunk.group.add(crossMesh);

    // Physics for cross-road (so player can drive onto it). Two flanks (left & right of main road).
    for (const side of [-1, 1] as const) {
      const flankLen = CROSS_X_HALF - ROAD_HALF;
      const cb = new CANNON.Body({ type: CANNON.Body.STATIC, material: matGround });
      cb.addShape(new CANNON.Box(new CANNON.Vec3(flankLen / 2, 0.5, ROAD_HALF + 0.04)));
      cb.position.set(side * (ROAD_HALF + flankLen / 2), -0.5, zMid);
      world.addBody(cb);
      chunk.bodies.push(cb);
    }

    // Crosswalk stripes on main road
    for (const sign of [-1, 1] as const) {
      const cw = new THREE.Mesh(
        new THREE.PlaneGeometry(2 * ROAD_HALF, 2.0),
        new THREE.MeshStandardMaterial({ color: 0xffffff, map: crosswalkTex, transparent: true, roughness: 0.4 }),
      );
      cw.rotation.x = -Math.PI / 2;
      cw.position.set(0, 0.018, zMid + sign * (ROAD_HALF + 1.3));
      chunk.group.add(cw);
    }

    // Traffic signals (4 corners)
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x252a38, roughness: 0.85 });
    const boxMat = new THREE.MeshStandardMaterial({ color: 0x1a1f2e, roughness: 0.7 });
    const redMat = new THREE.MeshStandardMaterial({ color: 0xff4040, emissive: 0xff2020, emissiveIntensity: 1.2 });
    for (const sx of [-1, 1] as const) {
      for (const sz of [-1, 1] as const) {
        const x = sx * (ROAD_HALF + SIDEWALK_W * 0.7);
        const z = zMid + sz * (ROAD_HALF + SIDEWALK_W * 0.7);
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 4.0, 8), poleMat);
        pole.position.set(x, 2.0, z); pole.castShadow = true;
        chunk.group.add(pole);
        const head = new THREE.Mesh(new THREE.BoxGeometry(0.42, 1.05, 0.32), boxMat);
        head.position.set(x - sx * 0.25, 3.6, z); head.castShadow = true;
        chunk.group.add(head);
        const lens = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), redMat);
        lens.position.set(head.position.x - sx * 0.2, 3.95, head.position.z);
        chunk.group.add(lens);
      }
    }
  }

  // ---- Railway crossing ----
  if (chunk.hasRail) {
    chunk.roadGapZ = zMid;

    // Rails (two parallel) running across X
    const railMat = new THREE.MeshStandardMaterial({ color: 0x9a9faa, roughness: 0.4, metalness: 0.7 });
    for (const off of [-0.7, 0.7]) {
      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(60, 0.06, 0.08),
        railMat,
      );
      rail.position.set(0, 0.04, zMid + off);
      rail.receiveShadow = true; rail.castShadow = true;
      chunk.group.add(rail);
    }
    // Sleepers
    const sleeperMat = new THREE.MeshStandardMaterial({ color: 0x4a3a2a, roughness: 0.9 });
    for (let xi = -28; xi <= 28; xi += 1.6) {
      const sl = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.05, 1.7), sleeperMat);
      sl.position.set(xi, 0.025, zMid);
      chunk.group.add(sl);
    }

    // Warning poles (the actual arms are created with the train so they animate)
    for (const sx of [-1, 1] as const) {
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.07, 0.09, 3.0, 8),
        new THREE.MeshStandardMaterial({ color: 0x222633, roughness: 0.85 }),
      );
      pole.position.set(sx * (ROAD_HALF + 0.4), 1.5, zMid);
      pole.castShadow = true;
      chunk.group.add(pole);
    }

    // The road has a small "gap" at the rails — we keep the long ground body covering it (so ball doesn't fall
    // into a hole), but the train moving across will sweep the ball if too small.
  }

  // ---- Buildings (random rows on each side, skip blocked spans) ----
  {
    const seed = (index * 9173 + 1) % 100000;
    const rowSpacing = 5.6;
    const buildingLineNear = ROAD_HALF + SIDEWALK_W + 0.4;
    const rowsOut = 4;
    const sideRowOffset = 4.8;

    for (let zz = zStart - 2; zz > zEnd + 2; zz -= rowSpacing) {
      // skip blocked spans
      let blocked = false;
      for (const [t, b] of blockedSpans) if (zz <= t && zz >= b) blocked = true;
      if (blocked) continue;

      for (const side of [-1, 1] as const) {
        for (let r = 0; r < rowsOut; r++) {
          const s = seed + zz * 13 + side * 7 + r * 31;
          const widthJ = lerp(2.6, 5.4, rand(s * 1.13));
          const depth = lerp(2.6, 5.0, rand(s * 1.71));
          const height = lerp(6.0, r === 0 ? 18.0 : 32.0, rand(s * 2.11));
          const xJ = (rand(s * 3.13) - 0.5) * 0.8;
          const zJ = (rand(s * 4.51) - 0.5) * (rowSpacing - depth - 0.4);
          const x = side * (buildingLineNear + r * sideRowOffset + xJ) + side * widthJ * 0.5;
          const z = zz + zJ;

          const cIdx = (rand(s * 6.13) * buildingPalette.length) | 0;
          const baseCol = new THREE.Color(buildingPalette[cIdx]);
          if (r >= 2) baseCol.lerp(new THREE.Color(0x9aa3b3), 0.45);

          const bMat = concreteMat.clone();
          bMat.color = baseCol;
          const bm = new THREE.Mesh(new THREE.BoxGeometry(widthJ, height, depth), bMat);
          bm.position.set(x, height / 2, z);
          bm.rotation.y = (rand(s * 5.7) - 0.5) * 0.06;
          bm.castShadow = true; bm.receiveShadow = true;
          chunk.group.add(bm);

          const rcap = new THREE.Mesh(
            new THREE.BoxGeometry(widthJ * 1.04, 0.5, depth * 1.04),
            roofMat,
          );
          rcap.position.set(x, height + 0.25, z);
          rcap.rotation.y = bm.rotation.y;
          rcap.castShadow = true;
          chunk.group.add(rcap);

          // Solid building physics so things can't tunnel through
          const bb = new CANNON.Body({ type: CANNON.Body.STATIC, material: matGround });
          bb.addShape(new CANNON.Box(new CANNON.Vec3(widthJ / 2, height / 2, depth / 2)));
          bb.position.set(x, height / 2, z);
          bb.quaternion.setFromEuler(0, bm.rotation.y, 0);
          world.addBody(bb);
          chunk.bodies.push(bb);
        }
      }
    }
  }

  // ---- Streetlights (sparse) ----
  {
    const poleGeo = new THREE.CylinderGeometry(0.05, 0.07, 3.6, 8);
    const headGeo = new THREE.SphereGeometry(0.18, 10, 8);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x2a3352, roughness: 0.9 });
    const headMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.25, emissive: 0xfff1c8, emissiveIntensity: 1.4,
    });
    for (let z = zStart - 4; z > zEnd + 4; z -= 12) {
      let blocked = false;
      for (const [t, b] of blockedSpans) if (z <= t && z >= b) blocked = true;
      if (blocked) continue;
      for (const side of [-1, 1] as const) {
        const x = side * (ROAD_HALF + SIDEWALK_W * 0.5);
        const pole = new THREE.Mesh(poleGeo, poleMat);
        pole.position.set(x, 1.8 + CURB_H, z);
        pole.castShadow = true;
        chunk.group.add(pole);
        const head = new THREE.Mesh(headGeo, headMat);
        head.position.set(x - side * 0.35, 3.4 + CURB_H, z);
        chunk.group.add(head);
      }
    }
  }

  // ---- Props on the road ----
  {
    const seed = (index * 4719 + 31) % 100000;
    for (let z = zStart - 1.5; z > zEnd + 1.5; z -= 2.6) {
      const s = seed + z * 13;
      const r = rand(s);
      if (r < 0.45) continue;
      // Skip near blocked spans
      let near = false;
      for (const [t, b] of blockedSpans) if (z <= t + 1.5 && z >= b - 1.5) near = true;
      if (near) continue;

      const laneX = lerp(-ROAD_HALF + 0.5, ROAD_HALF - 0.5, rand(s * 1.31));
      const kindRoll = rand(s * 1.77);
      let kind: StickyKind = "trash";
      if (kindRoll < 0.5) kind = "trash";
      else if (kindRoll < 0.74) kind = "cone";
      else if (kindRoll < 0.9) kind = "bike";
      else kind = "person";
      if (rand(s * 2.91) > 0.985) kind = "breakable";

      spawnRoadProp(kind, laneX, z, chunk.index);
      const p = lastSpawnedProp;
      if (p) chunk.propIds.push(p.id);
    }
  }

  // ---- Civilians on sidewalks (denser) ----
  {
    const seed = (index * 7331 + 13) % 100000;
    for (let z = zStart - 2; z > zEnd + 2; z -= 3.5) {
      const s = seed + z * 17;
      if (rand(s) < 0.25) continue;
      let blocked = false;
      for (const [t, b] of blockedSpans) if (z <= t + 1 && z >= b - 1) blocked = true;
      if (blocked) continue;
      // Spawn on both sides sometimes
      const sides: (1 | -1)[] = rand(s * 4.2) > 0.6 ? [-1, 1] : [rand(s * 1.7) > 0.5 ? 1 : -1];
      for (const side of sides) {
        const sideX = side * (ROAD_HALF + SIDEWALK_W * 0.5 + (rand(s * 2.3 + side) - 0.5) * 1.2);
        const dir: 1 | -1 = rand(s * 3.1 + side) > 0.5 ? 1 : -1;
        const civ = spawnCivilian(sideX, z, dir, chunk.index);
        if (civ) chunk.propIds.push(civ.id);
      }
    }
  }

  // (spikes disabled in hole.io mode — phase 1)

  // ---- Cars on the road ----
  {
    const seed = (index * 8101 + 7) % 100000;
    for (let z = zStart - 6; z > zEnd + 6; z -= 14) {
      const s = seed + z * 11;
      if (rand(s) < 0.45) continue;
      let blocked = false;
      for (const [t, b] of blockedSpans) if (z <= t + 2 && z >= b - 2) blocked = true;
      if (blocked) continue;
      const lane = rand(s * 2.3) > 0.5 ? 2.4 : -2.4;
      const car = spawnCar(lane, z, chunk.index);
      if (car) chunk.propIds.push(car.id);
    }
  }

  // ---- Train (only in rail chunk) — kinematic, sweeps the crossing periodically ----
  if (chunk.hasRail) {
    const train = spawnTrain(zMid, chunk.index);
    if (train) chunk.propIds.push(train.id);
  }

  return chunk;
}

let lastSpawnedProp: StickyObject | null = null;

function spawnRoadProp(kind: StickyKind, x: number, z: number, chunkIndex: number) {
  const y = kind === "bike" ? 0.33 : kind === "cone" ? 0.3 : kind === "trash" ? 0.27 : 0.45;
  let mesh: THREE.Object3D;
  let shape: CANNON.Shape;
  let radius = 0.35, mass = 0.8, value = 1;
  if (kind === "trash") {
    mesh = makeTrashMesh();
    shape = new CANNON.Cylinder(0.18, 0.18, 0.5, 10);
    radius = 0.28; mass = 0.5; value = 1;
  } else if (kind === "cone") {
    mesh = makeConeMesh();
    shape = new CANNON.Cylinder(0.23, 0.05, 0.6, 12);
    radius = 0.3; mass = 0.6; value = 2;
  } else if (kind === "bike") {
    mesh = makeBikeMesh();
    shape = new CANNON.Box(new CANNON.Vec3(0.45, 0.12, 0.2));
    radius = 0.55; mass = 1.4; value = 4;
  } else if (kind === "person") {
    mesh = makePersonMesh();
    shape = new CANNON.Box(new CANNON.Vec3(0.18, 0.42, 0.18));
    radius = 0.45; mass = 1.0; value = 3;
  } else {
    mesh = makeBreakableMesh();
    shape = new CANNON.Box(new CANNON.Vec3(0.35, 0.4, 0.35));
    radius = 0.55; mass = 2.2; value = 10;
  }
  mesh.position.set(x, y, z);
  mesh.rotation.y = Math.random() * Math.PI * 2;
  propsGroup.add(mesh);
  const body = new CANNON.Body({ mass, material: matProp, linearDamping: 0.3, angularDamping: 0.6 });
  body.addShape(shape);
  body.position.set(x, y, z);
  body.quaternion.setFromEuler(0, mesh.rotation.y, 0);
  body.allowSleep = true;
  body.sleepSpeedLimit = 0.2;
  body.sleepTimeLimit = 0.2;
  world.addBody(body);
  const obj = addProp({ kind, value, radius, mesh, body, chunkIndex });
  lastSpawnedProp = obj;
}

function makeSpikeMesh(): THREE.Object3D {
  const g = new THREE.Group();
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(1.2, 0.06, 0.5),
    new THREE.MeshStandardMaterial({ color: 0xffd23a, roughness: 0.55, metalness: 0.2 }),
  );
  g.add(base);
  const spikeMat = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.4, metalness: 0.7 });
  const spikeGeo = new THREE.ConeGeometry(0.06, 0.18, 6);
  for (let i = -2; i <= 2; i++) {
    const sp = new THREE.Mesh(spikeGeo, spikeMat);
    sp.position.set(i * 0.22, 0.12, 0);
    g.add(sp);
  }
  g.castShadow = true;
  return g;
}

function spawnSpike(x: number, z: number, chunkIndex: number): StickyObject | null {
  const mesh = makeSpikeMesh();
  mesh.position.set(x, 0.05, z);
  propsGroup.add(mesh);
  const body = new CANNON.Body({ mass: 0, type: CANNON.Body.STATIC, material: matProp });
  body.addShape(new CANNON.Box(new CANNON.Vec3(0.6, 0.12, 0.25)));
  body.position.set(x, 0.12, z);
  world.addBody(body);
  return addProp({ kind: "spike", value: 0, radius: 0.6, mesh, body, chunkIndex });
}

function spawnCivilian(x: number, z: number, dir: 1 | -1, chunkIndex: number): StickyObject | null {
  const color = civilianPalette[(Math.random() * civilianPalette.length) | 0];
  const mesh = makePersonMesh(color);
  mesh.position.set(x, CURB_H + 0.3, z);
  propsGroup.add(mesh);
  const body = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, material: matProp });
  body.addShape(new CANNON.Box(new CANNON.Vec3(0.2, 0.45, 0.2)));
  body.position.set(x, CURB_H + 0.3, z);
  world.addBody(body);
  const obj = addProp({
    kind: "civilian", value: 5, radius: 0.75, mesh, body, chunkIndex,
    npc: { type: "civilian", sideX: x, dir, speed: 0.45 + Math.random() * 0.35, phase: Math.random() * 6.28 },
  });
  return obj;
}

function spawnCar(laneX: number, z: number, chunkIndex: number): StickyObject | null {
  const color = carPalette[(Math.random() * carPalette.length) | 0];
  const mesh = makeCarMesh(color);
  mesh.position.set(laneX, 0, z);
  // Cars on the side of road facing forward (lane > 0 going +Z, lane < 0 going -Z) — keeps right-hand traffic
  const goingPositive = laneX > 0; // right lane drives toward +Z (i.e. behind ball region)
  if (!goingPositive) mesh.rotation.y = Math.PI;
  propsGroup.add(mesh);
  const body = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, material: matProp });
  body.addShape(new CANNON.Box(new CANNON.Vec3(0.55, 0.5, 1.1)));
  body.position.set(laneX, 0.5, z);
  body.quaternion.setFromEuler(0, mesh.rotation.y, 0);
  world.addBody(body);
  const obj = addProp({
    kind: "car", value: 25, radius: 1.5, mesh, body, chunkIndex,
    npc: { type: "car", speed: goingPositive ? 8.0 : -8.0, lane: laneX },
  });
  return obj;
}

type BarrierArm = { pivot: THREE.Object3D; body: CANNON.Body; side: -1 | 1; openRot: number; closedRot: number };
type Train = { mesh: THREE.Object3D; body: CANNON.Body; t: number; zCenter: number; lastHorn: number; barriers: BarrierArm[] };
const trains: Train[] = [];

function spawnTrain(zCenter: number, _chunkIndex: number): StickyObject | null {
  const g = new THREE.Group();
  const carColors = [0xee2d3a, 0xee2d3a, 0x2a3550, 0x9a9faa];
  for (let i = 0; i < 4; i++) {
    const c = new THREE.Mesh(
      new THREE.BoxGeometry(3.4, 1.6, 1.4),
      new THREE.MeshStandardMaterial({ color: carColors[i], roughness: 0.55, metalness: 0.3 }),
    );
    c.position.set(i * 3.6 - 5.4, 1.0, 0);
    c.castShadow = true; c.receiveShadow = true;
    g.add(c);
    // Roof detail
    const top = new THREE.Mesh(
      new THREE.BoxGeometry(3.0, 0.2, 1.2),
      new THREE.MeshStandardMaterial({ color: 0x141822, roughness: 0.7 }),
    );
    top.position.set(c.position.x, 1.9, 0);
    g.add(top);
  }
  // Engine front
  const front = new THREE.Mesh(
    new THREE.BoxGeometry(0.6, 1.2, 1.2),
    new THREE.MeshStandardMaterial({ color: 0xffd84d, emissive: 0xffaa20, emissiveIntensity: 0.4 }),
  );
  front.position.set(-7.6, 0.8, 0);
  g.add(front);

  g.position.set(-60, 0, zCenter);
  scene.add(g);

  const body = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, material: matProp });
  body.addShape(new CANNON.Box(new CANNON.Vec3(7.5, 1.0, 0.7)));
  body.position.set(-60, 1.0, zCenter);
  world.addBody(body);

  const obj = addProp({
    kind: "car",
    value: 200, radius: 8.0, mesh: g, body, chunkIndex: -1, tier: 6,
  });

  // Barrier arms — pivot at the pole, rotate 90deg to close across the road
  const barriers: BarrierArm[] = [];
  const gateMat1 = new THREE.MeshStandardMaterial({ color: 0xff3a3a, emissive: 0x661010, emissiveIntensity: 0.4, roughness: 0.6 });
  const gateMat2 = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });
  for (const sx of [-1, 1] as const) {
    const pivot = new THREE.Group();
    pivot.position.set(sx * (ROAD_HALF + 0.4), 2.7, zCenter);
    scene.add(pivot);
    // Build arm extending toward road center along -sx
    const armLen = ROAD_HALF + 0.6;
    const segLen = armLen / 5;
    for (let i = 0; i < 5; i++) {
      const seg = new THREE.Mesh(
        new THREE.BoxGeometry(segLen * 0.95, 0.10, 0.10),
        i % 2 === 0 ? gateMat1 : gateMat2,
      );
      // Local space: arm extends toward -sx, so segments at (-sx * (i+0.5)*segLen, 0, 0)
      seg.position.set(-sx * (i + 0.5) * segLen, 0, 0);
      pivot.add(seg);
    }
    // Kinematic body matching the closed arm shape
    const armBody = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, material: matGround });
    armBody.addShape(new CANNON.Box(new CANNON.Vec3(armLen / 2, 0.08, 0.08)));
    world.addBody(armBody);

    // Open = arm pointing up (rotated about Z so it stands vertical from the pole's base);
    // since pivot's local arm is along -sx (X axis), rotating about Z brings it to +Y (up).
    // closedRot = 0 means horizontal across road (closed). openRot = +sx * PI/2 raises it.
    barriers.push({ pivot, body: armBody, side: sx, openRot: sx * Math.PI / 2, closedRot: 0 });
  }

  trains.push({ mesh: g, body, t: Math.random() * 8, zCenter, lastHorn: 0, barriers });
  return obj;
}

function disposeChunk(ch: Chunk) {
  scene.remove(ch.group);
  ch.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose?.();
    const mat = (m.material as any);
    if (mat?.dispose) mat.dispose();
  });
  for (const b of ch.bodies) world.removeBody(b);
  for (const id of ch.propIds) {
    const p = props.find((x) => x.id === id);
    if (p && !p.stuck) removeProp(p);
  }
  // Remove trains in chunk
  for (let i = trains.length - 1; i >= 0; i--) {
    const t = trains[i];
    const idx = Math.floor(-t.zCenter / CHUNK_LEN);
    if (idx === ch.index) {
      for (const b of t.barriers) {
        scene.remove(b.pivot);
        if (b.body.world) world.removeBody(b.body);
      }
      trains.splice(i, 1);
    }
  }
}

function ballChunkIndex(): number {
  return Math.max(0, Math.floor(-ballBody.position.z / CHUNK_LEN));
}

function updateChunks() {
  const c = ballChunkIndex();
  for (let i = Math.max(0, c - VIEW_BEHIND); i <= c + VIEW_AHEAD; i++) {
    if (!chunks.has(i)) chunks.set(i, generateChunk(i));
  }
  for (const [i, ch] of chunks) {
    if (i < c - VIEW_BEHIND || i > c + VIEW_AHEAD + 1) {
      disposeChunk(ch);
      chunks.delete(i);
    }
  }
}

// ---------- Driving heading (declared early so resetGame can touch it) ----------
let heading = 0; // 0 = facing -Z

// ---------- Lives / game over ----------
const MAX_LIVES = 3;
let lives = MAX_LIVES;
let gameOver = false;
let lastHitAt = 0;

const livesEl = document.createElement("div");
livesEl.style.cssText = "position:fixed;top:14px;right:18px;padding:8px 14px;background:rgba(0,0,0,0.55);color:#ff8aa6;font:700 18px system-ui;border-radius:14px;letter-spacing:2px";
document.body.appendChild(livesEl);

const overEl = document.createElement("div");
overEl.style.cssText = "position:fixed;inset:0;display:none;align-items:center;justify-content:center;flex-direction:column;background:rgba(0,0,0,0.6);color:#fff;font:600 28px system-ui;z-index:10";
overEl.innerHTML = `<div style="font-size:46px;margin-bottom:14px">GAME OVER</div><div id="overScore" style="opacity:.85;margin-bottom:18px"></div><div style="opacity:.7;font-size:18px">Press R to restart</div>`;
document.body.appendChild(overEl);

function refreshLivesUI() {
  livesEl.textContent = "♥".repeat(lives) + "♡".repeat(MAX_LIVES - lives);
}
refreshLivesUI();

// Minimap
const miniCanvas = document.createElement("canvas");
miniCanvas.width = 200; miniCanvas.height = 200;
miniCanvas.style.cssText = "position:fixed;bottom:18px;right:18px;border:2px solid rgba(255,255,255,0.55);border-radius:12px;background:rgba(0,0,0,0.5);box-shadow:0 4px 18px rgba(0,0,0,0.35)";
document.body.appendChild(miniCanvas);
const miniCtx = miniCanvas.getContext("2d")!;

function drawMinimap() {
  if (!currentMap) return;
  const w = miniCanvas.width, h = miniCanvas.height;
  miniCtx.clearRect(0, 0, w, h);
  const cs = currentMap.cellSize;
  const W = currentMap.size[0] * cs, H = currentMap.size[1] * cs;
  const sx = w / W, sy = h / H;
  const toX = (x: number) => (x - mapBounds.minX) * sx;
  const toY = (z: number) => (z - mapBounds.minZ) * sy;

  // Tiles
  for (let r = 0; r < currentMap.size[1]; r++) {
    const row = currentMap.grid[r] || "";
    for (let c = 0; c < currentMap.size[0]; c++) {
      const ch = row[c] || "G";
      const color =
        ch === "R" || ch === "X" ? "#34384a" :
        ch === "S" ? "#cdd2da" :
        ch === "W" ? "#3a78bf" :
        "#3e7a35";
      miniCtx.fillStyle = color;
      miniCtx.fillRect(c * cs * sx, r * cs * sy, cs * sx + 0.5, cs * sy + 0.5);
    }
  }

  // Props
  for (const p of props) {
    if (p.stuck || p.falling) continue;
    const px = toX(p.mesh.position.x), py = toY(p.mesh.position.z);
    let color = "#aaa", radius = 1.5;
    const tier = holeTier();
    const dimmed = p.tier > tier;
    if (p.kind === "police") {
      const blink = Math.sin(performance.now() * 0.01 + p.id) > 0;
      color = blink ? "#ff3030" : "#3060ff";
      radius = 3.5;
    } else if (p.kind === "car") { color = "#7ad1ff"; radius = 2.5; }
    else if (p.kind === "civilian" || p.kind === "person") { color = "#ffffff"; radius = 1.5; }
    else if (p.kind === "tree" || p.kind === "breakable") { color = "#4dff8a"; radius = 1.8; }
    else if (p.kind.startsWith("building")) {
      // Draw building footprint as rect
      miniCtx.fillStyle = dimmed ? "rgba(170,170,170,0.55)" : "#dadada";
      const r = p.radius;
      miniCtx.fillRect(toX(p.mesh.position.x - r), toY(p.mesh.position.z - r), r * 2 * sx, r * 2 * sy);
      continue;
    } else { color = "#bdbdbd"; radius = 1; }
    if (dimmed) color = "rgba(255,255,255,0.35)";
    miniCtx.fillStyle = color;
    miniCtx.beginPath();
    miniCtx.arc(px, py, radius, 0, Math.PI * 2);
    miniCtx.fill();
  }

  // Hole
  const hx = toX(holePos.x), hy = toY(holePos.z);
  const hr = Math.max(3, holeRadius * sx);
  miniCtx.fillStyle = "#000";
  miniCtx.beginPath();
  miniCtx.arc(hx, hy, hr, 0, Math.PI * 2);
  miniCtx.fill();
  miniCtx.strokeStyle = "#ffd23a";
  miniCtx.lineWidth = 2;
  miniCtx.stroke();

  // Border label
  miniCtx.fillStyle = "rgba(255,255,255,0.85)";
  miniCtx.font = "600 11px system-ui";
  miniCtx.fillText(currentMap.name, 8, 14);
}

let flashColor = 0x000000;
let flashUntil = 0;
function vignetteFlash(color: number, durationSec: number) {
  flashColor = color;
  flashUntil = performance.now() + durationSec * 1000;
}

function loseLife(_reason: string) {
  if (gameOver) return;
  const now = performance.now();
  if (now - lastHitAt < 1300) return;
  lastHitAt = now;
  lives--;
  refreshLivesUI();
  vignetteFlash(0xff2a2a, 0.45);
  if (lives <= 0) {
    gameOver = true;
    const sc = Math.floor(score + (ballScale - 1) * 25);
    (document.getElementById("overScore") as HTMLDivElement).textContent = `Score: ${sc}`;
    overEl.style.display = "flex";
  }
}

// ---------- Initial world ----------
function resetGame() {
  // Remove existing chunks & props
  for (const [, ch] of chunks) disposeChunk(ch);
  chunks.clear();
  trains.length = 0;
  // Clear stuck items
  // (no stuck group in hole.io mode)
  // Remove leftover props (shouldn't be any, but safe)
  while (props.length) removeProp(props[0]);
  pendingStickIds.clear();

  score = 0;
  level = 1;
  map = 1;
  lampPostsEaten = 0;
  killCount = 0;
  itemsEatenThisLevel = 0;
  gameStartedAt = performance.now();
  holeRadius = baseHoleRadius;
  applyHoleScale();
  lives = MAX_LIVES;
  gameOver = false;
  heading = 0;
  overEl.style.display = "none";
  overEl.querySelector("div")!.textContent = "GAME OVER";
  refreshLivesUI();
  holePos.set(0, 0, 10);
  holeVel.set(0, 0, 0);
  loadMap(getMapForLevel(level));
}

resetGame();

// ---------- Input ----------
const keys = new Set<string>();
let cameraMode = 0;
const CAMERA_MODES = ["chase", "tilted", "topdown", "cinematic"] as const;
function onKeyDown(e: KeyboardEvent) {
  const k = e.key.toLowerCase();
  if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(k)) {
    e.preventDefault();
  }
  keys.add(k);
  if (k === "r") resetGame();
  if (k === "c") {
    cameraMode = (cameraMode + 1) % CAMERA_MODES.length;
    showCamHint();
  }
}
function onKeyUp(e: KeyboardEvent) {
  keys.delete(e.key.toLowerCase());
}
document.addEventListener("keydown", onKeyDown);
document.addEventListener("keyup", onKeyUp);
window.addEventListener("blur", () => keys.clear());
canvas.tabIndex = 0;
canvas.addEventListener("click", () => canvas.focus());

// ---------- Virtual joysticks (P1 left, P2 right) ----------
const touchInput = { x: 0, z: 0, active: false };
const touchInput2 = { x: 0, z: 0, active: false };

function wireJoystick(elId: string, knobId: string, target: { x: number; z: number; active: boolean }) {
  const joyEl = document.getElementById(elId);
  const joyKnob = document.getElementById(knobId);
  if (!joyEl || !joyKnob) return;
  let pid: number | null = null;
  let cx = 0, cy = 0;
  const radius = 50;
  const updateFromPoint = (px: number, py: number) => {
    let dx = px - cx; let dy = py - cy;
    const m = Math.hypot(dx, dy);
    if (m > radius) { dx = (dx / m) * radius; dy = (dy / m) * radius; }
    joyKnob.style.transform = `translate(${dx}px, ${dy}px)`;
    target.x = dx / radius; target.z = dy / radius;
    target.active = Math.hypot(target.x, target.z) > 0.12;
  };
  const reset = () => {
    pid = null;
    target.x = 0; target.z = 0; target.active = false;
    joyKnob.style.transform = "translate(0, 0)";
    joyKnob.classList.remove("active");
  };
  joyEl.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const rect = joyEl.getBoundingClientRect();
    cx = rect.left + rect.width / 2;
    cy = rect.top + rect.height / 2;
    pid = e.pointerId;
    joyEl.setPointerCapture(pid);
    joyKnob.classList.add("active");
    updateFromPoint(e.clientX, e.clientY);
    unlockAudio();
  });
  joyEl.addEventListener("pointermove", (e) => {
    if (pid !== e.pointerId) return;
    e.preventDefault();
    updateFromPoint(e.clientX, e.clientY);
  });
  const end = (e: PointerEvent) => {
    if (pid !== e.pointerId) return;
    e.preventDefault();
    try { joyEl.releasePointerCapture(pid); } catch {}
    reset();
  };
  joyEl.addEventListener("pointerup", end);
  joyEl.addEventListener("pointercancel", end);
  joyEl.addEventListener("pointerleave", end);
}
wireJoystick("joystick", "joyKnob", touchInput);
wireJoystick("joystick2", "joyKnob2", touchInput2);


// Camera mode hint UI
const camHint = document.createElement("div");
camHint.style.cssText = "position:fixed;top:14px;left:50%;transform:translateX(-50%);padding:6px 14px;background:rgba(0,0,0,0.55);color:#fff;font:600 14px system-ui;border-radius:14px;pointer-events:none;opacity:0;transition:opacity .25s";
document.body.appendChild(camHint);
let camHintTimer = 0;
function showCamHint() {
  camHint.textContent = `Camera: ${CAMERA_MODES[cameraMode]}`;
  camHint.style.opacity = "1";
  camHintTimer = performance.now() + 1400;
}
showCamHint();

// ---------- Level transitions ----------
let levelTransitioning = false;
let levelTransitionUntil = 0;

const levelToast = document.createElement("div");
levelToast.style.cssText = "position:fixed;left:50%;top:42%;transform:translate(-50%,-50%) scale(0.6);padding:18px 38px;background:rgba(0,0,0,0.7);color:#fff;font:700 32px system-ui;border-radius:18px;letter-spacing:2px;pointer-events:none;opacity:0;transition:opacity .25s ease-out, transform .35s cubic-bezier(.2,1.2,.3,1);box-shadow:0 8px 36px rgba(255,210,58,0.25)";
document.body.appendChild(levelToast);

const levelFlash = document.createElement("div");
levelFlash.style.cssText = "position:fixed;inset:0;pointer-events:none;background:radial-gradient(circle at center, rgba(255,210,58,0.55) 0%, rgba(255,210,58,0) 60%);opacity:0;transition:opacity .35s ease-out;z-index:5";
document.body.appendChild(levelFlash);

function showLevelToast(msg: string, ms = 1600) {
  levelToast.textContent = msg;
  levelToast.style.opacity = "1";
  levelToast.style.transform = "translate(-50%,-50%) scale(1)";
  levelFlash.style.opacity = "1";
  setTimeout(() => { levelFlash.style.opacity = "0"; }, 220);
  levelTransitionUntil = performance.now() + ms;
  levelTransitioning = true;
}

function maybeAdvanceLevel() {
  while (itemsEatenThisLevel >= itemsForLevel(level)) {
    itemsEatenThisLevel = 0;
    level++;
    holeRadius = baseHoleRadius * (1 + (level - 1) * 0.32);
    applyHoleScale();
    if (level % LEVELS_PER_MAP === 1 && level > 1) {
      // Map cleared — load next map immediately
      const justCleared = map;
      map = Math.min(MAX_MAPS, map + 1);
      showLevelToast(`MAP ${justCleared} CLEARED!  →  MAP ${map}`, 2400);
      triggerShake(0.6);
      emitConfetti(holePos.x, holePos.z, 90);
      loadMap(getMapForLevel(level));
      triggerShake(0.4);
    } else {
      showLevelToast(`LEVEL ${level}`);
      emitConfetti(holePos.x, holePos.z, 36);
      triggerShake(0.25);
    }
    if (level > MAX_MAPS * LEVELS_PER_MAP) {
      level = MAX_MAPS * LEVELS_PER_MAP;
      gameOver = true;
      (document.getElementById("overScore") as HTMLDivElement).textContent = `You cleared all ${MAX_MAPS} maps! Score: ${score}`;
      overEl.querySelector("div")!.textContent = "YOU WIN";
      overEl.style.display = "flex";
      return;
    }
  }
}

// ---------- Swallow ----------
let lastPickupAt = 0;

function startFalling(p: StickyObject) {
  if (p.stuck || p.falling) return;
  const isBuilding = p.kind === "building_S" || p.kind === "building_M" || p.kind === "building_L";
  p.falling = { startY: p.mesh.position.y, t: 0, dur: isBuilding ? 1.1 : 0.45 };
  if (p.body.world) world.removeBody(p.body);
  bodyIdToProp.delete(p.body.id);
  score += p.value;
  itemsEatenThisLevel++;
  if (p.kind === "lamppost") lampPostsEaten++;
  if (p.kind === "civilian" || p.kind === "person" || p.kind === "car" || p.kind === "police") killCount++;
  // Visible growth — bigger things give bigger size jumps
  // Much slower, more deliberate growth — keeps the camera framing pleasant
  const growBoost = isBuilding
    ? 0.10 + p.tier * 0.05
    : 0.008 + p.tier * 0.012 + Math.min(0.10, p.radius * 0.02);
  holeRadius = clamp(holeRadius + growBoost, baseHoleRadius, baseHoleRadius * 16);
  applyHoleScale();
  if (isBuilding) {
    playBreakSound();
    triggerShake(0.35 + p.tier * 0.12);
  } else if (p.kind === "civilian" || p.kind === "person") {
    playYelp();
  } else if (p.kind === "car" || p.kind === "police") {
    playHonk(); // beep on swallow
    setTimeout(() => playHonk(), 90); // double-beep
    playPickupSound(0.8);
  } else {
    playPickupSound(lerp(0.4, 1.4, clamp(p.tier / 5, 0, 1)));
    if (p.tier >= 4) triggerShake(0.18);
  }
  lastPickupAt = performance.now();
  maybeAdvanceLevel();
}

function tryStick(_p: StickyObject) { /* unused in hole.io mode */ }
void tryStick;
void playBreakSound;
void pendingStickIds;

// ---------- Camera ----------
const camTarget = new THREE.Vector3();
const camPos = new THREE.Vector3();
const camTargetSmoothed = new THREE.Vector3(0, 0, 0);

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

function updateCamera(dt: number) {
  const mode = CAMERA_MODES[cameraMode];
  const growth = clamp((holeRadius - baseHoleRadius) / 8, 0, 1);

  if (mode === "chase") {
    // Two-player chase: follow midpoint, pull back based on player separation
    const midX = (holePos.x + holePos2.x) * 0.5;
    const midZ = (holePos.z + holePos2.z) * 0.5;
    const sep = Math.hypot(holePos.x - holePos2.x, holePos.z - holePos2.z);
    const sepBoost = clamp(sep / 30, 0, 1);
    const dirX = Math.sin(heading);
    const dirZ = -Math.cos(heading);
    const dist = lerp(22, 38, growth) + sepBoost * 18;
    const height = lerp(18, 30, growth) + sepBoost * 14;
    const camX = midX - dirX * dist;
    const camZ = midZ - dirZ * dist;
    camTarget.set(midX + dirX * 4, holeRadius * 0.5, midZ + dirZ * 4);
    camPos.set(camX, holeRadius + height, camZ);
  } else if (mode === "topdown") {
    const height = lerp(28, 60, growth);
    camTarget.set(holePos.x, 0, holePos.z);
    camPos.set(holePos.x, height, holePos.z + 0.0001);
  } else if (mode === "tilted") {
    const height = lerp(24, 46, growth);
    const back = lerp(14, 24, growth);
    camTarget.set(holePos.x, 0, holePos.z - 2);
    camPos.set(holePos.x, height, holePos.z + back);
  } else {
    // wide cinematic
    const tNow = performance.now() * 0.0003;
    const radius = lerp(20, 36, growth);
    const height = lerp(20, 34, growth);
    camTarget.set(holePos.x, 0, holePos.z);
    camPos.set(
      holePos.x + Math.cos(tNow) * radius,
      height,
      holePos.z + Math.sin(tNow) * radius,
    );
  }

  camTargetSmoothed.lerp(camTarget, 1 - Math.pow(0.0001, dt));
  camera.position.lerp(camPos, 1 - Math.pow(0.001, dt));

  if (camShake > 0.001) {
    const k = camShake * 1.4;
    camera.position.x += (Math.random() - 0.5) * k;
    camera.position.y += (Math.random() - 0.5) * k * 0.6;
    camera.position.z += (Math.random() - 0.5) * k;
  }

  camera.lookAt(camTargetSmoothed);
}

// ---------- Controls (rolling ball, car-like steering) ----------
function updateControls(dt: number) {
  if (gameOver || levelTransitioning) return;
  // P1: WASD only (arrows reserved for P2)
  const forward = keys.has("w");
  const back = keys.has("s");
  const left = keys.has("a");
  const right = keys.has("d");

  let fwdInput = (forward ? 1 : 0) - (back ? 1 : 0) * 0.7;
  let steerInput = (right ? 1 : 0) - (left ? 1 : 0);

  const speedNow = Math.hypot(holeVel.x, holeVel.z);
  const growth = clamp((holeRadius - baseHoleRadius) / 6, 0, 1);
  const steerRate = lerp(2.6, 1.6, growth);
  const steerScale = clamp(speedNow / 4, 0.3, 1.0);

  // Joystick overrides keyboard when active — absolute direction control
  let joyOverride = false;
  if (touchInput.active) {
    joyOverride = true;
    // Joystick vector in screen-space: x = right, z (down) = forward
    // World forward is -Z, so map joy.z (downward drag) → backward, upward drag → forward
    const jx = touchInput.x;
    const jz = touchInput.z;
    const mag = Math.min(1, Math.hypot(jx, jz));
    // Desired heading: angle so that (sin(h), -cos(h)) points toward (jx, -jz)
    const targetHeading = Math.atan2(jx, jz);
    // Smoothly rotate toward target heading (shortest arc)
    let dh = targetHeading - heading;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    heading += dh * Math.min(1, dt * 10);
    fwdInput = mag;
    steerInput = 0;
  }

  if (!joyOverride) {
    heading += steerInput * steerRate * steerScale * dt;
  }

  const fwdX = Math.sin(heading);
  const fwdZ = -Math.cos(heading);

  const maxSpeed = lerp(14, 18, growth);
  const targetVX = fwdX * fwdInput * maxSpeed;
  const targetVZ = fwdZ * fwdInput * maxSpeed;
  const k = 1 - Math.pow(0.0009, dt);
  holeVel.x = lerp(holeVel.x, targetVX, k);
  holeVel.z = lerp(holeVel.z, targetVZ, k);

  // Kill lateral drift
  const along = holeVel.x * fwdX + holeVel.z * fwdZ;
  const perpX = holeVel.x - along * fwdX;
  const perpZ = holeVel.z - along * fwdZ;
  const lateralKill = 1 - Math.pow(0.001, dt);
  holeVel.x -= perpX * lateralKill;
  holeVel.z -= perpZ * lateralKill;

  if (fwdInput === 0) {
    const decay = 1 - Math.pow(0.6, dt);
    holeVel.x -= holeVel.x * decay;
    holeVel.z -= holeVel.z * decay;
  }

  holePos.x += holeVel.x * dt;
  holePos.z += holeVel.z * dt;
  holePos.y = 0;

  // Clamp inside map bounds, with a small inset so the hole rim stays on the map
  const inset = holeRadius;
  if (holePos.x < mapBounds.minX + inset) { holePos.x = mapBounds.minX + inset; holeVel.x = 0; }
  if (holePos.x > mapBounds.maxX - inset) { holePos.x = mapBounds.maxX - inset; holeVel.x = 0; }
  if (holePos.z < mapBounds.minZ + inset) { holePos.z = mapBounds.minZ + inset; holeVel.z = 0; }
  if (holePos.z > mapBounds.maxZ - inset) { holePos.z = mapBounds.maxZ - inset; holeVel.z = 0; }
}

// ---------- P2 controls ----------
function updateControlsP2(dt: number) {
  if (gameOver || levelTransitioning) return;
  const forward = keys.has("arrowup");
  const back = keys.has("arrowdown");
  const left = keys.has("arrowleft");
  const right = keys.has("arrowright");

  let fwdInput = (forward ? 1 : 0) - (back ? 1 : 0) * 0.7;
  let steerInput = (right ? 1 : 0) - (left ? 1 : 0);

  const speedNow = Math.hypot(holeVel2.x, holeVel2.z);
  const growth = clamp((holeRadius2 - baseHoleRadius) / 6, 0, 1);
  const steerRate = lerp(2.6, 1.6, growth);
  const steerScale = clamp(speedNow / 4, 0.3, 1.0);

  let joyOverride = false;
  if (touchInput2.active) {
    joyOverride = true;
    const jx = touchInput2.x;
    const jz = touchInput2.z;
    const mag = Math.min(1, Math.hypot(jx, jz));
    const targetHeading = Math.atan2(jx, jz);
    let dh = targetHeading - heading2;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    heading2 += dh * Math.min(1, dt * 10);
    fwdInput = mag;
    steerInput = 0;
  }

  if (!joyOverride) {
    heading2 += steerInput * steerRate * steerScale * dt;
  }

  const fwdX = Math.sin(heading2);
  const fwdZ = -Math.cos(heading2);

  const maxSpeed = lerp(14, 18, growth);
  const targetVX = fwdX * fwdInput * maxSpeed;
  const targetVZ = fwdZ * fwdInput * maxSpeed;
  const k = 1 - Math.pow(0.0009, dt);
  holeVel2.x = lerp(holeVel2.x, targetVX, k);
  holeVel2.z = lerp(holeVel2.z, targetVZ, k);

  const along = holeVel2.x * fwdX + holeVel2.z * fwdZ;
  const perpX = holeVel2.x - along * fwdX;
  const perpZ = holeVel2.z - along * fwdZ;
  const lateralKill = 1 - Math.pow(0.001, dt);
  holeVel2.x -= perpX * lateralKill;
  holeVel2.z -= perpZ * lateralKill;

  if (fwdInput === 0) {
    const decay = 1 - Math.pow(0.6, dt);
    holeVel2.x -= holeVel2.x * decay;
    holeVel2.z -= holeVel2.z * decay;
  }

  holePos2.x += holeVel2.x * dt;
  holePos2.z += holeVel2.z * dt;

  const inset = holeRadius2;
  if (holePos2.x < mapBounds.minX + inset) { holePos2.x = mapBounds.minX + inset; holeVel2.x = 0; }
  if (holePos2.x > mapBounds.maxX - inset) { holePos2.x = mapBounds.maxX - inset; holeVel2.x = 0; }
  if (holePos2.z < mapBounds.minZ + inset) { holePos2.z = mapBounds.minZ + inset; holeVel2.z = 0; }
  if (holePos2.z > mapBounds.maxZ - inset) { holePos2.z = mapBounds.maxZ - inset; holeVel2.z = 0; }
}

// ---------- NPC update ----------
const tmpV = new CANNON.Vec3();
function updateNPCs(dt: number) {
  for (const p of props) {
    if (p.stuck || p.falling || !p.npc) continue;
    if (p.npc.type === "civilian") {
      const c = p.npc;
      let z = p.body.position.z + c.dir * c.speed * dt;
      c.phase += dt * 6;
      const bob = Math.sin(c.phase) * 0.04;
      if (Math.random() < 0.002) c.dir = (c.dir === 1 ? -1 : 1) as 1 | -1;
      // Bounce off map bounds
      if (currentMap) {
        if (z < mapBounds.minZ + 1) { z = mapBounds.minZ + 1; c.dir = 1; }
        if (z > mapBounds.maxZ - 1) { z = mapBounds.maxZ - 1; c.dir = -1; }
      }
      tmpV.set(c.sideX, CURB_H + 0.3 + bob, z);
      p.body.position.copy(tmpV);
      p.mesh.position.set(tmpV.x, tmpV.y, tmpV.z);
      p.mesh.rotation.y = c.dir > 0 ? 0 : Math.PI;
    } else if (p.npc.type === "car") {
      const c = p.npc;
      const axis = c.axis ?? "z";
      // Establish home lane on first run (before any overtaking offset)
      if ((c as any).homeL === undefined) (c as any).homeL = c.lane;
      if ((c as any).overtake === undefined) (c as any).overtake = 0;
      const homeL = (c as any).homeL as number;

      // ---- Speed scaling for red lights (in map mode w/ traffic system) ----
      let speedScale = 1;
      if (traffic) {
        const lightState = axis === "z" ? nsLightState() : ewLightState();
        if (lightState !== "g") {
          const myAxisPos = axis === "z" ? p.body.position.z : p.body.position.x;
          const center = axis === "z" ? traffic.cz : traffic.cx;
          const stopLine = center - Math.sign(c.speed) * traffic.stopDist;
          const distToStop = (stopLine - myAxisPos) * Math.sign(c.speed);
          // Approaching stop line (positive distToStop) and not yet past it
          if (distToStop > -0.4 && distToStop < 12) {
            // Ease in over 8m, hard stop at the line
            speedScale = clamp(distToStop / 8, 0, 1);
            if (distToStop < 0.2) speedScale = 0;
          }
        }
      }

      // ---- Overtake: look ahead in same axis & direction for slower car in our lane ----
      const lookAhead = 7.0;
      const sameLaneTol = 1.2;
      let blocked = false;
      for (const o of props) {
        if (o === p) continue;
        if (!o.npc || o.npc.type !== "car") continue;
        const oc = o.npc;
        const oAxis = oc.axis ?? "z";
        if (oAxis !== axis) continue;
        if (Math.sign(oc.speed) !== Math.sign(c.speed)) continue;
        if (Math.abs(oc.speed) >= Math.abs(c.speed) - 0.2) continue; // not slower
        // Forward distance along axis
        const myA = axis === "z" ? p.body.position.z : p.body.position.x;
        const oA = axis === "z" ? o.body.position.z : o.body.position.x;
        const fwd = (oA - myA) * Math.sign(c.speed);
        if (fwd < 0.5 || fwd > lookAhead) continue;
        // Perp distance
        const myP = axis === "z" ? p.body.position.x : p.body.position.z;
        const oP = axis === "z" ? o.body.position.x : o.body.position.z;
        if (Math.abs(myP - oP) < sameLaneTol) { blocked = true; break; }
      }
      // Overtake offset: shift further from centerline (away from oncoming traffic)
      const sideSign = Math.sign(homeL) || 1;
      const target = blocked ? sideSign * 1.0 : 0;
      (c as any).overtake = lerp((c as any).overtake, target, 1 - Math.pow(0.04, dt));
      const effectiveLane = homeL + (c as any).overtake;
      // Clamp lane to road bounds (map mode: half cell width; chunk mode: ROAD_HALF)
      const halfRoad = currentMap ? (currentMap.cellSize * 0.5 - 0.5) : (ROAD_HALF - 0.5);
      // Only clamp if home lane was within road; otherwise leave it (roadside parking, etc.)
      let lane = effectiveLane;
      if (Math.abs(homeL) < halfRoad + 0.1) {
        lane = clamp(effectiveLane, -halfRoad, halfRoad);
      }
      c.lane = lane;

      // ---- Move along axis ----
      const stepDelta = c.speed * dt * speedScale;
      if (axis === "z") {
        let z = p.body.position.z + stepDelta;
        if (currentMap) {
          // No more wraparound feeding: when a car reaches the map edge, it stops
          // (player has to seek out cars instead of waiting for them to come back).
          if (z < mapBounds.minZ + 1) { z = mapBounds.minZ + 1; c.speed = 0; }
          if (z > mapBounds.maxZ - 1) { z = mapBounds.maxZ - 1; c.speed = 0; }
          // Don't roll past the stop line if red
          if (traffic && nsLightState() !== "g") {
            const stop = traffic.cz - Math.sign(c.speed) * traffic.stopDist;
            if (Math.sign(c.speed) > 0 && z > stop && p.body.position.z <= stop) z = stop;
            if (Math.sign(c.speed) < 0 && z < stop && p.body.position.z >= stop) z = stop;
          }
        } else if (Math.abs(z - holePos.z) > CHUNK_LEN * (VIEW_AHEAD + 1)) {
          z = holePos.z - Math.sign(c.speed) * CHUNK_LEN * VIEW_AHEAD;
        }
        tmpV.set(lane, 0.5, z);
      } else {
        let x = p.body.position.x + stepDelta;
        if (currentMap) {
          if (x < mapBounds.minX + 1) { x = mapBounds.minX + 1; c.speed = 0; }
          if (x > mapBounds.maxX - 1) { x = mapBounds.maxX - 1; c.speed = 0; }
          if (traffic && ewLightState() !== "g") {
            const stop = traffic.cx - Math.sign(c.speed) * traffic.stopDist;
            if (Math.sign(c.speed) > 0 && x > stop && p.body.position.x <= stop) x = stop;
            if (Math.sign(c.speed) < 0 && x < stop && p.body.position.x >= stop) x = stop;
          }
        }
        tmpV.set(x, 0.5, lane);
      }
      p.body.position.copy(tmpV);
      p.mesh.position.set(tmpV.x, 0, tmpV.z);
    }
  }

  // Trains: travel +X across crossing periodically; barriers close before & during
  for (const t of trains) {
    t.t += dt;
    const period = 18;
    const phase = t.t % period;

    // Barrier closeness: 0 = open, 1 = fully closed
    // close from phase 0..2, stay closed 2..11, open 11..13
    let close = 0;
    if (phase < 2) close = phase / 2;
    else if (phase < 11) close = 1;
    else if (phase < 13) close = 1 - (phase - 11) / 2;
    else close = 0;

    for (const b of t.barriers) {
      const rot = lerp(b.openRot, b.closedRot, close);
      b.pivot.rotation.z = rot;
      // Update body to match world position of arm midpoint
      const armLen = ROAD_HALF + 0.6;
      const midLocalX = -b.side * armLen / 2;
      // Compute world transform of pivot + offset
      const cs = Math.cos(rot), sn = Math.sin(rot);
      const wx = b.pivot.position.x + cs * midLocalX;
      const wy = b.pivot.position.y + sn * midLocalX;
      b.body.position.set(wx, wy, b.pivot.position.z);
      b.body.quaternion.setFromEuler(0, 0, rot);
    }

    // Train sweep window: only while barriers fully closed
    let x = -120;
    if (phase >= 3 && phase <= 10) {
      x = lerp(-70, 70, (phase - 3) / 7);
      if (phase < 3.4 && performance.now() - t.lastHorn > 5000) {
        playTrainHorn();
        t.lastHorn = performance.now();
      }
    } else {
      x = -120;
    }
    t.body.position.set(x, 1.0, t.zCenter);
    t.mesh.position.set(x, 0, t.zCenter);
  }
}

// ---------- Police contact + camera shake ----------
let camShake = 0;

function triggerShake(amount: number) {
  camShake = Math.min(1.4, camShake + amount);
}

function checkPoliceContact(_dt: number) {
  // Police are no longer hostile — just patrol. Nothing to do here.
}

function swallowScan() {
  const tier = holeTier();
  for (const p of props) {
    if (p.stuck || p.falling) continue;
    if (p.tier > tier) continue;
    const dx = p.mesh.position.x - holePos.x;
    const dz = p.mesh.position.z - holePos.z;
    const d = Math.hypot(dx, dz);
    const isBuilding = p.kind === "building_S" || p.kind === "building_M" || p.kind === "building_L";
    if (isBuilding) {
      // Ball must be at least as wide as the building footprint
      if (holeRadius < p.radius * 0.9) continue;
      if (d <= holeRadius + p.radius * 0.5) startFalling(p);
    } else {
      // Generous tolerance for moving NPCs so they can't escape the gobble
      const moving = p.kind === "car" || p.kind === "police" || p.kind === "civilian" || p.kind === "person";
      const reach = holeRadius + p.radius + (moving ? 0.6 : 0.15);
      if (d <= reach) startFalling(p);
    }
  }
}

function advanceFalling(dt: number) {
  for (let i = props.length - 1; i >= 0; i--) {
    const p = props[i];
    if (!p.falling) continue;
    p.falling.t += dt;
    const u = clamp(p.falling.t / p.falling.dur, 0, 1);
    // Hole.io: pull horizontally toward hole center and drop straight down through the ground.
    const k = 1 - Math.pow(0.00015, dt);
    p.mesh.position.x = lerp(p.mesh.position.x, holePos.x, k);
    p.mesh.position.z = lerp(p.mesh.position.z, holePos.z, k);
    // Accelerating fall — small at first, much deeper by end
    p.mesh.position.y = p.falling.startY - u * u * 14;
    p.mesh.rotation.x += dt * 4 * (1 + u);
    p.mesh.rotation.z += dt * 3 * (1 + u);
    if (u >= 1) {
      if (p.mesh.parent) p.mesh.parent.remove(p.mesh);
      props.splice(i, 1);
    }
  }
}

function syncMeshes() {
  // Hole.io: flat disk on the ground. Sit just above the tiles to avoid z-fighting.
  holeGroup.position.set(holePos.x, 0.04, holePos.z);
  holeGroup.rotation.y = 0;
  ballShadow.position.set(holePos.x, 0.025, holePos.z);
  ballShadow.scale.setScalar(holeRadius * 1.4);
  // P2 hole
  holeGroup2.position.set(holePos2.x, 0.04, holePos2.z);
  holeGroup2.scale.set(holeRadius2, holeRadius2, holeRadius2);
  for (const p of props) {
    if (p.stuck || p.falling) continue;
    if (p.npc || p.body.type === CANNON.Body.KINEMATIC) continue;
    p.mesh.position.set(p.body.position.x, p.body.position.y, p.body.position.z);
    p.mesh.quaternion.set(p.body.quaternion.x, p.body.quaternion.y, p.body.quaternion.z, p.body.quaternion.w);
  }
}

// ---------- LOCAL 2-PLAYER (P2 hole) ----------
const holePos2 = new THREE.Vector3(0, 0, 0);
const holeVel2 = new THREE.Vector3();
let holeRadius2 = baseHoleRadius;
let heading2 = 0;

const holeGroup2 = new THREE.Group();
const p2Disk = new THREE.Mesh(
  new THREE.CircleGeometry(1, 48),
  new THREE.MeshBasicMaterial({ color: 0x2a0a0a }),
);
p2Disk.rotation.x = -Math.PI / 2;
p2Disk.renderOrder = 2;
holeGroup2.add(p2Disk);
const p2Rim = new THREE.Mesh(
  new THREE.RingGeometry(0.97, 1.18, 48),
  new THREE.MeshBasicMaterial({ color: 0xff8a3d, transparent: true, opacity: 0.95, side: THREE.DoubleSide }),
);
p2Rim.rotation.x = -Math.PI / 2;
p2Rim.renderOrder = 2;
holeGroup2.add(p2Rim);
const p2Glow = new THREE.Mesh(
  new THREE.RingGeometry(1.18, 1.45, 48),
  new THREE.MeshBasicMaterial({ color: 0xffb37a, transparent: true, opacity: 0.35, side: THREE.DoubleSide }),
);
p2Glow.rotation.x = -Math.PI / 2;
p2Glow.renderOrder = 2;
holeGroup2.add(p2Glow);
holeGroup2.position.y = 0.04;
scene.add(holeGroup2);

function applyHole2Scale() { holeGroup2.scale.set(holeRadius2, holeRadius2, holeRadius2); }
applyHole2Scale();

// P2 swallows props in a parallel pass — same rules but using holeRadius2.
function swallowScanP2() {
  const tier = clamp(Math.floor(holeRadius2 / 0.6), 1, 7);
  for (const p of props) {
    if (p.stuck || p.falling) continue;
    if (p.tier > tier) continue;
    const dx = p.mesh.position.x - holePos2.x;
    const dz = p.mesh.position.z - holePos2.z;
    const d = Math.hypot(dx, dz);
    const isBuilding = p.kind === "building_S" || p.kind === "building_M" || p.kind === "building_L";
    if (isBuilding) {
      if (holeRadius2 < p.radius * 0.9) continue;
      if (d <= holeRadius2 + p.radius * 0.5) startFallingP2(p);
    } else {
      const moving = p.kind === "car" || p.kind === "police" || p.kind === "civilian" || p.kind === "person";
      const reach = holeRadius2 + p.radius + (moving ? 0.6 : 0.15);
      if (d <= reach) startFallingP2(p);
    }
  }
}
function startFallingP2(p: StickyObject) {
  if (p.stuck || p.falling) return;
  const isBuilding = p.kind === "building_S" || p.kind === "building_M" || p.kind === "building_L";
  p.falling = { startY: p.mesh.position.y, t: 0, dur: isBuilding ? 1.1 : 0.45 };
  if (p.body.world) world.removeBody(p.body);
  bodyIdToProp.delete(p.body.id);
  const growBoost = isBuilding
    ? 0.10 + p.tier * 0.05
    : 0.008 + p.tier * 0.012 + Math.min(0.10, p.radius * 0.02);
  holeRadius2 = clamp(holeRadius2 + growBoost, baseHoleRadius, baseHoleRadius * 16);
  applyHole2Scale();
}

// Eat-each-other: bigger hole eats smaller if 15% bigger and overlapping.
function checkPvP() {
  const dx = holePos.x - holePos2.x;
  const dz = holePos.z - holePos2.z;
  const d = Math.hypot(dx, dz);
  if (holeRadius > holeRadius2 * 1.15 && d <= holeRadius + holeRadius2 * 0.5) {
    holeRadius2 = baseHoleRadius;
    applyHole2Scale();
    triggerShake(0.5);
    showLevelToast("P1 ate P2!", 1200);
    // Respawn P2 a few units away
    holePos2.x = holePos.x + 8 * (Math.random() < 0.5 ? -1 : 1);
    holePos2.z = holePos.z + 8 * (Math.random() < 0.5 ? -1 : 1);
  } else if (holeRadius2 > holeRadius * 1.15 && d <= holeRadius2 + holeRadius * 0.5) {
    holeRadius = baseHoleRadius;
    itemsEatenThisLevel = 0;
    applyHoleScale();
    triggerShake(0.5);
    showLevelToast("P2 ate P1!", 1200);
    holePos.x = holePos2.x + 8 * (Math.random() < 0.5 ? -1 : 1);
    holePos.z = holePos2.z + 8 * (Math.random() < 0.5 ? -1 : 1);
  }
}

// ---------- Multiplayer (legacy, unused) ----------
type RemoteHole = {
  id: number;
  name: string;
  x: number;
  z: number;
  r: number;
  group: THREE.Group;
  rim: THREE.Mesh;
  disk: THREE.Mesh;
  label: HTMLDivElement;
  lastSeenAt: number;
};
const remotes = new Map<number, RemoteHole>();
const remoteColors = [0xff5252, 0x66ff7a, 0xffd23a, 0xff58d4, 0x9d6bff, 0xff9a3d, 0x4dffe3];

function makeRemoteHole(id: number): RemoteHole {
  const color = remoteColors[id % remoteColors.length];
  const group = new THREE.Group();
  const disk = new THREE.Mesh(
    new THREE.CircleGeometry(1, 48),
    new THREE.MeshBasicMaterial({ color: 0x0a1a3a }),
  );
  disk.rotation.x = -Math.PI / 2;
  disk.renderOrder = 2;
  group.add(disk);
  const rim = new THREE.Mesh(
    new THREE.RingGeometry(0.97, 1.18, 48),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, side: THREE.DoubleSide }),
  );
  rim.rotation.x = -Math.PI / 2;
  rim.renderOrder = 2;
  group.add(rim);
  group.position.y = 0.04;
  scene.add(group);

  const label = document.createElement("div");
  label.className = "remote-label";
  label.style.cssText = "position:absolute;left:0;top:0;transform:translate(-50%,-100%);color:#fff;font:700 12px ui-sans-serif;text-shadow:0 2px 0 rgba(0,0,0,0.6);pointer-events:none;white-space:nowrap;z-index:9";
  document.body.appendChild(label);

  return { id, name: `player${id}`, x: 0, z: 0, r: 1, group, disk, rim, label, lastSeenAt: performance.now() };
}

MP.onRemoteUpdate((id, x, z, r, name) => {
  let rh = remotes.get(id);
  if (!rh) { rh = makeRemoteHole(id); remotes.set(id, rh); }
  rh.x = x; rh.z = z; rh.r = r; rh.name = name; rh.lastSeenAt = performance.now();
});
MP.onRemoteLeave((id) => {
  const rh = remotes.get(id);
  if (!rh) return;
  scene.remove(rh.group);
  rh.label.remove();
  remotes.delete(id);
});
MP.onMapSeed((seed) => {
  // The procedural generator already takes a seed argument. We can't easily
  // override the per-map seed here without bigger surgery, so for v1 we just
  // log it. Players will see slightly different cities — but their hole
  // positions and eat events still sync.
  console.log("[mp] server map seed:", seed);
});
MP.onEaten((victim, _eater) => {
  if (victim === MP.getMyId()) {
    // We got eaten — reset our hole.
    holeRadius = baseHoleRadius;
    applyHoleScale();
    triggerShake(0.6);
    showLevelToast("You were eaten!", 1500);
  }
});

function updateRemotes() {
  const now = performance.now();
  for (const [id, rh] of remotes) {
    // Smoothly approach the latest received position.
    rh.group.position.x += (rh.x - rh.group.position.x) * 0.25;
    rh.group.position.z += (rh.z - rh.group.position.z) * 0.25;
    rh.group.scale.set(rh.r, rh.r, rh.r);

    // Project to screen for label
    const wp = new THREE.Vector3(rh.group.position.x, 0.04, rh.group.position.z);
    const proj = wp.clone().project(camera);
    if (proj.z < 1) {
      const sx = (proj.x * 0.5 + 0.5) * window.innerWidth;
      const sy = (-proj.y * 0.5 + 0.5) * window.innerHeight;
      rh.label.style.transform = `translate(${sx}px, ${sy - 50 - rh.r * 4}px) translate(-50%, -100%)`;
      rh.label.textContent = `${rh.name} • ${rh.r.toFixed(1)}`;
      rh.label.style.display = "block";
    } else {
      rh.label.style.display = "none";
    }

    // Cull stale remotes (lost connection without leave message)
    if (now - rh.lastSeenAt > 8000) {
      scene.remove(rh.group);
      rh.label.remove();
      remotes.delete(id);
    }

    // Eat detection — if I'm meaningfully bigger and overlapping, claim the eat.
    const dx = rh.group.position.x - holePos.x;
    const dz = rh.group.position.z - holePos.z;
    const d = Math.hypot(dx, dz);
    if (holeRadius > rh.r * 1.15 && d <= holeRadius + rh.r * 0.5) {
      MP.claimEat(id);
    }
  }
}

// ---------- Start screen gating ----------
let gameStarted = false;
const startScreen = document.getElementById("startScreen");
const playBtn = document.getElementById("playBtn");
let selectedMap = 1;
document.querySelectorAll<HTMLButtonElement>(".map-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".map-btn").forEach((b) => b.classList.remove("selected"));
    btn.classList.add("selected");
    selectedMap = parseInt(btn.dataset.map || "1", 10);
  });
});
const hudEl = document.getElementById("hud");
if (hudEl) hudEl.classList.add("hidden");
function startGame() {
  if (gameStarted) return;
  gameStarted = true;
  gameStartedAt = performance.now();
  // Start in the chosen map: level = (mapIdx-1)*LEVELS_PER_MAP + 1
  if (selectedMap > 1) {
    level = (selectedMap - 1) * LEVELS_PER_MAP + 1;
    map = selectedMap;
    holeRadius = baseHoleRadius * (1 + (level - 1) * 0.32);
    applyHoleScale();
    loadMap(getMapForLevel(level));
  }
  unlockAudio();
  startScreen?.classList.add("hide");
  hudEl?.classList.remove("hidden");
  canvas.focus();
  // Drop hidden screen from layout after the fade so it can't intercept
  setTimeout(() => { if (startScreen) startScreen.style.display = "none"; }, 600);
}
playBtn?.addEventListener("click", startGame);
window.addEventListener("keydown", (e) => {
  if (!gameStarted && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    startGame();
  }
});

// ---------- Loop ----------
let lastT = performance.now();
const fixedDt = 1 / 60;
let acc = 0;

function tick() {
  const t = performance.now();
  const dt = Math.min(0.045, (t - lastT) / 1000);
  lastT = t;
  acc += dt;

  if (!gameStarted) {
    // Idle title-screen orbit around the spawn point
    const tNow = performance.now() * 0.00018;
    const r = 28;
    camera.position.set(
      holePos.x + Math.cos(tNow) * r,
      18 + Math.sin(tNow * 0.7) * 1.5,
      holePos.z + Math.sin(tNow) * r,
    );
    camera.lookAt(holePos.x, 1, holePos.z);
    sun.position.set(holePos.x + 40, 60, holePos.z + 28);
    sun.target.position.set(holePos.x, 0, holePos.z);
    sun.target.updateMatrixWorld();
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
    return;
  }

  updateTrafficLights(dt);
  updateNPCs(dt);
  updateParticles(dt);
  maybeHonk();
  maybeApproachScream();

  // Police siren intensity: closest chasing police that we can't yet swallow
  {
    const tier = holeTier();
    let closest = Infinity;
    let chasing = false;
    for (const p of props) {
      if (p.kind !== "police" || p.stuck || p.falling) continue;
      const dx = p.mesh.position.x - holePos.x;
      const dz = p.mesh.position.z - holePos.z;
      const d = Math.hypot(dx, dz);
      if (d < closest) closest = d;
      if (tier < p.tier) chasing = true;
    }
    void chasing; void closest;
    setSirenVolume(0);
  }

  while (acc >= fixedDt) {
    updateControls(fixedDt);
    updateControlsP2(fixedDt);
    swallowScan();
    swallowScanP2();
    checkPvP();
    checkPoliceContact(fixedDt);
    advanceFalling(fixedDt);
    acc -= fixedDt;
  }
  // decay shake
  camShake *= Math.pow(0.18, dt);
  // hide level toast after duration
  if (levelTransitioning && performance.now() > levelTransitionUntil) {
    levelToast.style.opacity = "0";
    levelToast.style.transform = "translate(-50%,-50%) scale(0.6)";
    levelTransitioning = false;
  }

  if (!currentMap) updateChunks();

  sun.position.set(ballMesh.position.x + 40, 60, ballMesh.position.z + 28);
  sun.target.position.set(ballMesh.position.x, 0, ballMesh.position.z);
  sun.target.updateMatrixWorld();

  const itemsNeeded = itemsForLevel(level);
  const xpFrac = clamp(itemsEatenThisLevel / Math.max(1, itemsNeeded), 0, 1);

  if (elXpFill) elXpFill.style.width = `${xpFrac * 100}%`;

  if (elTimerText) {
    const remain = gameStarted ? Math.max(0, MATCH_DURATION_MS - (performance.now() - gameStartedAt)) : MATCH_DURATION_MS;
    const mm = Math.floor(remain / 60000);
    const ss = Math.floor((remain % 60000) / 1000);
    elTimerText.textContent = `${mm.toString().padStart(2, "0")}:${ss.toString().padStart(2, "0")}`;
  }

  if (elMissionFill) {
    const m = clamp(lampPostsEaten / MISSION_GOAL, 0, 1);
    elMissionFill.style.width = `${m * 100}%`;
  }
  if (elKillCount) elKillCount.textContent = String(killCount);

  // Nameplate above hole — project world pos to screen
  if (elNameplate && gameStarted) {
    const wp = new THREE.Vector3();
    holeGroup.getWorldPosition(wp);
    const proj = wp.clone().project(camera);
    if (proj.z < 1) {
      const sx = (proj.x * 0.5 + 0.5) * window.innerWidth;
      const sy = (-proj.y * 0.5 + 0.5) * window.innerHeight;
      // offset upward proportional to hole radius (rough screen-space lift)
      const lift = 70 + holeRadius * 6;
      elNameplate.style.left = `${sx}px`;
      elNameplate.style.top = `${sy - lift}px`;
      elNameplate.classList.add("visible");
      if (elNpLvl) elNpLvl.textContent = String(level);
      if (elNpHpFill) elNpHpFill.style.width = `${xpFrac * 100}%`;
      if (elNpHpCur) elNpHpCur.textContent = String(itemsEatenThisLevel);
      if (elNpHpMax) elNpHpMax.textContent = String(itemsNeeded);
    } else {
      elNameplate.classList.remove("visible");
    }
  }

  if (camHintTimer > 0 && performance.now() > camHintTimer) {
    camHint.style.opacity = "0";
    camHintTimer = 0;
  }

  if (flashUntil > performance.now()) {
    const a = clamp((flashUntil - performance.now()) / 450, 0, 1);
    const r = (flashColor >> 16) & 0xff, gg = (flashColor >> 8) & 0xff, bb = flashColor & 0xff;
    vignette.style.background = `radial-gradient(1400px 800px at 50% 38%, rgba(${r},${gg},${bb},${0.0}) 35%, rgba(${r},${gg},${bb},${0.35 * a}) 100%)`;
  } else {
    vignette.style.background = "radial-gradient(1400px 800px at 50% 38%, rgba(0,0,0,0) 65%, rgba(0,0,0,0.18) 100%)";
  }

  // Ball pulse on pickup — uniform scale so the sphere stays a sphere
  const pickupPulse = clamp((performance.now() - lastPickupAt) / 140, 0, 1);
  const pulse = 1 - smoothstep(0, 1, pickupPulse);
  const squish = 1 + pulse * 0.08;
  const sUni = holeRadius * squish;
  holeGroup.scale.set(sUni, sUni, sUni);

  syncMeshes();
  updateCamera(dt);
  renderer.render(scene, camera);
  drawMinimap();
  requestAnimationFrame(tick);
}

// ---------- Vignette ----------
const vignette = document.createElement("div");
vignette.style.position = "fixed";
vignette.style.inset = "0";
vignette.style.pointerEvents = "none";
vignette.style.background =
  "radial-gradient(1400px 800px at 50% 38%, rgba(0,0,0,0) 65%, rgba(0,0,0,0.18) 100%)";
document.body.appendChild(vignette);

tick();
