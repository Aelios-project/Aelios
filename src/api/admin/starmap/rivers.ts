export const STARMAP_RIVERS_SCRIPT = String.raw`import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

var HAN_TYPES = { fact: 1, preference: 1, habit: 1, note: 1 };
var YANG_TYPES = { relationship: 1, event: 1, boundary: 1, decision: 1 };
var HAN_COLORS = {
  fact: new THREE.Color(0x7cb3e8),
  preference: new THREE.Color(0x86d8cc),
  habit: new THREE.Color(0x93a9c2),
  note: new THREE.Color(0xe9eef8)
};
var YANG_COLORS = {
  relationship: new THREE.Color(0xf0977f),
  event: new THREE.Color(0xf0c062),
  boundary: new THREE.Color(0xe06575),
  decision: new THREE.Color(0xeaa94e)
};
var PINNED_COLOR = new THREE.Color(0xfff6e2);
var REL_COLORS = {
  supports: new THREE.Color(0xdce1eb),
  contradicts: new THREE.Color(0xef4444),
  cause_effect: new THREE.Color(0xf59e0b),
  derived_from: new THREE.Color(0xa78bfa),
  same_thread: new THREE.Color(0x7db4dc),
  supersedes: new THREE.Color(0x8c8c96)
};
var TYPE_LEGEND = [
  { id: 'fact', label: 'fact', color: '#7cb3e8' },
  { id: 'preference', label: 'preference', color: '#86d8cc' },
  { id: 'habit', label: 'habit', color: '#93a9c2' },
  { id: 'note', label: 'note', color: '#e9eef8' },
  { id: 'relationship', label: 'relationship', color: '#f0977f' },
  { id: 'event', label: 'event', color: '#f0c062' },
  { id: 'boundary', label: 'boundary', color: '#e06575' },
  { id: 'decision', label: 'decision', color: '#eaa94e' }
];
var REL_LEGEND = [
  { id: 'supports', label: 'supports', color: '#dce1eb' },
  { id: 'contradicts', label: 'contradicts', color: '#ef4444' },
  { id: 'cause_effect', label: 'cause_effect', color: '#f59e0b' },
  { id: 'derived_from', label: 'derived_from', color: '#a78bfa' },
  { id: 'same_thread', label: 'same_thread', color: '#7db4dc' },
  { id: 'supersedes', label: 'supersedes', color: '#8c8c96' }
];
var RECENT_MS = 30 * 86400000;
var MAX_PARTICLES = 2800;

function hashStr(s) {
  var h = 2166136261 >>> 0;
  for (var i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    var t = (a += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
function starSize(importance, pinned) {
  var imp = Number(importance);
  if (!Number.isFinite(imp)) imp = 0.5;
  imp = clamp(imp, 0, 1);
  var base = 0.6;
  var k = 1.75;
  var r = base + Math.pow(imp, 1.35) * k;
  if (pinned) r *= 1.5;
  return r;
}
function typeColor(type) {
  if (HAN_COLORS[type]) return HAN_COLORS[type].clone();
  if (YANG_COLORS[type]) return YANG_COLORS[type].clone();
  return new THREE.Color(0xa0a8c0);
}
function isHanType(type) { return !!HAN_TYPES[type]; }
function isYangType(type) { return !!YANG_TYPES[type]; }
function riverOf(type) {
  if (isYangType(type)) return 'yang';
  return 'han';
}
function fmtTime(value) {
  if (!value) return '—';
  var d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function pct(v) { return Math.round(Number(v || 0) * 100) + '%'; }

// ── DOM ──────────────────────────────────────────────────────
var canvas = document.getElementById('c');
var tooltipEl = document.getElementById('tooltip');
var drawerEl = document.getElementById('drawer');
var drawerTitle = document.getElementById('drawerTitle');
var drawerMeta = document.getElementById('drawerMeta');
var drawerEdges = document.getElementById('drawerEdges');
var countLabel = document.getElementById('countLabel');
var loadingBanner = document.getElementById('loadingBanner');
var emptyBanner = document.getElementById('emptyBanner');
var authBanner = document.getElementById('authBanner');
var errorBanner = document.getElementById('errorBanner');
var skipHint = document.getElementById('skipHint');
var searchBar = document.getElementById('searchBar');
var chipsPanel = document.getElementById('chipsPanel');
var statsEl = document.getElementById('stats');
var typeLegendEl = document.getElementById('typeLegend');
var relLegendEl = document.getElementById('relLegend');
var lastRealCount = 0;

var typeVisible = {};
var relVisible = {};
TYPE_LEGEND.forEach(function (t) { typeVisible[t.id] = true; });
REL_LEGEND.forEach(function (r) { relVisible[r.id] = true; });

var showAllEdges = false;
var nodes = [];
var edges = [];
var meta = { total_nodes: 0, total_edges: 0, truncated: false };
var starById = {};
var indexToNode = [];
var adj = {};
var hoverId = null;
var selectedId = null;
var pulseId = null;
var pulseUntil = 0;
var introActive = true;
var introT0 = 0;
var idleT0 = performance.now();
var autoOrbit = false;
var orbitAng = 0;
var camTween = null;
var loadSeq = 0;
var firstLoad = true;
var pageVisible = !document.hidden;
var raf = 0;
var fpsEma = 60;
var statsT0 = 0;
var pointer = new THREE.Vector2(-10, -10);
var raycaster = new THREE.Raycaster();
raycaster.params.Points = { threshold: 0.9 };

// ── three ────────────────────────────────────────────────────
var renderer = new THREE.WebGLRenderer({
  canvas: canvas, antialias: true, alpha: false, powerPreference: 'high-performance'
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setClearColor(0x04050c, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
var clock = new THREE.Clock();

var scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x04050c, 0.010);

var camera = new THREE.PerspectiveCamera(50, 1, 0.1, 400);
camera.position.set(8, 34, 78);

var controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.065;
controls.minDistance = 12;
controls.maxDistance = 160;
controls.maxPolarAngle = Math.PI * 0.49;
controls.target.set(0, 2.2, 2);
controls.update();

// cut a stretch out of a curve (u = control-point parameter) as its own curve, so the
// pieces share one path and meet without a kink
function subCurve(curve, u0, u1) {
  var pts = [];
  var n = 48;
  for (var i = 0; i <= n; i++) pts.push(curve.getPoint(u0 + (u1 - u0) * i / n));
  return new THREE.CatmullRomCurve3(pts, false, 'centripetal');
}

// 长江 is one continuous main stem that sweeps through the confluence. 汉江 is thinner and
// more winding; it slants in from the left, then runs along the bank for a stretch, drawing
// toward mid-channel as the two waters mix (the merge stretch, where recent memories sit).
function buildCurves() {
  var trunkPts = [
    new THREE.Vector3(60.6, 0.5, -25.9),
    new THREE.Vector3(50, 0.6, -31.5),
    new THREE.Vector3(37.1, 0.5, -32.9),
    new THREE.Vector3(24.9, 0.35, -28.4),
    new THREE.Vector3(15.7, 0.2, -20.7),
    new THREE.Vector3(8.6, 0.1, -12.3),
    new THREE.Vector3(3.9, 0.05, -5.8),
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(-3.4, -0.3, 8.3),
    new THREE.Vector3(-4.8, -0.6, 18.2),
    new THREE.Vector3(-3.2, -1, 29.1),
    new THREE.Vector3(0.8, -1.5, 41.5),
    new THREE.Vector3(4.2, -2.2, 55.1),
    new THREE.Vector3(3.6, -3, 71.1)
  ];
  var CONF = 7; // trunkPts index of the confluence
  var trunk = new THREE.CatmullRomCurve3(trunkPts, false, 'centripetal');
  var uConf = CONF / (trunkPts.length - 1);
  var yang = subCurve(trunk, 0, uConf);
  var down = subCurve(trunk, uConf, 1);

  var hanPts = [
    new THREE.Vector3(-38.2, 0.5, -76.1),
    new THREE.Vector3(-34.5, 0.65, -71.4),
    new THREE.Vector3(-30.8, 0.7, -66.6),
    new THREE.Vector3(-27.3, 0.6, -61.8),
    new THREE.Vector3(-23.8, 0.45, -55.7),
    new THREE.Vector3(-21.6, 0.3, -49.1),
    new THREE.Vector3(-20.9, 0.25, -42.1),
    new THREE.Vector3(-18.9, 0.3, -35.4),
    new THREE.Vector3(-14.6, 0.45, -29.9),
    new THREE.Vector3(-8.8, 0.5, -26),
    new THREE.Vector3(-3.5, 0.4, -21.5),
    new THREE.Vector3(-0.1, 0.25, -16.5),
    new THREE.Vector3(1.3, 0.12, -10.7),
    new THREE.Vector3(0.9, 0.05, -5.2)
  ];
  // along the bank below the confluence: start beside the main stem, ease in to mid-channel
  var downLen = down.getLength();
  var up = new THREE.Vector3(0, 1, 0);
  var BANK = 9;
  for (var i = 0; i <= BANK; i++) {
    var k = i / BANK;
    var s = (k * 16) / downLen;
    var p = down.getPointAt(s);
    var side = new THREE.Vector3().crossVectors(down.getTangentAt(s), up).normalize();
    hanPts.push(p.addScaledVector(side, 1.15 * (1 - 0.85 * k * k)));
  }
  var JOIN = hanPts.length - BANK - 1; // index where 汉江 reaches the main stem
  var hanFull = new THREE.CatmullRomCurve3(hanPts, false, 'centripetal');
  var uJoin = JOIN / (hanPts.length - 1);
  var han = subCurve(hanFull, 0, uJoin);
  var merge = subCurve(hanFull, uJoin, 1);

  var yangLen = yang.getLength();
  var hanLen = han.getLength();
  return {
    han: han, yang: yang, down: down, merge: merge,
    trunk: trunk, hanFull: hanFull,
    // where the confluence falls along each full river, as a fraction of its length
    trunkSplit: yangLen / (yangLen + downLen),
    hanSplit: hanLen / (hanLen + merge.getLength())
  };
}
var curves = buildCurves();

// river ribbons: luminous water. A bright thread runs down the mid-channel and swells of
// light travel downstream; a wide faint copy underneath gives the river its bloom.
var ribbonMaterials = [];
var ribbonVertexShader = [
  'varying vec2 vUv;',
  'void main() {',
  '  vUv = uv;',
  '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
  '}'
].join('\n');
var ribbonFragmentShader = [
  'uniform vec3 uColor;',
  'uniform vec3 uColor2;',
  'uniform float uSplit;',
  'uniform float uTime;',
  'uniform float uOpacity;',
  'uniform float uEndFade;',
  'uniform float uFadeFrom;',
  'uniform float uCrest;',
  'uniform float uLen;',
  'varying vec2 vUv;',
  'void main() {',
  '  float y = vUv.y * 2.0 - 1.0;',
  '  float body = exp(-y * y * 3.0) * (1.0 - y * y);',
  '  float crest = exp(-y * y * 70.0) * uCrest;',
  // x in world units, so swells keep one spacing on every river
  '  float x = vUv.x * uLen;',
  '  float swell = pow(0.5 + 0.5 * sin(x * 0.21 - uTime * 1.05), 4.0);',
  '  float swell2 = pow(0.5 + 0.5 * sin(x * 0.47 - uTime * 1.7 + 1.9), 6.0);',
  '  float ripple = 0.78 + 0.22 * sin(x * 2.1 - uTime * 2.4 + y * 2.5);',
  '  float glow = body * (0.5 + 0.55 * swell + 0.35 * swell2) * ripple;',
  '  float thread = crest * (0.45 + 1.1 * swell + 0.5 * swell2);',
  '  float along = smoothstep(0.0, 0.04, vUv.x) * (1.0 - smoothstep(0.96, 1.0, vUv.x));',
  '  along *= 1.0 - uEndFade * clamp((vUv.x - uFadeFrom) / (1.0 - uFadeFrom), 0.0, 1.0);',
  // below the confluence the water turns from its own colour to the mixed colour
  '  vec3 base = mix(uColor, uColor2, smoothstep(uSplit, uSplit + 0.1, vUv.x));',
  '  vec3 col = mix(base, vec3(1.0, 0.97, 0.9), clamp(thread * 0.35, 0.0, 1.0));',
  '  gl_FragColor = vec4(col, (glow + thread) * along * uOpacity);',
  '}'
].join('\n');

// opts: widthAt(t) (width profile along the river), color2 + split (colour below t = split),
// endFade + fadeFrom (how much to dim from t = fadeFrom to the far end),
// crest (strength of the mid-channel thread, default 1)
function makeRiverRibbon(curve, width, colorHex, opacity, opts) {
  opts = opts || {};
  var segs = Math.max(120, Math.round(curve.getLength() * 1.5));
  var pts = curve.getSpacedPoints(segs);
  var positions = [];
  var uvs = [];
  for (var i = 0; i < pts.length; i++) {
    var p = pts[i];
    var t = i / (pts.length - 1);
    var next = pts[Math.min(i + 1, pts.length - 1)];
    var tangent = new THREE.Vector3().subVectors(next, p);
    if (tangent.lengthSq() < 1e-8) tangent.set(0, 0, 1);
    else tangent.normalize();
    var side = new THREE.Vector3().crossVectors(tangent, new THREE.Vector3(0, 1, 0));
    if (side.lengthSq() < 1e-8) side.set(1, 0, 0);
    else side.normalize();
    var w = width * (opts.widthAt ? opts.widthAt(t) : 0.55 + 0.45 * Math.sin(t * Math.PI));
    var a = p.clone().addScaledVector(side, w);
    var b = p.clone().addScaledVector(side, -w);
    a.y -= 0.4;
    b.y -= 0.4;
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
    uvs.push(t, 0, t, 1);
  }
  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  var idx = [];
  for (var s = 0; s < pts.length - 1; s++) {
    var i0 = s * 2, i1 = s * 2 + 1, i2 = (s + 1) * 2, i3 = (s + 1) * 2 + 1;
    idx.push(i0, i1, i2, i1, i3, i2);
  }
  geo.setIndex(idx);
  var mat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(colorHex) },
      uColor2: { value: new THREE.Color(opts.color2 == null ? colorHex : opts.color2) },
      uSplit: { value: opts.split == null ? 1 : opts.split },
      uTime: { value: 0 },
      uOpacity: { value: opacity },
      uEndFade: { value: opts.endFade || 0 },
      uFadeFrom: { value: opts.fadeFrom || 0 },
      uCrest: { value: opts.crest == null ? 1 : opts.crest },
      uLen: { value: curve.getLength() }
    },
    vertexShader: ribbonVertexShader,
    fragmentShader: ribbonFragmentShader,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending
  });
  ribbonMaterials.push(mat);
  return new THREE.Mesh(geo, mat);
}

// 长江 widens all the way down and never pinches at the confluence; 汉江 is narrow at its
// source, fullest where it meets the main stem, then thins out as it mixes in
function trunkWidth(t) {
  var sp = curves.trunkSplit;
  var source = 0.35 + 0.65 * Math.min(t / 0.08, 1);
  return source * (t < sp ? 0.5 + 0.5 * (t / sp) : 1 + 0.3 * (t - sp) / (1 - sp));
}
function hanWidth(t) {
  var sp = curves.hanSplit;
  return t < sp ? 0.35 + 0.65 * (t / sp) : 1 - 0.75 * (t - sp) / (1 - sp);
}
var trunkOpts = { widthAt: trunkWidth, split: curves.trunkSplit, endFade: 0.72, fadeFrom: curves.trunkSplit };
var hanOpts = { widthAt: hanWidth, endFade: 1, fadeFrom: curves.hanSplit };
var riverGroup = new THREE.Group();
// wide faint bloom first, then the water itself
riverGroup.add(makeRiverRibbon(curves.hanFull, 3.0, 0x3a78d0, 0.12, Object.assign({ crest: 0 }, hanOpts)));
riverGroup.add(makeRiverRibbon(curves.trunk, 6.2, 0xd89a40, 0.1, Object.assign({ crest: 0, color2: 0x4a5478 }, trunkOpts)));
riverGroup.add(makeRiverRibbon(curves.hanFull, 1.4, 0x5f9ed8, 0.42, hanOpts));
riverGroup.add(makeRiverRibbon(curves.trunk, 3.2, 0xeab058, 0.42, Object.assign({ color2: 0x5f6580 }, trunkOpts)));
scene.add(riverGroup);

var cityLight = new THREE.PointLight(0xffd090, 1.5, 42, 2);
cityLight.position.set(0, 4.5, 0);
scene.add(cityLight);
scene.add(new THREE.AmbientLight(0x334466, 0.55));

// soft radial sprite texture shared by star halos and milky-way haze
function makeGlowTexture() {
  var c = document.createElement('canvas');
  c.width = c.height = 128;
  var ctx = c.getContext('2d');
  var g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,0.60)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.22)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.06)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}
var glowTex = makeGlowTexture();
function makeDotTexture() {
  var c = document.createElement('canvas');
  c.width = c.height = 32;
  var ctx = c.getContext('2d');
  var g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.75)');
  g.addColorStop(0.7, 'rgba(255,255,255,0.12)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}
var dotTex = makeDotTexture();

// far dust: dense warm micro-dust on a tilted band + sparse brighter far stars
(function makeDust() {
  var warm = new THREE.Color(0xffe9c4);
  var cool = new THREE.Color(0xbcd2ff);
  var cc = new THREE.Color();
  var rnd = mulberry32(0xD057);
  // micro gold dust on a tilted slab, like a distant galaxy plane
  var n1 = 560;
  var pos = new Float32Array(n1 * 3);
  var col = new Float32Array(n1 * 3);
  for (var i = 0; i < n1; i++) {
    var r = 26 + rnd() * 118;
    var th = rnd() * Math.PI * 2;
    var x = Math.cos(th) * r;
    pos[i * 3] = x;
    pos[i * 3 + 1] = (rnd() + rnd() + rnd() - 1.5) * 9 + x * 0.2 - 4;
    pos[i * 3 + 2] = Math.sin(th) * r - 12;
    cc.copy(rnd() < 0.78 ? warm : cool);
    var b = 0.35 + rnd() * 0.5;
    col[i * 3] = cc.r * b; col[i * 3 + 1] = cc.g * b; col[i * 3 + 2] = cc.b * b;
  }
  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  var mat = new THREE.PointsMaterial({
    size: 0.42, sizeAttenuation: true, vertexColors: true, map: dotTex,
    transparent: true, opacity: 0.55, depthWrite: false,
    blending: THREE.AdditiveBlending
  });
  scene.add(new THREE.Points(geo, mat));
  // sparse brighter far stars
  var n2 = 200;
  var pos2 = new Float32Array(n2 * 3);
  var col2 = new Float32Array(n2 * 3);
  for (var j = 0; j < n2; j++) {
    var r2 = 85 + rnd() * 90;
    var th2 = rnd() * Math.PI * 2;
    var ph2 = (rnd() - 0.5) * Math.PI;
    pos2[j * 3] = r2 * Math.cos(ph2) * Math.cos(th2);
    pos2[j * 3 + 1] = r2 * Math.sin(ph2) * 0.6;
    pos2[j * 3 + 2] = r2 * Math.cos(ph2) * Math.sin(th2) - 10;
    cc.copy(rnd() < 0.7 ? warm : cool);
    var b2 = 0.5 + rnd() * 0.5;
    col2[j * 3] = cc.r * b2; col2[j * 3 + 1] = cc.g * b2; col2[j * 3 + 2] = cc.b * b2;
  }
  var geo2 = new THREE.BufferGeometry();
  geo2.setAttribute('position', new THREE.BufferAttribute(pos2, 3));
  geo2.setAttribute('color', new THREE.BufferAttribute(col2, 3));
  var mat2 = new THREE.PointsMaterial({
    size: 0.85, sizeAttenuation: true, vertexColors: true, map: dotTex,
    transparent: true, opacity: 0.7, depthWrite: false,
    blending: THREE.AdditiveBlending
  });
  scene.add(new THREE.Points(geo2, mat2));
})();

// milky-way haze: a few huge soft sprites, very low opacity, slow breathing
var fogSprites = [];
(function makeFog() {
  var defs = [
    { p: [-46, 12, -85], s: 130, c: 0x2a3a6e, o: 0.10 },
    { p: [52, -8, -72], s: 105, c: 0x1e4a56, o: 0.08 },
    { p: [8, 6, -48], s: 72, c: 0x6e5a2e, o: 0.07 },
    { p: [-72, 22, -28], s: 92, c: 0x3a2a5e, o: 0.07 },
    { p: [34, 28, -105], s: 145, c: 0x22315e, o: 0.09 },
    { p: [-18, -16, 62], s: 85, c: 0x4a3a2a, o: 0.05 },
    { p: [0, 1.6, 0], s: 17, c: 0xffd9a0, o: 0.16 }
  ];
  for (var i = 0; i < defs.length; i++) {
    var d = defs[i];
    var m = new THREE.SpriteMaterial({
      map: glowTex, color: d.c, transparent: true, opacity: d.o,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    var sp = new THREE.Sprite(m);
    sp.position.set(d.p[0], d.p[1], d.p[2]);
    sp.scale.set(d.s, d.s, 1);
    scene.add(sp);
    fogSprites.push({ mat: m, base: d.o, phase: i * 1.7, speed: 0.18 + (i % 3) * 0.07 });
  }
})();

// star shader: hot core + soft inner glow + wide halo, per-star breathing
var starVertexShader = [
  'attribute float aSize;',
  'attribute float aPhase;',
  'attribute float aAlpha;',
  'attribute float aCore;',
  'attribute float aKind;',
  'attribute vec3 aColor;',
  'attribute vec3 aFlow;',
  'attribute float aBob;',
  'uniform float uTime;',
  'uniform float uPixelRatio;',
  'uniform float uSway;',
  'varying vec3 vColor;',
  'varying float vAlpha;',
  'varying float vCore;',
  'void main() {',
  '  vColor = aColor;',
  '  vCore = aCore;',
  '  float breathe = 0.82 + 0.18 * sin(uTime * 1.7 + aPhase);',
  '  vAlpha = aAlpha * breathe;',
  // river stars ride the current back and forth; city lights float above the confluence.
  // starSway() in JS mirrors this so edge lines stay attached.
  '  vec3 pos = position + (aFlow * sin(uTime * 0.42 + aPhase * 1.7) + vec3(0.0, aBob * sin(uTime * 0.55 + aPhase * 3.1), 0.0)) * uSway;',
  '  if (aKind > 1.5) {',
  '    // easter-egg stars breathe slower and deeper',
  '    vAlpha = aAlpha * (0.72 + 0.28 * sin(uTime * 0.9 + aPhase));',
  '  }',
  '  vec4 mv = modelViewMatrix * vec4(pos, 1.0);',
  '  gl_PointSize = aSize * uPixelRatio * (180.0 / -mv.z);',
  '  gl_Position = projectionMatrix * mv;',
  '}'
].join('\n');
var starFragmentShader = [
  'varying vec3 vColor;',
  'varying float vAlpha;',
  'varying float vCore;',
  'void main() {',
  '  vec2 uv = gl_PointCoord - vec2(0.5);',
  '  float d = length(uv);',
  '  if (d > 0.5) discard;',
  '  float core = smoothstep(0.16, 0.02, d);',
  '  float mid = exp(-d * 7.5) * 0.9;',
  '  float halo = exp(-d * 2.8) * 0.30;',
  '  vec3 col = vColor + vec3(0.92, 0.95, 1.0) * core * vCore;',
  '  float a = (core + mid + halo) * vAlpha;',
  '  gl_FragColor = vec4(col, a);',
  '}'
].join('\n');

var starMaterial = new THREE.ShaderMaterial({
  uniforms: {
    uTime: { value: 0 },
    uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
    uSway: { value: 1 }
  },
  vertexShader: starVertexShader,
  fragmentShader: starFragmentShader,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending
});

var starsPoints = null;
var starsGroup = new THREE.Group();
scene.add(starsGroup);

// halo layer: wide soft bloom for important / pinned / easter stars
var haloVertexShader = [
  'attribute float aSize;',
  'attribute float aPhase;',
  'attribute float aAlpha;',
  'attribute vec3 aColor;',
  'attribute vec3 aFlow;',
  'attribute float aBob;',
  'uniform float uTime;',
  'uniform float uPixelRatio;',
  'uniform float uSway;',
  'varying vec3 vColor;',
  'varying float vAlpha;',
  'void main() {',
  '  vColor = aColor;',
  '  vAlpha = aAlpha * (0.82 + 0.18 * sin(uTime * 0.8 + aPhase));',
  '  vec3 pos = position + (aFlow * sin(uTime * 0.42 + aPhase * 1.7) + vec3(0.0, aBob * sin(uTime * 0.55 + aPhase * 3.1), 0.0)) * uSway;',
  '  vec4 mv = modelViewMatrix * vec4(pos, 1.0);',
  '  gl_PointSize = aSize * uPixelRatio * (150.0 / -mv.z);',
  '  gl_Position = projectionMatrix * mv;',
  '}'
].join('\n');
var haloFragmentShader = [
  'uniform sampler2D uMap;',
  'varying vec3 vColor;',
  'varying float vAlpha;',
  'void main() {',
  '  vec4 tex = texture2D(uMap, gl_PointCoord);',
  '  gl_FragColor = vec4(vColor, tex.a * vAlpha);',
  '}'
].join('\n');
var haloMaterial = new THREE.ShaderMaterial({
  uniforms: {
    uTime: { value: 0 },
    uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
    uSway: { value: 1 },
    uMap: { value: glowTex }
  },
  vertexShader: haloVertexShader,
  fragmentShader: haloFragmentShader,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending
});
var haloPoints = null;
// smooth transitions: focus changes write targets, the frame loop eases toward them
var targetSizes = null;
var targetAlphas = null;
var targetHaloSizes = null;
var targetHaloAlphas = null;
var animActive = false;

// particle flow (GPU): curves baked into float textures, drift runs in shader.`;
